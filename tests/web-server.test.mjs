import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { startNamingServer } from "./support/legacy-web-v1-fa84980/server.mjs";
import { SLOTS } from "../dialogue-model/runtime/naming-task.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
const names = (prefix) => Object.fromEntries(SLOTS.map((slot, i) => [slot, prefix + i]));
const trial = ({ seed }) => ({ trialId: "web-trial", seed, human: { png, mimeType: "image/png" }, ai: { png, mimeType: "image/png" },
  key: { human: names("PRIVATE-FIGURE"), ai: names("PRIVATE-FIGURE") } });
const score = ({ humanSubmission, aiSubmission }) => ({ provisional: true, success: true,
  figures: SLOTS.map((humanSlot) => ({ human: { slot: humanSlot, rawName: humanSubmission[humanSlot] }, ai: { slot: humanSlot, rawName: aiSubmission[humanSlot] }, matched: true })) });

async function setup(t, { hideStrategy = false, fail = false } = {}) {
  const payloads = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    if (fail) { res.writeHead(500); res.end("RAW-ERROR-SECRET-TOKEN-PROMPT-IMAGE"); return; }
    const final = payloads.at(-1).messages.at(-1).content.includes("最終提出要求");
    const judgment = payloads.at(-1).messages.some((message) => message.role === "system" && message.content.includes("【非公開の対話判断】"));
    const content = judgment ? JSON.stringify({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }) :
      final ? JSON.stringify(names("AI-PRIVATE-")) : "公開AI発話";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "mock", choices: [{ message: { content } }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "PRIVATE-TEST-KEY",
    baseUrl: "http://127.0.0.1:" + upstream.address().port + "/v1" });
  const server = await startNamingServer({ port: 0, client, createTrial: trial, scoreTrial: score, runDir: "", hideStrategy });
  t.after(async () => {
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base + "/v1/");
  const cookie = page.headers.get("set-cookie").split(";")[0];
  async function request(path, body, extra = {}) {
    return fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  }
  return { server, base, page, cookie, payloads, request };
}

test("local Web workflow serves own image, public chat, private submission, then provisional per-figure result", async (t) => {
  const { server, page, request, payloads } = await setup(t, { hideStrategy: true });
  assert.equal(server.address().address, "127.0.0.1");
  assert.match(await page.text(), /研究者用：試行の開始/);
  assert.match(page.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  let response = await request("/api/start", { strategy: "bypass-enabled", seed: 102 });
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.ok(!Object.hasOwn(state.trial, "strategy"));
  assert.equal(state.trial.seed, 102);
  const image = await request("/api/image");
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  state = await (await request("/api/turn", { utterance: "公開人間発話" })).json();
  assert.equal(state.trial.publicHistory.length, 2);
  state = await (await request("/api/ai-submit", {})).json();
  assert.equal(state.trial.aiSubmitted, true);
  assert.ok(!Object.hasOwn(state.trial, "aiSubmission"));
  assert.ok(!JSON.stringify(state).includes("AI-PRIVATE-"));
  assert.ok(!Object.hasOwn((await (await request("/api/state")).json()).trial, "result"));
  const human = names("HUMAN-PRIVATE-");
  response = await request("/api/submit", { submission: human });
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.trial.status, "completed");
  assert.equal(state.trial.result.provisional, true); assert.equal(state.trial.result.figures.length, 6);
  assert.equal(state.trial.aiSubmission[SLOTS[0]], "AI-PRIVATE-0");
  assert.doesNotMatch(JSON.stringify(payloads), /HUMAN-PRIVATE|PRIVATE-FIGURE/);
  assert.equal((await request("/api/turn", { utterance: "終了後" })).status, 400);
});

test("submitting human names first triggers private AI final request, without transmitting human names", async (t) => {
  const { request, payloads } = await setup(t);
  await request("/api/start", { strategy: "repair-first", seed: 100 });
  const result = await (await request("/api/submit", { submission: names("PRIVATE-HUMAN") })).json();
  assert.equal(result.trial.status, "completed"); assert.equal(payloads.length, 1);
  assert.doesNotMatch(JSON.stringify(payloads), /PRIVATE-HUMAN/);
});

test("Web errors never return raw API errors, prompts, images, or tokens; failed turn is not committed", async (t) => {
  const { request } = await setup(t, { fail: true });
  await request("/api/start", { strategy: "repair-first", seed: 100 });
  const response = await request("/api/turn", { utterance: "PRIVATE-PROMPT-TEXT" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "ai_unavailable" });
  const state = await (await request("/api/state")).json();
  assert.deepEqual(state.trial.publicHistory, []);
  const submitted = await request("/api/submit", { submission: names("human") });
  assert.equal(submitted.status, 502);
  assert.deepEqual(await submitted.json(), { error: "ai_unavailable" });
  const failed = await (await request("/api/state")).json();
  assert.equal(failed.trial.humanSubmitted, true); assert.equal(failed.trial.status, "submitting");
  assert.ok(!Object.hasOwn(failed.trial, "result"));
});

test("Web rejects cross-origin/foreign host requests and isolates browser sessions", async (t) => {
  const { base, request } = await setup(t);
  assert.equal((await fetch(base + "/api/state")).status, 401);
  assert.equal((await request("/api/start", { strategy: "repair-first", seed: 100 }, { Origin: "https://untrusted.invalid" })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base + "/api/state", { headers: { Host: "attacker.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  await request("/api/start", { strategy: "repair-first", seed: 100 });
  const otherPage = await fetch(base + "/v1/");
  const otherCookie = otherPage.headers.get("set-cookie").split(";")[0];
  const other = await fetch(base + "/api/state", { headers: { cookie: otherCookie } });
  assert.equal((await other.json()).trial, null);
  assert.equal((await request("/does-not-exist")).status, 404);
  assert.equal((await request("/api/start", { strategy: "unsupported", seed: 100 })).status, 400);
  const current = await (await request("/api/state")).json();
  assert.equal(current.trial.seed, 100);
});

// A small DOM surface executes the shipped UI script without a browser or npm
// dependencies. HTTP tests above exercise the real server independently.
async function uiHarness({ unstarted = false } = {}) {
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.value = ""; this._text = ""; this.scrollTop = 0; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ""; this.children = [...children]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    get scrollHeight() { return this.children.length * 100; }
    querySelectorAll(selector) { const tags = selector.split(","); return this.children.flatMap((c) => [...(tags.includes(c.tagName) ? [c] : []), ...c.querySelectorAll(selector)]); }
    get elements() { return this._elements ?? Object.fromEntries(this.querySelectorAll("input").map(input => [input.name, input])); }
    set elements(value) { this._elements = value; }
    addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
    fire(type, values = {}) { const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...values }; for (const handler of this.handlers[type] ?? []) handler(event); return event; }
    requestSubmit() { this.fire("submit"); }
    focus(options) { this.focusOptions = options; }
  }
  const html = await readFile(new URL("../dialogue-model/runtime/web/v1/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../dialogue-model/runtime/web/v1/app.js", import.meta.url), "utf8");
  const elements = Object.fromEntries([...html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/gu)].map(([, tag, id]) => [id, new Element(tag)]));
  const chatButton = new Element("button"), submitButton = new Element("button");
  elements.chat.append(elements.utterance, elements["chat-status"], chatButton);
  elements.submission.append(elements.names, submitButton);
  const setupButton = new Element("button"); elements.setup.append(setupButton);
  const strategyInput = new Element("input"), seedInput = new Element("input");
  strategyInput.name = "strategy"; strategyInput.value = "repair-first";
  seedInput.name = "seed"; seedInput.value = "1";
  const toggles = ["visualAid", "referenceMemory"].map(name => {
    const input = new Element("input"); input.type = "checkbox"; input.name = name; input.value = "on"; input.checked = false;
    return input;
  });
  elements.setup.append(strategyInput, seedInput, ...toggles);
  const requests = [], pending = [];
  const state = { busy: false, hideStrategy: true, trial: unstarted ? null :
    { trialId: "dom-trial", slots: SLOTS, status: "dialogue", publicHistory: [], humanSubmitted: false } };
  const response = (value, ok = true) => ({ ok, json: async () => value });
  runInNewContext(script, {
    document: {
      getElementById: (id) => elements[id], createElement: (tag) => new Element(tag),
      createTextNode: (text) => { const node = new Element("text"); node.textContent = text; return node; },
      querySelectorAll: (selector) => [...new Set(Object.values(elements).flatMap((e) => e.querySelectorAll(selector)))],
    },
    FormData: class {
      constructor(form) { this.values = form.querySelectorAll("input").filter(input => input.type !== "checkbox" || input.checked).map(input => [input.name, input.value]); }
      get(name) { return this.values.find(([key]) => key === name)?.[1] ?? null; }
      [Symbol.iterator]() { return this.values[Symbol.iterator](); }
    },
    fetch: async (path, options) => {
      requests.push({ path, body: options?.body ? JSON.parse(options.body) : undefined });
      if (path === "/api/state") return response(state);
      return new Promise((resolve) => pending.push((value, ok) => resolve(response(value, ok))));
    },
    setTimeout, clearTimeout,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  return { elements, chatButton, requests, pending, state, settle };
}

test("Web UI keeps a bounded transcript and responsive image beside a stable composer", async () => {
  const css = await readFile(new URL("../dialogue-model/runtime/web/v1/style.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../dialogue-model/runtime/web/v1/index.html", import.meta.url), "utf8");
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:1\.3fr 1fr/u);
  assert.match(css, /\.workspace \.panel\s*\{[^}]*height:clamp\([^}]*display:flex/u);
  assert.match(css, /#history\s*\{[^}]*min-height:0[^}]*overflow-y:auto[^}]*overscroll-behavior:contain/u);
  assert.match(css, /#chat textarea\s*\{resize:none\}/u);
  assert.match(css, /@media\(max-width:850px\)\{\.workspace\{grid-template-columns:1fr/u);
  assert.match(html, /<label for="utterance">/u);
  assert.match(html, /id="chat-status" role="status" aria-live="polite"/u);
  assert.match(html, /Enterで送信・Shift\+Enterで改行/u);
});

test("researcher toggles are labelled, unchecked by default, and confined to the setup form", async () => {
  const html = await readFile(new URL("../dialogue-model/runtime/web/v1/index.html", import.meta.url), "utf8");
  const setup = html.match(/<form id="setup"[\s\S]*?<\/form>/u)[0];
  for (const [id, name] of [["visual-aid", "visualAid"], ["reference-memory", "referenceMemory"]]) {
    assert.match(setup, new RegExp('for="' + id + '"'));
    const input = setup.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))[0];
    assert.match(input, new RegExp('name="' + name + '"'));
    assert.match(input, /type="checkbox"/u);
    assert.doesNotMatch(input, /\bchecked\b/u);
  }
  assert.doesNotMatch(html.slice(html.indexOf('<section id="trial"')), /visualAid|referenceMemory|視覚補助|参照メモリ/u);
});

for (const [visualAid, referenceMemory] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`Web UI sends selected booleans and hides researcher setup during the trial (${visualAid},${referenceMemory})`, async () => {
    const { elements, requests, pending, state, settle } = await uiHarness({ unstarted: true });
    assert.equal(elements.setup.hidden, false);
    elements.setup.elements.visualAid.checked = visualAid;
    elements.setup.elements.referenceMemory.checked = referenceMemory;
    elements.setup.fire("submit");
    assert.deepEqual(requests.at(-1), { path: "/api/start", body: { strategy: "repair-first", seed: 1, visualAid, referenceMemory } });
    pending.shift()({ ...state, trial: { trialId: "blind-toggle-trial", slots: SLOTS, status: "dialogue", publicHistory: [], humanSubmitted: false } });
    await settle();
    assert.equal(elements.setup.hidden, true);
    assert.equal(elements.trial.hidden, false);
    assert.doesNotMatch(elements.trial.textContent, /視覚補助|参照メモリ|visualAid|referenceMemory/u);
  });
}

test("Web UI labels all six final names explicitly and suppresses keyboard send during IME or Shift+Enter", async () => {
  const { elements, requests } = await uiHarness();
  assert.equal(elements.names.children.length, 6);
  elements.names.children.forEach((label, i) => {
    assert.equal(label.textContent, SLOTS[i]);
    assert.equal(label.htmlFor, label.children[0].id);
    assert.ok(label.htmlFor);
    assert.equal(label.children[0].name, SLOTS[i]);
  });
  const input = elements.utterance; input.value = "会話";
  for (const event of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(input.fire("keydown", { key: "Enter", ...event }).prevented, false);
  }
  input.fire("compositionstart");
  assert.equal(input.fire("keydown", { key: "Enter" }).prevented, false);
  input.fire("compositionend");
  assert.equal(requests.length, 1);
  input.value = "　 ";
  assert.equal(input.fire("keydown", { key: "Enter" }).prevented, true);
  assert.equal(requests.length, 1);
});

test("Web UI Enter sends once, disables input throughout AI wait, and scrolls new messages without moving focus", async () => {
  const { elements, chatButton, requests, pending, state, settle } = await uiHarness();
  elements.utterance.value = "この図形はどう見えますか";
  const enter = elements.utterance.fire("keydown", { key: "Enter" });
  assert.equal(enter.prevented, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { path: "/api/turn", body: { utterance: "この図形はどう見えますか" } });
  assert.equal(elements.utterance.disabled, true);
  assert.equal(chatButton.disabled, true);
  assert.equal(elements["chat-status"].textContent, "AIが考えています…");
  elements.chat.fire("submit"); elements.utterance.fire("keydown", { key: "Enter" });
  assert.equal(requests.length, 2);
  const publicHistory = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "公開発話" + i }));
  pending.shift()({ ...state, trial: { ...state.trial, publicHistory } });
  await settle();
  assert.equal(elements.history.children.length, 60);
  assert.equal(elements.history.scrollTop, elements.history.scrollHeight);
  assert.equal(elements.utterance.disabled, false); assert.equal(chatButton.disabled, false);
  assert.equal(elements["chat-status"].textContent, "");
  assert.equal(elements.utterance.value, "");
  assert.equal(elements.utterance.focusOptions.preventScroll, true);
});

test("Web UI retains result table while omitting private figure IDs from every displayed detail", async () => {
  const ui = await uiHarness();
  const result = {
    provisional: true, success: true, matchedCount: 6,
    figures: SLOTS.map((slot, i) => ({ figureId: "PRIVATE-ID-" + i, human: { slot, rawName: "名前" + i }, ai: { rawName: "名前" + i }, matched: true })),
    duplicateNames: { human: [{ name: "重複", slots: SLOTS.slice(0, 2), figureIds: ["PRIVATE-DUPLICATE"] }], ai: [] },
  };
  // Reuse a turn response to render a finished server state without coupling the
  // DOM harness to form serialization or the server's final-request protocol.
  ui.elements.utterance.value = "完了"; ui.elements.chat.fire("submit");
  ui.pending.shift()({ trial: { ...ui.state.trial, status: "completed", humanSubmitted: true, result } });
  await ui.settle();
  assert.equal(ui.elements.results.hidden, false);
  assert.equal(ui.elements["result-body"].querySelectorAll("table").length, 1);
  assert.equal(ui.elements["result-body"].querySelectorAll("td").length, 24);
  assert.match(ui.elements["result-body"].textContent, /あなたの位置/u);
  assert.match(ui.elements["result-body"].textContent, /研究者用/u);
  assert.doesNotMatch(ui.elements["result-body"].textContent, /PRIVATE-|figureId/u);
  assert.equal(ui.elements.utterance.disabled, true);
});

for (const [error, status, aiSubmitted] of [["ai_unavailable", "submitting", false], ["scoring_error", "scoring_error", true]]) {
  test(`Web UI offers ${error} retry without resubmitting human names`, async () => {
    const { elements, requests, pending, state, settle } = await uiHarness();
    elements.submission.fire("submit");
    assert.equal(requests.at(-1).path, "/api/submit");
    state.trial = { ...state.trial, status, humanSubmitted: true, aiSubmitted,
      humanSubmission: names("committed-human-") };
    pending.shift()({ error }, false);
    await settle();
    assert.match(elements.notice.textContent, error === "scoring_error" ? /採点でエラー/ : /再試行/);
    if (error === "scoring_error") assert.match(elements["submission-status"].textContent, /採点でエラー/);
    const retry = elements.submission.querySelectorAll("button").find(button => /再試行/.test(button.textContent));
    assert.ok(retry, "a dedicated final-submission retry button is present");
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(elements.submission.querySelectorAll("input")[0].disabled, true);
    retry.fire("click");
    assert.deepEqual(requests.at(-1), { path: "/api/ai-submit", body: {} });
    assert.equal(retry.disabled, true);
    pending.shift()({ ...state, trial: { ...state.trial, status: "completed", aiSubmitted: true } });
    await settle();
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, true);
  });
}
