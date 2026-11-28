import { FIGURE_BANK } from '../../../../dialogue-model/runtime/stimuli/figure-bank.ts';
import type { SettingsStorage } from './reception-settings.ts';

export type FigurePreset = { id: string; revision: number; name: string; figureIds: string[] };
export type FigurePresetReference = Pick<FigurePreset, 'id' | 'revision'>;
export type FigurePresetMutation = { id: string | null; expectedRevision: number } &
  ({ name: string; figureIds: string[] } | { hide: true });
export type FigurePresetResult = { ok: true } | { ok: false; error: 'conflict' | 'invalid' };
export type FigurePresetPort = {
  list(): Promise<FigurePreset[]>;
  read(id: string): Promise<FigurePreset | null>;
  save(input: FigurePresetMutation): Promise<FigurePresetResult>;
};

type HiddenPreset = FigurePresetReference & { hidden: true };
type PresetRow = FigurePreset | HiddenPreset;
const PREFIX = 'figure-preset:';
const bankIds = FIGURE_BANK.map(figure => figure.id);
const initialPresets = new Map(Array.from({ length: 10 }, (_, index): [string, FigurePreset] => {
  const id = `trio-${String(index + 1).padStart(2, '0')}-v1`;
  const figureIds = bankIds.slice(index * 3, (index + 1) * 3);
  return [id, { id, revision: 1, name: `3図形（${figureIds[0]}–${figureIds[2]}）`, figureIds }];
}));
export const isFigurePresetId = (id: unknown): id is string => typeof id === 'string' &&
  (initialPresets.has(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id));
const revisionNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function figureIdsFor(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const selected = bankIds.filter(id => value.includes(id));
  return selected.length === 3 ? selected : null;
}
function parsePresetRow(id: string, value: unknown): PresetRow {
  const row = value as Partial<FigurePreset> & { hidden?: unknown };
  if (row?.id !== id || !isFigurePresetId(id) || !revisionNumber(row.revision) || row.revision < 1) {
    throw new Error('invalid_figure_preset');
  }
  if (row.hidden === true) return { id, revision: row.revision, hidden: true };
  const figureIds = figureIdsFor(row.figureIds);
  if (typeof row.name !== 'string' || !row.name.trim() || !figureIds) throw new Error('invalid_figure_preset');
  return { id, revision: row.revision, name: row.name, figureIds };
}

// The seed entries are initial values. An edit or a tombstone takes their place.
async function readRow(storage: SettingsStorage, id: string): Promise<PresetRow | null> {
  const raw = await storage.get(PREFIX + id);
  return raw === undefined ? initialPresets.get(id) ?? null : parsePresetRow(id, raw);
}
export async function readFigurePreset(storage: SettingsStorage, id: string): Promise<FigurePreset | null> {
  if (!isFigurePresetId(id)) return null;
  const row = await readRow(storage, id);
  return row && !('hidden' in row) ? structuredClone(row) : null;
}
export async function listFigurePresets(storage: SettingsStorage): Promise<FigurePreset[]> {
  const visible = new Map(initialPresets);
  for (const [key, value] of await storage.list({ prefix: PREFIX })) {
    const id = key.slice(PREFIX.length), row = parsePresetRow(id, value);
    if ('hidden' in row) visible.delete(id);
    else visible.set(id, row);
  }
  return structuredClone([...visible.values()]);
}

/** Run inside an AdminIndex transaction so writes and protocol snapshots share a revision boundary. */
export async function saveFigurePreset(storage: SettingsStorage, input: FigurePresetMutation, newId: () => string): Promise<FigurePresetResult> {
  if (!input || !revisionNumber(input.expectedRevision) || input.id !== null && !isFigurePresetId(input.id)) {
    return { ok: false, error: 'invalid' };
  }
  const id = input.id ?? newId();
  const existing = await readRow(storage, id);
  if (input.id === null ? existing !== null || input.expectedRevision !== 0
    : !existing || 'hidden' in existing || existing.revision !== input.expectedRevision) {
    return { ok: false, error: 'conflict' };
  }
  const revision = input.expectedRevision + 1;
  if ('hide' in input) {
    if (input.hide !== true || !existing) return { ok: false, error: 'invalid' };
    await storage.put({ [PREFIX + id]: { id, revision, hidden: true } });
  } else {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const figureIds = figureIdsFor(input.figureIds);
    if (!name || !figureIds || /[\r\n]/u.test(name)) return { ok: false, error: 'invalid' };
    await storage.put({ [PREFIX + id]: { id, revision, name, figureIds } });
  }
  return { ok: true };
}
