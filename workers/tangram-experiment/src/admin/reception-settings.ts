// Researcher-saved reception settings in the global AdminIndex. Pure over a
// minimal storage interface, testable in Node. Layout (append-only history):
//   "reception-protocol:current"     {revision, protocolId, sha256, savedAt}
//   "reception-protocol:rev:<10>"    {revision, sha256, savedAt, protocol}  complete canonical v2 or v3 protocol (new saves are v3; saved v2 entries stay readable)
//   "reception-mode:current"         {revision, value, savedAt, protocolRevision}
//   "reception-mode:rev:<10>"        same as current, per revision
//   "reception-post-generation-check:current" / "reception-post-generation-check:rev:<10>"
//                                    {revision, value, savedAt}
//   "reception-migration:rotation-90-180-270:v1"
//                                    {at, outcome, fromRevision, toRevision}  one-time switch to the new rotation default (#269)
// No settings key exists until a researcher saves. A history without its current
// pointer, or a pointer that disagrees with its history, is damage: it fails
// closed and is never read as "unsaved" or "off".
import { ReceptionError, validateReceptionProtocolV2, validateReceptionProtocolV3, receptionProtocolSha256 } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { ReceptionProtocolV2, ReceptionProtocolV3 } from '../../../../dialogue-model/runtime/v2/reception.ts';
import { isPostGenerationCheck, type PostGenerationCheck } from '../../../../dialogue-model/runtime/v2/deferred-ai-extraction.ts';
import { FIGURE_SET_SIZE } from '../../../../dialogue-model/runtime/stimuli/figure-bank.ts';
import { readFigurePreset } from './figure-presets.ts';
import { DEFAULT_ROTATION_MODE } from './rotation-choices.ts';
import type { ProtocolFigureSelection, ProtocolFormInput } from './reception-port.ts';

export type SettingsStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
};
/** v2 entries were saved before the figure bank; they are read as they are and never rewritten. */
export type StoredProtocol = ReceptionProtocolV2 | ReceptionProtocolV3;
export type ProtocolEntry = { revision: number; savedAt: string; sha256: string; protocol: StoredProtocol };
export type ModeEntry = { revision: number; value: 'on' | 'off'; savedAt: string; protocolRevision: number | null };
export type ModeState = { value: 'unset'; revision: 0 } | { value: 'on' | 'off'; revision: number; savedAt: string };
type PostGenerationCheckEntry = { revision: number; value: PostGenerationCheck; savedAt: string };
export type ReceptionSettings = { protocol: ProtocolEntry | null; mode: ModeState; postGenerationCheck?: PostGenerationCheckEntry };
/** Reception is the default: only a researcher's explicit "off" closes it. The stored value is never rewritten. */
export const receptionOpen = (mode: ModeState): boolean => mode.value !== 'off';
export type ProtocolFields = Pick<ReceptionProtocolV3, 'allowedOrders' | 'seedPolicy' | 'referenceMemory' | 'betweenTrials' | 'receptionNumberFormat' | 'rotationMode' | 'figureSelection' | 'figureSetPolicy'>;
export type SaveResult = { ok: true; revision: number } | { ok: false; error: 'conflict' | 'invalid' | 'protocol_unconfigured' | 'unavailable' };

const PROTOCOL = 'reception-protocol:current', PROTOCOL_REV = 'reception-protocol:rev:';
const MODE = 'reception-mode:current', MODE_REV = 'reception-mode:rev:';
const POST_GENERATION_CHECK = 'reception-post-generation-check:current', POST_GENERATION_CHECK_REV = 'reception-post-generation-check:rev:';
const ROTATION_MIGRATION = 'reception-migration:rotation-90-180-270:v1';
const FIELDS = ['allowedOrders', 'seedPolicy', 'referenceMemory', 'betweenTrials', 'receptionNumberFormat', 'rotationMode', 'figureSelection', 'figureSetPolicy'];
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
  let protocol: StoredProtocol;
  const version = e.protocol && typeof e.protocol === 'object' ? (e.protocol as { schemaVersion?: unknown }).schemaVersion : undefined;
  try { protocol = version === 'reception_protocol_v3' ? validateReceptionProtocolV3(e.protocol) : validateReceptionProtocolV2(e.protocol); } catch { return broken(); }
  if (!positive(e.revision) || !iso(e.savedAt) || !sha(e.sha256) || protocol.revision !== e.revision ||
    receptionProtocolSha256(JSON.stringify(protocol)) !== e.sha256) return broken();
  return { revision: e.revision, savedAt: e.savedAt, sha256: e.sha256, protocol };
}
function modeEntry(value: unknown): ModeEntry {
  const e = exact(value, ['revision', 'value', 'savedAt', 'protocolRevision']);
  if (!positive(e.revision) || (e.value !== 'on' && e.value !== 'off') || !iso(e.savedAt) || e.protocolRevision !== null && !positive(e.protocolRevision)) return broken();
  return { revision: e.revision, value: e.value, savedAt: e.savedAt, protocolRevision: e.protocolRevision as number | null };
}
function postGenerationCheckEntry(value: unknown): PostGenerationCheckEntry {
  const e = exact(value, ['revision', 'value', 'savedAt']);
  if (!positive(e.revision) || !isPostGenerationCheck(e.value) || !iso(e.savedAt)) return broken();
  return { revision: e.revision, value: e.value, savedAt: e.savedAt };
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
    const check = await storage.get(POST_GENERATION_CHECK);
    if (check === undefined) {
      if (await hasAny(storage, POST_GENERATION_CHECK_REV)) broken();
      return { protocol, mode };
    }
    const entry = postGenerationCheckEntry(check);
    const saved = postGenerationCheckEntry(await storage.get(revKey(POST_GENERATION_CHECK_REV, entry.revision)));
    if (JSON.stringify(saved) !== JSON.stringify(entry)) broken();
    return { protocol, mode, postGenerationCheck: entry };
  } catch { return broken(); }
}

/** Strict check of a snapshot after an RPC boundary (transport-only attributes already removed). */
export function validateReceptionSettings(value: unknown): ReceptionSettings {
  try {
    const hasCheck = value !== null && typeof value === 'object' && Object.hasOwn(value, 'postGenerationCheck');
    const s = exact(value, ['protocol', 'mode', ...(hasCheck ? ['postGenerationCheck'] : [])]);
    const protocol = s.protocol === null ? null : protocolEntry(s.protocol);
    const m = s.mode && typeof s.mode === 'object' && (s.mode as { value?: unknown }).value === 'unset'
      ? exact(s.mode, ['value', 'revision']) : exact(s.mode, ['value', 'revision', 'savedAt']);
    let mode: ModeState;
    if (m.value === 'unset') { if (m.revision !== 0) broken(); mode = { value: 'unset', revision: 0 }; }
    else {
      if ((m.value !== 'on' && m.value !== 'off') || !positive(m.revision) || !iso(m.savedAt)) broken();
      mode = { value: m.value as 'on' | 'off', revision: m.revision as number, savedAt: m.savedAt as string };
    }
    return { protocol, mode, ...(hasCheck ? { postGenerationCheck: postGenerationCheckEntry(s.postGenerationCheck) } : {}) };
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
  let protocol: ReceptionProtocolV3;
  try {
    protocol = validateReceptionProtocolV3({ schemaVersion: 'reception_protocol_v3', protocolId: previous?.protocol.protocolId ?? newId(), revision,
      allowedOrders: fields.allowedOrders, seedPolicy: fields.seedPolicy, referenceMemory: fields.referenceMemory, betweenTrials: fields.betweenTrials,
      receptionNumberFormat: fields.receptionNumberFormat, rotationMode: fields.rotationMode,
      figureSelection: fields.figureSelection, figureSetPolicy: fields.figureSetPolicy });
  } catch { return { ok: false, error: 'invalid' }; }
  if (!await appendProtocol(storage, protocol, now)) return { ok: false, error: 'unavailable' };
  return { ok: true, revision };
}

/** Appends one complete protocol as its own revision, with any extra keys in the same put. False when that revision's key is already taken. */
async function appendProtocol(storage: SettingsStorage, protocol: StoredProtocol, now: number, extra: Record<string, unknown> = {}): Promise<boolean> {
  const { revision } = protocol;
  if (await storage.get(revKey(PROTOCOL_REV, revision)) !== undefined) return false;
  const savedAt = new Date(now).toISOString(), sha256 = receptionProtocolSha256(JSON.stringify(protocol));
  await storage.put({ [PROTOCOL]: { revision, protocolId: protocol.protocolId, sha256, savedAt },
    [revKey(PROTOCOL_REV, revision)]: { revision, sha256, savedAt, protocol }, ...extra });
  return true;
}

/**
 * One-time switch of the saved rotation to the new default (researcher-approved 2026-11-28, #269). Run it in a transaction at startup.
 * A marker settles the question for good, so a researcher's later explicit choice is never rewritten.
 * - a saved v3 protocol with ±90°: a new revision identical except for rotationMode; earlier revisions and their sha256 stay in the history
 * - anything else (unsaved, 0°, already the new mode, a v2 protocol without figure fields): the marker only
 * Damaged settings throw before anything is written: no migration, no marker, still failing closed.
 * Returns the revision it saved, or null.
 */
export async function migrateRotationDefault(storage: SettingsStorage, now: number): Promise<number | null> {
  if (await storage.get(ROTATION_MIGRATION) !== undefined) return null;
  const { protocol: saved } = await readSettings(storage);
  const marker = (outcome: 'unsaved' | 'kept' | 'migrated', toRevision: number | null) =>
    ({ at: new Date(now).toISOString(), outcome, fromRevision: saved?.revision ?? null, toRevision });
  const current = saved?.protocol;
  if (!saved || current?.schemaVersion !== 'reception_protocol_v3' || current.rotationMode !== 'relative_pm90') {
    await storage.put({ [ROTATION_MIGRATION]: marker(saved ? 'kept' : 'unsaved', null) });
    return null;
  }
  const revision = saved.revision + 1;
  const next = validateReceptionProtocolV3({ ...current, revision, rotationMode: DEFAULT_ROTATION_MODE });
  if (!await appendProtocol(storage, next, now, { [ROTATION_MIGRATION]: marker('migrated', revision) })) return broken();
  return revision;
}

function sameFigureSelection(a: ProtocolFigureSelection, b: ProtocolFigureSelection): boolean {
  if (a.mode === 'seeded_random' && b.mode === 'seeded_random') {
    return a.selectionSeed === b.selectionSeed && (a.figureCount ?? FIGURE_SET_SIZE) === (b.figureCount ?? FIGURE_SET_SIZE);
  }
  if (a.mode === 'preset' && b.mode === 'preset') return a.setId === b.setId;
  return a.mode === 'custom' && b.mode === 'custom' &&
    a.figureIds.length === b.figureIds.length && a.figureIds.every(id => b.figureIds.includes(id));
}

/** All reads and the write run inside one transaction. Only the frozen IDs enter the saved protocol. */
export async function saveProtocolFromForm(storage: SettingsStorage, input: ProtocolFormInput, now: number, newId: () => string): Promise<SaveResult> {
  const { expectedRevision, fields } = input;
  const selection = fields.figureSelection;
  let figureSelection: ProtocolFigureSelection;
  if (selection.mode === 'managed_preset') {
    if (fields.figureSetPolicy !== 'shared') return { ok: false, error: 'invalid' };
    const preset = await readFigurePreset(storage, selection.id);
    if (!preset || preset.revision !== selection.revision) return { ok: false, error: 'conflict' };
    figureSelection = { mode: 'custom', figureIds: preset.figureIds };
  } else if ((selection.mode === 'custom' && selection.figureIds.length === 3) ||
    (selection.mode === 'seeded_random' && selection.figureCount === 3)) {
    figureSelection = selection;
  } else {
    const { protocol } = await readSettings(storage);
    if (expectedRevision !== (protocol?.revision ?? 0)) return { ok: false, error: 'conflict' };
    const current = protocol?.protocol;
    if (current?.schemaVersion !== 'reception_protocol_v3' || current.figureSetPolicy !== fields.figureSetPolicy ||
      !sameFigureSelection(current.figureSelection, selection)) return { ok: false, error: 'invalid' };
    figureSelection = current.figureSelection;
  }
  return saveProtocol(storage, { expectedRevision, fields: { ...fields, figureSelection } }, now, newId);
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

export async function savePostGenerationCheck(storage: SettingsStorage, input: { expectedRevision: unknown; value: unknown }, now: number): Promise<SaveResult> {
  if (!expected(input?.expectedRevision) || !isPostGenerationCheck(input.value)) return { ok: false, error: 'invalid' };
  let settings: ReceptionSettings;
  try { settings = await readSettings(storage); } catch { return { ok: false, error: 'unavailable' }; }
  const previous = settings.postGenerationCheck?.revision ?? 0;
  if (input.expectedRevision !== previous) return { ok: false, error: 'conflict' };
  const revision = previous + 1, historyKey = revKey(POST_GENERATION_CHECK_REV, revision);
  if (await storage.get(historyKey) !== undefined) return { ok: false, error: 'unavailable' };
  const entry = { revision, value: input.value, savedAt: new Date(now).toISOString() };
  await storage.put({ [POST_GENERATION_CHECK]: entry, [historyKey]: entry });
  return { ok: true, revision };
}

export async function protocolHistory(storage: SettingsStorage): Promise<ProtocolEntry[]> {
  return [...(await storage.list({ prefix: PROTOCOL_REV })).values()].map(protocolEntry).sort((a, b) => b.revision - a.revision);
}
export async function modeHistory(storage: SettingsStorage): Promise<ModeEntry[]> {
  return [...(await storage.list({ prefix: MODE_REV })).values()].map(modeEntry).sort((a, b) => b.revision - a.revision);
}
