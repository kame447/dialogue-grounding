import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const web = new URL("../dialogue-model/runtime/web/", import.meta.url);
const [script, html, css] = await Promise.all(["app.js", "index.html", "style.css"].map((name) => readFile(new URL(name, web), "utf8")));
// Same DOM fixture as web-v2-chat-ux.test.mjs: shipped handlers, no browser packages.
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
  const timers = new Map(), calls = [];
  runInNewContext(script, {
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => "browser-client-" + ++clientSequence },
    document: { getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
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
      // invalidJson models an HTML error page from a proxy in front of the app.
      if (custom) return { ok: custom.status < 400, status: custom.status, json: async () => {
        if (custom.invalidJson) throw new SyntaxError("Unexpected token '<', \"<html>502 Bad Gateway\" is not valid JSON");
        return structuredClone(custom.body);
      } };
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
    poll: async () => {
      const timer = [...timers.values()].filter((entry) => entry.delay === 700 || entry.delay === 2000).sort((a, b) => a.at - b.at)[0];
      assert.ok(timer, "a state refresh is scheduled"); await advance(timer.at - now);
    } };
}
const send = (e, text) => { e.utterance.value = text; e.chat.fire("submit"); };
const messageBodies = (e) => e.history.children.map((node) => node.querySelectorAll("p")[0]?.textContent);
const messageCalls = (calls) => calls.filter((call) => call.path === "/api/message");
const gate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; };
const paths = (e) => e.board.children.filter((node) => node.tagName === "path");
const nameAll = async (e, skip = -1) => {
  for (const [i, path] of paths(e).entries()) {
    if (i === skip) continue;
    path.fire("click"); e["figure-name"].value = "名前" + i; e["name-form"].fire("submit"); await tick();
  }
};
const itemTexts = (list) => list.children.map((item) => item.querySelectorAll("span")[0]?.textContent);
const STOPPED = "進行を確認できません。実験担当者にお知らせください。";
// Issue #161: no internal cause reaches the participant (AI failure wording,
// retries of AI work, scoring, HTTP/JSON/transport text or error codes).
const INTERNAL = /AIの返答|AIに接続|AIの提出を再試行|再試行|採点|エラー|通信|サーバー|[0-9]{3}|JSON|Unexpected|Failed|fetch|Bad Gateway|ai_|_error|scoring|record_write|PRIVATE/u;
const visibleText = (root) => root.textContent;
const retryButton = (e) => e.submission.children.find((node) => node.tagName === "button" && node.handlers.click);
const submittedTrial = (extra) => ({ ...trial(), submitted: true, closed: true, status: "submitting",
  humanSubmission: Object.fromEntries(trial().scene.shapes.map((shape, i) => [shape.id, "名前" + i])), ...extra });

test("an AI retry in flight shows typing dots instead of the stale error, then the reply", async () => {
  const held = gate(), initial = trial();
  initial.aiStatus = "error";
  const { e } = await ui(initial, async ({ path }) => { if (path === "/api/retry") await held.wait; });
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED, "a reloaded stopped trial shows the neutral notice at once");
  assert.equal(e["typing-indicator"].hidden, true);
  e["retry-chat"].fire("click"); await tick();
  assert.equal(e["chat-recovery"].hidden, true, "the old error is not shown while the retry runs");
  assert.equal(e["typing-indicator"].hidden, false, "the retry is shown as AI activity");
  held.release(); await tick();
  assert.equal(e["typing-indicator"].hidden, true);
  assert.equal(e["chat-recovery"].hidden, true);
  assert.ok(e.history.textContent.includes("再試行した応答"));
});

test("a failed retry returns to the explicit error after the in-flight state", async () => {
  const initial = trial();
  initial.aiStatus = "error";
  const { e, calls } = await ui(initial, async ({ path }) => (path === "/api/retry" ? { status: 502, body: { error: "ai_unavailable" } } : undefined));
  e["retry-chat"].fire("click"); await tick();
  assert.equal(calls.filter((call) => call.path === "/api/retry").length, 1);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["chat-recovery-message"].textContent, STOPPED);
  assert.equal(e.notice.textContent, "", "the stop is shown once, beside the composer");
  assert.equal(e["typing-indicator"].hidden, true);
});

test("the unanswered-figure warning survives polling until every figure is answered", async () => {
  const { e, poll } = await ui();
  e["finish-conversation"].fire("click");
  await nameAll(e, 2);
  e.submission.fire("submit");
  assert.match(e["submission-status"].textContent, /名前が未入力の図形があります/u);
  await poll(); await poll();
  assert.match(e["submission-status"].textContent, /名前が未入力の図形があります/u, "a state refresh must not erase the warning");
  paths(e)[2].fire("click"); e["name-unknown"].fire("click"); await tick();
  await poll();
  assert.doesNotMatch(e["submission-status"].textContent, /未入力/u);
});

test("confirmation and results add a readable thumbnail list with the same names, never figure ids", async () => {
  const { e, getState, poll } = await ui();
  e["finish-conversation"].fire("click");
  await nameAll(e, 5);
  paths(e)[5].fire("click"); e["name-unknown"].fire("click"); await tick();
  e.submission.fire("submit");
  assert.equal(e["confirm-dialog"].open, true);
  assert.deepEqual(itemTexts(e["confirm-list"]), ["名前0", "名前1", "名前2", "名前3", "名前4", "未合意・わからない"]);
  assert.ok(e["confirm-list"].children.every((item) => item.className === "summary-item" && item.children[0].tagName === "svg"));
  assert.equal(e["result-list"].children.length, 0, "no results before the server publishes them");
  const state = getState().trial;
  Object.assign(state, { submitted: true, aiSubmitted: true, status: "completed", result: { figures: paths(e).map((path, i) => ({
    human: { slot: path.sceneShape.id, rawName: i === 5 ? "" : "名前" + i }, ai: { rawName: i % 2 ? "鳥" : "" }, matched: i === 0 })) } });
  await poll();
  assert.equal(e.results.hidden, false);
  const texts = itemTexts(e["result-list"]);
  assert.equal(texts.length, 6);
  assert.equal(texts[0], "あなた：名前0\nAI：未合意・わからない · 一致");
  assert.equal(texts[5], "あなた：未合意・わからない\nAI：鳥 · 不一致");
  const visible = e["result-list"].textContent + e["confirm-list"].textContent;
  for (const id of ["s-a81c", "s-f120", "s-119e", "s-cc02", "s-a620", "s-67b4"]) assert.ok(!visible.includes(id));
});

test("phone layout: conversation stage fits one viewport, desktop rules are untouched", () => {
  const desktop = css.split("@media")[0];
  assert.ok(!desktop.includes(":has("), "the phone layout never applies outside its media query");
  assert.match(desktop, /\.workspace\{display:grid;grid-template-columns:minmax\(0,7fr\) minmax\(0,3fr\)/u);
  const phone = css.match(/@media\(max-width:760px\)\{\nmain:has[\s\S]*?\n\}/u)?.[0];
  assert.ok(phone, "a separate phone block exists");
  const scope = "main:has(#trial:not([hidden]) #conversation-stage:not([hidden]))";
  assert.ok(phone.split("\n").slice(1, -1).every((line) => line.startsWith(scope)), "only the conversation stage changes; names and results keep their layout");
  assert.match(phone, /\{height:100dvh;display:flex;flex-direction:column/u);
  assert.match(phone, /\.board\{[^}]*height:35dvh/u);
  assert.match(phone, /\.dialogue\{flex:1;[^}]*min-height:0/u);
  assert.match(phone, /#chat\{display:flex/u);
  assert.match(css, /@media\(max-width:760px\) and \(max-height:500px\)\{[^@]*\.workspace\{flex-direction:row\}/u, "short landscape phones place board and chat side by side");
  assert.match(css, /@media\(min-width:761px\)\{#confirm-list\{display:none\}\}/u);
  assert.ok(!/#board[^{]*\{[^}]*(?:transform|rotate|scale)/u.test(css), "the stimulus keeps its geometry");
  assert.match(html, /<div id="confirm-list" class="summary-list"/u);
  assert.match(html, /<div id="result-list" class="summary-list"/u);
});

for (const [label, reply] of [
  ["a coded AI failure", () => ({ status: 502, body: { error: "ai_unavailable" } })],
  ["a coded scoring failure with extra detail", () => ({ status: 500, body: { error: "scoring_error", detail: "PRIVATE model-x" } })],
  ["an HTML proxy error page", () => ({ status: 502, invalidJson: true })],
  ["a dropped connection", () => { throw new TypeError("Failed to fetch"); }],
]) {
  test(`i161: ${label} while submitting names shows only the neutral stop`, async () => {
    const { e, root, calls } = await ui(trial(), async ({ path, state }) => {
      if (path !== "/api/names") return;
      Object.assign(state.trial, { submitted: true, closed: true, status: "submitting", finalError: "ai_unavailable",
        humanSubmission: Object.fromEntries(state.trial.scene.shapes.map((shape, i) => [shape.id, "名前" + i])) });
      return reply();
    });
    e["finish-conversation"].fire("click");
    await nameAll(e);
    e.submission.fire("submit"); e["confirm-submit"].fire("click"); await tick();
    assert.equal(calls.filter((call) => call.path === "/api/names").length, 1);
    assert.equal(e["submission-status"].textContent, STOPPED);
    assert.equal(e.notice.textContent, "", "not repeated at the top");
    assert.equal(retryButton(e).hidden, false);
    assert.equal(retryButton(e).textContent, "状態を確認");
    assert.doesNotMatch(visibleText(root), INTERNAL);
  });
}

test("i161: an unexplained failure outside the trial view is the same neutral sentence, never the raw error", async () => {
  const { e, root } = await ui(trial(), ({ path }) => { if (path === "/api/names") throw new TypeError("Failed to fetch"); });
  e["finish-conversation"].fire("click");
  await nameAll(e);
  e.submission.fire("submit"); e["confirm-submit"].fire("click"); await tick();
  assert.equal(e.notice.textContent, STOPPED);
  assert.doesNotMatch(visibleText(root), INTERNAL);
});

test("i161: a v2 scoring failure after both submissions never waits silently; 状態を確認 resumes the same submission once", async () => {
  const held = gate();
  const { e, root, calls, getState } = await ui(submittedTrial({ aiSubmitted: true, finalError: "scoring_error" }), async ({ path, state }) => {
    if (path !== "/api/ai-submit") return;
    await held.wait;
    Object.assign(state.trial, { status: "completed", finalError: undefined, aiSubmitted: true,
      result: { figures: state.trial.scene.shapes.map((shape) => ({ human: { slot: shape.id, rawName: "名前" }, ai: { rawName: "名前" }, matched: true })) } });
  });
  assert.equal(e["submission-status"].textContent, STOPPED);
  assert.equal(retryButton(e).hidden, false);
  assert.doesNotMatch(visibleText(root), INTERNAL);
  retryButton(e).fire("click"); retryButton(e).fire("click"); await tick();
  const order = calls.map((call) => call.path).filter((path) => ["/api/state", "/api/ai-submit", "/api/names"].includes(path));
  assert.equal(order.at(-2), "/api/state", "the state is read before anything is resumed");
  assert.equal(order.at(-1), "/api/ai-submit");
  assert.equal(calls.filter((call) => call.path === "/api/ai-submit").length, 1, "a double click resumes once");
  assert.equal(calls.filter((call) => call.path === "/api/names").length, 0, "names are never resent");
  assert.equal(calls.find((call) => call.path === "/api/ai-submit").body.expectedRecordId, getState().trial.sessionId);
  held.release(); await tick();
  assert.equal(retryButton(e).hidden, true);
  assert.notEqual(e["submission-status"].textContent, STOPPED);
});

test("i161: a submission with no reported failure waits quietly, then shows the neutral stop after the watchdog", async () => {
  const { e, calls, advance } = await ui(submittedTrial({ aiSubmitted: false }));
  assert.equal(e["submission-status"].textContent, "名前を提出しました。AIの提出を待っています。");
  assert.equal(retryButton(e).hidden, true);
  await advance(59000);
  assert.equal(retryButton(e).hidden, true);
  await advance(2000);
  assert.equal(e["submission-status"].textContent, STOPPED);
  assert.equal(retryButton(e).hidden, false);
  assert.equal(calls.filter((call) => call.path === "/api/ai-submit").length, 0, "nothing is resumed automatically");
});

test("i161: 状態を確認 on a stalled AI turn only re-reads the state; a double click on a stopped turn resumes it once", async () => {
  const stalled = trial(); stalled.aiStatus = "thinking";
  const first = await ui(stalled);
  await first.advance(60001);
  assert.equal(first.e["chat-recovery-message"].textContent, STOPPED);
  first.e["retry-chat"].fire("click"); await tick();
  assert.equal(first.calls.filter((call) => call.path === "/api/retry").length, 0, "the server still reports work in progress");
  const stopped = trial(); stopped.aiStatus = "error";
  const held = gate();
  const second = await ui(stopped, async ({ path }) => { if (path === "/api/retry") await held.wait; });
  second.e["retry-chat"].fire("click"); second.e["retry-chat"].fire("click"); await tick();
  assert.equal(second.calls.filter((call) => call.path === "/api/retry").length, 1);
  assert.equal(second.calls.filter((call) => call.path === "/api/message").length, 0, "no human message is replayed");
  held.release(); await tick();
  assert.equal(second.e["chat-recovery"].hidden, true);
});

test("i161: while waiting for the reception, a lasting failed state read shows the neutral stop on the visible screen", async () => {
  let offline = false;
  const waiting = { trial: null, reception: { status: "waiting", revision: 1 } };
  const { e, advance } = await ui(null, ({ path }) => {
    if (offline && path === "/api/state") throw new TypeError("Failed to fetch");
    if (["/api/state", "/api/reception"].includes(path)) return { status: 200, body: waiting };
  });
  assert.equal(e["start-stage"].hidden, false);
  assert.equal(e.trial.hidden, true);
  offline = true; await advance(10000);
  assert.equal(e.notice.textContent, "", "a short interruption stays invisible");
  await advance(60000);
  assert.equal(e.notice.textContent, STOPPED);
  offline = false; await advance(6000);
  assert.equal(e.notice.textContent, "", "a successful read clears it");
});

test("i161: 状態を確認 resumes nothing when the fresh state read fails", async () => {
  let offline = false;
  const stopped = trial(); stopped.aiStatus = "error";
  const { e, calls } = await ui(stopped, ({ path }) => { if (offline && path === "/api/state") throw new TypeError("Failed to fetch"); });
  offline = true; e["retry-chat"].fire("click"); await tick();
  assert.equal(calls.filter((call) => call.path === "/api/retry").length, 0, "a cached error state is not enough");
  offline = false; e["retry-chat"].fire("click"); await tick();
  assert.equal(calls.filter((call) => call.path === "/api/retry").length, 1);
});

