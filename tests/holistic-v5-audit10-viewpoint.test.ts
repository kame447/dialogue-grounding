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
];
const safe = [
  selfView,
  'こちらの画面だと右端に切れ目があります。',
  '私の画面だと右端に切れ目があります。',
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
