// Synthetic wording only. jev_generation_retry_v7 widens the unsupported-topic-shift check to the wordings v6 missed: "次いこう" (no particle) and "次の図形を見てみよう".
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { findTopicShiftClaims, findTopicShiftClaimsV7 } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { buildRecords, publicFocusTurn, OWN, type Turn } from './support/s4-v3-records.ts';

const missedBeforeV7 = ['うん、次いこう。', 'じゃあ、次の図形を見てみよう。', 'よし、次行こうか。', 'では、別の形を見ましょう。', '次の図形を確認していこう。', 'つぎいきましょう。', 'うん、次いくね。'];
const shiftedBefore = ['うん、次にいこう。', 'では、次の図形に移りましょう。', '話題を変えましょう。', '先に進みます。', '別の形へいきましょうか？'];
const notShifts = [
  '二つの部分がつながった形ですか？', '次に、細い棒がつながっているかを確認させてください。', '次へは進まずに、この特徴を確認させてください。', '次の特徴は、穴の数です。',
  '次に進む前に、この形の穴を確かめさせてください。', '別の形ではなく、いまの形の先端を確かめたいです。', '相手が「次いこう」と言いました。', '次の形には行きません。',
  '次の図形のことではなく、この形の話です。', '先に、この形の切れ目の数を教えてください。',
];

test('v7 flags the wordings v6 missed; v6 does not; every wording v6 flagged is still flagged; introductions, negations and quotes are not shifts', () => {
  for (const text of missedBeforeV7) { assert.deepEqual(findTopicShiftClaimsV7(text), ['unsupported_topic_shift'], text); assert.deepEqual(findTopicShiftClaims(text), [], 'v6 keeps its behaviour: ' + text); }
  for (const text of shiftedBefore) { assert.deepEqual(findTopicShiftClaims(text), ['unsupported_topic_shift'], text); assert.deepEqual(findTopicShiftClaimsV7(text), ['unsupported_topic_shift'], text); }
  for (const text of notShifts) { assert.deepEqual(findTopicShiftClaimsV7(text), [], text); assert.deepEqual(findTopicShiftClaims(text), [], text); }
});

const confirming = '二つの部分がつながった形ですか？';
const turns = (action: string, drafts: string[]): Turn[] => [
  { human: '尖っている部分はどこですか？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '小さい部分のほうですか？' } },
  { human: '次の形を見ましょう。', plan: { action, target: action === 'move_on' ? 'figure_3' : 'figure_0', referent: 'figure_0', drafts, actionScores: { move_on: 0.9, confirm: 0.6, repair: 0.1 } } },
];
const statuses = (records: any) => verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
const build = (label: 'bypass-enabled' | 'repair-first', version: string | undefined, drafts: string[], action = 'move_on') =>
  buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns: turns(action, drafts) });

for (const moved of ['うん、次いこう。', 'じゃあ、次の図形を見てみよう。']) {
  test(`after a vetoed move_on a new trial (v7) does not publish "${moved}" and rewrites it into the chosen confirmation; v6 publishes it as before`, async () => {
    const v7 = await build('repair-first', undefined, [moved, confirming]);
    const t7 = v7.trials[0].attempts[0];
    assert.equal(t7.generationRetryVersion, 'jev_generation_retry_v10'); // the default of a new trial; v10 contains the v7 topic-shift check
    assert.equal(t7.intervention.reasonCode, 'vetoed_bypass_action');
    assert.equal(t7.executed.action, 'confirm');
    assert.deepEqual(t7.generationGuard, { violations: ['unsupported_topic_shift'], regenerated: true, fallback: false });
    assert.equal(t7.publicSpeech, confirming);
    assert.equal(v7.trials[0].lastCommittedState.repairHistory.at(-1).question, t7.executed.feature);
    assert.deepEqual(statuses(v7), ['pass', 'pass', 'pass', 'pass']);
    assert.equal(v7.trials[0].replay[0].result.status, 'same_material_intervention_verified');
    const v6 = await build('repair-first', 'jev_generation_retry_v6', [moved, confirming]);
    assert.equal(v6.trials[0].attempts[0].publicSpeech, moved, 'a v6 record keeps the behaviour it was recorded with');
    assert.deepEqual(v6.trials[0].attempts[0].generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.deepEqual(statuses(v6), ['pass', 'pass', 'pass', 'pass']);
  });
}

test('v7: two such drafts hold the input; a regular move_on, a defer-style move after an agreement and a narrowing confirmation are still published', async () => {
  await assert.rejects(build('repair-first', undefined, ['うん、次いこう。', 'じゃあ、次の図形を見てみよう。']), /unsafe_generation|generation_failed|stop/u);
  const bypass = await build('bypass-enabled', undefined, ['うん、次いこう。', confirming]);
  assert.equal(bypass.trials[0].attempts[0].executed.action, 'move_on');
  assert.equal(bypass.trials[0].attempts[0].publicSpeech, 'うん、次いこう。');
  assert.deepEqual(statuses(bypass), ['pass', 'pass', 'pass', 'pass']);
  const narrowing = '次に、細い棒がつながっているかを確認させてください。';
  const plain = await build('bypass-enabled', undefined, [narrowing, confirming], 'confirm');
  for (const label of ['bypass-enabled'] as const) assert.equal(plain.trials[0].attempts[0].publicSpeech, narrowing, label);
  assert.deepEqual(plain.trials[0].attempts[0].generationGuard, { violations: [], regenerated: false, fallback: false });
  const proposal = 'この図形を「小舟」と呼びませんか？';
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    const afterAgreement = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns: [publicFocusTurn(0),
      { human: proposal, plan: { action: 'agree', target: 'figure_0', referent: 'figure_0', name: '小舟', act: 'name_propose', speech: 'では「小舟」と呼びましょう。',
        extraction: JSON.stringify([{ segmentId: 's1', quote: proposal, proposition: '小舟', name: '小舟', targets: [OWN.ownAnchors[0].id], aspect: 'name', linkedIssueId: null, respondsToTurn: null }]) } },
      { human: 'じゃあ、次の形を見ましょう。', plan: { action: 'accept', target: 'figure_1', referent: 'figure_1', drafts: ['うん、次いこう。'] } }] });
    const attempt = afterAgreement.trials[0].attempts[0];
    assert.equal(attempt.publicSpeech, 'うん、次いこう。');
    assert.deepEqual(attempt.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.deepEqual(statuses(afterAgreement), ['pass', 'pass', 'pass', 'pass']);
  }
});
