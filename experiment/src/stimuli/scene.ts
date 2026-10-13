/**
 * Scattered figure scene (seat-specific placement contract).
 *
 * As in the original tangram naming task, each seat sees the same six silhouettes scattered over a
 * canvas at irregular positions and orientations — never in a grid, never numbered. Placement is
 * generated on the server from the room seed and the seat, so it is identical across reloads and
 * different between the human and the AI seat.
 *
 * Coordinate contract (shared by the browser renderer and any future VLM / agent renderer):
 * - The scene is SCENE.width × SCENE.height units, origin top-left, y down.
 * - A figure's canonical polygons live in a 0..100 box. Let c be the centre of their bounding box.
 *   A canonical point p maps to the scene as  world = (x, y) + R(rotation) · scale · (p − c),
 *   where R rotates clockwise on screen by `rotation` degrees (y down).
 * - worldPolygons() / sceneSvg() implement exactly this; renderers must not add their own rotation.
 */
import type { FigurePlacement, Point } from '../ai/protocol';
import { createRng } from './layout';

export const SCENE = { width: 400, height: 300 } as const;

/** x, y: centre of the canonical bounding box (scene units); rotation: clockwise degrees; scale: scene units per canonical unit. */
export type Placement = FigurePlacement;

const MARGIN = 6;
/** Minimum clear distance between two silhouettes, in scene units. */
const GAP = 14;
/** Radius around each figure's centre kept free of other silhouettes (stable click/tap target). */
const HIT_RADIUS = 12;

type P = readonly [number, number];
type Poly = readonly P[];

function bboxCentre(polygons: readonly Poly[]): P {
  const pts = polygons.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

const polyArea = (p: Poly) => Math.abs(p.reduce((sum, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return sum + x * y2 - x2 * y; }, 0)) / 2;

/** Canonical polygons → scene polygons for one placement (see the contract above). */
export function transformPolygons(polygons: readonly Poly[], placement: Placement): Point[][] {
  const [cx, cy] = bboxCentre(polygons);
  const rad = (placement.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return polygons.map((poly) => poly.map(([px, py]) => {
    const dx = (px - cx) * placement.scale;
    const dy = (py - cy) * placement.scale;
    return [round(placement.x + dx * cos - dy * sin), round(placement.y + dx * sin + dy * cos)] as Point;
  }));
}

const round = (v: number) => Math.round(v * 100) / 100;

export function worldPolygons(figure: { polygons: readonly Poly[]; placement: Placement }): Point[][] {
  return transformPolygons(figure.polygons, figure.placement);
}

export function bounds(polygons: readonly Poly[]) {
  const pts = polygons.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export const pathData = (polygons: readonly Poly[]) => polygons.map((poly) => `M${poly.map(([x, y]) => `${x},${y}`).join('L')}Z`).join('');

// ---------- geometry for the non-overlap test (tans are convex) ----------

function segDist(a: P, b: P, c: P, d: P): number {
  const cross = (o: P, p: P, q: P) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
}

function pointSeg(p: P, a: P, b: P): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function inside(p: P, poly: Poly): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function polyDist(a: Poly, b: Poly): number {
  if (inside(a[0], b) || inside(b[0], a)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    best = Math.min(best, segDist(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]));
    if (best === 0) return 0;
  }
  return best;
}

/** Smallest clear distance between two figures (0 when they touch or overlap). */
export function figureDistance(a: readonly Poly[], b: readonly Poly[]): number {
  let best = Infinity;
  for (const pa of a) for (const pb of b) best = Math.min(best, polyDist(pa, pb));
  return best;
}

/** Distance from a point to a figure (0 when inside). */
export function pointFigureDistance(p: P, polygons: readonly Poly[]): number {
  let best = Infinity;
  for (const poly of polygons) {
    if (inside(p, poly)) return 0;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, pointSeg(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return best;
}

/**
 * True when the centres look arranged: four or more on one row/column band, or two separate rows
 * (or columns) of three, i.e. a 3×2 / 2×3 grid-like reading order.
 */
export function looksAligned(centres: P[]): boolean {
  const check = (values: number[], band: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    const groups: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      let n = 1;
      while (i + n < sorted.length && sorted[i + n] - sorted[i] <= band) n++;
      groups.push(n);
    }
    if (groups.some((n) => n >= 4)) return true;
    // Two disjoint triples: greedy from the smallest value.
    let triples = 0;
    for (let i = 0; i + 2 < sorted.length;) {
      if (sorted[i + 2] - sorted[i] <= band) { triples++; i += 3; } else i++;
    }
    return triples >= 2;
  };
  return check(centres.map((c) => c[1]), SCENE.height * 0.12) || check(centres.map((c) => c[0]), SCENE.width * 0.1);
}

function seatSeed(seed: number, seat: string): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const ch of seat) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

interface Shape { polys: readonly Poly[]; boxes: ReturnType<typeof bounds>[]; box: ReturnType<typeof bounds> }

function shapeOf(polys: readonly Poly[]): Shape {
  return { polys, boxes: polys.map((p) => bounds([p])), box: bounds(polys) };
}

const translate = (shape: Shape, dx: number, dy: number): Shape => ({
  polys: shape.polys.map((p) => p.map(([x, y]) => [x + dx, y + dy] as Point)),
  boxes: shape.boxes.map((b) => ({ minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy })),
  box: { minX: shape.box.minX + dx, maxX: shape.box.maxX + dx, minY: shape.box.minY + dy, maxY: shape.box.maxY + dy },
});

const boxGap = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) =>
  Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY, 0);

/** True when the two shapes are at least `gap` apart; bounding boxes reject most pairs early. */
function clearOf(a: Shape, b: Shape, gap: number): boolean {
  if (boxGap(a.box, b.box) >= gap) return true;
  for (let i = 0; i < a.polys.length; i++) for (let j = 0; j < b.polys.length; j++) {
    if (boxGap(a.boxes[i], b.boxes[j]) >= gap) continue;
    if (polyDist(a.polys[i], b.polys[j]) < gap) return false;
  }
  return true;
}

function pointClear(p: P, shape: Shape, r: number): boolean {
  const b = shape.box;
  if (p[0] < b.minX - r || p[0] > b.maxX + r || p[1] < b.minY - r || p[1] > b.maxY + r) return true;
  return pointFigureDistance(p, shape.polys) >= r;
}

/** Upper bounds on the work one placement may do (a room creation places two seats). */
export const PLACEMENT_BUDGET = { attempts: 60, positionsPerFigure: 40 } as const;

/**
 * Irregular, non-overlapping placements for one seat. Deterministic in (polygonsList, seed, seat).
 * Silhouettes share the same tan area in the original task, so figures are scaled towards a common
 * area (elongated ones are not shrunk to fit a square box), with a cap on the longest side.
 * Work is bounded by PLACEMENT_BUDGET; the size factor shrinks after failed attempts, so a valid
 * scene is always found well within the budget (checked over many seeds in scene.test.ts).
 */
export function placeFigures(polygonsList: readonly (readonly Poly[])[], seed: number, seat: string): Placement[] {
  const rng = createRng(seatSeed(seed, seat));
  const areas = polygonsList.map((polys) => polys.reduce((sum, p) => sum + polyArea(p), 0));
  const refArea = Math.max(...areas);
  const spans = polygonsList.map((polys) => { const b = bounds(polys); return Math.hypot(b.maxX - b.minX, b.maxY - b.minY); });
  const relative = polygonsList.map((_, i) => Math.pow(refArea / areas[i], 0.42));
  const order = polygonsList.map((_, i) => i).sort((a, b) => spans[b] * relative[b] - spans[a] * relative[a]);
  let k = 0.9;
  for (let attempt = 0; attempt < PLACEMENT_BUDGET.attempts; attempt++) {
    if (attempt > 0 && attempt % 3 === 0) k *= 0.93;
    const placements: Placement[] = new Array(polygonsList.length);
    const placed: Shape[] = [];
    const centres: P[] = [];
    let ok = true;
    for (const i of order) {
      const scale = Math.round(Math.min(k * relative[i], (SCENE.height * 0.62) / spans[i]) * 1000) / 1000;
      const rotation = Math.floor(rng() * 360);
      const local = shapeOf(transformPolygons(polygonsList[i], { x: 0, y: 0, rotation, scale }));
      const xLo = MARGIN - local.box.minX, xHi = SCENE.width - MARGIN - local.box.maxX;
      const yLo = MARGIN - local.box.minY, yHi = SCENE.height - MARGIN - local.box.maxY;
      if (xHi < xLo || yHi < yLo) { ok = false; break; }
      let found = false;
      for (let t = 0; t < PLACEMENT_BUDGET.positionsPerFigure && !found; t++) {
        const x = round(xLo + rng() * (xHi - xLo));
        const y = round(yLo + rng() * (yHi - yLo));
        const world = translate(local, x, y);
        const clear = placed.every((other, j) =>
          clearOf(world, other, GAP) && pointClear([x, y], other, HIT_RADIUS) && pointClear(centres[j], world, HIT_RADIUS));
        if (!clear) continue;
        placements[i] = { x, y, rotation, scale };
        placed.push(world);
        centres.push([x, y]);
        found = true;
      }
      if (!found) { ok = false; break; }
    }
    if (ok && !looksAligned(centres)) return placements;
  }
  throw new Error('Unable to place figures within budget');
}

/** Standalone SVG of one seat's scene: the image a future VLM partner would receive. */
export function sceneSvg(figures: Array<{ polygons: readonly Poly[]; placement: Placement }>): string {
  const paths = figures.map((f) => `<path d="${pathData(worldPolygons(f))}" fill="#23272d"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SCENE.width} ${SCENE.height}" width="${SCENE.width * 2}" height="${SCENE.height * 2}"><rect width="100%" height="100%" fill="#ffffff"/>${paths}</svg>`;
}
