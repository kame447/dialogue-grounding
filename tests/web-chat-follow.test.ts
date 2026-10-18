// v2 participant chat behaves like an ordinary chat app (E1, 2026-10-19):
// bottom-anchored log, own send jumps, scrolled-up readers get a pill instead of
// a jump, dots live in the composer, and the composer survives keyboards.
// DOM-only fixture with a clamped scroll model; synthetic stimuli; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const web = new URL("../dialogue-model/runtime/web/", import.meta.url);
const [script, html, css] = await Promise.all(["app.js", "index.html", "style.css"].map((name) => readFile(new URL(name, web), "utf8")));

type Handler = (event: FakeEvent) => void;
type FakeEvent = { target: Element; prevented: boolean; preventDefault(): void; [key: string]: unknown };
const MESSAGE_PX = 100;
class Element {
  tagName: string; children: Element[] = []; handlers: Record<string, Handler[]> = {}; attributes: Record<string, string> = {};
  value = ""; _text = ""; disabled = false; open = false; hidden = false; focused = false;
  clientHeight = 400; scrollLog: number[] = []; #scrollTop = 0;
  style = { values: {} as Record<string, string>, setProperty(name: string, value: string) { this.values[name] = value; } };
  constructor(tag: string) { this.tagName = tag; }
  // Browsers clamp scroll offsets; scrollTo/scrollTop past the end lands at the end.
  get scrollHeight() { return this.children.length * MESSAGE_PX; }
  get scrollTop() { return this.#scrollTop; }
  set scrollTop(value: number) { this.#scrollTop = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight))); this.scrollLog.push(this.#scrollTop); }
  get atBottom() { return this.scrollTop === Math.max(0, this.scrollHeight - this.clientHeight); }
  set textContent(value: string) { this._text = String(value); this.children = []; }
  get textContent(): string { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this._text = ""; this.children = [...children]; this.scrollTop = 0; }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); if (name === "hidden") this.hidden = true; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  get elements() { return Object.fromEntries(this.querySelectorAll("input,select,textarea").map((node) => [node.getAttribute("name"), node])); }
  querySelectorAll(selector: string): Element[] {
    const matches = (child: Element) => selector.split(",").some((part) => {
      const match = part.match(/^([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/u);
      return Boolean(match) && child.tagName === match![1] && (!match![2] || child.getAttribute(match![2]) === match![3]);
    });
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  addEventListener(type: string, handler: Handler) { (this.handlers[type] ??= []).push(handler); }
  fire(type: string, fields: Record<string, unknown> = {}) {
    const event: FakeEvent = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...fields };
    for (const handler of this.handlers[type] ?? []) handler(event);
    return event;
  }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollTo({ top }: { top: number }) { this.scrollTop = top; }
  getBBox() { return { x: 100, y: 150, width: 130, height: 180 }; }
}
function makeDOM() {
  const root = new Element("document"), stack = [root], ids: Record<string, Element> = {};
  for (const token of html.matchAll(/<\/?([\w-]+)\b([^>]*?)>/gu)) {
    const [, tag, rest] = token;
    if (token[0].startsWith("</")) { if (stack.at(-1)?.tagName === tag) stack.pop(); continue; }
    const node = new Element(tag);
    for (const [, name, quoted, unquoted] of rest.matchAll(/([\w-]+)(?:="([^"]*)"|=([^\s]+))?/gu)) node.setAttribute(name, quoted ?? unquoted ?? "");
    node.value = node.getAttribute("value") ?? "";
    const id = node.getAttribute("id");
    if (id) ids[id] = node;
    stack.at(-1)!.append(node);
    if (!["input", "meta", "link", "br"].includes(tag)) stack.push(node);
  }
  return { root, ids };
}
type ChatEvent = { id: string; speaker: string; text: string; clientId?: string };
type Trial = { version: number; sessionId: string; submitted: boolean; aiStatus: string; events: ChatEvent[]; scene: unknown };
function trial(count = 1): Trial {
  const events = Array.from({ length: count }, (_, i) => ({ id: "event-" + (i + 1), speaker: i % 2 ? "human" : "ai", text: "公開の発話" + i }));
  return { version: 2, sessionId: "trial-private", submitted: false, aiStatus: "idle", events, scene: {
    width: 1200, height: 800, shapes: ["s-a", "s-b", "s-c", "s-d", "s-e", "s-f"].map((id, i) => ({ id, path: `M ${100 + i * 140} 100 l 60 80 l -40 90 Z`, centroid: { x: 140 + i * 140, y: 200 } })),
  } };
}
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
type Options = { visualViewport?: Element & { height: number } };
async function ui(initial: Trial, options: Options = {}) {
  const { ids: e } = makeDOM();
  let timerId = 0, now = 10000, clientSequence = 0;
  const state = { trial: initial };
  const timers = new Map<number, { callback: () => void; delay: number; at: number }>();
  const observers: (() => void)[] = [];
  const documentElement = new Element("html");
  runInNewContext(script, {
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => "client-" + ++clientSequence },
    document: { documentElement, getElementById: (id: string) => e[id], createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag) },
    visualViewport: options.visualViewport,
    ResizeObserver: class { callback: () => void; constructor(callback: () => void) { this.callback = callback; observers.push(callback); } observe() {} },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay, at: now + delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, request?: { body?: string }) => {
      const body = request?.body ? JSON.parse(request.body) : undefined;
      let value: unknown = state;
      if (path === "/api/message") {
        const eventId = "event-" + (state.trial.events.length + 1);
        state.trial.events.push({ id: eventId, speaker: "human", text: body.text, clientId: body.clientId });
        state.trial.aiStatus = "thinking"; value = { eventId, ...state };
      }
      return { ok: true, status: path === "/api/message" ? 202 : 200, json: async () => structuredClone(value) };
    },
  });
  await tick();
  const poll = async () => {
    const timer = [...timers].filter(([, entry]) => entry.delay === 700 || entry.delay === 2000).sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(timer, "a state refresh is scheduled");
    timers.delete(timer[0]); now = timer[1].at; timer[1].callback(); await tick();
  };
  const arrive = async (text: string) => {
    state.trial.events.push({ id: "ai-" + state.trial.events.length, speaker: "ai", text });
    state.trial.aiStatus = "idle"; await poll();
  };
  const scrollUp = (top = 0) => { e.history.scrollTop = top; e.history.fire("scroll"); };
  const resize = () => observers.forEach((callback) => callback());
  return { e, state, poll, arrive, scrollUp, resize, documentElement };
}
const send = (e: Record<string, Element>, text: string) => { e.utterance.value = text; e.chat.fire("submit"); };
const ancestorsOf = (target: string) => {
  const { root } = makeDOM(), path: string[] = [];
  const visit = (node: Element, trail: string[]): boolean => {
    if (node.getAttribute("id") === target) { path.push(...trail); return true; }
    return node.children.some((child) => visit(child, [...trail, node.getAttribute("id") ?? node.getAttribute("class") ?? node.tagName]));
  };
  visit(root, []); return path;
};

test("load and reload start at the bottom of a long log", async () => {
  for (let reload = 0; reload < 2; reload++) {
    const { e } = await ui(trial(40));
    assert.equal(e.history.children.length, 40);
    assert.ok(e.history.atBottom, "the newest message is visible on load");
    assert.equal(e["new-messages"].hidden, true);
  }
});

test("following reader: every new message (AI, own, scripted opening) keeps the bottom and pushes history up", async () => {
  const { e, arrive } = await ui(trial(10));
  await arrive("AIの新着");
  assert.ok(e.history.atBottom); assert.equal(e["new-messages"].hidden, true);
  send(e, "自分の発話");
  assert.ok(e.history.atBottom, "the optimistic bubble is at the bottom before acknowledgement");
  await tick(); assert.ok(e.history.atBottom);
  const empty = trial(0);
  const opening = await ui(empty);
  await opening.arrive("冒頭の発話");
  assert.equal(opening.e.history.children.length, 1);
  assert.ok(opening.e.history.atBottom);
});

test("own send and rapid sends always jump to the bottom, even from scrolled-up history", async () => {
  const { e, scrollUp } = await ui(trial(30));
  scrollUp(200);
  assert.equal(e.history.scrollTop, 200);
  for (const text of ["一つ目", "二つ目", "三つ目"]) { send(e, text); assert.ok(e.history.atBottom, text + " is visible after sending"); }
  await tick();
  assert.ok(e.history.atBottom);
  assert.equal(e.history.children.length, 33, "rapid sends are kept once each and in order");
  assert.equal(e["new-messages"].hidden, true);
});

test("scrolled-up reader is never moved by arrivals; a pill appears, tapping it resumes following", async () => {
  const { e, arrive, scrollUp } = await ui(trial(30));
  scrollUp(500);
  await arrive("読んでいる間の新着");
  assert.equal(e.history.scrollTop, 500, "no forced jump");
  assert.equal(e["new-messages"].hidden, false);
  assert.match(html, /<button id="new-messages" type="button" class="new-messages" hidden><span aria-hidden="true">↓<\/span> 新しいメッセージ<\/button>/u);
  assert.equal(e["new-messages"].getAttribute("type"), "button");
  await arrive("さらに新着");
  assert.equal(e.history.scrollTop, 500);
  e["new-messages"].fire("click");
  assert.ok(e.history.atBottom); assert.equal(e["new-messages"].hidden, true);
  assert.equal(e.history.focused, true, "focus moves to the log, not the hidden pill or the keyboard");
  await arrive("追従再開後の新着");
  assert.ok(e.history.atBottom, "following resumed");
});

test("returning to the bottom by scrolling resumes following and hides the pill", async () => {
  const { e, arrive, scrollUp } = await ui(trial(30));
  scrollUp(100); await arrive("新着");
  assert.equal(e["new-messages"].hidden, false);
  scrollUp(e.history.scrollHeight);
  assert.equal(e["new-messages"].hidden, true);
  await arrive("次の新着");
  assert.ok(e.history.atBottom);
  scrollUp(e.history.scrollHeight - e.history.clientHeight - 30);
  await arrive("ほぼ末尾で届いた新着");
  assert.ok(e.history.atBottom, "a few pixels short of the end still counts as following");
});

test("a scrolled-up reader with no new arrivals sees no pill; acknowledgement of their own message is not 'new'", async () => {
  const { e, poll, scrollUp } = await ui(trial(30));
  send(e, "送った発話");
  scrollUp(0);
  await tick(); await poll();
  assert.equal(e.history.scrollTop, 0);
  assert.equal(e["new-messages"].hidden, true, "reconciling a pending bubble into the public log is not a new message");
});

test("typing dots live in the composer's speaking space, not in the log; status, reduced motion and stop rules hold", async () => {
  assert.deepEqual(ancestorsOf("typing-indicator").slice(-2), ["chat", "composer-status"], "dots are inside the composer bar");
  assert.ok(!ancestorsOf("typing-indicator").includes("history") && !ancestorsOf("typing-indicator").includes("transcript"));
  assert.ok(ancestorsOf("chat-recovery").includes("chat"), "error/stall recovery replaces the dots in the same space");
  const { e, state, poll, arrive } = await ui(trial(5));
  assert.equal(e["typing-indicator"].hidden, true);
  send(e, "質問");
  assert.equal(e["typing-indicator"].hidden, false);
  assert.ok(e.history.children.every((node) => !node.attributes.class?.includes("typing")), "no dots bubble in the log");
  assert.equal(e["chat-status"].textContent, "AIが返答を作成しています");
  await tick(); assert.equal(e["typing-indicator"].hidden, false);
  state.trial.aiStatus = "error"; await poll();
  assert.equal(e["typing-indicator"].hidden, true, "dots stop on error");
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["retry-chat"].disabled, false, "the composer-area retry is not disabled by composer locking");
  await arrive("返答");
  assert.equal(e["typing-indicator"].hidden, true);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.typing-indicator span\{animation:none\}/u);
  assert.match(css, /\.composer-status\{[^}]*min-height:20px/u, "the speaking space is reserved, so dots never shift the log");
});

test("composer stays at the bottom: transcript flexes, composer never shrinks; phone layout fits the visual viewport", async () => {
  assert.match(css, /#chat\{flex-shrink:0/u);
  assert.match(css, /#history\{[^}]*flex:1;min-height:0;overflow-y:auto/u);
  assert.doesNotMatch(css.match(/#history\{[^}]*\}/u)![0], /scroll-behavior:smooth/u, "jumps are instant; a smooth jump would unfollow mid-animation");
  assert.match(html, /interactive-widget=resizes-content/u, "Android keyboards shrink the layout, so dvh shrinks the log");
  assert.match(css, /main:has\(#trial:not\(\[hidden\]\) #conversation-stage:not\(\[hidden\]\)\)\{max-height:var\(--viewport-height,100dvh\)\}/u);
  assert.match(css, /@media\(max-width:760px\) and \(max-height:300px\)\{\nmain:has\(#trial:not\(\[hidden\]\) #conversation-stage:not\(\[hidden\]\)\) \.topbar\{display:none\}\n\}/u,
    "a landscape phone with the keyboard up drops only the step bar");
  const viewport = Object.assign(new Element("viewport"), { height: 844 });
  const { e, documentElement, arrive } = await ui(trial(30), { visualViewport: viewport });
  assert.equal(documentElement.style.values["--viewport-height"], "844px");
  await arrive("キーボード前");
  viewport.height = 512.4; e.history.clientHeight = 150; viewport.fire("resize");
  assert.equal(documentElement.style.values["--viewport-height"], "512px");
  assert.ok(e.history.atBottom, "opening the keyboard keeps a following reader at the bottom");
  Object.assign(viewport, { scale: 2, height: 300 }); viewport.fire("resize");
  assert.equal(documentElement.style.values["--viewport-height"], "512px", "pinch zoom does not shrink the layout");
  Object.assign(viewport, { scale: 1, height: 844 }); viewport.fire("resize");
  assert.equal(documentElement.style.values["--viewport-height"], "844px");
});

test("the composer-side recovery button keeps its own disabled rule while an operation runs", async () => {
  const state = trial(5); state.aiStatus = "error";
  const { e } = await ui(state);
  assert.equal(e["chat-recovery"].hidden, false);
  assert.equal(e["retry-chat"].disabled, false);
  e["retry-chat"].fire("click");
  assert.equal(e["retry-chat"].disabled, true, "disabled while the retry operation is working");
  await tick();
  e["finish-conversation"].fire("click");
  assert.equal(e["retry-chat"].disabled, true, "disabled when the chat stage is not open");
});

test("a shrinking log keeps followers at the bottom but never moves a scrolled-up reader", async () => {
  const { e, resize, scrollUp } = await ui(trial(30));
  e.history.clientHeight = 200; resize();
  assert.ok(e.history.atBottom);
  scrollUp(300); e.history.clientHeight = 120; resize();
  assert.equal(e.history.scrollTop, 300);
});

test("Enter stays a newline (IME safe) and names stage round trip returns to the bottom", async () => {
  const { e, arrive, scrollUp } = await ui(trial(30));
  e.utterance.value = "一行目";
  for (const fields of [{}, { isComposing: true }, { keyCode: 229 }]) assert.equal(e.utterance.fire("keydown", { key: "Enter", ...fields }).prevented, false);
  scrollUp(0);
  e["finish-conversation"].fire("click");
  assert.equal(e["conversation-stage"].hidden, true);
  assert.equal(e["new-messages"].hidden, true);
  await arrive("名前段階中の新着");
  e["back-to-chat"].fire("click");
  assert.equal(e["conversation-stage"].hidden, false);
  assert.ok(e.history.atBottom, "coming back shows the newest message");
  assert.equal(e["new-messages"].hidden, true);
});
