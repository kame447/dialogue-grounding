import assert from "node:assert/strict";
import test from "node:test";
import { normalRepairQualityGuidance } from "../dialogue-model/runtime/decision/repair-quality.ts";
import { GENERATION_RETRY_V22, type RecordedGenerationRetryVersion } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OWN, runTurn, type Label, type Plan } from "./support/s4-v3-records.ts";

const v21 = "jev_generation_retry_v21";
const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5",
  "bypass_acceptance_v3", "jev_repair_quality_v1");
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const figure = OWN.ownAnchors[0].id;
const selected = (key: string) => ({ human_move_on_source: "other", commitment_state: "insufficient" } as Record<string, string>)[key];
const segment = (quote: string, aspect: string, figureId = figure, name: string | null = null) =>
  ({ segmentId: quote, quote, targets: [figureId], aspect, proposition: quote, name, linkedIssueId: null, respondsToTurn: null });
const visual = (text: string) => JSON.stringify({ text, observationFeatures: [] });
const parts = (...texts: string[]) => JSON.stringify({ parts: texts.map((text, item) => ({ item, text })), observationFeatures: [] });
const emptyObservation = JSON.stringify({ segments: [], visualFeatures: { sources: [] } });
const advice = normalRepairQualityGuidance("accept");
const question = "切り込みは二つですか？";
const otherQuestion = "ふくらみはどの部分ですか？";
const firstReply = "お話の図形は、帆が立った舟のように見えます。";
const visualReply = "切り込みどうしはどのようにつながっていますか？";
const repairReply = "ふくらみというのは、丸い部分のことですか？";
const questions = JSON.stringify([segment(question, "question"), segment(otherQuestion, "question", OWN.ownAnchors[1].id)]);
const multiChoose = (choices: Record<string, string>): Plan["choose"] => (key, criteria) =>
  key === "visual_purpose" ? Object.keys(criteria).find(label => label.startsWith("issue_")) :
    choices[key] ?? selected(key);
type Event = { id: string; seq: number; speaker: "human" | "ai"; text: string };
type Message = { role: string; content: string };
type History = { state: ReturnType<typeof initialState>; events: Event[] };

async function run(text: string, plan: Plan, version: RecordedGenerationRetryVersion = GENERATION_RETRY_V22,
  label: Label = "bypass-enabled", history?: History) {
  const events = history?.events ?? [];
  const seq = events.length + 1;
  const state = history?.state ?? initialState({ profile, generationRetryVersion: version, agreeNameScopeVersion: "jev_naming_v2" });
  const requests: Message[][] = [];
  const result = await runTurn(profile, label, state, [...events, { id: `event-${seq}`, seq, speaker: "human", text }],
    { aiExtraction: "[]", ...plan, captureRequest: (provider, body) => {
      if (provider === "luna") requests.push(JSON.parse(body).messages);
    } }, technicalTrial, version);
  assert.equal(result.publication.status, "committed");
  const generation = requests.filter((_, index) => result.luna[index].phase === "generation");
  const action = (index = generation.length - 1) => generation[index].find(message => message.content.startsWith("Jevが選んだ行動だけ"))!.content;
  return { ...result, generation, action, events: result.publication.publicEvents as Event[] };
}

test("v22 delivers the accept guidance once for ordinary, multipart and recovered execution", async () => {
  const main: Plan = { action: "accept", target: "none", speech: firstReply, choose: selected };
  const ordinary = await run("うん。", main);
  assert.equal(ordinary.action().split(advice).length, 2);
  const multiple: Plan = { ...main, action: "accept", target: "figure_0", extraction: questions, act: "ask",
    speech: parts(firstReply, repairReply), aiExtraction: emptyObservation,
    choose: multiChoose({ extra_0: "repair", extra_1: "leave" }) };
  const both = await run(question + otherQuestion, multiple);
  assert.equal(both.action().split(advice).length, 2);
  assert.match(both.action(), /items の 0 番:[^\n]+\nこの accept の部分に適用します。/u);
  const old = await run(question + otherQuestion, multiple, v21);
  assert.ok(!old.action().includes(advice));
  assert.deepEqual(both.httpBodies.map(request => request.provider), old.httpBodies.map(request => request.provider));

  const recovery: Plan = { action: "confirm", target: "figure_0", drafts: ["{}", "{}", firstReply],
    choose: (key, _criteria, { generationCalls }) => generationCalls >= 2 && key === "action" ? "accept" :
      generationCalls >= 2 && key === "target" ? "none" : key === "publication_continuation" ? "acknowledge_unresolved" : selected(key) };
  const recovered = await run("舟に見えます。", recovery);
  assert.equal(recovered.trace.generatedPublication?.recovery?.executed.action, "accept");
  assert.ok(!recovered.action(0).includes(advice));
  assert.ok(!recovered.action(1).includes(advice));
  assert.equal(recovered.action().split(advice).length, 2);
  const oldRecovery = await run("舟に見えます。", recovery, v21);
  assert.ok(!oldRecovery.action().includes(advice));
  assert.deepEqual(recovered.httpBodies.map(request => request.provider), oldRecovery.httpBodies.map(request => request.provider));
});

test("v22 distinguishes the two visual parts and leaves the hold wording on the adopted action", async () => {
  const single = await run(question, { action: "confirm", target: "figure_0", speech: visual(visualReply),
    aiExtraction: emptyObservation, choose: selected });
  const singleScope = single.action().split("\n").find(line => line.startsWith("判断で選ばれた論点（目的）"));
  assert.ok(singleScope);
  const noDeferral = "未解決の図形について保留や命名の先送りを提案しないでください。";
  assert.ok(singleScope.includes(noDeferral));
  assert.doesNotMatch(singleScope, /discriminatingFeature/u);
  const multi: Plan = { action: "confirm", target: "figure_0", extraction: questions, act: "ask",
    speech: parts(visualReply, repairReply), aiExtraction: emptyObservation, choose: multiChoose({ extra_0: "repair" }) };
  const runs = await Promise.all((["bypass-enabled", "repair-first"] as const)
    .map(label => run(question + otherQuestion, multi, GENERATION_RETRY_V22, label)));
  const [allow, veto] = runs;
  const [confirm, repair] = allow.action().split("\n").filter(line => line.startsWith("items の"));
  assert.equal(confirm, "items の 0 番: " + singleScope.replace(noDeferral, "") +
    "この扱いの部分では、その論点について判断を保留したり話を移したりしないでください。");
  assert.match(confirm, /形の参照枠に関する共通教示に沿って短く尋ねて確かめ/u);
  assert.match(confirm, /観察メモにない特徴を肯定したり、同じ図形だと断定したりしない/u);
  assert.match(repair, /公開上の食い違いを.+確かめ直す・直す/u);
  assert.match(repair, /訂正を明示するのは、これまでの発話にその根拠があるときだけ/u);
  assert.match(confirm, /その論点について判断を保留したり話を移したりしない/u);
  assert.match(repair, /その論点について判断を保留したり話を移したりしない/u);
  assert.deepEqual(allow.generation, veto.generation);
  const old = await run(question + otherQuestion, multi, v21);
  const oldScopes = old.action().split("\n").filter(line => line.startsWith("items の"));
  assert.equal(oldScopes[0].slice(14), oldScopes[1].slice(14));

  const hold: Plan = { ...multi, speechByLabel: { "bypass-enabled": parts(visualReply, "ふくらみのところは、まだよく分かりません。"),
    "repair-first": parts(visualReply, repairReply) },
    speech: undefined, choose: multiChoose({ extra_0: "hold_open", extra_alt_0: "repair" }) };
  const adopter = await run(question + otherQuestion, hold, GENERATION_RETRY_V22, "bypass-enabled");
  const substitute = await run(question + otherQuestion, hold, GENERATION_RETRY_V22, "repair-first");
  assert.match(adopter.action(), /相手が示した特徴や見立ての短い反復/u);
  assert.doesNotMatch(adopter.action(), /相手の言葉の短い反復/u);
  assert.doesNotMatch(substitute.action(), /相手が示した特徴や見立ての短い反復/u);
  assert.match(substitute.action(), /公開上の食い違いを.+確かめ直す・直す/u);
  assert.deepEqual(substitute.generation, veto.generation);
});

test("v22 can confirm a committed name and refer to it without adopting another name", async () => {
  const name = "灯台";
  const proposal = "この図形を灯台と呼びましょう。";
  const named = await run(proposal, { action: "agree", target: "figure_0", referent: "figure_0", name, act: "name_propose",
    speech: "はい、「灯台」と呼びましょう。", extraction: JSON.stringify([segment(proposal, "name", figure, name)]),
    choose: key => selected(key) ?? ({ naming_grounding: "grounded_name_0", naming_evidence: "turn_1" } as Record<string, string>)[key] });
  assert.deepEqual(named.state.ledger[figure], { status: "agreed", name });
  const confirm = "この図形の呼び名は灯台でいいですか？";
  const affirm = "はい、「灯台」で決まっています。";
  const sameName: Plan = { action: "accept", target: "figure_0", referent: "figure_0", act: "name_propose",
    speech: affirm, extraction: JSON.stringify([segment(confirm, "name", figure, name)]), choose: selected };
  const reconfirmed = await run(confirm, sameName, GENERATION_RETRY_V22, "bypass-enabled", named);
  assert.equal(reconfirmed.trace.namingReconfirm, true);
  assert.equal(reconfirmed.speech, affirm);
  assert.match(reconfirmed.action(), /同じ図形に合意済みの名前であれば、その名前で決まっていると肯定してかまいません/u);
  const instruction = reconfirmed.generation[0][1].content;
  assert.match(instruction, /新しい名前の合意を表明できるのはagreeのときだけ/u);
  assert.doesNotMatch(instruction, /。合意を表明できるのはagreeのときだけ/u);
  assert.match(reconfirmed.action(), /既に合意した名前はそのまま参照できる/u);
  assert.deepEqual(reconfirmed.state.ledger, named.state.ledger);

  const features = "「灯台」の先に切り込みがありますか？";
  const asked = await run("もう少し形を教えてください。", { action: "confirm", target: "figure_0", speech: visual(features),
    aiExtraction: emptyObservation, choose: selected }, GENERATION_RETRY_V22, "bypass-enabled", named);
  assert.equal(asked.speech, features);
  assert.ok(asked.generation[0].some(message => message.content.includes("その図形の呼び名としてそのまま参照できます。")));
  assert.deepEqual(asked.state.ledger, named.state.ledger);

  const guarded = await run(confirm, { ...sameName, drafts: ["いいえ、「風車」に決めましょう。", affirm], draftAct: "adopt_other" },
    GENERATION_RETRY_V22, "bypass-enabled", named);
  assert.ok(guarded.trace.generationGuard.violations.includes("draft_act_mismatch"));
  assert.equal(guarded.speech, affirm);
  assert.deepEqual(guarded.state.ledger, named.state.ledger);
});
