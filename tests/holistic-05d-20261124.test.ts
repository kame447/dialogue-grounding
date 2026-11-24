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

import { jevChoiceAnswersValid, jevReportedCost, jevResponseId } from '../dialogue-model/runtime/decision/jev-choice-response.ts';
test('the shared response contract: confidence and probabilities in 0..1, exact keys, reported cost, gen- ids', () => {
  const labels = { q: ['a', 'b'] };
  const ok = (extra: object = {}, probs = { a: 1, b: 0 }) => ({ q: { type: 'choice', choice: 'a', probabilities: probs, ...extra } });
  assert.equal(jevChoiceAnswersValid(ok(), labels), true);
  assert.equal(jevChoiceAnswersValid(ok({ confidence: 0.5 }), labels), true);
  assert.equal(jevChoiceAnswersValid(ok({ confidence: null }), labels), true);
  assert.equal(jevChoiceAnswersValid(ok({ confidence: 2 }), labels), false);
  assert.equal(jevChoiceAnswersValid(ok({ extra: 1 }), labels), false);
  assert.equal(jevChoiceAnswersValid(ok({}, { a: 1, b: 1.5 }), labels), false);
  assert.equal(jevChoiceAnswersValid({ ...ok(), z: ok().q }, labels), false);
  assert.equal(jevChoiceAnswersValid({ q: { ...ok().q, choice: 'c' } }, labels), false);
  assert.equal(jevReportedCost({ usage: { cost: 0 } }), 0);
  assert.equal(jevReportedCost({ usage: { cost: -1 } }), null);
  assert.equal(jevReportedCost({}), null);
  assert.equal(jevResponseId({ id: 'gen-abc_1' }), 'gen-abc_1');
  assert.equal(jevResponseId({ id: 'other' }), null);
});
