// Old-memory fix: a revisit and a name in the same human turn. Synthetic text only.
import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceGraph, applyReferenceUpdate as applyJs, snapshotReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { prepareMemory as prepareMemoryJs } from "../dialogue-model/runtime/judgment/memory.mjs";

// The .mjs defaults make its inferred parameter types too narrow for explicit arguments.
const prepareMemory = prepareMemoryJs as (graph: unknown, turn: number, interpretation: unknown, publicTurns: unknown) => any;
const applyReferenceUpdate = applyJs as (graph: unknown, update: unknown, options: unknown) => any;

const ids = ["s-0a01", "s-0a02", "s-0a03", "s-0a04", "s-0a05", "s-0a06"];
const [X, Y] = ids;
const interpretation = (extra: Record<string, unknown>) => ({ slots: [X], epistemic: "hypothesis", intent: "refer",
  feature: null, nameAcceptance: null, deferSlot: null, revisitSlot: null, ...extra });
const turns: { turn: number; speaker: "human" | "ai"; text: string }[] = [];
function step(graph: any, turn: number, text: string, extra: Record<string, unknown>) {
  turns.push({ turn, speaker: "human", text });
  const staged = prepareMemory(graph, turn, interpretation(extra), turns);
  const next = applyReferenceUpdate(graph, staged.update, { publicTurns: turns, generationSucceeded: true });
  turns.push({ turn: turn + 1, speaker: "ai", text: "合成の応答です。" });
  return { graph: next, staged };
}

test("a revisit with a same-turn name keeps the revisit record (was memory_not_deferred)", () => {
  turns.length = 0;
  let graph = createReferenceGraph({ slots: ids });
  ({ graph } = step(graph, 2, "波みたいなのがあります", { intent: "name_proposal", nameAcceptance: { slot: X, name: "波" } }));
  ({ graph } = step(graph, 4, "それはあとにしましょう", { deferSlot: X }));
  assert.equal(snapshotReferenceGraph(graph).ownSlots[X].status, "deferred");
  const { graph: after, staged } = step(graph, 6, "さっきの波に戻りましょう", { intent: "name_proposal",
    nameAcceptance: { slot: X, name: "波" }, revisitSlot: X });
  assert.equal(staged.rejected, null);
  assert.deepEqual(staged.update.operations.map((op: { id: string }) => op.id), ["6:human", "6:revisit", "6:name"]);
  const view = snapshotReferenceGraph(after).ownSlots[X];
  assert.deepEqual([view.status, view.candidate.name, view.candidate.agreement], ["tentative", "波", "none"]);
});

test("defer with a same-turn name, and defer+revisit together, keep the previous order", () => {
  turns.length = 0;
  let graph = createReferenceGraph({ slots: ids });
  const { graph: deferred, staged } = step(graph, 2, "波はあとにしましょう", { intent: "name_proposal",
    nameAcceptance: { slot: X, name: "波" }, deferSlot: X });
  assert.deepEqual(staged.update.operations.map((op: { id: string }) => op.id), ["2:human", "2:name", "2:defer"]);
  assert.equal(snapshotReferenceGraph(deferred).ownSlots[X].status, "deferred");
  graph = deferred;
  const both = step(graph, 4, "こっちは保留して、さっきのに戻ります", { slots: [X, Y], deferSlot: Y, revisitSlot: X });
  assert.deepEqual(both.staged.update.operations.map((op: { id: string }) => op.id), ["4:human", "4:defer", "4:revisit"]);
  assert.equal(both.staged.rejected, null);
});
