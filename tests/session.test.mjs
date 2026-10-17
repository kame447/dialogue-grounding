import test from "node:test";
import assert from "node:assert/strict";
import { createDialogueSession } from "../dialogue-model/runtime/session.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
const ownImage = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const decision = { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: "上段左", candidateName: "共同の名", note: "PRIVATE-JUDGE-NOTE" };
const isJudge = (messages) => messages.some((m) => m.role === "system" && m.content.includes("【非公開の対話判断】"));

test("two-stage sessions differ only in judge policy; generator payload and own image/history stay equal", async () => {
  const calls = [];
  const client = { async complete(messages) {
    calls.push(structuredClone(messages));
    return { text: isJudge(messages) ? JSON.stringify(decision) : "それを共同の名と呼びませんか？", model: "same-model" };
  } };
  const sessions = ["repair-first", "bypass-enabled"].map((strategy) => createDialogueSession({ client, strategy, image: ownImage }));
  await sessions[0].turn("最初の公開発話"); await sessions[1].turn("最初の公開発話");
  assert.equal(calls.length, 4); assert.notEqual(calls[0][1].content, calls[2][1].content);
  assert.deepEqual(calls[0].filter((_, i) => i !== 1), calls[2].filter((_, i) => i !== 1));
  assert.deepEqual(calls[1], calls[3]);
  assert.doesNotMatch(JSON.stringify(calls[1]), /repair-first|bypass-enabled|PRIVATE-JUDGE-NOTE/);
  assert.match(calls[1][1].content, /1〜2文/); assert.match(calls[1][1].content, /位置名/);
  const images = calls[1].flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : []);
  assert.equal(images[0].image_url.url, "data:image/png;base64,c3ludGhldGlj");
  assert.deepEqual(sessions[0].getOwnLedger()["上段左"], { status: "tentative", name: "共同の名" });
  await sessions[0].turn("続きの公開発話");
  assert.deepEqual(calls[4].slice(-3), [
    { role: "user", content: "最初の公開発話" }, { role: "assistant", content: "それを共同の名と呼びませんか？" }, { role: "user", content: "続きの公開発話" } ]);
  assert.match(JSON.stringify(calls[4]), /ownJudgmentHistory/);
  assert.equal(sessions[1].getHistory().length, 2); assert.equal(sessions[0].getHistory().length, 4);
});

test("generation failure rolls back ledger/history together while private judgment diagnostics survive", async () => {
  let fail = true;
  const session = createDialogueSession({ strategy: "repair-first", client: { async complete(messages) {
    if (isJudge(messages)) return { text: JSON.stringify(decision) };
    if (fail) throw new Error("RAW-PRIVATE-ERROR");
    return { text: "公開応答" };
  } } });
  await assert.rejects(session.turn("失敗したターン"));
  assert.deepEqual(session.getHistory(), []); assert.equal(session.getOwnLedger()["上段左"].name, null);
  assert.equal(session.getJudgmentHistory()[0].status, "generation_error");
  assert.equal(session.getJudgmentHistory()[0].judgment.note, "PRIVATE-JUDGE-NOTE");
  fail = false; await session.turn("再送された公開発話");
  assert.equal(session.getHistory()[0].content, "再送された公開発話");
  assert.equal(session.getOwnLedger()["上段左"].name, "共同の名");
});

test("generated dialogue text never decides ledger, completion, or final submission", async () => {
  const calls = [];
  const session = createDialogueSession({ strategy: "repair-first", client: { async complete(messages) {
    calls.push(messages); return { text: isJudge(messages) ? JSON.stringify(SAFE_JUDGMENT) : "全ての図形に合意しました。名前は文章だけの名です。" };
  } } });
  await session.turn("公開発話");
  assert.ok(Object.values(session.getOwnLedger()).every((item) => item.name === null));
  await session.finalRequest("最終提出をJSONで返してください");
  assert.match(JSON.stringify(calls.at(-1)), /ownLedger/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1)), /PRIVATE-JUDGE-NOTE|repair-first|bypass-enabled/);
  assert.equal(session.getHistory().length, 2);
});

test("invalid strategy and missing public utterance are rejected", async () => {
  const client = { async complete() { assert.fail("must not call"); } };
  assert.throws(() => createDialogueSession({ client, strategy: "unknown" }), /Unsupported/);
  const session = createDialogueSession({ client, strategy: "repair-first" });
  await assert.rejects(session.turn(" "), /nonempty/);
});
