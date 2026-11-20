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
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; this.scrollTop = 0; }
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
  const timers = new Map(), calls = [], documentEvents = new Element("document");
  const context = {
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => "browser-client-" + ++clientSequence },
    document: { getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag),
      addEventListener: (type, handler) => documentEvents.addEventListener(type, handler) },
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
  };
  runInNewContext(script, context);
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
  return { e, root, calls, context, documentEvents, getState: () => state, advance,
    poll: async () => {
      const timer = [...timers.values()].filter((entry) => entry.delay === 700 || entry.delay === 2000).sort((a, b) => a.at - b.at)[0];
      assert.ok(timer, "a state refresh is scheduled"); await advance(timer.at - now);
    } };
}
const send = (e, text) => { e.utterance.value = text; e.chat.fire("submit"); };
const messageBodies = (e) => e.history.children.map((node) => node.querySelectorAll("p")[0]?.textContent);
const messageCalls = (calls) => calls.filter((call) => call.path === "/api/message");
const STOPPED = "進行を確認できません。実験担当者にお知らせください。";
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
  assert.equal(e.history.children.length, 2);
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

test("failed send retains a subtle failure action, stops dots, and never automatically retries", async () => {
  let failed = true;
  const initial = trial(); initial.aiStatus = "thinking";
  const { e, calls, poll } = await ui(initial, ({ path }) => path === "/api/message" && failed ? { status: 502, body: { error: "ai_unavailable" } } : undefined);
  send(e, "失われない発話"); await tick(); await poll();
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(messageBodies(e).at(-1), "失われない発話");
  assert.equal(messageCalls(calls).length, 1);
  const retry = e.history.querySelectorAll("button")[0];
  assert.equal(retry.textContent, "再送"); assert.equal(retry.disabled, false);
  assert.match(e["chat-status"].textContent, /送信を確認できません/u);
  failed = false; retry.fire("click"); await tick();
  assert.equal(messageCalls(calls).length, 2);
  assert.deepEqual(messageCalls(calls)[1].body, messageCalls(calls)[0].body, "explicit retry reuses both id and exact text");
  assert.equal(e.history.querySelectorAll("button").length, 0);
  assert.equal(messageBodies(e).filter((text) => text === "失われない発話").length, 1);
});

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
  assert.equal(e["typing-indicator"].hidden, true);
  getState().trial.aiStatus = "thinking"; await poll();
  assert.equal(e["typing-indicator"].hidden, false);
  assert.equal(e["typing-indicator"].children.length, 3);
  assert.equal(e["typing-indicator"].getAttribute("aria-hidden"), "true");
  assert.equal(e["chat-status"].textContent, "AIが返答を作成しています");
  assert.equal(e["chat-status"].getAttribute("class"), "sr-only");
  assert.equal(e["chat-status"].getAttribute("aria-live"), "polite");
  getState().trial.events.push({ id: "event-2", speaker: "ai", text: "新しい返答" });
  getState().trial.aiStatus = "idle"; await poll();
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(e["chat-status"].textContent, "");
});

test("AI errors replace dots with the neutral stop; checking the state resumes the turn without replaying human messages", async () => {
  const state = trial(); state.aiStatus = "thinking";
  const { e, getState, calls, poll } = await ui(state);
  getState().trial.aiStatus = "error"; await poll();
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
  assert.equal(e["chat-status"].textContent, STOPPED);
  assert.match(html, /<button id="retry-chat" type="button" class="quiet">状態を確認<\/button>/u, "one fixed label for every stop");
  assert.doesNotMatch(e["chat-recovery"].textContent + e["chat-status"].textContent + e.notice.textContent, /AI|返答|再試行|取得/u);
  assert.equal(calls.filter((call) => call.path === "/api/retry").length, 0);
  e["retry-chat"].fire("click"); await tick();
  assert.equal(calls.filter((call) => call.path === "/api/retry").length, 1);
  assert.equal(messageCalls(calls).length, 0);
  assert.equal(e["chat-recovery"].hidden, true);
});

test("no-progress watchdog stops animation after one minute; checking state cannot restart unchanged dots", async () => {
  const state = trial(); state.aiStatus = "thinking";
  const { e, calls, advance, getState, poll } = await ui(state);
  assert.equal(e["typing-indicator"].hidden, false);
  await advance(60001);
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
  assert.match(html, /<button id="retry-chat" type="button" class="quiet">状態を確認<\/button>/u, "one fixed label for every stop");
  e["retry-chat"].fire("click"); await tick();
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(calls.filter((call) => call.path === "/api/retry").length, 0);
  getState().trial.events.push({ id: "event-2", speaker: "ai", text: "遅れて届いた返答" });
  getState().trial.aiStatus = "idle"; await poll();
  assert.equal(e["chat-recovery"].hidden, true);
});

// Issue #161: a short disconnection is not shown; polling recovers it. Only a
// disconnection that outlasts the watchdog shows the neutral stop.
test("a short disconnection stays invisible; a lasting one shows the neutral stop and recovery only re-reads", async () => {
  let disconnected = false;
  const state = trial(); state.aiStatus = "thinking";
  const { e, calls, poll, advance, getState } = await ui(state, ({ path }) => { if (path === "/api/state" && disconnected) throw new Error("offline"); });
  disconnected = true; await poll();
  assert.equal(e["typing-indicator"].hidden, false);
  assert.equal(e["chat-recovery"].hidden, true);
  disconnected = false; await poll();
  assert.equal(e["chat-recovery"].hidden, true);
  disconnected = true; await advance(60001);
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
  disconnected = false; e["retry-chat"].fire("click"); await tick();
  assert.equal(e["typing-indicator"].hidden, true, "unchanged dots do not restart after the stall");
  assert.equal(e["chat-recovery"].hidden, false, "no progress has been confirmed yet");
  assert.equal(calls.filter((call) => call.path === "/api/retry").length, 0);
  getState().trial.events.push({ id: "event-2", speaker: "ai", text: "遅れて届いた返答" });
  getState().trial.aiStatus = "idle"; await poll();
  assert.equal(e["chat-recovery"].hidden, true);
});

test("a missing POST acknowledgement times out to a retained retryable bubble without replay", async () => {
  const held = gate();
  const { e, calls, advance, poll } = await ui(trial(), async ({ path }) => { if (path === "/api/message") { await held.wait; return { status: 502, body: {} }; } });
  send(e, "確認が返らない発話"); await tick(); await advance(20001); await poll();
  assert.equal(messageBodies(e).at(-1), "確認が返らない発話");
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(e.history.querySelectorAll("button")[0].disabled, false);
  assert.equal(messageCalls(calls).length, 1);
  held.release(); await tick();
});

test("Enter, Shift+Enter and IME never submit; clicking send preserves the exact multiline text", async () => {
  const { e, calls } = await ui();
  const text = "  第一行\n第二行\n";
  e.utterance.value = text;
  for (const fields of [{}, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    assert.equal(e.utterance.fire("keydown", { key: "Enter", ...fields }).prevented, false);
  }
  assert.equal(messageCalls(calls).length, 0);
  e.chat.fire("submit"); await tick();
  assert.equal(messageCalls(calls)[0].body.text, text);
  assert.equal(messageBodies(e).at(-1), text);
});

// ---- Space+Enter send (Issue #171) ------------------------------------------
const SPACE = { key: " ", code: "Space", keyCode: 32 }, ENTER = { key: "Enter", code: "Enter", keyCode: 13 };
// The fixture has no native editing: an unprevented keydown inserts its text at
// the selection, as a textarea does (IME keys pass the text the IME inserts).
function keydown(e, fields, input = fields.key === "Enter" ? "\n" : fields.key) {
  const node = e.utterance, event = node.fire("keydown", fields);
  if (!event.prevented && input) {
    const start = node.selectionStart ?? node.value.length, end = node.selectionEnd ?? node.value.length;
    node.value = node.value.slice(0, start) + input + node.value.slice(end);
    node.selectionStart = node.selectionEnd = start + input.length;
  }
  return event;
}
const keyup = (e, fields) => e.utterance.fire("keyup", fields);
const type = (e, text) => { e.utterance.value = text; e.utterance.selectionStart = e.utterance.selectionEnd = text.length; };
const messageTexts = (calls) => messageCalls(calls).map((call) => call.body.text);

test("Space held then Enter sends once without the chord's own space; Enter alone and Space released first stay newlines", async () => {
  const { e, calls } = await ui();
  type(e, "こんにちは");
  assert.equal(keydown(e, ENTER).prevented, false); keyup(e, ENTER);
  keydown(e, SPACE); keyup(e, SPACE);
  assert.equal(keydown(e, ENTER).prevented, false); keyup(e, ENTER);
  assert.equal(e.utterance.value, "こんにちは\n \n");
  assert.equal(messageCalls(calls).length, 0);
  type(e, "左上の図形かな");
  assert.equal(keydown(e, SPACE).prevented, false, "the held Space is still typed natively");
  assert.equal(keydown(e, ENTER).prevented, true);
  keyup(e, ENTER); keyup(e, SPACE); await tick();
  assert.deepEqual(messageTexts(calls), ["左上の図形かな"]);
  assert.equal(messageBodies(e).at(-1), "左上の図形かな");
  assert.equal(e.utterance.value, "");
});

test("Space+Enter mid-text removes only its own space; text changed any other way is never trimmed by guess", async () => {
  const { e, calls, context: c } = await ui();
  type(e, "左上の図形"); e.utterance.selectionStart = e.utterance.selectionEnd = 2;
  keydown(e, SPACE);
  assert.equal(e.utterance.value, "左上 の図形");
  assert.equal(keydown(e, ENTER).prevented, true); keyup(e, ENTER); keyup(e, SPACE); await tick();
  assert.deepEqual(messageTexts(calls), ["左上の図形"]);
  type(e, "右下"); keydown(e, SPACE); type(e, "右下 と貼り付け");
  assert.equal(keydown(e, ENTER).prevented, false, "an unexpected change keeps Enter a newline");
  assert.equal(messageCalls(calls).length, 1);
  const before = { value: "左上の図形", start: 2, end: 2 };
  for (const value of ["左上 の図形", "左上　の図形", "左上   の図形", "左上の図形"]) assert.equal(c.spaceEnterRestore(before, value), before, value);
  for (const value of ["左上 xの図形", "左上の図", "左 上の図形", "左上 の図形 "]) assert.equal(c.spaceEnterRestore(before, value), null, value);
  const selection = { value: "abcdef", start: 1, end: 3 };
  assert.equal(c.spaceEnterRestore(selection, "a def"), selection, "a Space that replaced a selection is undone too");
});

test("Space+Enter never sends a blank composer and leaves no stray space; it keeps the send button's guards", async () => {
  const { e, calls } = await ui();
  let submits = 0; e.chat.addEventListener("submit", () => submits++);
  for (const text of ["", "　 \n"]) {
    type(e, text); keydown(e, SPACE);
    assert.equal(keydown(e, ENTER).prevented, true); keyup(e, ENTER); keyup(e, SPACE);
    assert.equal(e.utterance.value, text);
  }
  assert.equal(submits, 0, "a blank composer is not submitted, so no required-field bubble");
  type(e, "名前の段階では送らない"); e["finish-conversation"].fire("click");
  assert.equal(e.utterance.disabled, true);
  keydown(e, SPACE); keydown(e, ENTER); keyup(e, ENTER); keyup(e, SPACE); await tick();
  assert.equal(e.utterance.value, "名前の段階では送らない");
  assert.equal(messageCalls(calls).length, 0);
});

test("IME never sends: composition, isComposing, keyCode 229 and a key right after compositionend; a conversion Space is never held", async () => {
  const { e, calls, advance } = await ui();
  type(e, "かんじ");
  e.utterance.fire("compositionstart");
  assert.equal(keydown(e, { ...SPACE, isComposing: true }, "").prevented, false);
  assert.equal(keydown(e, { ...ENTER, isComposing: true, keyCode: 229 }, "").prevented, false);
  e.utterance.fire("compositionend"); await advance(0);
  assert.equal(keydown(e, ENTER).prevented, false, "the conversion Space, still held, does not arm the chord");
  keyup(e, ENTER); keyup(e, SPACE);
  // Between compositionstart and compositionend every key is IME input, even without isComposing.
  e.utterance.fire("compositionstart"); keydown(e, SPACE, "");
  assert.equal(keydown(e, ENTER, "").prevented, false);
  keyup(e, ENTER); keyup(e, SPACE); e.utterance.fire("compositionend"); await advance(0);
  // Safari dispatches the confirming key after compositionend, in the same task.
  e.utterance.fire("compositionstart"); e.utterance.fire("compositionend");
  assert.equal(keydown(e, SPACE, "").prevented, false);
  assert.equal(keydown(e, ENTER, "").prevented, false);
  keyup(e, SPACE); keyup(e, ENTER); await advance(0);
  // keyCode 229 or isComposing without a composition event (e.g. a Windows IME).
  keydown(e, { ...SPACE, keyCode: 229 }, "　");
  assert.equal(keydown(e, ENTER).prevented, false); keyup(e, ENTER); keyup(e, SPACE);
  for (const ime of [{ keyCode: 229 }, { isComposing: true }]) {
    keydown(e, SPACE);
    assert.equal(keydown(e, { ...ENTER, ...ime }, "").prevented, false); keyup(e, ENTER); keyup(e, SPACE);
  }
  await tick();
  assert.equal(messageCalls(calls).length, 0);
  type(e, "漢字です"); keydown(e, SPACE);
  assert.equal(keydown(e, ENTER).prevented, true, "after the IME the chord works again");
  await tick();
  assert.deepEqual(messageTexts(calls), ["漢字です"]);
});

test("Enter auto-repeat, another Enter or Space auto-repeat during a sent chord never send twice or edit the cleared composer", async () => {
  const { e, calls } = await ui();
  type(e, "一回だけ"); keydown(e, SPACE);
  assert.equal(keydown(e, ENTER).prevented, true);
  for (let i = 0; i < 3; i++) assert.equal(keydown(e, { ...ENTER, repeat: true }).prevented, true);
  assert.equal(keydown(e, { ...SPACE, repeat: true }).prevented, true);
  keyup(e, ENTER);
  assert.equal(keydown(e, ENTER).prevented, true, "Enter again while the same Space is held");
  keyup(e, SPACE);
  assert.equal(keydown(e, { ...ENTER, repeat: true }).prevented, true, "that Enter stays latched until released");
  keyup(e, ENTER);
  assert.equal(e.utterance.value, "");
  assert.equal(keydown(e, ENTER).prevented, false, "released keys: Enter is a newline again"); keyup(e, ENTER);
  type(e, "二回目"); keydown(e, SPACE); keydown(e, ENTER); keyup(e, SPACE);
  assert.equal(keydown(e, { ...ENTER, repeat: true }).prevented, true, "Space released first: Enter auto-repeat adds no newline");
  keyup(e, ENTER); await tick();
  assert.deepEqual(messageTexts(calls), ["一回だけ", "二回目"]);
  assert.equal(e.utterance.value, "");
});

test("keyup, blur, focus and a hidden page release a held Space; a modifier or another key in between cancels the chord", async () => {
  const { e, calls, documentEvents } = await ui();
  const cases = [
    [() => { keydown(e, SPACE); keyup(e, SPACE); }, ENTER],
    [() => { keydown(e, SPACE); e.utterance.fire("blur"); }, ENTER],
    [() => { keydown(e, SPACE); e.utterance.fire("focus"); }, ENTER],
    [() => { keydown(e, SPACE); documentEvents.fire("visibilitychange"); }, ENTER],
    [() => { keydown(e, SPACE); keydown(e, { key: "a", code: "KeyA", keyCode: 65 }); }, ENTER],
    [() => { keydown(e, SPACE); keydown(e, { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, ""); }, ENTER],
    [() => { keydown(e, SPACE); keydown(e, { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true }, ""); keyup(e, { key: "Shift" }); }, ENTER],
    [() => { keydown(e, ENTER); keydown(e, SPACE); }, { ...ENTER, repeat: true }],
    [() => keydown(e, { ...SPACE, ctrlKey: true }, ""), ENTER],
    ...["shiftKey", "ctrlKey", "altKey", "metaKey"].map((modifier) => [() => keydown(e, SPACE), { ...ENTER, [modifier]: true }]),
  ];
  for (const [before, enter] of cases) {
    type(e, "送らない"); before();
    assert.equal(keydown(e, enter).prevented, false);
    keyup(e, ENTER); keyup(e, SPACE);
  }
  await tick();
  assert.equal(messageCalls(calls).length, 0);
});

test("the composer hint names the Enter newline and the Space+Enter send beside the kept send button", () => {
  assert.match(html, /<span id="send-hint" class="muted">Enterで改行・Space＋Enterで送信<\/span><button id="send-message">/u);
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

test("typing motion is disabled by reduced-motion and old visible wait/Enter hints are absent", () => {
  assert.match(css, /@keyframes typing-bounce/u);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.typing-indicator span\{animation:none\}/u);
  // Plain Enter never sends; the only send key is the Space+Enter chord (Issue #171).
  assert.doesNotMatch(html + script, /AIが考えています|受理済み・会話を更新中|送信中…|(?<!Space＋)Enterで送信/u);
  assert.match(css, /#chat textarea\{[^}]*overflow-y:auto/u);
});

test("a hung recovery poll is bounded and cannot strand a failed-send retry button", async () => {
  const held = gate(); let reads = 0;
  const state = trial(); state.aiStatus = "thinking";
  const { e, calls, advance } = await ui(state, async ({ path }) => {
    if (path === "/api/message") return { status: 502, body: {} };
    if (path === "/api/state" && ++reads > 1) await held.wait;
  });
  send(e, "失敗後の通信も止まった"); await tick();
  assert.equal(e["typing-indicator"].hidden, true, "a POST failure immediately stops dots before recovery GET finishes");
  await advance(10001);
  assert.equal(e.history.querySelectorAll("button")[0].disabled, false);
  assert.equal(messageCalls(calls).length, 1);
  await advance(50000);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
  held.release(); await tick();
});
