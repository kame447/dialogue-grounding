// Synthetic wording only. The partner proposes a name, then asks twice, without saying it, whether it is acceptable; the AI's focus moved in between.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { buildRecords, OWN, type Turn } from './support/s4-v3-records.ts';

const name = '小舟';
const slot = OWN.ownAnchors[0].id;
const proposal = 'この図形を「小舟」と呼びませんか？';
const approval = (text: string, respondsToTurn: number) => JSON.stringify([{ segmentId: 's1', quote: text, proposition: '呼び名の承認を求める', name: null, targets: [],
  aspect: 'name', linkedIssueId: null, respondsToTurn }]);
const asks = ['その呼び名でいい？', 'だから、その名前でいいかどうかを聞いています。'];
const turns = (antecedents: [string, string]): Turn[] => [
  { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'name_propose', speech: '輪が台に接している形のことですか？',
    extraction: JSON.stringify([{ segmentId: 's1', quote: proposal, proposition: name, name, targets: [slot], aspect: 'name', linkedIssueId: null, respondsToTurn: null }]) } },
  { human: asks[0], plan: { action: 'confirm', target: 'figure_1', referent: 'figure_0', act: 'name_propose', antecedent: antecedents[0], speech: '細い部分が途中で曲がっている形のことですか？',
    extraction: approval(asks[0], 2) } },
  { human: asks[1], plan: { action: 'agree', target: 'figure_0', referent: 'figure_0', name, act: 'name_propose', antecedent: antecedents[1], speech: 'はい、「小舟」と呼びましょう。',
    extraction: approval(asks[1], 4) } },
];
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`holistic_v5 ${label}: agree stays available after two name-less approval requests and S4 and the dynamic replay verify it`, async () => {
    const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns: turns(['claim_0', 'claim_1']) });
    const trial = records.trials[0], trace = trial.attempts[0];
    assert.equal(trace.namingRequest, true);
    assert.equal(trace.executed.action, 'agree');
    assert.deepEqual(trial.lastCommittedState.judgments.at(-1).jevTurn.agreeNames, [{ name, figureId: slot, sourceTurn: 1 }]);
    assert.equal(trial.replay[0].result.status, 'same_material_intervention_verified');
    assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
    assert.deepEqual(verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status), ['pass', 'pass', 'pass', 'pass']);
  });
}


// A feature asked once is not asked again after an accept and a change of figure; S4 re-derives the same feature candidates from the written ledger.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`holistic_v5 ${label}: a confirmed feature does not come back after an accept in between, and S4 derives the same candidates`, async () => {
    const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns: [
      { human: 'この図形の特徴を教えてください。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '特徴を一つ確かめさせてください。' } },
      { human: '別の図形の話に移ります。', plan: { action: 'accept', target: 'figure_1', referent: 'figure_1', speech: '別の図形の話ですね。' } },
      { human: 'もう一度さっきの図形に戻って特徴を教えてください。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: 'もう一つ特徴を確かめさせてください。' } },
    ] });
    const trial = records.trials[0], judgments = trial.lastCommittedState.judgments;
    const features = judgments.filter((j: any) => j.jevTurn.executed.action === 'confirm').map((j: any) => j.jevTurn.executed.feature);
    assert.equal(features.length, 2);
    assert.notEqual(features[0], features[1]);
    assert.equal(trial.replay[0].result.status, 'same_material_intervention_verified');
    assert.deepEqual(verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status), ['pass', 'pass', 'pass', 'pass']);
  });
}
