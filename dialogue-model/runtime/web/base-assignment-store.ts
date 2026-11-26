import { open, lstat, realpath, rename, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { data, OWNER, UUID, readOwner, readAssignment, safeInt, validateBoundBaseRecord, validateBaseAssignmentConfig } from '../v2/base-assignment-data.ts';
import { BaseSessionError } from '../v2/base-assignment-session.ts';
import type { PersistReason } from '../v2/base-assignment-session.ts';
import type { BaseLocalContainer, BaseFileStore, BaseOwnerState, BaseArchiveWrite, BaseRecord } from '../v2/base-assignment.ts';
import { isParticipantRole, participantRoleView, readParticipantRoleEntry } from '../../../workers/tangram-experiment/src/admin/participant-role.ts';
import type { ParticipantRoleEntry, ParticipantRoleView } from '../../../workers/tangram-experiment/src/admin/participant-role.ts';
const fail = (reason: PersistReason = 'store_io') => new BaseSessionError('trial_unavailable', reason);
const MAX_OWNER_BYTES = 64 * 1024 * 1024;
const IDLE = 30 * 60 * 1000;
/** A touch rewrites the whole owner file, so it is skipped while the stored access time is this recent (far below IDLE). */
const TOUCH_INTERVAL = 60 * 1000;
/** A close rewrites the owner file only for an access time that is at least this much newer than the stored one (not for a few milliseconds). */
const CLOSE_WRITEBACK_MIN = 1000;
export async function privateDirectory(root: string): Promise<string> {
  if (typeof root !== 'string' || !root || resolve(root) !== root || await realpath(root) !== root) throw fail();
  for (let path = root;; path = dirname(path)) {
    const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw fail();
    try { await lstat(join(path, '.git')); throw fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw fail(); }
    if (dirname(path) === path) break;
  }
  if (((await lstat(root)).mode & 0o777) !== 0o700) throw fail();
  return root;
}
async function readPrivate(file: string, max = MAX_OWNER_BYTES): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (s.size > max) throw fail('size_limit');
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) throw fail();
    const text = await handle.readFile('utf8');
    try { return JSON.parse(text); } catch { throw fail('store_invalid'); }
  } finally { await handle.close(); }
}
export async function readPrivateAssignment(file: string) {
  await privateDirectory(dirname(file));
  return validateBaseAssignmentConfig(await readPrivate(file, 16384));
}
function container(raw: unknown, ownerId: string): BaseLocalContainer {
  const c = data(raw, ['schemaVersion', 'owner', 'archives', 'questionnaires', 'ledger', 'tombstones', 'lastAccessMs']);
  if (c.schemaVersion !== 'base_local_owner_v1' || !safeInt(c.lastAccessMs) || c.lastAccessMs < 0 || !Array.isArray(c.tombstones) ||
      c.tombstones.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(c.tombstones).size !== c.tombstones.length) throw fail('store_invalid');
  const owner = readOwner(c.owner, ownerId);
  const archives = data(c.archives), ledger = data(c.ledger), questionnaires = data(c.questionnaires);
  for (const [id, record] of Object.entries(archives)) {
    if (!UUID.test(id)) throw fail('store_invalid');
    const r = data(record); validateBoundBaseRecord(r, r.assignment); if (r.recordId !== id) throw fail('store_invalid');
    if (!(c.tombstones as string[]).includes(id) && !Object.values(owner.admissions).some(e =>
      e?.record?.recordId === id && JSON.stringify(readAssignment(r.assignment)) === JSON.stringify(readAssignment(e.assignment)))) throw fail('store_invalid');
  }
  for (const [id, epoch] of Object.entries(ledger)) if (!UUID.test(id) || !safeInt(epoch) || epoch < 0) throw fail('store_invalid');
  for (const id of Object.keys(questionnaires)) if (!UUID.test(id)) throw fail('store_invalid');
  return structuredClone(raw) as BaseLocalContainer;
}
export type LocalStore = BaseFileStore & {
  inspect(): Promise<BaseLocalContainer>;
  /** Whether the owner has not idled out; no copy of the container is made. */
  alive(): Promise<boolean>;
  /** One questionnaire entry (a copy), without copying the container. */
  questionnaire(id: string): Promise<unknown>;
  adminRecord(id: string, includeParticipantRole?: boolean): Promise<LocalAdminRecord | null>;
  adminRecords(): Promise<LocalAdminRecord[]>;
  setParticipantRole(id: string, role: unknown): Promise<boolean>;
  touch(): Promise<void>;
  saveQuestionnaire(id: string, value: unknown): Promise<void>;
  deleteRecord(id: string): Promise<boolean>;
};
type LocalAdminRecord = { record: BaseRecord; questionnaire: unknown; participantRole: ParticipantRoleView };
export async function registerBaseOwner(root: string, ownerId: string, now: number): Promise<void> {
  await privateDirectory(root); if (!OWNER.test(ownerId) || !safeInt(now) || now < 0) throw fail();
  const value: BaseLocalContainer = { schemaVersion: 'base_local_owner_v1', owner: { schemaVersion: 'base_owner_v1', ownerId,
    revision: 0, activeKey: null, admissions: {} }, archives: {}, questionnaires: {}, ledger: {}, tombstones: [], lastAccessMs: now };
  const h = await open(join(root, ownerId + '.owner.json'), 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(value)); } catch (error) { await h.close(); await unlink(join(root, ownerId + '.owner.json')).catch(() => {}); throw error; }
  await h.close();
}
export async function listBaseOwners(root: string): Promise<string[]> {
  await privateDirectory(root);
  return (await readdir(root)).filter(v => /^[a-f0-9]{64}\.owner\.json$/u.test(v)).map(v => v.slice(0, 64));
}
export async function openBaseFileStore({root, ownerId, now}: {root: string; ownerId: string; now: () => number}): Promise<LocalStore> {
  let locked: Awaited<ReturnType<typeof open>> | undefined;
  const file = join(root, ownerId + '.owner.json'), lock = join(root, '.' + ownerId + '.lock');
  try {
    await privateDirectory(root); if (!OWNER.test(ownerId)) throw fail();
    // Prove registration before creating even a lock for an unknown owner.
    container(await readPrivate(file), ownerId);
    locked = await open(lock, 'wx', 0o600);
    await locked.writeFile(randomUUID());
  } catch { if (locked) { await locked.close(); await unlink(lock).catch(() => {}); } throw fail(); }
  const lockStat = await locked.stat(); let closed = false, serial: Promise<unknown> = Promise.resolve();
  function queued<T>(fn: () => Promise<T>): Promise<T> { const p = serial.then(fn); serial = p.catch(() => {}); return p; }
  // Anything other than a store error that fails while the container is read or validated is a damaged container.
  const readContainer = async (): Promise<BaseLocalContainer> => {
    const raw = await readPrivate(file);
    try { return container(raw, ownerId); } catch (error) { throw error instanceof BaseSessionError ? error : fail('store_invalid'); }
  };
  // The newest time the store itself accepted an access. A touch inside TOUCH_INTERVAL skips the write of the owner file, never the access:
  // expiry is judged from the later of this and the stored time. A graceful close writes it back; after an abnormal exit the stored time can be
  // up to TOUCH_INTERVAL older than the last real access, so the idle window shrinks by at most that much.
  let lastAccess = 0;
  async function load() {
    if (closed) throw fail(); await privateDirectory(root);
    return readContainer();
  }
  // This store holds the owner's lock, so the file changes only through save() below. A read-only operation reuses the container that was
  // validated for the file's current identity (device, inode, size, times); any other change of the file is read and validated again.
  // The cache is never handed out: a mutating operation still starts from load(), and a reader receives a copy.
  let cache: { sig: string; c: BaseLocalContainer } | null = null;
  const signature = (s: Awaited<ReturnType<typeof lstat>>) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink, s.mode].join(':');
  async function loadShared(): Promise<BaseLocalContainer> {
    if (closed) throw fail(); await privateDirectory(root);
    const before = await lstat(file);
    if (before.size > MAX_OWNER_BYTES) throw fail('size_limit');
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) throw fail();
    if (cache && cache.sig === signature(before)) return cache.c;
    const c = await readContainer();
    const after = await lstat(file);
    cache = signature(after) === signature(before) ? { sig: signature(before), c } : null;
    return c;
  }
  const expired = (c: BaseLocalContainer) => !safeInt(now()) || now() < 0 || now() - Math.max(c.lastAccessMs, lastAccess) >= IDLE;
  async function replacePrivate(target: string, text: string, requireExisting: boolean) {
    const tmp = join(root, '.' + ownerId + '.' + randomUUID() + '.tmp'); let h;
    try {
      h = await open(tmp, 'wx', 0o600); await h.writeFile(text); await h.close(); h = undefined;
      // Refuse a replaced/hard-linked target rather than repairing its permissions.
      const s = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (!requireExisting && error.code === 'ENOENT') return null;
        throw error;
      });
      if (s && (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600)) throw fail();
      await rename(tmp, target);
    } catch { await h?.close().catch(() => {}); await unlink(tmp).catch(() => {}); throw fail(); }
  }
  async function save(c: BaseLocalContainer) {
    container(c, ownerId);
    const text = JSON.stringify(c);
    if (Buffer.byteLength(text) > MAX_OWNER_BYTES) throw fail('size_limit');
    cache = null;
    await replacePrivate(file, text, true);
    try { const written = await lstat(file); cache = { sig: signature(written), c: JSON.parse(text) as BaseLocalContainer }; } catch { cache = null; }
  }
  const participantRoleFile = (id: string) => join(root, ownerId + '.' + id + '.participant-role.json');
  async function removeRole(id: string): Promise<void> {
    await unlink(participantRoleFile(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw fail();
    });
  }
  async function readRole(id: string): Promise<ParticipantRoleEntry | null> {
    try { return readParticipantRoleEntry(await readPrivate(participantRoleFile(id)), id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw fail();
    }
  }
  const hasRecord = (c: BaseLocalContainer, id: string) =>
    UUID.test(id) && !c.tombstones.includes(id) && Object.hasOwn(c.archives, id);
  async function readAdminRecord(c: BaseLocalContainer, id: string, includeParticipantRole = true): Promise<LocalAdminRecord | null> {
    if (!hasRecord(c, id)) return null;
    return { record: c.archives[id], questionnaire: c.questionnaires[id] ?? null,
      participantRole: participantRoleView(includeParticipantRole ? (await readRole(id))?.role : undefined) };
  }
  return {
    read: () => queued(async () => { const c = await loadShared(); return expired(c) ? {kind: 'expired'} : {kind: 'state', state: structuredClone(c.owner)}; }),
    readRecord: id => queued(async () => { const c = await loadShared(); if (expired(c) || !UUID.test(id) || c.tombstones.includes(id)) return null; const r = c.archives[id]; return r === undefined ? null : structuredClone(r); }),
    compareAndSwap: (revision: number, next: BaseOwnerState, writes: readonly BaseArchiveWrite[]) => queued(async () => {
      const c = await load(); if (expired(c)) throw fail('owner_expired');
      if (c.owner.revision !== revision) return false;
      let owner: BaseOwnerState; try { owner = readOwner(next, ownerId); } catch { throw fail('owner_state_invalid'); }
      if (owner.revision !== revision + 1) throw fail('owner_state_invalid');
      for (const write of writes) {
        const r: BaseRecord = write.record; validateBoundBaseRecord(r, r.assignment);
        if (c.tombstones.includes(r.recordId)) throw fail('record_deleted');
        if (write.assignmentId !== r.assignment.assignmentId ||
            !Object.values(owner.admissions).some(e => e?.assignment.assignmentId === write.assignmentId && e.record?.recordId === r.recordId)) throw fail('owner_state_invalid');
        c.archives[r.recordId] = structuredClone(r); c.ledger[r.recordId] ??= now();
      }
      c.owner = owner; c.lastAccessMs = Math.max(now(), lastAccess); lastAccess = c.lastAccessMs; await save(c); return true;
    }),
    inspect: () => queued(async () => structuredClone(await loadShared())),
    alive: () => queued(async () => !expired(await loadShared())),
    questionnaire: id => queued(async () => { const c = await loadShared(); const q = Object.hasOwn(c.questionnaires, id) ? c.questionnaires[id] : undefined; return q === undefined ? null : structuredClone(q); }),
    touch: () => queued(async () => {
      const shared = await loadShared(); if (expired(shared)) throw new BaseSessionError('owner_expired');
      // Rewriting the whole owner file for a read is what made long dialogues slow; extend the expiry at most once per interval.
      lastAccess = Math.max(lastAccess, now());
      if (safeInt(now()) && now() >= shared.lastAccessMs && now() - shared.lastAccessMs < TOUCH_INTERVAL) return;
      const c = await load(); if (expired(c)) throw new BaseSessionError('owner_expired'); c.lastAccessMs = lastAccess; await save(c);
    }),
    // Idle expiry is for participant access; a researcher may classify retained records.
    adminRecord: (id, includeParticipantRole) => queued(async () => {
      const c = await load();
      // The tombstone survives a failed unlink or a restart between the two writes.
      if (c.tombstones.includes(id)) await removeRole(id);
      return readAdminRecord(c, id, includeParticipantRole);
    }),
    adminRecords: () => queued(async () => {
      const c = await load();
      for (const id of c.tombstones) await removeRole(id);
      const records: LocalAdminRecord[] = [];
      for (const id of Object.keys(c.archives)) {
        const record = await readAdminRecord(c, id);
        if (record) records.push(record);
      }
      return records;
    }),
    setParticipantRole: (id, role) => queued(async () => {
      const c = await load();
      if (!hasRecord(c, id) || !isParticipantRole(role)) return false;
      const previous = await readRole(id);
      if ((previous?.role ?? 'unclassified') !== role) {
        const entry: ParticipantRoleEntry = { ...participantRoleView(role), recordId: id, updatedAt: new Date(now()).toISOString() };
        await replacePrivate(participantRoleFile(id), JSON.stringify(entry), previous !== null);
      }
      return true;
    }),
    saveQuestionnaire: (id, value) => queued(async () => {
      const c = await load(); if (expired(c)) throw new BaseSessionError('owner_expired');
      if (!c.archives[id] || c.tombstones.includes(id)) throw new BaseSessionError('not_found');
      c.questionnaires[id] = structuredClone(value); c.lastAccessMs = Math.max(now(), lastAccess); lastAccess = c.lastAccessMs; await save(c);
    }),
    deleteRecord: id => queued(async () => {
      try {
        if (typeof id !== 'string' || !UUID.test(id)) throw fail();
        const c = await load();
        if (c.tombstones.includes(id)) {
          await removeRole(id);
          return false;
        }
        if (expired(c)) throw new BaseSessionError('owner_expired');
        if (!Object.hasOwn(c.archives, id)) return false;
        const record = c.archives[id];
        const envelope = Object.values(c.owner.admissions).find(e => e?.record?.recordId === id);
        if (!envelope) throw fail();
        validateBoundBaseRecord(record, envelope.assignment);
        delete c.archives[id]; delete c.questionnaires[id]; delete c.ledger[id];
        c.tombstones.push(id);
        envelope.record = null; envelope.status = 'failed'; envelope.errorCode = 'record_deleted';
        c.owner.revision += 1;
        await save(c);
        await removeRole(id);
        return true;
      } catch (error) {
        if (error instanceof BaseSessionError && error.code === 'owner_expired') throw error;
        throw fail();
      }
    }),
    close: () => queued(async () => {
      if (closed) return;
      // A graceful close keeps the idle window exact: write back an access time that a skipped touch left only in memory.
      if (lastAccess > 0 && safeInt(now()) && now() - lastAccess < IDLE) {
        try { const c = await load(); if (lastAccess - c.lastAccessMs >= CLOSE_WRITEBACK_MIN) { c.lastAccessMs = lastAccess; await save(c); } } catch { /* the stored time stays as it was */ }
      }
      closed = true; cache = null; await locked.close();
      const s = await lstat(lock).catch((error:NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw fail();
      });
      if (s && s.ino === lockStat.ino && s.dev === lockStat.dev) await unlink(lock);
    }),
  };
}
