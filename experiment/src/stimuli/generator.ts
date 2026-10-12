/**
 * OFFLINE generator for the DEMO silhouettes. It is slow (seeded search with
 * pairwise IoU checks), so the app never imports it. Regenerate the static
 * data with:  node src/stimuli/generator.ts > src/stimuli/stimulus-data.ts
 */
declare const process: { argv: string[] } | undefined;
type TanKind = 'L' | 'M' | 'S' | 'Q' | 'P';
type Point = readonly [number, number];
type PlacedTan = { kind: TanKind; polygon: Point[] };
const rt2 = Math.sqrt(2);
const local: Record<TanKind, Point[]> = {
  L: [[0, 0], [2 * rt2, 0], [0, 2 * rt2]],
  M: [[0, 0], [2, 0], [0, 2]],
  S: [[0, 0], [rt2, 0], [0, rt2]],
  Q: [[0, 0], [rt2, 0], [rt2, rt2], [0, rt2]],
  P: [[0, 0], [2, 0], [3, 1], [1, 1]],
};

/** Standard tan geometry, rotated in 45° steps, optionally reflected, then translated. */
export function tan(kind: TanKind, x: number, y: number, rotDeg: number, flip = false): Point[] {
  const angle = Math.round(rotDeg / 45) * 45 * Math.PI / 180;
  const c = Math.cos(angle); const s = Math.sin(angle);
  return local[kind].map(([px, py]) => {
    const fx = flip ? -px : px;
    return [Number((x + fx * c - py * s).toFixed(6)), Number((y + fx * s + py * c).toFixed(6))] as const;
  });
}

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function strictlyInside(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]; const b = poly[j];
    if (((a[1] > p[1]) !== (b[1] > p[1])) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function overlaps(a: Point[], b: Point[]): boolean {
  // Proper boundary crossings imply positive-area intersection; containment catches nested pieces.
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length], b1 = b[j], b2 = b[(j + 1) % b.length];
    if (cross(a1, a2, b1) * cross(a1, a2, b2) < -1e-8 && cross(b1, b2, a1) * cross(b1, b2, a2) < -1e-8) return true;
  }
  const centroid = (poly: Point[]) => [poly.reduce((sum, p) => sum + p[0], 0) / poly.length, poly.reduce((sum, p) => sum + p[1], 0) / poly.length] as const;
  return a.some((point) => strictlyInside(point, b)) || b.some((point) => strictlyInside(point, a)) || strictlyInside(centroid(a), b) || strictlyInside(centroid(b), a);
}
function adjacent(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length], b1 = b[j], b2 = b[(j + 1) % b.length];
    if (Math.abs(cross(a1, a2, b1)) > 1e-6 || Math.abs(cross(a1, a2, b2)) > 1e-6) continue;
    const len = distance(a1, a2); if (!len) continue;
    const t1 = ((b1[0] - a1[0]) * (a2[0] - a1[0]) + (b1[1] - a1[1]) * (a2[1] - a1[1])) / (len * len);
    const t2 = ((b2[0] - a1[0]) * (a2[0] - a1[0]) + (b2[1] - a1[1]) * (a2[1] - a1[1])) / (len * len);
    if ((Math.min(1, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2))) * len >= 0.5 - 1e-6) return true;
  }
  return false;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function buildFigure(seed: number): PlacedTan[] {
  const random = rng(seed);
  const rootKind = (['L', 'M', 'S', 'Q', 'P'] as TanKind[])[Math.abs(seed) % 5];
  const rootRotation = (Math.floor(Math.abs(seed) / 5) % 8) * 45;
  const initial: PlacedTan[] = [{ kind: rootKind, polygon: tan(rootKind, 0, 0, rootRotation, Math.floor(Math.abs(seed) / 40) % 2 === 1) }];
  const shuffle = <T,>(items: T[]): T[] => items.map((item) => [random(), item] as const).sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const search = (placed: PlacedTan[], remaining: TanKind[]): PlacedTan[] | null => {
    if (!remaining.length) return placed;
    for (const kind of shuffle(remaining)) {
      const candidates: Point[][] = [];
      for (const rotation of [0, 45, 90, 135, 180, 225, 270, 315]) for (const flip of [false, true]) {
        const raw = tan(kind, 0, 0, rotation, flip);
        for (const target of placed) for (let i = 0; i < raw.length; i++) for (let j = 0; j < target.polygon.length; j++) {
          const r1 = raw[i], r2 = raw[(i + 1) % raw.length], t1 = target.polygon[j], t2 = target.polygon[(j + 1) % target.polygon.length];
          if (Math.abs(distance(r1, r2) - distance(t1, t2)) > 1e-5) continue;
          const shifted = raw.map(([x, y]) => [x + t2[0] - r1[0], y + t2[1] - r1[1]] as const);
          if (!adjacent(shifted, target.polygon) || placed.some((piece) => overlaps(shifted, piece.polygon))) continue;
          candidates.push(shifted);
        }
      }
      for (const polygon of shuffle(candidates)) {
        const result = search([...placed, { kind, polygon }], remaining.filter((candidate, index) => candidate !== kind || remaining.indexOf(kind) !== index));
        if (result) return result;
      }
    }
    return null;
  };
  const left = ['L', 'L', 'M', 'S', 'S', 'Q', 'P'] as TanKind[];
  left.splice(left.indexOf(rootKind), 1);
  const result = search(initial, left);
  if (!result) throw new Error('Could not assemble connected tangram');
  return result;
}
function normalize(pieces: PlacedTan[]): PlacedTan[] {
  const xs = pieces.flatMap((piece) => piece.polygon.map(([x]) => x)); const ys = pieces.flatMap((piece) => piece.polygon.map(([, y]) => y));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = 88 / Math.max(maxX - minX, maxY - minY);
  const xPad = (88 - (maxX - minX) * scale) / 2, yPad = (88 - (maxY - minY) * scale) / 2;
  return pieces.map(({ kind, polygon }) => ({ kind, polygon: polygon.map(([x, y]) => [Number((6 + xPad + (x - minX) * scale).toFixed(2)), Number((6 + yPad + (y - minY) * scale).toFixed(2))]) }));
}
function mask48(pieces: PlacedTan[]): boolean[] {
  const points = pieces.flatMap((piece) => piece.polygon);
  const minX = Math.min(...points.map(([x]) => x)), maxX = Math.max(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y)), maxY = Math.max(...points.map(([, y]) => y));
  const scale = 44 / Math.max(maxX - minX, maxY - minY);
  const ox = (48 - (maxX - minX) * scale) / 2, oy = (48 - (maxY - minY) * scale) / 2;
  const inside = (p: Point, poly: Point[]) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };
  return Array.from({ length: 48 * 48 }, (_, index) => {
    const x = index % 48, y = Math.floor(index / 48);
    const point: Point = [minX + (x + 0.5 - ox) / scale, minY + (y + 0.5 - oy) / scale];
    return pieces.some((piece) => inside(point, piece.polygon));
  });
}
function rotatedMask(mask: boolean[], rotation: number, mirror: boolean): boolean[] {
  const result = Array<boolean>(48 * 48).fill(false);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (mask[y * 48 + x]) {
    let xx = mirror ? 47 - x : x, yy = y;
    if (rotation === 90) [xx, yy] = [47 - yy, xx];
    else if (rotation === 180) [xx, yy] = [47 - xx, 47 - yy];
    else if (rotation === 270) [xx, yy] = [yy, 47 - xx];
    result[yy * 48 + xx] = true;
  }
  return result;
}
function silhouetteIou(a: boolean[], b: boolean[]): number {
  let best = 0;
  for (const mirror of [false, true]) for (const rotation of [0, 90, 180, 270]) {
    const transformed = rotatedMask(b, rotation, mirror); let intersection = 0, union = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] && transformed[i]) intersection++; if (a[i] || transformed[i]) union++; }
    best = Math.max(best, intersection / union);
  }
  return best;
}
function aspectRatio(pieces: PlacedTan[]): number {
  const points = pieces.flatMap((piece) => piece.polygon);
  return (Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x))) / (Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y)));
}
const rawLayouts: PlacedTan[][] = [];
const masks: boolean[][] = [];
const aspectBands = [[1.4, Infinity], [0, 0.7], [0.7, 1.4], [1.4, Infinity], [0, 0.7], [0.7, 1.4], [1.4, Infinity], [0, 0.7], [0.7, 1.4], [1.4, Infinity], [0, 0.7], [0.7, 1.4]];
for (let seed = 0; rawLayouts.length < 12 && seed < 300; seed++) {
  const [minAspect, maxAspect] = aspectBands[rawLayouts.length];
  let candidate: PlacedTan[];
  try { candidate = buildFigure(20261013 + seed * 7919); } catch { continue; }
  const ratio = aspectRatio(candidate);
  if (!(ratio > minAspect && ratio < maxAspect)) continue;
  const mask = mask48(normalize(candidate));
  if (masks.some((prior) => silhouetteIou(prior, mask) >= 0.55)) continue;
  rawLayouts.push(candidate); masks.push(mask);
}
if (rawLayouts.length !== 12) throw new Error(`Could not generate twelve distinct connected tangrams (${rawLayouts.length})`);
export const TAN_LAYOUTS = rawLayouts;
const layouts = rawLayouts.map(normalize);

const fmt = (layout: PlacedTan[]) => JSON.stringify(layout.map((t) => ({ kind: t.kind, polygon: t.polygon.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]) })));
export const NORMALIZED_LAYOUTS = layouts;

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('generator.ts')) {
  const lines = [
    '// GENERATED by src/stimuli/generator.ts — do not edit by hand.',
    '// DEMO self-made tangram-like silhouettes (7 standard tans each). Not the original paper stimuli.',
    "export type TanKind = 'L' | 'M' | 'S' | 'Q' | 'P';",
    'export interface BakedTan { kind: TanKind; polygon: [number, number][] }',
    '/** Pre-scale tan coordinates (tan units), used by geometry tests. */',
    `export const TAN_LAYOUTS: BakedTan[][] = [\n${rawLayouts.map((l) => '  ' + fmt(l)).join(',\n')},\n];`,
    '/** Normalised to the 0..100 viewBox. */',
    `export const NORMALIZED_LAYOUTS: BakedTan[][] = [\n${layouts.map((l) => '  ' + fmt(l)).join(',\n')},\n];`,
  ];
  console.log(lines.join('\n'));
}
