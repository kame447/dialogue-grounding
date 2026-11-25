// Luna path (no jevResearch): a restore must keep the attempts recorded before it.
// Construction persists once, so the first record after a restore is checked directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';

const SEED = 35;
const FINAL = JSON.stringify(Object.fromEntries(modelView(createTrialV2({ seed: SEED })).anchors.map((a) => [a.id, null])));
const ACCEPT = { action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };

function harness({ failFirstGeneration = false } = {}) {
  const records = [], raw = [];
  let calls = 0, failed = false;
  const client = { async complete(messages, options = {}) {
    calls++;
    if (failFirstGeneration && !failed && options.phase === 'generation') { failed = true; throw Object.assign(new Error('synthetic'), { status: 503 }); }
    if (messages.some((m) => typeof m.content === 'string' && m.content.includes('JSON'))) return { text: FINAL, model: 'fake' };
    return { text: 'わかりました。', model: 'fake' };
  } };
  const judge = { async judge() { calls++; return ACCEPT; } };
  return { client, judge, records, raw, calls: () => calls,
    onPersist: async (record) => { raw.push(record); records.push(JSON.parse(JSON.stringify(record))); } };
}
const make = (h, extra = {}) => createNamingTaskV2({ client: h.client, judge: h.judge, strategy: 'repair-first', seed: SEED,
  referenceMemory: true, runDir: null, onPersist: h.onPersist, ...extra });
const roundTrip = (record) => JSON.parse(JSON.stringify(record));
// The record written by construction itself, before any further message or whenIdle.
async function restoreOnly(saved, extra = {}) {
  const h = harness();
  const task = await make(h, { restore: roundTrip(saved), ...extra });
  assert.equal(h.records.length, 1, 'construction persists exactly once');
  return { h, task, first: h.records[0] };
}

for (const strategy of ['repair-first', 'bypass-enabled']) {
  test(`A1/A5 ${strategy}: an in-progress restore keeps prior attempts, appends new ones after them`, async () => {
    const h = harness();
    const task = await make(h, { strategy });
    task.message('鳥に見える', 'm-1'); await task.whenIdle();
    const saved = roundTrip(h.records.at(-1));
    assert.ok(saved.attempts.length >= 1);
    const { h: h2, task: restored, first } = await restoreOnly(saved, { strategy });
    assert.deepEqual(first.attempts, saved.attempts);
    assert.deepEqual(restored.researcherView().attempts, saved.attempts);
    assert.equal(h2.calls(), 0, 'restoring an idle trial calls neither model nor judge');
    restored.message('次は船です', 'm-2'); await restored.whenIdle();
    const after = h2.records.at(-1).attempts;
    assert.equal(after.length, saved.attempts.length + 1);
    assert.deepEqual(after.slice(0, saved.attempts.length), saved.attempts);
    assert.deepEqual(restored.researcherView().attempts, after);
    // A3: restoring again does not add the prefix twice.
    const again = await restoreOnly(h2.records.at(-1), { strategy });
    assert.deepEqual(again.first.attempts, after);
  });
}

test('A2 a completed restore keeps attempts, judgments, scoring and events without model calls', async () => {
  const h = harness();
  const task = await make(h);
  task.message('鳥に見える', 'm-1'); await task.whenIdle();
  const names = Object.fromEntries(task.getState().scene.shapes.map((s) => [s.id, null]));
  await task.submitHuman({ names });
  if (!task.getState().aiSubmitted) await task.submitAI();
  const saved = roundTrip(h.records.at(-1));
  assert.equal(saved.status, 'completed');
  assert.ok(saved.attempts.length >= 1);
  const { h: h2, task: restored, first } = await restoreOnly(saved);
  for (const field of ['attempts', 'judgments', 'scoring', 'events', 'status']) assert.deepEqual(first[field], saved[field], field);
  assert.equal(h2.calls(), 0);
  assert.doesNotMatch(JSON.stringify(restored.getState()), /"attempts"|"validation"/u);
});

test('A6 a failure → retry history is kept whole across JSON round trips', async () => {
  const h = harness({ failFirstGeneration: true });
  const task = await make(h);
  task.message('鳥に見える', 'm-1'); await task.whenIdle();
  assert.equal(task.getState().aiStatus, 'error');
  await task.retry(); await task.whenIdle();
  const saved = roundTrip(h.records.at(-1));
  assert.ok(saved.attempts.length >= 2, 'the failed attempt and its retry are both recorded');
  const { h: h2, task: restored, first } = await restoreOnly(saved);
  assert.deepEqual(first.attempts, saved.attempts);
  restored.message('次は船です', 'm-2'); await restored.whenIdle();
  const after = h2.records.at(-1).attempts;
  assert.deepEqual(after.slice(0, saved.attempts.length), saved.attempts);
  assert.equal(after.length, saved.attempts.length + 1);
  const again = await restoreOnly(h2.records.at(-1));
  assert.deepEqual(again.first.attempts, after);
});

test('A4 legacy records without attempts, or with [], gain no invented entries', async () => {
  const h = harness();
  const task = await make(h);
  task.message('鳥に見える', 'm-1'); await task.whenIdle();
  const saved = roundTrip(h.records.at(-1));
  for (const legacy of [(({ attempts, ...rest }) => rest)(saved), { ...saved, attempts: [] }]) {
    const { h: h2, task: restored, first } = await restoreOnly(legacy);
    assert.deepEqual(first.attempts, []);
    restored.message('次は船です', 'm-2'); await restored.whenIdle();
    assert.equal(h2.records.at(-1).attempts.length, 1);
  }
});

test('A7 prior attempts handed out are copies: changing them does not change the next save', async () => {
  const h = harness();
  const task = await make(h);
  task.message('鳥に見える', 'm-1'); await task.whenIdle();
  const saved = roundTrip(h.records.at(-1));
  const { h: h2, task: restored } = await restoreOnly(saved);
  restored.researcherView().attempts[0].status = 'MUTATED-VIEW';
  h2.raw[0].attempts[0].status = 'MUTATED-RECORD';
  await restored.persistNow();
  assert.deepEqual(h2.records.at(-1).attempts, saved.attempts);
  assert.deepEqual(restored.researcherView().attempts, saved.attempts);
});

test('A8 a Luna record whose own attempts is not an array is refused before any call or persist', async () => {
  const h = harness();
  const task = await make(h);
  task.message('鳥に見える', 'm-1'); await task.whenIdle();
  const saved = roundTrip(h.records.at(-1));
  for (const attempts of [null, 'attempts', { 0: {} }, 1, true]) {
    const restore = { ...saved, attempts }, before = structuredClone(restore);
    const h2 = harness();
    await assert.rejects(make(h2, { restore }), { code: 'invalid_options' }, JSON.stringify(attempts));
    assert.equal(h2.records.length, 0);
    assert.equal(h2.calls(), 0);
    assert.deepEqual(restore, before, 'the stored record is not modified');
  }
});
