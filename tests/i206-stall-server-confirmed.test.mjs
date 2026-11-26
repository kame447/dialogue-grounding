import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const web = new URL("../dialogue-model/runtime/web/", import.meta.url);
const [script, html, css] = await Promise.all(["app.js", "index.html", "style.css"].map((name) => readFile(new URL(name, web), "utf8")));
// A small DOM fixture exercises shipped event handlers, without browser packages.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {};
    this.value = ""; this._text = ""; this.textUpdates = 0; this.disabled = false; this.open = false;
    this.scrollTop = 0; this.clientHeight = 400;
  }
  set textContent(value) { this._text = String(value); this.children = []; this.textUpdates++; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; this.scrollTop = 0; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get scrollHeight() { return this.children.length * 200; }
  get elements() { return Object.fromEntries(this.querySelectorAll("input,select,textarea").map((node) => [node.getAttribute("name"), node])); }
  querySelectorAll(selector) {
    const matches = (child) => selector.split(",").some((part) => {
      const match = part.match(/^([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/u);
      return match && child.tagName === match[1] && (!match[2] || child.getAttribute(match[2]) === match[3]);
    });
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  fire(type, fields = {}) {
    const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...fields };
    for (const handler of this.handlers[type] ?? []) handler(event);
    return event;
  }
  requestSubmit() { this.fire("submit"); }
  focus(options) { this.focusOptions = options; this.focused = true; }
  showModal() { assert.equal(this.open, false); this.open = true; }
  close() { this.open = false; }
  scrollTo({ top }) { this.scrollTop = top; }
  getBBox() { return { x: 100, y: 150, width: 130, height: 180 }; }
}
function makeDOM() {
  const root = new Element("document"), stack = [root], ids = {};
  for (const token of html.matchAll(/<\/?([\w-]+)\b([^>]*?)>/gu)) {
    const [, tag, rest] = token;
    if (token[0].startsWith("</")) { if (stack.at(-1)?.tagName === tag) stack.pop(); continue; }
    const node = new Element(tag);
    for (const [, name, quoted, unquoted] of rest.matchAll(/([\w-]+)(?:="([^"]*)"|=([^\s]+))?/gu)) node.setAttribute(name, quoted ?? unquoted ?? "");
    node.value = node.getAttribute("value") ?? "";
    if (node.getAttribute("id")) ids[node.getAttribute("id")] = node;
    stack.at(-1).append(node);
    if (!["input", "meta", "link", "br"].includes(tag)) stack.push(node);
  }
  return { root, ids };
}
function trial(id = "trial-private") {
  return { version: 2, sessionId: id, submitted: false, aiStatus: "idle", events: [{ id: "event-1", speaker: "ai", text: "まず、どの図形から話しましょうか？" }], scene: {
    width: 1200, height: 800, shapes: ["s-a81c", "s-f120", "s-119e", "s-cc02", "s-a620", "s-67b4"].map((id, i) => ({
      id, path: `M ${100 + i * 140} 100 l 60 80 l -40 90 Z`, centroid: { x: 140 + i * 140, y: 200 },
    })),
  } };
}
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function ui(initial = trial(), handler) {
  const { root, ids: e } = makeDOM();
  let state = { trial: initial }, timerId = 0, now = 10000, clientSequence = 0;
  const timers = new Map(), calls = [];
  const document = { visibilityState: "visible", addEventListener: root.addEventListener.bind(root),
    getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  runInNewContext(script, {
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => "browser-client-" + ++clientSequence },
    document,
    FormData: class {
      constructor(form) { this.values = Object.entries(form.elements).map(([name, node]) => [name, node.value]); }
      get(name) { return this.values.find(([key]) => key === name)?.[1] ?? null; }
    },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay, at: now + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      const custom = await handler?.({ path, body, state });
      let value = state;
      if (custom) return { ok: custom.status < 400, status: custom.status, json: async () => structuredClone(custom.body) };
      if (path === "/api/message") {
        const eventId = "event-" + (state.trial.events.length + 1);
        state.trial.events.push({ id: eventId, speaker: "human", text: body.text, clientId: body.clientId });
        state.trial.aiStatus = "thinking"; value = { eventId, ...state };
      }
      if (path === "/api/retry") {
        state.trial.aiStatus = "idle";
        state.trial.events.push({ id: "event-retry", speaker: "ai", text: "再試行した応答" });
      }
      return { ok: true, status: path === "/api/message" ? 202 : 200, json: async () => structuredClone(value) };
    },
  });
  await tick();
  const advance = async (millis) => {
    const target = now + millis;
    for (let i = 0; i < 1000; i++) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { now = target; return; }
      timers.delete(next[0]); now = next[1].at; next[1].callback(); await tick();
    }
    assert.fail("fixture timer did not settle");
  };
  return { e, root, calls, getState: () => state, advance,
    setVisibility: (value) => { document.visibilityState = value; root.fire("visibilitychange"); },
    poll: async () => {
      const timer = [...timers.values()].filter((entry) => entry.delay === 700 || entry.delay === 2000).sort((a, b) => a.at - b.at)[0];
      assert.ok(timer, "a state refresh is scheduled"); await advance(timer.at - now);
    } };
}
const send = (e, text) => { e.utterance.value = text; e.chat.fire("submit"); };
// The AI's typing bubble (Issue #170) is display only and always last; it is
// not a message. Anywhere else it would show up below as a message without text.
const isTyping = (node) => node?.className === "ai typing-message";
const typingShown = (e) => isTyping(e.history.children.at(-1));
const typingCount = (e) => e.history.children.filter(isTyping).length;
const messageNodes = (e) => typingShown(e) ? e.history.children.slice(0, -1) : e.history.children;
const messageBodies = (e) => messageNodes(e).map((node) => node.querySelectorAll("p")[0]?.textContent);
const messageCalls = (calls) => calls.filter((call) => call.path === "/api/message");
const STOPPED = "進行を確認できません。実験担当者にお知らせください。";
const gate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; };

// #206 item 2: a turn the server itself reports as still being processed (busy), read successfully, is confirmed progress. A slow re-observation (up to 85 s in one call)
// is not a stall, and the client invents no shorter wait of its own. Everything that is not such a report keeps the no-progress watchdog.
const working = () => { const state = trial(); state.aiStatus = "thinking"; return state; };

test("server-confirmed processing is not a stall: dots stay and no stop is shown past the former one-minute wait", async () => {
  const { e, advance, getState } = await ui(working());
  getState().busy = true;
  await advance(1000);
  const status = e["chat-status"];
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.textContent, "AIが返答を作成しています");
  const updates = status.textUpdates;
  await advance(61000);
  assert.ok(typingShown(e), "the dots stay while the server reports work in progress");
  assert.equal(e["chat-recovery"].hidden, true);
  await advance(120000);
  assert.ok(typingShown(e));
  assert.equal(e["chat-recovery"].hidden, true);
  assert.equal(e.history.children.at(-1).getAttribute("aria-hidden"), "true");
  assert.equal(status.textContent, "AIが返答を作成しています");
  assert.equal(status.textUpdates, updates, "unchanged text is not written to the live region again");
});

test("when the server stops reporting work and reports an error, the stop shows at once", async () => {
  const { e, calls, advance, getState, poll } = await ui(working());
  getState().busy = true;
  await advance(100000);
  assert.equal(e["chat-recovery"].hidden, true);
  getState().trial.aiStatus = "error"; getState().busy = false; await poll();
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
  assert.equal(e["chat-status"].textContent, STOPPED);
  assert.equal(e["retry-chat"].textContent, "状態を確認");
  assert.equal(e["retry-chat"].disabled, false);
  const before = calls.length;
  e["retry-chat"].fire("click"); await tick();
  assert.deepEqual(calls.slice(before).filter(({ path }) => path === "/api/state" || path === "/api/retry"), [
    { path: "/api/state", body: undefined }, { path: "/api/retry", body: { expectedRecordId: getState().trial.sessionId } },
  ]);
});

test("a lost connection is not confirmation: busy from an earlier read does not hide the stall once reads fail", async () => {
  let offline = false;
  const { e, advance, getState } = await ui(working(), ({ path }) => { if (offline && path === "/api/state") throw new TypeError("Failed to fetch"); });
  getState().busy = true;
  await advance(5000);
  assert.equal(e["chat-recovery"].hidden, true);
  offline = true;
  await advance(10000);
  assert.equal(e["chat-recovery"].hidden, true, "a short interruption stays invisible");
  await advance(61000);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
});

test("without a server report of work in progress the no-progress watchdog is unchanged", async () => {
  const { e, advance } = await ui(working());
  await advance(59000);
  assert.equal(e["chat-recovery"].hidden, true);
  await advance(2000);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
});

test("an unanswered state request times out after the last confirmed busy response; state check does not resend", async () => {
  const pendingRead = gate();
  let noReply = false;
  const { e, calls, advance, getState } = await ui(working(), ({ path }) => {
    if (noReply && path === "/api/state") return pendingRead.wait;
  });
  getState().busy = true;
  await advance(5000);
  noReply = true;
  await advance(59000);
  assert.equal(e["chat-recovery"].hidden, true);
  await advance(2000);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-status"].textContent, STOPPED);
  const updates = e["chat-status"].textUpdates;
  await advance(12000);
  assert.equal(e["chat-status"].textUpdates, updates);
  noReply = false;
  getState().busy = false;
  pendingRead.release(); await tick();
  const before = calls.length;
  e["retry-chat"].fire("click"); await tick();
  assert.deepEqual(calls.slice(before).filter(({ path }) => path.startsWith("/api/")), [{ path: "/api/state", body: undefined }]);
  assert.equal(e["chat-recovery"].hidden, false);
});

test("a local timer cannot extend a previously received busy report when polling is suspended", async () => {
  const { e, advance, getState, setVisibility } = await ui(working());
  getState().busy = true;
  getState().trial.dialogueRecovery = "active";
  await advance(1000);
  setVisibility("hidden");
  await advance(61000);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
  assert.equal(e["chat-status"].textContent, STOPPED);
  assert.equal(e["retry-chat"].textContent, "状態を確認");
  setVisibility("visible");
  await advance(1000);
  assert.equal(e["chat-recovery"].hidden, true);
  assert.equal(e["chat-status"].textContent, "AIが返答を作成しています");
});
