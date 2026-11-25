// Issue #140: exercise the actual Worker/DO entrypoints with saved storage and
// an old scheduled alarm. All records and credentials here are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load, clone } from './support/s5-base/support.ts';
import { archiveSnapshot, readArchived, readQuestionnaire } from '../workers/tangram-experiment/src/admin/archive.ts';
import { applyQuestionnaire, QUESTIONNAIRE_FORM } from '../dialogue-model/runtime/v2/participant-records.ts';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';

registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
// Keep the Cloudflare-only module out of the runtime-only typecheck, as in S5.
const workerModuleURL = new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href;
const { default: worker, TangramSession, AdminIndex }: any = await import(workerModuleURL);
const initial = load('WORKER-MATCHING-STORAGE.json');
const ID: string = initial.active.recordId, OWNER: string = initial['base:owner:v1'].ownerId;
const COOKIE = 'c'.repeat(64), TOKEN = 'synthetic-admin-token-'.repeat(3);
const DAY = 86400000, T0 = Date.parse(initial.active.updatedAt);
type Kind = 'assigned' | 'legacy_archive' | 'legacy_active';
type MemoryStorage = {
  alarms: { at: number | null; scheduled: number; cleared: number };
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string | string[]): Promise<number>;
  list<T = unknown>(options: { prefix: string; startAfter?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
  transaction<T>(fn: (tx: MemoryStorage) => Promise<T>): Promise<T>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

function memoryStorage(input: Record<string, unknown> = {}): MemoryStorage {
  let values = new Map(Object.entries(clone(input)));
  const alarms = { at: T0 + 30 * DAY as number | null, scheduled: 0, cleared: 0 };
  return {
    alarms,
    async get<T = unknown>(key: string) { return clone(values.get(key)) as T | undefined; },
    async put(entries: Record<string, unknown>) { for (const [k, v] of Object.entries(entries)) values.set(k, clone(v)); },
    async delete(keys: string | string[]) { let n = 0; for (const k of Array.isArray(keys) ? keys : [keys]) n += Number(values.delete(k)); return n; },
    async list<T = unknown>({ prefix, startAfter, limit, reverse }: { prefix: string; startAfter?: string; limit?: number; reverse?: boolean }) {
      let keys = [...values.keys()].filter(k => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map(k => [k, clone(values.get(k)) as T]));
    },
    async transaction<T>(fn: (tx: MemoryStorage) => Promise<T>): Promise<T> {
      const before = clone(values);
      try { return await fn(this); } catch (e) { values = before; throw e; }
    },
    async setAlarm(at: number) { alarms.at = at; alarms.scheduled++; },
    async deleteAlarm() { alarms.at = null; alarms.cleared++; },
  };
}

async function fixture(kind: Kind) {
  const input = clone(initial);
  input.ledger = { [ID]: T0 };
  if (kind !== 'assigned') {
    delete input['base:owner:v1'];
    delete input.active.assignment;
    delete input['record:' + ID].assignment;
  }
  const record = clone(input.active);
  const questionnaire = applyQuestionnaire(null, { answers: {}, comment: 'synthetic draft', submit: false }, new Date(T0).toISOString()).questionnaire;
  input['questionnaire:' + ID] = questionnaire;
  if (kind === 'legacy_active') { delete input.ledger; delete input['record:' + ID]; }
  const storage = memoryStorage(input), indexStorage = memoryStorage();
  const index: any = new AdminIndex({ storage: indexStorage } as any, {});
  const pending: Promise<unknown>[] = [];
  const counters = { newOwner: 0, model: 0 };
  let session: any;
  const env: any = {
    RECORD_RETENTION_DAYS: '30', ADMIN_TOKEN: TOKEN,
    ADMIN_RATE_LIMIT: { async limit() { return { success: true }; } },
    ADMIN_INDEX: { idFromName: () => 'global', get: () => index },
    NAMING_SESSIONS: {
      idFromName: (name: string) => name, idFromString: (id: string) => id,
      get(id: string) {
        if ([COOKIE, OWNER].includes(id)) return session;
        return { async registerBaseOwner() { counters.newOwner++; return true; } };
      },
    },
    ASSETS: { async fetch() { return new Response('<html><body></body></html>', { headers: { 'Content-Type': 'text/html' } }); } },
    AI_PROXY: { async chat() { counters.model++; throw Error('unexpected synthetic model call'); } },
  };
  session = new TangramSession({ storage, id: { toString: () => OWNER }, waitUntil(p: Promise<unknown>) { pending.push(p); } } as any, env);
  // Active-only legacy objects were not indexed before the archive migration.
  if (kind !== 'legacy_active') await index.upsert(summarizeRecord({ ...record, questionnaire }, OWNER, summarizeLatency(record)));
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('Cookie')) headers.set('Cookie', 'tangram_session=' + COOKIE);
    return worker.fetch(new Request('https://experiment.invalid' + path, { ...init, headers }), env);
  };
  const admin = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + TOKEN);
    return request(path, { ...init, headers });
  };
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); assert.equal(counters.model, 0); };
  return { storage, index, session, record, questionnaire, counters, request, admin, flush };
}

async function retained(x: Awaited<ReturnType<typeof fixture>>) {
  await x.flush();
  assert.equal((await x.storage.get<any>('active'))?.recordId, ID, 'active survives');
  assert.equal((await readArchived(x.storage, ID))?.recordId, ID, 'archive survives');
  assert.ok(Object.hasOwn(await x.storage.get('ledger') ?? {}, ID), 'ledger survives');
  assert.ok(await readQuestionnaire(x.storage, ID), 'questionnaire survives');
  assert.equal((await x.index.get(ID))?.recordId, ID, 'index survives');
  assert.deepEqual(await x.index.audit(), [], 'no automatic deletion audit');
  assert.equal(x.storage.alarms.scheduled, 0, 'no expiry alarm is scheduled');
  assert.equal(x.counters.newOwner, 0, 'age never creates a different owner');
  const exported = await x.admin('/admin/record/' + ID + '.json');
  assert.equal(exported.status, 200);
  const body: any = await exported.json();
  assert.equal(body.recordId, ID);
  assert.deepEqual(body.questionnaire, await readQuestionnaire(x.storage, ID));
}

for (const days of [30, 31, 400]) for (const kind of ['assigned', 'legacy_archive', 'legacy_active'] as Kind[]) {
  test(`${kind}: old alarm at ${days} days cannot delete records or questionnaire`, async t => {
    const x = await fixture(kind);
    t.mock.method(Date, 'now', () => T0 + days * DAY);
    await x.session.alarm();
    assert.equal(x.storage.alarms.at, null, 'old alarm is cleared');
    assert.ok(await x.storage.get('active'), 'old alarm leaves active untouched');
    // Access performs additive backfill for old active-only storage.
    assert.equal((await x.request('/api/records')).status, 200);
    await retained(x);
    assert.deepEqual(await readQuestionnaire(x.storage, ID), x.questionnaire);
  });

  test(`${kind}: revisit at ${days} days preserves IDs and record access`, async t => {
    const x = await fixture(kind);
    t.mock.method(Date, 'now', () => T0 + days * DAY);
    const page = await x.request('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('Set-Cookie')!, new RegExp('^tangram_session=' + COOKIE + ';'));
    assert.match(page.headers.get('Set-Cookie')!, /Max-Age=2592000;/, 'Cookie lifetime stays separate');
    const state = await x.request('/api/state');
    // Legacy trials remain archive-only: BASE never fabricates their assignment.
    assert.equal(state.status, kind === 'assigned' ? 200 : 409);
    const stateBody: any = await state.json();
    if (kind === 'assigned') assert.equal(stateBody.trial.sessionId, ID);
    else assert.deepEqual(stateBody, { error: 'trial_unavailable' });
    const list = await x.request('/api/records');
    assert.equal(list.status, 200);
    assert.deepEqual(((await list.json()) as any).records.map((r: any) => r.recordId), [ID]);
    assert.equal((await x.request('/api/records/' + ID + '/review')).status, 200);
    await retained(x);
  });

  test(`${kind}: saving at ${days} days preserves existing records`, async t => {
    const x = await fixture(kind);
    let now = T0;
    t.mock.method(Date, 'now', () => now);
    if (kind === 'assigned') assert.equal((await x.request('/api/state')).status, 200);
    now += days * DAY;
    if (kind === 'assigned') await x.session.trial.persistNow();
    else {
      // Legacy records have no BASE task. Its archive writer still accepts late snapshots.
      assert.equal(await archiveSnapshot(x.storage, x.record, new Set(), now), true);
      assert.equal((await x.request('/api/records')).status, 200);
    }
    await retained(x);
  });

  test(`${kind}: questionnaire submission at ${days} days preserves trial and answers`, async t => {
    const x = await fixture(kind);
    t.mock.method(Date, 'now', () => T0 + days * DAY);
    // Like the S5 Worker tests, send bodies directly to the DO: Node requires
    // duplex for streamed forwarding, whereas Cloudflare's Request does not.
    const response = await x.session.fetch(new Request('https://session.invalid/api/records/' + ID + '/questionnaire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: Object.fromEntries(QUESTIONNAIRE_FORM.items.map(item => [item.id, 4])), submit: true }),
    }));
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as any).questionnaire.status, 'submitted');
    await retained(x);
    assert.deepEqual(await readArchived(x.storage, ID), x.record, 'questionnaire does not rewrite trial evidence');
  });

  test(`${kind}: admin list/detail/JSON at ${days} days preserves record and questionnaire`, async t => {
    const x = await fixture(kind);
    t.mock.method(Date, 'now', () => T0 + days * DAY);
    if (kind === 'legacy_active') assert.equal((await x.request('/api/records')).status, 200);
    await x.flush();
    const list = await x.admin('/admin');
    assert.equal(list.status, 200);
    assert.ok((await list.text()).includes('/admin/record/' + ID));
    assert.equal((await x.admin('/admin/record/' + ID)).status, 200);
    await retained(x);
  });
}

for (const kind of ['assigned', 'legacy_archive', 'legacy_active'] as Kind[]) {
  test(`${kind}: losing the Cookie after 400 days leaves existing admin records available`, async t => {
    const x = await fixture(kind);
    t.mock.method(Date, 'now', () => T0 + 400 * DAY);
    if (kind === 'legacy_active') assert.equal((await x.request('/api/records')).status, 200);
    await x.flush();
    const before = await x.session.adminRecord(ID);
    const missingCookie = await x.request('/api/state', { headers: { Cookie: '' } });
    assert.equal(missingCookie.status, 401);
    assert.equal(missingCookie.headers.get('Set-Cookie'), null);
    const newBrowser = await x.request('/', { headers: { Cookie: '' } });
    assert.equal(newBrowser.status, 200);
    assert.equal(x.counters.newOwner, 1);
    assert.ok(!newBrowser.headers.get('Set-Cookie')!.includes(COOKIE));
    assert.deepEqual(await x.session.adminRecord(ID), before);
    assert.equal((await x.index.get(ID))?.recordId, ID);
    const exported = await x.admin('/admin/record/' + ID + '.json');
    assert.equal(exported.status, 200);
    assert.deepEqual(await exported.json(), before);
    await x.flush();
  });

  test(`${kind}: explicit deletion after 400 days removes evidence and prevents resurrection`, async t => {
    const x = await fixture(kind);
    let now = T0;
    t.mock.method(Date, 'now', () => now);
    let lateTask: any = null;
    if (kind === 'assigned') {
      assert.equal((await x.request('/api/state')).status, 200);
      lateTask = x.session.trial;
    }
    now += 400 * DAY;
    if (kind === 'legacy_active') assert.equal((await x.request('/api/records')).status, 200);
    await x.flush();
    const deleted = await x.admin('/admin/record/' + ID + '/delete', {
      method: 'POST', headers: { Origin: 'https://experiment.invalid', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirm: ID }).toString(),
    });
    assert.equal(deleted.status, 303);
    assert.equal(await readArchived(x.storage, ID), null);
    assert.equal(await readQuestionnaire(x.storage, ID), null);
    assert.equal(await x.storage.get('active'), undefined);
    assert.equal(await x.index.get(ID), null);
    assert.deepEqual((await x.index.audit()).map((a: any) => a.reason), ['admin']);
    assert.ok((await x.storage.get<string[]>('tombstones'))?.includes(ID));
    if (lateTask) await assert.rejects(() => lateTask.persistNow(), { name: 'BaseSessionError' });
    assert.equal(await archiveSnapshot(x.storage, x.record, new Set(), Date.now()), false);
    assert.equal(await x.index.upsert(summarizeRecord(x.record, OWNER, summarizeLatency(x.record))), false);
    await x.session.alarm();
    assert.equal(await readArchived(x.storage, ID), null);
    assert.equal((await x.admin('/admin/record/' + ID + '.json')).status, 404);
    await x.flush();
  });
}

test('questionnaire notice describes no automatic deletion', () => {
  assert.match(QUESTIONNAIRE_FORM.notice, /自動では削除されません/);
  assert.doesNotMatch(QUESTIONNAIRE_FORM.notice, /その後自動的に削除/);
});
