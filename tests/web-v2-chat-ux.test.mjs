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
    this.value = ""; this._text = ""; this.disabled = false; this.open = false;
    this.scrollTop = 0; this.clientHeight = 400;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
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
async function ui(initial = trial(), handler, { tabSessionId, busy = false, storage = new Map(), startTime = 10000, initialReception, uuid } = {}) {
  const { root, ids: e } = makeDOM();
  let state = { trial: initial, busy, reception: initialReception }, timerId = 0, now = startTime, clientSequence = 0;
  const timers = new Map(), calls = [];
  const document = {
    visibilityState: "visible",
    getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    addEventListener: (type, listener) => root.addEventListener(type, listener),
  };
  runInNewContext(script, {
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: uuid ?? (() => "browser-client-" + ++clientSequence) },
    ...(tabSessionId ? { TangramTabSession: { resolve: async () => ({ kind: "restored", sessionId: tabSessionId }) } } : {}),
    document,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    FormData: class {
      constructor(form) { this.values = Object.entries(form.elements).map(([name, node]) => [name, node.value]); }
      get(name) { return this.values.find(([key]) => key === name)?.[1] ?? null; }
    },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay, at: now + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      const tabHeader = options?.headers?.["X-Tab-Session"];
      if (tabSessionId) assert.equal(tabHeader, tabSessionId, path);
      calls.push({ path, body, tabHeader, now });
      const custom = await handler?.({ path, body, state });
      let value = state;
      if (custom) return { ok: custom.status < 400, status: custom.status,
        headers: { get: (name) => custom.headers?.[name] ?? null }, json: async () => {
          if (custom.invalidJson) throw new SyntaxError("truncated synthetic JSON");
          return structuredClone(custom.body);
        } };
      if (path === "/api/message") {
        const eventId = "event-" + (state.trial.events.length + 1);
        state.trial.events.push({ id: eventId, speaker: "human", text: body.text, clientId: body.clientId });
        state.trial.aiStatus = "thinking"; value = { eventId, ...state };
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
  return { e, root, calls, storage, now: () => now, getState: () => state, advance,
    visibility: async (value) => { document.visibilityState = value; root.fire("visibilitychange"); await tick(); },
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
const DELAYED = "応答に時間がかかっています。入力した内容は保持されています。";
const RECOVERING = "応答に時間がかかっています。自動で再試行しています。入力した内容は保持されています。";
const manualPaths = ["/api/retry", "/api/interrupt", "/api/ai-submit"];
const gate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; };

test("opening is the first ordinary AI bubble; send immediately clears, refocuses and appends before acknowledgement", async () => {
  const held = gate();
  const { e, calls } = await ui(trial(), async ({ path }) => { if (path === "/api/message") await held.wait; });
  assert.equal(e.history.children[0].className, "ai");
  assert.equal(messageBodies(e)[0], "まず、どの図形から話しましょうか？");
  send(e, "最初のメッセージ");
  assert.equal(e.utterance.value, ""); assert.equal(e.utterance.focused, true);
  assert.deepEqual(messageBodies(e), ["まず、どの図形から話しましょうか？", "最初のメッセージ"]);
  assert.equal(messageCalls(calls).length, 1);
  assert.equal(messageCalls(calls)[0].body.clientId, "browser-client-1");
  held.release(); await tick();
  assert.equal(messageNodes(e).length, 2);
});

test("active AI work, a held POST and polling keep the next draft and its IME editable", async () => {
  const initial = { ...trial(), status: "dialogue", aiStatus: "thinking", dialogueRecovery: "active", recovering: true };
  const post = gate(), stateRead = gate();
  let posts = 0, reads = 0;
  const app = await ui(initial, async ({ path }) => {
    if (path === "/api/message" && ++posts === 1) await post.wait;
    if (path === "/api/state" && ++reads === 2) await stateRead.wait;
  }, { tabSessionId: "mock-tab", busy: true });
  const { e, calls } = app;
  assert.equal(typingShown(e), true);
  assert.equal(e.utterance.disabled, false);
  assert.equal(e["send-message"].disabled, false);
  assert.equal(e["finish-conversation"].disabled, true);

  send(e, "最初の発話"); await tick();
  assert.equal(e.utterance.disabled, false);
  assert.equal(e.utterance.focused, true);
  e.utterance.value = "にほんご";
  e.utterance.fire("compositionstart");
  await app.poll();
  assert.equal(reads, 2, "state request is in flight");
  assert.equal(e.utterance.disabled, false);
  assert.equal(e.utterance.value, "にほんご");
  stateRead.release(); await tick();
  assert.equal(e.utterance.disabled, false);
  assert.equal(e.utterance.value, "にほんご");
  assert.equal(e.utterance.fire("keydown", { key: "Enter" }).prevented, false);
  assert.equal(messageCalls(calls).length, 1);

  e.utterance.value = "日本語の補足";
  e.utterance.fire("compositionend");
  assert.equal(e.utterance.fire("keydown", { key: "Enter" }).prevented, false);
  await app.advance(0);
  assert.equal(e["send-message"].disabled, false, "the second message can be queued before the first receipt");
  e.utterance.fire("keydown", { key: "Enter" });
  assert.equal(messageCalls(calls).length, 1);
  e.utterance.value = "まだ送っていない文";
  post.release(); await tick(); await app.poll();
  assert.equal(e.utterance.value, "まだ送っていない文");
  assert.deepEqual(messageCalls(calls).map(({ body }) => [body.text, body.clientId, body.expectedRecordId]), [
    ["最初の発話", "browser-client-1", initial.sessionId],
    ["日本語の補足", "browser-client-2", initial.sessionId],
  ]);
  assert.deepEqual(messageBodies(e).slice(1), ["最初の発話", "日本語の補足"]);
});


test("old error states remain readable without manual recovery; only an explicit pause blocks sending", async () => {
  const initial = { ...trial(), status: "dialogue", aiStatus: "error", dialogueRecovery: "paused" };
  const { e, calls, getState, poll } = await ui(initial);
  assert.equal(e["chat-recovery-message"].textContent, "会話を中断しました。");
  assert.equal(e["send-message"].disabled, true);
  e.utterance.value = "保った下書き";
  await poll();
  assert.equal(e.utterance.value, "保った下書き");
  assert.equal(messageCalls(calls).length, 0);
  for (const recovery of ["unavailable", "retry"]) {
    getState().trial.dialogueRecovery = recovery;
    await poll();
    assert.equal(e.utterance.disabled, false);
    assert.equal(e["send-message"].disabled, false);
    assert.equal(e["finish-conversation"].disabled, true);
    assert.equal(e["chat-recovery-message"].textContent, "応答を待っています。この画面のままお待ちください。");
  }
  assert.equal(e["chat-recovery"].querySelectorAll("button").length, 0);
  assert.equal(calls.some(call => manualPaths.includes(call.path)), false);
});

test("202 with state reconciles the optimistic human once by clientId", async () => {
  const { e, calls, poll } = await ui();
  send(e, "相談"); await tick(); await poll();
  assert.deepEqual(messageBodies(e), ["まず、どの図形から話しましょうか？", "相談"]);
  assert.equal(messageCalls(calls).length, 1);
  assert.equal(e.history.children[1].className, "human");
});

test("state before 202 reconciles by clientId; a late shorter receipt snapshot cannot reorder the log", async () => {
  const held = gate(); let posted, snapshot;
  const app = await ui(trial(), async ({ path, body, state }) => {
    if (path === "/api/message") {
      posted = body;
      state.trial.events.push({ id: "event-2", speaker: "human", text: body.text, clientId: body.clientId });
      state.trial.aiStatus = "thinking"; snapshot = structuredClone(state);
      await held.wait;
      return { status: 202, body: { eventId: "event-2", ...snapshot } };
    }
  });
  send(app.e, "先に公開される発話"); await tick(); await app.poll();
  assert.equal(posted.clientId, "browser-client-1");
  assert.deepEqual(messageBodies(app.e), ["まず、どの図形から話しましょうか？", "先に公開される発話"]);
  app.getState().trial.events.push({ id: "event-3", speaker: "ai", text: "届いた返答" });
  app.getState().trial.aiStatus = "idle"; await app.poll();
  held.release(); await tick();
  assert.deepEqual(messageBodies(app.e), ["まず、どの図形から話しましょうか？", "先に公開される発話", "届いた返答"]);
  assert.equal(messageCalls(app.calls).length, 1);
});

test("receipt eventId also reconciles servers whose public event omits clientId", async () => {
  const { e, poll } = await ui(trial(), ({ path, body, state }) => {
    if (path === "/api/message") {
      state.trial.events.push({ id: "receipt-only", speaker: "human", text: body.text });
      return { status: 202, body: { eventId: "receipt-only" } };
    }
  });
  send(e, "IDによる確認"); await tick(); await poll();
  assert.deepEqual(messageBodies(e), ["まず、どの図形から話しましょうか？", "IDによる確認"]);
});

test("two identical texts have distinct clientIds and remain two messages in server order", async () => {
  const held = gate(); let first = true;
  const { e, calls } = await ui(trial(), async ({ path }) => {
    if (path === "/api/message" && first) { first = false; await held.wait; }
  });
  send(e, "同じことば"); send(e, "同じことば");
  assert.deepEqual(messageBodies(e).slice(1), ["同じことば", "同じことば"]);
  held.release(); await tick();
  assert.deepEqual(messageBodies(e).slice(1), ["同じことば", "同じことば"]);
  assert.notEqual(messageCalls(calls)[0].body.clientId, messageCalls(calls)[1].body.clientId);
});


test("a failed send retries in order with exactly the same body and tab", async () => {
  let attempts = 0;
  const { e, calls, advance } = await ui(trial(), ({ path }) =>
    path === "/api/message" && ++attempts <= 2 ? { status: 502, body: { error: "ai_unavailable" } } : undefined,
    { tabSessionId: "mock-tab" });
  send(e, "失われない発話"); await tick();
  send(e, "次に送る発話"); await tick();
  assert.equal(messageCalls(calls).length, 1);
  assert.equal(e["finish-conversation"].disabled, true);
  assert.equal(e.history.querySelectorAll("button").length, 0);
  assert.match(e["chat-status"].textContent, /入力を保持して送り直しています/u);
  assert.deepEqual(messageBodies(e).slice(1), ["失われない発話", "次に送る発話"]);
  await advance(1999);
  assert.equal(messageCalls(calls).length, 1);
  await advance(1);
  assert.equal(messageCalls(calls).length, 2);
  await advance(3999);
  assert.equal(messageCalls(calls).length, 2);
  await advance(1);
  const messages = messageCalls(calls);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.slice(0, 3).map(call => call.body), Array(3).fill(messages[0].body));
  assert.deepEqual(messages.slice(0, 3).map(call => call.tabHeader), Array(3).fill("mock-tab"));
  assert.equal(messages[3].body.text, "次に送る発話");
  assert.deepEqual(messageBodies(e).slice(1), ["失われない発話", "次に送る発話"]);
});

test("a 429 observes Retry-After and keeps the original clientId", async () => {
  let attempts = 0;
  const { e, calls, advance } = await ui(trial(), ({ path }) => path === "/api/message" && ++attempts === 1
    ? { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "3" } } : undefined);
  send(e, "あとで届く発話"); await tick(); await advance(2999);
  assert.equal(messageCalls(calls).length, 1);
  await advance(1);
  assert.deepEqual(messageCalls(calls).map(call => call.body), Array(2).fill(messageCalls(calls)[0].body));
});

for (const [condition, failure] of [
  ["a temporary unavailable record", { status: 409, body: { error: "trial_unavailable" } }],
  ["an unreadable success response", { status: 200, invalidJson: true }],
]) {
  test(`${condition} keeps the same message recoverable across reload`, async () => {
    const first = await ui(trial(), ({ path }) => path === "/api/message" ? failure : undefined,
      { tabSessionId: "mock-tab" });
    send(first.e, "確認を失った発話"); await tick();
    const original = messageCalls(first.calls)[0];
    assert.equal(messageCalls(first.calls).length, 1);
    const next = await ui(first.getState().trial, undefined, { tabSessionId: "mock-tab", storage: first.storage, startTime: first.now() });
    await next.advance(2000);
    assert.deepEqual(messageCalls(next.calls).map(({ body, tabHeader }) => ({ body, tabHeader })),
      [{ body: original.body, tabHeader: original.tabHeader }]);
    assert.equal(messageBodies(next.e).filter(text => text === original.body.text).length, 1);
  });
}

test("an ambiguous response failure that was publicly accepted keeps one canonical bubble without a false retry", async () => {
  const { e, calls } = await ui(trial(), ({ path, body, state }) => {
    if (path === "/api/message") {
      state.trial.events.push({ id: "event-2", speaker: "human", text: body.text, clientId: body.clientId });
      throw new Error("PRIVATE-RAW-ERROR");
    }
  });
  send(e, "実際には受理済み"); await tick();
  assert.equal(messageCalls(calls).length, 1);
  assert.deepEqual(messageBodies(e), ["まず、どの図形から話しましょうか？", "実際には受理済み"]);
  assert.equal(e.history.querySelectorAll("button").length, 0);
  assert.doesNotMatch(e.history.textContent + e.notice.textContent, /PRIVATE-RAW-ERROR/u);
});

test("three decorative dots and hidden polite status show during thinking, then disappear after a reply", async () => {
  const { e, getState, poll } = await ui();
  assert.equal(typingCount(e), 0);
  getState().trial.aiStatus = "thinking"; await poll();
  assert.ok(typingShown(e));
  assert.equal(e.history.children.at(-1).querySelectorAll("span").length, 3);
  assert.equal(e.history.children.at(-1).getAttribute("aria-hidden"), "true");
  assert.equal(e["chat-status"].textContent, "AIが返答を作成しています");
  assert.equal(e["chat-status"].getAttribute("class"), "sr-only");
  assert.equal(e["chat-status"].getAttribute("aria-live"), "polite");
  getState().trial.events.push({ id: "event-2", speaker: "ai", text: "新しい返答" });
  getState().trial.aiStatus = "idle"; await poll();
  assert.equal(typingCount(e), 0);
  assert.equal(e["chat-status"].textContent, "");
});


test("unchanged busy state reads do not renew the 60-second clock or block the next message", async () => {
  const state = { ...trial(), aiStatus: "thinking", recovering: true, dialogueRecovery: "active" };
  const { e, calls, advance, getState, poll } = await ui(state, undefined, { busy: true });
  const initialCount = state.events.length;
  await advance(59999);
  assert.ok(typingShown(e));
  await advance(1);
  assert.equal(typingCount(e), 0);
  assert.equal(e["chat-recovery-message"].textContent, RECOVERING);
  assert.equal(e["chat-recovery"].querySelectorAll("button").length, 0);
  assert.equal(messageNodes(e).length, initialCount);
  assert.equal(e["finish-conversation"].disabled, true);
  e["finish-conversation"].fire("click");
  assert.equal(e["name-stage"].hidden, true);
  assert.ok(calls.filter(call => call.path === "/api/state").length > 2);
  send(e, "回復中の追記"); await tick();
  assert.equal(messageCalls(calls).length, 1);
  assert.equal(e["chat-recovery-message"].textContent, RECOVERING, "another human message does not advance the AI reply");
  getState().trial.events.push({ id: "event-3", speaker: "ai", text: "遅れて届いた返答" });
  delete getState().trial.recovering;
  getState().trial.aiStatus = "idle"; getState().busy = false; await poll();
  assert.equal(e["chat-recovery"].hidden, true);
  assert.equal(e["finish-conversation"].disabled, false);
  send(e, "回復後の次の発話"); await tick();
  assert.equal(messageCalls(calls).length, 2);
  assert.equal(calls.some(call => manualPaths.includes(call.path)), false);
});

test("without a recovery marker a stall stays factual and returning to the tab polls immediately", async () => {
  const state = { ...trial(), aiStatus: "thinking" };
  const { e, calls, advance, visibility, getState } = await ui(state, undefined, { busy: true });
  e.utterance.value = "編集中";
  await visibility("hidden");
  const count = calls.length;
  await advance(60001);
  assert.equal(calls.length, count);
  assert.equal(e["chat-recovery-message"].textContent, DELAYED);
  assert.equal(typingCount(e), 0);
  getState().trial.events.push({ id: "event-2", speaker: "ai", text: "非表示中の返答" });
  getState().trial.aiStatus = "idle"; getState().busy = false;
  await visibility("visible");
  assert.equal(calls[count].path, "/api/state");
  assert.equal(messageBodies(e).at(-1), "非表示中の返答");
  assert.equal(e["chat-recovery"].hidden, true);
  assert.equal(e.utterance.value, "編集中");
});

test("an acknowledgement timeout retains the message then reuses its request", async () => {
  const held = gate();
  let attempts = 0;
  const { e, calls, advance } = await ui(trial(), async ({ path }) => {
    if (path === "/api/message" && ++attempts === 1) { await held.wait; return { status: 502, body: {} }; }
  });
  send(e, "確認が返らない発話"); await tick(); await advance(20000);
  assert.equal(messageBodies(e).at(-1), "確認が返らない発話");
  assert.equal(typingCount(e), 0);
  assert.equal(e.history.querySelectorAll("button").length, 0);
  assert.equal(messageCalls(calls).length, 1);
  await advance(2000);
  assert.deepEqual(messageCalls(calls).map(call => call.body), Array(2).fill(messageCalls(calls)[0].body));
  held.release(); await tick();
  assert.equal(messageBodies(e).filter(text => text === "確認が返らない発話").length, 1);
});

test("reload reconciles a stored message before resending it only to its original record and tab", async () => {
  for (const accepted of [false, true]) {
    const first = await ui(trial(), ({ path }) => path === "/api/message" ? { status: 502, body: {} } : undefined,
      { tabSessionId: "mock-tab" });
    send(first.e, "再読み込みで保つ発話"); await tick();
    const original = messageCalls(first.calls)[0];
    if (accepted) first.getState().trial.events.push({ id: "event-2", speaker: "human", text: original.body.text, clientId: original.body.clientId });
    const reload = await ui(first.getState().trial, undefined, { tabSessionId: "mock-tab", storage: first.storage, startTime: first.now() });
    await reload.advance(2000);
    assert.equal(messageCalls(reload.calls).length, Number(!accepted));
    if (!accepted) {
      assert.equal(messageCalls(reload.calls)[0].tabHeader, original.tabHeader);
      assert.deepEqual(messageCalls(reload.calls)[0].body, original.body);
    }
    assert.equal(messageBodies(reload.e).filter(text => text === original.body.text).length, 1);
  }
});

test("a retry never follows a changed tab, record or an ended trial", async () => {
  for (const change of ["tab", "record", "ended"]) {
    const first = await ui(trial(), ({ path }) => path === "/api/message" ? { status: 502, body: {} } : undefined,
      { tabSessionId: "mock-tab" });
    send(first.e, "前の試行の発話"); await tick();
    const reload = await ui(change === "record" ? trial("another-trial") : change === "ended"
      ? { ...trial(), closed: true, status: "submitting", submitted: true } : trial(),
      undefined, { tabSessionId: change === "tab" ? "another-tab" : "mock-tab", storage: first.storage, startTime: first.now() });
    await reload.advance(60000);
    assert.equal(messageCalls(reload.calls).length, 0, change);
    const state = first.getState();
    state.trial = change === "ended" ? null : trial("another-trial");
    await first.advance(60000);
    assert.equal(messageCalls(first.calls).length, 1, change);
  }
});

test("Shift+Enter and IME do not submit; plain Enter sends exact multiline text once", async () => {
  const { e, calls, advance } = await ui();
  const text = "  第一行\n第二行\n";
  e.utterance.value = text;
  for (const fields of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.equal(e.utterance.fire("keydown", { key: "Enter", ...fields }).prevented, false);
  }
  e.utterance.fire("compositionstart");
  assert.equal(e.utterance.fire("keydown", { key: "Enter" }).prevented, false);
  e.utterance.fire("compositionend");
  assert.equal(e.utterance.fire("keydown", { key: "Enter" }).prevented, false);
  await advance(0);
  assert.equal(e.utterance.fire("keydown", { key: "Enter", repeat: true }).prevented, true);
  assert.equal(messageCalls(calls).length, 0);
  assert.equal(e.utterance.fire("keydown", { key: "Enter" }).prevented, true);
  assert.equal(e.utterance.value, "");
  assert.equal(e.utterance.fire("keydown", { key: "Enter", repeat: true }).prevented, true);
  await tick();
  assert.deepEqual(messageCalls(calls).map((call) => call.body.text), [text]);
  assert.equal(messageBodies(e).at(-1), text);
  e.utterance.value = "   ";
  e.utterance.fire("keydown", { key: "Enter" });
  await tick();
  assert.equal(messageCalls(calls).length, 1);
  e.utterance.value = "ボタン送信";
  e.chat.fire("submit");
  await tick();
  assert.deepEqual(messageCalls(calls).map((call) => call.body.text), [text, "ボタン送信"]);
});

// Updated 2026-10-19 (E1): the reader's own send now jumps to the bottom, as
// in ordinary chat apps; arrivals still never move a scrolled-up reader.
test("own send jumps to the bottom; scrolled-up readers retain their position during authoritative refresh", async () => {
  const state = trial();
  state.events.push(...Array.from({ length: 12 }, (_, index) => ({ id: "history-" + index, speaker: "ai", text: "過去の会話" + index })));
  const { e, getState, poll } = await ui(state);
  e.history.scrollTop = 80; e.history.fire("scroll");
  send(e, "送信したら末尾へ");
  assert.equal(e.history.scrollTop, e.history.scrollHeight, "sending shows the sent bubble at the bottom");
  e.history.scrollTop = 80; e.history.fire("scroll");
  await tick(); assert.equal(e.history.scrollTop, 80, "DOM replacement restores the reader position");
  getState().trial.events.push({ id: "last-ai", speaker: "ai", text: "新しい応答" });
  getState().trial.aiStatus = "idle"; await poll();
  assert.equal(e.history.scrollTop, 80);
  e.history.scrollTop = e.history.scrollHeight - e.history.clientHeight; e.history.fire("scroll");
  getState().trial.events.push({ id: "next-ai", speaker: "ai", text: "末尾に続く応答" }); await poll();
  assert.equal(e.history.scrollTop, e.history.scrollHeight);
});

test("typing motion is disabled by reduced-motion and the shortcut hint matches behavior", () => {
  assert.match(css, /@keyframes typing-bounce/u);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.typing-indicator span\{animation:none\}/u);
  assert.doesNotMatch(html + script, /AIが考えています|受理済み・会話を更新中|送信中…/u);
  assert.match(html, /Enterで送信・Shift＋Enterで改行/u);
  assert.match(css, /#chat textarea\{[^}]*overflow-y:auto/u);
});


test("a hung state read cannot strand the original message retry", async () => {
  const held = gate(); let reads = 0, posts = 0;
  const { e, calls, advance } = await ui(trial(), async ({ path }) => {
    if (path === "/api/message" && ++posts === 1) return { status: 502, body: {} };
    if (path === "/api/state" && ++reads > 1) await held.wait;
  });
  send(e, "失敗後の状態取得も止まった"); await tick();
  assert.equal(typingCount(e), 0);
  await advance(9999);
  assert.equal(messageCalls(calls).length, 1);
  await advance(1);
  assert.equal(messageCalls(calls).length, 2);
  assert.deepEqual(messageCalls(calls)[1].body, messageCalls(calls)[0].body);
  held.release(); await tick();
});

const startReception = () => ({ status: "ready", number: "試験受付", revision: 4 });
const startUuid = () => "d5325b7f-1089-4221-9876-6b393fa77783";
const startCalls = (calls) => calls.filter(call => call.path === "/api/start");

test("a committed start is usable through GET while the original POST still hangs", async () => {
  const held = gate();
  const { e, calls, getState, poll, advance } = await ui(null, async ({ path, body, state }) => {
    if (path !== "/api/start") return;
    Object.assign(state, { starting: true, busy: true, startIntentId: body.startIntentId });
    state.reception.revision++;
    await held.wait;
    return { status: 502, body: {} };
  }, { tabSessionId: "mock-tab", initialReception: startReception(), uuid: startUuid });
  e["start-trial"].fire("click"); await tick(); await poll();
  assert.equal(e["start-trial"].disabled, true);
  assert.deepEqual(startCalls(calls)[0].body, { version: 2, startIntentId: startUuid(), expectedReceptionRevision: 4 });
  Object.assign(getState(), { trial: trial("new-record"), starting: undefined, busy: false });
  await poll();
  assert.equal(e.utterance.disabled, false);
  assert.equal(messageBodies(e).at(-1), "まず、どの図形から話しましょうか？");
  send(e, "開始後の発話"); await tick();
  assert.equal(messageCalls(calls)[0].body.expectedRecordId, "new-record");
  await advance(25000);
  held.release(); await tick();
  assert.equal(startCalls(calls).length, 1);
  assert.equal(e.notice.textContent, "");
});

test("an unaccepted start survives reload and resends only the original intent after a state read", async () => {
  const held = gate();
  const admitted = new Map();
  const deliver = (state, body) => {
    if (!admitted.has(body.startIntentId)) admitted.set(body.startIntentId, trial("new-record"));
    Object.assign(state, { trial: admitted.get(body.startIntentId), startIntentId: body.startIntentId });
    state.reception.revision = body.expectedReceptionRevision + 1;
    return { status: 200, body: state };
  };
  const first = await ui(null, async ({ path, body, state }) => {
    if (path !== "/api/start") return;
    await held.wait;
    return deliver(state, body);
  }, { tabSessionId: "mock-tab", initialReception: startReception(), uuid: startUuid });
  first.e["start-trial"].fire("click"); await tick();
  const next = await ui(null, ({ path, body, state }) => path === "/api/start" ? deliver(state, body) : undefined,
    { tabSessionId: "mock-tab", initialReception: startReception(), storage: first.storage, startTime: first.now() });
  await next.advance(1999);
  assert.equal(startCalls(next.calls).length, 0);
  await next.advance(102);
  assert.equal(next.calls[0].path, "/api/state");
  assert.equal(startCalls(next.calls).length, 1);
  assert.deepEqual(startCalls(next.calls)[0].body, startCalls(first.calls)[0].body);
  assert.equal(startCalls(next.calls)[0].tabHeader, "mock-tab");
  held.release(); await tick();
  assert.equal(admitted.size, 1);
  assert.deepEqual(messageBodies(next.e), ["まず、どの図形から話しましょうか？"]);
  assert.equal(next.e.utterance.disabled, false);
  assert.equal(next.storage.has("joint-naming-v2-start"), false);
});

test("a start is not sent again after the reception changes or is ended", async () => {
  for (const status of ["ready", "interrupted"]) {
    const { e, calls, getState, advance } = await ui(null, ({ path }) =>
      path === "/api/start" ? { status: 502, body: {} } : undefined,
      { tabSessionId: "mock-tab", initialReception: startReception(), uuid: startUuid });
    e["start-trial"].fire("click"); await tick();
    Object.assign(getState().reception, { revision: 5, status });
    await advance(65000);
    assert.equal(startCalls(calls).length, 1);
  }
});
