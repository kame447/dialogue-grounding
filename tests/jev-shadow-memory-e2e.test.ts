// Memory-ON Jev grounding shadow, end to end through the real Luna judge, dialogue-v2,
// queue and naming task (mock upstream and mock grounding judge; synthetic text only).
// The shadow sees the memory summary only when memory is ON, never presents
// unconfirmed information as grounded, and never changes anything participant-visible.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { snapshotReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { createMockGroundingJudge, type GroundingJudge, type GroundingRequest } from "../dialogue-model/runtime/grounding/client.ts";
import { A, B, C, createScriptedTrial, humanIds, ids, trial } from "./helpers/memory-harness.ts";
import { SCRIPT } from "./helpers/memory-script.ts";

type Rec = Record<string, any>;
const LABEL = /(?<![A-Za-z0-9])(?:M[0-4]|P[1-5]|ER[01]|a[0-9]{1,2}|F[1-6])(?![A-Za-z0-9])/u;
type Behaviour = "ok" | "throw" | "hang";

function shadowJudge(behaviour: Behaviour = "ok") {
  const requests: GroundingRequest[] = [];
  const mock = createMockGroundingJudge(() => ({ identification: "insufficient", nameAgreement: "unclear" }));
  const judge: GroundingJudge = { async judge(request, options) {
    requests.push(request);
    if (behaviour === "throw") throw Object.assign(new Error("SYNTHETIC-RAW-SHADOW-ERROR"), { code: "upstream_error" });
    if (behaviour === "hang") return new Promise<never>(() => {});
    return mock.judge(request, options);
  } };
  return { judge, requests };
}

async function run({ steps = SCRIPT, referenceMemory = true, shadow = "ok" as Behaviour | null, strategy = "repair-first",
  restore = null as Rec | null, from = 0, to = SCRIPT.length } = {}) {
  const recorder = shadowJudge(shadow ?? "ok");
  const harness = await createScriptedTrial({ steps, referenceMemory, strategy, restore,
    extra: shadow ? { groundingShadow: { judge: recorder.judge, timeoutMs: 20 } } : {} });
  const graphsBefore: Rec[] = [];
  for (let i = from; i < to; i++) {
    graphsBefore.push(structuredClone(harness.task.researcherView().privateState.graph));
    await harness.say(i);
  }
  const expected = (restore?.groundingShadow?.length ?? 0) + (shadow ? to - from : 0);
  for (let i = 0; i < 500 && harness.task.researcherView().groundingShadow.length < expected; i++) await pause(2);
  await harness.task.persistNow();
  return { ...harness, shadowRequests: recorder.requests, graphsBefore, final: harness.records.at(-1)! };
}
const chat = (requests: Rec[]) => JSON.stringify(requests.map(({ phase, messages, options }) => ({ phase, messages, options })));
const participantVisible = (r: Rec) => ({ events: r.events.map(({ seq, speaker, text }: Rec) => ({ seq, speaker, text })),
  ledger: r.ownLedger, privateState: r.queueState.privateState, graph: r.referenceGraph ?? null, judgments: r.judgments });

test("shadow on vs off (memory ON): identical upstream requests, utterances, ledger, memory and judgments, both strategies", async () => {
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const off = await run({ strategy, shadow: null });
    const on = await run({ strategy });
    assert.equal(on.shadowRequests.length, SCRIPT.length);
    assert.equal(chat(on.requests), chat(off.requests), strategy + ": Luna requests must be byte-identical");
    assert.deepEqual(participantVisible(on.final), participantVisible(off.final));
    // The mock clock also ticks on the shadow's extra research persists, so wall-clock stamps are excluded.
    const visible = (task: Rec) => { const state = task.getState();
      return { ...state, sessionId: null, events: state.events.map(({ at, ...event }: Rec) => event) }; };
    assert.deepEqual(visible(on.task), visible(off.task));
    assert.ok(on.final.groundingShadow.every((r: Rec) => r.status === "ok"));
    assert.equal(Object.hasOwn(off.final, "groundingShadow"), false);
  }
});

test("memory ON: the shadow sees the pre-turn memory and never shows unconfirmed or negated information as grounded/agreed", async () => {
  const { shadowRequests, graphsBefore } = await run();
  for (const [index, request] of shadowRequests.entries()) {
    const memory = JSON.parse(request.state).aiMemory;
    assert.ok(memory, "turn " + index + ": memory summary present when ON");
    const view = snapshotReferenceGraph(graphsBefore[index]);
    const active = graphsBefore[index].records.filter((r: Rec) => r.kind === "mention" && view.mentions.some((m: Rec) => m.id === r.id));
    for (const figure of memory.figures) {
      assert.ok(ids.includes(figure.ref), "own ids only");
      const on = (epistemic: string) => new Set(active.filter((m: Rec) => m.epistemic === epistemic && m.slots.includes(figure.ref)).map((m: Rec) => m.sourceTurn));
      for (const g of figure.grounded) assert.ok(on("grounded").has(g.turn), "turn " + index + ": grounded ref without a grounded mention");
      for (const h of figure.hypothesis) assert.ok(on("hypothesis").has(h.turn) && !on("grounded").has(h.turn), "hypothesis never upgraded");
      for (const turn of figure.featureReports.deniedTurns) assert.ok(!figure.featureReports.confirmedTurns.includes(turn), "negation is not support");
      const slot = view.ownSlots[figure.ref];
      if (figure.name?.agreement === "explicit") assert.equal(slot.candidate.agreement, "explicit");
      if (figure.memoryStatus === "agreed") assert.equal(slot.status, "agreed", "no agreement the memory does not hold");
    }
    // Free text is limited to public names: no quotes of human turns, no own-image observations.
    for (const step of SCRIPT) assert.ok(!JSON.stringify(memory).includes(step.human));
    assert.ok(!/confidence/u.test(JSON.stringify(memory)), "graph confidence is not forwarded as a probability");
  }
  const figureAt = (index: number, slot: string) => JSON.parse(shadowRequests[index].state).aiMemory.figures.find((f: Rec) => f.ref === slot);
  // Judged before the human's acceptance was committed: proposal only.
  assert.deepEqual([figureAt(1, A).memoryStatus, figureAt(1, A).name.agreement], ["tentative", "none"]);
  assert.deepEqual([figureAt(2, A).memoryStatus, figureAt(2, A).name.agreement], ["agreed", "explicit"]);
  // A two-slot hypothesis stays a hypothesis on both slots.
  assert.equal(figureAt(3, B).grounded.length, 0);
  assert.equal(figureAt(3, C).hypothesis.length, 1);
  // The denial of B's feature is a negative report only.
  assert.equal(figureAt(4, B).featureReports.deniedTurns.length, 1);
  assert.notEqual(figureAt(4, B).name?.agreement, "explicit");
  assert.equal(figureAt(5, C).memoryStatus, "deferred");
  assert.equal(figureAt(5, C).focus.mode, "defer");
});

test("memory OFF: shadow states carry no memory and equal the memory-ON states with aiMemory removed", async () => {
  const on = await run();
  const off = await run({ referenceMemory: false });
  assert.equal(off.shadowRequests.length, SCRIPT.length);
  for (const [index, request] of off.shadowRequests.entries()) {
    assert.equal(Object.hasOwn(JSON.parse(request.state), "aiMemory"), false);
    const { aiMemory, ...rest } = JSON.parse(on.shadowRequests[index].state);
    assert.ok(aiMemory);
    assert.equal(request.state, JSON.stringify(rest), "turn " + index + ": OFF state is byte-identical to the memory-less path");
  }
  assert.ok(off.final.groundingShadow.every((r: Rec) => !r.inputGaps.includes("memory_unavailable")));
});

test("shadow failures (error, hang past its own timeout) never change the dialogue, and record codes only", async () => {
  const off = await run({ shadow: null });
  for (const behaviour of ["throw", "hang"] as const) {
    const on = await run({ shadow: behaviour });
    assert.equal(chat(on.requests), chat(off.requests));
    assert.deepEqual(participantVisible(on.final), participantVisible(off.final));
    assert.equal(on.final.groundingShadow.length, SCRIPT.length);
    for (const record of on.final.groundingShadow) {
      assert.equal(record.status, "error");
      assert.match(record.error, /^[a-z][a-z0-9_]{0,39}$/u);
    }
    assert.ok(!JSON.stringify(on.final).includes("SYNTHETIC-RAW-SHADOW-ERROR"));
  }
});

test("restore mid-dialogue with the shadow on: the same shadow states and memory as an uninterrupted run", async () => {
  const whole = await run();
  const first = await run({ to: 5 });
  const saved = JSON.parse(JSON.stringify(first.final));
  assert.equal(saved.options.groundingShadow, true);
  const second = await run({ restore: saved, from: 5 });
  assert.deepEqual(second.shadowRequests.map((r) => r.state), whole.shadowRequests.slice(5).map((r) => r.state));
  assert.deepEqual(second.final.queueState.privateState.graph, whole.final.queueState.privateState.graph);
  assert.equal(second.final.groundingShadow.length, SCRIPT.length);
});

test("leak checks: shadow states never contain partner ids, the key, annotation-shaped labels or the strategy", async () => {
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const { shadowRequests } = await run({ strategy });
    for (const request of shadowRequests) {
      for (const id of humanIds) assert.ok(!request.state.includes(id));
      assert.ok(!request.state.includes(JSON.stringify(trial.key)));
      assert.ok(!LABEL.test(request.state), "label-shaped token " + request.state.match(LABEL)?.[0]);
      assert.ok(!/repair-first|bypass-enabled/u.test(request.state));
      assert.deepEqual(Object.keys(request), ["purpose", "state"]);
    }
  }
});
