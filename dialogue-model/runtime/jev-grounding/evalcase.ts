// Grounding evaluation case: the record shared by the eval-set builder and the
// shadow runner (jev-shadow-eval). Data-free: the cases themselves live outside
// the repository under private-runs/. Gold, correctness and old-system fields are
// never part of what a judge sees; toJudgeInput() returns only public history.

export const EVAL_CASE_SCHEMA = "jev-grounding-evalcase/v1";

/** Axis 1: public evidence that both sides identify the same target. */
export type TargetEvidence = "supported" | "insufficient" | "contradicted" | "unknown";
/** Axis 2: public evidence that a name for that target was jointly adopted. */
export type NameEvidence = "agreed" | "unclear" | "not_agreed" | "unknown";

export const TARGET_LEVELS: readonly TargetEvidence[] = Object.freeze(["supported", "insufficient", "contradicted", "unknown"]);
export const NAME_LEVELS: readonly NameEvidence[] = Object.freeze(["agreed", "unclear", "not_agreed", "unknown"]);

export type CaseSource = "historical" | "ai_session" | "synthetic";
export type CaseUnit = "episode_end" | "local_window" | "ai_turn";
export type Split = "train" | "dev" | "holdout";
export type LabelQuality = "explicit" | "derived" | "weak";

export const FAILURE_TAGS = Object.freeze([
  "unfounded_wakarimasu", // affirms understanding/identity without public evidence that the referent matches
  "early_naming", // proposes or fixes a name before the target is publicly identified
  "contradictory_agreement", // keeps or asserts agreement/identity against an open public contradiction
  "over_confirmation", // confirmation the partner treats as redundant or confusing
  "wrong_target_agreement", // offline only: agreed name maps to different figures under the answer key
  "state_mismatch", // logged internal action contradicts the public utterance (not visible to a public-text judge)
] as const);
export type FailureTag = (typeof FAILURE_TAGS)[number];

export interface HistoryTurn {
  speaker: "self" | "partner";
  text: string;
}

export interface GroundingEvalCase {
  schema: typeof EVAL_CASE_SCHEMA;
  caseId: string;
  source: CaseSource;
  unit: CaseUnit;
  /** Leakage unit; every case of one group shares a split. */
  groupId: string;
  dialogueKey: string;
  split: Split;
  /** Only true cases may be sent to an external model. False for anything holding verbatim historical text. */
  externalModelAllowed: boolean;
  /** Public turns, oldest first. No future turns. For ai_turn the judged AI reply itself is excluded. */
  history: HistoryTurn[];
  /** Index of the judged turn. For ai_turn this equals history.length (the reply about to be produced). */
  judgedTurnIndex: number;
  /** null = no gold. A blank source label is never mapped to a value. */
  expected: { target: TargetEvidence | null; name: NameEvidence | null };
  /** Which labels or rules the expected values came from, e.g. ["rule:T-open-M2", "M2", "a11"]. */
  labelBasis: string[];
  labelQuality: LabelQuality;
  /** Per-axis quality when the axes differ (labelQuality is then the weakest). */
  axisQuality?: { target: LabelQuality | null; name: LabelQuality | null };
  /** False for every historical case: ER1 and a11 are not evidence of independent correctness. */
  correctnessKnown: boolean;
  failureTags?: FailureTag[];
  /** ai_turn only: seq of the judged AI reply in the session record, and the logged action. */
  aiTurnSeq?: number;
  aiAction?: string;
  /** ai_turn only, offline: did the AI's target map to the partner's figure under the answer key. */
  offlineCorrect?: boolean | null;
}

export interface JudgeInput {
  history: HistoryTurn[];
  judgedTurnIndex: number;
}

const SOURCES: readonly CaseSource[] = ["historical", "ai_session", "synthetic"];
const UNITS: readonly CaseUnit[] = ["episode_end", "local_window", "ai_turn"];
const SPLITS: readonly Split[] = ["train", "dev", "holdout"];
const QUALITIES: readonly LabelQuality[] = ["explicit", "derived", "weak"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Returns a list of problems; empty means valid. Runtime check for values read from disk. */
export function validateEvalCase(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["case is not an object"];
  if (value.schema !== EVAL_CASE_SCHEMA) errors.push("schema");
  if (!nonEmptyString(value.caseId)) errors.push("caseId");
  if (!SOURCES.includes(value.source as CaseSource)) errors.push("source");
  if (!UNITS.includes(value.unit as CaseUnit)) errors.push("unit");
  if (!nonEmptyString(value.groupId)) errors.push("groupId");
  if (!nonEmptyString(value.dialogueKey)) errors.push("dialogueKey");
  if (!SPLITS.includes(value.split as Split)) errors.push("split");
  if (typeof value.externalModelAllowed !== "boolean") errors.push("externalModelAllowed");
  if (value.source === "historical" && value.externalModelAllowed !== false) errors.push("historical cases must not be externalModelAllowed");
  const history = value.history;
  if (!Array.isArray(history) || history.some((t) => !isRecord(t) || (t.speaker !== "self" && t.speaker !== "partner") || typeof t.text !== "string")) {
    errors.push("history");
  }
  const length = Array.isArray(history) ? history.length : 0;
  const index = value.judgedTurnIndex;
  if (!Number.isInteger(index)) errors.push("judgedTurnIndex");
  else if (value.unit === "ai_turn" ? index !== length : (index as number) < 0 || (index as number) >= length) errors.push("judgedTurnIndex out of range");
  const expected = value.expected;
  if (!isRecord(expected)) errors.push("expected");
  else {
    if (expected.target !== null && !TARGET_LEVELS.includes(expected.target as TargetEvidence)) errors.push("expected.target");
    if (expected.name !== null && !NAME_LEVELS.includes(expected.name as NameEvidence)) errors.push("expected.name");
  }
  if (!Array.isArray(value.labelBasis) || value.labelBasis.some((b) => typeof b !== "string")) errors.push("labelBasis");
  if (!QUALITIES.includes(value.labelQuality as LabelQuality)) errors.push("labelQuality");
  if (value.axisQuality !== undefined) {
    const aq = value.axisQuality;
    if (!isRecord(aq) || [aq.target, aq.name].some((q) => q !== null && !QUALITIES.includes(q as LabelQuality))) errors.push("axisQuality");
  }
  if (typeof value.correctnessKnown !== "boolean") errors.push("correctnessKnown");
  if (value.source === "historical" && value.correctnessKnown !== false) errors.push("historical cases cannot know correctness");
  if (value.failureTags !== undefined && (!Array.isArray(value.failureTags) || value.failureTags.some((t) => !(FAILURE_TAGS as readonly string[]).includes(t as string)))) {
    errors.push("failureTags");
  }
  if (value.unit === "ai_turn" && !Number.isInteger(value.aiTurnSeq)) errors.push("aiTurnSeq");
  if (value.offlineCorrect !== undefined && value.offlineCorrect !== null && typeof value.offlineCorrect !== "boolean") errors.push("offlineCorrect");
  return errors;
}

export function assertEvalCase(value: unknown): GroundingEvalCase {
  const errors = validateEvalCase(value);
  if (errors.length > 0) throw new Error(`invalid eval case: ${errors.join(", ")}`);
  return value as GroundingEvalCase;
}

/** The only view of a case a judge may receive: public history, no gold, tags, correctness or old action. */
export function toJudgeInput(evalCase: GroundingEvalCase): JudgeInput {
  return {
    history: evalCase.history.map((turn) => ({ speaker: turn.speaker, text: turn.text })),
    judgedTurnIndex: evalCase.judgedTurnIndex,
  };
}

/** Guard for any non-mock client: refuses cases that may not leave the machine. */
export function assertSendable(evalCase: GroundingEvalCase): void {
  if (!evalCase.externalModelAllowed || evalCase.source === "historical") {
    throw new Error(`case ${evalCase.caseId} may not be sent to an external model`);
  }
}
