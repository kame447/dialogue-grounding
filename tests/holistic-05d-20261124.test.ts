// Synthetic only. 05d-7: holistic_v1 is recorded at creation for a technical-trial v3 only; a plain v3 keeps its original profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateParticipantJevConfig } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { researchHash } from '../dialogue-model/runtime/v2/research-profile.ts';

const base = { schemaVersion: 'participant_jev_config_v1', lunaRequest: { timeoutMs: null, maxCompletionTokens: 1000 },
  timeouts: { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 },
  cacheDirectory: '/synthetic/cache', modelId: 'synthetic-luna-20261020', memoSha256: 'a'.repeat(64), seed: 1,
  limits: { lunaCalls: 100, lunaTokens: 100000, lunaPosts: 100, jevPosts: 100, jevUsd: 0.05 }, questionLayout: 'two_stage_v3' };

test('a technical-trial v3 records holistic_v1; a plain v3 and v1/v2 layouts do not', () => {
  const trial = validateParticipantJevConfig({ ...base, technicalTrial: { version: 'adaptive_repair_v3' } }).profile as any;
  const plain = validateParticipantJevConfig(base).profile as any;
  assert.equal(trial.dialoguePolicy, 'holistic_v1');
  assert.equal(Object.hasOwn(plain, 'dialoguePolicy'), false);
  assert.notEqual(researchHash(trial), researchHash(plain));
  for (const layout of ['two_stage_v1', 'two_stage_v2']) assert.equal(Object.hasOwn(validateParticipantJevConfig({ ...base, questionLayout: layout }).profile, 'dialoguePolicy'), false);
});
