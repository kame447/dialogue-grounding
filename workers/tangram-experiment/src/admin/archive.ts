// Per-trial archive and retention inside each session Durable Object.
//   "active"            the trial this browser resumes
//   "record:<recordId>" every trial's latest record, so a new trial never erases an earlier log
//   "ledger"            recordId -> last update (ms), which drives retention
//   "tombstones"        recordIds deleted by a researcher (ids only), so a still-running
//                       trial cannot write its record back after deletion
// Records expire RECORD_RETENTION_DAYS after their last update; nothing is deleted
// earlier. Pure over a minimal storage interface with an injected clock, so the
// Durable Object only wires it up (alarm, index notification).

export type ArchiveStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
};
type Archivable = { recordId: string; updatedAt?: unknown; [field: string]: unknown };
type Ledger = Record<string, number>;

export const ACTIVE_KEY = "active";
const LEDGER_KEY = "ledger";
const TOMBSTONES_KEY = "tombstones";
export const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const archiveKey = (recordId: string) => {
  if (!UUID.test(recordId)) throw new TypeError("invalid_record_id");
  return "record:" + recordId;
};

/** RECORD_RETENTION_DAYS: an integer 1-365; anything else falls back to 30. */
export function retentionDays(raw: unknown): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= 365 ? value : DEFAULT_RETENTION_DAYS;
}

/** Last update of a record: its own updatedAt when valid, otherwise the write time. */
function lastUpdate(record: Archivable, now: number): number {
  const parsed = typeof record.updatedAt === "string" ? Date.parse(record.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : now;
}
const expiryOf = (updatedMs: number, days: number) => updatedMs + days * DAY_MS;

async function ledgerOf(storage: ArchiveStorage): Promise<Ledger> { return (await storage.get<Ledger>(LEDGER_KEY)) ?? {}; }
async function tombstonesOf(storage: ArchiveStorage): Promise<string[]> { return (await storage.get<string[]>(TOMBSTONES_KEY)) ?? []; }

/**
 * Writes the snapshot under its record key, refreshes its ledger time, and writes
 * "active" unless the trial was replaced in this browser (a late write from a
 * retired trial must not displace the newer active one). A researcher-deleted
 * record is never written back. Returns false when the write was skipped.
 */
export async function archiveSnapshot(storage: ArchiveStorage, snapshot: Archivable, retired: ReadonlySet<string>, now: number): Promise<boolean> {
  const key = archiveKey(snapshot.recordId);
  if ((await tombstonesOf(storage)).includes(snapshot.recordId)) return false;
  const ledger = { ...(await ledgerOf(storage)), [snapshot.recordId]: lastUpdate(snapshot, now) };
  await storage.put(retired.has(snapshot.recordId) ? { [key]: snapshot, [LEDGER_KEY]: ledger }
    : { [ACTIVE_KEY]: snapshot, [key]: snapshot, [LEDGER_KEY]: ledger });
  return true;
}

/**
 * One-time, additive backfill for sessions created before the archive: copies
 * "active" to its record key and ledger (time = its own last update). Returns the
 * record when it wrote one, otherwise null.
 */
export async function backfillActive(storage: ArchiveStorage, now: number): Promise<Archivable | null> {
  const active = await storage.get<Archivable>(ACTIVE_KEY);
  if (!active || typeof active.recordId !== "string" || !UUID.test(active.recordId)) return null;
  const ledger = await ledgerOf(storage);
  if (Object.hasOwn(ledger, active.recordId) || (await tombstonesOf(storage)).includes(active.recordId)) return null;
  await storage.put({ [archiveKey(active.recordId)]: active, [LEDGER_KEY]: { ...ledger, [active.recordId]: lastUpdate(active, now) } });
  return active;
}

/** Researcher-only read of one archived trial; null for unknown or malformed ids. */
export async function readArchived(storage: ArchiveStorage, recordId: string): Promise<Archivable | null> {
  if (!UUID.test(recordId)) return null;
  return (await storage.get<Archivable>(archiveKey(recordId))) ?? null;
}

/** RecordIds with a stored record in this session (used to re-register index entries). */
export async function ledgerIds(storage: ArchiveStorage): Promise<string[]> {
  return Object.keys(await ledgerOf(storage)).sort();
}

/** When the session's alarm should fire: the earliest expiry, or null with no records. */
export async function nextExpiry(storage: ArchiveStorage, days: number): Promise<number | null> {
  const times = Object.values(await ledgerOf(storage));
  return times.length ? expiryOf(Math.min(...times), days) : null;
}

/** RecordIds whose last update is at least `days` old at `now`. Never anything younger. */
export async function expiredIds(storage: ArchiveStorage, now: number, days: number): Promise<string[]> {
  return Object.entries(await ledgerOf(storage)).filter(([, updated]) => expiryOf(updated, days) <= now).map(([id]) => id).sort();
}

/** Removes records (and "active" when it is one of them) plus their ledger entries. */
async function removeRecords(storage: ArchiveStorage, ids: readonly string[], tombstone: boolean): Promise<void> {
  if (!ids.length) return;
  const ledger = await ledgerOf(storage);
  for (const id of ids) delete ledger[id];
  const active = await storage.get<Archivable>(ACTIVE_KEY);
  const updates: Record<string, unknown> = { [LEDGER_KEY]: ledger };
  if (tombstone) updates[TOMBSTONES_KEY] = [...new Set([...(await tombstonesOf(storage)), ...ids])];
  await storage.put(updates);
  await storage.delete([...ids.map(archiveKey), ...(active && ids.includes(active.recordId) ? [ACTIVE_KEY] : [])]);
}

/**
 * Retention: deletes only records past expiry at `now`. `beforeDelete` runs first
 * (the index removal); if it throws, nothing is deleted and the alarm can retry.
 */
export async function expireRecords(storage: ArchiveStorage, now: number, days: number,
  beforeDelete: (ids: string[]) => Promise<void>): Promise<string[]> {
  const ids = await expiredIds(storage, now, days);
  if (!ids.length) return [];
  await beforeDelete(ids);
  // Re-check after the await: a record updated meanwhile is no longer expired.
  const still = new Set(await expiredIds(storage, now, days));
  const removing = ids.filter((id) => still.has(id));
  // Tombstoned like a researcher deletion: a late write from the same trial cannot
  // recreate a record that the index no longer lists.
  await removeRecords(storage, removing, true);
  return removing;
}

/** Researcher deletion of one trial: removes it now and tombstones its id. Idempotent. */
export async function deleteArchived(storage: ArchiveStorage, recordId: string): Promise<boolean> {
  archiveKey(recordId);
  const existed = Boolean(await storage.get(archiveKey(recordId)));
  await removeRecords(storage, [recordId], true);
  return existed;
}
