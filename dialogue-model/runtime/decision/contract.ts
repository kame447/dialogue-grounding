import type { LedgerAction } from "./judgment-material-v5.ts";
// Decision 0002, opt-in research contract. Jev alone selects the next action;
// observations and repair progress are materials, never an answer key or policy.
import type { ObservationMemo } from "../observation/contract.ts";
import type { LocalAct, LocalClaimView, PublicTurn } from "../local-grounding/contract.ts";
import type { OwnLedger } from "../judgment/schema.mjs";

export const JEV_ACTIONS = Object.freeze(["accept", "propose_name", "confirm", "repair", "defer", "revisit", "agree", "move_on", "close", "request_observation"] as const);
export type JevAction = typeof JEV_ACTIONS[number];
export const OBSERVATION_ASPECTS = Object.freeze(["orientation", "part", "contour", "construal", "referent"] as const);
export type DecisionObservationAspect = typeof OBSERVATION_ASPECTS[number];
export type JevTarget = { kind: "single"; figureId: string } | { kind: "multiple"; figureIds: string[] } | { kind: "none" };
export type JevObservationRequest = {
  figureIds: string[];
  aspect: DecisionObservationAspect;
  question: string;
  partnerConstrual: string | null;
};
export type RepairHistoryEntry = {
  turn: number;
  issueId: string | null;
  action: "repair" | "confirm" | "revisit";
  question: string;
  partnerClaims: readonly { id: string; act: LocalAct; proposition: string; targets: readonly string[] }[];
  candidatesBefore: readonly string[];
  candidatesAfter: readonly string[];
  addedClaimIds: readonly string[];
  removedClaimIds: readonly string[];
  /** Descriptive change only; not a stagnation threshold or command to move on. */
  progress: "changed" | "unchanged" | "unknown";
  missingReasons?: string[];
  humanRejections?: { segmentId: string; reason: string }[];
};
export const REPAIR_REPLY_COMPARISONS = ["same", "narrowed", "widened_or_shifted", "not_comparable"] as const;
export const REPAIR_LOCAL_GAPS = ["human_local_missing", "human_capacity_dropped", "ai_source_incomplete"] as const;
/** adaptive_repair_v3 only. Mechanical record facts, never semantic identity,
 * a progress verdict, a threshold or a command to select an action. */
export type RepairFact = {
  turn: number;
  previousTurn: number | null;
  replyVsPrevious: typeof REPAIR_REPLY_COMPARISONS[number];
  sameQuestionAsPrevious: boolean;
  localGaps: (typeof REPAIR_LOCAL_GAPS[number])[];
  localRejections: number;
};
/** v13 material derived from a public reading and the other speaker's support. */
export type SharedConstrual = {
  id: string;
  claimIds: string[];
  figureIds: string[];
  construal: string;
  openDetails: { issueId: string; aspect: string; proposition: string; state: string }[];
};
export type PublicNameCandidate = { name: string; figureId: string | null; sourceTurn: number };
export type JevPriorAction = { turn: number; action: JevAction; target: JevTarget; name: string | null; feature: string | null };
/** Human utterance referent, independent of the next action's target. No winner or calibration. */
export type HumanReferentMaterial = { status: "ok" | "unknown"; scores: Record<string, number> | null };
export type HumanReferentEstimate = HumanReferentMaterial & {
  model: string | null;
  responseId: string | null;
  costUsd: number | null;
  latencyMs: number;
  inputBudget: DecisionInputBudget | null;
  calibrated: false;
};
export const REPAIR_PROSPECTS = ["progressing", "stalled", "uncertain", "no_open_issue"] as const;
export const REPAIR_PROSPECT_BASES = ["new_information", "candidate_narrowed", "candidate_widened", "repetition", "partner_uncertain", "other_figure_benefit", "none"] as const;
/** Uncalibrated Jev material. Never a threshold, a score or a forced branch. */
export type RepairProspectMaterial =
  | { status: "ok"; issue: { choice: "issue"; turn: number; issueId: string | null } | { choice: "none" } | { choice: "unknown" };
      prospect: typeof REPAIR_PROSPECTS[number]; basis: typeof REPAIR_PROSPECT_BASES[number];
      scores: { repair_issue: Record<string, number>; prospect: Record<string, number>; basis: Record<string, number> } }
  | { status: "unknown"; issue: null; prospect: null; basis: null; scores: null };
/** v2 adds the agreement gate: repair issues closed by a later agree are left out of Jev's inference. */
export type AdaptiveRepairTrial = { version: "adaptive_repair_v1" | "adaptive_repair_v2" | "adaptive_repair_v3" };
export type JevDecisionInput = {
  turn: number;
  publicTurns: readonly PublicTurn[];
  ownSlots: readonly string[];
  /** A's memo; the request builder forwards only its textual observation fields. */
  observations: ObservationMemo;
  issueSummary: string;
  priorClaims: readonly LocalClaimView[];
  repairHistory: readonly RepairHistoryEntry[];
  previousAction: JevPriorAction | null;
  /** Literal public spans only, validated against their public source turn. */
  publicNames: readonly PublicNameCandidate[];
  /** Opt-in agreement candidates backed by eligible public naming claims. */
  agreeNames?: PublicNameCandidate[];
  /** Private participant ledger for candidate validation. Never serialized to Jev. */
  participantLedger?: OwnLedger;
  /** Local v3 proposal legality only. The request never serializes the ledger. */
  nameLedger?: OwnLedger;
  /** holistic_v1 only, local like nameLedger (never serialized): the observation memo's readings (holistic construals) are explanations, not names, so only public names are name candidates. */
  nameSource?: "public_only";
  /** holistic_v3 only, local (never serialized): this turn's human utterance carries a typed naming request; with no agree candidate, accept is not offered. */
  namingRequest?: true;
  /** holistic_v4 only, local with namingRequest: accept is never offered for the typed naming request, even when an agree is legal. */
  namingRequestStrict?: true;
  /** C sets false after its engineering limit for targeted reobservation is reached. */
  reobservationAllowed?: boolean;
  humanReferent?: HumanReferentMaterial;
  repairProspect?: RepairProspectMaterial;
  repairFacts?: RepairFact[];
  /** holistic_v5 only: every action executed in earlier turns. Its presence (even empty) selects the compact judgment material (decision/judgment-material-v5.ts). */
  judgmentLedger?: readonly LedgerAction[];
  /** holistic_v5 only: the stimulus rotation of the trial. The rotation premise is stated only for relative_pm90 (omitted means that original mode). */
  rotationMode?: "relative_pm90" | "relative_0";
  /** jev_generation_retry_v6 only: every question of the request, the repair-prospect questions included, carries the notation legend and the rotation premise. */
  notationV6?: true;
  /** jev_generation_retry_v11 only: the legend also describes the `answerClaims` rows (an answer the graph no longer carries has a null source turn). */
  notationV11?: true;
  /** Private material mode from the trial's generation version. */
  p5Enabled?: true;
  sharedConstruals?: SharedConstrual[];
};
export type DecisionInputBudget = {
  maxChars: 20000;
  stateChars: number;
  omitted: { publicTurns: number; claims: number; publicNames: number; repairHistory: number;
    reobservations: number; observationDetails: number; observationChars: number; issueSummaryChars: number };
};
export type JevDecisionStageEvidence = {
  /** multiple_candidates exists only in two_stage_v2, between action_target and detail.
   * action and target exist only in two_stage_v3 (action, then the target the chosen action may take, then detail). */
  stage: "action_target" | "multiple_candidates" | "detail" | "action" | "target";
  model: string | null;
  responseId: string | null;
  /** Wire choice labels, with complete uncalibrated score maps for research only. */
  choices: Record<string, string>;
  scores: Record<string, Record<string, number>>;
  latencyMs: number;
  costUsd: number | null;
  /** Present on the real adapter, including when no material was omitted. */
  inputBudget?: DecisionInputBudget;
};
export type JevDecisionEvidence = Omit<JevDecisionStageEvidence, "stage"> & {
  decisionMenuVersion?: typeof PARTICIPANT_TARGET_MENU_VERSION;
  /** Real calls retain every executed stage; mocks omit this or supply an empty array. */
  stages?: JevDecisionStageEvidence[];
};
export type JevDecision = {
  action: JevAction;
  target: JevTarget;
  name: string | null;
  feature: string | null;
  /** Sources of the selected name/feature, within target; never a narrowed target. */
  detailFigureIds?: string[];
  sharedClaimIds?: string[];
  observe: JevObservationRequest | null;
  evidence: JevDecisionEvidence;
  decisionKind: "jev_local_test" | "mock";
  calibrated: false;
};
export type JevDecisionCallOptions = { signal?: AbortSignal; timeoutMs?: number;
  /** two_stage_v3 only: selects the holistic-first criteria text; absent keeps the older text byte for byte. */
  dialoguePolicy?: DialoguePolicy;
  /** decide() only: receives a copy of this call's own evidence when the call fails. Untrusted until
   * validated by projectDecisionFailureEvidence; never invoked for referent, prospect or detail calls. */
  onFailureEvidence?: (evidence: unknown) => void };
/** Execution projection, independently evidenced after an opt-in acceptance step. */
export type JevExecutedDecision = Omit<Pick<JevDecision, "action" | "target" | "name" | "feature" | "observe" | "detailFigureIds" | "sharedClaimIds">,
  "action" | "observe"> & { action: Exclude<JevAction, "request_observation">; observe: null };
export type JevDetailResult = { executed: JevExecutedDecision; evidence: JevDecisionStageEvidence };
export const PARTICIPANT_TARGET_MENU_VERSION = "action_conditioned_targets_v1";
export type JevDecisionClient = {
  readonly participantTargetMenuVersion?: typeof PARTICIPANT_TARGET_MENU_VERSION;
  decide(input: JevDecisionInput, options?: JevDecisionCallOptions): Promise<JevDecision>;
  estimateRepairProspect?(input: JevDecisionInput, options?: JevDecisionCallOptions): Promise<RepairProspectMaterial>;
  estimateReferent?(input: JevDecisionInput, options?: JevDecisionCallOptions): Promise<HumanReferentEstimate>;
  /** two_stage_v3 + dialoguePolicy holistic_v1 only. Never throws for a transport or response failure: that is status "error" (unconfirmed). */
  classifyDraftAct?(input: DraftActInput, options?: JevDecisionCallOptions): Promise<DraftActResult>;
  completeDetail?(input: JevDecisionInput, selected: Pick<JevDecision, "action" | "target">,
    options?: JevDecisionCallOptions): Promise<JevDetailResult>;
};
/** two_stage_v1 is the default and is unchanged. two_stage_v2 is explicit opt-in only: stage one asks
 * action and target kind, and a multiple target is followed by one closed choice among the 2-6 figure subsets. */
/** Version of the dialogue policy a trial was created with (recorded in its profile and options). Absent = the text before holistic-first. */
/** holistic_v1: the whole-reading prompts and the draft-naming question. holistic_v2 adds, for new trials only, the casual-naming extraction criterion and the
 * name rules (the memo readings and the partner's proposed names are never AI propose_name candidates). A recorded policy is reproduced as it was created. */
/** holistic_v3 adds, for new trials only, the typed naming-request rule: a turn whose human utterance asks for a name (a proposal or an approval question) and in which
 * agree is not legal does not offer accept. */
/** holistic_v4 adds, for new trials only, to holistic_v3: an approval request may answer the claim the classifier chose when that claim carries a name (a human proposal or a public AI
 * adoption) whatever turn the extraction points at, and a typed naming request (an unadopted name) never offers accept, even when agree is legal. holistic_v3 is reproduced as it was. */
/** holistic_v5 inherits the decision and naming-request rules of holistic_v4. */
export type DialoguePolicy = "holistic_v1" | "holistic_v2" | "holistic_v3" | "holistic_v4" | "holistic_v5";
export const isHolisticV4Plus = (p: unknown): p is "holistic_v4" | "holistic_v5" => p === "holistic_v4" || p === "holistic_v5";
export const isHolisticV3Plus = (p: unknown): p is "holistic_v3" | "holistic_v4" | "holistic_v5" => p === "holistic_v3" || isHolisticV4Plus(p);
export const isHolisticV2Plus = (p: unknown): boolean => p === "holistic_v2" || isHolisticV3Plus(p);
export const isHolisticPolicy = (p: unknown): p is DialoguePolicy => p === "holistic_v1" || isHolisticV2Plus(p);
/** What a draft does about naming (holistic_v1): a closed set judged by Jev for the executed target and name. */
export const DRAFT_ACTS = ["adopt_chosen", "adopt_other", "decline_or_hold", "propose_question", "recount_only", "none"] as const;
export type DraftAct = typeof DRAFT_ACTS[number];
export type DraftActInput = { turn: number; publicTurns: readonly PublicTurn[]; reasons: readonly string[];
  selected: { action: JevAction; target: JevTarget; name: string | null }; draft: string };
export type DraftActResult = { status: "ok" | "error"; choice: DraftAct | null; scores: Record<string, number> | null; model: string | null;
  responseId: string | null; costUsd: number | null; latencyMs: number; error: string | null };
export type JevQuestionLayout = "two_stage_v1" | "two_stage_v2" | "two_stage_v3";
/** two_stage_v3 is explicit opt-in only (integrated profile). Stage one is one closed question over the actions that have at
 * least one legal target and detail in the material; stage two is one closed question over the targets that action may take
 * (none, one figure, or a 2-6 figure candidate set); the detail stage is unchanged. At most 3 POSTs per decision. */
