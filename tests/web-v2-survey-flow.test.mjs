// Questionnaire step, review navigation after submission, draft restore and
// earlier-trial access in the v2 web UI. The questionnaire form used here is a
// synthetic stand-in for the server's PROVISIONAL trial items (試行用・研究者未承認).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const web = new URL("../dialogue-model/runtime/web/", import.meta.url);
const [script, html] = await Promise.all(["app.js", "index.html"].map((name) => readFile(new URL(name, web), "utf8")));
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {};
    this.value = ""; this._text = ""; this.disabled = false; this.open = false; this.checked = false;
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
  focus() { if (this.disabled) return; this.focused = true; }
  showModal() { this.open = true; }
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
    if (rest.match(/(^|\s)hidden(\s|$|>)/u)) node.hidden = true;
    if (node.getAttribute("id")) ids[node.getAttribute("id")] = node;
    stack.at(-1).append(node);
    if (!["input", "meta", "link", "br"].includes(tag)) stack.push(node);
  }
  return { root, ids };
}
const FORM = { version: "provisional-v0", provisional: true, notice: "試行用の仮の質問です（研究者未承認）。",
  items: ["q_one", "q_two"].map((id, i) => ({ id, text: `質問${i + 1}`, type: "likert", min: 1, max: 7, minLabel: "低", maxLabel: "高", required: true })),
  comment: { maxLength: 2000 } };
function trial(id = "rec-active", extra = {}) {
  return { version: 2, sessionId: id, submitted: false, aiStatus: "idle", status: "dialogue", events: [{ id: "e1", speaker: "ai", text: "公開された相談" }], scene: {
    width: 1200, height: 800, shapes: ["s-a", "s-b"].map((id, i) => ({ id, path: `M ${100 + i * 140} 100 l 60 80 l -40 90 Z`, centroid: { x: 140 + i * 140, y: 200 } })),
  }, ...extra };
}
const resultFor = (state) => ({ figures: state.scene.shapes.map((shape) => ({ human: { slot: shape.id, rawName: "名前" }, ai: { rawName: "名前" }, matched: true })) });
function completed(id = "rec-active") {
  const value = trial(id, { submitted: true, aiSubmitted: true, status: "completed", humanSubmission: { "s-a": "名前", "s-b": null } });
  value.result = resultFor(value); return value;
}
const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
// A local mock of the participant API (no network, no real participant data).
async function ui({ initial = trial(), storage = new Map(), local = new Map(), server = {} } = {}) {
  const { ids: e } = makeDOM();
  const backend = { state: { trial: initial }, questionnaires: new Map(), records: [], reviews: new Map(), noSurvey: false, failDraft: false, ...server };
  let timerId = 0;
  const timers = new Map(), calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  // Server-side lock (resultLocked): a completed trial's result is withheld
  // until its questionnaire is submitted. legacy=true models an older server.
  const locked = (id, completedTrial) => !backend.legacy && completedTrial && backend.questionnaires.get(id)?.status !== "submitted";
  const stateView = () => {
    const value = structuredClone(backend.state);
    if (value.trial && locked(value.trial.sessionId, value.trial.status === "completed")) { delete value.trial.result; value.trial.resultLocked = true; }
    return value;
  };
  const context = {
    document: { getElementById: (id) => e[id], createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    localStorage: { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: (key) => local.delete(key),
      get length() { return local.size; }, key: (i) => [...local.keys()][i] ?? null },
    FormData: class { constructor() { this.values = []; } get() { return null; } },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body, method: options?.method ?? "GET" });
      if (path === "/api/state") return reply(200, stateView());
      if (path === "/api/names") { backend.state.trial.submitted = true; return reply(200, stateView()); }
      if (path === "/api/records") return backend.noSurvey ? reply(404, { error: "not_found" }) : reply(200, { records: backend.records });
      const match = path.match(/^\/api\/records\/([^/]+)\/(questionnaire|review)$/u);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (backend.noSurvey) return reply(404, { error: "not_found" });
        if (match[2] === "review") {
          if (!backend.reviews.has(id)) return reply(404, { error: "not_found" });
          const review = structuredClone(backend.reviews.get(id));
          if (locked(id, true)) { delete review.result; review.resultLocked = true; }
          return reply(200, review);
        }
        const stored = backend.questionnaires.get(id) ?? null;
        if (!body) return reply(200, { recordId: id, form: FORM, questionnaire: stored });
        if (stored?.status === "submitted") return reply(409, { error: "questionnaire_submitted" });
        if (!body.submit && backend.failDraft) return reply(503, { error: "unavailable" });
        if (body.submit && Object.values(body.answers).some((value) => value === null)) return reply(400, { error: "invalid_questionnaire" });
        const next = { status: body.submit ? "submitted" : "draft", answers: body.answers, comment: body.comment, submittedAt: body.submit ? "2026-10-19T00:00:00Z" : null };
        backend.questionnaires.set(id, next);
        return reply(200, { recordId: id, form: FORM, questionnaire: next });
      }
      return reply(404, { error: "not_found" });
    },
  };
  runInNewContext(script, context);
  await tick();
  const run = async (filter = () => true) => {
    const due = [...timers.entries()].filter(([, timer]) => filter(timer));
    for (const [id] of due) timers.delete(id);
    for (const [, timer] of due) timer.callback();
    await tick();
  };
  return { e, context, calls, backend, storage, local, timers,
    poll: () => run((timer) => timer.delay >= 700 && timer.delay <= 2000),
    // Draft saves use 0 ms (resend after reload) or the 2000 ms debounce.
    flushSave: () => run((timer) => timer.delay === 0 || timer.delay === 2000),
    run };
}
const radios = (e, index) => e["questionnaire-items"].children[index].querySelectorAll("input");
const choose = (e, index, value) => { const input = radios(e, index)[value - 1]; input.checked = true; input.fire("change"); };
const visibleStage = (e) => ["conversation-stage", "name-stage", "questionnaire-stage", "results"].filter((id) => !e[id].hidden);

test("pure stage rules: editable chat/names before submission, review stages after, default order", async () => {
  const { context: c } = await ui();
  const base = { localStage: "chat", reviewStage: null };
  assert.equal(c.resolveStage({ ...base, submitted: false, completed: false, survey: "pending" }), "chat");
  assert.equal(c.resolveStage({ ...base, localStage: "names", submitted: false, completed: false, survey: "pending" }), "names");
  assert.equal(c.resolveStage({ ...base, reviewStage: "results", submitted: false, completed: false, survey: "pending" }), "chat", "review stages need a submission");
  assert.equal(c.resolveStage({ ...base, submitted: true, completed: false, survey: "pending" }), "names", "waits on names for the AI");
  assert.equal(c.resolveStage({ ...base, submitted: true, completed: true, survey: "open" }), "questionnaire");
  assert.equal(c.resolveStage({ ...base, submitted: true, completed: true, survey: "loading" }), "questionnaire");
  assert.equal(c.resolveStage({ ...base, submitted: true, completed: true, survey: "submitted" }), "results");
  assert.equal(c.resolveStage({ ...base, submitted: true, completed: true, survey: "unavailable" }), "results");
  assert.equal(c.resolveStage({ ...base, reviewStage: "chat", submitted: true, completed: true, survey: "open" }), "chat");
  assert.equal(c.resolveStage({ ...base, reviewStage: "questionnaire", submitted: true, completed: false, survey: "pending" }), "names", "no questionnaire before completion");
  assert.deepEqual([...c.allowedStages({ submitted: true, completed: true, survey: "unavailable" })], ["chat", "names", "results"]);
  assert.deepEqual([...c.allowedStages({ submitted: true, completed: true, survey: "open" })], ["chat", "names", "questionnaire"], "results locked before submit");
  assert.deepEqual([...c.allowedStages({ submitted: true, completed: true, survey: "submitted" })], ["chat", "names", "questionnaire", "results"]);
  assert.equal(c.resolveStage({ ...base, reviewStage: "results", submitted: true, completed: true, survey: "open" }), "questionnaire", "a draft never unlocks results");
  assert.deepEqual([...c.allowedStages({ submitted: false, completed: false, survey: "pending" })], ["chat", "names"]);
  const local = { answers: { q_one: 3 }, synced: false }, server = { status: "draft", answers: { q_one: 5 } };
  assert.equal(c.pickSurveyDraft(local, server), local, "unsynced browser edits are newest");
  assert.equal(c.pickSurveyDraft({ ...local, synced: true }, server), server);
  assert.equal(c.pickSurveyDraft(local, { status: "submitted", answers: {} }).status, "submitted", "a submission is final");
  assert.equal(c.pickSurveyDraft(null, null), null);
  assert.deepEqual([...c.missingSurveyItems(c.normalizeSurveyForm(FORM), { q_one: 2 })], ["q_two"]);
  assert.equal(c.normalizeSurveyForm({ items: [] }), null);
  assert.equal(c.normalizeSurveyForm({ items: [{ id: "x", text: "t", min: 1, max: 99 }] }), null);
});

test("names -> questionnaire -> results with read-only review and a draft that survives every switch", async () => {
  const app = await ui();
  const { e, backend, calls, local } = app;
  e["finish-conversation"].fire("click");
  for (const path of e.board.querySelectorAll("path")) { path.fire("click"); e["name-unknown"].fire("click"); }
  e.submission.fire("submit"); e["confirm-submit"].fire("click"); await tick();
  assert.deepEqual(visibleStage(e), ["name-stage"], "waits for the AI on the names stage");
  assert.equal(e["review-bar"].hidden, false);
  assert.equal(e["stage-nav"].querySelectorAll("button").find((b) => b.getAttribute("data-stage") === "questionnaire").disabled, true);
  assert.equal(calls.some((call) => call.path.includes("/questionnaire")), false, "no questionnaire call before completion");
  Object.assign(backend.state.trial, { aiSubmitted: true, status: "completed" });
  backend.state.trial.result = resultFor(backend.state.trial);
  await app.poll();
  assert.deepEqual(visibleStage(e), ["questionnaire-stage"]);
  assert.equal(e["questionnaire-title"].focused, true);
  assert.doesNotMatch(e.board.textContent, /AI：/u, "AI names and matches stay hidden until the results stage");
  assert.equal(app.calls.filter((call) => call.path === "/api/state").length > 0, true);
  assert.equal(e["questionnaire-lock"].hidden, false);
  assert.equal(e["questionnaire-to-results"].hidden, true);
  assert.match(html, /class="provisional-badge">試行用・研究者未承認</u, "fixed provisional badge in the questionnaire header");
  assert.match(e["questionnaire-notice"].textContent, /研究者未承認/u);
  assert.equal(e["step-questionnaire"].getAttribute("aria-current"), "step");
  choose(e, 0, 4);
  assert.equal(JSON.parse(local.get("joint-naming-survey:rec-active")).synced, false, "every change is kept in this browser at once");
  e["questionnaire-comment"].value = "自由記述の下書き"; e["questionnaire-comment"].fire("input");
  // Review the conversation and the names (read-only), then come back.
  e["stage-nav"].querySelectorAll("button").find((b) => b.getAttribute("data-stage") === "chat").fire("click");
  assert.deepEqual(visibleStage(e), ["conversation-stage"]);
  assert.equal(e.chat.hidden, true, "no composer after submission");
  assert.equal(e["finish-conversation"].hidden, true);
  assert.equal(e.history.focused, true);
  assert.match(e.history.textContent, /公開された相談/u);
  assert.match(e["review-notice"].textContent, /名前と会話はもう変更できません/u);
  assert.match(e["review-notice"].textContent, /アンケートは提出するまで回答・変更できます/u);
  assert.equal(e["survey-prompt"].hidden, false, "unanswered questionnaire is prompted on other stages");
  assert.match(e["open-survey"].textContent, /再開/u);
  const draft = calls.filter((call) => call.path === "/api/records/rec-active/questionnaire" && call.body);
  assert.equal(draft.length, 1, "leaving the questionnaire flushes the pending draft");
  assert.deepEqual(draft[0].body, { answers: { q_one: 4, q_two: null }, comment: "自由記述の下書き", submit: false });
  e["stage-nav"].querySelectorAll("button").find((b) => b.getAttribute("data-stage") === "names").fire("click");
  assert.deepEqual(visibleStage(e), ["name-stage"]);
  assert.match(e["names-title-text"].textContent, /提出した名前/u);
  // The locked 結果 tab leads to the questionnaire with an explanation.
  const resultsTab = e["stage-nav"].querySelectorAll("button").find((b) => b.getAttribute("data-stage") === "results");
  assert.equal(resultsTab.disabled, false);
  assert.match(resultsTab.getAttribute("aria-label"), /アンケートの提出後/u);
  resultsTab.fire("click");
  assert.deepEqual(visibleStage(e), ["questionnaire-stage"]);
  assert.match(e["questionnaire-status"].textContent, /アンケートの提出後に結果を表示します/u);
  assert.equal(e["result-list"].children.length, 0, "no result rows in the page while locked");
  await app.flushSave();
  assert.equal(backend.questionnaires.get("rec-active").status, "draft");
  resultsTab.fire("click");
  assert.deepEqual(visibleStage(e), ["questionnaire-stage"], "a saved draft does not unlock results");
  assert.equal(radios(e, 0)[3].checked, true, "answer still selected after navigating");
  assert.equal(e["questionnaire-comment"].value, "自由記述の下書き");
  // Missing answers block the submission without a dialog or a request.
  const before = calls.length;
  e["questionnaire-form"].fire("submit"); await tick();
  assert.equal(calls.length, before);
  assert.match(e["questionnaire-status"].textContent, /未回答の質問が1問/u);
  assert.equal(radios(e, 1)[0].focused, true);
  choose(e, 1, 6);
  e["questionnaire-form"].fire("submit"); await tick(); await tick();
  const submit = calls.filter((call) => call.body?.submit === true);
  assert.equal(submit.length, 1);
  assert.deepEqual(submit[0].body.answers, { q_one: 4, q_two: 6 });
  assert.deepEqual(visibleStage(e), ["results"]);
  assert.equal(e["results-title"].focused, true);
  assert.match(e.board.textContent, /AI：名前 · 一致/u, "the result arrives by refetch after submit");
  assert.equal(e["result-list"].children.length, 2);
  assert.equal(local.has("joint-naming-survey:rec-active"), false, "browser copy removed after submission");
  assert.equal(e["survey-prompt"].hidden, true);
  assert.match(e["review-notice"].textContent, /アンケートも提出済み/u);
  e["stage-nav"].querySelectorAll("button").find((b) => b.getAttribute("data-stage") === "questionnaire").fire("click");
  assert.equal(radios(e, 0).every((input) => input.disabled), true, "submitted answers are read-only");
  assert.equal(e["questionnaire-submit"].hidden, true);
  assert.equal(e["step-questionnaire"].getAttribute("data-state"), "active");
});

test("reload restores the unsynced browser draft over the server draft and resends it", async () => {
  const local = new Map([["joint-naming-survey:rec-active", JSON.stringify({ answers: { q_one: 2, bogus: 9 }, comment: "未送信", synced: false })]]);
  const app = await ui({ initial: completed(), local, server: { questionnaires: new Map([["rec-active", { status: "draft", answers: { q_one: 7, q_two: null }, comment: "古い" }]]) } });
  const { e, calls } = app;
  assert.deepEqual(visibleStage(e), ["questionnaire-stage"], "completed trial without a submitted questionnaire opens it");
  assert.equal(radios(e, 0)[1].checked, true);
  assert.equal(e["questionnaire-comment"].value, "未送信");
  await app.flushSave();
  const sent = calls.filter((call) => call.body && call.path.endsWith("/questionnaire"));
  assert.deepEqual(sent.at(-1).body, { answers: { q_one: 2, q_two: null }, comment: "未送信", submit: false }, "unknown ids dropped");
  assert.equal(local.has("joint-naming-survey:rec-active"), false, "the browser copy is dropped once the server has it");
});

// Issue #161: the participant hears that the answers are kept, not why saving failed.
test("server draft failures keep the answers in the browser and say so without the cause", async () => {
  const app = await ui({ initial: completed(), server: { failDraft: true } });
  const { e, local } = app;
  choose(e, 0, 5);
  await app.flushSave();
  assert.equal(e["questionnaire-status"].textContent, "入力した回答はこの画面に残っています。");
  assert.equal(JSON.parse(local.get("joint-naming-survey:rec-active")).answers.q_one, 5);
  assert.equal(radios(e, 0)[4].checked, true);
});

test("an older server without the questionnaire API falls back to results and the planned label", async () => {
  const app = await ui({ initial: completed(), server: { noSurvey: true, legacy: true } });
  assert.deepEqual(visibleStage(app.e), ["results"]);
  assert.equal(app.e["step-questionnaire"].getAttribute("data-state"), "planned");
  assert.equal(app.e["survey-prompt"].hidden, true);
  assert.equal(app.e["record-history"].hidden, true);
});

test("earlier completed trials are reachable while a newer trial is in dialogue; polling pauses during review", async () => {
  const earlier = completed("rec-earlier");
  const reviews = new Map([["rec-earlier", { recordId: "rec-earlier", status: "completed", scene: earlier.scene, events: [{ id: "x1", speaker: "ai", text: "以前の会話" }],
    humanSubmission: earlier.humanSubmission, result: earlier.result }]]);
  const records = [{ recordId: "rec-active", status: "dialogue", active: true, questionnaire: "none", startedAt: "2026-10-19T03:00:00Z" },
    { recordId: "rec-earlier", status: "completed", active: false, questionnaire: "none", startedAt: "2026-10-18T03:00:00Z" }];
  const storage = new Map([["joint-naming-v2-draft", JSON.stringify({ trial: "rec-active", stage: "chat", answers: [["s-a", "下書きの名前"]] })]]);
  const local = new Map([["joint-naming-survey:rec-gone", JSON.stringify({ answers: { q_one: 1 }, comment: "期限切れ", synced: false })],
    ["joint-naming-survey:rec-earlier", JSON.stringify({ answers: { q_one: 6 }, comment: "", synced: false })]]);
  const app = await ui({ storage, local, server: { records, reviews } });
  const { e, calls } = app;
  assert.equal(e["record-history"].hidden, false);
  assert.match(e["record-summary"].textContent, /アンケート未回答 1件/u);
  assert.equal(local.has("joint-naming-survey:rec-gone"), false, "copies of records no longer listed are removed");
  assert.equal(local.has("joint-naming-survey:rec-earlier"), true);
  const buttons = e["record-list"].children[0].querySelectorAll("button");
  assert.deepEqual(buttons.map((b) => b.textContent), ["会話を見る", "アンケートに回答"]);
  e.utterance.value = "書きかけのメッセージ";
  buttons[1].fire("click"); await tick();
  assert.deepEqual(visibleStage(e), ["questionnaire-stage"]);
  assert.equal(e["exit-review"].hidden, false);
  assert.match(e["review-notice"].textContent, /以前の試行を表示しています/u);
  assert.equal(e["record-history"].hidden, true);
  e["stage-nav"].querySelectorAll("button").find((b) => b.getAttribute("data-stage") === "chat").fire("click");
  assert.match(e.history.textContent, /以前の会話/u);
  assert.equal(e.chat.hidden, true);
  const stateCalls = calls.filter((call) => call.path === "/api/state").length;
  await app.poll(); await app.poll();
  assert.equal(calls.filter((call) => call.path === "/api/state").length, stateCalls, "the active trial never replaces the review");
  assert.equal(storage.has("joint-naming-v2-draft"), true, "the active trial's name memo is untouched");
  // The earlier record follows the same lock: results only after its submit.
  assert.doesNotMatch(e.board.textContent, /AI：/u);
  e["stage-nav"].querySelectorAll("button").find((b) => b.getAttribute("data-stage") === "results").fire("click");
  assert.deepEqual(visibleStage(e), ["questionnaire-stage"]);
  assert.equal(radios(e, 0)[5].checked, true, "the unsynced browser copy is restored for the earlier record");
  choose(e, 1, 2);
  e["questionnaire-form"].fire("submit"); await tick(); await tick();
  assert.deepEqual(calls.filter((call) => call.body?.submit === true).map((call) => call.path), ["/api/records/rec-earlier/questionnaire"]);
  assert.deepEqual(visibleStage(e), ["results"]);
  assert.match(e.board.textContent, /AI：名前 · 一致/u);
  assert.equal(calls.some((call) => ["/api/names", "/api/message", "/api/retry", "/api/ai-submit"].includes(call.path)), false, "nothing from the review reaches active-trial routes");
  e["exit-review"].fire("click"); await tick();
  assert.deepEqual(visibleStage(e), ["conversation-stage"]);
  assert.equal(e.utterance.value, "書きかけのメッセージ", "unsent composer text returns");
  assert.match(e.board.textContent, /下書きの名前/u);
  assert.equal(e.chat.hidden, false);
});

test("an open questionnaire has no participant next/start control or admission request", async () => {
  const app = await ui({ initial: completed() });
  const { e, calls } = app;
  assert.equal(e["new-trial"], undefined);
  assert.equal(e["new-trial-warning"], undefined);
  assert.equal(e.setup, undefined);
  await app.poll();
  assert.equal(calls.some(call => call.path === "/api/start" || call.path.includes("prepare-next")), false);
  assert.equal(app.backend.state.trial.sessionId, "rec-active");
  assert.doesNotMatch(script, /window\.(confirm|alert)|\balert\(|\bconfirm\(/u);
});

test("i161: questionnaire load and submit failures show no transport or server detail and keep the answers", async () => {
  const app = await ui({ initial: completed() });
  const { e, context } = app;
  choose(e, 0, 5); choose(e, 1, 3);
  const realFetch = context.fetch;
  context.fetch = async (path, options) => {
    if (path.endsWith("/questionnaire") && options?.body && JSON.parse(options.body).submit) throw new TypeError("Failed to fetch");
    return realFetch(path, options);
  };
  e["questionnaire-form"].fire("submit"); await tick();
  assert.equal(e["questionnaire-status"].textContent, "進行を確認できません。実験担当者にお知らせください。 入力した回答はこの画面に残っています。");
  assert.equal(radios(e, 0)[4].checked, true);
  context.fetch = async (path, options) => path.endsWith("/questionnaire") && !options?.body ? { ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } } : realFetch(path, options);
  context.loadSurvey(true); await tick();
  assert.equal(e["questionnaire-loading"].textContent, "アンケートを表示できませんでした。上の「アンケート」をもう一度選んでください。");
  assert.doesNotMatch(e["questionnaire-status"].textContent + e["questionnaire-loading"].textContent + e.notice.textContent, /通信|サーバー|再試行|Failed|Unexpected|エラー/u);
});

