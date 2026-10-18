// AI-session turns as eval cases. Reads a persisted v2 trial record (outside the
// repository) and a researcher-side annotation file keyed by AI reply seq.
// The answer key (record.scoring.key) is read here only to set offlineCorrect;
// it never enters history, and toJudgeInput() drops offlineCorrect.
import type { FailureTag, GroundingEvalCase, LabelQuality, NameEvidence, Split, TargetEvidence } from "./evalcase.ts";
import { EVAL_CASE_SCHEMA, FAILURE_TAGS, NAME_LEVELS, TARGET_LEVELS } from "./evalcase.ts";

interface RecordEvent { id: string; seq: number; speaker: string; text: string }
interface RecordJudgment {
  lastEventId?: string;
  status?: string;
  judgment?: { action?: string; targetSlot?: string | null; candidateName?: string | null };
}
export interface SessionRecord {
  recordId?: string;
  events: RecordEvent[];
  judgments: RecordJudgment[];
  scoring?: { key?: { human?: Record<string, string>; ai?: Record<string, string> } };
}

/** Researcher-side reading of one AI reply (provisional until reviewed). */
export interface TurnAnnotation {
  seq: number;
  target: TargetEvidence | null;
  name: NameEvidence | null;
  tags: FailureTag[];
  basis: string[];
  quality: LabelQuality;
  /** Episode label within the session, used as the leakage group. */
  episode: string;
  /** Partner-side slot the partner was talking about, if known; offline only. */
  partnerSlot?: string | null;
}

export interface AiTurn {
  seq: number;
  action: string | null;
  targetSlot: string | null;
  candidateName: string | null;
  history: { speaker: "self" | "partner"; text: string }[];
}

/** Every committed judged AI reply with the public history that preceded it. */
export function aiTurns(record: SessionRecord): AiTurn[] {
  const events = [...record.events].sort((a, b) => a.seq - b.seq);
  const out: AiTurn[] = [];
  for (const entry of record.judgments) {
    if (entry.status !== "committed" || !entry.judgment) continue;
    const at = events.findIndex((e) => e.id === entry.lastEventId);
    if (at < 0) continue;
    const reply = events.slice(at + 1).find((e) => e.speaker === "ai");
    if (!reply) continue;
    const before = events.filter((e) => e.seq < reply.seq);
    out.push({
      seq: reply.seq,
      action: entry.judgment.action ?? null,
      targetSlot: entry.judgment.targetSlot ?? null,
      candidateName: entry.judgment.candidateName ?? null,
      history: before.map((e) => ({ speaker: e.speaker === "ai" ? "self" : "partner", text: e.text })),
    });
  }
  return out;
}

/** Offline only: whether the AI's slot and the partner's slot are the same figure under the answer key. */
export function offlineCorrect(record: SessionRecord, aiSlot: string | null, partnerSlot: string | null | undefined): boolean | null {
  const key = record.scoring?.key;
  if (!key?.ai || !key.human || !aiSlot || !partnerSlot) return null;
  const a = key.ai[aiSlot], h = key.human[partnerSlot];
  return a && h ? a === h : null;
}

export function validateAnnotation(value: unknown): string[] {
  const v = value as Partial<TurnAnnotation> | null;
  const errors: string[] = [];
  if (!v || typeof v !== "object") return ["annotation is not an object"];
  if (!Number.isInteger(v.seq)) errors.push("seq");
  if (v.target !== null && !TARGET_LEVELS.includes(v.target as TargetEvidence)) errors.push("target");
  if (v.name !== null && !NAME_LEVELS.includes(v.name as NameEvidence)) errors.push("name");
  if (!Array.isArray(v.tags) || v.tags.some((t) => !(FAILURE_TAGS as readonly string[]).includes(t))) errors.push("tags");
  if (!Array.isArray(v.basis)) errors.push("basis");
  if (!["explicit", "derived", "weak"].includes(v.quality as string)) errors.push("quality");
  if (typeof v.episode !== "string" || !v.episode) errors.push("episode");
  return errors;
}

export function buildAiTurnCases(record: SessionRecord, annotations: readonly TurnAnnotation[], options: {
  dialogueKey: string; split: Split; externalModelAllowed: boolean;
}): GroundingEvalCase[] {
  const bySeq = new Map(annotations.map((a) => [a.seq, a]));
  return aiTurns(record).map((turn) => {
    const note = bySeq.get(turn.seq);
    const correct = note ? offlineCorrect(record, turn.targetSlot, note.partnerSlot) : null;
    return {
      schema: EVAL_CASE_SCHEMA,
      caseId: `${options.dialogueKey}-s${turn.seq}`,
      source: "ai_session",
      unit: "ai_turn",
      groupId: `${options.dialogueKey}-${note?.episode ?? "unannotated"}`,
      dialogueKey: options.dialogueKey,
      split: options.split,
      externalModelAllowed: options.externalModelAllowed,
      history: turn.history,
      judgedTurnIndex: turn.history.length,
      expected: { target: note?.target ?? null, name: note?.name ?? null },
      labelBasis: note ? [...note.basis] : ["unannotated"],
      labelQuality: note?.quality ?? "weak",
      correctnessKnown: correct !== null,
      failureTags: note ? [...note.tags] : [],
      aiTurnSeq: turn.seq,
      aiAction: turn.action ?? undefined,
      offlineCorrect: correct,
    };
  });
}

/** Lexical surfacing of affirmations worth checking (はい／わかります／あります…). A candidate, not a failure. */
export function affirmationCandidate(text: string): boolean {
  return /^(?:\s|「)*(?:はい|うん|たしかに|確かに|あります|そうです|そうですね|わかります|なるほど|ああ、それ)/.test(text) || /わかります/.test(text);
}
