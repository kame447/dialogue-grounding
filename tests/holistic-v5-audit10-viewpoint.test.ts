import assert from 'node:assert/strict';
import test from 'node:test';
import { findOrientationLeaks } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { buildRecords, normal, OLD, runTurn } from './support/s4-v3-records.ts';

const trialVersion = { version: 'adaptive_repair_v3' } as const;
const human = '私の画面では右端に切れ目があります。そちらの図形にも切れ目はありますか？';
const selfView = 'こちらの画面では右端に切れ目があります。そちらにも切れ目はありますか？';
const unsafe = [
  'そちらの画面でもこちらと同じ向きになっています。切れ目がある形ですか？',
  'そちらの画面では右端に切れ目が見えています。',
];
const needsRewrite = [
  ...unsafe.map(draft => ({ draft, codes: ['shared_view_assumption'] })),
  { draft: 'そちらの画面でもこちらと同じ向きなので、端の切れ目が見えますか？', codes: ['shared_view_assumption'] },
  { draft: 'こちらと同じ向きに見えています。切れ目の形は分かりますか？', codes: ['shared_view_assumption'] },
  { draft: '右端に切れ目がある図形、そちらも見つかりましたか？', codes: ['orientation_leak'] },
  { draft: 'そちらの画面では上端に切れ目があって、下端に丸い穴があります。', codes: ['shared_view_assumption'] },
  { draft: 'そちらの画像では右端に小さな穴が見えます。', codes: ['shared_view_assumption'] },
  { draft: 'そちらの画面では右端に切れ目が見えますが、左側に小さな穴もあります。', codes: ['shared_view_assumption'] },
  { draft: '上の中央に丸い穴がありますか？', codes: ['orientation_leak'] },
  { draft: 'そちらは左側に浅いくぼみが見えます。', codes: ['shared_view_assumption'] },
  { draft: 'そちらにも上端に長い棒が見えます。', codes: ['shared_view_assumption'] },
  { draft: 'こちらは細い棒が見えます。左側に浅いくぼみがあります。', codes: ['orientation_leak'] },
  { draft: 'こちらは左端に穴があり、そちらの図形は右端に穴があります。', codes: ['shared_view_assumption'] },
];
const safe = [
  selfView,
  'こちらの画面だと右端に切れ目があります。',
  '私の画面だと右端に切れ目があります。',
  'こちらの画面では上端に切れ目があって、下端に丸い穴があります。',
  '私の画像では右端に小さな穴が見えます。',
  'こちらの見え方では下端に細い棒があります。',
  '僕の見え方だと上端に丸い穴があります。',
  'こっちでは右端に丸い穴が見えるよ。',
  'こちらの画面だと上端は丸いけど、下端には切れ目があります。',
  'こちらの画面では右端に切れ目が見えますが、左側に穴もあります。',
  'こちらの画面では上端が丸いです、左側には切れ目があります。',
  'こちらの画面では上の中央に丸い穴があります。',
  'そちらの画像では右端に小さな穴がありますか？',
  'こちらから見て、右端に切れ目があります。',
  'そちらの画面では右端に切れ目が見えるとおっしゃっていましたね。',
  '「そちらの画面では右端に見える」と言っていましたね。',
  'そちらの画面では右端に切れ目が見えていますか。',
  'そちらの画面でも右端に切れ目が見えていますか？',
  'そちらも同じ向きではないですね。',
  'そちらでは右端に切れ目があるとのことですね。切れ目の形をもう少し教えてください。',
  'そちらでは右端に切れ目があると教えてくれましたね。切れ目は三角形ですか？',
  '両方の画面が同じ向きとは限りません。切れ目の形を教えてください。',
  'そちらも同じ位置とは限らないので、切れ目の形を見比べましょう。',
  'そちらでは右端に切れ目があるなら、その切れ目は三角形ですか？',
  'そちらの画面で右端に切れ目があるのであれば、その切れ目の形を教えてください。',
  'そちらで右端に切れ目があるとすると、細い棒もつながっていますか？',
  '二つの突起が同じ方向に傾いて並ぶかは判断しきれません。根元はつながっていますか？',
  'こちらは左側に浅いくぼみが見えます。',
  'こちらにも上端に長い棒が見えます。',
  'こちらの図形は右端に丸い穴が見えます。',
  'こちらは左端に穴があり、そちらは右端に穴がありますか？',
];
const scopeChecks = (records: any) =>
  verifyRecords(records).checks.filter(check => /^intervention\.trial\.0\.attempt\.0\./u.test(check.id)).map(check => check.status);

test('v4 keeps its saved orientation rules', () => {
  assert.deepEqual(findOrientationLeaks(unsafe[0], 'holistic_v4'), []);
  assert.deepEqual(findOrientationLeaks(unsafe[1], 'holistic_v4'), []);
  assert.deepEqual(findOrientationLeaks(safe[1], 'holistic_v4'), ['orientation_leak']);
  assert.deepEqual(findOrientationLeaks(safe[2], 'holistic_v4'), ['orientation_leak']);
});

test('v5 attaches viewpoint and clause qualifiers to the directional terms they cover', () => {
  const legacy = 'jev_generation_retry_v2';
  // the topic markers belong to jev_generation_retry_v5 only: v4 reads these clauses as before
  const v4 = 'jev_generation_retry_v4';
  for (const cue of ['こちらは', 'こちらにも', 'こちらの図形は']) {
    assert.deepEqual(findOrientationLeaks(cue + '右端に小さな穴があります。', 'holistic_v5', v4), ['orientation_leak']);
    assert.deepEqual(findOrientationLeaks(cue + '右端に小さな穴があります。', 'holistic_v5', 'jev_generation_retry_v5'), []);
  }
  assert.deepEqual(findOrientationLeaks('そちらは右端に小さな穴があります。', 'holistic_v5', v4), ['orientation_leak']);
  assert.deepEqual(findOrientationLeaks('そちらは右端に小さな穴があります。', 'holistic_v5', 'jev_generation_retry_v5'), ['shared_view_assumption']);
  for (const cue of ['こちらは', 'こちらにも', 'こちらの図形は', 'そちらは']) {
    assert.deepEqual(findOrientationLeaks(cue + '右端に小さな穴があります。', 'holistic_v5', legacy), ['orientation_leak']);
  }
  assert.deepEqual(findOrientationLeaks('こっちでは右端に丸い穴が見えるよ。', 'holistic_v5', legacy), ['orientation_leak']);
  assert.deepEqual(findOrientationLeaks('上の中央に丸い穴がありますか？', 'holistic_v5', legacy), []);
  assert.deepEqual(findOrientationLeaks('そちらでは右端に切れ目がありますが、その切れ目は見えますか？', 'holistic_v5'),
    ['shared_view_assumption']);
  for (const cause of ['なので、', 'なので', 'だという前提があるため、', 'ですから、']) {
    assert.deepEqual(findOrientationLeaks('そちらでも同じ向き' + cause + '切れ目が見えますか？', 'holistic_v5'),
      ['shared_view_assumption']);
  }
  assert.deepEqual(findOrientationLeaks('そちらでは右端に切れ目がありまして、細い棒も見えますか？', 'holistic_v5'),
    ['shared_view_assumption']);
  assert.deepEqual(findOrientationLeaks('そちらでは右端に切れ目があります、その切れ目は見えますか？', 'holistic_v5'),
    ['shared_view_assumption']);
  assert.deepEqual(findOrientationLeaks('右端に切れ目があって、そちらでは左端に見えますか？', 'holistic_v5'),
    ['orientation_leak']);
  assert.deepEqual(findOrientationLeaks('こちらでは右端に切れ目があり、そちらでは左端に見えますか？', 'holistic_v5'), []);
  assert.deepEqual(findOrientationLeaks('そちらでは右端に切れ目があり、こちらでは左端に見えます。', 'holistic_v5'),
    ['shared_view_assumption']);
  assert.deepEqual(findOrientationLeaks('そちらでは右端と左端の両方に切れ目がありますか？', 'holistic_v5'), []);
  assert.deepEqual(findOrientationLeaks('こちらから見ると、そちらと同じ方向に傾いています。', 'holistic_v5'), ['shared_view_assumption']);
  assert.deepEqual(findOrientationLeaks('そちらと同じ方向に傾いていますか？', 'holistic_v5'), []);
});

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`${label}: old v5 preserves a saved orientation fallback and new v5 publishes the explicit viewpoint`, async () => {
    const draft = '私の画像では右端に小さな穴があります。';
    const options = { label, dialoguePolicy: 'holistic_v5' as const, technicalTrial: trialVersion };
    const plan = { action: 'confirm', target: 'figure_0' };
    const old = await buildRecords({ ...options, generationRetryVersion: 'jev_generation_retry_v2',
      turns: [{ human, plan: { ...plan, drafts: [draft, draft] } }] });
    const modern = await buildRecords({ ...options, turns: [{ human, plan: { ...plan, drafts: [draft] } }] });
    assert.deepEqual(old.trials[0].attempts[0].generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
    assert.equal(modern.trials[0].attempts[0].publicSpeech, draft);
    assert.equal(modern.trials[0].attempts[0].generationGuard.regenerated, false);
    assert.equal(modern.trials[0].attempts[0].generationRetryVersion, modern.trials[0].replay[0].tape.generationRetryVersion);
    assert.deepEqual(scopeChecks(old), ['pass', 'pass', 'pass', 'pass']);
    assert.deepEqual(scopeChecks(modern), ['pass', 'pass', 'pass', 'pass']);
    const wrongVersion = structuredClone(modern);
    delete wrongVersion.trials[0].attempts[0].generationRetryVersion;
    delete wrongVersion.trials[0].turns[0].trace[0].generationRetryVersion;
    assert.ok(scopeChecks(wrongVersion).includes('mismatch'));
  });

  test(`${label}: an assertion about the partner's view is rewritten`, async () => {
    for (const { draft, codes } of needsRewrite) {
      const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: trialVersion,
        turns: [{ human, plan: { action: 'confirm', target: 'figure_0', drafts: [draft, selfView] } }] });
      const trace = records.trials[0].attempts[0];
      assert.equal(trace.publicSpeech, selfView);
      assert.deepEqual(trace.generationGuard, { violations: codes, regenerated: true, fallback: false });
      assert.deepEqual(scopeChecks(records), ['pass', 'pass', 'pass', 'pass']);
    }
  });

  test(`${label}: local views, attributions and orientation questions may be published`, async () => {
    for (const draft of safe) {
      const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: trialVersion,
        turns: [{ human, plan: { action: 'confirm', target: 'figure_0', drafts: [draft] } }] });
      const trace = records.trials[0].attempts[0];
      assert.equal(trace.publicSpeech, draft);
      assert.deepEqual(trace.generationGuard, { violations: [], regenerated: false, fallback: false });
      assert.deepEqual(scopeChecks(records), ['pass', 'pass', 'pass', 'pass']);
    }
  });

  test(`${label}: two partner-view assertions stop without a fallback`, async () => {
    const { lunaRequest, timeouts } = normal.run.manifest;
    const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5');
    const state = structuredClone(OLD.state);
    await assert.rejects(runTurn(profile, label, state, [{ id: 'human-1', seq: 1, speaker: 'human', text: human }],
      { action: 'confirm', target: 'figure_0', drafts: [unsafe[0], unsafe[0]] }, trialVersion), (error: any) => {
      assert.equal(error.code, 'unsafe_generation');
      const trace = error.traces.at(-1);
      assert.equal(trace.publicSpeech, null);
      assert.deepEqual(trace.generationGuard, { violations: ['shared_view_assumption'], regenerated: true, fallback: false });
      return true;
    });
  });
}
