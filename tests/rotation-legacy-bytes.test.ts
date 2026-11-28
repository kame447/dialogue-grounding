// #269: relative_90_180_270 was added without changing a byte the two earlier modes produce.
// The expected digests were generated from base 620ef5c, before the new mode existed (see tests/support/rotation-legacy-digests.ts);
// never regenerate them from a later commit. A mismatch here means an earlier mode's stimulus, request or pool key changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGACY_MODES, poolKeys, requestDigests, stimulusDigests } from './support/rotation-legacy-digests.ts';

const expected = JSON.parse(readFileSync(new URL('./fixtures/rotation-legacy-bytes/digests-620ef5c.json', import.meta.url), 'utf8'));

test('the table comes from the base commit and covers every earlier mode', () => {
  assert.equal(expected.baseCommit, '620ef5c');
  for (const mode of ['implicit', 'relative_pm90', 'relative_0']) {
    assert.ok(Object.keys(expected.stimuli).some(key => key.startsWith(mode + '|')), mode + ' stimuli');
    assert.ok(Object.keys(expected.requests).some(key => key.startsWith(mode + '|')), mode + ' requests');
  }
  assert.ok(Object.keys(expected.poolKeys).every(key => !key.startsWith('relative_90_180_270')), 'the new mode has no base digest');
});

test('stimuli, trial ids, recorded angles and layouts of the earlier modes keep their base bytes', () => {
  const actual = stimulusDigests(LEGACY_MODES);
  assert.deepEqual(Object.keys(actual), Object.keys(expected.stimuli));
  for (const [name, digest] of Object.entries(expected.stimuli)) assert.deepEqual(actual[name], digest, name);
});

test('every Jev request kind that carries the rotation premise keeps its base bytes for the earlier modes', () => {
  const actual = requestDigests(LEGACY_MODES);
  assert.deepEqual(Object.keys(actual), Object.keys(expected.requests));
  for (const [name, digests] of Object.entries(expected.requests)) assert.deepEqual(actual[name], digests, name);
});

test('prepared-observation pool keys of the earlier modes keep their base values', () => {
  assert.deepEqual(poolKeys(), expected.poolKeys);
});
