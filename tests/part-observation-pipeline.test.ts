import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrialV2, modelView, participantView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { PART_GEOMETRY_VERSION } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import {
  approveReception, canonicalReceptionProtocolV3, createReception, receptionProtocolSha256, validateReceptionPlan,
} from '../dialogue-model/runtime/v2/reception.ts';
import type { ReceptionPlanV3 } from '../dialogue-model/runtime/v2/reception.ts';
import { assignmentPartObservationVersion, validateBoundBaseRecord } from '../dialogue-model/runtime/v2/base-assignment-data.ts';
import { createBaseAssignmentSession } from '../dialogue-model/runtime/v2/base-assignment-session.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { SCRIPTED_OPENING_MODE } from '../dialogue-model/runtime/v2/opening-mode.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { workerTerraInitialKey } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import { validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';
import type { ObservationInput, ObservationMemo } from '../dialogue-model/runtime/observation/contract.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { ParticipantUsageLedger } from '../dialogue-model/runtime/web/participant-usage.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';
import { ParticipantPreobservations } from '../workers/tangram-experiment/src/participant-preobservation.ts';
import { createWorkerParticipantRuntime } from '../workers/tangram-experiment/src/participant-runtime.ts';
import type { ParticipantService } from '../workers/tangram-experiment/src/participant-runtime.ts';
import { harness } from './support/s5-base/support.ts';

const approvedAt = '2026-11-28T00:00:00.000Z';
const receptionId = '11111111-1111-4111-8111-111111111111';
const pin = validateParticipantModelPin({
  schemaVersion: 'participant_model_pin_v3', terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261001',
});
async function approvedPlan(count: 4 | 6, enabled = true): Promise<ReceptionPlanV3> {
  const protocol = {
    schemaVersion: 'reception_protocol_v3', protocolId: '22222222-2222-4222-8222-222222222222', revision: 1,
    allowedOrders: [['bypass-enabled', 'repair-first']], seedPolicy: 'shared', referenceMemory: true,
    betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
    figureSelection: { mode: 'preset', setId: count === 4 ? 'pilot-four-v1' : 'legacy-v1' }, figureSetPolicy: 'shared',
  };
  const expected = { protocolId: protocol.protocolId, revision: protocol.revision,
    sha256: receptionProtocolSha256(canonicalReceptionProtocolV3(protocol)) };
  const pending = createReception({ receptionId, objectId: 'a'.repeat(64), createdAt: approvedAt, number: null });
  const result = await approveReception(pending, {
    expectedRevision: 0, order: 0, protocol, expected, approvedAt, randomSeed: () => 41,
    participantModelPin: pin, participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE,
    initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2, openingMode: SCRIPTED_OPENING_MODE,
    ...(enabled ? { partObservationVersion: PART_GEOMETRY_VERSION } : {}),
  });
  return result.plan as ReceptionPlanV3;
}

type Transaction = {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put(values: Record<string, unknown>): Promise<void>;
};
function memory() {
  let entries = new Map<string, unknown>(), pending: Promise<unknown> = Promise.resolve();
  const view = (state: Map<string, unknown>): Transaction => ({
    async get<T>(key: string) { return structuredClone(state.get(key)) as T | undefined; },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...state].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]));
    },
    async put(values: Record<string, unknown>) { for (const [key, value] of Object.entries(values)) state.set(key, structuredClone(value)); },
  });
  return {
    get<T>(key: string) { return view(entries).get<T>(key); },
    transaction<T>(write: (tx: Transaction) => Promise<T>): Promise<T> {
      const next = pending.then(async () => {
        const staged = structuredClone(entries), result = await write(view(staged));
        entries = staged; return result;
      });
      pending = next.catch(() => {});
      return next;
    },
  };
}

function materials(plan: ReceptionPlanV3, index = 0) {
  const trial = createTrialV2(plan.trials[index]);
  const model = modelView(trial, { partObservationVersion: plan.partObservationVersion } as any);
  const own: ObservationInput = {
    ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors,
    ...(model.parts ? { ownParts: model.parts } : {}),
  };
  return { trial, own };
}

function observationProxy() {
  const calls: any[] = [];
  const chat = async (input: unknown, expected: string) => {
    const body = input as any;
    assert.equal(body.purpose, 'visual_observation', 'the scripted opening requires no dialogue or decision call');
    assert.equal(body.initial_observation_generation, INITIAL_OBSERVATION_STRUCTURED_V2);
    calls.push(structuredClone(body));
    const ownAnchors = JSON.parse(body.messages[1].content).ownAnchors as { id: string }[];
    return { status: 200, data: {
      model: expected, initial_observation_generation: INITIAL_OBSERVATION_STRUCTURED_V2,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ figures: ownAnchors.map(({ id }) => ({
        id, holistic: [], analytic: { shapes: [], composition: '複数の部分がつながる形', relations: [] }, unknowns: [],
      })) }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
    } };
  };
  const proxy: ParticipantService = {
    async participantPolicy() { return pin; }, participantChat: chat, participantUsageChat: chat,
    async participantChoices() { throw new Error('unexpected decision'); },
    async participantUsageChoices() { throw new Error('unexpected decision'); },
  };
  return { proxy, calls };
}

async function warm(plan: ReceptionPlanV3) {
  const storage = memory(), preobservations = new ParticipantPreobservations(storage), { proxy, calls } = observationProxy();
  const { own } = materials(plan);
  const key = await workerTerraInitialKey(pin, own, plan.initialObservationGeneration);
  await preobservations.schedule({ key, own, trialIndices: [0, 1] }, { pin, proxy,
    initialObservationGeneration: plan.initialObservationGeneration });
  const saved = await storage.get<{ memo: ObservationMemo }>(key);
  assert.ok(saved, 'preobservation must persist its memo');
  assert.equal(calls.length, 1);
  return { own, key, saved: saved.memo, storage, preobservations, proxy, calls };
}

function sessionFixture(plan: ReceptionPlanV3, index: number, warmed: Awaited<ReturnType<typeof warm>>) {
  const h = harness({ adapter: 'worker_binding' });
  const bindings: any[] = [];
  let usageSnapshot: unknown;
  h.options.makeTask = async (input: any) => {
    bindings.push(input);
    const selected = input.restore?.options.figureSelection ?? input.figureSelection;
    const rotationMode = input.restore?.options.rotationMode ?? input.rotationMode;
    const trial = createTrialV2({ seed: input.seed, rotationMode, figureSelection: selected });
    const model = modelView(trial, { partObservationVersion: input.partObservationVersion } as any);
    const own: ObservationInput = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') },
      ownAnchors: model.anchors, ...(model.parts ? { ownParts: model.parts } : {}) };
    assert.deepEqual(own, warmed.own, 'approval and task start/restore must project exactly the same own material');
    const usage = await ParticipantUsageLedger.open({
      async read() { return usageSnapshot; },
      async update(write) { usageSnapshot = write(usageSnapshot); return usageSnapshot as ReturnType<typeof write>; },
    }, input.participantRuntime.assignmentId, pin, input.restore?.jevLedger);
    const runtime = createWorkerParticipantRuntime({ pin, own, proxy: warmed.proxy, cache: warmed.preobservations.startCache,
      usage, initialObservationGeneration: input.initialObservationGeneration });
    return createNamingTaskV2({
      ...runtime, seed: input.seed, strategy: input.strategy, referenceMemory: input.referenceMemory,
      openingMode: input.openingMode, partObservationVersion: input.partObservationVersion,
      rotationMode, figureSelection: selected, createTrial: () => trial, runDir: null,
      utteranceStyle: runtime.jevResearch.profile.utteranceStyle, now: () => Date.parse(approvedAt),
      restore: input.restore,
      onPersist: async (snapshot: any) => input.onPersist({ ...snapshot, options: { ...snapshot.options,
        participantModelPin: pin, participantRuntimeProfile: input.participantRuntime.profile,
        initialObservationGeneration: input.initialObservationGeneration } }),
    } as Parameters<typeof createNamingTaskV2>[0]);
  };
  const make = (restore = false) => createBaseAssignmentSession({
    ...h.options,
    readPlan: async () => {
      if (restore) throw new Error('restoration must use its saved assignment');
      return { receptionId, plan, trialIndex: index };
    },
  } as unknown as Parameters<typeof createBaseAssignmentSession>[0]);
  return { h, bindings, make };
}

test('parts version is explicitly frozen in approved plans; legacy plans preserve absence and invalid bindings reject', async () => {
  for (const count of [4, 6] as const) {
    const plan = await approvedPlan(count), old = await approvedPlan(count, false);
    const frozen = validateReceptionPlan(plan);
    assert.ok(frozen.schemaVersion === 'reception_plan_v3');
    assert.equal(frozen.partObservationVersion, PART_GEOMETRY_VERSION);
    assert.equal(Object.hasOwn(validateReceptionPlan(old), 'partObservationVersion'), false);
    for (const mutation of [
      (value: any) => { value.partObservationVersion = 'tangram_parts_v999'; },
      (value: any) => { delete value.participantModelPin; },
      (value: any) => { delete value.participantRuntimeProfile; },
    ]) {
      const invalid = structuredClone(plan); mutation(invalid);
      assert.throws(() => validateReceptionPlan(invalid));
    }
    assert.equal(plan.trials[0].figureSelection.figureIds.length, count);
  }
});

for (const count of [4, 6] as const) test(`${count} figures retain every part through preobservation, both strategies, persistence and restore`, async () => {
  const plan = await approvedPlan(count), warmed = await warm(plan);
  for (const index of [0, 1]) {
    const fixture = sessionFixture(plan, index, warmed);
    await fixture.make().start({ version: 2 });
    const saved = fixture.h.state.admissions.initial.record;
    assert.equal(assignmentPartObservationVersion(saved.assignment), PART_GEOMETRY_VERSION);
    assert.equal(saved.options.partObservationVersion, PART_GEOMETRY_VERSION);
    assert.deepEqual(saved.queueState.privateState.observationMemo, warmed.saved);
    assert.equal(saved.queueState.privateState.observationMemo.figures.length, count);
    validateBoundBaseRecord(saved, saved.assignment);
    for (const row of warmed.own.ownParts!) {
      assert.deepEqual(saved.queueState.privateState.observationMemo.figures.find((figure: any) => figure.id === row.id).parts, row.parts);
    }
    const restored = await fixture.make(true).restore();
    assert.equal(restored.kind, 'restored');
    await restored.task!.persistNow();
    assert.deepEqual(fixture.h.state.admissions.initial.record.queueState.privateState.observationMemo, warmed.saved);
    assert.equal(fixture.bindings.at(-1).partObservationVersion, PART_GEOMETRY_VERSION);
    const mismatched = structuredClone(saved);
    delete mismatched.options.partObservationVersion;
    assert.throws(() => validateBoundBaseRecord(mismatched, saved.assignment), { code: 'assignment_record_invalid' });
    mismatched.options.partObservationVersion = 'tangram_parts_v999';
    assert.throws(() => validateBoundBaseRecord(mismatched, saved.assignment), { code: 'assignment_record_invalid' });
  }
  assert.equal(warmed.calls.length, 1, 'both strategies and restores must reuse the same initial observation');
});

test('legacy trials remain parts-free on start and restore and refuse a newly injected parts version', async () => {
  const plan = await approvedPlan(4, false), warmed = await warm(plan), fixture = sessionFixture(plan, 0, warmed);
  await fixture.make().start({ version: 2 });
  const before = fixture.h.state.admissions.initial.record;
  assert.equal(Object.hasOwn(before.options, 'partObservationVersion'), false);
  assert.ok(before.queueState.privateState.observationMemo.figures.every((figure: any) => !Object.hasOwn(figure, 'parts')));
  await fixture.make(true).restore();
  const after = fixture.h.state.admissions.initial.record;
  assert.deepEqual(after.queueState.privateState.observationMemo, before.queueState.privateState.observationMemo);
  const changed = structuredClone(after); changed.options.partObservationVersion = PART_GEOMETRY_VERSION;
  assert.throws(() => validateBoundBaseRecord(changed, after.assignment), { code: 'assignment_record_invalid' });
  assert.equal(warmed.calls.length, 1);
});

test('own part projection never exposes opposing identifiers, correspondence, source figure IDs or participant labels', async () => {
  const plan = await approvedPlan(4), { trial, own } = materials(plan);
  const text = JSON.stringify({ ownAnchors: own.ownAnchors, ownParts: own.ownParts });
  const human = participantView(trial);
  for (const shape of human.shapes) assert.ok(!text.includes(shape.id));
  assert.doesNotMatch(text, /"figureId"|"F[0-9]+"|"key"|"human"|"seed"|"rotation"|"name"/u);
  assert.equal(Object.hasOwn(human, 'parts'), false);
  assert.equal(Object.hasOwn(modelView(trial), 'parts'), false);
  assert.throws(() => modelView(structuredClone(trial), { partObservationVersion: PART_GEOMETRY_VERSION } as any));
  const detached = modelView(trial, { partObservationVersion: PART_GEOMETRY_VERSION } as any);
  detached.parts![0].parts.parts[0].members[0] = 99;
  assert.notEqual(modelView(trial, { partObservationVersion: PART_GEOMETRY_VERSION } as any).parts![0].parts.parts[0].members[0], 99);
});

test('a saved memo cannot omit candidates or gain parts under a legacy input', async () => {
  const plan = await approvedPlan(4), warmed = await warm(plan), memo = structuredClone(warmed.saved);
  memo.figures[0].parts!.parts.pop();
  assert.throws(() => validateObservationMemo(memo, warmed.own), { code: 'invalid_input' });
  const { ownParts: _parts, ...legacy } = warmed.own;
  assert.throws(() => validateObservationMemo(warmed.saved, { ...legacy, ownParts: undefined }), { code: 'invalid_input' });
});
