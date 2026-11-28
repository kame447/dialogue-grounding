// Rotation memory: what the AI could see in its OWN figures if it turned them, prepared before the session.
// This file holds only types, validators and small readers. It imports no bundle data, so code that merely validates or
// reads a saved projection (observation memo, feature evidence) does not pull the data in. The bundle, the projection
// and the pin live in rotation-memory.ts.
//
// Two layers, never mixed:
//   - RotationMemoryEntry   researcher-side bundle of ONE figure (all four absolute views). It carries the bank
//     figure key and absolute rotations and must never be sent to a model.
//   - OwnRotationMemory     the model-facing projection for one figure on the AI's screen. Views are relative to the
//     rotation currently shown (rel 0 = now; 90/180/270 = turned clockwise by that much). It holds no figure key,
//     bank ID, absolute rotation, rotation mode or anything about the partner's side.
//
// Every candidate is an AI proposal (a hypothesis), not an answer key; a matching candidate alone never fixes a
// target, an agreement or a name.

export type AbsoluteRotation = 0 | 90 | 180 | 270;
export type RelativeRotation = 90 | 180 | 270;
export const ABSOLUTE_ROTATIONS: readonly AbsoluteRotation[] = Object.freeze([0, 90, 180, 270] as const);
/** Clockwise turns from the view now on screen; the current view itself is rel 0 and lives in `current`. */
export const RELATIVE_ROTATIONS: readonly RelativeRotation[] = Object.freeze([90, 180, 270] as const);

export type Confidence = '高' | '中' | '低';
export type ReviewStatus = 'ai_unreviewed' | 'researcher_confirmed' | 'researcher_edited';
/** Where a region's centroid lies in the figure's bounding box (thirds), as in the earlier prepared region notes. */
export const POSITION_WORDS = Object.freeze(['中央付近', '左寄り', '右寄り', '上寄り', '下寄り', '左上寄り', '右上寄り', '左下寄り', '右下寄り'] as const);
export type PositionWord = typeof POSITION_WORDS[number];
/** Eight-way direction of a triangle's apex (screen up = 上). */
export const DIRECTION_WORDS = Object.freeze(['上', '右上', '右', '右下', '下', '左下', '左', '左上'] as const);
export type DirectionWord = typeof DIRECTION_WORDS[number];

// Engineering bounds for the validators, not experimental conditions. The generated data stays well inside them.
export const ROTATION_MEMORY_LIMITS = Object.freeze({
  regions: 8, whole: 3, partCandidates: 3, noun: 40, owner: 40, posture: 80, direction: 80, role: 80, shapeName: 24,
});

// ---- Researcher-side bundle (internal; never sent to a model) ----

export type RotationMemoryRegion = {
  id: string;
  /** Source atom IDs of the confirmed partition (strings; split atoms such as "2a"/"2b" exist). Identical in all four views. */
  members: string[];
  shapeName: string;
  sides: number | null;
  areaPercent: number;
  /** Present only for a region whose outline has a dent. */
  concave?: true;
  adjacent: string[];
};
export type RotationMemoryLayout = { id: string; at: PositionWord; tipDirection: DirectionWord | null };
export type RotationMemoryWhole = {
  rank: number; noun: string; posture: string; direction: string; confidence: Confidence;
  /** Role of EVERY region of this view in the whole, in region order. */
  parts: { id: string; role: string }[];
};
export type RotationMemoryPart = { id: string; candidates: { noun: string; confidence: Confidence; owner?: string }[] };
export type RotationMemoryViewRecord = {
  layout: RotationMemoryLayout[];
  /** [] = no whole construal in this view. */
  whole: RotationMemoryWhole[];
  /** Only regions that have at least one adopted candidate. */
  parts: RotationMemoryPart[];
  reviewStatus: ReviewStatus;
};
export type RotationMemoryEntry = {
  /** Bank figure ID. Internal only. */
  figureKey: string;
  regions: RotationMemoryRegion[];
  views: Record<AbsoluteRotation, RotationMemoryViewRecord>;
};

// ---- Model-facing projection ----

export type OwnRotationRegion = {
  id: string; shapeName: string; areaPercent: number;
  /** Position on the AI's screen NOW. Directions inside a turned view are only meaningful inside that view. */
  at: PositionWord;
  /** Apex direction of a triangle on the AI's screen NOW. */
  tip?: DirectionWord;
  concave?: true;
  adjacent: string[];
};
/** A confidence of 低 is expressed by omission; only 中 and 高 are written. */
export type OwnRotationPartCandidate = { noun: string; owner?: string; confidence?: '中' | '高' };
export type OwnRotationWholeCandidate = {
  noun: string; posture: string; direction: string; confidence?: '中' | '高';
  /** Region ID -> the role that region plays in this whole. */
  roles: Record<string, string>;
};
export type OwnRotationView = {
  /** [] = no whole construal in this view. */
  whole: OwnRotationWholeCandidate[];
  /** Region ID -> part candidates; only regions that have any. */
  parts: Record<string, OwnRotationPartCandidate[]>;
};
export type OwnRotationMemory = {
  regions: OwnRotationRegion[];
  current: OwnRotationView;
  turned: ({ rel: RelativeRotation } & OwnRotationView)[];
  /** True when any of the four views has a whole construal. False is different from "no whole construal now". */
  wholeAnywhere: boolean;
};

/** The pin of a bundle: what a reception stores. It is a record of which data was used, not a switch. */
export type RotationMemoryPin = { version: string; dataSha256: string; catalogRevision: string };

// ---- Validation helpers ----

const fail = (): never => { throw new TypeError('invalid_rotation_memory'); };
const IMAGE_LIKE = /data\s*:\s*image|image_url|base64/iu;
const REGION_ID = /^P[1-9][0-9]?$/u;

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || !required.includes(k) && !optional.includes(k)) || !required.every(k => keys.includes(k))) return fail();
  for (const key of keys as string[]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) return fail();
  }
  return value as Record<string, unknown>;
}
const text = (value: unknown, max: number): string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !IMAGE_LIKE.test(value) ? value : fail();
const array = (value: unknown, min: number, max: number): unknown[] =>
  Array.isArray(value) && value.length >= min && value.length <= max ? value : fail();
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => allowed.includes(value as T) ? value as T : fail();
const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : fail();
/** A dictionary whose keys are region IDs; returns its entries in region order. */
function byRegion(value: unknown, ids: readonly string[]): [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || !ids.includes(k))) return fail();
  return ids.filter(id => keys.includes(id)).map(id => {
    const field = Object.getOwnPropertyDescriptor(value, id);
    return field && Object.hasOwn(field, 'value') && field.enumerable ? [id, field.value] as [string, unknown] : fail();
  });
}
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const regionNumber = (id: string) => Number(id.slice(1));

function regionIds(rows: unknown[]): string[] {
  const ids = rows.map(row => text((row as { id?: unknown } | null)?.id, 3));
  if (ids.some(id => !REGION_ID.test(id)) || new Set(ids).size !== ids.length) return fail();
  return ids;
}
/** Adjacent IDs must exist, exclude the region itself, repeat nothing and be listed in region order. */
function adjacency(value: unknown, ids: readonly string[], self: string): string[] {
  const adjacent = array(value, 0, ids.length - 1).map(a => text(a, 3));
  if (adjacent.some(a => !ids.includes(a) || a === self) || new Set(adjacent).size !== adjacent.length || !sameList(adjacent, ids.filter(id => adjacent.includes(id)))) return fail();
  return adjacent;
}
const area = (value: unknown): number => { const n = finite(value); return n > 0 && n <= 100 ? n : fail(); };

// ---- Validation of the researcher-side bundle ----

function validateEntryView(value: unknown, regions: RotationMemoryRegion[]): RotationMemoryViewRecord {
  const ids = regions.map(r => r.id);
  const view = record(value, ['layout', 'whole', 'parts', 'reviewStatus']);
  const layout = array(view.layout, ids.length, ids.length).map((row, i): RotationMemoryLayout => {
    const l = record(row, ['id', 'at', 'tipDirection']);
    if (l.id !== ids[i]) return fail();
    return { id: ids[i], at: oneOf(l.at, POSITION_WORDS), tipDirection: l.tipDirection === null ? null : oneOf(l.tipDirection, DIRECTION_WORDS) };
  });
  const whole = array(view.whole, 0, ROTATION_MEMORY_LIMITS.whole).map((row, i): RotationMemoryWhole => {
    const c = record(row, ['rank', 'noun', 'posture', 'direction', 'confidence', 'parts']);
    if (c.rank !== i + 1) return fail();
    const parts = array(c.parts, ids.length, ids.length).map((p, k) => {
      const part = record(p, ['id', 'role']);
      if (part.id !== ids[k]) return fail();
      return { id: ids[k], role: text(part.role, ROTATION_MEMORY_LIMITS.role) };
    });
    return { rank: i + 1, noun: text(c.noun, ROTATION_MEMORY_LIMITS.noun), posture: text(c.posture, ROTATION_MEMORY_LIMITS.posture),
      direction: text(c.direction, ROTATION_MEMORY_LIMITS.direction), confidence: oneOf(c.confidence, ['高', '中', '低'] as const), parts };
  });
  let last = -1;
  const parts = array(view.parts, 0, ids.length).map((row): RotationMemoryPart => {
    const p = record(row, ['id', 'candidates']);
    const index = ids.indexOf(text(p.id, 3));
    if (index <= last) return fail();
    last = index;
    return { id: ids[index], candidates: array(p.candidates, 1, ROTATION_MEMORY_LIMITS.partCandidates).map(candidate => {
      const c = record(candidate, ['noun', 'confidence'], ['owner']);
      return { noun: text(c.noun, ROTATION_MEMORY_LIMITS.noun), confidence: oneOf(c.confidence, ['高', '中', '低'] as const),
        ...(c.owner === undefined ? {} : { owner: text(c.owner, ROTATION_MEMORY_LIMITS.owner) }) };
    }) };
  });
  return { layout, whole, parts, reviewStatus: oneOf(view.reviewStatus, ['ai_unreviewed', 'researcher_confirmed', 'researcher_edited'] as const) };
}

/** Strict check of one researcher-side bundle entry; returns a detached, canonically ordered copy. */
export function validateRotationMemoryEntry(value: unknown): RotationMemoryEntry {
  const entry = record(value, ['figureKey', 'regions', 'views']);
  const rows = array(entry.regions, 1, ROTATION_MEMORY_LIMITS.regions);
  const ids = regionIds(rows);
  const regions = rows.map((row, i): RotationMemoryRegion => {
    const r = record(row, ['id', 'members', 'shapeName', 'sides', 'areaPercent', 'adjacent'], ['concave']);
    const sides = r.sides === null ? null : finite(r.sides);
    if (sides !== null && (!Number.isInteger(sides) || sides < 3 || sides > 12)) return fail();
    const members = array(r.members, 1, 12).map(m => text(m, 4));
    if (new Set(members).size !== members.length) return fail();
    if (r.concave !== undefined && r.concave !== true) return fail();
    return { id: ids[i], members, shapeName: text(r.shapeName, ROTATION_MEMORY_LIMITS.shapeName), sides, areaPercent: area(r.areaPercent),
      ...(r.concave === true ? { concave: true as const } : {}), adjacent: adjacency(r.adjacent, ids, ids[i]) };
  });
  if (Math.abs(regions.reduce((sum, r) => sum + r.areaPercent, 0) - 100) > 1e-6) return fail();
  for (const r of regions) for (const a of r.adjacent) if (!regions.find(x => x.id === a)!.adjacent.includes(r.id)) return fail();
  const views = record(entry.views, ABSOLUTE_ROTATIONS.map(String));
  return { figureKey: text(entry.figureKey, 8), regions, views: {
    0: validateEntryView(views['0'], regions), 90: validateEntryView(views['90'], regions),
    180: validateEntryView(views['180'], regions), 270: validateEntryView(views['270'], regions),
  } };
}

/** Strict check of a whole bundle: every entry valid and figure keys unique. */
export function validateRotationMemoryBundle(value: unknown): RotationMemoryEntry[] {
  const entries = array(value, 1, 1000).map(validateRotationMemoryEntry);
  if (new Set(entries.map(e => e.figureKey)).size !== entries.length) return fail();
  return entries;
}

// ---- Validation of the model-facing projection ----

function validateView(value: unknown, ids: readonly string[], extra: readonly string[] = []): OwnRotationView {
  const view = record(value, ['whole', 'parts', ...extra]);
  const whole = array(view.whole, 0, ROTATION_MEMORY_LIMITS.whole).map((row): OwnRotationWholeCandidate => {
    const c = record(row, ['noun', 'posture', 'direction', 'roles'], ['confidence']);
    const roles = byRegion(c.roles, ids).map(([id, role]) => [id, text(role, ROTATION_MEMORY_LIMITS.role)] as const);
    if (!roles.length) return fail();
    return { noun: text(c.noun, ROTATION_MEMORY_LIMITS.noun), posture: text(c.posture, ROTATION_MEMORY_LIMITS.posture),
      direction: text(c.direction, ROTATION_MEMORY_LIMITS.direction),
      ...(c.confidence === undefined ? {} : { confidence: oneOf(c.confidence, ['中', '高'] as const) }), roles: Object.fromEntries(roles) };
  });
  const parts = Object.fromEntries(byRegion(view.parts, ids).map(([id, candidates]) => [id, array(candidates, 1, ROTATION_MEMORY_LIMITS.partCandidates).map((row): OwnRotationPartCandidate => {
    const c = record(row, ['noun'], ['owner', 'confidence']);
    return { noun: text(c.noun, ROTATION_MEMORY_LIMITS.noun), ...(c.owner === undefined ? {} : { owner: text(c.owner, ROTATION_MEMORY_LIMITS.owner) }),
      ...(c.confidence === undefined ? {} : { confidence: oneOf(c.confidence, ['中', '高'] as const) }) };
  })]));
  return { whole, parts };
}

/**
 * Strict restore/injection boundary for the model-facing projection; returns a detached, canonically ordered copy
 * (never a boolean). The saved projection a trial records can be validated with this on a cold restore. It throws a
 * TypeError for any shape it does not know; the caller decides what that means (it is not a reason to stop a trial).
 */
export function validateOwnRotationMemory(value: unknown): OwnRotationMemory {
  const top = record(value, ['regions', 'current', 'turned', 'wholeAnywhere']);
  const rows = array(top.regions, 1, ROTATION_MEMORY_LIMITS.regions);
  const ids = regionIds(rows);
  const regions = rows.map((row, i): OwnRotationRegion => {
    const r = record(row, ['id', 'shapeName', 'areaPercent', 'at', 'adjacent'], ['tip', 'concave']);
    if (r.concave !== undefined && r.concave !== true) return fail();
    return { id: ids[i], shapeName: text(r.shapeName, ROTATION_MEMORY_LIMITS.shapeName), areaPercent: area(r.areaPercent), at: oneOf(r.at, POSITION_WORDS),
      ...(r.tip === undefined ? {} : { tip: oneOf(r.tip, DIRECTION_WORDS) }), ...(r.concave === true ? { concave: true as const } : {}),
      adjacent: adjacency(r.adjacent, ids, ids[i]) };
  });
  const current = validateView(top.current, ids);
  const turned = array(top.turned, RELATIVE_ROTATIONS.length, RELATIVE_ROTATIONS.length).map((row, i) => {
    const view = validateView(row, ids, ['rel']);
    if ((row as { rel?: unknown }).rel !== RELATIVE_ROTATIONS[i]) return fail();
    return { rel: RELATIVE_ROTATIONS[i], ...view };
  });
  const wholeAnywhere = [current, ...turned].some(view => view.whole.length > 0);
  if (top.wholeAnywhere !== wholeAnywhere) return fail();
  return { regions, current, turned, wholeAnywhere };
}

/** Shape check of a stored pin; it does not require the pin to equal the bundle compiled in now. */
export function validateRotationMemoryPin(value: unknown): RotationMemoryPin {
  const pin = record(value, ['version', 'dataSha256', 'catalogRevision']);
  const check = (field: unknown, pattern: RegExp): string => typeof field === 'string' && pattern.test(field) ? field : fail();
  return { version: check(pin.version, /^tangram_rotation_memory_v[1-9][0-9]*$/u), dataSha256: check(pin.dataSha256, /^[a-f0-9]{64}$/u),
    catalogRevision: check(pin.catalogRevision, /^review-final-[a-f0-9]{16}$/u) };
}

// ---- Readers over a projection ----

/**
 * The string at a path inside a projection (relative to the projection, e.g. ['current','whole',0,'roles','P1'] or
 * ['turned',1,'parts','P1',0,'noun']), or undefined when the path does not lead to a string. For checking that a
 * statement is backed by the memory.
 */
export function rotationSourceValue(rotation: OwnRotationMemory, path: readonly (string | number)[]): string | undefined {
  let node: unknown = rotation;
  for (const key of path) {
    if (Array.isArray(node)) {
      if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= node.length) return undefined;
      node = node[key];
    } else if (node !== null && typeof node === 'object') {
      if (typeof key !== 'string' || !Object.hasOwn(node, key)) return undefined;
      node = (node as Record<string, unknown>)[key];
    } else return undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Names the AI may use for the whole figure: the whole nouns of the current view, then of the turned views, each once.
 * Part nouns are not names of the figure. Empty when no view has a whole construal.
 */
export function rotationNameCandidates(rotation: OwnRotationMemory): string[] {
  return [...new Set([rotation.current, ...rotation.turned].flatMap(view => view.whole.map(c => c.noun)))];
}

/**
 * Plain geometric statements about the figure as it is on the AI's screen now, without any construal word: one per
 * region and one per touching pair (region order). The catalog of features a statement may be built on.
 */
export function rotationFeatureCandidates(rotation: OwnRotationMemory): string[] {
  const shapes = rotation.regions.map(r => `${r.id}: ${r.at}の${r.shapeName}（全体面積の${r.areaPercent}%）`
    + (r.tip === undefined ? '' : `。頂点は${r.tip}向き`) + (r.concave === true ? '。輪郭にくぼみがある' : '') + '。');
  const relations = rotation.regions.flatMap(r => r.adjacent.filter(a => regionNumber(a) > regionNumber(r.id)).map(a => `${r.id}と${a}は辺で接する。`));
  return [...shapes, ...relations];
}
