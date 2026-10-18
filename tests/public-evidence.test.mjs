import test from "node:test";
import assert from "node:assert/strict";
import { publicTurnsFromHistory, isBareDeictic, literalSpan, quoteAround, groundReference, QUOTE_LIMIT } from "../dialogue-model/runtime/judgment/public-evidence.mjs";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";

const history = (...pairs) => pairs.flatMap(([human, ai]) => [{ role: "user", content: human }, ...(ai === undefined ? [] : [{ role: "assistant", content: ai }])]);
const interp = (over = {}) => ({ slots: ["上段左"], epistemic: "grounded", intent: "refer", feature: null, nameAcceptance: null, deferSlot: null, revisitSlot: null, ...over });

// Builds typed graph operations from the helper's materials, as the adapter does.
function ops(turn, g) {
  const out = [];
  if (g.antecedent) out.push({ kind: "mention", id: turn + ":a", ...pick(g.antecedent), antecedent: null });
  out.push({ kind: "mention", id: turn + ":h", ...pick(g.human), antecedent: g.antecedent ? turn + ":a" : null });
  if (g.feature) out.push({ kind: "feature", id: turn + ":f", ...g.feature, mentionId: turn + ":h" });
  if (g.name) out.push({ kind: "name", id: turn + ":n", ...g.name, mentionIds: [turn + ":h"], replaces: null });
  return out;
}
const pick = ({ sourceTurn, speaker, quote, slots, confidence, epistemic, intent }) => ({ sourceTurn, speaker, quote, slots, confidence, epistemic, intent });

test("public turns are numbered by exchange and carry text unchanged", () => {
  assert.deepEqual(publicTurnsFromHistory(history(["a", "b"], ["c"])), [
    { turn: 1, speaker: "human", text: "a" }, { turn: 1, speaker: "ai", text: "b" }, { turn: 2, speaker: "human", text: "c" }]);
  assert.throws(() => publicTurnsFromHistory([{ role: "system", content: "x" }]), TypeError);
});

test("bare acknowledgments and deictics are recognised, contentful replies are not", () => {
  for (const text of ["はい", "はい。", "うん", "それ", "じゃあそれで。", "そうです！", " ええ "]) assert.equal(isBareDeictic(text), true, text);
  for (const text of ["はい、稲妻で", "それは細長いです", "三角が二つ", "いいえ"]) assert.equal(isBareDeictic(text), false, text);
});

test("literal spans map normalised matches back to the original wording", () => {
  assert.deepEqual(literalSpan("じゃあ稲妻で。", "稲妻"), { start: 3, end: 5, text: "稲妻" });
  assert.equal(literalSpan("うさぎにしよう", "ウサギ").text, "うさぎ");
  assert.equal(literalSpan("ＶＩＰ な 形", "vip").text, "ＶＩＰ");
  assert.equal(literalSpan("尖りが二つ", "尖り が二つ").text, "尖りが二つ");
  assert.equal(literalSpan("鳥の頭", "魚"), null);
});

test("quotes stay within the limit and keep the focus span", () => {
  const text = "あ".repeat(200) + "稲妻" + "い".repeat(200);
  const span = literalSpan(text, "稲妻");
  const quote = quoteAround(text, { focus: span });
  assert.equal(quote.length, QUOTE_LIMIT);
  assert.ok(quote.includes("稲妻") && text.includes(quote));
  assert.equal(quoteAround("短い"), "短い");
});

test("a bare yes cannot ground or agree without a single-slot antecedent", () => {
  const turns = publicTurnsFromHistory(history(["はい"]));
  const g = groundReference({ publicTurns: turns, turn: 1, interpretation: interp({ intent: "name_acceptance", nameAcceptance: { slot: "上段左", name: "稲妻" } }) });
  assert.equal(g.human.epistemic, "hypothesis");
  assert.equal(g.name, null);
  assert.deepEqual(g.dropped.map((d) => d.reason).sort(), ["bare_acknowledgment", "bare_deictic_downgraded"]);
});

test("a bare yes after the AI's public proposal stays a hypothesis and records no name", () => {
  const h = history(["どれからにします？", "細長い形を「稲妻」と呼ぶのはどうでしょう？"], ["はい"]);
  const turns = publicTurnsFromHistory(h);
  const g = groundReference({ publicTurns: turns, turn: 2, interpretation: interp({ intent: "name_acceptance", nameAcceptance: { slot: "上段左", name: "稲妻" } }) });
  assert.equal(g.antecedent.speaker, "ai");
  assert.equal(g.antecedent.sourceTurn, 1);
  assert.equal(g.human.epistemic, "hypothesis");
  assert.equal(g.name, null);
  assert.ok(g.dropped.some((d) => d.kind === "name" && d.reason === "bare_acknowledgment"));
  const graph = applyReferenceUpdate(createReferenceGraph(), { expectedRevision: 0, turn: 2, operations: ops(2, g) }, { publicTurns: turns, generationSucceeded: true });
  assert.equal(graph.records.filter((r) => r.kind === "name").length, 0);
  assert.equal(graph.records.find((r) => r.speaker === "human").epistemic, "hypothesis");
});

test("accepting the AI's proposal while repeating the name is grounded and explicit", () => {
  const h = history(["どれからにします？", "細長い形を「稲妻」と呼ぶのはどうでしょう？"], ["はい、稲妻で"]);
  const turns = publicTurnsFromHistory(h);
  const g = groundReference({ publicTurns: turns, turn: 2, interpretation: interp({ intent: "name_acceptance", nameAcceptance: { slot: "上段左", name: "稲妻" } }) });
  assert.equal(g.antecedent, null);
  assert.deepEqual(g.name, { slot: "上段左", name: "稲妻", agreement: "explicit" });
  const graph = applyReferenceUpdate(createReferenceGraph(), { expectedRevision: 0, turn: 2, operations: ops(2, g) }, { publicTurns: turns, generationSucceeded: true });
  assert.equal(graph.records.find((r) => r.kind === "name").agreement, "explicit");
});

test("saying the name while accepting it is explicit and is accepted by the graph", () => {
  const turns = publicTurnsFromHistory(history(["じゃあそれ、イナズマで"]));
  const g = groundReference({ publicTurns: turns, turn: 1, interpretation: interp({ intent: "name_acceptance", nameAcceptance: { slot: "上段左", name: "いなずま" } }) });
  assert.deepEqual(g.name, { slot: "上段左", name: "イナズマ", agreement: "explicit" });
  const graph = applyReferenceUpdate(createReferenceGraph(), { expectedRevision: 0, turn: 1, operations: ops(1, g) }, { publicTurns: turns, generationSucceeded: true });
  assert.equal(graph.records.length, 2);
});

test("features are kept only as literal public spans; paraphrases are dropped", () => {
  const turns = publicTurnsFromHistory(history(["端に小さい四角がある方"]));
  const kept = groundReference({ publicTurns: turns, turn: 1, interpretation: interp({ intent: "feature_assertion", feature: { slot: "上段左", feature: "小さい四角", polarity: "confirmed" } }) });
  assert.deepEqual(kept.feature, { slot: "上段左", feature: "小さい四角", polarity: "confirmed" });
  const graph = applyReferenceUpdate(createReferenceGraph(), { expectedRevision: 0, turn: 1, operations: ops(1, kept) }, { publicTurns: turns, generationSucceeded: true });
  assert.equal(graph.records.length, 2);
  const paraphrase = groundReference({ publicTurns: turns, turn: 1, interpretation: interp({ intent: "feature_assertion", feature: { slot: "上段左", feature: "正方形の突起", polarity: "confirmed" } }) });
  assert.equal(paraphrase.feature, null);
  assert.equal(paraphrase.dropped[0].reason, "not_literal_in_public_text");
});

test("ambiguous references keep several own-slot hypotheses and never invent agreement", () => {
  const turns = publicTurnsFromHistory(history(["ジグザグっぽいの、2つあるかも"]));
  const g = groundReference({ publicTurns: turns, turn: 1, interpretation: interp({ slots: ["上段左", "下段右"], epistemic: "grounded" }) });
  assert.equal(g.human.epistemic, "hypothesis");
  assert.deepEqual(g.human.slots, ["上段左", "下段右"]);
  const graph = applyReferenceUpdate(createReferenceGraph(), { expectedRevision: 0, turn: 1, operations: ops(1, g) }, { publicTurns: turns, generationSucceeded: true });
  assert.equal(graph.records[0].epistemic, "hypothesis");
});

test("defer and revisit focus only on referenced slots", () => {
  const turns = publicTurnsFromHistory(history(["それは後で"]));
  const g = groundReference({ publicTurns: turns, turn: 1, interpretation: interp({ deferSlot: "上段左", revisitSlot: "下段中" }) });
  assert.deepEqual(g.focus, [{ slot: "上段左", mode: "defer" }]);
  assert.equal(g.dropped.find((d) => d.kind === "focus").reason, "slot_not_referenced");
});

test("missing human turn yields no materials", () => {
  const g = groundReference({ publicTurns: [], turn: 3, interpretation: interp() });
  assert.equal(g.human, null);
  assert.equal(g.dropped[0].reason, "no_public_human_turn");
});
