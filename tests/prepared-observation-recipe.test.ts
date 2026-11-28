import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createPreparedObservationRecipe, prepareObservationBundle, preparedObservationPoolKey,
  validatePreparedObservationBundle, validatePreparedObservationRecipe,
  type PreparedObservationParticipant, type PreparedObservationRecipe,
} from '../workers/tangram-experiment/src/prepared-observation-recipe.ts';
import {
  approveReception, createReception, effectiveFigureSelection, receptionProtocolSha256,
  type ReceptionProtocolV2, type ReceptionProtocolV3,
} from '../dialogue-model/runtime/v2/reception.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { observationInitialInstructions, type ObservationMessage } from '../dialogue-model/runtime/observation/observe.ts';
import { workerTerraInitialKey, type WorkerTerraCache } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import { ParticipantUsageLedger, type ParticipantUsageSnapshot } from '../dialogue-model/runtime/web/participant-usage.ts';
import type { ParticipantService } from '../workers/tangram-experiment/src/participant-runtime.ts';

const createdAt = '2026-01-01T00:00:00.000Z';
const bundleId = '10000000-0000-4000-8000-000000000001';
const pin = validateParticipantModelPin({ schemaVersion: 'participant_model_pin_v3',
  terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261014' });
const participant: PreparedObservationParticipant = {
  participantModelPin: pin, participantRuntimeProfile: 'participant_production_usage_v1',
  participantDialogueProfile: 'participant_dialogue_v23_prompt_consolidation',
  memoryPruneVersion: 'claim_prune_v3', openingMode: 'scripted_v1',
  initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2,
};
function protocol(extra: Partial<ReceptionProtocolV3> = {}): ReceptionProtocolV3 {
  return { schemaVersion: 'reception_protocol_v3', protocolId: '20000000-0000-4000-8000-000000000001', revision: 1,
    allowedOrders: [['repair-first', 'bypass-enabled'], ['bypass-enabled', 'repair-first']], seedPolicy: 'shared',
    referenceMemory: true, betweenTrials: 'questionnaire_required', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
    figureSelection: { mode: 'preset', setId: 'pilot-four-v1' }, figureSetPolicy: 'shared', ...extra };
}
function recipeInput(protocolValue: ReceptionProtocolV2 | ReceptionProtocolV3 = protocol()) {
  return { protocol: protocolValue, orderIndex: 0, participant, createdAt, bundleId, randomSeed: () => 1234 };
}
function memory() {
  const entries = new Map<string, unknown>();
  const cache: WorkerTerraCache = {
    async read(key) { return structuredClone(entries.get(key)); },
    async putIfAbsent(key, entry) {
      if (!entries.has(key)) entries.set(key, structuredClone(entry));
      return structuredClone(entries.get(key));
    },
  };
  return { entries, cache };
}
async function ledger() {
  let saved: ParticipantUsageSnapshot | undefined;
  return ParticipantUsageLedger.open({
    async read() { return structuredClone(saved); },
    async update(write) { saved = structuredClone(write(saved)); return structuredClone(saved); },
  }, bundleId, pin);
}
type Payload = { purpose: string; messages: ObservationMessage[]; initial_observation_generation?: string };
function proxy(failAt = 0) {
  const calls: Payload[] = [];
  const service: ParticipantService = {
    async participantPolicy() { assert.fail('preparation receives an already verified policy'); },
    async participantChat() { assert.fail('preparation must retain production usage accounting'); },
    async participantChoices() { assert.fail('preparation must not run dialogue decisions'); },
    async participantUsageChat(raw, expected) {
      assert.equal(expected, pin.terraModelId);
      const payload = raw as Payload;
      calls.push(structuredClone(payload));
      assert.equal(payload.purpose, 'visual_observation');
      assert.equal(payload.initial_observation_generation, INITIAL_OBSERVATION_STRUCTURED_V2);
      if (calls.length === failAt) return { status: 502, data: { error: 'invalid_upstream_response' } };
      const { ownAnchors } = JSON.parse(payload.messages[1].content as string) as { ownAnchors: { id: string }[] };
      const figures = ownAnchors.map(({ id }) => ({ id, holistic: [],
        analytic: { shapes: ['三角'], composition: '辺でつながる', relations: [] }, unknowns: [] }));
      return { status: 200, data: { model: pin.terraModelId,
        initial_observation_generation: INITIAL_OBSERVATION_STRUCTURED_V2,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ figures }) } }],
        usage: { cost: 0.01, prompt_tokens: 100, completion_tokens: 50 } } };
    },
  };
  return { service, calls };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function prepare(recipe: PreparedObservationRecipe) {
  const { cache, entries } = memory(), { service, calls } = proxy(), usage = await ledger();
  const bundle = await prepareObservationBundle({ recipe, proxy: service, cache, usage });
  return { recipe, bundle, cache, entries, calls, usage, service };
}

test('recipe retains the existing allocator draws, including per-trial figure-set collision retries', async () => {
  const selected = protocol({ seedPolicy: 'per_trial', figureSetPolicy: 'per_trial',
    figureSelection: { mode: 'seeded_random', selectionSeed: null, figureCount: 4 } });
  const draws = [101, 102, 201, 201, 202];
  let index = 0;
  const recipe = await createPreparedObservationRecipe({ ...recipeInput(selected), randomSeed: () => draws[index++] });
  assert.deepEqual(recipe.randomSeeds, draws);
  assert.deepEqual(recipe.plan.trials.map(trial => trial.seed), [101, 102]);
  assert.equal(recipe.plan.schemaVersion, 'reception_plan_v3');
  assert.deepEqual(recipe.plan.trials.map((_, i) => effectiveFigureSelection(recipe.plan, i).selectionSeed), [201, 202]);
  index = 0;
  const reception = createReception({ receptionId: bundleId, objectId: 'a'.repeat(64), createdAt, number: '001' });
  const approved = await approveReception(reception, { ...participant, expectedRevision: 0, order: 0, protocol: selected,
    expected: { protocolId: selected.protocolId, revision: selected.revision, sha256: receptionProtocolSha256(JSON.stringify(selected)) },
    approvedAt: createdAt, randomSeed: () => draws[index++] });
  assert.deepEqual(recipe.plan, approved.plan);
  assert.deepEqual(await validatePreparedObservationRecipe(recipe), recipe);
});

test('recipe preserves explicit shared selections and v2 legacy six-figure plans', async () => {
  const selected = protocol({ figureSelection: { mode: 'seeded_random', selectionSeed: 42, figureCount: 4 } });
  const shared = await createPreparedObservationRecipe(recipeInput(selected));
  assert.deepEqual(shared.randomSeeds, [1234]);
  assert.deepEqual(shared.plan.trials.map(trial => trial.seed), [1234, 1234]);
  assert.equal(effectiveFigureSelection(shared.plan, 0).selectionSeed, 42);
  assert.deepEqual(effectiveFigureSelection(shared.plan, 0), effectiveFigureSelection(shared.plan, 1));
  const { figureSelection: _selection, figureSetPolicy: _policy, ...base } = selected;
  const legacy = await createPreparedObservationRecipe(recipeInput({ ...base, schemaVersion: 'reception_protocol_v2' }));
  assert.equal(legacy.plan.schemaVersion, 'reception_plan_v2');
  assert.equal(effectiveFigureSelection(legacy.plan, 0).figureIds.length, 6);
  assert.deepEqual(await validatePreparedObservationRecipe(legacy), legacy);
});

test('pool identity ignores property order but isolates protocol and participant conditions', () => {
  const input = recipeInput(), key = preparedObservationPoolKey(input);
  assert.match(key, /^prepared_observation_pool_v1:[a-f0-9]{64}$/u);
  assert.equal(preparedObservationPoolKey({ ...input,
    participant: Object.fromEntries(Object.entries(participant).reverse()),
    protocol: Object.fromEntries(Object.entries(input.protocol).reverse()) as ReceptionProtocolV3 }), key);
  for (const changed of [
    { ...input, orderIndex: 1 },
    { ...input, protocol: protocol({ revision: 2 }) },
    { ...input, protocol: protocol({ rotationMode: 'relative_0' }) },
    { ...input, protocol: protocol({ seedPolicy: 'per_trial' }) },
    { ...input, protocol: protocol({ figureSelection: { mode: 'preset', setId: 'legacy-v1' } }) },
    { ...input, participant: { ...participant, participantModelPin: { ...pin, terraModelId: 'gpt-6.1-terra-2026-11-02' } } },
    { ...input, participant: { ...participant, participantDialogueProfile: 'participant_dialogue_v22_issue_fixes' as const } },
  ]) assert.notEqual(preparedObservationPoolKey(changed), key);
});

test('recipes detach caller data and reject unrecognized or inconsistent settings before any model work', async () => {
  const input = structuredClone({ ...recipeInput(), randomSeed: undefined });
  const recipe = await createPreparedObservationRecipe({ ...input, randomSeed: () => 42 });
  input.protocol.allowedOrders[0].reverse();
  input.participant.participantModelPin!.terraModelId = 'gpt-6.1-terra-2026-11-02';
  assert.deepEqual(recipe.plan.order, ['repair-first', 'bypass-enabled']);
  assert.equal(recipe.participant.participantModelPin!.terraModelId, pin.terraModelId);
  for (const changed of [
    { ...recipeInput(), participant: {} },
    { ...recipeInput(), participant: { ...participant, preparedObservations: {} } },
    { ...recipeInput(), participant: { ...participant, unexpected: true } },
    { ...recipeInput(), participant: { ...participant, initialObservationGeneration: undefined } },
    { ...recipeInput(), protocol: protocol({ referenceMemory: false }) },
    { ...recipeInput(), orderIndex: 99 },
  ]) await assert.rejects(createPreparedObservationRecipe(changed), { code: 'invalid_recipe' });
});

test('stored recipe validates all random draws, full plan and pool identity', async () => {
  const recipe = await createPreparedObservationRecipe(recipeInput());
  const changes: ((value: PreparedObservationRecipe) => void)[] = [
    value => { value.randomSeeds = []; },
    value => { value.randomSeeds.push(99); },
    value => { value.randomSeeds[0]++; },
    value => { value.plan.trials[1].seed++; },
    value => { value.poolKey = 'prepared_observation_pool_v1:' + '0'.repeat(64); },
    value => { value.plan.approvedAt = '2026-01-02T00:00:00.000Z'; },
    value => { value.plan.openingMode = undefined; },
    value => { value.protocol.revision++; },
  ];
  for (const change of changes) {
    const altered = structuredClone(recipe); change(altered);
    await assert.rejects(validatePreparedObservationRecipe(altered), { code: 'invalid_recipe' });
  }
});

test('shared full-board preparation sends the original own image and prompt once and persists a validated memo', async () => {
  const prepared = await prepare(await createPreparedObservationRecipe(recipeInput()));
  const { recipe, bundle, calls, entries, usage, cache, service } = prepared;
  assert.equal(calls.length, 1);
  assert.equal(bundle.entries.length, 1);
  assert.equal(entries.size, 1);
  assert.equal(bundle.entries[0].entry.memo.figures.length, 4);
  const model = modelView(createTrialV2({ seed: 1234, rotationMode: recipe.protocol.rotationMode,
    figureSelection: effectiveFigureSelection(recipe.plan, 0) }));
  const own = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors };
  assert.equal(bundle.entries[0].key, await workerTerraInitialKey(pin, own, INITIAL_OBSERVATION_STRUCTURED_V2));
  assert.deepEqual(JSON.parse(calls[0].messages[1].content as string), {
    ownAnchors: [...own.ownAnchors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  });
  assert.equal(calls[0].messages[0].content, observationInitialInstructions(4, INITIAL_OBSERVATION_STRUCTURED_V2));
  const images = calls[0].messages.flatMap(message => typeof message.content === 'string' ? [] :
    message.content.flatMap(part => part.type === 'image_url' ? [part.image_url.url] : []));
  assert.deepEqual(images.map(hash), [hash('data:image/png;base64,' + own.ownImage.base64)]);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['initial_observation_generation', 'messages', 'purpose']);
  for (const forbidden of ['figureIds', 'protocolId', 'repair-first', 'bypass-enabled', 'human']) {
    assert.ok(!JSON.stringify(calls[0]).includes('"' + forbidden + '"'));
  }
  assert.deepEqual(await validatePreparedObservationBundle(bundle, recipe), bundle);
  assert.equal(usage.snapshot().phases.terra.initial_observation.posts, 1);
  assert.equal(usage.snapshot().phases.terra.initial_observation.knownUsd, 0.01);
  await prepareObservationBundle({ recipe, proxy: service, cache, usage });
  assert.equal(calls.length, 1);
  assert.equal(usage.snapshot().phases.terra.initial_observation.cacheHits, 1);
});

test('per-trial boards prepare every distinct six-figure image before returning a bundle', async () => {
  const { figureSelection: _selection, figureSetPolicy: _policy, ...base } = protocol({ seedPolicy: 'per_trial' });
  let seed = 500;
  const recipe = await createPreparedObservationRecipe({ ...recipeInput({ ...base, schemaVersion: 'reception_protocol_v2' }), randomSeed: () => seed++ });
  const { bundle, calls, usage } = await prepare(recipe);
  assert.equal(calls.length, 2);
  assert.equal(bundle.entries.length, 2);
  assert.notEqual(bundle.entries[0].key, bundle.entries[1].key);
  assert.ok(bundle.entries.every(({ entry }) => entry.memo.figures.length === 6));
  assert.ok(calls.every(call => call.messages[0].content === observationInitialInstructions(6, INITIAL_OBSERVATION_STRUCTURED_V2)));
  assert.equal(usage.snapshot().phases.terra.initial_observation.posts, 2);
  assert.deepEqual(await validatePreparedObservationBundle(bundle, recipe), bundle);
});

test('a failed second observation returns no ready bundle and a deliberate retry reuses the completed memo', async () => {
  let seed = 600;
  const recipe = await createPreparedObservationRecipe({ ...recipeInput(protocol({ seedPolicy: 'per_trial' })), randomSeed: () => seed++ });
  const { cache, entries } = memory(), { service, calls } = proxy(2), usage = await ledger();
  await assert.rejects(prepareObservationBundle({ recipe, proxy: service, cache, usage }), { code: 'invalid_response' });
  assert.equal(calls.length, 2);
  assert.equal(entries.size, 1);
  const complete = await prepareObservationBundle({ recipe, proxy: service, cache, usage });
  assert.equal(complete.entries.length, 2);
  assert.equal(calls.length, 3);
  assert.equal(usage.snapshot().phases.terra.initial_observation.cacheHits, 1);
});

test('a put result without a durable readable entry cannot mark a bundle ready', async () => {
  const recipe = await createPreparedObservationRecipe(recipeInput()), { service } = proxy();
  const cache: WorkerTerraCache = { async read() { return undefined; }, async putIfAbsent(_key, entry) { return entry; } };
  await assert.rejects(prepareObservationBundle({ recipe, proxy: service, cache, usage: await ledger() }), { code: 'invalid_response' });
});

test('ready verification rejects missing, duplicate, foreign and corrupted memos without a model call', async () => {
  let seed = 800;
  const prepared = await prepare(await createPreparedObservationRecipe({ ...recipeInput(protocol({ seedPolicy: 'per_trial' })), randomSeed: () => seed++ }));
  const { recipe, bundle, calls } = prepared;
  const changes: ((value: typeof bundle) => void)[] = [
    value => { value.entries.pop(); },
    value => { value.entries.push(structuredClone(value.entries[0])); },
    value => { value.entries[1] = structuredClone(value.entries[0]); },
    value => { value.entries[0].key = 'terra_initial_observation_v1:' + '0'.repeat(64); },
    value => { value.entries[0].entry.memoSha256 = '0'.repeat(64); },
    value => { value.entries[0].entry.memo.figures[0].region.x++; },
    value => { value.plan.trials[0].seed++; },
    value => { value.randomSeeds.push(1000); },
    value => { value.preparedAt = '2025-12-31T23:59:59.999Z'; },
    value => { value.bundleId = '10000000-0000-4000-8000-000000000002'; },
  ];
  for (const change of changes) {
    const altered = structuredClone(bundle); change(altered);
    await assert.rejects(validatePreparedObservationBundle(altered, recipe), { code: 'invalid_bundle' });
  }
  assert.equal(calls.length, 2);
});
