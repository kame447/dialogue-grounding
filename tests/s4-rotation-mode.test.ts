// #269: S4 judges the rotation premise of every recorded Jev judgment request against the stimulus mode its own state records.
// relative_pm90 states the ±90 sentence, relative_0 states none, relative_90_180_270 states the sentence of the task contract.
// The records come from the real runtime and offline replay (buildRecords); retargetRotation (support/s4-rotation-records.ts) changes only the recorded
// mode and the premise sentence, so what S4 verifies or refuses is exactly that relation. Synthetic wording only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { buildRecords, type Label } from './support/s4-v3-records.ts';
import { PREMISE_90_180_270, PREMISE_PM90, premiseOf, retargetRotation, retargetToMode, type RotationMode } from './support/s4-rotation-records.ts';

const LABELS: Label[] = ['repair-first', 'bypass-enabled'];
const MODES: RotationMode[] = ['relative_pm90', 'relative_0', 'relative_90_180_270'];
const INTERVENTION = /^intervention\.trial\.0\.attempt\.0\./u;
const statuses = (records: unknown) => verifyRecords(records as never).checks.filter(c => INTERVENTION.test(c.id)).map(c => c.id.split('.').pop() + ':' + c.status);
const ALL_PASS = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:pass'];

// The final turn is the one replayed. The second turn changes the figure and the third comes back, so the record holds the repair prospect too.
const turns = [
  { human: 'この図形の特徴を教えてください。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '特徴を一つ確かめさせてください。' } },
  { human: '別の図形の話に移ります。', plan: { action: 'accept', target: 'figure_1', referent: 'figure_1', speech: '別の図形の話ですね。' } },
  { human: 'もう一度さっきの図形に戻って特徴を教えてください。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: 'もう一つ特徴を確かめさせてください。' } },
];
const original = Object.fromEntries(await Promise.all(LABELS.map(async label =>
  [label, await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns })]))) as Record<Label, any>;

/** The judgment requests of one record set, from the replay of its first side: [phase, question keys, instructions of every question]. */
const requests = (records: any) => (records.trials[0].replay[0].result.sides[0].requests as any[]).filter(r => r.provider === 'jev')
  .map(r => ({ phase: r.phase as string, keys: Object.keys(r.payload.questions), state: JSON.parse(r.payload.state), instructions: Object.values<any>(r.payload.questions).map(q => q.instructions as string) }));
const count = (text: string, sentence: string) => text.split(sentence).length - 1;

for (const label of LABELS) {
  test(`${label}: the recorded requests carry the original premise, and the record covers every kind S4 reads the premise from`, () => {
    const rows = requests(original[label]);
    assert.deepEqual(rows.map(r => r.phase), ['human_referent', 'repair_prospect', 'decision', 'decision', 'decision']);
    for (const row of rows) {
      assert.equal(row.state.rotationMode, 'relative_pm90');
      for (const text of row.instructions) { assert.equal(count(text, PREMISE_PM90), 1); assert.equal(count(text, PREMISE_90_180_270), 0); }
    }
    assert.deepEqual(statuses(original[label]), ALL_PASS);
    // Re-targeting to the mode the records already state changes nothing, down to the hashes.
    assert.deepEqual(retargetToMode(original[label], 'relative_pm90'), original[label]);
  });

  for (const mode of MODES) {
    test(`${label}: S4 verifies a record of ${mode} that states the sentence its contract gives`, () => {
      const records = retargetToMode(original[label], mode);
      const premise = premiseOf(mode);
      for (const row of requests(records)) {
        assert.equal(row.state.rotationMode, mode);
        for (const text of row.instructions) {
          assert.equal(count(text, PREMISE_PM90), mode === 'relative_pm90' ? 1 : 0, 'the ±90 sentence');
          assert.equal(count(text, PREMISE_90_180_270), mode === 'relative_90_180_270' ? 1 : 0, 'the 90・180・270 sentence');
          if (premise === null) assert.ok(!/回転して提示しています/u.test(text), 'relative_0 states no premise');
        }
      }
      assert.deepEqual(statuses(records), ALL_PASS);
    });
  }
}

// Each case keeps every hash consistent and changes only the relation between the recorded mode and the sentence the requests carry.
const SECOND_SENTENCE_START = PREMISE_90_180_270.indexOf('向きや方位を表す語');
const DISAGREEMENTS: [string, { stateMode: string; premise: string | null }][] = [
  ['relative_90_180_270 that states the ±90 sentence', { stateMode: 'relative_90_180_270', premise: PREMISE_PM90 }],
  ['relative_90_180_270 that states no premise', { stateMode: 'relative_90_180_270', premise: null }],
  ['relative_pm90 that states the 90・180・270 sentence', { stateMode: 'relative_pm90', premise: PREMISE_90_180_270 }],
  ['relative_pm90 that states no premise', { stateMode: 'relative_pm90', premise: null }],
  ['relative_0 that states the 90・180・270 sentence', { stateMode: 'relative_0', premise: PREMISE_90_180_270 }],
  ['relative_0 that states the ±90 sentence', { stateMode: 'relative_0', premise: PREMISE_PM90 }],
  ['relative_90_180_270 whose sentence names another angle', { stateMode: 'relative_90_180_270', premise: PREMISE_90_180_270.replace('180度', '170度') }],
  ['relative_90_180_270 whose sentence is missing its second sentence', { stateMode: 'relative_90_180_270', premise: PREMISE_90_180_270.slice(0, SECOND_SENTENCE_START).trimEnd() }],
  ['relative_90_180_270 whose sentence is stated twice', { stateMode: 'relative_90_180_270', premise: PREMISE_90_180_270 + '\n' + PREMISE_90_180_270 }],
  ['an unrecorded mode that states the 90・180・270 sentence', { stateMode: 'relative_90_180_271', premise: PREMISE_90_180_270 }],
];
for (const label of LABELS) {
  for (const [description, edit] of DISAGREEMENTS) {
    test(`${label}: S4 refuses a record of ${description}`, () => {
      const result = statuses(retargetRotation(original[label], edit));
      // The material, the hashes and the executed turn stay consistent, so what fails is the replay of the request text.
      assert.deepEqual(result, ['shape:pass', 'binding:pass', 'execution:pass', 'replay:mismatch']);
    });
  }
}
