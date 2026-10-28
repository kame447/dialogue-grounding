import { createHash } from 'node:crypto';
import type { Strategy } from './base-assignment.ts';

export type ReceptionProtocol = { schemaVersion: 'reception_protocol_v1'; protocolId: string; revision: number;
  allowedOrders: Strategy[][]; seedPolicy: 'shared' | 'per_trial'; referenceMemory: boolean;
  betweenTrials: 'none'; receptionNumberFormat: 'daily_seq3' };
export type ReceptionPlan = { schemaVersion: 'reception_plan_v1'; protocolId: string; protocolRevision: number;
  protocolSha256: string; order: Strategy[]; trials: { index: number; strategy: Strategy; seed: number; referenceMemory: boolean }[]; approvedAt: string };
export type ReceptionStatus = 'pending' | 'approved' | 'in_progress' | 'finished' | 'cancelled';
export type Reception = { schemaVersion: 'reception_v1'; receptionId: string; objectId: string; createdAt: string;
  number: string | null; status: ReceptionStatus; plan: ReceptionPlan | null; revision: number;
  trials: { index: number; recordId: string | null }[] };
export type ReceptionSummary = Pick<Reception, 'receptionId' | 'objectId' | 'createdAt' | 'number' | 'status' | 'revision' | 'trials'>;
export type ReceptionErrorCode = 'protocol_unconfigured' | 'reception_conflict' | 'invalid_order' | 'reception_unavailable' |
  'reception_not_approved' | 'trial_changed' | 'reception_finished';
export class ReceptionError extends Error {
  readonly code: ReceptionErrorCode;
  constructor(code: ReceptionErrorCode) { super(code); this.name = 'ReceptionError'; this.code = code; }
}
const fail = (code: ReceptionErrorCode = 'reception_unavailable'): never => { throw new ReceptionError(code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const owner = /^[a-f0-9]{64}$/u;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const strategy = (v: unknown): v is Strategy => v === 'repair-first' || v === 'bypass-enabled';
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(k => typeof k !== 'string' || !keys.includes(k))) return fail();
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return fail(); }
  return value as Record<string, any>;
}
function order(value: unknown): Strategy[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(v => !strategy(v)) || new Set(value).size !== value.length) return fail();
  return [...value];
}
/** No defaults: absent, malformed and unknown versions all fail closed. */
export function validateReceptionProtocol(value: unknown): ReceptionProtocol {
  try {
    const p = object(value, ['schemaVersion','protocolId','revision','allowedOrders','seedPolicy','referenceMemory','betweenTrials','receptionNumberFormat']);
    if (p.schemaVersion !== 'reception_protocol_v1' || !uuid.test(p.protocolId) || !int(p.revision) || p.revision < 1 ||
      !Array.isArray(p.allowedOrders) || !p.allowedOrders.length || !['shared','per_trial'].includes(p.seedPolicy) ||
      typeof p.referenceMemory !== 'boolean' || p.betweenTrials !== 'none' || p.receptionNumberFormat !== 'daily_seq3') return fail();
    return { schemaVersion: 'reception_protocol_v1', protocolId: p.protocolId, revision: p.revision,
      allowedOrders: p.allowedOrders.map(order), seedPolicy: p.seedPolicy, referenceMemory: p.referenceMemory,
      betweenTrials: 'none', receptionNumberFormat: p.receptionNumberFormat };
  } catch { return fail('protocol_unconfigured'); }
}
export function canonicalReceptionProtocol(value: unknown): string { return JSON.stringify(validateReceptionProtocol(value)); }
export function validateReceptionPlan(value: unknown): ReceptionPlan {
  try {
    const p = object(value, ['schemaVersion','protocolId','protocolRevision','protocolSha256','order','trials','approvedAt']);
    const strategies = order(p.order);
    if (p.schemaVersion !== 'reception_plan_v1' || !uuid.test(p.protocolId) || !int(p.protocolRevision) || p.protocolRevision < 1 ||
      typeof p.protocolSha256 !== 'string' || !owner.test(p.protocolSha256) || !iso(p.approvedAt) ||
      !Array.isArray(p.trials) || p.trials.length !== strategies.length) return fail();
    const trials = p.trials.map((raw: unknown, index: number) => {
      const t = object(raw, ['index','strategy','seed','referenceMemory']);
      if (t.index !== index || t.strategy !== strategies[index] || !int(t.seed) || typeof t.referenceMemory !== 'boolean') return fail();
      return { index, strategy: strategies[index], seed: t.seed, referenceMemory: t.referenceMemory };
    });
    return { schemaVersion: 'reception_plan_v1', protocolId: p.protocolId, protocolRevision: p.protocolRevision,
      protocolSha256: p.protocolSha256, order: strategies, trials, approvedAt: p.approvedAt };
  } catch { return fail(); }
}
export function validateReception(value: unknown): Reception {
  try {
    const r = object(value, ['schemaVersion','receptionId','objectId','createdAt','number','status','plan','revision','trials']);
    if (r.schemaVersion !== 'reception_v1' || !uuid.test(r.receptionId) || !owner.test(r.objectId) || !iso(r.createdAt) ||
      r.number !== null && (typeof r.number !== 'string' || !/^\d{3}$/u.test(r.number)) ||
      !['pending','approved','in_progress','finished','cancelled'].includes(r.status) || !int(r.revision) || r.revision < 0 || !Array.isArray(r.trials)) return fail();
    const plan = r.plan === null ? null : validateReceptionPlan(r.plan);
    const trials = r.trials.map((raw: unknown, index: number) => {
      const t = object(raw, ['index','recordId']);
      if (t.index !== index || !plan || index >= plan.trials.length || t.recordId !== null && !uuid.test(t.recordId)) return fail();
      return { index, recordId: t.recordId as string | null };
    });
    if (r.status === 'pending' && (plan || trials.length) || ['approved','in_progress','finished'].includes(r.status) && !plan ||
      ['approved','cancelled'].includes(r.status) && trials.length || r.status === 'in_progress' && !trials.length ||
      r.status === 'finished' && (!plan || trials.length !== plan.trials.length || trials.some((t: {recordId: string|null}) => !t.recordId))) return fail();
    return { schemaVersion:'reception_v1', receptionId:r.receptionId, objectId:r.objectId, createdAt:r.createdAt,
      number:r.number, status:r.status, plan, revision:r.revision, trials };
  } catch { return fail(); }
}
export function createReception(input: { receptionId: string; objectId: string; createdAt: string; number: string | null }): Reception {
  return validateReception({ schemaVersion:'reception_v1', ...input, status:'pending', plan:null, revision:0, trials:[] });
}
export async function approveReception(value: unknown, options: { expectedRevision: number; order: number; protocol: unknown; approvedAt: string; randomSeed: () => number }): Promise<Reception> {
  const r = validateReception(value), p = validateReceptionProtocol(options.protocol);
  if (r.status !== 'pending' || r.revision !== options.expectedRevision) return fail('reception_conflict');
  if (!int(options.order) || !p.allowedOrders[options.order]) return fail('invalid_order');
  const selected = p.allowedOrders[options.order], seeds = selected.map((_, i) => i === 0 || p.seedPolicy === 'per_trial' ? options.randomSeed() : null);
  const plan = validateReceptionPlan({ schemaVersion:'reception_plan_v1', protocolId:p.protocolId, protocolRevision:p.revision,
    protocolSha256:createHash('sha256').update(canonicalReceptionProtocol(p)).digest('hex'), order:selected,
    trials:selected.map((strategy, index) => ({ index, strategy, seed:seeds[index] ?? seeds[0], referenceMemory:p.referenceMemory })), approvedAt:options.approvedAt });
  return validateReception({ ...r, status:'approved', plan, revision:r.revision+1 });
}
export function cancelReception(value: unknown, expectedRevision: number): Reception {
  const r = validateReception(value);
  if (!['pending','approved'].includes(r.status) || r.trials.length || r.revision !== expectedRevision) return fail('reception_conflict');
  return validateReception({ ...r, status:'cancelled', revision:r.revision+1 });
}
export function participantReception(value: unknown) {
  const r = validateReception(value);
  const status = ({ pending:'waiting', approved:'ready', in_progress:'in_progress', finished:'finished', cancelled:'unavailable' } as const)[r.status];
  return { number:r.number, status, revision:r.revision };
}
export function receptionSummary(value: unknown): ReceptionSummary {
  const r = validateReception(value);
  return { receptionId:r.receptionId, objectId:r.objectId, number:r.number, createdAt:r.createdAt, status:r.status, revision:r.revision, trials:r.trials };
}
/** Supported mechanism only: researchers select a format in their protocol. */
const numberFormats = {
  daily_seq3: { format: (seq: number) => seq <= 999 ? String(seq).padStart(3,'0') : null,
    day: (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0,10) },
};
export function formatReceptionNumber(format: string, seq: number): string | null {
  if (format !== 'daily_seq3' || !int(seq) || seq < 1) return fail();
  return numberFormats[format].format(seq);
}
export function receptionNumberDay(format: string, ms: number): string {
  if (format !== 'daily_seq3' || !int(ms) || !Number.isFinite(new Date(ms).getTime())) return fail();
  return numberFormats[format].day(ms);
}
