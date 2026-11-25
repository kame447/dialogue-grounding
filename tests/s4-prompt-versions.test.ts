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

// Merge with main bcb8211: its instruction sources changed again (usage-only plumbing, no prompt text), so main's own
// records (baseline text) and the merged #172 records (#172 text) each need their registered sources.
const mainBcb8211 = { scheme: 'complete_instruction_source_sha256', files: {'v2/dialogue-v2.mjs':'092a7d3ff87462cf4df9f06e25fa23f5d6394c14e5c30dd35c9c894723ad160c','v2/jev-turn.ts':'77619037549ac800b750b4d3ffe6fd0c342ddc1af5508050132ac19b5ffb0dd8','v2/generation-guard.ts':'f1641117798e1538a6db4ebb97e8ac33a2da14e926c405f4a7c7f6c8b751ad46','judgment/instructions.mjs':'aa8b84ba60f10780328521457fc3abf4bfaa6db6efd32a725924075a9584f884','observation/observe.ts':'469a0c99af9d68e681176acfaa43c32dbb4493df82d0ded17b817ae039c1a0ad','local-grounding/extract.ts':'1f3af472bca173e83bcb0bf07e4b98c15fb98bc1b960aedc28e0a4970563764e','local-grounding/jev-local-test.ts':'95e1509bd5a4dbc6f1687605d24b6848c311cb631db480adce5bc5eeed052492','decision/jev-decision.ts':'a7503c1904b3fe55a90458c1ad996b76432491f9640087321d871e5468851b33','local-grounding/extract-ai.ts':'61c88803ddd0dd8690dadbd707afdb1111e894fb8dcc396562cd6eb85217ebd5','local-grounding/jev-ai-public.ts':'6d3e05a7fb12778754a6cd8ba9c7b00e7045fa55daeded213a46a5a10375f1c7'} };
const mergedSources = JSON.parse(await readFile(new URL('./fixtures/parity-verify/failure-path-partner-position-eaa8e9c/producer-records.json', import.meta.url), 'utf8')).observation_timeout.run.promptSources;

test('main bcb8211 sources replay the baseline text, and the merged #172 sources replay the #172 text', () => {
  const asMain = withSources(original, mainBcb8211);
  assert.deepEqual(interventionChecks(asMain), expected);
  assert.equal(verifyRecords(asMain).checks.find(c => c.id === 'intervention.trial.0.attempt.0.replay')?.status, 'pass');
  const asMerged = withSources(current, mergedSources);
  assert.deepEqual(interventionChecks(asMerged), expected);
  assert.equal(verifyRecords(asMerged).checks.find(c => c.id === 'intervention.trial.0.attempt.0.replay')?.status, 'pass');
  for (const crossed of [withSources(current, mainBcb8211), withSources(original, mergedSources)]) {
    assert.deepEqual(replay(crossed), { id: 'intervention.trial.0.attempt.0.replay', status: 'mismatch', reason: 'intervention_replay_mismatch' });
  }
});
