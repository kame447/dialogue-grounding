// The sources a statement relies on in the pre-made rotation memory (postGenerationCheck on). A model writes the path it was shown
// (a call's layer), the program reads the stored memo. The unit of a source is one candidate of a view (whole/i, parts/Pk/j), so a
// different candidate of the same view is a different source; an extraction that only reaches a view names its candidate through the
// words it quotes. Synthetic nouns and ids only: the contract does not depend on the bundle's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOwnRotationMemory } from '../dialogue-model/runtime/stimuli/rotation-memory-shape.ts';
import { rotationInitialMemo } from '../dialogue-model/runtime/observation/rotation-memo.ts';
import type { ObservationMemo } from '../dialogue-model/runtime/observation/contract.ts';
import { readVisualFeatureEvidence, readVisualFeatureSources, sameVisualFeatureSources } from '../dialogue-model/runtime/v2/visual-feature-evidence.ts';

const id = 's-0000';
const region = (rid: string, shapeName: string, areaPercent: number, at: string, adjacent: string[]) => ({ id: rid, shapeName, areaPercent, at, adjacent });
const whole = (noun: string, roles: Record<string, string>) => ({ noun, posture: '座っている', direction: '右向き', roles });
// turned[0] (rel 90): a whole construal and two part candidates of P2 (腕・袖) plus 耳 on P1 and on P3 (the same noun twice);
// turned[2] (rel 270): two whole construals (ニワトリ・馬); turned[1] (rel 180): nothing.
const rotation = validateOwnRotationMemory({
  regions: [region('P1', '三角形', 20, '上寄り', ['P2']), region('P2', '台形', 60, '中央付近', ['P1', 'P3']), region('P3', '三角形', 20, '下寄り', ['P2'])],
  current: { whole: [whole('猫', { P1: '耳', P2: '体', P3: '尾' })], parts: {} },
  turned: [
    { rel: 90, whole: [whole('ウサギ', { P1: '耳', P2: '体', P3: '尾' })], parts: { P1: [{ noun: '耳' }], P2: [{ noun: '腕' }, { noun: '袖' }], P3: [{ noun: '耳' }] } },
    { rel: 180, whole: [], parts: {} },
    { rel: 270, whole: [whole('ニワトリ', { P1: 'とさか', P2: '体', P3: '足' }), whole('馬', { P1: '耳', P2: '胴', P3: '脚' })], parts: {} },
  ],
  wholeAnywhere: true,
});
const memo: ObservationMemo = rotationInitialMemo([{ id, bbox: { x: 0, y: 0, w: 10, h: 10 }, centroid: { x: 5, y: 5 } }], new Map([[id, rotation]]), '2026-11-28T00:00:00.000Z');
const declared = (path: (string | number)[]) => readVisualFeatureSources([{ figureId: id, path }], memo, [id]);
const extracted = (path: (string | number)[], quote: string) =>
  readVisualFeatureEvidence({ sources: [{ source: { figureId: id, path }, quote }] }, memo, [id], quote);
const agree = (generation: (string | number)[], extraction: (string | number)[], quote: string) => {
  const d = declared(generation), e = extracted(extraction, quote);
  return !!d && !!e && sameVisualFeatureSources(d, e);
};
const unit = (path: (string | number)[]) => [{ figureId: id, path }];

test('every path to one candidate reads as that candidate, whichever layer showed it', () => {
  const t2 = ['rotation', 'turned', 2];
  for (const path of [[...t2, 'whole', 0], [...t2, 'whole', 0, 'noun'], [...t2, 'whole', 0, 'posture'], [...t2, 'whole', 0, 'roles', 'P1']]) {
    assert.deepEqual(declared(path), unit([...t2, 'whole', 0]), JSON.stringify(path));
  }
  assert.deepEqual(declared([...t2, 'whole', 1, 'noun']), unit([...t2, 'whole', 1]));
  const t0 = ['rotation', 'turned', 0];
  assert.deepEqual(declared([...t0, 'parts', 'P2', 1]), unit([...t0, 'parts', 'P2', 1]));
  assert.deepEqual(declared([...t0, 'parts', 'P2', 1, 'noun']), unit([...t0, 'parts', 'P2', 1]));
  assert.deepEqual(declared(['rotation', 'current', 'whole', 0, 'noun']), unit(['rotation', 'current', 'whole', 0]));
  assert.deepEqual(declared(['rotation', 'regions', 1, 'shapeName']), unit(['rotation', 'regions', 1]));
  assert.deepEqual(declared(['rotation', 'regions', 1]), unit(['rotation', 'regions', 1]));
});

test('a view, its line and a region of part candidates are coarse units; the same noun twice in a view is one candidate', () => {
  const t0 = ['rotation', 'turned', 0];
  for (const path of [t0, [...t0, 'view'], [...t0, 'parts']]) assert.deepEqual(declared(path), unit(t0), JSON.stringify(path));
  assert.deepEqual(declared(['rotation', 'current']), unit(['rotation', 'current']));
  assert.deepEqual(declared([...t0, 'parts', 'P2']), unit([...t0, 'parts', 'P2']));
  // 耳 is offered by P1 and by P3: the first in stored order stands for both.
  assert.deepEqual(declared([...t0, 'parts', 'P3', 0, 'noun']), unit([...t0, 'parts', 'P1', 0]));
  assert.deepEqual(declared([...t0, 'parts', 'P1', 0]), unit([...t0, 'parts', 'P1', 0]));
});

test('a path that is not a source of the memory is refused', () => {
  const plain = structuredClone(memo); delete plain.figures[0].rotation;
  const t0 = ['rotation', 'turned', 0], t2 = ['rotation', 'turned', 2];
  for (const path of [['rotation'], ['rotation', 'turned'], ['rotation', 'turned', 3], ['rotation', 'turned', -1], ['rotation', 'turned', '1'],
    [...t2, 'zzz'], [...t2, 'whole'], [...t2, 'whole', 2], [...t2, 'whole', 0, 'zzz'], [...t0, 'parts', 'P9'], [...t0, 'parts', 'P2', 2],
    [...t0, 'parts', 'P2', 0, 'zzz'], ['rotation', 'wholeAnywhere'], ['rotation', 'regions'], ['rotation', 'regions', 3], ['rotation', 'regions', 1, 'zzz'],
    ['rotation', 'current', 'view'], ['rotation', 'current', 'whole', 1]]) {
    assert.equal(declared(path), null, JSON.stringify(path));
  }
  assert.equal(readVisualFeatureSources([{ figureId: id, path: [...t2, 'whole', 0] }], plain, [id]), null, 'a figure without the memory has no such source');
  assert.equal(readVisualFeatureSources([{ figureId: id, path: [...t2, 'whole', 0] }], memo, []), null, 'not a figure the plan allows');
});

test('a different candidate of the same view is a different source, whether the extraction names it by path or by its quote', () => {
  const t2 = ['rotation', 'turned', 2];
  assert.ok(agree([...t2, 'whole', 0], [...t2, 'view'], '向きを変えるとニワトリに見えます。'), 'same candidate');
  assert.ok(agree([...t2, 'whole', 1], [...t2, 'view'], '向きを変えると馬に見えます。'), 'same candidate, the other one');
  assert.ok(!agree([...t2, 'whole', 1], [...t2, 'view'], '向きを変えるとニワトリに見えます。'), 'declared 馬, quoted ニワトリ');
  assert.ok(!agree([...t2, 'whole', 1], [...t2, 'whole', 0, 'noun'], '向きを変えるとニワトリに見えます。'), 'declared 馬, extracted ニワトリ by path');
  assert.ok(!agree([...t2, 'whole', 0], [...t2, 'view'], '向きを変えると分かりやすいです。'), 'the quote names no candidate: not verified');
  assert.ok(!agree([...t2, 'whole', 0], ['rotation', 'turned', 0, 'view'], '向きを変えるとウサギに見えます。'), 'another view');
  assert.ok(!agree([...t2, 'whole', 0], ['rotation', 'current'], '今は猫に見えます。'), 'another view (the current one)');
  assert.ok(agree([...t2, 'view'], [...t2, 'view'], '向きを変えると分かりやすいです。'), 'two coarse sources of one view agree');
});

test('part candidates are told apart per candidate, and per region by the words quoted', () => {
  const t0 = ['rotation', 'turned', 0];
  assert.ok(agree([...t0, 'parts', 'P2', 0, 'noun'], [...t0, 'view'], '横にすると腕のように見えます。'));
  assert.ok(!agree([...t0, 'parts', 'P2', 1, 'noun'], [...t0, 'view'], '横にすると腕のように見えます。'), 'declared 袖, quoted 腕');
  assert.ok(agree([...t0, 'parts', 'P2', 1], [...t0, 'parts', 'P2'], '横にすると袖のように見えます。'), 'a region-level extraction narrows to the region’s candidate');
  assert.ok(!agree([...t0, 'parts', 'P2', 1], [...t0, 'parts', 'P2'], '横にすると腕のように見えます。'));
  // The same noun on two regions is one candidate for matching: declared on P3, quoted without a region.
  assert.ok(agree([...t0, 'parts', 'P3', 0, 'noun'], [...t0, 'view'], '横にすると耳のように見えます。'));
  // A part noun is not a whole construal of the view.
  assert.ok(!agree([...t0, 'whole', 0], [...t0, 'view'], '横にすると腕のように見えます。'));
});

test('a quote that names two candidates is two sources; both must have been declared', () => {
  const t0 = ['rotation', 'turned', 0];
  const both = extracted([...t0, 'view'], 'ウサギで、腕のように見えます。')!;
  assert.deepEqual(both.sources.map(s => s.source.path), [[...t0, 'whole', 0], [...t0, 'parts', 'P2', 0]]);
  const two = readVisualFeatureSources([{ figureId: id, path: [...t0, 'whole', 0] }, { figureId: id, path: [...t0, 'parts', 'P2', 0, 'noun'] }], memo, [id])!;
  assert.ok(sameVisualFeatureSources(two, both));
  assert.ok(!sameVisualFeatureSources(declared([...t0, 'whole', 0])!, both), 'a statement that uses two candidates declared one');
});

test('two paths of one candidate are one source; repeating the very same path is still refused', () => {
  const t2 = ['rotation', 'turned', 2];
  const merged = readVisualFeatureSources([{ figureId: id, path: [...t2, 'whole', 0] }, { figureId: id, path: [...t2, 'whole', 0, 'noun'] }], memo, [id]);
  assert.deepEqual(merged, unit([...t2, 'whole', 0]));
  assert.deepEqual(readVisualFeatureSources([{ figureId: id, path: [...t2, 'whole', 0] }, { figureId: id, path: [...t2, 'whole', 1] }], memo, [id])!.length, 2);
  assert.equal(readVisualFeatureSources([{ figureId: id, path: [...t2, 'view'] }, { figureId: id, path: [...t2, 'view'] }], memo, [id]), null);
});

test('sources of earlier memos read exactly as before', () => {
  const earlier: ObservationMemo = { observedAt: '2026-11-28T00:00:00.000Z', figures: [{ id, region: { x: 0, y: 0, w: 10, h: 10 },
    holistic: [{ construal: '合成の見立て', basis: ['三角'], status: 'hypothesis' as const }],
    analytic: { shapes: ['尖った形', '細長い形'], composition: '辺がつながる', relations: ['接する'] }, unknowns: [], reobservations: [] }] };
  const ok = (path: (string | number)[]) => readVisualFeatureSources([{ figureId: id, path }], earlier, [id]);
  assert.deepEqual(ok(['analytic', 'shapes', 0]), unit(['analytic', 'shapes', 0]));
  assert.deepEqual(ok(['analytic', 'composition']), unit(['analytic', 'composition']));
  assert.deepEqual(ok(['holistic', 0, 'basis', 0]), unit(['holistic', 0, 'basis', 0]));
  assert.equal(ok(['analytic', 'shapes', 5]), null);
  assert.equal(ok(['rotation', 'current']), null, 'no rotation memory, no such source');
  const same = { figureId: id, path: ['analytic', 'shapes', 0] };
  assert.equal(readVisualFeatureSources([same, structuredClone(same)], earlier, [id]), null, 'a repeated path stays refused');
  const evidence = (path: (string | number)[], quote: string) => readVisualFeatureEvidence({ sources: [{ source: { figureId: id, path }, quote }] }, earlier, [id], quote)!;
  assert.ok(sameVisualFeatureSources(ok(['analytic', 'shapes', 0])!, evidence(['analytic', 'shapes', 0], '尖った形です。')));
  assert.ok(!sameVisualFeatureSources(ok(['analytic', 'shapes', 1])!, evidence(['analytic', 'shapes', 0], '尖った形です。')));
});
