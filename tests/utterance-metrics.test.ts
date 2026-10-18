// Offline utterance diagnostics: lexical heuristics over public text only.
import test from "node:test";
import assert from "node:assert/strict";
import { measureUtterance, classifySentence, splitSentences, auditTurn, summarize, aiTurnsFromRecord, humanTexts } from "../dialogue-model/runtime/v2/utterance-metrics.ts";

test("sentences get one primary function each; acknowledgements do not count", () => {
  assert.deepEqual(splitSentences("いいですね。鳥みたいです！どれですか？"), ["いいですね", "鳥みたいです", "どれですか?"]);
  const cases: [string, string][] = [["なるほど", "ack"], ["「鳥」ですね", "ack"], ["家みたいな形がありますね", "share"],
    ["尖りが二つある形のことですか?", "ask"], ["「鳥」と呼ぶのはどうでしょう?", "propose"], ["では「鳥」と呼びましょう", "decide"],
    ["すみません、取り違えていました", "repair"], ["この形はあとで戻りましょう", "defer"], ["次の形を見てみましょう", "move_on"],
    ["そろそろ終わりにしましょうか?", "close"]];
  for (const [sentence, fn] of cases) assert.equal(classifySentence(sentence), fn, sentence);
  const m = measureUtterance("はい、くちばしのように尖った部分がある形ですね。「鳥の頭」と呼びましょう。");
  assert.deepEqual(m.functions, ["share", "decide"]); assert.equal(m.functionCount, 2);
  assert.equal(measureUtterance("いいですね。私の画像にも鳥みたいな形があります。").functionCount, 1);
  assert.equal(measureUtterance("ありがとうございます。").functionCount, 0);
});

test("length, analytic density and orientation terms", () => {
  const m = measureUtterance("左側の三角の尖りがある形");
  assert.equal(m.chars, 12); assert.equal(m.orientationTerms, 1); assert.ok(m.analyticTerms >= 2);
  assert.equal(measureUtterance(" 鳥 ").chars, 1);
  assert.throws(() => measureUtterance(null as unknown as string));
});

test("agreement consistency: public decision wording under non-agree, and silent agree", () => {
  assert.equal(auditTurn({ text: "「鳥」と呼びましょう。", action: "accept" }).publicOnlyAgreement, true);
  assert.equal(auditTurn({ text: "「鳥」と呼びましょう。", action: "agree" }).publicOnlyAgreement, false);
  assert.equal(auditTurn({ text: "鳥ですね。", action: "agree" }).ledgerOnlyAgreement, true);
  assert.equal(auditTurn({ text: "「鳥」でいいですか？", action: "confirm" }).publicOnlyAgreement, false);
  const s = summarize([auditTurn({ text: "鳥。", action: "accept" }), auditTurn({ text: "鳥と呼びましょう。猫は？", action: "accept" })]);
  assert.equal(s.turns, 2); assert.equal(s.publicOnlyAgreement, 1); assert.equal(s.multiFunctionShare, 0.5); assert.equal(s.nonAgreeTurns, 2);
  assert.equal(summarize([]).medianChars, null);
});

test("records pair committed judgments with the following AI text (v2 events and v1 history)", () => {
  const v2 = {
    events: [{ speaker: "ai", seq: 1, text: "まず、どの図形から話しましょうか？", origin: "scripted_opening" },
      { speaker: "human", seq: 2, text: "鳥" }, { speaker: "human", seq: 3, text: "鳥っぽい" }, { speaker: "ai", seq: 4, text: "鳥みたいですね。" }],
    judgments: [{ turnIndex: 3, judgment: { action: "accept", followUp: { action: "move_on" } } }],
  };
  assert.deepEqual(aiTurnsFromRecord(v2), [{ text: "鳥みたいですね。", action: "accept", followUpAction: "move_on" }]);
  assert.deepEqual(humanTexts(v2), ["鳥", "鳥っぽい"]);
  const v1 = { publicHistory: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], judgments: [{ turnIndex: 1, judgment: { action: "confirm" } }] };
  assert.deepEqual(aiTurnsFromRecord(v1), [{ text: "b", action: "confirm", followUpAction: null }]);
  assert.deepEqual(aiTurnsFromRecord({}), []);
});
