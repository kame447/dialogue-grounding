import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load, clone } from './support/s5-base/support.ts';
registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
const root = process.env.S5_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { TangramSession }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/index.ts').href);
const { validateBoundBaseRecord }: any = await import(pathToFileURL(root + '/dialogue-model/runtime/v2/base-assignment.ts').href);
const oldNow = Date.now; Date.now = () => 946684800001; after(() => { Date.now = oldNow; });
const initial = load('WORKER-MATCHING-STORAGE.json');
const target = initial['base:owner:v1'].admissions.initial.record.recordId;
const badId = '99999999-9999-4999-8999-999999999999';
const refusal = (e: any) => { assert.equal(e.name, 'BaseAssignmentError'); assert.equal(e.code, 'assignment_record_invalid'); assert.equal(e.message, 'assignment_record_invalid'); return true; };
function fixture(kind = 'matching') {
  const input = clone(initial), record = input['record:' + target], owner = input['base:owner:v1'];
  if (kind === 'foreign' || kind === 'retired_foreign') {
    record.assignment.assignmentId = badId;
    validateBoundBaseRecord(record, record.assignment);
    assert.throws(() => validateBoundBaseRecord(record, owner.admissions.initial.assignment), refusal);
  }
  if (kind === 'missing_assignment') delete record.assignment;
  if (kind === 'missing_owner') delete input['base:owner:v1'];
  if (kind === 'corrupt_owner') owner.revision = 'invalid';
  if (kind === 'different_record_id') record.recordId = '88888888-8888-4888-8888-888888888888';
  if (kind === 'retired_foreign') {
    const next = clone(owner.admissions.initial.record);
    next.recordId = '77777777-7777-4777-8777-777777777777';
    next.assignment.assignmentId = '66666666-6666-4666-8666-666666666666';
    const key = 'after:' + target;
    owner.admissions[key] = { schemaVersion: 'base_assigned_session_v1', assignment: clone(next.assignment), status: 'active', record: clone(next), errorCode: null };
    owner.activeKey = key; input.active = clone(next); input['record:' + next.recordId] = clone(next); input.ledger[next.recordId] = 946684800000;
  }
  if (kind === 'legacy') {
    delete input['base:owner:v1']; delete input.active.assignment; delete record.assignment;
  }
  if (kind === 'expired') input.ledger[target] = 0;
  if (kind === 'missing_ledger') delete input.ledger[target];
  if (kind === 'tombstoned') input.tombstones = [target];
  let values = new Map<string, any>(Object.entries(input)); const pending: Promise<unknown>[] = [];
  const counters = { reads: 0, writes: 0, model: 0 };
  const storage = {
    async get(key: string) { counters.reads++; return clone(values.get(key)); },
    async put(v: Record<string, unknown>) { counters.writes++; for (const [k, x] of Object.entries(v)) values.set(k, clone(x)); },
    async delete(keys: string | string[]) { counters.writes++; let n = 0; for (const k of Array.isArray(keys) ? keys : [keys]) n += Number(values.delete(k)); return n; },
    async transaction(fn: (tx: any) => Promise<any>) { const before = clone(values); try { return await fn(this); } catch (e) { values = before; throw e; } },
    async setAlarm() {}, async deleteAlarm() {},
  };
  const ctx = { storage, id: { toString: () => initial['base:owner:v1'].ownerId }, waitUntil(p: Promise<unknown>) { pending.push(p); } };
  const o = new TangramSession(ctx, { RECORD_RETENTION_DAYS: '30', AI_PROXY: { async chat() { counters.model++; throw Error('unexpected synthetic model call'); } } });
  const fingerprint = () => JSON.stringify([...values]);
  return { o, counters, fingerprint, record, async done() { await Promise.all(pending); assert.equal(counters.model, 0); } };
}
test('Worker matching metadata and private record load without mutation/model', async () => {
  const x = fixture(), before = x.fingerprint();
  assert.equal(await x.o.baseOwnerStatus(), 'registered'); assert.deepEqual(await x.o.adminRecord(target), x.record);
  assert.equal(x.fingerprint(), before); assert.equal(x.counters.writes, 0); await x.done();
});
for (const kind of ['foreign', 'missing_assignment', 'missing_owner', 'corrupt_owner']) {
  for (const surface of ['baseOwnerStatus', 'adminRecord']) test('Worker refuses ' + kind + ' on ' + surface, async () => {
    const x = fixture(kind), before = x.fingerprint();
    await assert.rejects(() => surface === 'baseOwnerStatus' ? x.o.baseOwnerStatus() : x.o.adminRecord(target), refusal);
    assert.equal(x.fingerprint(), before); assert.equal(x.counters.writes, 0); await x.done();
  });
}
test('Worker record key cannot return another self-valid record id', async () => {
  const x = fixture('different_record_id'), before = x.fingerprint();
  await assert.rejects(() => x.o.adminRecord(target), refusal); assert.equal(x.fingerprint(), before); await x.done();
});
test('Worker legacy archive-only metadata/export remains readable', async () => {
  const x = fixture('legacy'); assert.equal(await x.o.baseOwnerStatus(), 'registered'); assert.deepEqual(await x.o.adminRecord(target), x.record); await x.done();
});
test('Worker unknown private archive remains null', async () => {
  const x = fixture(); assert.equal(await x.o.adminRecord('55555555-5555-4555-8555-555555555555'), null); await x.done();
});
test('Worker old ledger timestamp does not expire owner metadata', async () => {
  const x = fixture('expired'); assert.equal(await x.o.baseOwnerStatus(), 'registered'); await x.done();
});
for (const kind of ['missing_ledger', 'tombstoned']) test('Worker ' + kind + ' active metadata stays expired', async () => {
  const x = fixture(kind); assert.equal(await x.o.baseOwnerStatus(), 'expired'); await x.done();
});
test('Worker matching completed review is actually reached', async () => {
  const x = fixture(); const r = await x.o.fetch(new Request('https://session.invalid/api/records/' + target + '/review'));
  assert.equal(r.status, 200); assert.equal((await r.json()).recordId, target); await x.done();
});
for (const path of ['/api/records', '/api/records/' + target + '/review', '/api/records/' + target + '/questionnaire']) {
  test('Worker corrupt retired archive refused before public surface ' + path, async () => {
    const x = fixture('retired_foreign'), before = x.fingerprint();
    assert.equal(await x.o.baseOwnerStatus(), 'registered', 'current admission is valid; this control must reach the retired archive');
    const r = await x.o.fetch(new Request('https://session.invalid' + path));
    assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'trial_unavailable' });
    assert.equal(x.fingerprint(), before); await x.done();
  });
}
for (const value of [null, [], 42, 'synthetic', true, false]) test('Worker nonobject body precedes all owner storage: ' + JSON.stringify(value), async () => {
  const x = fixture(); const r = await x.o.fetch(new Request('https://session.invalid/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }));
  assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'invalid_request' }); assert.equal(x.counters.reads, 0); assert.equal(x.counters.writes, 0); await x.done();
});
