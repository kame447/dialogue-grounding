// The models propose interpretations; only this boundary assigns public evidence,
// graph IDs and issue IDs. No score is used to promote an interpretation.
import { AI_BOUND_SOURCE, LABELLED_ANSWER_SOURCE, LOCAL_QUESTION_ANSWER_SOURCE, LOCAL_ASPECTS, LOCAL_ACTS, LOCAL_ANSWERS_CHECKED } from "./contract.ts";
import type { AiPublicPending, LocalSegmentProposal, LocalFunctionVerdict, LocalVerificationResult, LocalClaimView, PublicTurn } from "./contract.ts";
import { isBareDeictic, literalSpan, quoteAround } from "../judgment/public-evidence.mjs";
import { SLOTS } from "../stimuli/board.mjs";
import { CLAIM_PRUNE_V3, REFERENCE_LIMITS, snapshotReferenceGraph, validateReferenceUpdate, ReferenceGraphError } from "../memory/reference-graph.mjs";
import { priorClaimViews } from "./derive.ts";

export type LocalGraph = { records: readonly unknown[]; slots?: readonly string[]; memoryPruneVersion?: import("../memory/reference-graph.mjs").MemoryPruneVersion };
export type LocalVerificationDiagnostic = {
  segmentId: string;
  reason: "issue_link_overridden";
  /** Only bounded graph-ref syntax is retained, never arbitrary model text. */
  linkedIssueId: string | null;
  resolvedIssueId: string;
} | {
  segmentId: string;
  reason: "antecedent_dropped";
  /** The incompatible optional pointer, checked for graph-ref syntax. */
  respondsToClaimId: string;
  resolvedIssueId: string;
} | {
  segmentId: string;
  reason: "targets_inherited";
  /** holistic_v3 only: the claim whose empty extracted targets were copied from the claim it answers. */
  claimId: string;
  respondsToClaimId: string;
} | {
  segmentId: string;
  reason: "antecedent_missing";
  /** Invalid model text is never retained; only graph-ref syntax can survive. */
  respondsToClaimId: string | null;
  resolvedIssueId: string;
};
export type LocalVerifiedUpdate = LocalVerificationResult & { diagnostics?: LocalVerificationDiagnostic[] };
type VerificationInput = {
  /** holistic_v3 only: see LocalGroundingOptions.keepUnboundApproval. */
  keepUnboundApproval?: boolean;
  /** holistic_v4 only: see LocalGroundingOptions.approvalFromNamedClaim. */
  approvalFromNamedClaim?: boolean;
  /** v7: questions bound through the committed single-figure check and its public description. */
  referenceQuestionBindings?: ReadonlyMap<string, string>;
  directReferenceReplies?: boolean;
  /** jev_generation_retry_v11: an ask rewrites its aspect to the question's only when it answers that question or names no turn. */
  refinedReplyRules?: boolean;
  /** jev_generation_retry_v12: an agree the classifier labelled as answering the checked point (answersChecked "yes") counts as the pointing reply the quote's own words would otherwise have to carry. */
  answerFieldRules?: boolean;
  /** scoped_v9: a direct reply to a public singleton question uses the question's target. */
  bindDirectQuestionReplies?: boolean;
  retainLocalQuestionAnswers?: boolean;
  /** v11: the turn after which the current naming interval starts (the last agree, defer or move_on); a name proposal before it is never carried by an approval request. */
  namingIntervalStart?: number;
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
const independentActs = new Set(["assert", "construe", "name_propose", "ask"]);
// A typed agree still needs words that point to the checked figure for this
// cross-aspect reply. A standalone acknowledgment or a name question is not enough.
export function directsToFigure(quote: string, directReferenceReplies = false): boolean {
  const normalized = quote.normalize("NFKC");
  if (!directReferenceReplies) return /(?:(?:^|[\s、,]|まさに|確かに)(?:これ|それ)|(?:この|その|同じ)(?:図形|形))(?:のこと)?(?:です[よね]?|だ[よね]?)?[。!\s]*$/u.test(normalized);
  // Speech-like spelling can separate a pointing word with punctuation or repeat it.
  return /(?:(?:^|[\s、,!。.]|まさに|確かに|そうそう)(?:これ(?:これ)?|それ(?:それ)?)|(?:この|その|同じ)(?:図形|形))(?:のこと)?(?:です[よね]?|だ[よね]?)?[\s、,!。.]*$/u.test(normalized);
}
const figureReplyAspects = new Set(["referent", "part", "contour", "construal", "orientation", "position", "question"]);
export const isFigureReplyAspect = (aspect: string): boolean => figureReplyAspects.has(aspect);

function opposesPointingReply(segment: LocalSegmentProposal, question: LocalClaimView, figure: string, humanText: string,
  segments: readonly LocalSegmentProposal[], verdicts: readonly LocalFunctionVerdict[], ownSlots: readonly string[]): boolean {
  if (/[?？]|じゃない|ではない|違う|違います|別の(?:図形|形)/u.test(segment.quote.normalize("NFKC"))) return true;
  return segments.some(other => {
    if (!other || other.segmentId === segment.segmentId || !figureReplyAspects.has(other.aspect) ||
        !text(other.quote) || !literalSpan(humanText, other.quote) || !Array.isArray(other.targets) ||
        !other.targets.every(id => ownSlots.includes(id))) return false;
    if (other.targets.some(id => id !== figure)) return true;
    const matching = verdicts.filter(v => v?.segmentId === other.segmentId);
    if (matching.length !== 1) return false;
    const verdict = matching[0];
    return (verdict.act === "deny" || verdict.act === "ask") &&
      (verdict.respondsToClaimId === question.id || other.respondsToTurn === question.sourceTurn);
  });
}
const overlap = (a: readonly string[], b: readonly string[]) => a.some(slot => b.includes(slot));

/** Only the CURRENT public human turn may supply a new segment's quote. */
export function verifyLocalUpdate({ graph, turn, publicTurns, segments, verdicts, keepUnboundApproval = false, approvalFromNamedClaim = false, referenceQuestionBindings, directReferenceReplies = false, refinedReplyRules = false, answerFieldRules = false, bindDirectQuestionReplies = false, retainLocalQuestionAnswers = false, namingIntervalStart = 0 }: VerificationInput): LocalVerifiedUpdate {
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
    if (matches.length !== 1 || !exact(verdict, answerFieldRules && matches.length === 1 && Object.hasOwn(verdict ?? {}, "answersChecked") ? ["segmentId", "act", "respondsToClaimId", "rawScore", "answersChecked"] : ["segmentId", "act", "respondsToClaimId", "rawScore"]) ||
        verdict.answersChecked !== undefined && !LOCAL_ANSWERS_CHECKED.includes(verdict.answersChecked) ||
        !LOCAL_ACTS.includes(verdict.act) || !(verdict.respondsToClaimId === null || ref(verdict.respondsToClaimId) || independentActs.has(verdict.act)) ||
        !(verdict.rawScore === null || (typeof verdict.rawScore === "number" && Number.isFinite(verdict.rawScore)))) {
      reject("invalid_verdict"); continue;
    }
    if (verdict.act === "unknown") { reject("unknown_act"); continue; }
    const quote = literalSpan(human.text, segment.quote)?.text;
    if (!quote || quote.length > 160) { reject("nonpublic_quote"); continue; }
    let act = verdict.act;
    let prior = verdict.respondsToClaimId === null ? null : active.find(c => c.id === verdict.respondsToClaimId) ?? null;
    const missingAntecedent = verdict.respondsToClaimId !== null && !prior;
    if (missingAntecedent && !independentActs.has(act)) { reject("missing_claim_response"); continue; }
    let targets = [...segment.targets];
    let aspect = segment.aspect;
    let linkedIssue = segment.linkedIssueId;
    let name = segment.name;
    // An approval request ("is that name fine?") is a name proposal that carries the earlier proposal's name; it is decided before the bare-deictic rule so a short typed request is not turned into an acknowledgement.
    // The antecedent is the claim the classifier chose: the partner's own name proposal, or a public AI claim that carries a name (an adoption, a named confirmation).
    // The name is public either way. The extraction's respondsToTurn names the AI turn that was just answered, so for this act it does not have to be the claim's turn.
    // v11 (#198): a short approval request that answers the AI's question about a name ("いい？") answers the partner's latest name proposal:
    // the latest proposal of the partner in the current naming interval and before the request. The question itself names nothing, so the proposal is the claim the request carries the name from.
    if (refinedReplyRules && keepUnboundApproval && prior?.speaker === "ai" && prior.act === "ask" && act === "name_propose" && name === null && aspect === "name") {
      // The latest proposal of the partner inside the current naming interval and before this request (not before the question the classifier linked: the same question may have been asked twice), whether or not it names a figure: a later, corrected proposal is the one the request answers,
      // and a proposal from before an agree, defer or move_on is not carried into the next figure.
      const proposal = active.filter(c => c.speaker === "human" && c.act === "name_propose" && c.aspect === "name" && c.name !== null && c.sourceTurn > namingIntervalStart && c.sourceTurn < turn)
        .sort((x, y) => x.sourceTurn - y.sourceTurn || x.turn - y.turn).at(-1);
      // (NB-26N-2) A proposal that named a figure is carried only to a question about that figure: after the partner left a figure without any boundary action, the next figure's question does not take its old name.
      if (proposal && (proposal.targets.length === 0 || prior.targets.length === 0 || overlap(proposal.targets, prior.targets))) prior = proposal;
    }
    const approvalRequest = keepUnboundApproval && !!prior && act === "name_propose" && name === null && aspect === "name" && prior.aspect === "name" &&
      (approvalFromNamedClaim ? ["name_propose", "name_accept"].includes(prior.act) : prior.act === "name_propose" && prior.speaker === "human") && prior.name !== null;
    // jev_generation_retry_v9: a question whose target the binding supplied keeps that provenance in its claim, so the rule below also holds on later turns.
    const checkedFigure = prior && (referenceQuestionBindings?.get(prior.id) ?? (prior.source === AI_BOUND_SOURCE ? prior.targets[0] : undefined));
    const boundQuestion = checkedFigure && prior?.act === "ask" && previousClaims.includes(prior) &&
      prior.targets.length === 1 && prior.targets[0] === checkedFigure ? prior : null;
    // The question defines the target of a direct affirmation or denial, even
    // when the extraction also includes other figures.
    if (bindDirectQuestionReplies && prior?.act === "ask" && previousClaims.includes(prior) &&
        (act === "agree" || act === "deny") && name === null &&
        isFigureReplyAspect(aspect) && isFigureReplyAspect(prior.aspect) && prior.targets.length === 1 &&
        (segment.respondsToTurn === null || segment.respondsToTurn === prior.sourceTurn) &&
        targets.length > 0 && (targets.length !== 1 || targets[0] !== prior.targets[0])) {
      if (graph.memoryPruneVersion === CLAIM_PRUNE_V3) { reject("inconsistent_claim_response"); continue; }
      targets = [...prior.targets];
    }
    // v12: the classifier's closed label stands in for the quote's pointing words; every other condition below (agree, no name, the question's only figure, nothing opposing) is unchanged.
    const labelled = !!boundQuestion && !directsToFigure(quote, directReferenceReplies) && answerFieldRules && verdict.answersChecked === "yes";
    const pointsToFigure = !!boundQuestion && (directsToFigure(quote, directReferenceReplies) || labelled);
    const agreesWithCheckedFigure = !!boundQuestion && pointsToFigure && act === "agree" && name === null &&
      (directReferenceReplies ? figureReplyAspects.has(aspect) && figureReplyAspects.has(boundQuestion.aspect) :
        aspect === "referent" && boundQuestion.aspect === "question") &&
      (targets.length === 0 || targets.length === 1 && targets[0] === boundQuestion.targets[0]) &&
      (!directReferenceReplies || !opposesPointingReply(segment, boundQuestion, boundQuestion.targets[0], human.text, segments, verdicts, ownSlots));
    // A same-aspect extraction of a pointing reply must pass the direct check too.
    // A supplied target is used only by a reply that passed the direct check; any other agree is the v7 case (a response to a question that has no target).
    if (directReferenceReplies && boundQuestion && act === "agree" && !agreesWithCheckedFigure &&
        (boundQuestion.aspect === "question" || pointsToFigure || boundQuestion.source === AI_BOUND_SOURCE || isSuppliedBinding(referenceQuestionBindings, boundQuestion.id))) {
      reject("inconsistent_claim_response"); continue;
    }
    // An explicitly targeted question can have a local answer even when its
    // public description did not establish a naming target.
    const agreesWithLocalQuestion = retainLocalQuestionAnswers && !boundQuestion && prior?.act === "ask" &&
      prior.aspect === "question" && prior.source === "ai_hypothesis" && previousClaims.includes(prior) &&
      act === "agree" && verdict.answersChecked === "yes" && name === null && aspect !== prior.aspect &&
      isFigureReplyAspect(aspect) && prior.targets.length === 1 && segment.targets.length === 1 &&
      segment.targets[0] === prior.targets[0] &&
      (segment.respondsToTurn === null || segment.respondsToTurn === prior.sourceTurn) &&
      !opposesPointingReply(segment, prior, prior.targets[0], human.text, segments, verdicts, ownSlots);
    if (agreesWithCheckedFigure && boundQuestion) aspect = boundQuestion.aspect;
    if (agreesWithLocalQuestion) aspect = "question";
    // v12: a reply counted because of the label (not the quote's own words) keeps that provenance in its claim, so the naming scope reads it the same way on later turns.
    const labelledAnswer = agreesWithCheckedFigure && labelled;
    // v9: a supplied target is the question's only for a reply that passed the direct check. Any other reply that adds information
    // (agree was rejected above; assert and construe here) is judged against the question as extracted, which named no figure.
    if (prior && prior.source === AI_BOUND_SOURCE && !agreesWithCheckedFigure && ["agree", "assert", "construe"].includes(act)) prior = { ...prior, targets: [] };
    if (directReferenceReplies && prior && name === null && figureReplyAspects.has(aspect) &&
        figureReplyAspects.has(prior.aspect) && prior.targets.length === 1 &&
        (targets.length === 0 || targets.length === 1 && targets[0] === prior.targets[0])) {
      const withdrawnQuestion = act === "withdraw" && prior.speaker === "human" && prior.act === "agree" &&
        active.some(c => c.id === prior?.respondsTo && c.speaker === "ai" && c.act === "ask");
      if (withdrawnQuestion || (act === "deny" || act === "ask") && prior.speaker === "ai" && prior.act === "ask" &&
          !(refinedReplyRules && act === "ask" && segment.respondsToTurn !== null && segment.respondsToTurn !== prior.sourceTurn)) aspect = prior.aspect;
    }
    if (!agreesWithCheckedFigure && !agreesWithLocalQuestion && (isBareDeictic(quote) || /^(?:それ|これ|あれ)で(?:いい|良い|よい)(?:です)?[。！!？?\s]*$/u.test(quote.normalize("NFKC").trim()))) {
      // ai1 is the program-owned primary act. A secondary feature (ai2) cannot
      // receive a bare acknowledgment, even if the classifier selected its ID.
      const primary = previousClaims.filter(c => c.id === `${c.turn}:ai1`);
      if (!approvalRequest && (primary.length !== 1 || !prior || prior.id !== primary[0].id || !responses.has(act))) {
        act = "acknowledge"; prior = null; targets = []; linkedIssue = null; name = null;
      }
    }
    if (verdict.respondsToClaimId !== null && !prior && act !== "acknowledge" && !independentActs.has(act)) { reject("missing_claim_response"); continue; }
    if (responses.has(act) && !prior) { reject("missing_claim_response"); continue; }
    let droppedAntecedent: string | null = null;
    // Independent statements do not require an antecedent. Check before target
    // inheritance so discarding a pointer cannot transfer its figure candidates.
    // An approval question about a name, linked by the classifier to an earlier name proposal while neither names a figure, has no figure to contradict: the link stays.
    // An approval request ("is that name fine?") is a name proposal that carries the earlier proposal's name; neither names a figure, so there is none to contradict.
    // A question about a name (ask) that the classifier links to an earlier unbound name proposal keeps its link too: it asks about the same name, naming no figure.
    // It is a plain question, not an approval request (the typed naming request counts name proposals only).
    const unboundNameQuestion = keepUnboundApproval && !!prior && act === "ask" && aspect === "name" && prior.aspect === "name" && prior.act === "name_propose";
    const unboundApproval = (approvalRequest || unboundNameQuestion) && prior!.targets.length === 0 && targets.length === 0;
    // v11 (NB-26N-3): withdrawing one's own name proposal that named no figure withdraws it (neither side names a figure, so there is none to contradict).
    const unboundWithdraw = refinedReplyRules && act === "withdraw" && prior?.speaker === "human" && prior.act === "name_propose" && prior.aspect === "name" &&
      prior.targets.length === 0 && targets.length === 0 && (aspect === "name" || aspect === "progress");
    if (unboundWithdraw) aspect = "name";
    if (prior && independentActs.has(act) && prior.sourceTurn < turn &&
        (prior.aspect !== aspect || !unboundApproval && !unboundWithdraw && !overlap(prior.targets, targets.length ? targets : prior.targets) ||
          (!(approvalRequest && approvalFromNamedClaim) && segment.respondsToTurn !== null && segment.respondsToTurn !== prior.sourceTurn))) {
      droppedAntecedent = prior.id; prior = null;
    }
    // Outside the direct-question rule above, only absence of a target can
    // inherit the verified antecedent's candidates.
    const inheritedTargets = prior !== null && targets.length === 0 && prior.targets.length > 0;
    if (prior && targets.length === 0) targets = [...prior.targets];
    // Deferring or revisiting an issue inherits its aspect only when extraction
    // supplied generic progress. Explicit semantic disagreements remain invalid.
    if (prior && aspect === "progress" && ["defer", "revisit"].includes(act)) aspect = prior.aspect;
    if (prior && (prior.sourceTurn >= turn || prior.aspect !== aspect || !unboundApproval && !unboundWithdraw && !overlap(prior.targets, targets) ||
        (!(approvalRequest && approvalFromNamedClaim) && segment.respondsToTurn !== null && segment.respondsToTurn !== prior.sourceTurn))) {
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
    if (act === "name_propose" && approvalRequest && prior) name = prior.name;
    else if (act === "name_propose") {
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
      speaker: "human", sourceTurn: turn, quote, respondsTo: prior?.id ?? null,
      source: agreesWithLocalQuestion ? LOCAL_QUESTION_ANSWER_SOURCE : labelledAnswer ? LABELLED_ANSWER_SOURCE : "partner_statement" });
    if (keepUnboundApproval && inheritedTargets) (result.diagnostics ??= []).push({ segmentId: segment.segmentId, reason: "targets_inherited", claimId: id, respondsToClaimId: prior!.id });
    if (overriddenIssue || droppedIssue) (result.diagnostics ??= []).push({ segmentId: segment.segmentId, reason: "issue_link_overridden",
      linkedIssueId: ref(proposedIssue) ? proposedIssue : null, resolvedIssueId: issueId });
    if (droppedAntecedent !== null) (result.diagnostics ??= []).push({ segmentId: segment.segmentId, reason: "antecedent_dropped",
      respondsToClaimId: droppedAntecedent, resolvedIssueId: issueId });
    if (missingAntecedent && independentActs.has(act)) (result.diagnostics ??= []).push({ segmentId: segment.segmentId, reason: "antecedent_missing",
      respondsToClaimId: ref(verdict.respondsToClaimId) ? verdict.respondsToClaimId : null, resolvedIssueId: issueId });
  }
  return result;
}

/** The reason a verified operation the memory then refused is recorded under (the run and S4 share it). */
export const memoryRejectionReason = (code: unknown): string => "memory_" + (typeof code === "string" && /^[a-z][a-z0-9_]{0,59}$/.test(code) ? code : "invalid_update");
/** The run's own step for one verified operation: append it to the update and let the memory validate the whole update, so an operation beyond the memory's limits is refused
 * while the earlier ones stand. S4 applies the redone operations through this same function, in the same order, on the graph before the turn. */
export function applyVerifiedOperation<U extends { operations: unknown[] }>(graph: LocalGraph, update: U, operation: unknown, publicTurns: readonly PublicTurn[]):
  { applied: true; update: U } | { applied: false; reason: string } {
  const candidate = { ...update, operations: [...update.operations, operation] };
  try { return { applied: true, update: validateReferenceUpdate(graph, candidate, { publicTurns }) as unknown as U }; }
  catch (error) {
    if (!(error instanceof ReferenceGraphError)) throw error;
    return { applied: false, reason: memoryRejectionReason((error as { code?: unknown }).code) };
  }
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

/** Bind one targetless question to the executed figure only when the already
 * published description supports that single figure. Pending extraction stays raw. */
const SUPPLIED_SUFFIX = "#supplied";
/** True when the binding gave the question its figure (its extraction had none), as opposed to confirming a target the extraction already carried. */
export const isSuppliedBinding = (bindings: ReadonlyMap<string, string> | undefined, questionId: string): boolean => bindings?.has(questionId + SUPPLIED_SUFFIX) === true;
export function bindPublishedReferenceQuestion(pending: AiPublicPending | null | undefined,
  prior: Pick<LocalPriorAct, "turn" | "action" | "targetSlot" | "publishedFallback"> | undefined,
  source: (PublicTurn & { nonReferential?: boolean }) | undefined, turn: number, directReferenceReplies = false): Map<string, string> {
  const bound = new Map<string, string>();
  if (!pending || !prior || prior.publishedFallback || !prior.targetSlot ||
      (prior.action !== "confirm" && prior.action !== "repair") ||
      source?.speaker !== "ai" || source.nonReferential || source.turn !== pending.aiSeq || source.turn !== prior.turn ||
      (pending.status !== "ready" && pending.status !== "partial")) return bound;
  const cited = pending.candidates.filter(c => c.sourceTurn === source.turn && source.text.includes(c.quote));
  const questions = cited.filter(c => c.act === "ask");
  const descriptions = cited.filter(c => ["assert", "agree", "construe"].includes(c.act) &&
    ["referent", "part", "contour", "construal"].includes(c.aspect) && c.targets.length > 0);
  const question = questions[0];
  const figure = prior.targetSlot;
  if (questions.length === 1 &&
      (directReferenceReplies ? figureReplyAspects.has(question.aspect) : question.aspect === "question") &&
      (question.targets.length === 0 || directReferenceReplies && question.targets.length === 1 && question.targets[0] === figure) &&
      descriptions.some(c => c.targets.length === 1 && c.targets[0] === figure) &&
      descriptions.every(c => c.targets.includes(figure))) {
    bound.set(`${turn}:pub${question.ordinal}`, figure);
    // Only a question whose extraction left the target empty gets the executed figure from this binding. That supplied
    // target is evidence only for a reply that passes the direct check (see isSuppliedBinding).
    if (question.targets.length === 0) bound.set(`${turn}:pub${question.ordinal}${SUPPLIED_SUFFIX}`, figure);
  }
  return bound;
}

/** Recover literal names from a committed act whose AI turn is public.
 * Private plan features are disabled by default. legacy_private_plan exists only
 * for historical gate/test reproduction, with the original fixed part aspect.
 */
export function recordAiClaims({ graph, turn, publicTurns, priorAct, featureSource = "none" }: {
  graph: LocalGraph; turn: number; publicTurns: readonly PublicTurn[]; priorAct: LocalPriorAct;
  featureSource?: "none" | "legacy_private_plan";
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
    if (act.discriminatingFeature !== null) {
      // Reserve the historical ordinal even when no feature claim is created:
      // later follow-up names must retain their IDs and secondary role.
      if (featureSource === "legacy_private_plan") add("part", act.discriminatingFeature, act.action === "confirm" ? "ask" : "assert");
      else ordinal++;
    }
    // A follow-up never becomes primary if the main act had no literal element.
    if (ordinal === 0) ordinal = 1;
  }
  return result;
}
