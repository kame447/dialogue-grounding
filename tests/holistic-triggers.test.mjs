// Prompt/typed-state regressions using local mocks. These tests do not establish
// that a real model follows the instructions or that the research policy works.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLunaJudge } from "../dialogue-model/runtime/judgment/luna.mjs";
import { TASK_INSTRUCTIONS, TASK_INSTRUCTIONS_V2, JUDGE_POLICIES, STRATEGIES } from "../dialogue-model/runtime/judgment/instructions.mjs";
import { createOwnLedger, SAFE_JUDGMENT, validateJudgment } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createDialogueV2, GENERATOR_INSTRUCTIONS_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";

const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const proposal = { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: ids[0], candidateName: "鳥" };
async function capture({ strategy = "repair-first", memory = false, publicHistory = [{ role: "user", content: "鳥っぽい形があります。" }],
  result = proposal, ownLedger = createOwnLedger(ids), responses = null } = {}) {
  const requests = [];
  const judge = createLunaJudge({ async complete(messages, options) {
    requests.push(structuredClone({ messages, options }));
    return { text: JSON.stringify(responses ? responses[requests.length - 1] : { ...result, ...(memory ? { reference: null } : {}) }) };
  } });
  const output = await judge.judge({ version: 2, strategy, image, ownAnchors: anchors, ownLedger, publicHistory,
    ...(memory ? { referenceContext: { graph: createReferenceGraph({ slots: ids }), turn: 1,
      publicTurns: [{ turn: 1, speaker: "human", text: publicHistory.at(-1).content }] } } : {}) });
  return { requests, output };
}
const triggers = [
  "相手が迷い・曖昧さ・食い違いを表明したか特徴・詳細を求めた",
  "公開対話の矛盾が未解決",
  "名前を確定しようとする時点で対象を1つに絞れず誤った合意の実害がある",
];

test("v1 task, complete judge retry requests and both four-line strategy policies remain byte-identical", async () => {
  assert.equal(digest(TASK_INSTRUCTIONS), "eab651c869324c43bb9332b0109f69fe7751a85753c800182fa49a997f271ae4");
  const baseline = {
    "repair-first": { policy: "ecf5f98e347748cfdc54731fb3f136f81c1d8a446fb022a7564ac9dbd600d4e2", retry: "cb5e1530f5defd435cd12d498c03be04c764c9b08b71bc10e18b2d95dfd2ee6f" },
    "bypass-enabled": { policy: "dec3b8fcab2332d7a0d7688cd93d6980a087b9695064c7eb0d904b96596c2df5", retry: "35d3208c6836271ea0611cfb7fada4b6fcd45d154b9d559dbe3c797b58794303" },
  };
  for (const strategy of STRATEGIES) {
    const calls = [];
    // The local per-call deadline is a client option, never sent upstream; the
    // pinned digest covers the request messages and phase byte for byte.
    await createLunaJudge({ async complete(messages, { timeoutMs, ...options }) {
      assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
      calls.push({ messages, options });
      return { text: calls.length === 1 ? "invalid-json" : JSON.stringify(SAFE_JUDGMENT) }; } })
      .judge({ version: 1, strategy, publicHistory: [{ role: "user", content: "こんにちは" }], ownLedger: createOwnLedger() });
    assert.equal(digest(JUDGE_POLICIES[strategy]), baseline[strategy].policy);
    assert.equal(digest(JSON.stringify(calls)), baseline[strategy].retry);
  }
});

for (const memory of [false, true]) test(`new v2 trigger/holistic contract is strategy-common and supplied to actual judge requests (memory=${memory})`, async () => {
  const left = await capture({ memory, strategy: "repair-first" }), right = await capture({ memory, strategy: "bypass-enabled" });
  const withoutPolicy = (messages) => messages.filter((message) => !Object.values(JUDGE_POLICIES).includes(message.content));
  assert.deepEqual(withoutPolicy(left.requests[0].messages), withoutPolicy(right.requests[0].messages));
  for (const captured of [left, right]) {
    const [task, policy, judge] = captured.requests[0].messages.map((message) => message.content);
    assert.equal(task, TASK_INSTRUCTIONS_V2); assert.ok(Object.values(JUDGE_POLICIES).includes(policy));
    for (const trigger of triggers) { assert.ok(task.includes(trigger)); assert.ok(judge.includes(trigger)); }
    assert.match(task, /内部に候補が複数残るだけでは、confirmや特徴の説明を始めない/);
    assert.match(judge, /内部の候補数だけはトリガーではありません/);
    assert.match(judge, /discriminatingFeatureは原則null/);
    assert.match(judge, /全体の見立てと結び付けて理解を表し/);
    assert.doesNotMatch(task + judge, /説明に合う候補が2つ以上ある|識別特徴1つ（discriminatingFeature）で短く示し|agreeにdiscriminatingFeatureを入れて特徴を短く添える/);
    assert.equal(captured.output.discriminatingFeature, null);
  }
});

test("bare-backchannel agreement binds the immediate naming proposal to a partner-introduced/accepted target", async () => {
  const ownLedger = createOwnLedger(ids); ownLedger[ids[0]] = { status: "tentative", name: "鳥" };
  const history = [{ role: "user", content: "鳥っぽい形があるよ。" }, { role: "assistant", content: "私にも鳥のように見えます。『鳥』と呼びましょうか？" }, { role: "user", content: "はい。" }];
  const { requests, output } = await capture({ ownLedger, publicHistory: history, result: { ...proposal, action: "agree" } });
  const prompt = requests[0].messages[2].content;
  assert.match(prompt, /自分の直前の名称提案が相手が導入または受け入れた対象について/);
  assert.match(prompt, /その提案への受入れと読め、公開対話に曖昧さや矛盾が残っていない/);
  assert.match(prompt, /対象や名称採用の意思が不明ならaccept/);
  assert.match(prompt, /識別特徴の付加は条件ではありません/);
  assert.equal(output.action, "agree"); assert.equal(output.discriminatingFeature, null);
  assert.deepEqual(requests[0].messages.slice(-history.length), history);
});

test("unassigned/deferred agree still rejects and its retry no longer forces an analytic feature", async () => {
  for (const status of ["unassigned", "deferred"]) {
    const ownLedger = createOwnLedger(ids);
    if (status === "deferred") ownLedger[ids[0]] = { status, name: "鳥" };
    const { requests, output } = await capture({ ownLedger, responses: [{ ...proposal, action: "agree" }, proposal] });
    assert.equal(requests.length, 2); assert.equal(output.action, "propose_name"); assert.equal(output.discriminatingFeature, null);
    const retry = requests[1].messages.at(-1).content;
    assert.match(retry, /agree_requires_shared_identification/);
    assert.match(retry, /discriminatingFeatureは原則null/);
    assert.match(retry, /分析トリガーがあるときだけ1特徴/);
    assert.doesNotMatch(retry, /識別特徴1つを添えたpropose_name/);
    assert.throws(() => validateJudgment({ ...proposal, action: "agree" }, { ownLedger, agreeEvidence: true }), { code: "agree_requires_shared_identification" });
  }
});

test("explicit difficulty/detail/contradiction and pre-agreement risk keep typed confirm available with one feature", async () => {
  for (const text of ["似た形があって迷っています。", "くぼみはありますか、詳しく教えて。", "さっきの形とは違うと思います。", "名前を決めたいけど、どちらの形かまだ分からない。"]) {
    const result = { ...proposal, action: "confirm", discriminatingFeature: "くぼみが一つある" };
    const { requests, output } = await capture({ publicHistory: [{ role: "user", content: text }], result });
    assert.deepEqual(output, result);
    assert.match(requests[0].messages[2].content, /一度に1特徴ずつ/);
  }
  assert.throws(() => validateJudgment({ ...proposal, action: "confirm" }, { ownLedger: createOwnLedger(ids), agreeEvidence: true }), /inconsistent_action/);
});

test("generator gets holistic/no-invented-counts guidance without changing final typed actions or strategy inputs", async () => {
  assert.doesNotMatch(GENERATOR_INSTRUCTIONS_V2, /複数候補が残る/);
  for (const trigger of triggers) assert.ok(GENERATOR_INSTRUCTIONS_V2.includes(trigger));
  assert.match(GENERATOR_INSTRUCTIONS_V2, /discriminatingFeature があるときだけ/);
  assert.match(GENERATOR_INSTRUCTIONS_V2, /内部に候補が複数残るだけでは分析を始めない/);
  const outputs = [];
  for (const strategy of STRATEGIES) {
    const calls = [];
    const session = createDialogueV2({ strategy, image, anchors, judge: { async judge() { return proposal; } },
      client: { async complete(messages, options) { calls.push({ messages, options }); return { text: "鳥のように見えますね。" }; } } });
    const result = await session.runAiTurn({ events: [{ id: "event-1", seq: 1, speaker: "human", text: "鳥っぽい形があるよ。" }],
      lastEventId: "event-1", privateState: session.initialPrivateState(), signal: new AbortController().signal });
    assert.equal(result.privateState.ledger[ids[0]].status, "tentative");
    assert.equal(result.privateState.judgments[0].judgment.discriminatingFeature, null);
    assert.equal(calls[0].messages[1].content, GENERATOR_INSTRUCTIONS_V2);
    assert.match(calls[0].messages[1].content, /discriminatingFeatureがないときは、相手の見立てを短く受け止め/);
    assert.match(calls[0].messages[1].content, /判断にない尖り・四角・くぼみなどの形の数や特徴を作って補わない/);
    assert.match(calls[0].messages[1].content, /discriminatingFeatureがあるときは、質問にせず、その特徴に短く触れて/);
    outputs.push({ calls, result });
  }
  assert.deepEqual(outputs[0], outputs[1]);
});
