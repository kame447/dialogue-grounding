// Offline shadow comparison of the old v2 judge's recorded actions against an
// independent Jev 2-axis grounding verdict. Research diagnostics only: nothing
// here feeds back into a dialogue, the ledger, scoring or a participant view.
//
// Jev scores are relative/action scores. Until calibrated against gold they
// are never "probability correct", and the old judge's action probabilities are
// not reused as P(correct target).

export const TARGET_LEVELS = Object.freeze(["supported", "insufficient", "contradicted", "unknown"] as const);
export const NAME_LEVELS = Object.freeze(["agreed", "unclear", "not_agreed", "unknown"] as const);
export type TargetLevel = typeof TARGET_LEVELS[number];
export type NameLevel = typeof NAME_LEVELS[number];

export type JudgeTurn = { speaker: "self" | "partner"; text: string };
/** The AI's own unverified interpretation (Luna), never the answer key. */
export type AiHypothesis = { action: string | null; targetSlot: string | null; candidateName: string | null; discriminatingFeature: string | null };
export type JevAxesInput = {
  /** Public turns only, oldest first, ending before the reply being judged. */
  history: JudgeTurn[];
  aiHypothesis?: AiHypothesis | null;
};
export type JevAxesVerdict = {
  target: TargetLevel;
  name: NameLevel;
  /** Uncalibrated relative scores; may be absent. */
  scores?: { target?: Partial<Record<TargetLevel, number>>; name?: Partial<Record<NameLevel, number>> } | null;
  model: string | null;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
};
export type JevAxesClient = {
  /** "mock" never leaves the process; anything else is treated as an external model. */
  readonly kind: "mock" | "live";
  judgeAxes(input: JevAxesInput): Promise<JevAxesVerdict>;
};

/** Behaviour codes on the old system's AI reply (lexical + recorded action). */
export const BEHAVIOURS = Object.freeze([
  "claims_understanding", // 「わかります」「ありますね」 etc.
  "naming",               // propose_name, or public naming wording
  "agreement",            // agree, or public decision wording
  "confirmation",         // confirm action or a confirmation question
  "impression_sharing",   // 見立て wording ("…みたい", "…っぽい")
  "hold_or_revisit",      // defer / move-on / revisit wording
  "repair",
] as const);
export type Behaviour = typeof BEHAVIOURS[number];

/** Failure tags shared with the jev-evalset case files. */
export const FAILURE_TAGS = Object.freeze(["unfounded_wakarimasu", "early_naming", "contradictory_agreement", "over_confirmation", "wrong_target_agreement"] as const);
export type FailureTag = typeof FAILURE_TAGS[number];

export type ReplayItem = {
  /** seq of the AI reply in the record. */
  aiSeq: number;
  history: JudgeTurn[];
  oldAction: string | null;
  hypothesis: AiHypothesis | null;
  replyText: string;
};

/** Structural subset of jev-evalset's case type (owned by HumbleLangmuir in
 * dialogue-model/runtime/jev-grounding/evalcase.ts); only the fields read here. */
export type EvalCaseLike = {
  caseId: string;
  source: "historical" | "ai_session" | "synthetic";
  /** Leakage unit (dialogue or episode); splits are assigned per group. */
  groupId: string;
  split: "train" | "dev" | "holdout";
  /** Anything but true means the case must never reach an external model. */
  externalModelAllowed?: boolean;
  history: JudgeTurn[];
  judgedTurnIndex: number;
  /** null = no gold; a blank source label is never mapped to a value. */
  expected: { target: TargetLevel | null; name: NameLevel | null };
  failureTags?: string[];
  labelBasis?: string[];
  labelQuality?: "explicit" | "derived" | "weak";
  /** Per-axis quality (jev-grounding-derive/v2); labelQuality is the weaker of the two. */
  axisQuality?: { target?: "explicit" | "derived" | "weak" | null; name?: "explicit" | "derived" | "weak" | null } | null;
  correctnessKnown?: boolean;
  aiSeq?: number;
  oldAction?: string;
  /** Synthetic cases: a candidate reply scored against failureTags. Never sent to the judge. */
  probeReply?: { text: string; action: string | null };
};

/** Reviewed AI reply, keyed by its seq. `tags` holds the failures a judge of
 * public text could detect; an empty list is a reviewed turn with none (a
 * provisional negative). Offline-only tags such as wrong_target_agreement or
 * state_mismatch go to `otherTags`. */
export type KnownFailure = { aiSeq: number; tags: FailureTag[]; otherTags: string[]; basis: string;
  /** Reviewer's provisional 2-axis label for the evidence before the reply, if any. */
  expected?: { target: TargetLevel | null; name: NameLevel | null } | null };
