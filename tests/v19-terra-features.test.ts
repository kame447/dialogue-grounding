import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { VISUAL_FEATURE_GENERATION } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { DEFERRED_AI_EXTRACTION_GENERATION } from "../dialogue-model/runtime/v2/deferred-ai-extraction.ts";
import type { ObservationMemo } from "../dialogue-model/runtime/observation/contract.ts";
import type { LocalOwnAnchor } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { readVisualFeatureDraft, readVisualFeatureEvidence } from "../dialogue-model/runtime/v2/visual-feature-evidence.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";

const [first, second] = OWN.ownAnchors;
const firstSource = { figureId: first.id, path: ["analytic", "relations", 0] };
const commonSource = { figureId: first.id, path: ["analytic", "shapes", 0] };
const outsideSource = { figureId: second.id, path: ["analytic", "shapes", 0] };
const text = "小さい部分が細い台につながって見えますか？";
const human = "片方の図形のつながり方をもう少し確かめたいです。";
const profile = { dialoguePolicy: "holistic_v5", technicalTrial: { version: "adaptive_repair_v3" },
  interventionVersion: "bypass_acceptance_v2", judgmentMaterialVersion: "jev_repair_quality_v1",
  agreeNameScopeVersion: "jev_naming_v1", generationRetryVersion: VISUAL_FEATURE_GENERATION } as const;
const memo = (count: 4 | 6): ObservationMemo => ({
  observedAt: "2000-01-01T00:00:00.000Z",
  figures: OWN.ownAnchors.slice(0, count).map((anchor: LocalOwnAnchor) => ({
    id: anchor.id, region: anchor.bbox, holistic: [], unknowns: [], reobservations: [],
    analytic: { shapes: ["三角の部分"], composition: "小さい部分と大きい部分",
      relations: anchor.id === first.id ? ["小さい部分と細い台の接続"] : [] },
  })),
});

for (const generationRetryVersion of [VISUAL_FEATURE_GENERATION, DEFERRED_AI_EXTRACTION_GENERATION] as const)
for (const [count, action] of [[4, "confirm"], [6, "repair"]] as const) {
  test(`${generationRetryVersion} ${count}-figure ${action} independently binds used features in both strategies`, async () => {
    const sources = [{ quote: text, source: firstSource }];
    const draft = (source: typeof firstSource) => JSON.stringify({ text, observationFeatures: [source] });
    const records = await buildRecords({ ...profile, generationRetryVersion, figureCount: count, memo: memo(count), turns: [{ human, plan: {
      action, target: "figure_0",
      drafts: count === 4 ? [draft(commonSource), draft(firstSource)] : [draft(firstSource)],
      aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources } }),
      choose: key => key === "human_move_on_source" ? "other" : key === "visual_purpose" ? "clarify_reference" : undefined,
    } }],
    onTurn(_label, turn) {
      assert.equal(turn.trace.executed.feature, null);
      assert.deepEqual(turn.trace.executed.visualPurpose, { kind: "clarify_reference" });
      assert.deepEqual(turn.trace.generatedPublication?.visualFeatures, { sources });
      assert.equal(turn.speech, text);
      assert.equal(turn.state.repairHistory.at(-1).question, text);
      assert.equal(turn.luna.filter(call => call.phase === "ai_extraction").length, count === 4 ? 2 : 1);
      assert.deepEqual(turn.trace.generationGuard.violations, count === 4 ? ["visual_feature_mismatch"] : []);
    } });
    const checks = verifyRecords(records).checks.filter(check => check.id.startsWith("intervention.trial.0.attempt.0."));
    assert.equal(checks.length, 4);
    for (const check of checks) assert.equal(check.status, "pass", JSON.stringify(check));
  });
}

test("v19 allows an honest unresolved response and preserves the selected target", async () => {
  const unclear = "まだつながり方が分かりません。どの部分を指していますか？";
  await buildRecords({ ...profile, memo: memo(6), turns: [{ human, plan: {
    action: "confirm", target: "figure_0",
    speech: JSON.stringify({ text: unclear, observationFeatures: [] }),
    aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
    choose: key => key === "visual_purpose" ? "unknown" : key === "human_move_on_source" ? "other" : undefined,
  } }],
  onTurn(_label, turn) {
    assert.deepEqual(turn.trace.executed.visualPurpose, { kind: "unknown" });
    assert.deepEqual(turn.trace.executed.target, { kind: "single", figureId: first.id });
    assert.deepEqual(turn.trace.generatedPublication?.visualFeatures, { sources: [] });
    assert.equal(turn.speech, unclear);
  } });
});

test("v19 links the chosen public issue and keeps an existing name through visual repair", async () => {
  const ask = "細い台とのつながり方が違いますか？";
  const before = { status: "agreed", name: "帆" };
  const proposal = "その形を「帆」と呼びましょう。";
  const records = await buildRecords({ ...profile, memo: memo(6), turns: [{ human: proposal, plan: {
    action: "agree", target: "figure_0", name: before.name, act: "name_propose", referent: "figure_0",
    speech: "ええ、「帆」にしましょう。",
    extraction: JSON.stringify([{ segmentId: "name", quote: proposal, proposition: proposal, targets: [first.id],
      aspect: "name", name: before.name, linkedIssueId: null, respondsToTurn: null }]),
    choose: key => key === "naming_grounding" ? "grounded_name_0" : key === "naming_evidence" ? "turn_1"
      : key === "human_move_on_source" ? "other" : undefined,
  } }, { human: ask, plan: {
    action: "repair", target: "figure_0", act: "ask",
    extraction: JSON.stringify([{ segmentId: "question", quote: ask, proposition: ask, targets: [first.id],
      aspect: "question", name: null, linkedIssueId: null, respondsToTurn: null }]),
    speech: JSON.stringify({ text, observationFeatures: [firstSource] }),
    aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [{ quote: text, source: firstSource }] } }),
    choose: (key, criteria) => key === "visual_purpose" ? Object.keys(criteria).find(label =>
      label.startsWith("issue_") && JSON.parse(criteria[label]).sourceTurn === 3)
      : key === "human_move_on_source" ? "other" : undefined,
  } }],
  onTurn(_label, turn) {
    assert.deepEqual(turn.state.ledger[first.id], before);
    if (turn.trace.turnIndex === 1) return;
    const purpose = turn.trace.executed.visualPurpose;
    assert.equal(purpose?.kind, "resolve_issue");
    assert.equal(turn.state.repairHistory.at(-1).issueId, purpose.issueId);
    assert.equal(turn.state.repairHistory.at(-1).question, text);
    assert.equal(turn.trace.generatedPublication?.visualPurposeSources?.[0].quote, ask);
  } });
  const checks = verifyRecords(records).checks.filter(check => check.id.startsWith("intervention.trial.0.attempt.0."));
  assert.equal(checks.length, 4);
  for (const check of checks) assert.equal(check.status, "pass", JSON.stringify(check));
});

test("v19 feature references must resolve on the selected figures and the extracted quote must come from the utterance", () => {
  const observed = memo(4);
  assert.equal(readVisualFeatureDraft(JSON.stringify({ text, observationFeatures: [outsideSource] }), observed, [first.id], false), null);
  assert.equal(readVisualFeatureEvidence({ sources: [{ source: firstSource, quote: "話していない特徴" }] }, observed, [first.id], text), null);
  assert.equal(readVisualFeatureEvidence({ sources: [{ source: { ...firstSource, path: ["unknowns", 0] }, quote: text }] },
    observed, [first.id], text), null);
});
