import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile, readdir, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNamingTask, SLOTS, outsideRepositoryDirectory } from "../dialogue-model/runtime/naming-task.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
const isJudge = (body) => body.messages.some((m) => m.role === "system" && m.content.includes("【非公開の対話判断】"));

const AI_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
const HUMAN_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=", "base64");
const submission = (prefix) => Object.fromEntries(SLOTS.map((slot, i) => [slot, prefix + i]));
const fakeTrial = ({ seed }) => ({ trialId: "SECRET-TRIAL-ID", seed,
  ai: { png: AI_PNG, mimeType: "image/png" }, human: { png: HUMAN_PNG, mimeType: "image/png" },
  key: { human: Object.fromEntries(SLOTS.map((slot, i) => [slot, "PRIVATE-FIGURE-ID-" + i])),
    ai: Object.fromEntries(SLOTS.map((slot, i) => [slot, "PRIVATE-FIGURE-ID-" + (5 - i)])) } });
const fakeScore = ({ key, humanSubmission, aiSubmission }) => ({ provisional: true, success: false,
  figures: SLOTS.map((humanSlot, i) => ({ figureId: key.human[humanSlot], humanSlot, aiSlot: SLOTS[5 - i],
    humanName: humanSubmission[humanSlot], aiName: aiSubmission[SLOTS[5 - i]], match: false })) });

async function mock(t, respond, judgeResponse = JSON.stringify(SAFE_JUDGMENT)) {
  const requests = [];
  let nonJudgeCalls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const value = isJudge(requests.at(-1)) ? { text: judgeResponse } : await respond(++nonJudgeCalls, requests.at(-1));
    res.writeHead(value.status ?? 200, { "Content-Type": "application/json" });
    res.end(value.raw ?? JSON.stringify({ model: "one-fixed-model", usage: { prompt_tokens: 12, completion_tokens: 7 },
      choices: [{ message: { content: value.text } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn",
    apiKey: "TEST-TOKEN-PRIVATE-DO-NOT-DISCLOSE", baseUrl: "http://127.0.0.1:" + server.address().port + "/v1" }, undefined, { sleep: async () => {} });
  return { requests, client };
}
function taskOptions(client, extra = {}) { return { client, strategy: "repair-first", seed: 101,
  createTrial: fakeTrial, scoreTrial: fakeScore, runDir: "", ...extra }; }

test("HTTP payloads expose only own image/public history; strategies differ only in instruction", async (t) => {
  const { client, requests } = await mock(t, async () => ({ text: "公開されたAI応答" }));
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const task = await createNamingTask(taskOptions(client, { strategy }));
    await task.turn("公開された人間の発話");
    await task.turn("続きの公開発話");
  }
  const [first, second, otherFirst, otherSecond] = requests.filter(isJudge);
  const [generatedFirst, generatedSecond, otherGeneratedFirst, otherGeneratedSecond] = requests.filter((body) => !isJudge(body));
  assert.deepEqual(generatedFirst, otherGeneratedFirst);
  assert.deepEqual(generatedSecond, otherGeneratedSecond);
  assert.doesNotMatch(JSON.stringify(first), /続きの公開発話/);
  assert.equal(first.purpose, "dialogue_turn"); assert.ok(!Object.hasOwn(first, "model"));
  const removeStrategy = (value) => ({ ...value, messages: value.messages.filter((_, i) => i !== 1) });
  assert.deepEqual(removeStrategy(first), removeStrategy(otherFirst));
  assert.deepEqual(removeStrategy(second), removeStrategy(otherSecond));
  assert.notEqual(first.messages[1].content, otherFirst.messages[1].content);
  assert.match(first.messages[0].content, /6図形が2段3列/);
  assert.match(first.messages[0].content, /相手の画面では配置も向きも異な/);
  assert.deepEqual(second.messages.slice(-3, -1), [
    { role: "user", content: "公開された人間の発話" }, { role: "assistant", content: "公開されたAI応答" } ]);
  for (const body of requests) {
    const images = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : []);
    assert.equal(images.length, 1);
    assert.equal(images[0].image_url.url, "data:image/png;base64," + AI_PNG.toString("base64"));
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-FIGURE-ID|SECRET-TRIAL-ID|TEST-TOKEN|humanSubmission|scoring/);
    assert.ok(!JSON.stringify(body).includes(HUMAN_PNG.toString("base64")));
  }
});

test("AI commits privately; scoring happens only after both submissions and closes dialogue", async (t) => {
  const ai = submission("AI-FINAL-");
  const { client, requests } = await mock(t, async (i) => ({ text: i === 1 ? "公開応答" : JSON.stringify(ai) }));
  let scores = 0;
  const task = await createNamingTask(taskOptions(client, { scoreTrial: (args) => { scores++; return fakeScore(args); } }));
  await task.turn("公開発話");
  const state = await task.submitAI();
  assert.equal(scores, 0); assert.equal(state.aiSubmitted, true);
  assert.ok(!Object.hasOwn(state, "judgments")); assert.ok(!Object.hasOwn(state, "ownLedger"));
  assert.ok(!Object.hasOwn(state, "aiSubmission")); assert.ok(!Object.hasOwn(state, "result"));
  assert.ok(!JSON.stringify(state).includes("AI-FINAL"));
  assert.equal(state.publicHistory.length, 2);
  const finalMessages = requests.at(-1).messages;
  assert.deepEqual(finalMessages.slice(-3, -1), state.publicHistory);
  assert.match(JSON.stringify(finalMessages), /ownLedger/);
  assert.doesNotMatch(JSON.stringify(finalMessages), /repair-first|bypass-enabled/);
  await assert.rejects(task.turn("もう一度"), /dialogue_closed/);
  const completed = await task.submitHuman(submission("PRIVATE-HUMAN-"));
  assert.equal(scores, 1); assert.deepEqual(completed.aiSubmission, ai); assert.equal(completed.result.provisional, true);
  await assert.rejects(task.submitHuman(submission("changed")), /already_submitted/);
  await assert.rejects(task.submitAI(), /already_submitted/);
});

test("human submission never enters final request; one format retry does not expose invalid output", async (t) => {
  const { client, requests } = await mock(t, async (i) => ({ text: i === 1 ? "INVALID-PRIVATE-OUTPUT" : JSON.stringify(submission("final")) }));
  const task = await createNamingTask(taskOptions(client));
  await task.submitHuman(submission("PRIVATE-HUMAN-NAME"));
  const state = await task.submitAI();
  assert.equal(requests.length, 2); assert.equal(state.status, "completed");
  assert.deepEqual(requests[0].messages.slice(0, -1), requests[1].messages.slice(0, -1));
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE-HUMAN-NAME|INVALID-PRIVATE-OUTPUT|PRIVATE-FIGURE-ID|SECRET-TRIAL-ID/);
  assert.deepEqual(state.publicHistory, []);
});

test("invalid AI JSON is rejected after exactly two requests, without scoring or disclosure", async (t) => {
  const { client, requests } = await mock(t, async () => ({ text: JSON.stringify({ ...submission("ai"), extra: "UPSTREAM-SECRET" }) }));
  const task = await createNamingTask(taskOptions(client, { scoreTrial() { assert.fail("must not score"); } }));
  await assert.rejects(task.submitAI(), /invalid_ai_submission/);
  assert.equal(requests.length, 2); assert.equal(task.getState().status, "submission_error");
  assert.doesNotMatch(JSON.stringify(task.getState()), /UPSTREAM-SECRET|aiSubmission/);
  await assert.rejects(task.submitAI(), /already_submitted/);
  assert.equal(requests.length, 2);
});

test("failed HTTP turns are sanitized, history remains unchanged, concurrency is rejected", async (t) => {
  let unblock;
  let received;
  const reached = new Promise((resolve) => { received = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  const { client } = await mock(t, async () => { received(); await gate; return { status: 500, raw: "SECRET-RAW-PROVIDER-PROMPT" }; });
  const task = await createNamingTask(taskOptions(client));
  const pending = task.turn("public");
  await reached;
  await assert.rejects(task.submitHuman(submission("x")), /busy/);
  unblock();
  await assert.rejects(pending, (error) => error.code === "ai_unavailable" && !error.message.includes("SECRET"));
  assert.deepEqual(task.getState().publicHistory, []);
  assert.equal(task.getState().busy, false);
});

test("records are opt-in, private, metered, and keep key only within completed scoring", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "naming-records-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { client } = await mock(t, async (i) => ({ text: i === 1 ? "public AI" : JSON.stringify(submission("ai")) }));
  const task = await createNamingTask(taskOptions(client, { runDir: directory }));
  let [name] = await readdir(directory);
  let record = JSON.parse(await readFile(join(directory, name), "utf8"));
  assert.equal(record.strategy, "repair-first"); assert.equal(record.seed, 101);
  assert.equal(record.scoring, null); assert.ok(!JSON.stringify(record).includes("PRIVATE-FIGURE-ID"));
  await task.turn("public human"); await task.submitAI();
  record = JSON.parse(await readFile(join(directory, name), "utf8"));
  assert.equal(record.aiSubmission[SLOTS[0]], "ai0"); assert.equal(record.scoring, null);
  await task.submitHuman(submission("human"));
  record = JSON.parse(await readFile(join(directory, name), "utf8"));
  assert.deepEqual(record.scoring.key, fakeTrial({ seed: 101 }).key);
  assert.equal(record.publicHistory.length, 2); assert.equal(record.requests.length, 3);
  assert.equal(record.judgments.length, 1); assert.equal(record.judgments[0].status, "committed");
  assert.equal(record.judgments[0].judgment.action, "accept");
  assert.ok(Object.values(record.ownLedger).every((item) => item.name === null));
  assert.equal(record.requests[0].model, "one-fixed-model"); assert.equal(record.requests[0].usage.inputTokens, 12);
  assert.equal(record.requests[0].kind, "judgment"); assert.equal(record.requests[1].kind, "generation");
  assert.equal(record.requests[2].kind, "final_submission"); assert.equal(record.requests[0].retryCount, 0); assert.equal(typeof record.requests[0].latencyMs, "number");
  assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(record), /TEST-TOKEN|base64|image_url/);
  assert.equal((await readdir(directory)).length, 1);
});

test("repository paths and external symlinks into a repository are refused before writing", async (t) => {
  const external = await mkdtemp(join(tmpdir(), "naming-symlink-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(resolve("."), join(external, "repo"));
  for (const path of [resolve("runs/not-allowed"), join(external, "repo", "runs", "nested")]) {
    await assert.rejects(outsideRepositoryDirectory(path), /repository_output_forbidden/);
    await assert.rejects(createNamingTask(taskOptions({ complete() {} }, { runDir: path })), /repository_output_forbidden/);
  }
  assert.equal(await outsideRepositoryDirectory(join(external, "new", "nested")), join(await import("node:fs/promises").then((fs) => fs.realpath(external)), "new", "nested"));
});

test("invalid submissions and seeds do not commit or send any API request", async () => {
  const client = { complete() { assert.fail("must not call"); } };
  for (const seed of ["", "101", 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(createNamingTask(taskOptions(client, { seed })), /invalid_seed/);
  }
  const task = await createNamingTask(taskOptions(client));
  for (const bad of [{}, { ...submission("x"), extra: "x" }, { ...submission("x"), [SLOTS[0]]: 7 }]) {
    await assert.rejects(task.submitHuman(bad), /invalid_submission/);
  }
  assert.equal(task.getState().humanSubmitted, false);
  assert.equal(task.getState().status, "dialogue");
});

test("private ledger/judgments are recorded, excluded from participant state, and only candidates for AI final names", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "naming-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const decision = { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: "上段左", candidateName: "作業中の名", note: "PRIVATE-JUDGMENT-NOTE" };
  const { client, requests } = await mock(t, async (i) => ({ text: i === 1 ? "公開された命名提案" : JSON.stringify(submission("FINAL-MODEL-CHOICE")) }), JSON.stringify(decision));
  const task = await createNamingTask(taskOptions(client, { runDir: directory }));
  await task.turn("公開発話");
  assert.ok(!Object.hasOwn(task.getState(), "ownLedger")); assert.ok(!Object.hasOwn(task.getState(), "judgments"));
  assert.doesNotMatch(JSON.stringify(task.getState()), /PRIVATE-JUDGMENT-NOTE/);
  const generated = requests.find((body) => !isJudge(body));
  assert.doesNotMatch(JSON.stringify(generated), /PRIVATE-JUDGMENT-NOTE|repair-first|bypass-enabled/);
  await task.submitHuman(submission("HUMAN-PRIVATE"));
  const state = await task.submitAI();
  assert.equal(state.aiSubmission[SLOTS[0]], "FINAL-MODEL-CHOICE0");
  assert.match(JSON.stringify(requests.at(-1)), /作業中の名/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /PRIVATE-JUDGMENT-NOTE|HUMAN-PRIVATE/);
  const [file] = await readdir(directory);
  const record = JSON.parse(await readFile(join(directory, file), "utf8"));
  assert.equal(record.ownLedger["上段左"].name, "作業中の名");
  assert.equal(record.judgments[0].ownLedgerBefore["上段左"].name, null);
  assert.equal(record.judgments[0].ownLedgerAfter["上段左"].name, "作業中の名");
  assert.equal(record.judgments[0].judgment.note, "PRIVATE-JUDGMENT-NOTE");
});

test("judge fallback is persisted without raw invalid output and transient generation retries are counted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "naming-fallback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { client, requests } = await mock(t, async (i) => i === 1 ? { status: 502, raw: "PRIVATE-RAW-502" } : { text: "公開応答" }, "PRIVATE-INVALID-JUDGMENT");
  const task = await createNamingTask(taskOptions(client, { runDir: directory }));
  await task.turn("公開発話");
  assert.equal(requests.length, 4); // Two format attempts, then one retried generation.
  const [file] = await readdir(directory);
  const record = JSON.parse(await readFile(join(directory, file), "utf8"));
  assert.equal(record.judgments[0].validation.fallback, true);
  assert.deepEqual(record.judgments[0].judgment, SAFE_JUDGMENT);
  assert.equal(record.requests.at(-1).kind, "generation"); assert.equal(record.requests.at(-1).retryCount, 1);
  assert.equal(record.requests.at(-1).timeoutMs, 90000);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE-RAW-502|PRIVATE-INVALID-JUDGMENT/);
});
