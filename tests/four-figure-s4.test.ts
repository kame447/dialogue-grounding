import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRecords } from './support/s4-v3-records.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';

const historical = JSON.parse(await readFile(new URL('./support/s4-integration/NORMAL-RECORDS.json', import.meta.url), 'utf8'));
const statuses = (records: any) => interventionChecks(records).filter(check => check.id.startsWith('intervention.trial.0.attempt.0.'));
const changeSources = (records: any, sources: any) => {
  const changed = structuredClone(records);
  changed.run.promptSources = sources;
  changed.trials[0].identity.prompts = hash(sources);
  return changed;
};

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  for (const [action, target] of [['accept', 'none'], ['confirm', 'figures_0_1']] as const) {
    test(`four-figure S4 ${label} ${action}: complete independent replay and closed source boundary`, async () => {
      const records = await buildRecords({ label, figureCount: 4, dialoguePolicy: 'holistic_v5',
        generationRetryVersion: 'jev_generation_retry_v12', technicalTrial: { version: 'adaptive_repair_v3' },
        turns: [{ human: 'どの形のことか、少し確かめたいです。', plan: { action, target,
          speech: action === 'accept' ? 'ゆっくり見比べてみましょう。' : '細い部分のつながりを確かめましょう。' } }] });
      assert.deepEqual(statuses(records).map(check => check.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(statuses(records)));
      const trial = records.trials[0], replay = trial.replay[0];
      assert.equal(Object.keys(trial.lastCommittedState.ledger).length, 4);
      for (const side of replay.result.sides) {
        const targetQuestion = side.requests.find((request: any) => request.payload?.questions?.target).payload.questions.target;
        assert.equal(Object.keys(targetQuestion.criteria).length, action === 'accept' ? 16 : 15);
        assert.ok(Object.keys(targetQuestion.criteria).every(key => !/(?:^|_)[45](?:_|$)/.test(key)));
        assert.match(targetQuestion.instructions, /f0〜f3/);
        const generation = side.requests.find((request: any) => request.phase === 'generation');
        assert.match(generation.payload.messages[0].content, /タングラム4図形/);
      }
      const unknown = structuredClone(records.run.promptSources);
      unknown.files['decision/jev-decision.ts'] = '0'.repeat(64);
      assert.ok(statuses(changeSources(records, unknown)).some(check => check.status === 'mismatch'));
      assert.ok(statuses(changeSources(records, historical.run.promptSources)).some(check => check.status === 'mismatch'));
    });
  }
}


test('four-figure S4 validates the count in repair-prospect and human-referent requests after a prior turn', async () => {
  const records = await buildRecords({ figureCount: 4, dialoguePolicy: 'holistic_v5',
    generationRetryVersion: 'jev_generation_retry_v12', technicalTrial: { version: 'adaptive_repair_v3' },
    turns: [{ human: 'どちらの形か確かめたいです。', plan: { action: 'confirm', target: 'figures_0_1',
      speech: '細い部分のつながりを確かめましょう。' } },
    { human: '少しずつ比べましょう。', plan: { action: 'accept', target: 'none', referent: 'none', speech: 'ゆっくり見比べてみましょう。' } }] });
  assert.deepEqual(statuses(records).map(check => check.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(statuses(records)));
  const requests = records.trials[0].replay[0].result.sides[0].requests;
  assert.ok(requests.some((request: any) => request.payload?.questions?.repair_issue));
  assert.ok(requests.some((request: any) => request.payload?.questions?.human_referent));
});

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  for (const generationRetryVersion of ['jev_generation_retry_v17', 'jev_generation_retry_v18'] as const) {
    test(`four-figure S4 ${label} ${generationRetryVersion}: current publication profile passes the independent replay`, async () => {
      const records = await buildRecords({ label, figureCount: 4, dialoguePolicy: 'holistic_v5',
        generationRetryVersion, agreeNameScopeVersion: 'jev_naming_v1',
        interventionVersion: 'bypass_acceptance_v2', judgmentMaterialVersion: 'jev_repair_quality_v1',
        technicalTrial: { version: 'adaptive_repair_v3' }, turns: [{ human: 'ゆっくり比べていきましょう。',
          plan: { action: 'accept', target: 'none', speech: '少しずつ見比べてみましょう。',
            choose: question => question === 'human_move_on_source' ? 'other' : undefined } }] });
      assert.deepEqual(statuses(records).map(check => check.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(statuses(records)));
      for (const source of ['shape-terminology.ts', 'v2/visual-feature-evidence.ts']) {
        assert.match(records.run.promptSources.files[source], /^[a-f0-9]{64}$/, source);
        const incomplete = structuredClone(records.run.promptSources);
        delete incomplete.files[source];
        assert.ok(statuses(changeSources(records, incomplete)).some(check => check.status === 'mismatch'), source);
      }
    });
  }
}
