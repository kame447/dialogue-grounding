import test from "node:test";
import assert from "node:assert/strict";
import { createDialogueSession } from "../dialogue-model/runtime/session.mjs";

const ownImage = { mimeType: "image/png", base64: "c3ludGhldGlj" };

test("both strategies receive only own image and public history", async () => {
  const calls = [];
  const client = { async complete(messages) {
    calls.push(JSON.parse(JSON.stringify(messages)));
    return { text: "その形はどうでしょう？", model: "same-model" };
  } };
  const strict = createDialogueSession({ client, strategy: "repair-first", image: ownImage });
  const flexible = createDialogueSession({ client, strategy: "bypass-enabled", image: ownImage });
  await strict.turn("船のような形ですか？");
  await flexible.turn("船のような形ですか？");
  const [strictFirst, flexibleFirst] = calls;
  assert.equal(strictFirst.length, 4);
  assert.equal(flexibleFirst.length, 4);
  assert.equal(strictFirst[0].content, flexibleFirst[0].content);
  assert.notEqual(strictFirst[1].content, flexibleFirst[1].content);
  assert.deepEqual(strictFirst.slice(2), flexibleFirst.slice(2));
  assert.equal(strictFirst[2].content[1].image_url.url, "data:image/png;base64,c3ludGhldGlj");
  assert.ok(!JSON.stringify(strictFirst).includes("gold_annotation"));
  assert.ok(!JSON.stringify(strictFirst).includes("answer_key"));
  await strict.turn("少し違うかもしれません");
  assert.equal(calls[2][3].role, "user");
  assert.equal(calls[2][3].content, "船のような形ですか？");
  assert.equal(calls[2][4].role, "assistant");
  assert.equal(calls[2][4].content, "その形はどうでしょう？");
  assert.equal(calls[2][5].content, "少し違うかもしれません");
  assert.equal(flexible.getHistory().length, 2);
  assert.equal(strict.getHistory().length, 4);
});

test("failed turns do not corrupt public dialogue history", async () => {
  let attempt = 0;
  const client = { async complete() {
    attempt += 1;
    if (attempt === 1) throw new Error("provider unavailable");
    return { text: "了解" };
  } };
  const session = createDialogueSession({ client, strategy: "repair-first" });
  await assert.rejects(session.turn("最初の発言"));
  assert.deepEqual(session.getHistory(), []);
  await session.turn("再送の発言");
  assert.deepEqual(session.getHistory(), [
    { role: "user", content: "再送の発言" },
    { role: "assistant", content: "了解" },
  ]);
});

test("invalid strategy and missing utterance are rejected", async () => {
  const client = { async complete() { return { text: "OK" }; } };
  assert.throws(() => createDialogueSession({ client, strategy: "experimental-threshold" }),
    /Unsupported/);
  const session = createDialogueSession({ client, strategy: "repair-first" });
  await assert.rejects(session.turn(" "), /nonempty/);
});
