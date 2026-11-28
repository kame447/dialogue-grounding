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
  append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
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
  let state = { trial: initial }, timerId = 0, now = 10000;
  const calls = [], timers = new Map(), delays = new Map(), frames = new Map();
  const storage = new Map();
  runInNewContext(script, {
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => START_INTENT },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    document: { getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    setTimeout: (callback, delay = 0) => { timers.set(++timerId, callback); delays.set(timerId, delay); return timerId; },
    clearTimeout: (id) => { timers.delete(id); delays.delete(id); },
    requestAnimationFrame: (callback) => { frames.set(++timerId, callback); return timerId; },
    cancelAnimationFrame: (id) => frames.delete(id),
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
  const run = async (callbacks) => { for (const callback of callbacks) callback(); await tick(); };
  return { root, e, calls, frames,
    timersAt: (delay) => [...timers].filter(([id]) => delays.get(id) === delay).map(([, callback]) => callback),
    frame: async () => { const callbacks = [...frames.values()]; frames.clear(); await run(callbacks); },
    runTimers: async (delay) => {
      now += delay;
      const callbacks = [];
      for (const [id, callback] of timers) if (delays.get(id) === delay) { callbacks.push(callback); timers.delete(id); delays.delete(id); }
      await run(callbacks);
    },
    poll: async () => {
      const delay = [...delays.values()].find((value) => [700, 2000, 5000].includes(value));
      if (delay === undefined) return;
      now += delay;
      const callbacks = [];
      for (const [id, callback] of timers) if (delays.get(id) === delay) { callbacks.push(callback); timers.delete(id); delays.delete(id); }
      await run(callbacks);
    },
  };
}
const START_INTENT = "00000000-0000-4000-8000-000000000001";
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
  assert.deepEqual(starts(calls), [{ path: "/api/start", method: "POST", body: { version: 2, startIntentId: START_INTENT } }]);
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

test("an unaccepted start waits, then resends the same intent after a fresh state read", async () => {
  let reject = true;
  const { e, calls, poll } = await ui(null, ({ path, setState }) => {
    if (path !== "/api/start") return;
    if (reject) return { status: 409, body: { error: "trial_unavailable" } };
    setState({ trial: trial() });
  });
  assert.ok(e["start-trial"]);
  e["start-trial"].fire("click"); await tick();
  assert.equal(e["start-stage"].hidden, false);
  assert.equal(e["start-trial"].disabled, true);
  assert.match(e["start-message"].textContent, /試行を準備しています/u);
  const initial = starts(calls)[0];
  reject = false;
  await poll(); await poll();
  assert.equal(starts(calls).length, 1);
  await poll();
  assert.equal(starts(calls).length, 2);
  assert.deepEqual(starts(calls)[1], initial);
  assert.equal(calls[calls.lastIndexOf(starts(calls)[1]) - 1].path, "/api/state");
  assert.equal(e["start-stage"].hidden, true);
  assert.equal(e.trial.hidden, false);
});

const actions = [
  ["/api/message", (e) => { e.utterance.value = "送ろうとした下書き"; e.chat.fire("submit"); }],
  ["/api/names", (e) => {
    e["finish-conversation"].fire("click");
    e.board.querySelectorAll("path")[0].fire("click");
    e["name-unknown"].fire("click");
    e.submission.fire("submit");
    assert.equal(e["confirm-dialog"].open, true);
    e["confirm-submit"].fire("click");
  }],
];
for (const [path, fire] of actions) {
  test(`i139 UI ${path} includes the displayed trial's sessionId`, async () => {
    const { e, calls } = await ui(trial());
    fire(e); await tick();
    const sent = calls.find((call) => call.path === path);
    assert.ok(sent, "actual shipped action dispatched its POST");
    assert.equal(sent.body.expectedRecordId, "private-session-id");
  });
  test(`i139 UI ${path} trial_changed refreshes the trial and preserves unsent text`, async () => {
    const next = { ...trial(), sessionId: "next-private-trial", events: [{ id: "next-public", speaker: "ai", text: "次の試行の会話" }] };
    const held = gate();
    const { e, calls, poll } = await ui(trial(), async ({ path: requested, setState }) => {
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

for (const [label, initial, complete] of [
  ["dialogue", { aiStatus: "error", dialogueRecovery: "retry" }, (value) => ({
    ...value, aiStatus: "idle", dialogueRecovery: "active",
    events: [...value.events, { id: "recovered", speaker: "ai", text: "自動で届いた返答" }],
  })],
  ["submission", { submitted: true, status: "submitting", finalError: "scoring_error" }, (value) => ({
    ...value, status: "completed", aiSubmitted: true, resultLocked: true,
  })],
]) {
  test(`i139 UI tracks automatic ${label} recovery with GET and keeps the same trial`, async () => {
    let current = { ...trial(), ...initial };
    const { e, calls, poll } = await ui(current, ({ path }) => path === "/api/state" ? { body: { trial: current } } : undefined);
    const before = calls.length;
    current = complete(current);
    await poll();
    assert.ok(calls.slice(before).some(({ path, method }) => path === "/api/state" && method === "GET"));
    assert.equal(current.sessionId, "private-session-id");
    if (label === "dialogue") assert.match(e.history.textContent, /自動で届いた返答/u);
    else assert.equal(e["submission-status"].textContent, "双方の提出が完了しました。");
    assert.equal(calls.some(({ path }) => ["/api/retry", "/api/interrupt", "/api/ai-submit"].includes(path)), false);
  });

  test(`i139 UI replaces the old ${label} recovery display when the active trial changes`, async () => {
    let current = { ...trial(), ...initial };
    const { e, calls, poll } = await ui(current, ({ path }) => path === "/api/state" ? { body: { trial: current } } : undefined);
    e.utterance.value = "別の試行へ送らない下書き";
    current = { ...trial(), sessionId: "next-private-trial", events: [{ id: "next-public", speaker: "ai", text: "次の試行の会話" }] };
    await poll();
    assert.match(e.history.textContent, /次の試行の会話/u);
    assert.doesNotMatch(e.history.textContent, /別の試行へ送らない下書き/u);
    assert.equal(e["chat-recovery"].hidden, true);
    assert.equal(calls.filter(({ method }) => method === "POST").length, 0);
  });
}


const scriptedTrial = (id = "scripted-trial") => ({ ...trial(), sessionId: id, openingMode: "scripted_v1",
  events: [{ id: id + "-opening", speaker: "ai", text: "どれから話しましょうか？", nonReferential: true }] });
const typingShown = (e) => e.history.children.at(-1)?.className === "ai typing-message";

test("a new start shows the scene and the usual dots, then the saved opening one second after paint", async () => {
  const x = await ui(null, ({ path, setState }) => {
    if (path === "/api/start") setState({ trial: scriptedTrial() });
  });
  x.e["start-trial"].fire("click"); x.e["start-trial"].fire("click"); await tick();
  assert.equal(starts(x.calls).length, 1);
  assert.equal(x.e.trial.hidden, false);
  assert.equal(x.e["conversation-stage"].hidden, false);
  assert.ok(x.e.board.children.length);
  assert.ok(typingShown(x.e));
  assert.doesNotMatch(x.e.history.textContent, /どれから話しましょうか/u);
  assert.equal(x.e.utterance.disabled, false, "the participant can already write a draft");
  assert.equal(x.e["send-message"].disabled, true);
  assert.equal(x.e["finish-conversation"].disabled, true);
  x.e.utterance.value = "上の形から話したいです"; x.e.chat.fire("submit");
  x.e["finish-conversation"].fire("click");
  assert.equal(x.calls.some(({ path }) => path === "/api/message"), false);
  assert.equal(x.e["conversation-stage"].hidden, false);
  assert.equal(x.timersAt(1000).length, 0, "network completion alone must not start the display countdown");
  await x.frame();
  assert.equal(x.timersAt(1000).length, 0, "allow the first rendered frame to paint");
  await x.frame();
  assert.equal(x.timersAt(1000).length, 1);
  assert.ok(typingShown(x.e));
  await x.runTimers(1000);
  assert.equal(typingShown(x.e), false);
  assert.match(x.e.history.textContent, /どれから話しましょうか/u);
  assert.equal(x.e.history.children.length, 1);
  assert.equal(x.e["send-message"].disabled, false);
  assert.equal(x.e["finish-conversation"].disabled, false);
  assert.equal(x.e.utterance.value, "上の形から話したいです");
  await x.poll(); await x.frame();
  assert.equal(x.e.history.children.length, 1, "polling neither duplicates nor hides the greeting again");
  assert.equal(x.timersAt(1000).length, 0);
});

test("reloading an existing scripted opening shows its saved history immediately", async () => {
  const x = await ui(scriptedTrial());
  assert.match(x.e.history.textContent, /どれから話しましょうか/u);
  assert.equal(typingShown(x.e), false);
  assert.equal(x.e["send-message"].disabled, false);
  assert.equal(x.frames.size, 0);
  assert.equal(x.timersAt(1000).length, 0);
  assert.equal(starts(x.calls).length, 0);
});

test("a trial switch cancels the opening timer and ignores an already dispatched callback", async () => {
  let serverTrial = null;
  const x = await ui(null, ({ path, setState }) => {
    if (path === "/api/start") { serverTrial = scriptedTrial(); setState({ trial: serverTrial }); }
    if (path === "/api/state") return { body: { trial: serverTrial } };
  });
  x.e["start-trial"].fire("click"); await tick(); await x.frame(); await x.frame();
  const stale = x.timersAt(1000)[0];
  assert.equal(typeof stale, "function");
  serverTrial = { ...trial(), sessionId: "different-trial", events: [{ id: "different-opening", speaker: "ai", text: "別の試行の会話" }] };
  await x.runTimers(2000);
  assert.match(x.e.history.textContent, /別の試行の会話/u);
  assert.equal(x.timersAt(1000).length, 0);
  stale(); await tick();
  assert.match(x.e.history.textContent, /別の試行の会話/u);
  assert.doesNotMatch(x.e.history.textContent, /どれから話しましょうか/u);
  assert.equal(typingShown(x.e), false);
  assert.equal(x.e["send-message"].disabled, false);
});

test("a failed start creates no presentation timer; automatic recovery presents the opening once", async () => {
  let fail = true;
  const x = await ui(null, ({ path, setState }) => {
    if (path !== "/api/start") return;
    if (fail) return { status: 409, body: { error: "trial_unavailable" } };
    setState({ trial: scriptedTrial(), startIntentId: START_INTENT });
  });
  x.e["start-trial"].fire("click"); await tick();
  assert.equal(x.frames.size, 0);
  assert.equal(x.timersAt(1000).length, 0);
  fail = false;
  await x.poll(); await x.poll();
  assert.equal(starts(x.calls).length, 1);
  await x.poll();
  assert.ok(typingShown(x.e));
  await x.frame(); await x.frame(); await x.runTimers(1000);
  assert.equal(x.e.history.children.length, 1);
  assert.equal(typingShown(x.e), false);
  assert.equal(starts(x.calls).length, 2);
  assert.deepEqual(starts(x.calls)[0].body, starts(x.calls)[1].body);
});


test("a legacy generated opening is displayed immediately even after an explicit start", async () => {
  const x = await ui(null, ({ path, setState }) => {
    if (path === "/api/start") setState({ trial: trial() });
  });
  x.e["start-trial"].fire("click"); await tick();
  assert.match(x.e.history.textContent, /公開された会話/u);
  assert.equal(typingShown(x.e), false);
  assert.equal(x.e["send-message"].disabled, false);
  assert.equal(x.frames.size, 0);
  assert.equal(x.timersAt(1000).length, 0);
});

test("a state poll can reveal a newly started trial before its POST returns without replaying the opening", async () => {
  const held = gate();
  let state = { trial: null, reception: { status: "ready", revision: 1 } };
  const x = await ui(null, async ({ path }) => {
    if (path === "/api/start") {
      state = { trial: scriptedTrial(), startIntentId: START_INTENT, reception: { status: "in_progress", revision: 2 } };
      await held.wait;
      return { body: state };
    }
    if (["/api/state", "/api/reception"].includes(path)) return { body: state };
  });
  x.e["start-trial"].fire("click"); await tick();
  await x.runTimers(700);
  assert.equal(x.e.trial.hidden, false);
  assert.ok(typingShown(x.e));
  assert.doesNotMatch(x.e.history.textContent, /どれから話しましょうか/u);
  await x.frame(); await x.frame(); await x.runTimers(1000);
  assert.match(x.e.history.textContent, /どれから話しましょうか/u);
  held.release(); await tick(); await x.frame();
  assert.equal(x.e.history.children.length, 1);
  assert.equal(typingShown(x.e), false);
  assert.equal(x.timersAt(1000).length, 0);
  assert.equal(x.e["send-message"].disabled, false);
  assert.equal(starts(x.calls).length, 1);
});

test("an explicitly started trial with its generated opening pending waits for that opening", async () => {
  let current = { ...trial(), events: [], aiStatus: "thinking", recovering: true };
  const { e, calls, poll } = await ui(current, ({ path }) => path === "/api/state"
    ? { body: { trial: current, busy: current.aiStatus === "thinking" } } : undefined);
  assert.equal(e["send-message"].disabled, true);
  assert.equal(e.utterance.disabled, false);
  e.utterance.value = "挨拶を待つ間の下書き";
  e.chat.fire("submit");
  assert.equal(calls.some(({ path }) => path === "/api/message"), false);
  current = trial();
  await poll();
  assert.equal(e["send-message"].disabled, false);
  assert.equal(e.utterance.value, "挨拶を待つ間の下書き");
  assert.match(e.history.textContent, /公開された会話/u);
});
