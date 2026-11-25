import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";

test("participant textarea length matches the naming task message boundary", async () => {
  const html = await readFile(new URL("../dialogue-model/runtime/web/index.html", import.meta.url), "utf8");
  const textarea = html.match(/<textarea\b[^>]*\bid="utterance"[^>]*>/u)?.[0];
  assert.ok(textarea);
  const limit = Number(textarea.match(/\bmaxlength="(\d+)"/u)?.[1]);
  assert.equal(limit, 2000);

  const client = { async complete(_messages, options = {}) {
    const text = options.phase === "judgment"
      ? JSON.stringify({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null })
      : "はい。";
    return { text, model: "fake" };
  } };
  const task = await createNamingTaskV2({ client, strategy: "repair-first", seed: 21, runDir: "" });
  const allowed = "あ".repeat(limit);
  assert.throws(() => task.message(allowed + "あ"), { code: "invalid_message" });
  assert.ok(task.message(allowed).eventId);
  await task.whenIdle();
  assert.equal(task.getState().events.filter((event) => event.speaker === "human").at(-1).text, allowed);
});
