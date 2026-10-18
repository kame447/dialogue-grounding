import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLunaJudge } from "../dialogue-model/runtime/judgment/luna.mjs";
import { TASK_INSTRUCTIONS, TASK_INSTRUCTIONS_V2, taskInstructionsFor, JUDGE_POLICIES, STRATEGIES } from "../dialogue-model/runtime/judgment/instructions.mjs";
import { SAFE_JUDGMENT, createOwnLedger, applyJudgment, validateJudgment } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";

// Synthetic public turns and images only. These capture the requested policy;
// canned responses do not establish a real model's conversational behavior.
const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const CANARY = "SYNTHETIC_RESEARCHER_ONLY_GOLD_FIGURE_ID";
const NOTE = "SYNTHETIC_OWN_NOTE";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const same = (a, b, message) => assert.ok(JSON.stringify(a) === JSON.stringify(b), message);

async function capture({ version = 2, strategy = "repair-first", memory = false,
  text = "よろしくお願いします。どれから話しましょうか。", result = SAFE_JUDGMENT,
  ownLedger = createOwnLedger(), ownJudgmentHistory = [] } = {}) {
  const requests = [];
  const judge = createLunaJudge({ async complete(messages, options) {
    requests.push({ messages: structuredClone(messages), options });
    return { text: JSON.stringify({ ...result, ...(memory ? { reference: null } : {}) }) };
  } });
  const graph = createReferenceGraph(), graphBefore = structuredClone(graph);
  const ledgerBefore = structuredClone(ownLedger);
  const input = { version, strategy, image: { ...image, humanImage: CANARY, figureId: CANARY },
    publicHistory: [{ role: "user", content: text, goldAnnotation: CANARY, futureHistory: CANARY }],
    ownLedger, ownJudgmentHistory, answerKey: CANARY,
    ...(memory ? { referenceContext: { graph, turn: 1, publicTurns: [
      { turn: 1, speaker: "human", text, goldAnnotation: CANARY },
    ] } } : {}) };
  const output = await judge.judge(input);
  assert.equal(requests.length, 1, "valid typed judgments must need no retry");
  same(graph, graphBefore, "judging must not commit reference memory");
  same(ownLedger, ledgerBefore, "judging must not mutate own notes");
  return { messages: requests[0].messages, output, diagnostics: judge.getDiagnostics() };
}

test("version selection preserves the exact v1 task and judge prompts and defaults to v1", async () => {
  // Baseline hashes taken from exp/WildBose before this v2 change.
  assert.equal(digest(TASK_INSTRUCTIONS), "eab651c869324c43bb9332b0109f69fe7751a85753c800182fa49a997f271ae4");
  assert.equal(taskInstructionsFor(), TASK_INSTRUCTIONS);
  assert.equal(taskInstructionsFor(1), TASK_INSTRUCTIONS);
  assert.equal(taskInstructionsFor(2), TASK_INSTRUCTIONS_V2);
  for (const version of [0, 3, null, "2", true]) assert.throws(() => taskInstructionsFor(version), /Unsupported task version/);
  const explicit = await capture({ version: 1 });
  assert.equal(digest(explicit.messages[2].content), "291d643303a9cae3b96d4659bf4355421bd033924ede827c90e9ede012b3eadb");
  let defaultMessages;
  await createLunaJudge({ async complete(messages) { defaultMessages = messages; return { text: JSON.stringify(SAFE_JUDGMENT) }; } })
    .judge({ publicHistory: [], ownLedger: createOwnLedger(), strategy: "repair-first" });
  assert.equal(defaultMessages[0].content, TASK_INSTRUCTIONS);
  assert.equal(defaultMessages[2].content, explicit.messages[2].content);
});

test("unsupported task versions fail before a model request", async () => {
  let calls = 0;
  const judge = createLunaJudge({ async complete() { calls++; } });
  await assert.rejects(judge.judge({ version: "2", strategy: "repair-first", ownLedger: createOwnLedger(), publicHistory: [] }), /Unsupported task version/);
  assert.equal(calls, 0);
});

for (const memory of [false, true]) test(`v2 common policy and evidence are identical across strategies (memory=${memory})`, async () => {
  const left = await capture({ memory, strategy: STRATEGIES[0] });
  const right = await capture({ memory, strategy: STRATEGIES[1] });
  const policy = (message) => message.role === "system" && Object.values(JUDGE_POLICIES).includes(message.content);
  for (const [index, value] of [left, right].entries()) {
    assert.equal(value.messages.filter(policy).length, 1);
    assert.equal(value.messages.find(policy).content, JUDGE_POLICIES[STRATEGIES[index]]);
    assert.equal(JUDGE_POLICIES[STRATEGIES[index]].split("\n").length, 4);
    assert.equal(value.messages[0].content, TASK_INSTRUCTIONS_V2);
    const task = value.messages[0].content, judge = value.messages[2].content;
    assert.match(task, /まず全体の印象・身近なものへの見立て/);
    assert.match(task, /毎発話で名称を決めたり、幾何学的な特徴を添えたりする必要はありません/);
    assert.match(task, /まず自分の画像に対応しそうな対象があるか/);
    assert.match(task, /説明・識別に明示的に迷うか詳細・確認を求める/);
    assert.match(task, /候補が2つ以上ある/);
    assert.match(task, /前の食い違いが未解決/);
    assert.match(task, /取り違えの疑いが名称の重複・付け替えや最終対応に影響/);
    assert.match(task, /確認・修復をするか保留するかは方略に従って/);
    assert.match(task, /挨拶や漠然とした開始の相談だけで/);
    assert.match(task, /不確かさや問い返しを毎回演出せず/);
    assert.match(task, /相槌や似た印象だけから、同じ対象・名称への合意を作らない/);
    assert.match(judge, /曖昧さや食い違いの根拠がなければconfirmを挟まず/);
    assert.match(judge, /discriminatingFeature=nullで短い全体の見立て/);
    assert.match(judge, /型の制約としてdiscriminatingFeatureが必要/);
    assert.match(judge, /確認自体や画像にない特徴を作らない/);
    assert.match(judge, /propose_nameやfollowUpを作らない/);
    assert.match(task, /見立ての共有、対象の同定、名称への合意は別の段階/);
    assert.match(task, /毎回確認の質問をする必要はありません/);
    assert.match(judge, /相手が述べた形の特徴が自分の対象に実際にあるか/);
    assert.equal(JSON.stringify(value.messages).includes("ownReferences"), memory);
  }
  same(left.messages.filter((m) => !policy(m)), right.messages.filter((m) => !policy(m)),
    "strategy changes must affect only the four-line strategy policy");
});

for (const strategy of STRATEGIES) for (const memory of [false, true]) {
  test(`v2 retains typed brief acceptance, proposal, agreement and contrastive confirmation (${strategy}, memory=${memory})`, async () => {
    const slot = Object.keys(createOwnLedger())[0];
    const cases = [
      { text: "まずどう進めましょうか。", result: { ...SAFE_JUDGMENT, note: NOTE } },
      { text: "風車っぽく見える形があります。", result: { ...SAFE_JUDGMENT, targetSlot: slot, note: NOTE } },
      { text: "そちらから一つ名前を提案してください。", result: { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: slot, candidateName: "風車", note: NOTE } },
      // A partner's name for a new target is kept as a candidate while the AI shows which figure it means.
      { text: "羽が四つある形を風車と呼びませんか。", result: { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: slot, candidateName: "風車",
        discriminatingFeature: "尖りが四つある", note: NOTE } },
      { text: "似た形が二つあって迷っています。くぼみはありますか。", result: { ...SAFE_JUDGMENT,
        action: "confirm", targetSlot: slot, candidateName: "風車", discriminatingFeature: "輪郭にくぼみがある", note: NOTE } },
    ];
    for (const scenario of cases) {
      const { output } = await capture({ ...scenario, strategy, memory });
      same(output, { ...scenario.result, ...(memory ? { reference: null } : {}) }, "typed result and private note must be preserved");
      const ledger = applyJudgment(createOwnLedger(), output);
      const status = output.action === "agree" ? "agreed" : ["propose_name", "confirm"].includes(output.action) ? "tentative" : "unassigned";
      assert.equal(ledger[slot].status, status);
      if (output.action === "accept") assert.equal(ledger[slot].name, null, "reception is not a naming agreement");
    }
    for (const discriminatingFeature of [null, "尖りが四つある"]) assert.throws(() => validateJudgment({ ...SAFE_JUDGMENT, action: "agree", targetSlot: slot,
      candidateName: "風車", discriminatingFeature }, { agreeEvidence: true }), /agree_requires_shared_identification/,
      "v2 never agrees in the same turn a target is first identified");
    assert.throws(() => validateJudgment({ ...SAFE_JUDGMENT, action: "confirm", targetSlot: slot }),
      "v2 must retain the typed discriminating-feature requirement when confirm is actually selected");
  });
}

test("v2 drops unauthorized metadata, keeps own notes private, and does not invent public location labels or figure IDs", async () => {
  const ownLedger = createOwnLedger(), slot = Object.keys(ownLedger)[0];
  ownLedger[slot] = { status: "tentative", name: "風車" };
  for (const memory of [false, true]) {
    const { messages } = await capture({ memory, ownLedger,
      ownJudgmentHistory: [{ action: "propose_name", targetSlot: slot, candidateName: "風車", figureId: CANARY }] });
    const serialized = JSON.stringify(messages);
    assert.ok(!serialized.includes(CANARY), "caller-only metadata must never enter model requests");
    assert.ok(!/repair-first|bypass-enabled|goldAnnotation|futureHistory|answerKey/.test(serialized), "condition labels and researcher data stay out");
    const working = messages.find((m) => typeof m.content === "string" && m.content.startsWith("AI自身の作業メモ"));
    assert.ok(working, "own ledger and judgment history must remain available as private working state");
    const state = JSON.parse(working.content.slice(working.content.indexOf("{")));
    same(state.ownLedger, ownLedger, "own ledger must be preserved");
    assert.equal(state.ownJudgmentHistory[0].targetSlot, slot);
    assert.match(messages[0].content, /内部参照ID・位置名・画像座標を相手への発話に出さず/);
    assert.match(messages[2].content, /ownLedgerのキー/);
    const instructions = messages.filter((m) => m.role === "system" && m !== working &&
      !m.content.includes('"ownReferences":')).map((m) => m.content).join("\n");
    assert.ok(!/上段左|上段中|上段右|下段左|下段中|下段右|2段3列|\bF[1-6]\b/.test(instructions),
      "v2 instructions must not assert legacy positions or researcher figure identifiers");
    assert.equal(messages.at(-1).role, "user");
  }
});
