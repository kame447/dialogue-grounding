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
  focus(options) { if (this.disabled) return; this.focusOptions = options; this.focused = true; }
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
  return { version: 2, sessionId: id, submitted: false, aiStatus: "idle", events: [], scene: {
    width: 1200, height: 800, shapes: ["s-a81c", "s-f120", "s-119e", "s-cc02", "s-a620", "s-67b4"].map((id, i) => ({
      id, path: `M ${100 + i * 140} 100 l 60 80 l -40 90 Z`, centroid: { x: 140 + i * 140, y: 200 },
    })),
  } };
}
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function ui(initial = trial(), handler, storage = new Map()) {
  const { root, ids: e } = makeDOM();
  let state = { trial: initial }, timerId = 0;
  const timers = new Map(), calls = [];
  e.setup.elements.strategy.value = "repair-first";
  e.setup.elements.seed.value = "1";
  runInNewContext(script, {
    document: { getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => {
      const node = new Element(tag);
      if (tag === "path" && e["confirm-scene"].simulateHiddenPaths) node.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });
      return node;
    } },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
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


test("chat opens with an upcoming questionnaire step and a hidden final form", async () => {
  const { e, calls } = await ui();
  assert.equal(e["conversation-stage"].hidden, false);
  assert.equal(e["name-stage"].hidden, true);
  assert.equal(e.results.hidden, true);
  assert.equal(e["step-chat"].getAttribute("aria-current"), "step");
  assert.equal(e["step-questionnaire"].getAttribute("data-state"), "upcoming");
  assert.equal(e["review-bar"].hidden, true, "review navigation appears only after submission");
  assert.equal(e["name-list"].children.length, 6);
  assert.equal(e.setup.hidden, true);
  assert.equal(calls.filter((call) => call.path !== "/api/records").length, 1);
});

test("explicit name-stage navigation preserves names and history without submitting", async () => {
  const state = trial(); state.events.push({ id: "public-1", speaker: "ai", text: "公開された相談" });
  const { e, calls } = await ui(state);
  save(e, paths(e)[0], "合意した名前");
  e["finish-conversation"].fire("click");
  assert.equal(e["conversation-stage"].hidden, true);
  assert.equal(e["name-stage"].hidden, false);
  assert.equal(e["names-title"].focused, true);
  assert.equal(e["step-chat"].getAttribute("data-state"), "complete");
  assert.equal(e["step-names"].getAttribute("aria-current"), "step");
  assert.equal(e.utterance.disabled, true);
  assert.match(e["name-list"].textContent, /合意した名前/u);
  e["name-list"].children[0].fire("click");
  assert.equal(e["figure-name"].value, "合意した名前");
  e["figure-name"].value = "修正した名前"; e["name-form"].fire("submit");
  assert.equal(e["name-list"].children[0].focused, true, "focus returns to the current row after rebuilding names");
  assert.match(e["name-list"].textContent, /修正した名前/u);
  e["back-to-chat"].fire("click");
  assert.equal(e["conversation-stage"].hidden, false);
  assert.equal(e.utterance.disabled, false);
  assert.equal(e.utterance.focused, true);
  assert.match(e.history.textContent, /公開された相談/u);
  assert.equal(calls.filter((call) => call.path !== "/api/records").length, 1, "stage changes and draft editing never call the server");
});

test("reload restores stage and private drafts only for the same opaque v2 session", async () => {
  const storage = new Map();
  const first = await ui(trial("session-one"), undefined, storage);
  save(first.e, paths(first.e)[0], "同じ試行の名前");
  first.e["finish-conversation"].fire("click");
  const restored = await ui(trial("session-one"), undefined, storage);
  assert.equal(restored.e["name-stage"].hidden, false);
  assert.match(restored.e.board.textContent, /同じ試行の名前/u);
  assert.equal(restored.calls.filter((call) => call.path !== "/api/records").length, 1);
  const fresh = await ui(trial("session-two"), undefined, storage);
  assert.equal(fresh.e["conversation-stage"].hidden, false);
  assert.doesNotMatch(fresh.e.board.textContent, /同じ試行/u);
  assert.equal(storage.size, 0);
});

test("accepted final names stay in Name stage until the server publishes a result", async () => {
  const { e, calls, getState, poll } = await ui();
  e["finish-conversation"].fire("click");
  for (const path of paths(e)) { path.fire("click"); e["name-unknown"].fire("click"); }
  e.submission.fire("submit");
  assert.equal(e["confirm-dialog"].open, true);
  e["confirm-submit"].fire("click"); await tick();
  assert.equal(e.results.hidden, true);
  assert.equal(e["name-stage"].hidden, false);
  // After submission the chat stays viewable (read-only), never editable.
  assert.equal(e["back-to-chat"].disabled, false);
  assert.equal(e["review-names"].hidden, true);
  assert.equal(e.chat.hidden, true);
  assert.equal(e["review-bar"].hidden, false);
  assert.match(e["review-notice"].textContent, /名前と会話はもう変更できません/u);
  assert.equal(calls.filter((call) => call.path === "/api/names").length, 1);
  assert.equal(calls.find((call) => call.path === "/api/names").body.confirm, true);
  getState().trial.aiSubmitted = true;
  await poll();
  assert.equal(e.results.hidden, true, "both submission flags alone are not a result");
  getState().trial.result = { figures: paths(e).map((path) => ({ human: { slot: path.sceneShape.id, rawName: "" }, ai: { rawName: "" }, matched: true })) };
  await poll();
  assert.equal(e.results.hidden, false);
  assert.equal(e["name-stage"].hidden, true);
  assert.equal(e["step-results"].getAttribute("aria-current"), "step");
  assert.equal(e["step-names"].getAttribute("data-state"), "complete");
  assert.equal(e["step-questionnaire"].getAttribute("data-state"), "planned");
  assert.equal(e["results-title"].focused, true);
});

test("rejected final names retain editable Name stage and never show Results", async () => {
  const { e, calls } = await ui(trial(), ({ path }) => path === "/api/names" ? { status: 409, body: { error: "busy" } } : undefined);
  e["finish-conversation"].fire("click");
  for (const path of paths(e)) { path.fire("click"); e["name-unknown"].fire("click"); }
  e.submission.fire("submit"); e["confirm-submit"].fire("click"); await tick();
  assert.equal(e.results.hidden, true);
  assert.equal(e["name-stage"].hidden, false);
  assert.equal(e["back-to-chat"].disabled, false);
  assert.equal(e["review-names"].disabled, false);
  assert.equal(calls.filter((call) => call.path === "/api/names").length, 1);
});

test("a different v2 session clears old drafts, history and modal during polling", async () => {
  const { e, setState, poll } = await ui(trial("session-before"));
  save(e, paths(e)[0], "前の名前");
  e["finish-conversation"].fire("click");
  paths(e)[1].fire("click");
  setState({ trial: trial("session-after") }); await poll();
  assert.equal(e["name-dialog"].open, false);
  assert.equal(e["conversation-stage"].hidden, false);
  assert.doesNotMatch(e.board.textContent + e["name-list"].textContent, /前の名前/u);
});

test("closed confirmation SVG uses each own figure's live bounds for its name", async () => {
  const { e } = await ui();
  e["finish-conversation"].fire("click");
  paths(e).forEach((path, index) => {
    path.getBBox = () => ({ x: 100 + index * 100, y: 100 + index * 70, width: 70, height: 90 });
    save(e, path, "名称" + index);
  });
  e["confirm-scene"].simulateHiddenPaths = true;
  e.submission.fire("submit");
  const previewPaths = e["confirm-scene"].querySelectorAll("path");
  assert.equal(previewPaths.length, 6);
  previewPaths.forEach((path, index) => {
    assert.equal(path.shapeName.getAttribute("y"), String(216 + index * 70));
    assert.equal(path.shapeName.getAttribute("x"), String(path.sceneShape.centroid.x));
    assert.equal(path.shapeName.textContent, "名称" + index);
  });
  assert.equal(new Set(previewPaths.map((path) => path.shapeName.getAttribute("y"))).size, 6,
    "names do not collapse into one row when the preview dialog has no layout");
});
