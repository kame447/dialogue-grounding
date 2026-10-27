// Researcher-only admin log page of the tangram Worker: pure modules only, no Cloudflare runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ADMIN_USER, MIN_TOKEN_LENGTH, checkAdmin, presentedToken, tokensMatch } from "../workers/tangram-experiment/src/admin/auth.ts";
import { handleAdmin, isAdminPath, ADMIN_HEADERS } from "../workers/tangram-experiment/src/admin/routes.ts";
import type { AdminDeps } from "../workers/tangram-experiment/src/admin/routes.ts";
import { summarizeRecord, indexLatency } from "../workers/tangram-experiment/src/admin/summary.ts";
import type { AdminSummary } from "../workers/tangram-experiment/src/admin/summary.ts";
import { escapeHtml, renderDetail, renderList, parseFilter, applyFilter } from "../workers/tangram-experiment/src/admin/render.ts";
import { summarizeLatency } from "../workers/tangram-experiment/src/admin/latency.ts";
import { ACTIVE_KEY, archiveKey, archiveSnapshot, backfillActive, deleteArchived, expireRecords, expiredIds, nextExpiry, readArchived,
  retentionDays } from "../workers/tangram-experiment/src/admin/archive.ts";
import { getSummary, listAudit, listPage, recordHash, removeSummaries, upsertSummary } from "../workers/tangram-experiment/src/admin/index-store.ts";

const TOKEN = "t".repeat(20) + "-synthetic-test-token-0123456789";
const OBJECT = "a".repeat(64);
const RECORD = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FIRST = "11111111-1111-4111-8111-111111111111", SECOND = "22222222-2222-4222-8222-222222222222";
const XSS = "<script>alert(1)</script>\"'&";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-19T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const basic = (user: string, password: string) => "Basic " + btoa(`${user}:${password}`);

function record(overrides: Record<string, unknown> = {}) {
  return {
    recordId: RECORD, version: 2, trialId: "trial-PRIVATE", seed: 137, strategy: "bypass-enabled",
    startedAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:01:00.000Z",
    options: { visualAid: false, referenceMemory: true, utteranceStyle: "concise", userAgent: "Mozilla/5.0 PRIVATE-UA" },
    status: "dialogue", cookie: "tangram_session=" + "f".repeat(64), ip: "203.0.113.9",
    events: [
      { id: "e1", seq: 1, speaker: "ai", text: "まず、どの図形から話しましょうか？", at: "2026-10-19T00:00:00.000Z", origin: "scripted_opening" },
      { id: "e2", seq: 2, speaker: "human", text: "PRIVATE-UTTERANCE " + XSS, at: "2026-10-19T00:00:10.000Z", clientId: "client-PRIVATE" },
      { id: "e3", seq: 3, speaker: "ai", text: "PRIVATE-REPLY", at: "2026-10-19T00:00:14.000Z" },
      { id: "e4", seq: 4, speaker: "human", text: "PRIVATE-SECOND", at: "2026-10-19T00:00:20.000Z" },
    ],
    judgments: [{ turnIndex: 2, status: "committed", judgment: { action: "propose_name", targetSlot: "s-ab12", candidateName: "PRIVATE-NAME " + XSS,
      discriminatingFeature: null, note: null } }],
    attempts: [
      { turnIndex: 2, status: "committed", memory: { opsApplied: 1, rejected: null }, generationGuard: { violations: [], regenerated: false, fallback: false } },
      { turnIndex: 4, status: "judge_error", memory: { opsApplied: 0, rejected: "memory_invalid_update" }, validation: { failures: [XSS] } },
    ],
    requests: [
      { kind: "judgment", status: "ok", model: "model-x", latencyMs: 2500 },
      { kind: "generation", status: "ok", model: "model-x", latencyMs: 1200 },
      { kind: "judgment", status: "error", httpStatus: 502, latencyMs: 8000 },
    ],
    queueState: { pendingHumanEventIds: ["e4"], errorCode: "ai_unavailable", closed: false, events: [{ text: "PRIVATE-QUEUE" }] },
    humanSubmission: null, aiSubmission: null, closed: false, finalError: null, scoring: null,
    ...overrides,
  };
}
const summaryOf = (r = record()) => summarizeRecord(r, OBJECT, summarizeLatency(r));

/** Durable Object storage stand-in: get, multi-key put, delete, ordered list. It survives "eviction" by design. */
function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string) { return structuredClone(map.get(key)) as T | undefined; },
    async put(entries: Record<string, unknown>) { for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value)); },
    async delete(keys: string[]) { let n = 0; for (const key of keys) if (map.delete(key)) n++; return n; },
    async list<T>({ prefix, startAfter, limit, reverse }: { prefix: string; startAfter?: string; limit?: number; reverse?: boolean }) {
      let keys = [...map.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(map.get(k)) as T]));
    },
  };
}

function deps(overrides: Partial<AdminDeps> = {}) {
  const calls = { limit: 0, getRecord: 0, deleteRecord: 0 };
  const value: AdminDeps = {
    token: TOKEN,
    limiter: { async limit() { calls.limit++; return { success: calls.limit <= 3 }; } },
    retentionDays: 30,
    async listPage() { return { items: [summaryOf()], next: null }; },
    async getSummary(id) { return id === RECORD ? summaryOf() : null; },
    async getRecord(entry) { calls.getRecord++; assert.equal(entry.objectId, OBJECT); return record(); },
    async deleteRecord() { calls.deleteRecord++; },
    async audit() { return []; },
    summarizeLatency,
    ...overrides,
  };
  return { value, calls };
}
const req = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string) =>
  new Request("https://example.test" + path, { method, headers: { "CF-Connecting-IP": "198.51.100.1", ...headers }, ...(body === undefined ? {} : { body }) });
const AUTH = { Authorization: "Bearer " + TOKEN };
const deleteRequest = (id: string, confirm: string, headers: Record<string, string> = {}) => req(`/admin/record/${id}/delete`,
  { ...AUTH, Origin: "https://example.test", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded", ...headers },
  "POST", new URLSearchParams({ confirm }).toString());

// --- Authentication -------------------------------------------------------

test("token is read only from Authorization: Bearer, or Basic with the fixed user", () => {
  assert.equal(presentedToken("Bearer " + TOKEN), TOKEN);
  assert.equal(presentedToken(basic(ADMIN_USER, TOKEN)), TOKEN);
  assert.equal(presentedToken(basic("someone", TOKEN)), null);
  assert.equal(presentedToken(basic(ADMIN_USER, "")), null);
  for (const bad of [null, "", "Bearer", "bearer " + TOKEN, "Basic !!!", "Token " + TOKEN]) assert.equal(presentedToken(bad), null, String(bad));
});

test("comparison is exact and fails closed without a sufficiently long secret", async () => {
  assert.equal(await tokensMatch(TOKEN, TOKEN), true);
  assert.equal(await tokensMatch(TOKEN + "x", TOKEN), false);
  assert.equal(await tokensMatch(TOKEN.slice(0, -1), TOKEN), false);
  assert.equal(await checkAdmin("Bearer " + TOKEN, TOKEN), "ok");
  assert.equal(await checkAdmin("Bearer wrong", TOKEN), "invalid");
  assert.equal(await checkAdmin(null, TOKEN), "missing");
  assert.equal(await checkAdmin("Bearer " + TOKEN, undefined), "unconfigured");
  assert.equal(await checkAdmin("Bearer " + "x".repeat(MIN_TOKEN_LENGTH - 1), "x".repeat(MIN_TOKEN_LENGTH - 1)), "unconfigured");
});

test("/admin is 404 without the secret or the limiter; only GET, plus POST on the delete path", async () => {
  assert.equal(isAdminPath("/admin"), true); assert.equal(isAdminPath("/admin/record/x"), true);
  assert.equal(isAdminPath("/administrator"), false); assert.equal(isAdminPath("/api/state"), false);
  for (const override of [{ token: undefined }, { token: "short" }, { limiter: undefined }]) {
    const { value } = deps(override);
    for (const request of [req("/admin", AUTH), deleteRequest(RECORD, RECORD)]) {
      const response = await handleAdmin(request, value);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("WWW-Authenticate"), null);
    }
  }
  const { value, calls } = deps();
  assert.equal((await handleAdmin(req("/admin", AUTH, "POST", ""), value)).status, 404);
  assert.equal((await handleAdmin(req(`/admin/record/${RECORD}`, AUTH, "POST", ""), value)).status, 404);
  assert.equal(calls.deleteRecord, 0);
});

test("missing credentials prompt without consuming the limiter; every credentialed attempt counts", async () => {
  const { value, calls } = deps();
  const prompt = await handleAdmin(req("/admin"), value);
  assert.equal(prompt.status, 401);
  assert.match(prompt.headers.get("WWW-Authenticate") ?? "", /^Basic realm="tangram-admin"/);
  assert.equal(calls.limit, 0);
  assert.equal((await handleAdmin(req("/admin?token=" + TOKEN + "&ADMIN_TOKEN=" + TOKEN), value)).status, 401, "a query-string token is ignored");
  assert.equal((await handleAdmin(req("/admin", { Authorization: "Bearer wrong" }), value)).status, 401);
  assert.equal((await handleAdmin(req("/admin", { Authorization: basic(ADMIN_USER, TOKEN) }), value)).status, 200);
  assert.equal((await handleAdmin(req("/admin", { Authorization: "Bearer wrong" }), value)).status, 401);
  const limited = await handleAdmin(req("/admin", AUTH), value);
  assert.equal(limited.status, 429, "a correct token is also refused once the visitor is over the limit");
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(calls.limit, 4);
});

test("admin responses carry no-store, noindex and a strict CSP, and no CORS or cookies", async () => {
  const { value } = deps({ limiter: { async limit() { return { success: true }; } } });
  for (const request of [req("/admin", AUTH), req("/admin/style.css", AUTH), req("/admin/record/" + RECORD, AUTH), req("/admin/nope", AUTH),
    req("/admin"), deleteRequest(RECORD, RECORD), deleteRequest(RECORD, "x")]) {
    const response = await handleAdmin(request, value);
    for (const [name, expected] of Object.entries(ADMIN_HEADERS)) assert.equal(response.headers.get(name), expected, `${request.url} ${name}`);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
  assert.match(ADMIN_HEADERS["Content-Security-Policy"], /default-src 'none'/);
  assert.doesNotMatch(ADMIN_HEADERS["Content-Security-Policy"], /script-src|unsafe/);
});

test("record detail is served only for indexed trials with a well-formed recordId, and fails closed without auth", async () => {
  const { value, calls } = deps({ limiter: { async limit() { return { success: true }; } } });
  assert.equal((await handleAdmin(req("/admin/record/" + RECORD), value)).status, 401);
  assert.equal((await handleAdmin(req("/admin/record/" + RECORD, { Authorization: "Bearer wrong" }), value)).status, 401);
  assert.equal((await handleAdmin(req("/admin/record/" + RECORD, AUTH), deps({ token: undefined }).value)).status, 404);
  assert.equal((await handleAdmin(req("/admin/record/" + FIRST, AUTH), value)).status, 404);
  assert.equal((await handleAdmin(req("/admin/record/../../api/state", AUTH), value)).status, 404);
  assert.equal((await handleAdmin(req("/admin/record/" + RECORD.toUpperCase(), AUTH), value)).status, 404);
  assert.equal((await handleAdmin(req("/admin/session/" + OBJECT, AUTH), value)).status, 404, "object ids are not addressable");
  assert.equal(calls.getRecord, 0);
  const detail = await handleAdmin(req("/admin/record/" + RECORD, AUTH), value);
  assert.equal(detail.status, 200);
  const html = await detail.text();
  assert.match(html, /PRIVATE-UTTERANCE/, "researchers see the public events");
  assert.match(html, /memory_invalid_update/);
  assert.match(html, /ai_unavailable/);
  assert.match(html, /method="post" action="\/admin\/record\/0f8fad5b-d9cb-469f-a165-70867728950e\/delete"/);
  assert.match(html, /href="\/admin\/record\/0f8fad5b-d9cb-469f-a165-70867728950e\.json"/);
});

test("JSON export of one record: same auth and limiter, admin headers, attachment, indexed ids only", async () => {
  const { value, calls } = deps({ limiter: { async limit() { return { success: true }; } } });
  const path = "/admin/record/" + RECORD + ".json";
  assert.equal((await handleAdmin(req(path), value)).status, 401);
  assert.equal((await handleAdmin(req(path, { Authorization: "Bearer wrong" }), value)).status, 401);
  assert.equal((await handleAdmin(req(path, AUTH), deps({ token: undefined }).value)).status, 404);
  assert.equal((await handleAdmin(req("/admin/record/" + FIRST + ".json", AUTH), value)).status, 404);
  for (const odd of [RECORD + ".JSON", RECORD + ".json.json", RECORD + ".html", "..%2Factive.json"]) {
    assert.equal((await handleAdmin(req("/admin/record/" + odd, AUTH), value)).status, 404, odd);
  }
  assert.equal((await handleAdmin(req(path, AUTH, "POST"), value)).status, 404, "export is GET-only");
  assert.equal(calls.getRecord, 0);
  const response = await handleAdmin(req(path, AUTH), value);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="tangram-record-${RECORD}.json"`);
  for (const [key, header] of Object.entries(ADMIN_HEADERS)) assert.equal(response.headers.get(key), header, key);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.deepEqual(await response.json(), record());
  const limited = deps({ limiter: { async limit() { return { success: false }; } } });
  assert.equal((await handleAdmin(req(path, AUTH), limited.value)).status, 429);
});

// --- Admin delete ---------------------------------------------------------

test("admin delete needs auth, a same-origin POST and a confirmation equal to the recordId; GET has no side effect", async () => {
  const { value, calls } = deps({ limiter: { async limit() { return { success: true }; } } });
  const noAuth = deleteRequest(RECORD, RECORD, { Authorization: "" });
  assert.equal((await handleAdmin(noAuth, value)).status, 401);
  assert.equal((await handleAdmin(deleteRequest(RECORD, RECORD, { Authorization: "Bearer wrong" }), value)).status, 401);
  assert.equal((await handleAdmin(deleteRequest(RECORD, RECORD, { Origin: "" }), value)).status, 403, "Origin is required");
  assert.equal((await handleAdmin(deleteRequest(RECORD, RECORD, { Origin: "https://evil.test" }), value)).status, 403);
  assert.equal((await handleAdmin(deleteRequest(RECORD, RECORD, { "Sec-Fetch-Site": "cross-site" }), value)).status, 403);
  assert.equal((await handleAdmin(deleteRequest(RECORD, "", {}), value)).status, 400);
  assert.equal((await handleAdmin(deleteRequest(RECORD, FIRST, {}), value)).status, 400);
  assert.equal((await handleAdmin(deleteRequest(RECORD, RECORD, { "Content-Type": "application/json" }), value)).status, 400);
  assert.equal((await handleAdmin(deleteRequest(FIRST, FIRST), value)).status, 404, "unindexed");
  assert.equal((await handleAdmin(req(`/admin/record/${RECORD}/delete`, AUTH), value)).status, 404, "GET never deletes");
  assert.equal(calls.deleteRecord, 0);
  const done = await handleAdmin(deleteRequest(RECORD, RECORD), value);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("Location"), "/admin?deleted=1");
  assert.equal(calls.deleteRecord, 1);
});

test("browser form POSTs pass the CSRF check: same-origin referrer policy, and Origin null only with Sec-Fetch-Site same-origin", async () => {
  assert.equal(ADMIN_HEADERS["Referrer-Policy"], "same-origin", "no-referrer would make browsers send Origin: null");
  const { value, calls } = deps({ limiter: { async limit() { return { success: true }; } } });
  assert.equal((await handleAdmin(deleteRequest(RECORD, RECORD, { Origin: "null", "Sec-Fetch-Site": "same-origin" }), value)).status, 303);
  assert.equal(calls.deleteRecord, 1);
  for (const headers of [{ Origin: "null", "Sec-Fetch-Site": "" }, { Origin: "null", "Sec-Fetch-Site": "cross-site" },
    { Origin: "null", "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.test", "Sec-Fetch-Site": "same-origin" },
    { Origin: "https://example.test", "Sec-Fetch-Site": "same-site" }]) {
    assert.equal((await handleAdmin(deleteRequest(RECORD, RECORD, headers), value)).status, 403, JSON.stringify(headers));
  }
  assert.equal(calls.deleteRecord, 1);
});

test("deleting removes the record and its index entry, writes a content-free audit entry, and cannot be undone by a late write", async () => {
  const session = memoryStorage(), index = memoryStorage();
  await archiveSnapshot(session, record({ updatedAt: iso(T0) }), new Set(), T0);
  await upsertSummary(index, summaryOf(record({ updatedAt: iso(T0) })));
  assert.equal(await deleteArchived(session, RECORD), true);
  await removeSummaries(index, [RECORD], "admin", T0 + DAY);
  assert.equal(await readArchived(session, RECORD), null);
  assert.equal(session.map.has(ACTIVE_KEY), false, "the deleted trial was active, so active goes too");
  assert.equal(await getSummary(index, RECORD), null);
  assert.equal((await listPage(index)).items.length, 0);
  assert.equal(await nextExpiry(session, 30), null, "no alarm needed");
  // A still-running trial writes again: refused, and the index refuses it too.
  assert.equal(await archiveSnapshot(session, record({ updatedAt: iso(T0 + 2 * DAY) }), new Set(), T0 + 2 * DAY), false);
  assert.equal(await readArchived(session, RECORD), null);
  assert.equal(await upsertSummary(index, summaryOf()), false);
  const audit = await listAudit(index);
  assert.deepEqual(audit, [{ recordHash: await recordHash(RECORD), deletedAt: iso(T0 + DAY), reason: "admin" }]);
  assert.deepEqual(Object.keys(audit[0]).sort(), ["deletedAt", "reason", "recordHash"]);
  const auditText = JSON.stringify([...index.map.entries()]);
  for (const secret of [RECORD, "PRIVATE", "bypass", OBJECT]) assert.ok(!auditText.includes(secret), secret);
  // Idempotent: a repeated removal adds no second audit entry.
  await removeSummaries(index, [RECORD], "admin", T0 + 3 * DAY);
  assert.equal((await listAudit(index)).length, 1);
});

// --- Archive compatibility helpers (fake clock) --------------------------
// Expiry helpers below are exercised explicitly for legacy compatibility only.
// Production never invokes them; i140-no-auto-delete.test.ts covers that boundary.

test("RECORD_RETENTION_DAYS: integer 1-365, otherwise 30", () => {
  assert.equal(retentionDays("30"), 30); assert.equal(retentionDays("1"), 1); assert.equal(retentionDays("365"), 365); assert.equal(retentionDays(7), 7);
  for (const bad of [undefined, "", "0", "366", "-5", "7.5", "abc", "1e2", 0, 400, 3.5, null]) assert.equal(retentionDays(bad), 30, String(bad));
});

test("two trials in one browser are each kept until their own expiry, and both are listed meanwhile", async () => {
  const session = memoryStorage(), index = memoryStorage();
  const retired = new Set<string>();
  const persist = async (id: string, ms: number, status = "dialogue") => {
    const r = record({ recordId: id, status, updatedAt: iso(ms) });
    assert.equal(await archiveSnapshot(session, r, retired, ms), true);
    await upsertSummary(index, summaryOf(r));
  };
  await persist(FIRST, T0);
  await persist(FIRST, T0 + 1 * DAY, "completed");
  retired.add(FIRST); // /api/start replaces the browser's active trial
  await persist(SECOND, T0 + 10 * DAY);
  assert.equal(await archiveSnapshot(session, record({ recordId: FIRST, status: "completed", updatedAt: iso(T0 + 1 * DAY) }), retired, T0 + 10 * DAY), true);
  assert.equal((await session.get<any>(ACTIVE_KEY)).recordId, SECOND, "a retired trial never displaces the active one");
  assert.deepEqual((await listPage(index)).items.map((s) => s.recordId), [SECOND, FIRST], "newest first, both listed");
  const removeFromIndex = async (ids: string[]) => { await removeSummaries(index, ids, "retention", T0 + 99 * DAY); };
  // Nothing goes early: FIRST expires 30 days after its last update (day 1), SECOND after day 10.
  assert.deepEqual(await expireRecords(session, T0 + 31 * DAY - 1, 30, removeFromIndex), []);
  assert.equal(await nextExpiry(session, 30), T0 + 31 * DAY);
  assert.deepEqual(await expireRecords(session, T0 + 31 * DAY, 30, removeFromIndex), [FIRST]);
  assert.equal(await readArchived(session, FIRST), null);
  assert.equal(await getSummary(index, FIRST), null, "index entry goes with its record");
  assert.equal((await readArchived(session, SECOND))?.recordId, SECOND);
  assert.equal((await session.get<any>(ACTIVE_KEY)).recordId, SECOND, "the in-window active trial still restores");
  assert.deepEqual((await listPage(index)).items.map((s) => s.recordId), [SECOND]);
  assert.equal(await nextExpiry(session, 30), T0 + 40 * DAY);
  assert.deepEqual(await expireRecords(session, T0 + 40 * DAY, 30, removeFromIndex), [SECOND]);
  assert.equal(session.map.has(ACTIVE_KEY), false);
  assert.equal(await nextExpiry(session, 30), null);
  assert.deepEqual((await listAudit(index)).map((a) => a.reason), ["retention", "retention"]);
});

test("an update refreshes the expiry; a failing index removal deletes nothing", async () => {
  const session = memoryStorage();
  await archiveSnapshot(session, record({ updatedAt: iso(T0) }), new Set(), T0);
  assert.equal(await nextExpiry(session, 30), T0 + 30 * DAY);
  await archiveSnapshot(session, record({ updatedAt: iso(T0 + 5 * DAY) }), new Set(), T0 + 5 * DAY);
  assert.equal(await nextExpiry(session, 30), T0 + 35 * DAY, "the alarm moves with the last update");
  assert.deepEqual(await expiredIds(session, T0 + 30 * DAY, 30), [], "the earlier expiry no longer applies");
  await assert.rejects(expireRecords(session, T0 + 36 * DAY, 30, async () => { throw new Error("index unavailable"); }));
  assert.ok(await readArchived(session, RECORD), "kept for the alarm's retry");
  assert.equal(await nextExpiry(session, 7), T0 + 12 * DAY, "a shorter configured period applies on the next schedule");
});

test("restore after eviction keeps the archive; a legacy active-only session is backfilled once with expiry from its last update", async () => {
  const session = memoryStorage();
  await archiveSnapshot(session, record({ updatedAt: iso(T0) }), new Set(), T0);
  // Eviction drops memory only: a new instance sees the same storage and needs no backfill.
  assert.equal(await backfillActive(session, T0 + DAY), null);
  assert.equal((await readArchived(session, RECORD))?.recordId, RECORD);
  assert.equal((await session.get<any>(ACTIVE_KEY)).recordId, RECORD);
  // A session written before this change has only "active".
  const legacy = memoryStorage();
  await legacy.put({ [ACTIVE_KEY]: record({ recordId: SECOND, status: "completed", updatedAt: iso(T0 - 3 * DAY) }) });
  assert.equal((await backfillActive(legacy, T0))?.recordId, SECOND);
  assert.deepEqual([...legacy.map.keys()].sort(), [ACTIVE_KEY, "ledger", archiveKey(SECOND)]);
  assert.equal(await nextExpiry(legacy, 30), T0 + 27 * DAY, "expiry counts from the record's own last update");
  assert.equal(await backfillActive(legacy, T0), null, "one-time");
  assert.equal((await legacy.get<any>(ACTIVE_KEY)).recordId, SECOND, "active is never removed by backfill");
  assert.equal(await backfillActive(memoryStorage(), T0), null);
  const odd = memoryStorage(); await odd.put({ [ACTIVE_KEY]: { recordId: "not-a-uuid" } });
  assert.equal(await backfillActive(odd, T0), null);
});

test("a legacy active-only session older than 30 days is backfilled and indexed without deletion", async () => {
  const session = memoryStorage(), index = memoryStorage();
  await session.put({ [ACTIVE_KEY]: record({ recordId: SECOND, updatedAt: iso(T0 - 45 * DAY) }) });
  // Same order as TangramSession.initialize(): backfill -> cancel alarm -> restore/index.
  assert.equal((await backfillActive(session, T0))?.recordId, SECOND);
  assert.equal((await session.get<any>(ACTIVE_KEY)).recordId, SECOND);
  const restored = await readArchived(session, SECOND);
  assert.ok(restored);
  assert.equal(await upsertSummary(index, summaryOf(restored as ReturnType<typeof record>)), true);
  assert.equal((await getSummary(index, SECOND))?.recordId, SECOND);
  assert.deepEqual(await listAudit(index), []);
});

test("a stale ordering key never shows a duplicate or a deleted row", async () => {
  const index = memoryStorage();
  await upsertSummary(index, summaryOf(record({ updatedAt: iso(T0) })));
  await upsertSummary(index, summaryOf(record({ updatedAt: iso(T0 + 1000) })));
  // Simulate a leftover key from an interleaved write.
  await index.put({ [`u:${String(9_999_999_999_999 - T0).padStart(13, "0")}:${RECORD}`]: RECORD, [`u:0000000000001:${FIRST}`]: FIRST });
  const page = await listPage(index);
  assert.deepEqual(page.items.map((s) => s.recordId), [RECORD]);
  assert.equal(page.items[0].updatedAt, iso(T0 + 1000));
});

test("archive keys accept only UUID record ids", async () => {
  assert.throws(() => archiveKey("../active"), /invalid_record_id/);
  assert.equal(await readArchived(memoryStorage(), "active"), null);
  await assert.rejects(archiveSnapshot(memoryStorage(), { recordId: "x" }, new Set(), T0), /invalid_record_id/);
});

test("the index pages newest first with no cap, and re-indexing moves an entry instead of duplicating it", async () => {
  const index = memoryStorage();
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  for (let n = 0; n < 250; n++) await upsertSummary(index, summaryOf(record({ recordId: id(n), updatedAt: iso(T0 + n * 1000) })));
  const pages: string[][] = [];
  let after: string | null = null;
  do { const page: { items: AdminSummary[]; next: string | null } = await listPage(index, after); pages.push(page.items.map((s) => s.recordId)); after = page.next; } while (after);
  assert.deepEqual(pages.map((p) => p.length), [100, 100, 50]);
  assert.equal(pages[0][0], id(249));
  assert.equal(pages.flat().length, new Set(pages.flat()).size);
  await upsertSummary(index, summaryOf(record({ recordId: id(0), updatedAt: iso(T0 + 999_999) })));
  const first = await listPage(index);
  assert.equal(first.items[0].recordId, id(0));
  assert.equal([...index.map.keys()].filter((k) => k.startsWith("u:")).length, 250);
  assert.equal((await listPage(index, "not-a-cursor")).items[0].recordId, id(0));
});

// --- Summary, rendering, latency ------------------------------------------

test("the index summary is an allowlist with no cookies, IPs, user agents, text or names", () => {
  const value = summaryOf();
  assert.deepEqual(Object.keys(value).sort(), ["aiStatus", "counts", "errorCodes", "latency", "objectId", "questionnaire", "recordId", "referenceMemory",
    "startedAt", "status", "strategy", "updatedAt", "utteranceStyle"]);
  const text = JSON.stringify(value);
  for (const secret of ["PRIVATE", "tangram_session", "f".repeat(64), "203.0.113.9", "Mozilla", "s-ab12", "client-", "<script", "model-x", "trial-"]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.equal(value.aiStatus, "error");
  assert.equal(value.referenceMemory, true);
  assert.deepEqual(value.counts, { humanMessages: 2, aiMessages: 2, committedTurns: 1, attempts: 2, incompleteAttempts: 1, requestErrors: 1 });
  assert.deepEqual(value.errorCodes, ["ai_unavailable", "attempt_judge_error", "http_502", "memory_invalid_update"]);
  assert.equal("turns" in value.latency, false);
  assert.throws(() => summarizeRecord(record(), "not-a-hash", summarizeLatency(record())), /invalid_object_id/);
  assert.throws(() => summarizeRecord({ ...record(), recordId: "x" }, OBJECT, summarizeLatency(record())), /invalid_record/);
  const odd = summarizeRecord(record({ strategy: XSS, status: XSS, startedAt: XSS, finalError: "Free text error",
    queueState: { pendingHumanEventIds: [], errorCode: XSS } }), OBJECT, summarizeLatency(record()));
  assert.equal(odd.strategy, "unknown"); assert.equal(odd.status, "unknown"); assert.equal(odd.startedAt, null);
  assert.ok(!JSON.stringify(odd).includes("<") && !JSON.stringify(odd).includes("Free text"));
});

test("index latency drops per-turn detail and any non-code key", () => {
  const base = summarizeLatency(record());
  const latency = { ...base, errorCodes: { http_502: 1, ["PRIVATE text"]: 2 }, validationFailures: { [XSS]: 1 },
    byPhase: { judgment: base.byPhase.judgment, ["bad key"]: base.byPhase.judgment }, turns: [{ aiSeq: 3 } as never] };
  const kept = indexLatency(latency);
  assert.deepEqual(Object.keys(kept.errorCodes), ["http_502"]);
  assert.deepEqual(kept.validationFailures, {});
  assert.deepEqual(Object.keys(kept.byPhase), ["judgment"]);
  assert.equal("turns" in kept, false);
});

test("every record value is escaped in the list and detail pages", () => {
  assert.equal(escapeHtml(XSS), "&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;");
  assert.equal(escapeHtml(null), ""); assert.equal(escapeHtml(undefined), "");
  const hostile = record({ finalError: XSS, scoring: { key: { [XSS]: XSS }, result: XSS }, humanSubmission: { [XSS]: XSS } });
  const html = renderDetail(hostile, summaryOf(), summarizeLatency(hostile), 30);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  const list = renderList([summaryOf()], parseFilter(new URLSearchParams("status=" + encodeURIComponent(XSS))), "u:" + XSS,
    [{ recordHash: XSS, deletedAt: XSS, reason: "admin" }], 30);
  assert.doesNotMatch(list, /<script/i);
  assert.match(list, new RegExp(`href="/admin/record/${RECORD}"`));
  assert.match(list, /自動では削除されません（手動での削除のみ）/);
  assert.match(html, /この記録は自動では削除されません。/);
  assert.doesNotMatch(list + html, /日後に自動削除/);
});

test("a failed turn's sanitized cause (v2 errorCode/errorPhase/errorStatus/errorElapsedMs) is shown and indexed as a code", () => {
  const failed = record({ attempts: [
    { turnIndex: 2, status: "generation_error", errorCode: "timeout", errorPhase: "generation", errorStatus: 504, errorElapsedMs: 61000, generationRetried: true },
    { turnIndex: 4, status: "judge_error", errorCode: "<b>x</b>", errorPhase: "judgment", errorStatus: null, errorElapsedMs: 12 },
  ] });
  const s = summaryOf(failed);
  assert.ok(s.errorCodes.includes("turn_timeout"));
  assert.ok(!s.errorCodes.some((code) => code.includes("<")), "a non-code cause is never indexed");
  const html = renderDetail(failed, s, summarizeLatency(failed), 30);
  assert.match(html, /エラー（コード \/ 段階 \/ HTTP \/ 経過）/);
  assert.match(html, /<td>timeout \/ generation \/ HTTP 504 \/ 61000 ms<\/td><td>あり<\/td>/);
  assert.match(html, /<td>&lt;b&gt;x&lt;\/b&gt; \/ judgment \/ 12 ms<\/td><td><\/td>/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test("filters accept known values only", () => {
  const s = summaryOf();
  assert.deepEqual(parseFilter(new URLSearchParams("status=bogus&error=maybe&memory=1")), { status: "any", error: "any", memory: "any" });
  assert.equal(applyFilter([s], parseFilter(new URLSearchParams("error=with"))).length, 1);
  assert.equal(applyFilter([s], parseFilter(new URLSearchParams("error=without"))).length, 0);
  assert.equal(applyFilter([s], parseFilter(new URLSearchParams("status=completed"))).length, 0);
  assert.equal(applyFilter([s], parseFilter(new URLSearchParams("memory=off"))).length, 0);
});

test("the admin page uses the shared latency summary, which is text-free and never throws", () => {
  const value = summarizeLatency(record());
  assert.equal(value.version, 1);
  assert.equal(value.requests, 3); assert.equal(value.errors, 1);
  assert.equal(value.byPhase.judgment.count, 2); assert.equal(value.byPhase.judgment.errors, 1);
  for (const secret of ["PRIVATE", "model-x", "<script"]) assert.ok(!JSON.stringify(value).includes(secret), secret);
  for (const garbage of [null, 1, "x", [], { requests: "x", events: [null, 1] }, { requests: [{ kind: "<b>", latencyMs: -1 }] }]) {
    assert.doesNotThrow(() => summarizeLatency(garbage));
  }
});

// --- Configuration and participant boundary -------------------------------

test("wrangler keeps migration v1 unchanged, adds AdminIndex under v2, sets 30-day cookie lifetime and holds no admin secret", async () => {
  const raw = await readFile(new URL("../workers/tangram-experiment/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["TangramSession"] }, { tag: "v2", new_sqlite_classes: ["AdminIndex"] }]);
  assert.ok(config.durable_objects.bindings.some((b: any) => b.name === "ADMIN_INDEX" && b.class_name === "AdminIndex"));
  assert.ok(config.ratelimits.some((r: any) => r.name === "ADMIN_RATE_LIMIT"));
  assert.equal(new Set(config.ratelimits.map((r: any) => r.namespace_id)).size, config.ratelimits.length);
  assert.equal(config.vars.RECORD_RETENTION_DAYS, "30");
  assert.equal(retentionDays(config.vars.RECORD_RETENTION_DAYS), 30);
  assert.ok(!Object.keys(config.vars ?? {}).some((key) => /ADMIN|TOKEN|SECRET/i.test(key)));
});

test("participant state is unchanged and /admin is routed before the participant API", async () => {
  const source = await readFile(new URL("../workers/tangram-experiment/src/index.ts", import.meta.url), "utf8");
  // Participant state is the live state, with only the result withheld until the questionnaire is submitted.
  assert.match(source, /private async state\(\): Promise<unknown> \{\n\s+const live = this\.trial\?\.getState\(\) \?\? null;\n\s+const trial = live && typeof live\.sessionId === "string"\n\s+\? lockResult\(live, await readQuestionnaire\(this\.ctx\.storage, live\.sessionId\)\) : live;\n\s+return \{ trial, hideStrategy: true, busy: Boolean\(live\?\.busy\) \};/);
  assert.ok(source.indexOf("isAdminPath(url.pathname)") < source.indexOf('url.pathname.startsWith("/api/")'));
  // initialize(): backfill -> cancel old alarm -> restore (no expiry).
  const init = source.slice(source.indexOf("private async initialize()"));
  const order = ["backfillActive(", "await this.scheduleExpiry();", "const record = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY)",
    "this.registerSummary(record)", "this.createTrial("].map((needle) => init.indexOf(needle));
  assert.ok(order.every((at) => at >= 0) && order.every((at, i) => i === 0 || at > order[i - 1]), String(order));
  assert.doesNotMatch(source, /runExpiry|expireRecords|nextExpiry|setAlarm\(/);
  // Persist cancels old alarms; every archive mutation is serialized (audit L4).
  assert.match(source, /archiveSnapshot\(this\.ctx\.storage, snapshot, this\.retired, Date\.now\(\)\)\)\) return;\n\s+await this\.scheduleExpiry\(\);/);
  for (const call of ["archiveSnapshot(", "deleteArchived(", "backfillActive("]) {
    const uses = source.split(call).length - 1;
    const wrapped = source.split("this.serialized(() => " + call).length - 1;
    assert.ok(uses >= 1 && uses === wrapped, `${call} ${wrapped}/${uses}`);
  }
  // The alarm re-registers remaining records, repairing a missed best-effort index write (audit L2).
  assert.match(source.slice(source.indexOf("async alarm()")), /^async alarm\(\)[\s\S]*?ledgerIds\(this\.ctx\.storage\)[\s\S]*?this\.registerSummary\(/);
  assert.doesNotMatch(source, /deleteAll/);
});
