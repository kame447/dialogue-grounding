import { createHash } from 'node:crypto';
import {
  approveReception, createReception, effectiveFigureSelection, effectiveRotationMode, receptionProtocolSha256,
  validateReceptionPlan, validateReceptionProtocolV2, validateReceptionProtocolV3,
} from '../../../dialogue-model/runtime/v2/reception.ts';
import type {
  ParticipantPlanSettings, ReceptionPlanV2, ReceptionPlanV3, ReceptionProtocolV2, ReceptionProtocolV3,
} from '../../../dialogue-model/runtime/v2/reception.ts';
import { data } from '../../../dialogue-model/runtime/v2/base-assignment-data.ts';
import { createTrialV2, modelView } from '../../../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { FIGURE_BANK_VERSION } from '../../../dialogue-model/runtime/stimuli/figure-bank.ts';
import { OBSERVATION_MEMO_VERSION, observationInitialInstructions } from '../../../dialogue-model/runtime/observation/observe.ts';
import {
  validateWorkerTerraCacheEntry, workerTerraInitialKey,
  type WorkerTerraCache, type WorkerTerraCacheEntry,
} from '../../../dialogue-model/runtime/observation/worker-terra-observer.ts';
import type { ObservationInput } from '../../../dialogue-model/runtime/observation/contract.ts';
import type { ParticipantUsageLedger } from '../../../dialogue-model/runtime/web/participant-usage.ts';
import { createParticipantTerraObserver, type ParticipantService } from './participant-runtime.ts';

export type PreparedObservationParticipant = Omit<ParticipantPlanSettings, 'preparedObservations'>;
export type PreparedObservationRequest = {
  protocol: ReceptionProtocolV2 | ReceptionProtocolV3;
  orderIndex: number;
  participant: PreparedObservationParticipant;
};
export type PreparedObservationRecipe = PreparedObservationRequest & {
  schemaVersion: 'prepared_observation_recipe_v1';
  poolKey: string;
  bundleId: string;
  createdAt: string;
  randomSeeds: number[];
  plan: ReceptionPlanV2 | ReceptionPlanV3;
};
export type PreparedObservationBundle = {
  poolKey: string;
  bundleId: string;
  preparedAt: string;
  randomSeeds: number[];
  plan: ReceptionPlanV2 | ReceptionPlanV3;
  entries: { key: string; entry: WorkerTerraCacheEntry }[];
};
export class PreparedObservationError extends Error {
  readonly code: 'invalid_recipe' | 'invalid_bundle';
  constructor(code: 'invalid_recipe' | 'invalid_bundle') {
    super(code); this.name = 'PreparedObservationError'; this.code = code;
  }
}

const RECIPE_SCHEMA = 'prepared_observation_recipe_v1';
const POOL_SCHEMA = 'prepared_observation_pool_v1';
const RECIPE_KEYS = ['schemaVersion', 'poolKey', 'bundleId', 'createdAt', 'protocol', 'orderIndex', 'participant', 'randomSeeds', 'plan'];
const PLAN_KEYS = ['schemaVersion', 'protocolId', 'protocolRevision', 'protocolSha256', 'order', 'betweenTrials', 'approvedAt', 'trials'];
const BUNDLE_KEYS = ['poolKey', 'bundleId', 'preparedAt', 'randomSeeds', 'plan', 'entries'];
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';
const PLACEHOLDER_DATE = '2000-01-01T00:00:00.000Z';
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = (code: 'invalid_recipe' | 'invalid_bundle' = 'invalid_recipe'): never => { throw new PreparedObservationError(code); };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const fields = data(value);
    return '{' + Object.keys(fields).sort().map(key => JSON.stringify(key) + ':' + canonical(fields[key])).join(',') + '}';
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
      typeof value === 'number' && !Number.isFinite(value)) return fail();
  return JSON.stringify(value);
}

function request(value: PreparedObservationRequest): PreparedObservationRequest {
  const protocol = value.protocol?.schemaVersion === 'reception_protocol_v3'
    ? validateReceptionProtocolV3(value.protocol) : validateReceptionProtocolV2(value.protocol);
  const orderIndex = value.orderIndex;
  if (!Number.isSafeInteger(orderIndex) || orderIndex < 0 || !protocol.allowedOrders[orderIndex] || !protocol.referenceMemory) return fail();
  const supplied = data(value.participant);
  // Reuse the plan's participant validation, including relationships between pin,
  // profile, generation and pruning versions. Unknown participant fields fail too.
  const checked = validateReceptionPlan({ ...supplied,
    schemaVersion: 'reception_plan_v2', protocolId: protocol.protocolId, protocolRevision: protocol.revision,
    protocolSha256: receptionProtocolSha256(JSON.stringify(protocol)), order: protocol.allowedOrders[orderIndex],
    betweenTrials: protocol.betweenTrials, approvedAt: PLACEHOLDER_DATE,
    trials: protocol.allowedOrders[orderIndex].map((strategy, index) => ({ index, strategy, seed: 0,
      referenceMemory: protocol.referenceMemory, rotationMode: protocol.rotationMode })),
  });
  const participant = Object.fromEntries(Object.entries(checked).filter(([key]) => !PLAN_KEYS.includes(key))) as PreparedObservationParticipant;
  if (!participant.participantModelPin || Object.hasOwn(supplied, 'preparedObservations') || canonical(supplied) !== canonical(participant)) return fail();
  return { protocol, orderIndex, participant };
}

/** Storage identity includes the current instructions, never image or memo text. */
export function preparedObservationPoolKey(value: PreparedObservationRequest): string {
  try {
    const checked = request(value);
    const generation = checked.participant.initialObservationGeneration;
    return POOL_SCHEMA + ':' + sha256(canonical({ ...checked, schemaVersion: POOL_SCHEMA,
      figureBankVersion: FIGURE_BANK_VERSION, observationMemoVersion: OBSERVATION_MEMO_VERSION,
      initialInstructionsSha256: [4, 6].map(count => sha256(observationInitialInstructions(count, generation))),
    }));
  } catch { return fail(); }
}

async function planned(checked: PreparedObservationRequest, createdAt: string, randomSeed: () => number) {
  const { protocol, orderIndex, participant } = checked;
  const reception = createReception({ receptionId: PLACEHOLDER_ID, objectId: '0'.repeat(64), createdAt, number: null });
  const approved = await approveReception(reception, { ...participant,
    expectedRevision: 0, order: orderIndex, protocol,
    expected: { protocolId: protocol.protocolId, revision: protocol.revision, sha256: receptionProtocolSha256(JSON.stringify(protocol)) },
    approvedAt: createdAt, randomSeed,
  });
  if (!approved.plan || approved.plan.schemaVersion === 'reception_plan_v1') return fail();
  return approved.plan;
}

/** Record all draws from the existing allocator, including figure-set collision retries. */
export async function createPreparedObservationRecipe(value: PreparedObservationRequest & {
  createdAt: string; randomSeed?: () => number; bundleId?: string;
}): Promise<PreparedObservationRecipe> {
  try {
    const checked = request(value), bundleId = value.bundleId ?? crypto.randomUUID();
    if (!iso(value.createdAt) || !uuid(bundleId)) return fail();
    const source = value.randomSeed ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]);
    const randomSeeds: number[] = [];
    const plan = await planned(checked, value.createdAt, () => {
      const seed = source();
      if (!Number.isSafeInteger(seed)) return fail();
      randomSeeds.push(seed);
      return seed;
    });
    return { schemaVersion: RECIPE_SCHEMA, poolKey: preparedObservationPoolKey(checked), bundleId,
      createdAt: value.createdAt, ...checked, randomSeeds, plan };
  } catch { return fail(); }
}

export async function validatePreparedObservationRecipe(value: unknown): Promise<PreparedObservationRecipe> {
  try {
    const raw = data(value, RECIPE_KEYS);
    if (raw.schemaVersion !== RECIPE_SCHEMA || !uuid(raw.bundleId) || !iso(raw.createdAt) ||
        !Array.isArray(raw.randomSeeds) || !raw.randomSeeds.length || !raw.randomSeeds.every(Number.isSafeInteger)) return fail();
    const checked = request(raw as unknown as PreparedObservationRequest);
    const poolKey = preparedObservationPoolKey(checked);
    if (raw.poolKey !== poolKey) return fail();
    const randomSeeds = [...raw.randomSeeds] as number[];
    let index = 0;
    const plan = await planned(checked, raw.createdAt, () => {
      if (index >= randomSeeds.length) return fail();
      return randomSeeds[index++];
    });
    const stored = validateReceptionPlan(raw.plan);
    if (index !== randomSeeds.length || canonical(plan) !== canonical(stored)) return fail();
    return { schemaVersion: RECIPE_SCHEMA, poolKey, bundleId: raw.bundleId, createdAt: raw.createdAt,
      ...checked, randomSeeds, plan };
  } catch { return fail(); }
}

type Board = { key: string; own: ObservationInput };
async function observationBoards(recipe: PreparedObservationRecipe): Promise<Board[]> {
  const boards = new Map<string, Board>();
  const material = new Set<string>();
  for (const trial of recipe.plan.trials) {
    const rotationMode = effectiveRotationMode(recipe.plan, trial.index);
    const figureSelection = effectiveFigureSelection(recipe.plan, trial.index);
    const identity = canonical({ seed: trial.seed, rotationMode, figureSelection });
    if (material.has(identity)) continue;
    material.add(identity);
    const model = modelView(createTrialV2({ seed: trial.seed, rotationMode, figureSelection }));
    const own: ObservationInput = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors };
    const key = await workerTerraInitialKey(recipe.participant.participantModelPin!, own, recipe.participant.initialObservationGeneration);
    boards.set(key, { key, own });
  }
  return [...boards.values()];
}

/** A bundle is ready only when every distinct full-board memo is persisted and validated. */
export async function prepareObservationBundle({ recipe: source, proxy, cache, usage }: {
  recipe: PreparedObservationRecipe; proxy: ParticipantService; cache: WorkerTerraCache; usage: ParticipantUsageLedger;
}): Promise<PreparedObservationBundle> {
  const recipe = await validatePreparedObservationRecipe(source);
  const entries: PreparedObservationBundle['entries'] = [];
  const pin = recipe.participant.participantModelPin!;
  if (canonical(usage.snapshot().pin) !== canonical(pin)) return fail('invalid_bundle');
  for (const { key, own } of await observationBoards(recipe)) {
    const initialObservationGeneration = recipe.participant.initialObservationGeneration;
    const observer = createParticipantTerraObserver({ pin, own, proxy, cache, usage, initialObservationGeneration });
    await observer.observeAll(own);
    const entry = await validateWorkerTerraCacheEntry(await cache.read(key), { modelPin: pin, own, key, initialObservationGeneration });
    entries.push({ key, entry });
  }
  return { poolKey: recipe.poolKey, bundleId: recipe.bundleId, preparedAt: new Date().toISOString(),
    randomSeeds: recipe.randomSeeds, plan: recipe.plan, entries };
}

/** Read-only verification; a missing or stale memo can never start a live observation. */
export async function validatePreparedObservationBundle(value: unknown, source: PreparedObservationRecipe): Promise<PreparedObservationBundle> {
  try {
    const recipe = await validatePreparedObservationRecipe(source);
    const raw = data(value, BUNDLE_KEYS);
    if (raw.poolKey !== recipe.poolKey || raw.bundleId !== recipe.bundleId || !iso(raw.preparedAt) ||
        Date.parse(raw.preparedAt) < Date.parse(recipe.createdAt) || canonical(raw.randomSeeds) !== canonical(recipe.randomSeeds) ||
        canonical(validateReceptionPlan(raw.plan)) !== canonical(recipe.plan) || !Array.isArray(raw.entries)) return fail('invalid_bundle');
    const boards = await observationBoards(recipe);
    if (raw.entries.length !== boards.length) return fail('invalid_bundle');
    const saved = new Map<string, unknown>();
    for (const item of raw.entries) {
      const entry = data(item, ['key', 'entry']);
      if (typeof entry.key !== 'string' || saved.has(entry.key)) return fail('invalid_bundle');
      saved.set(entry.key, entry.entry);
    }
    const entries: PreparedObservationBundle['entries'] = [];
    for (const { key, own } of boards) {
      if (!saved.has(key)) return fail('invalid_bundle');
      const entry = await validateWorkerTerraCacheEntry(saved.get(key), {
        modelPin: recipe.participant.participantModelPin!, own, key,
        initialObservationGeneration: recipe.participant.initialObservationGeneration,
      });
      entries.push({ key, entry });
    }
    return { poolKey: recipe.poolKey, bundleId: recipe.bundleId, preparedAt: raw.preparedAt,
      randomSeeds: recipe.randomSeeds, plan: recipe.plan, entries };
  } catch { return fail('invalid_bundle'); }
}
