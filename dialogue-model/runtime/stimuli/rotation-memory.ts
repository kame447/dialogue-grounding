// Rotation memory: the bundle, the projection onto the AI's screen and the version pin.
// Types, validators and readers are in rotation-memory-shape.ts (no data import) and are re-exported here.
//
// The bundle is generated (docs/review/build-rotation-memory.ts), immutable and versioned; a changed bundle gets a new
// version and a new pin. A figure the bundle does not know simply has no memory: nothing here is a reason to stop a trial.
import {
  ROTATION_MEMORY_VERSION, ROTATION_MEMORY_CATALOG_REVISION, ROTATION_MEMORY_DATA_SHA256, ROTATION_MEMORY_ENTRIES,
} from './rotation-memory-data.ts';
import {
  ABSOLUTE_ROTATIONS, RELATIVE_ROTATIONS,
  type AbsoluteRotation, type OwnRotationMemory, type OwnRotationView, type RotationMemoryEntry, type RotationMemoryPin, type RotationMemoryViewRecord,
} from './rotation-memory-shape.ts';

export * from './rotation-memory-shape.ts';
export { ROTATION_MEMORY_VERSION, ROTATION_MEMORY_CATALOG_REVISION, ROTATION_MEMORY_DATA_SHA256 };

function absoluteRotation(value: unknown): AbsoluteRotation {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError('invalid_rotation_memory_input');
  const turn = ((value % 360) + 360) % 360;
  if (turn % 90 !== 0) throw new TypeError('invalid_rotation_memory_input');
  return turn as AbsoluteRotation;
}

function projectView(view: RotationMemoryViewRecord): OwnRotationView {
  return {
    whole: [...view.whole].sort((a, b) => a.rank - b.rank).map(c => ({
      noun: c.noun, posture: c.posture, direction: c.direction,
      ...(c.confidence === '低' ? {} : { confidence: c.confidence }),
      roles: Object.fromEntries(c.parts.map(p => [p.id, p.role])),
    })),
    parts: Object.fromEntries(view.parts.map(p => [p.id, p.candidates.map(c => ({
      noun: c.noun, ...(c.owner === undefined ? {} : { owner: c.owner }),
      ...(c.confidence === '低' ? {} : { confidence: c.confidence }),
    }))])),
  };
}

/**
 * Pure projection of one researcher-side entry onto the AI's screen: `currentRotation` is the absolute rotation now
 * shown. The result is a fresh object every call (no shared references with the bundle) with a fixed key order, so
 * equal inputs give equal bytes. Throws a TypeError for a rotation that is not a multiple of 90.
 */
export function projectRotationMemoryEntry(entry: RotationMemoryEntry, currentRotation: number): OwnRotationMemory {
  const current = absoluteRotation(currentRotation);
  const base = entry.views[current];
  return {
    regions: entry.regions.map(r => {
      const layout = base.layout.find(l => l.id === r.id)!;
      return { id: r.id, shapeName: r.shapeName, areaPercent: r.areaPercent, at: layout.at,
        ...(layout.tipDirection === null ? {} : { tip: layout.tipDirection }), ...(r.concave === true ? { concave: true as const } : {}),
        adjacent: [...r.adjacent] };
    }),
    current: projectView(base),
    turned: RELATIVE_ROTATIONS.map(rel => ({ rel, ...projectView(entry.views[((current + rel) % 360) as AbsoluteRotation]) })),
    wholeAnywhere: ABSOLUTE_ROTATIONS.some(r => entry.views[r].whole.length > 0),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<string | symbol, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
const bundle = new Map(deepFreeze(ROTATION_MEMORY_ENTRIES).map(entry => [entry.figureKey, entry] as const));

/** The researcher-side entry of one figure (frozen), or undefined when the bundle has none. */
export function rotationMemoryEntry(figureKey: string): RotationMemoryEntry | undefined {
  return typeof figureKey === 'string' ? bundle.get(figureKey) : undefined;
}

/**
 * Model-facing memory of one of the AI's own figures. `figureKey` is the bank figure ID and `rotation` the absolute
 * rotation currently shown (researcher-side values); neither appears in the result. A figure the bundle does not know
 * gives undefined: the caller keeps the existing own-geometry path without a new stop.
 */
export function projectOwnRotationMemory(input: { figureKey: string; rotation: number }): OwnRotationMemory | undefined {
  const rotation = absoluteRotation(input?.rotation);
  const entry = rotationMemoryEntry(input.figureKey);
  return entry === undefined ? undefined : projectRotationMemoryEntry(entry, rotation);
}

/** The pin of the bundle compiled into this build. A reception stores it; it is not a switch. */
export function rotationMemoryPin(): RotationMemoryPin {
  return { version: ROTATION_MEMORY_VERSION, dataSha256: ROTATION_MEMORY_DATA_SHA256, catalogRevision: ROTATION_MEMORY_CATALOG_REVISION };
}
