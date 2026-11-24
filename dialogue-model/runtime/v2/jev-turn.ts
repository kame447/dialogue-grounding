import {applyBypassAcceptance,interventionForStrategy,BypassAcceptanceError,BYPASS_ACCEPTANCE_V1_TABLE_SHA256,isOpenIssueRerankRecord} from '../decision/bypass-acceptance.ts';
import type {ExecutedDecision,InterventionConfig,InterventionTrace} from '../decision/bypass-acceptance.ts';
import {JEV_ACTIONS} from '../decision/contract.ts';
import {validateOwnLedger} from '../judgment/schema.mjs';
// Decision 0002, opt-in only. The queue owns publication; this module returns a
// detached candidate state and never turns a model score into shared evidence.
import type { Judgment, OwnLedger } from "../judgment/schema.mjs";
import { createOwnLedger, validateJudgment, applyJudgment, JudgmentValidationError } from "../judgment/schema.mjs";
import { normalizeName } from "../judgment/name-evidence.mjs";
import { stageMemory } from "../judgment/memory.mjs";
import { createReferenceGraph, applyReferenceUpdate, previewReferenceUpdate, snapshotReferenceGraph, REFERENCE_LIMITS } from "../memory/reference-graph.mjs";
import { priorClaimViews, summarizeLocalIssues } from "../local-grounding/derive.ts";
import { createMemoLocalExtractor, LOCAL_EXTRACTION_INSTRUCTIONS, MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from "../local-grounding/extract.ts";
import { LOCAL_CLASSIFICATION_INSTRUCTIONS } from "../local-grounding/classify.ts";
import type { LocalGroundingOptions, LocalOwnImage, LocalOwnAnchor, PublicTurn, LocalClaimView } from "../local-grounding/contract.ts";
import type { ObservationMemo, ObservationObserver, ReobservationResult } from "../observation/contract.ts";
import { validateObservationMemo, mergeReobservation, observationContextMessages, ObservationError, type ObservationErrorCode,
  OBSERVATION_INITIAL_INSTRUCTIONS, OBSERVATION_TARGETED_INSTRUCTIONS, OBSERVATION_MEMO_VERSION } from "../observation/observe.ts";
import type { JevDecision, JevDecisionClient, JevDecisionInput, JevObservationRequest, RepairHistoryEntry, HumanReferentEstimate, RepairProspectMaterial, AdaptiveRepairTrial, PublicNameCandidate, RepairFact, JevQuestionLayout } from "../decision/contract.ts";
import { deriveRepairFacts, validateRepairFacts } from "../decision/repair-facts.ts";
import { validateJevDecision, validateHumanReferentEstimate, validateRepairProspectEstimate, validateRepairProspectMaterial, unknownRepairProspect, JevDecisionError, JEV_DECISION_INPUT_LIMITS,
  projectDecisionFailureEvidence, checkDecisionFailureEvidence, TWO_STAGE_V2_CANDIDATE_SETS, candidateSetLabel, V3_TARGET_LABEL_SET } from "../decision/jev-decision.ts";
import type { JevDecisionFailureEvidence } from "../decision/jev-decision.ts";
import { prepareLocalGroundingTurn, validateLocalGroundingOptions, findLocalPublicationViolations } from "./local-grounding-turn.ts";
import type { LocalGroundingResearchRecord, LocalGroundingTrace } from "./local-grounding-turn.ts";
import { findAgreeNameMismatch, findProposeNameMismatch, findGuardViolations, findOrientationLeaks, findWorkingNoteLeaks, orientationSafeFallback, rewriteReasons } from "./generation-guard.ts";
import { createMemoAiExtractor, MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS, AiPublicError, aiHash, emptyAiEvidence } from "../local-grounding/extract-ai.ts";
import { createJevAiFunctionClassifier, createJevAiSupportChecker, AI_FUNCTION_INSTRUCTIONS, AI_SUPPORT_INSTRUCTIONS,
  AI_RESPONSE_SUPPORT_INSTRUCTIONS, AI_FUNCTION_CRITERIA, AI_SUPPORT_CHOICES, AI_ACT_DESCRIPTIONS } from "../local-grounding/jev-ai-public.ts";
import { initialAiPublicState, validateAiPublicState, prependAiPublic, verifyAiPublicUpdate } from "../local-grounding/verify-ai.ts";
import type { AiPublicState, AiPublicPending, AiPublicResearch, AiStageEvidence, AiPublicInput } from "../local-grounding/contract.ts";
import { JevLocalTestError } from "../local-grounding/jev-local-test.ts";
import type { JevChoiceTransportOptions, JevChoiceEvidence } from "../local-grounding/jev-local-test.ts";
import { AIConnectionError } from "../client.mjs";
import { agreementGate, inferenceHistory, checkRepairGate } from "./agreement-gate.ts";
import type { RepairGate } from "./agreement-gate.ts";

type Graph = Parameters<typeof prepareLocalGroundingTurn>[1]["graph"];
type Event = { id: string; seq: number; speaker: "human" | "ai"; text: string; nonReferential?: boolean };
type Message = { role: "system" | "user" | "assistant"; content: string };
type ChatClient = { complete(messages: Message[], options: { phase: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ text: string }> };
type Guard = { violations: string[]; regenerated: boolean; fallback: boolean };
export type GenerationRetryVersion = "jev_generation_retry_v1" | "jev_generation_retry_v2";
const ACT_INSTRUCTIONS = "Jevが選んだ行動だけを文章にしてください。行動と対象は変更せず、選択済みの名前・特徴があればそれに従ってください。選択済みの特徴がないacceptでは、相手の問いに観察メモで確かめられる範囲（ある・ない・確かめられない）で直接答えてよく、新しい名前や特徴の確認質問は足さないでください。観察メモは仮説で、局所的な支持を図形全体の理解や名称決定へ拡張しないでください。";
// two_stage_v3 only (new text, not yet reviewed by Argon): a revisit whose target stays a candidate set.
export const REVISIT_MULTIPLE_INSTRUCTIONS = "対象は複数候補のままです。選ばれた行動は、先ほどの未解決の区別に戻ることだけです。どの候補かを勝手に一つに絞らず、名前に決まったとは言わないでください。候補の数や内部の参照IDは相手に伝えず、相手が知らないことを知っているかのようにも話さないでください。";
const DETAIL_INSTRUCTIONS = "対象は複数候補のままです。detailFigureIdsは選ばれた特徴の出典図形であり、対象の確定ではありません。その特徴を候補すべての性質にせず、候補を勝手に一つに絞らずに確認・修復を表現してください。";
export type JevTurnLocalOptions = Pick<LocalGroundingOptions, "classifier" | "timeoutMs" | "researchLimits"> & {
  aiPublicClaims?: boolean;
  /** Dependency injection for mock/local HTTP. The model and URL remain fixed. */
  aiPublicTransport?: JevChoiceTransportOptions;
};
export type JevTurnErrorCode = "invalid_state" | "observation_failed" | "decision_failed" | "invalid_decision" |
  "reobservation_limit" | "generation_failed" | "unsafe_generation" | "aborted" | "invalid_intervention" | "alternative_failed";
export type ObservationFailure = { observationErrorCode: ObservationErrorCode; observationPhase: "initial" | "targeted" };
export const JEV_GENERATION_ERROR_CODES = Object.freeze(["timeout", "network_error", "invalid_json", "empty_response", "provider_http_error",
  "policy_http_error", "invalid_policy_response", "invalid_response", "unavailable"] as const);
export type JevGenerationErrorCode = typeof JEV_GENERATION_ERROR_CODES[number];
const JUDGMENT_REJECTION_CODES = ["reassignment_requires_repair", "duplicate_name_requires_repair", "inconsistent_action", "agree_requires_shared_identification"] as const;
const TURN_REJECTION_CODES = ["agree_without_public_proposal", "action_target_not_allowed", ...JUDGMENT_REJECTION_CODES] as const;
export type JevTurnFailureDetails = { decisionRejectionCode?: typeof TURN_REJECTION_CODES[number]; generationErrorCode?: JevGenerationErrorCode };
export type JevHumanReferentTrace = HumanReferentEstimate & {
  turnIndex: number;
  /** SHA-256 of JSON.stringify of the validated memo supplied to estimation. */
  observationMemo: { version: number; sha256: string };
};
export class JevTurnError extends Error {
  code: JevTurnErrorCode;
  observationErrorCode?: ObservationErrorCode;
  observationPhase?: ObservationFailure["observationPhase"];
  decisionRejectionCode?: JevTurnFailureDetails["decisionRejectionCode"];
  generationErrorCode?: JevGenerationErrorCode;
  constructor(code: JevTurnErrorCode, observation?: ObservationFailure, details: JevTurnFailureDetails = {}) {
    const safe = (["invalid_state", "observation_failed", "decision_failed", "invalid_decision", "reobservation_limit",
      "generation_failed", "unsafe_generation", "aborted", "invalid_intervention", "alternative_failed"] as const).includes(code) ? code : "invalid_state";
    super(safe); this.name = safe === "aborted" ? "AbortError" : "JevTurnError"; this.code = safe;
    if (observation && (observation.observationPhase === "initial" || observation.observationPhase === "targeted")) {
      this.observationPhase = observation.observationPhase;
      this.observationErrorCode = new ObservationError(observation.observationErrorCode).code;
    }
    if (details.decisionRejectionCode && TURN_REJECTION_CODES.includes(details.decisionRejectionCode)) this.decisionRejectionCode = details.decisionRejectionCode;
    if (details.generationErrorCode !== undefined) this.generationErrorCode = JEV_GENERATION_ERROR_CODES.includes(details.generationErrorCode)
      ? details.generationErrorCode : "unavailable";
  }
}
/** Never copy arbitrary code/message/response properties from an injected client. */
export function normalizeGenerationErrorCode(error: unknown): JevGenerationErrorCode {
  try {
    const code = error instanceof AIConnectionError ? error.code : error instanceof JevTurnError ? error.generationErrorCode : undefined;
    if (JEV_GENERATION_ERROR_CODES.includes(code)) return code;
  } catch { /* Modified typed errors may have throwing getters. */ }
  return "unavailable";
}
// Only these constructors own the closed codes. Unknown, spoofed or modified
// provider exceptions cannot put their messages, responses or tokens into logs.
function observationFailure(error: unknown, phase: ObservationFailure["observationPhase"], aborted = false): ObservationFailure {
  let code: ObservationErrorCode = "unavailable";
  try {
    if (aborted) code = "aborted";
    else if (error instanceof ObservationError) code = new ObservationError(error.code).code;
    else if (error instanceof JevTurnError && error.observationErrorCode !== undefined) code = new ObservationError(error.observationErrorCode).code;
  } catch { code = "unavailable"; }
  return { observationErrorCode: code, observationPhase: phase };
}
export type JevTurnTrace = {
  turnIndex: number; lastEventId: string | null; attemptNumber: number;
  status: "staged" | "committed" | "superseded" | "error" | "aborted";
  initialObservation: ObservationMemo | null;
  reobservations: Array<{ request: JevObservationRequest; result: ReobservationResult }>;
  local: LocalGroundingResearchRecord | null;
  humanReferent: JevHumanReferentTrace | null;
  repairProspect?: RepairProspectMaterial;
  repairGate?: RepairGate;
  repairFacts?: RepairFact[];
  decisions: JevDecision[];
  intervention: "none_pending_researcher_decision" | InterventionTrace | null;
  schemaVersion?: "jev_turn_trace_v2"; executed?: ExecutedDecision | null;
  finalAction: Judgment | null;
  publicSpeech: string | null;
  observationMemo: ObservationMemo | null;
  repairHistory: RepairHistoryEntry[];
  generationGuard: Guard;
  generationRetryVersion?: "jev_generation_retry_v2";
  errorCode?: JevTurnErrorCode;
  observationErrorCode?: ObservationErrorCode;
  observationPhase?: ObservationFailure["observationPhase"];
  decisionRejectionCode?: JevTurnFailureDetails["decisionRejectionCode"];
  generationErrorCode?: JevGenerationErrorCode;
  /** Owner-private, failed decide() attempts only: the closed evidence of that very call, or null when it is unknown
   * (e.g. the deadline won the race, or an injected client reported nothing). Never on success or other failures. */
  decisionFailure?: { evidence: JevDecisionFailureEvidence | null };
  redacted?: true;
  aiPublic?: AiPublicResearch;
};
type CommittedAct = {
  turnIndex: number; lastEventId: string | null; status: "committed"; judgment: Judgment;
  generationGuard: Guard; jevTurn: { attemptNumber: number; decision: JevDecision; executed?:ExecutedDecision; intervention?:InterventionTrace; humanReferent?: JevHumanReferentTrace; repairProspect?: RepairProspectMaterial; repairGate?: RepairGate; agreeNames?: PublicNameCandidate[]; repairFacts?: RepairFact[] };
  localGrounding: LocalGroundingTrace;
  aiPublic?: { aiSeq: number; textSha256: string };
};
export type JevPrivateState = {
  schemaVersion?: "jev_private_state_v2"; interventionPolicy?: {version:"bypass_acceptance_v1";tableSha256:string};
  agreeNameScopeVersion?: "scoped_v1";
  ledger: OwnLedger; graph: Graph; judgments: CommittedAct[];
  observationMemo: ObservationMemo | null; repairHistory: RepairHistoryEntry[];
  aiPublic?: AiPublicState;
};
export type JevTurnOptions = {
  intervention?: InterventionConfig; decisionTimeoutMs?:number; technicalTrial?: AdaptiveRepairTrial;
  /** Omitted means two_stage_v1. Must match the decision client's own layout when it declares one. */
  questionLayout?: JevQuestionLayout;
  /** Offline replay can request the original retry wire text for a historical tape. */
  generationRetryVersion?: GenerationRetryVersion;
  client: ChatClient; ownImage: LocalOwnImage; ownAnchors: readonly LocalOwnAnchor[];
  observer: ObservationObserver; jevDecision: JevDecisionClient; localGrounding: JevTurnLocalOptions;
  maxReobservations?: number;
  onJevTurnTrace?: ((record: JevTurnTrace) => unknown) | null;
  onLocalGroundingTrace?: ((record: LocalGroundingResearchRecord) => unknown) | null;
  generation: { task: string; instructions: string; concise?: string; actionScope: Record<string, string>; final: string; timeoutMs: number };
};

/** Confirm only after the caller installs the candidate returned by runAiTurn. */
export function settleJevTurnTraces(records: readonly JevTurnTrace[], privateState: unknown): JevTurnTrace[] {
  const judgments = (privateState as { judgments?: CommittedAct[] })?.judgments;
  return records.map(record => ({ ...structuredClone(record), status: ["staged", "committed", "superseded"].includes(record.status)
    ? Array.isArray(judgments) && judgments.some(j => j.status === "committed" && j.turnIndex === record.turnIndex &&
      (j.lastEventId ?? null) === record.lastEventId && j.jevTurn?.attemptNumber === record.attemptNumber) ? "committed" : "superseded"
    : record.status }));
}

/** Queue commit identity, never staged attempts alone, establishes publication.
 * Persistence of this projection remains the caller's responsibility. */
export async function settleAiPublicClaims(records: readonly JevTurnTrace[], privateState: JevPrivateState) {
  return Promise.all(records.filter(r => r.aiPublic?.pending).map(async record => {
    const pending = record.aiPublic!.pending!;
    const committed = privateState.judgments?.some(j => j.status === "committed" && j.turnIndex === record.turnIndex &&
      (j.lastEventId ?? null) === record.lastEventId && j.jevTurn?.attemptNumber === record.attemptNumber &&
      j.aiPublic?.aiSeq === pending.aiSeq && j.aiPublic?.textSha256 === pending.textSha256);
    const published = committed && record.publicSpeech !== null && await aiHash(record.publicSpeech) === pending.textSha256;
    const installed = privateState.aiPublic?.pending;
    const log = privateState.aiPublic?.log.find(l => l.aiSeq === pending.aiSeq);
    const sourceStatus = log?.status ?? (installed?.aiSeq === pending.aiSeq && installed.textSha256 === pending.textSha256 ? installed.status : "unknown");
    return { turnIndex: record.turnIndex, lastEventId: record.lastEventId, attemptNumber: record.attemptNumber,
      aiSeq: pending.aiSeq, textSha256: pending.textSha256, sourceStatus,
      status: !published ? "unpublished" : sourceStatus === "failed" ? "published_failed" : log ? "published_applied_or_rejected"
        : sourceStatus === "unknown" ? "published_unknown" : "published_unapplied" };
  }));
}

function abortIf(signal?: AbortSignal) { if (signal?.aborted) throw new JevTurnError("aborted"); }
async function observationHash(memo: ObservationMemo): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(memo)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function interruptible<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let listener: () => void = () => {};
  const canceled = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new JevTurnError("aborted"));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try { return await Promise.race([work, canceled]); }
  finally { signal.removeEventListener("abort", listener); }
}
function emit<T>(sink: ((value: T) => unknown) | null | undefined, value: T) {
  if (!sink) return;
  try { Promise.resolve(sink(structuredClone(value))).catch(() => {}); }
  catch { /* Research sinks cannot affect publication. */ }
}
const targets = (decision: Pick<JevDecision, "target">) => decision.target.kind === "single" ? [decision.target.figureId]
  : decision.target.kind === "multiple" ? [...decision.target.figureIds] : [];
const contentKey = (claim: LocalClaimView) => JSON.stringify([claim.aspect, claim.act, claim.proposition, claim.name]);
const INFORMATION_ACTS = new Set(["assert", "agree", "deny", "construe", "name_propose", "name_accept", "name_reject"]);
const figureInformation = (claim: LocalClaimView) => INFORMATION_ACTS.has(claim.act) && !["question", "progress"].includes(claim.aspect);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
/** two_stage_v2: the only labels a saved candidate-set stage may score (fixed 2-6 own-figure subsets). */
const CANDIDATE_SET_LABELS = TWO_STAGE_V2_CANDIDATE_SETS.map(candidateSetLabel);
// Shared with the publication rejection below; no new semantic acceptance rule.
const eligibleAgreeClaim = (c: LocalClaimView) => c.aspect === "name" && c.name !== null && c.targets.length === 1 &&
  (c.speaker === "human" && c.act === "name_propose" || c.act === "name_accept");

function buildAgreeNamesV3(claims: readonly LocalClaimView[], publicTurns: readonly PublicTurn[], turn: number,
  slots: readonly string[], { ledger, judgments, agreeNameScopeVersion }: Pick<JevPrivateState, "ledger" | "judgments" | "agreeNameScopeVersion">,
  current: { status: string; scores: Record<string, number> | null } | null = null): PublicNameCandidate[] {
  const isHumanProposal = (c: LocalClaimView) => c.speaker === "human" && c.act === "name_propose";
  const publicClaims = claims.filter(c => c.aspect === "name" && c.name !== null &&
    publicTurns.some(t => t.turn === c.sourceTurn));
  // A committed AI reply resolves or leaves the previous naming interval when it agrees, defers or moves on.
  const lastBoundary = judgments.filter(j => ["agree", "defer", "move_on"].includes(j.judgment.action)).at(-1)?.turnIndex ?? 0;
  const openClaims = publicClaims.filter(c => c.sourceTurn > lastBoundary);
  const proposals = openClaims.filter(isHumanProposal);
  const scoped = agreeNameScopeVersion === "scoped_v1";
  const latestProposal = (scoped ? proposals.filter(p => p.targets.length === 0) : proposals).at(-1)?.sourceTurn;
  const focusedTurns = judgments.flatMap(({ turnIndex, jevTurn }) => {
    const ids = jevTurn.executed ? targets(jevTurn.executed) : [];
    return turnIndex > lastBoundary && ids.length ? [{ turnIndex, ids }] : [];
  });
  const prevJudgment = judgments.at(-1);
  const prevIds = prevJudgment && prevJudgment.turnIndex > lastBoundary && prevJudgment.jevTurn.executed &&
    ["confirm", "repair", "propose_name"].includes(prevJudgment.judgment.action) ? targets(prevJudgment.jevTurn.executed) : [];
  const prevFallbackConfirm = prevIds.length > 0 && prevJudgment?.generationGuard?.fallback === true &&
    ["confirm", "repair"].includes(prevJudgment.judgment.action);
  const prevPublicIds = new Set(prevJudgment && prevIds.length ? claims.filter(c => c.speaker === "ai" &&
    c.sourceTurn > prevJudgment.turnIndex && c.sourceTurn < turn).flatMap(c => c.targets) : []);
  const wasFocused = (id: string) => prevIds.includes(id) || focusedTurns.some(j => j.ids.includes(id));
  // The partner's own latest word on whether a figure is the one meant: a referent denial (targets taken from the claim it answers when it has none)
  // blocks agreement on that figure until a later referent claim of theirs re-affirms it. This is about the target, not about the proposed name.
  const claimTargets = (c: LocalClaimView) => c.targets.length ? c.targets : claims.find(p => p.id === c.respondsTo)?.targets ?? [];
  const referentClaims = claims.filter(c => c.speaker === "human" && c.aspect === "referent" && c.sourceTurn > lastBoundary);
  // A denial stands until the partner agrees with an AI public claim that refers only to that figure, and the referent estimate puts it strictly first.
  // An agree about one member of the AI's candidate set, a bare assert and other acts leave the denial in place.
  const referentAt = (at: number) => at === turn ? current : judgments.find(j => j.turnIndex === at)?.jevTurn.humanReferent ?? null;
  const selects = (m: { status: string; scores: Record<string, number> | null } | null, id: string) =>
    !!m && m.status === "ok" && !!m.scores && typeof m.scores[id] === "number" && Object.entries(m.scores).every(([key, value]) => key === id || m.scores![id] > value);
  const referentDenied = (id: string) => {
    const lastDeny = referentClaims.filter(c => c.act === "deny" && claimTargets(c).includes(id)).at(-1);
    if (!lastDeny) return false;
    const after = referentClaims.slice(referentClaims.indexOf(lastDeny) + 1);
    return !after.some(c => {
      if (c.act !== "agree") return false;
      const antecedent = claims.find(p => p.id === c.respondsTo);
      return antecedent?.speaker === "ai" && antecedent.targets.length === 1 && antecedent.targets[0] === id &&
        (c.targets.length === 0 || c.targets.length === 1 && c.targets[0] === id) && selects(referentAt(c.sourceTurn), id);
    });
  };
  const aiSharedIds = new Set(claims.filter(c => c.speaker === "ai" && c.sourceTurn > lastBoundary && c.sourceTurn < turn).flatMap(c => c.targets));

  return openClaims.flatMap(c => {
    const name = c.name!;
    if (!isHumanProposal(c) && c.act !== "name_accept") return [];
    // A generic fallback confirm/repair did not publicly ground any figure; never let an unbound human proposal jump to immediate agree.
    if (prevFallbackConfirm && c.sourceTurn === turn && isHumanProposal(c) && c.targets.length === 0) return [];
    const requiresFocus = prevPublicIds.size > 0 ||
      (prevIds.length > 0 && c.sourceTurn === turn && isHumanProposal(c) && c.targets.length > 0);
    const normalized = normalizeName(name);
    if (c.sourceTurn < turn) {
      const focusMoved = c.targets.length > 0 && focusedTurns.some(j =>
        j.turnIndex >= c.sourceTurn && !c.targets.some(id => j.ids.includes(id)));
      const replaced = !scoped && proposals.some(p => p.sourceTurn > c.sourceTurn && normalizeName(p.name!) !== normalized);
      if (focusMoved || replaced) return [];
    }
    const currentUnbound = c.sourceTurn === turn || isHumanProposal(c) && c.sourceTurn === latestProposal;
    // An unbound partner proposal can be agreed only for a figure the AI has already shared publicly (a public AI claim about it) and executed on;
    // otherwise the approval request is answered by confirming which figure is meant.
    const candidates = c.targets.length ? c.targets : currentUnbound ? slots.filter(id => aiSharedIds.has(id) && wasFocused(id)) : [];
    const antecedent = c.act === "name_accept" ? publicClaims.find(p => p.id === c.respondsTo && p.name === name) : undefined;
    const source = publicTurns.find(t => t.turn === c.sourceTurn && t.text.includes(name)) ??
      (antecedent && publicTurns.find(t => t.turn === antecedent.sourceTurn && t.text.includes(name))) ??
      (c.act === "name_accept" ? publicTurns.filter(t => t.text.includes(name)).sort((a, b) => a.turn - b.turn)[0] : undefined);
    if (!source) return [];
    const occupied = slots.filter(id => ledger[id].name !== null && normalizeName(ledger[id].name) === normalized);
    return candidates.filter(id => {
      // Supersession applies to this candidate, using a verified reply or an explicitly bound target.
      if (scoped && proposals.some(p => {
        if (p.sourceTurn <= c.sourceTurn) return false;
        const linked = p.respondsTo === c.id || (antecedent !== undefined && p.respondsTo === antecedent.id);
        const slot = p.targets.length === 1 ? p.targets[0] : null;
        if (normalizeName(p.name!) !== normalized) return linked || slot === id;
        return slot !== null && slot !== id && (linked || c.targets.length === 1);
      })) return false;
      if (referentDenied(id)) return false;
      if (requiresFocus && !wasFocused(id)) return false;
      if (prevPublicIds.size && !prevPublicIds.has(id)) return false;
      const entry = ledger[id];
      if (entry.status === "agreed" || entry.status === "deferred" && entry.name !== null && !occupied.includes(id) ||
        occupied.some(other => other !== id)) return false;
      return !openClaims.some(r => r.speaker === "human" && r.sourceTurn > c.sourceTurn &&
        (r.act === "deny" || r.act === "name_reject") && r.name === name && (r.respondsTo === c.id || r.targets.includes(id)));
    }).map(figureId => ({ name, figureId, sourceTurn: source.turn }));
  });
}

/** The names already agreed in this committed snapshot, keyed only by own figure IDs. */
export function agreedNamesFromLedger(ledger: OwnLedger): Record<string, string> {
  return Object.fromEntries(Object.entries(ledger).flatMap(([slot, entry]) =>
    entry.status === "agreed" && entry.name !== null ? [[slot, entry.name]] : []));
}

const hasAgreeNameV3 = (names: readonly PublicNameCandidate[], name: string | null, figureId: string | null) =>
  names.some(n => n.name === name && n.figureId === figureId);

/** Decision 0002: new figure information or strict candidate narrowing only.
 * Difficulty, backchannels, repeated content and record pruning add no progress. */
export function updateRepairHistory(history: readonly RepairHistoryEntry[], before: readonly LocalClaimView[],
  after: readonly LocalClaimView[], turn: number, context?: { answeredRepairTurn: number;
    aiPublic?: { humanOk: boolean; rejected: Array<{ segmentId: string; reason: string }>; aiComplete: boolean } }): RepairHistoryEntry[] {
  const result = structuredClone(history) as RepairHistoryEntry[];
  const pending = context?.aiPublic ? result.find(entry => entry.turn === context.answeredRepairTurn && entry.turn < turn && entry.progress === "unknown")
    : [...result].reverse().find(entry => entry.turn < turn && entry.progress === "unknown");
  if (!pending) return result;
  const roots = after.filter(c => c.speaker === "ai" && c.sourceTurn > pending.turn && c.sourceTurn < turn &&
    c.targets.some(id => pending.candidatesBefore.includes(id)));
  const answered = context?.answeredRepairTurn === pending.turn;
  const replies = after.filter(c => c.speaker === "human" && c.sourceTurn === turn &&
    (c.issueId === pending.issueId || roots.some(root => c.respondsTo === root.id) || answered &&
      (!c.targets.length || c.targets.some(id => pending.candidatesBefore.includes(id)))));
  if (!replies.length && !answered) return result;
  const information = replies.filter(figureInformation);
  const previousContent = before.filter(c => c.speaker === "human" && figureInformation(c));
  const novel = information.filter(c => {
    if (!c.targets.length) return false;
    const duplicate = previousContent.some(prior => contentKey(prior) === contentKey(c) && prior.targets.some(id => c.targets.includes(id)));
    previousContent.push(c);
    return !duplicate;
  });
  pending.issueId ??= replies[0]?.issueId ?? roots.at(-1)?.issueId ?? null;
  pending.partnerClaims = replies.map(({ id, act, proposition, targets }) => ({ id, act, proposition, targets: [...targets] }));
  pending.candidatesAfter = information.length ? [...new Set(information.flatMap(c => c.targets))] : [...pending.candidatesBefore];
  pending.addedClaimIds = novel.map(c => c.id);
  pending.removedClaimIds = before.filter(c => c.issueId === pending.issueId && !after.some(next => next.id === c.id)).map(c => c.id);
  const narrowed = pending.candidatesAfter.length > 0 && pending.candidatesAfter.length < pending.candidatesBefore.length &&
    pending.candidatesAfter.every(id => pending.candidatesBefore.includes(id));
  pending.progress = novel.length || narrowed ? "changed" : "unchanged";
  if (context?.aiPublic) {
    const { humanOk, rejected, aiComplete } = context.aiPublic;
    const reasons = [...(!humanOk ? ["human_local_missing"] : []),
      ...(rejected.some(r => r.reason.startsWith("memory_") || r.reason === "operation_limit") ? ["human_capacity_dropped"] : []),
      ...(!aiComplete ? ["ai_source_incomplete"] : [])];
    Object.assign(pending, { missingReasons: reasons, humanRejections: structuredClone(rejected) });
    if (pending.progress !== "changed" && reasons.length) pending.progress = "unknown";
  }
  return result;
}

// New state boundary only. Historical catalogs require the recorded tape.
/** two_stage_v3: the target kinds each action may take (a literal copy of the contract table; never read from a question). */
const V3_ACTION_KINDS={accept:['none','single','multiple'],defer:['none','single','multiple'],move_on:['none','single','multiple'],close:['none','single','multiple'],
  propose_name:['single'],agree:['single'],confirm:['single','multiple'],repair:['single','multiple'],revisit:['single','multiple']} as const;
const stateExact=(x:any,keys:string[])=>!!x&&Object.getPrototypeOf(x)===Object.prototype&&Reflect.ownKeys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
function stateJson(x:unknown,seen=new Set<object>()):void {
 if(x===null||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))return;
 if(!x||typeof x!=='object'||seen.has(x))throw Error();const array=Array.isArray(x),keys=Reflect.ownKeys(x);
 if(Object.getPrototypeOf(x)!==(array?Array.prototype:Object.prototype)||array&&keys.length!==(x as unknown[]).length+1)throw Error();
 seen.add(x);for(const k of keys){if(array&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(x,k)!;
  if(typeof k!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||array&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=(x as unknown[]).length))throw Error();stateJson(d.value,seen);}seen.delete(x);
}
function stateSame(a:any,b:any):boolean {
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();return ak.length===bk.length&&ak.every((k,i)=>k===bk[i]&&stateSame(a[k],b[k]));
}
function checkedIntervention(x:unknown):InterventionConfig {
 try{stateJson(x);const c=x as InterventionConfig;if(!stateSame(c,interventionForStrategy(c.policy==='bypass_acceptance_v1:accept'?'bypass-enabled':c.policy==='bypass_acceptance_v1:veto'?'repair-first':null)))throw Error();return structuredClone(c);}
 catch{throw new JevTurnError('invalid_intervention');}
}
function executionProjection(d:JevDecision):ExecutedDecision {return{action:d.action as ExecutedDecision['action'],target:structuredClone(d.target),name:d.name,feature:d.feature,observe:null,...(Object.hasOwn(d,'detailFigureIds')?{detailFigureIds:structuredClone(d.detailFigureIds!)}:{})};}
function persistedExecution(x:any,slots:readonly string[]):void {
 if(!stateExact(x,['action','target','name','feature','observe',...(Object.hasOwn(x??{},'detailFigureIds')?['detailFigureIds']:[])])||!JEV_ACTIONS.includes(x.action)||x.action==='request_observation'||x.observe!==null||
  ![x.name,x.feature].every(v=>v===null||typeof v==='string'&&v.trim().length>0&&v.length<=400))throw Error();
 const t=x.target;let selected:string[]=[];
 if(t?.kind==='none'){if(!stateExact(t,['kind']))throw Error();}
 else if(t?.kind==='single'){if(!stateExact(t,['kind','figureId'])||!slots.includes(t.figureId))throw Error();selected=[t.figureId];}
 else if(t?.kind==='multiple'){if(!stateExact(t,['kind','figureIds'])||!Array.isArray(t.figureIds)||t.figureIds.length<2||new Set(t.figureIds).size!==t.figureIds.length||t.figureIds.some((id:string)=>!slots.includes(id)))throw Error();selected=t.figureIds;}else throw Error();
 if(Object.hasOwn(x,'detailFigureIds')&&(!Array.isArray(x.detailFigureIds)||new Set(x.detailFigureIds).size!==x.detailFigureIds.length||x.detailFigureIds.some((id:string)=>!selected.includes(id))))throw Error();
 if(['propose_name','agree'].includes(x.action)&&(t.kind!=='single'||x.name===null||x.feature!==null))throw Error();
 if(['confirm','repair'].includes(x.action)&&(t.kind==='none'||x.feature===null||x.name!==null))throw Error();
 if(['accept','defer','revisit','move_on','close'].includes(x.action)&&(x.name!==null||x.feature!==null))throw Error();
 if(x.action==='revisit'&&t.kind==='none')throw Error();
}
// Historical state has no original request catalog; validate all retained
// native evidence fields without inventing omitted catalog material.
function persistedEvidence(value:any,stage?:'action_target'|'multiple_candidates'|'detail'|'action'|'target'):void {
 const keys=['model','responseId','choices','scores','latencyMs','costUsd',...(stage||Object.hasOwn(value??{},'inputBudget')?['inputBudget']:[]),...(stage?['stage']:Object.hasOwn(value??{},'stages')?['stages']:[])];
 if(!stateExact(value,keys)||stage&&(value.stage!==stage||value.model===null||value.costUsd===null)||!(value.model===null||typeof value.model==='string'&&value.model.length<=128)||!(value.responseId===null||typeof value.responseId==='string'&&/^gen-[A-Za-z0-9_-]{1,124}$/.test(value.responseId))||typeof value.latencyMs!=='number'||!Number.isFinite(value.latencyMs)||value.latencyMs<0||!(value.costUsd===null||typeof value.costUsd==='number'&&Number.isFinite(value.costUsd)&&value.costUsd>=0)||!value.choices||!value.scores||!stateSame(Object.keys(value.choices).sort(),Object.keys(value.scores).sort()))throw Error();
 for(const [key,choice]of Object.entries(value.choices)){const scores=value.scores[key];if(typeof choice!=='string'||!scores||!Object.hasOwn(scores,choice)||Object.values(scores).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))throw Error();}
 if(value.inputBudget!==undefined){const b=value.inputBudget,ks=['publicTurns','claims','publicNames','repairHistory','reobservations','observationDetails','observationChars','issueSummaryChars'];if(!stateExact(b,['maxChars','stateChars','omitted'])||b.maxChars!==20000||!Number.isSafeInteger(b.stateChars)||b.stateChars<0||b.stateChars>20000||!stateExact(b.omitted,ks)||ks.some(k=>!Number.isSafeInteger(b.omitted[k])||b.omitted[k]<0))throw Error();}
}
export type JevPrivateStateV2=JevPrivateState & {schemaVersion:'jev_private_state_v2';interventionPolicy:{version:'bypass_acceptance_v1';tableSha256:string}};
export type JevTurnTraceV2=Omit<JevTurnTrace,'schemaVersion'|'executed'|'intervention'>&{schemaVersion:'jev_turn_trace_v2';executed:ExecutedDecision|null;intervention:InterventionTrace|null};
export function validateJevPrivateStateV2(value:unknown,ownSlots:readonly string[],intervention:InterventionConfig,questionLayout:JevQuestionLayout='two_stage_v1'):JevPrivateStateV2 {
 checkedIntervention(intervention);
 if(questionLayout!=='two_stage_v1'&&questionLayout!=='two_stage_v2'&&questionLayout!=='two_stage_v3')throw new JevTurnError('invalid_state');
 try{
  stateJson(value);const s=value as any;validateOwnLedger(Object.fromEntries(ownSlots.map(k=>[k,{status:'unassigned',name:null}])));
  const hasAgreeNameScope=Object.hasOwn(s??{},'agreeNameScopeVersion');
  if(!stateExact(s,['schemaVersion','interventionPolicy','ledger','graph','judgments','observationMemo','repairHistory',...(Object.hasOwn(s??{},'aiPublic')?['aiPublic']:[]),...(hasAgreeNameScope?['agreeNameScopeVersion']:[])])||s.schemaVersion!=='jev_private_state_v2'||!stateSame(s.interventionPolicy,{version:'bypass_acceptance_v1',tableSha256:BYPASS_ACCEPTANCE_V1_TABLE_SHA256}))throw Error();
  if(hasAgreeNameScope&&(questionLayout!=='two_stage_v3'||s.agreeNameScopeVersion!=='scoped_v1'))throw Error();
  validateOwnLedger(s.ledger);if(!sameSet(Object.keys(s.ledger),ownSlots))throw Error();const graph=snapshotReferenceGraph(s.graph);if(!sameSet(Object.keys(graph.ownSlots),ownSlots)||!Array.isArray(s.judgments)||!Array.isArray(s.repairHistory))throw Error();
  if(s.observationMemo!==null){const m=validateObservationMemo(s.observationMemo);if(!sameSet(m.figures.map(f=>f.id),ownSlots))throw Error();}
  if(Object.hasOwn(s,'aiPublic'))validateAiPublicState(s.aiPublic,ownSlots,Number.MAX_SAFE_INTEGER,s.graph);
  // Every claim record still held by the graph, withdrawn or not (the live view alone drops a claim as soon as it is withdrawn).
  const graphClaims=new Map<string,any>((s.graph.records as any[]).filter((r:any)=>r?.kind==='claim').map((r:any)=>[r.id,r]));
  const seen=new Set<string>();
  for(const j of s.judgments){
   if(!stateExact(j,['turnIndex','lastEventId','status','judgment','generationGuard','jevTurn','localGrounding',...(Object.hasOwn(j,'aiPublic')?['aiPublic']:[])])||j.status!=='committed'||!Number.isSafeInteger(j.turnIndex)||j.turnIndex<1||!(j.lastEventId===null||typeof j.lastEventId==='string'&&j.lastEventId.length<=160))throw Error();
   const z=j.jevTurn;if(!stateExact(z,['attemptNumber','decision','executed','intervention',...(Object.hasOwn(z??{},'humanReferent')?['humanReferent']:[]),...(Object.hasOwn(z??{},'repairProspect')?['repairProspect']:[]),...(Object.hasOwn(z??{},'repairGate')?['repairGate']:[]),...(Object.hasOwn(z??{},'agreeNames')?['agreeNames']:[]),...(Object.hasOwn(z??{},'repairFacts')?['repairFacts']:[])])||!Number.isSafeInteger(z.attemptNumber)||z.attemptNumber<1)throw Error();
   const hasAgreeNames=Object.hasOwn(z,'agreeNames');
   // Historical evidence retains the candidate catalog, not the original request's public turns.
   if(questionLayout==='two_stage_v3'&&!hasAgreeNames||hasAgreeNames&&(!Array.isArray(z.agreeNames)||z.agreeNames.length>JEV_DECISION_INPUT_LIMITS.publicNames||z.agreeNames.some((n:any)=>!stateExact(n,['name','figureId','sourceTurn'])||
     typeof n.name!=='string'||!n.name.trim()||n.name.length>80||!(ownSlots.includes(n.figureId)||questionLayout!=='two_stage_v3'&&n.figureId===null)||!Number.isSafeInteger(n.sourceTurn)||n.sourceTurn<1||n.sourceTurn>j.turnIndex)))throw Error();
   const hasAgreeFor=(ids:readonly string[])=>hasAgreeNames&&z.agreeNames.some((n:PublicNameCandidate)=>ids.some(id=>n.figureId===null||n.figureId===id));
   const actionLabels=JEV_ACTIONS.filter(a=>a!=='agree'||!hasAgreeNames||hasAgreeFor(ownSlots));
   // v2: closures must be justified by agrees saved before this turn; the prospect was asked over the open entries only.
   if(Object.hasOwn(z,'repairGate')&&!checkRepairGate(z.repairGate,s.repairHistory,s.judgments,j.turnIndex))throw Error();
   if(Object.hasOwn(z,'repairProspect'))validateRepairProspectMaterial(z.repairProspect,Object.hasOwn(z,'repairGate')?inferenceHistory(s.repairHistory,z.repairGate):s.repairHistory,j.turnIndex);
   if(Object.hasOwn(z,'repairFacts'))validateRepairFacts(z.repairFacts,Object.hasOwn(z,'repairGate')?inferenceHistory(s.repairHistory,z.repairGate):s.repairHistory,j.turnIndex);
   const key=JSON.stringify([j.turnIndex,j.lastEventId,z.attemptNumber]);if(seen.has(key))throw Error();seen.add(key);
   const d=z.decision;if(!stateExact(d,['action','target','name','feature','observe','evidence','decisionKind','calibrated',...(Object.hasOwn(d??{},'detailFigureIds')?['detailFigureIds']:[])])||!['mock','jev_local_test'].includes(d.decisionKind)||d.calibrated!==false)throw Error();
   persistedEvidence(d.evidence);
   if(d.decisionKind==='jev_local_test'){
    // two_stage_v2 keeps a candidate-set stage between action_target and detail for every multiple target.
    const detail=['propose_name','agree','confirm','repair'].includes(d.action),setStage=questionLayout==='two_stage_v2'&&d.target?.kind==='multiple';
    // two_stage_v3 keeps exactly action, target, [detail]; a target label must decode to the saved decision's own target.
    const v3=questionLayout==='two_stage_v3';
    const es=d.evidence.stages;if(!Array.isArray(es)||es.length!==(v3?2:1+(setStage?1:0))+(detail?1:0))throw Error();
    persistedEvidence(es[0],v3?'action':'action_target');
    if(v3){
     persistedEvidence(es[1],'target');
     if(!stateSame(Object.keys(es[0].choices),['action'])||!stateSame(Object.keys(es[1].choices),['target']))throw Error();
     const t=d.target,idx=(ids:string[])=>ids.map(id=>ownSlots.indexOf(id));
     const expected=t?.kind==='none'?'none':t?.kind==='single'?'figure_'+ownSlots.indexOf(t.figureId):t?.kind==='multiple'?candidateSetLabel(idx(t.figureIds)):null;
     const offered=Object.keys(es[1].scores.target);
     if(expected===null||es[1].choices.target!==expected||offered.length!==new Set(offered).size||!offered.every(k=>V3_TARGET_LABEL_SET.includes(k)))throw Error();
     // The target question can only ever have offered kinds this action may take (audit/06 F5: a saved `none: 0` for revisit was never offerable).
     const allowed=(V3_ACTION_KINDS as Record<string,readonly string[]>)[d.action];
     if(!allowed||!offered.every(k=>allowed.includes(k==='none'?'none':k.startsWith('figure_')?'single':'multiple')))throw Error();
     if(d.action==='agree'&&!offered.every(k=>hasAgreeFor([ownSlots[Number(k.slice('figure_'.length))]])))throw Error();
     if(t.kind==='multiple'&&!TWO_STAGE_V2_CANDIDATE_SETS.some(s=>candidateSetLabel(s)===expected))throw Error();
    }
    if(setStage){
     persistedEvidence(es[1],'multiple_candidates');
     // The set stage asked exactly one closed question over all 57 subsets; anything else was never a Jev answer.
     if(!sameSet(Object.keys(es[1].choices),['candidate_set'])||!sameSet(Object.keys(es[1].scores),['candidate_set'])||!sameSet(Object.keys(es[1].scores.candidate_set),CANDIDATE_SET_LABELS))throw Error();
     const set=TWO_STAGE_V2_CANDIDATE_SETS.find(s=>candidateSetLabel(s)===es[1].choices.candidate_set);
     if(!set||es[0].choices.target!=='multiple'||!stateSame(set.map(i=>ownSlots[i]),d.target.figureIds))throw Error();
    }
    if(detail)persistedEvidence(es.at(-1),'detail');
    // After the turn's one reobservation the stage-one question omits request_observation (as in isOpenIssueRerankRecord).
    const keys=Object.keys(es[0].scores.action??{}).sort();
    // v3 scores only the actions that had a legal target and detail: any subset of the offerable labels that holds the always-legal ones and the chosen action.
    const actionKeysOk=v3?keys.every(k=>actionLabels.includes(k as any))&&['accept','defer','revisit','move_on','close',d.action].every(k=>keys.includes(k))
      :stateSame(keys,[...actionLabels].sort())||stateSame(keys,actionLabels.filter(a=>a!=='request_observation').sort());
    if(!actionKeysOk||!stateSame(d.evidence.choices,es[0].choices)||!stateSame(d.evidence.scores,es[0].scores)||es[0].choices.action!==d.action||d.evidence.model!==es.at(-1).model||d.evidence.responseId!==es.at(-1).responseId||d.evidence.costUsd!==es.reduce((n:number,e:any)=>n+e.costUsd,0))throw Error();
   }else if(d.evidence.model!==null||Object.keys(d.evidence.choices).length||Object.keys(d.evidence.scores).length||d.evidence.stages?.length)throw Error();
   const original=executionProjection(d);persistedExecution(original,ownSlots);persistedExecution(z.executed,ownSlots);
   if(questionLayout==='two_stage_v3'&&[original,z.executed].some(e=>e.action==='agree'&&
    (e.target.kind!=='single'||!hasAgreeNameV3(z.agreeNames,e.name,e.target.figureId))))throw Error();
   const t=z.intervention;if(!stateExact(t,['schemaVersion','policy','disposition','reasonCode','original','rerank','alternative','detailEvidence','failure'])||t.schemaVersion!=='jev_intervention_v1'||t.failure!==null||!stateSame(t.original,original))throw Error();
   const accept=t.policy==='bypass_acceptance_v1:accept',veto=t.policy==='bypass_acceptance_v1:veto';if(!accept&&!veto)throw Error();
   if(t.disposition==='adopted'){if(t.reasonCode!==(accept?'no_intervention':'not_in_veto_set')||veto&&['defer','move_on'].includes(d.action)||!stateSame(z.executed,original)||[t.rerank,t.alternative,t.detailEvidence].some(v=>v!==null))throw Error();}
   else if(t.disposition==='rejected'&&t.rerank?.policyId==='saved_action_scores_open_issue_v1'){
    // adaptive_repair_v1 only; the saved_action_scores_v1 branch below is unchanged.
    const i=s.judgments.indexOf(j),p=i>0?s.judgments[i-1].jevTurn.executed:null,m=z.repairProspect,src=t.rerank.source;
    // Provenance: Jev's own explicit issue choice in this turn names an earlier repair entry.
    if(!veto||m?.status!=='ok'||m.issue.choice!=='issue'||m.issue.turn!==src?.issueTurn||m.issue.issueId!==src?.issueId||
       !s.repairHistory.some((r:RepairHistoryEntry)=>r.turn===src.issueTurn&&r.issueId===src.issueId&&r.turn<j.turnIndex)||
       !isOpenIssueRerankRecord(t,d,z.executed,ownSlots,p&&{action:p.action,target:p.target},hasAgreeNames?z.agreeNames:undefined,questionLayout,m))throw Error();
    if(['confirm','repair'].includes(z.executed.action))persistedEvidence(t.detailEvidence,'detail');else if(t.detailEvidence!==null)throw Error();
   }
   else if(t.disposition==='rejected'){
    if(!veto||!['defer','move_on'].includes(d.action)||t.reasonCode!=='vetoed_bypass_action'||!stateSame(t.alternative,z.executed)||!stateSame(z.executed.target,original.target)||['defer','move_on'].includes(z.executed.action))throw Error();
    const r=t.rerank;if(!stateExact(r,['policyId','ranking','selected'])||r.policyId!=='saved_action_scores_v1'||!Array.isArray(r.ranking)||!r.ranking.length||!stateSame(r.selected,{action:z.executed.action,target:z.executed.target}))throw Error();
    const actions=new Set<string>();let previous:any=null;for(const a of r.ranking){if(!stateExact(a,['action','score'])||!JEV_ACTIONS.includes(a.action)||['defer','move_on','request_observation'].includes(a.action)||actions.has(a.action)||typeof a.score!=='number'||a.score<0||a.score>1||a.score!==d.evidence?.stages?.[0]?.scores?.action?.[a.action]||previous&&(a.score>previous.score||a.score===previous.score&&JEV_ACTIONS.indexOf(a.action)<JEV_ACTIONS.indexOf(previous.action)))throw Error();actions.add(a.action);previous=a;}
    const restrictedAgree=hasAgreeNames&&original.target.kind==='single'&&!hasAgreeFor([original.target.figureId]);
    // v3 independently qualifies proposal and agreement names. Old records retain their original catalogs.
    const invalidNames=questionLayout==='two_stage_v3'?restrictedAgree&&actions.has('agree'):
      restrictedAgree?actions.has('agree'):actions.has('propose_name')!==actions.has('agree');
    if(!actions.has('accept')||!actions.has('close')||r.ranking[0].action!==z.executed.action||actions.has('confirm')!==actions.has('repair')||
      invalidNames||actions.has('revisit')!==(original.target.kind!=='none')||original.target.kind!=='single'&&(actions.has('agree')||actions.has('propose_name')))throw Error();
    const detail=['propose_name','agree','confirm','repair'].includes(z.executed.action);if(detail){persistedEvidence(t.detailEvidence,'detail');}else if(t.detailEvidence!==null)throw Error();
   }else throw Error();
   if(questionLayout==='two_stage_v3'&&['repair','confirm','revisit'].includes(j.judgment?.action)){
    // The repair-history entry created for this judgment keeps the executed candidate set; only a later human reply may update it (progress leaves unknown).
    const ids=z.executed.target.kind==='single'?[z.executed.target.figureId]:z.executed.target.kind==='multiple'?z.executed.target.figureIds:[];
    const entry=s.repairHistory.find((r:any)=>r?.turn===j.turnIndex);
    if(!entry||entry.action!==j.judgment.action||!stateSame(entry.candidatesBefore,ids))throw Error();
    const after=entry.candidatesAfter,same=stateSame(after,ids),claimsOf=Array.isArray(entry.partnerClaims)?entry.partnerClaims:[];
    if(!Array.isArray(after)||new Set(after).size!==after.length||!after.every((id:string)=>ownSlots.includes(id)))throw Error();
    if(s.judgments.at(-1)===j){
     // No later turn exists, so no human reply could have updated this entry yet: it is exactly as created. A progress label never opens it.
     if(entry.progress!=='unknown'||!same||claimsOf.length||entry.addedClaimIds?.length||entry.removedClaimIds?.length||Object.hasOwn(entry,'missingReasons')||Object.hasOwn(entry,'humanRejections'))throw Error();
    }else{
     // A later committed turn exists. Mirror updateRepairHistory exactly: the candidate set is the union of the targets of the information claims among the
     // partner claims, or the original set when there is none; missingReasons only ever turn the progress into unknown and never change the set.
     // Resolve every partner claim against the live graph: a claim still there is judged exactly as the generator did (figureInformation);
     // a pruned one is judged by its act alone, and every way it could count is allowed.
     // The generator puts only novel information claims into addedClaimIds, so an id listed there was an information claim then, even when a later
     // withdrawal or pruning removed the claim from the graph; a withdrawn claim that is still recorded resolves from its record.
     const addedSet=new Set<string>(Array.isArray(entry.addedClaimIds)?entry.addedClaimIds:[]);
     const resolved:any[]=[],unresolved:any[]=[],named:Set<string>=new Set();
     for(const c of claimsOf){
      if(!c||!Array.isArray(c.targets)||typeof c.id!=='string')throw Error();
      const g=graphClaims.get(c.id);
      if(g){if(g.act!==c.act||!stateSame(g.targets,c.targets))throw Error();if(figureInformation(g)){resolved.push(c);if(c.targets.length)named.add(c.id);}}
      else if(addedSet.has(c.id)){if(!INFORMATION_ACTS.has(c.act)||!c.targets.length)throw Error();resolved.push(c);named.add(c.id);}
      else if(INFORMATION_ACTS.has(c.act)){unresolved.push(c);if(c.targets.length)named.add(c.id);}
     }
     const expected=(list:any[])=>list.length?[...new Set(list.flatMap((c:any)=>c.targets))]:[...ids];
     let setOk:boolean;
     if(!unresolved.length)setOk=stateSame(after,expected(resolved));
     else if(unresolved.length>8)setOk=resolved.every((c:any)=>c.targets.every((id:string)=>after.includes(id)))&&after.every((id:string)=>[...resolved,...unresolved].some((c:any)=>c.targets.includes(id)));
     else{setOk=false;for(let mask=0;mask<1<<unresolved.length&&!setOk;mask++){const exp=expected([...resolved,...unresolved.filter((_:any,n:number)=>mask>>n&1)]);setOk=exp.length===after.length&&exp.every((id:string)=>after.includes(id));}}
     if(!setOk)throw Error();
     const added=Array.isArray(entry.addedClaimIds)?entry.addedClaimIds:[];
     if(new Set(added).size!==added.length||!added.every((id:string)=>named.has(id)&&claimsOf.find((c:any)=>c.id===id).targets.every((t:string)=>after.includes(t))))throw Error();
     const narrowed=after.length>0&&after.length<ids.length&&after.every((id:string)=>ids.includes(id));
     const reasons=Array.isArray(entry.missingReasons)?entry.missingReasons.length:0;
     if(entry.progress==='changed'){if(!(added.length||narrowed))throw Error();}
     else if(entry.progress==='unchanged'){if(added.length||narrowed||reasons)throw Error();}
     else{
      // unknown: untouched since creation, or an update that the AI-public reasons turned back to unknown (so it had no novel claim and no narrowing).
      const untouched=same&&!claimsOf.length&&!added.length&&!entry.removedClaimIds?.length&&!Object.hasOwn(entry,'missingReasons')&&!Object.hasOwn(entry,'humanRejections');
      if(!untouched&&!(reasons&&!added.length&&!narrowed))throw Error();
     }
    }
   }
   const e=z.executed,g=j.judgment;if(g.action!==e.action||g.targetSlot!==(e.target.kind==='single'?e.target.figureId:null)||g.candidateName!==e.name||g.discriminatingFeature!==e.feature)throw Error();
  }
  return structuredClone(s);
 }catch{throw new JevTurnError('invalid_state');}
}
// Scope's own timeout is not caller abort. First observable terminal cause sticks.
function interventionDeadline(ms:number,caller?:AbortSignal){
 const controller=new AbortController(),at=performance.now()+ms;let cause:'timeout'|'aborted'|null=null,done=false;let reject!:(e:unknown)=>void;
 const canceled=new Promise<never>((_,r)=>{reject=r;});canceled.catch(()=>{});
 const stop=(c:'timeout'|'aborted')=>{if(done||cause)return;cause=c;reject(new JevDecisionError(c));controller.abort();};
 const checkpoint=(detail=false)=>{if(caller?.aborted)stop('aborted');else if(performance.now()>=at||detail&&Math.floor(at-performance.now())<1)stop('timeout');if(cause)throw new JevDecisionError(cause);};
 const abort=()=>stop('aborted');caller?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{if(caller?.aborted)stop('aborted');else stop('timeout');},ms);
 return {signal:controller.signal,check:checkpoint,remaining:()=>Math.floor(at-performance.now()),
  async run<T>(work:(signal:AbortSignal)=>Promise<T>,detail=false):Promise<T>{checkpoint(detail);try{const x=await Promise.race([Promise.resolve().then(()=>{checkpoint(detail);return work(controller.signal);}),canceled]);checkpoint();return x;}catch(e){if(cause)throw new JevDecisionError(cause);checkpoint();throw e;}},
  close(){done=true;clearTimeout(timer);caller?.removeEventListener('abort',abort);}};
}

export function createJevTurnRuntime(options: JevTurnOptions) {
  const adaptive = Object.hasOwn(options,'technicalTrial');
  if(adaptive){try{stateJson(options.technicalTrial);if(!stateExact(options.technicalTrial,['version'])||!['adaptive_repair_v1','adaptive_repair_v2','adaptive_repair_v3'].includes(options.technicalTrial!.version))throw Error();}catch{throw new JevTurnError('invalid_state');}}
  const gated=adaptive&&['adaptive_repair_v2','adaptive_repair_v3'].includes(options.technicalTrial!.version);
  const factored=adaptive&&options.technicalTrial!.version==='adaptive_repair_v3';
  const checkProspectMode=(s:JevPrivateState)=>{
    if(!adaptive&&s.judgments?.some(j=>Object.hasOwn(j.jevTurn??{},'repairProspect')||Object.hasOwn(j.jevTurn??{},'agreeNames')&&questionLayout!=='two_stage_v3'||j.jevTurn?.intervention?.rerank?.policyId==='saved_action_scores_open_issue_v1'))throw new JevTurnError('invalid_state');
    // Each version restores only its own records: v2 judgments always carry the gate, older ones never do.
    if(s.judgments?.some(j=>Object.hasOwn(j.jevTurn??{},'repairGate')!==gated))throw new JevTurnError('invalid_state');
    if(s.judgments?.some(j=>Object.hasOwn(j.jevTurn??{},'repairFacts')!==factored))throw new JevTurnError('invalid_state');
  };
  const integrated=Object.hasOwn(options,'intervention')||Object.hasOwn(options,'decisionTimeoutMs');
  let intervention:InterventionConfig|null=null,decisionTimeoutMs:number|undefined;
  if(integrated){try{
   const c=Object.getOwnPropertyDescriptor(options,'intervention'),t=Object.getOwnPropertyDescriptor(options,'decisionTimeoutMs');
   if(!c?.enumerable||!Object.hasOwn(c,'value')||!t?.enumerable||!Object.hasOwn(t,'value')||!Number.isSafeInteger(t.value)||t.value<1||t.value>600000)throw Error();
   intervention=checkedIntervention(c.value);decisionTimeoutMs=t.value;
  }catch{throw new JevTurnError('invalid_intervention');}}
  const { client, observer, jevDecision, generation } = options;
  // One layout per runtime: validation, acceptance, restore and the client's own requests must agree.
  const questionLayout: JevQuestionLayout = options.questionLayout ?? "two_stage_v1";
  if (questionLayout !== "two_stage_v1" && questionLayout !== "two_stage_v2" && questionLayout !== "two_stage_v3") throw new Error("Invalid Jev question layout");
  if (questionLayout !== "two_stage_v1" && !integrated) throw new Error(questionLayout + " requires the integrated Jev profile");
  const generationRetryVersion = options.generationRetryVersion ??
    (questionLayout === "two_stage_v3" ? "jev_generation_retry_v2" : "jev_generation_retry_v1");
  if (generationRetryVersion !== "jev_generation_retry_v1" &&
      (generationRetryVersion !== "jev_generation_retry_v2" || questionLayout !== "two_stage_v3")) {
    throw new Error("Invalid Jev generation retry version");
  }
  const restateJudgment = generationRetryVersion === "jev_generation_retry_v2";
  const declaredLayout = (jevDecision as { metadata?: { questionLayout?: unknown } } | undefined)?.metadata?.questionLayout;
  if (declaredLayout !== undefined && declaredLayout !== questionLayout) throw new Error("Jev question layout mismatch");
  const rejectNewLegacyState=(s:JevPrivateState)=>{
   checkProspectMode(s);
   if(!integrated&&(Object.hasOwn(s,'schemaVersion')||Object.hasOwn(s,'interventionPolicy')||s.judgments?.some(j=>Object.hasOwn(j.jevTurn??{},'executed')||Object.hasOwn(j.jevTurn??{},'intervention'))))throw new JevTurnError('invalid_state');
  };
  if (typeof observer?.observeAll !== "function" || typeof observer?.reobserve !== "function" || typeof jevDecision?.decide !== "function") throw new Error("Invalid Jev turn options");
  if (options.onJevTurnTrace != null && typeof options.onJevTurnTrace !== "function") throw new Error("Invalid Jev turn trace callback");
  const maxReobservations = options.maxReobservations ?? 1;
  if (!Number.isSafeInteger(maxReobservations) || maxReobservations < 0 || maxReobservations > 1) throw new Error("Invalid reobservation limit");
  const ownImage = structuredClone(options.ownImage), ownAnchors = structuredClone(options.ownAnchors), slots = ownAnchors.map(a => a.id);
  validateLocalGroundingOptions({ ...options.localGrounding, extractor: { async extract() { return []; } } });
  const aiEnabled = options.localGrounding.aiPublicClaims === true;
  const aiExtractor = aiEnabled ? createMemoAiExtractor(client) : null;
  const aiFunction = aiEnabled ? createJevAiFunctionClassifier({ ...options.localGrounding.aiPublicTransport, ...(options.localGrounding.researchLimits === undefined ? {} : { researchLimits: options.localGrounding.researchLimits }) }) : null;
  const aiSupport = aiEnabled ? createJevAiSupportChecker({ ...options.localGrounding.aiPublicTransport, ...(options.localGrounding.researchLimits === undefined ? {} : { researchLimits: options.localGrounding.researchLimits }) }) : null;
  const aiPromptBodies = [MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS, AI_FUNCTION_INSTRUCTIONS + "\n" + JSON.stringify(AI_FUNCTION_CRITERIA),
    AI_SUPPORT_INSTRUCTIONS + "\n" + AI_RESPONSE_SUPPORT_INSTRUCTIONS + "\n" + JSON.stringify({ AI_SUPPORT_CHOICES, AI_ACT_DESCRIPTIONS })];
  const attempts: JevTurnTrace[] = [];
  let attemptsStarted = 0;
  let initialMemo: Promise<ObservationMemo> | null = null, initialRecorded = false;
  const privateInstructions = [generation.task, generation.instructions, generation.concise ?? "", ACT_INSTRUCTIONS, DETAIL_INSTRUCTIONS, REVISIT_MULTIPLE_INSTRUCTIONS, LOCAL_EXTRACTION_INSTRUCTIONS,
    MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, LOCAL_CLASSIFICATION_INSTRUCTIONS, OBSERVATION_INITIAL_INSTRUCTIONS,
    OBSERVATION_TARGETED_INSTRUCTIONS, ...(aiEnabled ? aiPromptBodies : [])].map(content => ({ role: "system", content }));
  function project<T>(value: T): T {
    let redacted = false;
    const safe = (item: unknown): unknown => {
      if (typeof item === "string") {
        const leak = item.includes(ownImage.base64) || findLocalPublicationViolations(item, privateInstructions)
          .some(code => ["internal_image", "internal_credential", "internal_prompt_echo"].includes(code));
        if (leak) { redacted = true; return "[redacted]"; }
        return item;
      }
      if (Array.isArray(item)) return item.map(safe);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, safe(child)]));
      return item;
    };
    const result = safe(value) as T;
    if (redacted && result && typeof result === "object") Object.assign(result, { redacted: true });
    return result;
  }
  function initialPrivateState(): JevPrivateState {
    return { ...(integrated?{schemaVersion:'jev_private_state_v2' as const,interventionPolicy:{version:'bypass_acceptance_v1' as const,tableSha256:BYPASS_ACCEPTANCE_V1_TABLE_SHA256}}:{}), ledger: createOwnLedger(slots), judgments: [], graph: createReferenceGraph({ slots }) as Graph, observationMemo: null, repairHistory: [],
      ...(questionLayout === "two_stage_v3" ? { agreeNameScopeVersion: "scoped_v1" as const } : {}),
      ...(aiEnabled ? { aiPublic: initialAiPublicState() } : {}) };
  }
  async function memoOnce(signal?: AbortSignal) {
    abortIf(signal);
    if (!initialMemo) initialMemo = Promise.resolve().then(() => observer.observeAll({ ownImage: structuredClone(ownImage), ownAnchors: structuredClone(ownAnchors) }))
      .then(memo => validateObservationMemo(memo, { ownAnchors })).catch(error => {
        initialMemo = null; throw new JevTurnError("observation_failed", observationFailure(error, "initial"));
      });
    try { return structuredClone(await interruptible(initialMemo, signal)); }
    catch (error) { throw new JevTurnError(signal?.aborted ? "aborted" : "observation_failed", observationFailure(error, "initial", signal?.aborted)); }
  }
  async function initializePrivateState({ signal }: { signal?: AbortSignal } = {}): Promise<JevPrivateState> {
    return { ...initialPrivateState(), observationMemo: await memoOnce(signal) };
  }
  async function runAiTurn({ events, signal, privateState, lastEventId = null, requestSeq = null }: {
    events: Event[]; signal?: AbortSignal; privateState: JevPrivateState; lastEventId?: string | null; requestSeq?: number | null;
  }) {
    const latest = events.filter(e => e.speaker === "human").at(-1);
    if (!latest || !Number.isSafeInteger(latest.seq) || latest.seq < 1) throw new JevTurnError("invalid_state");
    const ordinal = ++attemptsStarted;
    const attemptNumber = Number.isSafeInteger(requestSeq) && requestSeq! > 0 ? requestSeq! : ordinal;
    const record: JevTurnTrace = { turnIndex: latest.seq, lastEventId, attemptNumber, status: "error", initialObservation: null,
      reobservations: [], local: null, humanReferent: null, decisions: [], intervention: integrated?null:"none_pending_researcher_decision", ...(integrated?{schemaVersion:"jev_turn_trace_v2" as const,executed:null}:{}), finalAction: null,
      publicSpeech: null, observationMemo: null, repairHistory: [], ...(factored ? { repairFacts: [] } : {}), generationGuard: { violations: [], regenerated: false, fallback: false } };
    let errorCode: JevTurnErrorCode = "invalid_state";
    const decideFailure: { failed: boolean; evidence?: unknown } = { failed: false };
    let localRule: "action_target_not_allowed" | null = null;
    let observationPhase: ObservationFailure["observationPhase"] | null = null;
    try {
      abortIf(signal);
      const state = integrated?validateJevPrivateStateV2(privateState,slots,intervention!,questionLayout):structuredClone(privateState);
      if(!integrated&&(Object.hasOwn(state,'schemaVersion')||Object.hasOwn(state,'interventionPolicy')||state.judgments?.some(j=>Object.hasOwn(j.jevTurn??{},'executed')||Object.hasOwn(j.jevTurn??{},'intervention'))))throw new JevTurnError('invalid_state');
      checkProspectMode(state);
      snapshotReferenceGraph(state.graph);
      if (!Array.isArray(state.judgments) || !Array.isArray(state.repairHistory) || !sameSet(state.graph.slots, slots)) throw new JevTurnError("invalid_state");
      errorCode = "observation_failed";
      observationPhase = "initial";
      let memo = state.observationMemo ? validateObservationMemo(state.observationMemo, { ownAnchors }) : await memoOnce(signal);
      observationPhase = null;
      if (!initialRecorded && initialMemo) { record.initialObservation = structuredClone(memo); initialRecorded = true; }
      if (aiEnabled) {
        try { state.aiPublic = validateAiPublicState(state.aiPublic, slots, latest.seq - 1, state.graph); }
        catch { throw new JevTurnError("invalid_state"); }
      }
      const publicTurns: PublicTurn[] = events.filter(e => e.seq <= latest.seq &&
        (!aiEnabled || events.filter(other => other.seq === e.seq).length === 1)).slice(-REFERENCE_LIMITS.publicTurns).map(e => ({ turn: e.seq, speaker: e.speaker, text: e.text,
        ...(e.nonReferential ? { nonReferential: true } : {}) }));
      const previous = state.judgments.at(-1), previousExecution=previous?(integrated?previous.jevTurn.executed!:previous.jevTurn.decision):null, previousAi = previous && publicTurns.find(t => t.speaker === "ai" && t.turn > previous.turnIndex && t.turn < latest.seq);
      const local = { ...options.localGrounding, extractor: createMemoLocalExtractor({ complete(messages, options) {
        if (messages.some(message => typeof message.content !== "string")) throw new JevTurnError("invalid_state");
        return client.complete(messages as Message[], options);
      } }, { getMemo: () => structuredClone(memo), ...(options.localGrounding.researchLimits === undefined ? {} : { researchLimits: options.localGrounding.researchLimits, timeoutMs: options.localGrounding.timeoutMs }) }) };
      const priorAct = previousAi ? { ...previous.judgment, turn: previousAi.turn, publishedFallback: previous.generationGuard.fallback,
        ...(previousExecution!.target.kind === "multiple" ? { targetCandidates: [...previousExecution!.target.figureIds] } : {}) } : undefined;
      let initialUpdate = stageMemory(state.graph, latest.seq, null, publicTurns);
      if (aiEnabled) {
        errorCode = "invalid_state";
        const pre = await prependAiPublic({ graph: state.graph, update: initialUpdate, state: state.aiPublic!, events, publicTurns, priorAct });
        state.aiPublic = pre.state; initialUpdate = pre.update;
        record.aiPublic = { phase: "ai_public_claims", application: pre.application, pending: null, observationMemo: null,
          stages: { ai_extraction: emptyAiEvidence(), ai_function: emptyAiEvidence(), ai_support: emptyAiEvidence() },
          prompts: { extraction: { version: 1, sha256: await aiHash(aiPromptBodies[0]) }, function: { version: 1, sha256: await aiHash(aiPromptBodies[1]) },
            support: { version: 1, sha256: await aiHash(aiPromptBodies[2]) } } };
      }
      const prepared = await prepareLocalGroundingTurn(local, { graph: state.graph,
        update: initialUpdate, publicTurns, signal, ownImage, ownAnchors, captureResearch: true,
        ...(!aiEnabled && previousAi ? { priorAct: { ...previous.judgment, turn: previousAi.turn, publishedFallback: previous.generationGuard.fallback,
          ...(previousExecution!.target.kind === "multiple" ? { targetCandidates: [...previousExecution!.target.figureIds] } : {}) } } : {}) });
      record.local = { ...prepared.research!, turnIndex: latest.seq, lastEventId, attemptNumber, status: "error", localStatus: prepared.trace.status };
      abortIf(signal);
      const graph = previewReferenceUpdate(state.graph, prepared.update, { publicTurns }) as Graph;
      const beforeClaims = priorClaimViews(state.graph, { limit: REFERENCE_LIMITS.records });
      const claims = priorClaimViews(graph, { limit: REFERENCE_LIMITS.records });
      let repairHistory = updateRepairHistory(state.repairHistory, beforeClaims, claims, latest.seq,
        previous && previousAi && ["repair", "confirm", "revisit"].includes(previous.judgment.action) ? { answeredRepairTurn: previous.turnIndex,
          ...(aiEnabled ? { aiPublic: { humanOk: prepared.trace.status === "ok", rejected: prepared.trace.rejected,
            aiComplete: state.aiPublic!.log.some(log => log.aiSeq === previousAi.turn && log.status === "applied") } } : {}) }
          : aiEnabled ? { answeredRepairTurn: -1, aiPublic: { humanOk: prepared.trace.status === "ok", rejected: prepared.trace.rejected, aiComplete: false } } : undefined);
      // v2: decide the gate from the judgments and claims as they stand now; Jev infers over the open entries only.
      const gate = gated ? agreementGate(repairHistory, state.judgments, claims, latest.seq, state.ledger) : null;
      if (gate) record.repairGate = structuredClone(gate);
      const baseInput: JevDecisionInput = { turn: latest.seq, publicTurns, ownSlots: [...slots], observations: memo,
        issueSummary: summarizeLocalIssues(graph), priorClaims: claims, repairHistory: gate ? inferenceHistory(repairHistory, gate) : repairHistory,
        previousAction: previous && previousAi ? { turn: previousAi.turn, action: previousExecution!.action, target: previousExecution!.target,
          name: previousExecution!.name, feature: previousExecution!.feature } : null,
        publicNames: claims.filter(c => c.name !== null && publicTurns.some(t => t.turn === c.sourceTurn && t.text.includes(c.name!)))
          .map(c => ({ name: c.name!, figureId: c.targets.length === 1 ? c.targets[0] : null, sourceTurn: c.sourceTurn })) };
      if (questionLayout === "two_stage_v3") {
        baseInput.agreeNames = buildAgreeNamesV3(claims, publicTurns, latest.seq, slots, state);
        baseInput.nameLedger = structuredClone(state.ledger);
      }
      else if (adaptive) baseInput.agreeNames = claims.filter(eligibleAgreeClaim).flatMap(c => {
        // A name_accept may inherit a name without repeating its literal text.
        const source = publicTurns.find(t => t.turn === c.sourceTurn && t.text.includes(c.name!)) ??
          publicTurns.filter(t => t.text.includes(c.name!)).sort((a, b) => a.turn - b.turn)[0];
        return source ? [{ name: c.name!, figureId: c.targets[0], sourceTurn: source.turn }] : [];
      });
      if (factored) {
        baseInput.repairFacts = deriveRepairFacts(repairHistory, state.judgments, baseInput.repairHistory);
        record.repairFacts = structuredClone(baseInput.repairFacts);
      }
      // Estimate the HUMAN utterance's referent once, before any action choice.
      // It is private evidence, never a target selection or a graph operation.
      errorCode = "decision_failed";
      const referentInput = structuredClone({ ...baseInput, reobservationAllowed: maxReobservations > 0 });
      const observationMemo = { version: OBSERVATION_MEMO_VERSION, sha256: await interruptible(observationHash(memo), signal) };
      let estimate: HumanReferentEstimate = { status: "unknown", scores: null, model: null, responseId: null,
        costUsd: null, latencyMs: 0, inputBudget: null, calibrated: false };
      record.humanReferent = { ...estimate, turnIndex: latest.seq, observationMemo };
      const referentStarted = performance.now();
      try {
        abortIf(signal);
        if (typeof jevDecision.estimateReferent === "function") {
          const raw = await interruptible(jevDecision.estimateReferent(structuredClone(referentInput), { signal }), signal);
          abortIf(signal);
          estimate = validateHumanReferentEstimate(raw, referentInput);
        }
      } catch (error) {
        abortIf(signal);
        let aborted = false;
        try { aborted = (error instanceof JevTurnError || error instanceof JevDecisionError) && error.code === "aborted"; }
        catch { /* An injected error getter cannot become research evidence. */ }
        if (aborted) throw new JevTurnError("aborted");
        estimate.latencyMs = Math.max(0, Math.round(performance.now() - referentStarted));
      }
      abortIf(signal);
      record.humanReferent = { ...estimate, turnIndex: latest.seq, observationMemo };
      baseInput.humanReferent = { status: estimate.status, scores: structuredClone(estimate.scores) };
      // The estimate of this very exchange backs a re-affirmation of a denied figure, so the candidates are completed only now.
      if (questionLayout === "two_stage_v3") baseInput.agreeNames = buildAgreeNamesV3(claims, publicTurns, latest.seq, slots, state, baseInput.humanReferent);
      if (adaptive && baseInput.repairHistory.length && typeof jevDecision.estimateRepairProspect === "function") {
        record.repairHistory = structuredClone(repairHistory);
        let prospect = unknownRepairProspect();
        const prospectInput = structuredClone({ ...baseInput, reobservationAllowed: maxReobservations > 0 });
        try {
          const raw = await interruptible(jevDecision.estimateRepairProspect(prospectInput, { signal }), signal);
          abortIf(signal);
          prospect = validateRepairProspectEstimate(raw, baseInput);
        } catch (error) {
          abortIf(signal);
          let aborted = false;
          try { aborted = (error instanceof JevTurnError || error instanceof JevDecisionError) && error.code === "aborted"; }
          catch { /* An injected error getter cannot enter private evidence. */ }
          if (aborted) throw new JevTurnError("aborted");
        }
        record.repairProspect = structuredClone(prospect);
        baseInput.repairProspect = structuredClone(prospect);
      }
      let decision: JevDecision;
      let finalInput:JevDecisionInput|undefined,deadline:ReturnType<typeof interventionDeadline>|undefined;
      try {
      for (let count = 0; ; count++) {
        const input = structuredClone({ ...baseInput, observations: memo, reobservationAllowed: count < maxReobservations });
        errorCode = "decision_failed";
        deadline=integrated?interventionDeadline(decisionTimeoutMs!,signal):undefined;
        // Plan O: a fresh sink per decide() call. Only this call's rejection reads it, at the moment it settles, so a
        // previous success, a reobservation decision, a detail call or a late completion is never attributed here.
        const sink: { evidence?: unknown } = {};
        const onFailureEvidence = (evidence: unknown) => { sink.evidence = evidence; };
        let raw: unknown;
        try {
          raw = deadline?await deadline.run(s=>jevDecision.decide(structuredClone(input),{signal:s,timeoutMs:options.decisionTimeoutMs,onFailureEvidence})):await interruptible(jevDecision.decide(structuredClone(input), { signal, onFailureEvidence }), signal);
        } catch (error) { decideFailure.failed = true; decideFailure.evidence = sink.evidence; throw error; }
        abortIf(signal);
        errorCode = "invalid_decision";
        try { decision = validateJevDecision(raw, input, { questionLayout }); }
        catch (error) {
          // two_stage_v3 only: a decision the local table refuses names its rule; no provider response or cost record is invented for it.
          if (questionLayout === "two_stage_v3" && error instanceof JevDecisionError && error.rule === "action_target_not_allowed") localRule = error.rule;
          throw error;
        }
        record.decisions.push(structuredClone(decision));
        if (decision.action !== "request_observation") {finalInput=input;break;}
        deadline?.close();
        if (count >= maxReobservations) throw new JevTurnError("reobservation_limit");
        errorCode = "observation_failed";
        observationPhase = "targeted";
        const request = decision.observe!;
        const { figureIds, ...issue } = request;
        const result = await interruptible(observer.reobserve({ ownImage: structuredClone(ownImage), ownAnchors: structuredClone(ownAnchors),
          memo: structuredClone(memo), figureIds: [...figureIds], issue: structuredClone(issue) }, { signal }), signal);
        abortIf(signal);
        // merge validates the result; the request must still match this call.
        if (!sameSet(result.figures.map(f => f.figureId), figureIds) || result.issue.aspect !== issue.aspect ||
            result.issue.question !== issue.question || result.issue.partnerConstrual !== issue.partnerConstrual) throw new ObservationError("invalid_response");
        memo = validateObservationMemo(mergeReobservation(memo, result), { ownAnchors });
        record.reobservations.push({ request: structuredClone(request), result: structuredClone(result) });
        observationPhase = null;
      }
      let execution:ExecutedDecision;
      if(integrated){
        errorCode='decision_failed';deadline!.check();
        try {
          const acceptanceOptions={...(adaptive?{rerank:"open_issue_v1" as const}:{}),...(questionLayout!=="two_stage_v1"?{questionLayout}:{})};
          const result=await applyBypassAcceptance(finalInput!,decision!,intervention!,typeof jevDecision.completeDetail==='function'?
            (input,selected)=>deadline!.run(s=>jevDecision.completeDetail!(input,selected,{signal:s,timeoutMs:deadline!.remaining()}),true):undefined,
            Object.keys(acceptanceOptions).length?acceptanceOptions:undefined);
          deadline!.check();execution=result.executed;record.intervention=result.intervention;record.executed=execution;
        }catch(e){
          if(e instanceof BypassAcceptanceError){if(e.intervention)record.intervention=structuredClone(e.intervention);throw new JevTurnError(e.code==='alternative_failed'?'alternative_failed':'invalid_decision');}throw e;
        }
      }else execution=executionProjection(decision!);
      deadline?.close();
      errorCode = "invalid_decision";
      const ambiguousDefer = execution.action === "defer" && execution.target.kind !== "single";
      const multipleFeature = ["confirm", "repair"].includes(execution.action) && execution.target.kind === "multiple";
      // two_stage_v3 only: a revisit that keeps its candidate set. Like ambiguousDefer it bypasses the shared validateJudgment
      // (which stays unchanged for every other path) and never touches a ledger entry.
      const ambiguousRevisit = questionLayout === "two_stage_v3" && execution.action === "revisit" && execution.target.kind === "multiple";
      const act = { action: execution.action, targetSlot: execution.target.kind === "single" ? execution.target.figureId : null,
        candidateName: execution.name, discriminatingFeature: execution.feature, note: null };
      // P3 can retain an unresolved referent. Keep its whole candidate set in
      // the decision trace; no arbitrary slot is chosen or ledger entry changed.
      let judgment: Judgment;
      try {
        judgment = ambiguousDefer ? { ...act, action: "defer" }
          : ambiguousRevisit ? { ...act, action: "revisit" }
          : multipleFeature ? { ...act, action: execution.action as "confirm" | "repair" } : validateJudgment(act, { ownLedger: state.ledger });
      } catch (error) {
        if (questionLayout === "two_stage_v3" && error instanceof JudgmentValidationError) {
          const rejection = JUDGMENT_REJECTION_CODES.find(code => code === error.code);
          if (rejection) record.decisionRejectionCode = rejection;
        }
        throw error;
      }
      if (judgment.action === "agree" && !(questionLayout === "two_stage_v3"
        ? hasAgreeNameV3(baseInput.agreeNames!, judgment.candidateName, judgment.targetSlot)
        : claims.some(c => eligibleAgreeClaim(c) && c.name === judgment.candidateName && c.targets[0] === judgment.targetSlot))) {
        record.decisionRejectionCode = "agree_without_public_proposal";
        throw new JevTurnError("invalid_decision");
      }
      record.finalAction = judgment;
      if (["repair", "confirm", "revisit"].includes(judgment.action)) {
        const candidates = targets(execution), issue = [...claims].reverse().find(c => c.targets.some(id => candidates.includes(id)));
        // A multiple revisit names a problem only when exactly one issue overlaps its candidate set; otherwise the source stays unresolved.
        const overlapping = new Set(claims.filter(c => c.targets.some(id => candidates.includes(id))).map(c => c.issueId));
        repairHistory = [...repairHistory, { turn: latest.seq, issueId: ambiguousRevisit && overlapping.size !== 1 ? null : issue?.issueId ?? null, action: judgment.action as RepairHistoryEntry["action"],
          question: judgment.discriminatingFeature ?? judgment.candidateName ?? "", partnerClaims: [], candidatesBefore: candidates, candidatesAfter: candidates,
          addedClaimIds: [], removedClaimIds: [], progress: "unknown" }];
      }
      record.observationMemo = memo; record.repairHistory = repairHistory;
      const generationMemo = aiEnabled ? structuredClone(memo) : null;
      const generationIssues = aiEnabled ? summarizeLocalIssues(graph) : null;
      const actionMessage: Message = { role: "system",
        content: ACT_INSTRUCTIONS + "\n" + generation.actionScope[judgment.action] + "\n" + JSON.stringify({ ...judgment, target: execution.target,
          ...(execution.detailFigureIds ? { detailFigureIds: execution.detailFigureIds } : {}) }) };
      const messages: Message[] = [{ role: "system", content: generation.task }, { role: "system", content: generation.instructions },
        ...(generation.concise ? [{ role: "system" as const, content: generation.concise }] : []),
        actionMessage,
        ...(multipleFeature ? [{ role: "system" as const, content: DETAIL_INSTRUCTIONS }] : []),
        ...(ambiguousRevisit ? [{ role: "system" as const, content: REVISIT_MULTIPLE_INSTRUCTIONS }] : []),
        ...observationContextMessages(JSON.stringify({ scope: "private_observations_not_ground_truth", memo })),
        { role: "system", content: "局所問題（非公開）:\n" + summarizeLocalIssues(graph) },
        ...publicTurns.map(t => ({ role: t.speaker === "human" ? "user" as const : "assistant" as const, content: t.text }))];
      const violations = (text: string, context: Message[]) => [...new Set([...findGuardViolations(text, judgment.action), ...findLocalPublicationViolations(text, context),
        ...(questionLayout === "two_stage_v3" ? findOrientationLeaks(text) : []),
        ...(questionLayout === "two_stage_v3" ? findWorkingNoteLeaks(text, events.filter(e => e.seq <= latest.seq).map(e => e.text)) : []),
        ...(questionLayout === "two_stage_v3" && judgment.action === "agree" && judgment.candidateName !== null
          ? findAgreeNameMismatch(text, judgment.candidateName) : []),
        ...(questionLayout === "two_stage_v3" && judgment.action === "propose_name" && judgment.candidateName !== null
          ? findProposeNameMismatch(text, judgment.candidateName) : []),
        ...(adaptive && /repair[_-]?prospect|repair_issue|candidate_narrowed|candidate_widened|other_figure_benefit|no_open_issue|issue_\d+/iu.test(text.normalize("NFKC").replace(/\s/gu, "")) ? ["internal_field"] : []),
        ...(factored && /repair_?facts|reply_?vs_?previous|not_comparable|widened_or_shifted|same_?question|local_?gaps/iu.test(text.normalize("NFKC").replace(/\s/gu, "")) ? ["internal_field"] : []),
        ...(/human[_-]?referent/iu.test(text.normalize("NFKC").replace(/\s/gu, "")) ? ["internal_field"] : []),
        ...(aiEnabled && /\d+:pub\d+/u.test(text.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "")) ? ["internal_id"] : []),
        ...(aiEnabled ? findLocalPublicationViolations(text, privateInstructions) : [])])];
      errorCode = "generation_failed";
      let result = await interruptible(client.complete(messages, { phase: "generation", timeoutMs: generation.timeoutMs, signal }), signal);
      abortIf(signal);
      if (typeof result?.text !== "string" || !result.text.trim()) throw new JevTurnError("generation_failed", undefined, { generationErrorCode: "invalid_response" });
      record.generationGuard.violations = violations(result.text, messages);
      if (record.generationGuard.violations.length) {
        record.generationGuard.regenerated = true;
        if (restateJudgment) record.generationRetryVersion = generationRetryVersion;
        const retry: Message[] = [...messages, { role: "system",
          content: "公開発話を書き直してください。選択済みの行動を変更しないでください。" +
            (restateJudgment ? "\n" + actionMessage.content + "\n" : "") + rewriteReasons(record.generationGuard.violations) }];
        result = await interruptible(client.complete(retry, { phase: "generation", timeoutMs: generation.timeoutMs, signal }), signal);
        abortIf(signal);
        const codes = typeof result?.text === "string" && result.text.trim() ? violations(result.text, retry) : ["empty_utterance"];
        record.generationGuard.violations = [...new Set([...record.generationGuard.violations, ...codes])];
        if (codes.length) {
          const orientationOnly = questionLayout === "two_stage_v3" &&
            record.generationGuard.violations.length === 1 && record.generationGuard.violations[0] === "orientation_leak" &&
            codes.length === 1 && codes[0] === "orientation_leak";
          const safeText = orientationOnly ? orientationSafeFallback(judgment) : null;
          if (!safeText || violations(safeText, retry).length) throw new JevTurnError("unsafe_generation");
          result = { text: safeText };
          record.generationGuard.fallback = true;
          if (["confirm", "repair"].includes(judgment.action) && repairHistory.length && repairHistory.at(-1)?.turn === latest.seq) {
            repairHistory = [...repairHistory.slice(0, -1), { ...repairHistory.at(-1)!, question: "" }];
            record.repairHistory = repairHistory;
          }
        }
      }
      let aiPending: AiPublicPending | null = null;
      if (aiEnabled) {
        aiPending = await prepareAiPublic({ turn: latest.seq, aiSeq: latest.seq + 1, candidateText: result.text, publicTurns,
          ownSlots: slots, ownAnchors: [...ownAnchors], observations: generationMemo!, issueSummary: generationIssues! }, graph, record.aiPublic!, signal,
          record.generationGuard.fallback);
        abortIf(signal);
        state.aiPublic!.pending = aiPending;
      }
      // A validated feature-only repair preserves both the current name and its
      // status. Keep the legacy applyJudgment default outside this Jev boundary.
      const featureOnlyRepair = judgment.action === "repair" && judgment.candidateName === null && judgment.discriminatingFeature !== null;
      const nextState: JevPrivateState = { ...(integrated?{schemaVersion:'jev_private_state_v2' as const,interventionPolicy:state.interventionPolicy}:{}), ledger: ambiguousDefer || ambiguousRevisit || multipleFeature || featureOnlyRepair ? structuredClone(state.ledger) : applyJudgment(state.ledger, judgment),
        graph: applyReferenceUpdate(state.graph, prepared.update, { publicTurns, generationSucceeded: true }) as Graph,
        observationMemo: memo, repairHistory, judgments: [...state.judgments, { turnIndex: latest.seq, lastEventId, status: "committed", judgment,
          generationGuard: structuredClone(record.generationGuard), jevTurn: { attemptNumber, decision, ...(integrated?{executed:execution,intervention:record.intervention as InterventionTrace}:{}), humanReferent: structuredClone(record.humanReferent), ...(record.repairProspect === undefined ? {} : { repairProspect: structuredClone(record.repairProspect) }),
            ...(adaptive || questionLayout === "two_stage_v3" ? { agreeNames: structuredClone(baseInput.agreeNames!) } : {}),
            ...(factored ? { repairFacts: structuredClone(baseInput.repairFacts!) } : {}),
            ...(gate ? { repairGate: structuredClone(gate) } : {}) },
          localGrounding: { ...prepared.trace, attemptNumber }, ...(aiEnabled ? { aiPublic: { aiSeq: aiPending!.aiSeq, textSha256: aiPending!.textSha256 } } : {}) }],
        ...(aiEnabled ? { aiPublic: state.aiPublic } : {}) };
      // Keep the naming policy from the original snapshot, including its absence on historical v3 tapes.
      if (state.agreeNameScopeVersion) nextState.agreeNameScopeVersion = state.agreeNameScopeVersion;
      record.status = "staged"; record.publicSpeech = result.text; record.local.status = "staged";
      return { text: result.text, privateState: nextState };
      } finally {deadline?.close();}
    } catch (error) {
      let code: JevTurnErrorCode = signal?.aborted ? "aborted" : errorCode;
      // Observation adapters are injected: even an own-class exception there
      // remains an observation failure. Do not read arbitrary code getters.
      if (!signal?.aborted && !observationPhase) {
        try {
          if (error instanceof JevTurnError && (integrated||!['invalid_intervention','alternative_failed'].includes(error.code))) code = new JevTurnError(error.code).code;
          else if (error instanceof JevDecisionError && error.code === "invalid_decision") code = "invalid_decision";
        }
        catch { code = errorCode; }
      }
      record.status = code === "aborted" ? "aborted" : "error"; record.errorCode = code;
      if (decideFailure.failed && record.status === "error") record.decisionFailure = { evidence: projectDecisionFailureEvidence(decideFailure.evidence, questionLayout) };
      else if (localRule !== null && record.status === "error") {
        record.decisionRejectionCode = localRule;
        record.decisionFailure = { evidence: checkDecisionFailureEvidence({ schemaVersion: "jev_decision_failure_v1", questionLayout, callIndex: attemptNumber, error: "invalid_decision",
          rejectionCode: localRule, model: null, responseId: null, costUsd: null, latencyMs: 0, inputBudget: null, stages: [] }) };
      }
      if (code === "generation_failed") record.generationErrorCode = normalizeGenerationErrorCode(error);
      const observation = observationPhase ? observationFailure(error, observationPhase, signal?.aborted) : undefined;
      if (observation) Object.assign(record, observation);
      if (record.local) record.local.status = record.status;
      throw new JevTurnError(code, observation, {
        ...(record.decisionRejectionCode ? { decisionRejectionCode: record.decisionRejectionCode } : {}),
        ...(record.generationErrorCode ? { generationErrorCode: record.generationErrorCode } : {}) });
    } finally {
      const safe = project(record); attempts.push(safe);
      emit(options.onJevTurnTrace, safe);
      if (safe.local) emit(options.onLocalGroundingTrace, safe.local);
    }
  }
  async function prepareAiPublic(input: AiPublicInput, graph: Graph, research: AiPublicResearch, signal?: AbortSignal, fallback = false): Promise<AiPublicPending> {
    const snapshot = structuredClone(input);
    const timeoutMs = options.localGrounding.timeoutMs ?? 20000, deadline = performance.now() + timeoutMs;
    const pending: AiPublicPending = { aiSeq: snapshot.aiSeq, textSha256: await aiHash(snapshot.candidateText), candidates: [], status: "empty", reasons: [] };
    research.observationMemo = { version: OBSERVATION_MEMO_VERSION, sha256: await observationHash(snapshot.observations) };
    if (fallback) { pending.status = "skipped_fallback"; pending.reasons = ["skipped_fallback"]; research.pending = pending; return pending; }
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined, stage: keyof AiPublicResearch["stages"] = "ai_extraction";
    let abort = () => {};
    const callOptions = () => {
      abortIf(signal);
      if (controller.signal.aborted || performance.now() >= deadline) throw new AiPublicError("timeout");
      return { timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), signal: controller.signal };
    };
    const checkPayload = (value: unknown) => {
      const raw = JSON.stringify(value);
      if (raw.includes(ownImage.base64) || /data\s*:\s*image\s*\//iu.test(raw) ||
          findLocalPublicationViolations(raw, privateInstructions).some(c => ["internal_image", "internal_credential", "internal_prompt_echo"].includes(c))) throw new AiPublicError("invalid_response");
    };
    const capture = (name: "ai_function" | "ai_support", adapter: { readonly lastEvidence: JevChoiceEvidence | null }, before: number) => {
      if (settled) return;
      const e = adapter.lastEvidence;
      if (e?.callIndex === before + 1) research.stages[name] = { status: e.status === "skipped" ? "skipped" : e.status,
        calls: 1, model: e.model, responseId: e.responseId, callIndex: e.callIndex, costUsd: e.costUsd, error: e.error, choices: [] };
    };
    const started = (name: "ai_function" | "ai_support", callIndex: number) => {
      // Completion evidence may never arrive before the shared phase deadline.
      research.stages[name] = { ...emptyAiEvidence(), status: "error", calls: 1, callIndex };
    };
    const work = async () => {
      checkPayload(snapshot);
      let segments;
      const extractionCall = aiExtractor!.start(snapshot, callOptions());
      research.stages.ai_extraction = extractionCall.evidence;
      try { segments = await extractionCall.result; }
      finally { if (!settled) research.stages.ai_extraction = extractionCall.evidence; }
      callOptions();
      pending.reasons.push(...extractionCall.diagnostics.rejected.map(r => r.reason));
      if (!segments.length) { pending.reasons.push("empty_extraction"); research.stages.ai_function.status = "skipped"; research.stages.ai_support.status = "skipped"; return; }
      const functionInput = { turn: snapshot.turn, aiSeq: snapshot.aiSeq, candidateText: snapshot.candidateText,
        publicTurns: snapshot.publicTurns, segments, priorClaims: priorClaimViews(graph, { limit: REFERENCE_LIMITS.records }) };
      checkPayload(functionInput);
      stage = "ai_function";
      const beforeFunction = aiFunction!.callCount;
      let verdicts;
      try {
        const work = aiFunction!.classify(functionInput, callOptions());
        started("ai_function", aiFunction!.callCount);
        verdicts = await work;
      }
      finally { capture("ai_function", aiFunction!, beforeFunction); }
      callOptions();
      research.stages.ai_function.choices = verdicts.map((v, index) => ({ segmentId: `segment_${index + 1}`, act: v.act as import("../local-grounding/contract.ts").AiPublicAct,
        respondsToClaimId: v.respondsToClaimId, rawScore: v.rawScore }));
      callOptions();
      const checkedSegments = segments.filter(s => verdicts.some(v => v.segmentId === s.segmentId && !["acknowledge", "unknown"].includes(v.act)));
      let supports: Awaited<ReturnType<NonNullable<typeof aiSupport>["check"]>> = [];
      if (checkedSegments.length) {
        stage = "ai_support";
        const beforeSupport = aiSupport!.callCount;
        try {
          const work = aiSupport!.check({ ...functionInput, segments: checkedSegments, verdicts }, callOptions());
          started("ai_support", aiSupport!.callCount);
          supports = await work;
        }
        finally { capture("ai_support", aiSupport!, beforeSupport); }
        callOptions();
        research.stages.ai_support.choices = supports.map(v => ({ segmentId: `segment_${segments.findIndex(s => s.segmentId === v.segmentId) + 1}`,
          support: v.support, rawScore: v.rawScore }));
        callOptions();
      } else research.stages.ai_support.status = "skipped";
      const verified = verifyAiPublicUpdate({ graph, aiSeq: snapshot.aiSeq, candidateText: snapshot.candidateText,
        publicTurns: snapshot.publicTurns, segments, verdicts, supports });
      pending.candidates = verified.candidates;
      pending.status = verified.candidates.length ? verified.rejected.length || pending.reasons.length ? "partial" : "ready" : "empty";
      pending.reasons.push(...verified.rejected.map(r => r.reason), ...verified.diagnostics);
    };
    try {
      const canceled = new Promise<never>((_resolve, reject) => {
        abort = () => { reject(new JevTurnError("aborted")); controller.abort(); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        const schedule = () => {
          const remaining = deadline - performance.now();
          if (remaining <= 0) { reject(new AiPublicError("timeout")); controller.abort(); }
          else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
        };
        schedule();
      });
      await Promise.race([work(), canceled]); abortIf(signal);
    } catch (error) {
      abortIf(signal);
      let code = controller.signal.aborted ? "timeout" : "unavailable";
      try {
        if (!controller.signal.aborted) code = error instanceof AiPublicError ? new AiPublicError(error.code).code
          : error instanceof JevLocalTestError ? new JevLocalTestError(error.code).code : "unavailable";
      } catch { code = "unavailable"; }
      pending.status = "failed"; pending.candidates = []; pending.reasons = [stage + "_" + code];
      research.stages[stage].status = "error"; research.stages[stage].error = code; research.stages[stage].choices = [];
    } finally {
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort();
    }
    pending.reasons = [...new Set(pending.reasons)]; research.pending = structuredClone(pending);
    return pending;
  }
  async function finalRequest({ events, privateState }: { events: Event[]; privateState: JevPrivateState }, retry = false) {
    checkProspectMode(privateState);
    if(integrated)privateState=validateJevPrivateStateV2(privateState,slots,intervention!,questionLayout);else rejectNewLegacyState(privateState);
    if (!privateState.observationMemo) throw new JevTurnError("invalid_state");
    const memo = validateObservationMemo(privateState.observationMemo, { ownAnchors });
    const agreed = retry && questionLayout === "two_stage_v3" ? agreedNamesFromLedger(privateState.ledger) : {};
    const confirmed = Object.keys(agreed).length ? "\n次の確定済みの図形IDと名前の組を維持してください。\n" + JSON.stringify(agreed) : "";
    return client.complete([{ role: "system", content: generation.task },
      ...observationContextMessages(JSON.stringify({ scope: "private_observations_not_ground_truth", memo, ownLedger: privateState.ledger })),
      ...events.map(e => ({ role: e.speaker === "human" ? "user" as const : "assistant" as const, content: e.text })),
      { role: "user", content: generation.final + (retry ? "\n指定JSON形式で再提出してください。" + confirmed : "") }], { phase: "final_submission", timeoutMs: generation.timeoutMs });
  }
  return Object.freeze({ slots: Object.freeze([...slots]), initialPrivateState, initializePrivateState, runAiTurn, finalRequest,
    getAttempts: () => structuredClone(attempts), snapshotGraph: (state: JevPrivateState) => {checkProspectMode(state);if(!integrated)rejectNewLegacyState(state);return snapshotReferenceGraph((integrated?validateJevPrivateStateV2(state,slots,intervention!,questionLayout):state).graph);} });
}
