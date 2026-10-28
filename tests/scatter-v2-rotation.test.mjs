// #142 rotation modes. relative_pm90 is pinned to fixed values computed independently at c3a871e
// (runtime/dialogue-design-20261028-020087fb/impl-a-oracle-c3a871e.mjs); never regenerate them to match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FIGURES } from '../dialogue-model/runtime/stimuli/figures.mjs';
import { polygonArea } from '../dialogue-model/runtime/stimuli/geometry.mjs';
import * as scatter from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';

const { BOARD_WIDTH, BOARD_HEIGHT, createLayoutsV2, createTrialV2, participantView, modelView } = scatter;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, (_k, x) => x && x.type === 'Buffer' && Array.isArray(x.data) ? Buffer.from(x.data).toString('base64') : x);

const ORACLE = {
  0: { trialId: 'tangram-prototype-v2-12e927a5aa5ef300',
    humanPng: '237cc183a279350d57460fa97e4a7dc75c7af1b1febda5cf5dd0871e1b6a26a7', aiPng: '4599f440ea1ddbb967a7ba7ee6a4316ec47531a45a7a7f011980a9d4a5546e12',
    scene: '1d39d6924904c390cbc285499e74d8b2d6242573ed580b57115b6200239fe836', anchors: '9feaea4addf759c443bfb4a4277c4d39e65716107396774a4c32a929399719a7',
    key: '87297eb448c12acb8b1c745ff59e1a7bf4ae32ae6f05c54ec1e064eaa18f8217', trial: '0f6db764faf14aa4b334e5854cb635f067e716b6674af63a254349544c418b35' },
  17: { trialId: 'tangram-prototype-v2-31805328295d5222',
    humanPng: '1dc7401daf09f7e372cb3795538fd4af97a1f13833b6a9957213eb9a248f85f3', aiPng: 'c7527ac2c95f7fe67d8ea8e10331de1619ac0b3637f8bca4618a9bd78bab94f7',
    scene: 'edd268e48c550d3c9539e3f1050071e0c852176acff3232dcc7f2937ec2c68e3', anchors: '163c9516b090ea9682e784d457f63e252e5930f27782b836a336055290631025',
    key: '70f4a4679abed81b9aaf9f00788950f5510aa9cf42512ec3e3159f8da50ae304', trial: '15517322bbc12fa55a49280595d7545e23c20cbf72122b0dee3d210719936266' },
  1701: { trialId: 'tangram-prototype-v2-e96c46888b1582b6',
    humanPng: '89d4b257677a1cb9d2938038ef59ba2f8a71733b1ef9982ac24cdea1bceb98ba', aiPng: 'a98d2d1071cc3040edc5e1115fbf7730d428a01ae12cc9cdf2e3941c88ce4140',
    scene: '7c2bb7e75fd9f860abf5289b7e07316cb1f57ca960ab798cbb39f565290fd4e9', anchors: 'a5745021b204a26b60a1da6891d06fd5f71cf442de2499972ee3a3937efed235',
    key: 'f6ad36eca6e88f0035be9899468d75f24e184f722c2e35e52e31db2ec462a60b', trial: 'c90d6864fe42b36629e5ac59e748c68a1ab959ebfccae01edd1d5414b6432b81' },
  [-1]: { trialId: 'tangram-prototype-v2-fb1505c06918d7bb',
    humanPng: '1fb7c8d5c30d8ab9bf3e5d898a7b24df243a398a68f00d8317289e3390c9b592', aiPng: '0deef3214b60a35d53b5bb5ca60a04f6bfe4c275d5f55046f8b047ad961c2c77',
    scene: '117bf6da9d8369dff86ecf55f26a02f1a0903317f3341c10cf8eb8bcb2afb9e1', anchors: '82a2f1129fc2a93428c4d6b417b7791c23b0402eaf9b301e9207a57b5a8694c3',
    key: '3a1b3aa257ba90f02fe378c552fbc0b026c662fd24d6479aa35442eeb4c983d1', trial: '0f1db0a776d3d25332444874e9ac4c23f017a1a8810daab7ec85ff8a731476fe' },
  [Number.MAX_SAFE_INTEGER]: { trialId: 'tangram-prototype-v2-d106e7007f0732a9',
    humanPng: 'f53ee4e51fd8ba34d355a7c76806d58622d3f2cb7a3d3c3b17505e763b31dddb', aiPng: 'd69e21d4e5ea53faedbe8376d3b3fb0beed44f1d6da1a659c39be79bde4d6595',
    scene: 'dcaf86ebe15d52ad57ac414a38706eef213eb5a9883f849509855b927487195a', anchors: '10bce7ebacf0e7b50b2ae369d282a7b6fda66fd44ad844eb00fe41c1de8a3798',
    key: 'ee4a5a34a1f6627298dc64ecdb798b679cd6fd971fa78e1f2f540d90e470e2e6', trial: 'b146262ec54da11f070226f194b615ad777a3b908d22c4cd169d5e9fcc565422' },
};
const AGGREGATE_SEEDS = [...Array(64).keys(), -1, 1701, 104729, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
const AGGREGATE = '4b540559046e2e256e9bf18927fec83b28eed2b7aa64eb271eeedff53c48889a';
const INVALID_MODES = ['relative_90', '', null, 0, 'RELATIVE_0', 'relative_pm90 ', [], {}, ['relative_0']];

test('R1 relative_pm90 (implicit and explicit) equals the fixed c3a871e values', () => {
  for (const options of [{}, { rotationMode: 'relative_pm90' }]) {
    for (const [seedText, expected] of Object.entries(ORACLE)) {
      const t = createTrialV2({ seed: Number(seedText), ...options });
      assert.deepEqual({ trialId: t.trialId, humanPng: sha(t.human.png), aiPng: sha(t.ai.png), scene: sha(JSON.stringify(t.human.scene)),
        anchors: sha(JSON.stringify(t.ai.anchors)), key: sha(JSON.stringify(t.key)), trial: sha(json(t)) }, expected, `seed ${seedText}`);
    }
    const all = createHash('sha256');
    for (const seed of AGGREGATE_SEEDS) all.update(json(createTrialV2({ seed, ...options })) + '\n');
    assert.equal(all.digest('hex'), AGGREGATE);
  }
  for (let seed = 0; seed < 200; seed++) assert.deepEqual(createLayoutsV2({ seed, rotationMode: 'relative_pm90' }), createLayoutsV2({ seed }));
});

test('R2 ROTATION_MODES is a frozen list of the two modes', () => {
  assert.deepEqual(scatter.ROTATION_MODES, ['relative_pm90', 'relative_0']);
  assert.ok(Object.isFrozen(scatter.ROTATION_MODES));
});

test('R3 unknown rotation modes are rejected; only undefined selects the default', () => {
  for (const rotationMode of INVALID_MODES) {
    assert.throws(() => createLayoutsV2({ seed: 5, rotationMode }), TypeError, JSON.stringify(rotationMode));
    assert.throws(() => createTrialV2({ seed: 5, rotationMode }), TypeError, JSON.stringify(rotationMode));
  }
  assert.deepEqual(createTrialV2({ seed: 5, rotationMode: undefined }), createTrialV2({ seed: 5 }));
});

test('R4 relative_0, 1000 seeds: human side and slot→figure map unchanged, AI angle equals the same figure\'s human angle', () => {
  const ids = FIGURES.map(f => f.id).sort();
  for (let seed = 0; seed < 1000; seed++) {
    const zero = createLayoutsV2({ seed, rotationMode: 'relative_0' }), pm = createLayoutsV2({ seed });
    assert.deepEqual(createLayoutsV2({ seed, rotationMode: 'relative_0' }), zero);
    assert.deepEqual(zero.human, pm.human);
    const map = layout => Object.fromEntries(layout.map(p => [p.id, p.figureId]));
    assert.deepEqual(map(zero.ai), map(pm.ai));
    const allIds = ['human', 'ai'].flatMap(side => zero[side].map(p => p.id));
    assert.equal(new Set(allIds).size, 12);
    for (const side of ['human', 'ai']) {
      const layout = zero[side];
      assert.equal(layout.length, 6);
      assert.deepEqual(layout.map(p => p.figureId).sort(), ids);
      for (const p of layout) {
        assert.ok([0, 90, 180, 270].includes(p.rotation));
        assert.equal(p.polygons.length, 7);
        assert.equal(p.polygons.reduce((sum, poly) => sum + polygonArea(poly), 0), 8 * 48 ** 2);
        assert.ok(p.bbox.x >= 32 && p.bbox.y >= 32 && p.bbox.x + p.bbox.w <= BOARD_WIDTH - 32 && p.bbox.y + p.bbox.h <= BOARD_HEIGHT - 32);
      }
      for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
        const a = layout[i], b = layout[j];
        assert.ok(Math.abs(a.center.x - b.center.x) >= 36 && Math.abs(a.center.y - b.center.y) >= 36);
        const dx = Math.max(a.bbox.x - b.bbox.x - b.bbox.w, b.bbox.x - a.bbox.x - a.bbox.w, 0);
        const dy = Math.max(a.bbox.y - b.bbox.y - b.bbox.h, b.bbox.y - a.bbox.y - a.bbox.h, 0);
        assert.ok(Math.hypot(dx, dy) >= 28);
      }
      for (const axis of ['x', 'y']) {
        const values = layout.map(p => p.center[axis]).sort((a, b) => a - b);
        const band = axis === 'x' ? BOARD_WIDTH * 0.1 : BOARD_HEIGHT * 0.12;
        assert.ok(values[2] - values[0] > band || values[5] - values[3] > band);
        for (let i = 0; i < 3; i++) assert.ok(values[i + 3] - values[i] > band);
      }
    }
    for (const human of zero.human) {
      const ai = zero.ai.find(p => p.figureId === human.figureId);
      assert.equal(ai.rotation, human.rotation, `seed ${seed} ${human.figureId}`);
      assert.ok(Math.hypot(ai.center.x - human.center.x, ai.center.y - human.center.y) >= 96);
    }
  }
  for (const seed of [0, 17, 1701]) {
    const zero = createTrialV2({ seed, rotationMode: 'relative_0' }), pm = createTrialV2({ seed });
    assert.deepEqual(createTrialV2({ seed, rotationMode: 'relative_0' }), zero);
    assert.deepEqual(zero.human, pm.human);
    assert.deepEqual(zero.key, pm.key);
    assert.match(zero.trialId, /^tangram-prototype-v2-[a-f0-9]{16}$/u);
    assert.notEqual(zero.trialId, pm.trialId);
    assert.notDeepEqual(zero.ai.png, pm.ai.png);
  }
});

test('R5 trialStimulusV2 returns the generated angles of that exact trial only', () => {
  for (const rotationMode of scatter.ROTATION_MODES) for (const seed of [0, 17, 1701]) {
    const trial = createTrialV2({ seed, rotationMode }), layouts = createLayoutsV2({ seed, rotationMode });
    const stimulus = scatter.trialStimulusV2(trial);
    assert.deepEqual(stimulus, { version: 'tangram-prototype-v2', rotationMode, angles: {
      human: Object.fromEntries(layouts.human.map(p => [p.id, p.rotation])),
      ai: Object.fromEntries(layouts.ai.map(p => [p.id, p.rotation])) } });
    for (const [slot, figureId] of Object.entries(trial.key.ai)) {
      const humanSlot = Object.keys(trial.key.human).find(s => trial.key.human[s] === figureId);
      const relative = (stimulus.angles.ai[slot] - stimulus.angles.human[humanSlot] + 360) % 360;
      assert.ok(rotationMode === 'relative_0' ? relative === 0 : [90, 270].includes(relative));
    }
    stimulus.angles.ai[Object.keys(stimulus.angles.ai)[0]] = 45;
    assert.deepEqual(scatter.trialStimulusV2(trial), scatter.trialStimulusV2(trial));
    assert.notEqual(scatter.trialStimulusV2(trial).angles.ai[Object.keys(stimulus.angles.ai)[0]], 45);
    assert.equal(scatter.trialStimulusV2(structuredClone(trial)), null);
    assert.equal(scatter.trialStimulusV2({ ...trial }), null);
  }
  for (const value of [null, undefined, {}, 'trial', 1]) assert.equal(scatter.trialStimulusV2(value), null);
});

// Keys at every depth and meaningful strings; PNG bytes are excluded.
function exposed(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => exposed(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); exposed(v, out); }
  return out;
}
test('R6 relative_0 projections carry no mode, angle, seed or correspondence', () => {
  for (const seed of [0, 17, 1701]) {
    const zero = createTrialV2({ seed, rotationMode: 'relative_0' }), pm = createTrialV2({ seed });
    const { png, ...model } = modelView(zero);
    for (const text of [...exposed(participantView(zero)), ...exposed(model)]) {
      assert.doesNotMatch(text, /relative|rotation|angle|seed|trialId|figureId|stimulus/iu);
      assert.doesNotMatch(text, /^F[1-6]$/u);
      assert.ok(!FIGURES.some(f => text === f.id));
    }
    assert.deepEqual(participantView(zero), participantView(pm));
    assert.notDeepEqual(png, modelView(pm).png);
  }
});
