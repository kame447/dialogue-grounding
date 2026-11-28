// A new reception freezes the rotation-memory bundle and a trial reads it once, at its start, without any observation request.
// Earlier receptions (no pin) keep their plans, cache keys and memos. Synthetic ids only; no real dialogue data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrialV2, modelView, trialStimulusV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { PART_GEOMETRY_VERSION } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import { projectOwnRotationMemory, rotationMemoryPin } from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import {
  approveReception, canonicalReceptionProtocolV3, createReception, receptionProtocolSha256, validateReceptionPlan,
} from '../dialogue-model/runtime/v2/reception.ts';
import { SCRIPTED_OPENING_MODE } from '../dialogue-model/runtime/v2/opening-mode.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { sameRotationMemoryPin, validateRotationMemoryPin, validateRotationMemoryRecord } from '../dialogue-model/runtime/v2/rotation-memory-pin.ts';
import { readVisualFeatureEvidence } from '../dialogue-model/runtime/v2/visual-feature-evidence.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { buildReobservationMessages, mergeReobservation, validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';
import { workerTerraInitialKey } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import {
  ROTATION_MEMO_ABSENT, ROTATION_MEMO_COMPOSITION, createRotationMemoryObserver, rotationInitialMemo,
} from '../dialogue-model/runtime/observation/rotation-memo.ts';
import type { ObservationInput, ObservationMemo, ObservationObserver } from '../dialogue-model/runtime/observation/contract.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';
import { overrideRotationMemorySource, projectOwnFigures, rotationMemoryFor } from '../workers/tangram-experiment/src/rotation-memory-source.ts';
import type { RotationMemorySource } from '../workers/tangram-experiment/src/rotation-memory-source.ts';

const approvedAt = '2026-11-28T00:00:00.000Z';
const receptionId = '11111111-1111-4111-8111-111111111111';
const pin = validateParticipantModelPin({
  schemaVersion: 'participant_model_pin_v3', terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261001',
});
const FIGURES = {
  3: ['F1', 'F2', 'F8'], 4: ['F1', 'F2', 'F8', 'F30'], 6: ['F6', 'F11', 'F16', 'F19', 'F20', 'F30'],
} as const;
const realSource: RotationMemorySource = { pin: rotationMemoryPin, project: projectOwnRotationMemory };

async function approve(extra: Record<string, unknown>, figureIds: readonly string[] = FIGURES[3]) {
  const protocol = {
    schemaVersion: 'reception_protocol_v3', protocolId: '22222222-2222-4222-8222-222222222222', revision: 1,
    allowedOrders: [['bypass-enabled', 'repair-first']], seedPolicy: 'shared', referenceMemory: true,
    betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_90_180_270',
    figureSelection: { mode: 'custom', figureIds }, figureSetPolicy: 'shared',
  };
  const expected = { protocolId: protocol.protocolId, revision: protocol.revision,
    sha256: receptionProtocolSha256(canonicalReceptionProtocolV3(protocol)) };
  const pending = createReception({ receptionId, objectId: 'a'.repeat(64), createdAt: approvedAt, number: null });
  const result = await approveReception(pending, {
    expectedRevision: 0, order: 0, protocol, expected, approvedAt, randomSeed: () => 41,
    participantModelPin: pin, participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE,
    initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2, openingMode: SCRIPTED_OPENING_MODE, ...extra,
  } as Parameters<typeof approveReception>[1]);
  return result.plan as any;
}

function board(figureIds: readonly string[], rotationMode = 'relative_90_180_270', seed = 41) {
  const trial = createTrialV2({ seed, rotationMode, figureSelection: { mode: 'custom', figureIds } });
  const model = modelView(trial);
  const own: ObservationInput = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors };
  return { trial, own };
}
const unusedBase = (counter: { calls: number }): ObservationObserver => ({
  async observeAll() { counter.calls++; throw new Error('unexpected observation request'); },
  async reobserve() { counter.calls++; throw new Error('unexpected observation request'); },
});

test('a new plan freezes the pin; earlier plans keep their shape; it never combines with prepared or part observations', async () => {
  const bundle = rotationMemoryPin();
  const plan = await approve({ rotationMemory: bundle });
  assert.deepEqual((validateReceptionPlan(plan) as { rotationMemory?: unknown }).rotationMemory, bundle);
  assert.deepEqual(Object.keys(bundle).sort(), ['catalogRevision', 'dataSha256', 'version']);

  const earlier = await approve({});
  assert.equal(Object.hasOwn(validateReceptionPlan(earlier), 'rotationMemory'), false);
  assert.equal(Object.hasOwn(earlier, 'rotationMemory'), false);

  // The same plan is valid without the pin and refused with a malformed or doubled one.
  const prepared = { schemaVersion: 'prepared_observations_v1', bundleId: '33333333-3333-4333-8333-333333333333',
    preparedAt: '2026-11-27T00:00:00.000Z', trials: [0, 1].map(index => ({ index,
      cacheKey: 'terra_initial_observation_v1:' + 'a'.repeat(64), memoSha256: 'b'.repeat(64) })) };
  assert.ok((await approve({ preparedObservations: prepared })).preparedObservations, 'the prepared literal alone is valid');
  assert.ok((await approve({ partObservationVersion: PART_GEOMETRY_VERSION })).partObservationVersion, 'the part version alone is valid');
  await assert.rejects(approve({ rotationMemory: bundle, preparedObservations: prepared }));
  await assert.rejects(approve({ rotationMemory: bundle, partObservationVersion: PART_GEOMETRY_VERSION }));
  for (const bad of [{ ...bundle, extra: 1 }, { ...bundle, dataSha256: 'x'.repeat(64) }, { ...bundle, version: 'tangram_rotation_memory' }, null, 'v1']) {
    await assert.rejects(approve({ rotationMemory: bad }), Error);
  }
  const noProfile = structuredClone(plan);
  delete noProfile.participantRuntimeProfile;
  assert.throws(() => validateReceptionPlan(noProfile));
  const noPin = structuredClone(plan);
  delete noPin.participantModelPin; delete noPin.participantRuntimeProfile; delete noPin.initialObservationGeneration; delete noPin.openingMode;
  assert.throws(() => validateReceptionPlan(noPin));
});

test('the pin and the record shape are strict; a different bundle in the record is data, not a refusal', () => {
  const bundle = rotationMemoryPin();
  assert.deepEqual(validateRotationMemoryPin(bundle), bundle);
  const used = { ...bundle, dataSha256: '0'.repeat(64) };
  const record = validateRotationMemoryRecord({ pin: bundle, used });
  assert.equal(sameRotationMemoryPin(record.pin, bundle), true);
  assert.equal(sameRotationMemoryPin(record.used, bundle), false);
  for (const bad of [{ pin: bundle }, { pin: bundle, used, extra: 1 }, { pin: bundle, used: { ...used, extra: 1 } }, null, []]) {
    assert.throws(() => validateRotationMemoryRecord(bad), TypeError);
  }
});

test('only the production runtime with reference memory and a bundle freezes a pin', () => {
  const production = { participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE, participantModelPin: pin } as const;
  assert.deepEqual(rotationMemoryFor(production, true), rotationMemoryPin());
  assert.equal(rotationMemoryFor(production, false), undefined);
  assert.equal(rotationMemoryFor({ participantModelPin: pin }, true), undefined);
  assert.equal(rotationMemoryFor({ participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE }, true), undefined);
  const previous = overrideRotationMemorySource(undefined);
  try { assert.equal(rotationMemoryFor(production, true), undefined, 'no bundle in the deploy: earlier path'); }
  finally { overrideRotationMemorySource(previous); }
  assert.deepEqual(rotationMemoryFor(production, true), rotationMemoryPin());
});

for (const [count, ids] of [[3, FIGURES[3]], [4, FIGURES[4]], [6, FIGURES[6]]] as const) {
  for (const mode of count === 3 ? ['relative_pm90', 'relative_0', 'relative_90_180_270'] : ['relative_90_180_270']) {
    test(`${count} figures (${mode}): the first memo is static, projected by relative rotation, and carries nothing of the bank or the partner`, async () => {
      const { trial, own } = board(ids, mode);
      const counter = { calls: 0 };
      let projections = 0;
      const observer = createRotationMemoryObserver({ base: unusedBase(counter), own,
        project: () => { projections++; return projectOwnFigures(trial, own.ownAnchors, realSource); } });
      assert.equal(projections, 0, 'nothing is read before the first memo');
      const memo = await observer.observeAll(own);
      assert.equal(counter.calls, 0, 'no observation request');
      assert.equal(projections, 1);
      assert.deepEqual(memo.figures.map(f => f.id), own.ownAnchors.map(a => a.id));

      const stimulus = trialStimulusV2(trial)!;
      for (const figure of memo.figures) {
        assert.deepEqual(figure.holistic, []);
        assert.deepEqual(figure.analytic, { shapes: [], composition: ROTATION_MEMO_COMPOSITION, relations: [] });
        assert.deepEqual(figure.unknowns, []);
        assert.deepEqual(figure.reobservations, []);
        assert.deepEqual(figure.region, own.ownAnchors.find(a => a.id === figure.id)!.bbox);
        // The projection of THIS figure at the rotation it is shown at (bank key and absolute rotation stay inside the call).
        assert.deepEqual(figure.rotation, projectOwnRotationMemory({ figureKey: trial.key.ai[figure.id], rotation: stimulus.angles.ai[figure.id] }));
        assert.deepEqual(Object.keys(figure.rotation!), ['regions', 'current', 'turned', 'wholeAnywhere']);
        assert.deepEqual(figure.rotation!.turned.map(view => view.rel), [90, 180, 270]);
      }
      const text = JSON.stringify(memo);
      assert.doesNotMatch(text, /"F\d+"|figureKey|figureId|bankVersion|angles|"key"/u, 'no bank ID or researcher key');
      for (const shape of trial.human.scene.shapes) assert.ok(!text.includes(shape.id), 'no id of the partner side');
      assert.deepEqual(validateObservationMemo(memo, { ownAnchors: own.ownAnchors }), memo);
      assert.deepEqual(JSON.parse(text), memo, 'survives storage');
      // Two reads of equal inputs differ only in the timestamp.
      const again = await observer.observeAll(own);
      assert.deepEqual({ ...again, observedAt: '' }, { ...memo, observedAt: '' });
    });
  }
}

test('a figure the bundle lacks or cannot project keeps a plain entry and nothing stops', async () => {
  const { trial, own } = board(FIGURES[4]);
  const keys = FIGURES[4];
  const flaky: RotationMemorySource = { pin: rotationMemoryPin, project: ({ figureKey, rotation }) => {
    if (figureKey === keys[0]) return undefined;
    if (figureKey === keys[1]) throw new TypeError('impossible rotation');
    return projectOwnRotationMemory({ figureKey, rotation });
  } };
  const observer = createRotationMemoryObserver({ base: unusedBase({ calls: 0 }), own, project: () => projectOwnFigures(trial, own.ownAnchors, flaky) });
  const memo = await observer.observeAll(own);
  for (const figure of memo.figures) {
    const key = trial.key.ai[figure.id];
    if (key === keys[0] || key === keys[1]) {
      assert.equal(Object.hasOwn(figure, 'rotation'), false);
      assert.equal(figure.analytic.composition, ROTATION_MEMO_ABSENT);
    } else assert.ok(figure.rotation);
  }
  assert.deepEqual(validateObservationMemo(memo, { ownAnchors: own.ownAnchors }), memo);
  // With no bundle at all every entry is plain, and the memo is still valid.
  const none = rotationInitialMemo(own.ownAnchors, new Map(), memo.observedAt);
  assert.ok(none.figures.every(f => !Object.hasOwn(f, 'rotation') && f.analytic.composition === ROTATION_MEMO_ABSENT));
  assert.deepEqual(validateObservationMemo(none, { ownAnchors: own.ownAnchors }), none);
});

test('the observer refuses another board and an abort, and re-observation still goes to the base observer', async () => {
  const { trial, own } = board(FIGURES[4]);
  const seen: unknown[] = [];
  const base: ObservationObserver = {
    async observeAll() { throw new Error('unexpected'); },
    async reobserve(input) { seen.push(input); return { observedAt: approvedAt, issue: input.issue, figures: [] }; },
  };
  const observer = createRotationMemoryObserver({ base, own, project: () => projectOwnFigures(trial, own.ownAnchors, realSource) });
  await assert.rejects(observer.observeAll({ ...own, ownAnchors: own.ownAnchors.slice(0, 3) }), (e: any) => e.code === 'invalid_input');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(observer.observeAll(own, { signal: controller.signal }), (e: any) => e.code === 'aborted');
  const memo = await observer.observeAll(own);
  const request = { ...own, memo, figureIds: [own.ownAnchors[0].id], issue: { aspect: 'part' as const, question: '形は？', partnerConstrual: null } };
  assert.equal((await observer.reobserve(request)).issue.question, '形は？');
  assert.equal(seen.length, 1);
});

test('rotation is optional per figure; only a malformed saved value is refused; earlier memos are untouched', async () => {
  const { trial, own } = board(FIGURES[3]);
  const memo = rotationInitialMemo(own.ownAnchors, projectOwnFigures(trial, own.ownAnchors, realSource), approvedAt);
  const mixed = structuredClone(memo) as ObservationMemo;
  delete mixed.figures[0].rotation;
  assert.deepEqual(validateObservationMemo(mixed, { ownAnchors: own.ownAnchors }), mixed);
  const corrupt = (edit: (figure: any) => void) => { const copy = structuredClone(memo) as any; edit(copy.figures[1]); return copy; };
  for (const edit of [
    (f: any) => { f.rotation.turned.pop(); },
    (f: any) => { f.rotation.extra = 1; },
    (f: any) => { f.rotation.wholeAnywhere = !f.rotation.wholeAnywhere; },
    (f: any) => { f.rotation = 'x'; },
    (f: any) => { f.rotation.regions[0].adjacent = ['P9']; },
  ]) assert.throws(() => validateObservationMemo(corrupt(edit), { ownAnchors: own.ownAnchors }), (e: any) => e.code === 'invalid_input');
  // An earlier (Terra-style) memo has no rotation key and validates exactly as before.
  const earlier: ObservationMemo = { observedAt: approvedAt, figures: own.ownAnchors.map(a => ({ id: a.id, region: { ...a.bbox },
    holistic: [{ construal: '合成の見立て', basis: ['三角'], status: 'hypothesis' as const }],
    analytic: { shapes: ['三角'], composition: '辺がつながる', relations: [] }, unknowns: [], reobservations: [] })) };
  const checked = validateObservationMemo(earlier, { ownAnchors: own.ownAnchors });
  assert.deepEqual(checked, earlier);
  assert.ok(checked.figures.every(f => !Object.hasOwn(f, 'rotation')));
});

test('a re-observation of a rotation-memory memo carries only the targeted figure and still merges back', async () => {
  const { trial, own } = board(FIGURES[4]);
  const memo = rotationInitialMemo(own.ownAnchors, projectOwnFigures(trial, own.ownAnchors, realSource), approvedAt);
  const [target, other] = own.ownAnchors;
  const issue = { aspect: 'part' as const, question: '三角形の大きさは？', partnerConstrual: null };
  const messages = buildReobservationMessages({ ...own, memo, figureIds: [target.id], issue });
  const text = JSON.stringify(messages);
  // The re-observation shows the nouns layer (one line per view) with its legend, not the full projection.
  assert.ok(text.includes(target.id) && text.includes('rotationLegend') && text.includes('全体: '), 'the targeted figure brings its memory');
  assert.ok(!text.includes(other.id), 'no other figure of the board');
  assert.doesNotMatch(text, /"F\d+"|figureKey|bankVersion/u);
  const merged = mergeReobservation(memo, { observedAt: '2026-11-28T00:00:01.000Z', issue,
    figures: [{ figureId: target.id, supports: ['三角を含む'], contradicts: [], unknown: [] }] });
  assert.equal(merged.figures.find(f => f.id === target.id)!.reobservations.length, 1);
  assert.deepEqual(merged.figures.map(f => f.rotation), memo.figures.map(f => f.rotation), 'the saved memory is not touched');
  assert.deepEqual(validateObservationMemo(merged, { ownAnchors: own.ownAnchors }), merged);
});

test('visual-feature evidence resolves rotation paths, and only those that lead to a string of that figure', async () => {
  const { trial, own } = board(FIGURES[3]);
  const memo = rotationInitialMemo(own.ownAnchors, projectOwnFigures(trial, own.ownAnchors, realSource), approvedAt);
  const figure = memo.figures[0];
  const evidence = (path: (string | number)[], target = figure.id) =>
    readVisualFeatureEvidence({ sources: [{ source: { figureId: target, path }, quote: '三角' }] }, memo, [target]);
  assert.ok(evidence(['rotation', 'regions', 0, 'shapeName']));
  assert.equal(evidence(['rotation', 'regions', 99, 'shapeName']), null, 'no such region');
  assert.equal(evidence(['rotation', 'wholeAnywhere']), null, 'not a string');
  assert.equal(evidence(['rotation']), null, 'a whole projection is not a statement');
  const plain = structuredClone(memo); delete plain.figures[0].rotation;
  assert.equal(readVisualFeatureEvidence({ sources: [{ source: { figureId: figure.id, path: ['rotation', 'regions', 0, 'shapeName'] }, quote: '三角' }] }, plain, [figure.id]), null);
});

// Computed from 75c66cc (before this change) and from this tree: identical. A reception without the pin never gets ownParts or rotation.
const OLD_KEYS: Record<string, string> = {
  'legacy6:none': 'terra_initial_observation_v1:9620853a805bcdb7c371a5d2ef785197521b57ba89d61f728f91a740457d242e',
  'legacy6:structured_outputs_v1': 'terra_initial_observation_v1:95d89de093edf1c24c4b145e4094368a1e1d1086cbcd63f4e429f4bb858bf138',
  'legacy6:structured_outputs_v2': 'terra_initial_observation_v1:6282de4f0b1a8f0d26b7f0b4d2b5da1897b1ddd1096cb008b4973a4633b3ed35',
  'custom3:none': 'terra_initial_observation_v1:f5931be5ab91633edcdd30ce7b1ba41fcc2f1941c5ba592f2a376b8dcd18b865',
  'custom3:structured_outputs_v1': 'terra_initial_observation_v1:feeecd7363e3c605ddde44d3e2ba57833c5b9a9e14b471b35b788bd9f8161b08',
  'custom3:structured_outputs_v2': 'terra_initial_observation_v1:63f1f0f9084f045efb525736b41948a434512cf19f2bc5cbeb064d4785cc6664',
  'custom4:none': 'terra_initial_observation_v1:fde99c6307d0c2c508bf366be245016925a2e91ae7678cc3a5ffcbe0a7a956be',
  'custom4:structured_outputs_v1': 'terra_initial_observation_v1:f9e216f7988a5d7a1f60e9f9b44a2d71e783e04f8cbcf0d8096da6ef59667fad',
  'custom4:structured_outputs_v2': 'terra_initial_observation_v1:8aabab9ba186c71ad85fbdb9aa6537b73dbff7a151d341d60ab0816a4b32ffb9',
};
test('earlier receptions keep their initial observation cache keys byte for byte', async () => {
  const earlierPin = validateParticipantModelPin({ schemaVersion: 'participant_model_pin_v1', terraModelId: 'gpt-6.1-terra-2026-11-01',
    lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261001' });
  const cases: [string, any][] = [
    ['legacy6', { seed: 41, rotationMode: 'relative_pm90' }],
    ['custom3', { seed: 7, rotationMode: 'relative_90_180_270', figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F8'] } }],
    ['custom4', { seed: 11, rotationMode: 'relative_0', figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F8', 'F30'] } }],
  ];
  for (const [name, options] of cases) {
    const model = modelView(createTrialV2(options));
    const own: ObservationInput = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors };
    for (const generation of [undefined, 'structured_outputs_v1', 'structured_outputs_v2'] as const) {
      assert.equal(await workerTerraInitialKey(earlierPin, own, generation), OLD_KEYS[`${name}:${generation ?? 'none'}`], `${name}:${generation}`);
    }
  }
});
