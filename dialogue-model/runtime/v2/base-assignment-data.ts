// Shared validation internals. node:crypto is already available to the Worker
// under its existing nodejs_compat flag (also used by the stimulus generator).
import { createHash } from 'node:crypto';
import type { BaseAssignmentConfig, BaseAssignment, BaseRecord, BaseOwnerState } from './base-assignment.ts';
import { validateReceptionPlan } from './reception.ts';
export type BaseAssignmentErrorCode = 'invalid_request' | 'assignment_unconfigured' | 'assignment_invalid' |
  'assignment_conflict' | 'assignment_record_invalid';
export class BaseAssignmentError extends Error {
  readonly code: BaseAssignmentErrorCode;
  constructor(code: BaseAssignmentErrorCode) { super(code); this.name = 'BaseAssignmentError'; this.code = code; }
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const OWNER = /^[a-f0-9]{64}$/u;
const SHA = OWNER;
export function data(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('shape');
  const names = Reflect.ownKeys(value);
  if (names.some(k => typeof k !== 'string') || keys && (names.length !== keys.length || names.some(k => !keys.includes(k as string)))) throw new Error('keys');
  const out: Record<string, unknown> = {};
  for (const key of names as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('data');
    Object.defineProperty(out, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
export const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const positive = (v: unknown): v is number => safeInt(v) && v > 0;
const strategy = (v: unknown) => v === 'repair-first' || v === 'bypass-enabled';
function guard<T>(code: BaseAssignmentErrorCode, fn: () => T): T { try { return fn(); } catch { throw new BaseAssignmentError(code); } }
export function validateBaseAssignmentConfig(value: unknown): BaseAssignmentConfig {
  return guard(value === null || value === undefined ? 'assignment_unconfigured' : 'assignment_invalid', () => {
    const c = data(value);
    if (!Object.hasOwn(c, 'referenceMemory')) c.referenceMemory = true;
    data(c, ['schemaVersion', 'configId', 'revision', 'strategy', 'seed', 'referenceMemory']);
    if (c.schemaVersion !== 'base_assignment_config_v1' || typeof c.configId !== 'string' || !V4.test(c.configId) ||
        !positive(c.revision) || !strategy(c.strategy) || !safeInt(c.seed) || typeof c.referenceMemory !== 'boolean') throw new Error('value');
    return Object.freeze({ schemaVersion: 'base_assignment_config_v1', configId: c.configId, revision: c.revision,
      strategy: c.strategy, seed: c.seed, referenceMemory: c.referenceMemory }) as BaseAssignmentConfig;
  });
}
export function validateBaseStart(value: unknown): Readonly<{ version: 2 }> {
  return guard('invalid_request', () => { const b = data(value, ['version']); if (b.version !== 2) throw new Error('version'); return Object.freeze({ version: 2 }); });
}
export function canonicalBaseAssignmentConfig(value: unknown): string { return JSON.stringify(validateBaseAssignmentConfig(value)); }
export function configFromAssignment(a: BaseAssignment): BaseAssignmentConfig {
  if (a.source.kind !== 'server_config_v1') throw new BaseAssignmentError('assignment_record_invalid');
  return validateBaseAssignmentConfig({ schemaVersion: 'base_assignment_config_v1', configId: a.source.configId,
    revision: a.source.revision, strategy: a.strategy, seed: a.seed, referenceMemory: a.referenceMemory });
}
export function readAssignment(value: unknown): BaseAssignment {
  return guard('assignment_record_invalid', () => {
    const a = data(value, ['schemaVersion', 'assignmentId', 'strategy', 'seed', 'referenceMemory', 'source', 'createdAt']);
    const rawSource = data(a.source);
    if (rawSource.kind === 'reception_plan_v1') {
      const s = data(rawSource, ['kind','adapter','receptionId','protocolId','protocolRevision','protocolSha256','trialIndex','plan']);
      const plan = validateReceptionPlan(s.plan);
      if (!safeInt(s.trialIndex) || s.trialIndex < 0 || s.trialIndex >= plan.trials.length) throw new Error('index');
      const t = plan.trials[s.trialIndex];
      if (a.schemaVersion !== 'base_assignment_v1' || typeof a.assignmentId !== 'string' || !V4.test(a.assignmentId) ||
        s.adapter !== 'worker_binding' || typeof s.receptionId !== 'string' || !V4.test(s.receptionId) ||
        s.protocolId !== plan.protocolId || s.protocolRevision !== plan.protocolRevision || s.protocolSha256 !== plan.protocolSha256 ||
        a.strategy !== t.strategy || a.seed !== t.seed || a.referenceMemory !== t.referenceMemory ||
        typeof a.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(a.createdAt) || new Date(a.createdAt).toISOString() !== a.createdAt) throw new Error('assignment');
      return Object.freeze({ schemaVersion:'base_assignment_v1', assignmentId:a.assignmentId, strategy:a.strategy,
        seed:a.seed, referenceMemory:a.referenceMemory, source:Object.freeze({ kind:'reception_plan_v1', adapter:s.adapter,
          receptionId:s.receptionId, protocolId:s.protocolId, protocolRevision:s.protocolRevision, protocolSha256:s.protocolSha256,
          trialIndex:s.trialIndex, plan }), createdAt:a.createdAt }) as BaseAssignment;
    }
    // Preserve every existing server_config_v1 field and digest validation.
    const s = data(rawSource, ['kind', 'adapter', 'configId', 'revision', 'configSha256']);
    if (a.schemaVersion !== 'base_assignment_v1' || typeof a.assignmentId !== 'string' || !V4.test(a.assignmentId) ||
        !strategy(a.strategy) || !safeInt(a.seed) || typeof a.referenceMemory !== 'boolean' || s.kind !== 'server_config_v1' ||
        !['local_private_file', 'worker_binding'].some(v => v === s.adapter) || typeof s.configId !== 'string' || !V4.test(s.configId) ||
        !positive(s.revision) || typeof s.configSha256 !== 'string' || !SHA.test(s.configSha256) || typeof a.createdAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(a.createdAt) || new Date(a.createdAt).toISOString() !== a.createdAt) throw new Error('assignment');
    const result = { schemaVersion: 'base_assignment_v1', assignmentId: a.assignmentId, strategy: a.strategy, seed: a.seed, referenceMemory: a.referenceMemory, source: Object.freeze({ kind: s.kind, adapter: s.adapter, configId: s.configId, revision: s.revision, configSha256: s.configSha256 }), createdAt: a.createdAt } as BaseAssignment;
    const canonical = canonicalBaseAssignmentConfig(configFromAssignment(result));
    if (createHash('sha256').update(canonical).digest('hex') !== s.configSha256) throw new Error('digest');
    return Object.freeze(result);
  });
}
export function validateBoundBaseRecord(record: unknown, assignment: unknown): void {
  guard('assignment_record_invalid', () => {
    const a = readAssignment(assignment), r = data(record), own = readAssignment(r.assignment), options = data(r.options), queue = data(r.queueState);
    if (typeof r.recordId !== 'string' || !UUID.test(r.recordId) || r.version !== 2 || r.seed !== a.seed || r.strategy !== a.strategy ||
        options.referenceMemory !== a.referenceMemory || !['dialogue', 'submitting', 'completed'].some(v => v === r.status) ||
        !Array.isArray(queue.pendingHumanEventIds) || queue.pendingHumanEventIds.some(v => typeof v !== 'string') ||
        queue.errorCode !== null && typeof queue.errorCode !== 'string' || JSON.stringify(own) !== JSON.stringify(a)) throw new Error('record');
  });
}
/** Detached owner state: never trust a saved active pointer without its envelope. */
export function readOwner(value: unknown, ownerId: string): BaseOwnerState {
  return guard('assignment_record_invalid', () => {
    const o = data(value, ['schemaVersion', 'ownerId', 'revision', 'activeKey', 'admissions']), admissions = data(o.admissions);
    if (!OWNER.test(ownerId) || o.schemaVersion !== 'base_owner_v1' || o.ownerId !== ownerId || !safeInt(o.revision) || o.revision < 0 ||
        o.activeKey !== null && (typeof o.activeKey !== 'string' || !Object.hasOwn(admissions, o.activeKey))) throw new Error('owner');
    if (o.activeKey === null && Object.keys(admissions).length) throw new Error('pointer');
    const assignmentIds = new Set<string>(), recordIds = new Set<string>();
    for (const [key, v] of Object.entries(admissions)) {
      if (key !== 'initial' && (!key.startsWith('after:') || !UUID.test(key.slice(6)))) throw new Error('key');
      const e = data(v, ['schemaVersion', 'assignment', 'status', 'record', 'errorCode']), a = readAssignment(e.assignment);
      if (e.schemaVersion !== 'base_assigned_session_v1' || assignmentIds.has(a.assignmentId)) throw new Error('assignment'); assignmentIds.add(a.assignmentId);
      if (e.status === 'active' ? e.record === null || e.errorCode !== null : e.status === 'preparing' ? e.errorCode !== null :
          e.status !== 'failed' || !['start_interrupted', 'initialization_failed', 'record_write_failed', 'assignment_record_invalid', 'record_deleted'].some(c => c === e.errorCode)) throw new Error('status');
      if (e.errorCode === 'record_deleted' && e.record !== null) throw new Error('deleted');
      if (e.record !== null) { validateBoundBaseRecord(e.record, a); const id = (e.record as BaseRecord).recordId; if (recordIds.has(id)) throw new Error('record'); recordIds.add(id); }
    }
    return structuredClone(value) as BaseOwnerState;
  });
}
