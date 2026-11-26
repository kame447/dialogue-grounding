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
  assert.ok(reported.every(entry => Number.isFinite(Date.parse(entry.at)) && Object.keys(entry).sort().join() === 'at,code'));
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
    const read = await h.read(); assert.equal(read.kind, 'state'); read.state.revision = 99;
    assert.equal((await h.read()).state.revision, 0, 'a reader cannot change what the next reader sees');
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
  assert.equal((await h.read()).state.revision, 0);
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
  assert.equal((await h.read()).state.revision, 0);
  const st = load('OWNER-ACTIVE.json'); st.revision = 1;
  const r = st.admissions.initial.record;
  assert.equal(await h.compareAndSwap(0, st, [{ assignmentId: r.assignment.assignmentId, record: r }]), true);
  assert.deepEqual((await h.read()).state, st);
  assert.deepEqual(await h.readRecord(r.recordId), r);
  const bytes = await readFile(x.file);
  const stale = clone(st); stale.revision = 5;
  assert.equal(await h.compareAndSwap(4, stale, []), false);
  assert.deepEqual(await readFile(x.file), bytes);
  assert.equal((await h.read()).state.revision, 1);
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
