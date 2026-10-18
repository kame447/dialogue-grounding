// Participant-side records: read-only review, the PROVISIONAL questionnaire
// (研究者未承認の仮項目), per-record archive storage and the admin view of answers.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { startNamingServer } from "../dialogue-model/runtime/web/server.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { applyQuestionnaire, participantReview, QUESTIONNAIRE_FORM, questionnaireStatus } from "../dialogue-model/runtime/v2/participant-records.ts";
import { archiveSnapshot, backfillActive, deleteArchived, expireRecords, readArchived, readQuestionnaire,
  writeQuestionnaire } from "../workers/tangram-experiment/src/admin/archive.ts";
import { summarizeRecord } from "../workers/tangram-experiment/src/admin/summary.ts";
import { renderDetail, renderList, parseFilter } from "../workers/tangram-experiment/src/admin/render.ts";
import { summarizeLatency } from "../workers/tangram-experiment/src/admin/latency.ts";
import { sessionCookie, sessionId } from "../workers/tangram-experiment/src/session-cookie.ts";

const NOW = "2026-10-19T01:00:00.000Z";
const LATER = "2026-10-19T02:00:00.000Z";
const IDS = QUESTIONNAIRE_FORM.items.map((item) => item.id);
const full = (value = 4) => Object.fromEntries(IDS.map((id) => [id, value]));
const XSS = "<script>alert(1)</script>\"'&";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-19T00:00:00.000Z");
const RECORD = "0f8fad5b-d9cb-469f-a165-70867728950e";

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string) { return structuredClone(map.get(key)) as T | undefined; },
    async put(entries: Record<string, unknown>) { for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value)); },
    async delete(keys: string[]) { let n = 0; for (const key of keys) if (map.delete(key)) n++; return n; },
  };
}
const code = (fn: () => unknown) => { try { fn(); } catch (error: any) { return error.code; } return null; };

// --- Questionnaire rules -----------------------------------------------------

test("the questionnaire form is labelled provisional and has four independent 1-7 items, no total", () => {
  assert.equal(QUESTIONNAIRE_FORM.provisional, true);
  assert.match(QUESTIONNAIRE_FORM.version, /^provisional-/);
  assert.match(QUESTIONNAIRE_FORM.notice, /研究者未承認/);
  assert.deepEqual(IDS, ["mental_effort", "task_difficulty", "smoothness", "bothersome"]);
  for (const item of QUESTIONNAIRE_FORM.items) assert.deepEqual([item.type, item.min, item.max, item.required], ["likert", 1, 7, true]);
  assert.equal(QUESTIONNAIRE_FORM.comment.maxLength, 2000);
  assert.ok(!JSON.stringify(QUESTIONNAIRE_FORM).match(/NASA|Paas|total|score/i));
});

test("drafts may be partial and overwritten; a submission needs every item; only an identical re-submit is accepted afterwards", () => {
  let { questionnaire, changed } = applyQuestionnaire(null, { answers: { mental_effort: 3 }, submit: false }, NOW);
  assert.equal(changed, true);
  assert.equal(questionnaire.status, "draft");
  assert.equal(questionnaire.answers.smoothness, null);
  assert.equal(questionnaire.comment, "");
  assert.equal(questionnaire.submittedAt, null);
  ({ questionnaire } = applyQuestionnaire(questionnaire, { answers: { mental_effort: 5, smoothness: 2 }, comment: "メモ", submit: false }, LATER));
  assert.deepEqual([questionnaire.createdAt, questionnaire.updatedAt, questionnaire.answers.mental_effort], [NOW, LATER, 5]);
  assert.equal(code(() => applyQuestionnaire(questionnaire, { answers: { mental_effort: 5 }, submit: true }, LATER)), "invalid_questionnaire");

  const submitted = applyQuestionnaire(questionnaire, { answers: full(6), comment: "感想", submit: true }, LATER).questionnaire;
  assert.deepEqual([submitted.status, submitted.submittedAt, submitted.createdAt], ["submitted", LATER, NOW]);
  const again = applyQuestionnaire(submitted, { answers: full(6), comment: "感想", submit: true }, "2026-10-20T00:00:00.000Z");
  assert.equal(again.changed, false);
  assert.deepEqual(again.questionnaire, submitted, "idempotent: timestamps are not touched");
  assert.equal(code(() => applyQuestionnaire(submitted, { answers: full(5), comment: "感想", submit: true }, LATER)), "questionnaire_submitted");
  assert.equal(code(() => applyQuestionnaire(submitted, { answers: full(6), comment: "変更", submit: true }, LATER)), "questionnaire_submitted");
  assert.equal(code(() => applyQuestionnaire(submitted, { answers: full(6), comment: "感想", submit: false }, LATER)), "questionnaire_submitted");
  assert.equal(questionnaireStatus(submitted), "submitted");
  assert.equal(questionnaireStatus(null), "none");
});

test("malformed questionnaire bodies are rejected without echoing them", () => {
  for (const body of [null, [], "x", { answers: full() }, { answers: full(), submit: "yes" }, { answers: [], submit: false },
    { answers: { ...full(), extra: 1 }, submit: false }, { answers: { mental_effort: 0 }, submit: false }, { answers: { mental_effort: 8 }, submit: false },
    { answers: { mental_effort: 2.5 }, submit: false }, { answers: { mental_effort: "3" }, submit: false },
    { answers: {}, comment: 3, submit: false }, { answers: {}, comment: "x".repeat(2001), submit: false },
    { answers: {}, submit: false, names: { a: "b" } }]) {
    assert.equal(code(() => applyQuestionnaire(null, body, NOW)), "invalid_questionnaire", JSON.stringify(body)?.slice(0, 80));
  }
  assert.equal(applyQuestionnaire(null, { answers: {}, comment: "x".repeat(2000), submit: false }, NOW).changed, true);
});

// --- Worker archive ------------------------------------------------------------

function completed(overrides: Record<string, unknown> = {}) {
  return { recordId: RECORD, seed: 31, status: "completed", startedAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:10:00.000Z",
    events: [{ id: "e1", seq: 1, speaker: "ai", text: "まず", at: "2026-10-19T00:00:00.000Z", origin: "scripted_opening" }],
    judgments: [{ judgment: { candidateName: "PRIVATE-JUDGMENT" } }], attempts: [], ownLedger: { x: "PRIVATE-LEDGER" },
    humanSubmission: { "h-1": "人名" }, aiSubmission: { "a-1": "PRIVATE-AI-NAME" },
    scoring: { key: { human: { "h-1": "PRIVATE-FIGURE" } }, result: { provisional: true, success: false, matchedCount: 0, total: 6,
      figures: [{ figureId: "PRIVATE-FIGURE", human: { slot: "h-1", rawName: "人名", normalized: "x" }, ai: { slot: "a-1", rawName: "AI名" }, matched: false }] } },
    queueState: { pendingHumanEventIds: [], errorCode: null }, ...overrides };
}

test("a questionnaire can be added later to a trial completed before this change, and refreshes its retention", async () => {
  const storage = memoryStorage();
  // A pre-archive session: only "active" exists (as written by the first deployed Worker).
  await storage.put({ active: completed() });
  await backfillActive(storage, T0 + DAY);
  const answers = applyQuestionnaire(null, { answers: full(3), submit: true }, NOW).questionnaire;
  assert.equal(await writeQuestionnaire(storage, RECORD, answers, T0 + 20 * DAY), true);
  assert.deepEqual(await readQuestionnaire(storage, RECORD), answers);
  // The record itself is untouched: names, key and scoring are byte-identical.
  assert.deepEqual(await readArchived(storage, RECORD), completed());
  const removed = await expireRecords(storage, T0 + 31 * DAY, 30, async () => {});
  assert.deepEqual(removed, [], "the questionnaire save counts as an update for retention");
  assert.deepEqual(await expireRecords(storage, T0 + 51 * DAY, 30, async () => {}), [RECORD]);
  assert.equal(await readQuestionnaire(storage, RECORD), null, "expiry removes the answers with the record");
  assert.equal(await writeQuestionnaire(storage, RECORD, answers, T0 + 52 * DAY), false, "never recreated after expiry");
  assert.equal([...storage.map.keys()].some((key) => key.includes(RECORD)), false);
});

test("questionnaire writes are refused for unknown, malformed or deleted records; deletion removes the answers", async () => {
  const storage = memoryStorage();
  await archiveSnapshot(storage, completed(), new Set(), T0);
  const answers = applyQuestionnaire(null, { answers: {}, submit: false }, NOW).questionnaire;
  assert.equal(await writeQuestionnaire(storage, "11111111-1111-4111-8111-111111111111", answers, T0), false);
  await assert.rejects(writeQuestionnaire(storage, "../active", answers, T0));
  assert.equal(await readQuestionnaire(storage, "../active"), null);
  assert.equal(await writeQuestionnaire(storage, RECORD, answers, T0), true);
  await deleteArchived(storage, RECORD);
  assert.equal(await readQuestionnaire(storage, RECORD), null);
  assert.equal(await writeQuestionnaire(storage, RECORD, answers, T0), false, "a tombstoned record never gets answers back");
});

// --- Review ----------------------------------------------------------------------

test("the review holds only the participant's own scene, public events, own names and the results screen", () => {
  const review = participantReview(completed());
  assert.deepEqual(Object.keys(review).sort(), ["events", "humanSubmission", "recordId", "result", "scene", "startedAt", "status", "updatedAt"]);
  assert.deepEqual(review.events, [{ id: "e1", speaker: "ai", text: "まず", at: "2026-10-19T00:00:00.000Z" }]);
  assert.deepEqual(review.humanSubmission, { "h-1": "人名" });
  assert.equal(review.scene.shapes.length, 6);
  const text = JSON.stringify(review);
  for (const secret of ["PRIVATE", "figureId", "seed", "key", "anchors", "normalized", '"slot":"a-1"']) assert.ok(!text.includes(secret), secret);
  assert.equal(code(() => participantReview(completed({ status: "dialogue", scoring: null }))), "trial_not_completed");
});

// --- Admin ------------------------------------------------------------------------

test("admin shows the questionnaire escaped in the detail and only its state in the index", () => {
  const questionnaire = applyQuestionnaire(null, { answers: full(2), comment: "PRIVATE-COMMENT " + XSS, submit: true }, NOW).questionnaire;
  const record = { ...completed(), questionnaire };
  const summary = summarizeRecord(record, "a".repeat(64), summarizeLatency(record));
  assert.equal(summary.questionnaire, "submitted");
  assert.ok(!JSON.stringify(summary).includes("PRIVATE-COMMENT"));
  const list = renderList([summary], parseFilter(new URLSearchParams()), null, [], 30);
  assert.match(list, /仮アンケート/);
  assert.match(list, /提出済み/);
  const detail = renderDetail(record, summary, summarizeLatency(record), 30);
  assert.match(detail, /研究者未承認/);
  assert.ok(detail.includes("PRIVATE-COMMENT &lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;"));
  assert.ok(!detail.includes("<script>"));
  assert.match(detail, /mental_effort/);
  // Older index entries have no questionnaire state: shown as none, never an error.
  const legacy = { ...summary } as Record<string, unknown>;
  delete legacy.questionnaire;
  assert.match(renderList([legacy as typeof summary], parseFilter(new URLSearchParams()), null, [], 30), /<td>なし<\/td><\/tr>/);
  assert.equal(summarizeRecord(completed(), "a".repeat(64), summarizeLatency(completed())).questionnaire, "none");
  assert.match(renderDetail(completed(), summary, summarizeLatency(completed()), 30), /回答なし/);
});

// --- Session cookie ---------------------------------------------------------------

test("the participant cookie is persistent for the retention period and keeps HttpOnly, Secure and SameSite=Strict", async () => {
  const id = "c".repeat(64);
  assert.equal(sessionCookie(id, 30), `tangram_session=${id}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Strict`);
  assert.match(sessionCookie(id, 7), /Max-Age=604800;/);
  assert.throws(() => sessionCookie("x;Domain=evil", 30));
  assert.equal(sessionId(`a=b; tangram_session=${id}`), id);
  assert.equal(sessionId("tangram_session=short"), null);
  const source = await readFile(new URL("../workers/tangram-experiment/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tangram_session=\$\{/, "every Set-Cookie goes through sessionCookie()");
  // A page load re-sends the existing id (never a new one) with a fresh Max-Age.
  assert.match(source, /sessionCookie\(sessionId\(request\.headers\.get\("Cookie"\)\) \?\? newSessionId\(\), retentionDays\(env\.RECORD_RETENTION_DAYS\)\)/);
});

test("Worker routes: one indistinguishable not_found, own records only, and names/scoring never written", async () => {
  const source = await readFile(new URL("../workers/tangram-experiment/src/index.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("private async recordRoute("), source.indexOf("private state()"));
  assert.match(route, /RECORD_ID\.test\(recordId\) \? await readArchived\(this\.ctx\.storage, recordId\)/);
  assert.match(route, /this\.serialized\(async \(\) => \{[\s\S]*writeQuestionnaire\(/);
  assert.doesNotMatch(route, /archiveSnapshot|storage\.put|humanSubmission|scoring/);
  assert.ok(source.indexOf('pathname === "/api/records"') < source.indexOf("if (!this.trial) throw"));
});

// --- Local research server over HTTP ------------------------------------------------

const ownIds = (messages: any[]) => {
  const text = messages.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
  const memo = text.match(/内部参照ID（非公開[^\n]*\n(\[.*\])/);
  return memo ? JSON.parse(memo[1]).map((a: any) => a.id) : [];
};

async function setup(t: any) {
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const messages = JSON.parse(Buffer.concat(chunks).toString()).messages;
    const last = messages.at(-1).content;
    const isJudge = messages.some((m: any) => m.role === "system" && typeof m.content === "string" && m.content.includes("【非公開の対話判断】"));
    const content = isJudge ? JSON.stringify({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null })
      : typeof last === "string" && last.includes("最終提出要求") ? JSON.stringify(Object.fromEntries(ownIds(messages).map((id: string) => [id, "AI名"])))
      : "はい、見てみますね。";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "mock", choices: [{ message: { content } }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "PRIVATE-TEST-KEY",
    baseUrl: "http://127.0.0.1:" + (upstream.address() as any).port + "/v1" });
  const server = await (startNamingServer as any)({ port: 0, client, runDir: "", hideStrategy: true });
  t.after(async () => { await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]); });
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const browser = async () => {
    const cookie = (await fetch(base)).headers.get("set-cookie")!.split(";")[0];
    return (path: string, body?: unknown) => fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  };
  return { browser };
}

async function completeTrial(request: (path: string, body?: unknown) => Promise<Response>, seed: number) {
  let state = await (await request("/api/start", { version: 2, strategy: "repair-first", seed })).json();
  assert.equal((await request("/api/message", { text: "細長いのから" })).status, 202);
  for (let i = 0; i < 200 && (state.trial.aiStatus !== "idle" || state.trial.events.length < 3); i++) {
    await new Promise((r) => setTimeout(r, 10));
    state = await (await request("/api/state")).json();
  }
  const names = Object.fromEntries(state.trial.scene.shapes.map((s: any, i: number) => [s.id, i ? "名前" + i : null]));
  const response = await request("/api/names", { names, confirm: true });
  assert.equal(response.status, 200);
  return { state: (await response.json()).trial, names };
}

test("local server: own completed trials are listed and reviewable; other browsers and ids get the same not_found", async (t) => {
  const { browser } = await setup(t);
  const alice = await browser(), bob = await browser();
  const before = await (await alice("/api/records")).json();
  assert.deepEqual(before, { records: [] });
  let state = await (await alice("/api/start", { version: 2, strategy: "repair-first", seed: 31 })).json();
  const id = state.trial.sessionId;
  assert.equal((await alice(`/api/records/${id}/review`)).status, 409);
  assert.deepEqual(await (await alice(`/api/records/${id}/questionnaire`, { answers: {}, submit: false })).json(), { error: "trial_not_completed" });
  ({ state } = { state: (await completeTrial(alice, 31)).state });
  const first = state.sessionId;
  const review = await (await alice(`/api/records/${first}/review`)).json();
  assert.deepEqual(review.result, state.result, "the review shows exactly the results screen");
  assert.deepEqual(review.scene, state.scene);
  assert.deepEqual(review.events, state.events.map(({ id, speaker, text, at }: any) => ({ id, speaker, text, at })));
  for (const secret of ["figureId", "seed", "anchors", "judgments", "AI名\":{", "PRIVATE"]) assert.ok(!JSON.stringify(review).includes(secret), secret);

  // A second trial in the same browser: the first stays listed and reviewable.
  const second = (await completeTrial(alice, 32)).state.sessionId;
  const { records } = await (await alice("/api/records")).json();
  assert.deepEqual(new Set(records.map((r: any) => r.recordId)), new Set([id, first, second].filter((v, i, a) => a.indexOf(v) === i)));
  assert.equal(records.find((r: any) => r.recordId === second).active, true);
  assert.equal(records.find((r: any) => r.recordId === first).active, false);
  assert.equal((await alice(`/api/records/${first}/review`)).status, 200);

  // Another browser, an unknown id and a malformed id are indistinguishable.
  const notFound = [await bob(`/api/records/${first}/review`), await bob(`/api/records/${first}/questionnaire`),
    await bob(`/api/records/${first}/questionnaire`, { answers: full(), submit: true }),
    await alice("/api/records/11111111-1111-4111-8111-111111111111/review"), await alice("/api/records/..%2Factive/review")];
  for (const response of notFound) assert.deepEqual([response.status, await response.json()], [404, { error: "not_found" }]);
  assert.deepEqual(await (await bob("/api/records")).json(), { records: [] });
});

test("local server: a late questionnaire on a completed trial leaves names and scoring unchanged", async (t) => {
  const { browser } = await setup(t);
  const request = await browser();
  const { state } = await completeTrial(request, 33);
  const id = state.sessionId;
  const reviewBefore = await (await request(`/api/records/${id}/review`)).json();
  let response = await request(`/api/records/${id}/questionnaire`);
  assert.deepEqual(await response.json(), { recordId: id, form: QUESTIONNAIRE_FORM, questionnaire: null });
  response = await request(`/api/records/${id}/questionnaire`, { answers: { smoothness: 5 }, comment: "途中", submit: false });
  assert.equal((await response.json()).questionnaire.status, "draft");
  assert.equal((await (await request("/api/records")).json()).records[0].questionnaire, "draft");
  response = await request(`/api/records/${id}/questionnaire`, { answers: full(4), submit: false, names: {} });
  assert.deepEqual([response.status, await response.json()], [400, { error: "invalid_questionnaire" }]);
  response = await request(`/api/records/${id}/questionnaire`, { answers: full(4), comment: "完了", submit: true });
  const submitted = (await response.json()).questionnaire;
  assert.equal(submitted.status, "submitted");
  response = await request(`/api/records/${id}/questionnaire`, { answers: full(4), comment: "完了", submit: true });
  assert.deepEqual([response.status, (await response.json()).questionnaire], [200, submitted]);
  response = await request(`/api/records/${id}/questionnaire`, { answers: full(5), comment: "完了", submit: true });
  assert.deepEqual([response.status, await response.json()], [409, { error: "questionnaire_submitted" }]);
  assert.deepEqual(await (await request(`/api/records/${id}/review`)).json(), reviewBefore);
  assert.deepEqual((await (await request("/api/state")).json()).trial.result, state.result);
});
