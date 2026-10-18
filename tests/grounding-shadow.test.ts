// v2 two-axis grounding shadow: default off, never changes the dialogue, private records only. Mock judges, synthetic text.
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextLoop, setTimeout as pause } from "node:timers/promises";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createMockGroundingJudge, type GroundingJudge, type GroundingRequest } from "../dialogue-model/runtime/grounding/client.ts";
import type { GroundingShadowRecord } from "../dialogue-model/runtime/v2/grounding-shadow.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const STRATEGIES = ["repair-first", "bypass-enabled"] as const;
const model = () => ({
  async complete(_messages: unknown, { phase }: { phase?: string } = {}) {
    if (phase === "generation") return { text: "尖りが二つの図形ですね。" };
    throw new Error("unexpected phase " + phase);
  },
});
// Deterministic synthetic Luna: proposes the partner's name for its first own figure.
const luna = { async judge(input: Any) {
  return { action: "propose_name", targetSlot: Object.keys(input.ownLedger)[0], candidateName: "鳥", discriminatingFeature: null, note: null };
} };
type Levels = { identification: "supported" | "insufficient" | "contradicted" | "unknown"; nameAgreement: "agreed" | "unclear" | "not_agreed" | "unknown" };
function recordingJudge(levels: Levels = { identification: "insufficient", nameAgreement: "unclear" }) {
  const requests: GroundingRequest[] = [];
  const mock = createMockGroundingJudge(() => levels);
  const judge: GroundingJudge = { async judge(request, options) { requests.push(request); return mock.judge(request, options); } };
  return { judge, requests };
}
async function settle(task: Any, expected: number) {
  for (let index = 0; index < 200 && task.researcherView().groundingShadow.length < expected; index++) await pause(1);
}
async function runTrial(strategy: string, groundingShadow: Any, seed = 501) {
  const records: Any[] = [];
  const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy, seed, runDir: null,
    onPersist: async (record: Any) => { records.push(structuredClone(record)); }, ...(groundingShadow ? { groundingShadow } : {}) } as Any);
  task.message("三角が二つくっついたのを鳥にしませんか");
  await task.whenIdle();
  task.message("はい");
  await task.whenIdle();
  return { task, records };
}
const strip = (state: Any) => ({ ...state, sessionId: null });

test("default OFF: no judge call, and records keep their previous shape", async () => {
  const { task, records } = await runTrial("repair-first", null);
  const last = records.at(-1);
  assert.equal(Object.hasOwn(last, "groundingShadow"), false);
  assert.equal(Object.hasOwn(last.options, "groundingShadow"), false);
  assert.deepEqual(task.researcherView().groundingShadow, []);
});

test("shadow ON changes no utterance, act, ledger or participant state, for both strategies identically", async () => {
  for (const strategy of STRATEGIES) {
    const off = await runTrial(strategy, null, 777);
    const { judge, requests } = recordingJudge();
    const on = await runTrial(strategy, { judge }, 777);
    await settle(on.task, 2);
    assert.deepEqual(strip(on.task.getState()).events.map((e: Any) => [e.speaker, e.text]), strip(off.task.getState()).events.map((e: Any) => [e.speaker, e.text]));
    assert.deepEqual({ ...strip(on.task.getState()), events: null }, { ...strip(off.task.getState()), events: null });
    const onPrivate = on.task.researcherView().privateState, offPrivate = off.task.researcherView().privateState;
    assert.deepEqual(onPrivate.ledger, offPrivate.ledger);
    assert.deepEqual(onPrivate.judgments.map((j: Any) => j.judgment), offPrivate.judgments.map((j: Any) => j.judgment));
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.purpose === "grounding_jev"));
    const shadow: GroundingShadowRecord[] = on.task.researcherView().groundingShadow;
    assert.deepEqual(shadow.map((record) => [record.status, record.identification?.level, record.nameAgreement?.level]),
      [["ok", "insufficient", "unclear"], ["ok", "insufficient", "unclear"]]);
    assert.ok(shadow.every((record) => record.targetSlot === onPrivate.judgments[0].judgment.targetSlot && record.latencyMs !== null));
    // The persisted record carries the shadow and its opt-in flag; the participant view never does.
    await on.task.persistNow();
    const persisted = on.records.at(-1);
    assert.equal(persisted.options.groundingShadow, true);
    assert.equal(persisted.groundingShadow.length, 2);
    const participant = JSON.stringify(on.task.getState());
    assert.doesNotMatch(participant, /grounding|identification|nameAgreement|insufficient|unclear|typesafe|jev/i);
  }
});

test("the judged state carries no answer key, partner ids or future turns, and the same state for both strategies", async () => {
  const states: string[][] = [];
  for (const strategy of STRATEGIES) {
    const { judge, requests } = recordingJudge();
    const { task } = await runTrial(strategy, { judge }, 909);
    await settle(task, 2);
    const key = JSON.stringify(task.researcherView().key);
    const partnerIds = task.getState().scene.shapes.map((shape: Any) => shape.id);
    for (const { state } of requests) {
      for (const id of partnerIds) assert.ok(!state.includes(id), "partner id leaked");
      for (const value of (key.match(/"[A-Za-z0-9_-]{6,}"/g) ?? []).map((v) => v.slice(1, -1))) {
        if (!Object.keys(task.researcherView().privateState.ledger).includes(value)) assert.ok(!state.includes(value), "answer-key value leaked");
      }
      assert.doesNotMatch(state, /repair-first|bypass-enabled|strategy/);
    }
    // The first judgment sees only the first exchange, never the later "はい".
    assert.doesNotMatch(requests[0].state, /"text":"はい"/);
    assert.match(requests[1].state, /"text":"はい"/);
    states.push(requests.map((request) => request.state));
  }
  assert.deepEqual(states[0], states[1]);
});

test("a never-settling or slow judge never delays the reply; the record settles on the shadow's own timeout", async () => {
  let calls = 0;
  const hanging: GroundingJudge = { judge() { calls++; return new Promise(() => {}); } };
  const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: "repair-first", seed: 31, runDir: null,
    groundingShadow: { judge: hanging, timeoutMs: 30 } } as Any);
  task.message("鳥でしょうか");
  assert.equal(await Promise.race([task.whenIdle().then(() => "idle"), nextLoop().then(() => "blocked")]), "idle");
  assert.equal(task.getState().aiStatus, "idle");
  await settle(task, 1);
  assert.equal(calls, 1);
  const [record] = task.researcherView().groundingShadow;
  assert.equal(record.status, "error");
  assert.equal(record.error, "timeout");
  assert.equal(record.identification, null);
});

test("judge failures and out-of-set verdicts are recorded as errors without raw messages", async () => {
  const throwing: GroundingJudge = { async judge() { throw Object.assign(new Error("provider secret sk-or-x"), { code: "not_found" }); } };
  const forged: GroundingJudge = { async judge(request) {
    return { purpose: request.purpose, model: "typesafe/jev-1.14", provider: null, id: null, latencyMs: 1, usage: null,
      identification: { level: "correct", scores: { correct: 1 }, confidence: null },
      nameAgreement: { level: "agreed", scores: { agreed: 1, unclear: 0, not_agreed: 0, unknown: 0 }, confidence: null } } as Any;
  } };
  for (const [judge, error] of [[throwing, "not_found"], [forged, "invalid_response"]] as const) {
    const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: "bypass-enabled", seed: 32, runDir: null, groundingShadow: { judge } } as Any);
    task.message("鳥でしょうか");
    await task.whenIdle();
    await settle(task, 1);
    const [record] = task.researcherView().groundingShadow;
    assert.equal(record.status, "error");
    assert.equal(record.error, error);
    assert.doesNotMatch(JSON.stringify(record), /secret|sk-or|correct/);
    assert.equal(task.getState().aiStatus, "idle");
  }
});

test("restore keeps earlier shadow records, and a trial started without the shadow never gains it", async () => {
  const { judge } = recordingJudge({ identification: "supported", nameAgreement: "agreed" });
  const { task, records } = await runTrial("repair-first", { judge }, 41);
  await settle(task, 2);
  await task.persistNow();
  const saved = structuredClone(records.at(-1));
  const second = recordingJudge();
  const restored: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: "repair-first", seed: 41, runDir: null,
    restore: saved, groundingShadow: { judge: second.judge } } as Any);
  assert.equal(restored.researcherView().groundingShadow.length, 2);
  restored.message("次は船っぽいのです");
  await restored.whenIdle();
  await settle(restored, 3);
  assert.deepEqual(restored.researcherView().groundingShadow.map((r: Any) => r.nameAgreement.level), ["agreed", "agreed", "unclear"]);

  const off = await runTrial("repair-first", null, 42);
  const offRecord = structuredClone(off.records.at(-1));
  const third = recordingJudge();
  const resumed: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: "repair-first", seed: 42, runDir: null,
    restore: offRecord, groundingShadow: { judge: third.judge } } as Any);
  resumed.message("次は船っぽいのです");
  await resumed.whenIdle();
  await pause(5);
  assert.equal(third.requests.length, 0);
  assert.deepEqual(resumed.researcherView().groundingShadow, []);
});

test("shadow options are validated and an aborted turn starts no shadow call", async () => {
  const base = { client: model(), strategy: "repair-first", image: { mimeType: "image/png", base64: "c3ludGhldGlj" },
    anchors: Array.from({ length: 6 }, (_, i) => ({ id: `s-000${i + 1}`, bbox: { x: i, y: 0, width: 1, height: 1 }, centroid: { x: i, y: 0 } })) };
  assert.throws(() => createDialogueV2({ ...base, groundingShadow: { judge: {} } } as Any), /Invalid grounding shadow options/);
  assert.throws(() => createDialogueV2({ ...base, groundingShadow: { judge: recordingJudge().judge, timeoutMs: 0 } } as Any), /Invalid grounding shadow options/);
  assert.throws(() => createDialogueV2({ ...base, groundingShadow: { judge: recordingJudge().judge } } as Any), /Invalid grounding shadow callback/);
  const { judge, requests } = recordingJudge();
  const controller = new AbortController();
  let release: (value: unknown) => void = () => {};
  const dialogue: Any = createDialogueV2({ ...base, judge: { judge: () => new Promise((resolve) => { release = resolve; }) },
    groundingShadow: { judge }, onGroundingShadow: () => {} } as Any);
  const turn = dialogue.runAiTurn({ events: [{ id: "e1", seq: 1, speaker: "human", text: "鳥でしょうか" }], lastEventId: "e1",
    privateState: dialogue.initialPrivateState(), signal: controller.signal });
  await nextLoop();
  controller.abort();
  release(SAFE_JUDGMENT);
  await assert.rejects(turn, (error: Any) => error.name === "AbortError");
  await pause(5);
  assert.equal(requests.length, 0);
});

test("invalid memory evidence degrades to a memory_unavailable gap; valid memory evidence reaches the state", async () => {
  const { startGroundingShadow } = await import("../dialogue-model/runtime/v2/grounding-shadow.ts");
  const input = { events: [{ seq: 1, speaker: "human", text: "鳥っぽいの" }], turnIndex: 1, lastEventId: "e1",
    judgment: { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null },
    ownLedger: { "s-0001": { status: "unassigned" as const, name: null } }, priorAiActs: [] };
  for (const [memoryEvidence, gap, present] of [[{ "bad key": 1 }, true, false], [{ schema: "memory_evidence_v1", open: 1 }, false, true], [undefined, false, false]] as const) {
    const { judge, requests } = recordingJudge();
    const record = await new Promise<GroundingShadowRecord>((resolve) => startGroundingShadow({ judge, timeoutMs: 1000 },
      { ...input, memoryEvidence: memoryEvidence as never }, resolve));
    assert.equal(record.status, "ok");
    assert.equal(record.inputGaps.includes("memory_unavailable"), gap);
    assert.equal(JSON.parse(requests[0].state).aiMemory !== undefined, present);
  }
});

test("the web server passes the shadow only from researcher start-up options, never from a participant request", async (t) => {
  const { startNamingServer } = await import("../dialogue-model/runtime/web/server.mjs");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
  for (const configured of [null, { judge: recordingJudge().judge }]) {
    const calls: Any[] = [];
    const createTaskV2 = async (options: Any) => {
      calls.push(options);
      return { getState: () => ({ version: 2, sessionId: "s", scene: { png, mimeType: "image/png", shapes: [] }, events: [], busy: false, status: "dialogue" }) };
    };
    const server: Any = await startNamingServer({ port: 0, client: model(), createTaskV2, runDir: "", ...(configured ? { groundingShadow: configured } : {}) } as Any);
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const base = "http://127.0.0.1:" + server.address().port;
    const page = await fetch(base);
    await page.text();
    const cookie = String(page.headers.get("set-cookie")).split(";")[0];
    const response = await fetch(base + "/api/start", { method: "POST", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 2, strategy: "repair-first", seed: 1, groundingShadow: { judge: "x" } }) });
    await response.text();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].groundingShadow, configured ?? undefined);
  }
});
