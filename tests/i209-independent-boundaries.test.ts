// Independent acceptance of the #209 contract using synthetic records and the Worker entrypoint.
// The task factory, DO storage and rate limits are local fixtures. Role routes and storage are real.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clone, config, raw } from './support/s5-base/support.ts';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import { applyQuestionnaire } from '../dialogue-model/runtime/v2/participant-records.ts';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
    }
    return next(specifier, context);
  },
});
const { default: edge, TangramSession, AdminIndex } = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href);
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    // Node requires duplex on the body stream forwarded by the Worker.
    super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init);
  }
};
after(() => { globalThis.Request = NativeRequest; hooks.deregister(); });

const ORIGIN = 'https://i209-synthetic.invalid';
const TOKEN = 'synthetic-i209-admin-token-'.repeat(3);
const SCHEMA = 'participant_role_v1';
const MISSING_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const INDEX_WRITE_FAILURE = new Error('synthetic index write failure');
type Role = 'human' | 'ai' | 'unclassified';
type StorageData = Record<string, unknown>;

function memory(initial: StorageData = {}) {
  let values = new Map(Object.entries(clone(initial)));
  let pending: Promise<unknown> = Promise.resolve();
  let broken = false;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  }
  const writable = () => { if (broken) throw INDEX_WRITE_FAILURE; };
  const view = (map: Map<string, unknown>) => ({
    async get<T = unknown>(key: string) { return clone(map.get(key)) as T | undefined; },
    async put(entries: StorageData) {
      writable();
      for (const [key, value] of Object.entries(entries)) map.set(key, clone(value));
    },
    async delete(keys: string | string[]) {
      writable();
      return [keys].flat().reduce((count, key) => count + Number(map.delete(key)), 0);
    },
    async list({ prefix = '', start, startAfter, end, limit, reverse }: {
      prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean;
    }) {
      let keys = [...map.keys()].filter(key => key.startsWith(prefix) &&
        (start === undefined || key >= start) && (startAfter === undefined || key > startAfter) &&
        (end === undefined || key < end)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map(key => [key, clone(map.get(key))]));
    },
  });
  return {
    get: <T = unknown>(key: string) => view(values).get<T>(key),
    put: (entries: StorageData) => enqueue(() => view(values).put(entries)),
    delete: (keys: string | string[]) => enqueue(() => view(values).delete(keys)),
    list: (options: Parameters<ReturnType<typeof view>['list']>[0]) => view(values).list(options),
    transaction: <T>(fn: (tx: ReturnType<typeof view>) => Promise<T>) => enqueue(async () => {
      const staged = clone(values);
      const result = await fn(view(staged));
      values = staged;
      return result;
    }),
    async setAlarm() {},
    async deleteAlarm() {},
    snapshot: () => clone(Object.fromEntries(values)),
    failWrites(value: boolean) { broken = value; },
  };
}

async function ok(response: Response, status = 200) {
  assert.equal(response.status, status, 'synthetic baseline request must work');
  return response;
}

const rolePath = (id: string) => '/admin/record/' + id + '/participant-role';
const exportPath = (id: string) => '/admin/record/' + id + '.json';
const receptionRolePath = (id: string) => '/admin/reception/' + id + '/participant-role';
const deletePath = (id: string) => '/admin/record/' + id + '/delete';
const roleKey = (id: string) => 'participant-role:' + id;
const roleProjection = (role: Role) => ({ role, schemaVersion: SCHEMA });

async function fixture(mode: 'on' | 'off' = 'on') {
  const stores = new Map<string, ReturnType<typeof memory>>();
  const objects = new Map<string, InstanceType<typeof TangramSession>>();
  const tasks = new Map<string, { persistNow(): Promise<unknown>; complete(): Promise<void> }>();
  const pending: Promise<unknown>[] = [];
  let upstreamCalls = 0;
  const indexStorage = memory();
  let index = new AdminIndex({ storage: indexStorage }, {});
  if (mode === 'on') {
    const fields = {
      allowedOrders: [['bypass-enabled', 'repair-first']], seedPolicy: 'per_trial',
      referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3',
      rotationMode: 'relative_pm90', figureSelection: { mode: 'preset', setId: 'legacy-v1' }, figureSetPolicy: 'shared',
    };
    assert.equal((await index.saveReceptionProtocol({ expectedRevision: 0, fields })).ok, true);
  }
  assert.equal((await index.saveReceptionMode({ expectedRevision: 0, value: mode })).ok, true);
  const permit = { async limit() { return { success: true }; } };
  const env = {
    ADMIN_TOKEN: TOKEN, ADMIN_RATE_LIMIT: permit, BASE_ASSIGNMENT_JSON: JSON.stringify(config()), RECORD_RETENTION_DAYS: '30',
    ADMIN_INDEX: { idFromName: (name: string) => name, get: () => index },
    NAMING_SESSIONS: { idFromName: (id: string) => id, idFromString: (id: string) => id, get: object },
    ASSETS: { async fetch() { return new Response('<html><body></body></html>'); } },
    START_RATE_LIMIT: permit, SESSION_ACTION_RATE_LIMIT: permit, IP_ACTION_RATE_LIMIT: permit,
    GLOBAL_ACTION_RATE_LIMIT: permit, QUESTIONNAIRE_RATE_LIMIT: permit,
    AI_PROXY: { async chat() { upstreamCalls++; assert.fail('no upstream requests in independent acceptance'); } },
  };
  function store(id: string) {
    const saved = stores.get(id) ?? memory();
    stores.set(id, saved);
    return saved;
  }
  function object(id: string) {
    const existing = objects.get(id);
    if (existing) return existing;
    const instance = new TangramSession({
      storage: store(id), id: { toString: () => id }, waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    }, env);
    instance.createTrial = async (input: { restore?: ReturnType<typeof raw>; onPersist(value: unknown): Promise<unknown>;
      seed: number; strategy: string; referenceMemory: boolean; rotationMode?: string; figureSelection?: unknown }) => {
      const record = clone(input.restore ?? raw());
      if (!input.restore) {
        record.recordId = crypto.randomUUID();
        record.seed = input.seed;
        record.strategy = input.strategy;
        record.options.referenceMemory = input.referenceMemory;
        record.options.rotationMode = input.rotationMode;
        if (input.figureSelection) record.options.figureSelection = input.figureSelection;
        record.stimulus = { version: 'synthetic-stimulus-v1', rotationMode: input.rotationMode, angles: { human: { h1: 0 }, ai: { a1: 0 } } };
      }
      const persistNow = () => input.onPersist(clone(record));
      const task = {
        getState: () => ({ version: 2, sessionId: record.recordId, status: record.status, events: clone(record.events),
          submitted: record.status === 'completed', aiSubmitted: record.status === 'completed' }),
        persistNow, whenIdle: async () => {},
        message: () => ({ eventId: 'synthetic-event', duplicate: false }),
        retry: async () => {}, submitHuman: async () => ({}), submitAI: async () => ({}),
        async complete() {
          record.status = 'completed'; record.closed = true;
          record.humanSubmission = {}; record.aiSubmission = {};
          record.scoring = { key: {}, result: { provisional: false, success: false, matchedCount: 0, total: 6, figures: [] } };
          await persistNow();
        },
      };
      tasks.set(record.recordId, task);
      await persistNow();
      return task;
    };
    objects.set(id, instance);
    return instance;
  }
  const request = (path: string, init: RequestInit = {}): Promise<Response> => edge.fetch(new Request(ORIGIN + path, init), env);
  const admin = (path: string, init: RequestInit = {}, extra: HeadersInit = {}) => {
    const headers = new Headers({ Authorization: 'Bearer ' + TOKEN });
    new Headers(extra).forEach((value, header) => headers.set(header, value));
    return request(path, { ...init, headers });
  };
  const post = (path: string, form: URLSearchParams, extra: HeadersInit = {}) => {
    const headers = new Headers({ Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json' });
    new Headers(extra).forEach((value, header) => headers.set(header, value));
    return admin(path, { method: 'POST', body: form }, headers);
  };
  function set(id: string, role: string, extra?: HeadersInit) {
    return post(rolePath(id), new URLSearchParams({ role }), extra);
  }
  function bulk(id: string, role: Role, displayed?: string[], extra?: HeadersInit) {
    const form = new URLSearchParams({ role });
    for (const recordId of displayed ?? []) form.append('recordId', recordId);
    return post(receptionRolePath(id), form, extra);
  }
  async function browser() {
    const page = await ok(await request('/'));
    const cookie = page.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    const id = cookie.slice(cookie.indexOf('=') + 1);
    const participant = (path: string, init: RequestInit = {}) => request(path, { ...init, headers: { Cookie: cookie } });
    const owner = () => object(id);
    return {
      id, cookie, owner, store: store(id), participant,
      async approve() {
        await ok(await participant('/api/reception', { method: 'POST' }));
        const row = await owner().adminReception();
        const { protocol: selected } = await index.readReceptionSettings();
        return owner().adminApproveReception({ expectedRevision: row.revision, order: 0, protocol: {
          protocolId: selected.protocol.protocolId, revision: selected.revision, sha256: selected.sha256,
        } });
      },
      async start(previousId?: string) {
        const reception = mode === 'on' ? await owner().adminReception() : null;
        const body = { version: 2, ...(reception ? { expectedReceptionRevision: reception.revision } : {}),
          ...(previousId ? { expectedRecordId: previousId } : {}) };
        const response = await ok(await owner().fetch(new Request(ORIGIN + '/api/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })));
        const state = await response.json();
        assert.equal(typeof state.trial?.sessionId, 'string');
        return state.trial.sessionId as string;
      },
    };
  }
  async function legacyArchive() {
    const id = crypto.randomUUID(), ownerId = 'a'.repeat(64);
    const base = raw();
    const record = { ...base, recordId: id, status: 'completed', closed: true, events: [...base.events,
      { id: 'synthetic-human-event', seq: 2, speaker: 'human', text: 'synthetic utterance', at: base.updatedAt }] };
    await store(ownerId).put({ ['record:' + id]: record, ledger: { [id]: Date.parse(record.updatedAt) } });
    await index.upsert(summarizeRecord(record, ownerId, summarizeLatency(record)));
    return { id, ownerId, record, store: store(ownerId) };
  }
  async function indexTrial(browser: { id: string; store: ReturnType<typeof memory> }, id: string) {
    const record = await browser.store.get<Record<string, unknown>>('record:' + id);
    assert.ok(record, 'the baseline task persisted its synthetic trial');
    await index.upsert(summarizeRecord(record, browser.id, summarizeLatency(record)));
  }
  async function drain() {
    while (pending.length) await Promise.all(pending.splice(0));
    assert.equal(upstreamCalls, 0);
  }
  return {
    request, admin, post, set, bulk, browser, legacyArchive, indexTrial, drain, indexStorage, tasks,
    get index() { return index; },
    restart() { objects.clear(); index = new AdminIndex({ storage: indexStorage }, {}); },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Browser = Awaited<ReturnType<Fixture['browser']>>;

async function receptionFixture(h: Fixture, count: 1 | 2) {
  const browser = await h.browser();
  const { receptionId } = await browser.approve();
  const first = await browser.start();
  await h.tasks.get(first)!.complete();
  const ids = [first];
  if (count === 2) {
    const second = await browser.start(first);
    await h.tasks.get(second)!.complete();
    ids.push(second);
  }
  await h.drain();
  for (const id of ids) await h.indexTrial(browser, id);
  return { browser, receptionId: receptionId as string, ids };
}

async function assertRole(h: Fixture, id: string, role: Role) {
  const response = await h.admin(rolePath(id));
  assert.equal(response.status, 200, '#209 requires an authenticated role GET for an existing synthetic record (missing at the pre-implementation base)');
  assert.deepEqual(await response.json(), { recordId: id, role });
}
async function assertSet(response: Response, status = 200) {
  assert.equal(response.status, status, '#209 requires an implemented role POST for this synthetic fixture');
  if (status === 200) assert.match(response.headers.get('Content-Type') ?? '', /^application\/json\b/);
  if (status === 303) assert.ok(response.headers.get('Location'), 'browser form returns to the admin UI');
}
async function assertBulk(response: Response) {
  // The contract gives the JSON and browser conventions, and does not pin
  // a distinct success body for the reception route.
  if (response.status === 303) await assertSet(response, 303);
  else await assertSet(response);
}
async function exported(h: Fixture, id: string) {
  assert.ok(await h.index.get(id), 'baseline fixture has an indexed record');
  const response = await ok(await h.admin(exportPath(id)));
  return response.json();
}
async function assertClosed(response: Response, status?: number) {
  if (status !== undefined) assert.equal(response.status, status, '#209 rejection status');
  else assert.ok(response.status >= 400 && response.status < 500, '#209 must reject with a closed client-error code');
  const { error } = await response.json();
  assert.match(error, /^[a-z][a-z0-9_]*$/u);
}
function roleAudit(h: Fixture, id: string) {
  return Object.values(h.indexStorage.snapshot()).flatMap(value => Array.isArray(value) ? value : [value])
    .filter(row => row && typeof row === 'object' && row.recordId === id && Object.values(row).includes('participant_role_set'));
}
async function questionnaire(browser: Browser, id: string) {
  const saved = applyQuestionnaire(null, { answers: {}, comment: 'synthetic-only questionnaire', submit: false }, '2026-10-20T00:00:00.000Z').questionnaire;
  await browser.store.put({ ['questionnaire:' + id]: saved });
  return saved;
}
function recordRows(html: string) {
  return [...html.matchAll(/href=["']\/admin\/record\/([\da-f-]{36})["']/gu)].map(match => match[1]);
}
function nextPage(html: string) {
  const links = [...html.matchAll(/href=["']([^"']+)["']/gu)].map(match => new URL(match[1].replaceAll('&amp;', '&'), ORIGIN));
  return links.find(link => link.pathname === '/admin' && link.searchParams.has('after'));
}

test('WS4 control: synthetic receptions, OFF records and old archives exist before adding participant roles', async () => {
  const on = await fixture();
  const batch = await receptionFixture(on, 2);
  assert.equal((await batch.browser.owner().adminReception()).status, 'finished');
  for (const id of batch.ids) assert.equal((await exported(on, id)).recordId, id);
  const old = await on.legacyArchive();
  assert.equal(Object.hasOwn(await exported(on, old.id), 'assignment'), false);
  const off = await fixture('off');
  const browser = await off.browser();
  const id = await browser.start();
  await off.drain();
  await off.indexTrial(browser, id);
  assert.equal((await exported(off, id)).recordId, id);
  assert.equal((await (await ok(await browser.participant('/api/state'))).json()).trial.sessionId, id);
});

test('WS4 individual role: edits live outside trial, owner and index summary, survive cold start and keep the old record visible', async () => {
  const h = await fixture('off');
  const browser = await h.browser();
  const id = await browser.start();
  await h.tasks.get(id)!.complete();
  const survey = await questionnaire(browser, id);
  await h.drain();
  await h.indexTrial(browser, id);
  const before = browser.store.snapshot();
  const beforeSummary = await h.index.get(id);
  const beforePublic = await (await ok(await browser.participant('/api/state'))).json();
  const beforeExport = await exported(h, id);
  assert.deepEqual(beforeExport.questionnaire, survey);
  assertRoleProjection(beforeExport, 'unclassified');
  await assertRole(h, id, 'unclassified');

  await assertSet(await h.set(id, 'human', { Accept: 'text/html' }), 303);
  const humanRole = await h.indexStorage.get<Record<string, unknown>>(roleKey(id));
  assert.deepEqual(humanRole, { schemaVersion: SCHEMA, recordId: id, role: 'human', updatedAt: humanRole?.updatedAt });
  assert.ok(typeof humanRole?.updatedAt === 'string' && Number.isFinite(Date.parse(humanRole.updatedAt)));
  await assertRole(h, id, 'human');
  assert.deepEqual(browser.store.snapshot(), before);
  assert.deepEqual(await h.index.get(id), beforeSummary);

  await assertSet(await h.set(id, 'ai'));
  await h.tasks.get(id)!.persistNow();
  await h.drain();
  await h.indexTrial(browser, id);
  h.restart();
  await assertRole(h, id, 'ai');
  assert.deepEqual(await (await ok(await browser.participant('/api/state'))).json(), beforePublic);
  assert.deepEqual(await exported(h, id), { ...beforeExport, participantRole: roleProjection('ai') });
  assert.equal(Object.hasOwn(await browser.store.get('active') as object, 'participantRole'), false);

  await assertSet(await h.set(id, 'unclassified'));
  await assertRole(h, id, 'unclassified');
  assert.deepEqual(await exported(h, id), beforeExport);
  const audit = roleAudit(h, id);
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map(row => [row.from, row.to]).sort(), [['ai', 'unclassified'], ['human', 'ai'], ['unclassified', 'human']]);
  assert.ok(audit.every(row => typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))));
  assert.deepEqual(await h.index.audit(), [], 'role audit is stored separately from deletion audit');
});

function assertRoleProjection(record: Record<string, unknown>, role: Role) {
  assert.deepEqual(record.participantRole, roleProjection(role), '#209 requires participantRole in the admin-only JSON projection');
}

test('WS4 legacy archive: a human speaker in dialogue does not classify the person playing that role', async () => {
  const h = await fixture();
  const legacy = await h.legacyArchive();
  const before = legacy.store.snapshot();
  const out = await exported(h, legacy.id);
  assert.ok(out.events.some((event: { speaker: string }) => event.speaker === 'human'));
  assert.equal(Object.hasOwn(out, 'assignment'), false);
  await assertRole(h, legacy.id, 'unclassified');
  assertRoleProjection(await exported(h, legacy.id), 'unclassified');
  await assertSet(await h.set(legacy.id, 'ai'));
  assertRoleProjection(await exported(h, legacy.id), 'ai');
  assert.deepEqual(legacy.store.snapshot(), before);
});

test('WS4 role POST protects both routes from participant credentials, invalid values and cross-origin requests', async () => {
  const h = await fixture();
  const { browser, receptionId, ids: [id] } = await receptionFixture(h, 1);
  await assertRole(h, id, 'unclassified');
  const beforeIndex = h.indexStorage.snapshot(), beforeOwner = browser.store.snapshot();
  const cookieOnly = { Authorization: '', Cookie: browser.cookie };
  for (const [path, form] of [
    [rolePath(id), new URLSearchParams({ role: 'human' })],
    [receptionRolePath(receptionId), new URLSearchParams({ role: 'human', recordId: id })],
  ] as const) {
    assert.equal((await h.post(path, form, cookieOnly)).status, 401);
    assert.equal((await h.post(path, form, { Origin: '' })).status, 403);
    assert.equal((await h.post(path, form, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await h.post(path, form, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const invalid = new URLSearchParams(form); invalid.set('role', 'robot');
    await assertClosed(await h.post(path, invalid));
  }
  assert.equal((await h.request(rolePath(id), { headers: { Cookie: browser.cookie } })).status, 401);
  assert.equal((await h.request(exportPath(id), { headers: { Cookie: browser.cookie } })).status, 401);
  await assertClosed(await h.set(MISSING_ID, 'ai'));
  assert.deepEqual(browser.store.snapshot(), beforeOwner);
  assert.deepEqual(h.indexStorage.snapshot(), beforeIndex);
  await assertRole(h, id, 'unclassified');
});

test('WS4 completed reception: exact displayed set can be assigned, then one trial corrected independently', async () => {
  const h = await fixture();
  const { receptionId, ids: [first, second] } = await receptionFixture(h, 2);
  const { ids: [other] } = await receptionFixture(h, 1);
  await assertRole(h, first, 'unclassified');
  await assertBulk(await h.bulk(receptionId, 'human', [second, first])); // Compare the displayed set regardless of order.
  await assertRole(h, first, 'human');
  await assertRole(h, second, 'human');
  await assertRole(h, other, 'unclassified');
  const oldPage = await (await ok(await h.admin('/admin/receptions'))).text();
  const bulkForm = [...oldPage.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gu)]
    .map(match => match[0]).find(html => html.includes(receptionRolePath(receptionId)));
  assert.ok(bulkForm, '#209 requires a bulk role form for a completed reception');
  const ids = [...bulkForm.matchAll(/<input\b[^>]*>/gu)].map(match => match[0])
    .filter(input => /\bname=["']recordId["']/u.test(input))
    .map(input => /\bvalue=["']([^"']+)["']/u.exec(input)?.[1]).sort();
  assert.deepEqual(ids, [first, second].sort(), 'the form must carry the IDs displayed for this reception');

  await assertSet(await h.set(second, 'ai'));
  const records = await Promise.all([first, second, other].map(id => exported(h, id)));
  assert.deepEqual(records.map(record => record.participantRole.role).sort(), ['ai', 'human', 'unclassified']);
  assert.equal(roleAudit(h, first).length, 1);
  assert.equal(roleAudit(h, second).length, 2);
  assert.equal(roleAudit(h, other).length, 0);
  const log = await (await ok(await h.admin('/admin'))).text();
  for (const role of ['人間', 'AI', '未分類']) assert.match(log.replace(/<select\b[\s\S]*?<\/select>/gu, ''), new RegExp(role, 'u'));
  const refreshed = await (await ok(await h.admin('/admin/receptions'))).text();
  const row = [...refreshed.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gu)].map(match => match[0])
    .find(html => html.includes(receptionRolePath(receptionId)));
  assert.ok(row, 'the refreshed reception list retains the reception being edited');
  const visible = row.replace(/<select\b[\s\S]*?<\/select>/gu, '').replace(/<[^>]+>/gu, ' ');
  assert.match(visible, /人間/u);
  assert.match(visible, /\bAI\b/u);
});

test('WS4 v1 added trial: stale displayed set conflicts without writes; omitted set covers current stored trials', async () => {
  const h = await fixture();
  const { browser, receptionId, ids: [first] } = await receptionFixture(h, 1);
  // The second planned slot exists but carries no record until the second start.
  await assertBulk(await h.bulk(receptionId, 'human', [first]));
  assert.equal(Object.keys(h.indexStorage.snapshot()).filter(key => key.startsWith('participant-role:')).length, 1);
  const second = await browser.start(first);
  await h.tasks.get(second)!.complete();
  await h.drain();
  await h.indexTrial(browser, second);
  const index = h.indexStorage.snapshot(), owner = browser.store.snapshot();
  await assertClosed(await h.bulk(receptionId, 'ai', [first]), 409);
  assert.deepEqual(h.indexStorage.snapshot(), index, 'stale-set conflict leaves both sidecars and audit intact');
  assert.deepEqual(browser.store.snapshot(), owner);
  await assertRole(h, first, 'human');
  await assertRole(h, second, 'unclassified');
  await assertBulk(await h.bulk(receptionId, 'ai'));
  await assertRole(h, first, 'ai');
  await assertRole(h, second, 'ai');
});

test('WS4 v1 removed trial: delete the sidecar with its trial, reject stale bulk input and keep its sibling', async () => {
  const h = await fixture();
  const { browser, receptionId, ids: [first, second] } = await receptionFixture(h, 2);
  await assertBulk(await h.bulk(receptionId, 'human', [first, second]));
  await questionnaire(browser, first);
  await h.drain();
  const old = browser.store.snapshot(), indexBefore = h.indexStorage.snapshot();
  assert.equal((await h.admin(deletePath(first))).status, 404, 'GET does not delete');
  assert.equal((await h.post(deletePath(first), new URLSearchParams({ confirm: second }))).status, 400);
  assert.deepEqual(browser.store.snapshot(), old);
  assert.deepEqual(h.indexStorage.snapshot(), indexBefore);
  const deleted = await h.post(deletePath(first), new URLSearchParams({ confirm: first }), { Accept: 'text/html' });
  assert.equal(deleted.status, 303);
  await h.drain();
  assert.equal(await h.indexStorage.get(roleKey(first)), undefined);
  assert.equal(await browser.store.get('record:' + first), undefined);
  assert.equal(await browser.store.get('questionnaire:' + first), undefined);
  assert.equal((await h.admin(exportPath(first))).status, 404);
  assert.equal((await browser.participant('/api/records/' + first + '/review')).status, 404);
  assert.deepEqual((await h.index.audit()).map((row: { reason: string }) => row.reason), ['admin']);
  const indexAfter = h.indexStorage.snapshot(), ownerAfter = browser.store.snapshot();
  await assertClosed(await h.bulk(receptionId, 'ai', [first, second]), 409);
  assert.deepEqual(h.indexStorage.snapshot(), indexAfter);
  assert.deepEqual(browser.store.snapshot(), ownerAfter);
  await assertRole(h, second, 'human');
  await assertBulk(await h.bulk(receptionId, 'ai', [second]));
  await assertRole(h, second, 'ai');
  assert.equal(await h.indexStorage.get(roleKey(first)), undefined);
});

test('WS4 2c: stale summary after owner-first delete cannot take an individual or bulk role update', async () => {
  const h = await fixture();
  const { browser, receptionId, ids: [first, second] } = await receptionFixture(h, 2);
  assert.equal((await exported(h, first)).recordId, first);
  const before = h.indexStorage.snapshot(), staleSummary = await h.index.get(first);
  const staleTask = h.tasks.get(first)!;
  h.indexStorage.failWrites(true);
  try {
    await h.post(deletePath(first), new URLSearchParams({ confirm: first }), { Accept: 'text/html' });
  } catch (error) {
    assert.equal(error, INDEX_WRITE_FAILURE, 'accept only the injected failure at the Worker boundary');
  }
  try {
    await h.drain();
  } catch (error) {
    assert.equal(error, INDEX_WRITE_FAILURE, 'accept only the injected failure in background work');
  } finally {
    h.indexStorage.failWrites(false);
  }
  assert.ok((await browser.store.get<string[]>('tombstones'))?.includes(first), 'owner removal precedes the injected index failure');
  assert.deepEqual(h.indexStorage.snapshot(), before, 'the index storage did not commit the failed write');
  h.restart();
  assert.ok(await h.index.get(first), 'fault fixture must have a stale summary');
  assert.equal(await h.indexStorage.get(roleKey(first)), undefined);
  await assertRole(h, second, 'unclassified');
  const index = h.indexStorage.snapshot(), owner = browser.store.snapshot();
  await assertClosed(await h.set(first, 'ai'));
  await assertClosed(await h.bulk(receptionId, 'ai', [first, second]), 409);
  assert.deepEqual(h.indexStorage.snapshot(), index, 'failed updates leave the index and audit as they were');
  assert.deepEqual(browser.store.snapshot(), owner);
  assert.equal((await h.admin(exportPath(first))).status, 404);
  // Late work may reject or be discarded. Its authoritative result is storage.
  await Promise.allSettled([staleTask.persistNow()]);
  await h.index.upsert(staleSummary);
  await h.drain();
  h.restart();
  assert.equal((await h.admin(exportPath(first))).status, 404);
  await assertBulk(await h.bulk(receptionId, 'ai'));
  await assertRole(h, second, 'ai');
  assert.equal(await h.indexStorage.get(roleKey(first)), undefined);
  assert.equal(await browser.store.get('record:' + first), undefined);
  assert.equal((await browser.participant('/api/records/' + first + '/review')).status, 404);
});

test('WS4 list pagination: a role filter reaches an older record and survives following the next link', async () => {
  const h = await fixture();
  const target = await h.legacyArchive();
  await assertSet(await h.set(target.id, 'ai'));
  // The existing index pages at 100. Seed a full first page of newer,
  // unclassified synthetic records to put the matching trial beyond it.
  for (let i = 0; i < 100; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const record = { ...target.record, recordId: id, updatedAt: new Date(Date.parse('2026-10-20T00:00:00.000Z') + i).toISOString() };
    await target.store.put({ ['record:' + id]: record });
    await h.index.upsert(summarizeRecord(record, target.ownerId, summarizeLatency(record)));
  }
  const start = await (await ok(await h.admin('/admin?role=ai'))).text();
  let html = start;
  const matched = new Set(recordRows(start));
  const visited = new Set<string>();
  for (let link = nextPage(html); link; link = nextPage(html)) {
    assert.equal(link.searchParams.get('role'), 'ai', 'the cursor preserves the operator’s filter');
    assert.ok(!visited.has(link.href), 'cursor must advance');
    visited.add(link.href);
    html = await (await ok(await h.admin(link.pathname + link.search))).text();
    for (const id of recordRows(html)) matched.add(id);
  }
  assert.deepEqual([...matched], [target.id], 'follow pagination before deciding the complete filtered result');
});
