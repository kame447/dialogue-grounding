import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load, clone, harness, sessionError } from './support/s5-base/support.ts';
import { researcherOffAdminIndex } from './support/i139-researcher-off-admin-index.ts';
registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
const root = process.env.S5_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { TangramSession, AdminIndex }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/index.ts').href);
const { readOwner }: any = await import(pathToFileURL(root + '/dialogue-model/runtime/v2/base-assignment-data.ts').href);
const { trialTerminationExpectation } = await import('../workers/tangram-experiment/src/admin/trial-termination.ts');
const now = 946684800001, oldNow = Date.now;
Date.now = () => now; after(() => { Date.now = oldNow; });
const ownerKey = 'base:owner:v1';
const ids = ['b9771f3f-39e6-4c4a-bfa7-6499de23959f', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const text = (id: string) => 'SYNTHETIC-PRIVATE-UTTERANCE-' + id;
function fixture(legacy = false) {
  const input = load('WORKER-MATCHING-STORAGE.json'), owner = input[ownerKey];
  for (let i = 0; i < ids.length; i++) {
    const record = clone(input['record:' + ids[0]]);
    record.recordId = ids[i]; record.events = [{ id: 'synthetic', speaker: 'human', text: text(ids[i]) }];
    record.assignment.assignmentId = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'][i];
    record.status = i === 2 ? 'dialogue' : 'completed'; record.closed = i !== 2;
    record.queueState.pendingHumanEventIds = []; record.queueState.errorCode = null;
    const key = i === 0 ? 'initial' : 'after:' + ids[i - 1];
    owner.admissions[key] = { schemaVersion: 'base_assigned_session_v1', assignment: clone(record.assignment), status: 'active', record: clone(record), errorCode: null };
    owner.activeKey = key; input.active = clone(record); input['record:' + ids[i]] = record;
    input.ledger[ids[i]] = now - 1;
    input['questionnaire:' + ids[i]] = { comment: text(ids[i]) };
  }
  const factory = harness({ state: owner, adapter: 'worker_binding' });
  if (legacy) {
    delete input[ownerKey]; delete input.active.assignment;
    for (const id of ids) delete input['record:' + id].assignment;
  }
  let values = new Map<string, any>(Object.entries(input)), inTransaction = false;
  const controls = { fail: '' }, mutations: boolean[] = [], pending: Promise<unknown>[] = [];
  const storage = {
    async get(key: string) { return clone(values.get(key)); },
    async put(entries: Record<string, unknown>) {
      mutations.push(inTransaction);
      for (const [k, v] of Object.entries(entries)) values.set(k, clone(v));
      if (controls.fail === 'put') throw Error('synthetic-storage-failure');
    },
    async delete(keys: string | string[]) {
      mutations.push(inTransaction); let count = 0;
      for (const k of Array.isArray(keys) ? keys : [keys]) count += Number(values.delete(k));
      if (controls.fail === 'delete') throw Error('synthetic-storage-failure');
      return count;
    },
    async transaction(fn: (tx: any) => Promise<any>) {
      const before = clone(values); inTransaction = true;
      try { return await fn(this); } catch (e) { values = before; throw e; } finally { inTransaction = false; }
    },
    async setAlarm() {}, async deleteAlarm() {},
  };
  const object = () => {
    const o = new TangramSession({ storage, id: { toString: () => owner.ownerId }, waitUntil(p: Promise<unknown>) { pending.push(p); } },
      { RECORD_RETENTION_DAYS: '30', ADMIN_INDEX: researcherOffAdminIndex(AdminIndex), AI_PROXY: { async chat() { assert.fail('no real or mock upstream call expected'); } } });
    o.createTrial = factory.options.makeTask;
    return o;
  };
  return { o: object(), object, storage, controls, mutations, factory, fingerprint: () => JSON.stringify([...values]),
    done: () => Promise.all(pending) };
}
function assertNoRecord(value: any, id: string): void {
  assert.ok(!JSON.stringify(value).includes(text(id)), 'deleted utterance must be absent throughout owner state');
  if (value && typeof value === 'object') {
    assert.notEqual(value.recordId, id, 'no full record or record projection may remain');
    for (const child of Object.values(value)) assertNoRecord(child, id);
  }
}
for (const mode of ['assigned', 'legacy archive', 'legacy active only']) {
  test('force end preserves ' + mode + ' record and rolls back an interrupted write', async () => {
    const x = fixture(mode !== 'assigned'), id = ids[2], key = 'record:' + id;
    if (mode === 'legacy active only') {
      await x.storage.delete(key);
      const ledger = await x.storage.get('ledger');
      delete ledger[id];
      await x.storage.put({ ledger });
    }
    const raw = await x.storage.get('active'), questionnaire = await x.storage.get('questionnaire:' + id);
    const preceding = await x.storage.get('record:' + ids[1]);
    const expected = trialTerminationExpectation(await x.o.adminRecord(id));
    assert.ok(expected);
    const before = x.fingerprint();
    x.controls.fail = 'put';
    await assert.rejects(x.o.adminForceEndRecord(id, expected), /synthetic-storage-failure/u);
    assert.equal(x.fingerprint(), before);
    x.controls.fail = '';
    assert.deepEqual(await x.o.adminForceEndRecord(ids[1], expected), { ok: false, error: 'conflict' });
    assert.deepEqual(await x.o.adminForceEndRecord(id, expected), { ok: true });
    const stored = await x.storage.get(key);
    assert.deepEqual(stored, { ...raw, status: 'interrupted', updatedAt: stored.termination.at, termination: { at: stored.updatedAt, by: 'admin' } });
    assert.deepEqual(await x.storage.get('active'), stored);
    assert.deepEqual(await x.storage.get('questionnaire:' + id), questionnaire);
    assert.deepEqual(await x.storage.get('record:' + ids[1]), preceding);
    const owner = await x.storage.get(ownerKey);
    if (mode === 'assigned') assert.deepEqual(owner.admissions[owner.activeKey].record, stored);
    else assert.equal(owner, undefined);
    const after = x.fingerprint(), cold = x.object();
    assert.deepEqual(await cold.adminForceEndRecord(id, expected), { ok: true });
    assert.equal(x.fingerprint(), after);
    const state = await cold.fetch(new Request('https://synthetic.invalid/api/state'));
    assert.equal(state.status, 200);
    assert.equal((await state.json()).interrupted, true);
    assert.equal(x.factory.tasks.length, 0);
    await x.done();
  });
}
test('admin deletion scrubs retired owner copy atomically, preserves current restore and after-key idempotency', async () => {
  const x = fixture(), before = await x.storage.get(ownerKey), active = await x.storage.get('active');
  assert.equal(await x.o.adminDelete(ids[1]), true);
  const owner = readOwner(await x.storage.get(ownerKey), before.ownerId);
  assertNoRecord(owner, ids[1]);
  assert.deepEqual(owner.admissions['after:' + ids[0]], { ...before.admissions['after:' + ids[0]], record: null, status: 'failed', errorCode: 'record_deleted' });
  assert.equal(owner.revision, before.revision + 1); assert.equal(owner.activeKey, before.activeKey);
  assert.deepEqual(owner.admissions.initial, before.admissions.initial);
  assert.deepEqual(owner.admissions[owner.activeKey], before.admissions[before.activeKey]);
  assert.deepEqual(await x.storage.get('active'), active);
  assert.equal(await x.storage.get('record:' + ids[1]), undefined); assert.equal(await x.storage.get('questionnaire:' + ids[1]), undefined);
  assert.equal((await x.storage.get('ledger'))[ids[1]], undefined); assert.ok((await x.storage.get('tombstones')).includes(ids[1]));
  assert.ok(x.mutations.every(Boolean), 'all deletion writes must share the storage transaction');
  assert.equal(await x.o.adminRecord(ids[1]), null); assert.ok(await x.o.adminRecord(ids[0])); assert.ok(await x.o.adminRecord(ids[2]));
  await assert.rejects(x.o.adminPrepareNext(ids[0]), sessionError('not_found'));
  const cold = x.object(), response = await cold.fetch(new Request('https://synthetic.invalid/api/state'));
  assert.equal(response.status, 200); assert.equal((await response.json()).trial.sessionId, ids[2]);
  assert.deepEqual(x.factory.tasks[0].input.restore, active);
  const revision = (await x.storage.get(ownerKey)).revision;
  assert.equal(await cold.adminDelete(ids[1]), false); assert.equal((await x.storage.get(ownerKey)).revision, revision);
  await x.done();
});
test('deleting current admission removes all copies and rejects a late live callback and cold restart', async () => {
  const x = fixture();
  assert.equal((await x.o.fetch(new Request('https://synthetic.invalid/api/state'))).status, 200);
  assert.equal(await x.o.adminDelete(ids[2]), true);
  const owner = await x.storage.get(ownerKey); readOwner(owner, owner.ownerId); assertNoRecord(owner, ids[2]);
  assert.equal(await x.storage.get('active'), undefined);
  const before = x.fingerprint();
  await assert.rejects(x.factory.tasks[0].emit({ updatedAt: new Date(now).toISOString() }), sessionError('owner_expired'));
  assert.equal(x.fingerprint(), before);
  assert.equal(await x.object().baseOwnerStatus(), 'expired');
  const r = await x.object().fetch(new Request('https://synthetic.invalid/api/state'));
  assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'session_required' }); await x.done();
});
for (const fail of ['put', 'delete']) test('admin deletion rolls back every copy when storage fails during ' + fail, async () => {
  const x = fixture(), before = x.fingerprint(); x.controls.fail = fail;
  await assert.rejects(x.o.adminDelete(ids[1]), /synthetic-storage-failure/);
  assert.equal(x.fingerprint(), before); x.controls.fail = '';
  assert.equal(await x.o.adminDelete(ids[1]), true); assertNoRecord(await x.storage.get(ownerKey), ids[1]); await x.done();
});
test('legacy ownerless archive remains readable before and after deleting another legacy record', async () => {
  const x = fixture(true), before = await x.o.adminRecord(ids[0]);
  assert.ok(before); assert.equal(await x.o.adminDelete(ids[1]), true);
  assert.deepEqual(await x.o.adminRecord(ids[0]), before); assert.equal(await x.storage.get(ownerKey), undefined); await x.done();
});
