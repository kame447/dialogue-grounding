import { createHash } from 'node:crypto';
import { FIGURES } from './figures.mjs';
import { PIECES } from './pieces.mjs';

// Candidate stimulus bank for researcher pilots (Issue #180). It is not a formally adopted
// experimental condition: set membership and the selection mode need researcher approval.
export const FIGURE_BANK_VERSION = 'tangram-bank-v1';
export const LEGACY_FIGURE_SET_ID = 'legacy-v1';

type Point = readonly [number, number];
export type BankPiece = { readonly id: string; readonly type: string; readonly points: readonly Point[] };
export type BankFigure = { readonly id: string; readonly pieces: readonly BankPiece[] };

// F7-F30: piece polygons in PIECES order (L1, L2, M, S1, S2, Q, P), integer coordinates.
// Found by a seeded search and verified by validateFigures (area 8, no overlap, edge-connected,
// no rotation/reflection duplicates). F7/F8, F9/F10, F13/F14, F19/F20, F21/F22, F25/F26 are
// near-twin pairs (one piece relocated). IDs carry no semantic names.
const addedCoordinates: readonly (readonly (readonly Point[])[])[] = [
  [[[0,2],[0,0],[2,2]],[[0,2],[-2,2],[0,0]],[[-2,0],[-2,2],[-1,1]],[[2,1],[2,2],[1,1]],[[2,1],[1,1],[2,0]],[[2,0],[2,1],[3,1],[3,0]],[[2,3],[1,3],[0,2],[1,2]]],
  [[[0,2],[0,0],[2,2]],[[0,2],[-2,2],[0,0]],[[-2,0],[-2,2],[-1,1]],[[2,1],[2,2],[1,1]],[[2,1],[1,1],[2,0]],[[2,0],[2,1],[3,1],[3,0]],[[2,0],[3,0],[4,-1],[3,-1]]],
  [[[2,0],[2,2],[0,0]],[[2,0],[2,2],[4,0]],[[2,0],[4,0],[3,-1]],[[3,2],[2,2],[3,1]],[[1,2],[1,1],[2,2]],[[2,2],[2,3],[3,3],[3,2]],[[5,0],[4,0],[3,-1],[4,-1]]],
  [[[2,0],[2,2],[0,0]],[[2,0],[2,2],[4,0]],[[2,0],[4,0],[3,-1]],[[3,2],[2,2],[3,1]],[[1,2],[1,1],[2,2]],[[2,2],[2,3],[3,3],[3,2]],[[1,0],[2,0],[3,-1],[2,-1]]],
  [[[0,0],[0,2],[2,0]],[[0,2],[-2,2],[0,0]],[[-1,-1],[-1,1],[0,0]],[[-1,1],[-2,1],[-1,0]],[[-2,1],[-2,2],[-1,1]],[[0,-1],[0,0],[1,0],[1,-1]],[[-2,-2],[-2,-1],[-1,0],[-1,-1]]],
  [[[2,0],[2,2],[0,0]],[[2,0],[0,0],[2,-2]],[[0,0],[0,2],[1,1]],[[0,1],[0,2],[-1,1]],[[0,0],[0,1],[-1,0]],[[-1,-1],[-1,0],[0,0],[0,-1]],[[0,1],[-1,1],[-2,0],[-1,0]]],
  [[[2,0],[2,2],[0,0]],[[0,2],[0,0],[2,2]],[[0,2],[0,0],[-1,1]],[[1,0],[1,-1],[2,0]],[[2,1],[2,0],[3,1]],[[1,2],[1,3],[2,3],[2,2]],[[1,-2],[1,-1],[2,0],[2,-1]]],
  [[[2,0],[2,2],[0,0]],[[0,2],[0,0],[2,2]],[[0,2],[0,0],[-1,1]],[[1,0],[1,-1],[2,0]],[[2,1],[2,0],[3,1]],[[2,1],[2,2],[3,2],[3,1]],[[1,-2],[1,-1],[2,0],[2,-1]]],
  [[[2,2],[0,2],[2,0]],[[2,2],[2,0],[4,2]],[[4,0],[2,0],[3,1]],[[1,0],[1,1],[2,0]],[[1,0],[1,-1],[2,0]],[[1,2],[1,3],[2,3],[2,2]],[[0,4],[0,3],[1,2],[1,3]]],
  [[[0,2],[0,0],[2,2]],[[2,2],[2,4],[0,2]],[[0,2],[0,0],[-1,1]],[[0,3],[0,2],[1,3]],[[-1,2],[-1,1],[0,2]],[[-1,2],[-1,3],[0,3],[0,2]],[[2,3],[2,4],[3,5],[3,4]]],
  [[[0,2],[0,0],[2,2]],[[2,2],[2,4],[0,2]],[[0,2],[0,0],[-1,1]],[[2,1],[2,2],[1,1]],[[2,1],[2,2],[3,1]],[[2,0],[2,1],[3,1],[3,0]],[[2,2],[2,3],[3,4],[3,3]]],
  [[[2,0],[2,2],[0,0]],[[2,0],[2,2],[4,0]],[[2,2],[4,2],[3,1]],[[3,2],[3,3],[2,2]],[[3,0],[3,-1],[4,0]],[[1,-1],[1,0],[2,0],[2,-1]],[[3,2],[3,3],[4,4],[4,3]]],
  [[[2,2],[0,2],[2,0]],[[2,2],[2,4],[0,2]],[[-1,3],[1,3],[0,2]],[[2,0],[2,1],[3,0]],[[2,2],[2,1],[3,2]],[[2,-1],[2,0],[3,0],[3,-1]],[[4,3],[3,3],[2,2],[3,2]]],
  [[[2,2],[0,2],[2,0]],[[2,2],[2,4],[0,2]],[[1,1],[-1,1],[0,2]],[[2,0],[2,1],[3,0]],[[2,2],[2,1],[3,2]],[[2,-1],[2,0],[3,0],[3,-1]],[[4,3],[3,3],[2,2],[3,2]]],
  [[[0,0],[0,2],[2,0]],[[0,0],[0,-2],[2,0]],[[3,-1],[1,-1],[2,0]],[[2,1],[1,1],[2,0]],[[1,1],[1,2],[2,1]],[[2,0],[2,1],[3,1],[3,0]],[[0,3],[0,2],[1,1],[1,2]]],
  [[[0,0],[0,2],[2,0]],[[0,0],[0,-2],[2,0]],[[3,-1],[1,-1],[2,0]],[[2,1],[1,1],[2,0]],[[1,1],[1,2],[2,1]],[[-1,-2],[-1,-1],[0,-1],[0,-2]],[[0,3],[0,2],[1,1],[1,2]]],
  [[[0,0],[0,2],[2,0]],[[0,2],[-2,2],[0,0]],[[-1,1],[-3,1],[-2,2]],[[-1,0],[-1,1],[0,0]],[[-1,0],[-1,-1],[0,0]],[[-2,-1],[-2,0],[-1,0],[-1,-1]],[[1,3],[0,3],[-1,2],[0,2]]],
  [[[0,2],[0,0],[2,2]],[[0,2],[0,4],[2,2]],[[0,4],[0,2],[-1,3]],[[-1,4],[-1,3],[0,4]],[[0,4],[0,5],[-1,4]],[[0,4],[0,5],[1,5],[1,4]],[[-1,4],[-1,5],[0,6],[0,5]]],
  [[[2,2],[0,2],[2,0]],[[0,0],[0,2],[2,0]],[[0,0],[2,0],[1,-1]],[[2,1],[2,0],[3,1]],[[3,0],[3,1],[2,0]],[[0,2],[0,3],[1,3],[1,2]],[[-1,1],[-1,2],[0,3],[0,2]]],
  [[[2,2],[0,2],[2,0]],[[0,0],[0,2],[2,0]],[[0,0],[2,0],[1,-1]],[[2,1],[2,0],[3,1]],[[3,0],[3,1],[2,0]],[[0,2],[0,3],[1,3],[1,2]],[[-1,-1],[-1,0],[0,1],[0,0]]],
  [[[0,0],[0,2],[2,0]],[[0,2],[-2,2],[0,0]],[[-2,0],[-2,2],[-1,1]],[[-2,2],[-3,2],[-2,1]],[[-1,2],[-1,3],[-2,2]],[[-3,2],[-3,3],[-2,3],[-2,2]],[[0,2],[1,2],[2,1],[1,1]]],
  [[[2,2],[0,2],[2,0]],[[2,2],[2,0],[4,2]],[[4,2],[2,2],[3,3]],[[2,3],[2,2],[3,3]],[[2,2],[2,3],[1,2]],[[2,3],[2,4],[3,4],[3,3]],[[3,3],[4,3],[5,2],[4,2]]],
  [[[2,0],[2,2],[0,0]],[[2,0],[2,2],[4,0]],[[2,2],[4,2],[3,1]],[[2,0],[2,-1],[3,0]],[[2,2],[2,3],[3,2]],[[1,-1],[1,0],[2,0],[2,-1]],[[1,0],[0,0],[-1,-1],[0,-1]]],
  [[[0,0],[0,2],[2,0]],[[2,0],[0,0],[2,-2]],[[1,3],[1,1],[0,2]],[[0,1],[0,2],[-1,1]],[[2,1],[1,1],[2,0]],[[2,-2],[2,-1],[3,-1],[3,-2]],[[2,-2],[3,-2],[4,-3],[3,-3]]],
] as unknown as readonly (readonly (readonly Point[])[])[];

const pieceDefs = PIECES as unknown as readonly { id: string; type: string }[];

const added: readonly BankFigure[] = addedCoordinates.map((polygons, index) => Object.freeze({
  id: 'F' + (index + 7),
  pieces: Object.freeze(polygons.map((points, i) => Object.freeze({
    id: pieceDefs[i].id, type: pieceDefs[i].type,
    points: Object.freeze(points.map(p => Object.freeze([p[0], p[1]] as const))),
  }))),
}));

/** F1-F6 are the unchanged legacy figures; F7-F30 are new. */
export const FIGURE_BANK: readonly BankFigure[] = Object.freeze([...(FIGURES as readonly BankFigure[]), ...added]);

const bankIds = new Set(FIGURE_BANK.map(f => f.id));
export const FIGURE_SET_SIZE = 6;

// Researcher pilot candidates, not formally adopted experimental conditions.
export const FIGURE_SETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'legacy-v1': Object.freeze(['F1', 'F2', 'F3', 'F4', 'F5', 'F6']),
  'bank-set-a': Object.freeze(['F7', 'F8', 'F9', 'F10', 'F11', 'F12']),
  'bank-set-b': Object.freeze(['F13', 'F14', 'F15', 'F16', 'F17', 'F18']),
  'bank-set-c': Object.freeze(['F19', 'F20', 'F21', 'F22', 'F23', 'F24']),
  'bank-set-d': Object.freeze(['F25', 'F26', 'F27', 'F28', 'F29', 'F30']),
});

export type FigureSelectionSpec =
  | { mode: 'preset'; setId: string }
  | { mode: 'seeded_random'; selectionSeed: number }
  | { mode: 'custom'; figureIds: readonly string[] };

export type ResolvedFigureSelection = {
  bankVersion: typeof FIGURE_BANK_VERSION;
  mode: 'preset' | 'seeded_random' | 'custom';
  setId: string | null;
  selectionSeed: number | null;
  figureIds: readonly string[];
};

const sha256 = (text: string) => createHash('sha256').update(text).digest();

function validateFigureIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== FIGURE_SET_SIZE) throw new TypeError('figureIds must list exactly six figures');
  if (!value.every(id => typeof id === 'string' && bankIds.has(id))) throw new TypeError('unknown figure id');
  if (new Set(value).size !== value.length) throw new TypeError('figureIds must not repeat');
  return [...value];
}

function seededFigureIds(selectionSeed: number): string[] {
  const ids = FIGURE_BANK.map(f => f.id);
  const digest = sha256(`${FIGURE_BANK_VERSION}:selection:${selectionSeed}`);
  // Fisher-Yates driven by a SHA-256 stream (one hash per draw, rejection-free modulo of 32 bits).
  for (let i = ids.length - 1, draw = 0; i > 0; i--, draw++) {
    const value = createHash('sha256').update(digest).update(String(draw)).digest().readUInt32BE(0);
    const j = value % (i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, FIGURE_SET_SIZE);
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function expectedSelection(mode: unknown, spec: Record<string, unknown>): ResolvedFigureSelection {
  if (mode === 'preset') {
    const setId = spec.setId;
    if (typeof setId !== 'string' || !Object.hasOwn(FIGURE_SETS, setId)) throw new TypeError('unknown figure set');
    return { bankVersion: FIGURE_BANK_VERSION, mode, setId, selectionSeed: null, figureIds: [...FIGURE_SETS[setId]] };
  }
  if (mode === 'seeded_random') {
    const seed = spec.selectionSeed;
    if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw new TypeError('selectionSeed must be a safe integer');
    const figureIds = seededFigureIds(seed);
    return { bankVersion: FIGURE_BANK_VERSION, mode, setId: 'seeded-' + sha256(`${FIGURE_BANK_VERSION}:${seed}:${figureIds.join(',')}`).toString('hex').slice(0, 8), selectionSeed: seed, figureIds };
  }
  if (mode === 'custom') {
    const figureIds = validateFigureIds(spec.figureIds);
    return { bankVersion: FIGURE_BANK_VERSION, mode, setId: 'custom-' + sha256(figureIds.join(',')).toString('hex').slice(0, 8), selectionSeed: null, figureIds };
  }
  throw new TypeError('unknown figure selection mode');
}

const SPEC_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  preset: ['mode', 'setId'],
  seeded_random: ['mode', 'selectionSeed'],
  custom: ['mode', 'figureIds'],
});
const RESOLVED_KEYS = ['bankVersion', 'mode', 'setId', 'selectionSeed', 'figureIds'] as const;
const hasExactKeys = (obj: Record<string, unknown>, keys: readonly string[]): boolean => {
  const names = Object.keys(obj);
  return names.length === keys.length && keys.every(k => Object.hasOwn(obj, k));
};

/** Resolves a selection spec or validates an already resolved selection; undefined means the legacy F1-F6 set. Fails closed on anything else. */
export function resolveFigureSelection(spec?: unknown): ResolvedFigureSelection {
  if (spec === undefined) return expectedSelection('preset', { setId: LEGACY_FIGURE_SET_ID });
  if (!isRecord(spec)) throw new TypeError('figure selection must be an object');
  const rawKeys = typeof spec.mode === 'string' && Object.hasOwn(SPEC_KEYS, spec.mode) ? SPEC_KEYS[spec.mode] : null;
  if (rawKeys && hasExactKeys(spec, rawKeys)) return expectedSelection(spec.mode, spec);
  return validateResolvedFigureSelection(spec);
}

/** Strict check of an already resolved selection (e.g. from a stored record). */
export function validateResolvedFigureSelection(value: unknown): ResolvedFigureSelection {
  if (!isRecord(value)) throw new TypeError('resolved figure selection must be an object');
  if (!hasExactKeys(value, RESOLVED_KEYS)) throw new TypeError('resolved figure selection has unexpected keys');
  if (value.bankVersion !== FIGURE_BANK_VERSION) throw new TypeError('unknown bank version');
  const ids = validateFigureIds(value.figureIds);
  const mode = value.mode;
  const expected = mode === 'custom' ? expectedSelection(mode, { figureIds: ids })
    : mode === 'preset' ? expectedSelection(mode, { setId: value.setId })
    : mode === 'seeded_random' ? expectedSelection(mode, { selectionSeed: value.selectionSeed })
    : expectedSelection(mode, {});
  const same = expected.setId === value.setId && expected.selectionSeed === value.selectionSeed
    && expected.figureIds.length === ids.length && expected.figureIds.every((id, i) => id === ids[i]);
  if (!same) throw new TypeError('resolved figure selection is inconsistent');
  return expected;
}

export function isLegacyFigureSelection(selection: ResolvedFigureSelection): boolean {
  const legacy = FIGURE_SETS[LEGACY_FIGURE_SET_ID];
  return selection.mode === 'preset' && selection.setId === LEGACY_FIGURE_SET_ID
    && selection.figureIds.length === legacy.length && selection.figureIds.every((id, i) => id === legacy[i]);
}
