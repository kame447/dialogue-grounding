import test from 'node:test';
import assert from 'node:assert/strict';
import { PreparedObservationCoordinator } from '../workers/tangram-experiment/src/prepared-observation-coordinator.ts';
import {
  PREPARED_OBSERVATION_TARGET, PREPARED_OBSERVATION_ACTIVE, PreparedObservationPoolError,
  ensurePreparedObservationJobs, preparedObservationCounts, takePreparedObservationJob,
  finishPreparedObservationJob, claimPreparedObservation,
} from '../workers/tangram-experiment/src/prepared-observation-pool.ts';
import type { PreparedPoolStorage, PreparedPoolTransaction, PreparedPoolSpec, PreparedClaimRequest } from '../workers/tangram-experiment/src/prepared-observation-pool.ts';
import { preparedObservationPoolKey } from '../workers/tangram-experiment/src/prepared-observation-recipe.ts';
import type { PreparedObservationBundle } from '../workers/tangram-experiment/src/prepared-observation-recipe.ts';
import { resolveParticipantConfiguration } from '../workers/tangram-experiment/src/participant-configuration.ts';
import { validateReceptionProtocolV3, receptionProtocolSha256 } from '../dialogue-model/runtime/v2/reception.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';
import type { ParticipantService } from '../workers/tangram-experiment/src/participant-runtime.ts';

const now = '2026-11-28T00:00:00.000Z';
const pin = validateParticipantModelPin({
  schemaVersion: 'participant_model_pin_v1', terraModelId: 'gpt-6.1-terra-2026-11-01',
  lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261014',
});
const protocol = validateReceptionProtocolV3({
  schemaVersion: 'reception_protocol_v3', protocolId: '44444444-4444-4444-8444-444444444444', revision: 1,
  allowedOrders: [['repair-first', 'bypass-enabled'], ['bypass-enabled', 'repair-first']],
  seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3',
  rotationMode: 'relative_pm90', figureSelection: { mode: 'preset', setId: 'pilot-four-v1' }, figureSetPolicy: 'shared',
});
// The pool and recipe layers still serve four-figure settings (stock and claims made before #268 must stay readable), so the
// pool-level tests keep this four-figure protocol. The coordinator prepares only for three figures: `trio` is its fixture.
const trio = validateReceptionProtocolV3({ ...protocol, figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] } });
const participant = { participantModelPin: pin, participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE } as const;
const spec: PreparedPoolSpec = { protocol, orderIndex: 0, participant, poolKey: await preparedObservationPoolKey({ protocol, orderIndex: 0, participant }) };
let sequence = 1;
const newId = () => '00000000-0000-4000-8000-' + String(sequence++).padStart(12, '0');
const seed = () => sequence++ * 713;
function memory() {
  let data = new Map<string, unknown>(), tail: Promise<unknown> = Promise.resolve();
  const view = (values: Map<string, unknown>): PreparedPoolTransaction => ({
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]));
    },
  });
  const storage: PreparedPoolStorage = {
    get: <T>(key: string) => view(data).get<T>(key),
    put: entries => view(data).put(entries),
    list: <T>(options: { prefix: string }) => view(data).list<T>(options),
    transaction<T>(write: (tx: PreparedPoolTransaction) => Promise<T>): Promise<T> {
      const next = tail.then(async () => {
        const staged = structuredClone(data), result = await write(view(staged));
        data = staged;
        return result;
      });
      tail = next.catch(() => {});
      return next;
    },
  };
  return storage;
}
const request = (receptionId = newId(), claimed: { revision: number } = protocol): PreparedClaimRequest => ({
  receptionId, objectId: 'a'.repeat(64), expectedRevision: 0, order: 0,
  protocolSha256: receptionProtocolSha256(JSON.stringify(claimed)), participant,
});
const failure = (code: string) => (error: unknown) => error instanceof PreparedObservationPoolError && error.code === code;
async function ready(storage: PreparedPoolStorage, selected = spec) {
  const job = await takePreparedObservationJob(storage, [selected], now);
  assert.ok(job);
  const bundle: PreparedObservationBundle = {
    bundleId: job.recipe.bundleId, poolKey: job.recipe.poolKey, preparedAt: now,
    randomSeeds: job.recipe.randomSeeds, plan: job.recipe.plan, entries: [],
  };
  await finishPreparedObservationJob(storage, job.recipe, { bundle }, now);
  return job;
}

test('preparation queues a bounded stock once and gives no admission a partial job', async () => {
  const storage = memory();
  await ensurePreparedObservationJobs(storage, [spec], now, { newId, randomSeed: seed });
  await ensurePreparedObservationJobs(storage, [spec], now, { newId, randomSeed: seed });
  assert.deepEqual((await preparedObservationCounts(storage, [spec]))[0], {
    orderIndex: 0, order: protocol.allowedOrders[0], ready: 0, queued: PREPARED_OBSERVATION_TARGET, preparing: 0, failed: 0,
  });
  await assert.rejects(claimPreparedObservation(storage, spec.poolKey, request(), now), failure('empty'));
  const running = await takePreparedObservationJob(storage, [spec], now);
  assert.ok(running);
  await assert.rejects(claimPreparedObservation(storage, spec.poolKey, request(), now), failure('empty'));
  await finishPreparedObservationJob(storage, running.recipe, { errorCode: 'preparation_failed' }, now);
  await assert.rejects(claimPreparedObservation(storage, spec.poolKey, request(), now), failure('empty'));
});

test('concurrent claims are exclusive and retries after a lost owner save reuse the same bundle', async () => {
  const storage = memory();
  await ensurePreparedObservationJobs(storage, [spec], now, { target: 2, newId, randomSeed: seed });
  await ready(storage); await ready(storage);
  const first = request(), second = request();
  const [a, b] = await Promise.all([
    claimPreparedObservation(storage, spec.poolKey, first, now),
    claimPreparedObservation(storage, spec.poolKey, second, now),
  ]);
  assert.notEqual(a.recipe.bundleId, b.recipe.bundleId);
  assert.equal((await claimPreparedObservation(storage, spec.poolKey, first, now)).recipe.bundleId, a.recipe.bundleId);
  await assert.rejects(claimPreparedObservation(storage, spec.poolKey, { ...first, objectId: 'b'.repeat(64) }, now), failure('conflict'));
  await assert.rejects(claimPreparedObservation(storage, spec.poolKey, { ...first, expectedRevision: 1 }, now), failure('conflict'));
  await assert.rejects(claimPreparedObservation(storage, spec.poolKey, request(), now), failure('empty'));
});

test('an interrupted alarm does not submit the same potentially billable observation again', async () => {
  const storage = memory();
  await ensurePreparedObservationJobs(storage, [spec], now, { target: 2, newId, randomSeed: seed });
  const interrupted = await takePreparedObservationJob(storage, [spec], now);
  const next = await takePreparedObservationJob(storage, [spec], now);
  assert.ok(interrupted); assert.ok(next);
  assert.notEqual(next.recipe.bundleId, interrupted.recipe.bundleId);
  const counts = (await preparedObservationCounts(storage, [spec]))[0];
  assert.equal(counts.failed, 1); assert.equal(counts.preparing, 1); assert.equal(counts.ready, 0);
});

test('a new configuration cannot claim old stock and preserves old claims', async () => {
  const storage = memory();
  await ensurePreparedObservationJobs(storage, [spec], now, { target: 1, newId, randomSeed: seed });
  await ready(storage);
  const claimed = request(), first = await claimPreparedObservation(storage, spec.poolKey, claimed, now);
  const newer = { ...protocol, revision: 2 };
  const other: PreparedPoolSpec = { ...spec, protocol: newer, poolKey: await preparedObservationPoolKey({ protocol: newer, orderIndex: 0, participant }) };
  await ensurePreparedObservationJobs(storage, [other], now, { target: 1, newId, randomSeed: seed });
  await assert.rejects(claimPreparedObservation(storage, other.poolKey, request(), now), failure('empty'));
  assert.equal((await claimPreparedObservation(storage, spec.poolKey, claimed, now)).recipe.bundleId, first.recipe.bundleId);
});

function coordinator(base: typeof trio = trio) {
  const storage = memory(), alarms: number[] = [];
  const control = { posts: 0, policy: pin, fail: false };
  const unused = async () => { throw new Error('unexpected dialogue call'); };
  const proxy: ParticipantService = {
    participantPolicy: async () => control.policy,
    participantUsagePolicy: async () => control.policy,
    participantChat: unused, participantChoices: unused, participantUsageChoices: unused,
    async participantUsageChat(payload: unknown, expected: string) {
      control.posts++;
      assert.equal(expected, pin.terraModelId);
      const body = payload as { purpose: string; messages: { content: string }[] };
      assert.equal(body.purpose, 'visual_observation');
      if (control.fail) return { status: 503, data: { error: 'unavailable' } };
      const input = JSON.parse(body.messages[1].content);
      const saved = settings.protocol.protocol.figureSelection;
      assert.equal(input.ownAnchors.length, saved.mode === 'custom' ? saved.figureIds.length : 4);
      const figures = input.ownAnchors.map(({ id }: { id: string }) => ({
        id, holistic: [], analytic: { shapes: ['三角'], composition: '辺がつながる', relations: [] }, unknowns: [],
      }));
      return { status: 200, data: { model: expected, choices: [{ message: { content: JSON.stringify({ figures }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 8 } } };
    },
  };
  const env = { PARTICIPANT_TERRA_ENABLED: 'on', PARTICIPANT_TERRA_PROFILE: PARTICIPANT_PRODUCTION_PROFILE, PARTICIPANT_AI_PROXY: proxy };
  const settings = { protocol: { protocol: base, revision: base.revision, savedAt: now, sha256: receptionProtocolSha256(JSON.stringify(base)) },
    mode: { value: 'on' as const, revision: 1, savedAt: now } };
  const service = new PreparedObservationCoordinator({ storage, env, readSettings: async () => structuredClone(settings), setAlarm: async time => { alarms.push(time); } });
  return { storage, env, settings, service, control, alarms };
}

test('status and preparation scheduling do not observe; only the pre-admission alarm creates memos', async () => {
  const f = coordinator();
  assert.equal((await f.service.status()).orders[0].ready, 0);
  assert.deepEqual(await f.service.prepare({ expectedProtocolRevision: 99 }), { ok: false, error: 'conflict' });
  assert.equal(f.control.posts, 0);
  assert.deepEqual(await f.service.prepare({ expectedProtocolRevision: 1 }), { ok: true });
  assert.ok(f.alarms.length);
  assert.equal(f.control.posts, 0);
  await f.service.alarm();
  assert.equal(f.control.posts, 1, 'shared conditions reuse one exact prepared observation');
  assert.equal((await f.service.status()).orders[0].ready, 1);
  const { participant: bound } = await resolveParticipantConfiguration(f.env, trio);
  const input = { ...request(undefined, trio), participant: bound };
  const bundle = await f.service.claim(input);
  assert.equal(f.control.posts, 1, 'claim only reads; replenishment is queued for later');
  assert.equal(bundle.entries.length, 1);
  assert.equal((await f.service.claim(input)).bundleId, bundle.bundleId);
  assert.equal(f.control.posts, 1);
  const current = await f.storage.get<{ specs: unknown[] }>(PREPARED_OBSERVATION_ACTIVE);
  assert.equal(current?.specs.length, 2);
});

test('failed preparation and changed model pins never fall through to observation on claim', async () => {
  const f = coordinator();
  await f.service.prepare({ expectedProtocolRevision: 1 });
  f.control.fail = true;
  await f.service.alarm();
  assert.equal((await f.service.status()).orders[0].failed, 1);
  const { participant: bound } = await resolveParticipantConfiguration(f.env, trio);
  await assert.rejects(f.service.claim({ ...request(undefined, trio), participant: bound }), { message: 'prepared_observations_unavailable' });
  assert.equal(f.control.posts, 1);
  f.control.policy = { ...pin, terraModelId: 'gpt-6.1-terra-2026-11-02' };
  await f.service.alarm();
  assert.equal(f.control.posts, 1, 'configuration changes stop pending generation');
  assert.equal((await f.service.status()).orders[0].ready, 0);
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function revise(f: ReturnType<typeof coordinator>) {
  const next = { ...trio, revision: f.settings.protocol.revision + 1 };
  f.settings.protocol = { protocol: next, revision: next.revision, savedAt: now, sha256: receptionProtocolSha256(JSON.stringify(next)) };
}

test('a delayed old preparation cannot overwrite a newer configuration or start an obsolete job', async () => {
  for (const operation of ['prepare', 'alarm'] as const) {
    const f = coordinator();
    if (operation === 'alarm') await f.service.prepare({ expectedProtocolRevision: 1 });
    const entered = deferred(), release = deferred();
    f.env.PARTICIPANT_AI_PROXY.participantUsagePolicy = async () => {
      entered.resolve(); await release.promise; return pin;
    };
    const old = operation === 'prepare' ? f.service.prepare({ expectedProtocolRevision: 1 }) : f.service.alarm();
    await entered.promise;
    revise(f);
    f.env.PARTICIPANT_AI_PROXY.participantUsagePolicy = async () => pin;
    assert.deepEqual(await f.service.prepare({ expectedProtocolRevision: 2 }), { ok: true });
    release.resolve();
    const result = await old;
    if (operation === 'prepare') assert.deepEqual(result, { ok: false, error: 'conflict' });
    const active = await f.storage.get<{ specs: PreparedPoolSpec[] }>(PREPARED_OBSERVATION_ACTIVE);
    assert.ok(active?.specs.every(item => item.protocol.revision === 2));
    assert.equal(f.control.posts, 0);
    assert.equal((await f.service.status()).orders[0].queued, PREPARED_OBSERVATION_TARGET);
  }
});

test('an invalid ready memo is quarantined before claim so the same pending reception can recover', async () => {
  const f = coordinator();
  await f.service.prepare({ expectedProtocolRevision: 1 });
  await f.service.alarm();
  const rows = await f.storage.list<any>({ prefix: 'prepared-observations:v1:job:' });
  const [key, job] = [...rows].find(([, value]) => value.status === 'ready')!;
  job.bundle.entries[0].entry.memo.figures[0].analytic.composition = 'changed after preparation';
  await f.storage.put({ [key]: job });
  const { participant: bound } = await resolveParticipantConfiguration(f.env, trio);
  const input = { ...request(undefined, trio), participant: bound };
  await assert.rejects(f.service.claim(input), { message: 'prepared_observations_unavailable' });
  assert.equal(f.control.posts, 1);
  assert.equal((await f.service.status()).orders[0].failed, 1);
  await f.service.prepare({ expectedProtocolRevision: 1 });
  await f.service.alarm();
  const recovered = await f.service.claim(input);
  assert.notEqual(recovered.bundleId, job.recipe.bundleId);
  assert.equal(f.control.posts, 2, 'the claim never observes; only the explicit preparation alarm did');
  assert.equal((await f.service.claim(input)).bundleId, recovered.bundleId);
});

test('a lost owner write can be followed by an explicit approval of a new protocol without recycling the old bundle', async () => {
  const f = coordinator();
  await f.service.prepare({ expectedProtocolRevision: 1 });
  await f.service.alarm();
  const { participant: bound } = await resolveParticipantConfiguration(f.env, trio);
  const input = { ...request(undefined, trio), participant: bound };
  const first = await f.service.claim(input);
  revise(f);
  await f.service.prepare({ expectedProtocolRevision: 2 });
  await f.service.alarm();
  const changed = { ...input, protocolSha256: f.settings.protocol.sha256 };
  const second = await f.service.claim(changed);
  assert.notEqual(second.bundleId, first.bundleId);
  assert.equal((await f.service.claim(changed)).bundleId, second.bundleId);
  const jobs = [...(await f.storage.list<any>({ prefix: 'prepared-observations:v1:job:' })).values()];
  assert.equal(jobs.find(job => job.recipe.bundleId === first.bundleId)?.status, 'claimed');
  assert.equal(f.control.posts, 2);
});

test('a three-figure setting is prepared for exactly as before, and a migration from a four-figure one starts preparing for the new revision', async () => {
  const f = coordinator(validateReceptionProtocolV3({ ...protocol, figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4'] } }));
  assert.deepEqual(await f.service.status(), { supported: false, protocolRevision: 1, targetPerOrder: PREPARED_OBSERVATION_TARGET, orders: [], errorCode: null });
  // The researcher saves three figures as the next revision of the same protocol.
  const migrated = { ...trio, revision: 2 };
  f.settings.protocol = { protocol: migrated, revision: 2, savedAt: now, sha256: receptionProtocolSha256(JSON.stringify(migrated)) };
  assert.deepEqual(await f.service.prepare({ expectedProtocolRevision: 2 }), { ok: true });
  assert.equal((await f.service.status()).orders[0].queued, PREPARED_OBSERVATION_TARGET);
  assert.equal(f.control.posts, 0, 'preparing only queues; the alarm observes');
  await f.service.alarm();
  assert.equal(f.control.posts, 1);
  assert.equal((await f.service.status()).orders[0].ready, 1);
});

test('a four- or six-figure setting is never prepared for: status is unsupported, preparation and claim refuse, and no model is called (#268)', async () => {
  for (const figureSelection of [{ mode: 'preset', setId: 'pilot-four-v1' }, { mode: 'preset', setId: 'legacy-v1' }, { mode: 'preset', setId: 'bank-set-a' },
    { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4'] }, { mode: 'seeded_random', selectionSeed: 7, figureCount: 4 }, { mode: 'seeded_random', selectionSeed: 7 }] as const) {
    const legacy = validateReceptionProtocolV3({ ...protocol, figureSelection });
    const f = coordinator(legacy);
    assert.deepEqual(await f.service.status(), { supported: false, protocolRevision: 1, targetPerOrder: PREPARED_OBSERVATION_TARGET, orders: [], errorCode: null });
    assert.deepEqual(await f.service.prepare({ expectedProtocolRevision: 1 }), { ok: false, error: 'unconfigured' });
    await f.service.alarm();
    const { participant: bound } = await resolveParticipantConfiguration(f.env, legacy);
    await assert.rejects(f.service.claim({ ...request(undefined, legacy), participant: bound }), { message: 'reception_conflict' });
    assert.equal(f.control.posts, 0); assert.deepEqual(f.alarms, []);
    assert.deepEqual([...(await f.storage.list({ prefix: 'prepared-observations:v1:' })).keys()], [], JSON.stringify(figureSelection));
  }
});

test('a preparation that was running for three figures stops when the setting becomes a four-figure one, and spends nothing', async () => {
  const f = coordinator();
  assert.deepEqual(await f.service.prepare({ expectedProtocolRevision: 1 }), { ok: true });
  const legacy = { ...protocol, revision: 2 };
  f.settings.protocol = { protocol: legacy, revision: 2, savedAt: now, sha256: receptionProtocolSha256(JSON.stringify(legacy)) };
  await f.service.alarm();
  assert.equal(f.control.posts, 0);
  assert.equal((await f.service.status()).supported, false);
  const active = await f.storage.get<{ errorCode: string | null }>(PREPARED_OBSERVATION_ACTIVE);
  assert.equal(active?.errorCode, 'configuration_changed');
});
