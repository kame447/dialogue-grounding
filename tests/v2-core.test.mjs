import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNamingTaskV2, validateNamesV2, parseAiNamesV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createDialogueV2, GENERATOR_INSTRUCTIONS_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createTrialV2, modelView } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";

const POSITION_WORDS = /上段|下段|左上|右上|左下|右下|R1C1|R2C3/;
const textOf = (messages) => messages.flatMap((m) => typeof m.content === "string" ? [m.content] : m.content.filter((p) => p.type === "text").map((p) => p.text)).join("\n");
const imagesOf = (messages) => messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").map((p) => p.image_url.url) : []);
const ownIdsFrom = (messages) => {
  const memo = textOf(messages).match(/内部参照ID（非公開[^\n]*\n(\[.*\])/);
  return memo ? JSON.parse(memo[1]).map((a) => a.id) : [];
};

/** Fake model: judgment JSON, short utterances, and final names keyed by the AI's own ids. */
function fakeClient({ delays = {}, reference = null, finalName = (ids) => Object.fromEntries(ids.map((id, i) => [id, "名前" + i])) } = {}) {
  const calls = [];
  return {
    calls,
    async complete(messages, options = {}) {
      calls.push({ phase: options.phase, messages });
      if (delays[options.phase]) await delays[options.phase]();
      if (options.phase === "judgment") {
        return { text: JSON.stringify({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null,
          ...(reference ? { reference: reference(ownIdsFrom(messages)) } : {}) }), model: "fake" };
      }
      if (options.phase === "final_submission") return { text: JSON.stringify(finalName(ownIdsFrom(messages))), model: "fake" };
      const humans = messages.filter((m) => m.role === "user" && typeof m.content === "string");
      return { text: "はい、" + humans.at(-1).content.slice(0, 10) + "ですね。", model: "fake" };
    },
  };
}

test("v2 generator wording never names fixed positions", () => {
  assert.ok(!POSITION_WORDS.test(GENERATOR_INSTRUCTIONS_V2));
});

test("participant state carries only the own scene and public events", async () => {
  const task = await createNamingTaskV2({ client: fakeClient(), strategy: "repair-first", seed: 21, runDir: "" });
  const state = task.getState();
  assert.equal(state.version, 2);
  assert.equal(state.scene.shapes.length, 6);
  const serialized = JSON.stringify(state);
  for (const forbidden of ["key", "figureId", "anchors", "ledger", "judgment", "strategy", "png", "seed", "trialId"]) assert.ok(!serialized.includes('"' + forbidden), forbidden);
  assert.ok(!serialized.includes(createTrialV2({ seed: 21 }).trialId), "seed-derived trial id must not reach the participant");
  assert.ok(!POSITION_WORDS.test(serialized));
  const trial = createTrialV2({ seed: 21 });
  assert.deepEqual(state.scene.shapes.map((s) => s.id), Object.keys(trial.key.human));
});

test("model requests carry only the AI's own image and own ids, never the human board or key", async () => {
  const client = fakeClient();
  const task = await createNamingTaskV2({ client, strategy: "bypass-enabled", seed: 22, runDir: "" });
  task.message("よろしくお願いします");
  await task.whenIdle();
  const trial = createTrialV2({ seed: 22 });
  const aiImage = "data:image/png;base64," + trial.ai.png.toString("base64");
  const humanImage = "data:image/png;base64," + trial.human.png.toString("base64");
  for (const { messages } of client.calls) {
    const images = imagesOf(messages);
    assert.deepEqual(images, [aiImage]);
    assert.ok(!images.includes(humanImage));
    const text = textOf(messages);
    for (const id of Object.keys(trial.key.human)) assert.ok(!text.includes(id), "human id leaked: " + id);
    for (const figure of new Set(Object.values(trial.key.ai))) assert.ok(!text.includes('"' + figure + '"'), "figure id leaked");
    assert.ok(!POSITION_WORDS.test(text));
  }
  assert.deepEqual(ownIdsFrom(client.calls[0].messages), Object.keys(trial.key.ai));
});

test("a correction sent while the AI is thinking supersedes the stale reply", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let firstGeneration = true;
  const client = fakeClient({ delays: { generation: async () => { if (firstGeneration) { firstGeneration = false; await gate; } } } });
  const task = await createNamingTaskV2({ client, strategy: "repair-first", seed: 23, runDir: "" });
  task.message("これは鳥っぽい");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(task.getState().aiStatus, "thinking");
  task.message("あ、違う、魚かも");
  release();
  await task.whenIdle();
  const events = task.getState().events;
  assert.deepEqual(events.map((e) => e.speaker), ["ai", "human", "human", "ai"]);
  assert.match(events[3].text, /魚かも/);
  const lastGeneration = client.calls.filter((c) => c.phase === "generation").at(-1).messages;
  const humanTurns = lastGeneration.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content);
  assert.deepEqual(humanTurns, ["これは鳥っぽい", "あ、違う、魚かも"]);
  const { privateState } = task.researcherView();
  assert.equal(privateState.judgments.length, 1, "the superseded run committed nothing");
});

test("submissions use each side's own opaque ids and are scored only after both", async () => {
  const trial = createTrialV2({ seed: 24 });
  const aiIds = Object.keys(trial.key.ai);
  // Give the AI the same names the human gives to the same figures, except one.
  const humanIds = Object.keys(trial.key.human);
  const nameOf = (figure) => "図形" + figure;
  const client = fakeClient({ finalName: (ids) => Object.fromEntries(ids.map((id, i) => [id, i === 0 ? "ちがう" : nameOf(trial.key.ai[id])])) });
  const task = await createNamingTaskV2({ client, strategy: "repair-first", seed: 24, runDir: "" });
  const names = Object.fromEntries(humanIds.map((id, i) => [id, i === 5 ? null : nameOf(trial.key.human[id])]));
  await task.submitHuman({ names });
  assert.equal(task.getState().result, undefined);
  assert.throws(() => task.message("まだ話せる？"), /dialogue_closed/);
  await task.submitAI();
  const state = task.getState();
  const expected = humanIds.filter((id, i) => i !== 5 && trial.key.human[id] !== trial.key.ai[aiIds[0]]).length;
  assert.equal(state.result.matchedCount, expected);
  assert.ok(!JSON.stringify(state.result).includes("figureId"));
});

test("names validation and AI parsing reject foreign or missing ids", () => {
  const ids = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
  assert.throws(() => validateNamesV2({ "上段左": "x" }, ids), /invalid_submission/);
  assert.deepEqual(validateNamesV2(Object.fromEntries(ids.map((id) => [id, " "])), ids), Object.fromEntries(ids.map((id) => [id, null])));
  assert.equal(parseAiNamesV2(JSON.stringify({ "s-0001": "a" }), ids), null);
  assert.equal(parseAiNamesV2("```json\n" + JSON.stringify(Object.fromEntries(ids.map((id) => [id, "a"]))) + "\n```", ids)["s-0006"], "a");
});

for (const strategy of ["repair-first", "bypass-enabled"]) test(`reference memory defaults on and grounds public mentions privately: ${strategy}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-core-"));
  try {
    const client = fakeClient({ reference: (ids) => ({ slots: [ids[0]], epistemic: "grounded", intent: "feature_assertion",
      feature: { slot: ids[0], feature: "細長い", polarity: "confirmed" }, nameAcceptance: null, deferSlot: null, revisitSlot: null }) });
    const task = await createNamingTaskV2({ client, strategy, seed: 25, runDir: dir });
    task.message("細長いのがあります");
    await task.whenIdle();
    const [file] = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    const record = JSON.parse(await readFile(join(dir, file), "utf8"));
    assert.equal(record.version, 2);
    assert.equal(record.options.referenceMemory, true);
    assert.equal(record.judgments[0].memory.opsApplied, 2);
    const aiId = Object.keys(createTrialV2({ seed: 25 }).key.ai)[0];
    assert.deepEqual(record.referenceGraph.mentions[0].slots, [aiId]);
    assert.equal(record.referenceGraph.ownSlots[aiId].features[0].polarity, "confirmed");
    assert.ok(!JSON.stringify(task.getState()).includes("referenceGraph"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const strategy of ["repair-first", "bypass-enabled"]) test(`direct v2 runtime defaults on and allows explicit opt-out: ${strategy}`, () => {
  const model = modelView(createTrialV2({ seed: 25 }));
  const options = { client: fakeClient(), strategy, anchors: model.anchors,
    image: { mimeType: model.mimeType, base64: model.png.toString("base64") } };
  assert.ok(createDialogueV2(options).initialPrivateState().graph);
  assert.equal(createDialogueV2({ ...options, referenceMemory: false }).initialPrivateState().graph, null);
});

test("the AI may submit first; the human submission then completes scoring", async () => {
  const task = await createNamingTaskV2({ client: fakeClient(), strategy: "bypass-enabled", seed: 26, runDir: "" });
  await task.submitAI();
  assert.equal(task.getState().result, undefined);
  const ids = task.getState().scene.shapes.map((s) => s.id);
  await task.submitHuman({ names: Object.fromEntries(ids.map((id) => [id, null])) });
  assert.equal(task.getState().result.total, 6);
});

test("the human cannot submit while the AI is still answering; nothing is silently dropped", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const task = await createNamingTaskV2({ client: fakeClient({ delays: { generation: () => gate } }), strategy: "repair-first", seed: 27, runDir: "" });
  task.message("これは何に見えますか");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const ids = task.getState().scene.shapes.map((s) => s.id);
  await assert.rejects(task.submitHuman({ names: Object.fromEntries(ids.map((id) => [id, null])) }), /ai_busy/);
  release();
  await task.whenIdle();
  assert.equal(task.getState().events.at(-1).speaker, "ai");
  await task.submitHuman({ names: Object.fromEntries(ids.map((id) => [id, null])) });
  assert.equal(task.getState().submitted, true);
});

test("background and explicit record writes never collide", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-persist-"));
  try {
    const task = await createNamingTaskV2({ client: fakeClient(), strategy: "repair-first", seed: 28, runDir: dir });
    task.message("一つめ");
    task.message("二つめ");
    await Promise.all([task.whenIdle(), task.whenIdle()]);
    await task.submitAI();
    const ids = task.getState().scene.shapes.map((s) => s.id);
    await task.submitHuman({ names: Object.fromEntries(ids.map((id) => [id, "x"])) });
    const files = await readdir(dir);
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
    const record = JSON.parse(await readFile(join(dir, files.find((f) => f.endsWith(".json"))), "utf8"));
    assert.equal(record.status, "completed");
    assert.equal(record.seed, 28, "the researcher record keeps the seed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an upstream error keeps the message pending and blocks submission until retry", async () => {
  let fail = true;
  const base = fakeClient();
  const client = { calls: base.calls, async complete(messages, options = {}) {
    if (options.phase === "generation" && fail) { const error = new Error("upstream"); error.status = 503; throw error; }
    return base.complete(messages, options);
  } };
  const task = await createNamingTaskV2({ client, strategy: "repair-first", seed: 29, runDir: "" });
  task.message("これはどう？");
  await task.whenIdle();
  assert.equal(task.getState().aiStatus, "error");
  assert.deepEqual(task.getState().events.map((e) => e.speaker), ["ai", "human"], "the opening and human message are preserved");
  const ids = task.getState().scene.shapes.map((s) => s.id);
  await assert.rejects(task.submitHuman({ names: Object.fromEntries(ids.map((id) => [id, null])) }), /ai_retry_required/);
  await assert.rejects(task.submitAI(), /ai_retry_required/);
  assert.equal(task.researcherView().privateState.judgments.length, 0, "failed generation committed nothing");
  fail = false;
  await task.retry();
  assert.deepEqual(task.getState().events.map((e) => e.speaker), ["ai", "human", "ai"]);
  await task.submitHuman({ names: Object.fromEntries(ids.map((id) => [id, null])) });
});

test("concurrent AI submissions share one final request; a second human submission is refused", async () => {
  const client = fakeClient();
  const task = await createNamingTaskV2({ client, strategy: "bypass-enabled", seed: 30, runDir: "" });
  await Promise.all([task.submitAI(), task.submitAI()]);
  assert.equal(client.calls.filter((c) => c.phase === "final_submission").length, 1);
  const ids = task.getState().scene.shapes.map((s) => s.id);
  const names = Object.fromEntries(ids.map((id) => [id, null]));
  await task.submitHuman({ names });
  await assert.rejects(task.submitHuman({ names }), /already_submitted/);
});
