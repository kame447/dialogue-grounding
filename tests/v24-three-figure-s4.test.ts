import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { interventionChecks } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";

const options = {
  dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3", judgmentMaterialVersion: "jev_repair_quality_v1",
  technicalTrial: { version: "adaptive_repair_v3" }, generationRetryVersion: "jev_generation_retry_v24", agreeNameScopeVersion: "jev_naming_v3",
  figureCount: 3,
} as const;
const replayCheck = (records: Awaited<ReturnType<typeof buildRecords>>) => interventionChecks(records).find(check => check.id.endsWith(".replay"));
const choose = (key: string) => key === "human_move_on_source" ? "other" : key === "commitment_state" ? "not_due"
  : key === "draft_topic_shift" ? "within_plan" : undefined;

for (const postGenerationCheck of ["off", "on"] as const) {
  test(`v24 S4 binds the ${postGenerationCheck} publication boundary on three figures`, async () => {
    const visual = postGenerationCheck === "on";
    const records = await buildRecords({ ...options, turns: [{ human: "細い部分はどうつながっていますか？", plan: {
      postGenerationCheck, action: "confirm", target: "figure_0", referent: "figure_0", choose,
      speech: JSON.stringify({ text: "細い部分は端でつながっています。", ...(visual ? { observationFeatures: [] } : {}) }),
      aiExtraction: JSON.stringify(visual ? { segments: [], visualFeatures: { sources: [] } } : []),
    } }] });
    const baseline = replayCheck(records);
    assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
    const trial = records.trials[0], entry = trial.replay[0], side = entry.result.sides[0];
    assert.equal(Object.keys(entry.tape.state.ledger).length, 3);
    assert.equal(Object.hasOwn(trial.attempts[0], "draftActs"), visual);
    assert.equal(side.publicationBoundary.job.schemaVersion, visual ? "deferred_ai_classification_v1" : "deferred_ai_extraction_v1");
    assert.equal(side.requests.findIndex((request: { phase: string }) => request.phase === "ai_extraction") < side.publicationBoundary.requestsBeforePublication, visual);
    assert.match(side.requests.find((request: { phase: string }) => request.phase === "generation").payload.messages[0].content, /タングラム3図形/u);

    const changedMode = structuredClone(records);
    changedMode.trials[0].replay[0].tape.postGenerationCheck = visual ? "off" : "on";
    assert.equal(replayCheck(changedMode)?.status, "mismatch");

    if (!visual) {
      const changedLegend = structuredClone(records);
      for (const comparison of [changedLegend.trials[0].replay[0].result.sides[1], changedLegend.evidence.pairedReplay[0].right]) {
        const request = comparison.requests.find((entry: { phase: string }) => entry.phase === "decision");
        const action = request.payload.questions.action;
        assert.match(action.instructions, /f0〜f2はownSlots/u);
        action.instructions = action.instructions.replace("f0〜f2はownSlots", "f0〜f3はownSlots");
        request.payloadSha256 = request.preProjectionPayloadSha256 = hash(request.payload);
      }
      assert.equal(replayCheck(changedLegend)?.status, "mismatch");
    }
  });
}

for (const grounded of [false, true]) {
  test(`v24 S4 binds the OFF agreement ledger to grounding (${grounded})`, async () => {
    const human = "鳥という名前でどうですか？";
    const figureId = OWN.ownAnchors[0].id;
    const records = await buildRecords({ ...options, turns: [{ human, plan: {
      postGenerationCheck: "off", action: "agree", target: "figure_0", referent: "figure_0", name: "鳥", act: "name_propose",
      speech: "はい、「鳥」で決まりですね。",
      extraction: JSON.stringify([{ segmentId: "name", quote: human, targets: [figureId], aspect: "name",
        proposition: human, name: "鳥", linkedIssueId: null, respondsToTurn: null }]),
      choose: key => key === "naming_grounding" ? grounded ? "grounded_name_0" : "unresolved"
        : key === "naming_evidence" ? grounded ? "turn_1" : "none" : choose(key),
    } }] });
    const baseline = replayCheck(records);
    assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
    assert.equal(records.trials[0].attempts[0].generatedPublication.agreementWithheld, grounded ? undefined : true);
    assert.equal(records.trials[0].lastCommittedState.ledger[figureId].status, grounded ? "agreed" : "unassigned");
    const altered = structuredClone(records);
    altered.trials[0].lastCommittedState.ledger[figureId] = grounded
      ? { status: "unassigned", name: null } : { status: "agreed", name: "鳥" };
    assert.ok(interventionChecks(altered).some(check => check.status === "mismatch"));
  });
}

test("v24 S4 binds the regenerated ON plan and post-publication classification after recovery", async () => {
  const bad = "この図形をいったん置いて、次のを見よう。";
  const good = "私の図形の切り込みは半円です。";
  const records = await buildRecords({ ...options, turns: [{ human: "図形を見分ける特徴を教えてください。", plan: {
    postGenerationCheck: "on", action: "accept", target: "none",
    drafts: [bad, bad, bad, bad, JSON.stringify({ text: good, observationFeatures: [] })],
    aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
    choose: (key, _criteria, { generationCalls }) => key === "draft_topic_shift"
      ? generationCalls < 5 ? "unsupported_shift" : "within_plan"
      : key === "publication_continuation" ? "ask_unresolved" : choose(key),
  } }] });
  assert.equal(records.trials[0].attempts[0].generatedPublication.continuation.choice, "ask_unresolved");
  const baseline = replayCheck(records);
  assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
});


test("v24 S4 accepts an OFF mechanical rewrite without a semantic check", async () => {
  const records = await buildRecords({ ...options, turns: [{ human: "細い部分はどうつながっていますか？", plan: {
    postGenerationCheck: "off", action: "confirm", target: "figure_0", referent: "figure_0", choose,
    drafts: [JSON.stringify({ observationFeatures: [] }), JSON.stringify({ text: "端でつながっています。", observationFeatures: "診断用" })],
    aiExtraction: "[]",
  } }] });
  const guard = records.trials[0].attempts[0].generationGuard;
  assert.deepEqual(guard.violations, ["draft_structure_mismatch"]);
  assert.equal(guard.regenerated, true);
  const baseline = replayCheck(records);
  assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
});

test("v24 S4 binds the ON naming proposal to its semantic check", async () => {
  const human = "鳥のような形に見えます。";
  const records = await buildRecords({ ...options, figureCount: 4, turns: [{ human, plan: {
    postGenerationCheck: "on", action: "propose_name", target: "figure_0", referent: "figure_0", name: "鳥",
    speech: "では、「鳥」にしませんか？", act: "construe",
    extraction: JSON.stringify([{ segmentId: "shape", quote: human, targets: [OWN.ownAnchors[0].id], aspect: "construal",
      proposition: human, name: null, linkedIssueId: null, respondsToTurn: null }]),
    choose: key => key === "draft_naming" ? "propose_chosen" : choose(key),
  } }] });
  assert.deepEqual(records.trials[0].attempts[0].draftActs[0].triggers, ["propose_action", "topic_shift"]);
  const baseline = replayCheck(records);
  assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
});
