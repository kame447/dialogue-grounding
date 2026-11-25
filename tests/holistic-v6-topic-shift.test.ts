// Synthetic wording only. jev_generation_retry_v6: after the strategy refused a move, or while the chosen act is a confirm, a draft that says the conversation moves on is not published.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { findTopicShiftClaims, findOrientationLeaks, defaultGenerationRetryVersion, hasVersionedViewpoint, isGenerationV5, isGenerationV6, isGenerationV7, isGenerationV8, isGenerationV9, isGenerationV10, validGenerationRetryVersion } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { buildRecords, type Turn } from './support/s4-v3-records.ts';

const moved = 'うん、次にいこう。';
const confirming = '二つの部分がつながった形ですか？';
const turns = (action: string, drafts: string[], extra: Record<string, unknown> = {}): Turn[] => [
  { human: '尖っている部分はどこですか？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '小さい部分のほうですか？' } },
  { human: '次の形を見ましょう。', plan: { action, target: action === 'move_on' ? 'figure_3' : 'figure_0', referent: 'figure_0', drafts, actionScores: { move_on: 0.9, confirm: 0.6, repair: 0.1 }, ...extra } },
];
const statuses = (records: any) => verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
const build = (label: 'bypass-enabled' | 'repair-first', version: string, drafts: string[], action = 'move_on') =>
  buildRecords({ label, dialoguePolicy: 'holistic_v5', generationRetryVersion: version as any, technicalTrial: { version: 'adaptive_repair_v3' }, turns: turns(action, drafts) });

test('the guard: only a chosen move_on, defer or close may say the conversation moves on; quotes, negations and an ordinary "次に" question are not shifts', () => {
  for (const text of [moved, 'では、次の図形に移りましょう。', '話題を変えましょう。', '先に進みます。', '別の形へいきましょうか？']) assert.deepEqual(findTopicShiftClaims(text), ['unsupported_topic_shift'], text);
  for (const text of [confirming, '次に、細い棒はつながっていますか？', '次の特徴は、穴の数です。', '先に進まず、この形を確かめたいです。', '相手が「次にいこう」と言いました。', '次の形には行きません。']) assert.deepEqual(findTopicShiftClaims(text), [], text);
});

test('versions: v10 contains v9, v8, v7, v6, v5 and v4; v5 and v4 are not v6; the default of a new v5 trial is v10 (v9, v8, v7, v6 and v5 stay valid for saved records)', () => {
  assert.equal(defaultGenerationRetryVersion('two_stage_v3', 'holistic_v5'), 'jev_generation_retry_v10');
  const all = ['jev_generation_retry_v4', 'jev_generation_retry_v5', 'jev_generation_retry_v6', 'jev_generation_retry_v7', 'jev_generation_retry_v8', 'jev_generation_retry_v9', 'jev_generation_retry_v10'];
  for (const v of all) { assert.ok(hasVersionedViewpoint(v)); assert.ok(validGenerationRetryVersion(v, 'two_stage_v3', 'holistic_v5')); }
  assert.deepEqual(all.map(isGenerationV5), [false, true, true, true, true, true, true]);
  assert.deepEqual(all.map(isGenerationV6), [false, false, true, true, true, true, true]);
  assert.deepEqual(all.map(isGenerationV7), [false, false, false, true, true, true, true]);
  assert.deepEqual(all.map(isGenerationV8), [false, false, false, false, true, true, true]);
  assert.deepEqual(all.map(isGenerationV9), [false, false, false, false, false, true, true]);
  assert.deepEqual(all.map(isGenerationV10), [false, false, false, false, false, false, true]);
  assert.equal(validGenerationRetryVersion('jev_generation_retry_v6', 'two_stage_v3', 'holistic_v4'), false);
});

for (const version of ['jev_generation_retry_v5', 'jev_generation_retry_v6'] as const) {
  test(`repair-first after a vetoed move_on (${version}): ${version === 'jev_generation_retry_v6' ? 'the move-on draft is rewritten into the chosen confirmation' : 'the earlier behaviour is unchanged'}`, async () => {
    const records = await build('repair-first', version, [moved, confirming]);
    const trial = records.trials[0], trace = trial.attempts[0];
    assert.equal(trace.intervention.reasonCode, 'vetoed_bypass_action');
    assert.equal(trace.executed.action, 'confirm');
    assert.equal(trace.generationRetryVersion, version);
    if (version === 'jev_generation_retry_v6') {
      assert.deepEqual(trace.generationGuard, { violations: ['unsupported_topic_shift'], regenerated: true, fallback: false });
      assert.equal(trace.publicSpeech, confirming);
    } else {
      assert.equal(trace.publicSpeech, moved, 'v5 publishes it as before');
      assert.deepEqual(trace.generationGuard, { violations: [], regenerated: false, fallback: false });
    }
    assert.deepEqual(statuses(records), ['pass', 'pass', 'pass', 'pass']);
    assert.equal(trial.replay[0].result.status, 'same_material_intervention_verified');
  });
}

test('v6: a regular move_on (bypass-enabled) says it, a plain confirm that moves on is rewritten, and two bad drafts hold the input instead of publishing a move', async () => {
  const bypass = await build('bypass-enabled', 'jev_generation_retry_v6', [moved, confirming]); // the repair-first side of the same turn needs the rewrite
  assert.equal(bypass.trials[0].attempts[0].executed.action, 'move_on');
  assert.equal(bypass.trials[0].attempts[0].publicSpeech, moved);
  assert.deepEqual(bypass.trials[0].attempts[0].generationGuard, { violations: [], regenerated: false, fallback: false });
  assert.deepEqual(statuses(bypass), ['pass', 'pass', 'pass', 'pass']);
  const plain = await build('bypass-enabled', 'jev_generation_retry_v6', [moved, confirming], 'confirm');
  assert.equal(plain.trials[0].attempts[0].executed.action, 'confirm');
  assert.deepEqual(plain.trials[0].attempts[0].generationGuard.violations, ['unsupported_topic_shift']);
  assert.equal(plain.trials[0].attempts[0].publicSpeech, confirming);
  assert.deepEqual(statuses(plain), ['pass', 'pass', 'pass', 'pass']);
  await assert.rejects(build('repair-first', 'jev_generation_retry_v6', [moved, 'では、次の図形に移りましょう。']), /unsafe_generation|generation_failed|stop/u);
});

test('the other guard checks of v4 and v5 are unchanged by v6', () => {
  const text = '上の中央に丸い穴がありますか？';
  for (const v of ['jev_generation_retry_v4', 'jev_generation_retry_v5', 'jev_generation_retry_v6'] as const) assert.deepEqual(findOrientationLeaks(text, 'holistic_v5', v), ['orientation_leak']);
});

test('v6: a vetoed defer is treated the same way, and a move to the next figure after an agreement is still said', async () => {
  const slot = (await import('./support/s4-v3-records.ts')).OWN.ownAnchors[0].id;
  const deferred = await build('repair-first', 'jev_generation_retry_v6', ['うん、次の形に進もう。', confirming], 'defer');
  const trace = deferred.trials[0].attempts[0];
  assert.equal(trace.intervention.reasonCode, 'vetoed_bypass_action');
  assert.notEqual(trace.executed.action, 'defer');
  assert.deepEqual(trace.generationGuard.violations, ['unsupported_topic_shift']);
  assert.deepEqual(statuses(deferred), ['pass', 'pass', 'pass', 'pass']);
  const proposal = 'この図形を「小舟」と呼びませんか？';
  const description = '短い辺が二つつながっていますね。';
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', generationRetryVersion: 'jev_generation_retry_v6', technicalTrial: { version: 'adaptive_repair_v3' }, turns: [
      { human: '短い辺がつながった形の話です。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: description,
        aiExtraction: JSON.stringify([{ segmentId: 's1', quote: description, proposition: description, name: null, targets: [slot], aspect: 'contour', linkedIssueId: null, respondsToTurn: null }]) } },
      { human: proposal, plan: { action: 'agree', target: 'figure_0', referent: 'figure_0', name: '小舟', act: 'name_propose', speech: 'では「小舟」と呼びましょう。',
        extraction: JSON.stringify([{ segmentId: 's1', quote: proposal, proposition: '小舟', name: '小舟', targets: [slot], aspect: 'name', linkedIssueId: null, respondsToTurn: null }]) } },
      { human: 'では、次の形を見ましょう。', plan: { action: 'accept', target: 'figure_1', referent: 'figure_1', drafts: ['はい、次の形にいきましょう。'] } },
    ] });
    const attempt = records.trials[0].attempts[0];
    assert.equal(attempt.publicSpeech, 'はい、次の形にいきましょう。');
    assert.deepEqual(attempt.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.deepEqual(statuses(records), ['pass', 'pass', 'pass', 'pass']);
  }
});

const NOTE = '選ばれた行動は、話題や図形を次へ移すことではありません。相手が次へ進むことを提案していても応じず、次へ進むと述べずに、選ばれた対象や特徴の確認を、このactionの範囲で行ってください。';
const actMessages = (records: any, label: string) => records.trials[0].replay[0].result.sides.find((s: any) => s.label === label).requests
  .filter((r: any) => r.phase === 'generation').map((r: any) => r.payload.messages[2].content as string);

test('v6: the action scope of a confirm or repair says not to follow a move-on and to check the chosen feature, for both strategies; v5 does not say it; the history stays consistent after a veto', async () => {
  const v6 = await build('repair-first', 'jev_generation_retry_v6', [moved, confirming]);
  for (const label of ['repair-first', 'bypass-enabled']) for (const m of actMessages(v6, label).slice(0, 1)) assert.equal(m.includes(NOTE), label === 'repair-first', `${label}: the note belongs to the confirm of the vetoed side only, as its act is a confirm`);
  const plainConfirm = await build('bypass-enabled', 'jev_generation_retry_v6', ['二つの部分がつながった形ですか？'], 'confirm');
  for (const label of ['repair-first', 'bypass-enabled']) assert.ok(actMessages(plainConfirm, label)[0].includes(NOTE), label + ' a confirm carries the note');
  const v5 = await build('repair-first', 'jev_generation_retry_v5', [moved, confirming]);
  for (const label of ['repair-first', 'bypass-enabled']) for (const m of actMessages(v5, label)) assert.ok(!m.includes(NOTE));
  // after the veto the chosen feature is the one that was asked: the history entry and the public question agree
  const trial = v6.trials[0], executed = trial.attempts[0].executed, last = trial.lastCommittedState.repairHistory.at(-1);
  assert.equal(executed.action, 'confirm');
  assert.equal(last.question, executed.feature);
  assert.equal(trial.attempts[0].publicSpeech, confirming);
});

test('v6: the repair-prospect questions carry the notation legend and the rotation premise; v5 requests are unchanged', async () => {
  const { buildRepairProspectPayload } = await import('../dialogue-model/runtime/decision/jev-decision.ts');
  const { OLD, OWN } = await import('./support/s4-v3-records.ts');
  const slots = OWN.ownAnchors.map((a: any) => a.id);
  const input: any = { turn: 7, publicTurns: [{ turn: 1, speaker: 'human', text: 'はじめます。' }, { turn: 7, speaker: 'human', text: 'もう一度。' }], ownSlots: slots, observations: structuredClone(OLD.state.observationMemo), issueSummary: '', priorClaims: [],
    repairHistory: [{ turn: 3, issueId: null, action: 'confirm', question: '細い枝', partnerClaims: [], candidatesBefore: [slots[1]], candidatesAfter: [slots[1]], addedClaimIds: [], removedClaimIds: [], progress: 'unknown' }],
    previousAction: null, publicNames: [], judgmentLedger: [], rotationMode: 'relative_pm90' };
  const texts = (extra: any) => Object.values<any>(buildRepairProspectPayload({ ...input, ...extra }, { questionLayout: 'two_stage_v3' }).questions).map(q => q.instructions as string);
  for (const t of texts({ notationV6: true })) { assert.match(t, /stateの記法/u); assert.match(t, /relative_pm90/u); }
  for (const t of texts({})) { assert.doesNotMatch(t, /stateの記法/u); assert.doesNotMatch(t, /relative_pm90/u); }
  assert.throws(() => buildRepairProspectPayload({ ...input, judgmentLedger: undefined, notationV6: true }, { questionLayout: 'two_stage_v3' }), /invalid_input/u);
});
