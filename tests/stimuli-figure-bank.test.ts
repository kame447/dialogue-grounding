import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FIGURES } from '../dialogue-model/runtime/stimuli/figures.mjs';
import { validateFigures } from '../dialogue-model/runtime/stimuli/geometry.mjs';
import {
  FIGURE_BANK, FIGURE_BANK_VERSION, FIGURE_SETS, LEGACY_FIGURE_SET_ID,
  resolveFigureSelection, validateResolvedFigureSelection, isLegacyFigureSelection,
} from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { renderBankCatalogHtml } from '../dialogue-model/runtime/stimuli/render-bank-sheet.ts';
import { createTrialV2, createLayoutsV2, participantView, modelView, trialStimulusV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const SEEDS = [1, 2, 3, 201, 4242];
const PRESETS = Object.keys(FIGURE_SETS);

test('bank has 30 valid, unique figures and keeps F1-F6 byte-identical', () => {
  assert.equal(FIGURE_BANK.length, 30);
  assert.deepEqual(FIGURE_BANK.map(f => f.id), Array.from({ length: 30 }, (_, i) => 'F' + (i + 1)));
  assert.deepEqual(validateFigures(FIGURE_BANK), { valid: true, errors: [] });
  assert.equal(JSON.stringify(FIGURE_BANK.slice(0, 6)), JSON.stringify(FIGURES));
  for (const f of FIGURE_BANK) {
    const pts = f.pieces.flatMap(p => p.points);
    const w = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]));
    const h = Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]));
    assert.ok(Math.max(w, h) <= 9 && Math.min(w, h) >= 2, f.id);
  }
});

test('legacy selection is byte-identical to the unspecified call and the seed 201 pin', () => {
  const a = createTrialV2({ seed: 201 });
  const b = createTrialV2({ seed: 201, figureSelection: { mode: 'preset', setId: LEGACY_FIGURE_SET_ID } });
  assert.equal(a.trialId, b.trialId);
  assert.deepEqual(a.human.png, b.human.png);
  assert.deepEqual(a.ai.png, b.ai.png);
  assert.deepEqual(a.ai.anchors, b.ai.anchors);
  assert.deepEqual(a.key, b.key);
  assert.equal(sha(a.ai.png), 'd53d538887af2df0be62ceeb02cb261661c75edb8ea2355d2c319836193dd280');
  assert.deepEqual(trialStimulusV2(a), trialStimulusV2(b));
  assert.equal(Object.hasOwn(trialStimulusV2(a)!, 'bankVersion'), false);
});

test('every preset and seeded_random selection places its recorded figures on both sides', () => {
  const specs = [
    ...PRESETS.flatMap(setId => SEEDS.map(seed => ({ seed, spec: { mode: 'preset', setId } }))),
    ...Array.from({ length: 20 }, (_, i) => ({ seed: 100 + i, spec: { mode: 'seeded_random', selectionSeed: i * 37 - 5 } })),
  ];
  const ids = new Set<string>();
  for (const { seed, spec } of specs) {
    const resolved = resolveFigureSelection(spec);
    const trial = createTrialV2({ seed, figureSelection: spec });
    const human = Object.values(trial.key.human) as string[], ai = Object.values(trial.key.ai) as string[];
    assert.equal(new Set(human).size, resolved.figureIds.length);
    assert.deepEqual([...human].sort(), [...resolved.figureIds].sort());
    assert.deepEqual([...ai].sort(), [...resolved.figureIds].sort());
    const stim = trialStimulusV2(trial)!;
    for (const side of ['human', 'ai']) for (const angle of Object.values(stim.angles[side])) assert.ok([0, 90, 180, 270].includes(angle as number));
    ids.add(trial.trialId);
    if (isLegacyFigureSelection(resolved)) continue; // legacy keeps the original record shape
    assert.deepEqual(stim.figureIds, resolved.figureIds);
    assert.equal(stim.figureSetId, resolved.setId);
    assert.equal(stim.bankVersion, FIGURE_BANK_VERSION);
    assert.equal(stim.selectionMode, resolved.mode);
    assert.equal(stim.selectionSeed, resolved.selectionSeed);
  }
  // Same seed, different sets: distinct trial ids.
  const same = PRESETS.map(setId => createTrialV2({ seed: 7, figureSelection: { mode: 'preset', setId } }).trialId);
  assert.equal(new Set(same).size, PRESETS.length);
  assert.ok(ids.size > 0);
});

test('same (seed, figureSelection) reproduces bytes; rotation modes keep working', () => {
  const spec = { mode: 'custom', figureIds: ['F30', 'F2', 'F17', 'F8', 'F23', 'F11'] };
  for (const rotationMode of ['relative_pm90', 'relative_0']) {
    const a = createTrialV2({ seed: 9, rotationMode, figureSelection: spec });
    const b = createTrialV2({ seed: 9, rotationMode, figureSelection: spec });
    assert.deepEqual(a.human.png, b.human.png);
    assert.deepEqual(a.ai.png, b.ai.png);
    assert.deepEqual(a.key, b.key);
    assert.deepEqual(createLayoutsV2({ seed: 9, rotationMode, figureSelection: spec }), createLayoutsV2({ seed: 9, rotationMode, figureSelection: spec }));
  }
  const rel0 = createTrialV2({ seed: 9, rotationMode: 'relative_0', figureSelection: spec });
  const angles = trialStimulusV2(rel0)!.angles;
  const byFigure = (side: string) => Object.fromEntries(Object.entries(rel0.key[side]).map(([id, f]) => [f, angles[side][id]]));
  assert.deepEqual(byFigure('human'), byFigure('ai'));
});

test('participant and model views never expose bank identity', () => {
  for (const setId of PRESETS) {
    const trial = createTrialV2({ seed: 11, figureSelection: { mode: 'preset', setId } });
    const text = JSON.stringify(participantView(trial)) + JSON.stringify({ ...modelView(trial), png: undefined });
    assert.doesNotMatch(text, /F(?:[7-9]|[12][0-9]|30)\b|bank-set|tangram-bank|selectionSeed|figureIds|figureSetId|bankVersion|legacy-v1/);
  }
});

test('invalid selections fail closed', () => {
  const bad: unknown[] = [
    null, 'legacy-v1', {}, { mode: 'x' },
    { mode: 'preset', setId: 'nope' }, { mode: 'preset', setId: '__proto__' }, { mode: 'preset' },
    { mode: 'seeded_random', selectionSeed: 1.5 }, { mode: 'seeded_random', selectionSeed: '3' }, { mode: 'seeded_random', selectionSeed: 2 ** 60 },
    { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5'] },
    { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F5'] },
    { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F31'] },
    { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'] },
  ];
  for (const spec of bad) {
    assert.throws(() => resolveFigureSelection(spec), TypeError);
    assert.throws(() => createTrialV2({ seed: 1, figureSelection: spec }), TypeError);
  }
  const ok = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 5 });
  assert.deepEqual(validateResolvedFigureSelection(JSON.parse(JSON.stringify(ok))), ok);
  assert.throws(() => validateResolvedFigureSelection({ ...ok, setId: 'seeded-00000000' }));
  assert.throws(() => validateResolvedFigureSelection({ ...ok, bankVersion: 'v0' }));
  assert.throws(() => validateResolvedFigureSelection({ ...ok, figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] }));
  const presetOk = resolveFigureSelection({ mode: 'preset', setId: 'bank-set-a' });
  assert.deepEqual(resolveFigureSelection(presetOk), presetOk);
  for (const tampered of [
    { ...presetOk, bankVersion: 'v0' },
    { ...presetOk, figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] },
    { ...presetOk, setId: 'bank-set-b' },
    { mode: 'preset', setId: 'bank-set-a', extra: true },
  ]) {
    assert.throws(() => resolveFigureSelection(tampered), TypeError);
    assert.throws(() => createTrialV2({ seed: 1, figureSelection: tampered }), TypeError);
  }
});

test('resolution shapes and legacy detection', () => {
  const legacy = resolveFigureSelection();
  assert.equal(isLegacyFigureSelection(legacy), true);
  assert.deepEqual(legacy, { bankVersion: FIGURE_BANK_VERSION, mode: 'preset', setId: 'legacy-v1', selectionSeed: null, figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] });
  const custom = resolveFigureSelection({ mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] });
  assert.equal(isLegacyFigureSelection(custom), false);
  assert.match(custom.setId!, /^custom-[0-9a-f]{8}$/);
  const seeded = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12 });
  assert.match(seeded.setId!, /^seeded-[0-9a-f]{8}$/);
  assert.equal(seeded.selectionSeed, 12);
  assert.equal(new Set(seeded.figureIds).size, 6);
  assert.deepEqual(seeded, resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12 }));
});

test('catalog HTML lists all 30 figures and the candidate sets', () => {
  const html = renderBankCatalogHtml();
  assert.ok((html.match(/<svg/g) ?? []).length >= 30);
  for (let i = 1; i <= 30; i++) assert.ok(html.includes(`>F${i}<`), `F${i}`);
  for (const id of PRESETS) assert.ok(html.includes(id));
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
});
