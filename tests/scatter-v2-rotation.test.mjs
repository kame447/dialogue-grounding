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
const INVALID_MODES = ['relative_90', '', null, 0, 'RELATIVE_0', 'relative_pm90 ', [], {}, ['relative_0'],
  'relative_90_180', 'relative_180', 'RELATIVE_90_180_270', 'relative_90_180_270 ', ['relative_90_180_270']];

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

test('R2 ROTATION_MODES is a frozen list of the three modes; the earlier two keep their place', () => {
  assert.deepEqual(scatter.ROTATION_MODES, ['relative_pm90', 'relative_0', 'relative_90_180_270']);
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
      assert.ok(rotationMode === 'relative_0' ? relative === 0 : [90, ...(rotationMode === 'relative_90_180_270' ? [180] : []), 270].includes(relative));
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

// #269: the two earlier modes stay byte-identical once relative_90_180_270 exists.
// relative_0, and the figure-selection boards of both earlier modes, are pinned to values computed from the base commit 620ef5c
// (before relative_90_180_270 existed). Like R1, never regenerate them from the current implementation.
const ORACLE_REL0 = {
  0: { trialId: 'tangram-prototype-v2-0727f2bb745bd660',
    humanPng: '237cc183a279350d57460fa97e4a7dc75c7af1b1febda5cf5dd0871e1b6a26a7', aiPng: '79e4621c940d974a20caf7a6dabce86427c4fe44dd5c8174ec68e9e11fac11c8',
    scene: '1d39d6924904c390cbc285499e74d8b2d6242573ed580b57115b6200239fe836', anchors: '1177de4c6d26beba1d5c91cad44a7f0f5c626f4b2c5c73aa8f659d9a8692082c',
    key: '73fec6451c18bdbf9e5c6a9eeae61dc7ed4b59f43c40c20a97ff8e679e07d98a', trial: 'b86476c071c54166a1811c7ceb2b36d3f516528324c70e745e674f3f08452b99' },
  17: { trialId: 'tangram-prototype-v2-bd2fbd6f4897c3ab',
    humanPng: '1dc7401daf09f7e372cb3795538fd4af97a1f13833b6a9957213eb9a248f85f3', aiPng: '0883c11a5a3d66ccad76a3c6c4c7c0ab227f73f08dcac967331ff37532bae7d9',
    scene: 'edd268e48c550d3c9539e3f1050071e0c852176acff3232dcc7f2937ec2c68e3', anchors: '8c3a15350d1ad8968a5236a6870e46e1e412d349120364078a6c953f14c7c036',
    key: '89cdd4248a95518f9fdf00c2a53b18dafdff3aed7b4a2d7cc00e27ae7176462d', trial: '9dcd0444b28d0279bef6b8fa5e8fa2e2833e6859efc5520455ff89a0532be67f' },
  1701: { trialId: 'tangram-prototype-v2-a8af8aa558814b15',
    humanPng: '89d4b257677a1cb9d2938038ef59ba2f8a71733b1ef9982ac24cdea1bceb98ba', aiPng: 'c168884a731c42cb1fbea44fedd69b9ef4959495b556cf6c09d4f5f80b67d001',
    scene: '7c2bb7e75fd9f860abf5289b7e07316cb1f57ca960ab798cbb39f565290fd4e9', anchors: '242a4908331c4adbdacb9008a3aaf67292b2aec46489251fc054c75e08d94a4d',
    key: '8026d652fc3c7d37c8ad7343cb26f2ca747fb23af5d1f3419683c4c2ea4492aa', trial: 'e83b631789beb93c7aa05f44fccdfe11e49c38d7af4bf9429eb37e669b7f8c61' },
  [-1]: { trialId: 'tangram-prototype-v2-17101cc019a92909',
    humanPng: '1fb7c8d5c30d8ab9bf3e5d898a7b24df243a398a68f00d8317289e3390c9b592', aiPng: 'dcdca8e46b8f36b0812e2d2f5dc6ae404b9fc44942e4915e932b067b98c3c9f4',
    scene: '117bf6da9d8369dff86ecf55f26a02f1a0903317f3341c10cf8eb8bcb2afb9e1', anchors: '9715165ac1bf4d799deb74277ea09502119af121ea07365d6ecce748446f6aaf',
    key: '5924f6e27b83cca0b4d8ec62bc2a1733ea8ae96d30af7eebaf56356de571e3a6', trial: 'cb6ceedc5906f913cb4625be2e9ab0246d2550234259deee710d841b4182dd32' },
  [Number.MAX_SAFE_INTEGER]: { trialId: 'tangram-prototype-v2-c630bd7736e02ce0',
    humanPng: 'f53ee4e51fd8ba34d355a7c76806d58622d3f2cb7a3d3c3b17505e763b31dddb', aiPng: '7164a157a2b159065ed17a062a556f5278ae8c9dfb3b1a5b865af9e754b5bb22',
    scene: 'dcaf86ebe15d52ad57ac414a38706eef213eb5a9883f849509855b927487195a', anchors: 'feb4ffe8bb14ee52393aaf9ff8ac0cb5cc2373c963ea27a90927fede0063c5bf',
    key: 'ec6e2ca07072acf28e6dfdf148b5c677eb7d256fe68b2ab91f9864ec98ce0f85', trial: '30518c27d2630ba8b88048efc85cbefd244b6fa00d629adbb895c30ef9ac46c2' },
};
const AGGREGATE_REL0_SEEDS = [...Array(24).keys(), -1, 1701, 104729, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
const AGGREGATE_REL0 = '7a2c80ae020a714c811c6d28ccfd29d3a22123436eb509c78c9d8363fc675799';
const LAYOUTS_500 = { relative_pm90: '550bae58541ec7d71e49b3b3ddae66d6bbf87e71d8f61a5b666e0ea3237cf546',
  relative_0: '7db0494ec454ddd5b1bc8b54db5cccf6442c9be0bb2aafa0abaf92f641f7b39f' };
const SELECTION_PINS = {
  preset_pilot_four: { figureSelection: {mode:'preset',setId:'pilot-four-v1'},
    relative_pm90: {
      0: ['tangram-prototype-v2-1e3b85c5ac6f7de2', 'dff6eb623a7cbfcc3558b74238936c165097d550e6604da31b4978268f78be90'],
      17: ['tangram-prototype-v2-40bdf315c454746b', 'c465d2d84578fd26c95da97102d898068acda63282a1c65eb5e8b5fc5bd4058d'],
      1701: ['tangram-prototype-v2-5e9874effa37a45b', 'd6595c2b8431ddf2f0f80409e145c17f2887eac04ddd54567c192238cc148926'],
    },
    relative_0: {
      0: ['tangram-prototype-v2-f95cdc2b43017cf7', '21812f4963ac4255d450e0b503e527ce856aa84ddb195e41dfe932b666d1aefd'],
      17: ['tangram-prototype-v2-0859ee4021fdd0c3', '359017dea6acc09c284a56ec4263eb132c87fc13eb75b4e7522dc1168e97d549'],
      1701: ['tangram-prototype-v2-83c787cf5ae5907b', 'ad66aa6ad5b88a29e154f7ef4e527c0c4b35eef0638bdf4711153fa400064b37'],
    },
  },
  custom_three: { figureSelection: {mode:'custom',figureIds:['F2','F5','F9']},
    relative_pm90: {
      0: ['tangram-prototype-v2-9918c648f8b76aa5', '46829b704379a647538b70df0841aa5eab7276511f9d726f4f8e2ad3b0366c62'],
      17: ['tangram-prototype-v2-0bf746c3ef866c30', '10706ba951e5c6dbc4fd389aac66c9cb0d7252b7e94b5e9864fed99df884f1e2'],
      1701: ['tangram-prototype-v2-874b999c9eb4d1d9', '14474cb76a5a28a15cc6eab2e89de22a288e5611317df8f4906d6b9729d727c5'],
    },
    relative_0: {
      0: ['tangram-prototype-v2-c3e1461b284e84e2', 'eb21ecab3df8b84dbd4dd41b11057e5ea1427ad4b5d5fdba4110bdd5e2bf7f8c'],
      17: ['tangram-prototype-v2-02558f3be23b751c', '6441be04a97401cb9c621e3e19ff4398da0af2453759d13d802eef0e1f1998f6'],
      1701: ['tangram-prototype-v2-25bbedb0d52a34c4', 'c5c229c130de9a460518db3d93e74f13f352e6a86101a096309264aff0618c77'],
    },
  },
  seeded_three_7: { figureSelection: {mode:'seeded_random',selectionSeed:7,figureCount:3},
    relative_pm90: {
      0: ['tangram-prototype-v2-d06bd0929bbe5e0f', '76294c7ce90f80371457756d46e14b3e8174c8eb19348182d0a947c86c4b7557'],
      17: ['tangram-prototype-v2-48d94328b7dca213', '921a8bbe7ad5d374edf58e62f2a1dbc53d9b21d1f1747ed9124b0d1f665e7799'],
      1701: ['tangram-prototype-v2-0720f5311e219a1f', '41ca321ab5334ceecac8d0069301b904edcdea41fd0bec2834e56594a1413783'],
    },
    relative_0: {
      0: ['tangram-prototype-v2-215c0e8640c2fb96', '561235607ed44d89216235b39c64665c73bae754d0e504e2bb2e8632b7ebc213'],
      17: ['tangram-prototype-v2-1a67c7e46d665925', '73ac430ae044c0d3b4643f48d413d02d21dbeb9f18d89480442b16fea949aa91'],
      1701: ['tangram-prototype-v2-e7afd8d3ea9c9186', '796c3403ab5a6e5649fad5244e03fdf012f4c1b323330560d0e8e8d4791e3f42'],
    },
  },
  preset_bank_set_a: { figureSelection: {mode:'preset',setId:'bank-set-a'},
    relative_pm90: {
      0: ['tangram-prototype-v2-3a2169bbe190d8b1', '4fc0bfa7a6f1b38583a9fe6ee50de56f9145019addda33d44d0249044b10eb38'],
      17: ['tangram-prototype-v2-064a25aee26e216c', 'dff2b7f3f309db9c7bdffb25fbea460c9890074e26ced857e70b17995ccb3b18'],
      1701: ['tangram-prototype-v2-ded1b277c9068d20', 'a101aa9b4fa2351ff080490ab3c36d4f9cb3bc7f8fe01745c94451538a9eab2f'],
    },
    relative_0: {
      0: ['tangram-prototype-v2-337d714cc16f4f15', '44017f69e6ab274532a49ccd5c986499a05bd03d5ded08be0666ede64eefe8aa'],
      17: ['tangram-prototype-v2-c267987a7526f3b3', 'a6103f963a083f032f5d0afe9e21de4ce03e7b002cd75a9898a31c403de3362e'],
      1701: ['tangram-prototype-v2-0e981529352cb70e', '63e07360ff08b66367ad7f56adfe674dcae726c11aef6865ada8f1badcd63651'],
    },
  },
};

const fieldsOf = (t) => ({ trialId: t.trialId, humanPng: sha(t.human.png), aiPng: sha(t.ai.png), scene: sha(JSON.stringify(t.human.scene)),
  anchors: sha(JSON.stringify(t.ai.anchors)), key: sha(JSON.stringify(t.key)), trial: sha(json(t)) });

test('R7 relative_0 and the figure-selection boards of both earlier modes equal the fixed 620ef5c values', () => {
  for (const [seedText, expected] of Object.entries(ORACLE_REL0)) {
    assert.deepEqual(fieldsOf(createTrialV2({ seed: Number(seedText), rotationMode: 'relative_0' })), expected, `seed ${seedText}`);
  }
  const all = createHash('sha256');
  for (const seed of AGGREGATE_REL0_SEEDS) all.update(json(createTrialV2({ seed, rotationMode: 'relative_0' })) + '\n');
  assert.equal(all.digest('hex'), AGGREGATE_REL0);
  for (const rotationMode of ['relative_pm90', 'relative_0']) {
    const digest = createHash('sha256');
    for (let seed = 0; seed < 500; seed++) digest.update(JSON.stringify(createLayoutsV2({ seed, rotationMode })) + '\n');
    assert.equal(digest.digest('hex'), LAYOUTS_500[rotationMode], rotationMode);
  }
  for (const [name, { figureSelection, ...modes }] of Object.entries(SELECTION_PINS)) for (const [rotationMode, seeds] of Object.entries(modes)) {
    for (const [seedText, [trialId, trial]] of Object.entries(seeds)) {
      const t = createTrialV2({ seed: Number(seedText), rotationMode, figureSelection });
      assert.deepEqual([t.trialId, sha(json(t))], [trialId, trial], `${name} ${rotationMode} seed ${seedText}`);
    }
  }
});
