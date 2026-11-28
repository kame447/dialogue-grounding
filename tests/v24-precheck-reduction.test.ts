import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERATION_RETRY_V23, GENERATION_RETRY_V24, findOrientationLeaks, type RecordedGenerationRetryVersion } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OLD, OWN, runTurn, type Label, type Plan } from "./support/s4-v3-records.ts";

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5", "bypass_acceptance_v3", "jev_repair_quality_v1");
const technical = { version: "adaptive_repair_v3" } as const;
const figure = OWN.ownAnchors[0].id;
const labels: Label[] = ["repair-first", "bypass-enabled"];
const suggested = "鳥のような形に見えます。";
const ordinary = "「鳥」にしませんか？";
const alternatives = ["では、「鳥」にしませんか？", "「鳥」はどうですか？"];
const stay = "今の図形の話を続けたいです。";

function choose(key: string) {
  return ({ human_move_on_source: "other", commitment_state: "insufficient", draft_topic_shift: "within_plan" } as Record<string, string>)[key];
}
const propose = (drafts: string[], firstAct = "propose_chosen"): Plan => ({
  action: "propose_name", target: "figure_0", name: "鳥", referent: "figure_0", act: "construe", drafts, aiExtraction: "[]",
  extraction: JSON.stringify([{ segmentId: "construal", quote: suggested, proposition: suggested, targets: [figure],
    aspect: "construal", name: null, linkedIssueId: null, respondsToTurn: null }]),
  choose: (key, _criteria, context) => key === "draft_naming" ? context.generationCalls === 1 ? firstAct : "propose_chosen" : choose(key),
});

async function run(label: Label, version: RecordedGenerationRetryVersion, human: string, plan: Plan) {
  const memo = structuredClone(OLD.state.observationMemo);
  memo.figures.find((entry: { id: string }) => entry.id === figure).holistic =
    [{ construal: "鳥", basis: ["とがった先"], status: "hypothesis" }];
  const state = initialState({ profile, generationRetryVersion: version, agreeNameScopeVersion: "jev_naming_v3", memo });
  const jev: { body: string; keys: string[] }[] = [];
  const terra: string[] = [];
  const result = await runTurn(profile, label, state, [{ seq: 1, speaker: "human", text: human }],
    { ...plan, captureRequest(provider, body) {
      if (provider === "jev") jev.push({ body, keys: Object.keys(JSON.parse(body).questions) });
      else terra.push(body);
    } }, technical, version);
  assert.equal(result.publication.status, "committed");
  const generations = result.luna.filter(call => call.phase === "generation").length;
  return { ...result, generations, decisions: jev.filter(call => call.keys.includes("action")).length, jev, terra };
}

test("v24 は選定した名前の自然な提案を既存の Jev 送信で確認し、初稿を公開する", async () => {
  for (const draft of alternatives) {
    const [repair, bypass] = await Promise.all(labels.map(label => run(label, GENERATION_RETRY_V24, suggested, propose([draft]))));
    assert.deepEqual(repair.terra, bypass.terra);
    assert.deepEqual(repair.jev, bypass.jev);
    for (const result of [repair, bypass]) {
      assert.equal(result.trace.executed.action, "propose_name");
      assert.equal(result.speech, draft);
      assert.equal(result.generations, 1);
      assert.equal(result.decisions, 1);
      const checks = result.jev.filter(call => call.keys.includes("draft_topic_shift"));
      assert.deepEqual(checks.map(call => call.keys), [["draft_naming", "draft_topic_shift"]]);
      assert.equal(result.state.ledger[figure].status, "tentative");
    }
  }
  const old = await run("repair-first", GENERATION_RETRY_V23, suggested, propose([alternatives[0], ordinary]));
  assert.equal(old.generations, 2);
  assert.equal(old.decisions, 1);
  assert.equal(old.speech, ordinary);
});

test("v24 の提案では別の名前や選択名の合意を公開しない", async () => {
  const invalid = [["「魚」にしませんか？", "propose_question"], ["では「鳥」で決まりです。", "adopt_chosen"]] as const;
  for (const [draft, verdict] of invalid) {
    const result = await run("bypass-enabled", GENERATION_RETRY_V24, suggested, propose([draft, ordinary], verdict));
    assert.equal(result.speech, ordinary);
    assert.equal(result.decisions, 1);
    assert.equal(result.generations, 2);
    assert.equal(result.state.ledger[figure].status, "tentative");
  }
});

test("v24 は方位語だけで再稿にせず、相手の盤面の断定と計画外の移行を拒む", async () => {
  for (const draft of ["私には右向きの鳥に見えます。", "こちらから見た場合、右向きの鳥に見えます。"]) {
    assert.deepEqual(findOrientationLeaks(draft, "holistic_v5", GENERATION_RETRY_V23), ["orientation_leak"]);
    for (const label of labels) {
      const result = await run(label, GENERATION_RETRY_V24, stay,
        { action: "accept", target: "none", drafts: [draft], aiExtraction: "[]", choose });
      assert.equal(result.speech, draft);
      assert.equal(result.generations, 1);
      assert.equal(result.decisions, 1);
    }
  }
  const next = "この図形をいったん置いて、次のを見よう。";
  const safe = "いま見ている図形のことですね。";
  const partner = "そちらの画面でも同じ右向きです。";
  for (const draft of [partner, next]) {
    for (const label of labels) {
      const result = await run(label, GENERATION_RETRY_V24, stay, {
        action: "accept", target: "none", drafts: [draft, safe], aiExtraction: "[]",
        choose: (key, _criteria, context) => key === "draft_topic_shift" && draft === next && context.generationCalls === 1
          ? "unsupported_shift" : choose(key),
      });
      assert.equal(result.speech, safe);
      assert.equal(result.generations, 2);
      assert.equal(result.decisions, 1);
      assert.ok(result.trace.generationGuard.violations.includes(draft === next ? "unsupported_topic_shift" : "shared_view_assumption"));
    }
  }
});
