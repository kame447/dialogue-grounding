// #269 relative_90_180_270 at the reception boundary: the saved protocol, the frozen plan and the prepared-observation pool.
// Synthetic material only. The earlier modes' pool keys are pinned to values computed from the base commit 620ef5c, before the new mode
// existed; like the stimulus pins, never regenerate them from the current implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPreparedObservationRecipe, prepareObservationBundle, preparedObservationPoolKey,
  validatePreparedObservationBundle, validatePreparedObservationRecipe, type PreparedObservationParticipant,
} from '../workers/tangram-experiment/src/prepared-observation-recipe.ts';
import {
  effectiveFigureSelection, effectiveRotationMode, ROTATION_MODES, validateReceptionPlan, validateReceptionProtocolV2, validateReceptionProtocolV3,
  type ReceptionProtocolV2, type ReceptionProtocolV3,
} from '../dialogue-model/runtime/v2/reception.ts';
import { createLayoutsV2, createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import type { ObservationMessage } from '../dialogue-model/runtime/observation/observe.ts';
import type { WorkerTerraCache } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import { ParticipantUsageLedger, type ParticipantUsageSnapshot } from '../dialogue-model/runtime/web/participant-usage.ts';
import type { ParticipantService } from '../workers/tangram-experiment/src/participant-runtime.ts';

const NEW = 'relative_90_180_270';
const createdAt = '2026-01-01T00:00:00.000Z';
const bundleId = '10000000-0000-4000-8000-000000000001';
const otherProtocolId = '30000000-0000-4000-8000-000000000001';
const THREE = { mode: 'custom', figureIds: ['F2', 'F17', 'F30'] } as const;
const SIX = { mode: 'preset', setId: 'legacy-v1' } as const;
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
function proxy() {
  const calls: Payload[] = [];
  const service: ParticipantService = {
    async participantPolicy() { assert.fail('preparation receives an already verified policy'); },
    async participantChat() { assert.fail('preparation must retain production usage accounting'); },
    async participantChoices() { assert.fail('preparation must not run dialogue decisions'); },
    async participantUsageChat(raw, expected) {
      assert.equal(expected, pin.terraModelId);
      const payload = raw as Payload;
      calls.push(structuredClone(payload));
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

const turnsOf = (seed: number, figureSelection: unknown) => {
  const layouts = createLayoutsV2({ seed, rotationMode: NEW, figureSelection });
  return layouts.human.map((h: any) => (layouts.ai.find((a: any) => a.figureId === h.figureId).rotation - h.rotation + 360) % 360).sort((a: number, b: number) => a - b);
};
/** A seed chosen from the turns it realizes: each of 90, 180 and 270 occurs once on the three figures. */
const SEED = (() => { for (let seed = 0; ; seed++) if (turnsOf(seed, THREE).join() === '90,180,270') return seed; })();

const BASE_POOL_KEYS = {
  four_pm90: 'prepared_observation_pool_v1:b572de5b6b1d24055bde27ef38cdf24c2d3358f629fc5a421a2807fc86b08dd3',
  four_rel0: 'prepared_observation_pool_v1:f0af8fb5225b07d5406b138c07b67f2b064eeedee55aa95da585ab4470e35855',
  three_pm90: 'prepared_observation_pool_v1:e8d3a9b1006e73a9fc9b94c7265ed660db0c25bf6cca27e07a6e445b3ecf22e8',
  three_rel0: 'prepared_observation_pool_v1:0d50b87067421e119b8232a7ad3e04ce97e63dac8ee6a6b96d658096f153bb49',
  six_pm90: 'prepared_observation_pool_v1:a84a79636d8d16ebca1fa70794b9562a89689b3e6786e68fd8c2ac40b620c6a7',
  six_rel0: 'prepared_observation_pool_v1:6f440e82f07d4dee98fe9fba70441ee9af981f92d02b26f50326d8a1215ad5e5',
  six_seeded_pm90: 'prepared_observation_pool_v1:6de1d521d2a4aac69c2a88ad68b08b07db786c20738e0e634f01f7a12b8dcdcc',
};

test('a protocol carries relative_90_180_270, it is frozen into the plan of every trial, and near-miss names are refused', async () => {
  assert.deepEqual(ROTATION_MODES, ['relative_pm90', 'relative_0', NEW]);
  const v3 = protocol({ rotationMode: NEW });
  const { figureSelection: _selection, figureSetPolicy: _policy, ...rest } = v3;
  const v2 = { ...rest, schemaVersion: 'reception_protocol_v2' } as ReceptionProtocolV2;
  assert.equal(validateReceptionProtocolV3(v3).rotationMode, NEW);
  assert.equal(validateReceptionProtocolV2(v2).rotationMode, NEW);
  const misses = ['relative_90_180', 'relative_180', 'RELATIVE_90_180_270', 'relative_90_180_270 ', '', null, undefined, [NEW]];
  for (const bad of misses) {
    assert.throws(() => validateReceptionProtocolV3({ ...v3, rotationMode: bad }), { code: 'protocol_unconfigured' }, JSON.stringify(bad));
    assert.throws(() => validateReceptionProtocolV2({ ...v2, rotationMode: bad }), { code: 'protocol_unconfigured' }, JSON.stringify(bad));
  }
  for (const [label, selected] of [['v3 three figures', protocol({ rotationMode: NEW, figureSelection: THREE })], ['v2 legacy six figures', v2]] as const) {
    const recipe = await createPreparedObservationRecipe(recipeInput(selected));
    assert.ok(recipe.plan.trials.length > 0 && recipe.plan.trials.every(trial => trial.rotationMode === NEW), label);
    recipe.plan.trials.forEach((_, index) => assert.equal(effectiveRotationMode(recipe.plan, index), NEW, label));
    const saved = JSON.parse(JSON.stringify(recipe.plan));
    assert.deepEqual(validateReceptionPlan(saved), recipe.plan, label);
    assert.deepEqual(await validatePreparedObservationRecipe(recipe), recipe, label);
    for (const bad of misses) {
      const altered = structuredClone(saved);
      altered.trials[0].rotationMode = bad;
      assert.throws(() => validateReceptionPlan(altered), { code: 'reception_unavailable' }, `${label} ${JSON.stringify(bad)}`);
    }
  }
});

test('pool keys: the earlier modes keep theirs, the new mode has its own, three figures are reused across revisions and protocol ids, four and six are not', () => {
  const keyFor = (options: Partial<ReceptionProtocolV3>) => preparedObservationPoolKey({ ...recipeInput(), protocol: protocol(options) });
  assert.deepEqual({
    four_pm90: keyFor({}), four_rel0: keyFor({ rotationMode: 'relative_0' }),
    three_pm90: keyFor({ figureSelection: THREE }), three_rel0: keyFor({ figureSelection: THREE, rotationMode: 'relative_0' }),
    six_pm90: keyFor({ figureSelection: SIX }), six_rel0: keyFor({ figureSelection: SIX, rotationMode: 'relative_0' }),
    six_seeded_pm90: keyFor({ figureSelection: { mode: 'seeded_random', selectionSeed: null } }),
  }, BASE_POOL_KEYS);
  const next = { four: keyFor({ rotationMode: NEW }), three: keyFor({ rotationMode: NEW, figureSelection: THREE }), six: keyFor({ rotationMode: NEW, figureSelection: SIX }) };
  assert.match(next.three, /^prepared_observation_pool_v1:[a-f0-9]{64}$/u);
  // Neither earlier mode's stock is ever offered to the new mode, whatever the figure set.
  assert.equal(new Set([...Object.values(BASE_POOL_KEYS), ...Object.values(next)]).size, Object.keys(BASE_POOL_KEYS).length + 3);
  // Three-figure stock follows the frozen figure values only; four and six figures also follow the protocol's identity.
  assert.equal(keyFor({ rotationMode: NEW, figureSelection: THREE, revision: 2, protocolId: otherProtocolId }), next.three);
  assert.equal(keyFor({ rotationMode: NEW, figureSelection: { ...THREE, figureIds: ['F30', 'F2', 'F17'] }, revision: 3 }), next.three);
  assert.notEqual(keyFor({ rotationMode: NEW, revision: 2 }), next.four);
  assert.notEqual(keyFor({ rotationMode: NEW, figureSelection: SIX, revision: 2 }), next.six);
  assert.notEqual(keyFor({ rotationMode: NEW, figureSelection: { ...THREE, figureIds: ['F2', 'F17', 'F29'] } }), next.three);
});

test('the recipe prepares the AI-side board of the new mode, and a later revision reuses the three-figure memo with no new model request', async () => {
  const input = (extra: Partial<ReceptionProtocolV3>) => ({ ...recipeInput(protocol({ rotationMode: NEW, figureSelection: THREE, ...extra })), randomSeed: () => SEED });
  const first = await createPreparedObservationRecipe(input({}));
  assert.deepEqual(first.plan.trials.map(trial => trial.seed), [SEED, SEED]);
  const { cache } = memory(), { service, calls } = proxy(), usage = await ledger();
  const bundle = await prepareObservationBundle({ recipe: first, proxy: service, cache, usage });
  assert.equal(calls.length, 1);
  assert.equal(bundle.entries.length, 1);
  const boardOf = (rotationMode: string) => 'data:image/png;base64,' + modelView(createTrialV2({ seed: SEED, rotationMode,
    figureSelection: effectiveFigureSelection(first.plan, 0) })).png.toString('base64');
  const images = calls[0].messages.flatMap(message => typeof message.content === 'string' ? [] :
    message.content.flatMap(part => part.type === 'image_url' ? [part.image_url.url] : []));
  assert.deepEqual(images, [boardOf(NEW)]);
  // The seed realizes all three turns, so it is neither earlier mode's board.
  for (const other of ['relative_pm90', 'relative_0']) assert.notEqual(images[0], boardOf(other), other);
  // Another revision and protocol id of the same three figures finds the memo already stored and asks the model nothing.
  const second = await createPreparedObservationRecipe(input({ revision: 2, protocolId: otherProtocolId }));
  assert.equal(second.poolKey, first.poolKey);
  const reused = await prepareObservationBundle({ recipe: second, proxy: service, cache, usage });
  assert.equal(calls.length, 1);
  assert.deepEqual(reused.entries.map(({ key }) => key), bundle.entries.map(({ key }) => key));
  assert.deepEqual(await validatePreparedObservationBundle(reused, second), reused);
  assert.equal(usage.snapshot().phases.terra.initial_observation.posts, 1);
  assert.equal(usage.snapshot().phases.terra.initial_observation.cacheHits, 1);
});
