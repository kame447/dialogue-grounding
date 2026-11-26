// Issue #172: a partner's place on their own board is not a shape feature and does not pick one of the AI's
// differently arranged figures. Prompt contract and runtime boundaries with synthetic utterances, memos and
// local mocks only; these tests do not show that a live model follows the wording.
import test from "node:test";
import assert from "node:assert/strict";
import { TASK_INSTRUCTIONS_V2, JUDGE_POLICIES, STRATEGIES } from "../dialogue-model/runtime/judgment/instructions.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { GENERATOR_INSTRUCTIONS_V2, LUNA_GENERATOR_INSTRUCTIONS_V2, ACTION_SCOPE_V2, LUNA_ACTION_SCOPE_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createTrialV2, modelView } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from "../dialogue-model/runtime/local-grounding/extract.ts";
import { buildJevDecisionPayload, buildJevDecisionDetailPayload, buildHumanReferentPayload, createJevDecisionClient } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionInput } from "../dialogue-model/runtime/decision/contract.ts";
import { createProfileDialogue } from "../dialogue-model/runtime/diagnostics/parity-live/replay.ts";
import { profile } from "./support/s4-integration/harness.ts";

const OPENING = "まず、どの図形から話しましょうか？";
// A place on the partner's screen only, versus the position of parts inside one figure.
const PLACE_ONLY = ["一番左上の図形かな", "右端の図形です", "一番上にあるやつ"];
const SHAPE_PARTS = ["右に突き出た部分がある形です", "上下に細長くて、上の部分が斜めになっています"];
// Fixed position vocabulary that v2 instructions must never assert (see v2-core).
const FIXED_POSITIONS = /上段|下段|左上|右上|左下|右下|R1C1|R2C3/;

type Message = { role: string; content: any };
const textOf = (messages: Message[]) => messages.flatMap(m => typeof m.content === "string" ? [m.content]
  : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text)).join("\n");
const imagesOf = (messages: Message[]) => messages.flatMap(m => Array.isArray(m.content)
  ? m.content.filter((p: any) => p.type === "image_url").map((p: any) => p.image_url.url) : []);
const systemText = (messages: Message[]) => textOf(messages.filter(m => m.role === "system"));

function assertPlaceRule(text: string, label: string) {
  assert.match(text, /相手の画面での図形の場所（右端・真ん中・一番上など）は形/, label + ": a partner's place is not a shape feature");
  assert.match(text, /場所しか手がかり/, label + ": a place alone never selects one own figure");
  assert.match(text, /図形の中の部分の位置や向き（右に突き出た部分など）/, label + ": parts inside a figure stay usable");
  assert.doesNotMatch(text, FIXED_POSITIONS, label + ": no fixed position vocabulary in instructions");
}
// A place-only turn realized as accept: the request asks for the shape, and "only receive" remains solely as the
// explicit branch for every other case, so no instruction in the same request opposes asking.
function assertCoherentAccept(messages: Message[], label: string) {
  const text = textOf(messages);
  assert.match(text, /場所しか手がかりがなければ[^。]*場所だけでは分からないことを短く伝えて形の特徴を尋ねてください/, label + ": common rule");
  assert.match(text, /acceptでは、相手が場所だけで図形を示したときは形の特徴を尋ね、それ以外は受け止めるだけにしてください/, label + ": generator rule");
  assert.match(text, /相手が場所だけで図形を示したときは、場所だけでは分からないことを短く伝えて形の特徴を尋ね/, label + ": accept scope");
  assert.equal(text.split("受け止めるだけ").length, text.split("それ以外は受け止めるだけ").length, label + ": no unconditional 'only receive'");
}

test("each prompt that reads the human turn separates a partner's board place from shape features", () => {
  assertPlaceRule(TASK_INSTRUCTIONS_V2, "task");
  assert.match(TASK_INSTRUCTIONS_V2, /場所だけでは自分のどの図形か決まりません/);
  assert.match(TASK_INSTRUCTIONS_V2, /形の説明に言い換えたりせず、場所だけでは分からないことを短く伝えて形の特徴を尋ねてください/);
  assert.match(TASK_INSTRUCTIONS_V2, /公開対話ですでに共有した手がかり/);
  assert.match(TASK_INSTRUCTIONS_V2, /回転させて考え、向きが変わっても保たれる全体の見立てや形の特徴で照合してください/);
  assert.doesNotMatch(TASK_INSTRUCTIONS_V2, /相手の位置や上下左右の説明を/, "the old sentence mixed board places with part orientation");
  assertPlaceRule(MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, "extraction");
  assert.match(MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, /場所しか手がかりのない部分はtargets: \[\]にしてください/);
  assert.doesNotMatch(MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, /相手の上下左右を自分のregionへ直接対応させず/);

  const slots = Array.from({ length: 6 }, (_, i) => `own-${i}`);
  const input = { turn: 2, ownSlots: slots, issueSummary: "", priorClaims: [], publicNames: [], repairHistory: [], previousAction: null,
    publicTurns: [{ turn: 1, speaker: "ai", text: OPENING }, { turn: 2, speaker: "human", text: PLACE_ONLY[0] }],
    observations: { observedAt: "2026-11-20T00:00:00.000Z", figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
      holistic: [{ construal: `見立て${i}`, basis: ["部分"], status: "hypothesis" }],
      analytic: { shapes: ["右に突き出た部分がある"], composition: "上部の斜め輪郭が右側へ張り出す", relations: [] }, unknowns: [], reobservations: [] })) } } as JevDecisionInput;
  const decision = buildJevDecisionPayload(input), detail = buildJevDecisionDetailPayload(input, { action: "confirm", target: { kind: "single", figureId: "own-0" } })!;
  for (const [key, question] of [...Object.entries(decision.questions), ...Object.entries(detail.questions)]) {
    assertPlaceRule(question.instructions, "jev " + key);
    assert.match(question.instructions, /受け止めて形の特徴を尋ねる応答（accept）を選べます/, "jev " + key);
  }
  const referent = buildHumanReferentPayload(input).questions.human_referent.instructions;
  assertPlaceRule(referent, "jev human_referent");
  assert.match(referent, /複数や判定不能ならmultiple/);
  assert.doesNotMatch(referent, /accept/, "estimating the human referent never chooses an action");
  // Jev's recommended act and Luna's accept wording agree; every other accept keeps its original wording.
  for (const text of [GENERATOR_INSTRUCTIONS_V2, LUNA_GENERATOR_INSTRUCTIONS_V2]) {
    assert.match(text, /acceptでは、相手が場所だけで図形を示したときは形の特徴を尋ね、それ以外は受け止めるだけにしてください。/);
    assert.doesNotMatch(text, /acceptでは受け止めるだけにしてください/);
  }
  assert.match(ACTION_SCOPE_V2.accept, /^相手が場所だけで図形を示したときは、場所だけでは分からないことを短く伝えて形の特徴を尋ねる。それ以外は受け止めるだけ。名前に決まったとは言わない$/);
  assert.match(LUNA_ACTION_SCOPE_V2.accept, /形の特徴を尋ね、自分の図形の観察は添えない。それ以外は受け止め、判断メモにある同じ論点の自分の観察は短く添えてよい。名前に決まったとは言わない$/);
});

// The Luna v2 path, as the public Worker builds it (createNamingTaskV2 without Jev research).
async function lunaTrial(strategy: string, seed: number) {
  const calls: Array<{ phase: string; messages: Message[] }> = [];
  const client = { async complete(messages: Message[], options: { phase?: string } = {}) {
    calls.push(structuredClone({ phase: options.phase ?? "", messages }));
    if (options.phase === "judgment") return { text: JSON.stringify({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }), model: "fake" };
    return { text: "そちらのその図形ですね。どんな形か教えてもらえますか？", model: "fake" };
  } };
  const task = await createNamingTaskV2({ client, strategy, seed, runDir: "" });
  for (const text of [...PLACE_ONLY, ...SHAPE_PARTS]) { task.message(text); await task.whenIdle(); }
  return { calls, events: task.getState().events };
}

test("Luna v2 path: judge and generator get the same place rule, strategies differ only by the policy, only the AI image is sent", async () => {
  const seed = 172, trial = createTrialV2({ seed });
  const aiImage = "data:image/png;base64," + trial.ai.png.toString("base64"), humanImage = "data:image/png;base64," + trial.human.png.toString("base64");
  const [left, right] = await Promise.all(STRATEGIES.map(strategy => lunaTrial(strategy, seed)));
  for (const run of [left, right]) {
    assert.deepEqual(run.events.map((e: { speaker: string }) => e.speaker), ["ai", ...[...PLACE_ONLY, ...SHAPE_PARTS].flatMap(() => ["human", "ai"])]);
    assert.equal(run.events[0].text, OPENING);
    const phases = run.calls.map(c => c.phase);
    assert.equal(phases.filter(p => p === "judgment").length, 5); assert.equal(phases.filter(p => p === "generation").length, 5);
    for (const { phase, messages } of run.calls) {
      assert.equal(messages[0].content, TASK_INSTRUCTIONS_V2, phase + ": the shared task text is the first message");
      assertPlaceRule(messages[0].content, phase);
      if (phase === "generation") assertCoherentAccept(messages, "luna generation");
      assert.deepEqual(imagesOf(messages), [aiImage]); assert.ok(!imagesOf(messages).includes(humanImage));
      const all = textOf(messages);
      for (const id of Object.keys(trial.key.human)) assert.ok(!all.includes(id), "human id leaked: " + id);
      for (const figure of new Set(Object.values(trial.key.ai) as string[])) assert.ok(!all.includes('"' + figure + '"'), "figure id leaked");
      assert.doesNotMatch(systemText(messages), FIXED_POSITIONS, phase + ": instructions assert no fixed position");
      assert.doesNotMatch(all, /repair-first|bypass-enabled/);
    }
    // The partner's words reach the model only as public turns, verbatim.
    const last = run.calls.at(-1)!.messages.filter(m => m.role === "user" && typeof m.content === "string").map(m => m.content);
    assert.deepEqual(last, [...PLACE_ONLY, ...SHAPE_PARTS]);
  }
  const withoutPolicy = (calls: typeof left.calls) => calls.map(c => ({ ...c, messages: c.messages.filter(m => !Object.values(JUDGE_POLICIES).includes(m.content)) }));
  assert.deepEqual(withoutPolicy(left.calls), withoutPolicy(right.calls));
  assert.notDeepEqual(left.calls, right.calls, "the four-line strategy policy is still the only difference");
});

// The Jev path, as the local research server builds it: research profile, integrated intervention, native Jev
// client over a synthetic transport. Jev answers are scripted; the request bodies are the ones really built.
function jevTrial(strategy: string, script: { human: string; action: string; target: string; feature?: string;
  segment?: { quote: string; targets: "none" | "first"; aspect: string; proposition: string } }) {
  const trial = createTrialV2({ seed: 172 }), view = modelView(trial);
  const own = { mimeType: view.mimeType, base64: view.png.toString("base64") };
  const memo = () => ({ observedAt: "2026-11-20T00:00:00.000Z", figures: view.anchors.map((a: any, i: number) => ({ id: a.id, region: { ...a.bbox },
    holistic: [{ construal: `見立て${i}`, basis: ["全体の形"], status: "hypothesis" }],
    analytic: { shapes: [i === 1 ? "右に突き出た部分がある" : `三角が${i + 1}つ`], composition: i === 0 ? "上部の斜め輪郭が右側へ張り出し、幅広い部分につながる" : `構成${i}`, relations: [] },
    unknowns: [], reobservations: [] })) });
  const bodies: any[] = [], luna: Array<{ phase: string; messages: Message[] }> = [], inputs: JevDecisionInput[] = [];
  const fetchImpl = async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]: [string, any]) => {
      const labels = Object.keys(question.criteria);
      const choice = key === "human_referent" ? "multiple" : key === "action" ? script.action : key === "target" ? script.target
        : key.startsWith("candidate_") ? "exclude" : key === "feature" ? labels.find(l => JSON.parse(question.criteria[l]).value === script.feature)! : labels[0];
      return [key, { type: "choice", choice, probabilities: Object.fromEntries(labels.map(l => [l, l === choice ? 1 : 0])) }];
    }));
    return Response.json({ model: "typesafe/jev-1.14", id: "gen-synthetic-" + bodies.length, usage: { cost: 0 }, answers });
  };
  const native = createJevDecisionClient({ enabled: true, readKey: async () => "sk-or-SYNTHETIC-0000000000000000", fetchImpl, timeoutMs: 1000, researchLimits: { maxDeadlineMs: 600000 } })!;
  const jevDecision: any = { estimateReferent: (input: any, options: any) => native.estimateReferent(input, options),
    decide(input: any, options: any) { inputs.push(structuredClone(input)); return native.decide(input, options); },
    completeDetail: (input: any, selected: any, options: any) => native.completeDetail(input, selected, options) };
  const client = { async complete(messages: Message[], options: { phase: string }) {
    luna.push(structuredClone({ phase: options.phase, messages }));
    if (options.phase === "local_extraction") return { text: JSON.stringify(script.segment ? [{ segmentId: "s1", quote: script.segment.quote,
      targets: script.segment.targets === "first" ? [view.anchors[1].id] : [], aspect: script.segment.aspect, proposition: script.segment.proposition,
      name: null, linkedIssueId: null, respondsToTurn: null }] : []) };
    if (options.phase === "ai_extraction") return { text: "[]" };
    return { text: "そちらの図形のことですね。どんな形か教えてもらえますか？" };
  } };
  const dialogue: any = createProfileDialogue(profile(), { strategy, client, image: own, anchors: view.anchors, referenceMemory: true, decisionMode: "jev",
    observer: { async observeAll() { return memo(); }, async reobserve() { throw new Error("no reobservation in this script"); } }, jevDecision,
    localGrounding: { classifier: { async classify(input: any) { return input.segments.map((s: any) => ({ segmentId: s.segmentId, act: "assert", respondsToClaimId: null, rawScore: null })); } },
      aiPublicTransport: { readKey: async () => { throw new Error("unselected AI key"); }, fetchImpl: async () => { throw new Error("unselected AI fetch"); } } } } as any);
  const events = [{ id: "ai-1", seq: 1, speaker: "ai", text: OPENING, nonReferential: true }, { id: "human-2", seq: 2, speaker: "human", text: script.human }];
  const run = async () => dialogue.runAiTurn({ events, privateState: await dialogue.initializePrivateState(), lastEventId: "human-2", requestSeq: 1 });
  return { trial, own, bodies, luna, inputs, run };
}

test("Jev path: a place-only turn carries the rule to extraction, referent, decision and generation; accept/none assigns no figure", async () => {
  const script = { human: PLACE_ONLY[0], action: "accept", target: "none",
    segment: { quote: "一番左上の図形", targets: "none" as const, aspect: "position", proposition: "相手の画面の場所で図形を示している" } };
  const [a, b] = STRATEGIES.map(strategy => jevTrial(strategy, script));
  const [ra, rb] = [await a.run(), await b.run()];
  for (const [run, result] of [[a, ra], [b, rb]] as const) {
    const extraction = run.luna.find(c => c.phase === "local_extraction")!, generation = run.luna.find(c => c.phase === "generation")!;
    assert.equal(extraction.messages[0].content, MEMO_LOCAL_EXTRACTION_INSTRUCTIONS);
    assert.equal(generation.messages[0].content, TASK_INSTRUCTIONS_V2);
    const decision = generation.messages.find(m => typeof m.content === "string" && m.content.includes('"action":"accept"'))!;
    assert.match(decision.content, /"targetSlot":null/); assert.match(decision.content, /"target":\{"kind":"none"\}/);
    assert.ok(decision.content.includes(ACTION_SCOPE_V2.accept), "the act line carries the place-only accept wording");
    assertCoherentAccept(generation.messages, "jev generation");
    assert.deepEqual(run.bodies.map(body => Object.keys(body.questions).includes("human_referent") ? "referent" : "decision"), ["referent", "decision"]);
    for (const body of run.bodies) for (const [key, question] of Object.entries(body.questions) as Array<[string, any]>) assertPlaceRule(question.instructions, key);
    // The place-only claim stays without a target; no program rule maps it to a figure.
    const claim = run.inputs[0].priorClaims.find(c => c.quote === "一番左上の図形")!;
    assert.deepEqual(claim.targets, []);
    assert.ok(Object.values(result.privateState.ledger).every((entry: any) => entry.status === "unassigned" && entry.name === null));
    // Boundary: no image, pixel region, strategy or partner-side material reaches Jev, extraction or generation.
    const sent = JSON.stringify([run.bodies, run.luna]);
    assert.ok(!sent.includes(run.own.base64));
    assert.doesNotMatch(JSON.stringify(run.bodies), /"region"|"bbox"|"centroid"|repair-first|bypass-enabled/);
    for (const id of Object.keys(run.trial.key.human)) assert.ok(!sent.includes(id), "human id leaked: " + id);
    for (const figure of new Set(Object.values(run.trial.key.ai) as string[])) assert.ok(!sent.includes('"' + figure + '"'), "figure id leaked");
    assert.ok(!sent.includes(run.trial.human.png.toString("base64")));
  }
  assert.deepEqual(a.inputs, b.inputs); assert.deepEqual(a.bodies, b.bodies); assert.deepEqual(a.luna, b.luna);
  assert.equal(ra.text, rb.text);
});

test("Jev path: a feature about a part inside a figure (右に突き出た部分) still flows unchanged; spatial wording is not filtered", async () => {
  const script = { human: SHAPE_PARTS[0], action: "confirm", target: "figure_1", feature: "右に突き出た部分がある",
    segment: { quote: "右に突き出た部分", targets: "first" as const, aspect: "part", proposition: "右に突き出た部分がある" } };
  const [a, b] = STRATEGIES.map(strategy => jevTrial(strategy, script));
  const [ra, rb] = [await a.run(), await b.run()];
  for (const [run, result] of [[a, ra], [b, rb]] as const) {
    const generation = run.luna.find(c => c.phase === "generation")!;
    assert.ok(generation.messages.some(m => typeof m.content === "string" && m.content.includes('"discriminatingFeature":"右に突き出た部分がある"')));
    assert.equal(result.privateState.judgments[0].judgment.action, "confirm");
    assert.equal(result.privateState.judgments[0].judgment.discriminatingFeature, "右に突き出た部分がある");
    assert.deepEqual(result.privateState.judgments[0].generationGuard.violations, []);
    assert.deepEqual(run.inputs[0].priorClaims.find(c => c.quote === "右に突き出た部分")!.targets, [modelView(run.trial).anchors[1].id]);
  }
  assert.deepEqual(a.bodies, b.bodies); assert.deepEqual(a.luna, b.luna);
});
