import assert from 'node:assert/strict';
import test from 'node:test';
import { findOrientationLeaks } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { buildRecords, normal, OLD, runTurn } from './support/s4-v3-records.ts';

const trialVersion = { version: 'adaptive_repair_v3' } as const;
const human = '切れ目がある図形ですか？';
const selfView = 'こちらの画面では右端に切れ目があります。そちらにも切れ目はありますか？';
const unsafe = [
  'そちらの画面でもこちらと同じ向きになっています。切れ目がある形ですか？',
  'そちらの画面では右端に切れ目が見えています。',
];
const safe = [
  selfView,
  'こちらの画面だと右端に切れ目があります。',
  '私の画面だと右端に切れ目があります。',
  'そちらの画面では右端に切れ目が見えるとおっしゃっていましたね。',
  '「そちらの画面では右端に見える」と言っていましたね。',
  'そちらの画面では右端に切れ目が見えていますか。',
  'そちらの画面でも右端に切れ目が見えていますか？',
  'そちらも同じ向きではないですね。',
];
const scopeChecks = (records: any) =>
  verifyRecords(records).checks.filter(check => /^intervention\.trial\.0\.attempt\.0\./u.test(check.id)).map(check => check.status);

test('v4 keeps its saved orientation rules', () => {
  assert.deepEqual(findOrientationLeaks(unsafe[0], 'holistic_v4'), []);
  assert.deepEqual(findOrientationLeaks(unsafe[1], 'holistic_v4'), []);
  assert.deepEqual(findOrientationLeaks(safe[1], 'holistic_v4'), ['orientation_leak']);
  assert.deepEqual(findOrientationLeaks(safe[2], 'holistic_v4'), ['orientation_leak']);
});

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`${label}: an assertion about the partner's view is rewritten`, async () => {
    for (const draft of unsafe) {
      const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: trialVersion,
        turns: [{ human, plan: { action: 'confirm', target: 'figure_0', drafts: [draft, selfView] } }] });
      const trace = records.trials[0].attempts[0];
      assert.equal(trace.publicSpeech, selfView);
      assert.deepEqual(trace.generationGuard, { violations: ['shared_view_assumption'], regenerated: true, fallback: false });
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
