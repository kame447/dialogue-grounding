import { privateBaseOptions } from './support/s5-private-options.mjs';
// Participant-side records: read-only review, the PROVISIONAL questionnaire
// (研究者未承認の仮項目), per-record archive storage and the admin view of answers.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { startNamingServer } from "../dialogue-model/runtime/web/server.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { applyQuestionnaire, lockResult, participantReview, QUESTIONNAIRE_FORM, questionnaireStatus } from "../dialogue-model/runtime/v2/participant-records.ts";
import { archiveSnapshot, backfillActive, deleteArchived, readArchived, readQuestionnaire,
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

test("a legacy completed trial accepts a questionnaire and updates its ledger only on submission", async () => {
  const storage = memoryStorage();
  // A pre-archive session: only "active" exists (as written by the first deployed Worker).
  await storage.put({ active: completed() });
  await backfillActive(storage, T0 + DAY);
  const answers = applyQuestionnaire(null, { answers: full(3), submit: true }, NOW).questionnaire;
  // Preserve the original update time on draft saves; a submission updates the ledger.
  const originalLedger = await storage.get('ledger');
  const draft = applyQuestionnaire(null, { answers: {}, submit: false }, NOW).questionnaire;
  assert.equal(await writeQuestionnaire(storage, RECORD, draft, T0 + 25 * DAY, false), true);
  assert.deepEqual(await storage.get('ledger'), originalLedger);
  assert.equal(await writeQuestionnaire(storage, RECORD, answers, T0 + 20 * DAY, true), true);
  assert.deepEqual(await readQuestionnaire(storage, RECORD), answers);
  // The record itself is untouched: names, key and scoring are byte-identical.
  assert.deepEqual(await readArchived(storage, RECORD), completed());
  assert.deepEqual(await storage.get('ledger'), { [RECORD]: T0 + 20 * DAY });
});

test("questionnaire writes are refused for unknown, malformed or deleted records; deletion removes the answers", async () => {
  const storage = memoryStorage();
  await archiveSnapshot(storage, completed(), new Set(), T0);
  const answers = applyQuestionnaire(null, { answers: {}, submit: false }, NOW).questionnaire;
  assert.equal(await writeQuestionnaire(storage, "11111111-1111-4111-8111-111111111111", answers, T0, false), false);
  await assert.rejects(writeQuestionnaire(storage, "../active", answers, T0, false));
  assert.equal(await readQuestionnaire(storage, "../active"), null);
  assert.equal(await writeQuestionnaire(storage, RECORD, answers, T0, false), true);
  await deleteArchived(storage, RECORD);
  assert.equal(await readQuestionnaire(storage, RECORD), null);
  assert.equal(await writeQuestionnaire(storage, RECORD, answers, T0, true), false, "a tombstoned record never gets answers back");
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

test("lockResult withholds a result until the questionnaire is submitted, for earlier records too, without mutating the view", () => {
  const review = participantReview(completed());
  const frozen = structuredClone(review);
  const draft = applyQuestionnaire(null, { answers: full(), submit: false }, NOW).questionnaire;
  const submitted = applyQuestionnaire(null, { answers: full(), submit: true }, NOW).questionnaire;
  for (const questionnaire of [null, undefined, draft, { status: "submitted?" }]) {
    const locked = lockResult(review, questionnaire);
    assert.equal(locked.resultLocked, true);
    assert.equal("result" in locked, false);
    assert.ok(!JSON.stringify(locked).includes("AI名"), "no AI names while locked");
  }
  assert.deepEqual(lockResult(review, submitted), { ...frozen, resultLocked: false });
  assert.deepEqual(review, frozen, "the input view is not modified");
  // A trial without a result (still in dialogue) has nothing to withhold.
  assert.deepEqual(lockResult({ status: "dialogue", events: [] }, null), { status: "dialogue", events: [], resultLocked: false });
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

test("the participant cookie has its own lifetime and keeps HttpOnly, Secure and SameSite=Lax (Issue #136)", async () => {
  const id = "c".repeat(64);
  assert.equal(sessionCookie(id, 30), `tangram_session=${id}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`);
  assert.match(sessionCookie(id, 7), /Max-Age=604800;/);
  assert.throws(() => sessionCookie("x;Domain=evil", 30));
  assert.equal(sessionId(`a=b; tangram_session=${id}`), id);
  assert.equal(sessionId("tangram_session=short"), null);
  const source = await readFile(new URL("../workers/tangram-experiment/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tangram_session=\$\{/, "every Set-Cookie goes through sessionCookie()");
  // Known owners keep their id after durable lookup; absent/expired pages register before Cookie.
  // Actual Worker order/error behavior is covered by the separate S5 Worker tests.
  assert.match(source, /baseOwnerStatus\(\)/);
  assert.match(source, /registerBaseOwner\(\)/);
  assert.match(source, /sessionCookie\(cookie!,retentionDays\(env\.RECORD_RETENTION_DAYS\)\)/);
});

test("questionnaire saves have their own 30/60s per-session rate limit namespace in wrangler", async () => {
  const raw = await readFile(new URL("../workers/tangram-experiment/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));
  const limit = config.ratelimits.find((r: any) => r.name === "QUESTIONNAIRE_RATE_LIMIT");
  assert.deepEqual(limit?.simple, { limit: 30, period: 60 });
  assert.equal(new Set(config.ratelimits.map((r: any) => r.namespace_id)).size, config.ratelimits.length, "its own namespace");
});

test("Worker routes: one indistinguishable not_found, own records only, and names/scoring never written", async () => {
  const source = await readFile(new URL("../workers/tangram-experiment/src/index.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("private async recordRoute("), source.indexOf("private state()"));
  assert.match(route, /RECORD_ID\.test\(recordId\) \? await this\.readOwnedArchive\(recordId\)/);
  assert.match(route, /this\.serialized\(async \(\) => \{[\s\S]*writeQuestionnaire\(/);
  // Only a submission updates the ledger timestamp; this never sets an expiry.
  assert.match(route, /writeQuestionnaire\(this\.ctx\.storage, recordId, next\.questionnaire, Date\.now\(\),\s+next\.questionnaire\.status === "submitted"\)/);
  assert.doesNotMatch(route, /archiveSnapshot|storage\.put|humanSubmission|scoring/);
  // The review's result is withheld until that record's questionnaire is submitted.
  assert.match(route, /lockResult\(participantReview\(record\), await readQuestionnaire\(this\.ctx\.storage, recordId\)\)/);
  assert.doesNotMatch(source, /(?<!await )this\.state\(\)/, "state() is always awaited, never sent as a promise");
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
  const privateOptions = await privateBaseOptions(t,{seed:31});
  const server = await (startNamingServer as any)({ port: 0, client, ...privateOptions, hideStrategy: true });
  t.after(async () => { await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]); });
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const browser = async () => {
    const cookie = (await fetch(base)).headers.get("set-cookie")!.split(";")[0];
    const request = (path: string, body?: unknown) => fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return Object.assign(request,{async operatorPrepare(seed:number){
      const saved=JSON.parse(await readFile(privateOptions.baseAssignmentFile,"utf8"));
      await writeFile(privateOptions.baseAssignmentFile,JSON.stringify({...saved,seed,revision:saved.revision+1}),{mode:0o600});
      const current=await (await request("/api/state")).json();
      if(current.trial?.status==="completed"){
        const next=await fetch(base+"/admin/record/"+current.trial.sessionId+"/prepare-next",{method:"POST",headers:{Authorization:"Bearer "+privateOptions.adminToken,Origin:base,"Content-Type":"application/json"},body:"{}"});
        assert.equal(next.status,201);
      }
    }});
  };
  return { browser };
}

async function completeTrial(request: (path: string, body?: unknown) => Promise<Response>, seed: number) {
  await (request as typeof request & {operatorPrepare(seed:number):Promise<void>}).operatorPrepare(seed);
  let state = await (await request("/api/state")).json();
  if(!state.trial)state=await (await request("/api/start",{version:2})).json();
  assert.equal((await request("/api/message", { text: "細長いのから", expectedRecordId:state.trial.sessionId })).status, 202);
  for (let i = 0; i < 200 && (state.trial.aiStatus !== "idle" || state.trial.events.length < 3); i++) {
    await new Promise((r) => setTimeout(r, 10));
    state = await (await request("/api/state")).json();
  }
  const names = Object.fromEntries(state.trial.scene.shapes.map((s: any, i: number) => [s.id, i ? "名前" + i : null]));
  const response = await request("/api/names", { names, confirm: true, expectedRecordId:state.trial.sessionId });
  assert.equal(response.status, 200);
  return { state: (await response.json()).trial, names };
}

test("local server: own completed trials are listed and reviewable; other browsers and ids get the same not_found", async (t) => {
  const { browser } = await setup(t);
  const alice = await browser(), bob = await browser();
  const before = await (await alice("/api/records")).json();
  assert.deepEqual(before, { records: [] });
  let state = await (await alice("/api/start", { version: 2 })).json();
  const id = state.trial.sessionId;
  assert.equal((await alice(`/api/records/${id}/review`)).status, 409);
  assert.deepEqual(await (await alice(`/api/records/${id}/questionnaire`, { answers: {}, submit: false })).json(), { error: "trial_not_completed" });
  ({ state } = { state: (await completeTrial(alice, 31)).state });
  const first = state.sessionId;
  const review = await (await alice(`/api/records/${first}/review`)).json();
  assert.deepEqual([review.resultLocked, review.result, state.resultLocked, state.result], [true, undefined, true, undefined],
    "the result is withheld in both views until the questionnaire is submitted");
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
  assert.deepEqual([reviewBefore.resultLocked, "result" in reviewBefore, state.resultLocked, "result" in state], [true, false, true, false]);
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
  // After submission: the same review plus the result, identical to the live state's (scoring is unchanged).
  const { result, resultLocked, ...reviewAfter } = await (await request(`/api/records/${id}/review`)).json();
  const { resultLocked: _locked, ...unchanged } = reviewBefore;
  assert.deepEqual(reviewAfter, unchanged);
  assert.equal(resultLocked, false);
  assert.equal(result.total, 6);
  const live = (await (await request("/api/state")).json()).trial;
  assert.deepEqual([live.resultLocked, live.result], [false, result]);
});
