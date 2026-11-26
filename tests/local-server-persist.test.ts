// Long-dialogue behaviour of the local participant server: a failed record write is reported as a closed code, and a read-only request no longer rewrites,
// re-reads and re-validates the whole owner file. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { openBaseFileStore } from '../dialogue-model/runtime/web/base-assignment-store.ts';
import { load, clone } from './support/s5-base/support.ts';

type Any = any;
const T0 = 946684800000;

// ---- 1. A failed record write is kept as a closed code ------------------------------------------------------------------------------
const model = () => ({ async complete(_m: unknown, { phase }: { phase?: string } = {}) {
  if (phase === 'generation') return { text: '三角が二つの図形ですね。' };
  throw new Error('unexpected phase ' + phase);
} });
const luna = { async judge(input: Any) {
  return { action: 'confirm', targetSlot: Object.keys(input.ownLedger)[0], candidateName: null, discriminatingFeature: '尖りが二つ', note: null };
} };
const coded = (code: string) => Object.assign(new Error('private detail must not be reported'), { code });

test('a failed record write is reported once as a closed code and carried in the next record', async () => {
  const records: Any[] = [], reported: Any[] = [];
  let mode: 'ok' | 'store' | 'invalid' | 'plain' = 'ok';
  const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: 'repair-first', seed: 71, runDir: null,
    onPersist: async (record: Any) => {
      if (mode === 'store') throw coded('trial_unavailable');
      if (mode === 'invalid') throw coded('assignment_record_invalid');
      if (mode === 'plain') throw new Error('disk full: /private/path');
      records.push(structuredClone(record));
    },
    onPersistFailure: (failure: Any) => reported.push(failure) } as Any);
  assert.equal(Object.hasOwn(records.at(-1), 'persistFailures'), false, 'a normal record keeps its earlier shape');
  for (const next of ['store', 'invalid', 'plain'] as const) {
    mode = next;
    await assert.rejects(task.persistNow());
  }
  assert.deepEqual(reported.map(entry => entry.code), ['record_store_rejected', 'record_invalid', 'record_write_failed']);
  assert.ok(reported.every(entry => Number.isFinite(Date.parse(entry.at)) && Object.keys(entry).sort().join() === (entry.code === 'record_store_rejected' ? 'at,code,reason' : 'at,code')));
  assert.equal(reported[0].reason, 'store_unknown', 'a store rejection without a recognised reason is store_unknown');
  mode = 'ok';
  await task.persistNow();
  const saved = records.at(-1);
  assert.deepEqual(saved.persistFailures.map((entry: Any) => entry.code), ['record_store_rejected', 'record_invalid', 'record_write_failed']);
  assert.doesNotMatch(JSON.stringify(saved.persistFailures), /private|disk full/u);
  assert.equal(Object.hasOwn(task.getState(), 'persistFailures'), false, 'the participant view never carries it');
  // A restore keeps the history and the failure never changes the dialogue.
  const restored: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: 'repair-first', seed: 71, runDir: null, restore: structuredClone(saved),
    onPersist: async (record: Any) => { records.push(structuredClone(record)); } } as Any);
  await restored.persistNow();
  assert.equal(records.at(-1).persistFailures.length, 3);
});

test('a failing write does not stop a turn: the reply is published and the failure is still reported', async () => {
  const reported: Any[] = [];
  let failing = false;
  const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: 'bypass-enabled', seed: 72, runDir: null,
    onPersist: async () => { if (failing) throw coded('trial_unavailable'); },
    onPersistFailure: (failure: Any) => reported.push(failure) } as Any);
  failing = true;
  task.message('三角が二つあるやつから話しましょう');
  await task.whenIdle().catch(() => {});
  assert.equal(task.getState().events.at(-1).speaker, 'ai');
  assert.equal(task.getState().aiStatus, 'idle');
  assert.ok(reported.length >= 1 && reported.every(entry => entry.code === 'record_store_rejected'));
});

// ---- 2. Read-only requests leave the owner file alone --------------------------------------------------------------------------------
async function setup(t: Any) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'HardyWatt-local-server-'));
  const owner = load('OWNER-EMPTY.json'), file = join(root, owner.ownerId + '.owner.json');
  const value: Any = { schemaVersion: 'base_local_owner_v1', owner, archives: {}, questionnaires: {}, ledger: {}, tombstones: [], lastAccessMs: T0 };
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const handles: Any[] = [];
  t.after(async () => { for (const h of handles) await h.close().catch(() => {}); await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); });
  const open = async (now = T0) => { const h = await openBaseFileStore({ root, ownerId: owner.ownerId, now: () => now }); handles.push(h); return h; };
  return { root, owner, file, value, open };
}

test('read-only operations do not rewrite the owner file and return copies', async t => {
  const x = await setup(t), h = await x.open();
  const before = await readFile(x.file), mtime = (await stat(x.file)).mtimeMs;
  for (let i = 0; i < 3; i++) {
    const read: Any = await h.read(); assert.equal(read.kind, 'state'); read.state.revision = 99;
    assert.equal(((await h.read()) as Any).state.revision, 0, 'a reader cannot change what the next reader sees');
    assert.equal(await h.alive(), true);
    assert.equal(await h.questionnaire('c'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12)), null);
    const inspected = await h.inspect(); inspected.lastAccessMs = 1; assert.equal((await h.inspect()).lastAccessMs, T0);
  }
  assert.deepEqual(await readFile(x.file), before);
  assert.equal((await stat(x.file)).mtimeMs, mtime);
});

test('a touch rewrites the file at most once per interval and still enforces the idle expiry', async t => {
  const x = await setup(t);
  const soon = await x.open(T0 + 1000);
  const before = await readFile(x.file);
  await soon.touch();
  assert.deepEqual(await readFile(x.file), before, 'a touch right after the last access writes nothing');
  await soon.close();
  const later = await x.open(T0 + 61000);
  await later.touch();
  assert.equal(JSON.parse(await readFile(x.file, 'utf8')).lastAccessMs, T0 + 61000, 'after the interval the access time moves');
  await later.close();
  const idle = await x.open(T0 + 61000 + 31 * 60 * 1000);
  await assert.rejects(idle.touch(), { code: 'owner_expired' });
  assert.equal(await idle.alive(), false);
});

test('a change of the file made outside the store is read and validated again, not served from the cache', async t => {
  const x = await setup(t), h = await x.open();
  assert.equal(((await h.read()) as Any).state.revision, 0);
  const id = 'd'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12);
  assert.equal(await h.questionnaire(id), null);
  const changed = clone(x.value); changed.questionnaires[id] = { status: 'draft' };
  await writeFile(x.file, JSON.stringify(changed), { mode: 0o600 });
  assert.deepEqual(await h.questionnaire(id), { status: 'draft' });
  await writeFile(x.file, '{"broken":', { mode: 0o600 });
  await assert.rejects(h.read());
  await assert.rejects(h.inspect());
});

test('after a compare-and-swap the next reader sees the new state and a stale swap still changes nothing', async t => {
  const x = await setup(t), h = await x.open();
  assert.equal(((await h.read()) as Any).state.revision, 0);
  const st = load('OWNER-ACTIVE.json'); st.revision = 1;
  const r = st.admissions.initial.record;
  assert.equal(await h.compareAndSwap(0, st, [{ assignmentId: r.assignment.assignmentId, record: r }]), true);
  assert.deepEqual(((await h.read()) as Any).state, st);
  assert.deepEqual(await h.readRecord(r.recordId), r);
  const bytes = await readFile(x.file);
  const stale = clone(st); stale.revision = 5;
  assert.equal(await h.compareAndSwap(4, stale, []), false);
  assert.deepEqual(await readFile(x.file), bytes);
  assert.equal(((await h.read()) as Any).state.revision, 1);
});

test('a second owner file rewrite by another process is detected when a mutating operation starts from the file', async t => {
  const x = await setup(t), h = await x.open();
  await h.read();
  const swapped = clone(x.value); swapped.lastAccessMs = T0 + 5;
  await writeFile(x.file, JSON.stringify(swapped), { mode: 0o600 });
  const st = clone(x.owner); st.revision = 1;
  assert.equal(await h.compareAndSwap(0, st, []), true, 'the swap starts from the file as it is now');
  assert.equal(JSON.parse(await readFile(x.file, 'utf8')).owner.revision, 1);
});

// ---- 3. Audit 27 fixes ---------------------------------------------------------------------------------------------------------------
import { createBaseAssignmentSession } from '../dialogue-model/runtime/v2/base-assignment-session.ts';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { mkdir } from 'node:fs/promises';

test('a touch inside the write interval still counts as the access: the idle window runs from the last access, in both directions', async t => {
  const x = await setup(t);
  let clock = T0;
  const h = await openBaseFileStore({ root: x.root, ownerId: x.owner.ownerId, now: () => clock });
  clock = T0 + 59_000; await h.touch();                       // inside 60 s of the stored time: no write
  assert.equal(JSON.parse(await readFile(x.file, 'utf8')).lastAccessMs, T0);
  clock = T0 + 59_000 + 1_742_000;                            // 29 min 02 s after the last access
  assert.equal(await h.alive(), true);
  assert.equal((await h.read()).kind, 'state');
  clock = T0 + 59_000 + 1_800_000;                            // 30 min after it
  assert.equal(await h.alive(), false);
  assert.equal((await h.read()).kind, 'expired');
  await h.close();
});

test('a graceful close writes a skipped access time back; the next process measures the idle window from it', async t => {
  const x = await setup(t);
  let clock = T0;
  const h = await openBaseFileStore({ root: x.root, ownerId: x.owner.ownerId, now: () => clock });
  clock = T0 + 59_000; await h.touch(); await h.close();
  assert.equal(JSON.parse(await readFile(x.file, 'utf8')).lastAccessMs, T0 + 59_000);
  clock = T0 + 59_000 + 1_742_000;
  const next = await openBaseFileStore({ root: x.root, ownerId: x.owner.ownerId, now: () => clock });
  t.after(() => next.close().catch(() => {}));
  assert.equal(await next.alive(), true);
});

const syntheticTask = (value: Any) => createNamingTaskV2({ client: model(), judge: luna, ...value, runDir: null });
for (const entrance of ['cookie', 'tab'] as const) {
  test(`the participant server returns the same trial 29 min 02 s after the last access and expires it after 30 min, by ${entrance}`, async t => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'HardyWatt-idle-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await chmod(dir, 0o700);
    const owners = join(dir, 'owners'); await mkdir(owners, { mode: 0o700 });
    const assignment = join(dir, 'base.json');
    await writeFile(assignment, JSON.stringify({ schemaVersion: 'base_assignment_config_v1', configId: '11111111-1111-4111-8111-111111111111', revision: 1, strategy: 'repair-first', seed: 71, referenceMemory: false }), { mode: 0o600 });
    let clock = T0;
    const server = await startNamingServer({ port: 0, client: {}, baseAssignmentFile: assignment, baseStoreRoot: owners, createTaskV2: syntheticTask, now: () => clock } as Any);
    t.after(() => server.drainAndClose().catch(() => {}));
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const page = await fetch(url, { headers: { Host: new URL(url).host } }); const cookie = page.headers.get('set-cookie')!.split(';')[0]; await page.text();
    const headers: Record<string, string> = { Cookie: cookie, 'Content-Type': 'application/json' };
    if (entrance === 'tab') {
      const created = await fetch(url + '/api/sessions', { method: 'POST', headers, body: '{}' });
      headers['X-Tab-Session'] = (await created.json()).sessionId;
    }
    const call = async (path: string, body?: unknown) => { const r = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, json: await r.json().catch(() => null) }; };
    const started = await call('/api/start', { version: 2 });
    assert.equal(started.status, 200);
    const id = started.json.trial.sessionId;
    clock = T0 + 59_000;
    assert.equal((await call('/api/state')).json.trial.sessionId, id);
    clock = T0 + 59_000 + 1_742_000;
    const back = await call('/api/state');
    assert.equal(back.status, 200); assert.equal(back.json.trial.sessionId, id, 'the same trial, 29 min 02 s after the last access');
    clock += 1_800_000;
    assert.ok([401, 404].includes((await call('/api/state')).status), '30 min without access expires it as before');
  });
}

test('after a graceful restart the idle window still runs from the last access', async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'HardyWatt-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  const owners = join(dir, 'owners'); await mkdir(owners, { mode: 0o700 });
  const assignment = join(dir, 'base.json');
  await writeFile(assignment, JSON.stringify({ schemaVersion: 'base_assignment_config_v1', configId: '11111111-1111-4111-8111-111111111111', revision: 1, strategy: 'repair-first', seed: 71, referenceMemory: false }), { mode: 0o600 });
  let clock = T0;
  const boot = async () => {
    const server = await startNamingServer({ port: 0, client: {}, baseAssignmentFile: assignment, baseStoreRoot: owners, createTaskV2: syntheticTask, now: () => clock } as Any);
    return { server, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port };
  };
  let { server, url } = await boot();
  const page = await fetch(url); const cookie = page.headers.get('set-cookie')!.split(';')[0]; await page.text();
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const id = (await (await fetch(url + '/api/start', { method: 'POST', headers, body: '{"version":2}' })).json()).trial.sessionId;
  clock = T0 + 59_000; await (await fetch(url + '/api/state', { headers })).text();
  await server.drainAndClose();
  clock = T0 + 59_000 + 1_742_000;
  ({ server, url } = await boot());
  t.after(() => server.drainAndClose().catch(() => {}));
  const back = await fetch(url + '/api/state', { headers });
  assert.equal(back.status, 200);
  assert.equal((await back.json()).trial.sessionId, id);
});

test('store rejections carry a closed sub-reason: damaged container, deleted record, expired owner', async t => {
  const x = await setup(t);
  const h = await x.open();
  // a record that was deleted (tombstone) cannot be written back
  const st = load('OWNER-ACTIVE.json'); st.revision = 1;
  const record = st.admissions.initial.record;
  assert.equal(await h.compareAndSwap(0, st, [{ assignmentId: record.assignment.assignmentId, record }]), true);
  assert.equal(await h.deleteRecord(record.recordId), true);
  const again = clone(st); again.revision = 3;
  await assert.rejects(h.compareAndSwap(2, again, [{ assignmentId: record.assignment.assignmentId, record }]), { code: 'trial_unavailable', reason: 'record_deleted' });
  // a damaged container
  const bytes = await readFile(x.file);
  await writeFile(x.file, '{"broken":', { mode: 0o600 });
  await assert.rejects(h.read(), { reason: 'store_invalid' });
  await writeFile(x.file, bytes, { mode: 0o600 });
  assert.equal((await h.read()).kind, 'state');
  // an owner that idled out
  await h.close();
  const late = await x.open(T0 + 31 * 60_000);
  await assert.rejects(late.compareAndSwap(2, again, []), { code: 'trial_unavailable', reason: 'owner_expired' });
});

test('a session maps a refused compare-and-swap to the cas_conflict reason (a start answers busy) and a store failure to store_io', async () => {
  const store = (cas: () => unknown) => ({ read: async () => ({ kind: 'state', state: load('OWNER-EMPTY.json') }), readRecord: async () => null, compareAndSwap: async () => cas() });
  const session = (cas: () => unknown) => createBaseAssignmentSession({ ownerId: load('OWNER-EMPTY.json').ownerId, adapter: 'local_private_file', store: store(cas) as Any, now: () => T0, newId: () => '22222222-2222-4222-8222-222222222222',
    readConfig: async () => ({ schemaVersion: 'base_assignment_config_v1', configId: '11111111-1111-4111-8111-111111111111', revision: 1, strategy: 'repair-first', seed: 71, referenceMemory: false }),
    makeTask: async () => { throw new Error('unused'); } } as Any);
  await assert.rejects(session(() => false).start({ version: 2 }), { code: 'busy', reason: 'cas_conflict' });
  await assert.rejects(session(() => { throw new Error('disk'); }).start({ version: 2 }), { code: 'trial_unavailable', reason: 'store_io' });
});

test('a record that would exceed the read limit is refused when it is saved, not accepted into the cache and refused after a restart', async t => {
  const x = await setup(t), h = await x.open();
  const before = await readFile(x.file);
  const id = 'e'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12);
  const r = load('ENRICHED-RECORD.json');
  const st = load('OWNER-ACTIVE.json'); st.revision = 1;
  assert.equal(await h.compareAndSwap(0, st, [{ assignmentId: st.admissions.initial.record.assignment.assignmentId, record: st.admissions.initial.record }]), true);
  const saved = await readFile(x.file);
  void id; void r; void before;
  const big = 'x'.repeat(65 * 1024 * 1024);
  await assert.rejects(h.saveQuestionnaire(st.admissions.initial.record.recordId, { comment: big }), { reason: 'size_limit' });
  assert.deepEqual(await readFile(x.file), saved, 'nothing was written');
  assert.equal((await h.read()).kind, 'state');
});

test('what the cache serves is what the file holds (no undefined properties)', async t => {
  const x = await setup(t), h = await x.open();
  const st = load('OWNER-ACTIVE.json'); st.revision = 1;
  const record = st.admissions.initial.record;
  await h.compareAndSwap(0, st, [{ assignmentId: record.assignment.assignmentId, record }]);
  await h.saveQuestionnaire(record.recordId, { status: 'draft', undefKey: undefined });
  const served: Any = await h.questionnaire(record.recordId);
  assert.equal(Object.hasOwn(served, 'undefKey'), false);
  assert.deepEqual(JSON.parse(await readFile(x.file, 'utf8')).questionnaires[record.recordId], served);
});

test('a restored failure history keeps only closed codes, ISO times and closed sub-reasons', async () => {
  const records: Any[] = [];
  const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: 'repair-first', seed: 71, runDir: null, onPersist: async (record: Any) => { records.push(structuredClone(record)); } } as Any);
  const saved = structuredClone(records.at(-1));
  saved.persistFailures = [
    { code: 'record_store_rejected', at: '2026-11-26T00:00:00.000Z', reason: 'cas_conflict' },
    { code: 'UNCLOSED_ARBITRARY_TEXT', at: '2026-11-26T00:00:01.000Z' },
    { code: 'record_invalid', at: 'not-a-timestamp' },
    { code: 'record_store_rejected', at: '2026-11-26T00:00:02.000Z', reason: 'free text' },
  ];
  const restored: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: 'repair-first', seed: 71, runDir: null, restore: saved,
    onPersist: async (record: Any) => { records.push(structuredClone(record)); } } as Any);
  await restored.persistNow();
  assert.deepEqual(records.at(-1).persistFailures, [
    { code: 'record_store_rejected', at: '2026-11-26T00:00:00.000Z', reason: 'cas_conflict' },
    { code: 'record_store_rejected', at: '2026-11-26T00:00:02.000Z' },
  ]);
  void task;
});
