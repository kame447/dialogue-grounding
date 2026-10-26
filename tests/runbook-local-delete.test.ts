import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { readOwner } from '../dialogue-model/runtime/v2/base-assignment-data.ts';
import { openBaseFileStore } from '../dialogue-model/runtime/web/base-assignment-store.ts';
import { createBaseAssignmentSession } from '../dialogue-model/runtime/v2/base-assignment-session.ts';
import { web, ADMIN } from './support/s5-base/http-support.ts';
import { load, clone, harness, sessionError } from './support/s5-base/support.ts';

const idle = 30 * 60 * 1000, epoch = 946684800000;
function marked(code = 'record_deleted', record: any = null, status = 'failed') {
  const owner = load('OWNER-ACTIVE.json'); Object.assign(owner.admissions.initial, { status, record, errorCode: code }); return owner;
}
test('new deletion marker is valid only failed/null without altering old state', () => {
  const owner = marked(), before = clone(owner);
  assert.deepEqual(readOwner(owner, owner.ownerId), owner); assert.deepEqual(owner, before);
});
for (const code of ['start_interrupted', 'initialization_failed', 'record_write_failed', 'assignment_record_invalid']) {
  for (const retained of [false, true]) test('old failure ' + code + ' snapshot=' + retained + ' stays valid', () => {
    const owner = marked(code, retained ? load('ENRICHED-RECORD.json') : null);
    assert.deepEqual(readOwner(owner, owner.ownerId), owner);
  });
}
for (const [label, owner] of [
  ['record-bearing', marked('record_deleted', load('ENRICHED-RECORD.json'))],
  ['active', marked('record_deleted', null, 'active')],
  ['preparing', marked('record_deleted', null, 'preparing')],
  ['unknown-code', marked('deleted_record')]
] as const) test('invalid marker ' + label + ' is rejected', () => {
  assert.throws(() => readOwner(owner, owner.ownerId), { name: 'BaseAssignmentError', code: 'assignment_record_invalid' });
});

async function store(t: any) {
  const root = await fs.mkdtemp('/private/tmp/SandyNoether-g6-delete-store-'), owner = load('OWNER-ACTIVE.json');
  const record = owner.admissions.initial.record, id = record.recordId, path = root + '/' + owner.ownerId + '.owner.json';
  const container = { schemaVersion: 'base_local_owner_v1', owner, archives: { [id]: record },
    questionnaires: { [id]: { synthetic: true } }, ledger: { [id]: epoch }, tombstones: [], lastAccessMs: epoch };
  await fs.writeFile(path, JSON.stringify(container), { mode: 0o600 }); let tick = epoch;
  const h: any = await openBaseFileStore({ root, ownerId: owner.ownerId, now: () => tick });
  t.after(async () => { await h.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, path, h, owner, id, container, clock: (n: number) => { tick = n; } };
}
test('real store deletes both snapshots and related data atomically, repeats do not mutate', async t => {
  const x = await store(t); assert.equal(typeof x.h.deleteRecord, 'function');
  assert.equal(await x.h.deleteRecord(x.id), true);
  const c = JSON.parse(await fs.readFile(x.path, 'utf8'));
  assert.deepEqual(c.archives, {}); assert.deepEqual(c.questionnaires, {}); assert.deepEqual(c.ledger, {});
  assert.deepEqual(c.tombstones, [x.id]); assert.equal(c.lastAccessMs, epoch);
  assert.equal(c.owner.revision, x.owner.revision + 1); assert.equal(c.owner.activeKey, x.owner.activeKey);
  assert.deepEqual(c.owner.admissions.initial.assignment, x.owner.admissions.initial.assignment);
  assert.deepEqual(c.owner.admissions.initial, { ...x.owner.admissions.initial, record: null, status: 'failed', errorCode: 'record_deleted' });
  const bytes = await fs.readFile(x.path);
  assert.equal(await x.h.deleteRecord(x.id), false); assert.deepEqual(await fs.readFile(x.path), bytes);
  assert.equal(await x.h.readRecord(x.id), null);
  assert.equal(await x.h.compareAndSwap(x.owner.revision, x.owner, []), false);
});
test('store exact idle expiry throws typed expiry without mutating bytes', async t => {
  const x = await store(t); assert.equal(typeof x.h.deleteRecord, 'function'); const bytes = await fs.readFile(x.path);
  x.clock(epoch + idle); await assert.rejects(x.h.deleteRecord(x.id), sessionError('owner_expired'));
  assert.deepEqual(await fs.readFile(x.path), bytes);
});
test('actual delete rename fault leaves complete old container and cleans only own temp', async t => {
  const x = await store(t); assert.equal(typeof x.h.deleteRecord, 'function'); const bytes = await fs.readFile(x.path);
  const original = fs.rename; let hit = 0;
  fs.rename = (async (from: any, to: any) => { if (to === x.path) { hit++; throw Error('synthetic rename failure'); } return original(from, to); }) as any;
  syncBuiltinESMExports();
  try { await assert.rejects(x.h.deleteRecord(x.id), sessionError('trial_unavailable')); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
  assert.equal(hit, 1); assert.deepEqual(await fs.readFile(x.path), bytes);
  assert.equal((await fs.readdir(x.root)).filter(v => v.endsWith('.tmp')).length, 0);
});

async function startTrial(w: any) {
  assert.equal((await w.page()).status, 200);
  const r = await w.request('/api/start', { version: 2 }); assert.equal(r.status, 200);
  return (await r.json()).trial.sessionId as string;
}
function admin(w: any, path: string, body: string, extra: Record<string, string> = {}) {
  return fetch(w.base() + path, { method: 'POST', redirect: 'manual', headers: {
    Authorization: 'Bearer ' + ADMIN, Origin: w.base(), 'Content-Type': 'application/x-www-form-urlencoded', ...extra
  }, body });
}
const remove = (w: any, id: string) => admin(w, '/admin/record/' + id + '/delete', 'confirm=' + id);
const next = (w: any, id: string) => admin(w, '/admin/record/' + id + '/prepare-next', '{}', { 'Content-Type': 'application/json' });
async function ownerFile(w: any) { return w.storeRoot + '/' + (await fs.readdir(w.storeRoot)).find((v: string) => v.endsWith('.owner.json')); }

test('HTTP deleted successor retry404 warm/cold, participant409, no resurrection or reallocation', async t => {
  const w = await web(t); const a = await startTrial(w); await w.tasks[0].complete();
  const response = await next(w, a); assert.equal(response.status, 201); const b = (await response.json()).recordId;
  const path = await ownerFile(w), before = JSON.parse(await fs.readFile(path, 'utf8'));
  const rawB = clone(before.owner.admissions['after:' + a].record);
  const deleted = await remove(w, b); assert.equal(deleted.status, 303); assert.equal(deleted.headers.get('location'), '/admin?deleted=1');
  const after = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(after.owner.activeKey, before.owner.activeKey); assert.deepEqual(after.owner.admissions.initial, before.owner.admissions.initial);
  assert.deepEqual(after.archives[a], before.archives[a]); assert.equal(after.owner.admissions['after:' + a].record, null);
  assert.ok(!JSON.stringify(after).includes('"recordId":"' + b + '"'));
  const constructed = w.inputs.length;
  const again = await next(w, a); assert.equal(again.status, 404); assert.deepEqual(await again.json(), { error: 'not_found' });
  assert.equal((await remove(w, b)).status, 404);
  assert.equal((await w.request('/api/state')).status, 409);
  assert.equal((await w.request('/api/start', { version: 2 })).status, 409);
  const stable = await fs.readFile(path);
  await assert.rejects(w.inputs[1].onPersist(rawB)); assert.deepEqual(await fs.readFile(path), stable);
  await w.restart(); const cold = await next(w, a); assert.equal(cold.status, 404);
  assert.deepEqual(await cold.json(), { error: 'not_found' }); assert.equal(w.inputs.length, constructed);
  assert.equal((await w.request('/api/record/' + b + '/review')).status, 404);
});
test('deleting retired predecessor preserves successor and after key without rewind', async t => {
  const w = await web(t); const a = await startTrial(w); await w.tasks[0].complete();
  const created = await next(w, a); assert.equal(created.status, 201); const b = (await created.json()).recordId;
  const path = await ownerFile(w), old = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal((await remove(w, a)).status, 303);
  const after = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.deepEqual(after.owner.admissions['after:' + a], old.owner.admissions['after:' + a]);
  assert.equal(after.owner.activeKey, 'after:' + a); assert.deepEqual(after.archives[b], old.archives[b]);
  assert.equal((await next(w, a)).status, 404);
  const state = await w.request('/api/state'); assert.equal(state.status, 200); assert.equal((await state.json()).trial.sessionId, b);
});
test('summary success then transaction expiry maps admin plain404, not participant401', async t => {
  let expiring = false, reads = 0;
  const w = await web(t, { now: () => expiring && ++reads >= 4 ? epoch + idle : epoch });
  const id = await startTrial(w), path = await ownerFile(w), bytes = await fs.readFile(path), factories = w.inputs.length;
  expiring = true; const r = await remove(w, id);
  assert.equal(r.status, 404); assert.equal(await r.text(), 'Not found');
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('www-authenticate'), null); assert.equal(r.headers.get('location'), null); assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.deepEqual(await fs.readFile(path), bytes); assert.equal(w.inputs.length, factories);
});
test('HTTP rename fault409 is not expiry or303 and retains complete container', async t => {
  const w = await web(t); const id = await startTrial(w), path = await ownerFile(w), bytes = await fs.readFile(path);
  const original = fs.rename; let hit = 0;
  fs.rename = (async (from: any, to: any) => { if (to === path) { hit++; throw Error('synthetic rename failure'); } return original(from, to); }) as any;
  syncBuiltinESMExports(); let r: Response;
  try { r = await remove(w, id); } finally { fs.rename = original; syncBuiltinESMExports(); }
  assert.equal(hit, 1); assert.equal(r!.status, 409); assert.deepEqual(await r!.json(), { error: 'trial_unavailable' });
  assert.deepEqual(await fs.readFile(path), bytes);
});
for (const kind of ['missing-auth', 'wrong-auth', 'csrf', 'confirmation']) test('delete protection ' + kind + ' before mutation', async t => {
  const w = await web(t), id = await startTrial(w), path = await ownerFile(w), bytes = await fs.readFile(path), factories = w.inputs.length;
  const r = await admin(w, '/admin/record/' + id + '/delete', 'confirm=' + (kind === 'confirmation' ? 'wrong' : id), {
    ...(kind === 'missing-auth' ? { Authorization: '' } : kind === 'wrong-auth' ? { Authorization: 'Bearer wrong' } : {}),
    ...(kind === 'csrf' ? { Origin: 'http://127.0.0.1:1' } : {})
  }); assert.equal(r.status, kind === 'csrf' ? 403 : kind === 'confirmation' ? 400 : 401);
  assert.deepEqual(await fs.readFile(path), bytes); assert.equal(w.inputs.length, factories);
});
for (const code of ['record_deleted', 'assignment_record_invalid', 'initialization_failed', 'record_write_failed', 'start_interrupted']) {
  test('precise existing after-key ' + code + ' branch preserves failure distinction', async () => {
    const h = harness(), c = createBaseAssignmentSession(h.options as any);
    await c.start({ version: 2 }); await h.tasks[0].complete(); const a = h.tasks[0].record.recordId;
    await c.prepareNext(a); const old = h.state, before = clone(old);
    Object.assign(old.admissions['after:' + a], { status: 'failed', record: null, errorCode: code }); h.setState(old);
    const counts = clone(h.stats);
    await assert.rejects(c.prepareNext(a), sessionError(code === 'record_deleted' ? 'not_found' : 'trial_unavailable'));
    assert.equal(h.stats.config, counts.config); assert.equal(h.stats.factory, counts.factory); assert.equal(h.stats.cas, counts.cas);
    assert.deepEqual(h.state.activeKey, before.activeKey);
  });
}
