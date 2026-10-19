// Shared contract for proposition-scoped (partial) grounding memory. Decision 0001.
// Opt-in research path only: no default strategy, prompt, scoring, UI or model policy
// depends on this file. Every record is the AI's interpretation of PUBLIC utterances
// onto its OWN candidate slots; none of it is an answer key or proof of a true referent.
//
// Pipeline (one human turn):
//   1. Luna  (LocalSegmentExtractor)  proposes segments: quote, targets, aspect, free-text proposition.
//   2. Jev   (LocalFunctionClassifier) picks one closed-set LocalAct per segment, in context.
//   3. Program (verifyLocalUpdate)     checks quote/antecedent/target/name provenance and emits
//      reference-graph `claim` operations for verified segments only; the rest are rejected.
//   4. Commit: the operations join the same referenceGraph update that is applied only when
//      generation succeeds and the reply is published (dialogue-v2 transaction boundary).
// Scores/confidences returned by models are uncalibrated and are NEVER used to promote a claim.

/** Local issue aspects. `construal` (何に見えるか) and `name` (命名) are deliberately separate. */
export const LOCAL_ASPECTS = Object.freeze([
  "referent",    // which figure is meant (target identification)
  "part",        // a component piece / sub-shape
  "contour",     // outline / silhouette
  "orientation", // facing / rotation
  "position",    // relative position of parts or on the board
  "construal",   // 見立て: "looks like a ship" — never a naming proposal by itself
  "name",        // naming proposal / adoption / rejection
  "question",    // an open question that is not one of the above
  "progress",    // moving on / task management
] as const);
export type LocalAspect = typeof LOCAL_ASPECTS[number];

/** Closed set Jev chooses from, per segment. `unknown` keeps memory unchanged. */
export const LOCAL_ACTS = Object.freeze([
  "assert",       // states a proposition (feature, orientation, ...)
  "construe",     // states a 見立て
  "agree",        // agrees with a specific prior proposition
  "deny",         // denies / corrects a specific prior proposition
  "ask",          // asks about a local issue
  "name_propose", // proposes calling the target by a name
  "name_accept",  // accepts a specific prior naming proposal
  "name_reject",  // rejects a specific prior naming proposal
  "defer",        // leaves the issue open for now
  "revisit",      // returns to an earlier (deferred) issue
  "withdraw",     // the speaker retracts their own earlier proposition
  "acknowledge",  // backchannel only; never agreement by itself
  "unknown",
] as const);
export type LocalAct = typeof LOCAL_ACTS[number];

/** Derived (never stored) state of one local issue. */
export const LOCAL_ISSUE_STATES = Object.freeze(["unconfirmed", "supported", "denied", "contested", "deferred", "withdrawn"] as const);
export type LocalIssueState = typeof LOCAL_ISSUE_STATES[number];

/** Name status of a target. `agreed` requires a verified partner acceptance of a verified proposal. */
export const LOCAL_NAME_STATES = Object.freeze(["no_name", "unclear", "not_agreed", "agreed", "unknown"] as const);
export type LocalNameState = typeof LOCAL_NAME_STATES[number];

/** Whose epistemic position a claim records. AI hypotheses are never facts. */
export const LOCAL_SOURCES = Object.freeze(["own_observation", "partner_statement", "ai_hypothesis"] as const);
export type LocalSource = typeof LOCAL_SOURCES[number];

export type PublicTurn = { turn: number; speaker: "human" | "ai"; text: string };

// ---- Step 1: Luna extraction (free text, model output; untrusted) ----
export type LocalSegmentProposal = {
  /** Model-local id, unique within one extraction ("s1", "s2", ...). */
  segmentId: string;
  /** Must be a literal span of the CURRENT human turn; the program re-locates it. */
  quote: string;
  /** AI's own candidate slots; [] means the target is unresolved. */
  targets: string[];
  aspect: LocalAspect;
  /** Luna's short paraphrase of what is asserted/asked (<=160 chars). Not evidence by itself. */
  proposition: string;
  /** Literal name only for aspect "name"; otherwise null. */
  name: string | null;
  /** Existing issue this segment continues, or null. Program verifies it exists. */
  linkedIssueId: string | null;
  /** Earlier public turn this segment responds to, or null. Program verifies it. */
  respondsToTurn: number | null;
};
export type LocalExtractionInput = {
  turn: number;
  publicTurns: readonly PublicTurn[];
  ownSlots: readonly string[];
  /** Private summary of current local issues (summarizeLocalIssues). Same for both strategies. */
  issueSummary: string;
};
export type LocalSegmentExtractor = {
  extract(input: LocalExtractionInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<LocalSegmentProposal[]>;
};

// ---- Step 2: Jev closed-set function (model output; untrusted) ----
export type LocalFunctionVerdict = {
  segmentId: string;
  act: LocalAct;
  /** The prior claim (graph record id) this segment answers, or null. Program verifies it. */
  respondsToClaimId: string | null;
  /** Raw model score for research logs only. Uncalibrated; never a promotion threshold. */
  rawScore: number | null;
};
export type LocalClassificationInput = {
  turn: number;
  publicTurns: readonly PublicTurn[];
  segments: readonly LocalSegmentProposal[];
  /** Candidate prior claims (id, aspect, targets, act, speaker, sourceTurn, proposition, name). */
  priorClaims: readonly LocalClaimView[];
};
export type LocalFunctionClassifier = {
  classify(input: LocalClassificationInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<LocalFunctionVerdict[]>;
};

// ---- Step 3: program-owned records in the reference graph (kind "claim") ----
/** Stored as referenceGraph record { kind: "claim", id, turn, ...LocalClaimFields }. */
export type LocalClaimFields = {
  issueId: string;          // program-assigned, stable across revisits ("<turn>:<local-id>" of the first claim)
  targets: string[];        // own slots; [] when unresolved
  aspect: LocalAspect;
  act: Exclude<LocalAct, "unknown">;
  proposition: string;      // Luna paraphrase, <=160
  name: string | null;      // literal public span, only for aspect "name"
  speaker: "human" | "ai";
  sourceTurn: number;
  quote: string;            // literal span of the public source turn, <=160
  respondsTo: string | null; // verified prior claim id
  source: LocalSource;
};
export type LocalClaimView = LocalClaimFields & { id: string; turn: number };

export type LocalRejection = { segmentId: string; reason: string };
export type LocalVerificationResult = {
  /** Reference-graph operations ({kind:"claim", id, ...}) for verified segments only. */
  operations: Array<{ kind: "claim"; id: string } & LocalClaimFields>;
  rejected: LocalRejection[];
};

// ---- Derived views (for prompts and research records; private) ----
export type LocalIssueView = {
  issueId: string;
  aspect: LocalAspect;
  targets: string[];
  state: LocalIssueState;
  /** Only for aspect "name". */
  nameState: LocalNameState | null;
  name: string | null;
  claimIds: string[];
  lastTurn: number;
};

/** v2 option shape. Default null (off). Requires referenceMemory: true. */
export type LocalGroundingOptions = {
  extractor: LocalSegmentExtractor;
  classifier: LocalFunctionClassifier;
  timeoutMs?: number;
};
