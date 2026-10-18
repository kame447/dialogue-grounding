// RESEARCHER ONLY. Offline geometry of the synthetic prototype figures; no I/O,
// no model calls and nothing here is ever sent to a model or participant.
// Similarities are descriptive diagnostics, not calibrated human or model
// confusability, and they do not select or replace any adopted stimulus.
import { FIGURES } from "../../stimuli/figures.mjs";
import { boundarySegments } from "../../stimuli/geometry.mjs";
import { createLayoutsV2 } from "../../stimuli/scatter-v2.mjs";

export type Point = readonly [number, number];
export type Figure = { id: string; pieces: ReadonlyArray<{ points: ReadonlyArray<Point> }> };

export const SHAPE_SIMILARITY_LIMITATION = "Pixel/contour similarity of exact silhouettes. It is not evidence of what Luna or a human perceives, and holistic impressions (e.g. 'house') may follow other cues. Raster IoU uses centroid alignment only.";

const figures = FIGURES as unknown as ReadonlyArray<Figure>;
export const FIGURE_IDS: readonly string[] = figures.map((f) => f.id);

function figureById(id: string): Figure {
  const figure = figures.find((f) => f.id === id);
  if (!figure) throw new TypeError("Unknown figure");
  return figure;
}

function inside(polygon: ReadonlyArray<Point>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function centroid(figure: Figure): Point {
  let area = 0, cx = 0, cy = 0;
  for (const { points } of figure.pieces) {
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
      const c = ax * by - bx * ay;
      area += c; cx += (ax + bx) * c; cy += (ay + by) * c;
    }
  }
  return [cx / (3 * area), cy / (3 * area)];
}

export type Mask = { size: number; cells: Uint8Array };
const EXTENT = 3.6; // half-width in figure units; every silhouette fits after centring.

/** Binary silhouette sampled on a centred grid, rotated clockwise on screen (y down). */
export function rasterize(id: string, degrees: number, size = 96): Mask {
  if (!Number.isInteger(size) || size < 8 || size > 512) throw new TypeError("size must be an integer from 8 to 512");
  const figure = figureById(id), [ox, oy] = centroid(figure);
  const a = -degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const cells = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const u = ((col + 0.5) / size * 2 - 1) * EXTENT, v = ((row + 0.5) / size * 2 - 1) * EXTENT;
    // Inverse rotation of the sample point equals rotating the figure forward.
    const x = u * c - v * s + ox, y = u * s + v * c + oy;
    if (figure.pieces.some((p) => inside(p.points, x, y))) cells[row * size + col] = 1;
  }
  return { size, cells };
}

export function iou(a: Mask, b: Mask): number {
  if (a.size !== b.size) throw new TypeError("mask sizes differ");
  let both = 0, either = 0;
  for (let i = 0; i < a.cells.length; i++) { both += a.cells[i] & b.cells[i]; either += a.cells[i] | b.cells[i]; }
  return either ? both / either : 0;
}

/** Orientation-dependent overlap of two figures exactly as presented. */
export function presentedIou(a: string, aDegrees: number, b: string, bDegrees: number, size = 96): number {
  return iou(rasterize(a, aDegrees, size), rasterize(b, bDegrees, size));
}

/** Best centroid-aligned overlap over rotations (no reflection). */
export function invariantIou(a: string, b: string, { step = 5, size = 96 } = {}): { iou: number; degrees: number } {
  const base = rasterize(a, 0, size);
  let best = { iou: -1, degrees: 0 };
  for (let d = 0; d < 360; d += step) {
    const value = iou(base, rasterize(b, d, size));
    if (value > best.iou + 1e-12) best = { iou: value, degrees: d };
  }
  return best;
}

/** log-scaled Hu invariants (rotation/translation/scale invariant). */
export function huMoments(mask: Mask): number[] {
  const { size, cells } = mask;
  let m00 = 0, m10 = 0, m01 = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (cells[y * size + x]) { m00++; m10 += x; m01 += y; }
  const xc = m10 / m00, yc = m01 / m00;
  const mu = (p: number, q: number) => {
    let sum = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (cells[y * size + x]) sum += (x - xc) ** p * (y - yc) ** q;
    return sum;
  };
  const n = (p: number, q: number) => mu(p, q) / m00 ** (1 + (p + q) / 2);
  const [n20, n02, n11, n30, n03, n21, n12] = [n(2, 0), n(0, 2), n(1, 1), n(3, 0), n(0, 3), n(2, 1), n(1, 2)];
  const h = [
    n20 + n02,
    (n20 - n02) ** 2 + 4 * n11 ** 2,
    (n30 - 3 * n12) ** 2 + (3 * n21 - n03) ** 2,
    (n30 + n12) ** 2 + (n21 + n03) ** 2,
    (n30 - 3 * n12) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2) + (3 * n21 - n03) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2),
    (n20 - n02) * ((n30 + n12) ** 2 - (n21 + n03) ** 2) + 4 * n11 * (n30 + n12) * (n21 + n03),
    (3 * n21 - n03) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2) - (n30 - 3 * n12) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2),
  ];
  // h7 changes sign under reflection only; keep magnitude so mirrored shapes stay close.
  return h.map((v, i) => (i === 6 ? -Math.log10(Math.abs(v) + 1e-30) : -Math.sign(v || 1) * Math.log10(Math.abs(v) + 1e-30)));
}

export function huDistance(a: string, b: string, size = 128): number {
  const ha = huMoments(rasterize(a, 0, size)), hb = huMoments(rasterize(b, 0, size));
  // First four invariants: higher orders are dominated by raster noise.
  return Math.sqrt(ha.slice(0, 4).reduce((s, v, i) => s + (v - hb[i]) ** 2, 0));
}

/** Outer boundary loop (counter-clockwise in figure coordinates) of a silhouette. */
export function outerContour(id: string): Point[] {
  const segments = boundarySegments(figureById(id).pieces.map((p) => p.points as Point[])) as Array<[Point, Point]>;
  const key = (p: Point) => p.map((n) => Math.round(n * 1e6)).join(",");
  const loops: Point[][] = [];
  const edges = [...segments];
  while (edges.length) {
    const [start, first] = edges.pop()!;
    const loop: Point[] = [start];
    let end = first;
    while (key(end) !== key(start)) {
      loop.push(end);
      const next = edges.findIndex(([a]) => key(a) === key(end));
      if (next < 0) throw new Error("Open silhouette boundary");
      end = edges.splice(next, 1)[0][1];
    }
    loops.push(loop);
  }
  const area = (l: Point[]) => l.reduce((s, a, i) => s + a[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * a[1], 0) / 2;
  return loops.sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)))[0];
}

/** Cumulative turning angle sampled at n equal arclength positions. */
export function turningFunction(contour: ReadonlyArray<Point>, n = 360): number[] {
  const m = contour.length;
  const edges = contour.map((p, i) => {
    const q = contour[(i + 1) % m];
    return { length: Math.hypot(q[0] - p[0], q[1] - p[1]), angle: Math.atan2(q[1] - p[1], q[0] - p[0]) };
  }).filter((e) => e.length > 1e-9);
  const total = edges.reduce((s, e) => s + e.length, 0);
  const cumulative: number[] = [];
  let angle = edges[0].angle;
  for (let i = 0; i < edges.length; i++) {
    if (i) {
      let turn = edges[i].angle - edges[i - 1].angle;
      while (turn > Math.PI) turn -= 2 * Math.PI;
      while (turn <= -Math.PI) turn += 2 * Math.PI;
      angle += turn;
    }
    cumulative.push(angle);
  }
  const out: number[] = [];
  let index = 0, start = 0;
  for (let k = 0; k < n; k++) {
    const s = (k + 0.5) / n * total;
    while (start + edges[index].length < s) { start += edges[index].length; index++; }
    out.push(cumulative[index]);
  }
  return out;
}

/** Arkin-style L2 distance minimised over start point and rotation (radians RMS). */
export function turningDistance(a: string, b: string, n = 360): number {
  const fa = turningFunction(outerContour(a), n), fb = turningFunction(outerContour(b), n);
  const wrap = fb[n - 1] - fb[0] > 0 ? 2 * Math.PI : -2 * Math.PI;
  let best = Infinity;
  for (let shift = 0; shift < n; shift++) {
    const diff = fa.map((v, i) => {
      const j = i + shift;
      return v - (j < n ? fb[j] : fb[j - n] + wrap);
    });
    const mean = diff.reduce((s, v) => s + v, 0) / n;
    const value = Math.sqrt(diff.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    if (value < best) best = value;
  }
  return best;
}

export type PairRow = { a: string; b: string; invariantIou: number; bestDegrees: number; huDistance: number; turningDistance: number };

/** All 15 unordered pairs with three rotation-invariant measures. */
export function pairwiseInvariant(ids: readonly string[] = FIGURE_IDS): PairRow[] {
  const rows: PairRow[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const best = invariantIou(ids[i], ids[j]);
    rows.push({ a: ids[i], b: ids[j], invariantIou: best.iou, bestDegrees: best.degrees,
      huDistance: huDistance(ids[i], ids[j]), turningDistance: turningDistance(ids[i], ids[j]) });
  }
  return rows;
}

/** Rank-average confusability (1 = most similar on all three measures). */
export function rankPairs(rows: readonly PairRow[]): Array<PairRow & { meanRank: number }> {
  const rank = (key: keyof PairRow, descending: boolean) => {
    const sorted = [...rows].sort((p, q) => descending ? (q[key] as number) - (p[key] as number) : (p[key] as number) - (q[key] as number));
    return new Map(sorted.map((r, i) => [r, i + 1]));
  };
  const r1 = rank("invariantIou", true), r2 = rank("huDistance", false), r3 = rank("turningDistance", false);
  return rows.map((r) => ({ ...r, meanRank: (r1.get(r)! + r2.get(r)! + r3.get(r)!) / 3 }))
    .sort((p, q) => p.meanRank - q.meanRank);
}

export type SeedFigureRow = {
  figureId: string; humanRotation: number; aiRotation: number; relativeRotation: number;
  presentedSelf: number; presentedBestOther: { figureId: string; iou: number };
  presentedRank: number; invariantRank: number;
};

/** Per-seed v2 board geometry: for each human-view figure, how its presented
 * silhouette overlaps every AI-view silhouette as presented (orientation-
 * dependent appearance) versus after rotation search (shape identity). */
export function seedAnalysis(seed: number, size = 64): { seed: number; figures: SeedFigureRow[]; presentedMisranked: number } {
  const layouts = createLayoutsV2({ seed }) as { human: Array<{ figureId: string; rotation: number }>; ai: Array<{ figureId: string; rotation: number }> };
  const aiRot = new Map(layouts.ai.map((p) => [p.figureId, p.rotation]));
  const huRot = new Map(layouts.human.map((p) => [p.figureId, p.rotation]));
  const invariant = new Map<string, number>();
  for (const a of FIGURE_IDS) for (const b of FIGURE_IDS) {
    invariant.set(a + b, a === b ? 1 : invariantIou(a, b, { step: 15, size }).iou);
  }
  const rows = FIGURE_IDS.map((h) => {
    const humanMask = rasterize(h, huRot.get(h)!, size);
    const scores = FIGURE_IDS.map((a) => ({ figureId: a, iou: iou(humanMask, rasterize(a, aiRot.get(a)!, size)) }));
    const self = scores.find((s) => s.figureId === h)!.iou;
    const others = scores.filter((s) => s.figureId !== h).sort((p, q) => q.iou - p.iou);
    const invScores = FIGURE_IDS.map((a) => invariant.get(h + a)!).sort((p, q) => q - p);
    return {
      figureId: h, humanRotation: huRot.get(h)!, aiRotation: aiRot.get(h)!,
      relativeRotation: ((aiRot.get(h)! - huRot.get(h)!) % 360 + 360) % 360,
      presentedSelf: self, presentedBestOther: others[0],
      presentedRank: 1 + others.filter((o) => o.iou > self).length,
      invariantRank: invScores.indexOf(1) + 1,
    };
  });
  return { seed, figures: rows, presentedMisranked: rows.filter((r) => r.presentedRank > 1).length };
}

/** Appearance margin at a relative rotation: overlap of a figure with itself
 * turned by `degrees`, minus the best overlap with any other figure in any
 * quarter orientation. Positive means the true counterpart still looks most
 * alike without mental rotation (an option sketch, not an adopted condition). */
export function rotationMargin(degrees: number, size = 64): Array<{ figureId: string; self: number; bestOther: number; margin: number }> {
  return FIGURE_IDS.map((h) => {
    const base = rasterize(h, 0, size);
    const self = iou(base, rasterize(h, degrees, size));
    let bestOther = 0;
    for (const g of FIGURE_IDS) if (g !== h) for (const q of [0, 90, 180, 270]) bestOther = Math.max(bestOther, iou(base, rasterize(g, q, size)));
    return { figureId: h, self, bestOther, margin: self - bestOther };
  });
}
