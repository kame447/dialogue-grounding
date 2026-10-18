// The cross-session index entry. Built by an explicit allowlist from a stored
// trial record: identifiers, options, states, counts and codes only. Never
// cookies, IP addresses, user agents, utterances, names or answers.
import type { LatencySummary } from "./latency";

export type AdminSummary = {
  recordId: string;
  /** Durable Object id (already a one-way hash of the session name); never the cookie. */
  objectId: string;
  startedAt: string | null;
  updatedAt: string | null;
  strategy: string;
  referenceMemory: boolean;
  utteranceStyle: string;
  status: string;
  aiStatus: string;
  counts: { humanMessages: number; aiMessages: number; committedTurns: number; attempts: number; incompleteAttempts: number; requestErrors: number };
  errorCodes: string[];
  /** Cross-session index form: per-turn detail is dropped; code-keyed maps keep code keys only. */
  latency: IndexLatency;
};
export type IndexLatency = Omit<LatencySummary, "turns">;

/** Defense in depth: the index never stores a non-code key, whatever the producer returns. */
export function indexLatency(latency: LatencySummary): IndexLatency {
  const codes = (map: Record<string, number>) => Object.fromEntries(Object.entries(map ?? {})
    .filter(([key, value]) => CODE.test(key) && Number.isFinite(value)));
  const { turns: _turns, ...rest } = latency;
  return { ...rest, byPhase: Object.fromEntries(Object.entries(rest.byPhase ?? {}).filter(([key]) => CODE.test(key))),
    slowestPhase: rest.slowestPhase && CODE.test(rest.slowestPhase.phase) ? rest.slowestPhase : null,
    errorCodes: codes(rest.errorCodes), validationFailures: codes(rest.validationFailures) };
}

const isPlain = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const CODE = /^[a-z0-9_]{1,64}$/;
export const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = RECORD_ID;
export const OBJECT_ID = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const pick = (value: unknown, allowed: readonly string[], fallback: string) =>
  typeof value === "string" && allowed.includes(value) ? value : fallback;
const time = (value: unknown) => typeof value === "string" && ISO.test(value) ? value : null;
const list = (value: unknown) => Array.isArray(value) ? value : [];

export function aiStatusOf(queueState: unknown): string {
  if (!isPlain(queueState)) return "unknown";
  if (queueState.closed === true) return "closed";
  if (queueState.errorCode) return "error";
  return list(queueState.pendingHumanEventIds).length ? "thinking" : "idle";
}

/** Distinct machine codes from the record's error surfaces; free text is dropped. */
export function errorCodesOf(record: Record<string, any>): string[] {
  const codes = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && CODE.test(value)) codes.add(value); };
  add(record.queueState?.errorCode);
  add(record.finalError);
  for (const attempt of list(record.attempts)) {
    if (!isPlain(attempt)) continue;
    if (attempt.status === "judge_error" || attempt.status === "generation_error") add("attempt_" + attempt.status);
    add(attempt.memory?.rejected);
    if (attempt.generationGuard?.fallback === true) add("guard_fallback");
    if (attempt.validation?.fallback === true) add("judge_safe_fallback");
  }
  for (const request of list(record.requests)) {
    if (!isPlain(request) || request.status === "ok") continue;
    add(Number.isInteger(request.httpStatus) ? "http_" + request.httpStatus : "request_error");
  }
  return [...codes].sort();
}

export function summarizeRecord(record: unknown, objectId: string, latency: LatencySummary): AdminSummary {
  if (!isPlain(record) || typeof record.recordId !== "string" || !UUID.test(record.recordId)) throw new TypeError("invalid_record");
  if (!OBJECT_ID.test(objectId)) throw new TypeError("invalid_object_id");
  const events = list(record.events).filter(isPlain);
  const attempts = list(record.attempts).filter(isPlain);
  return {
    recordId: record.recordId,
    objectId,
    startedAt: time(record.startedAt),
    updatedAt: time(record.updatedAt),
    strategy: pick(record.strategy, ["repair-first", "bypass-enabled"], "unknown"),
    referenceMemory: record.options?.referenceMemory === true,
    utteranceStyle: pick(record.options?.utteranceStyle, ["default", "concise"], "default"),
    status: pick(record.status, ["dialogue", "submitting", "completed"], "unknown"),
    aiStatus: aiStatusOf(record.queueState),
    counts: {
      humanMessages: events.filter((event) => event.speaker === "human").length,
      aiMessages: events.filter((event) => event.speaker === "ai").length,
      committedTurns: list(record.judgments).length,
      attempts: attempts.length,
      // Superseded runs also stay incomplete, so this is not a failure count by itself.
      incompleteAttempts: attempts.filter((attempt) => attempt.status === "judge_error" || attempt.status === "generation_error").length,
      requestErrors: list(record.requests).filter((request) => isPlain(request) && request.status !== "ok").length,
    },
    errorCodes: errorCodesOf(record),
    latency: indexLatency(latency),
  };
}
