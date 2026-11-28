import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clone, config, raw } from './support/s5-base/support.ts';
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
const root = fileURLToPath(new URL('../', import.meta.url));
const { default: edge, TangramSession, AdminIndex }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/index.ts').href);
const { validateBoundBaseRecord }: any = await import(pathToFileURL(root + '/dialogue-model/runtime/v2/base-assignment.ts').href);
// Cloudflare Request permits forwarding a body stream without Node's duplex
// option. Model that constructor contract only; all actual edge code runs.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init);
  }
};
const p = () => ({ schemaVersion: 'reception_protocol_v1', protocolId: '22222222-2222-4222-8222-222222222222',
  revision: 3, allowedOrders: [['bypass-enabled', 'repair-first'], ['repair-first']], seedPolicy: 'per_trial',
  referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3' });
// Saved through the researcher settings store (env values are no longer read).
const settingsFields = () => ({ allowedOrders: [['bypass-enabled', 'repair-first'], ['repair-first']], seedPolicy: 'per_trial',
  referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90', figureSelection: { mode: 'preset', setId: 'legacy-v1' }, figureSetPolicy: 'shared' });
const req = (path: string, body?: unknown, cookie?: string) => new Request('https://i139.invalid' + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function memory() {
  let values = new Map<string, any>();
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => {
    const run = queue.then(fn); queue = run.catch(() => {}); return run;
  };
  const view = (map: Map<string, any>) => ({
    async get(key: string) { return clone(map.get(key)); },
    async put(updates: Record<string, unknown>) { for (const [key, value] of Object.entries(updates)) map.set(key, clone(value)); },
    async delete(keys: string | string[]) { let n = 0; for (const key of Array.isArray(keys) ? keys : [keys]) n += Number(map.delete(key)); return n; },
    async list({ prefix }: { prefix: string }) { return new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); },
  });
  return { snapshot: () => clone(Object.fromEntries(values)),
    get: (key: string) => view(values).get(key), put: (updates: Record<string, unknown>) => enqueue(() => view(values).put(updates)),
    delete: (keys: string | string[]) => enqueue(() => view(values).delete(keys)), list: (options: { prefix: string }) => view(values).list(options),
    transaction(fn: (tx: any) => Promise<any>) {
      return enqueue(async () => {
        const staged = clone(values), result = await fn(view(staged));
        values = staged; return result; // Throw leaves committed state untouched.
      });
    },
    async setAlarm() {}, async deleteAlarm() {},
  };
}
function harness(overrides: Record<string, unknown> = {}, settings: 'on' | 'unset' | 'off' = 'on') {
  const stores = new Map<string, ReturnType<typeof memory>>(), objects = new Map<string, any>();
  const tasks = new Map<string, any>(), pending: Promise<unknown>[] = []; let modelCalls = 0, factories = 0;
  const indexStorage = memory();
  let index = new AdminIndex({ storage: indexStorage }, {});
  const configured = settings === 'unset' ? Promise.resolve()
    : settings === 'off' ? (async () => { assert.equal((await index.saveReceptionMode({ expectedRevision: 0, value: 'off' })).ok, true); })() : (async () => {
    assert.equal((await index.saveReceptionProtocol({ expectedRevision: 0, fields: settingsFields() })).ok, true);
    assert.equal((await index.saveReceptionMode({ expectedRevision: 0, value: 'on' })).ok, true);
  })();
  const objectEnv: any = { BASE_ASSIGNMENT_JSON: JSON.stringify(config()),
    ADMIN_INDEX: { idFromName: (id: string) => id, get: () => index },
    AI_PROXY: { async chat() { modelCalls++; throw Error('no synthetic test should call a model'); } }, ...overrides };
  function get(id: string) {
    if (!stores.has(id)) stores.set(id, memory());
    if (!objects.has(id)) {
      const o = new TangramSession({ storage: stores.get(id), id: { toString: () => id }, waitUntil(p: Promise<unknown>) { pending.push(p); } }, objectEnv);
      // Replace only the model/task factory, preserving the real assignment,
      // storage, Worker routing and reception admission logic.
      o.createTrial = async (input: any) => {
        factories++;
        const record = clone(input.restore ?? raw());
        if (!input.restore) { record.recordId = crypto.randomUUID(); record.seed = input.seed; record.strategy = input.strategy; record.options.referenceMemory = input.referenceMemory;
          // Stands in for implementer A's task: new records carry the mode and generated stimulus.
          record.options.rotationMode = input.rotationMode;
          if (input.openingMode) record.options.openingMode = input.openingMode;
          if (input.figureSelection) record.options.figureSelection = input.figureSelection; // frozen by a v3 plan; legacy-v1 needs no stimulus metadata
          record.stimulus = { version: 'synthetic-stimulus-v1', rotationMode: input.rotationMode, angles: { human: { h1: 0 }, ai: { a1: 0 } } }; }
        const task = { getState: () => ({ version: 2, sessionId: record.recordId, status: record.status, events: [], submitted: record.status === 'completed', aiSubmitted: record.status === 'completed' }),
          persistNow: async () => input.onPersist(clone(record)), whenIdle: async () => {}, message: () => ({ eventId: 'synthetic', duplicate: false }),
          retry: async () => {}, submitHuman: async () => ({}), submitAI: async () => ({}),
          stopped: 0, stopForAdmin() { this.stopped++; },
          save: async (patch: Record<string, unknown>) => { Object.assign(record, patch); await input.onPersist(clone(record)); },
          complete: async () => { record.status = 'completed'; record.closed = true; await input.onPersist(clone(record)); } };
        tasks.set(record.recordId, task); await input.onPersist(clone(record)); return task;
      };
      objects.set(id, o);
    }
    return objects.get(id);
  }
  const env = { ...objectEnv, NAMING_SESSIONS: { idFromName: (id: string) => id, idFromString: (id: string) => id, get },
    ASSETS: { async fetch() { return new Response('<html></html>'); } }, START_RATE_LIMIT: { async limit() { return { success: true }; } } };
  return { get index() { return index; }, indexStorage, objectEnv, tasks, get,
    edge: (r: Request) => edge.fetch(r, env) as Promise<Response>,
    async displayed() { await configured; const p = (await index.readReceptionSettings()).protocol; return { protocolId: p.protocol.protocolId, revision: p.revision, sha256: p.sha256 }; },
    async browser() { await configured; const r = await edge.fetch(req('/'), env); assert.equal(r.status, 200); return r.headers.get('set-cookie')!.split(';')[0]; },
    object: (cookie: string) => get(cookie.split('=')[1]),
    snapshot: (cookie: string) => stores.get(cookie.split('=')[1])!.snapshot(),
    evict() { objects.clear(); }, evictIndex() { index = new AdminIndex({ storage: indexStorage }, {}); },
    get factories() { return factories; },
    async done() { await Promise.all(pending); assert.equal(modelCalls, 0); },
  };
}
async function damageSettings(h: ReturnType<typeof harness>, how: string) {
  if (how === 'index unavailable') { for (const name of ['readReceptionSettings']) (h.index as any)[name] = async () => { throw Error('synthetic index outage'); }; return; }
  const storage: any = h.indexStorage, snap = storage.snapshot();
  if (how === 'current removed') { await storage.delete('reception-protocol:current'); return; }
  const key = Object.keys(snap).find(k => k.startsWith('reception-protocol:rev:'))!;
  await storage.put({ [key]: { ...snap[key], protocol: { ...snap[key].protocol, rotationMode: 'x' } } });
}
async function receive(h: ReturnType<typeof harness>, cookie: string) {
  // No body required: also exercises the edge allowlist and strips credentials.
  const r = await h.edge(new Request('https://i139.invalid/api/reception', { method: 'POST', headers: { Cookie: cookie } }));
  assert.equal(r.status, 200); return r.json();
}
async function approved(h: ReturnType<typeof harness>, cookie: string, order = 0) {
  await receive(h, cookie);
  const o = h.object(cookie), r = await o.adminReception();
  return o.adminApproveReception({ expectedRevision: r.revision, order, protocol: await h.displayed() });
}
const reception = (h: ReturnType<typeof harness>, cookie: string) => h.snapshot(cookie)['reception:v1'];
const start = (h: ReturnType<typeof harness>, cookie: string, patch: Record<string, unknown> = {}) => h.object(cookie).fetch(req('/api/start', {
  version: 2, expectedReceptionRevision: reception(h, cookie).revision, ...patch,
})) as Promise<Response>;
const noPrivate = (value: unknown) => assert.doesNotMatch(JSON.stringify(value), /receptionId|objectId|protocol|repair-first|bypass-enabled|strategy|seed|assignment|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/u);
function publicResponse(value: unknown, saved: any, expectedPublic: unknown) {
  const secrets = new Set<unknown>([saved.receptionId, saved.objectId, saved.plan.protocolId, saved.plan.protocolSha256,
    ...saved.plan.order, ...saved.plan.trials.flatMap((t: any) => [t.seed, String(t.seed)])]);
  const publicPaths = new Set(['trial.sessionId', 'trial.version', 'trial.status', 'reception.number', 'reception.revision', 'reception.status', 'hideStrategy', 'busy']);
  const at = (node: any, path: string) => path.split('.').reduce((part, key) => part?.[key], node);
  // These are independently supplied expected values, never copied from the
  // response under test. Only equality earns a public-path collision exception.
  for (const path of publicPaths) {
    assert.notEqual(at(expectedPublic, path), undefined, 'expected public contract includes ' + path);
    assert.deepEqual(at(value, path), at(expectedPublic, path), 'public value at ' + path);
  }
  const walk = (node: unknown, path = '') => {
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        assert.ok(!/^(receptionId|objectId|plan|order|strategy|seed|protocol|protocolId|protocolRevision|protocolSha256|assignment)$/u.test(key), 'private key at ' + path + '.' + key);
        walk(child, path ? path + '.' + key : key);
      }
    } else if (!publicPaths.has(path)) assert.ok(!secrets.has(node), 'private actual value at ' + path);
  };
  walk(value);
}

test('leakage oracle accepts public-path value collisions and rejects additional private fields or values', () => {
  const saved = { receptionId: '11111111-1111-4111-8111-111111111111', objectId: 'a'.repeat(64),
    plan: { protocolId: p().protocolId, protocolSha256: 'b'.repeat(64), order: ['repair-first', 'bypass-enabled'],
      trials: [0, 1, 2, 1007, 4009].map(seed => ({ seed })) } };
  const state = { trial: { version: 2, sessionId: '10074009-0000-4000-8000-000000000000', status: 'dialogue' },
    reception: { number: '001', status: 'in_progress', revision: 2 }, hideStrategy: true, busy: false };
  const expected = clone(state);
  publicResponse(state, saved, expected);
  for (const extra of [{ seed: 2 }, { plan: {} }, { protocol: {} }, { strategy: 'repair-first' },
    { debug: 0 }, { debug: '4009' }, { debug: saved.receptionId }, { debug: saved.plan.protocolId },
    { trial: { ...state.trial, extra: 'bypass-enabled' } }]) assert.throws(() => publicResponse({ ...state, ...extra }, saved, expected));
  for (const extra of [
    { trial: { ...state.trial, version: 4009 } }, { trial: { ...state.trial, status: 'repair-first' } },
    { trial: { ...state.trial, sessionId: saved.receptionId } },
    { reception: { ...state.reception, number: '4009' } }, { reception: { ...state.reception, revision: 4009 } },
    { reception: { ...state.reception, status: saved.plan.protocolId } }, { hideStrategy: 4009 }, { busy: 4009 },
  ]) assert.throws(() => publicResponse({ ...state, ...extra }, saved, expected));
});

test('transaction fake isolates staged writes, rolls back only failures, and serializes concurrent commits', async () => {
  const s = memory(); await s.put({ counter: 0 });
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => s.transaction(async tx => {
    const n = await tx.get('counter'); await tx.put({ counter: n + 1 });
    assert.equal((await s.get('counter')), n, 'uncommitted writes are not visible');
    if (i === 2) throw Error('synthetic rollback');
  })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4); assert.equal(await s.get('counter'), 4);
});

for (const rollback of [false, true]) test('transaction fake preserves concurrent ordinary put/delete on ' + (rollback ? 'rollback' : 'commit'), async () => {
  const s = memory(); await s.put({ counter: 0, remove: 'old' });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const transaction = s.transaction(async tx => {
    await tx.put({ counter: 1 }); entered(); await gate;
    if (rollback) throw Error('synthetic rollback');
  });
  // Attach rejection handling before releasing so the harness never produces
  // an unhandled rejection while ordinary writes are queued behind it.
  const outcome = transaction.then(() => 'committed', () => 'rolled_back');
  await started;
  const write = s.put({ 'reception:other': 'preserve' }), remove = s.delete('remove');
  assert.equal(await s.get('counter'), 0, 'transaction remains isolated'); release();
  await Promise.all([write, remove]);
  assert.equal(await outcome, rollback ? 'rolled_back' : 'committed');
  assert.equal(await s.get('counter'), rollback ? 0 : 1);
  assert.equal(await s.get('reception:other'), 'preserve'); assert.equal(await s.get('remove'), undefined);
});

test('real edge state/reception/approval/state/start contract exposes only public reception and trial identifiers', async () => {
  const h = harness({ BASE_ASSIGNMENT_JSON: undefined }), cookie = await h.browser();
  const initial = await h.edge(req('/api/state', undefined, cookie)); assert.equal(initial.status, 200);
  assert.equal((await initial.json()).trial, null); assert.equal(reception(h, cookie), undefined);
  const received = await receive(h, cookie); noPrivate(received);
  const waiting = await (await h.edge(req('/api/state', undefined, cookie))).json();
  assert.deepEqual(waiting, { trial: null, hideStrategy: true, busy: false, reception: { number: '001', status: 'waiting', revision: 0 } });
  await h.object(cookie).adminApproveReception({ expectedRevision: 0, order: 0, protocol: await h.displayed() });
  const ready = await (await h.edge(req('/api/state', undefined, cookie))).json();
  // This exact envelope is also consumed by the UI ready-poll test.
  assert.deepEqual(ready, { trial: null, hideStrategy: true, busy: false, reception: { number: '001', status: 'ready', revision: 1 } });
  noPrivate(ready);
  const saved = reception(h, cookie), response = await h.edge(req('/api/start', { version: 2, expectedReceptionRevision: ready.reception.revision }, cookie));
  assert.equal(response.status, 200, 'approved plan works without BASE_ASSIGNMENT_JSON');
  const state = await response.json(), storage = h.snapshot(cookie);
  const committedRecord = storage['base:owner:v1'].admissions.initial.record;
  const committedReception = storage['reception:v1'];
  // UUID trial.sessionId is intentionally public: it is the stale-write guard.
  publicResponse(state, saved, {
    trial: { version: 2, sessionId: committedRecord.recordId, status: 'dialogue' },
    reception: { number: saved.number, revision: committedReception.revision, status: 'in_progress' },
    hideStrategy: true, busy: false,
  });
  assert.equal(h.snapshot(cookie)['record:' + state.trial.sessionId].seed, saved.plan.trials[0].seed);
  await h.done();
});

for (const next of [false, true]) for (const invalid of ['index unavailable', 'current removed', 'content damaged']) test('approved plan cannot start if current protocol becomes invalid (next=' + next + '): ' + invalid, async () => {
  const h = harness(), cookie = await h.browser(); await approved(h, cookie);
  let recordId: string | undefined;
  if (next) {
    const r = await start(h, cookie); assert.equal(r.status, 200); recordId = (await r.json()).trial.sessionId;
    await h.tasks.get(recordId!).complete();
  }
  const factories = h.factories;
  const before = h.snapshot(cookie); await damageSettings(h, invalid);
  const response = await start(h, cookie, recordId ? { expectedRecordId: recordId } : {}); assert.equal(response.status, 409);
  assert.deepEqual(h.snapshot(cookie), before); assert.equal(h.factories, factories); await h.done();
});

test('approved plan survives DO recreation and distinct cookies concurrently create distinct numbered receptions', async () => {
  const h = harness(), a = await h.browser(), b = await h.browser();
  await Promise.all([receive(h, a), receive(h, b)]);
  assert.notEqual(reception(h, a).receptionId, reception(h, b).receptionId);
  assert.notEqual(reception(h, a).number, reception(h, b).number);
  await h.object(a).adminApproveReception({ expectedRevision: 0, order: 0, protocol: await h.displayed() });
  const saved = reception(h, a); h.evict();
  const response = await start(h, a); assert.equal(response.status, 200);
  const recordId = (await response.json()).trial.sessionId;
  assert.equal(reception(h, a).receptionId, saved.receptionId); assert.deepEqual(reception(h, a).plan, saved.plan);
  const record = h.snapshot(a)['record:' + recordId];
  assert.equal(record.seed, saved.plan.trials[0].seed); assert.equal(record.strategy, saved.plan.trials[0].strategy);
  assert.equal(reception(h, b).status, 'pending'); await h.done();
});

test('page GET creates no reception or trial; same cookie concurrent POST and cold reload create exactly one; another cookie differs', async () => {
  const h = harness(), a = await h.browser();
  assert.equal(reception(h, a), undefined); assert.equal(h.factories, 0);
  const results = await Promise.all([receive(h, a), receive(h, a), receive(h, a)]);
  for (const r of results) { assert.deepEqual(r, results[0]); noPrivate(r); }
  const first = reception(h, a); assert.equal(first.schemaVersion, 'reception_v1'); assert.equal(first.status, 'pending');
  assert.match(first.receptionId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.equal(first.number, '001'); assert.equal(h.factories, 0);
  h.evict(); assert.deepEqual(await receive(h, a), results[0]); assert.equal(reception(h, a).receptionId, first.receptionId);
  const b = await h.browser(); await receive(h, b);
  assert.notEqual(reception(h, b).receptionId, first.receptionId); assert.equal(reception(h, b).number, '002');
  assert.equal((await h.index.listReceptions()).length, 2); await h.done();
});

for (const protocol of ['index unavailable', 'current removed', 'content damaged']) test('unreadable protocol keeps a saved waiting reception but cannot approve or start, and creates no new reception: ' + protocol, async () => {
  const h = harness(), cookie = await h.browser(), other = await h.browser();
  const projection = await receive(h, cookie); noPrivate(projection);
  const displayed = await h.displayed(); await damageSettings(h, protocol);
  await assert.rejects(() => h.object(cookie).adminApproveReception({ expectedRevision: 0, order: 0, protocol: displayed }), (e: any) => e?.name === 'ReceptionError' && ['reception_unavailable', 'protocol_unconfigured'].includes(e.message));
  assert.equal(reception(h, cookie).status, 'pending');
  const refused = await h.edge(new Request('https://i139.invalid/api/reception', { method: 'POST', headers: { Cookie: other } }));
  assert.equal(refused.status, 409); noPrivate(await refused.json()); assert.equal(reception(h, other), undefined);
  const response = await start(h, cookie); assert.equal(response.status, 409); noPrivate(await response.json());
  assert.equal(h.factories, 0); await h.done();
});

test('pending start is 409, and approval CAS permits exactly one winner', async () => {
  const h = harness(), cookie = await h.browser(); await receive(h, cookie);
  assert.equal((await start(h, cookie)).status, 409); assert.equal(h.factories, 0);
  const shown = await h.displayed();
  const results = await Promise.allSettled([0, 1].map(order => h.object(cookie).adminApproveReception({ expectedRevision: 0, order, protocol: shown })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(reception(h, cookie).revision, 1); await h.done();
});

test('approved explicit start uses plan, records its provenance, survives protocol edits, and advances only through its bounded trials', async () => {
  const h = harness(), cookie = await h.browser(); await approved(h, cookie);
  const plan = clone(reception(h, cookie).plan);
  // Current env config has the opposite first strategy; plan must win.
  assert.notEqual(config().strategy, plan.trials[0].strategy);
  const r1 = await start(h, cookie); assert.equal(r1.status, 200);
  let state = await r1.json();
  const firstId = state.trial.sessionId, first = h.snapshot(cookie)['record:' + firstId];
  noPrivate(state.reception);
  assert.deepEqual(Object.keys(state.reception).sort(), ['number', 'revision', 'status']);
  assert.equal(first.strategy, plan.trials[0].strategy); assert.equal(first.seed, plan.trials[0].seed);
  assert.equal(first.options.referenceMemory, plan.trials[0].referenceMemory);
  assert.equal(first.assignment.source.kind, 'reception_plan_v3');
  assert.equal(first.assignment.source.protocolId, plan.protocolId);
  assert.equal(first.assignment.source.protocolRevision, plan.protocolRevision);
  assert.equal(first.assignment.source.protocolSha256, plan.protocolSha256);
  assert.equal(first.assignment.source.trialIndex, 0);
  assert.deepEqual(reception(h, cookie).plan, plan);
  assert.equal((await start(h, cookie, { expectedRecordId: firstId })).status, 409, 'unfinished predecessor');
  await h.tasks.get(firstId).complete();
  const unchanged = h.snapshot(cookie), factories = h.factories;
  const wrongPredecessor = await start(h, cookie, { expectedRecordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(wrongPredecessor.status, 409); assert.deepEqual(await wrongPredecessor.json(), { error: 'trial_changed' });
  assert.deepEqual(h.snapshot(cookie), unchanged); assert.equal(h.factories, factories);
  assert.equal((await h.index.saveReceptionProtocol({ expectedRevision: 1, fields: { ...settingsFields(), referenceMemory: true, allowedOrders: [['repair-first']], rotationMode: 'relative_0' } })).ok, true);
  const r2 = await start(h, cookie, { expectedRecordId: firstId }); assert.equal(r2.status, 200);
  state = await r2.json(); const secondId = state.trial.sessionId;
  assert.notEqual(firstId, secondId);
  const second = h.snapshot(cookie)['record:' + secondId];
  assert.equal(second.strategy, plan.trials[1].strategy); assert.equal(second.seed, plan.trials[1].seed);
  assert.equal(second.options.referenceMemory, plan.trials[1].referenceMemory);
  assert.equal(second.assignment.source.trialIndex, 1);
  assert.deepEqual(reception(h, cookie).trials.map((t: any) => t.recordId), [firstId, secondId]);
  await h.tasks.get(secondId).complete();
  assert.equal((await start(h, cookie, { expectedRecordId: secondId })).status, 409);
  assert.equal(h.factories, 2); assert.equal((await h.object(cookie).adminRecord(firstId)).recordId, firstId);
  assert.equal((await (await h.object(cookie).fetch(req('/api/state'))).json()).reception.status, 'finished');
  await h.done();
});

test('plan-derived record validation rejects mismatched seeds and malformed or unknown provenance fields', async () => {
  const h = harness(), cookie = await h.browser(); await approved(h, cookie);
  const response = await start(h, cookie); assert.equal(response.status, 200);
  const id = (await response.json()).trial.sessionId, record = h.snapshot(cookie)['record:' + id];
  validateBoundBaseRecord(record, record.assignment);
  assert.throws(() => validateBoundBaseRecord({ ...record, seed: record.seed + 1 }, record.assignment));
  for (const patch of [{ rotation: true }, { kind: 'reception_plan_v1' }, { trialIndex: -1 }, { protocolRevision: 0 }, { protocolSha256: 'invalid' }]) {
    const invalid = clone(record); Object.assign(invalid.assignment.source, patch);
    assert.throws(() => validateBoundBaseRecord(invalid, invalid.assignment));
  }
  await h.done();
});

test('a synthetic one-trial order never creates a second trial', async () => {
  const h = harness(), cookie = await h.browser(); await approved(h, cookie, 1);
  const response = await start(h, cookie); assert.equal(response.status, 200);
  const id = (await response.json()).trial.sessionId;
  await h.tasks.get(id).complete();
  assert.equal((await start(h, cookie, { expectedRecordId: id })).status, 409);
  assert.equal(h.factories, 1); await h.done();
});

test('start expectations are mandatory; stale approval/start requests cannot create additional trials', async () => {
  const h = harness(), cookie = await h.browser(); await approved(h, cookie);
  const o = h.object(cookie), revision = reception(h, cookie).revision;
  for (const body of [{ version: 2 }, { version: 2, expectedReceptionRevision: revision - 1 },
    { version: 2, expectedReceptionRevision: revision, expectedRecordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]) {
    const r = await o.fetch(req('/api/start', body)); assert.equal(r.status, 409); assert.equal(h.factories, 0);
  }
  const both = await Promise.all([start(h, cookie), start(h, cookie)]);
  assert.equal(both.filter(r => r.status === 200).length, 1); assert.equal(both.filter(r => r.status === 409).length, 1);
  const first = reception(h, cookie).trials[0].recordId;
  await h.tasks.get(first).complete();
  assert.equal((await start(h, cookie)).status, 409, 'next start requires predecessor expectation');
  const before = h.snapshot(cookie);
  assert.equal((await start(h, cookie, { expectedReceptionRevision: revision, expectedRecordId: first })).status, 409);
  assert.deepEqual(h.snapshot(cookie), before); assert.equal(h.factories, 1); await h.done();
});

test('cancel before start blocks participant; cancellation after start preserves record and is rejected', async () => {
  for (const doStart of [false, true]) {
    const h = harness(), cookie = await h.browser(); await approved(h, cookie);
    if (doStart) assert.equal((await start(h, cookie)).status, 200);
    const before = h.snapshot(cookie), r = reception(h, cookie);
    if (doStart) {
      await assert.rejects(() => h.object(cookie).adminCancelReception({ expectedRevision: r.revision }));
      assert.deepEqual(h.snapshot(cookie), before);
    } else {
      await h.object(cookie).adminCancelReception({ expectedRevision: r.revision });
      assert.equal((await start(h, cookie)).status, 409); assert.equal(h.factories, 0);
    }
    await h.done();
  }
});

test('index failures do not prevent participant reception creation or approved plan start', async () => {
  const h = harness(), cookie = await h.browser();
  h.index.upsertReception = async () => { throw Error('synthetic index outage'); };
  await approved(h, cookie); assert.equal((await start(h, cookie)).status, 200); await h.done();
});

test('AdminIndex reception namespace isolates record summaries, CAS revisions and JST number counters', async () => {
  const h = harness(), cookie = await h.browser(); await receive(h, cookie);
  const row = (await h.index.listReceptions())[0];
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'number', 'objectId', 'receptionId', 'revision', 'status', 'trials'].sort());
  assert.deepEqual(await h.index.getReception(row.receptionId), row);
  await h.index.upsertReception({ ...row, revision: row.revision + 1, status: 'approved' });
  await h.index.upsertReception(row);
  assert.equal((await h.index.getReception(row.receptionId)).status, 'approved', 'late writes never regress index');
  assert.deepEqual(await h.index.page(null), { items: [], next: null });
  assert.equal(await h.index.get('unknown'), null);
  const before = Date.parse('2000-01-01T14:59:59.999Z'), after = before + 1;
  const nums = await Promise.all(Array.from({ length: 5 }, () => h.index.allocateReceptionNumber('daily_seq3', before)));
  assert.deepEqual([...nums].sort(), ['001', '002', '003', '004', '005']);
  assert.equal(await h.index.allocateReceptionNumber('daily_seq3', after), '001');
  await h.indexStorage.put({ 'reception:number:daily_seq3:2000-01-02': 999 });
  assert.equal(await h.index.allocateReceptionNumber('daily_seq3', after), null);
  await h.done();
});

test('legacy mode with reception explicitly off keeps exact BASE admission behavior and reception API is optional', async () => {
  const h = harness({ RECEPTION_REQUIRED: 'on' }, 'off'), cookie = await h.browser();
  const r = await h.object(cookie).fetch(req('/api/start', { version: 2 })); assert.equal(r.status, 200);
  const state = await r.json(), record = h.snapshot(cookie)['record:' + state.trial.sessionId];
  assert.equal(record.strategy, config().strategy); assert.equal(record.seed, config().seed);
  assert.equal(record.assignment.source.kind, 'server_config_v1'); assert.equal(reception(h, cookie), undefined);
  const optional = await h.object(cookie).fetch(new Request('https://i139.invalid/api/reception', { method: 'POST' }));
  assert.equal(optional.status, 404, 'chosen local/legacy compatibility contract: absent reception API');
  await h.done();
});

const ROLE_ADMIN_TOKEN = 'synthetic-i209-admin-token-only-0123456789';
const roleEnv = { ADMIN_TOKEN: ROLE_ADMIN_TOKEN, ADMIN_RATE_LIMIT: { async limit() { return { success: true }; } } };
const rolePath = (id: string) => '/admin/record/' + id + '/participant-role';
const roleKey = (id: string) => 'participant-role:' + id;
function adminRequest(path: string, opts: { role?: string; ids?: string[]; auth?: boolean; origin?: string; cookie?: string } = {}) {
  const headers = new Headers({ Accept: 'application/json' });
  if (opts.auth !== false) headers.set('Authorization', 'Bearer ' + ROLE_ADMIN_TOKEN);
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  if (opts.role === undefined) return new Request('https://i139.invalid' + path, { headers });
  headers.set('Origin', opts.origin ?? 'https://i139.invalid');
  const body = new URLSearchParams({ role: opts.role });
  for (const id of opts.ids ?? []) body.append('recordId', id);
  return new Request('https://i139.invalid' + path, { method: 'POST', headers, body });
}

async function adminRole(h: ReturnType<typeof harness>, id: string) {
  const response = await h.edge(adminRequest(rolePath(id)));
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result.role;
}

async function indexSyntheticTrial(h: ReturnType<typeof harness>, cookie: string, id: string) {
  // The synthetic createTrial replaces the production onPersist wrapper that writes this projection.
  const record = h.snapshot(cookie)['record:' + id];
  await h.index.upsert(summarizeRecord(record, h.object(cookie).ctx.id.toString(), summarizeLatency(record)));
}

function endRequest(path: string, form: Record<string, string>, opts: { auth?: boolean; origin?: string } = {}) {
  const headers = new Headers({ Origin: opts.origin ?? 'https://i139.invalid' });
  if (opts.auth !== false) headers.set('Authorization', 'Bearer ' + ROLE_ADMIN_TOKEN);
  return new Request('https://i139.invalid' + path, { method: 'POST', headers, body: new URLSearchParams(form) });
}

test('force end reception protects completed history and closes a submitting trial across eviction', async () => {
  const h = harness(roleEnv), cookie = await h.browser(), approval = await approved(h, cookie);
  const first = (await (await start(h, cookie)).json()).trial.sessionId;
  await h.tasks.get(first).complete();
  await indexSyntheticTrial(h, cookie, first);
  const second = (await (await start(h, cookie, { expectedRecordId: first })).json()).trial.sessionId;
  const task = h.tasks.get(second);
  await task.save({ status: 'submitting' });
  await indexSyntheticTrial(h, cookie, second);
  const before = h.snapshot(cookie), saved = reception(h, cookie);
  const path = '/admin/reception/' + approval.receptionId + '/force-end';
  const form = { confirm: saved.number, expectedRevision: String(saved.revision) };
  const page = await (await h.edge(adminRequest('/admin/receptions'))).text();
  assert.match(page, /受付を強制終了/u);
  assert.equal((await h.edge(adminRequest(path))).status, 404);
  assert.equal((await h.edge(endRequest(path, form, { auth: false }))).status, 401);
  assert.equal((await h.edge(endRequest(path, form, { origin: 'https://wrong.invalid' }))).status, 403);
  assert.equal((await h.edge(endRequest(path, { ...form, confirm: 'wrong' }))).status, 400);
  assert.equal((await h.edge(endRequest(path, { ...form, expectedRevision: String(saved.revision - 1) }))).status, 409);
  assert.deepEqual(h.snapshot(cookie), before);
  assert.equal((await h.edge(endRequest(path, form))).status, 303);
  const after = h.snapshot(cookie), ended = reception(h, cookie);
  assert.deepEqual(ended, { ...saved, status: 'interrupted', revision: saved.revision + 1, termination: ended.termination });
  assert.equal(ended.termination.by, 'admin');
  assert.equal(new Date(ended.termination.at).toISOString(), ended.termination.at);
  const record = after['record:' + second];
  assert.deepEqual(record, { ...before['record:' + second], status: 'interrupted', updatedAt: ended.termination.at, termination: ended.termination });
  assert.deepEqual(after.active, record);
  const ownerState = after['base:owner:v1'];
  assert.deepEqual(ownerState.admissions[ownerState.activeKey].record, record);
  assert.deepEqual(after['record:' + first], before['record:' + first]);
  assert.equal(after.tombstones, before.tombstones);
  assert.equal(task.stopped, 1);
  await assert.rejects(task.complete());
  assert.equal((await h.edge(endRequest(path, form))).status, 303);
  assert.deepEqual(h.snapshot(cookie), after);
  await h.index.upsert(summarizeRecord(before['record:' + second], h.object(cookie).ctx.id.toString(), summarizeLatency(before['record:' + second])));
  const detail = await (await h.edge(adminRequest('/admin/record/' + second))).text();
  assert.match(detail, /強制終了/u);
  assert.doesNotMatch(detail, /name="revision"/u);
  const exported = await (await h.edge(adminRequest('/admin/record/' + second + '.json'))).json();
  assert.deepEqual(exported.termination, ended.termination);
  assert.deepEqual(exported.scoring, before['record:' + second].scoring);
  for (const filter of ['active', 'completed']) {
    const html = await (await h.edge(adminRequest('/admin?status=' + filter))).text();
    assert.doesNotMatch(html, new RegExp(second, 'u'));
  }
  const interrupted = await (await h.edge(adminRequest('/admin?status=interrupted'))).text();
  assert.match(interrupted, new RegExp(second, 'u'));
  h.evict();
  const factories = h.factories, owner = h.object(cookie);
  const state = await owner.fetch(req('/api/state'));
  assert.equal(state.status, 200);
  const view = await state.json();
  assert.equal(view.interrupted, true);
  assert.equal(view.trial, null);
  for (const route of ['/api/message', '/api/retry', '/api/names', '/api/ai-submit', '/api/start']) {
    const body = route === '/api/start'
      ? { version: 2, expectedRecordId: second, expectedReceptionRevision: ended.revision }
      : { expectedRecordId: second };
    const rejected = await owner.fetch(req(route, body));
    assert.equal(rejected.status, 409, route);
    assert.deepEqual(await rejected.json(), { error: 'trial_interrupted' });
  }
  const { records } = await (await owner.fetch(req('/api/records'))).json();
  assert.equal(records.find((r: any) => r.recordId === second)?.status, 'interrupted');
  assert.equal(records.find((r: any) => r.recordId === first)?.status, 'completed');
  assert.equal(h.factories, factories);
  await h.done();
});

test('force end one trial rechecks archived contents and closes its reception without starting the next condition', async () => {
  const h = harness(roleEnv), cookie = await h.browser();
  await approved(h, cookie);
  const id = (await (await start(h, cookie)).json()).trial.sessionId;
  await indexSyntheticTrial(h, cookie, id);
  const detail = '/admin/record/' + id, path = detail + '/force-end';
  const displayedRevision = async () => {
    const html = await (await h.edge(adminRequest(detail))).text();
    return /name="revision" value="([a-f0-9]{64})"/u.exec(html)?.[1];
  };
  const stale = await displayedRevision();
  assert.ok(stale);
  await h.tasks.get(id).save({ queueState: { ...h.snapshot(cookie)['record:' + id].queueState, errorCode: 'ai_unavailable' } });
  const changed = await displayedRevision();
  assert.ok(changed);
  assert.notEqual(changed, stale);
  const form = { status: 'dialogue', confirm: id, revision: changed };
  assert.equal((await h.edge(endRequest(path, { ...form, revision: stale }))).status, 409);
  assert.equal((await h.edge(endRequest(path, { ...form, status: 'submitting' }))).status, 409);
  assert.equal((await h.edge(endRequest(path, form))).status, 303);
  const after = h.snapshot(cookie);
  assert.equal(reception(h, cookie).status, 'interrupted');
  assert.equal(reception(h, cookie).trials.length, 1);
  assert.equal((await start(h, cookie, { expectedRecordId: id })).status, 409);
  assert.equal((await h.edge(endRequest(path, form))).status, 303);
  assert.deepEqual(h.snapshot(cookie), after);
  await h.done();
});

test('force end reconciles a stale active row when the index write fails', async t => {
  const h = harness(roleEnv, 'off'), cookie = await h.browser(), owner = h.object(cookie);
  const id = (await (await owner.fetch(req('/api/start', { version: 2 }))).json()).trial.sessionId;
  await h.done();
  await indexSyntheticTrial(h, cookie, id);
  const detail = '/admin/record/' + id;
  const initial = await (await h.edge(adminRequest(detail))).text();
  const revision = /name="revision" value="([a-f0-9]{64})"/u.exec(initial)?.[1];
  assert.ok(revision);
  const upsert = t.mock.method(h.index, 'upsert', async () => { throw Error('synthetic index write failure'); });
  assert.equal((await h.edge(endRequest(detail + '/force-end', { confirm: id, revision, status: 'dialogue' }))).status, 303);
  assert.equal(upsert.mock.callCount(), 1);
  assert.equal(h.snapshot(cookie)['record:' + id].status, 'interrupted');
  assert.equal((await h.index.get(id)).status, 'dialogue');
  for (const [filter, visible] of [['active', false], ['completed', false], ['interrupted', true]] as const) {
    const page = await h.edge(adminRequest('/admin?status=' + filter));
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.equal(text.includes(detail), visible, filter);
    if (visible) assert.match(text, /強制終了/u);
  }
  assert.equal((await h.index.get(id)).status, 'dialogue', 'the index was still stale during the list reads');
  await h.done();
});

test('force end reception with a failed admission preserves its unfilled slot', async () => {
  const h = harness(roleEnv), cookie = await h.browser(), approval = await approved(h, cookie);
  h.object(cookie).createTrial = async () => { throw Error('synthetic admission failure'); };
  const failed = await start(h, cookie);
  assert.equal(failed.status, 409);
  assert.deepEqual(await failed.json(), { error: 'trial_unavailable' });
  const saved = reception(h, cookie);
  assert.equal(saved.status, 'in_progress');
  assert.deepEqual(saved.trials, [{ index: 0, recordId: null }]);
  const path = '/admin/reception/' + approval.receptionId + '/force-end';
  const form = { confirm: saved.number, expectedRevision: String(saved.revision) };
  assert.equal((await h.edge(endRequest(path, form))).status, 303);
  const ended = reception(h, cookie);
  assert.equal(ended.status, 'interrupted');
  assert.deepEqual(ended.trials, saved.trials);
  h.evict();
  assert.equal((await start(h, cookie)).status, 409);
  assert.deepEqual(await (await h.object(cookie).fetch(req('/api/records'))).json(), { records: [] });
  assert.equal(h.factories, 0);
  await h.done();
});

test('I209 classifies a completed reception atomically and allows a per-record correction', async () => {
  const h = harness(roleEnv), cookie = await h.browser(), r = await approved(h, cookie);
  const first = (await (await start(h, cookie)).json()).trial.sessionId;
  await h.tasks.get(first).complete();
  await h.done();
  await indexSyntheticTrial(h, cookie, first);
  const batch = '/admin/reception/' + r.receptionId + '/participant-role';
  const role = (id: string) => adminRole(h, id);
  assert.equal(await role(first), 'unclassified');
  const staleIds = [first];
  const second = (await (await start(h, cookie, { expectedRecordId: first })).json()).trial.sessionId;
  await h.tasks.get(second).complete();
  await h.done();
  await indexSyntheticTrial(h, cookie, second);
  const versionPath = '/admin/receptions/version';
  const beforeVersion = await (await h.edge(adminRequest(versionPath))).json();
  const original = h.snapshot(cookie);
  const publicBefore = await (await h.edge(req('/api/records', undefined, cookie))).json();
  assert.equal((await h.edge(adminRequest(batch, { role: 'ai', ids: staleIds }))).status, 409);
  assert.equal((await h.edge(adminRequest(batch, { role: 'ai', auth: false, cookie }))).status, 401);
  assert.equal((await h.edge(adminRequest(rolePath(first), { role: 'ai', origin: 'https://wrong.invalid' }))).status, 403);
  assert.equal((await h.edge(adminRequest(rolePath(first), { role: 'AI' }))).status, 400);
  assert.equal(await role(first), 'unclassified');
  assert.equal(await role(second), 'unclassified');
  assert.equal((await h.edge(adminRequest(batch, { role: 'ai', ids: [first, second] }))).status, 200);
  assert.equal(await role(first), 'ai');
  assert.equal(await role(second), 'ai');
  assert.notDeepEqual(await (await h.edge(adminRequest(versionPath))).json(), beforeVersion);
  const update = await h.edge(adminRequest(rolePath(second), { role: 'human' }));
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), { recordId: second, role: 'human' });
  h.evictIndex();
  assert.equal(await role(first), 'ai');
  assert.equal(await role(second), 'human');
  const exported = await (await h.edge(adminRequest('/admin/record/' + second + '.json'))).json();
  assert.deepEqual(exported.participantRole, { schemaVersion: 'participant_role_v1', role: 'human' });
  delete exported.participantRole;
  assert.deepEqual(exported, original['record:' + second]);
  assert.deepEqual(h.snapshot(cookie), original);
  assert.deepEqual(await (await h.edge(req('/api/records', undefined, cookie))).json(), publicBefore);
  const stored = await h.indexStorage.get(roleKey(second));
  assert.deepEqual(stored, { schemaVersion: 'participant_role_v1', recordId: second, role: 'human', updatedAt: stored.updatedAt });
  const audit = Object.entries(h.indexStorage.snapshot()).filter(([key]) => key.startsWith('participant-role-audit:')).map(([, value]) => value);
  assert.equal(audit.length, 3);
  assert.ok(audit.some(entry => entry.kind === 'participant_role_set' && entry.recordId === second && entry.from === 'ai' && entry.to === 'human'));
  assert.equal((await h.edge(adminRequest(batch, { role: 'unclassified' }))).status, 200, 'role-only API uses all live trials');
  assert.equal(await role(first), 'unclassified');
  assert.equal(await role(second), 'unclassified');
});

test('I209 classifies reception-OFF and old archive-only records', async () => {
  const h = harness(roleEnv, 'off'), cookie = await h.browser();
  const current = (await (await h.object(cookie).fetch(req('/api/start', { version: 2 }))).json()).trial.sessionId;
  await h.done();
  await indexSyntheticTrial(h, cookie, current);
  const oldOwner = 'a'.repeat(64), oldId = '00000000-0000-4000-8000-000000000209';
  const old = { ...raw(), recordId: oldId };
  await h.get(oldOwner).ctx.storage.put({ ['record:' + oldId]: old });
  await h.index.upsert(summarizeRecord(old, oldOwner, summarizeLatency(old)));
  for (const id of [current, oldId]) {
    assert.equal(await adminRole(h, id), 'unclassified');
    assert.equal((await h.edge(adminRequest(rolePath(id), { role: 'ai' }))).status, 200);
    assert.equal(await adminRole(h, id), 'ai');
  }
  assert.deepEqual(await h.get(oldOwner).ctx.storage.get('record:' + oldId), old);
  await h.tasks.get(current).persistNow();
  await indexSyntheticTrial(h, cookie, current);
  await h.done();
  assert.equal(await adminRole(h, current), 'ai');
  const indexed = await h.index.get(current);
  const roleBeforeDelete = await h.indexStorage.get(roleKey(current));
  assert.equal(await h.object(cookie).adminDelete(current), true);
  // Model a failed second deletion step: the index still has the old summary and role.
  assert.equal((await h.edge(adminRequest(rolePath(current)))).status, 404);
  assert.equal((await h.edge(adminRequest(rolePath(current), { role: 'human' }))).status, 404);
  assert.deepEqual(await h.indexStorage.get(roleKey(current)), roleBeforeDelete);
  await h.index.remove([current], 'admin');
  assert.equal(await h.indexStorage.get(roleKey(current)), undefined);
  assert.equal(await h.index.upsert(indexed), false);
  assert.equal(await adminRole(h, oldId), 'ai');
});

test('deleting trial logs removes their reception links and hides the row once all trials are deleted', async () => {
  const h = harness(roleEnv), cookie = await h.browser(), r = await approved(h, cookie);
  const first = (await (await start(h, cookie)).json()).trial.sessionId;
  await h.tasks.get(first).complete();
  const second = (await (await start(h, cookie, { expectedRecordId: first })).json()).trial.sessionId;
  await h.tasks.get(second).complete();
  await h.done();
  await indexSyntheticTrial(h, cookie, first);
  await indexSyntheticTrial(h, cookie, second);
  const other = await h.browser();
  await h.edge(req('/api/reception', {}, other));
  await h.done();
  const pending = reception(h, other);
  const path = '/admin/receptions';
  const list = async () => {
    const response = await h.edge(adminRequest(path));
    assert.equal(response.status, 200);
    return response.text();
  };
  const version = async () => (await h.edge(adminRequest(path + '/version'))).json();
  const deleteLog = (id: string) => h.edge(endRequest('/admin/record/' + id + '/delete', { confirm: id }));
  const browserHistory = async (ownerCookie = cookie) => {
    const response = await h.edge(req('/api/sessions', undefined, ownerCookie));
    assert.equal(response.status, 200);
    return (await response.json()).sessions;
  };
  const before = await list(), beforeVersion = await version();
  assert.equal((await browserHistory()).length, 1);
  assert.ok(before.includes(r.receptionId) && before.includes(first) && before.includes(second));
  assert.ok(before.includes(pending.receptionId));
  assert.equal((await deleteLog(first)).status, 303);
  const partial = await list(), partialVersion = await version();
  assert.ok(partial.includes(r.receptionId) && partial.includes(second));
  assert.ok(!partial.includes(first) && !partial.includes('削除済み'));
  assert.deepEqual((await browserHistory())[0].records.map((record: any) => record.recordId), [second]);
  assert.notDeepEqual(partialVersion, beforeVersion);
  assert.ok(partial.includes(pending.receptionId));
  assert.equal((await deleteLog(second)).status, 303);
  const after = await list();
  assert.ok(!after.includes(r.receptionId) && !after.includes(first) && !after.includes(second));
  assert.ok(after.includes(pending.receptionId));
  assert.deepEqual(await browserHistory(), []);
  assert.equal((await (await h.edge(req('/api/sessions', undefined, cookie))).json()).hadDeletedReception, true);
  assert.equal((await (await h.edge(req('/api/sessions', undefined, other))).json()).hadDeletedReception, undefined);
  assert.equal((await browserHistory(other)).length, 1);
  assert.notDeepEqual(await version(), partialVersion);
  // Persisted admission identity and deletion audit remain; no other trial is deleted.
  assert.deepEqual(reception(h, cookie).trials.map((t: any) => t.recordId), [first, second]);
  assert.equal(await h.object(cookie).adminRecord(first), null);
  assert.equal(await h.object(cookie).adminRecord(second), null);
  assert.equal((await h.index.audit()).length, 2);
  h.evict(); h.evictIndex();
  assert.ok(!(await list()).includes(r.receptionId));
  assert.deepEqual(await browserHistory(), []);
  await h.done();
});

test('already deleted trial hides its reception even when the global index removal has not succeeded', async () => {
  const h = harness(roleEnv), cookie = await h.browser(), r = await approved(h, cookie);
  const id = (await (await start(h, cookie)).json()).trial.sessionId;
  await h.done();
  await indexSyntheticTrial(h, cookie, id);
  const list = async () => (await h.edge(adminRequest('/admin/receptions'))).text();
  assert.ok((await list()).includes(r.receptionId));
  assert.equal(await h.object(cookie).adminDelete(id), true);
  assert.ok(await h.index.get(id), 'index removal has not happened');
  assert.ok(!(await list()).includes(r.receptionId));
  assert.deepEqual((await (await h.edge(req('/api/sessions', undefined, cookie))).json()).sessions, []);
  const retry = await start(h, cookie);
  assert.equal(retry.status, 401, 'deleted admission has expired and cannot start again');
  assert.deepEqual(await retry.json(), { error: 'session_required' });
  await h.done();
});


test('a terminal unrecorded slot does not retain a reception after all real logs were deleted', async () => {
  const h = harness(roleEnv), cookie = await h.browser(), r = await approved(h, cookie);
  const first = (await (await start(h, cookie)).json()).trial.sessionId;
  await h.tasks.get(first).complete(); await h.done();
  await indexSyntheticTrial(h, cookie, first);
  h.object(cookie).createTrial = async () => { throw Error('synthetic second admission failure'); };
  assert.equal((await start(h, cookie, { expectedRecordId: first })).status, 409);
  const saved = reception(h, cookie);
  assert.deepEqual(saved.trials.map((t: any) => t.recordId), [first, null]);
  const list = async () => (await h.edge(adminRequest('/admin/receptions'))).text();
  const history = async () => (await (await h.edge(req('/api/sessions', undefined, cookie))).json()).sessions;
  assert.equal((await h.edge(endRequest('/admin/record/' + first + '/delete', { confirm: first }))).status, 303);
  // A recoverable admission is not a deleted experiment. Retain it until ended.
  assert.ok((await list()).includes(r.receptionId));
  assert.equal((await history()).length, 1);
  assert.equal((await h.edge(endRequest('/admin/reception/' + r.receptionId + '/force-end',
    { confirm: saved.number, expectedRevision: String(saved.revision) }))).status, 303);
  await h.done();
  assert.ok(!(await list()).includes(r.receptionId));
  assert.deepEqual(await history(), []);
  assert.deepEqual(reception(h, cookie).trials.map((t: any) => t.recordId), [first, null]);
  assert.equal((await h.index.audit()).length, 1);
  h.evict(); h.evictIndex();
  assert.ok(!(await list()).includes(r.receptionId));
  assert.deepEqual(await history(), []);
  await h.done();
});
