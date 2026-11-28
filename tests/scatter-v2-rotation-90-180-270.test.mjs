// #269 relative_90_180_270: the AI side turns each figure a further 90°, 180° or 270°, equally likely and never 0°.
// Per figure the turn is (ai.rotation - human.rotation + 360) % 360. The human side, its placement and the slot→figure map
// stay what relative_pm90 gives for the same seed: only the single AI-side draw per figure is read differently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as scatter from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';

const { BOARD_WIDTH, BOARD_HEIGHT, createLayoutsV2, createTrialV2, participantView, modelView, trialStimulusV2 } = scatter;
const MODE = 'relative_90_180_270';
const THREE = { mode: 'custom', figureIds: ['F2', 'F17', 'F30'] };
const FOUR = { mode: 'preset', setId: 'pilot-four-v1' };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const options = (figureSelection) => figureSelection ? { figureSelection } : {};

/** The AI side's turn relative to the human side, per figure. */
const relativeTurns = (layouts) => new Map(layouts.human.map(h => [h.figureId,
  (layouts.ai.find(a => a.figureId === h.figureId).rotation - h.rotation + 360) % 360]));

test('P1 each figure turns 90, 180 or 270 degrees with equal frequency and 0 never occurs', () => {
  for (const [label, figureSelection, seeds] of [['three figures', THREE, 1000], ['legacy six figures', undefined, 500]]) {
    const counts = new Map();
    let n = 0;
    for (let seed = 0; seed < seeds; seed++) {
      for (const turn of relativeTurns(createLayoutsV2({ seed, rotationMode: MODE, ...options(figureSelection) })).values()) {
        counts.set(turn, (counts.get(turn) ?? 0) + 1);
        n++;
      }
    }
    assert.equal(n, 3000, label);
    // Nothing but the three turns occurs, in particular no 0.
    assert.deepEqual([...counts.keys()].sort((a, b) => a - b), [90, 180, 270], label);
    const sigma = Math.sqrt(2 * n / 9);
    for (const turn of [90, 180, 270]) {
      assert.ok(Math.abs(counts.get(turn) - n / 3) <= 4 * sigma, `${label}: ${turn} occurred ${counts.get(turn)} of ${n}`);
    }
  }
});

test('P2 the AI-side draw keeps its position: for one seed and figure the new turn and the ±90 turn pair up as a single shared draw gives', () => {
  const pairs = new Map();
  for (let seed = 0; seed < 1000; seed++) {
    const pm90 = relativeTurns(createLayoutsV2({ seed, figureSelection: THREE }));
    for (const [figureId, turn] of relativeTurns(createLayoutsV2({ seed, rotationMode: MODE, figureSelection: THREE }))) {
      const pair = `${pm90.get(figureId)},${turn}`;
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
  }
  // draw < 1/3 gives (90, 90); 1/3 <= draw < 1/2 gives (90, 180); 1/2 <= draw < 2/3 gives (270, 180); draw >= 2/3 gives (270, 270).
  // (90, 270) and (270, 90) would need two different draws, so they never occur.
  assert.deepEqual([...pairs.keys()].sort(), ['270,180', '270,270', '90,180', '90,90']);
  const n = 3000;
  for (const [pair, p] of [['90,90', 1 / 3], ['90,180', 1 / 6], ['270,180', 1 / 6], ['270,270', 1 / 3]]) {
    assert.ok(Math.abs(pairs.get(pair) - n * p) <= 4 * Math.sqrt(n * p * (1 - p)), `${pair} occurred ${pairs.get(pair)} of ${n}`);
  }
});

test('P3 for the same seed the human side with its placement, the slot ids and the slot→figure map equal relative_pm90', () => {
  const slotMap = (layout) => Object.fromEntries(layout.map(p => [p.id, p.figureId]));
  for (let seed = 0; seed < 1000; seed++) {
    const next = createLayoutsV2({ seed, rotationMode: MODE }), pm90 = createLayoutsV2({ seed });
    assert.deepEqual(createLayoutsV2({ seed, rotationMode: MODE }), next, `seed ${seed} is reproducible`);
    assert.deepEqual(next.human, pm90.human, `seed ${seed}`);
    assert.deepEqual(slotMap(next.ai), slotMap(pm90.ai), `seed ${seed}`);
  }
});

test('P4 a trial keeps the human board, scene and key of relative_pm90, has its own opaque trialId and records its stimulus', () => {
  for (const seed of [0, 17, 1701]) {
    const next = createTrialV2({ seed, rotationMode: MODE }), pm90 = createTrialV2({ seed }), zero = createTrialV2({ seed, rotationMode: 'relative_0' });
    assert.deepEqual(createTrialV2({ seed, rotationMode: MODE }), next);
    assert.deepEqual(next.human, pm90.human);
    assert.deepEqual(next.key, pm90.key);
    assert.deepEqual(participantView(next), participantView(pm90));
    // The trial id follows the existing rule: relative_pm90 keeps the original scope, every other mode hashes `trial:<mode>`.
    assert.equal(next.trialId, 'tangram-prototype-v2-' + sha(`tangram-prototype-v2:${seed}:trial:${MODE}`).slice(0, 16));
    assert.notEqual(next.trialId, pm90.trialId);
    assert.notEqual(next.trialId, zero.trialId);
    const stimulus = trialStimulusV2(next), pmStimulus = trialStimulusV2(pm90);
    assert.equal(stimulus.rotationMode, MODE);
    assert.deepEqual(stimulus.angles.human, pmStimulus.angles.human);
    for (const [slot, figureId] of Object.entries(next.key.ai)) {
      const humanSlot = Object.keys(next.key.human).find(s => next.key.human[s] === figureId);
      assert.ok([90, 180, 270].includes((stimulus.angles.ai[slot] - stimulus.angles.human[humanSlot] + 360) % 360));
    }
  }
});

test('P5 no seed fails to place the silhouettes: 2000 seeds for three custom, four preset and legacy six figures', () => {
  for (const [label, figureSelection, count] of [['three custom', THREE, 3], ['four preset', FOUR, 4], ['legacy six', undefined, 6]]) {
    const failures = [];
    for (let seed = 0; seed < 2000; seed++) {
      try {
        const layouts = createLayoutsV2({ seed, rotationMode: MODE, ...options(figureSelection) });
        for (const side of ['human', 'ai']) {
          assert.equal(layouts[side].length, count);
          for (const p of layouts[side]) {
            assert.ok([0, 90, 180, 270].includes(p.rotation));
            assert.ok(p.bbox.x >= 32 && p.bbox.y >= 32 && p.bbox.x + p.bbox.w <= BOARD_WIDTH - 32 && p.bbox.y + p.bbox.h <= BOARD_HEIGHT - 32);
          }
        }
      } catch (error) { failures.push(`${seed}: ${error.message}`); }
    }
    assert.deepEqual(failures, [], label);
  }
});

// Keys at every depth and meaningful strings; PNG bytes are excluded.
function exposed(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => exposed(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); exposed(v, out); }
  return out;
}
test('P6 the participant and model projections carry no mode, angle, seed or correspondence', () => {
  for (const seed of [0, 17, 1701]) {
    const trial = createTrialV2({ seed, rotationMode: MODE });
    const { png, ...model } = modelView(trial);
    for (const text of [...exposed(participantView(trial)), ...exposed(model)]) {
      assert.doesNotMatch(text, /relative|rotation|angle|seed|trialId|figureId|stimulus/iu);
      assert.doesNotMatch(text, /^F\d+$/u);
    }
  }
});
