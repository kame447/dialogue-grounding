// Researcher-only index of trial summaries, keyed by recordId, in one global
// Durable Object. Pure over a minimal storage interface, testable in Node.
//   "r:<recordId>"               summary (allowlisted, PII-free)
//   "u:<descending time>:<id>"   ordering key for pagination by last update
//   "d:<hash>"                   deleted marker: a deleted id is never indexed again
//   "a:<deletedAt>:<hash>"       audit entry {recordHash, deletedAt, reason}; no content
// Entries live exactly as long as their record: removed only together with it
// (retention expiry or researcher deletion). No cap, no trim.
import { RECORD_ID } from "./summary.ts";
import type { AdminSummary } from "./summary.ts";
import { isParticipantRole, participantRoleView, readParticipantRoleEntry } from "./participant-role.ts";
import type { ParticipantRole, ParticipantRoleAudit, ParticipantRoleEntry } from "./participant-role.ts";

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
  const hash = await recordHash(summary.recordId);
  if (await storage.get("d:" + hash)) return false;
  const previous = await storage.get<AdminSummary>("r:" + summary.recordId);
  const key = orderKey(summary);
  if (previous && orderKey(previous) !== key) await storage.delete([orderKey(previous)]);
  await storage.put({ ["r:" + summary.recordId]: summary, [key]: summary.recordId });
  return true;
}

export async function getSummary(storage: IndexStorage, recordId: string): Promise<AdminSummary | null> {
  return (await storage.get<AdminSummary>("r:" + recordId)) ?? null;
}

const participantRoleKey = (recordId: string) => "participant-role:" + recordId;
export const PARTICIPANT_ROLE_REVISION = "participant-role-revision";

/** A classification is joined at read time; it is never part of a stored summary. */
export async function recordRoles(storage: IndexStorage, recordIds: string[], includeDeleted: boolean): Promise<Record<string, ParticipantRole | "deleted">> {
  const rows = await Promise.all([...new Set(recordIds)].map(async id => {
    if (!RECORD_ID.test(id)) throw new Error("invalid_record_id");
    if (includeDeleted && await storage.get("d:" + await recordHash(id))) return [id, "deleted"] as const;
    const entry = await storage.get(participantRoleKey(id));
    return [id, entry === undefined ? "unclassified" : readParticipantRoleEntry(entry, id).role] as const;
  }));
  return Object.fromEntries(rows);
}

/** The session RPC verifies the archives and serializes this mutation with owner deletion. */
export async function setParticipantRole(storage: IndexStorage, targets: { recordId: string; hash: string }[],
  objectId: string, role: unknown, at: string, revision: string): Promise<boolean> {
  if (!isParticipantRole(role) || !targets.length || new Set(targets.map(target => target.recordId)).size !== targets.length) return false;
  const updates: Record<string, ParticipantRoleEntry | ParticipantRoleAudit | string> = {};
  for (const { recordId, hash } of targets) {
    const summary = await getSummary(storage, recordId);
    if ((summary && (summary.recordId !== recordId || summary.objectId !== objectId)) || await storage.get("d:" + hash)) return false;
    const key = participantRoleKey(recordId);
    const old = await storage.get(key);
    const from = old === undefined ? "unclassified" : readParticipantRoleEntry(old, recordId).role;
    if (from === role) continue;
    updates[key] = { ...participantRoleView(role), recordId, updatedAt: at };
    updates[`participant-role-audit:${at}:${revision}:${recordId}`] = { kind: "participant_role_set", recordId, from, to: role, at };
  }
  if (Object.keys(updates).length) await storage.put({ ...updates, [PARTICIPANT_ROLE_REVISION]: revision });
  return true;
}

/** Newest first, PAGE_SIZE per page; `after` is the opaque cursor from the previous page. */
export async function listPage(storage: IndexStorage, after: string | null = null, limit = PAGE_SIZE):
  Promise<{ items: AdminSummary[]; next: string | null }> {
  const keys = await storage.list<string>({ prefix: "u:", ...(after && CURSOR.test(after) ? { startAfter: after } : {}), limit: limit + 1 });
  const entries = [...keys.entries()];
  const page = entries.slice(0, limit);
  const items: AdminSummary[] = [];
  const seen = new Set<string>();
  // An ordering key is shown only if it is its record's current one, so a stale key never duplicates a row.
  for (const [key, id] of page) {
    if (seen.has(id)) continue;
    const summary = await getSummary(storage, id);
    if (summary && orderKey(summary) === key) { items.push(summary); seen.add(id); }
  }
  return { items, next: entries.length > limit ? page.at(-1)![0] : null };
}

/** Removes entries together with their records and appends one audit entry per removed id. */
export async function removeSummaries(storage: IndexStorage, recordIds: readonly string[], reason: DeletionReason, now: number): Promise<number> {
  let removed = 0;
  for (const recordId of recordIds) {
    const hash = await recordHash(recordId);
    const previous = await storage.get<AdminSummary>("r:" + recordId);
    const keys = [participantRoleKey(recordId)];
    if (previous) keys.push("r:" + recordId, orderKey(previous));
    await storage.delete(keys);
    if (await storage.get("d:" + hash)) continue;
    const deletedAt = new Date(now).toISOString();
    const entry: AuditEntry = { recordHash: hash, deletedAt, reason };
    await storage.put({ ["d:" + hash]: true, [`a:${deletedAt}:${hash}`]: entry });
    removed++;
  }
  if (removed) await storage.put({ [PARTICIPANT_ROLE_REVISION]: crypto.randomUUID() });
  return removed;
}

export async function listAudit(storage: IndexStorage, limit = 50): Promise<AuditEntry[]> {
  return [...(await storage.list<AuditEntry>({ prefix: "a:", reverse: true, limit })).values()];
}
