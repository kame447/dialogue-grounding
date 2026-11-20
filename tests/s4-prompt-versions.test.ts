// #172: the independent S4 verifier binds a record's instruction sources (run.promptSources) to the text of
// that prompt version. Synthetic records only; no producer code is executed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';

const load = async (name: string) => JSON.parse(await readFile(new URL('./support/s4-integration/' + name, import.meta.url), 'utf8'));
const original = await load('NORMAL-RECORDS.json'), current = await load('i172/NORMAL-RECORDS.json'), expected = await load('NORMAL-CHECKS.json');
// The instruction sources the pre-#172 main (2dbf7e2) records, as kept in the adopted e6e2c67 failure capture.
const preFixMain = JSON.parse(await readFile(new URL('./fixtures/parity-verify/failure-path-repair-facts-e6e2c67/producer-records.json', import.meta.url), 'utf8')).observation_timeout.run.promptSources;
const replay = (records: any) => interventionChecks(records).find(c => c.id === 'intervention.trial.0.attempt.0.replay')!;
// Sources and their digest move together, so only the source/text binding can fail.
const withSources = (records: any, sources: unknown) => {
  const r = structuredClone(records); r.run.promptSources = structuredClone(sources);
  for (const t of r.trials) t.identity.prompts = hash(sources);
  return r;
};

test('the original normal record (baseline8af76e6 sources and text) still passes unchanged', () => {
  assert.deepEqual(interventionChecks(original), expected);
  assert.equal(verifyRecords(original).checks.find(c => c.id === 'intervention.trial.0.attempt.0.replay')?.status, 'pass');
});

test('the #172 normal record (its own sources and text) passes', () => {
  assert.deepEqual(interventionChecks(current), expected);
  assert.equal(verifyRecords(current).checks.find(c => c.id === 'intervention.trial.0.attempt.0.replay')?.status, 'pass');
  assert.equal(current.trials[0].identity.prompts, hash(current.run.promptSources));
});

test('the pre-#172 main sources with the baseline text pass, and with the #172 text are a mismatch', () => {
  assert.equal(hash(preFixMain), '302bc298b4f7b17a07d78a0a57b914841f4af146901f97537f80f05b7c952d9b');
  const recorded = withSources(original, preFixMain);
  assert.deepEqual(interventionChecks(recorded), expected);
  assert.equal(verifyRecords(recorded).checks.find(c => c.id === 'intervention.trial.0.attempt.0.replay')?.status, 'pass');
  const crossed = withSources(current, preFixMain);
  assert.deepEqual(replay(crossed), { id: 'intervention.trial.0.attempt.0.replay', status: 'mismatch', reason: 'intervention_replay_mismatch' });
  assert.deepEqual(interventionChecks(crossed).filter(c => !c.id.endsWith('.replay')), expected.filter((c: any) => !c.id.endsWith('.replay')));
});

test('crossed sources and text are a replay mismatch in both directions', () => {
  for (const crossed of [withSources(current, original.run.promptSources), withSources(original, current.run.promptSources)]) {
    assert.deepEqual(replay(crossed), { id: 'intervention.trial.0.attempt.0.replay', status: 'mismatch', reason: 'intervention_replay_mismatch' });
    const others = interventionChecks(crossed).filter(c => !c.id.endsWith('.replay'));
    assert.deepEqual(others, expected.filter((c: any) => !c.id.endsWith('.replay')), 'only the replay proof depends on the prompt version');
  }
});

test('altered replay text is a mismatch under either version', () => {
  for (const records of [original, current]) {
    const altered = structuredClone(records);
    const generation = altered.trials[0].replay[0].result.sides[1].requests.find((r: any) => r.phase === 'generation');
    generation.payload.messages[0].content += '。';
    assert.equal(replay(altered).status, 'mismatch');
  }
});

test('an identity digest that disagrees with the sources, or unregistered sources, is a mismatch', () => {
  const digest = structuredClone(current); digest.trials[0].identity.prompts = original.trials[0].identity.prompts;
  assert.equal(replay(digest).status, 'mismatch');
  const sources = structuredClone(current.run.promptSources); sources.files['v2/jev-turn.ts'] = '0'.repeat(64);
  assert.equal(replay(withSources(current, sources)).status, 'mismatch');
  const missing = structuredClone(current); delete missing.run.promptSources;
  assert.equal(replay(missing).status, 'mismatch');
});
