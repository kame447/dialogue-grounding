// Research-only latency summary over a stored v2 record. Pure and import-free so
// the Worker bundle can use it. Output holds numbers, phase names and enum-like
// codes only: never utterance text, model names, event ids or provider errors.
// Malformed input yields zeros and nulls instead of throwing.

export type PhaseLatency = { count: number; errors: number; p50Ms: number | null; p90Ms: number | null; p95Ms: number | null; maxMs: number | null; totalMs: number };
export type Distribution = { count: number; p50Ms: number | null; p90Ms: number | null; p95Ms: number | null; maxMs: number | null };
export type CallLatency = { phase: string; latencyMs: number; status: "ok" | "error"; errorCode: string | null };
export type TurnLatency = {
  aiSeq: number; requestSeq: number | null;
  fromTriggerMs: number | null; fromFirstPendingMs: number | null; runMs: number | null;
  calls: CallLatency[];
  judgeAttempts: number | null; judgeRetries: number; validationFailures: string[];
  judgeFallback: boolean; guardRegenerated: boolean; guardFallback: boolean;
  supersededBefore: number;
};
export type LatencySummary = {
  version: 1;
  requests: number; errors: number;
  byPhase: Record<string, PhaseLatency>;
  turn: Distribution; firstPending: Distribution;
  slowestPhase: { phase: string; p50Ms: number } | null;
  timeouts: number; errorCodes: Record<string, number>;
  attempts: { total: number; committed: number; superseded: number; errored: number; interrupted: number };
  judgeRetries: number; validationFailures: Record<string, number>; guardRegenerations: number; guardFallbacks: number;
  turns: TurnLatency[];
};

type Obj = Record<string, unknown>;
type Event = { id: string; seq: number; speaker: "human" | "ai"; atMs: number; scripted: boolean };
type Request = { kind: string; ok: boolean; latencyMs: number; requestSeq: number | null; errorCode: string | null };
type Timing = { requestSeq: number; lastEventId: string | null; startedAtMs: number | null; endedAtMs: number | null; outcome: string;
  judgeAttempts: number | null; validationFailures: string[]; judgeFallback: boolean; guardRegenerated: boolean; guardFallback: boolean };

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const seqOf = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
const code = (value: unknown, limit = 40): string | null =>
  typeof value === "string" && new RegExp(`^[a-z][a-z0-9_]{0,${limit - 1}}$`).test(value) ? value : null;

/** Nearest-rank percentiles, with one sort per distribution. */
function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null;
  return { count: sorted.length, p50Ms: percentile(50), p90Ms: percentile(90), p95Ms: percentile(95),
    maxMs: sorted.length ? sorted.reduce((max, value) => Math.max(max, value), -Infinity) : null };
}
const increment = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };

function readEvents(record: Obj): Event[] {
  const events: Event[] = [];
  for (const raw of list(record.events)) {
    if (!isObj(raw)) continue;
    const seq = seqOf(raw.seq), atMs = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
    if (seq === null || !Number.isFinite(atMs) || typeof raw.id !== "string" || (raw.speaker !== "human" && raw.speaker !== "ai")) continue;
    events.push({ id: raw.id, seq, speaker: raw.speaker, atMs, scripted: raw.origin === "scripted_opening" });
  }
  return events.sort((a, b) => a.seq - b.seq);
}

function readRequests(record: Obj): Request[] {
  const requests: Request[] = [];
  for (const raw of list(record.requests)) {
    if (!isObj(raw)) continue;
    const latencyMs = finite(raw.latencyMs);
    if (latencyMs === null || latencyMs < 0) continue;
    requests.push({ kind: code(raw.kind) ?? "other", ok: raw.status === "ok", latencyMs, requestSeq: seqOf(raw.requestSeq),
      errorCode: raw.status === "ok" ? null : code(raw.errorCode) ?? "error" });
  }
  return requests;
}

function readTimings(record: Obj): Timing[] {
  const timings: Timing[] = [];
  for (const raw of list(record.turnTimings)) {
    if (!isObj(raw)) continue;
    const requestSeq = seqOf(raw.requestSeq);
    if (requestSeq === null) continue;
    timings.push({ requestSeq, lastEventId: typeof raw.lastEventId === "string" ? raw.lastEventId : null,
      startedAtMs: finite(raw.startedAtMs), endedAtMs: finite(raw.endedAtMs),
      outcome: ["running", "returned", "superseded", "error"].includes(raw.outcome as string) ? raw.outcome as string : "error",
      judgeAttempts: seqOf(raw.judgeAttempts), validationFailures: list(raw.validationFailures).map((value) => code(value, 60) ?? "invalid"),
      judgeFallback: raw.judgeFallback === true, guardRegenerated: raw.guardRegenerated === true, guardFallback: raw.guardFallback === true });
  }
  return timings.sort((a, b) => a.requestSeq - b.requestSeq);
}

/** Generation calls after the first in the same attempt are guard regenerations. */
function phases(requests: Request[]): string[] {
  const generations = new Map<number, number>();
  return requests.map((request) => {
    if (request.kind !== "generation" || request.requestSeq === null) return request.kind;
    const seen = generations.get(request.requestSeq) ?? 0;
    generations.set(request.requestSeq, seen + 1);
    return seen ? "regeneration" : "generation";
  });
}

export function summarizeLatency(record: unknown): LatencySummary {
  const source: Obj = isObj(record) ? record : {};
  const events = readEvents(source), requests = readRequests(source), timings = readTimings(source);
  const phaseOf = phases(requests);

  const byPhase: Record<string, PhaseLatency> = {};
  const grouped = new Map<string, Request[]>();
  const callsBySeq = new Map<number, CallLatency[]>();
  requests.forEach((request, index) => {
    const phase = phaseOf[index];
    const items = grouped.get(phase) ?? [];
    items.push(request); grouped.set(phase, items);
    if (request.requestSeq !== null) {
      const calls = callsBySeq.get(request.requestSeq) ?? [];
      calls.push({ phase, latencyMs: request.latencyMs, status: request.ok ? "ok" : "error", errorCode: request.errorCode });
      callsBySeq.set(request.requestSeq, calls);
    }
  });
  for (const [phase, items] of grouped) {
    const values = items.map((item) => item.latencyMs);
    const { p50Ms, p90Ms, p95Ms, maxMs } = distribution(values);
    byPhase[phase] = { count: items.length, errors: items.filter((item) => !item.ok).length, p50Ms, p90Ms, p95Ms, maxMs,
      totalMs: values.reduce((sum, value) => sum + value, 0) };
  }
  let slowestPhase: LatencySummary["slowestPhase"] = null;
  for (const [phase, latency] of Object.entries(byPhase)) {
    if (latency.p50Ms !== null && (!slowestPhase || latency.p50Ms > slowestPhase.p50Ms)) slowestPhase = { phase, p50Ms: latency.p50Ms };
  }
  const errorCodes: Record<string, number> = {};
  for (const request of requests) if (request.errorCode) increment(errorCodes, request.errorCode);

  const committedSeqs = new Set<number>();
  const returnedByEvent = new Map<string, Timing[]>();
  for (const timing of timings) {
    if (timing.outcome !== "returned" || timing.lastEventId === null) continue;
    const bucket = returnedByEvent.get(timing.lastEventId) ?? [];
    bucket.push(timing); returnedByEvent.set(timing.lastEventId, bucket);
  }
  // The timings are sorted, including duplicate request sequences. Count an
  // open interval by binary search instead of scanning all attempts per turn.
  function boundary(seq: number, inclusive: boolean): number {
    let lo = 0, hi = timings.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2), value = timings[mid].requestSeq;
      if (value < seq || inclusive && value === seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const turns: TurnLatency[] = [];
  let previousSeq = 0;
  for (let index = 0, lastAi = -1; index < events.length; index++) {
    const event = events[index];
    if (event.speaker !== "ai") continue;
    const humans = events.slice(lastAi + 1, index).filter((item) => item.speaker === "human");
    lastAi = index;
    if (event.scripted || !humans.length) continue;
    const before = events[index - 1];
    // The committing attempt is the latest returned one on the exact preceding snapshot.
    const candidates = returnedByEvent.get(before.id);
    let timing: Timing | null = null;
    while (candidates?.length) {
      const candidate = candidates.pop()!;
      if (!committedSeqs.has(candidate.requestSeq)) { timing = candidate; break; }
    }
    if (timing) committedSeqs.add(timing.requestSeq);
    const requestSeq = timing?.requestSeq ?? null;
    const calls = requestSeq === null ? [] : callsBySeq.get(requestSeq) ?? [];
    turns.push({
      aiSeq: event.seq, requestSeq,
      fromTriggerMs: event.atMs - humans[humans.length - 1].atMs,
      fromFirstPendingMs: event.atMs - humans[0].atMs,
      runMs: timing && timing.startedAtMs !== null && timing.endedAtMs !== null ? timing.endedAtMs - timing.startedAtMs : null,
      calls,
      judgeAttempts: timing?.judgeAttempts ?? null,
      judgeRetries: Math.max(0, (timing?.judgeAttempts ?? 1) - 1),
      validationFailures: timing ? [...timing.validationFailures] : [],
      judgeFallback: timing?.judgeFallback ?? false, guardRegenerated: timing?.guardRegenerated ?? false, guardFallback: timing?.guardFallback ?? false,
      supersededBefore: requestSeq === null ? 0 : Math.max(0, boundary(requestSeq, false) - boundary(previousSeq, true)),
    });
    if (requestSeq !== null) previousSeq = requestSeq;
  }

  const validationFailures: Record<string, number> = {};
  for (const timing of timings) for (const failure of timing.validationFailures) increment(validationFailures, failure);
  const committed = timings.filter((timing) => committedSeqs.has(timing.requestSeq)).length;
  return {
    version: 1,
    requests: list(source.requests).length,
    errors: list(source.requests).filter((request) => !isObj(request) || request.status !== "ok").length,
    byPhase,
    turn: distribution(turns.map((turn) => turn.fromTriggerMs).filter((value): value is number => value !== null)),
    firstPending: distribution(turns.map((turn) => turn.fromFirstPendingMs).filter((value): value is number => value !== null)),
    slowestPhase,
    timeouts: requests.filter((request) => request.errorCode === "timeout").length,
    errorCodes,
    attempts: {
      total: timings.length, committed,
      superseded: timings.filter((timing) => timing.outcome === "superseded" || (timing.outcome === "returned" && !committedSeqs.has(timing.requestSeq))).length,
      errored: timings.filter((timing) => timing.outcome === "error").length,
      interrupted: timings.filter((timing) => timing.outcome === "running").length,
    },
    judgeRetries: timings.reduce((sum, timing) => sum + Math.max(0, (timing.judgeAttempts ?? 1) - 1), 0),
    validationFailures,
    guardRegenerations: timings.filter((timing) => timing.guardRegenerated).length,
    guardFallbacks: timings.filter((timing) => timing.guardFallback).length,
    turns,
  };
}
