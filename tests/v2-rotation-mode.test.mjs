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
const pngOf = (rotationMode, seed = SEED) => modelView(createTrialV2({ seed, rotationMode })).png.toString('base64');
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
const sawImage = (h, rotationMode, seed = SEED) => h.images.some((url) => url.includes(pngOf(rotationMode, seed)));

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

// #269 relative_90_180_270. Its seed is chosen from the turns the seed realizes: 90, 180 and 270 all occur, and the AI board
// differs from the AI boards of both earlier modes. (Seed 1701 above gives the same AI board as relative_pm90: no 180 occurs.)
const NEW = 'relative_90_180_270';
const turnsOf = (seed) => {
  const layouts = scatter.createLayoutsV2({ seed, rotationMode: NEW });
  return layouts.human.map((h) => (layouts.ai.find((a) => a.figureId === h.figureId).rotation - h.rotation + 360) % 360);
};
const NEW_SEED = (() => {
  for (let seed = 0; ; seed++) {
    if (![90, 180, 270].every((turn) => turnsOf(seed).includes(turn))) continue;
    if (['relative_pm90', 'relative_0'].some((mode) => pngOf(mode, seed) === pngOf(NEW, seed))) continue;
    return seed;
  }
})();

test('N10 relative_90_180_270 records its mode, stimulus and trialId and gives the model its own board', async () => {
  const { record, h } = await run({ rotationMode: NEW, seed: NEW_SEED });
  const trial = createTrialV2({ seed: NEW_SEED, rotationMode: NEW });
  assert.equal(record.options.rotationMode, NEW);
  assert.deepEqual(record.stimulus, scatter.trialStimulusV2(trial));
  assert.equal(record.trialId, trial.trialId);
  assert.ok(sawImage(h, NEW, NEW_SEED));
  assert.ok(!sawImage(h, 'relative_pm90', NEW_SEED) && !sawImage(h, 'relative_0', NEW_SEED));
  // The recorded AI angles carry a 180° turn: the seed was chosen for it.
  const turns = Object.entries(trial.key.ai).map(([slot, figureId]) => {
    const humanSlot = Object.keys(trial.key.human).find((s) => trial.key.human[s] === figureId);
    return (record.stimulus.angles.ai[slot] - record.stimulus.angles.human[humanSlot] + 360) % 360;
  });
  assert.ok(turns.includes(180) && turns.every((turn) => [90, 180, 270].includes(turn)));
});

test('N11 both strategies get the same relative_90_180_270 stimulus: trialId, board images and recorded stimulus', async () => {
  const [a, b] = await Promise.all(['repair-first', 'bypass-enabled'].map((strategy) => run({ strategy, rotationMode: NEW, seed: NEW_SEED })));
  assert.ok(a.h.images.length > 0);
  assert.deepEqual([...new Set(a.h.images)], [...new Set(b.h.images)]);
  assert.deepEqual(a.record.stimulus, b.record.stimulus);
  assert.equal(a.record.trialId, b.record.trialId);
});

test('N12 the participant state of relative_90_180_270 shows neither the mode nor angles, and its scene is the human board of relative_pm90', async () => {
  const { task } = await run({ rotationMode: NEW, seed: NEW_SEED });
  const state = task.getState();
  assert.doesNotMatch(JSON.stringify(state), /relative|rotation|angle|stimulus/iu);
  assert.deepEqual(state.scene, participantView(createTrialV2({ seed: NEW_SEED })));
});

test('N13 save → JSON → restore keeps relative_90_180_270 whatever the caller passes and shows the same board', async () => {
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    const first = await run({ strategy, rotationMode: NEW, seed: NEW_SEED });
    const saved = JSON.parse(JSON.stringify(first.record));
    for (const other of ['relative_pm90', 'relative_0', undefined]) {
      const h = harness();
      const { record } = await run({ strategy, rotationMode: other, seed: NEW_SEED, restore: saved }, h);
      assert.equal(record.options.rotationMode, NEW);
      assert.deepEqual(record.stimulus, saved.stimulus);
      assert.equal(record.trialId, saved.trialId);
      assert.ok(sawImage(h, NEW, NEW_SEED));
      assert.ok(!sawImage(h, 'relative_pm90', NEW_SEED) && !sawImage(h, 'relative_0', NEW_SEED));
    }
  }
});

test('N14 records that disagree with relative_90_180_270 are refused before any call or persist', async () => {
  const saved = JSON.parse(JSON.stringify((await run({ rotationMode: NEW, seed: NEW_SEED })).record));
  const edit = (change) => { const copy = structuredClone(saved); change(copy); return copy; };
  const slot = Object.keys(saved.stimulus.angles.ai)[0];
  const cases = [
    { restore: edit((r) => { r.stimulus.angles.ai[slot] = (r.stimulus.angles.ai[slot] + 90) % 360; }) },
    { restore: edit((r) => { r.stimulus.rotationMode = 'relative_pm90'; }) },
    { restore: edit((r) => { r.options.rotationMode = 'relative_pm90'; }) },
    { restore: edit((r) => { r.options.rotationMode = 'relative_90_180_270 '; }) },
    { restore: edit((r) => { delete r.stimulus; }) },
    { restore: edit((r) => { r.trialId = createTrialV2({ seed: NEW_SEED }).trialId; }) },
    { rotationMode: NEW, createTrial: ({ seed }) => createTrialV2({ seed }) },
    { rotationMode: NEW, createTrial: ({ seed }) => createTrialV2({ seed, rotationMode: 'relative_0' }) },
  ];
  for (const extra of cases) {
    const h = harness();
    await assert.rejects(createNamingTaskV2({ client: h.client, judge: h.judge, strategy: 'repair-first', seed: NEW_SEED, runDir: null,
      onPersist: h.onPersist, ...extra }), { code: 'invalid_options' }, JSON.stringify(Object.keys(extra)));
    assert.equal(h.calls(), 0);
    assert.equal(h.records.length, 0);
  }
});

test('N15 the answer key of relative_90_180_270 is the one of relative_pm90, and participantReview rebuilds its scene from the recorded mode', async () => {
  const { task } = await run({ rotationMode: NEW, seed: NEW_SEED });
  assert.deepEqual(task.researcherView().key, createTrialV2({ seed: NEW_SEED }).key);
  const completed = (options) => ({ recordId: '00000000-0000-4000-8000-000000000001', status: 'completed', seed: NEW_SEED,
    startedAt: '2026-11-28T00:00:00.000Z', updatedAt: '2026-11-28T00:01:00.000Z', events: [], humanSubmission: {},
    scoring: { result: { provisional: false, success: false, matchedCount: 0, total: 6, figures: [] } }, options });
  assert.deepEqual(participantReview(completed({ rotationMode: NEW })).scene, participantView(createTrialV2({ seed: NEW_SEED, rotationMode: NEW })));
  assert.deepEqual(participantReview(completed({ rotationMode: NEW })).scene, participantView(createTrialV2({ seed: NEW_SEED })));
});
