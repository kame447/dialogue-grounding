// Research-only state for the two-axis grounding-evidence judge (Jev, shadow).
// Built from an explicit whitelist: public turns up to the judged point, and the
// AI side's own unverified hypothesis and notes. Never the partner's board, the
// answer key, future turns, gold labels or the dialogue strategy (both strategies
// must receive an identical judgment for identical evidence).
import type { IdentificationEvidence, NameAgreementEvidence } from "../../../workers/research-ai-proxy/src/grounding.ts";
import { GROUNDING_MAX_STATE_CHARS } from "../../../workers/research-ai-proxy/src/grounding.ts";

export type { IdentificationEvidence, NameAgreementEvidence };

export type GroundingPublicEvent = { seq: number; speaker: "human" | "ai"; text: string };
/** Luna's interpretation for the coming AI turn; a hypothesis, not a verified fact. */
export type GroundingAiHypothesis = {
  action: string | null;
  targetSlot: string | null;
  candidateName: string | null;
  discriminatingFeature: string | null;
};
export type GroundingNote = { status: "unassigned" | "tentative" | "agreed" | "deferred"; name: string | null };
export type GroundingPriorAct = { turn: number; action: string; targetSlot: string | null; candidateName: string | null };
export type GroundingEvidenceInput = {
  /** Public events; anything other than seq/speaker/text is ignored. */
  events: readonly unknown[];
  /** The judgment is about the evidence after this public event, before the next AI utterance. */
  asOfSeq: number;
  aiHypothesis?: GroundingAiHypothesis | null;
  /** The AI's own working notes keyed by its own opaque ids (never the partner's ids). */
  ownNamingNotes?: Readonly<Record<string, GroundingNote>> | null;
  priorAiActs?: readonly GroundingPriorAct[] | null;
  /**
   * Optional closed-vocabulary summary of the AI's own reference memory, passed only when memory is on.
   * Absent -> the state is byte-identical to a memory-off state. Semantics belong to the memory module.
   */
  memoryEvidence?: GroundingMemoryEvidence | null;
};
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type GroundingMemoryEvidence = Readonly<Record<string, JsonValue>>;
/** Program-side, non-semantic notes about what the judge did not receive. */
export type GroundingInputGap = "no_target_hypothesis" | "earlier_turns_omitted" | "no_ai_turn_yet" | "memory_unavailable";

export const GROUNDING_PUBLIC_TURNS = 24;
const MAX_TEXT = 2_000;
const MAX_HINT = 400;
const MAX_ID = 64;
const MAX_PRIOR_ACTS = 12;
const STATUSES = ["unassigned", "tentative", "agreed", "deferred"];
const MEMORY_MAX_CHARS = 4_000;
const MEMORY_MAX_DEPTH = 5;
const MEMORY_MAX_ITEMS = 24;
const MEMORY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export class GroundingEvidenceError extends TypeError {
  code: string;
  constructor(code: string) {
    super("Invalid grounding evidence: " + code);
    this.name = "GroundingEvidenceError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, max: number, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > max) throw new GroundingEvidenceError(code);
  return value.trim() || null;
}

function publicEvents(events: readonly unknown[], asOfSeq: number): GroundingPublicEvent[] {
  if (!Array.isArray(events) || !Number.isSafeInteger(asOfSeq) || asOfSeq < 1) throw new GroundingEvidenceError("invalid_public_events");
  const kept: GroundingPublicEvent[] = [];
  let previous = 0;
  for (const event of events) {
    if (!isRecord(event) || !Number.isSafeInteger(event.seq) || (event.seq as number) <= previous ||
        !["human", "ai"].includes(event.speaker as string) || typeof event.text !== "string" || event.text.length > MAX_TEXT) {
      throw new GroundingEvidenceError("invalid_public_events");
    }
    previous = event.seq as number;
    // Future turns are dropped, never forwarded: replay callers may pass a whole dialogue.
    if (previous <= asOfSeq) kept.push({ seq: previous, speaker: event.speaker as "human" | "ai", text: event.text });
  }
  if (!kept.some((event) => event.speaker === "human")) throw new GroundingEvidenceError("no_partner_utterance");
  return kept;
}

function hypothesis(value: GroundingAiHypothesis | null | undefined, notes: Record<string, GroundingNote> | null) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new GroundingEvidenceError("invalid_ai_hypothesis");
  const targetSlot = text(value.targetSlot, MAX_ID, "invalid_ai_hypothesis");
  if (targetSlot !== null && notes && !Object.hasOwn(notes, targetSlot)) throw new GroundingEvidenceError("invalid_ai_hypothesis");
  return {
    targetRef: targetSlot,
    intendedAction: text(value.action, MAX_ID, "invalid_ai_hypothesis"),
    candidateName: text(value.candidateName, 200, "invalid_ai_hypothesis"),
    distinguishingFeature: text(value.discriminatingFeature, MAX_HINT, "invalid_ai_hypothesis"),
  };
}

function ownNotes(value: GroundingEvidenceInput["ownNamingNotes"]): Record<string, GroundingNote> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || Object.keys(value).length > 12) throw new GroundingEvidenceError("invalid_own_notes");
  return Object.fromEntries(Object.entries(value).map(([id, entry]) => {
    if (id.length > MAX_ID || !isRecord(entry) || !STATUSES.includes(entry.status as string)) throw new GroundingEvidenceError("invalid_own_notes");
    return [id, { status: entry.status as GroundingNote["status"], name: text(entry.name, 200, "invalid_own_notes") }];
  }));
}

function priorActs(value: GroundingEvidenceInput["priorAiActs"], asOfSeq: number): GroundingPriorAct[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new GroundingEvidenceError("invalid_prior_acts");
  return value.map((act) => {
    if (!isRecord(act) || !Number.isSafeInteger(act.turn) || typeof act.action !== "string" || act.action.length > MAX_ID) {
      throw new GroundingEvidenceError("invalid_prior_acts");
    }
    return { turn: act.turn as number, action: act.action, targetSlot: text(act.targetSlot, MAX_ID, "invalid_prior_acts"),
      candidateName: text(act.candidateName, 200, "invalid_prior_acts") };
  }).filter((act) => act.turn <= asOfSeq).slice(-MAX_PRIOR_ACTS);
}

// Generic bounds only; the memory module owns the vocabulary and must exclude partner ids and future turns.
function memorySummary(value: GroundingEvidenceInput["memoryEvidence"]): GroundingMemoryEvidence | null {
  if (value === null || value === undefined) return null;
  const check = (node: unknown, depth: number): JsonValue => {
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if (typeof node === "string" && node.length <= 200) return node;
    if (depth < MEMORY_MAX_DEPTH && Array.isArray(node) && node.length <= MEMORY_MAX_ITEMS) return node.map((item) => check(item, depth + 1));
    if (depth < MEMORY_MAX_DEPTH && isRecord(node) && Object.getPrototypeOf(node) === Object.prototype &&
        Object.keys(node).length <= MEMORY_MAX_ITEMS && Object.keys(node).every((key) => MEMORY_KEY.test(key))) {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, check(item, depth + 1)]));
    }
    throw new GroundingEvidenceError("invalid_memory_evidence");
  };
  if (!isRecord(value) || Object.hasOwn(value, "status")) throw new GroundingEvidenceError("invalid_memory_evidence");
  const summary = check(value, 0) as GroundingMemoryEvidence;
  if (JSON.stringify(summary).length > MEMORY_MAX_CHARS) throw new GroundingEvidenceError("invalid_memory_evidence");
  return summary;
}

const SPEAKER = { human: "相手", ai: "AI" } as const;

/** @returns the serialized state and the program-side input gaps (recorded, never sent as a verdict). */
export function buildGroundingEvidence(input: GroundingEvidenceInput): { state: string; gaps: GroundingInputGap[]; turns: number } {
  if (!isRecord(input)) throw new GroundingEvidenceError("invalid_input");
  const events = publicEvents(input.events, input.asOfSeq);
  const notes = ownNotes(input.ownNamingNotes);
  const claims = hypothesis(input.aiHypothesis, notes);
  const acts = priorActs(input.priorAiActs, input.asOfSeq);
  const memory = memorySummary(input.memoryEvidence);
  const target = claims?.targetRef ?? null;
  const gaps: GroundingInputGap[] = [];
  if (!claims || (claims.targetRef === null && claims.candidateName === null)) gaps.push("no_target_hypothesis");
  if (!events.some((event) => event.speaker === "ai")) gaps.push("no_ai_turn_yet");

  // Keep the newest turns that fit; cross-turn references need as much history as the bound allows.
  let window = events.slice(-GROUNDING_PUBLIC_TURNS);
  const serialize = (turns: GroundingPublicEvent[]) => JSON.stringify({
    task: "二者が配置・向きの異なる同じ6図形を見て、同じ図形に同じ名前を付ける共同命名。見立ての類似、対象の同定、名称の合意は別のもの。",
    judgedPoint: `公開発話 turn ${input.asOfSeq} までを見た時点。次のAI発話の直前。`,
    publicDialogue: turns.map(({ seq, speaker, text }) => ({ turn: seq, speaker: SPEAKER[speaker], text })),
    omittedEarlierTurns: events.length - turns.length,
    aiSideClaims: claims && {
      ...claims,
      status: "AI側モデルが自分の画像から推定した未検証の仮説。公開対話による裏付けではない。",
    },
    aiOwnNotes: notes && {
      notes,
      status: "AI自身の作業メモ。正解表ではなく、相手の画面とは照合されていない。",
    },
    aiPriorActsOnTarget: acts.filter((act) => target !== null && act.targetSlot === target)
      .map(({ turn, action, candidateName }) => ({ turn, action, candidateName })),
    // Omitted entirely when memory is off, so memory-off states are unchanged.
    ...(memory ? { aiMemory: {
      ...memory,
      status: "AI自身の参照メモリ（非公開の解釈記録）。正解表でも照合済みの事実でもなく、公開対話による裏付けでもない。",
    } } : {}),
  });
  let state = serialize(window);
  while (state.length > GROUNDING_MAX_STATE_CHARS && window.length > 1) {
    window = window.slice(1);
    state = serialize(window);
  }
  if (state.length > GROUNDING_MAX_STATE_CHARS) throw new GroundingEvidenceError("state_too_large");
  if (window.length < events.length) gaps.push("earlier_turns_omitted");
  return { state, gaps, turns: window.length };
}
