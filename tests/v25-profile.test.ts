// The v25 profile (participant_dialogue_v25_generation_cleanup): a reception pins the post-generation check setting like v24 (default OFF), the earlier profiles keep their meaning,
// and the runtime of a v25 trial refuses a missing or a stray setting like v24's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveReception, createReception, hasPostGenerationCheckProfile, isParticipantDialogueProfile, isPilot012ParticipantDialogueProfile, participantMemoryPruneVersion,
  PILOT012_V22_PARTICIPANT_PROFILE, PILOT012_V23_PARTICIPANT_PROFILE, PILOT012_V24_PARTICIPANT_PROFILE, PILOT012_V25_PARTICIPANT_PROFILE,
  receptionProtocolSha256, validateReceptionPlan, type ReceptionProtocolV2 } from '../dialogue-model/runtime/v2/reception.ts';
import { GENERATION_RETRY_V25 } from '../dialogue-model/runtime/v2/deferred-ai-extraction.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { CLAIM_PRUNE_V3 } from '../dialogue-model/runtime/memory/reference-graph.mjs';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { initialState, normal, OLD, runTurn } from './support/s4-v3-records.ts';

test('the v25 profile is a pilot012 profile that carries the post-generation check setting; the older profiles keep theirs', () => {
  assert.equal(PILOT012_V25_PARTICIPANT_PROFILE, 'participant_dialogue_v25_generation_cleanup');
  for (const profile of [PILOT012_V24_PARTICIPANT_PROFILE, PILOT012_V25_PARTICIPANT_PROFILE]) {
    assert.equal(isParticipantDialogueProfile(profile), true, profile);
    assert.equal(isPilot012ParticipantDialogueProfile(profile), true, profile);
    assert.equal(hasPostGenerationCheckProfile(profile), true, profile);
    assert.equal(participantMemoryPruneVersion(profile), CLAIM_PRUNE_V3, profile);
  }
  for (const profile of [PILOT012_V22_PARTICIPANT_PROFILE, PILOT012_V23_PARTICIPANT_PROFILE, 'participant_dialogue_v26', undefined, null, '']) {
    assert.equal(hasPostGenerationCheckProfile(profile), false, String(profile));
  }
  assert.equal(isParticipantDialogueProfile('participant_dialogue_v26'), false);
});

for (const [name, dialogueProfile] of [['v24', PILOT012_V24_PARTICIPANT_PROFILE], ['v25', PILOT012_V25_PARTICIPANT_PROFILE]] as const) {
  test(`${name}: a reception plan fixes the check OFF for both orders by default, keeps an explicit ON, and refuses a missing, a stray or a malformed setting`, async () => {
    const protocol: ReceptionProtocolV2 = { schemaVersion: 'reception_protocol_v2', protocolId: '22222222-2222-4222-8222-222222222222',
      revision: 1, allowedOrders: [['repair-first', 'bypass-enabled'], ['bypass-enabled', 'repair-first']], seedPolicy: 'shared', referenceMemory: true,
      betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0' };
    const time = '2026-11-01T00:00:00.000Z';
    const pending = createReception({ receptionId: '11111111-1111-4111-8111-111111111111', objectId: 'a'.repeat(64), createdAt: time, number: null });
    const params: Parameters<typeof approveReception>[1] = { expectedRevision: 0, order: 0, protocol, expected: { protocolId: protocol.protocolId, revision: 1,
      sha256: receptionProtocolSha256(JSON.stringify(protocol)) }, approvedAt: time, randomSeed: () => 211,
      participantModelPin: { schemaVersion: 'participant_model_pin_v3' as const, terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261001' },
      participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE, initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2,
      memoryPruneVersion: CLAIM_PRUNE_V3, participantDialogueProfile: dialogueProfile };
    const plan = (await approveReception(pending, params)).plan;
    const explicit = (await approveReception(pending, { ...params, order: 1, postGenerationCheck: 'on' })).plan;
    assert.ok(plan && plan.schemaVersion === 'reception_plan_v2' && explicit && explicit.schemaVersion === 'reception_plan_v2');
    assert.equal(plan.participantDialogueProfile, dialogueProfile);
    assert.equal(plan.postGenerationCheck, 'off');
    assert.equal(explicit.postGenerationCheck, 'on');
    assert.deepEqual(plan.order, ['repair-first', 'bypass-enabled']);
    assert.deepEqual(explicit.order, ['bypass-enabled', 'repair-first']);
    const { postGenerationCheck, ...missing } = plan;
    assert.throws(() => validateReceptionPlan(missing));
    assert.throws(() => validateReceptionPlan({ ...plan, postGenerationCheck: false }));
    assert.throws(() => validateReceptionPlan({ ...plan, postGenerationCheck: 'maybe' }));
    // An earlier profile never carries the setting, and a v24 reception is not turned into a v25 one (or back) by editing the saved profile.
    const old = (await approveReception(pending, { ...params, participantDialogueProfile: PILOT012_V23_PARTICIPANT_PROFILE })).plan;
    assert.ok(old);
    assert.equal(Object.hasOwn(old, 'postGenerationCheck'), false);
    assert.throws(() => validateReceptionPlan({ ...old, postGenerationCheck }));
    assert.equal(validateReceptionPlan({ ...plan, participantDialogueProfile: dialogueProfile === PILOT012_V24_PARTICIPANT_PROFILE ? PILOT012_V25_PARTICIPANT_PROFILE : PILOT012_V24_PARTICIPANT_PROFILE })
      .participantDialogueProfile !== dialogueProfile, true, 'both profiles validate; the saved one is what runs');
    await assert.rejects(approveReception(pending, { ...params, participantDialogueProfile: PILOT012_V23_PARTICIPANT_PROFILE, postGenerationCheck: 'on' }));
  });
}

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5', 'bypass_acceptance_v3', 'jev_repair_quality_v1');
test('a v25 turn needs the setting (off or on) and a turn of an earlier version refuses one, like v24', async () => {
  const state = () => initialState({ profile, generationRetryVersion: GENERATION_RETRY_V25, agreeNameScopeVersion: 'jev_naming_v3', memo: structuredClone(OLD.state.observationMemo) });
  const events = [{ seq: 1, speaker: 'human' as const, text: '細い部分はどうつながっていますか？' }];
  const choose = (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined;
  const plan = { action: 'accept', target: 'none', speech: '端でつながっています。', choose, aiExtraction: '[]' };
  const technical = { version: 'adaptive_repair_v3' } as const;
  await assert.rejects(runTurn(profile, 'repair-first', state(), events, plan, technical, GENERATION_RETRY_V25), (error: { code?: string }) => error.code === 'invalid_state');
  const off = await runTurn(profile, 'repair-first', state(), events, { ...plan, postGenerationCheck: 'off' }, technical, GENERATION_RETRY_V25);
  assert.equal(off.trace.generationRetryVersion, GENERATION_RETRY_V25);
  assert.equal(off.speech, '端でつながっています。');
  await assert.rejects(runTurn(profile, 'repair-first', initialState({ profile, generationRetryVersion: 'jev_generation_retry_v23', agreeNameScopeVersion: 'jev_naming_v3', memo: structuredClone(OLD.state.observationMemo) }),
    events, { ...plan, postGenerationCheck: 'off' }, technical, 'jev_generation_retry_v23'), (error: { code?: string }) => error.code === 'invalid_state');
});
