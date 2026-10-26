import { open, lstat, realpath, rename, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { data, OWNER, UUID, readOwner, readAssignment, safeInt, validateBoundBaseRecord, validateBaseAssignmentConfig } from '../v2/base-assignment-data.ts';
import { BaseSessionError } from '../v2/base-assignment-session.ts';
import type { BaseLocalContainer, BaseFileStore, BaseOwnerState, BaseArchiveWrite, BaseRecord } from '../v2/base-assignment.ts';
const fail = () => new BaseSessionError('trial_unavailable');
const IDLE = 30 * 60 * 1000;
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
async function readPrivate(file: string, max = 64 * 1024 * 1024): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > max) throw fail();
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export async function readPrivateAssignment(file: string) {
  await privateDirectory(dirname(file));
  return validateBaseAssignmentConfig(await readPrivate(file, 16384));
}
function container(raw: unknown, ownerId: string): BaseLocalContainer {
  const c = data(raw, ['schemaVersion', 'owner', 'archives', 'questionnaires', 'ledger', 'tombstones', 'lastAccessMs']);
  if (c.schemaVersion !== 'base_local_owner_v1' || !safeInt(c.lastAccessMs) || c.lastAccessMs < 0 || !Array.isArray(c.tombstones) ||
      c.tombstones.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(c.tombstones).size !== c.tombstones.length) throw fail();
  const owner = readOwner(c.owner, ownerId);
  const archives = data(c.archives), ledger = data(c.ledger), questionnaires = data(c.questionnaires);
  for (const [id, record] of Object.entries(archives)) {
    if (!UUID.test(id)) throw fail();
    const r = data(record); validateBoundBaseRecord(r, r.assignment); if (r.recordId !== id) throw fail();
    if (!(c.tombstones as string[]).includes(id) && !Object.values(owner.admissions).some(e =>
      e?.record?.recordId === id && JSON.stringify(readAssignment(r.assignment)) === JSON.stringify(readAssignment(e.assignment)))) throw fail();
  }
  for (const [id, epoch] of Object.entries(ledger)) if (!UUID.test(id) || !safeInt(epoch) || epoch < 0) throw fail();
  for (const id of Object.keys(questionnaires)) if (!UUID.test(id)) throw fail();
  return structuredClone(raw) as BaseLocalContainer;
}
export type LocalStore = BaseFileStore & {
  inspect(): Promise<BaseLocalContainer>;
  touch(): Promise<void>;
  saveQuestionnaire(id: string, value: unknown): Promise<void>;
  deleteRecord(id: string): Promise<boolean>;
};
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
  async function load() {
    if (closed) throw fail(); await privateDirectory(root);
    return container(await readPrivate(file), ownerId);
  }
  const expired = (c: BaseLocalContainer) => !safeInt(now()) || now() < 0 || now() - c.lastAccessMs >= IDLE;
  async function save(c: BaseLocalContainer) {
    container(c, ownerId);
    const tmp = join(root, '.' + ownerId + '.' + randomUUID() + '.tmp'); let h;
    try {
      h = await open(tmp, 'wx', 0o600); await h.writeFile(JSON.stringify(c)); await h.close(); h = undefined;
      // Refuse a replaced/hard-linked target rather than repairing its permissions.
      const s = await lstat(file); if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) throw fail();
      await rename(tmp, file);
    } catch { await h?.close().catch(() => {}); await unlink(tmp).catch(() => {}); throw fail(); }
  }
  return {
    read: () => queued(async () => { const c = await load(); return expired(c) ? {kind: 'expired'} : {kind: 'state', state: c.owner}; }),
    readRecord: id => queued(async () => { const c = await load(); if (expired(c) || !UUID.test(id) || c.tombstones.includes(id)) return null; return c.archives[id] ?? null; }),
    compareAndSwap: (revision: number, next: BaseOwnerState, writes: readonly BaseArchiveWrite[]) => queued(async () => {
      const c = await load(); if (expired(c)) throw fail();
      if (c.owner.revision !== revision) return false;
      const owner = readOwner(next, ownerId); if (owner.revision !== revision + 1) throw fail();
      for (const write of writes) {
        const r: BaseRecord = write.record; validateBoundBaseRecord(r, r.assignment);
        if (write.assignmentId !== r.assignment.assignmentId || c.tombstones.includes(r.recordId) ||
            !Object.values(owner.admissions).some(e => e?.assignment.assignmentId === write.assignmentId && e.record?.recordId === r.recordId)) throw fail();
        c.archives[r.recordId] = structuredClone(r); c.ledger[r.recordId] ??= now();
      }
      c.owner = owner; c.lastAccessMs = now(); await save(c); return true;
    }),
    inspect: () => queued(load),
    touch: () => queued(async () => { const c = await load(); if (expired(c)) throw new BaseSessionError('owner_expired'); c.lastAccessMs = now(); await save(c); }),
    saveQuestionnaire: (id, value) => queued(async () => {
      const c = await load(); if (expired(c)) throw new BaseSessionError('owner_expired');
      if (!c.archives[id] || c.tombstones.includes(id)) throw new BaseSessionError('not_found');
      c.questionnaires[id] = structuredClone(value); c.lastAccessMs = now(); await save(c);
    }),
    deleteRecord: id => queued(async () => {
      try {
        if (typeof id !== 'string' || !UUID.test(id)) throw fail();
        const c = await load();
        if (expired(c)) throw new BaseSessionError('owner_expired');
        if (c.tombstones.includes(id) || !Object.hasOwn(c.archives, id)) return false;
        const record = c.archives[id];
        const envelope = Object.values(c.owner.admissions).find(e => e?.record?.recordId === id);
        if (!envelope) throw fail();
        validateBoundBaseRecord(record, envelope.assignment);
        delete c.archives[id]; delete c.questionnaires[id]; delete c.ledger[id];
        c.tombstones.push(id);
        envelope.record = null; envelope.status = 'failed'; envelope.errorCode = 'record_deleted';
        c.owner.revision += 1;
        await save(c); return true;
      } catch (error) {
        if (error instanceof BaseSessionError && error.code === 'owner_expired') throw error;
        throw fail();
      }
    }),
    close: () => queued(async () => {
      if (closed) return; closed = true; await locked.close();
      const s = await lstat(lock).catch((error:NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw fail();
      });
      if (s && s.ino === lockStat.ino && s.dev === lockStat.dev) await unlink(lock);
    }),
  };
}
