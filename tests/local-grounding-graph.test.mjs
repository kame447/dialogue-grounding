// Synthetic utterances only; no participant data or live model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { SLOTS } from "../dialogue-model/runtime/stimuli/board.mjs";
import { createReferenceGraph, applyReferenceUpdate, previewReferenceUpdate, snapshotReferenceGraph, summarizeForJudge, REFERENCE_LIMITS } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { deriveLocalIssues } from "../dialogue-model/runtime/local-grounding/derive.ts";

const [A, B] = SLOTS;
const claim = (turn, extra = {}) => ({ kind: "claim", id: `${turn}:c`, issueId: `${turn}:c`, targets: [A], aspect: "part", act: "assert",
  proposition: "四角がある", name: null, speaker: "human", sourceTurn: turn, quote: "四角がある", respondsTo: null, source: "partner_statement", ...extra });
function apply(graph, turn, operations) {
  const turns = new Map();
  for (const op of operations.filter(r => ["claim", "mention"].includes(r.kind))) {
    const key = `${op.sourceTurn}:${op.speaker}`;
    turns.set(key, { turn: op.sourceTurn, speaker: op.speaker, text: (turns.get(key)?.text ?? "") + op.quote });
  }
  return applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations }, { generationSucceeded: true, publicTurns: [...turns.values()] });
}
const rejected = (fn, code) => assert.throws(fn, error => error.code === code);

test("claim snapshots and JSON restores are detached while claimless shapes stay byte identical", () => {
  const initial = createReferenceGraph();
  assert.equal(Object.hasOwn(snapshotReferenceGraph(initial), "claims"), false);
  const before = JSON.stringify(initial), summary = summarizeForJudge(initial);
  const graph = apply(initial, 1, [claim(1)]);
  const restored = JSON.parse(JSON.stringify(graph));
  assert.deepEqual(snapshotReferenceGraph(restored), snapshotReferenceGraph(graph));
  assert.equal(summarizeForJudge(restored), summarizeForJudge(graph));
  const copy = snapshotReferenceGraph(graph); copy.claims[0].targets[0] = B;
  assert.deepEqual(graph.records[0].targets, [A]);
  assert.equal(JSON.stringify(initial), before); assert.equal(summarizeForJudge(initial), summary);
});

test("claim fields reject extras, open-set values, foreign slots and forged references", () => {
  const invalid = [
    { aspect: "whole" }, { act: "unknown" }, { source: "gold" }, { targets: [A, A] }, { targets: ["foreign"] },
    { quote: "x".repeat(161) }, { proposition: "x".repeat(161) }, { name: "船" }, { issueId: "free" },
    { sourceTurn: 2 }, { privateLabel: "hidden" },
  ];
  for (const extra of invalid) assert.throws(() => apply(createReferenceGraph(), 1, [claim(1, extra)]));
  rejected(() => apply(createReferenceGraph(), 1, [claim(1, { respondsTo: "1:missing" })]), "missing_provenance");
  rejected(() => apply(createReferenceGraph(), 1, [claim(1, { act: "agree" })]), "missing_claim_response");
  rejected(() => apply(createReferenceGraph(), 1, [claim(1, { aspect: "name", act: "name_propose", name: "船" })]), "unsupported_claim_name");
});

test("claim respondsTo supports forward same-transaction claims and rejects cycles", () => {
  const proposal = claim(2, { id: "2:p", issueId: "2:p", sourceTurn: 1, speaker: "ai", source: "ai_hypothesis" });
  const response = claim(2, { act: "agree", issueId: "2:p", respondsTo: "2:p" });
  const graph = apply(createReferenceGraph(), 2, [response, proposal]);
  assert.equal(snapshotReferenceGraph(graph).claims.length, 2);
  rejected(() => apply(createReferenceGraph(), 2, [response, { ...proposal, respondsTo: response.id }]), "inconsistent_claim_response");
});

test("retract invalidates claim dependents without transferring them to another slot", () => {
  let graph = apply(createReferenceGraph(), 1, [claim(1, { speaker: "ai", source: "ai_hypothesis" })]);
  graph = apply(graph, 2, [claim(2, { act: "agree", issueId: "1:c", respondsTo: "1:c" })]);
  const mention = { kind: "mention", id: "3:m", sourceTurn: 3, speaker: "human", quote: "先の説明を訂正します", slots: [B], confidence: 0.5,
    epistemic: "hypothesis", intent: "correction", antecedent: null };
  graph = apply(graph, 3, [mention, { kind: "retract", id: "3:r", targetId: "1:c", mentionId: "3:m", reason: "参照の訂正" }]);
  assert.deepEqual(snapshotReferenceGraph(graph).claims, []);
  assert.ok(snapshotReferenceGraph(graph).ownSlots[B].candidate === null);
});

test("resolved claim history is pruned deterministically but unresolved and deferred issues stay pinned", () => {
  let graph = apply(createReferenceGraph(), 1, [claim(1, { speaker: "ai", source: "ai_hypothesis" })]);
  graph = apply(graph, 2, [claim(2, { act: "defer", issueId: "1:c" })]);
  for (let turn = 3; turn < 75; turn++) graph = apply(graph, turn, [
    claim(turn, { speaker: "ai", source: "ai_hypothesis" }), claim(turn, { id: `${turn}:a`, issueId: `${turn}:c`, act: "agree", respondsTo: `${turn}:c` }),
  ]);
  assert.ok(graph.records.some(r => r.id === "1:c")); assert.ok(graph.records.some(r => r.id === "2:c"));
  assert.ok(!graph.records.some(r => r.id === "3:c"));
  assert.ok(graph.records.length <= REFERENCE_LIMITS.records);
  assert.deepEqual(snapshotReferenceGraph(JSON.parse(JSON.stringify(graph))), snapshotReferenceGraph(graph));
});

test("pinned unresolved overflow rejects the WHOLE update without changing its input", () => {
  let graph = createReferenceGraph();
  let overflow = false;
  for (let turn = 1; turn <= REFERENCE_LIMITS.records + 1; turn++) {
    const before = JSON.stringify(graph);
    try { graph = apply(graph, turn, [claim(turn, { speaker: "ai", source: "ai_hypothesis", proposition: "長い特徴".repeat(30), quote: "長い特徴".repeat(30) })]); }
    catch (error) { assert.equal(error.code, "capacity_exceeded"); assert.equal(JSON.stringify(graph), before); overflow = true; break; }
  }
  assert.ok(overflow);
});

test("preview prunes a full graph, supports derive and never mutates or commits its input", () => {
  const initial = createReferenceGraph();
  // A valid JSON restore may contain 160 settled independent reports. A new
  // optional report must be pruned before the preview can be consumed.
  const graph = { ...initial, revision: 80, lastTurn: 80,
    records: Array.from({ length: 80 }, (_, i) => [
      { ...claim(i + 1, { speaker: "ai", source: "ai_hypothesis" }), turn: i + 1 },
      { ...claim(i + 1, { id: `${i + 1}:a`, issueId: `${i + 1}:c`, act: "agree", respondsTo: `${i + 1}:c` }), turn: i + 1 },
    ]).flat() };
  snapshotReferenceGraph(graph);
  const before = JSON.stringify(graph), op = claim(81, { act: "acknowledge" });
  const options = { publicTurns: [{ turn: 81, speaker: "human", text: op.quote }] };
  const update = { expectedRevision: graph.revision, turn: 81, operations: [op] };
  const preview = previewReferenceUpdate(graph, update, options);
  assert.ok(preview.records.length <= 160); assert.ok(deriveLocalIssues(preview).length > 0);
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(preview, applyReferenceUpdate(graph, update, { ...options, generationSucceeded: true }));
  rejected(() => applyReferenceUpdate(graph, update, options), "generation_not_succeeded");
});
