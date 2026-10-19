// The models propose interpretations; only this boundary assigns public evidence,
// graph IDs and issue IDs. No score is used to promote an interpretation.
import { LOCAL_ASPECTS, LOCAL_ACTS } from "./contract.ts";
import type { LocalSegmentProposal, LocalFunctionVerdict, LocalVerificationResult, LocalClaimView, PublicTurn } from "./contract.ts";
import { isBareDeictic, literalSpan, quoteAround } from "../judgment/public-evidence.mjs";
import { SLOTS } from "../stimuli/board.mjs";
import { REFERENCE_LIMITS, snapshotReferenceGraph } from "../memory/reference-graph.mjs";
import { priorClaimViews } from "./derive.ts";

export type LocalGraph = { records: readonly unknown[]; slots?: readonly string[] };
export type LocalVerificationDiagnostic = {
  segmentId: string;
  reason: "issue_link_overridden";
  /** Only bounded graph-ref syntax is retained, never arbitrary model text. */
  linkedIssueId: string | null;
  resolvedIssueId: string;
};
export type LocalVerifiedUpdate = LocalVerificationResult & { diagnostics?: LocalVerificationDiagnostic[] };
type VerificationInput = {
  graph: LocalGraph;
  turn: number;
  publicTurns: readonly PublicTurn[];
  segments: readonly LocalSegmentProposal[];
  verdicts: readonly LocalFunctionVerdict[];
};
const exact = (value: unknown, keys: string[]) => value !== null && typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 160;
const ref = (value: unknown) => typeof value === "string" && /^[1-9]\d*:[a-zA-Z0-9_-]{1,32}$/u.test(value);
const responses = new Set(["agree", "deny", "name_accept", "name_reject", "withdraw"]);
const overlap = (a: readonly string[], b: readonly string[]) => a.some(slot => b.includes(slot));

/** Only the CURRENT public human turn may supply a new segment's quote. */
export function verifyLocalUpdate({ graph, turn, publicTurns, segments, verdicts }: VerificationInput): LocalVerifiedUpdate {
  const result: LocalVerifiedUpdate = { operations: [], rejected: [] };
  // Revalidate JSON-restored graphs before using any model-selected pointer.
  snapshotReferenceGraph(graph);
  const active: LocalClaimView[] = priorClaimViews(graph, { limit: REFERENCE_LIMITS.records });
  const ownSlots = graph.slots ?? SLOTS;
  const humans = publicTurns.filter(t => t.turn === turn && t.speaker === "human");
  const human = humans.length === 1 ? humans[0] : null;
  const previous = publicTurns.filter(t => t.turn < turn).at(-1);
  const previousAi = previous?.speaker === "ai" && !(previous as PublicTurn & { nonReferential?: boolean }).nonReferential ? previous : null;
  const previousClaims = previousAi ? active.filter(c => c.speaker === "ai" && c.sourceTurn === previousAi.turn &&
    literalSpan(previousAi.text, c.quote) !== null && !["acknowledge", "withdraw", "defer", "revisit"].includes(c.act)) : [];
  const count = (id: string) => segments.filter(s => s?.segmentId === id).length;
  for (const segment of segments) {
    const reject = (reason: string) => { result.rejected.push({ segmentId: typeof segment?.segmentId === "string" ? segment.segmentId : "invalid", reason }); };
    if (!Number.isSafeInteger(turn) || turn < 1 || !human) { reject("no_public_human_turn"); continue; }
    if (!exact(segment, ["segmentId", "quote", "targets", "aspect", "proposition", "name", "linkedIssueId", "respondsToTurn"]) ||
        !text(segment.segmentId) || count(segment.segmentId) !== 1 || !text(segment.quote) || !text(segment.proposition) ||
        !LOCAL_ASPECTS.includes(segment.aspect) || !Array.isArray(segment.targets) || segment.targets.length > 6 ||
        ![...segment.targets].every(s => ownSlots.includes(s)) || new Set(segment.targets).size !== segment.targets.length ||
        !(segment.name === null || (segment.aspect === "name" && text(segment.name))) ||
        !(segment.linkedIssueId === null || (typeof segment.linkedIssueId === "string" && segment.linkedIssueId.length <= 128)) ||
        !(segment.respondsToTurn === null || (Number.isSafeInteger(segment.respondsToTurn) && segment.respondsToTurn > 0 && segment.respondsToTurn < turn))) {
      reject("invalid_segment"); continue;
    }
    const matches = verdicts.filter(v => v?.segmentId === segment.segmentId);
    const verdict = matches[0];
    if (matches.length !== 1 || !exact(verdict, ["segmentId", "act", "respondsToClaimId", "rawScore"]) ||
        !LOCAL_ACTS.includes(verdict.act) || !(verdict.respondsToClaimId === null || ref(verdict.respondsToClaimId)) ||
        !(verdict.rawScore === null || (typeof verdict.rawScore === "number" && Number.isFinite(verdict.rawScore)))) {
      reject("invalid_verdict"); continue;
    }
    if (verdict.act === "unknown") { reject("unknown_act"); continue; }
    const quote = literalSpan(human.text, segment.quote)?.text;
    if (!quote || quote.length > 160) { reject("nonpublic_quote"); continue; }
    let act = verdict.act;
    let prior = verdict.respondsToClaimId === null ? null : active.find(c => c.id === verdict.respondsToClaimId) ?? null;
    if (verdict.respondsToClaimId !== null && !prior) { reject("missing_claim_response"); continue; }
    let targets = [...segment.targets];
    let aspect = segment.aspect;
    let linkedIssue = segment.linkedIssueId;
    let name = segment.name;
    if (isBareDeictic(quote) || /^(?:それ|これ|あれ)で(?:いい|良い|よい)(?:です)?[。！!？?\s]*$/u.test(quote.normalize("NFKC").trim())) {
      // ai1 is the program-owned primary act. A secondary feature (ai2) cannot
      // receive a bare acknowledgment, even if the classifier selected its ID.
      const primary = previousClaims.filter(c => c.id === `${c.turn}:ai1`);
      if (primary.length !== 1 || !prior || prior.id !== primary[0].id || !responses.has(act)) {
        act = "acknowledge"; prior = null; targets = []; linkedIssue = null; name = null;
      }
    }
    if (verdict.respondsToClaimId !== null && !prior && act !== "acknowledge") { reject("missing_claim_response"); continue; }
    if (responses.has(act) && !prior) { reject("missing_claim_response"); continue; }
    // Only absence of a target can inherit the verified antecedent's candidates.
    // A nonempty, contradictory target is never moved to a different figure.
    if (prior && targets.length === 0) targets = [...prior.targets];
    // Deferring or revisiting an issue inherits its aspect only when extraction
    // supplied generic progress. Explicit semantic disagreements remain invalid.
    if (prior && aspect === "progress" && ["defer", "revisit"].includes(act)) aspect = prior.aspect;
    if (prior && (prior.sourceTurn >= turn || prior.aspect !== aspect || !overlap(prior.targets, targets) ||
        (segment.respondsToTurn !== null && segment.respondsToTurn !== prior.sourceTurn))) {
      reject("inconsistent_claim_response"); continue;
    }
    if (prior && (act === "withdraw" ? prior.speaker !== "human" : responses.has(act) && prior.speaker === "human")) {
      reject("inconsistent_claim_speaker"); continue;
    }
    if (["name_accept", "name_reject"].includes(act) && (!prior || prior.act !== "name_propose" || prior.aspect !== "name" ||
        targets.length !== prior.targets.length || !targets.every(s => prior!.targets.includes(s)) || (name !== null && name !== prior.name))) {
      reject("unsupported_name_response"); continue;
    }
    if (act === "construe" && aspect !== "construal" || act.startsWith("name_") && aspect !== "name") {
      reject("act_aspect_mismatch"); continue;
    }
    if (act === "name_propose") {
      const span = name === null ? null : literalSpan(quote, name);
      if (!span) { reject("nonpublic_name"); continue; }
      name = span.text;
    } else if (["name_accept", "name_reject"].includes(act)) name = prior!.name;
    else if (name !== null) {
      const span = literalSpan(quote, name);
      if (!span) { reject("nonpublic_name"); continue; }
      name = span.text;
    }
    if (segment.respondsToTurn !== null && act !== "acknowledge" && !publicTurns.some(t => t.turn === segment.respondsToTurn && t.turn < turn)) {
      reject("nonpublic_response_turn"); continue;
    }
    // A verified claim response determines its issue. Luna's issue link is an
    // advisory interpretation and cannot veto Jev's verified antecedent.
    const overriddenIssue = prior && linkedIssue !== null && linkedIssue !== prior.issueId;
    const proposedIssue = linkedIssue;
    if (prior) linkedIssue = prior.issueId;
    let linked = linkedIssue === null ? [] : active.filter(c => c.issueId === linkedIssue);
    const droppedIssue = linkedIssue !== null && (!ref(linkedIssue) || !linked.length || !linked.some(c => c.aspect === aspect &&
      (overlap(c.targets, targets) || (c.targets.length === 0 && targets.length === 0))));
    // A bad advisory link alone cannot discard an otherwise verified new claim.
    if (droppedIssue) { linkedIssue = null; linked = []; }
    if (act === "revisit" && ![...linked].reverse().find(c => ["defer", "revisit"].includes(c.act))?.act.startsWith("defer")) {
      reject("not_deferred"); continue;
    }
    if (result.operations.length >= REFERENCE_LIMITS.operations) { reject("operation_limit"); continue; }
    let local = result.operations.length + 1;
    while (graph.records.some(r => (r as { id?: string }).id === `${turn}:local${local}`) || result.operations.some(r => r.id === `${turn}:local${local}`)) local++;
    const id = `${turn}:local${local}`;
    const issueId = prior?.issueId ?? linkedIssue ?? id;
    result.operations.push({ kind: "claim", id, issueId,
      targets, aspect, act, proposition: segment.proposition, name,
      speaker: "human", sourceTurn: turn, quote, respondsTo: prior?.id ?? null, source: "partner_statement" });
    if (overriddenIssue || droppedIssue) (result.diagnostics ??= []).push({ segmentId: segment.segmentId, reason: "issue_link_overridden",
      linkedIssueId: ref(proposedIssue) ? proposedIssue : null, resolvedIssueId: issueId });
  }
  return result;
}

export type LocalPriorAct = {
  /** Sequence number of the already PUBLIC AI utterance, not its human input. */
  turn: number;
  action: string;
  targetSlot: string | null;
  /** Program-owned unresolved candidates; never a single-slot name decision. */
  targetCandidates?: string[];
  candidateName: string | null;
  discriminatingFeature: string | null;
  /** Copied only from the committed publication trace, never a model verdict. */
  publishedFallback?: boolean;
  followUp?: Omit<LocalPriorAct, "turn" | "followUp" | "publishedFallback"> | null;
};

/** Recover a committed act only when its AI turn is already public. Feature
 * propositions retain the act's intended feature, even if the published wording
 * paraphrases it; their quote remains a literal public span. Names stay literal.
 * Feature aspect is conservatively fixed to part: an act has no aspect field,
 * and the program must not infer semantic aspects from generated language.
 */
export function recordAiClaims({ graph, turn, publicTurns, priorAct }: {
  graph: LocalGraph; turn: number; publicTurns: readonly PublicTurn[]; priorAct: LocalPriorAct;
}): LocalVerificationResult {
  snapshotReferenceGraph(graph);
  const result: LocalVerificationResult = { operations: [], rejected: [] };
  const reject = (segmentId: string, reason: string) => { result.rejected.push({ segmentId, reason }); };
  const sources = publicTurns.filter(t => t.speaker === "ai" && t.turn === priorAct?.turn &&
    !(t as PublicTurn & { nonReferential?: boolean }).nonReferential);
  if (!priorAct || !Number.isSafeInteger(turn) || !Number.isSafeInteger(priorAct.turn) || priorAct.turn < 1 ||
      priorAct.turn >= turn || sources.length !== 1) {
    reject("ai", "no_public_ai_turn"); return result;
  }
  // A generic guard fallback did not publish the intended act's propositions.
  // A successfully rewritten utterance has publishedFallback=false and is valid.
  if (priorAct.publishedFallback === true) { reject("ai", "ai_fallback_utterance"); return result; }
  const source = sources[0];
  const ownSlots = graph.slots ?? SLOTS;
  const existing = graph.records.filter(r => (r as { kind?: string }).kind === "claim") as LocalClaimView[];
  const active = priorClaimViews(graph, { limit: REFERENCE_LIMITS.records });
  let ordinal = 0;
  const acts = [priorAct, ...(priorAct.followUp ? [priorAct.followUp] : [])];
  for (const [actIndex, act] of acts.entries()) {
    if (actIndex > 0 && ordinal === 0) ordinal = 1;
    const candidates = act.targetCandidates;
    const targets = act.targetSlot !== null && ownSlots.includes(act.targetSlot) ? [act.targetSlot]
      : act.targetSlot === null && Array.isArray(candidates) && candidates.length >= 2 && candidates.length <= ownSlots.length &&
        new Set(candidates).size === candidates.length && candidates.every(id => ownSlots.includes(id)) ? [...candidates] : null;
    if (!targets) { reject("ai", "invalid_ai_target"); continue; }
    if (!["accept", "propose_name", "confirm", "agree", "repair", "defer", "revisit", "move_on", "close"].includes(act.action)) {
      reject("ai", "invalid_ai_act"); continue;
    }
    const add = (aspect: "name" | "part", candidate: string | null, functionAct: "name_propose" | "name_accept" | "assert" | "ask") => {
      const local = `ai${++ordinal}`;
      if (!text(candidate)) return;
      const span = literalSpan(source.text, candidate);
      if (aspect === "name" && (!span || span.text.length > 160)) { reject(local, "nonpublic_ai_element"); return; }
      const quote = aspect === "name" ? (source.text.length <= 160 ? source.text : span!.text) :
        quoteAround(source.text.trimStart(), { maxChars: 160 });
      if (!quote) { reject(local, "nonpublic_ai_element"); return; }
      const proposition = aspect === "name" ? span!.text : candidate;
      const name = aspect === "name" ? span!.text : null;
      const prior = functionAct === "name_accept" ? active.filter(c => c.speaker === "human" && c.aspect === "name" &&
        c.act === "name_propose" && c.sourceTurn < source.turn && c.targets.length === 1 && c.targets[0] === act.targetSlot && c.name === name).at(-1) : null;
      if (functionAct === "name_accept" && (!prior || !publicTurns.some(t => t.speaker === "human" && t.turn === prior.sourceTurn &&
          t.text.includes(prior.quote) && t.text.includes(name!)))) { reject(local, "missing_public_name_proposal"); return; }
      if (existing.some(c => c.speaker === "ai" && c.sourceTurn === source.turn && c.aspect === aspect &&
          c.act === functionAct && c.targets.length === targets.length && c.targets.every(id => targets.includes(id)) && c.name === name && c.proposition === proposition &&
          c.respondsTo === (prior?.id ?? null))) return;
      const id = `${turn}:${local}`;
      if (graph.records.some(r => (r as { id?: string }).id === id)) { reject(local, "duplicate_ai_id"); return; }
      result.operations.push({ kind: "claim", id, issueId: prior?.issueId ?? id, targets: [...targets], aspect, act: functionAct,
        proposition, name, speaker: "ai", sourceTurn: source.turn, quote, respondsTo: prior?.id ?? null, source: "ai_hypothesis" });
    };
    const naming = act.action === "propose_name" || (["confirm", "agree"].includes(act.action) && act.candidateName !== null);
    if (naming && targets.length === 1) add("name", act.candidateName, act.action === "agree" ? "name_accept" : "name_propose");
    if (act.discriminatingFeature !== null) add("part", act.discriminatingFeature, act.action === "confirm" ? "ask" : "assert");
    // A follow-up never becomes primary if the main act had no literal element.
    if (ordinal === 0) ordinal = 1;
  }
  return result;
}
