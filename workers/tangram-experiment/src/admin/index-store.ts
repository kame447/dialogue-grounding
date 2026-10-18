// Researcher-only index of trial summaries, keyed by recordId, in one global
// Durable Object. Pure over a minimal storage interface, testable in Node.
//   "r:<recordId>"               summary (allowlisted, PII-free)
//   "u:<descending time>:<id>"   ordering key for pagination by last update
//   "d:<hash>"                   deleted marker: a deleted id is never indexed again
//   "a:<deletedAt>:<hash>"       audit entry {recordHash, deletedAt, reason}; no content
// Entries live exactly as long as their record: removed only together with it
// (retention expiry or researcher deletion). No cap, no trim.
import type { AdminSummary } from "./summary";

export type IndexStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options: { prefix: string; startAfter?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
};
export type DeletionReason = "admin" | "retention";
export type AuditEntry = { recordHash: string; deletedAt: string; reason: DeletionReason };

export const PAGE_SIZE = 100;
const MAX_TIME = 9_999_999_999_999;
const CURSOR = /^u:\d{13}:[0-9a-f-]{36}$/;

const orderKey = (summary: AdminSummary) => {
  const ms = Date.parse(String(summary.updatedAt));
  return `u:${String(MAX_TIME - (Number.isFinite(ms) ? ms : 0)).padStart(13, "0")}:${summary.recordId}`;
};

/** Content-free reference to a deleted trial: a truncated SHA-256 of its recordId. */
export async function recordHash(recordId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tangram-record:" + recordId)));
  return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Adds or refreshes a summary; ignored for an id that was already deleted. */
export async function upsertSummary(storage: IndexStorage, summary: AdminSummary): Promise<boolean> {
  if (await storage.get("d:" + await recordHash(summary.recordId))) return false;
  const previous = await storage.get<AdminSummary>("r:" + summary.recordId);
  const key = orderKey(summary);
  if (previous && orderKey(previous) !== key) await storage.delete([orderKey(previous)]);
  await storage.put({ ["r:" + summary.recordId]: summary, [key]: summary.recordId });
  return true;
}

export async function getSummary(storage: IndexStorage, recordId: string): Promise<AdminSummary | null> {
  return (await storage.get<AdminSummary>("r:" + recordId)) ?? null;
}

/** Newest first, PAGE_SIZE per page; `after` is the opaque cursor from the previous page. */
export async function listPage(storage: IndexStorage, after: string | null = null, limit = PAGE_SIZE):
  Promise<{ items: AdminSummary[]; next: string | null }> {
  const keys = await storage.list<string>({ prefix: "u:", ...(after && CURSOR.test(after) ? { startAfter: after } : {}), limit: limit + 1 });
  const entries = [...keys.entries()];
  const page = entries.slice(0, limit);
  const items: AdminSummary[] = [];
  for (const [, id] of page) { const summary = await getSummary(storage, id); if (summary) items.push(summary); }
  return { items, next: entries.length > limit ? page.at(-1)![0] : null };
}

/** Removes entries together with their records and appends one audit entry per removed id. */
export async function removeSummaries(storage: IndexStorage, recordIds: readonly string[], reason: DeletionReason, now: number): Promise<number> {
  let removed = 0;
  for (const recordId of recordIds) {
    const hash = await recordHash(recordId);
    const previous = await storage.get<AdminSummary>("r:" + recordId);
    if (previous) await storage.delete(["r:" + recordId, orderKey(previous)]);
    if (await storage.get("d:" + hash)) continue;
    const deletedAt = new Date(now).toISOString();
    const entry: AuditEntry = { recordHash: hash, deletedAt, reason };
    await storage.put({ ["d:" + hash]: true, [`a:${deletedAt}:${hash}`]: entry });
    removed++;
  }
  return removed;
}

export async function listAudit(storage: IndexStorage, limit = 50): Promise<AuditEntry[]> {
  return [...(await storage.list<AuditEntry>({ prefix: "a:", reverse: true, limit })).values()];
}
