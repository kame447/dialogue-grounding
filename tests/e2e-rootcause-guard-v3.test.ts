// Problem 2 (2026-11-24 E2E): an unresolved issue must not be put off under non-defer/move_on acts.
// Local mocks only; no model or network access.
import test from "node:test";
import assert from "node:assert/strict";
import { findAgreeNameMismatch, findDeferralClaims, findGuardViolations, rewriteReasons } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";

type Action = "accept" | "propose_name" | "confirm" | "agree" | "repair" | "defer" | "revisit" | "move_on" | "close";
type Message = { role: string; content: unknown };
const NON_DEFERRING: Action[] = ["accept", "propose_name", "confirm", "agree", "repair", "revisit", "close"];

const PROPOSALS = [
  "「灯台」という名前はよさそうですが、どの形のことか絞れていないので、いったん保留にしましょう。",
  "「風車」は分かりやすい呼び方ですね。まだ一つに絞れていないので、名前を決めるのは少し待ちたいです。",
  "この形は保留にしておきましょう。", "保留にしたいです。", "それは後回しにしましょう。", "後回しにします。", "いったん飛ばしましょう。",
  "ひとまず置いておきましょう。", "いったん保留にしましょうか？", "後回しにしてもいいですか？", "名前を決めるのは後回しにしたいです。",
  "名前を付けるのはあとでにしましょう。", "未解決のまま次に進みましょう。", "分からないので、次の図形に進みましょう。",
  "決められないから別の図形を見ましょう。", "先送りにしましょう。", "この図形はあとで考えましょう。次の形を見ましょう。",
  "この形を先送りにしましょう。",
];
const BOUNDARIES = [
  "「保留」ではなく、もう少し特徴を確かめましょう。", "保留にせず、このまま確認しましょう。", "後回しにはしません。",
  "保留にしていた「灯台」の図形に戻りましょう。", "さっき保留にした形の続きですね。",
  "ありがとうございます。では次は、「時計」のように見える形を見てみましょう。", "決まりですね、次の図形に進みましょう。",
  "まだ一つに絞れていないので、輪の近くに四角い部分があるか教えてください。",
  "相手が「いったん保留にしましょう」と言っていましたね。", "「灯台」と呼ぶのはどうでしょう？", "尖りが二つある形のことですか？",
];

test("unsolicited deferral proposals are detected under every non-defer/move_on action", () => {
  for (const text of PROPOSALS) {
    assert.deepEqual(findDeferralClaims(text), ["unsolicited_deferral"], text);
    for (const action of NON_DEFERRING) assert.ok(findGuardViolations(text, action).includes("unsolicited_deferral"), `${action}: ${text}`);
  }
});

test("defer and move_on keep the legitimate put-off; quotes, negation, revisit and natural next-figure moves pass", () => {
  for (const text of PROPOSALS) for (const action of ["defer", "move_on"] as Action[]) {
    assert.ok(!findGuardViolations(text, action).includes("unsolicited_deferral"), `${action}: ${text}`);
  }
  for (const text of BOUNDARIES) {
    assert.deepEqual(findDeferralClaims(text), [], text);
    assert.ok(!findGuardViolations(text, "accept").includes("unsolicited_deferral"), text);
  }
});

test("retry reason names the deferral rule and does not echo the draft", () => {
  const reason = rewriteReasons(["unsolicited_deferral"]);
  assert.match(reason, /保留や先送りを提案/u);
  assert.doesNotMatch(reason, /灯台/u);
});

const ids = Array.from({ length: 6 }, (_, i) => `s-00${i}a`);
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const events = [{ id: "e-1", seq: 1, speaker: "human", text: "じゃあその形は「灯台」と呼びましょうか？" }];

function setup(action: Action, replies: { text: string }[], technicalTrial?: unknown) {
  const calls: Message[][] = [];
  const raw = { ...SAFE_JUDGMENT, action, targetSlot: ids[0], candidateName: action === "accept" ? null : "灯台", discriminatingFeature: action === "confirm" ? "輪" : null };
  const dialogue = createDialogueV2({ strategy: "repair-first", image, anchors, judge: { async judge() { return raw; } },
    client: { async complete(messages: Message[]) { calls.push(structuredClone(messages)); return replies[Math.min(calls.length - 1, replies.length - 1)]; } } });
  const state = dialogue.initialPrivateState();
  return { calls, run: () => dialogue.runAiTurn({ events, lastEventId: "e-1", privateState: state, signal: new AbortController().signal, ...(technicalTrial ? { technicalTrial } : {}) }) };
}

test("accept and confirm drafts that defer are regenerated once and the compliant retry is published", async () => {
  for (const [action, draft, retry] of [["accept", PROPOSALS[0], "「灯台」ですね、見え方を教えてください。"],
    ["confirm", PROPOSALS[1], "輪がある形のことですか？"]] as const) {
    const s = setup(action, [{ text: draft }, { text: retry }]);
    const result = await s.run();
    assert.equal(result.text, retry, action); assert.equal(s.calls.length, 2, action);
    assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: ["unsolicited_deferral"], regenerated: true, fallback: false }, action);
    const prompt = String(s.calls[1].at(-1)!.content);
    assert.match(prompt, /保留・先送りを提案せず/u); assert.doesNotMatch(prompt, /いったん保留|少し待ちたい/u);
  }
});

test("defer publishes its own deferral unchanged with one call", async () => {
  const s = setup("defer", [{ text: "この形はいったん保留にしましょう。" }]);
  const result = await s.run();
  assert.equal(result.text, "この形はいったん保留にしましょう。"); assert.equal(s.calls.length, 1);
  assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: [], regenerated: false, fallback: false });
});

test("boundary cases: whole-violation arrays are empty for allowed wording", () => {
  const allowed: Array<[Action, string]> = [
    ["defer", "この形を先送りにしましょう。"], ["move_on", "この形を先送りにしましょう。"],
    ["revisit", "前に保留にしておきましたが、同じ図形に戻りましょう。"],
    ["confirm", "名前を決めるのは後回しにしません。突起は二つですか？"],
    ["confirm", "名前を決めるのは少し待ちたいです。この図形の小さい突起は片側ですか？"],
    ["defer", "この形の話には、あとで戻りたいです。"], ["move_on", "この形の話には、あとで戻りたいです。"],
    ["accept", "ありがとうございます。では次は、「灯台」のように見える形を見てみましょう。"],
  ];
  for (const [action, text] of allowed) assert.deepEqual(findGuardViolations(text, action), [], `${action}: ${text}`);
  assert.deepEqual(findGuardViolations("この図形はあとで考えましょう。次の形を見ましょう。", "confirm"), ["unsolicited_deferral"]);
  assert.deepEqual(findGuardViolations("「灯台」は分かりやすい呼び方ですね。まだ一つに絞れていないので、名前を決めるのは少し待ちたいです。", "confirm"), ["unsolicited_deferral"]);
  assert.deepEqual(findGuardViolations("この形は保留にしましょう。突起は二つですか？", "confirm"), ["unsolicited_deferral"]);
});

test("later-return and other-figure move questions are not confirmation of the same figure", () => {
  assert.deepEqual(findGuardViolations("名前を決めるのは少し待ちたいです。次の図形に移りませんか？", "confirm"), ["unsolicited_deferral"]);
  assert.deepEqual(findGuardViolations("名前を決めるのは少し待ちたいです。この図形の突起は片側ですか？", "confirm"), []);
  assert.deepEqual(findGuardViolations("この形の話には、あとで戻りたいです。", "accept"), ["unsolicited_deferral"]);
});

test("agree wording must adopt the judged name", () => {
  const mismatch = ["前の形が「灯台」でしたね。この形は「風車」と呼びましょう。", "前の形が「灯台」でしたが、この形は「風車」と呼びましょう。"];
  for (const text of mismatch) assert.deepEqual(findAgreeNameMismatch(text, "灯台"), ["name_mismatch"], text);
  for (const text of ["前の形が「風車」でしたね。この形は「灯台」と呼びましょう。", "「風車」ではなく「灯台」にしましょう。",
    "はい、「灯台」と呼びましょう。", "はい、この形は「灯台」ですね。"]) assert.deepEqual(findAgreeNameMismatch(text, "灯台"), [], text);
  for (const text of ["前の形が「灯台」でしたね。この形の名前は「風車」に決めました。", "前の形が「灯台」でしたね。この形の名前は「風車」です。",
    "前の形が「灯台」でしたね。この形は「風車」です。"]) assert.deepEqual(findAgreeNameMismatch(text, "灯台"), ["name_mismatch"], text);
  for (const text of ["前の形が「風車」でしたね。この形の名前は「灯台」に決めました。", "前の形が「風車」でしたね。この形の名前は「灯台」です。",
    "前の形の名前は「風車」です。この形の名前は「灯台」です。", "前の形は「風車」に決めました。この形は「灯台」です。",
    "さっきの形は「風車」にしました。この形は「灯台」と呼びましょう。",
    "「風車」ではなく「灯台」と呼びましょう。", "はい、この形は「灯台」です。"]) assert.deepEqual(findAgreeNameMismatch(text, "灯台"), [], text);
  assert.deepEqual(findAgreeNameMismatch("はい、そう呼びましょう。", "灯台"), ["name_not_shown"]);
  assert.deepEqual(findAgreeNameMismatch("はい、呼びましょう。", "  "), []);
  assert.match(rewriteReasons(["name_mismatch"]), /別の名前/u);
  assert.equal(rewriteReasons(["naming_decision"]), "前の下書きは名称の決定・合意を表していました。決定・合意を表明せず、このactionの範囲で書き直してください。");
});
