import { normalizeName } from "../judgment/name-evidence.mjs";
import { literalSpan, QUOTE_LIMIT } from "../judgment/public-evidence.mjs";
import { isFigureReplyAspect } from "../local-grounding/verify.ts";
import type { LocalClaimView, PublicTurn } from "../local-grounding/contract.ts";
import type { ObservationFigure, ObservationMemo } from "../observation/contract.ts";
import { hasOrientationWords } from "../v2/generation-guard.ts";
import { namingDenialTargets, type NamingResponseEvidence } from "./naming-reconfirmation.ts";
import type { JevExecutedDecision } from "./contract.ts";
import type { NamingJudgmentLike } from "./naming-request.ts";

export type NamingDenials = Readonly<Record<string, number>>;
type VisibleTurn = PublicTurn & { nonReferential?: boolean };
export type NamingContrastAnswer = { figureId: string; deniedAt: number; questionId: string; replyIds: ReadonlySet<string>; identityIds: ReadonlySet<string> };

export function validNamingDenials(value: unknown, slots: readonly string[], turn: number): value is NamingDenials {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([id, at]) => slots.includes(id) && typeof at === "number" &&
      Number.isSafeInteger(at) && at > 0 && at <= turn);
}

const featureKey = (value: string): string => value.normalize("NFKC").trim().replace(/[。.!！]+$/u, "").trim();
const positiveFeatures = (f: ObservationFigure): string[] =>
  [...f.analytic.shapes, f.analytic.composition, ...f.analytic.relations, ...f.reobservations.flatMap(r => r.supports)];

type Count = { part: string | null; unit: string; number: string };

/** The same literal part and unit make counts from the memo and the answer
 * comparable. Unrecognized descriptions remain unresolved. */
function parseCount(key: string): Count | null {
  const parsed = /^(?:([^、。！？?「」『』\s]+?)[がは])?([0-9]+|[一二三四五六七八九十])(つ|個|本|箇所|か所)(?:ある|あります|です)?$/u.exec(key);
  if (!parsed) return null;
  const numeral = "一二三四五六七八九十".indexOf(parsed[2]);
  const number = numeral < 0 ? parsed[2].replace(/^0+(?=\d)/u, "") : String(numeral + 1);
  return { part: parsed[1] ?? null, unit: parsed[3], number };
}

function countMatches(a: Count, b: Count): boolean {
  return a.part === b.part && a.unit === b.unit && a.number === b.number;
}

function matchesFeature(a: string, b: string): boolean {
  const left = featureKey(a), right = featureKey(b);
  if (left === right) return true;
  const x = parseCount(left), y = parseCount(right);
  return !!x?.part && !!y && countMatches(x, y);
}

function unresolved(f: ObservationFigure, value: string): boolean {
  return [...f.unknowns, ...f.reobservations.flatMap(r => r.unknown)].some(note => matchesFeature(note, value));
}

function contradicts(f: ObservationFigure, value: string): boolean {
  return f.reobservations.some(r => r.contradicts.some(note => matchesFeature(note, value)));
}

/** Compare every figure in the pre-selection pool. A missing description
 * supplies no evidence about whether the feature is present. */
export function contrastFeatures(memo: ObservationMemo, candidates: readonly string[], figureId: string): string[] {
  const selected = memo.figures.find(f => f.id === figureId);
  if (!selected || candidates.length < 2 || !candidates.includes(figureId)) return [];
  const other = candidates.filter(id => id !== figureId).map(id => memo.figures.find(f => f.id === id));
  return [...new Set(positiveFeatures(selected))].filter(value => {
    const key = featureKey(value), count = parseCount(key);
    if (!key || /[「」『』?？\n\r。]/u.test(key) || hasOrientationWords(key, "jev_generation_retry_v12") ||
        contrastUtterance(key).question.length > QUOTE_LIMIT || contrastUtterance(key).statement.length > QUOTE_LIMIT) return false;
    function countsForPart(f: ObservationFigure) {
      const counts = new Map<string, string>();
      if (count?.part) for (const observed of positiveFeatures(f)) {
        const compared = parseCount(featureKey(observed));
        if (compared?.part === count.part && compared.unit === count.unit) counts.set(compared.number, observed);
      }
      return counts;
    }
    if (unresolved(selected, key) || contradicts(selected, key) || countsForPart(selected).size > 1) return false;
    return other.every(f => {
      if (!f || unresolved(f, key) || positiveFeatures(f).some(note => matchesFeature(note, key))) return false;
      const counts = countsForPart(f);
      if (counts.size > 1) return false;
      if (contradicts(f, key)) return true;
      const alternative = counts.values().next().value;
      return alternative !== undefined && !unresolved(f, alternative) && !contradicts(f, alternative);
    });
  });
}

function contrastUtterance(feature: string): { statement: string; question: string; text: string } {
  const property = featureKey(feature);
  const statement = `こちらでは、${property}という特徴が見えます。`;
  const question = `そちらの図形も、${property}という特徴がありますか？`;
  return { statement, question, text: statement + question };
}

export function includesNamingDenial(denials: NamingDenials, ids: readonly string[]): boolean {
  return ids.some(id => Object.hasOwn(denials, id));
}

export function protectedNamingCheck(denials: NamingDenials, execution: JevExecutedDecision): boolean {
  return (execution.action === "confirm" || execution.action === "repair") &&
    includesNamingDenial(denials, execution.target.kind === "single" ? [execution.target.figureId] :
      execution.target.kind === "multiple" ? execution.target.figureIds : []);
}

export function namingContrastUtterance(denials: NamingDenials, execution: JevExecutedDecision,
  memo: ObservationMemo, slots: readonly string[]) {
  if (!protectedNamingCheck(denials, execution) || execution.target.kind !== "single" || !execution.feature ||
      !contrastFeatures(memo, slots, execution.target.figureId).includes(execution.feature)) return null;
  return contrastUtterance(execution.feature);
}

/** Preserve the attempted figure when an explicit denial of a published
 * check has a conflicting target or aspect and is refused by local storage. */
export function updateNamingDenials(saved: NamingDenials, claims: readonly LocalClaimView[], turns: readonly VisibleTurn[],
  judgments: readonly NamingJudgmentLike[], turn: number, evidence: NamingResponseEvidence | undefined): NamingDenials {
  const denials = { ...saved };
  for (const c of claims) {
    if (c.speaker !== "human" || c.sourceTurn !== turn || c.act !== "deny" || !isFigureReplyAspect(c.aspect)) continue;
    const prior = claims.find(p => p.id === c.respondsTo);
    if (c.aspect !== "referent" && (prior?.speaker !== "ai" || prior.act !== "ask")) continue;
    for (const id of namingDenialTargets(c, prior, turns, judgments, "scoped_v12")) denials[id] = turn;
  }
  const human = turns.find(t => t.turn === turn && t.speaker === "human");
  const previous = turns.filter(t => t.turn < turn).at(-1);
  const judgment = judgments.at(-1);
  if (!human || previous?.speaker !== "ai" || previous.nonReferential || judgment?.aiPublic?.aiSeq !== previous.turn ||
      judgment.generationGuard?.fallback === true || !["confirm", "repair"].includes(String(judgment.judgment?.action)) ||
      evidence?.classifier?.status !== "ok") return denials;
  const executed = judgment.jevTurn?.executed?.target;
  const targets = executed?.kind === "single" && executed.figureId ? [executed.figureId] : executed?.figureIds ?? [];
  for (const q of evidence.classifier.verdicts) {
    if (q.act !== "deny") continue;
    const segment = evidence.extractor.segments.find(s => s.segmentId === q.segmentId);
    const antecedent = claims.find(c => c.id === q.respondsToClaimId);
    if (!segment || segment.name !== null || !isFigureReplyAspect(segment.aspect) || !literalSpan(human.text, segment.quote) ||
        segment.respondsToTurn !== null && segment.respondsToTurn !== previous.turn ||
        antecedent?.speaker !== "ai" || antecedent.sourceTurn !== previous.turn || !literalSpan(previous.text, antecedent.quote) ||
        !isFigureReplyAspect(antecedent.aspect)) continue;
    for (const id of targets) {
      if (antecedent.targets.includes(id) || antecedent.targets.length === 0 && targets.length === 1) denials[id] = turn;
    }
  }
  return denials;
}

type PublicClause = { start: number; end: number; text: string };

function publicClauses(text: string): PublicClause[] | null {
  const clauses: PublicClause[] = [];
  let read = 0;
  for (const match of text.matchAll(/(?:「[^」\r\n]*」|『[^』\r\n]*』|[^「」『』。．.!！？?…\r\n])+[。．.!！？?…]*/gu)) {
    if (text.slice(read, match.index).trim()) return null;
    read = match.index + match[0].length;
    if (match[0].trim()) clauses.push({ start: match.index, end: read, text: match[0].normalize("NFKC").trim() });
  }
  return text.slice(read).trim() ? null : clauses;
}

const withoutAck = (text: string) => text.replace(/^(?:はい|ええ)[、,\s]+/u, "");
const isIdentityAffirmation = (text: string) =>
  /^(?:(?:(?:私|わたし|こちら|自分)(?:が見ている|の))?(?:図形|形)(?:と同じ(?:です|だ)|と一致します)|(?:同じ|同一の)(?:図形|形)(?:です|だ))[。.!]*$/u
    .test(withoutAck(text));

function opposesIdentity(text: string): boolean {
  const unquoted = text.replace(/「[^」]*」|『[^』]*』/gu, "");
  if (/^(?:いいえ[、,\s]*)?(?:違います|違う|分かりません|わかりません)[。.!]*$/u.test(unquoted) ||
      /(?:別|違う)(?:の)?(?:図形|形)|(?:図形|形)(?:が|は|とは)違(?:う|います)/u.test(unquoted)) return true;
  if (!/(?:同じ|同一|一致)/u.test(unquoted)) return false;
  return /(?:[?？]|ません|ない|不明|分から|わから|かどうか|かな|かも|かは|か分|か判|たぶん|多分|おそらく)/u.test(unquoted);
}

function isNamingClause(text: string, names: ReadonlySet<string>): boolean {
  const proposal = /^(?:呼び名を変えて[、,]\s*)?[「『]([^「」『』]+)[」』](?:と呼び(?:ませんか|ましょう)|にし(?:ませんか|ましょう)|と呼ぼう|にしよう|で(?:いい|どう)(?:ですか)?)[。.!?]*$/u.exec(text);
  return proposal !== null && names.has(normalizeName(proposal[1]));
}

export function namingContrastAnswer(denials: NamingDenials, memo: ObservationMemo | null, candidates: readonly string[],
  claims: readonly LocalClaimView[], turns: readonly VisibleTurn[], judgments: readonly NamingJudgmentLike[],
  turn: number, evidence: NamingResponseEvidence | undefined): NamingContrastAnswer | null {
  const previous = turns.filter(t => t.turn < turn).at(-1);
  const human = turns.find(t => t.turn === turn && t.speaker === "human");
  const prior = judgments.at(-1);
  const target = prior?.jevTurn?.executed?.target;
  const feature = prior?.jevTurn?.executed?.feature;
  if (!memo || !human || previous?.speaker !== "ai" || previous.nonReferential || prior?.aiPublic?.aiSeq !== previous.turn ||
      prior.generationGuard?.fallback === true || !["confirm", "repair"].includes(String(prior.judgment?.action)) ||
      target?.kind !== "single" || !target.figureId || !feature || evidence?.classifier?.status !== "ok") return null;
  const figureId = target.figureId;
  const deniedAt = denials[figureId];
  if (deniedAt === undefined || deniedAt >= previous.turn ||
      !contrastFeatures(memo, candidates, figureId).includes(feature)) return null;
  const { statement, question, text } = contrastUtterance(feature);
  if (previous.text !== text) return null;
  const fromPrevious = claims.filter(c => c.speaker === "ai" && c.sourceTurn === previous.turn);
  const ask = fromPrevious.find(c => c.act === "ask" && c.quote === question && c.targets.length === 1 && c.targets[0] === figureId);
  const assertion = fromPrevious.find(c => c.act === "assert" && c.quote === statement && c.targets.length === 1 && c.targets[0] === figureId);
  if (!ask || !assertion) return null;
  const clauses = publicClauses(human.text);
  if (!clauses?.length || clauses.some(clause => opposesIdentity(clause.text))) return null;
  const responses = evidence.classifier.verdicts;
  if (responses.some(v => v.act === "deny" && [ask.id, assertion.id].includes(v.respondsToClaimId ?? ""))) return null;
  const replies = evidence.extractor.segments.flatMap(segment => {
    const quote = literalSpan(human.text, segment.quote);
    if (!quote || segment.name !== null || segment.targets.length !== 1 || segment.targets[0] !== figureId ||
        segment.respondsToTurn !== null && segment.respondsToTurn !== previous.turn) return [];
    const clause = clauses.find(c => c.start <= quote.start && c.end >= quote.end);
    const matched = responses.filter(v => v.segmentId === segment.segmentId);
    if (!clause || matched.length !== 1 || matched[0].act !== "agree" || matched[0].answersChecked !== "yes") return [];
    return [{ segment, clause, antecedent: matched[0].respondsToClaimId }];
  });
  const identities = replies.filter(r => r.segment.aspect === "referent" &&
    r.antecedent === assertion.id && isIdentityAffirmation(r.clause.text));
  const proposals = new Set(claims.flatMap(c => c.speaker === "human" && c.sourceTurn === turn && c.act === "name_propose" &&
    c.name !== null && c.targets.includes(figureId) ? [normalizeName(c.name)] : []));
  const key = featureKey(feature), count = parseCount(key);
  const ids = replies.filter(({ segment, clause, antecedent }) => {
    if (antecedent !== ask.id || !isFigureReplyAspect(segment.aspect) || /[?？…]/u.test(clause.text)) return false;
    const answer = featureKey(withoutAck(clause.text));
    if (!count?.part) return answer === key || answer.replace(/です$/u, "") === key;
    const said = parseCount(answer);
    if (!said || !countMatches({ ...said, part: said.part ?? count.part }, count)) return false;
    if (said.part !== null) return true;
    // A bare value may borrow the part only from the published question.
    // Any unexplained clause could establish another topic or a correction.
    return clauses.every(other => other === clause || identities.some(r => r.clause === other) || isNamingClause(other.text, proposals));
  }).map(r => r.segment.segmentId);
  return ids.length ? { figureId, deniedAt, questionId: ask.id,
    replyIds: new Set(ids), identityIds: new Set(identities.map(r => r.segment.segmentId)) } : null;
}
