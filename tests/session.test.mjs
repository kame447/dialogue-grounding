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

test("named confirmation and agreement retain the same own target across turns with identical generators in both conditions", async () => {
  const candidate = { ...SAFE_JUDGMENT, action: "confirm", targetSlot: "下段中", candidateName: "作業候補",
    discriminatingFeature: "候補間で異なるくぼみ", note: "PRIVATE-CANDIDATE-NOTE" };
  const agree = { ...SAFE_JUDGMENT, action: "agree", targetSlot: candidate.targetSlot, candidateName: candidate.candidateName };
  const executions = [];
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const calls = [];
    let judgeCount = 0;
    const session = createDialogueSession({ strategy, image: { ...ownImage, humanImage: "PRIVATE-HUMAN-IMAGE", key: "PRIVATE-KEY" },
      client: { async complete(messages) {
        calls.push(structuredClone(messages));
        return { text: isJudge(messages) ? JSON.stringify([candidate, agree][judgeCount++]) : "公開された応答" };
      } } });
    await session.turn("名前について確認したいです");
    assert.deepEqual(session.getOwnLedger()[candidate.targetSlot], { status: "tentative", name: candidate.candidateName });
    await session.turn("その名前にしましょう");
    assert.deepEqual(session.getOwnLedger()[candidate.targetSlot], { status: "agreed", name: candidate.candidateName });
    const notesMessage = calls[2].find((m) => typeof m.content === "string" && m.content.includes('"ownJudgmentHistory"'));
    const notes = JSON.parse(notesMessage.content.slice(notesMessage.content.indexOf("\n") + 1));
    assert.deepEqual(notes.ownJudgmentHistory, [{ action: "confirm", targetSlot: candidate.targetSlot, candidateName: candidate.candidateName }]);
    assert.doesNotMatch(JSON.stringify(calls), /PRIVATE-CANDIDATE-NOTE|PRIVATE-HUMAN-IMAGE|PRIVATE-KEY/);
    const historyBeforeFinal = session.getHistory();
    await session.finalRequest("最終名称は自分の画像と公開履歴を照合して決めてください");
    assert.match(JSON.stringify(calls.at(-1)), /作業候補/);
    assert.deepEqual(session.getHistory(), historyBeforeFinal);
    assert.deepEqual(session.getJudgmentHistory().map((item) => item.judgment.candidateName), [candidate.candidateName, candidate.candidateName]);
    executions.push(calls);
  }
  for (const index of [0, 2]) {
    assert.notEqual(executions[0][index][1].content, executions[1][index][1].content);
    assert.deepEqual(executions[0][index].filter((_, i) => i !== 1), executions[1][index].filter((_, i) => i !== 1));
  }
  for (const index of [1, 3, 4]) assert.deepEqual(executions[0][index], executions[1][index]);
});

test("every typed action reaches the same generator constraints in both strategies without promoting speech to agreement", async (t) => {
  const targetSlot = "上段中", candidateName = "候補名";
  const cases = [
    { action: "accept" },
    { action: "confirm", targetSlot, candidateName, discriminatingFeature: "候補を区別するくぼみ" },
    { action: "propose_name", targetSlot, candidateName },
    { action: "agree", targetSlot, candidateName },
    { action: "repair", targetSlot, candidateName },
    { action: "defer", targetSlot },
    { action: "revisit", targetSlot },
    { action: "move_on" },
    { action: "close" },
  ];
  for (const item of cases) await t.test(item.action, async () => {
    const judgment = { ...SAFE_JUDGMENT, ...item, note: "PRIVATE-ACTION-NOTE" }, payloads = [];
    for (const strategy of ["repair-first", "bypass-enabled"]) {
      let generated;
      const client = { async complete(messages) {
        if (isJudge(messages)) return { text: JSON.stringify(judgment) };
        generated = structuredClone(messages);
        // Deliberately misleading mock speech must never decide ledger status.
        return { text: "名称は合意済みです。" };
      } };
      const session = createDialogueSession({ client, strategy, image: ownImage });
      await session.turn("公開発話");
      const instructions = generated[1].content;
      assert.match(instructions, /confirmは相手への質問・確認/u);
      assert.match(instructions, /propose_nameは命名の提案/u);
      assert.match(instructions, /どちらも名称への合意・確定を表明せず/u);
      assert.match(instructions, /名称への合意・確定を表明できるのはagreeのときだけ/u);
      assert.match(instructions, /repairでは.*自己訂正として明示/u);
      assert.match(instructions, /deferでは.*保留することを、revisitでは.*再訪/u);
      assert.match(instructions, /move_onでは別対象への移行/u);
      assert.match(instructions, /closeでは対話終了を相談/u);
      assert.match(instructions, /acceptでは相手の発言を受け止め/u);
      const sent = JSON.parse(generated[2].content.split("\n").slice(1).join("\n"));
      const { action, targetSlot: slot, candidateName: name, discriminatingFeature } = judgment;
      assert.deepEqual(sent, { action, targetSlot: slot, candidateName: name, discriminatingFeature });
      assert.doesNotMatch(JSON.stringify(generated), /PRIVATE-ACTION-NOTE|repair-first|bypass-enabled/);
      assert.equal(Object.values(session.getOwnLedger()).some((entry) => entry.status === "agreed"), action === "agree");
      if (["confirm", "propose_name", "repair"].includes(action)) {
        assert.deepEqual(session.getOwnLedger()[targetSlot], { status: "tentative", name: candidateName });
      }
      payloads.push(generated);
    }
    assert.deepEqual(payloads[0], payloads[1]);
  });
});

test("invalid strategy and missing public utterance are rejected", async () => {
  const client = { async complete() { assert.fail("must not call"); } };
  assert.throws(() => createDialogueSession({ client, strategy: "unknown" }), /Unsupported/);
  const session = createDialogueSession({ client, strategy: "repair-first" });
  await assert.rejects(session.turn(" "), /nonempty/);
});
