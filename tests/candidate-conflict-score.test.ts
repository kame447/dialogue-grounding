// Synthetic key and annotation only; researcher-side scorer arithmetic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { goldReferentsInAiSpace, scoreFeatureSplit } from "../dialogue-model/runtime/diagnostics/candidate-conflict-score.ts";

const ids = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
const key = { human: { "h-1": "F1", "h-2": "F2", "h-3": "F3", "h-4": "F4", "h-5": "F5", "h-6": "F6" },
  ai: { "s-0001": "F2", "s-0002": "F1", "s-0003": "F3", "s-0004": "F4", "s-0005": "F5", "s-0006": "F6" } };
const annotation = { schema: "gold-referent/v1", source: "synthetic-test", turns: [{ turn: 1, goldHumanId: "h-1" }, { turn: 3, goldHumanId: null }] };
const conflict = { candidates: [{ id: "s-0001", feature: "a" }, { id: "s-0002", feature: "b" }], featureFits: ["s-0001"] };

test("gold referents map partner figures into the AI's id space through the key", () => {
  const gold = goldReferentsInAiSpace(annotation, key);
  assert.deepEqual(gold.get(1), { provenance: "gold_annotation", source: "synthetic-test", turn: 1, aiId: "s-0002" });
  assert.equal(gold.get(3)?.aiId, null);
  for (const bad of [{ ...annotation, schema: "x" }, { ...annotation, turns: [{ turn: 1, goldHumanId: "s-0001" }] },
    { ...annotation, turns: [{ turn: 1, goldHumanId: "h-1" }, { turn: 1, goldHumanId: "h-2" }] }]) {
    assert.throws(() => goldReferentsInAiSpace(bad, key), /invalid_gold_annotation/);
  }
  assert.throws(() => goldReferentsInAiSpace(annotation, { human: key.human, ai: { a: "F1", b: "F1" } }), /invalid_key/);
});

test("scoring needs annotation-provenance gold, not the AI's own choice", () => {
  const gold = goldReferentsInAiSpace(annotation, key).get(1)!;
  // The AI chose s-0001; gold is s-0002. A feature fitting both does not separate them.
  assert.deepEqual(scoreFeatureSplit({ scorerFits: ["s-0001", "s-0002"], scoredIds: ids, targetSlot: "s-0001", gold, conflict }), {
    fitCount: 2, fitsTarget: true, fitsGold: true, separatesTargetFromGold: false, goldInCandidates: true, splitsCandidates: false, claimMatchesScorer: false });
  assert.deepEqual(scoreFeatureSplit({ scorerFits: ["s-0001"], scoredIds: ids, targetSlot: "s-0001", gold, conflict }), {
    fitCount: 1, fitsTarget: true, fitsGold: false, separatesTargetFromGold: true, goldInCandidates: true, splitsCandidates: true, claimMatchesScorer: true });
  const none = scoreFeatureSplit({ scorerFits: ["s-0003"], scoredIds: ids, targetSlot: "s-0003", gold: null });
  assert.equal(none.fitsGold, null); assert.equal(none.separatesTargetFromGold, null); assert.equal(none.goldInCandidates, null);
  assert.throws(() => scoreFeatureSplit({ scorerFits: [], scoredIds: ids, targetSlot: "s-0001",
    gold: { provenance: "gold_annotation", source: "x", turn: 1, aiId: "s-0001" } }), /annotation/);
  assert.throws(() => scoreFeatureSplit({ scorerFits: ["x"], scoredIds: ids, targetSlot: null, gold: null }), /outside/);
});

test("runtime modules never import the key-consuming scorer", () => {
  const roots = ["dialogue-model/runtime/v2", "dialogue-model/runtime/judgment", "dialogue-model/runtime/web"];
  for (const root of roots) for (const name of readdirSync(root)) {
    if (!/\.(mjs|ts)$/.test(name)) continue;
    assert.ok(!readFileSync(`${root}/${name}`, "utf8").includes("candidate-conflict-score"), `${root}/${name}`);
  }
});
