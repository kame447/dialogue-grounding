import { isOpeningMode } from './opening-mode.ts';
import { CLAIM_PRUNE_V2 } from '../memory/reference-graph.mjs';
import { isP5ParticipantDialogueProfile, isPilot012ParticipantDialogueProfile, participantMemoryPruneVersion } from './reception.ts';
import { validateBaseStart, validateBaseAssignmentConfig, canonicalBaseAssignmentConfig, validateBoundBaseRecord } from './base-assignment.ts';
import { BaseAssignmentError, data, readAssignment, readOwner, UUID, OWNER, safeInt,
  assignmentOpeningMode, assignmentPreparedObservation, assignmentRotationMode, assignmentMemoryPruneVersion, assignmentParticipantModelPin, assignmentParticipantDialogueProfile, assignmentFigureSelection } from './base-assignment-data.ts';
import type { BaseSessionOptions, BaseSession, BaseSessionErrorCode, BaseOwnerState, BaseAssignment,
  AdmissionKey, BaseAssignedEnvelope, BaseRecord, RawBaseRecord, BaseTask, BaseArchiveWrite, FailureCode, FailureCause, RestoreResult, StartIntent } from './base-assignment.ts';
/** Closed sub-reasons of a store/session rejection (code trial_unavailable). Diagnostics only: the HTTP mapping uses `code`, and the reason never carries text. */
export type PersistReason = 'cas_conflict' | 'owner_expired' | 'record_deleted' | 'owner_state_invalid' | 'store_invalid' | 'store_io' | 'size_limit';
export class BaseSessionError extends Error {
  readonly code: BaseSessionErrorCode;
  readonly reason?: PersistReason;
  constructor(code: BaseSessionErrorCode, reason?: PersistReason) { super(code); this.name = 'BaseSessionError'; this.code = code; if (reason) this.reason = reason; }
}
const fail = (code: BaseSessionErrorCode = 'trial_unavailable', reason?: PersistReason): never => { throw new BaseSessionError(code, reason); };
function requireRunnableAssignment(assignment: BaseAssignment, adapter: BaseSessionOptions['adapter']): void {
  const profile = assignmentParticipantDialogueProfile(assignment);
  if ((isP5ParticipantDialogueProfile(profile) || isPilot012ParticipantDialogueProfile(profile)) &&
      (adapter !== 'worker_binding' || assignmentParticipantModelPin(assignment)?.schemaVersion !== 'participant_model_pin_v3' ||
        assignmentMemoryPruneVersion(assignment) !== participantMemoryPruneVersion(profile))) fail();
}
const copy = <T>(v: T): T => structuredClone(v);
export function needsAssignmentPreparation(entry: BaseAssignedEnvelope): boolean {
  return entry.status === 'preparing' || entry.status === 'failed' &&
    ['start_interrupted', 'initialization_failed', 'record_write_failed'].some(code => code === entry.errorCode);
}
/** External ports cannot select an internal error by throwing a matching string. */
async function port<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) { return fail('trial_unavailable', error instanceof BaseSessionError ? error.code === 'owner_expired' ? 'owner_expired' : error.reason ?? 'store_io' : 'store_io'); }
}
/** Maps a makeTask failure to a closed cause. Reads only own string codes of the known error classes (walking `cause`);
 * messages, responses and anything else are never copied, and an unrecognised error is 'unknown'. */
function failureCauseOf(error: unknown): FailureCause {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const o = e as { name?: unknown; code?: unknown; observationErrorCode?: unknown };
    if (o.name === 'JevTurnError') {
      if (o.code === 'observation_failed') {
        const c = o.observationErrorCode;
        return c === 'timeout' ? 'observation_timeout' : c === 'aborted' ? 'observation_aborted' : c === 'unavailable' ? 'observation_unavailable'
          : c === 'invalid_json' || c === 'invalid_response' || c === 'invalid_input' ? 'observation_invalid' : 'unknown';
      }
      return o.code === 'decision_failed' || o.code === 'generation_failed' || o.code === 'invalid_state' ? o.code : 'unknown';
    }
    if (o.name === 'ObservationError') {
      const c = o.code;
      return c === 'timeout' ? 'observation_timeout' : c === 'unavailable' ? 'observation_unavailable' : c === 'aborted' ? 'observation_aborted'
        : c === 'invalid_json' || c === 'invalid_response' || c === 'invalid_input' ? 'observation_invalid' : 'unknown';
    }
  }
  return 'unknown';
}
export function createBaseAssignmentSession(options: BaseSessionOptions): BaseSession {
  try {
    if (!options || options.openingMode !== undefined && !isOpeningMode(options.openingMode) || options.memoryPruneVersion !== undefined && (options.memoryPruneVersion !== CLAIM_PRUNE_V2 || options.adapter !== 'local_private_file') || !OWNER.test(options.ownerId) || !['local_private_file', 'worker_binding'].includes(options.adapter) ||
        typeof options.readConfig !== 'function' || typeof options.makeTask !== 'function' || typeof options.newId !== 'function' ||
        typeof options.now !== 'function' || !options.store || ['read', 'readRecord', 'compareAndSwap'].some(k => typeof (options.store as unknown as Record<string, unknown>)[k] !== 'function')) fail();
  } catch { fail(); }
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  let live: AdmissionKey | null = null;
  let cached: { key: AdmissionKey; task: BaseTask } | null = null;
  let restoring: Promise<RestoreResult> | null = null;
  let preparationFailures = 0, nextPreparationAt = 0;
  const recoverPreparation = options.adapter === 'worker_binding';
  async function state(): Promise<BaseOwnerState> {
    const input = await port(() => options.store.read());
    try {
      const result = data(input);
      if (result.kind === 'expired' && Object.keys(result).length === 1) return fail('owner_expired');
      if (result.kind !== 'state' || Object.keys(result).length !== 2 || !Object.hasOwn(result, 'state')) return fail();
      return readOwner(result.state, options.ownerId);
    } catch (error) {
      if (error instanceof BaseSessionError && error.code === 'owner_expired') throw error;
      return fail();
    }
  }
  async function commit(old: BaseOwnerState, next: BaseOwnerState, writes: BaseArchiveWrite[], conflict: BaseSessionErrorCode = 'trial_unavailable') {
    next.revision = old.revision + 1;
    try { readOwner(next, options.ownerId); } catch { fail('trial_unavailable', 'owner_state_invalid'); }
    const result = await port(() => options.store.compareAndSwap(old.revision, copy(next), copy(writes)));
    if (result === false) fail(conflict, 'cas_conflict'); if (result !== true) fail('trial_unavailable', 'store_invalid');
  }
  async function archived(id: string): Promise<BaseRecord | null> {
    const value = await port(() => options.store.readRecord(id));
    if (value === null) return null;
    try { validateBoundBaseRecord(value, value.assignment); return copy(value); } catch { return fail(); }
  }
  async function assignment(): Promise<BaseAssignment> {
    const binding = options.readPlan ? await port(() => options.readPlan!()) : null;
    if (binding !== null) {
      try {
        const t = binding.plan.trials[binding.trialIndex];
        return readAssignment({ schemaVersion:'base_assignment_v1', assignmentId:options.newId(), strategy:t.strategy,
          seed:t.seed, referenceMemory:t.referenceMemory, createdAt:new Date(options.now()).toISOString(),
          source:{ kind:binding.plan.schemaVersion, adapter:options.adapter, receptionId:binding.receptionId,
            protocolId:binding.plan.protocolId, protocolRevision:binding.plan.protocolRevision, protocolSha256:binding.plan.protocolSha256,
            trialIndex:binding.trialIndex, plan:binding.plan } });
      } catch { return fail(); }
    }
    const raw = await port(() => options.readConfig());
    try {
      const config = validateBaseAssignmentConfig(raw);
      const id = options.newId(), ms = options.now();
      if (!safeInt(ms) || ms < 0) return fail();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalBaseAssignmentConfig(config))));
      return readAssignment({ schemaVersion: 'base_assignment_v1', assignmentId: id, strategy: config.strategy,
        seed: config.seed, referenceMemory: config.referenceMemory,
        source: { kind: 'server_config_v1', adapter: options.adapter, configId: config.configId, revision: config.revision,
          ...(config.referenceMemory && options.memoryPruneVersion ? { memoryPruneVersion: options.memoryPruneVersion } : {}),
          ...(options.openingMode ? { openingMode: options.openingMode } : {}),
          configSha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') }, createdAt: new Date(ms).toISOString() });
    } catch { return fail(); }
  }
  async function admit(old: BaseOwnerState, key: AdmissionKey, intent?: StartIntent) {
    const a = await assignment();
    requireRunnableAssignment(a, options.adapter);
    const next = copy(old);
    next.admissions[key] = { schemaVersion: 'base_assigned_session_v1', assignment: a, status: 'preparing', record: null, errorCode: null,
      ...(intent ? { startIntent: intent } : {}) };
    next.activeKey = key;
    const previous = old.activeKey && old.admissions[old.activeKey]?.record;
    await commit(old, next, previous ? [{ assignmentId: previous.assignment.assignmentId, record: previous }] : [], 'busy');
    live = key;
    return { key, assignment: a };
  }
  async function failed(key: AdmissionKey, id: string, code: FailureCode, cause?: FailureCause) {
    try {
      await serial(async () => { const old = await state(), e = old.admissions[key];
        if (!e || e.assignment.assignmentId !== id || e.status !== 'preparing') return;
        const next = copy(old), target = next.admissions[key]!; target.status = 'failed'; target.errorCode = code;
        if (code === 'initialization_failed' && cause) target.failureCause = cause;
        await commit(old, next, []);
      });
    } catch { /* Preserve the last committed preparing snapshot on storage failure. */ }
  }
  async function construct(key: AdmissionKey, a: BaseAssignment, restore: BaseRecord | null, admitting = !restore, recoveringAdmission = false): Promise<BaseTask> {
    const token: { failed: boolean; internal: unknown; failureCode: FailureCode; cause: FailureCause } = { failed: false, internal: null, failureCode: 'initialization_failed', cause: 'unknown' };
    const onPersist = async (raw: RawBaseRecord) => {
      try {
        await serial(async () => {
          if (token.failed) return fail('trial_unavailable', 'owner_state_invalid');
          const old = await state(), e = old.admissions[key];
          if (!e || e.status === 'failed' || e.record?.status === 'interrupted' || e.assignment.assignmentId !== a.assignmentId) {
            return fail('trial_unavailable', 'owner_state_invalid');
          }
          const value = data(raw);
          if (Object.hasOwn(value, 'assignment') && JSON.stringify(readAssignment(value.assignment)) !== JSON.stringify(a)) return fail('trial_unavailable', 'owner_state_invalid');
          const record = { ...copy(value), assignment: a } as BaseRecord;
          validateBoundBaseRecord(record, a);
          if (record.status === 'interrupted') return fail('trial_unavailable', 'owner_state_invalid');
          if (e.record && e.record.recordId !== record.recordId) return fail('trial_unavailable', 'owner_state_invalid');
          // A deleted/expired record must not be resurrected by a late callback.
          if (e.status === 'active' && e.record && !await archived(e.record.recordId)) return fail('trial_unavailable', 'record_deleted');
          const next = copy(old); next.admissions[key]!.record = record;
          // activeKey stays exactly as read: retired writes never move it.
          await commit(old, next, [{ assignmentId: a.assignmentId, record }]);
        });
      } catch (error) {
        token.failureCode = error instanceof BaseAssignmentError ? 'assignment_record_invalid' : 'record_write_failed';
        token.internal = error;
        throw error;
      }
    };
    let task: BaseTask | undefined;
    try {
      const pin = assignmentParticipantModelPin(a);
      const plan = a.source.kind === 'reception_plan_v2' || a.source.kind === 'reception_plan_v3' ? a.source.plan : null;
      const limits = plan?.participantLimits;
      const profile = plan?.participantRuntimeProfile;
      const initialObservationGeneration = plan?.initialObservationGeneration;
      const openingMode = assignmentOpeningMode(a);
      const preparedObservation = assignmentPreparedObservation(a);
      const memoryPruneVersion = assignmentMemoryPruneVersion(a);
      const participantDialogueProfile = assignmentParticipantDialogueProfile(a);
      try { task = await options.makeTask({ strategy: a.strategy, seed: a.seed, referenceMemory: a.referenceMemory,
        runDir: null, restore: restore ? copy(restore) : null, now: options.now, onPersist,
        ...(pin ? { participantModelPin: pin } : {}),
        ...(memoryPruneVersion ? { memoryPruneVersion } : {}),
        ...(limits ? { participantLimits: limits } : {}),
        ...(profile ? { participantRuntime: { profile, assignmentId: a.assignmentId } } : {}),
        ...(initialObservationGeneration ? { initialObservationGeneration } : {}),
        ...(openingMode ? { openingMode } : {}),
        ...(preparedObservation ? { preparedObservation } : {}),
        ...(recoveringAdmission ? { recoveringAdmission: true } : {}),
        ...(participantDialogueProfile ? { participantDialogueProfile } : {}),
        ...(plan?.postGenerationCheck ? { postGenerationCheck: plan.postGenerationCheck } : {}),
        ...(restore ? {} : { rotationMode: assignmentRotationMode(a),
          ...(a.source.kind === 'reception_plan_v3' ? { figureSelection: assignmentFigureSelection(a) } : {}) }) }); }
      catch (error) { if (error === token.internal && error instanceof BaseSessionError) throw error; token.cause = failureCauseOf(error); return fail(); }
      if (!task || ['getState', 'persistNow', 'whenIdle', 'message', 'retry', 'submitHuman', 'submitAI'].some(k => typeof (task as unknown as Record<string, unknown>)[k] !== 'function')) return fail();
      const readyTask = task;
      const view = await port(() => readyTask.getState());
      await serial(async () => {
        const old = await state(), e = old.admissions[key];
        if (!e || !e.record || e.record.status === 'interrupted' || e.status === 'failed' || e.record.recordId !== view.sessionId || old.activeKey !== key) return fail();
        validateBoundBaseRecord(e.record, a);
        if (admitting) {
          token.failureCode = 'record_write_failed';
          const next = copy(old); next.admissions[key]!.status = 'active';
          await commit(old, next, [{ assignmentId: a.assignmentId, record: e.record }]);
        }
        cached = { key, task: readyTask };
      });
      preparationFailures = 0;
      nextPreparationAt = 0;
      return task;
    } catch (error) {
      token.failed = true;
      // A task can begin work before the admission is active. Invalidate it
      // before another construction is permitted for the same assignment.
      task?.stopForAdmin?.();
      if (admitting) {
        await failed(key, a.assignmentId, token.failureCode, token.cause);
        if (recoverPreparation || recoveringAdmission) {
          const delays = [2000, 4000, 8000, 16000, 30000, 60000];
          nextPreparationAt = options.now() + delays[preparationFailures];
          preparationFailures = Math.min(preparationFailures + 1, delays.length - 1);
        }
      }
      if (error instanceof BaseSessionError && error.code === 'owner_expired') throw error;
      return fail();
    } finally { if (live === key) live = null; }
  }
  function restore(): Promise<RestoreResult> {
    if (restoring) return restoring;
    const work = (async (): Promise<RestoreResult> => {
      const ready = await serial(async () => {
        const old = await state(), key = old.activeKey;
        if (key === null) return { kind: 'empty' as const };
        const e = old.admissions[key]!;
        if (e.record?.status === 'interrupted') return { kind: 'empty' as const };
        const intent = e.startIntent ? { startIntentId: e.startIntent.id } : {};
        requireRunnableAssignment(e.assignment, options.adapter);
        if ((recoverPreparation || e.startIntent) && needsAssignmentPreparation(e)) {
          if (live === key || options.now() < nextPreparationAt) return { kind: 'preparing' as const, intent };
          if (e.record && !await archived(e.record.recordId)) return fail();
          if (e.status === 'failed') {
            const next = copy(old), entry = next.admissions[key]!;
            entry.status = 'preparing'; entry.errorCode = null; delete entry.failureCause;
            await commit(old, next, []);
          }
          live = key;
          return { kind: 'resume_preparation' as const, key, assignment: e.assignment, record: e.record, intent };
        }
        if (e.status === 'preparing') {
          if (live === key) return fail('busy');
          const next = copy(old); next.admissions[key]!.status = 'failed'; next.admissions[key]!.errorCode = 'start_interrupted';
          await commit(old, next, []); return fail();
        }
        if (e.status === 'failed' || !e.record) return fail();
        if (!await archived(e.record.recordId)) return fail();
        return { kind: 'active' as const, key, assignment: e.assignment, record: e.record, task: cached?.key === key ? cached.task : null, intent };
      });
      if (ready.kind === 'empty') return { kind: 'empty', task: null };
      if (ready.kind === 'preparing') return { kind: 'preparing', task: null, ...ready.intent };
      if (ready.kind === 'resume_preparation') {
        const construction = construct(ready.key, ready.assignment, ready.record, true, true).then(() => {}, () => {});
        options.onPreparing?.(construction);
        return { kind: 'preparing', task: null, ...ready.intent };
      }
      return { kind: 'restored', task: ready.task ?? await construct(ready.key, ready.assignment, ready.record), ...ready.intent };
    })();
    restoring = work;
    work.then(() => { if (restoring === work) restoring = null; }, () => { if (restoring === work) restoring = null; });
    return work;
  }
  return {
    async start(body, intent) {
      try { validateBaseStart(body); } catch { return fail('invalid_request'); }
      const ready = await serial(async () => {
        const old = await state();
        if (old.activeKey === null) return { kind: 'new' as const, ...await admit(old, 'initial', intent) };
        const e = old.admissions[old.activeKey]!;
        requireRunnableAssignment(e.assignment, options.adapter);
        if (e.status === 'preparing') return fail('busy');
        if (e.status === 'failed' || !e.record) return fail();
        if (e.record.status !== 'completed') return fail('busy');
        return { kind: 'completed' as const };
      });
      if (ready.kind === 'new') return { kind: 'started', task: await construct(ready.key, ready.assignment, null) };
      const result = await restore(); if (result.kind !== 'restored') return fail();
      return { kind: 'completed', task: result.task };
    },
    restore,
    async prepareNext(id, intent) {
      const ready = await serial(async () => {
        const old = await state();
        if (typeof id !== 'string' || !UUID.test(id)) return fail('not_found');
        const predecessor = await archived(id);
        if (!predecessor) return fail('not_found');
        requireRunnableAssignment(predecessor.assignment, options.adapter);
        if (predecessor.status !== 'completed') return fail('busy');
        const key: AdmissionKey = `after:${id}`, existing = old.admissions[key];
        if (existing) {
          requireRunnableAssignment(existing.assignment, options.adapter);
          if (existing.status === 'failed' && existing.record === null && existing.errorCode === 'record_deleted') return fail('not_found');
          if (existing.status === 'preparing') return fail('busy');
          if (existing.status === 'failed' || !existing.record || existing.record.status === 'interrupted') return fail();
          if (!await archived(existing.record.recordId)) return fail('not_found');
          return { kind: 'existing' as const, recordId: existing.record.recordId };
        }
        if (old.activeKey === null) return fail('not_found');
        const current = old.admissions[old.activeKey]!;
        if (current.status === 'preparing') return fail('busy');
        if (current.status === 'failed' || !current.record) return fail();
        if (current.record.status !== 'completed') return fail('busy');
        if (current.record.recordId !== id) return fail('not_found');
        return { kind: 'new' as const, ...await admit(old, key, intent) };
      });
      if (ready.kind === 'existing') return { kind: 'existing', recordId: ready.recordId, participantPath: '/' };
      const task = await construct(ready.key, ready.assignment, null);
      return { kind: 'created', recordId: task.getState().sessionId as string, participantPath: '/' };
    },
  };
}
