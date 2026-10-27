import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const web = new URL("../dialogue-model/runtime/web/", import.meta.url);
const [script, html] = await Promise.all(["app.js", "index.html"].map((name) => readFile(new URL(name, web), "utf8")));

// Exercise the shipped HTML and handlers with the same small DOM approach as
// web-v2-layout-stages, including actual text and initial hidden attributes.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {};
    this.value = ""; this._text = ""; this.disabled = false; this.hidden = false; this.open = false;
    this.scrollTop = 0; this.clientHeight = 400;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "hidden" || name === "disabled") this[name] = true;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get scrollHeight() { return this.children.length * 200; }
  querySelectorAll(selector) {
    const matches = (child) => selector.split(",").some((part) => {
      const match = part.match(/^([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/u);
      return match && child.tagName === match[1] && (!match[2] || child.getAttribute(match[2]) === match[3]);
    });
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  // Deliberately dispatch even to disabled buttons to verify the handler guard.
  fire(type) { for (const handler of this.handlers[type] ?? []) handler({ target: this, preventDefault() {} }); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollTo({ top }) { this.scrollTop = top; }
  getBBox() { return { x: 100, y: 150, width: 130, height: 180 }; }
}
function makeDOM() {
  const root = new Element("document"), stack = [root], ids = {};
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?([\w-]+)\b([^>]*?)>|([^<]+)/gu)) {
    const [, tag, rest, text] = token;
    if (text) { stack.at(-1)._text += text; continue; }
    if (!tag) continue;
    if (token[0].startsWith("</")) { if (stack.at(-1)?.tagName === tag) stack.pop(); continue; }
    const node = new Element(tag);
    for (const [, name, quoted, unquoted] of rest.matchAll(/([\w-]+)(?:="([^"]*)"|=([^\s]+))?/gu)) node.setAttribute(name, quoted ?? unquoted ?? "");
    node.value = node.getAttribute("value") ?? "";
    if (node.getAttribute("id")) ids[node.getAttribute("id")] = node;
    stack.at(-1).append(node);
    if (!["input", "meta", "link", "br"].includes(tag)) stack.push(node);
  }
  return { root, e: ids };
}
const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function gate() {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  return { wait, release };
}
function trial(completed = false) {
  return { version: 2, sessionId: "private-session-id", status: completed ? "completed" : "dialogue",
    submitted: completed, aiSubmitted: completed, aiStatus: "idle", resultLocked: completed,
    events: [{ id: "public-1", speaker: "ai", text: "公開された会話" }],
    scene: { width: 1200, height: 800, shapes: [{ id: "opaque-shape", path: "M 100 100 l 60 80 l -40 90 Z" }] } };
}
async function ui(initial = null, handler) {
  const { root, e } = makeDOM();
  let state = { trial: initial }, timerId = 0;
  const calls = [], timers = new Map();
  const storage = new Map();
  runInNewContext(script, {
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    document: { getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options?.method ?? "GET", body });
      const custom = await handler?.({ path, body, setState: (value) => { state = value; } });
      const status = custom?.status ?? 200;
      const value = custom?.body ?? (path === "/api/records" ? { records: [] } : path.includes("questionnaire") ? {
        form: { items: [{ id: "q1", text: "試行用の質問", min: 1, max: 7 }] }, questionnaire: null,
      } : state);
      return { ok: status < 400, status, json: async () => structuredClone(value) };
    },
  });
  await tick();
  return { root, e, calls, poll: async () => {
    const callbacks = [...timers.values()]; timers.clear();
    for (const callback of callbacks) callback();
    await tick();
  } };
}
const starts = (calls) => calls.filter((call) => call.path === "/api/start");
const visibleText = (node) => node.hidden || (["dialog", "head"].includes(node.tagName) && !node.open) ? "" :
  node._text + node.children.map(visibleText).join("");

test("opening a page with no trial only reads state and waits for an explicit start", async () => {
  const { e, calls, poll } = await ui();
  assert.equal(calls[0].path, "/api/state");
  assert.equal(calls[0].method, "GET");
  assert.equal(starts(calls).length, 0, "page admission must not create a trial");
  assert.equal(e["start-stage"].hidden, false);
  assert.equal(e.trial.hidden, true);
  assert.equal(e["trial-progress"].hidden, true);
  assert.equal(e["start-trial"].textContent.trim(), "スタート");
  assert.equal(e["start-trial"].disabled, false);
  await poll(); await poll();
  assert.equal(starts(calls).length, 0, "waiting never starts a trial in the background");
});

test("start stays disabled until the initial state is known", async () => {
  const held = gate();
  const { e, calls } = await ui(null, async ({ path }) => { if (path === "/api/state") await held.wait; });
  assert.ok(e["start-trial"], "the start button is in the shipped HTML");
  assert.equal(e["start-trial"].disabled, true);
  e["start-trial"].fire("click");
  assert.equal(starts(calls).length, 0);
  held.release(); await tick();
  assert.equal(e["start-trial"].disabled, false);
  assert.equal(starts(calls).length, 0);
});

test("only the start button posts version 2 once, including a double click in flight", async () => {
  const held = gate();
  const { e, calls } = await ui(null, async ({ path, setState }) => {
    if (path === "/api/start") { await held.wait; setState({ trial: trial() }); }
  });
  assert.ok(e["start-trial"]);
  e["start-trial"].fire("click"); e["start-trial"].fire("click");
  await tick();
  assert.equal(e["start-trial"].disabled, true);
  assert.deepEqual(starts(calls), [{ path: "/api/start", method: "POST", body: { version: 2 } }]);
  held.release(); await tick();
  assert.equal(e["start-stage"].hidden, true);
  assert.equal(e.trial.hidden, false);
  assert.equal(e["trial-progress"].hidden, false);
  assert.equal(e["conversation-stage"].hidden, false);
  e["start-trial"].fire("click"); await tick();
  assert.equal(starts(calls).length, 1, "a hidden start button cannot replace an existing trial");
});

for (const completed of [false, true]) test(`an existing ${completed ? "completed" : "active"} trial bypasses waiting`, async () => {
  const { e, calls } = await ui(trial(completed));
  assert.ok(e["start-stage"]);
  assert.equal(e["start-stage"].hidden, true);
  assert.equal(e["start-trial"].disabled, true);
  assert.equal(e.trial.hidden, false);
  assert.equal(e["trial-progress"].hidden, false);
  assert.equal(e[completed ? "questionnaire-stage" : "conversation-stage"].hidden, false);
  assert.match(e.history.textContent, /公開された会話/u);
  e["start-trial"].fire("click"); await tick();
  assert.equal(starts(calls).length, 0);
});

test("waiting does not render conditions, strategy, seed or internal identifiers", async () => {
  const { root, e, calls } = await ui(null, ({ path }) => path === "/api/state" ? {
    body: { trial: null, condition: "private-condition", strategy: "repair-first", seed: 7654321,
      sessionId: "private-session-id", configId: "private-config-id", order: "private-order" },
  } : undefined);
  assert.ok(e["start-stage"]);
  assert.equal(e["start-stage"].hidden, false);
  assert.doesNotMatch(visibleText(root), /private-|repair-first|bypass-enabled|7654321|seed|条件|方略|内部ID/u);
  assert.equal(e["start-stage"].querySelectorAll("input,select,textarea").length, 0);
  assert.equal(starts(calls).length, 0);
});

test("a failed start stays on waiting and never retries without another click", async () => {
  let reject = true;
  const { e, calls, poll } = await ui(null, ({ path, setState }) => {
    if (path !== "/api/start") return;
    if (reject) return { status: 409, body: { error: "trial_unavailable" } };
    setState({ trial: trial() });
  });
  assert.ok(e["start-trial"]);
  e["start-trial"].fire("click"); await tick();
  assert.equal(e["start-stage"].hidden, false);
  assert.equal(e["start-trial"].disabled, false);
  assert.match(e.notice.textContent, /試行を開始できませんでした/u);
  await poll(); await poll();
  assert.equal(starts(calls).length, 1);
  reject = false; e["start-trial"].fire("click"); await tick();
  assert.equal(starts(calls).length, 2);
  assert.equal(e["start-stage"].hidden, true);
  assert.equal(e.trial.hidden, false);
});

const actions = [
  ["/api/message", (e) => { e.utterance.value = "送ろうとした下書き"; e.chat.fire("submit"); }],
  ["/api/names", (e) => e["confirm-submit"].fire("click")],
  ["/api/retry", (e) => e["retry-chat"].fire("click")],
  ["/api/ai-submit", (e) => e.submission.children.find((node) => node.tagName === "button" && node.handlers.click)?.fire("click")],
];
for (const [path, fire] of actions) {
  const initial = () => ({ ...trial(), ...(path === "/api/retry" ? { aiStatus: "error" } : {}),
    ...(path === "/api/ai-submit" ? { submitted: true, status: "scoring_error" } : {}) });
  test(`i139 UI ${path} includes the displayed trial's sessionId`, async () => {
    const { e, calls } = await ui(initial());
    fire(e); await tick();
    const sent = calls.find((call) => call.path === path);
    assert.ok(sent, "actual shipped action dispatched its POST");
    assert.equal(sent.body.expectedRecordId, "private-session-id");
  });
  test(`i139 UI ${path} trial_changed refreshes the trial and preserves unsent text`, async () => {
    const next = { ...trial(), sessionId: "next-private-trial", events: [{ id: "next-public", speaker: "ai", text: "次の試行の会話" }] };
    const held = gate();
    const { e, calls, poll } = await ui(initial(), async ({ path: requested, setState }) => {
      if (requested !== path) return;
      await held.wait; setState({ trial: next });
      return { status: 409, body: { error: "trial_changed" } };
    });
    fire(e); await tick();
    // The user can keep composing while the first message awaits its receipt.
    e.utterance.value = "さらに入力した下書き";
    held.release(); await tick();
    assert.ok(calls.slice(calls.findIndex((call) => call.path === path) + 1).some((call) => call.path === "/api/state"));
    assert.match(e.history.textContent, /次の試行の会話/u);
    assert.match(e.utterance.value, /さらに入力した下書き/u);
    if (path === "/api/message") assert.match(e.utterance.value, /送ろうとした下書き/u);
    await poll(); await poll();
    assert.equal(calls.filter((call) => call.path === path).length, 1, "an old-trial action is never replayed into the new trial");
    assert.doesNotMatch(e.history.textContent, /送ろうとした下書き/u, "the draft is not a message in the new trial");
  });
}
