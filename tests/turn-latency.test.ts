// Private per-turn latency records and their text-free summary. Local mocks and a
// fake clock only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeLatency } from "../dialogue-model/runtime/v2/latency.ts";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { DECISION_ACTIONS } from "../workers/research-ai-proxy/src/decisions.mjs";

type Options = { phase?: string };
const at = (ms: number) => new Date(ms).toISOString();

test("synthetic record: per-turn wall times, linked calls, regenerations, superseded attempts and percentiles", () => {
  const record = {
    events: [
      { id: "e-1", seq: 1, speaker: "ai", text: "OPENING-TEXT", at: at(0), origin: "scripted_opening" },
      { id: "e-2", seq: 2, speaker: "human", text: "HUMAN-TEXT-1", at: at(1000) },
      { id: "e-3", seq: 3, speaker: "human", text: "HUMAN-TEXT-2", at: at(1500) },
      { id: "e-4", seq: 4, speaker: "ai", text: "AI-TEXT-1", at: at(9500) },
      { id: "e-5", seq: 5, speaker: "human", text: "HUMAN-TEXT-3", at: at(10000) },
      { id: "e-6", seq: 6, speaker: "ai", text: "AI-TEXT-2", at: at(14000) },
    ],
    requests: [
      { kind: "judgment", status: "ok", model: "MODEL-NAME", latencyMs: 400, requestSeq: 1 },
      { kind: "judgment", status: "ok", latencyMs: 3000, requestSeq: 2 },
      { kind: "judgment", status: "ok", latencyMs: 2000, requestSeq: 2 },
      { kind: "generation", status: "ok", latencyMs: 1500, requestSeq: 2 },
      { kind: "generation", status: "ok", latencyMs: 1000, requestSeq: 2 },
      { kind: "judgment", status: "error", errorCode: "timeout", httpStatus: null, latencyMs: 2500, requestSeq: 3 },
      { kind: "judgment", status: "ok", latencyMs: 1000, requestSeq: 4 },
      { kind: "generation", status: "ok", latencyMs: 800, requestSeq: 4 },
      { kind: "final_submission", status: "ok", latencyMs: 5000, requestSeq: null },
    ],
    turnTimings: [
      { requestSeq: 1, lastEventId: "e-2", startedAtMs: 1000, endedAtMs: 1600, outcome: "superseded", validationFailures: [] },
      { requestSeq: 2, lastEventId: "e-3", startedAtMs: 1600, endedAtMs: 9400, outcome: "returned", judgeAttempts: 2,
        validationFailures: ["invalid_json"], guardRegenerated: true },
      { requestSeq: 3, lastEventId: "e-5", startedAtMs: 10000, endedAtMs: 12500, outcome: "error", errorCode: "timeout" },
      { requestSeq: 4, lastEventId: "e-5", startedAtMs: 12600, endedAtMs: 13900, outcome: "returned", judgeAttempts: 1 },
    ],
  };
  const s = summarizeLatency(record);
  assert.equal(s.version, 1); assert.equal(s.requests, 9); assert.equal(s.errors, 1);
  assert.deepEqual(s.turns.map((t) => [t.aiSeq, t.requestSeq, t.fromTriggerMs, t.fromFirstPendingMs, t.runMs, t.supersededBefore]),
    [[4, 2, 8000, 8500, 7800, 1], [6, 4, 4000, 4000, 1300, 1]]);
  assert.deepEqual(s.turns[0].calls.map((c) => c.phase), ["judgment", "judgment", "generation", "regeneration"]);
  assert.equal(s.turns[0].judgeRetries, 1); assert.deepEqual(s.turns[0].validationFailures, ["invalid_json"]);
  assert.equal(s.turns[0].guardRegenerated, true);
  assert.deepEqual(s.byPhase.judgment, { count: 5, errors: 1, p50Ms: 2000, p90Ms: 3000, p95Ms: 3000, maxMs: 3000, totalMs: 8900 });
  assert.deepEqual(s.byPhase.regeneration, { count: 1, errors: 0, p50Ms: 1000, p90Ms: 1000, p95Ms: 1000, maxMs: 1000, totalMs: 1000 });
  assert.equal(s.byPhase.final_submission.count, 1);
  assert.deepEqual(s.slowestPhase, { phase: "final_submission", p50Ms: 5000 });
  assert.deepEqual(s.turn, { count: 2, p50Ms: 4000, p90Ms: 8000, p95Ms: 8000, maxMs: 8000 });
  assert.equal(s.timeouts, 1); assert.deepEqual(s.errorCodes, { timeout: 1 });
  assert.deepEqual(s.attempts, { total: 4, committed: 2, superseded: 1, errored: 1, interrupted: 0 });
  assert.equal(s.judgeRetries, 1); assert.deepEqual(s.validationFailures, { invalid_json: 1 });
  assert.equal(s.guardRegenerations, 1);
  assert.doesNotMatch(JSON.stringify(s), /TEXT|MODEL-NAME|"e-\d"/);
});

test("legacy records without links still give wall times and phases; malformed input never throws", () => {
  const legacy = summarizeLatency({
    events: [{ id: "a", seq: 1, speaker: "human", text: "x", at: at(0) }, { id: "b", seq: 2, speaker: "ai", text: "y", at: at(2000) }],
    requests: [{ kind: "judgment", status: "ok", latencyMs: 700 }, { kind: "generation", status: "ok", latencyMs: 900 }, { kind: "generation", status: "ok", latencyMs: 300 }],
  });
  assert.equal(legacy.turn.p50Ms, 2000); assert.deepEqual(legacy.turns[0].calls, []); assert.equal(legacy.turns[0].requestSeq, null);
  assert.equal(legacy.byPhase.generation.count, 2, "unlinked generations are not called regenerations");
  for (const input of [null, undefined, 42, "x", [], {}, { events: "x", requests: [null, { latencyMs: "1" }, { kind: "Bad Kind!", status: "error", latencyMs: 5, errorCode: "Secret message" }] },
    { events: [{ seq: 1, speaker: "ai", at: "not a date", id: "x" }], turnTimings: [{ requestSeq: -1 }, null] }]) {
    const s = summarizeLatency(input);
    assert.equal(s.version, 1); assert.equal(s.turn.count, 0);
    assert.doesNotMatch(JSON.stringify(s), /Secret|Bad Kind/);
  }
  assert.deepEqual(Object.keys(summarizeLatency({ requests: [{ kind: "Bad Kind!", status: "error", latencyMs: 5, errorCode: "Secret message" }] }).byPhase), ["other"]);
});

function harness({ decisions = false } = {}) {
  let clock = 1_000_000, gate: Promise<void> | null = null, latest: Record<string, unknown> | null = null;
  const failNext = { judgment: 0 };
  const client = { async complete(_messages: unknown, options: Options) {
    clock += options.phase === "judgment" ? 2000 : 700;
    if (gate) await gate;
    if (options.phase === "judgment" && failNext.judgment > 0) {
      failNext.judgment--;
      throw Object.assign(new Error("SECRET-PROVIDER-BODY"), { code: "timeout" });
    }
    return { text: options.phase === "judgment" ? JSON.stringify(SAFE_JUDGMENT) : "PUBLIC-REPLY-TEXT", model: "MODEL-NAME", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const activeDecision = decisions ? { purpose: "decision_jev", client: { async chooseAction() {
    clock += 300;
    return { action: "accept", model: "MODEL-NAME", probabilities: Object.fromEntries(DECISION_ACTIONS.map((a: string) => [a, Number(a === "accept")])) };
  } } } : null;
  const options = { client, strategy: "repair-first", seed: 137, runDir: null, now: () => clock, activeDecision,
    onPersist: async (record: Record<string, unknown>) => { latest = structuredClone(record); } };
  return { options, failNext, record: () => latest!, setGate(value: Promise<void> | null) { gate = value; }, tick(ms: number) { clock += ms; } };
}

test("naming task records linked timings; a superseded attempt and a retry are counted, not leaked", async () => {
  const h = harness();
  const task = await createNamingTaskV2(h.options);
  let release!: () => void;
  h.setGate(new Promise<void>((resolve) => { release = resolve; }));
  task.message("HUMAN-ONE", "c-1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  h.tick(400);
  task.message("HUMAN-TWO", "c-2");
  h.setGate(null); release();
  await task.whenIdle();
  h.failNext.judgment = 1;
  task.message("HUMAN-THREE", "c-3");
  await task.whenIdle();
  assert.equal(task.getState().aiStatus, "error");
  await task.retry();
  const record = h.record();
  const timings = record.turnTimings as { outcome: string; requestSeq: number; errorCode: string | null }[];
  assert.deepEqual(timings.map((t) => t.outcome), ["superseded", "returned", "error", "returned"]);
  assert.equal(timings[2].errorCode, "timeout");
  const requests = record.requests as { requestSeq: number | null; errorCode?: string }[];
  assert.ok(requests.every((r) => Number.isSafeInteger(r.requestSeq)));
  assert.equal(requests.find((r) => r.errorCode)?.errorCode, "timeout");
  const s = summarizeLatency(record);
  assert.deepEqual(s.attempts, { total: 4, committed: 2, superseded: 1, errored: 1, interrupted: 0 });
  assert.equal(s.turns.length, 2); assert.equal(s.turns[0].supersededBefore, 1); assert.equal(s.turns[1].supersededBefore, 1);
  assert.ok(s.turns.every((t) => t.fromTriggerMs! > 0 && t.runMs! > 0 && t.calls.some((c) => c.phase === "generation")));
  assert.ok(s.turns[0].fromFirstPendingMs! > s.turns[0].fromTriggerMs!, "two coalesced human messages");
  assert.equal(s.timeouts, 1);
  assert.doesNotMatch(JSON.stringify(s), /HUMAN-|PUBLIC-REPLY|MODEL-NAME|SECRET/);
  assert.doesNotMatch(JSON.stringify(timings), /HUMAN-|PUBLIC-REPLY|MODEL-NAME|SECRET/);
  assert.doesNotMatch(JSON.stringify(record.requests), /SECRET/);
  assert.doesNotMatch(JSON.stringify(task.getState()), /turnTimings|requestSeq|latency/i);
});

test("latency survives durable restore and new turns continue the request sequence", async () => {
  const h = harness();
  const first = await createNamingTaskV2(h.options);
  first.message("HUMAN-ONE", "c-1"); await first.whenIdle();
  const saved = structuredClone(h.record());
  const restored = await createNamingTaskV2({ ...h.options, restore: saved });
  await restored.persistNow();
  assert.deepEqual(h.record().turnTimings, saved.turnTimings);
  restored.message("HUMAN-TWO", "c-2"); await restored.whenIdle();
  const record = h.record();
  const timings = record.turnTimings as { requestSeq: number }[];
  assert.deepEqual(timings.map((t) => t.requestSeq), [1, 2]);
  const s = summarizeLatency(record);
  assert.equal(s.turns.length, 2); assert.deepEqual(s.turns.map((t) => t.requestSeq), [1, 2]);
  assert.equal(s.attempts.committed, 2);
});

test("active decision calls are linked to their turn as decision_active", async () => {
  const h = harness({ decisions: true });
  const task = await createNamingTaskV2(h.options);
  task.message("HUMAN-ONE", "c-1"); await task.whenIdle();
  const s = summarizeLatency(h.record());
  assert.deepEqual(s.turns[0].calls.map((c) => c.phase), ["judgment", "decision_active", "generation"]);
  assert.equal(s.byPhase.decision_active.p50Ms, 300);
  const decision = (h.record().requests as { kind: string; purpose?: string }[]).find((r) => r.kind === "decision_active");
  assert.equal(decision?.purpose, "decision_jev");
});
