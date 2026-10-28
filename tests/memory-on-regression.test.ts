// Memory-ON multi-turn regression/E2E through the real Luna judge, dialogue-v2,
// queue and naming task. Only the upstream chat client is a local mock; every
// utterance is synthetic. No paid request, no network, no private material.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotReferenceGraph, summarizeForJudge } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { MEMORY_INSTRUCTIONS, MEMORY_NAME_INTENTS_V2 } from "../dialogue-model/runtime/judgment/memory.mjs";
import { JUDGE_TIME_BUDGET_MS } from "../dialogue-model/runtime/judgment/luna.mjs";
import { GENERATION_TIMEOUT_MS } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import {
  A, B, C, D, act, ref, ids, humanIds, humanPngBase64, aiPngBase64, trial, createScriptedTrial, requestText, requestImages,
  stableOptions, assertSameBudget, type Request, type Step,
} from "./helpers/memory-harness.ts";
import { SCRIPT } from "./helpers/memory-script.ts";

type Rec = Record<string, any>;
const MEMORY_SUMMARY_PREFIX = "AI自身の参照メモと公開発話の出典番号";
const isMemoryMessage = (message: { role: string; content: unknown }) => message.role === "system" && typeof message.content === "string" &&
  (message.content === MEMORY_INSTRUCTIONS || message.content === MEMORY_NAME_INTENTS_V2 || message.content.startsWith(MEMORY_SUMMARY_PREFIX));
const CONFIDENCE: Record<string, number> = { unresolved: 0, hypothesis: 0.5, grounded: 0.9 };
const BARE = /^(それ|これ|あれ|はい|うん|そう|そうです|了解|yes|ok)[。！!？?\s]*$/iu;
// Annotation-label shapes (M0-M4, P1-P5, ER0-ER1, a-series) and the researcher key's figure ids.
const LABEL = /(?<![A-Za-z0-9])(?:M[0-4]|P[1-5]|ER[01]|a[0-9]{1,2}|F[1-6])(?![A-Za-z0-9])/u;

async function runScript(steps: Step[], { referenceMemory = true, strategy = "repair-first" } = {}) {
  const harness = await createScriptedTrial({ steps, referenceMemory, strategy });
  const perTurn: Rec[] = [];
  for (let i = 0; i < steps.length; i++) perTurn.push(await harness.say(i));
  return { ...harness, perTurn };
}
const deps = (record: Rec): string[] => record.kind === "mention" ? (record.antecedent ? [record.antecedent] : [])
  : ["name", "question"].includes(record.kind) ? record.mentionIds : [record.mentionId];

/** Reference-graph invariants for one persisted record (raw durable graph + private snapshot). */
function assertGraphInvariants(record: Rec, label: string) {
  const graph = record.queueState.privateState.graph;
  assert.ok(graph, label + ": memory ON keeps a raw graph in durable state");
  // Restore equality: the persisted snapshot is exactly what the durable graph yields (checkGraph runs inside).
  assert.deepEqual(snapshotReferenceGraph(graph), record.referenceGraph, label + ": snapshot/durable graph mismatch");
  const committed = record.judgments.length;
  assert.equal(graph.revision, committed, label + ": one revision per committed AI turn");
  const answered = record.judgments.at(-1)?.turnIndex ?? 0;
  assert.equal(graph.lastTurn, answered, label + ": lastTurn is the latest answered human event");
  const events = new Map(record.events.map((event: Rec) => [event.seq, event]));
  const byId = new Map(graph.records.map((r: Rec) => [r.id, r]));
  for (const r of graph.records) {
    for (const id of deps(r)) assert.equal((byId.get(id) as Rec | undefined)?.kind, "mention", label + ": dangling provenance " + r.id + " -> " + id);
    if (r.kind === "mention") {
      const event = events.get(r.sourceTurn) as Rec | undefined;
      assert.ok(event && event.speaker === r.speaker && event.text.includes(r.quote), label + ": mention " + r.id + " not quoted from a public event");
      assert.ok(event.origin !== "scripted_opening", label + ": the scripted opening is never referential evidence");
      assert.ok(r.sourceTurn <= r.turn && r.turn <= answered, label + ": no future provenance");
      assert.equal(r.confidence, CONFIDENCE[r.epistemic], label + ": confidence is the fixed epistemic code, not P(correct)");
      assert.equal(r.slots.length === 0, r.epistemic === "unresolved", label + ": unresolved iff no candidate slot");
      if (r.epistemic === "grounded") assert.equal(r.slots.length, 1);
      if (BARE.test(r.quote)) assert.notEqual(r.epistemic, "grounded", label + ": a bare acknowledgment never grounds");
    }
    if (r.kind === "name" && r.agreement === "explicit") {
      assert.ok(r.mentionIds.some((id: string) => { const m = byId.get(id) as Rec;
        return m.speaker === "human" && m.intent === "name_acceptance" && m.epistemic === "grounded" && m.slots[0] === r.slot; }),
      label + ": explicit agreement needs a grounded human acceptance on the same own slot");
    }
  }
  const retracted = new Set(graph.records.filter((r: Rec) => r.kind === "retract").map((r: Rec) => r.targetId));
  for (const m of record.referenceGraph.mentions) assert.ok(!retracted.has(m.id), label + ": retracted mention still active");
  for (const [slot, view] of Object.entries(record.referenceGraph.ownSlots) as [string, Rec][]) {
    assert.ok(ids.includes(slot), label + ": graph keys are the AI's own ids only");
    assert.equal(view.status === "agreed", view.candidate?.agreement === "explicit", label + ": agreed iff explicit agreement");
    for (const feature of view.features) assert.ok(!retracted.has(feature.id) && !retracted.has(feature.mentionId));
  }
  const raw = JSON.stringify(graph);
  for (const id of humanIds) assert.ok(!raw.includes(id), label + ": partner ids never enter memory");
  assert.ok(!LABEL.test(JSON.stringify(record.referenceGraph)), label + ": no key/annotation-shaped tokens in memory");
}

test("memory ON: agree, deny, repair, defer, revisit and re-agree keep a consistent graph after every turn", async () => {
  const { perTurn } = await runScript(SCRIPT);
  let previous: Rec | null = null;
  for (const [index, record] of perTurn.entries()) {
    assertGraphInvariants(record, "turn " + index);
    const memory = record.judgments.at(-1).memory;
    assert.equal(memory.rejected, null, "turn " + index + ": every scripted interpretation is admissible");
    assert.equal(record.judgments.at(-1).validation.fallback, false);
    // Records are immutable attributed reports: a record kept across turns never changes.
    if (previous) {
      const before = new Map(previous.queueState.privateState.graph.records.map((r: Rec) => [r.id, r]));
      for (const r of record.queueState.privateState.graph.records) if (before.has(r.id)) assert.deepEqual(r, before.get(r.id));
    }
    previous = record;
  }
  const slotsAt = (i: number) => perTurn[i].referenceGraph.ownSlots;
  // Proposal is tentative/none; only the human's literal acceptance agrees.
  assert.deepEqual([slotsAt(0)[A].status, slotsAt(0)[A].candidate.agreement], ["tentative", "none"]);
  assert.deepEqual([slotsAt(1)[A].status, slotsAt(1)[A].candidate.agreement, slotsAt(1)[A].candidate.replaces ?? null], ["agreed", "explicit", null]);
  assert.deepEqual(perTurn[1].ownLedger[A], { status: "agreed", name: "鳥" });
  // A hypothesis over two own slots never becomes a single grounded target.
  const hyp = perTurn[2].referenceGraph.mentions.find((m: Rec) => m.sourceTurn === perTurn[2].judgments.at(-1).turnIndex);
  assert.deepEqual([hyp.epistemic, hyp.slots], ["hypothesis", [B, C]]);
  // Denial: the denied feature is recorded with denied polarity; the ledger repair releases B.
  const denied = slotsAt(3)[B].features;
  assert.deepEqual(denied.map((f: Rec) => [f.feature, f.polarity, f.speaker]), [["とがった先", "denied", "human"]]);
  assert.deepEqual(perTurn[3].ownLedger[B], { status: "unassigned", name: null });
  // Defer, a bare acknowledgment, then revisit.
  assert.equal(slotsAt(4)[C].status, "deferred");
  const bare = perTurn[5].referenceGraph.mentions.at(-1);
  assert.deepEqual([bare.quote, bare.epistemic, bare.slots], ["はい", "unresolved", []]);
  assert.equal(slotsAt(5)[C].status, "deferred", "an acknowledgment does not move a deferred slot");
  assert.equal(slotsAt(6)[C].status, "unassigned", "revisit without a name leaves the slot open, not agreed");
  assert.deepEqual([slotsAt(7)[C].status, slotsAt(7)[C].candidate.agreement], ["tentative", "none"]);
  assert.deepEqual([slotsAt(8)[C].status, slotsAt(8)[C].candidate.agreement], ["agreed", "explicit"]);
  assert.equal(slotsAt(8)[C].candidate.replaces ?? perTurn[8].referenceGraph.repairs.at(-1).replaces, perTurn[7].referenceGraph.ownSlots[C].candidate.id);
  // A confirmed feature report is not a name and not an agreement.
  assert.deepEqual([slotsAt(9)[D].status, slotsAt(9)[D].features.map((f: Rec) => f.polarity)], ["unassigned", ["confirmed"]]);
  assert.deepEqual(perTurn.at(-1)!.events.filter((e: Rec) => e.speaker === "ai").slice(1).map((e: Rec) => e.text), SCRIPT.map((s) => s.reply));
});

test("memory ON: each judge request carries exactly the pre-turn graph summary, and generation never sees memory", async () => {
  const { requests, perTurn } = await runScript(SCRIPT);
  const judges = requests.filter((r) => r.phase === "judgment");
  assert.equal(judges.length, SCRIPT.length);
  for (const [index, request] of judges.entries()) {
    const graphBefore = index === 0 ? null : perTurn[index - 1].queueState.privateState.graph;
    const summary = request.messages.find((m) => typeof m.content === "string" && m.content.startsWith(MEMORY_SUMMARY_PREFIX))!;
    const payload = JSON.parse((summary.content as string).slice((summary.content as string).indexOf("\n") + 1));
    if (graphBefore) assert.deepEqual(payload.ownReferences, JSON.parse(summarizeForJudge(graphBefore)));
    else assert.equal(payload.ownReferences.revision, 0);
    assert.equal(payload.currentTurn, perTurn[index].judgments.at(-1).turnIndex);
    assert.ok(payload.publicTurns.every((t: Rec) => Object.keys(t).join() === "turn,speaker"), "provenance numbers only, no repeated text");
    assert.equal(request.messages.filter((m) => m.content === MEMORY_INSTRUCTIONS).length, 1);
  }
  for (const request of requests.filter((r) => r.phase === "generation")) {
    assert.ok(!request.messages.some(isMemoryMessage), "generation input never includes memory");
    assert.ok(!requestText(request).includes("ownReferences"));
  }
});

test("memory OFF regression: identical public behaviour and byte-identical requests apart from the three memory messages", async () => {
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const on = await runScript(SCRIPT, { referenceMemory: true, strategy });
    const off = await runScript(SCRIPT, { referenceMemory: false, strategy });
    const publicView = (r: Rec) => r.events.map(({ seq, speaker, text }: Rec) => ({ seq, speaker, text }));
    assert.deepEqual(publicView(on.perTurn.at(-1)!), publicView(off.perTurn.at(-1)!));
    assert.deepEqual(on.perTurn.map((r) => r.ownLedger), off.perTurn.map((r) => r.ownLedger));
    assert.deepEqual(on.task.getState(), { ...off.task.getState(), sessionId: on.task.getState().sessionId });
    assert.equal(on.requests.length, off.requests.length);
    for (const [index, request] of on.requests.entries()) {
      const other = off.requests[index];
      assert.equal(request.phase, other.phase);
      assert.deepEqual(stableOptions(request.options), stableOptions(other.options));
      assertSameBudget(request.options, other.options, JUDGE_TIME_BUDGET_MS);
      const stripped = request.messages.filter((m) => !isMemoryMessage(m));
      assert.equal(JSON.stringify(stripped), JSON.stringify(other.messages), strategy + " request " + index + " differs beyond memory");
      // MEMORY_INSTRUCTIONS, the v2-only name-intent message and the graph summary.
      if (request.phase === "judgment") assert.equal(request.messages.length - stripped.length, 3);
      else assert.equal(stripped.length, request.messages.length);
    }
    const offRecord = off.perTurn.at(-1)!;
    assert.equal(Object.hasOwn(offRecord, "referenceGraph"), false);
    assert.equal(offRecord.queueState.privateState.graph, null);
    assert.ok(offRecord.judgments.every((j: Rec) => !Object.hasOwn(j, "memory")));
    assert.ok(off.requests.every((r) => !requestText(r).includes("参照メモ")));
  }
});

test("memory ON: both strategies build the identical graph from identical acts", async () => {
  const first = await runScript(SCRIPT, { strategy: "repair-first" });
  const second = await runScript(SCRIPT, { strategy: "bypass-enabled" });
  assert.deepEqual(first.perTurn.map((r) => r.queueState.privateState.graph), second.perTurn.map((r) => r.queueState.privateState.graph));
  const instructions = (requests: Request[]) => requests.filter((r) => r.phase === "judgment").map((r) => r.messages.filter(isMemoryMessage).map((m) => m.content));
  assert.deepEqual(instructions(first.requests), instructions(second.requests));
});

test("memory ON: restoring from the persisted record mid-dialogue continues to the same graph, ledger and replies", async () => {
  const reference = await runScript(SCRIPT);
  for (const cut of [2, 4, 6]) {
    const first = await createScriptedTrial({ steps: SCRIPT, referenceMemory: true });
    for (let i = 0; i < cut; i++) await first.say(i);
    const saved = structuredClone(first.records.at(-1)!);
    // Persisted records travel as JSON (DO storage / file); the graph must survive that, not just structuredClone.
    const restoredRecord = JSON.parse(JSON.stringify(saved));
    const second = await createScriptedTrial({ steps: SCRIPT, referenceMemory: true, restore: restoredRecord });
    assert.deepEqual(second.task.researcherView().privateState, saved.queueState.privateState, "cut " + cut + ": restored private state");
    assert.deepEqual(second.records.at(-1)!.referenceGraph, saved.referenceGraph);
    assert.equal(second.requests.length, 0, "an idle restore makes no model request");
    for (let i = cut; i < SCRIPT.length; i++) assertGraphInvariants(await second.say(i), "cut " + cut + " turn " + i);
    const done = second.records.at(-1)!, expected = reference.perTurn.at(-1)!;
    assert.deepEqual(done.queueState.privateState.graph, expected.queueState.privateState.graph, "cut " + cut + ": graph");
    assert.deepEqual(done.ownLedger, expected.ownLedger);
    assert.deepEqual(done.events.map((e: Rec) => [e.seq, e.speaker, e.text]), expected.events.map((e: Rec) => [e.seq, e.speaker, e.text]));
    assert.equal(done.recordId, saved.recordId);
    // The judge after restore sees the same memory summary as an uninterrupted run.
    const summaries = (requests: Request[]) => requests.filter((r) => r.phase === "judgment")
      .map((r) => r.messages.find((m) => typeof m.content === "string" && m.content.startsWith(MEMORY_SUMMARY_PREFIX))!.content);
    assert.deepEqual(summaries(second.requests), summaries(reference.requests).slice(cut));
  }
});

test("memory ON: a judge timeout or upstream error falls back without a memory write and the dialogue continues", async () => {
  for (const judgeReplies of [[{ error: "timeout" }], [{ error: "upstream_error" }], ["not json", { error: "timeout" }]]) {
    const steps = SCRIPT.map((step, i) => i === 2 ? { ...step, judgeReplies } : step);
    const { perTurn, requests, task } = await runScript(steps);
    const failed = perTurn[2], trace = failed.judgments.at(-1);
    assert.equal(trace.validation.fallback, true);
    assert.equal(trace.validation.memoryFallback, false);
    assert.deepEqual(trace.memory, { opsApplied: 0, rejected: null, interpretation: false });
    assert.equal(trace.judgment.action, "accept");
    assert.equal(failed.events.at(-1).text, SCRIPT[2].reply, "the participant still gets a reply");
    assert.deepEqual(failed.queueState.privateState.graph.records, perTurn[1].queueState.privateState.graph.records, "no memory write");
    assert.equal(failed.queueState.privateState.graph.revision, perTurn[1].queueState.privateState.graph.revision + 1);
    perTurn.forEach((record, i) => assertGraphInvariants(record, "fallback turn " + i));
    assert.equal(task.getState().aiStatus, "idle");
    for (const request of requests.filter((r) => r.phase === "judgment")) assert.ok(request.options.timeoutMs! <= JUDGE_TIME_BUDGET_MS);
  }
});

test("memory ON: an invalid memory interpretation keeps a valid non-agree act (memory fallback) and writes nothing", async () => {
  // Grounded on two slots is structurally impossible; the act itself is valid.
  const invalid = (step: typeof SCRIPT[number]) => ({ ...step,
    judgeReplies: Array(2).fill(JSON.stringify({ ...step.act, reference: { ...step.reference, slots: [A, B], epistemic: "grounded" } })) });
  const proposal = await runScript([invalid(SCRIPT[0])]);
  const kept = proposal.perTurn[0].judgments.at(-1);
  assert.equal(kept.validation.memoryFallback, true);
  assert.equal(kept.judgment.action, "propose_name");
  assert.deepEqual(proposal.perTurn[0].ownLedger[A], { status: "tentative", name: "鳥" });
  assert.equal(proposal.perTurn[0].referenceGraph.ownSlots[A].candidate, null, "nothing is written for the broken interpretation");
  proposal.perTurn.forEach((record, i) => assertGraphInvariants(record, "memory fallback proposal turn " + i));
  // An agree with a broken interpretation cannot be checked against retraction this turn (B3): the existing
  // validation fallback is used instead, so the ledger is not agreed.
  const { perTurn } = await runScript([SCRIPT[0], invalid(SCRIPT[1])]);
  const trace = perTurn[1].judgments.at(-1);
  assert.equal(trace.validation.fallback, true);
  assert.equal(trace.validation.memoryFallback, false);
  assert.equal(trace.judgment.action, "accept");
  assert.deepEqual(perTurn[1].ownLedger[A], { status: "tentative", name: "鳥" });
  assert.equal(perTurn[1].referenceGraph.ownSlots[A].status, "tentative", "the ledger act never fabricates an explicit memory agreement");
  assert.equal(perTurn[1].referenceGraph.ownSlots[A].candidate.agreement, "none");
  perTurn.forEach((record, i) => assertGraphInvariants(record, "memory fallback turn " + i));
});

test("memory ON: generation timeouts retry once; a failed turn commits no memory and a retry commits it exactly once", async () => {
  const once = await runScript(SCRIPT.slice(0, 2).map((step, i) => i === 1 ? { ...step, generationReplies: [{ error: "timeout" }] } : step));
  assert.equal(once.perTurn[1].judgments.at(-1).generationRetried, true);
  assert.equal(once.perTurn[1].queueState.privateState.graph.revision, 2);
  once.perTurn.forEach((record, i) => assertGraphInvariants(record, "retried turn " + i));
  for (const request of once.requests.filter((r) => r.phase === "generation")) assert.equal(request.options.timeoutMs, GENERATION_TIMEOUT_MS);

  const steps = SCRIPT.map((step) => ({ ...step }));
  const harness = await createScriptedTrial({ steps, referenceMemory: true });
  await harness.say(0);
  const before = harness.records.at(-1)!;
  steps[1].generationReplies = [{ error: "timeout" }, { error: "timeout" }];
  const failed = await harness.say(1);
  assert.equal(harness.task.getState().aiStatus, "error");
  assert.deepEqual(failed.queueState.privateState, before.queueState.privateState, "nothing is staged into memory on a failed turn");
  assert.equal(failed.turnTimings.at(-1).errorCode, "timeout");
  const retried = await harness.retry(1);
  assertGraphInvariants(retried, "after retry");
  assert.equal(retried.queueState.privateState.graph.revision, 2);
  const turn = retried.judgments.at(-1).turnIndex;
  assert.equal(retried.queueState.privateState.graph.records.filter((r: Rec) => r.kind === "mention" && r.sourceTurn === turn).length, 1);
  assert.equal(retried.referenceGraph.ownSlots[A].status, "agreed");
  assert.equal(harness.task.getState().aiStatus, "idle");
});

test("leak checks: no partner image, partner ids, answer key or annotation labels in any upstream request; no secrets in records", async () => {
  const steps = SCRIPT.map((step, i) => i === 3 ? { ...step, generationReplies: [{ error: "timeout" }] } : i === 5 ? { ...step, judgeReplies: [{ error: "upstream_error" }] } : step);
  const { requests, records, task } = await runScript(steps);
  await task.submitHuman({ names: Object.fromEntries(humanIds.map((id) => [id, ""])) });
  await task.submitAI();
  assert.ok(requests.length > SCRIPT.length * 2);
  const keyJson = JSON.stringify(trial.key);
  for (const request of requests) {
    const text = requestText(request);
    for (const id of humanIds) assert.ok(!text.includes(id), request.phase + ": partner id leaked");
    assert.ok(!LABEL.test(text), request.phase + ": key/annotation-shaped token " + text.match(LABEL)?.[0]);
    assert.ok(!text.includes(keyJson));
    for (const url of requestImages(request)) assert.equal(url, "data:image/png;base64," + aiPngBase64, "only the AI's own image is sent");
    assert.ok(!JSON.stringify(request.messages).includes(humanPngBase64.slice(0, 2000)), "partner image never sent");
  }
  for (const record of records) {
    const raw = JSON.stringify({ ...record, scoring: null });
    assert.ok(!raw.includes("SYNTHETIC-RAW-PROVIDER-MESSAGE"), "raw provider errors never persist");
    assert.ok(!raw.includes(MEMORY_INSTRUCTIONS.slice(0, 40)), "prompts never persist");
    assert.ok(!raw.includes(aiPngBase64.slice(0, 200)), "image bytes never persist");
    for (const timing of record.turnTimings) assert.ok(timing.errorCode === null || /^[a-z][a-z0-9_]{0,39}$/u.test(timing.errorCode));
  }
  // The participant API carries no memory, own ids or key.
  const state = JSON.stringify(task.getState());
  for (const forbidden of ["referenceGraph", "ownReferences", "ledger", ...ids, keyJson]) assert.ok(!state.includes(forbidden), forbidden);
});

test("structural guard: online runtime modules never import annotation, evaluation or private sources", async () => {
  const root = join(import.meta.dirname, "..", "dialogue-model", "runtime");
  const forbidden = /(?:annotation|private-runs|private-sources|jev-grounding|historical|gold|\.xlsx)/iu;
  const files: string[] = [];
  for (const dir of ["judgment", "memory", "v2", "grounding", "web"]) {
    const entries = await readdir(join(root, dir)).catch(() => []);
    for (const entry of entries) if (/\.(mjs|ts)$/u.test(entry)) files.push(join(root, dir, entry));
  }
  files.push(join(root, "client.mjs"), join(root, "decisions-client.mjs"));
  assert.ok(files.length > 10);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const [, specifier] of source.matchAll(/(?:import|from|import\()\s*["']([^"']+)["']/gu)) {
      assert.ok(!forbidden.test(specifier), file + " imports " + specifier);
    }
  }
});
