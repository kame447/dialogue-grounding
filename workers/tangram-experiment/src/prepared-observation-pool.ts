import { createHash } from 'node:crypto';
import { createPreparedObservationRecipe } from './prepared-observation-recipe.ts';
import type { PreparedObservationParticipant, PreparedObservationRecipe, PreparedObservationBundle } from './prepared-observation-recipe.ts';
import type { ReceptionProtocolV2, ReceptionProtocolV3 } from '../../../dialogue-model/runtime/v2/reception.ts';
import type { ParticipantUsageSnapshot } from '../../../dialogue-model/runtime/web/participant-usage.ts';

export const PREPARED_OBSERVATION_TARGET = 4;
export const PREPARED_OBSERVATION_ACTIVE = 'prepared-observations:v1:active';
const JOB_PREFIX = 'prepared-observations:v1:job:';
const CLAIM_PREFIX = 'prepared-observations:v1:claim:';
const USAGE_PREFIX = 'prepared-observations:v1:usage:';

export type PreparedPoolSpec = {
  poolKey: string;
  protocol: ReceptionProtocolV2 | ReceptionProtocolV3;
  orderIndex: number;
  participant: PreparedObservationParticipant;
};
export type PreparedPoolActive = { specs: PreparedPoolSpec[]; requestedAt: string; errorCode: string | null };
export type PreparedPoolJob = {
  recipe: PreparedObservationRecipe;
  status: 'queued' | 'preparing' | 'ready' | 'failed' | 'claimed';
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  bundle?: PreparedObservationBundle;
};
export type PreparedClaimRequest = {
  receptionId: string;
  objectId: string;
  expectedRevision: number;
  order: number;
  protocolSha256: string;
  participant: PreparedObservationParticipant;
};
type PreparedClaim = { request: PreparedClaimRequest; poolKey: string; jobKey: string; claimedAt: string };
export type PreparedPoolTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};
export type PreparedPoolStorage = PreparedPoolTransaction & {
  transaction<T>(update: (tx: PreparedPoolTransaction) => Promise<T>): Promise<T>;
};

export class PreparedObservationPoolError extends Error {
  readonly code: 'empty' | 'conflict' | 'unavailable';
  constructor(code: PreparedObservationPoolError['code']) {
    super(code); this.name = 'PreparedObservationPoolError'; this.code = code;
  }
}
const jobPrefix = (poolKey: string) => JOB_PREFIX + poolKey + ':';
const jobKey = (recipe: PreparedObservationRecipe) => jobPrefix(recipe.poolKey) + recipe.bundleId;
export const preparedObservationUsageKey = (bundleId: string) => USAGE_PREFIX + bundleId;

function checkedJob(value: unknown, poolKey: string): PreparedPoolJob {
  const job = value as PreparedPoolJob | undefined;
  if (!job || !job.recipe || job.recipe.poolKey !== poolKey ||
      !['queued', 'preparing', 'ready', 'failed', 'claimed'].includes(job.status) ||
      (job.status === 'ready' || job.status === 'claimed') && !job.bundle) {
    throw new PreparedObservationPoolError('unavailable');
  }
  return job;
}

/** Only the configuration operation and replenishment of future admissions enqueue work. */
export async function ensurePreparedObservationJobs(
  storage: PreparedPoolStorage, specs: PreparedPoolSpec[], now: string,
  options: { target?: number; randomSeed?: () => number; newId?: () => string;
    checkCurrent?: (tx: PreparedPoolTransaction) => Promise<boolean> } = {},
): Promise<void> {
  const target = options.target ?? PREPARED_OBSERVATION_TARGET;
  if (!Number.isSafeInteger(target) || target < 1 || target > PREPARED_OBSERVATION_TARGET ||
      specs.length < 1 || specs.length > 4 || new Set(specs.map(spec => spec.poolKey)).size !== specs.length) {
    throw new PreparedObservationPoolError('unavailable');
  }
  await storage.transaction(async tx => {
    if (options.checkCurrent && !await options.checkCurrent(tx)) throw new PreparedObservationPoolError('conflict');
    const pending: Record<string, unknown> = {};
    for (const spec of specs) {
      const jobs = [...(await tx.list<PreparedPoolJob>({ prefix: jobPrefix(spec.poolKey) })).values()]
        .map(job => checkedJob(job, spec.poolKey));
      const available = jobs.filter(job => ['queued', 'preparing', 'ready'].includes(job.status)).length;
      for (let i = available; i < target; i++) {
        const recipe = await createPreparedObservationRecipe({
          protocol: spec.protocol, orderIndex: spec.orderIndex, participant: spec.participant,
          createdAt: now, ...(options.randomSeed ? { randomSeed: options.randomSeed } : {}),
          ...(options.newId ? { bundleId: options.newId() } : {}),
        });
        if (recipe.poolKey !== spec.poolKey || await tx.get(jobKey(recipe)) !== undefined || pending[jobKey(recipe)] !== undefined) {
          throw new PreparedObservationPoolError('unavailable');
        }
        pending[jobKey(recipe)] = { recipe, status: 'queued' } satisfies PreparedPoolJob;
      }
    }
    await tx.put({ ...pending, [PREPARED_OBSERVATION_ACTIVE]: { specs, requestedAt: now, errorCode: null } satisfies PreparedPoolActive });
  });
}

export async function preparedObservationCounts(storage: PreparedPoolTransaction, specs: PreparedPoolSpec[]) {
  return Promise.all(specs.map(async spec => {
    const jobs = [...(await storage.list<PreparedPoolJob>({ prefix: jobPrefix(spec.poolKey) })).values()]
      .map(job => checkedJob(job, spec.poolKey));
    const count = (status: PreparedPoolJob['status']) => jobs.filter(job => job.status === status).length;
    return {
      orderIndex: spec.orderIndex, order: [...spec.protocol.allowedOrders[spec.orderIndex]],
      ready: count('ready'), queued: count('queued'), preparing: count('preparing'), failed: count('failed'),
    };
  }));
}

/** Only the single DO alarm calls this. A restarted in-flight job is never blindly resubmitted. */
export async function takePreparedObservationJob(
  storage: PreparedPoolStorage, specs: PreparedPoolSpec[], now: string,
  checkCurrent?: (tx: PreparedPoolTransaction) => Promise<boolean>,
): Promise<PreparedPoolJob | null> {
  return storage.transaction(async tx => {
    if (checkCurrent && !await checkCurrent(tx)) return null;
    const candidates: { spec: PreparedPoolSpec; ready: number; job: PreparedPoolJob }[] = [];
    for (const spec of specs) {
      const rows = await tx.list<PreparedPoolJob>({ prefix: jobPrefix(spec.poolKey) });
      const jobs = [...rows.values()].map(job => checkedJob(job, spec.poolKey));
      for (const job of jobs.filter(job => job.status === 'preparing')) {
        await tx.put({ [jobKey(job.recipe)]: { ...job, status: 'failed', errorCode: 'preparation_interrupted', finishedAt: now } });
      }
      const queued = jobs.filter(job => job.status === 'queued')
        .sort((a, b) => a.recipe.createdAt.localeCompare(b.recipe.createdAt) || a.recipe.bundleId.localeCompare(b.recipe.bundleId));
      if (queued[0]) candidates.push({ spec, ready: jobs.filter(job => job.status === 'ready').length, job: queued[0] });
    }
    candidates.sort((a, b) => a.ready - b.ready || a.spec.orderIndex - b.spec.orderIndex);
    const selected = candidates[0]?.job;
    if (!selected) return null;
    const running: PreparedPoolJob = { ...selected, status: 'preparing', startedAt: now };
    await tx.put({ [jobKey(selected.recipe)]: running });
    return running;
  });
}

export async function finishPreparedObservationJob(
  storage: PreparedPoolStorage, recipe: PreparedObservationRecipe,
  result: { bundle: PreparedObservationBundle } | { errorCode: string }, now: string,
): Promise<void> {
  await storage.transaction(async tx => {
    const key = jobKey(recipe), job = checkedJob(await tx.get(key), recipe.poolKey);
    if (job.status !== 'preparing') throw new PreparedObservationPoolError('conflict');
    if ('bundle' in result && (result.bundle.poolKey !== recipe.poolKey || result.bundle.bundleId !== recipe.bundleId)) {
      throw new PreparedObservationPoolError('unavailable');
    }
    await tx.put({ [key]: {
      ...job, finishedAt: now, ...('bundle' in result
        ? { status: 'ready', bundle: result.bundle }
        : { status: 'failed', errorCode: result.errorCode }),
    } });
  });
}

/** A request fingerprint preserves retries while an explicitly changed, still-pending approval may use new stock. */
export async function claimPreparedObservation(
  storage: PreparedPoolStorage, poolKey: string, request: PreparedClaimRequest, now: string,
  validate?: (job: PreparedPoolJob) => Promise<void>,
): Promise<PreparedPoolJob> {
  const fingerprint = createHash('sha256').update(JSON.stringify([
    poolKey, request.objectId, request.expectedRevision, request.order, request.protocolSha256,
  ])).digest('hex');
  const result = await storage.transaction<{ job: PreparedPoolJob } | { error: PreparedObservationPoolError['code'] }>(async tx => {
    const ownerKey = CLAIM_PREFIX + request.receptionId + ':owner';
    const owner = await tx.get<{ objectId: string; expectedRevision: number }>(ownerKey);
    if (owner && (owner.objectId !== request.objectId || owner.expectedRevision !== request.expectedRevision)) {
      throw new PreparedObservationPoolError('conflict');
    }
    const key = CLAIM_PREFIX + request.receptionId + ':' + fingerprint, previous = await tx.get<PreparedClaim>(key);
    if (previous) {
      const job = checkedJob(await tx.get(previous.jobKey), poolKey);
      if (job.status !== 'claimed') throw new PreparedObservationPoolError('unavailable');
      await validate?.(job);
      return { job };
    }
    const jobs = [...(await tx.list<PreparedPoolJob>({ prefix: jobPrefix(poolKey) })).values()]
      .map(job => checkedJob(job, poolKey)).filter(job => job.status === 'ready')
      .sort((a, b) => a.bundle!.preparedAt.localeCompare(b.bundle!.preparedAt) || a.recipe.bundleId.localeCompare(b.recipe.bundleId));
    const job = jobs[0];
    if (!job) return { error: 'empty' };
    try { await validate?.(job); }
    catch {
      await tx.put({ [jobKey(job.recipe)]: { ...job, status: 'failed', errorCode: 'invalid_prepared_bundle', finishedAt: now } });
      return { error: 'unavailable' };
    }
    const claimed: PreparedPoolJob = { ...job, status: 'claimed' };
    await tx.put({
      [jobKey(job.recipe)]: claimed,
      [ownerKey]: { objectId: request.objectId, expectedRevision: request.expectedRevision },
      [key]: { request, poolKey, jobKey: jobKey(job.recipe), claimedAt: now } satisfies PreparedClaim,
    });
    return { job: claimed };
  });
  if ('error' in result) throw new PreparedObservationPoolError(result.error);
  return result.job;
}

export function preparedObservationUsageStore(storage: PreparedPoolStorage, bundleId: string) {
  const key = preparedObservationUsageKey(bundleId);
  return {
    read: () => storage.get<ParticipantUsageSnapshot>(key),
    update: (write: (value: unknown) => ParticipantUsageSnapshot) => storage.transaction(async tx => {
      const next = write(await tx.get(key));
      await tx.put({ [key]: next });
      return next;
    }),
  };
}