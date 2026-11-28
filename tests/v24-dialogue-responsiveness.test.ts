import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERATION_RETRY_V24, type PostGenerationCheck } from "../dialogue-model/runtime/v2/deferred-ai-extraction.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OLD, OWN, runTurn, type Label, type Plan } from "./support/s4-v3-records.ts";

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5", "bypass_acceptance_v3", "jev_repair_quality_v1");
const technical = { version: "adaptive_repair_v3" } as const;
const strategies: Label[] = ["repair-first", "bypass-enabled"];
const figure = OWN.ownAnchors[0].id;
const source = { figureId: figure, path: ["analytic", "shapes", 0] };
const oldFeature = "三角の切れ込み";
const feature = "半円の切れ込み";
const badDraft = "この話はここまでにして、別の図形に進みましょう。";
const description = "私の図形は半円の切れ込みが目印です。";
const choice = "選ぶなら、半円の切れ込みがある形にします。見分けやすいからです。";
const namingInput = "鳥のような形に見えます。名前を決めましょう。";
const namingReply = "鳥という見立ては分かります。まだ同じ図形かは確かめられていません。";
const difference = "私の図形の切れ込みは半円です。そこが違いそうです。";
const corrected = "なるほど。私の図形にも半円の切れ込みがあります。細い部分にありますか？";

type Scenario = { human: string; answer: string; continuation: "ask_unresolved" | "acknowledge_unresolved"; naming?: true;
  observation?: { source: typeof source; quote: string }; };
const scenarios: Scenario[] = [
  { human: "図形を見分ける特徴を教えてください。", answer: description, continuation: "ask_unresolved", observation: { source, quote: description } },
  { human: "三角の切れ込みと半円の切れ込みなら、どちらの形から話しますか？", answer: choice,
    continuation: "acknowledge_unresolved", observation: { source, quote: "半円の切れ込みがある形" } },
  { human: namingInput, answer: namingReply, continuation: "acknowledge_unresolved", naming: true },
  { human: "三角の切れ込みです。形の違いを教えてください。", answer: difference,
    continuation: "ask_unresolved", observation: { source, quote: "私の図形の切れ込みは半円です。" } },
  { human: "切れ込みは三角ではなく半円です。形の違いを教えてください。", answer: corrected,
    continuation: "ask_unresolved", observation: { source, quote: "私の図形にも半円の切れ込みがあります。" } },
];

async function dialogue(label: Label, mode: PostGenerationCheck, scenario: Scenario, wrongSource = false) {
  const memo = structuredClone(OLD.state.observationMemo);
  const item = memo.figures.find((entry: { id: string }) => entry.id === figure);
  item.analytic.shapes = [feature];
  item.holistic = [{ construal: "鳥", basis: [feature], status: "hypothesis" }];
  const state = initialState({ profile, generationRetryVersion: GENERATION_RETRY_V24, agreeNameScopeVersion: "jev_naming_v3", memo });
  const hasSources = scenario.observation ? [scenario.observation] : [];
  const checkedDraft = JSON.stringify({ text: scenario.answer, observationFeatures: hasSources.map(row => row.source) });
  const requests: { provider: string; body: string }[] = [];
  let generationSends = 0;
  const on = mode === "on";
  const plan: Plan = {
    action: scenario.naming ? "propose_name" : "accept", target: scenario.naming ? "figure_0" : "none",
    ...(scenario.naming ? { name: "鳥", referent: "figure_0", act: "construe", extraction: JSON.stringify([{
      segmentId: "construal", quote: "鳥のような形に見えます。", proposition: "鳥のような形に見える", targets: [figure], aspect: "construal",
      name: null, linkedIssueId: null, respondsToTurn: null,
    }]) } : {}),
    postGenerationCheck: mode,
    drafts: on ? [badDraft, badDraft, badDraft, badDraft,
      ...(wrongSource ? [JSON.stringify({ text: scenario.answer, observationFeatures: [] })] : []), checkedDraft] : [scenario.answer],
    aiExtraction: JSON.stringify(on ? { segments: [], visualFeatures: { sources: hasSources } } : []),
    choose(key, criteria, context) {
      if (key === "draft_topic_shift") return context.generationCalls < 5 ? "unsupported_shift" : "within_plan";
      if (key === "publication_continuation") return scenario.continuation;
      if (key === "draft_naming") return context.generationCalls < 5 && Object.hasOwn(criteria, "propose_chosen") ? "propose_chosen" : "none";
      if (key === "human_move_on_source") return "other";
      if (key === "commitment_state") return "insufficient";
      return undefined;
    },
    ...(!on ? { onDraftCheck() { assert.fail("OFF の公開前に意味検査を呼んだ"); } } : {}),
    captureRequest(provider, body) {
      requests.push({ provider, body });
      const payload = JSON.parse(body);
      if (provider === "jev" && payload.questions.publication_continuation) {
        assert.equal(JSON.parse(payload.state).publicationRecoveryContext.respondToRequest, true);
        assert.match(payload.questions.publication_continuation.criteria.ask_unresolved, /相手の依頼にまず答え/u);
      }
      if (provider === "luna" && payload.messages[0]?.content.startsWith("あなたは二者によるタングラム")) {
        generationSends++;
        const common = payload.messages[1].content;
        assert.match(common, /説明には自分の見え方とその根拠、選択の依頼には選んだもの/u);
        assert.match(common, /訂正した点.*既に答えが出た点を聞き直さない/u);
        assert.match(common, /原則一発話で一つ.*相づちは「なるほど」程度/u);
        assert.match(common, /どこが一致し、どこが違うか/u);
        if (generationSends === 5) {
          const finalPlan = payload.messages[2].content;
          assert.match(finalPlan, /未確定のまま答える.*相手の説明・選択・命名・進行の依頼に/u);
          assert.match(finalPlan, /観察で答えられる内容とその根拠を先に/u);
          if (scenario.continuation === "ask_unresolved") assert.match(finalPlan, /未回答の具体的な一点/u);
          else assert.match(finalPlan, /新たな質問は加えない/u);
          assert.doesNotMatch(finalPlan, /何を確かめるとよいか、特定の図形/u);
        }
      }
    },
  };
  const result = await runTurn(profile, label, state, [{ seq: 1, speaker: "human", text: scenario.human }], plan,
    technical, GENERATION_RETRY_V24);
  assert.equal(result.speech, scenario.answer);
  assert.equal(result.publication.publicEvents.at(-1)?.text, scenario.answer);
  if (on || !scenario.naming) assert.deepEqual(result.state.ledger, state.ledger);
  else assert.deepEqual(result.state.ledger[figure], { name: "鳥", status: "tentative" });
  return { ...result, requests, generationSends };
}

test("v24 ON は回復した説明の出所も照合してから公開する", async () => {
  const result = await dialogue("bypass-enabled", "on", scenarios[0], true);
  assert.equal(result.generationSends, 6);
  assert.deepEqual(result.trace.generationGuard.violations, ["visual_feature_mismatch"]);
  assert.deepEqual(result.trace.generatedPublication?.visualFeatures?.sources, [scenarios[0].observation]);
  assert.equal(result.luna.filter(call => call.phase === "ai_extraction").length, 2);
});

for (const mode of ["on", "off"] as const) test(`v24 ${mode.toUpperCase()} は両方略で依頼・訂正に答える`, async () => {
  for (const scenario of scenarios) {
    const [first, second] = await Promise.all(strategies.map(label => dialogue(label, mode, scenario)));
    assert.deepEqual(first.requests, second.requests);
    for (const result of [first, second]) {
      const generated = result.trace.generatedPublication;
      if (mode === "on") {
        assert.equal(result.generationSends, 5);
        assert.equal(generated?.recovery?.reason, "publication_mismatch");
        assert.equal(generated?.continuation?.reason, "draft_mismatch");
        assert.equal(generated?.continuation?.choice, scenario.continuation);
        assert.deepEqual(generated?.visualFeatures?.sources, scenario.observation ? [scenario.observation] : []);
        assert.equal(result.luna.filter(call => call.phase === "ai_extraction").length, 1);
        assert.equal(result.jev.filter(call => Object.hasOwn(call.answers, "draft_topic_shift")).length, 5);
      } else {
        assert.equal(result.generationSends, 1);
        assert.equal(generated?.recovery, null);
        assert.equal(generated?.continuation, null);
        assert.equal(result.trace.draftActs, undefined);
        assert.equal(result.luna.filter(call => call.phase === "ai_extraction").length, 1);
      }
      if (scenario.answer === corrected) {
        assert.match(result.speech!, /^なるほど。[^？]*半円の切れ込み/u);
        assert.equal(result.speech!.includes(oldFeature), false);
        assert.equal((result.speech!.match(/？/gu) ?? []).length, 1);
      }
      if (scenario.answer === difference) assert.match(result.speech!, /半円です。そこが違いそうです/u);
    }
  }
});
