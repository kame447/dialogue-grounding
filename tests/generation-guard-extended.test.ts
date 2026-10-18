// Always-on guard extensions: self-repair wording only under repair, and no
// internal ids/fields/JSON under any action. Local mocks only.
import test from "node:test";
import assert from "node:assert/strict";
import { findRepairClaims, findInternalLeaks, findGuardViolations, fallbackUtterance, rewriteReasons } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { createDialogueV2, ACTION_SCOPE_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { SAFE_JUDGMENT, applyJudgment } from "../dialogue-model/runtime/judgment/schema.mjs";

type Action = "accept" | "propose_name" | "confirm" | "agree" | "repair" | "defer" | "revisit" | "move_on" | "close";
type Message = { role: string; content: unknown };
const ACTIONS: Action[] = ["accept", "propose_name", "confirm", "agree", "repair", "defer", "revisit", "move_on", "close"];
const ids = Array.from({ length: 6 }, (_, i) => `s-00${i}a`);
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const events = [{ id: "e-1", seq: 1, speaker: "human", text: "鳥みたいですね。" }];

test("self-repair declarations are detected clause-locally", () => {
  for (const text of ["すみません、訂正します。", "私の取り違えでした。", "間違えました、猫のほうです。", "さっきのは私の勘違いでした。", "さっきのは違いました。",
    "前の名前は取り消します。", "あれは撤回させてください。", "私の間違いです。どれのことですか？", "取り違えていました。いいですか？",
    "さっきの名前はいったん取り消します。", "私の見間違いでした。", "そう言ったのは私の誤りでした。", "その対応は取り消させてください。"]) {
    assert.deepEqual(findRepairClaims(text), ["self_repair"], text);
  }
});

test("legitimate holistic, proposal, question and partner-directed replies are not repair claims", () => {
  for (const text of ["鳥みたいに見えますね。", "「鳥」と呼ぶのはどうでしょう？", "訂正ありがとうございます。", "間違いないですか？",
    "間違えていたらすみません。", "取り違えないように確認させてください。", "それは勘違いですか？", "訂正しますか？",
    "なるほど、家っぽい形ですね。", "尖りが二つある形のことですか？", "この形の話には、あとで戻りたいです。",
    "それは誤りですか？", "誤りではないと思います。", "間違えやすい形ですね。",
    "それは違います。", "その見立ては誤りです。", "それは勘違いですね。", "訂正です。", "そちらの間違いではないです。", "[A:注意]"]) {
    assert.deepEqual(findGuardViolations(text, "accept"), [], text);
  }
});

test("internal ids, field names and JSON leak under every action, plain chat does not", () => {
  for (const action of ACTIONS) {
    assert.deepEqual(findGuardViolations("s-3f2a の形のことです。", action).filter((c) => c.startsWith("internal_")), ["internal_id"]);
    assert.ok(findGuardViolations('{"action":"accept"}', action).includes("internal_field"));
    assert.ok(findGuardViolations("targetSlotは決めていません。", action).includes("internal_field"));
  }
  for (const text of ["Sサイズくらいの小さい形です。", "S字みたいですね。", "Lの字に曲がっています。", "OKです、いい感じですね。"]) {
    assert.deepEqual(findInternalLeaks(text), [], text);
  }
});

test("self-repair is allowed under repair; agreement under agree; leaks never", () => {
  assert.deepEqual(findGuardViolations("すみません、訂正します。", "repair"), []);
  assert.deepEqual(findGuardViolations("すみません、訂正します。", "revisit"), ["self_repair"]);
  assert.deepEqual(findGuardViolations("「鳥」と呼びましょう。", "agree"), []);
  assert.deepEqual(findGuardViolations("「鳥」と呼びましょう。s-001a", "agree"), ["internal_id"]);
});

test("deferral wording (保留／後回しにしましょう) is not a name selection; a name still is", () => {
  for (const text of ["「船」はいったん保留にしましょう。", "猫はひとまず保留にしましょう。", "それは後回しにしましょう。"]) {
    assert.deepEqual(findGuardViolations(text, "defer"), [], text);
  }
  assert.deepEqual(findGuardViolations("「保留」にしましょう。", "defer"), ["name_selection"]);
  assert.deepEqual(findGuardViolations("保留にしましょう。「船」にしましょう。", "defer"), ["name_selection"]);
});

test("fixed fallbacks pass their own action and reject hostile bounded fields", () => {
  for (const action of ACTIONS) {
    const text = fallbackUtterance({ action, candidateName: "鳥", discriminatingFeature: "尖り" });
    assert.deepEqual(findGuardViolations(text, action), [], `${action}: ${text}`);
  }
  for (const feature of ["s-001a", "targetSlot", "私の勘違いでした"]) {
    const text = fallbackUtterance({ action: "confirm", candidateName: null, discriminatingFeature: feature });
    assert.equal(text, "どの形のことか、もう少し教えてもらえますか？");
  }
  assert.equal(fallbackUtterance({ action: "propose_name", candidateName: "s-001a", discriminatingFeature: null }), "その名前の候補はどうでしょう？");
});

test("agreement-only retry reason keeps the previously audited wording", () => {
  assert.equal(rewriteReasons(["naming_decision"]), "前の下書きは名称の決定・合意を表していました。決定・合意を表明せず、このactionの範囲で書き直してください。");
  assert.match(rewriteReasons(["self_repair", "internal_id"]), /訂正.*内部の参照ID/u);
  assert.equal(rewriteReasons([]), "");
});

function setup(action: Action, replies: { text: string }[], strategy = "repair-first") {
  const calls: Message[][] = [];
  const raw = { ...SAFE_JUDGMENT, action, targetSlot: ["move_on", "close", "accept"].includes(action) ? null : ids[0],
    candidateName: ["accept", "close", "move_on"].includes(action) ? null : "鳥", discriminatingFeature: action === "confirm" ? "尖り" : null };
  const dialogue = createDialogueV2({ strategy, image, anchors, judge: { async judge() { return raw; } },
    client: { async complete(messages: Message[]) { calls.push(structuredClone(messages)); return replies[Math.min(calls.length - 1, replies.length - 1)]; } } });
  const state = dialogue.initialPrivateState();
  state.ledger[ids[0]] = { status: "tentative", name: "鳥" };
  return { calls, raw, state, run: () => dialogue.runAiTurn({ events, lastEventId: "e-1", privateState: state, signal: new AbortController().signal }) };
}

test("normal mode publishes compliant output unchanged with one call, for every action", async () => {
  const replies: Record<Action, string> = { accept: "鳥みたいに見えますね。", propose_name: "「鳥」と呼ぶのはどうでしょう？", confirm: "尖りが二つある形のことですか？",
    agree: "では「鳥」と呼びましょう。", repair: "すみません、訂正します。猫のほうでした。", defer: "この形はあとで戻りましょう。",
    revisit: "さっきの形に戻ってもいいですか？", move_on: "ほかの形も見てみましょうか。", close: "そろそろ終わりにしましょうか？" };
  for (const action of ACTIONS) {
    const s = setup(action, [{ text: replies[action] }]); const result = await s.run();
    assert.equal(result.text, replies[action], action); assert.equal(s.calls.length, 1, action);
    assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: [], regenerated: false, fallback: false });
  }
});

test("self-repair under non-repair regenerates once with a reason; ledger follows the judgment", async () => {
  const s = setup("accept", [{ text: "すみません、取り違えていました。鳥ですね。" }, { text: "鳥みたいですね。" }]);
  const result = await s.run();
  assert.equal(result.text, "鳥みたいですね。"); assert.equal(s.calls.length, 2);
  assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: ["self_repair"], regenerated: true, fallback: false });
  const retry = String(s.calls[1].at(-1)!.content);
  assert.ok(retry.includes(ACTION_SCOPE_V2.accept)); assert.match(retry, /訂正を表明せず/u); assert.doesNotMatch(retry, /取り違えていました|鳥ですね/u);
  assert.deepEqual(result.privateState.ledger, applyJudgment(s.state.ledger, s.raw));
});

test("leaks under agree are rewritten, and a second leak falls back without retaining the draft", async () => {
  const s = setup("agree", [{ text: "s-000a は「鳥」で決まりですね。" }, { text: '{"targetSlot":"s-000a"}' }]);
  const result = await s.run();
  assert.equal(result.text, fallbackUtterance(s.raw)); assert.equal(s.calls.length, 2);
  assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: ["internal_id", "internal_field"], regenerated: true, fallback: true });
  assert.doesNotMatch(JSON.stringify(result.privateState.judgments), /決まりですね/u);
  assert.equal(result.privateState.ledger[ids[0]].status, "agreed");
});

test("both strategies regenerate and fall back identically for the extended rules", async () => {
  const a = setup("move_on", [{ text: "私の勘違いでした。" }], "repair-first");
  const b = setup("move_on", [{ text: "私の勘違いでした。" }], "bypass-enabled");
  assert.deepEqual(await a.run(), await b.run()); assert.deepEqual(a.calls, b.calls);
});
