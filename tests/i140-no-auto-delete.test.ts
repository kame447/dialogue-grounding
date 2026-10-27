// Public efe8cdc lineage: exercise the actual Worker/DO methods with in-memory
// storage. Only Cloudflare's base class is replaced; no upstream calls are made.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { archiveSnapshot, readArchived, readQuestionnaire, writeQuestionnaire } from "../workers/tangram-experiment/src/admin/archive.ts";
import { QUESTIONNAIRE_FORM, applyQuestionnaire } from "../dialogue-model/runtime/v2/participant-records.ts";
import { summarizeRecord } from "../workers/tangram-experiment/src/admin/summary.ts";
import { summarizeLatency } from "../workers/tangram-experiment/src/admin/latency.ts";

const baseClass = "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");
// Resolve imports before using a data URL, including the two extensionless
// runtime imports in this older Worker. Keep all application code unchanged.
async function loadWorkerSource(url: URL): Promise<string> {
  let source = stripTypeScriptTypes(await readFile(url, "utf8"));
  const replacements = await Promise.all([...source.matchAll(/from\s+"([^"]+)"/g)].map(async ([whole, specifier]) => {
    let target = specifier;
    if (specifier === "cloudflare:workers") target = baseClass;
    else if (specifier.startsWith(".")) {
      const resolved = new URL(specifier + (/\.(ts|mjs)$/.test(specifier) ? "" : ".ts"), url);
      target = resolved.pathname.endsWith("/index-do.ts") ? await moduleUrl(resolved) : resolved.href;
    }
    return [whole, `from "${target}"`] as const;
  }));
  for (const [before, after] of replacements) source = source.replace(before, after);
  // Node requires duplex for streamed request bodies; Workers accept them directly.
  return `const Request = class extends globalThis.Request {
    constructor(url, options) { super(url, options?.body instanceof ReadableStream ? { ...options, duplex: "half" } : options); }
  };\n` + source + `\n//# sourceURL=${url.href}\n`;
}
async function moduleUrl(url: URL): Promise<string> {
  return "data:text/javascript," + encodeURIComponent(await loadWorkerSource(url));
}
const workerModule = await import(await moduleUrl(new URL("../workers/tangram-experiment/src/index.ts", import.meta.url)));
const { TangramSession, AdminIndex } = workerModule;
const worker = workerModule.default;
const DAY = 86400000, T0 = Date.parse("2026-10-19T00:00:00Z");
const RECORD = "0f8fad5b-d9cb-469f-a165-70867728950e";
const COOKIE = "c".repeat(64), OBJECT = "a".repeat(64);
const TOKEN = "synthetic-admin-token-".repeat(3);
const answers = Object.fromEntries(QUESTIONNAIRE_FORM.items.map(({ id }) => [id, 4]));

function storage() {
  const map = new Map<string, any>();
  let alarm: number | null = T0 + 30 * DAY;
  let alarmWrites = 0;
  return {
    map, get alarm() { return alarm; }, get alarmWrites() { return alarmWrites; },
    async get(key: string) { return structuredClone(map.get(key)); },
    async put(entries: Record<string, unknown>) { for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value)); },
    async delete(keys: string[]) { let count = 0; for (const key of keys) if (map.delete(key)) count++; return count; },
    async list({ prefix, startAfter, limit, reverse }: any) {
      let keys = [...map.keys()].filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((key) => [key, structuredClone(map.get(key))]));
    },
    async deleteAlarm() { alarm = null; },
    async setAlarm(time: number) { alarm = time; alarmWrites++; },
  };
}

async function harness(legacy: boolean) {
  let snapshot: any;
  await createNamingTaskV2({ client: { async chat() { throw new Error("unexpected_upstream"); } }, seed: 31,
    strategy: "repair-first", runDir: null, now: () => T0,
    restore: { recordId: RECORD, closed: true, scoring: { result: { provisional: true, success: false, matchedCount: 0, total: 6, figures: [] } } },
    onPersist: async (value: any) => { snapshot = value; } } as any);
  assert.equal("owner" in snapshot, false, "public legacy records have no owner field");
  const records = storage(), indexStorage = storage();
  if (legacy) await records.put({ active: snapshot });
  else await archiveSnapshot(records, snapshot, new Set(), T0);
  const draft = applyQuestionnaire(null, { answers: {}, submit: false }, new Date(T0).toISOString()).questionnaire;
  if (!legacy) assert.equal(await writeQuestionnaire(records, RECORD, draft, T0, false), true);
  const pending: Promise<unknown>[] = [];
  const ctx = { storage: records, id: { toString: () => OBJECT }, waitUntil(p: Promise<unknown>) { pending.push(p); } };
  const index = new AdminIndex({ storage: indexStorage }, {});
  await index.upsert(summarizeRecord(snapshot, OBJECT, summarizeLatency(snapshot)));
  const env: any = { RECORD_RETENTION_DAYS: "30", ADMIN_TOKEN: TOKEN,
    QUESTIONNAIRE_RATE_LIMIT: { async limit() { return { success: true }; } },
    ADMIN_RATE_LIMIT: { async limit() { return { success: true }; } },
    ADMIN_INDEX: { idFromName: (id: string) => id, get: () => index },
    ASSETS: { async fetch() { return new Response("synthetic page"); } },
    AI_PROXY: { async chat() { throw new Error("unexpected_upstream"); } },
  };
  let session = new TangramSession(ctx, env);
  const sessions = new Map([[COOKIE, session], [OBJECT, session]]);
  env.NAMING_SESSIONS = { idFromName: (id: string) => id, idFromString: (id: string) => id,
    get(id: string) { if (!sessions.has(id)) sessions.set(id, new TangramSession({ ...ctx, storage: storage() }, env)); return sessions.get(id); } };
  const request = (path: string, body?: unknown, withCookie = true) => worker.fetch(new Request("https://example.test" + path, {
    method: body === undefined ? "GET" : "POST", headers: { ...(withCookie ? { Cookie: `tangram_session=${COOKIE}` } : {}),
      ...(path.startsWith("/admin") ? { Authorization: "Bearer " + TOKEN } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const retained = async (submitted = false) => {
    await drain();
    assert.equal((await readArchived(records, RECORD))?.recordId, RECORD);
    assert.equal((await records.get("active"))?.recordId, RECORD);
    assert.ok(Object.hasOwn(await records.get("ledger"), RECORD));
    assert.equal(await records.get("tombstones"), undefined);
    assert.equal((await index.page(null)).items[0]?.recordId, RECORD);
    assert.deepEqual(await index.audit(), [], "no automatic deletion audit");
    const list = await request("/admin", undefined, false);
    assert.equal(list.status, 200); assert.match(await list.text(), new RegExp(RECORD));
    assert.equal((await request(`/admin/record/${RECORD}`, undefined, false)).status, 200);
    const exported = await request(`/admin/record/${RECORD}.json`, undefined, false);
    assert.equal(exported.status, 200);
    const data = await exported.json();
    assert.equal(data.recordId, RECORD);
    if (!legacy || submitted) assert.equal(data.questionnaire.status, submitted ? "submitted" : "draft");
  };
  return { records, index, request, drain, retained, snapshot, fetch: (request: Request) => worker.fetch(request, env), get session() { return session; },
    evict() { session = new TangramSession(ctx, env); sessions.set(COOKIE, session); sessions.set(OBJECT, session); } };
}

for (const days of [30, 31, 400]) for (const legacy of [false, true]) {
  test(`${days} days: ${legacy ? "active-only legacy" : "archived owner-less"} records survive old alarm, visits, saves and questionnaire submission`, async (t) => {
    t.mock.method(Date, "now", () => T0);
    const h = await harness(legacy);
    t.mock.method(Date, "now", () => T0 + days * DAY);
    // Alarm runs before initialization, just as an already-scheduled alarm can.
    await h.session.alarm();
    if (!legacy) await h.retained();
    assert.equal(h.records.alarm, null, "old alarm is cancelled");
    const page = await h.request("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Set-Cookie"), new RegExp(`tangram_session=${COOKIE}; Max-Age=2592000`), "page renews the same id");
    const state = await h.request("/api/state");
    assert.equal(state.status, 200); assert.equal(state.headers.get("Set-Cookie"), null);
    assert.equal((await state.json()).trial.sessionId, RECORD);
    await h.retained();
    const list = await h.request("/api/records");
    assert.equal(list.headers.get("Set-Cookie"), null);
    assert.equal((await list.json()).records[0].recordId, RECORD);
    // Use the real task's persisted snapshot callback without contacting AI.
    await h.session.trial.persistNow();
    await h.retained();
    const submitted = await h.request(`/api/records/${RECORD}/questionnaire`, { answers, comment: "synthetic", submit: true });
    assert.equal(submitted.status, 200); assert.equal(submitted.headers.get("Set-Cookie"), null);
    assert.equal((await submitted.json()).questionnaire.status, "submitted");
    await h.retained(true);
    h.evict();
    assert.equal((await h.request("/api/state")).status, 200);
    await h.retained(true);
    assert.equal(h.records.alarmWrites, 0, "no new deletion alarms");
    // Losing the browser cookie cannot hide the record from the administrator.
    assert.equal((await h.request("/api/records", undefined, false)).status, 200);
    await h.retained(true);
  });
  test(`${days} days: initialization alone preserves ${legacy ? "active-only" : "archived"} old record`, async (t) => {
    t.mock.method(Date, "now", () => T0);
    const h = await harness(legacy);
    t.mock.method(Date, "now", () => T0 + days * DAY);
    const result = await h.request("/api/state");
    assert.equal(result.status, 200); assert.equal((await result.json()).trial?.sessionId, RECORD);
    await h.retained();
    assert.equal(h.records.alarm, null); assert.equal(h.records.alarmWrites, 0);
  });
}

for (const days of [30, 31, 400]) test(`${days} days: archive-only trial keeps its original timestamp, questionnaire and index`, async (t) => {
  t.mock.method(Date, "now", () => T0);
  const h = await harness(false);
  await h.records.delete(["active"]);
  t.mock.method(Date, "now", () => T0 + days * DAY);
  await h.session.alarm();
  const response = await h.request("/api/records");
  assert.equal(response.status, 200); assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal((await response.json()).records[0].recordId, RECORD);
  assert.deepEqual(await readArchived(h.records, RECORD), h.snapshot, "reading never refreshes the archive-only record");
  assert.equal((await readQuestionnaire<any>(h.records, RECORD)).status, "draft");
  const submitted = await h.request(`/api/records/${RECORD}/questionnaire`, { answers, submit: true });
  assert.equal(submitted.status, 200);
  const exported = await h.request(`/admin/record/${RECORD}.json`, undefined, false);
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).questionnaire.status, "submitted");
  assert.equal((await h.index.page(null)).items[0].recordId, RECORD);
  assert.equal(await h.records.get("active"), undefined);
  assert.equal(h.records.alarmWrites, 0);
});

test("questionnaire notice explains that answers are saved without automatic deletion", () => {
  assert.equal(QUESTIONNAIRE_FORM.notice, "試行用の仮の質問です（研究者未承認）。正式な尺度ではありません。回答は実験記録とともに保存され、自動では削除されません。");
});

test("explicit authenticated deletion still removes record, questionnaire and index, audits and prevents resurrection", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const h = await harness(false);
  await h.request("/api/state"); await h.drain();
  t.mock.method(Date, "now", () => T0 + 400 * DAY);
  // Same administrator route as the deployed Worker, including CSRF/confirmation.
  const response = await h.fetch(new Request(`https://example.test/admin/record/${RECORD}/delete`, {
    method: "POST", headers: { Authorization: "Bearer " + TOKEN, Origin: "https://example.test", "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: RECORD }),
  }));
  assert.equal(response.status, 303);
  assert.equal(await readArchived(h.records, RECORD), null); assert.equal(await readQuestionnaire(h.records, RECORD), null);
  assert.equal(await h.records.get("active"), undefined); assert.equal(await h.index.get(RECORD), null);
  assert.deepEqual(await h.records.get("tombstones"), [RECORD]);
  assert.deepEqual((await h.index.audit()).map((entry: any) => entry.reason), ["admin"]);
  assert.equal(await archiveSnapshot(h.records, h.snapshot, new Set(), Date.now()), false);
  assert.equal(await writeQuestionnaire(h.records, RECORD, {}, Date.now(), true), false);
  assert.equal(await h.index.upsert(summarizeRecord(h.snapshot, OBJECT, summarizeLatency(h.snapshot))), false);
  h.evict(); await h.request("/api/state"); await h.session.alarm();
  assert.equal((await h.index.page(null)).items.length, 0);
});
