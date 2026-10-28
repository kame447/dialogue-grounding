import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clone, config, raw } from './support/s5-base/support.ts';

// Real edge → session DO → AdminIndex. Only the model/task factory is replaced.
// Synthetic settings exercise the mechanism; none is a research choice.
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
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init); }
};
const RF = 'repair-first', BE = 'bypass-enabled';
const fields = (patch: Record<string, unknown> = {}) => ({ allowedOrders: [[BE, RF], [RF]], seedPolicy: 'per_trial', referenceMemory: false,
  betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0', ...patch });
const answers = { mental_effort: 4, task_difficulty: 4, smoothness: 4, bothersome: 4 };
const req = (path: string, body?: unknown, cookie?: string) => new Request('https://i139.invalid' + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function memory() {
  let values = new Map<string, any>(), queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const view = (map: Map<string, any>) => ({
    async get(key: string) { return clone(map.get(key)); },
    async put(updates: Record<string, unknown>) { for (const [k, v] of Object.entries(updates)) map.set(k, clone(v)); },
    async delete(keys: string | string[]) { let n = 0; for (const k of Array.isArray(keys) ? keys : [keys]) n += Number(map.delete(k)); return n; },
    async list({ prefix, reverse, limit }: { prefix: string; reverse?: boolean; limit?: number }) {
      let rows = [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows.reverse(); if (limit) rows = rows.slice(0, limit); return new Map(rows);
    },
  });
  return { snapshot: () => clone(Object.fromEntries(values)), set: (k: string, v: unknown) => values.set(k, clone(v)), remove: (k: string) => values.delete(k),
    get: (k: string) => view(values).get(k), put: (u: Record<string, unknown>) => enqueue(() => view(values).put(u)),
    delete: (k: string | string[]) => enqueue(() => view(values).delete(k)), list: (o: any) => view(values).list(o),
    transaction(fn: (tx: any) => Promise<any>) { return enqueue(async () => { const staged = clone(values), r = await fn(view(staged)); values = staged; return r; }); },
    async setAlarm() {}, async deleteAlarm() {} };
}
/** workerd RPC results carry a non-enumerable function-valued Symbol.dispose. */
function rpc(target: any, control: { down: boolean }) {
  return new Proxy(target, { get(t, key) {
    const value = t[key];
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      if (control.down) throw new Error('synthetic index outage');
      const result = await value.apply(t, args);
      if (result && typeof result === 'object') Object.defineProperty(result, Symbol.dispose, { value() {}, enumerable: false });
      return result;
    };
  } });
}
function harness() {
  const stores = new Map<string, ReturnType<typeof memory>>(), objects = new Map<string, any>(), tasks = new Map<string, any>(), inputs: any[] = [];
  const pending: Promise<unknown>[] = []; let modelCalls = 0;
  const indexStorage = memory(), index = new AdminIndex({ storage: indexStorage }, {}), control = { down: false };
  const objectEnv: any = { BASE_ASSIGNMENT_JSON: JSON.stringify(config()), RECEPTION_REQUIRED: 'on',
    ADMIN_INDEX: { idFromName: (id: string) => id, get: () => rpc(index, control) },
    AI_PROXY: { async chat() { modelCalls++; throw Error('no synthetic test may call a model'); } } };
  function get(id: string) {
    if (!stores.has(id)) stores.set(id, memory());
    if (!objects.has(id)) {
      const o = new TangramSession({ storage: stores.get(id), id: { toString: () => id }, waitUntil(p: Promise<unknown>) { pending.push(p); } }, objectEnv);
      o.createTrial = async (input: any) => {
        inputs.push({ ...input, restore: input.restore ? clone(input.restore) : null });
        const record = clone(input.restore ?? raw());
        if (!input.restore) {
          record.recordId = crypto.randomUUID(); record.seed = input.seed; record.strategy = input.strategy; record.options.referenceMemory = input.referenceMemory;
          // Stands in for implementer A's task: new records carry the mode and generated stimulus.
          record.options.rotationMode = input.rotationMode;
          record.stimulus = { version: 'synthetic-stimulus-v1', rotationMode: input.rotationMode, angles: { human: { h1: 0 }, ai: { a1: 0 } } };
        }
        const task = { getState: () => ({ version: 2, sessionId: record.recordId, status: record.status, events: [], submitted: record.status === 'completed', aiSubmitted: record.status === 'completed' }),
          persistNow: async () => input.onPersist(clone(record)), whenIdle: async () => {}, message: () => ({ eventId: 'synthetic', duplicate: false }),
          retry: async () => {}, submitHuman: async () => ({}), submitAI: async () => ({}),
          complete: async () => { record.status = 'completed'; record.closed = true; await input.onPersist(clone(record)); } };
        tasks.set(record.recordId, task); await input.onPersist(clone(record)); return task;
      };
      objects.set(id, o);
    }
    return objects.get(id);
  }
  const env = { ...objectEnv, NAMING_SESSIONS: { idFromName: (id: string) => id, idFromString: (id: string) => id, get },
    ASSETS: { async fetch() { return new Response('<html></html>'); } }, START_RATE_LIMIT: { async limit() { return { success: true }; } },
    QUESTIONNAIRE_RATE_LIMIT: { async limit() { return { success: true }; } } };
  const h = { index, indexStorage, control, tasks, inputs, get, stores,
    edge: (r: Request) => edge.fetch(r, env) as Promise<Response>,
    async browser() { const r = await edge.fetch(req('/'), env); assert.equal(r.status, 200); return r.headers.get('set-cookie')!.split(';')[0]; },
    object: (cookie: string) => get(cookie.split('=')[1]),
    snapshot: (cookie: string) => stores.get(cookie.split('=')[1])!.snapshot(),
    evict() { objects.clear(); },
    async done() { await Promise.all(pending); assert.equal(modelCalls, 0); },
    async protocol(patch: Record<string, unknown> = {}) {
      const current = (await index.readReceptionSettings()).protocol;
      const r = await index.saveReceptionProtocol({ expectedRevision: current?.revision ?? 0, fields: fields(patch) }); assert.equal(r.ok, true);
    },
    async mode(value: 'on' | 'off') { const m = (await index.readReceptionSettings()).mode; const r = await index.saveReceptionMode({ expectedRevision: m.revision, value }); assert.equal(r.ok, true); },
    async displayed() { const p = (await index.readReceptionSettings()).protocol; return { protocolId: p.protocol.protocolId, revision: p.revision, sha256: p.sha256 }; },
  };
  return h;
}
type H = ReturnType<typeof harness>;
const receive = async (h: H, cookie: string) => { const r = await h.edge(new Request('https://i139.invalid/api/reception', { method: 'POST', headers: { Cookie: cookie } })); return r; };
const reception = (h: H, cookie: string) => h.snapshot(cookie)['reception:v1'];
async function approve(h: H, cookie: string, order = 0) {
  assert.equal((await receive(h, cookie)).status, 200);
  return h.object(cookie).adminApproveReception({ expectedRevision: reception(h, cookie).revision, order, protocol: await h.displayed() });
}
const start = (h: H, cookie: string, patch: Record<string, unknown> = {}) => h.edge(req('/api/start', { version: 2, expectedReceptionRevision: reception(h, cookie).revision, ...patch }, cookie));
const state = async (h: H, cookie: string) => (await h.edge(req('/api/state', undefined, cookie))).json();
const errorOf = async (r: Response) => (await r.json()).error;
async function configured(patch: Record<string, unknown> = {}) { const h = harness(); await h.protocol(patch); await h.mode('on'); return h; }

test('env reception values are ignored: unsaved settings keep the legacy flow even with RECEPTION_REQUIRED=on', async () => {
  const h = harness(), cookie = await h.browser();
  assert.equal(Object.hasOwn(await state(h, cookie), 'reception'), false);
  assert.equal((await receive(h, cookie)).status, 404);
  const r = await h.edge(req('/api/start', { version: 2 }, cookie)); assert.equal(r.status, 200);
  const record = h.snapshot(cookie)['base:owner:v1'].admissions.initial.record;
  assert.equal(record.assignment.source.kind, 'server_config_v1'); assert.equal(h.inputs[0].rotationMode, 'relative_pm90');
  assert.equal(reception(h, cookie), undefined); await h.done();
});

test('D1: approval uses one snapshot; a stale protocol version or stale reception revision creates no plan', async () => {
  const h = await configured(), cookie = await h.browser(); assert.equal((await receive(h, cookie)).status, 200);
  const shown = await h.displayed(), o = h.object(cookie);
  await h.protocol({ rotationMode: 'relative_pm90' });
  const before = h.snapshot(cookie);
  await assert.rejects(() => o.adminApproveReception({ expectedRevision: 0, order: 1, protocol: shown }), (e: any) => e.message === 'protocol_changed');
  assert.deepEqual(h.snapshot(cookie), before);
  const current = await h.displayed();
  await assert.rejects(() => o.adminApproveReception({ expectedRevision: 1, order: 0, protocol: current }), (e: any) => e.message === 'reception_conflict');
  assert.deepEqual(h.snapshot(cookie), before);
  for (const bad of [undefined, { ...(await h.displayed()), extra: 1 }])
    await assert.rejects(() => o.adminApproveReception({ expectedRevision: 0, order: 0, protocol: bad }), (e: any) => e.message === 'protocol_changed');
  const fresh = await h.displayed();
  await o.adminApproveReception({ expectedRevision: 0, order: 0, protocol: fresh });
  const plan = reception(h, cookie).plan;
  assert.equal(plan.schemaVersion, 'reception_plan_v2'); assert.equal(plan.protocolRevision, fresh.revision); assert.equal(plan.protocolSha256, fresh.sha256);
  assert.deepEqual(plan.trials.map((t: any) => t.rotationMode), ['relative_pm90', 'relative_pm90']);
  // Concurrent save and approval: whichever order wins, the frozen plan matches the displayed version or nothing is approved.
  for (let i = 0; i < 4; i++) {
    const g = await configured(), c = await g.browser(); assert.equal((await receive(g, c)).status, 200);
    const shownNow = await g.displayed();
    const [, approval] = await Promise.allSettled([g.protocol({ rotationMode: 'relative_pm90' }),
      g.object(c).adminApproveReception({ expectedRevision: 0, order: 0, protocol: shownNow })]);
    const saved = reception(g, c);
    if (approval.status === 'fulfilled') { assert.equal(saved.plan.protocolSha256, shownNow.sha256); assert.equal(saved.plan.trials[0].rotationMode, 'relative_0'); }
    else { assert.equal(saved.status, 'pending'); assert.equal(saved.plan, null); }
  }
  await h.done();
});

test('the plan mode reaches only new tasks, both strategies get the same mode, and restore takes it from the record', async () => {
  for (const rotationMode of ['relative_pm90', 'relative_0']) {
    const h = await configured({ rotationMode }), cookie = await h.browser(); await approve(h, cookie);
    const r1 = await start(h, cookie); assert.equal(r1.status, 200); const first = (await r1.json()).trial.sessionId;
    await h.tasks.get(first).complete();
    assert.equal((await start(h, cookie, { expectedRecordId: first })).status, 200);
    const fresh = h.inputs.filter(i => !i.restore);
    assert.deepEqual(fresh.map(i => [i.strategy, i.rotationMode]), [[BE, rotationMode], [RF, rotationMode]]);
    await h.protocol({ rotationMode: rotationMode === 'relative_0' ? 'relative_pm90' : 'relative_0' });
    h.evict(); h.inputs.length = 0;
    assert.equal((await state(h, cookie)).trial.status, 'dialogue');
    const restored = h.inputs.find(i => i.restore);
    assert.ok(restored); assert.equal(Object.hasOwn(restored, 'rotationMode'), false); assert.equal(restored.restore.options.rotationMode, rotationMode);
    await h.done();
  }
});

test('records whose mode or stimulus disagrees with the plan are rejected in both the owner copy and the archive', async () => {
  for (const side of ['owner', 'archive'] as const) for (const damage of ['mode', 'stimulus', 'missing']) {
    const h = await configured(), cookie = await h.browser(); await approve(h, cookie);
    const id = (await (await start(h, cookie)).json()).trial.sessionId;
    const store = h.stores.get(cookie.split('=')[1])!, snap = store.snapshot();
    const edit = (record: any) => { if (damage === 'mode') record.options.rotationMode = 'relative_pm90';
      else if (damage === 'stimulus') record.stimulus.rotationMode = 'relative_pm90'; else { delete record.options.rotationMode; delete record.stimulus; } };
    if (side === 'owner') { const owner = snap['base:owner:v1']; edit(owner.admissions.initial.record); store.set('base:owner:v1', owner); }
    else { const record = snap['record:' + id]; edit(record); store.set('record:' + id, record); }
    h.evict();
    await assert.rejects(() => h.object(cookie).adminRecord(id));
    const s = await h.edge(req('/api/state', undefined, cookie)); assert.notEqual((await s.json()).trial?.sessionId, id, side + ' ' + damage + ' must not restore');
    await h.done();
  }
});

// D2: the owner class comes from stored state; the global mode matters only for new starts, new receptions,
// approvals and prepare-next. Existing trials never read the settings.
type Owner = 'unused' | 'pending' | 'cancelled' | 'approved' | 'in_progress' | 'finished' | 'legacy' | 'legacy_active';
async function build(owner: Owner) {
  const h = harness(); await h.protocol(); let cookie: string, recordId: string | null = null;
  if (owner === 'legacy' || owner === 'unused') {
    cookie = await h.browser();
    if (owner === 'legacy') { const r = await h.edge(req('/api/start', { version: 2 }, cookie)); assert.equal(r.status, 200); recordId = (await r.json()).trial.sessionId; await h.tasks.get(recordId!).complete(); }
    await h.mode('on');
  } else if (owner === 'legacy_active') {
    await h.mode('on'); const id = 'b'.repeat(64); cookie = 'tangram_session=' + id; h.get(id);
    const record = clone(raw()); recordId = record.recordId = crypto.randomUUID();
    h.stores.get(id)!.set('active', record);
  } else {
    await h.mode('on'); cookie = await h.browser();
    if (owner === 'pending' || owner === 'cancelled') assert.equal((await receive(h, cookie)).status, 200);
    else await approve(h, cookie, owner === 'finished' ? 1 : 0);
    if (owner === 'cancelled') await h.object(cookie).adminCancelReception({ expectedRevision: 0 });
    if (owner === 'in_progress' || owner === 'finished') { recordId = (await (await start(h, cookie)).json()).trial.sessionId; await h.tasks.get(recordId!).complete(); }
  }
  return { h, cookie: cookie!, recordId };
}
const expectations: Record<Owner, Record<'on' | 'off' | 'fail', { state: string | null; start: number; prepare?: number }>> = {
  unused: { on: { state: 'waiting', start: 409 }, off: { state: null, start: 200 }, fail: { state: 'unavailable', start: 409 } },
  pending: { on: { state: 'waiting', start: 409 }, off: { state: 'waiting', start: 409 }, fail: { state: 'waiting', start: 409 } },
  cancelled: { on: { state: 'unavailable', start: 409 }, off: { state: 'unavailable', start: 409 }, fail: { state: 'unavailable', start: 409 } },
  approved: { on: { state: 'ready', start: 200 }, off: { state: 'ready', start: 200 }, fail: { state: 'unavailable', start: 409 } },
  in_progress: { on: { state: 'in_progress', start: 200, prepare: 409 }, off: { state: 'in_progress', start: 200, prepare: 409 }, fail: { state: 'unavailable', start: 409, prepare: 409 } },
  finished: { on: { state: 'finished', start: 409, prepare: 409 }, off: { state: 'finished', start: 409, prepare: 409 }, fail: { state: 'finished', start: 409, prepare: 409 } },
  legacy: { on: { state: null, start: 409, prepare: 409 }, off: { state: null, start: 200, prepare: 201 }, fail: { state: null, start: 409, prepare: 409 } },
  legacy_active: { on: { state: null, start: 409 }, off: { state: null, start: 409 }, fail: { state: null, start: 409 } },
};
for (const owner of Object.keys(expectations) as Owner[]) for (const mode of ['on', 'off', 'fail'] as const) test(`D2 ${owner} owner with settings ${mode}`, async () => {
  const { h, cookie, recordId } = await build(owner), expected = expectations[owner][mode];
  if (mode === 'off') await h.mode('off');
  if (mode === 'fail') h.control.down = true;
  for (const evicted of [false, true]) {
    if (evicted) h.evict();
    const s = await state(h, cookie);
    assert.equal(s.reception?.status ?? null, expected.state, 'state ' + (evicted ? 'after recreation' : 'long-lived'));
    if (s.reception) assert.deepEqual(Object.keys(s.reception).sort(), ['number', 'revision', 'status']);
  }
  const before = h.snapshot(cookie), factories = h.inputs.filter(i => !i.restore).length;
  const hadReception = Object.hasOwn(before, 'reception:v1'), hadOwner = Object.hasOwn(before, 'base:owner:v1');
  const body = hadReception ? { version: 2, expectedReceptionRevision: reception(h, cookie).revision, ...(recordId ? { expectedRecordId: recordId } : {}) } : { version: 2 };
  const r = await h.edge(req('/api/start', body, cookie));
  assert.equal(r.status, expected.start, 'start');
  // A legacy owner's start only returns its completed trial; it never creates another one.
  if (owner === 'legacy') assert.equal(h.inputs.filter(i => !i.restore).length, factories);
  if (expected.start !== 200) {
    const after = h.snapshot(cookie);
    assert.equal(h.inputs.filter(i => !i.restore).length, factories, 'no new task'); assert.deepEqual(after['reception:v1'], before['reception:v1']);
    assert.equal(Object.hasOwn(after, 'reception:v1'), hadReception, 'no reception created'); assert.equal(Object.hasOwn(after, 'base:owner:v1'), hadOwner, 'no owner promotion');
    if (owner === 'legacy' && mode === 'on') assert.equal(await errorOf(r), 'reception_required');
  }
  if (expected.prepare !== undefined && recordId) {
    const p = await h.object(cookie).adminPrepareNext(recordId).then(() => 201, () => 409);
    assert.equal(p, expected.prepare, 'prepare-next');
  }
  // A reception is never created for an owner that is not unused, nor while settings are off or unreadable.
  const created = await receive(h, cookie);
  if (owner === 'unused' && mode === 'on') assert.equal(created.status, 200);
  else if (!hadReception) { assert.notEqual(created.status, 200); assert.equal(Object.hasOwn(h.snapshot(cookie), 'reception:v1'), false); }
  if (recordId && owner !== 'legacy_active') assert.equal((await h.edge(req(`/api/records/${recordId}/questionnaire`, { answers, comment: '', submit: true }, cookie))).status, 200, 'existing questionnaire never reads settings');
  if (owner === 'legacy_active') assert.ok(await h.object(cookie).adminRecord(recordId!), 'legacy evidence stays readable');
  await h.done();
});

test('D2: off closes pending approval; settings that cannot be read never count as off', async () => {
  const h = await configured(), cookie = await h.browser(); assert.equal((await receive(h, cookie)).status, 200);
  await h.mode('off');
  await assert.rejects(async () => h.object(cookie).adminApproveReception({ expectedRevision: 0, order: 0, protocol: await h.displayed() }), (e: any) => e.message === 'reception_closed');
  const fresh = harness(), c = await fresh.browser(); await fresh.protocol(); await fresh.mode('on'); await fresh.mode('off');
  fresh.indexStorage.remove('reception-mode:current'); // history remains: damaged, not unsaved
  const s = await state(fresh, c); assert.equal(s.reception?.status, 'unavailable');
  assert.equal((await fresh.edge(req('/api/start', { version: 2 }, c))).status, 409);
  assert.equal(fresh.inputs.length, 0); await h.done(); await fresh.done();
});

test('D3: questionnaire_required is frozen in the plan and needs this predecessor\'s valid submitted questionnaire', async () => {
  const h = await configured({ betweenTrials: 'questionnaire_required' }), cookie = await h.browser(); await approve(h, cookie);
  assert.equal(reception(h, cookie).plan.betweenTrials, 'questionnaire_required');
  const first = (await (await start(h, cookie)).json()).trial.sessionId; await h.tasks.get(first).complete();
  await h.protocol({ betweenTrials: 'none' });
  const store = h.stores.get(cookie.split('=')[1])!;
  const valid = { version: 'provisional-v0', status: 'submitted', answers, comment: '', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', submittedAt: '2026-10-28T00:00:00.000Z' };
  const nextBody = () => ({ expectedRecordId: first });
  const blocked = async (label: string) => {
    const before = h.snapshot(cookie), count = h.inputs.length;
    const r = await start(h, cookie, nextBody()); assert.equal(r.status, 409, label); assert.equal(await errorOf(r), 'questionnaire_required', label);
    assert.deepEqual(h.snapshot(cookie), before, label); assert.equal(h.inputs.length, count, label);
  };
  assert.equal((await state(h, cookie)).reception.status, 'questionnaire');
  await blocked('none saved');
  const draft = await h.edge(req(`/api/records/${first}/questionnaire`, { answers: { mental_effort: 4 }, comment: '', submit: false }, cookie)); assert.equal(draft.status, 200);
  await blocked('draft');
  const qKey = Object.keys(store.snapshot()).find(k => k !== 'record:' + first && k.endsWith(first) && JSON.stringify(store.snapshot()[k]).includes('provisional-v0'))!;
  assert.ok(qKey, 'questionnaire storage key');
  const without = (name: string) => { const v: any = clone(valid); delete v[name]; return v; };
  for (const [label, value] of [['missing comment', without('comment')], ['numeric comment', { ...valid, comment: 1 }], ['bad submittedAt', { ...valid, submittedAt: 'yesterday' }],
    ['null submittedAt', { ...valid, submittedAt: null }], ['bad createdAt', { ...valid, createdAt: '2026-10-28' }], ['missing answer', { ...valid, answers: { ...answers, bothersome: null } }],
    ['extra answer', { ...valid, answers: { ...answers, extra: 4 } }], ['out of range', { ...valid, answers: { ...answers, smoothness: 8 } }],
    ['other version', { ...valid, version: 'provisional-v1' }], ['extra field', { ...valid, recordId: first }], ['draft status', { ...valid, status: 'draft' }]] as const) {
    store.set(qKey, value); await blocked(label);
  }
  // A valid submitted answer stored under another record's key does not count for this predecessor.
  store.remove(qKey); store.set(qKey.replace(first, '99999999-9999-4999-8999-999999999999'), valid); await blocked('other record');
  h.evict(); await blocked('after recreation');
  const submitted = await h.edge(req(`/api/records/${first}/questionnaire`, { answers, comment: '', submit: true }, cookie)); assert.equal(submitted.status, 200);
  assert.equal((await state(h, cookie)).reception.status, 'in_progress');
  const both = await Promise.all([start(h, cookie, nextBody()), start(h, cookie, nextBody())]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409]); assert.equal(reception(h, cookie).trials.length, 2);
  await h.done();
});

test('D3: a none plan never waits for a questionnaire, even after the protocol is re-saved as required', async () => {
  const h = await configured(), cookie = await h.browser(); await approve(h, cookie);
  const first = (await (await start(h, cookie)).json()).trial.sessionId; await h.tasks.get(first).complete();
  await h.protocol({ betweenTrials: 'questionnaire_required' });
  assert.equal((await state(h, cookie)).reception.status, 'in_progress');
  assert.equal((await start(h, cookie, { expectedRecordId: first })).status, 200); await h.done();
});

test('legacy v1 plans and their records restore as the old mechanism', async () => {
  const h = await configured(), cookie = await h.browser(); assert.equal((await receive(h, cookie)).status, 200);
  const { approveReception }: any = await import(pathToFileURL(root + '/dialogue-model/runtime/v2/reception.ts').href);
  const store = h.stores.get(cookie.split('=')[1])!;
  const v1 = { schemaVersion: 'reception_protocol_v1', protocolId: '22222222-2222-4222-8222-222222222222', revision: 1, allowedOrders: [[RF]],
    seedPolicy: 'shared', referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3' };
  store.set('reception:v1', await approveReception(reception(h, cookie), { expectedRevision: 0, order: 0, protocol: v1, approvedAt: '2026-10-28T00:00:00.000Z', randomSeed: () => 7 }));
  h.evict();
  const r = await start(h, cookie); assert.equal(r.status, 200);
  const id = (await r.json()).trial.sessionId, record = h.snapshot(cookie)['record:' + id];
  assert.equal(record.assignment.source.kind, 'reception_plan_v1'); assert.equal(h.inputs.at(-1).rotationMode, 'relative_pm90');
  h.evict(); assert.equal((await state(h, cookie)).trial.sessionId, id); await h.done();
});

test('participant state, errors and HTML never expose settings, mode, angles or plan values', async () => {
  const h = await configured({ betweenTrials: 'questionnaire_required' }), cookie = await h.browser(); await approve(h, cookie);
  const first = (await (await start(h, cookie)).json()).trial.sessionId; await h.tasks.get(first).complete();
  const leaks = /relative_|rotation|stimulus|angles|betweenTrials|questionnaire_required"|protocol|reception_plan|seed|strategy|repair-first|bypass-enabled/u;
  for (const r of [await h.edge(req('/api/state', undefined, cookie)), await start(h, cookie, { expectedRecordId: first }), await h.edge(req('/', undefined, cookie))]) {
    const text = await r.text(); assert.doesNotMatch(text.replace('"error":"questionnaire_required"', ''), leaks);
  }
  await h.done();
});

test('D2: a deployment without the AdminIndex binding never falls back to the legacy start or prepare-next', async () => {
  const h = harness(), cookie = await h.browser();
  const o = h.object(cookie); o.env = { ...o.env, ADMIN_INDEX: undefined };
  const s = await (await o.fetch(req('/api/state'))).json(); assert.equal(s.reception?.status, 'unavailable');
  const r = await o.fetch(req('/api/start', { version: 2 })); assert.equal(r.status, 409);
  assert.equal(h.inputs.length, 0); assert.equal(h.snapshot(cookie)['base:owner:v1'].activeKey, null);
  assert.equal((await o.fetch(new Request('https://i139.invalid/api/reception', { method: 'POST' }))).status, 409);
  assert.equal(Object.hasOwn(h.snapshot(cookie), 'reception:v1'), false);
  // A legacy owner with a completed predecessor: prepare-next is refused and nothing changes.
  const legacy = await h.browser(), started = await h.edge(req('/api/start', { version: 2 }, legacy)); assert.equal(started.status, 200);
  const predecessor = (await started.json()).trial.sessionId; await h.tasks.get(predecessor).complete();
  const lo = h.object(legacy); lo.env = { ...lo.env, ADMIN_INDEX: undefined };
  const before = h.snapshot(legacy), count = h.inputs.filter(i => !i.restore).length;
  await assert.rejects(() => lo.adminPrepareNext(predecessor), (e: any) => e?.name === 'ReceptionError' && e.message === 'reception_unavailable');
  assert.deepEqual(h.snapshot(legacy), before); assert.equal(h.inputs.filter(i => !i.restore).length, count);
  await h.done();
});
