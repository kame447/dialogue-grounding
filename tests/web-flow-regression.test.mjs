import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { startNamingServer } from "../dialogue-model/runtime/web/server.mjs";
import { createTrial } from "../dialogue-model/runtime/stimuli/board.mjs";
import { SLOTS, STRATEGIES } from "../dialogue-model/runtime/naming-task.mjs";

// Real six-figure rendered boards, deterministic scripted upstream. Names are
// supplied by this fixture; no inference about actual Luna task success follows.
const SEED = 829;
const rendered = createTrial({ seed: SEED });
const trial = { ...rendered, key: Object.fromEntries(["human", "ai"].map((side) => [side,
  Object.fromEntries(SLOTS.map((slot) => [slot, "PRIVATE-GOLD-" + rendered.key[side][slot]]))])) };
const names = ["ねこ", "かさ", "とり", "ふね", "やま", "はな"];
const ids = Object.values(trial.key.human).sort();
const nameById = Object.fromEntries(ids.map((id, i) => [id, names[i]]));
const submission = (side) => Object.fromEntries(SLOTS.map((slot) => [slot, nameById[trial.key[side][slot]]]));
const phase = (messages) => messages.some((m) => m.role === "system" && m.content.includes("【非公開の対話判断】"))
  ? "judge" : messages.at(-1).content.includes("最終提出要求") ? "final" : "generation";
const gate = () => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  return { entered: entered.promise, signal: entered.resolve, wait: released.promise, release: released.resolve };
};

async function setup(t, { hideStrategy = false } = {}) {
  const payloads = [], plan = { failNext: false, holdNext: null, invalidFinal: false };
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    payloads.push(body);
    const kind = phase(body.messages);
    if (kind === "generation" && plan.holdNext) {
      const hold = plan.holdNext;
      hold.signal(); await hold.wait; plan.holdNext = null;
    }
    if (kind === "generation" && plan.failNext) {
      plan.failNext = false; res.writeHead(500); res.end("PRIVATE-UPSTREAM-BODY"); return;
    }
    const index = body.messages.filter((m) => m.role === "user" && typeof m.content === "string").length - 1;
    const content = kind === "judge" ? JSON.stringify({ action: "propose_name", targetSlot: SLOTS[index % 6],
      candidateName: "PRIVATE-LEDGER-" + index, discriminatingFeature: null, note: "PRIVATE-JUDGMENT-NOTE" }) :
      kind === "final" ? (plan.invalidFinal ? '{"private-invalid-final":true}' : JSON.stringify(submission("ai"))) : "公開のAI固定応答";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "scripted-http-test-only", choices: [{ message: { content } }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "dummy-local-test-token",
    baseUrl: "http://127.0.0.1:" + upstream.address().port + "/v1", timeoutMs: 5000 });
  const server = await startNamingServer({ port: 0, client, createTrial: ({ seed }) => ({ ...trial, seed }), runDir: "", hideStrategy });
  t.after(async () => {
    plan.holdNext?.release();
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base + "/v1/");
  const html = await page.text(), cookie = page.headers.get("set-cookie").split(";")[0];
  const request = (path, body) => fetch(base + path, {
    headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  const json = async (path, body, status = 200) => {
    const response = await request(path, body), value = await response.json();
    assert.equal(response.status, status, path + ": " + JSON.stringify(value));
    return value;
  };
  return { request, json, payloads, plan, html };
}

function privateBeforeCompletion(state) {
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE-GOLD-|PRIVATE-LEDGER-|PRIVATE-JUDGMENT-NOTE|private-invalid-final|ownLedger|judgments|targetSlot|discriminatingFeature|dummy-local-test-token/);
  assert.equal(Object.hasOwn(state.trial, "aiSubmission"), false);
  assert.equal(Object.hasOwn(state.trial, "result"), false);
  assert.equal(Object.hasOwn(state.trial, "key"), false);
}

function completeResult(state) {
  assert.equal(state.trial.status, "completed");
  assert.equal(state.trial.result.provisional, true);
  assert.equal(state.trial.result.success, true);
  assert.equal(state.trial.result.matchedCount, 6);
  assert.equal(state.trial.result.figures.length, 6);
  for (const row of state.trial.result.figures) {
    assert.equal(trial.key.human[row.human.slot], trial.key.ai[row.ai.slot]);
    assert.notEqual(row.human.slot, row.ai.slot);
    assert.equal(row.human.rawName, row.ai.rawName);
    assert.equal(row.matched, true);
  }
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE-LEDGER-|PRIVATE-JUDGMENT-NOTE|ownLedger|judgments|targetSlot/);
  assert.equal(Object.hasOwn(state.trial, "key"), false);
}

for (const strategy of STRATEGIES) {
  test(`${strategy}: real HTTP start/image/chat/final uses shuffled scoring and withholds AI names`, { timeout: 10000 }, async (t) => {
    const app = await setup(t, { hideStrategy: true });
    let state = await app.json("/api/start", { strategy, seed: SEED });
    privateBeforeCompletion(state);
    assert.equal(Object.hasOwn(state.trial, "strategy"), false);
    assert.deepEqual(state.trial.slots, SLOTS);
    const image = await app.request("/api/image");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), trial.human.png);
    state = await app.json("/api/turn", { utterance: "公開の相談" });
    const history = state.trial.publicHistory;
    assert.deepEqual(history, [{ role: "user", content: "公開の相談" }, { role: "assistant", content: "公開のAI固定応答" }]);
    privateBeforeCompletion(state);
    state = await app.json("/api/ai-submit", {});
    assert.equal(state.trial.aiSubmitted, true);
    assert.equal(state.trial.humanSubmitted, false);
    privateBeforeCompletion(state);
    privateBeforeCompletion(await app.json("/api/state"));
    state = await app.json("/api/submit", { submission: submission("human") });
    completeResult(state);
    assert.deepEqual(state.trial.publicHistory, history);
    const requestCount = app.payloads.length;
    assert.deepEqual(await app.json("/api/submit", { submission: submission("human") }, 400), { error: "already_submitted" });
    assert.deepEqual(await app.json("/api/ai-submit", {}, 400), { error: "already_submitted" });
    assert.equal(app.payloads.length, requestCount);
    assert.deepEqual(app.payloads.map((body) => phase(body.messages)), ["judge", "generation", "final"]);
    for (const body of app.payloads) {
      assert.equal(body.purpose, "dialogue_turn");
      assert.equal(Object.hasOwn(body, "model"), false);
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /PRIVATE-GOLD-|humanSubmission|scoring|matchedCount/);
      assert.equal(text.includes(trial.human.png.toString("base64")), false);
      const images = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((part) => part.type === "image_url") : []);
      assert.equal(images.length, 1);
      assert.equal(images[0].image_url.url, "data:image/png;base64," + trial.ai.png.toString("base64"));
    }
  });

  test(`${strategy}: recoverable HTTP failure preserves history and rejects concurrent mutations`, { timeout: 10000 }, async (t) => {
    const app = await setup(t);
    await app.json("/api/start", { strategy, seed: SEED });
    const before = (await app.json("/api/turn", { utterance: "確定済み" })).trial.publicHistory;
    app.plan.failNext = true;
    assert.deepEqual(await app.json("/api/turn", { utterance: "再送する発話" }, 502), { error: "ai_unavailable" });
    const failed = await app.json("/api/state");
    assert.deepEqual(failed.trial.publicHistory, before);
    assert.equal(failed.busy, false); privateBeforeCompletion(failed);
    const hold = gate(); app.plan.holdNext = hold;
    const pending = app.json("/api/turn", { utterance: "再送する発話" });
    await hold.entered;
    const busy = await app.json("/api/state");
    assert.equal(busy.busy, true); privateBeforeCompletion(busy);
    assert.deepEqual(busy.trial.publicHistory, before);
    const count = app.payloads.length;
    for (const [path, body] of [["/api/start", { strategy, seed: SEED + 1 }], ["/api/turn", { utterance: "重複" }],
      ["/api/submit", { submission: submission("human") }], ["/api/ai-submit", {}]]) {
      assert.deepEqual(await app.json(path, body, 400), { error: "busy" });
    }
    assert.equal(app.payloads.length, count);
    hold.release();
    const recovered = await pending;
    assert.equal(recovered.busy, false);
    assert.deepEqual(recovered.trial.publicHistory, [...before,
      { role: "user", content: "再送する発話" }, { role: "assistant", content: "公開のAI固定応答" }]);
    const finals = await app.json("/api/submit", { submission: submission("human") });
    completeResult(finals);
    assert.deepEqual(finals.trial.publicHistory, recovered.trial.publicHistory);
  });
}

test("invalid private final response never becomes a public chat turn or successful result", { timeout: 10000 }, async (t) => {
  const app = await setup(t);
  await app.json("/api/start", { strategy: "repair-first", seed: SEED });
  const before = (await app.json("/api/turn", { utterance: "公開発話" })).trial.publicHistory;
  app.plan.invalidFinal = true;
  assert.deepEqual(await app.json("/api/submit", { submission: submission("human") }, 502), { error: "invalid_ai_submission" });
  const state = await app.json("/api/state");
  assert.equal(state.trial.status, "submission_error");
  assert.deepEqual(state.trial.publicHistory, before); privateBeforeCompletion(state);
  assert.equal(app.payloads.filter((body) => phase(body.messages) === "final").length, 2);
});

// Minimal DOM, but real shipped app.js, real HTTP server and real chat client.
// Form serialization and initial/start/chat/final responses all cross HTTP.
class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.value = ""; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  set src(value) { this.attributes.src = value; }
  get src() { return this.attributes.src; }
  get scrollHeight() { return this.children.length * 100; }
  get elements() { return Object.fromEntries(this.querySelectorAll("input").map((input) => [input.name, input])); }
  querySelectorAll(selector) {
    const tags = selector.split(",");
    return this.children.flatMap((child) => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  fire(type, fields = {}) {
    const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...fields };
    for (const handler of this.handlers[type] ?? []) handler(event);
    return event;
  }
  requestSubmit() { this.fire("submit"); }
  focus(options) { this.focusOptions = options; }
}

async function ui(t, strategy) {
  const app = await setup(t);
  const script = await readFile(new URL("../dialogue-model/runtime/web/v1/app.js", import.meta.url), "utf8");
  const elements = Object.fromEntries([...app.html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/gu)]
    .map(([, tag, id]) => [id, new Element(tag)]));
  const chatButton = new Element("button"), submitButton = new Element("button");
  elements.chat.append(elements.utterance, chatButton);
  elements.submission.append(elements.names, submitButton);
  const strategyInput = new Element("input"), seedInput = new Element("input");
  strategyInput.name = "strategy"; strategyInput.value = strategy;
  seedInput.name = "seed"; seedInput.value = String(SEED);
  elements.setup.append(strategyInput, seedInput, new Element("button"));
  const calls = [], outstanding = new Set();
  let fetchFailure;
  runInNewContext(script, {
    document: { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag),
      createTextNode: (text) => { const node = new Element("text"); node.textContent = text; return node; },
      querySelectorAll: (selector) => [...new Set(Object.values(elements).flatMap((element) => element.querySelectorAll(selector)))],
    },
    FormData: class {
      constructor(form) { this.values = form.querySelectorAll("input").map((input) => [input.name, input.value]); }
      get(name) { return this.values.find(([key]) => key === name)?.[1]; }
      [Symbol.iterator]() { return this.values[Symbol.iterator](); }
    },
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      const pending = app.request(path, body); outstanding.add(pending);
      try { return await pending; } catch (error) { fetchFailure = error; throw error; }
      finally { outstanding.delete(pending); }
    },
    setTimeout, clearTimeout,
  });
  // Bounded event-loop settling, with no arbitrary sleep or wall-clock race.
  const settled = async () => {
    for (let count = 0; count < 50; count++) {
      await Promise.all([...outstanding]);
      await new Promise((resolve) => setImmediate(resolve));
      if (fetchFailure) throw fetchFailure;
      if (!outstanding.size && calls.length && !elements.setup.querySelectorAll("button")[0].disabled) return;
    }
    assert.fail("UI did not settle after its HTTP responses");
  };
  await settled();
  return { ...app, elements, calls, settled, chatButton, submitButton };
}

for (const strategy of STRATEGIES) {
  test(`${strategy}: shipped UI starts, labels six names, recovers chat, and renders final HTTP result`, { timeout: 10000 }, async (t) => {
    const app = await ui(t, strategy), e = app.elements;
    assert.equal(e.trial.hidden, true);
    e.setup.fire("submit"); await app.settled();
    assert.equal(e.setup.hidden, true); assert.equal(e.trial.hidden, false);
    assert.equal(e.board.src, "/api/image");
    assert.deepEqual(app.calls[1], { path: "/api/start", body: { strategy, seed: SEED, visualAid: false, referenceMemory: false } });
    assert.equal(e.names.children.length, 6);
    e.names.children.forEach((label, i) => {
      const input = label.children[0];
      assert.equal(label.textContent, SLOTS[i]);
      assert.equal(label.htmlFor, input.id);
      assert.equal(input.name, SLOTS[i]);
    });

    e.utterance.value = "公開の相談";
    for (const event of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      assert.equal(e.utterance.fire("keydown", { key: "Enter", ...event }).prevented, false);
    }
    assert.equal(app.calls.length, 2);
    const hold = gate(); app.plan.holdNext = hold;
    e.utterance.fire("keydown", { key: "Enter" }); await hold.entered;
    assert.equal(e.utterance.disabled, true); assert.equal(app.chatButton.disabled, true);
    assert.equal(e["chat-status"].textContent, "AIが考えています…");
    const count = app.calls.length;
    e.chat.fire("submit"); e.utterance.fire("keydown", { key: "Enter" });
    assert.equal(app.calls.length, count, "busy UI sends exactly once");
    hold.release(); await app.settled();
    assert.equal(e.history.children.length, 2);
    assert.equal(e.history.scrollTop, e.history.scrollHeight);
    assert.equal(e.utterance.value, ""); assert.equal(e.utterance.disabled, false);
    assert.equal(e.utterance.focusOptions.preventScroll, true);

    app.plan.failNext = true; e.utterance.value = "再送する公開発話";
    e.chat.fire("submit"); await app.settled();
    assert.match(e.notice.textContent, /直前の確定状態/);
    assert.equal(e.history.children.length, 2);
    assert.equal(e.utterance.value, "再送する公開発話");
    e.chat.fire("submit"); await app.settled();
    assert.equal(e.history.children.length, 4);
    assert.equal(e.notice.textContent, "");
    const human = submission("human");
    for (const slot of SLOTS) e.submission.elements[slot].value = human[slot];
    e.submission.fire("submit"); await app.settled();
    assert.equal(e.results.hidden, false);
    assert.match(e["result-body"].textContent, /6図形の名称が一致/);
    assert.equal(e["result-body"].querySelectorAll("td").length, 24);
    assert.doesNotMatch(e["result-body"].textContent + e.history.textContent,
      /PRIVATE-GOLD-|PRIVATE-LEDGER-|PRIVATE-JUDGMENT-NOTE|figureId|targetSlot/);
    assert.equal(e.history.children.length, 4, "private final JSON is never appended to chat");
    assert.equal(e.utterance.disabled, true); assert.equal(app.submitButton.disabled, true);
    completeResult(await app.json("/api/state"));
  });
}
