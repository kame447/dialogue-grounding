// A persist() that arrives while a write is queued but not started joins that write; the running write and one queued write are all that wait. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';

type Any = any;
const model = () => ({ async complete(_m: unknown, { phase }: { phase?: string } = {}) {
  if (phase === 'generation') return { text: '三角が二つの図形ですね。' };
  throw new Error('unexpected phase ' + phase);
} });
const luna = { async judge(input: Any) {
  return { action: 'confirm', targetSlot: Object.keys(input.ownLedger)[0], candidateName: null, discriminatingFeature: '尖りが二つ', note: null };
} };
function deferred() { let release!: () => void, fail!: (error: Error) => void; const promise = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; }); return { promise, release, fail }; }
async function harness(extra: Any = {}) {
  const writes: Any[] = [], failures: Any[] = [], slow: Any[] = [];
  const control: { gate: ReturnType<typeof deferred> | null; failAt: number | null } = { gate: null, failAt: null };
  const task: Any = await createNamingTaskV2({ client: model(), judge: luna, strategy: 'repair-first', seed: 71, runDir: null,
    onPersist: async (record: Any) => {
      const gate = control.gate; const shot = { events: record.events.length, updatedAt: record.updatedAt };
      writes.push(shot);
      if (gate) await gate.promise;
      if (control.failAt === writes.length) { control.failAt = null; throw Object.assign(new Error('synthetic'), { code: 'trial_unavailable', reason: 'cas_conflict' }); }
    },
    onPersistFailure: (failure: Any) => failures.push(failure), onPersistSlow: (entry: Any) => slow.push(entry), ...extra } as Any);
  return { task, writes, failures, slow, control };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('persist calls made while a write runs share one queued write: 1 running + 1 queued, not one per call', async () => {
  const { task, writes, control } = await harness();
  const before = writes.length;
  control.gate = deferred();
  const first = task.persistNow();            // starts and blocks in onPersist
  await tick();
  const joined = Array.from({ length: 6 }, () => task.persistNow());
  await tick();
  assert.equal(writes.length - before, 1, 'only the running write has started');
  const gate = control.gate; control.gate = null;
  gate.release();
  await Promise.all([first, ...joined]);
  assert.equal(writes.length - before, 2, 'one running write plus one write for all six joined calls');
});

test('the queued write starts after the running one and writes the newest state', async () => {
  const { task, writes, control } = await harness();
  control.gate = deferred();
  const first = task.persistNow();
  await tick();
  const startedEvents = writes.at(-1).events;
  task.message('三角が二つあるやつから話しましょう');   // a change made after the running write started
  const second = task.persistNow();
  const third = task.persistNow();
  const gate = control.gate; control.gate = null;
  gate.release();
  await Promise.all([first, second, third]);
  await task.whenIdle();
  const counts = writes.map(write => write.events);
  assert.ok(counts.every((count, index) => index === 0 || count >= counts[index - 1]), 'writes never go backwards: ' + counts.join(','));
  assert.ok(counts.at(-1)! > startedEvents, 'the change made after the first write started is written by a later write');
});

test('a call made after a write has started queues a new write instead of joining the running one', async () => {
  const { task, writes, control } = await harness();
  control.gate = deferred();
  const running = task.persistNow();
  await tick();
  const before = writes.length;
  const next = task.persistNow();
  const gate = control.gate; control.gate = null;
  gate.release();
  await Promise.all([running, next]);
  assert.equal(writes.length - before, 1, 'the queued write ran once, after the running one');
});

test('a failed write rejects every call that joined it, is reported once, and does not block the writes after it', async () => {
  const { task, writes, failures, control } = await harness();
  control.gate = deferred();
  const running = task.persistNow();
  await tick();
  const joined = [task.persistNow(), task.persistNow(), task.persistNow()];
  const settled = Promise.allSettled(joined);
  const gate = control.gate; control.gate = null;
  control.failAt = writes.length + 1;          // the write that runs next (the queued one) fails
  gate.release();
  await running.catch(() => {});
  const outcomes = await settled;
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected'), 'all joined calls see the failure');
  assert.equal(failures.length, 1, 'one failed write is one report, not one per caller');
  assert.deepEqual(Object.keys(failures[0]).sort(), ['at', 'code', 'reason']);
  const after = writes.length;
  await task.persistNow();
  assert.equal(writes.length, after + 1, 'the next persist writes normally');
});

test('a slow or long-waiting write is reported with its wait, duration and joined callers', async () => {
  const clock = { t: Date.parse('2026-11-26T00:00:00.000Z') };
  const { task, slow, control } = await harness({ now: () => clock.t });
  control.gate = deferred();
  const running = task.persistNow();
  await tick();
  const joined = [task.persistNow(), task.persistNow()];
  clock.t += 12_000;                           // the running write is slow, and the queued one has waited as long
  const gate = control.gate; control.gate = null;
  gate.release();
  await Promise.all([running, ...joined]);
  assert.ok(slow.length >= 1);
  assert.ok(slow.some(entry => entry.joined === 1 && entry.waitedMs >= 10_000), 'the queued write reports its wait and that two calls shared it: ' + JSON.stringify(slow));
  assert.ok(slow.every(entry => Object.keys(entry).sort().join() === 'joined,tookMs,waitedMs'));
});

test('without a pending write nothing changes: a call per write, in order', async () => {
  const { task, writes } = await harness();
  const before = writes.length;
  await task.persistNow(); await task.persistNow(); await task.persistNow();
  assert.equal(writes.length - before, 3);
});
