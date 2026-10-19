// Decision 0002, opt-in research contract. Jev alone selects the next action;
// observations and repair progress are materials, never an answer key or policy.
import type { ObservationMemo } from "../observation/contract.ts";
import type { LocalAct, LocalClaimView, PublicTurn } from "../local-grounding/contract.ts";

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
};
export type PublicNameCandidate = { name: string; figureId: string | null; sourceTurn: number };
export type JevPriorAction = { turn: number; action: JevAction; target: JevTarget; name: string | null; feature: string | null };
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
  /** C sets false after its engineering limit for targeted reobservation is reached. */
  reobservationAllowed?: boolean;
};
export type DecisionInputBudget = {
  maxChars: 20000;
  stateChars: number;
  omitted: { publicTurns: number; claims: number; publicNames: number; repairHistory: number;
    reobservations: number; observationDetails: number; observationChars: number; issueSummaryChars: number };
};
export type JevDecisionStageEvidence = {
  stage: "action_target" | "detail";
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
  observe: JevObservationRequest | null;
  evidence: JevDecisionEvidence;
  decisionKind: "jev_local_test" | "mock";
  calibrated: false;
};
export type JevDecisionCallOptions = { signal?: AbortSignal; timeoutMs?: number };
export type JevDecisionClient = { decide(input: JevDecisionInput, options?: JevDecisionCallOptions): Promise<JevDecision> };
export type JevQuestionLayout = "two_stage_v1";
