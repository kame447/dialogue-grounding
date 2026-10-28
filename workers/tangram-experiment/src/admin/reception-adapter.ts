import { ReceptionError, validateReception, effectiveRotationMode, effectiveBetweenTrials } from '../../../../dialogue-model/runtime/v2/reception.ts';
import { validateReceptionSettings } from './reception-settings.ts';
import type { Reception, ReceptionSummary } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { DisplayedProtocol, ReceptionAdminPort, ReceptionAdminRow, ReceptionAdminResult, ReceptionSettingsPort } from './reception-port.ts';
import { OBJECT_ID, RECORD_ID } from './summary.ts';

type Owner = {
  adminReception(): Promise<Reception | null>;
  adminApproveReception(input: { expectedRevision: number; order: number; protocol: DisplayedProtocol }): Promise<Reception>;
  adminCancelReception(input: { expectedRevision: number }): Promise<Reception>;
};
type Index = {
  listReceptions(): Promise<ReceptionSummary[]>;
  getReception(id: string): Promise<ReceptionSummary | null>;
};
type Options = { index: Index; owner(objectId: string): Owner | null; readSettings(): Promise<unknown> };
const PAGE_SIZE = 100;

/** Management values always come from the owning DO, never from index extras. */
function project(r: Reception): ReceptionAdminRow {
  return { receptionId:r.receptionId, number:r.number, createdAt:r.createdAt, status:r.status, revision:r.revision,
    plan:r.plan ? { order:[...r.plan.order], rotationMode:effectiveRotationMode(r.plan, 0), betweenTrials:effectiveBetweenTrials(r.plan) } : null,
    trials:r.trials.map(t => ({...t})) };
}
function failure(error: unknown): ReceptionAdminResult {
  // RPC Error objects need not preserve custom .code properties. Accept only
  // the closed error messages emitted by the owner, never reflect raw text.
  const code = error instanceof ReceptionError ? error.code : error instanceof Error ? error.message : null;
  switch (code) {
    case 'not_found': return { ok:false, error:'not_found' };
    case 'reception_conflict': return { ok:false, error:'conflict' };
    case 'invalid_order': return { ok:false, error:'invalid_order' };
    case 'protocol_unconfigured': return { ok:false, error:'protocol_unconfigured' };
    case 'protocol_changed': return { ok:false, error:'protocol_changed' };
    case 'reception_closed': return { ok:false, error:'reception_closed' };
    default: return { ok:false, error:'reception_unavailable' };
  }
}
export function createReceptionAdminPort(options: Options): ReceptionAdminPort {
  async function resolve(summary: ReceptionSummary | null, requestedId: string) {
    if (!summary || !RECORD_ID.test(requestedId) || summary.receptionId !== requestedId || !OBJECT_ID.test(summary.objectId)) return null;
    const owner = options.owner(summary.objectId);
    if (!owner) return null;
    const raw = await owner.adminReception();
    if (raw === null) return null;
    // workerd adds a non-enumerable Symbol.dispose to RPC results; keep only the structured data, then validate it as before.
    const reception = validateReception(structuredClone(raw));
    if (reception.receptionId !== requestedId || reception.objectId !== summary.objectId) return null;
    return { owner, reception };
  }
  async function lookup(id: string) {
    return RECORD_ID.test(id) ? resolve(await options.index.getReception(id),id) : null;
  }
  async function mutate(id: string, action: (owner: Owner) => Promise<unknown>): Promise<ReceptionAdminResult> {
    try {
      const resolved = await lookup(id);
      if (!resolved) return { ok:false, error:'not_found' };
      await action(resolved.owner);
      return { ok:true };
    } catch (error) { return failure(error); }
  }
  return {
    async protocol() {
      // Transport attributes (workerd's Symbol.dispose) are dropped before strict validation; damage throws.
      const s = validateReceptionSettings(structuredClone(await options.readSettings()));
      if (!s.protocol) return { configured:false, mode:s.mode.value };
      const p = s.protocol.protocol;
      return { configured:true, mode:s.mode.value, protocolId:p.protocolId, revision:s.protocol.revision, sha256:s.protocol.sha256,
        allowedOrders:p.allowedOrders, rotationMode:p.rotationMode, betweenTrials:p.betweenTrials };
    },
    async listPage(after) {
      const summaries = await options.index.listReceptions();
      const position = after ? summaries.findIndex(r => r.receptionId === after) : -1;
      const start = position + 1, page = summaries.slice(start,start+PAGE_SIZE), items: ReceptionAdminRow[] = [];
      const seen = new Set<string>();
      for (const summary of page) {
        if (seen.has(summary.receptionId)) continue;
        const resolved = await resolve(summary,summary.receptionId);
        if (!resolved) continue;
        seen.add(resolved.reception.receptionId); items.push(project(resolved.reception));
      }
      return { items, next:start+PAGE_SIZE < summaries.length ? page.at(-1)!.receptionId : null };
    },
    async version(since) {
      // Change detection only: index rows and settings are hashed, never shown; management values still come from the owner.
      const [rows, settings] = await Promise.all([options.index.listReceptions(), options.readSettings()]);
      const s = validateReceptionSettings(structuredClone(settings)), list = structuredClone(rows);
      if (!Array.isArray(list)) throw new Error('reception_unavailable');
      const material = JSON.stringify({ receptions: list.map(r => [r?.receptionId, r?.number, r?.status, r?.revision,
        Array.isArray(r?.trials) ? r.trials.map(t => t?.recordId ?? null) : null]),
        protocol: s.protocol ? [s.protocol.revision, s.protocol.sha256] : null, mode: [s.mode.value, s.mode.revision] });
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
      // Only the few index rows that could be new are confirmed with their owner, so a lost index update
      // (e.g. a cancellation) does not keep counting them.
      let newPending: number | null = null;
      if (since !== null) {
        newPending = 0;
        for (const row of list) {
          if (row?.status !== 'pending' || typeof row?.createdAt !== 'string' || row.createdAt < since) continue;
          if ((await resolve(row, row.receptionId))?.reception.status === 'pending') newPending++;
        }
      }
      return { version: [...digest].map(b => b.toString(16).padStart(2, '0')).join(''), newPending };
    },
    async get(id) { const result = await lookup(id); return result ? project(result.reception) : null; },
    approve:(id,input) => mutate(id,owner => owner.adminApproveReception(input)),
    cancel:(id,input) => mutate(id,owner => owner.adminCancelReception(input)),
  };
}

type SettingsIndex = {
  readReceptionSettings(): Promise<unknown>; receptionProtocolHistory(): Promise<unknown>; receptionModeHistory(): Promise<unknown>;
  saveReceptionProtocol(input: unknown): Promise<unknown>; saveReceptionMode(input: unknown): Promise<unknown>;
};
const SAVE_ERRORS = ['conflict', 'invalid', 'protocol_unconfigured', 'unavailable'];
function saveResult(value: unknown) {
  const v = structuredClone(value) as { ok?: unknown; error?: unknown };
  if (v?.ok === true) return { ok:true as const };
  return { ok:false as const, error:typeof v?.error === 'string' && SAVE_ERRORS.includes(v.error) ? v.error : 'unavailable' };
}
export function createReceptionSettingsPort(index: SettingsIndex): ReceptionSettingsPort {
  return {
    async read() {
      const settings = validateReceptionSettings(structuredClone(await index.readReceptionSettings()));
      return { ...settings, protocolHistory:structuredClone(await index.receptionProtocolHistory()) as never,
        modeHistory:structuredClone(await index.receptionModeHistory()) as never };
    },
    async saveProtocol(input) { return saveResult(await index.saveReceptionProtocol(input)); },
    async saveMode(input) { return saveResult(await index.saveReceptionMode(input)); },
  };
}
