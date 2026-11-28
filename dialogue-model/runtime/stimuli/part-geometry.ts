import { boundarySegments, EPSILON, intersectionArea, polygonArea, sharesEdge } from './geometry.mjs';

export const PART_GEOMETRY_VERSION = 'tangram_parts_v1';
export const REVIEWED_PART_GEOMETRY_VERSION = 'tangram_parts_reviewed_20261128_v1' as const;
export type PartObservationVersion = typeof PART_GEOMETRY_VERSION | typeof REVIEWED_PART_GEOMETRY_VERSION;
export const isPartObservationVersion = (value: unknown): value is PartObservationVersion => value === PART_GEOMETRY_VERSION || value === REVIEWED_PART_GEOMETRY_VERSION;

export type PartPoint = [number, number];
type Polygon = readonly (readonly [number, number])[];
type Segment = [PartPoint, PartPoint];
export type PartShape = 'triangle' | 'square' | 'rectangle' | 'rhombus' | 'parallelogram' |
  'trapezoid' | 'quadrilateral' | 'pentagon' | 'hexagon' | 'polygon' | 'compound';
export type GeometryPart = {
  members: number[];
  shape: PartShape;
  sides: number | null;
  convex: boolean | null;
  outlines: PartPoint[][];
  bbox: [number, number, number, number];
  /** Fraction of each outline edge present on the complete silhouette. Zero denotes an inferred cut. */
  edgeVisibility: number[][];
};
export type PartGeometry = {
  version: PartObservationVersion;
  source: 'own_stimulus_geometry';
  coordinateFrame: 'figure_local_pixels';
  origin: PartPoint;
  size: PartPoint;
  /** One-based original piece indices; adjacency requires an edge of positive length. */
  adjacency: [number, number][];
  /** All seven original pieces and all edge-connected unions, including the complete figure. */
  parts: GeometryPart[];
};

const MAX_COORDINATE = 10000;
const SHAPES: readonly PartShape[] = ['triangle', 'square', 'rectangle', 'rhombus', 'parallelogram',
  'trapezoid', 'quadrilateral', 'pentagon', 'hexagon', 'polygon', 'compound'];
const round = (n: number) => Math.round(n * 1e8) / 1e8 || 0;
const pointKey = (p: readonly number[]) => p.map(round).join(',');
const sub = (a: readonly number[], b: readonly number[]): PartPoint => [a[0] - b[0], a[1] - b[1]];
const cross = (a: readonly number[], b: readonly number[]) => a[0] * b[1] - a[1] * b[0];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1];
const near = (a: number, b = 0) => Math.abs(a - b) < EPSILON;
const signedArea = (p: Polygon) => p.reduce((s, a, i) => s + cross(a, p[(i + 1) % p.length]), 0) / 2;
const coordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE;
const point = (v: unknown): v is PartPoint => Array.isArray(v) && v.length === 2 && v.every(coordinate);
const invalid = (): never => { throw new TypeError('invalid_part_geometry'); };
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => !!v &&
  Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).length === keys.length &&
  keys.every(k => Object.hasOwn(v, k));

function box(polygons: readonly Polygon[]): [number, number, number, number] {
  const all = polygons.flat(), xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return [round(x), round(y), round(Math.max(...xs) - x), round(Math.max(...ys) - y)];
}

function isConvex(p: Polygon): boolean {
  const turns = p.map((a, i) => cross(sub(p[(i + 1) % p.length], a),
    sub(p[(i + 2) % p.length], p[(i + 1) % p.length]))).filter(v => !near(v));
  return turns.length >= 3 && (turns.every(v => v > 0) || turns.every(v => v < 0));
}

function inputPolygons(value: unknown): PartPoint[][] {
  if (!Array.isArray(value) || value.length !== 7) return invalid();
  const polygons: PartPoint[][] = [];
  for (const polygon of value) {
    if (!Array.isArray(polygon) || ![3, 4].includes(polygon.length) || !polygon.every(point) ||
        new Set(polygon.map(pointKey)).size !== polygon.length || !isConvex(polygon) ||
        polygonArea(polygon) < EPSILON) return invalid();
    polygons.push(polygon.map(([x, y]) => [round(x), round(y)]));
  }
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
    if (intersectionArea(polygons[i], polygons[j]) > EPSILON) return invalid();
  }
  return polygons;
}

function connected(members: number[], adjacency: [number, number][]): boolean {
  const allowed = new Set(members), reached = new Set([members[0]]);
  for (let pass = 0; pass < members.length; pass++) {
    for (const [a, b] of adjacency) if (allowed.has(a) && allowed.has(b)) {
      if (reached.has(a)) reached.add(b);
      if (reached.has(b)) reached.add(a);
    }
  }
  return reached.size === members.length;
}

function simplify(loop: PartPoint[]): PartPoint[] {
  let result = loop;
  for (;;) {
    const next = result.filter((b, i) => {
      const a = result[(i + result.length - 1) % result.length], c = result[(i + 1) % result.length];
      return !near(cross(sub(b, a), sub(c, b))) || dot(sub(b, a), sub(c, b)) <= 0;
    });
    if (next.length === result.length) break;
    if (next.length < 3) return invalid();
    result = next;
  }
  let start = 0;
  for (let i = 1; i < result.length; i++) {
    if (result[i][0] < result[start][0] || result[i][0] === result[start][0] && result[i][1] < result[start][1]) start = i;
  }
  return result.map((_, i) => result[(start + i) % result.length]);
}

export function loopsOf(polygons: PartPoint[][]): { outlines: PartPoint[][]; simple: boolean } {
  const merged = boundarySegments(polygons) as Segment[];
  const endpoints = [...new Map(merged.flat().map(p => [pointKey(p), p])).values()];
  const edges: Segment[] = [];
  for (const [a, b] of merged) {
    const vector = sub(b, a), length2 = dot(vector, vector);
    const t = (p: PartPoint) => dot(sub(p, a), vector) / length2;
    const cuts = endpoints.filter(p => near(cross(vector, sub(p, a))) && t(p) >= -EPSILON && t(p) <= 1 + EPSILON)
      .sort((p, q) => t(p) - t(q));
    for (let i = 0; i + 1 < cuts.length; i++) edges.push([cuts[i], cuts[i + 1]]);
  }
  const outgoing = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const key = pointKey(edges[i][0]);
    outgoing.set(key, [...outgoing.get(key) ?? [], i]);
  }
  let simple = [...outgoing.values()].every(v => v.length === 1);
  const unused = new Set(edges.map((_, i) => i)), outlines: PartPoint[][] = [];
  while (unused.size) {
    let index = unused.values().next().value as number;
    const start = pointKey(edges[index][0]), loop: PartPoint[] = [];
    for (let step = 0; step <= edges.length; step++) {
      if (!unused.delete(index)) return invalid();
      const [a, b] = edges[index];
      loop.push(a);
      if (pointKey(b) === start) break;
      const candidates = (outgoing.get(pointKey(b)) ?? []).filter(i => unused.has(i));
      if (!candidates.length) return invalid();
      const incoming = sub(b, a);
      candidates.sort((i, j) => {
        const first = sub(edges[i][1], b), second = sub(edges[j][1], b);
        return Math.atan2(cross(incoming, second), dot(incoming, second)) -
          Math.atan2(cross(incoming, first), dot(incoming, first)) || i - j;
      });
      index = candidates[0];
    }
    if (loop.length < 3) return invalid();
    if (new Set(loop.map(pointKey)).size !== loop.length) simple = false;
    outlines.push(simplify(loop));
  }
  outlines.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)) ||
    JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return { outlines, simple: simple && outlines.length === 1 };
}

export function classify(outlines: PartPoint[][], simple: boolean): Pick<GeometryPart, 'shape' | 'sides' | 'convex'> {
  if (!simple) return { shape: 'compound', sides: null, convex: null };
  const p = outlines[0], sides = p.length, convex = isConvex(p);
  let shape: PartShape = sides === 3 ? 'triangle' : sides === 4 ? 'quadrilateral' :
    sides === 5 ? 'pentagon' : sides === 6 ? 'hexagon' : 'polygon';
  if (sides === 4 && convex) {
    const edges = p.map((a, i) => sub(p[(i + 1) % 4], a));
    const lengths = edges.map(v => dot(v, v));
    const equal = lengths.every(v => near(v, lengths[0]));
    const rectangular = edges.every((v, i) => near(dot(v, edges[(i + 1) % 4])));
    const parallel = [near(cross(edges[0], edges[2])), near(cross(edges[1], edges[3]))];
    if (rectangular) shape = equal ? 'square' : 'rectangle';
    else if (equal) shape = 'rhombus';
    else if (parallel.every(Boolean)) shape = 'parallelogram';
    else if (parallel.some(Boolean)) shape = 'trapezoid';
  }
  return { shape, sides, convex };
}

function visibleFraction(a: PartPoint, b: PartPoint, fullBoundary: Segment[]): number {
  const vector = sub(b, a), length2 = dot(vector, vector);
  let fraction = 0;
  for (const [c, d] of fullBoundary) {
    if (!near(cross(vector, sub(c, a))) || !near(cross(vector, sub(d, a)))) continue;
    const first = dot(sub(c, a), vector) / length2, second = dot(sub(d, a), vector) / length2;
    fraction += Math.max(0, Math.min(1, Math.max(first, second)) - Math.max(0, Math.min(first, second)));
  }
  return round(Math.max(0, Math.min(1, fraction)));
}

/** Structural candidates from own-side drawing geometry, never observed agreement or a unique decomposition. */
export function createPartGeometry(value: readonly Polygon[], version: PartObservationVersion = PART_GEOMETRY_VERSION): PartGeometry {
  if (!isPartObservationVersion(version)) return invalid();
  const input = inputPolygons(value);
  const [x, y, w, h] = box(input);
  const polygons: PartPoint[][] = input.map(p => p.map(([px, py]) => [round(px - x), round(py - y)]));
  const adjacency: [number, number][] = [];
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
    if (sharesEdge(polygons[i], polygons[j])) adjacency.push([i + 1, j + 1]);
  }
  if (!connected([1, 2, 3, 4, 5, 6, 7], adjacency)) return invalid();
  const fullBoundary = boundarySegments(polygons) as Segment[];
  const parts: GeometryPart[] = [];
  for (let mask = 1; mask < 128; mask++) {
    const members = Array.from({ length: 7 }, (_, i) => i + 1).filter(i => (mask & (1 << (i - 1))) !== 0);
    if (!connected(members, adjacency)) continue;
    const included = members.map(i => polygons[i - 1]);
    const { outlines, simple } = loopsOf(included);
    parts.push({ members, ...classify(outlines, simple), outlines, bbox: box(outlines),
      edgeVisibility: outlines.map(loop => loop.map((a, i) => visibleFraction(a, loop[(i + 1) % loop.length], fullBoundary))) });
  }
  return { version, source: 'own_stimulus_geometry', coordinateFrame: 'figure_local_pixels',
    origin: [x, y], size: [w, h], adjacency, parts };
}

function equalValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((v, i) => equalValue(actual[i], v));
  if (expected && typeof expected === 'object') return exact(actual, Object.keys(expected)) &&
    Object.entries(expected).every(([k, v]) => equalValue(actual[k], v));
  return false;
}

/** Rebuild from the seven original polygons so missing combinations and altered geometry fail closed. */
export function validatePartGeometry(value: unknown): PartGeometry {
  if (!exact(value, ['version', 'source', 'coordinateFrame', 'origin', 'size', 'adjacency', 'parts']) ||
      !isPartObservationVersion(value.version) || value.source !== 'own_stimulus_geometry' ||
      value.coordinateFrame !== 'figure_local_pixels' || !point(value.origin) || !point(value.size) ||
      !value.size.every(v => v > 0) || !Array.isArray(value.adjacency) || value.adjacency.length > 21 ||
      !Array.isArray(value.parts) || value.parts.length < 8 || value.parts.length > 127) return invalid();
  for (const p of value.parts) {
    if (!exact(p, ['members', 'shape', 'sides', 'convex', 'outlines', 'bbox', 'edgeVisibility']) ||
        !Array.isArray(p.members) || p.members.length < 1 || p.members.length > 7 ||
        !p.members.every(v => Number.isSafeInteger(v) && v >= 1 && v <= 7) ||
        !SHAPES.includes(p.shape as PartShape) || !(p.sides === null || Number.isSafeInteger(p.sides) && Number(p.sides) >= 3 && Number(p.sides) <= 28) ||
        !(p.convex === null || typeof p.convex === 'boolean') ||
        !Array.isArray(p.outlines) || !p.outlines.length || p.outlines.length > 7 ||
        !p.outlines.every(loop => Array.isArray(loop) && loop.length >= 3 && loop.length <= 28 && loop.every(point)) ||
        !Array.isArray(p.bbox) || p.bbox.length !== 4 || !p.bbox.every(coordinate) ||
        !Array.isArray(p.edgeVisibility) || p.edgeVisibility.length !== p.outlines.length ||
        !p.edgeVisibility.every((loop, i) => Array.isArray(loop) && loop.length === (p.outlines as PartPoint[][])[i].length &&
          loop.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))) return invalid();
  }
  const singles = value.parts.filter(p => p.members.length === 1);
  if (singles.length !== 7) return invalid();
  const origin = value.origin, polygons: PartPoint[][] = [];
  for (let member = 1; member <= 7; member++) {
    const single = singles.find(p => p.members[0] === member);
    if (!single || single.outlines.length !== 1) return invalid();
    polygons.push(single.outlines[0].map(([x, y]: PartPoint) => [round(x + origin[0]), round(y + origin[1])]));
  }
  const expected = createPartGeometry(polygons, value.version);
  if (!equalValue(value, expected)) return invalid();
  return expected;
}
