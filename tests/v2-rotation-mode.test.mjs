// #142: the rotation mode is fixed at generation, recorded privately, restored from the record only,
// and never shown to the participant or the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as scatter from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { participantReview } from '../dialogue-model/runtime/v2/participant-records.ts';

const { createTrialV2, modelView, participantView } = scatter;
const SEED = 1701, PM90_TRIAL_ID = 'tangram-prototype-v2-e96c46888b1582b6';
const MODES = ['relative_pm90', 'relative_0'];
const opposite = (mode) => mode === 'relative_0' ? 'relative_pm90' : 'relative_0';
const pngOf = (rotationMode) => modelView(createTrialV2({ seed: SEED, rotationMode })).png.toString('base64');
const ACCEPT = { action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };

function harness() {
  const images = [], records = [];
  let calls = 0;
  const client = { async complete(messages) {
    calls++;
    for (const m of messages) if (Array.isArray(m.content)) for (const part of m.content)
      if (part?.type === 'image_url') images.push(part.image_url.url);
    return { text: 'そう見えるんですね。', model: 'fake' };
  } };
  const judge = { async judge() { calls++; return ACCEPT; } };
  return { client, judge, images, records, calls: () => calls,
    onPersist: async (record) => { records.push(JSON.parse(JSON.stringify(record))); } };
}
async function run(options, h = harness()) {
  const task = await createNamingTaskV2({ client: h.client, judge: h.judge, strategy: 'repair-first', seed: SEED, runDir: null,
    onPersist: h.onPersist, ...options });
  task.message('鳥に見える');
  await task.whenIdle();
  return { task, h, record: h.records.at(-1) };
}
const sawImage = (h, rotationMode) => h.images.some((url) => url.includes(pngOf(rotationMode)));

test('N1 a new trial records relative_pm90 explicitly with its generated stimulus', async () => {
  const { record } = await run({});
  assert.equal(record.options.rotationMode, 'relative_pm90');
  assert.equal(record.trialId, PM90_TRIAL_ID);
  assert.equal(record.seed, SEED);
  assert.deepEqual(record.stimulus, scatter.trialStimulusV2(createTrialV2({ seed: SEED })));
});

test('N2 relative_0 records its mode and stimulus and gives the model the relative_0 board', async () => {
  const { record, h } = await run({ rotationMode: 'relative_0' });
  assert.equal(record.options.rotationMode, 'relative_0');
  assert.deepEqual(record.stimulus, scatter.trialStimulusV2(createTrialV2({ seed: SEED, rotationMode: 'relative_0' })));
  assert.equal(record.trialId, createTrialV2({ seed: SEED, rotationMode: 'relative_0' }).trialId);
  assert.ok(sawImage(h, 'relative_0'));
  assert.ok(!sawImage(h, 'relative_pm90'));
});

test('N3 the stimulus is independent of the strategy for the same seed and mode', async () => {
  for (const rotationMode of MODES) {
    const [a, b] = await Promise.all(['repair-first', 'bypass-enabled'].map((strategy) => run({ strategy, rotationMode })));
    assert.ok(a.h.images.length > 0);
    assert.deepEqual([...new Set(a.h.images)], [...new Set(b.h.images)]);
    assert.deepEqual(a.record.stimulus, b.record.stimulus);
    assert.equal(a.record.trialId, b.record.trialId);
  }
});

test('N4 the participant state shows neither the mode nor angles, and the scene is the same in both modes', async () => {
  const states = [];
  for (const rotationMode of MODES) {
    const { task } = await run({ rotationMode });
    const state = task.getState();
    assert.doesNotMatch(JSON.stringify(state), /relative|rotation|angle|stimulus/iu);
    states.push(state.scene);
  }
  assert.deepEqual(states[0], states[1]);
  assert.deepEqual(states[0], participantView(createTrialV2({ seed: SEED })));
});

test('N5 save → JSON → restore keeps the recorded mode whatever the caller passes', async () => {
  for (const rotationMode of MODES) {
    const first = await run({ rotationMode });
    const saved = JSON.parse(JSON.stringify(first.record));
    const h = harness();
    const { record } = await run({ rotationMode: opposite(rotationMode), restore: saved }, h);
    assert.equal(record.options.rotationMode, rotationMode);
    assert.deepEqual(record.stimulus, saved.stimulus);
    assert.equal(record.trialId, saved.trialId);
    assert.ok(sawImage(h, rotationMode));
    assert.ok(!sawImage(h, opposite(rotationMode)));
  }
});

test('N6 a legacy record (pm90, no rotation fields) restores as relative_pm90 and stays without the fields', async () => {
  const first = await run({});
  // The c3a871e record shape: no options.rotationMode and no stimulus.
  const legacy = JSON.parse(JSON.stringify(first.record));
  delete legacy.options.rotationMode;
  delete legacy.stimulus;
  const h = harness();
  const { record } = await run({ rotationMode: 'relative_0', restore: legacy }, h);
  assert.ok(sawImage(h, 'relative_pm90'));
  assert.ok(!sawImage(h, 'relative_0'));
  assert.equal(record.trialId, PM90_TRIAL_ID);
  assert.ok(h.records.length > 0);
  for (const r of h.records) {
    assert.equal(Object.hasOwn(r.options, 'rotationMode'), false);
    assert.equal(Object.hasOwn(r, 'stimulus'), false);
  }
});

test('N7 invalid modes and inconsistent records are refused before any call or persist', async () => {
  const zero = JSON.parse(JSON.stringify((await run({ rotationMode: 'relative_0' })).record));
  const pm = JSON.parse(JSON.stringify((await run({})).record));
  const edit = (base, change) => { const copy = structuredClone(base); change(copy); return copy; };
  const firstSlot = Object.keys(zero.stimulus.angles.ai)[0];
  const cases = [
    ...['x', null, '', 'RELATIVE_0', 0, []].map((rotationMode) => ({ rotationMode })),
    { restore: edit(zero, (r) => { r.options.rotationMode = 'x'; }) },
    { restore: edit(zero, (r) => { r.options.rotationMode = null; }) },
    { restore: edit(zero, (r) => { r.options.rotationMode = undefined; }) },
    { restore: edit(zero, (r) => { r.stimulus.angles.ai[firstSlot] = (r.stimulus.angles.ai[firstSlot] + 90) % 360; }) },
    { restore: edit(zero, (r) => { r.stimulus.rotationMode = 'relative_pm90'; }) },
    { restore: edit(zero, (r) => { r.stimulus.version = 'tangram-prototype-v3'; }) },
    { restore: edit(zero, (r) => { r.trialId = PM90_TRIAL_ID; }) },
    { restore: edit(zero, (r) => { delete r.stimulus; }) },
    { restore: edit(pm, (r) => { r.options.rotationMode = 'relative_0'; }) },
    { restore: edit(pm, (r) => { delete r.options.rotationMode; }) },
    { restore: { ...pm, options: null } },
    { restore: { ...pm, options: [] } },
    { restore: (({ options, ...rest }) => rest)(pm) },
    { restore: { ...pm, options: Object.assign(Object.create({ inherited: true }), pm.options) } },
    { createTrial: ({ seed }) => structuredClone(createTrialV2({ seed })) },
    { createTrial: ({ seed }) => createTrialV2({ seed, rotationMode: 'relative_0' }) },
  ];
  for (const extra of cases) {
    const h = harness();
    await assert.rejects(createNamingTaskV2({ client: h.client, judge: h.judge, strategy: 'repair-first', seed: SEED, runDir: null,
      onPersist: h.onPersist, ...extra }), { code: 'invalid_options' }, JSON.stringify(Object.keys(extra)));
    assert.equal(h.calls(), 0);
    assert.equal(h.records.length, 0);
  }
});

test('N8 the answer key used for scoring is the same in both modes', async () => {
  const keys = [];
  for (const rotationMode of MODES) keys.push((await run({ rotationMode })).task.researcherView().key);
  assert.deepEqual(keys[0], keys[1]);
  assert.deepEqual(keys[0], createTrialV2({ seed: SEED }).key);
});

test('N9 participantReview rebuilds the scene from the recorded mode and refuses invalid ones', () => {
  const completed = (options) => ({ recordId: '00000000-0000-4000-8000-000000000001', status: 'completed', seed: SEED,
    startedAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:01:00.000Z', events: [], humanSubmission: {},
    scoring: { result: { provisional: false, success: false, matchedCount: 0, total: 6, figures: [] } },
    ...(options === undefined ? {} : { options }) });
  const scene = participantView(createTrialV2({ seed: SEED }));
  assert.deepEqual(participantReview(completed({ rotationMode: 'relative_0' })).scene, participantView(createTrialV2({ seed: SEED, rotationMode: 'relative_0' })));
  assert.deepEqual(participantReview(completed({ rotationMode: 'relative_pm90' })).scene, scene);
  assert.deepEqual(participantReview(completed({ referenceMemory: true })).scene, scene);
  assert.deepEqual(participantReview(completed(undefined)).scene, scene);
  for (const options of [{ rotationMode: 'x' }, { rotationMode: null }, { rotationMode: undefined }, null, []])
    assert.throws(() => participantReview(completed(options)), { code: 'operation_failed' }, JSON.stringify(options));
});
