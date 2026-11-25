import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNamingServer } from "./support/legacy-web-v1-fa84980/server.mjs";
import { main as cli } from "../dialogue-model/runtime/naming-cli.mjs";
import { SLOTS } from "../dialogue-model/runtime/naming-task.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { createTrial as renderedTrial } from "../dialogue-model/runtime/stimuli/board.mjs";
import { createOwnImageRotationSheet } from "../dialogue-model/runtime/visual/own-image-rotation.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";

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

// Integration below keeps the real task, session, judge and HTTP chat client.
// Only upstream inference and scoring are deterministic local fixtures.
const integratedBoard = renderedTrial({ seed: 31 });
const ownImageURL = "data:image/png;base64," + integratedBoard.ai.png.toString("base64");
const rotationURL = "data:image/png;base64," + createOwnImageRotationSheet(integratedBoard.ai.png, { enabled: true }).png.toString("base64");
const publicTurns = ["この図形の名称は帆で合意します", "次の図形も相談しましょう"];
const finalNames = Object.fromEntries(SLOTS.map((slot, i) => [slot, "最終名称" + i]));
const requestPhase = body => body.messages.some(m => m.role === "system" && m.content.includes("【非公開の対話判断】")) ? "judge" :
  body.messages.at(-1).content.includes("最終提出要求") ? "final" : "generation";
const imageURLs = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === "image_url").map(p => p.image_url.url) : []);
const messageText = body => JSON.stringify(body.messages.map(m => ({ ...m,
  content: Array.isArray(m.content) ? m.content.filter(p => p.type !== "image_url") : m.content })));

function checkParticipantState(state, blind = false) {
  for (const key of ["visualAid", "referenceMemory", "options", "referenceGraph", "reference", "memoryOps", "ownLedger", "judgments"]) assert.equal(Object.hasOwn(state, key), false, key);
  if (blind) assert.equal(Object.hasOwn(state, "strategy"), false);
  assert.doesNotMatch(JSON.stringify(state), /ownReferences|memoryOps|PRIVATE-CORRESPONDENCE/u);
}

async function integratedRuntime(t, referenceMemory) {
  const directory = await mkdtemp(join(tmpdir(), "naming-integrated-toggles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  let judgments = 0;
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); requests.push(body);
    const phase = requestPhase(body);
    const reference = phase === "judge" && judgments++ === 0 ? {
      slots: [SLOTS[0]], epistemic: "grounded", intent: "name_acceptance", feature: null,
      nameAcceptance: { slot: SLOTS[0], name: "帆" }, deferSlot: null, revisitSlot: null,
    } : null;
    const text = phase === "judge" ? JSON.stringify({ ...SAFE_JUDGMENT, ...(referenceMemory ? { reference } : {}) }) :
      phase === "final" ? JSON.stringify(finalNames) : "公開されたAIの固定応答";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "loopback-test-only", choices: [{ message: { content: text } }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const localClient = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "TEST-LOCAL-ONLY",
    baseUrl: "http://127.0.0.1:" + upstream.address().port + "/v1" });
  const records = join(directory, "records");
  const options = { client: localClient, runDir: records,
    createTrial: ({ seed }) => ({ ...integratedBoard, seed, key: { human: "PRIVATE-CORRESPONDENCE", ai: "PRIVATE-CORRESPONDENCE" } }),
    scoreTrial: () => ({ provisional: true, success: true, figures: [] }) };
  const record = async () => {
    const files = await readdir(records); assert.equal(files.length, 1);
    return JSON.parse(await readFile(join(records, files[0]), "utf8"));
  };
  return { options, directory, records, requests, record };
}

for (const entrypoint of ["Web", "CLI"]) for (const strategy of ["repair-first", "bypass-enabled"]) {
  for (const [visualAid, referenceMemory] of [[false, false], [true, false], [false, true], [true, true]]) {
    test(`${entrypoint} real runtime: ${strategy}, visual=${visualAid}, memory=${referenceMemory}`, async t => {
      const app = await integratedRuntime(t, referenceMemory);
      let state;
      if (entrypoint === "Web") {
        const server = await startNamingServer({ port: 0, ...app.options, hideStrategy: true });
        t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
        const base = "http://127.0.0.1:" + server.address().port;
        const page = await fetch(base); await page.text();
        const cookie = page.headers.get("set-cookie").split(";")[0];
        const request = (path, body) => fetch(base + path, { headers: { cookie,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
        const json = async (path, body) => {
          const response = await request(path, body), value = await response.json();
          assert.equal(response.status, 200, JSON.stringify(value));
          checkParticipantState(value.trial, true);
          return value.trial;
        };
        await json("/api/start", { strategy, seed: 31, visualAid, referenceMemory });
        for (const utterance of publicTurns) await json("/api/turn", { utterance });
        const image = await request("/api/image");
        assert.equal(image.status, 200);
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), integratedBoard.human.png);
        state = await json("/api/submit", { submission: finalNames });
        assert.deepEqual(await json("/api/state"), state);
      } else {
        let output = "";
        const imageDirectory = join(app.directory, "images");
        state = await cli(["--strategy", strategy, "--seed", "31", "--image-dir", imageDirectory,
          ...(visualAid ? ["--visual-aid"] : []), ...(referenceMemory ? ["--reference-memory"] : [])],
        { RESEARCH_RUN_DIR: app.records }, { ...app.options,
          input: Readable.from([publicTurns.join("\n") + "\n/submit " + JSON.stringify(finalNames) + "\n"]),
          output: new Writable({ write(chunk, encoding, done) { output += chunk; done(); } }) });
        checkParticipantState(state);
        assert.doesNotMatch(output, /visualAid|referenceMemory|ownReferences|referenceGraph|memoryOps|PRIVATE-CORRESPONDENCE/u);
        const images = await readdir(imageDirectory); assert.equal(images.length, 1);
        assert.deepEqual(await readFile(join(imageDirectory, images[0])), integratedBoard.human.png);
      }
      assert.equal(state.status, "completed");
      assert.equal(state.publicHistory.length, 4);
      assert.deepEqual(app.requests.map(requestPhase), ["judge", "generation", "judge", "generation", "final"]);
      for (const body of app.requests) {
        assert.equal(body.purpose, "dialogue_turn");
        assert.deepEqual(imageURLs(body), visualAid ? [ownImageURL, rotationURL] : [ownImageURL]);
        assert.ok(!JSON.stringify(body).includes(integratedBoard.human.png.toString("base64")));
        assert.doesNotMatch(messageText(body), /PRIVATE-CORRESPONDENCE|visualAid|referenceMemory/u);
        assert.ok(body.messages.every(m => !Array.isArray(m.content) || m.content.length <= 4));
        assert.ok(Buffer.byteLength(JSON.stringify(body)) < 18 * 1024 * 1024);
        if (visualAid) {
          const ownIndex = body.messages.findIndex(m => Array.isArray(m.content));
          assert.equal(body.messages[ownIndex + 1].role, "user");
          assert.equal(body.messages[ownIndex + 1].content.length, 2);
          assert.match(body.messages[ownIndex + 1].content[0].text, /0\/90\/180\/270/u);
        }
        if (!referenceMemory || requestPhase(body) !== "judge") assert.doesNotMatch(messageText(body), /ownReferences|memoryOps|publicTurns|referenceGraph|nameAcceptance|deferSlot|revisitSlot/u);
      }
      const record = await app.record();
      assert.deepEqual(record.options, { visualAid, referenceMemory });
      if (referenceMemory) {
        const judges = app.requests.filter(body => requestPhase(body) === "judge");
        const workingMemory = judges[1].messages.find(m => m.role === "system" && m.content.includes('"ownReferences":')).content;
        const summary = JSON.parse(workingMemory.slice(workingMemory.indexOf("\n") + 1));
        assert.equal(summary.ownReferences.revision, 1);
        assert.equal(summary.ownReferences.ownSlots[SLOTS[0]].candidate.name, "帆");
        assert.equal(record.referenceGraph.revision, 2);
        assert.equal(record.referenceGraph.ownSlots[SLOTS[0]].candidate.name, "帆");
        assert.deepEqual(record.judgments.map(item => item.memory.opsApplied), [2, 0]);
        assert.deepEqual(record.judgments.map(item => item.memory.interpretation), [true, false]);
        for (const item of record.judgments) {
          assert.equal(Object.hasOwn(item.judgment, "reference"), false, "raw reference interpretation stays out of judgment traces");
          assert.equal(Object.hasOwn(item.judgment, "memoryOps"), false, "program-generated operations stay out of judgment traces");
        }
        assert.equal(record.ownLedger[SLOTS[0]].name, null, "memory updates must not rewrite the ledger");
      } else {
        assert.equal(Object.hasOwn(record, "referenceGraph"), false);
        assert.ok(record.judgments.every(item => !Object.hasOwn(item, "memory")));
      }
    });
  }
}
