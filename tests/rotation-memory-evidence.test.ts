// The sources a statement relies on in the pre-made rotation memory. A model writes the path it was shown (a call's layer),
// the program reads the stored memo: every path of one view or region must read as the same unit, whichever layer showed it,
// so that a declaration on one layer and an independent extraction on another compare equal. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { projectOwnRotationMemory, rotationMemoryPin } from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import { rotationInitialMemo } from '../dialogue-model/runtime/observation/rotation-memo.ts';
import type { ObservationMemo } from '../dialogue-model/runtime/observation/contract.ts';
import { readVisualFeatureEvidence, readVisualFeatureSources, sameVisualFeatureSources } from '../dialogue-model/runtime/v2/visual-feature-evidence.ts';
import { projectOwnFigures } from '../workers/tangram-experiment/src/rotation-memory-source.ts';

const IDS = ['F6', 'F11', 'F16', 'F19', 'F20', 'F30'];
const trial = createTrialV2({ seed: 41, rotationMode: 'relative_90_180_270', figureSelection: { mode: 'custom', figureIds: IDS } });
const anchors = modelView(trial).anchors;
const memo: ObservationMemo = rotationInitialMemo(anchors, projectOwnFigures(trial, anchors, { pin: rotationMemoryPin, project: projectOwnRotationMemory }), '2026-11-28T00:00:00.000Z');
// A figure and a turned view that has a whole construal and part candidates, so every kind of path has something to point at.
const found = memo.figures.flatMap(figure => figure.rotation!.turned.map((view, k) => ({ figure, view, k })))
  .find(({ view }) => view.whole.length > 0 && Object.keys(view.parts).length > 0);
assert.ok(found, 'the fixture board has a turned view with a whole construal and parts');
const { figure, k } = found;
const id = figure.id;
// The plan allows the figures in `targets`; by default that is this figure and the one the path names.
const read = (path: (string | number)[], figureId = id, source = memo, targets = [id, figureId]) => readVisualFeatureSources([{ figureId, path }], source, targets);
const unit = ['rotation', 'turned', k];

test('every path to one turned view reads as that view, whichever layer showed it', () => {
  const stored = ['rotation', 'turned', k, 'whole', 0, 'noun'];       // a string of the stored projection
  const rolesLine = ['rotation', 'turned', k, 'whole', 0];             // the roles layer: one line per whole construal
  const partsLine = ['rotation', 'turned', k, 'parts'];                // the roles layer: the part candidates of the view
  const nounsLine = ['rotation', 'turned', k, 'view'];                 // the nouns layer: one line per view
  const partNoun = ['rotation', 'turned', k, 'parts', Object.keys(found.view.parts)[0], 0, 'noun'];
  for (const path of [stored, rolesLine, partsLine, nounsLine, partNoun, unit]) {
    assert.deepEqual(read(path), [{ figureId: id, path: unit }], JSON.stringify(path));
  }
});

test('the current view and a region read as their own units', () => {
  const regions = (figure.rotation!.regions);
  assert.deepEqual(read(['rotation', 'current']), [{ figureId: id, path: ['rotation', 'current'] }]);
  assert.deepEqual(read(['rotation', 'current', 'parts']), [{ figureId: id, path: ['rotation', 'current'] }]);
  const withWhole = memo.figures.find(f => f.rotation!.current.whole.length > 0);
  if (withWhole) assert.deepEqual(read(['rotation', 'current', 'whole', 0], withWhole.id), [{ figureId: withWhole.id, path: ['rotation', 'current'] }]);
  assert.ok(regions.length > 1);
  for (const path of [['rotation', 'regions', 1], ['rotation', 'regions', 1, 'shapeName']]) {
    assert.deepEqual(read(path), [{ figureId: id, path: ['rotation', 'regions', 1] }], JSON.stringify(path));
  }
});

test('a path that is not a source of the memory is refused', () => {
  const none = memo.figures.find(f => f.id !== id)!;
  const plain = structuredClone(memo); delete plain.figures.find(f => f.id === id)!.rotation;
  for (const path of [['rotation'], ['rotation', 'turned'], ['rotation', 'turned', 3], ['rotation', 'turned', k, 'zzz'], ['rotation', 'turned', k, 'whole', 9],
    ['rotation', 'turned', k, 'whole', 0, 'roles'], ['rotation', 'wholeAnywhere'], ['rotation', 'regions'], ['rotation', 'regions', 99],
    ['rotation', 'current', 'whole', 99], ['rotation', 'rel'], ['rotation', 'turned', -1], ['rotation', 'turned', '1']]) {
    assert.equal(read(path), null, JSON.stringify(path));
  }
  assert.equal(read(unit, id, plain), null, 'a figure without the memory has no such source');
  assert.equal(read(unit, none.id, memo, [id]), null, 'not a figure the plan allows');
});

test('a declaration on the generation layer and an extraction on the nouns layer compare equal; another view does not', () => {
  const declared = read(['rotation', 'turned', k, 'whole', 0])!;
  const extracted = (path: (string | number)[]) => readVisualFeatureEvidence({ sources: [{ source: { figureId: id, path }, quote: '向きを変えると' }] }, memo, [id])!;
  assert.ok(sameVisualFeatureSources(declared, extracted(['rotation', 'turned', k, 'view'])));
  assert.ok(sameVisualFeatureSources(declared, extracted(['rotation', 'turned', k, 'whole', 0, 'noun'])));
  assert.ok(!sameVisualFeatureSources(declared, extracted(['rotation', 'current'])));
  assert.ok(!sameVisualFeatureSources(declared, extracted(['rotation', 'turned', (k + 1) % 3, 'view'])));
});

test('two paths of one unit are one source; repeating the very same path is still refused', () => {
  const two = readVisualFeatureSources([{ figureId: id, path: ['rotation', 'turned', k, 'whole', 0] }, { figureId: id, path: ['rotation', 'turned', k, 'parts'] }], memo, [id]);
  assert.deepEqual(two, [{ figureId: id, path: unit }]);
  assert.equal(readVisualFeatureSources([{ figureId: id, path: ['rotation', 'turned', k, 'view'] }, { figureId: id, path: ['rotation', 'turned', k, 'view'] }], memo, [id]), null);
});

test('sources of earlier memos read exactly as before', () => {
  const earlier: ObservationMemo = { observedAt: '2026-11-28T00:00:00.000Z', figures: anchors.map((a: { id: string; bbox: { x: number; y: number; w: number; h: number } }) => ({ id: a.id, region: { ...a.bbox },
    holistic: [{ construal: '合成の見立て', basis: ['三角'], status: 'hypothesis' as const }],
    analytic: { shapes: ['三角'], composition: '辺がつながる', relations: ['接する'] }, unknowns: [], reobservations: [] })) };
  const target = anchors[0].id;
  const ok = (path: (string | number)[]) => readVisualFeatureSources([{ figureId: target, path }], earlier, [target]);
  assert.deepEqual(ok(['analytic', 'shapes', 0]), [{ figureId: target, path: ['analytic', 'shapes', 0] }]);
  assert.deepEqual(ok(['analytic', 'composition']), [{ figureId: target, path: ['analytic', 'composition'] }]);
  assert.deepEqual(ok(['holistic', 0, 'basis', 0]), [{ figureId: target, path: ['holistic', 0, 'basis', 0] }]);
  assert.equal(ok(['analytic', 'shapes', 5]), null);
  assert.equal(ok(['rotation', 'current']), null, 'no rotation memory, no such source');
  const same = { figureId: target, path: ['analytic', 'shapes', 0] };
  assert.equal(readVisualFeatureSources([same, structuredClone(same)], earlier, [target]), null, 'a repeated path stays refused');
});
