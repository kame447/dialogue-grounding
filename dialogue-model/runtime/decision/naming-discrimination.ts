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
export type NamingContrastAnswer = { figureId: string; deniedAt: number; questionId: string; statementId: string; replyIds: ReadonlySet<string> };

export function validNamingDenials(value: unknown, slots: readonly string[], turn: number): value is NamingDenials {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([id, at]) => slots.includes(id) && typeof at === "number" &&
      Number.isSafeInteger(at) && at > 0 && at <= turn);
}

const featureKey = (value: string): string => value.normalize("NFKC").trim().replace(/[。.!！]+$/u, "").trim();
const positiveFeatures = (f: ObservationFigure): string[] =>
  [...f.analytic.shapes, f.analytic.composition, ...f.analytic.relations, ...f.reobservations.flatMap(r => r.supports)];

/** A count expressed for the same literal part and unit is comparable.
 * The program leaves descriptions and paraphrases outside this form unresolved. */
function partCount(key: string): { part: string; number: string } | null {
  const parsed = /^([^、。！？?「」『』\s]+?)[がは]([0-9]+|[一二三四五六七八九十])(つ|個|本|箇所|か所)(?:ある)?$/u.exec(key);
  if (!parsed) return null;
  const numeral = "一二三四五六七八九十".indexOf(parsed[2]);
  const number = numeral < 0 ? parsed[2].replace(/^0+(?=\d)/u, "") : String(numeral + 1);
  return { part: parsed[1] + ":" + parsed[3], number };
}

/** Compare every figure in the pre-selection pool. A missing description
 * supplies no evidence about whether the feature is present. */
export function contrastFeatures(memo: ObservationMemo, candidates: readonly string[], figureId: string): string[] {
  const selected = memo.figures.find(f => f.id === figureId);
  if (!selected || candidates.length < 2 || !candidates.includes(figureId)) return [];
  const other = candidates.filter(id => id !== figureId).map(id => memo.figures.find(f => f.id === id));
  return [...new Set(positiveFeatures(selected))].filter(value => {
    const key = featureKey(value), count = partCount(key);
    if (!key || /[「」『』?？\n\r。]/u.test(key) || hasOrientationWords(key, "jev_generation_retry_v12") ||
        contrastUtterance(key).question.length > QUOTE_LIMIT || contrastUtterance(key).statement.length > QUOTE_LIMIT) return false;
    const matches = (text: string) => {
      const candidate = featureKey(text);
      const parsed = count && partCount(candidate);
      return candidate === key || parsed && parsed.part === count?.part && parsed.number === count?.number;
    };
    const unresolved = (f: ObservationFigure) =>
      [...f.unknowns, ...f.reobservations.flatMap(r => r.unknown)].some(matches);
    const contradicts = (f: ObservationFigure) => f.reobservations.some(r => r.contradicts.some(matches));
    const otherCounts = (f: ObservationFigure) => {
      const numbers = positiveFeatures(f).map(text => partCount(featureKey(text)))
        .filter(parsed => count && parsed?.part === count.part).map(parsed => parsed!.number);
      return new Set(numbers);
    };
    if (unresolved(selected) || contradicts(selected) || otherCounts(selected).size > 1) return false;
    return other.every(f => {
      if (!f || unresolved(f) || positiveFeatures(f).some(matches)) return false;
      const counts = otherCounts(f);
      return counts.size <= 1 && (contradicts(f) || counts.size === 1);
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

function answerKey(s: string): string {
  return featureKey(s).replace(/^(?:はい|ええ)[、,\s]*/u, "").replace(/(?:です|ます)$/u, "").trim();
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
  const key = answerKey(feature);
  const value = /(?:が|は)([^、。？?！？]+)$/u.exec(key)?.[1].trim();
  const responses = evidence.classifier.verdicts;
  if (responses.some(v => v.act === "deny" && [ask.id, assertion.id].includes(v.respondsToClaimId ?? ""))) return null;
  const ids = evidence.extractor.segments.filter(segment => {
    const quote = literalSpan(human.text, segment.quote);
    const response = evidence.classifier.verdicts.find(v => v.segmentId === segment.segmentId);
    if (!quote || response?.act !== "agree" || response.answersChecked !== "yes" || response.respondsToClaimId !== ask.id ||
        segment.name !== null || !isFigureReplyAspect(segment.aspect) || segment.targets.length !== 1 || segment.targets[0] !== figureId ||
        segment.respondsToTurn !== null && segment.respondsToTurn !== previous.turn) return false;
    const answer = answerKey(quote.text);
    return answer !== "" && (answer === key || answer === value && answerKey(segment.proposition) === key);
  }).map(s => s.segmentId);
  return ids.length ? { figureId, deniedAt, questionId: ask.id, statementId: assertion.id, replyIds: new Set(ids) } : null;
}
