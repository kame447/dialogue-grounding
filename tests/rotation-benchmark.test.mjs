import test from "node:test";
import assert from "node:assert/strict";
import { buildMessages, parseSlot, plan, runBenchmark, main, CONDITIONS } from "../dialogue-model/runtime/diagnostics/rotation-benchmark.mjs";
import { createTrial, SLOTS } from "../dialogue-model/runtime/stimuli/board.mjs";
import { cropOwnCells } from "../dialogue-model/runtime/visual/own-image-rotation.mjs";

const images = (messages) => messages.flatMap((m) => m.content).filter((p) => p.type === "image_url").map((p) => p.image_url.url);

test("conditions differ only by the own-board aid; requests carry no key or figure identity", () => {
  const trial = createTrial({ seed: 9 });
  const crop = cropOwnCells(trial.human.png)[0];
  const original = buildMessages({ ownPng: trial.ai.png, partnerCropPng: crop, condition: "original" });
  const aided = buildMessages({ ownPng: trial.ai.png, partnerCropPng: crop, condition: "visual-aided" });
  assert.deepEqual(aided.filter((m) => !m.content.some((p) => p.type === "text" && p.text.startsWith("補助画像"))), original);
  assert.equal(images(original).length, 2);
  assert.equal(images(aided).length, 3);
  assert.equal(images(original)[0], "data:image/png;base64," + trial.ai.png.toString("base64"));
  assert.ok(!images(aided).includes("data:image/png;base64," + trial.human.png.toString("base64")));
  const serialized = JSON.stringify(aided.flatMap((m) => m.content).filter((p) => p.type === "text"));
  for (const id of ["F1", "F2", "F3", "F4", "F5", "F6", "figureId", "key"]) assert.ok(!serialized.includes(id), id);
  for (const message of aided) assert.ok(message.content.length <= 4);
});

test("dry run sends nothing and plans six requests per seed and condition", async () => {
  assert.equal(plan({ seeds: [9, 10] }).length, 24);
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try { await main(["--seeds", "9,10"], {}); } finally { console.log = original; }
  assert.deepEqual(JSON.parse(lines[0]), { dryRun: true, requests: 24, seeds: [9, 10], conditions: [...CONDITIONS] });
});

test("answers are scored against the key only after the response", async () => {
  const seen = [];
  const client = { async complete(messages) { seen.push(messages); return { text: "{\"slot\":\"上段左\"}", usage: {} }; } };
  const { summary, results } = await runBenchmark({ client, seeds: [9], conditions: ["original"] });
  const trial = createTrial({ seed: 9 });
  const expected = SLOTS.filter((partnerSlot) => trial.key.ai["上段左"] === trial.key.human[partnerSlot]);
  assert.equal(summary.original.total, 6);
  assert.equal(summary.original.correct, expected.length);
  assert.deepEqual(results.filter((r) => r.correct).map((r) => r.partnerSlot), expected);
  assert.equal(seen.length, 6);
});

test("malformed or unknown answers are never counted as correct", () => {
  assert.equal(parseSlot("```json\n{\"slot\":\"下段右\"}\n```"), "下段右");
  assert.equal(parseSlot("{\"slot\":\"R1C1\"}"), null);
  assert.equal(parseSlot("上段左です"), null);
});
