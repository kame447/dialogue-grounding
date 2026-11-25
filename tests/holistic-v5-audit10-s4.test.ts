import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { buildRecords, OWN, type Turn } from './support/s4-v3-records.ts';

const name = '小舟';
const human = 'この図形を「小舟」と呼びませんか？';
const scenarios: Turn[] = [
  { human, plan: { action: 'agree', target: 'figure_0', referent: 'figure_0', name, act: 'name_propose',
    extraction: JSON.stringify([{ segmentId: 's1', quote: human, proposition: name, name, targets: [OWN.ownAnchors[0].id],
      aspect: 'name', linkedIssueId: null, respondsToTurn: null }]), speech: 'では「小舟」と呼びましょう。' } },
  { human: 'さっきの図形に戻れますか？', plan: { action: 'revisit', target: 'figure_0', speech: '先ほどの図形について続きを話しましょう。' } },
  { human: 'ここで終わりましょうか？', plan: { action: 'close', target: 'none', speech: 'ここで終わりにしてもいいですか？' } },
];
for (const dialoguePolicy of ['holistic_v4', 'holistic_v5'] as const) {
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    for (const turn of scenarios) test(`${dialoguePolicy} ${label}: S4 verifies ${turn.plan.action} generation`, async () => {
      const records = await buildRecords({ label, dialoguePolicy, technicalTrial: { version: 'adaptive_repair_v3' }, turns: [turn] });
      const trial = records.trials[0];
      assert.equal(trial.attempts[0].executed.action, turn.plan.action);
      const replay = trial.replay[0].result;
      assert.equal(replay.status, 'same_material_intervention_verified');
      assert.equal(replay.recordedPayloadsReproduced, true);
      assert.deepEqual(verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status),
        ['pass', 'pass', 'pass', 'pass']);
    });
  }
}
