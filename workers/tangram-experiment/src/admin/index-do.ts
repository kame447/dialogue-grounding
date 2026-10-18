import { DurableObject } from "cloudflare:workers";
import type { AdminSummary } from "./summary";
import { getSummary, listAudit, listPage, removeSummaries, upsertSummary } from "./index-store.ts";
import type { AuditEntry, DeletionReason } from "./index-store.ts";

/**
 * One global, researcher-only index of trial summaries keyed by recordId
 * (allowlisted, no PII). Entries are removed only together with their record;
 * see index-store.ts for the storage layout and the audit log.
 */
export class AdminIndex extends DurableObject {
  async upsert(summary: AdminSummary): Promise<boolean> { return upsertSummary(this.ctx.storage, summary); }
  async get(recordId: string): Promise<AdminSummary | null> { return getSummary(this.ctx.storage, recordId); }
  async page(after: string | null): Promise<{ items: AdminSummary[]; next: string | null }> { return listPage(this.ctx.storage, after); }
  async remove(recordIds: string[], reason: DeletionReason): Promise<number> { return removeSummaries(this.ctx.storage, recordIds, reason, Date.now()); }
  async audit(): Promise<AuditEntry[]> { return listAudit(this.ctx.storage); }
}
