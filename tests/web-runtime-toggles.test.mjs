import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNamingServer } from "../dialogue-model/runtime/web/server.mjs";
import { main as cli } from "../dialogue-model/runtime/naming-cli.mjs";
import { SLOTS } from "../dialogue-model/runtime/naming-task.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
const client = { complete() { assert.fail("toggle boundary tests must not call an API"); } };
const createTrial = ({ seed }) => ({ trialId: "toggle-trial", seed, human: { png, mimeType: "image/png" },
  ai: { png, mimeType: "image/png" }, key: {} });

function factory() {
  const calls = [];
  const states = [];
  return { calls, states, createTask(options) {
    calls.push(options);
    // Deliberately include condition fields in the fake to test the HTTP
    // boundary independently of naming-task's own state redaction contract.
    const state = Object.freeze({ trialId: "fake-toggle-trial", status: "dialogue", seed: options.seed,
      strategy: options.strategy, visualAid: options.visualAid, referenceMemory: options.referenceMemory,
      slots: [...SLOTS], busy: false, publicHistory: [] });
    states.push(state);
    return { getState: () => state, getHumanImage: () => ({ png, mimeType: "image/png" }) };
  } };
}

async function web(t, hideStrategy = false) {
  const fake = factory();
  const server = await startNamingServer({ port: 0, client, createTrial, createTask: fake.createTask, hideStrategy, runDir: "" });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base);
  await page.text();
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const request = (path, body) => fetch(base + path, { headers: { cookie,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { ...fake, request };
}

for (const hideStrategy of [false, true]) test(`Web passes boolean toggle combinations and redacts participant state (hideStrategy=${hideStrategy})`, async t => {
  const app = await web(t, hideStrategy);
  for (const toggles of [{}, { visualAid: true }, { referenceMemory: true }, { visualAid: true, referenceMemory: true },
    { visualAid: false, referenceMemory: false }]) {
    const response = await app.request("/api/start", { strategy: "repair-first", seed: 1, ...toggles });
    assert.equal(response.status, 200);
    const options = app.calls.at(-1);
    assert.ok(options, "task creation must use the injected factory");
    assert.equal(options.visualAid, toggles.visualAid ?? false);
    assert.equal(options.referenceMemory, toggles.referenceMemory ?? false);
    for (const value of [await response.json(), await (await app.request("/api/state")).json()]) {
      assert.equal(Object.hasOwn(value.trial, "visualAid"), false);
      assert.equal(Object.hasOwn(value.trial, "referenceMemory"), false);
      assert.equal(Object.hasOwn(value.trial, "strategy"), !hideStrategy);
    }
    assert.equal(app.states.at(-1).strategy, "repair-first", "redaction must not mutate task state");
    assert.equal(app.states.at(-1).visualAid, toggles.visualAid ?? false);
  }
});

test("Web rejects nonboolean toggle values before replacing a trial or calling its factory", async t => {
  const app = await web(t);
  const started = await app.request("/api/start", { strategy: "repair-first", seed: 1 });
  assert.equal(started.status, 200); await started.json();
  for (const key of ["visualAid", "referenceMemory"]) for (const value of [null, "false", "true", 0, 1, [], {}]) {
    const response = await app.request("/api/start", { strategy: "repair-first", seed: 2, [key]: value });
    assert.equal(response.status, 400, key + "=" + JSON.stringify(value));
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  assert.equal(app.calls.length, 1);
  const state = await (await app.request("/api/state")).json();
  assert.equal(state.trial.seed, 1);
});

for (const [flags, visualAid, referenceMemory] of [
  [[], false, false], [["--visual-aid"], true, false], [["--reference-memory"], false, true],
  [["--visual-aid", "--reference-memory"], true, true],
]) test(`CLI forwards default-off toggles: ${flags.join(" ") || "neither"}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "naming-toggle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = factory();
  const state = await cli(["--strategy", "repair-first", "--seed", "1", "--image-dir", dir, ...flags],
    { RESEARCH_RUN_DIR: "" }, { client, createTrial, createTask: fake.createTask, input: Readable.from(["/exit\n"]),
      output: new Writable({ write(chunk, encoding, done) { done(); } }) });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].visualAid, visualAid);
  assert.equal(fake.calls[0].referenceMemory, referenceMemory);
  assert.equal(state.status, "dialogue");
  assert.equal((await readdir(dir)).length, 1);
});

test("CLI refuses values attached to boolean flags before task creation", async () => {
  const fake = factory();
  for (const flag of ["--visual-aid=false", "--reference-memory=true"]) {
    await assert.rejects(cli([flag], {}, { createTask: fake.createTask }), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
  }
  assert.equal(fake.calls.length, 0);
});
