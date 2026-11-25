// Historical name-state scene tooling on an invented dialogue (no real data).
import test from "node:test";
import assert from "node:assert/strict";
import type { HistoricalRow } from "../dialogue-model/runtime/jev-grounding/labels.ts";
import { labelRows } from "../dialogue-model/runtime/jev-grounding/labels.ts";
import type { NameScene } from "../dialogue-model/runtime/jev-grounding/name-scenes.ts";
import { compareScenes, proxies, validateScene } from "../dialogue-model/runtime/jev-grounding/name-scenes.ts";

function row(no: number, speaker: string, labels: Partial<HistoricalRow> = {}): HistoricalRow {
  return { dialogue: 9, utteranceNo: String(no), speaker, text: "（架空）", ...labels };
}

// Episode 0: impression only, then an explicit proposal and its adoption (ER1).
// Episode 1: impression, denial, closed with ER0.
const ROWS: HistoricalRow[] = [
  row(1, "A", { episode: "E0 start", misalignmentState: "M0", AHLabel: "Holistic", speechFunctions: "a16（不確か）" }),
  row(2, "B", { speechFunctions: "a11（同意）", AHLabel: "Ack holistic" }),
  row(3, "A", { speechFunctions: "a8（短い質問）" }),
  row(4, "B", { episode: "E0 end", speechFunctions: "a11（同意）", episodeResult: "ER1" }),
  row(5, "A", { episode: "E1 start", misalignmentState: "M0", AHLabel: "Holistic" }),
  row(6, "B", { speechFunctions: "a12（非同意）", AHLabel: "Deny holistic", misalignmentState: "M2" }),
  row(7, "A", { episode: "E1 end", episodeResult: "ER0" }),
];

function scene(no: number, state: NameScene["state"], extra: Partial<NameScene> = {}): NameScene {
  return { dialogueKey: "H9", xlsxRow: no + 1, utteranceNo: String(no), state, confidence: "high", proposer: "-", borderline: false, reviewer: "test", reviewVersion: "v2", ...extra };
}

test("scene validation", () => {
  assert.deepEqual(validateScene(scene(1, "no_name")), []);
  assert.ok(validateScene({ ...scene(1, "no_name"), state: "unknown" }).includes("state"));
  assert.ok(validateScene({ ...scene(1, "no_name"), dialogueKey: "AI1" }).includes("dialogueKey"));
  assert.ok(validateScene({ ...scene(1, "no_name"), confidence: "sure" }).includes("confidence"));
  assert.deepEqual(validateScene(null), ["scene is not an object"]);
});

test("label proxies use only rows up to the scene and never read an impression as agreement", () => {
  const rows = labelRows(ROWS).get("H9") ?? [];
  const e0 = rows.filter((r) => r.episode === 0);
  const e1 = rows.filter((r) => r.episode === 1);
  assert.deepEqual(proxies(e0, 0), { erOnly: null, impressionAsProposal: "unclear", agreementTag: null });
  assert.equal(proxies(e0, 1).agreementTag, "agreed", "a11 + Ack holistic is what agreementTag reads");
  assert.deepEqual(proxies(e0, 3), { erOnly: "agreed", impressionAsProposal: "agreed", agreementTag: null });
  assert.equal(proxies(e1, 1).impressionAsProposal, "not_agreed");
  assert.equal(proxies(e1, 2).erOnly, null, "ER0 is ambiguous");
  // Truncating later rows does not change an earlier proxy.
  assert.deepEqual(proxies(e0.slice(0, 2), 1), proxies(e0, 1));
});

test("comparison: impression-only scenes expose the impression proxy; ER and a11 tallies", () => {
  const rows = labelRows(ROWS);
  const scenes = [
    scene(1, "no_name"), scene(2, "no_name", { confidence: "medium" }), scene(3, "unclear", { proposer: "A" }),
    scene(4, "agreed"), scene(6, "no_name", { borderline: true, confidence: "low" }), scene(7, "no_name"),
  ];
  const c = compareScenes(scenes, rows, () => "holdout");
  assert.equal(c.scenes, 6);
  assert.deepEqual(c.byState, { no_name: 4, unclear: 1, agreed: 1 });
  assert.equal(c.borderline, 1);
  assert.deepEqual(c.bySplit, { holdout: { no_name: 4, unclear: 1, agreed: 1 } });
  assert.equal(c.proxies.impressionAsProposal.confusion.no_name.unclear, 2);
  assert.equal(c.proxies.impressionAsProposal.confusion.no_name.not_agreed, 2);
  assert.equal(c.proxies.erOnly.missingPrediction, 5);
  assert.equal(c.proxies.erOnly.accuracy, 1);
  assert.deepEqual(c.a11ByState, { no_name: 1, agreed: 1 });
  assert.deepEqual(c.episodeEndByER, { ER1: { agreed: 1 }, ER0: { no_name: 1 } });
  assert.equal(c.er1NotAgreed, 0);
  const strict = compareScenes(scenes, rows, () => "holdout", { minConfidence: "high", excludeBorderline: true });
  assert.equal(strict.scenes, 4);
  assert.throws(() => compareScenes([scene(99, "no_name")], rows, () => "dev"), /not found/);
});
