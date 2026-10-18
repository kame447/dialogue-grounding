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
  replaceChildren(...children) { this._text = ""; this.children = [...children]; }
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
  return { version: 2, trialId: id, submitted: false, aiStatus: "idle", events: [], scene: {
    width: 1200, height: 800, shapes: ["s-a81c", "s-f120", "s-119e", "s-cc02", "s-a620", "s-67b4"].map((id, i) => ({
      id, path: `M ${100 + i * 140} 100 l 60 80 l -40 90 Z`, centroid: { x: 140 + i * 140, y: 200 },
    })),
  } };
}
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function ui(initial = trial(), handler) {
  const { root, ids: e } = makeDOM();
  let state = { trial: initial }, timerId = 0;
  const timers = new Map(), calls = [];
  e.setup.elements.strategy.value = "repair-first";
  e.setup.elements.seed.value = "1";
  runInNewContext(script, {
    document: { getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    FormData: class {
      constructor(form) { this.values = Object.entries(form.elements).map(([name, node]) => [name, node.value]); }
      get(name) { return this.values.find(([key]) => key === name)?.[1] ?? null; }
    },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      const custom = await handler?.({ path, body, state, setState: (value) => { state = value; } });
      if (custom) return { ok: custom.status < 400, status: custom.status, json: async () => structuredClone(custom.body) };
      let value = state;
      if (path === "/api/message") {
        const eventId = "e-" + (state.trial.events.length + 1);
        state.trial.events.push({ id: eventId, speaker: "human", text: body.text, at: "2026-10-18T06:00:00Z" });
        state.trial.aiStatus = "thinking"; value = { eventId };
      }
      if (path === "/api/names") { state.trial.submitted = true; }
      return { ok: true, status: path === "/api/message" ? 202 : 200, json: async () => structuredClone(value) };
    },
  });
  await tick();
  return { e, root, calls, getState: () => state, setState: (value) => { state = value; },
    poll: async () => { const callbacks = [...timers.values()]; timers.clear(); for (const cb of callbacks) cb(); await tick(); } };
}
const paths = (e) => e.board.querySelectorAll("path");
const save = (e, path, text) => { path.fire("click"); e["figure-name"].value = text; e["name-form"].fire("submit"); };

test("six exact silhouette buttons have no spatial/ordinal labels and open keyboard-accessible zoom", async () => {
  const { e, calls } = await ui();
  assert.equal(paths(e).length, 6);
  assert.equal(e.board.querySelectorAll("rect,circle").length, 0, "no enlarged rectangular or circular hit areas");
  assert.doesNotMatch(html, /上段|下段|図形[1-6]|2段3列/u);
  assert.equal(e.submission.querySelectorAll("input").length, 0);
  for (const path of paths(e)) {
    assert.equal(path.getAttribute("role"), "button");
    assert.equal(path.getAttribute("tabindex"), "0");
    assert.doesNotMatch(path.getAttribute("aria-label"), /s-|上段|下段|[1-6]/u);
  }
  const path = paths(e)[0];
  path.fire("click");
  assert.equal(e["name-dialog"].open, true);
  assert.equal(e["figure-preview"].children[0].getAttribute("d"), path.getAttribute("d"));
  assert.equal(e["figure-name"].focused, true);
  e["name-cancel"].fire("click");
  assert.equal(e["name-dialog"].open, false); assert.equal(path.focused, true);
  assert.equal(path.fire("keydown", { key: " " }).prevented, true);
  assert.equal(e["name-dialog"].open, true);
  e["name-cancel"].fire("click");
  assert.equal(path.fire("keydown", { key: "Enter" }).prevented, true);
  assert.equal(calls.length, 1, "selection and zoom stay local");
});

test("name editing/cancel and unknown stay local; all answers require explicit final confirmation", async () => {
  const { e, calls } = await ui();
  e.submission.fire("submit"); assert.equal(e["confirm-dialog"].open, false);
  assert.match(e["submission-status"].textContent, /未回答/u);
  save(e, paths(e)[0], "会話の名前");
  assert.match(e.board.textContent, /会話の名前/u);
  paths(e)[0].fire("click"); e["figure-name"].value = "捨てる編集"; e["name-cancel"].fire("click");
  assert.doesNotMatch(e.board.textContent, /捨てる編集/u);
  for (const path of paths(e).slice(1)) { path.fire("click"); e["name-unknown"].fire("click"); }
  assert.equal(calls.length, 1);
  e.submission.fire("submit"); assert.equal(e["confirm-dialog"].open, true);
  assert.match(e["confirm-scene"].textContent, /会話の名前/u);
  e["confirm-cancel"].fire("click"); assert.equal(calls.length, 1);
  e.submission.fire("submit"); e["confirm-submit"].fire("click"); await tick();
  const request = calls.find((call) => call.path === "/api/names");
  assert.deepEqual(request.body, { names: { "s-a81c": "会話の名前", "s-f120": null, "s-119e": null, "s-cc02": null, "s-a620": null, "s-67b4": null }, confirm: true });
  assert.equal(e["send-message"].disabled, true);
});

test("AI thinking keeps composer active; consecutive sends are optimistic and posted once in order", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  const state = trial(); state.aiStatus = "thinking";
  const { e, calls } = await ui(state, async ({ path }) => {
    if (path === "/api/message" && !held) { held = true; await gate; }
  });
  assert.equal(e["send-message"].disabled, false);
  save(e, paths(e)[0], "秘密のローカルメモ");
  e.utterance.value = "最初の発話"; e.chat.fire("submit");
  e.utterance.value = "補足の発話"; e.chat.fire("submit");
  e.chat.fire("submit"); e.utterance.fire("keydown", { key: "Enter", repeat: true });
  assert.equal(e.utterance.disabled, false); assert.equal(e["send-message"].disabled, false);
  assert.match(e.history.textContent, /最初の発話/u); assert.match(e.history.textContent, /補足の発話/u);
  release(); await tick();
  const messages = calls.filter((call) => call.path === "/api/message");
  assert.deepEqual(messages.map((call) => call.body), [{ text: "最初の発話" }, { text: "補足の発話" }]);
  assert.equal(e.history.children.length, 2, "accepted messages are not duplicated by poll reconciliation");
  assert.doesNotMatch(JSON.stringify(calls), /秘密のローカルメモ/u);
});

test("uncertain send failure is never retried or sent through legacy fallback", async () => {
  const { e, calls, poll } = await ui(trial(), ({ path }) => path === "/api/message" ? { status: 502, body: { error: "ai_unavailable" } } : undefined);
  e.utterance.value = "送信の確認が必要"; e.chat.fire("submit"); await tick(); await poll();
  assert.equal(calls.filter((call) => call.path === "/api/message").length, 1);
  assert.equal(calls.some((call) => call.path === "/api/turn"), false);
  assert.match(e.history.textContent, /自動では再送しません/u);
  assert.equal(e.utterance.disabled, false);
});

test("IME, Shift+Enter and repeated Enter do not accidentally send", async () => {
  const { e, calls } = await ui(); e.utterance.value = "日本語";
  for (const fields of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(e.utterance.fire("keydown", { key: "Enter", ...fields }).prevented, false);
  }
  e.utterance.fire("compositionstart"); e.utterance.fire("keydown", { key: "Enter" }); e.utterance.fire("compositionend");
  e.utterance.fire("keydown", { key: "Enter", repeat: true });
  assert.equal(calls.length, 1);
});

test("new trial clears old labels, dialogs, message drafts and result content, even for repeated seed", async () => {
  const { e, getState } = await ui(trial(), ({ path, state }) => {
    if (path === "/api/start") { state.trial = trial(); return { status: 200, body: state }; }
  });
  save(e, paths(e)[0], "前の試行の名前");
  e.utterance.value = "前の下書き";
  paths(e)[1].fire("click");
  e.setup.fire("submit"); await tick();
  assert.equal(getState().trial.trialId, "trial-private");
  assert.doesNotMatch(e.board.textContent, /前の試行/u);
  assert.equal(e.utterance.value, ""); assert.equal(e["name-dialog"].open, false);
  assert.equal(e["name-count"].textContent, "回答 0 / 6");
});

test("absent scene and initial empty session load safely", async () => {
  const empty = await ui(null); assert.equal(empty.e.trial.hidden, true); assert.equal(empty.e.setup.hidden, false);
  const state = trial(); delete state.scene;
  const { e } = await ui(state);
  assert.equal(paths(e).length, 0); assert.equal(e["review-names"].disabled, true);
  assert.match(e["scene-status"].textContent, /準備/u);
});

test("final results appear beside own figures without correspondence IDs", async () => {
  const state = trial(); state.submitted = true;
  state.result = { figures: [{ figureId: "PRIVATE-GOLD", human: { slot: "s-a81c", rawName: "帆" }, ai: { rawName: "船" }, matched: false }] };
  const { e } = await ui(state);
  assert.match(e.board.textContent, /あなた：帆/u); assert.match(e.board.textContent, /AI：船 · 不一致/u);
  assert.doesNotMatch(e.board.textContent + e["result-body"].textContent, /PRIVATE-GOLD|s-a81c|figureId/u);
});

test("layout gives chat half the desktop width and a tall independent scrolling log", () => {
  assert.match(css, /grid-template-columns:1fr 1fr/u);
  assert.match(css, /height:82dvh/u); assert.match(css, /height:74dvh/u);
  assert.match(css, /overflow-y:auto/u); assert.match(css, /overscroll-behavior:contain/u);
  assert.match(css, /pointer-events:visibleFill/u); assert.match(css, /prefers-reduced-motion/u);
});

test("a missing modern endpoint alone enables one serialized legacy fallback", async () => {
  const { e, calls } = await ui(trial(), ({ path, body, state }) => {
    if (path === "/api/message") return { status: 404, body: { error: "not_found" } };
    if (path === "/api/turn") {
      state.trial.events.push({ id: "legacy-" + state.trial.events.length, speaker: "human", text: body.utterance });
      return { status: 200, body: state };
    }
  });
  e.utterance.value = "旧APIへの発話"; e.chat.fire("submit"); await tick();
  assert.equal(calls.filter((call) => call.path === "/api/message").length, 1);
  assert.deepEqual(calls.find((call) => call.path === "/api/turn").body, { utterance: "旧APIへの発話" });
  assert.equal(e.history.children.length, 1);
});

test("poll begun before final submission cannot reopen a submitted trial", async () => {
  let reads = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { e, poll } = await ui(trial(), async ({ path, state }) => {
    if (path === "/api/state" && ++reads === 2) {
      const snapshot = structuredClone(state); await gate;
      return { status: 200, body: snapshot };
    }
  });
  const polling = poll(); await tick();
  for (const path of paths(e)) { path.fire("click"); e["name-unknown"].fire("click"); }
  e.submission.fire("submit"); e["confirm-submit"].fire("click"); await tick();
  assert.equal(e["send-message"].disabled, true);
  release(); await polling;
  assert.equal(e["send-message"].disabled, true);
});

test("polling preserves a reader's scroll position when they have scrolled up", async () => {
  const state = trial();
  state.events = Array.from({ length: 8 }, (_, i) => ({ id: i, speaker: i % 2 ? "ai" : "human", text: "公開会話" + i }));
  const { e, getState, poll } = await ui(state);
  e.history.scrollTop = 80; e.history.fire("scroll");
  getState().trial.events.push({ id: 9, speaker: "ai", text: "新しい応答" });
  await poll();
  assert.equal(e.history.scrollTop, 80);
  assert.match(e.history.textContent, /新しい応答/u);
});
