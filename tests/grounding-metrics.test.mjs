import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialogueMetrics, outcomeMetrics, aggregate, conditionOf, loadRecords, main } from "../dialogue-model/runtime/diagnostics/grounding-metrics.mjs";

const SECRET_TEXT = "ひみつの発話テキスト";
const act = (action, targetSlot, extra = {}) => ({ action, targetSlot, candidateName: null, discriminatingFeature: null, note: null, ...extra });
const turn = (turnIndex, judgment, status = "committed", validation = { attempts: 1, fallback: false, failures: [] }) =>
  ({ turnIndex, judgment, status, validation, ownLedgerBefore: {}, ownLedgerAfter: {} });

function record(overrides = {}) {
  return {
    recordId: "r", trialId: "t", seed: 9, strategy: "repair-first", status: "completed",
    publicHistory: [
      { role: "user", content: "あ" + SECRET_TEXT }, { role: "assistant", content: "はい、そうです" },
      { role: "user", content: "どれ？" }, { role: "assistant", content: "細長い形です" },
      { role: "user", content: "はい" }, { role: "assistant", content: "では保留しましょう" },
    ],
    judgments: [
      turn(1, act("confirm", "上段左")),
      turn(2, act("confirm", "上段左")),
      turn(3, act("defer", "上段左", { followUp: act("propose_name", "下段右", { candidateName: "船" }) })),
      turn(4, act("revisit", "上段左")),
      turn(5, act("agree", "上段左"), "judge_error", { attempts: 2, fallback: true, failures: ["invalid_json"] }),
    ],
    ownLedger: { 上段左: { status: "agreed", name: "鳥" }, 下段右: { status: "tentative", name: "船" } },
    aiSubmission: { 上段左: "鳥", 下段右: "魚" },
    scoring: { key: { human: { 上段左: "F1" }, ai: { 上段左: "F2" } }, result: { matchedCount: 4, total: 6, success: false, figures: [] } },
    ...overrides,
  };
}

test("dialogue metrics count typed acts, cycles, switches and defer/revisit without reading scoring", () => {
  const base = record();
  const withoutScoring = { ...base, scoring: undefined, status: "dialogue" };
  const metrics = dialogueMetrics(base);
  assert.deepEqual(dialogueMetrics(withoutScoring), metrics);
  assert.equal(metrics.utterances.human.count, 3);
  assert.equal(metrics.utterances.ai.count, 3);
  assert.equal(metrics.utterances.speakerRunPairs, 3);
  assert.equal(metrics.actionCounts.confirm, 2);
  assert.equal(metrics.actionCounts.propose_name, 1);
  assert.equal(metrics.actionCounts.agree, 0, "failed turns are not counted as acts");
  assert.equal(metrics.confirmCycles, 1);
  assert.equal(metrics.longestConfirmRun, 2);
  assert.equal(metrics.contextSwitches, 2);
  assert.equal(metrics.revisitedAfterDefer, 1);
  assert.equal(metrics.unresolvedDeferAtEnd, 0);
  assert.equal(metrics.failedTurns, 1);
  assert.equal(metrics.judgeFallbacks, 1);
  assert.equal(metrics.ledgerFinalMismatch, 1);
  assert.equal(metrics.referenceAmbiguity, null);
});

test("outcome is read only for completed trials", () => {
  assert.deepEqual(outcomeMetrics(record()), { matchedCount: 4, total: 6, success: false });
  assert.equal(outcomeMetrics(record({ status: "dialogue" })), null);
  assert.equal(outcomeMetrics(record({ scoring: null })), null);
});

test("reference ambiguity is summarized from a graph snapshot", () => {
  const referenceGraph = { records: [
    { kind: "mention", speaker: "human", epistemic: "unresolved", slots: [] },
    { kind: "mention", speaker: "human", epistemic: "hypothesis", slots: ["上段左", "上段中"] },
    { kind: "mention", speaker: "human", epistemic: "grounded", slots: ["上段左"] },
    { kind: "mention", speaker: "ai", epistemic: "grounded", slots: ["上段左"] },
    { kind: "question", status: "open" },
  ] };
  assert.deepEqual(dialogueMetrics(record({ referenceGraph })).referenceAmbiguity,
    { humanMentions: 3, unresolved: 1, multiCandidate: 1, grounded: 1, openQuestions: 1 });
});

test("aggregation keeps every strategy and toggle condition separate", () => {
  const rows = [
    record(), record({ seed: 10 }),
    record({ strategy: "bypass-enabled" }),
    record({ strategy: "bypass-enabled", options: { visualAid: true, referenceMemory: false } }),
  ];
  const result = aggregate(rows);
  assert.deepEqual(Object.keys(result), [
    "bypass-enabled|visualAid=false|referenceMemory=false",
    "bypass-enabled|visualAid=true|referenceMemory=false",
    "repair-first|visualAid=false|referenceMemory=false",
  ]);
  assert.equal(result["repair-first|visualAid=false|referenceMemory=false"].trials, 2);
  assert.deepEqual(result["repair-first|visualAid=false|referenceMemory=false"].seeds, [9, 10]);
  assert.deepEqual(result["repair-first|visualAid=false|referenceMemory=false"].matchedCount.perTrial, [4, 4]);
  assert.equal(conditionOf(record({ options: { visualAid: "yes" } })), "repair-first|visualAid=false|referenceMemory=false");
});

test("CLI prints aggregates only: no utterance text, names, slot keys or figure identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grounding-metrics-"));
  try {
    await writeFile(join(dir, "a.json"), JSON.stringify(record()));
    await writeFile(join(dir, "b.json"), JSON.stringify(record({ strategy: "bypass-enabled" })));
    await writeFile(join(dir, "broken.json"), "{" + SECRET_TEXT);
    await writeFile(join(dir, "notes.txt"), SECRET_TEXT);
    assert.equal((await loadRecords(dir)).length, 2);
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(line);
    try { await main(["--dir", dir]); } finally { console.log = original; }
    const output = lines.join("\n");
    for (const forbidden of [SECRET_TEXT, "鳥", "船", "魚", "上段左", "F1", "F2", "はい"]) assert.ok(!output.includes(forbidden), forbidden);
    assert.equal(JSON.parse(output).records, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
