// Researcher-saved reception settings in the global AdminIndex. Pure over a
// minimal storage interface, testable in Node. Layout (append-only history):
//   "reception-protocol:current"     {revision, protocolId, sha256, savedAt}
//   "reception-protocol:rev:<10>"    {revision, sha256, savedAt, protocol}  complete canonical v2 protocol
//   "reception-mode:current"         {revision, value, savedAt, protocolRevision}
//   "reception-mode:rev:<10>"        same as current, per revision
// Neither key exists until a researcher saves. A history without its current
// pointer, or a pointer that disagrees with its history, is damage: it fails
// closed and is never read as "unsaved" or "off".
import { ReceptionError, validateReceptionProtocolV2, receptionProtocolSha256 } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { ReceptionProtocolV2 } from '../../../../dialogue-model/runtime/v2/reception.ts';

export type SettingsStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
};
export type ProtocolEntry = { revision: number; savedAt: string; sha256: string; protocol: ReceptionProtocolV2 };
export type ModeEntry = { revision: number; value: 'on' | 'off'; savedAt: string; protocolRevision: number | null };
export type ModeState = { value: 'unset'; revision: 0 } | { value: 'on' | 'off'; revision: number; savedAt: string };
export type ReceptionSettings = { protocol: ProtocolEntry | null; mode: ModeState };
/** Reception is the default: only a researcher's explicit "off" closes it. The stored value is never rewritten. */
export const receptionOpen = (mode: ModeState): boolean => mode.value !== 'off';
export type ProtocolFields = Pick<ReceptionProtocolV2, 'allowedOrders' | 'seedPolicy' | 'referenceMemory' | 'betweenTrials' | 'receptionNumberFormat' | 'rotationMode'>;
export type SaveResult = { ok: true; revision: number } | { ok: false; error: 'conflict' | 'invalid' | 'protocol_unconfigured' | 'unavailable' };

const PROTOCOL = 'reception-protocol:current', PROTOCOL_REV = 'reception-protocol:rev:';
const MODE = 'reception-mode:current', MODE_REV = 'reception-mode:rev:';
const FIELDS = ['allowedOrders', 'seedPolicy', 'referenceMemory', 'betweenTrials', 'receptionNumberFormat', 'rotationMode'];
const revKey = (prefix: string, revision: number) => prefix + String(revision).padStart(10, '0');
const broken = (): never => { throw new ReceptionError('reception_unavailable'); };
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && new Date(v).toISOString() === v;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return broken();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(k => typeof k !== 'string' || !keys.includes(k))) return broken();
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return broken(); }
  return value as Record<string, unknown>;
}
function protocolEntry(value: unknown): ProtocolEntry {
  const e = exact(value, ['revision', 'savedAt', 'sha256', 'protocol']);
  let protocol: ReceptionProtocolV2;
  try { protocol = validateReceptionProtocolV2(e.protocol); } catch { return broken(); }
  if (!positive(e.revision) || !iso(e.savedAt) || !sha(e.sha256) || protocol.revision !== e.revision ||
    receptionProtocolSha256(JSON.stringify(protocol)) !== e.sha256) return broken();
  return { revision: e.revision, savedAt: e.savedAt, sha256: e.sha256, protocol };
}
function modeEntry(value: unknown): ModeEntry {
  const e = exact(value, ['revision', 'value', 'savedAt', 'protocolRevision']);
  if (!positive(e.revision) || (e.value !== 'on' && e.value !== 'off') || !iso(e.savedAt) || e.protocolRevision !== null && !positive(e.protocolRevision)) return broken();
  return { revision: e.revision, value: e.value, savedAt: e.savedAt, protocolRevision: e.protocolRevision as number | null };
}
async function hasAny(storage: SettingsStorage, prefix: string): Promise<boolean> { return (await storage.list({ prefix })).size > 0; }

/** One consistent snapshot; call inside a single storage transaction. */
export async function readSettings(storage: SettingsStorage): Promise<ReceptionSettings> {
  try {
    let protocol: ProtocolEntry | null = null;
    const current = await storage.get(PROTOCOL);
    if (current === undefined) { if (await hasAny(storage, PROTOCOL_REV)) broken(); }
    else {
      const c = exact(current, ['revision', 'protocolId', 'sha256', 'savedAt']);
      if (!positive(c.revision)) broken();
      protocol = protocolEntry(await storage.get(revKey(PROTOCOL_REV, c.revision as number)));
      if (protocol.revision !== c.revision || protocol.protocol.protocolId !== c.protocolId || protocol.sha256 !== c.sha256 || protocol.savedAt !== c.savedAt) broken();
    }
    let mode: ModeState = { value: 'unset', revision: 0 };
    const m = await storage.get(MODE);
    if (m === undefined) { if (await hasAny(storage, MODE_REV)) broken(); }
    else {
      const entry = modeEntry(m), saved = modeEntry(await storage.get(revKey(MODE_REV, entry.revision)));
      // "on" without a protocol is normal (reception is the default), but a mode saved against a protocol
      // revision that is now missing or older is evidence of lost settings, never "unsaved".
      if (JSON.stringify(saved) !== JSON.stringify(entry) ||
        entry.protocolRevision !== null && (!protocol || protocol.revision < entry.protocolRevision)) broken();
      mode = { value: entry.value, revision: entry.revision, savedAt: entry.savedAt };
    }
    return { protocol, mode };
  } catch { return broken(); }
}

/** Strict check of a snapshot after an RPC boundary (transport-only attributes already removed). */
export function validateReceptionSettings(value: unknown): ReceptionSettings {
  try {
    const s = exact(value, ['protocol', 'mode']);
    const protocol = s.protocol === null ? null : protocolEntry(s.protocol);
    const m = s.mode && typeof s.mode === 'object' && (s.mode as { value?: unknown }).value === 'unset'
      ? exact(s.mode, ['value', 'revision']) : exact(s.mode, ['value', 'revision', 'savedAt']);
    let mode: ModeState;
    if (m.value === 'unset') { if (m.revision !== 0) broken(); mode = { value: 'unset', revision: 0 }; }
    else {
      if ((m.value !== 'on' && m.value !== 'off') || !positive(m.revision) || !iso(m.savedAt)) broken();
      mode = { value: m.value as 'on' | 'off', revision: m.revision as number, savedAt: m.savedAt as string };
    }
    return { protocol, mode };
  } catch { return broken(); }
}

function fieldsOf(value: unknown): ProtocolFields | null {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.length || FIELDS.some(k => !Object.hasOwn(value, k))) return null;
  return value as ProtocolFields;
}
const expected = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export async function saveProtocol(storage: SettingsStorage, input: { expectedRevision: unknown; fields: unknown }, now: number, newId: () => string): Promise<SaveResult> {
  let settings: ReceptionSettings;
  try { settings = await readSettings(storage); } catch { return { ok: false, error: 'unavailable' }; }
  if (!expected(input?.expectedRevision)) return { ok: false, error: 'invalid' };
  const previous = settings.protocol, revision = (previous?.revision ?? 0) + 1;
  if (input.expectedRevision !== (previous?.revision ?? 0)) return { ok: false, error: 'conflict' };
  const fields = fieldsOf(input.fields);
  if (!fields) return { ok: false, error: 'invalid' };
  let protocol: ReceptionProtocolV2;
  try {
    protocol = validateReceptionProtocolV2({ schemaVersion: 'reception_protocol_v2', protocolId: previous?.protocol.protocolId ?? newId(), revision,
      allowedOrders: fields.allowedOrders, seedPolicy: fields.seedPolicy, referenceMemory: fields.referenceMemory, betweenTrials: fields.betweenTrials,
      receptionNumberFormat: fields.receptionNumberFormat, rotationMode: fields.rotationMode });
  } catch { return { ok: false, error: 'invalid' }; }
  if (await storage.get(revKey(PROTOCOL_REV, revision)) !== undefined) return { ok: false, error: 'unavailable' };
  const savedAt = new Date(now).toISOString(), sha256 = receptionProtocolSha256(JSON.stringify(protocol));
  await storage.put({ [PROTOCOL]: { revision, protocolId: protocol.protocolId, sha256, savedAt },
    [revKey(PROTOCOL_REV, revision)]: { revision, sha256, savedAt, protocol } });
  return { ok: true, revision };
}

export async function saveMode(storage: SettingsStorage, input: { expectedRevision: unknown; value: unknown }, now: number): Promise<SaveResult> {
  let settings: ReceptionSettings;
  try { settings = await readSettings(storage); } catch { return { ok: false, error: 'unavailable' }; }
  if (!expected(input?.expectedRevision) || (input.value !== 'on' && input.value !== 'off')) return { ok: false, error: 'invalid' };
  if (input.expectedRevision !== settings.mode.revision) return { ok: false, error: 'conflict' };
  const revision = settings.mode.revision + 1;
  if (await storage.get(revKey(MODE_REV, revision)) !== undefined) return { ok: false, error: 'unavailable' };
  const entry: ModeEntry = { revision, value: input.value, savedAt: new Date(now).toISOString(), protocolRevision: settings.protocol?.revision ?? null };
  await storage.put({ [MODE]: entry, [revKey(MODE_REV, revision)]: entry });
  return { ok: true, revision };
}

export async function protocolHistory(storage: SettingsStorage): Promise<ProtocolEntry[]> {
  return [...(await storage.list({ prefix: PROTOCOL_REV })).values()].map(protocolEntry).sort((a, b) => b.revision - a.revision);
}
export async function modeHistory(storage: SettingsStorage): Promise<ModeEntry[]> {
  return [...(await storage.list({ prefix: MODE_REV })).values()].map(modeEntry).sort((a, b) => b.revision - a.revision);
}
