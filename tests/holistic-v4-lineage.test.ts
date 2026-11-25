// holistic_v3 is reproduced as it was at 80d0cfd: a tape made by that runtime replays verified here, and its S4 checks pass unedited.
// The records come from the archived runtime of that commit; without the Git history the tests are skipped.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { buildRecords, MODEL, OWN } from './support/s4-v3-records.ts';
import { LOCAL_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract.ts';

const gitExec = promisify(execFile);
const gitRoot = fileURLToPath(new URL('../', import.meta.url));
const REVISION = '80d0cfd';
const S3 = OWN.ownAnchors[3].id;
const speech = '角ばった塊に細い脚が付いた形のように見えます。';
const aiExtraction = JSON.stringify([{ segmentId: 'shape', quote: speech, targets: [S3], aspect: 'construal', proposition: 'x', name: null, linkedIssueId: null, respondsToTurn: null }]);
const seg = (quote: string, name: string | null, targets: string[] = [], respondsToTurn: number | null = null) =>
  JSON.stringify([{ segmentId: 's1', quote, targets, aspect: 'name', proposition: quote, name, linkedIssueId: null, respondsToTurn }]);
const turnsFor = (antecedent: string, s3: string) => [
  { human: 'どんな図形がありますか？', plan: { action: 'confirm', target: 'figure_3', speech, aiExtraction } },
  { human: 'これ、かかしとかどう？', plan: { action: 'agree', target: 'figure_3', name: 'かかし', act: 'name_propose', referent: 'figure_3', extraction: seg('かかし', 'かかし', [s3]), speech: '「かかし」と呼びましょう。' } },
  { human: 'その呼び名でいい？', plan: { action: 'accept', target: 'none', act: 'name_propose', antecedent, referent: 'figure_3', extraction: seg('その呼び名でいい？', null, [], 4), speech: 'うん、いいよ。' } }];

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  for (const antecedent of ['claim_1', 'claim_2']) {
    test(`B2 ${label} ${antecedent}: a holistic_v3 tape made at ${REVISION} replays verified and passes S4 unedited`, async t => {
      try { await gitExec('git', ['cat-file', '-e', REVISION + '^{commit}'], { cwd: gitRoot }); }
      catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) { t.skip('historical Git objects are unavailable in this checkout'); return; }
        throw error;
      }
      const directory = await mkdtemp(join(tmpdir(), 'v3-archived-runtime-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      await gitExec('git', ['archive', '--output=' + join(directory, 'source.tar'), REVISION], { cwd: gitRoot });
      await gitExec('tar', ['-xf', join(directory, 'source.tar'), '-C', directory]);
      const archived = await import(pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href) as { buildRecords: typeof buildRecords; OWN: typeof OWN };
      const records = await archived.buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: turnsFor(antecedent, archived.OWN.ownAnchors[3].id) as never });
      const trial = records.trials[0];
      assert.equal(trial.profile.dialoguePolicy, 'holistic_v3');
      const checks = interventionChecks(records);
      const statuses = ['shape', 'binding', 'execution', 'replay'].map(kind => checks.find(c => c.id === 'intervention.trial.0.attempt.0.' + kind)?.status);
      assert.deepEqual(statuses, ['pass', 'pass', 'pass', 'pass']);
      const { tape } = trial.replay[0];
      const result = await pairedInterventionReplay(tape, archived.OWN as never, MODEL, JSON.parse(JSON.stringify(trial.profile)));
      assert.equal(result.status, 'same_material_intervention_verified', JSON.stringify(result.error));
    });
  }
}

// A record made by the runtime of eca0e6a is holistic_v3 by name but handled the approval request by what is now holistic_v4's rule: S4 must not accept it as v3.
for (const label of ['repair-first', 'bypass-enabled'] as const) {
  for (const antecedent of ['claim_1', 'claim_2']) {
    test(`S4 ${label} ${antecedent}: a record of eca0e6a labelled holistic_v3 is a replay mismatch`, async t => {
      const middle = 'eca0e6a';
      try { await gitExec('git', ['cat-file', '-e', middle + '^{commit}'], { cwd: gitRoot }); }
      catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) { t.skip('historical Git objects are unavailable in this checkout'); return; }
        throw error;
      }
      const directory = await mkdtemp(join(tmpdir(), 'v3-middle-runtime-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      await gitExec('git', ['archive', '--output=' + join(directory, 'source.tar'), middle], { cwd: gitRoot });
      await gitExec('tar', ['-xf', join(directory, 'source.tar'), '-C', directory]);
      const archived = await import(pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href) as { buildRecords: typeof buildRecords; OWN: typeof OWN };
      const records = await archived.buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: turnsFor(antecedent, archived.OWN.ownAnchors[3].id) as never });
      const checks = interventionChecks(records);
      const statuses = ['shape', 'binding', 'execution', 'replay'].map(kind => checks.find(c => c.id === 'intervention.trial.0.attempt.0.' + kind)?.status);
      assert.notDeepEqual(statuses, ['pass', 'pass', 'pass', 'pass']);
    });
  }
}

// The same, with a second segment of the last turn whose summary was redacted by the ordinary save: the readable approval request still shows the version mismatch.
for (const label of ['repair-first', 'bypass-enabled'] as const) {
  for (const antecedent of ['claim_1', 'claim_2']) {
    test(`S4 ${label} ${antecedent}: a record of eca0e6a with another segment redacted is still a replay mismatch`, async t => {
      const middle = 'eca0e6a';
      try { await gitExec('git', ['cat-file', '-e', middle + '^{commit}'], { cwd: gitRoot }); }
      catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) { t.skip('historical Git objects are unavailable in this checkout'); return; }
        throw error;
      }
      const directory = await mkdtemp(join(tmpdir(), 'v3-middle-runtime-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      await gitExec('git', ['archive', '--output=' + join(directory, 'source.tar'), middle], { cwd: gitRoot });
      await gitExec('tar', ['-xf', join(directory, 'source.tar'), '-C', directory]);
      const archived = await import(pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href) as { buildRecords: typeof buildRecords; OWN: typeof OWN };
      const s3 = archived.OWN.ownAnchors[3].id;
      const approval = 'その呼び名でいい？', feature = '丸い穴があります。';
      const two = JSON.stringify([{ segmentId: 's1', quote: approval, targets: [], aspect: 'name', proposition: approval, name: null, linkedIssueId: null, respondsToTurn: 4 },
        { segmentId: 's2', quote: feature, targets: [s3], aspect: 'part', proposition: LOCAL_EXTRACTION_INSTRUCTIONS.slice(0, 120), name: null, linkedIssueId: null, respondsToTurn: null }]);
      const turns = turnsFor(antecedent, s3);
      (turns[2].plan as any).extraction = two;
      (turns[2] as any).human = approval + feature;
      const records = await archived.buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: turns as never });
      assert.ok(records.trials[0].attempts[0].local.extractor.segments.some((x: any) => x.redacted === true));
      const checks = interventionChecks(records);
      const statuses = ['shape', 'binding', 'execution', 'replay'].map(kind => checks.find(c => c.id === 'intervention.trial.0.attempt.0.' + kind)?.status);
      assert.notDeepEqual(statuses, ['pass', 'pass', 'pass', 'pass']);
    });
  }
}
