import { ReceptionError } from '../../../dialogue-model/runtime/v2/reception.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../../../dialogue-model/runtime/web/participant-usage-policy.ts';
import { ParticipantUsageLedger } from '../../../dialogue-model/runtime/web/participant-usage.ts';
import { resolveParticipantConfiguration } from './participant-configuration.ts';
import type { ParticipantConfigurationEnv } from './participant-configuration.ts';
import { preparedObservationPoolKey, prepareObservationBundle, validatePreparedObservationBundle } from './prepared-observation-recipe.ts';
import type { ReceptionSettings } from './admin/reception-settings.ts';
import type { PreparedObservationPoolStatus } from './admin/prepared-observation-port.ts';
import {
  PREPARED_OBSERVATION_ACTIVE, PREPARED_OBSERVATION_TARGET, PreparedObservationPoolError,
  ensurePreparedObservationJobs, preparedObservationCounts, takePreparedObservationJob,
  finishPreparedObservationJob, claimPreparedObservation, preparedObservationUsageStore,
} from './prepared-observation-pool.ts';
import type { PreparedPoolActive, PreparedPoolStorage, PreparedPoolTransaction, PreparedPoolSpec, PreparedClaimRequest } from './prepared-observation-pool.ts';

type Options = {
  storage: PreparedPoolStorage;
  env: ParticipantConfigurationEnv;
  readSettings(tx?: PreparedPoolTransaction): Promise<ReceptionSettings>;
  setAlarm(time: number): Promise<void>;
  now?: () => Date;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hex64 = /^[a-f0-9]{64}$/u;
const sameSpecs = (a: PreparedPoolSpec[], b: PreparedPoolSpec[]) =>
  JSON.stringify(a.map(spec => spec.poolKey)) === JSON.stringify(b.map(spec => spec.poolKey));

/** Private global stock. Its alarms generate only future admissions, never an active participant's missing memo. */
export class PreparedObservationCoordinator {
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }

  private async context() {
    const settings = await this.options.readSettings(), protocol = settings.protocol?.protocol;
    if (!protocol || !protocol.referenceMemory || this.options.env.PARTICIPANT_TERRA_ENABLED !== 'on' ||
        this.options.env.PARTICIPANT_TERRA_PROFILE !== PARTICIPANT_PRODUCTION_PROFILE) {
      return { settings, supported: false as const, specs: [] as PreparedPoolSpec[], proxy: undefined };
    }
    const { participant, proxy } = await resolveParticipantConfiguration(this.options.env, protocol);
    if (!participant.participantModelPin || !proxy) throw new PreparedObservationPoolError('unavailable');
    const specs = await Promise.all(protocol.allowedOrders.map(async (_order, orderIndex) => ({
      protocol, orderIndex, participant,
      poolKey: await preparedObservationPoolKey({ protocol, orderIndex, participant }),
    })));
    return { settings, supported: true as const, specs, proxy };
  }

  private async isCurrent(context: Awaited<ReturnType<PreparedObservationCoordinator['context']>>, tx: PreparedPoolTransaction) {
    const current = await this.options.readSettings(tx);
    return !!current.protocol && current.protocol.sha256 === context.settings.protocol?.sha256 &&
      current.protocol.revision === context.settings.protocol?.revision;
  }

  private async enqueue(context: Awaited<ReturnType<PreparedObservationCoordinator['context']>>) {
    await ensurePreparedObservationJobs(this.options.storage, context.specs, this.now(), {
      checkCurrent: tx => this.isCurrent(context, tx),
    });
  }

  private async schedule(specs: PreparedPoolSpec[]) {
    if ((await preparedObservationCounts(this.options.storage, specs)).some(order => order.queued > 0)) {
      await this.options.setAlarm(Date.parse(this.now()) + 1000);
    }
  }

  private async setError(specs: PreparedPoolSpec[], errorCode: string | null) {
    await this.options.storage.transaction(async tx => {
      const current = await tx.get<PreparedPoolActive>(PREPARED_OBSERVATION_ACTIVE);
      if (current && sameSpecs(current.specs, specs)) await tx.put({ [PREPARED_OBSERVATION_ACTIVE]: { ...current, errorCode } });
    });
  }

  async status(): Promise<PreparedObservationPoolStatus> {
    let protocolRevision: number | null = null;
    try {
      const context = await this.context();
      protocolRevision = context.settings.protocol?.revision ?? null;
      const base = { supported: context.supported, protocolRevision, targetPerOrder: PREPARED_OBSERVATION_TARGET };
      if (!context.supported) return { ...base, orders: [], errorCode: null };
      const orders = await preparedObservationCounts(this.options.storage, context.specs);
      const active = await this.options.storage.get<PreparedPoolActive>(PREPARED_OBSERVATION_ACTIVE);
      const errorCode = active && sameSpecs(active.specs, context.specs) ? active.errorCode : null;
      return { ...base, orders, errorCode };
    } catch {
      try { protocolRevision = (await this.options.readSettings()).protocol?.revision ?? null; } catch { /* Keep the unavailable projection. */ }
      return { supported: true, protocolRevision, targetPerOrder: PREPARED_OBSERVATION_TARGET, orders: [], errorCode: 'configuration_unavailable' };
    }
  }

  async prepare(input: { expectedProtocolRevision: number }): Promise<
    { ok: true } | { ok: false; error: 'conflict' | 'unconfigured' | 'unavailable' }
  > {
    try {
      const context = await this.context();
      if (!context.settings.protocol) return { ok: false, error: 'unconfigured' };
      if (!Number.isSafeInteger(input?.expectedProtocolRevision) ||
          input.expectedProtocolRevision !== context.settings.protocol?.revision) return { ok: false, error: 'conflict' };
      if (!context.supported) return { ok: false, error: 'unconfigured' };
      await this.enqueue(context);
      await this.schedule(context.specs);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof PreparedObservationPoolError && error.code === 'conflict' ? 'conflict' : 'unavailable' };
    }
  }

  async claim(input: PreparedClaimRequest) {
    if (!input || !uuid.test(input.receptionId) || !hex64.test(input.objectId) ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        !Number.isSafeInteger(input.order) || !hex64.test(input.protocolSha256)) {
      throw new ReceptionError('prepared_observations_unavailable');
    }
    try {
      const context = await this.context(), spec = context.specs[input.order];
      if (!context.supported || !spec || context.settings.protocol?.sha256 !== input.protocolSha256 ||
          await preparedObservationPoolKey({ protocol: spec.protocol, orderIndex: input.order, participant: input.participant }) !== spec.poolKey) {
        throw new PreparedObservationPoolError('conflict');
      }
      let verified: Awaited<ReturnType<typeof validatePreparedObservationBundle>> | undefined;
      await claimPreparedObservation(this.options.storage, spec.poolKey, input, this.now(), async job => {
        verified = await validatePreparedObservationBundle(job.bundle, job.recipe);
      });
      if (!verified) throw new PreparedObservationPoolError('unavailable');
      const bundle = verified;
      try {
        await this.enqueue(context);
        await this.schedule(context.specs);
      } catch { await this.setError(context.specs, 'unavailable').catch(() => {}); }
      return bundle;
    } catch (error) {
      if (error instanceof PreparedObservationPoolError && error.code === 'conflict') throw new ReceptionError('reception_conflict');
      throw new ReceptionError('prepared_observations_unavailable');
    }
  }

  async alarm(): Promise<void> {
    const active = await this.options.storage.get<PreparedPoolActive>(PREPARED_OBSERVATION_ACTIVE);
    if (!active || !active.specs.length) return;
    let context: Awaited<ReturnType<PreparedObservationCoordinator['context']>>;
    try { context = await this.context(); }
    catch { await this.setError(active.specs, 'configuration_unavailable'); return; }
    if (!context.supported || !context.proxy || !sameSpecs(active.specs, context.specs)) {
      await this.setError(active.specs, 'configuration_changed'); return;
    }
    const job = await takePreparedObservationJob(this.options.storage, active.specs, this.now(), async tx => {
      const current = await tx.get<PreparedPoolActive>(PREPARED_OBSERVATION_ACTIVE);
      return !!current && sameSpecs(current.specs, active.specs) && await this.isCurrent(context, tx);
    });
    if (!job) return;
    try {
      const pin = job.recipe.participant.participantModelPin;
      if (!pin) throw new PreparedObservationPoolError('unavailable');
      const usage = await ParticipantUsageLedger.open(
        preparedObservationUsageStore(this.options.storage, job.recipe.bundleId),
        'prepared-observation:' + job.recipe.bundleId, pin,
      );
      const cache = {
        read: (key: string) => this.options.storage.get(key),
        putIfAbsent: (key: string, entry: unknown) => this.options.storage.transaction(async tx => {
          const found = await tx.get(key);
          if (found !== undefined) return found;
          await tx.put({ [key]: entry });
          return entry;
        }),
      };
      const bundle = await prepareObservationBundle({ recipe: job.recipe, proxy: context.proxy, cache, usage });
      await finishPreparedObservationJob(this.options.storage, job.recipe, { bundle }, this.now());
      await this.setError(active.specs, null);
    } catch {
      await finishPreparedObservationJob(this.options.storage, job.recipe, { errorCode: 'preparation_failed' }, this.now());
      await this.setError(active.specs, 'preparation_failed');
    }
    const current = await this.options.storage.get<PreparedPoolActive>(PREPARED_OBSERVATION_ACTIVE);
    if (current) await this.schedule(current.specs);
  }
}
