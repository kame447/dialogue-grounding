import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FIGURE_SETS, PILOT_FIGURE_SET_ID, resolveFigureSelection, validateResolvedFigureSelection } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { createLayoutsV2, createTrialV2, participantView, modelView, trialStimulusV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { scoreTrial, slotsOf } from '../dialogue-model/runtime/scoring.mjs';
import { createReferenceGraph, applyReferenceUpdate, snapshotReferenceGraph, summarizeForJudge } from '../dialogue-model/runtime/memory/reference-graph.mjs';

const preset = { mode: 'preset', setId: PILOT_FIGURE_SET_ID } as const;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

test('four-figure selections round-trip without adding fields to recorded selections', () => {
  assert.deepEqual(FIGURE_SETS[PILOT_FIGURE_SET_ID], ['F1', 'F2', 'F3', 'F4']);
  const random = { mode: 'seeded_random', selectionSeed: 12, figureCount: 4 } as const;
  assert.deepEqual(resolveFigureSelection(random).figureIds, ['F30', 'F18', 'F6', 'F21']);
  for (const spec of [preset, random, { mode: 'custom', figureIds: ['F7', 'F8', 'F9', 'F10'] }]) {
    const resolved = resolveFigureSelection(spec);
    assert.equal(resolved.figureIds.length, 4);
    assert.deepEqual(Object.keys(resolved), ['bankVersion', 'mode', 'setId', 'selectionSeed', 'figureIds']);
    assert.deepEqual(validateResolvedFigureSelection(JSON.parse(JSON.stringify(resolved))), resolved);
    const trial = createTrialV2({ seed: 73, figureSelection: resolved });
    assert.equal(participantView(trial).shapes.length, 4);
    assert.equal(modelView(trial).anchors.length, 4);
    assert.deepEqual(trialStimulusV2(trial)!.figureIds, resolved.figureIds);
    assert.deepEqual(createTrialV2({ seed: 73, figureSelection: spec }), trial);
    assert.notEqual(createTrialV2({ seed: 73 }).trialId, trial.trialId);
  }
  const six = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12 });
  assert.deepEqual(resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12, figureCount: 6 }), six);
  assert.throws(() => validateResolvedFigureSelection({ ...six, figureIds: six.figureIds.slice(0, 4) }), TypeError);
  for (const figureCount of [undefined, null, 0, 3, 5, 7, '4']) {
    assert.throws(() => resolveFigureSelection({ ...random, figureCount }), TypeError);
  }
  for (const figureIds of [['F1', 'F2', 'F3'], ['F1', 'F2', 'F3', 'F3'], ['F1', 'F2', 'F3', 'F31']]) {
    assert.throws(() => resolveFigureSelection({ mode: 'custom', figureIds }), TypeError);
  }
});

test('four-figure layouts preserve bounds, separation, rotation rules and private per-side identities', () => {
  for (const rotationMode of ['relative_0', 'relative_pm90']) for (let seed = 0; seed < 24; seed++) {
    const selection = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: seed, figureCount: 4 });
    const layout = createLayoutsV2({ seed, rotationMode, figureSelection: selection });
    assert.equal(new Set([...layout.human, ...layout.ai].map(shape => shape.id)).size, 8);
    for (const side of [layout.human, layout.ai]) {
      assert.equal(side.length, 4);
      assert.deepEqual(side.map(shape => shape.figureId).sort(), [...selection.figureIds].sort());
      for (const [i, shape] of side.entries()) {
        const a = shape.bbox;
        assert.ok(a.x >= 32 && a.y >= 32 && a.x + a.w <= 1168 && a.y + a.h <= 768);
        for (const other of side.slice(i + 1)) {
          const b = other.bbox;
          assert.ok(a.x >= b.x + b.w + 28 || b.x >= a.x + a.w + 28 || a.y >= b.y + b.h + 28 || b.y >= a.y + a.h + 28);
        }
      }
    }
    for (const human of layout.human) {
      const ai = layout.ai.find(shape => shape.figureId === human.figureId)!;
      assert.ok(Math.hypot(ai.center.x - human.center.x, ai.center.y - human.center.y) >= 96);
      const delta = (ai.rotation - human.rotation + 360) % 360;
      assert.ok(rotationMode === 'relative_0' ? delta === 0 : delta === 90 || delta === 270);
    }
  }
});

test('existing six-figure bank and seeded trials retain bytes captured before the four-figure change', () => {
  // Pins captured from unmodified ed93a8f, independently of the implementation below.
  const pins = [
    { selection: { mode: 'preset', setId: 'bank-set-a' }, trialId: 'tangram-prototype-v2-9314fb255a43872e',
      human: '12e33385fb77bac0510f8fb5e960764437365842f0f92e8b12065a2cf75bf649', ai: '17c8600667b790e81d2ab2aeaf41fbcdfa3087d55267eb1621ef56c27876f180',
      key: '8f52c3dc83d8f4d409e193f77911a06428807e61b1390a0fe68118a8d55c6f24', stimulus: 'de7ec88c217836b9129cc226c4da1061ff7dc77598fce4f7f66b75131347fbbf' },
    { selection: { mode: 'seeded_random', selectionSeed: 12 }, trialId: 'tangram-prototype-v2-166250765bef7310',
      human: '5cb027632130d1e1be9e5df1084a7a35abc0b65f7d62f0c52a675d33fda147c2', ai: '1ce9dec887dba5106709f0938ca85832f32e012fe6e5fbc72ea991b6c9927528',
      key: '9db593524ca1281ab923fa1494b7c2846972778b3c03924668d205e97ec3f9c2', stimulus: 'af6a73031d6c1d6216e03d0f3bfd126391eb5e1aa145812e5435a39ee7a28344' },
  ];
  for (const pin of pins) {
    const selection = resolveFigureSelection(pin.selection);
    assert.equal(selection.figureIds.length, 6);
    assert.deepEqual(validateResolvedFigureSelection(JSON.parse(JSON.stringify(selection))), selection);
    const trial = createTrialV2({ seed: 201, figureSelection: selection });
    assert.equal(trial.trialId, pin.trialId);
    assert.equal(sha(trial.human.png), pin.human);
    assert.equal(sha(trial.ai.png), pin.ai);
    assert.equal(sha(JSON.stringify(trial.key)), pin.key);
    assert.equal(sha(JSON.stringify(trialStimulusV2(trial))), pin.stimulus);
  }
});

const key = {
  human: { 's-0001': 'F1', 's-0002': 'F2', 's-0003': 'F3', 's-0004': 'F4' },
  ai: { 's-0011': 'F3', 's-0012': 'F1', 's-0013': 'F4', 's-0014': 'F2' },
};
const names: Record<string, string> = { F1: '鳥', F2: '船', F3: '人', F4: '木' };
const answers = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([slot, id]) => [slot, names[id]]));

test('four-figure scoring uses a denominator of four and retains mismatch, unnamed and duplicate rules', () => {
  const humanSubmission = answers(key.human), aiSubmission = answers(key.ai);
  const score = (ai = aiSubmission) => scoreTrial({ key, humanSubmission, aiSubmission: ai });
  assert.equal(score().total, 4);
  assert.equal(score().matchedCount, 4);
  assert.equal(score().success, true);
  const swapped = { ...aiSubmission, 's-0011': '鳥', 's-0012': '人' };
  assert.equal(score(swapped).matchedCount, 2);
  assert.equal(score(swapped).success, false);
  assert.equal(score({ ...aiSubmission, 's-0011': '' }).matchedCount, 3);
  assert.equal(score({ ...aiSubmission, 's-0011': '' }).unnamed.ai.length, 1);
  const duplicate = (map: Record<string, string>) => Object.fromEntries(Object.keys(map).map(slot => [slot, '同じ']));
  const duplicateScore = scoreTrial({ key, humanSubmission: duplicate(key.human), aiSubmission: duplicate(key.ai) });
  assert.equal(duplicateScore.matchedCount, 4);
  assert.equal(duplicateScore.success, false);
  const six = { ...key.ai, 's-0015': 'F5', 's-0016': 'F6' };
  for (const asymmetric of [{ human: key.human, ai: six }, { human: six, ai: key.human }]) {
    assert.throws(() => scoreTrial({ key: asymmetric, humanSubmission: {}, aiSubmission: {} }), TypeError);
  }
  assert.throws(() => slotsOf({ ...key.human, 's-0005': 'F5' }), TypeError);
});

test('four-slot reference memory retains names across JSON restore and rejects foreign slots', () => {
  const slots = Object.keys(key.ai), target = slots[0];
  const graph = createReferenceGraph({ slots, ownObservations: [{ slot: target, feature: '細長い' }] });
  const quote = '鳥で合意します';
  const operations = [
    { kind: 'mention', id: '1:m', sourceTurn: 1, speaker: 'human', quote, slots: [target], confidence: 0.8,
      epistemic: 'grounded', intent: 'name_acceptance', antecedent: null },
    { kind: 'name', id: '1:n', slot: target, name: '鳥', agreement: 'explicit', mentionIds: ['1:m'], replaces: null },
  ];
  const next = applyReferenceUpdate(graph, { expectedRevision: 0, turn: 1, operations }, {
    publicTurns: [{ turn: 1, speaker: 'human', text: quote }], generationSucceeded: true,
  });
  const restored = JSON.parse(JSON.stringify(next)), snapshot = snapshotReferenceGraph(restored);
  assert.deepEqual(Object.keys(snapshot.ownSlots), slots);
  assert.equal(snapshot.ownSlots[target].candidate.name, '鳥');
  assert.equal(snapshot.ownSlots[target].status, 'agreed');
  assert.deepEqual(Object.keys(JSON.parse(summarizeForJudge(restored)).ownSlots), slots);
  assert.throws(() => createReferenceGraph({ slots: [...slots, 's-0005'] }), { code: 'invalid_slots' });
  assert.throws(() => createReferenceGraph({ slots, ownObservations: [{ slot: 's-ffff', feature: '細長い' }] }), { code: 'invalid_slot' });
  restored.records[0].slots = ['s-ffff'];
  assert.throws(() => snapshotReferenceGraph(restored), { code: 'invalid_slot' });
});
