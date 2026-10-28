import { ReceptionError, validateReception, validateReceptionProtocol } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { Reception, ReceptionSummary } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { ReceptionAdminPort, ReceptionAdminRow, ReceptionAdminResult } from './reception-port.ts';
import { OBJECT_ID, RECORD_ID } from './summary.ts';

type Owner = {
  adminReception(): Promise<Reception | null>;
  adminApproveReception(input: { expectedRevision: number; order: number }): Promise<Reception>;
  adminCancelReception(input: { expectedRevision: number }): Promise<Reception>;
};
type Index = {
  listReceptions(): Promise<ReceptionSummary[]>;
  getReception(id: string): Promise<ReceptionSummary | null>;
};
type Options = { index: Index; owner(objectId: string): Owner | null; readProtocol(): unknown };
const PAGE_SIZE = 100;

/** Management values always come from the owning DO, never from index extras. */
function project(r: Reception): ReceptionAdminRow {
  return { receptionId:r.receptionId, number:r.number, createdAt:r.createdAt, status:r.status, revision:r.revision,
    plan:r.plan ? { order:[...r.plan.order] } : null, trials:r.trials.map(t => ({...t})) };
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
      try {
        const p = validateReceptionProtocol(options.readProtocol());
        return { configured:true, protocolId:p.protocolId, revision:p.revision, allowedOrders:p.allowedOrders };
      } catch { return { configured:false }; }
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
    async get(id) { const result = await lookup(id); return result ? project(result.reception) : null; },
    approve:(id,input) => mutate(id,owner => owner.adminApproveReception(input)),
    cancel:(id,input) => mutate(id,owner => owner.adminCancelReception(input)),
  };
}
