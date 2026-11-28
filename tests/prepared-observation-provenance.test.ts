import test from 'node:test';
import assert from 'node:assert/strict';
import { approveReception, createReception, receptionProtocolSha256, validateReceptionPlan,
  validateReceptionApprovalInput, participantReception } from '../dialogue-model/runtime/v2/reception.ts';
import type { ReceptionProtocolV2 } from '../dialogue-model/runtime/v2/reception.ts';
import { assignmentPreparedObservation, validateBoundBaseRecord } from '../dialogue-model/runtime/v2/base-assignment-data.ts';
import type { BaseAssignment } from '../dialogue-model/runtime/v2/base-assignment.ts';
import { validatePreparedObservations } from '../dialogue-model/runtime/v2/prepared-observations.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';

const time = '2026-11-01T00:00:00.000Z';
const protocol: ReceptionProtocolV2 = { schemaVersion: 'reception_protocol_v2', protocolId: '22222222-2222-4222-8222-222222222222',
  revision: 1, allowedOrders: [['repair-first', 'bypass-enabled']], seedPolicy: 'shared', referenceMemory: true,
  betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0' };
const pin = { schemaVersion: 'participant_model_pin_v3' as const, terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261001' };
const pending = () => createReception({ receptionId: '11111111-1111-4111-8111-111111111111', objectId: 'a'.repeat(64), createdAt: time, number: null });
const reference = () => validatePreparedObservations({ schemaVersion: 'prepared_observations_v1', bundleId: '33333333-3333-4333-8333-333333333333', preparedAt: time,
  trials: [0, 1].map(index => ({ index, cacheKey: 'terra_initial_observation_v1:' + 'a'.repeat(64), memoSha256: 'b'.repeat(64) })) }, 2);
const options = (): Parameters<typeof approveReception>[1] => ({ expectedRevision: 0, order: 0, protocol, expected: { protocolId: protocol.protocolId, revision: 1,
  sha256: receptionProtocolSha256(JSON.stringify(protocol)) }, approvedAt: time, randomSeed: () => 211,
  participantModelPin: pin, participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE });

test('prepared provenance freezes both trial references, stays private, and rejects grafted record provenance', async () => {
  const reception = await approveReception(pending(), { ...options(), preparedObservations: reference() });
  assert.deepEqual(participantReception(reception), { number: null, status: 'ready', revision: 1 });
  const plan = reception.plan!;
  assert.notEqual(plan.schemaVersion, 'reception_plan_v1');
  for (const index of [0, 1]) {
    const assignment: BaseAssignment = { schemaVersion: 'base_assignment_v1', assignmentId: '44444444-4444-4444-8444-444444444444',
      strategy: plan.trials[index].strategy, seed: 211, referenceMemory: true, createdAt: time,
      source: { kind: 'reception_plan_v2', adapter: 'worker_binding', receptionId: reception.receptionId, protocolId: plan.protocolId,
        protocolRevision: plan.protocolRevision, protocolSha256: plan.protocolSha256, trialIndex: index, plan: plan as Extract<typeof plan, { schemaVersion: 'reception_plan_v2' }> } };
    const preparedObservation = assignmentPreparedObservation(assignment)!;
    assert.equal(preparedObservation.index, index);
    const record = { version: 2, assignment, recordId: '55555555-5555-4555-8555-555555555555', seed: 211, strategy: assignment.strategy,
      status: 'dialogue', options: { referenceMemory: true, rotationMode: 'relative_0', participantModelPin: pin, jevResearch: true,
        participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE, preparedObservation },
      stimulus: { version: 'synthetic', rotationMode: 'relative_0', angles: { human: { h1: 0 }, ai: { a1: 0 } } },
      queueState: { pendingHumanEventIds: [], errorCode: null }, initialObservation: { memoSha256: preparedObservation.memoSha256 },
      jevLedger: { schemaVersion: PARTICIPANT_PRODUCTION_PROFILE, assignmentId: assignment.assignmentId } };
    assert.doesNotThrow(() => validateBoundBaseRecord(record, assignment));
    for (const change of [{ ...preparedObservation, index: 1 - index }, { ...preparedObservation, memoSha256: 'c'.repeat(64) }, undefined]) {
      const altered = structuredClone(record);
      altered.options.preparedObservation = change as typeof preparedObservation;
      assert.throws(() => validateBoundBaseRecord(altered, assignment), { code: 'assignment_record_invalid' });
    }
  }
});

test('legacy plans retain absent provenance and prepared plans require complete earlier valid references', async () => {
  const legacy = (await approveReception(pending(), options())).plan!;
  assert.equal(Object.hasOwn(legacy, 'preparedObservations'), false);
  assert.deepEqual(validateReceptionPlan(legacy), legacy);
  for (const preparedObservations of [
    { ...reference(), trials: reference().trials.slice(0, 1) },
    { ...reference(), preparedAt: '2026-11-02T00:00:00.000Z' },
    { ...reference(), trials: reference().trials.map(t => ({ ...t, index: 0 })) },
    { ...reference(), trials: reference().trials.map((t, i) => ({ ...t, memoSha256: (i ? 'c' : 'b').repeat(64) })) },
  ]) assert.throws(() => validateReceptionPlan({ ...legacy, preparedObservations }));
  assert.doesNotThrow(() => validateReceptionApprovalInput(pending(), options()));
  assert.throws(() => validateReceptionApprovalInput(pending(), { ...options(), expectedRevision: 1 }), { code: 'reception_conflict' });
  assert.throws(() => validateReceptionApprovalInput(pending(), { ...options(), order: 2 }), { code: 'invalid_order' });
});
