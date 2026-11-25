// Reference memory -> Jev grounding shadow: the pre-turn graph reaches the shadow state
// only when memory is ON, and nothing flows back. Mock judges and synthetic text only.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { startGroundingShadow, type GroundingShadowRecord } from "../dialogue-model/runtime/v2/grounding-shadow.ts";
import { buildGroundingEvidence } from "../dialogue-model/runtime/grounding/evidence.ts";
import { createMockGroundingJudge, type GroundingJudge, type GroundingRequest } from "../dialogue-model/runtime/grounding/client.ts";
import { createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const STRATEGIES = ["repair-first", "bypass-enabled"] as const;
const model = () => ({
  async complete(_messages: unknown, { phase }: { phase?: string } = {}) {
    if (phase === "generation") return { text: "尖りが二つの図形ですね。" };
    throw new Error("unexpected phase " + phase);
  },
});
const interpretation = (slot: string, extra: Any = {}) => ({ slots: [slot], epistemic: "grounded", intent: "refer", feature: null,
  nameAcceptance: null, deferSlot: null, revisitSlot: null, ...extra });
// Synthetic Luna with reference interpretations: propose -> agree -> deny a feature on another figure -> defer.
function luna() {
  const calls: Any[] = [];
  return { calls, async judge(input: Any) {
    calls.push(input);
    const [first, second] = Object.keys(input.ownLedger);
    const last = input.publicHistory.filter((m: Any) => m.role === "user").at(-1).content as string;
    const reference = !input.referenceContext ? undefined
      : last.includes("鳥にしませんか") ? interpretation(first, { intent: "name_proposal", nameAcceptance: { slot: first, name: "鳥" } })
      : last.includes("鳥でいいです") ? interpretation(first, { intent: "name_acceptance", nameAcceptance: { slot: first, name: "鳥" } })
      : last.includes("尖りはないです") ? interpretation(second, { intent: "denial", feature: { slot: second, feature: "尖り", polarity: "denied" } })
      : last.includes("後にしましょう") ? interpretation(second, { deferSlot: second })
      : { slots: [], epistemic: "unresolved", intent: "refer", feature: null, nameAcceptance: null, deferSlot: null, revisitSlot: null };
    const named = last.includes("鳥");
    return { action: named ? "propose_name" : "accept", targetSlot: named ? first : null, candidateName: named ? "鳥" : null,
      discriminatingFeature: null, note: null, ...(reference === undefined ? {} : { reference }) };
  } };
}
function recordingJudge() {
  const requests: GroundingRequest[] = [];
  const mock = createMockGroundingJudge(() => ({ identification: "insufficient", nameAgreement: "unclear" }));
  const judge: GroundingJudge = { async judge(request, options) { requests.push(request); return mock.judge(request, options); } };
  return { judge, requests };
}
const MESSAGES = ["三角が二つくっついたのを鳥にしませんか", "鳥でいいです", "丸いのは尖りはないです", "それは後にしましょう"];
async function settle(task: Any, expected: number) {
  for (let index = 0; index < 400 && task.researcherView().groundingShadow.length < expected; index++) await pause(1);
}
async function runTrial({ strategy = "repair-first", referenceMemory = true, shadow = true, seed = 611, messages = MESSAGES,
  restore = null as Any } = {}) {
  const records: Any[] = [];
  const recorder = recordingJudge();
  const judge = luna();
  const task: Any = await createNamingTaskV2({ client: model(), judge, strategy, seed, runDir: null, referenceMemory,
    onPersist: async (record: Any) => { records.push(structuredClone(record)); },
    ...(restore ? { restore } : {}), ...(shadow ? { groundingShadow: { judge: recorder.judge } } : {}) } as Any);
  for (const message of messages) {
    task.message(message);
    await task.whenIdle();
  }
  if (shadow) await settle(task, (restore?.groundingShadow?.length ?? 0) + messages.length);
  return { task, records, requests: recorder.requests, judge };
}
const memoryOf = (request: GroundingRequest) => JSON.parse(request.state).aiMemory;

test("memory ON: each shadow state carries the PRE-turn memory, with status, provenance, agreement, negation and defer", async () => {
  const { task, requests } = await runTrial();
  assert.equal(requests.length, 4);
  const [first, second] = task.slots ?? Object.keys(task.researcherView().privateState.ledger);
  const memories = requests.map(memoryOf);
  // Turn 1 is judged before anything was committed to memory.
  assert.equal(memories[0].memoryTurn, 0);
  assert.ok(memories[0].figures.every((f: Any) => f.name === null && f.grounded.length === 0));
  const at = (index: number, slot: string) => memories[index].figures.find((f: Any) => f.ref === slot);
  // Turn 2 sees the proposal from turn 1, not yet the agreement it is about to judge.
  assert.deepEqual(at(1, first).name, { text: "鳥", agreement: "none", visibility: "public", proposedBy: ["human"], sourceTurns: [at(1, first).grounded[0].turn] });
  assert.equal(at(1, first).memoryStatus, "tentative");
  // Turn 3 sees the human's explicit acceptance from turn 2.
  assert.equal(at(2, first).name.agreement, "explicit");
  assert.equal(at(2, first).memoryStatus, "agreed");
  // Turn 4 sees the denial as a negative report, never as support or a name.
  assert.equal(at(3, second).featureReports.deniedTurns.length, 1);
  assert.deepEqual(at(3, second).featureReports.confirmedTurns, []);
  assert.equal(at(3, second).name, null);
  // The defer committed at turn 4 is visible only to a later judgment.
  assert.equal(at(3, second).focus, null);
  const graph = task.researcherView().privateState.graph;
  assert.ok(graph.records.some((r: Any) => r.kind === "focus" && r.mode === "defer"));
  // No future turn: every turn mentioned in a memory precedes its judged point.
  for (const [index, memory] of memories.entries()) {
    const judged = JSON.parse(requests[index].state).publicDialogue.at(-1).turn;
    assert.equal(memory.asOfTurn, judged);
    assert.ok(memory.memoryTurn < judged);
  }
});

test("memory OFF: the shadow state has no memory key and is byte-identical to the memory-less builder", async () => {
  const { task, requests, records } = await runTrial({ referenceMemory: false });
  assert.equal(requests.length, 4);
  for (const request of requests) assert.equal(memoryOf(request), undefined);
  const view = task.researcherView();
  assert.equal(view.privateState.graph, null);
  // Rebuild the first judged state without any memory input and compare bytes.
  await task.persistNow();
  const events = records.at(-1).events.map(({ seq, speaker, text }: Any) => ({ seq, speaker, text }));
  const first = JSON.parse(requests[0].state);
  const judged = first.publicDialogue.at(-1).turn;
  const rebuilt = buildGroundingEvidence({ events, asOfSeq: judged, aiHypothesis: view.privateState.judgments[0].judgment,
    ownNamingNotes: view.privateState.judgments[0].ownLedgerBefore, priorAiActs: [] });
  assert.equal(rebuilt.state, requests[0].state);
});

test("the shadow changes nothing in memory, ledger, judgments or utterances, for both strategies identically", async () => {
  const states: string[][] = [];
  for (const strategy of STRATEGIES) {
    const off = await runTrial({ strategy, shadow: false, seed: 733 });
    const on = await runTrial({ strategy, shadow: true, seed: 733 });
    const strip = (task: Any) => {
      const { privateState } = task.researcherView();
      return { events: task.getState().events.map((e: Any) => [e.speaker, e.text]), graph: privateState.graph, ledger: privateState.ledger,
        judgments: privateState.judgments.map((j: Any) => ({ judgment: j.judgment, memory: j.memory })) };
    };
    assert.deepEqual(strip(on.task), strip(off.task));
    // Luna's inputs (including its own memory view) are identical with the shadow on.
    assert.deepEqual(on.judge.calls.map((c: Any) => c.referenceContext), off.judge.calls.map((c: Any) => c.referenceContext));
    states.push(on.requests.map((r) => r.state));
  }
  assert.deepEqual(states[0], states[1]);
});

test("no free text, labels, answer key or partner ids reach the memory part of the state", async () => {
  const { task, requests } = await runTrial({ messages: [...MESSAGES, "M2とER1とa11の尖りは見えますか"] });
  assert.equal(requests.length, 5);
  // The defer from turn 4 is visible to the next judgment.
  const [, second] = Object.keys(task.researcherView().privateState.ledger);
  assert.equal(memoryOf(requests[4]).figures.find((f: Any) => f.ref === second).focus.mode, "defer");
  const key = JSON.stringify(task.researcherView().key);
  const partnerIds = task.getState().scene.shapes.map((shape: Any) => shape.id);
  for (const request of requests) {
    const memory = JSON.stringify(memoryOf(request));
    for (const id of partnerIds) assert.ok(!memory.includes(id), "partner id leaked");
    for (const value of (key.match(/"[A-Za-z0-9_-]{6,}"/g) ?? []).map((v) => v.slice(1, -1))) {
      if (!Object.keys(task.researcherView().privateState.ledger).includes(value)) assert.ok(!memory.includes(value), "answer-key value leaked");
    }
    for (const text of ["尖り", "M2", "ER1", "a11", "三角", "confidence", "strategy", "repair-first", "bypass-enabled"]) {
      assert.ok(!memory.includes(text), text);
    }
  }
});

test("restore from a persisted record yields the same memory summary as the uninterrupted run", async () => {
  const full = await runTrial({ seed: 821 });
  const half = await runTrial({ seed: 821, messages: MESSAGES.slice(0, 2) });
  await half.task.persistNow();
  const saved = JSON.parse(JSON.stringify(half.records.at(-1)));
  const resumed = await runTrial({ seed: 821, messages: MESSAGES.slice(2), restore: saved });
  assert.equal(resumed.requests.length, 2);
  assert.ok(resumed.requests.every((r) => memoryOf(r)?.memoryTurn > 0));
  assert.deepEqual(resumed.requests.map(memoryOf), full.requests.slice(2).map(memoryOf));
});

test("an invalid graph degrades to a memory_unavailable gap and the axes still run", async () => {
  const input = { events: [{ seq: 1, speaker: "human", text: "鳥っぽいの" }], turnIndex: 1, lastEventId: "e1",
    judgment: { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null },
    ownLedger: { "s-0001": { status: "unassigned" as const, name: null } }, priorAiActs: [] };
  const run = async (graph: unknown) => {
    const { judge, requests } = recordingJudge();
    const record = await new Promise<GroundingShadowRecord>((resolve) => startGroundingShadow({ judge, timeoutMs: 1000 }, { ...input, graph }, resolve));
    return { record, state: requests[0]?.state };
  };
  const bad = await run({ schemaVersion: 1, records: "x" });
  assert.equal(bad.record.status, "ok");
  assert.ok(bad.record.inputGaps.includes("memory_unavailable"));
  assert.equal(JSON.parse(bad.state!).aiMemory, undefined);
  const none = await run(null);
  assert.ok(!none.record.inputGaps.includes("memory_unavailable"));
  const empty = await run(createReferenceGraph({ slots: Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`) }));
  assert.equal(JSON.parse(empty.state!).aiMemory.schema, "memory_evidence_v1");
  // Without memory the bytes match a call that never had a graph.
  assert.equal(none.state, (await run(undefined)).state);
});
