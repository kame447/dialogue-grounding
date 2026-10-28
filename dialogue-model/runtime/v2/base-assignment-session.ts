import { validateBaseStart, validateBaseAssignmentConfig, canonicalBaseAssignmentConfig, validateBoundBaseRecord } from './base-assignment.ts';
import { BaseAssignmentError, data, readAssignment, readOwner, UUID, OWNER, safeInt } from './base-assignment-data.ts';
import type { BaseSessionOptions, BaseSession, BaseSessionErrorCode, BaseOwnerState, BaseAssignment,
  AdmissionKey, BaseRecord, RawBaseRecord, BaseTask, BaseArchiveWrite, FailureCode, RestoreResult } from './base-assignment.ts';
export class BaseSessionError extends Error {
  readonly code: BaseSessionErrorCode;
  constructor(code: BaseSessionErrorCode) { super(code); this.name = 'BaseSessionError'; this.code = code; }
}
const fail = (code: BaseSessionErrorCode = 'trial_unavailable'): never => { throw new BaseSessionError(code); };
const copy = <T>(v: T): T => structuredClone(v);
/** External ports cannot select an internal error by throwing a matching string. */
async function port<T>(fn: () => T | Promise<T>): Promise<T> { try { return await fn(); } catch { return fail(); } }
export function createBaseAssignmentSession(options: BaseSessionOptions): BaseSession {
  try {
    if (!options || !OWNER.test(options.ownerId) || !['local_private_file', 'worker_binding'].includes(options.adapter) ||
        typeof options.readConfig !== 'function' || typeof options.makeTask !== 'function' || typeof options.newId !== 'function' ||
        typeof options.now !== 'function' || !options.store || ['read', 'readRecord', 'compareAndSwap'].some(k => typeof (options.store as unknown as Record<string, unknown>)[k] !== 'function')) fail();
  } catch { fail(); }
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  let live: AdmissionKey | null = null;
  let cached: { key: AdmissionKey; task: BaseTask } | null = null;
  let restoring: Promise<RestoreResult> | null = null;
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
    try { readOwner(next, options.ownerId); } catch { fail(); }
    const result = await port(() => options.store.compareAndSwap(old.revision, copy(next), copy(writes)));
    if (result === false) fail(conflict); if (result !== true) fail();
  }
  async function archived(id: string): Promise<BaseRecord | null> {
    const value = await port(() => options.store.readRecord(id));
    if (value === null) return null;
    try { validateBoundBaseRecord(value, value.assignment); return copy(value); } catch { return fail(); }
  }
  async function assignment(): Promise<BaseAssignment> {
    if (options.readPlan) {
      const binding = await port(() => options.readPlan!());
      try {
        const t = binding.plan.trials[binding.trialIndex];
        return readAssignment({ schemaVersion:'base_assignment_v1', assignmentId:options.newId(), strategy:t.strategy,
          seed:t.seed, referenceMemory:t.referenceMemory, createdAt:new Date(options.now()).toISOString(),
          source:{ kind:'reception_plan_v1', adapter:options.adapter, receptionId:binding.receptionId,
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
          configSha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') }, createdAt: new Date(ms).toISOString() });
    } catch { return fail(); }
  }
  async function admit(old: BaseOwnerState, key: AdmissionKey) {
    const a = await assignment(), next = copy(old);
    next.admissions[key] = { schemaVersion: 'base_assigned_session_v1', assignment: a, status: 'preparing', record: null, errorCode: null };
    next.activeKey = key;
    const previous = old.activeKey && old.admissions[old.activeKey]?.record;
    await commit(old, next, previous ? [{ assignmentId: previous.assignment.assignmentId, record: previous }] : [], 'busy');
    live = key;
    return { key, assignment: a };
  }
  async function failed(key: AdmissionKey, id: string, code: FailureCode) {
    try {
      await serial(async () => { const old = await state(), e = old.admissions[key];
        if (!e || e.assignment.assignmentId !== id || e.status !== 'preparing') return;
        const next = copy(old), target = next.admissions[key]!; target.status = 'failed'; target.errorCode = code;
        await commit(old, next, []);
      });
    } catch { /* Preserve the last committed preparing snapshot on storage failure. */ }
  }
  async function construct(key: AdmissionKey, a: BaseAssignment, restore: BaseRecord | null): Promise<BaseTask> {
    const token: { failed: boolean; internal: unknown; failureCode: FailureCode } = { failed: false, internal: null, failureCode: 'initialization_failed' };
    const onPersist = async (raw: RawBaseRecord) => {
      try {
        await serial(async () => {
          if (token.failed) return fail();
          const old = await state(), e = old.admissions[key];
          if (!e || e.status === 'failed' || e.assignment.assignmentId !== a.assignmentId) return fail();
          const value = data(raw);
          if (Object.hasOwn(value, 'assignment') && JSON.stringify(readAssignment(value.assignment)) !== JSON.stringify(a)) return fail();
          const record = { ...copy(value), assignment: a } as BaseRecord;
          validateBoundBaseRecord(record, a);
          if (e.record && e.record.recordId !== record.recordId) return fail();
          // A deleted/expired record must not be resurrected by a late callback.
          if (e.status === 'active' && e.record && !await archived(e.record.recordId)) return fail();
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
    try {
      let task: BaseTask;
      try { task = await options.makeTask({ strategy: a.strategy, seed: a.seed, referenceMemory: a.referenceMemory,
        runDir: null, restore: restore ? copy(restore) : null, now: options.now, onPersist }); }
      catch (error) { if (error === token.internal && error instanceof BaseSessionError) throw error; return fail(); }
      if (!task || ['getState', 'persistNow', 'whenIdle', 'message', 'retry', 'submitHuman', 'submitAI'].some(k => typeof (task as unknown as Record<string, unknown>)[k] !== 'function')) return fail();
      const view = await port(() => task.getState());
      await serial(async () => {
        const old = await state(), e = old.admissions[key];
        if (!e || !e.record || e.status === 'failed' || e.record.recordId !== view.sessionId || old.activeKey !== key) return fail();
        validateBoundBaseRecord(e.record, a);
        if (!restore) {
          token.failureCode = 'record_write_failed';
          const next = copy(old); next.admissions[key]!.status = 'active';
          await commit(old, next, [{ assignmentId: a.assignmentId, record: e.record }]);
        }
        cached = { key, task };
      });
      return task;
    } catch (error) {
      token.failed = true;
      if (!restore) await failed(key, a.assignmentId, token.failureCode);
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
        if (e.status === 'preparing') {
          if (live === key) return fail('busy');
          const next = copy(old); next.admissions[key]!.status = 'failed'; next.admissions[key]!.errorCode = 'start_interrupted';
          await commit(old, next, []); return fail();
        }
        if (e.status === 'failed' || !e.record) return fail();
        if (!await archived(e.record.recordId)) return fail();
        return { kind: 'active' as const, key, assignment: e.assignment, record: e.record, task: cached?.key === key ? cached.task : null };
      });
      if (ready.kind === 'empty') return { kind: 'empty', task: null };
      return { kind: 'restored', task: ready.task ?? await construct(ready.key, ready.assignment, ready.record) };
    })();
    restoring = work;
    work.then(() => { if (restoring === work) restoring = null; }, () => { if (restoring === work) restoring = null; });
    return work;
  }
  return {
    async start(body) {
      try { validateBaseStart(body); } catch { return fail('invalid_request'); }
      const ready = await serial(async () => {
        const old = await state();
        if (old.activeKey === null) return { kind: 'new' as const, ...await admit(old, 'initial') };
        const e = old.admissions[old.activeKey]!;
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
    async prepareNext(id) {
      const ready = await serial(async () => {
        const old = await state();
        if (typeof id !== 'string' || !UUID.test(id)) return fail('not_found');
        const predecessor = await archived(id);
        if (!predecessor) return fail('not_found');
        if (predecessor.status !== 'completed') return fail('busy');
        const key: AdmissionKey = `after:${id}`, existing = old.admissions[key];
        if (existing) {
          if (existing.status === 'failed' && existing.record === null && existing.errorCode === 'record_deleted') return fail('not_found');
          if (existing.status === 'preparing') return fail('busy');
          if (existing.status === 'failed' || !existing.record) return fail();
          if (!await archived(existing.record.recordId)) return fail('not_found');
          return { kind: 'existing' as const, recordId: existing.record.recordId };
        }
        if (old.activeKey === null) return fail('not_found');
        const current = old.admissions[old.activeKey]!;
        if (current.status === 'preparing') return fail('busy');
        if (current.status === 'failed' || !current.record) return fail();
        if (current.record.status !== 'completed') return fail('busy');
        if (current.record.recordId !== id) return fail('not_found');
        return { kind: 'new' as const, ...await admit(old, key) };
      });
      if (ready.kind === 'existing') return { kind: 'existing', recordId: ready.recordId, participantPath: '/' };
      const task = await construct(ready.key, ready.assignment, null);
      return { kind: 'created', recordId: task.getState().sessionId as string, participantPath: '/' };
    },
  };
}
