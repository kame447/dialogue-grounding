import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNamingServer } from "../dialogue-model/runtime/web/server.mjs";
import { main as cli } from "../dialogue-model/runtime/naming-cli.mjs";
import { SLOTS } from "../dialogue-model/runtime/naming-task.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
const names = () => Object.fromEntries(SLOTS.map((slot, i) => [slot, "name" + i]));
const createTrial = ({ seed }) => ({ trialId: "robustness-" + seed, seed,
  human: { png, mimeType: "image/png" }, ai: { png, mimeType: "image/png" },
  key: { human: names(), ai: names() } });
const scoreTrial = () => ({ provisional: true, success: true, figures: [] });
function clientFixture() {
  const calls = [];
  return { calls, async complete(messages) {
    calls.push(messages);
    const judge = messages.some(m => m.role === "system" && m.content.includes("【非公開の対話判断】"));
    return { text: judge ? JSON.stringify(SAFE_JUDGMENT) : messages.at(-1).content.includes("最終提出要求") ? JSON.stringify(names()) : "公開応答" };
  } };
}

async function web(t, options = {}) {
  let time = 0;
  const server = await startNamingServer({ port: 0, client: clientFixture(), createTrial, scoreTrial,
    runDir: "", now: () => time, ...options });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, cookie, body) => fetch(base + path, {
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  const page = async (path = "/") => {
    const response = await request(path);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.ok(cookie);
    return cookie;
  };
  const start = async cookie => {
    const response = await request("/api/start", cookie, { strategy: "repair-first", seed: 1 });
    assert.equal(response.status, 200, await response.text());
  };
  const finish = async cookie => {
    const response = await request("/api/submit", cookie, { submission: names() });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).trial.status, "completed");
  };
  return { request, page, start, finish, setTime(value) { time = value; } };
}

test("query strings preserve the home cookie and static asset pathname routing", async t => {
  const app = await web(t);
  const cookie = await app.page("/?p=1");
  for (const [path, type] of [["/app.js?v=1", "text/javascript"], ["/style.css?v=1", "text/css"]]) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), new RegExp(type));
    await response.text();
  }
  const state = await app.request("/api/state?p=1", cookie);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).trial, null);
});

test("more than 64 cookieless visits evict unused LRU sessions instead of permanently blocking new visitors", async t => {
  const app = await web(t);
  const first = await app.page();
  for (let i = 1; i < 65; i++) { app.setTime(i); await app.page(); }
  assert.equal((await app.request("/api/state", first)).status, 401);
});

test("capacity evicts the least recently used completed session and keeps an older active trial", async t => {
  const app = await web(t);
  const active = await app.page(); await app.start(active);
  app.setTime(1);
  const completedA = await app.page(); await app.start(completedA); await app.finish(completedA);
  app.setTime(2);
  const completedB = await app.page(); await app.start(completedB); await app.finish(completedB);
  for (let i = 3; i < 64; i++) { app.setTime(i); await app.page(); }
  app.setTime(100);
  assert.equal((await app.request("/api/state", completedA)).status, 200);
  await app.page();
  assert.equal((await app.request("/api/state", completedB)).status, 401);
  assert.equal((await app.request("/api/state", completedA)).status, 200);
  const response = await app.request("/api/state", active);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).trial.status, "dialogue");
});

test("idle unused/completed sessions expire, recent access renews inactivity, and active trials survive", async t => {
  const app = await web(t);
  const unused = await app.page(), recent = await app.page();
  const completed = await app.page(); await app.start(completed); await app.finish(completed);
  const active = await app.page(); await app.start(active);
  app.setTime(20 * 60 * 1000);
  assert.equal((await app.request("/api/state", recent)).status, 200);
  app.setTime(40 * 60 * 1000);
  assert.equal((await app.request("/api/state", unused)).status, 401);
  assert.equal((await app.request("/api/state", completed)).status, 401);
  assert.equal((await app.request("/api/state", recent)).status, 200);
  assert.equal((await app.request("/api/image", active)).status, 200);
});

test("in-flight trial creation is protected from timeout and unused-session eviction", async t => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const app = await web(t, { createTrial: async options => { entered.resolve(); await released.promise; return createTrial(options); } });
  const cookie = await app.page();
  const pending = app.start(cookie);
  await entered.promise;
  try {
    for (let i = 1; i < 65; i++) { app.setTime(i); await app.page(); }
    app.setTime(60 * 60 * 1000);
    await app.page();
    const response = await app.request("/api/state", cookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).busy, true);
  } finally { released.resolve(); await pending; }
  assert.equal((await app.request("/api/image", cookie)).status, 200);
});

test("a full server returns session_limit only when all 64 trials are protected", async t => {
  const app = await web(t);
  let first;
  for (let i = 0; i < 64; i++) {
    const cookie = await app.page(); first ??= cookie; await app.start(cookie);
  }
  app.setTime(60 * 60 * 1000);
  const response = await app.request("/");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "session_limit" });
  assert.equal((await app.request("/api/image", first)).status, 200);
});

test("failed AI final submission stays retryable over HTTP and is not expired while unfinished", async t => {
  let calls = 0;
  const app = await web(t, { client: { async complete() {
    if (++calls === 1) throw new Error("PRIVATE-UPSTREAM-FAILURE");
    return { text: JSON.stringify(names()) };
  } } });
  const cookie = await app.page(); await app.start(cookie);
  const failed = await app.request("/api/submit", cookie, { submission: names() });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "ai_unavailable" });
  app.setTime(60 * 60 * 1000);
  const response = await app.request("/api/state", cookie);
  assert.equal(response.status, 200);
  const state = (await response.json()).trial;
  assert.equal(state.status, "submitting");
  assert.equal(state.humanSubmitted, true);
  assert.equal(state.aiSubmitted, false);
  const retry = await app.request("/api/ai-submit", cookie, {});
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).trial.status, "completed");
  assert.equal(calls, 2);
});

test("HTTP scoring errors expose only the code and retry without another AI call", async t => {
  const client = clientFixture();
  let scores = 0;
  const app = await web(t, { client, scoreTrial() {
    if (++scores === 1) throw new Error("PRIVATE-SCORING-FAILURE");
    return scoreTrial();
  } });
  const cookie = await app.page(); await app.start(cookie);
  const failed = await app.request("/api/submit", cookie, { submission: names() });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "scoring_error" });
  app.setTime(60 * 60 * 1000);
  const response = await app.request("/api/state", cookie);
  assert.equal(response.status, 200);
  const state = (await response.json()).trial;
  assert.equal(state.status, "scoring_error");
  assert.equal(state.humanSubmitted, true);
  assert.equal(state.aiSubmitted, true);
  assert.equal(Object.hasOwn(state, "result"), false);
  const retry = await app.request("/api/ai-submit", cookie, {});
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).trial.status, "completed");
  assert.equal(client.calls.length, 1);
  assert.equal(scores, 2);
});

async function terminal(t) {
  const dir = await mkdtemp(join(tmpdir(), "server-cli-robustness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let output = "", trials = 0;
  const client = clientFixture();
  return { dir, client, args: ["--strategy", "repair-first", "--seed", "1", "--image-dir", join(dir, "images")],
    dependencies: { client, createTrial(options) { trials++; return createTrial(options); }, scoreTrial,
      output: new Writable({ write(chunk, encoding, done) { output += chunk; done(); } }) },
    output: () => output, trials: () => trials };
}

for (const [label, input] of [
  ["malformed JSON", "/submit SECRET-INVALID-JSON\n"],
  ["oversized JSON name", "/submit " + JSON.stringify({ ...names(), [SLOTS[0]]: "x".repeat(201) }) + "\n"],
  ["oversized prompted name", "/submit\n" + ["x".repeat(201), "b", "c", "d", "e", "f"].join("\n") + "\n"],
]) test(`interactive ${label} reports an error and accepts the next valid submission`, async t => {
  const app = await terminal(t);
  const state = await cli(app.args, { RESEARCH_RUN_DIR: "" }, { ...app.dependencies,
    input: Readable.from([input + "/submit " + JSON.stringify(names()) + "\n"]) });
  assert.equal(state.status, "completed");
  assert.deepEqual(state.humanSubmission, names());
  assert.equal(app.client.calls.length, 1, "invalid submissions never call the API");
  assert.match(app.output(), /提出.*確認.*再入力/u);
  assert.doesNotMatch(app.output(), /SECRET-INVALID-JSON|NamingTaskError| at /);
});

for (const [label, actions] of [
  ["utterance after submission", [{ submission: names() }, { utterance: "too late" }]],
  ["duplicate submission", [{ utterance: "do not send" }, { submission: names() }, { submission: names() }]],
]) test(`script rejects ${label} before trial creation, image export, or API calls`, async t => {
  const app = await terminal(t), script = join(app.dir, "turns.jsonl");
  await writeFile(script, actions.map(action => JSON.stringify(action)).join("\n") + "\n\n");
  await assert.rejects(cli([...app.args, "--script", script], { RESEARCH_RUN_DIR: "" }, app.dependencies), { code: "invalid_script" });
  assert.equal(app.client.calls.length, 0);
  assert.equal(app.trials(), 0);
  assert.deepEqual(await readdir(app.dir), ["turns.jsonl"]);
});
