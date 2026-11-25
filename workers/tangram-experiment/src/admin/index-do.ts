import { DurableObject } from "cloudflare:workers";
import type { AdminSummary } from "./summary";
import { getSummary, listAudit, listPage, removeSummaries, upsertSummary } from "./index-store.ts";
import type { AuditEntry, DeletionReason } from "./index-store.ts";
import { formatReceptionNumber, receptionNumberDay } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { ReceptionSummary } from '../../../../dialogue-model/runtime/v2/reception.ts';
import { modeHistory, protocolHistory, readSettings, saveMode, saveProtocol } from './reception-settings.ts';
import type { ModeEntry, ProtocolEntry, ReceptionSettings, SaveResult } from './reception-settings.ts';

/**
 * One global, researcher-only index of trial summaries keyed by recordId
 * (allowlisted, no PII). Entries are removed only together with their record;
 * see index-store.ts for the storage layout and the audit log.
 */
export class AdminIndex extends DurableObject {
  /** Researcher reception settings: one consistent snapshot of protocol and mode (see reception-settings.ts). */
  async readReceptionSettings(): Promise<ReceptionSettings> { return this.ctx.storage.transaction(tx => readSettings(tx)); }
  async saveReceptionProtocol(input: { expectedRevision: unknown; fields: unknown }): Promise<SaveResult> {
    return this.ctx.storage.transaction(tx => saveProtocol(tx, input, Date.now(), () => crypto.randomUUID()));
  }
  async saveReceptionMode(input: { expectedRevision: unknown; value: unknown }): Promise<SaveResult> {
    return this.ctx.storage.transaction(tx => saveMode(tx, input, Date.now()));
  }
  async receptionProtocolHistory(): Promise<ProtocolEntry[]> { return protocolHistory(this.ctx.storage); }
  async receptionModeHistory(): Promise<ModeEntry[]> { return modeHistory(this.ctx.storage); }
  async upsertReception(summary: ReceptionSummary): Promise<boolean> {
    return this.ctx.storage.transaction(async tx => {
      const key = 'reception:' + summary.receptionId, old = await tx.get<ReceptionSummary>(key);
      if (old && old.revision >= summary.revision) return false;
      await tx.put({ [key]: summary }); return true;
    });
  }
  async getReception(id: string): Promise<ReceptionSummary | null> { return await this.ctx.storage.get<ReceptionSummary>('reception:' + id) ?? null; }
  async listReceptions(): Promise<ReceptionSummary[]> {
    const rows = await this.ctx.storage.list<ReceptionSummary>({ prefix:'reception:' });
    return [...rows].filter(([key]) => /^reception:[a-f0-9-]{36}$/u.test(key)).map(([, row]) => row)
      .sort((a,b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt) || a.receptionId.localeCompare(b.receptionId));
  }
  async allocateReceptionNumber(format: string, now: number): Promise<string | null> {
    const day = receptionNumberDay(format, now), key = 'reception:number:' + format + ':' + day;
    return this.ctx.storage.transaction(async tx => {
      const previous = await tx.get<number>(key) ?? 0;
      const next = previous + 1, number = formatReceptionNumber(format,next);
      if (number !== null) await tx.put({ [key]: next });
      return number;
    });
  }
  async upsert(summary: AdminSummary): Promise<boolean> { return upsertSummary(this.ctx.storage, summary); }
  async get(recordId: string): Promise<AdminSummary | null> { return getSummary(this.ctx.storage, recordId); }
  async page(after: string | null): Promise<{ items: AdminSummary[]; next: string | null }> { return listPage(this.ctx.storage, after); }
  async remove(recordIds: string[], reason: DeletionReason): Promise<number> { return removeSummaries(this.ctx.storage, recordIds, reason, Date.now()); }
  async audit(): Promise<AuditEntry[]> { return listAudit(this.ctx.storage); }
}
