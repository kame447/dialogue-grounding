import { PIECES } from './pieces.mjs';

export const EPSILON = 1e-8;
const cross = ([ax, ay], [bx, by]) => ax * by - ay * bx;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const near = (a, b) => Math.abs(a - b) < EPSILON;
const signedArea = p => p.reduce((s, a, i) => s + cross(a, p[(i + 1) % p.length]), 0) / 2;
export const polygonArea = p => Math.abs(signedArea(p));
const ccw = p => signedArea(p) < 0 ? [...p].reverse() : p;

// Convex Sutherland–Hodgman clipping: geometric area, never a raster estimate.
// Source coordinates are integers; floating intersections use a 1e-8 tolerance.
export function intersectionArea(first, second) {
  let output = ccw(first);
  const clip = ccw(second);
  for (let i = 0; i < clip.length && output.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], edge = sub(b, a);
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const dp = cross(edge, sub(p, a)), dq = cross(edge, sub(q, a));
      const pin = dp >= -EPSILON, qin = dq >= -EPSILON;
      if (pin) output.push(p);
      if (pin !== qin) {
        const t = dp / (dp - dq);
        output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return output.length < 3 ? 0 : polygonArea(output);
}

function sharedLength(a, b, c, d) {
  const v = sub(b, a), length = Math.hypot(...v);
  if (!length || !near(cross(v, sub(c, a)), 0) || !near(cross(v, sub(d, a)), 0)) return 0;
  const project = p => (sub(p, a)[0] * v[0] + sub(p, a)[1] * v[1]) / length;
  const lo = Math.max(0, Math.min(project(c), project(d)));
  const hi = Math.min(length, Math.max(project(c), project(d)));
  return Math.max(0, hi - lo);
}
export function sharesEdge(p, q) {
  return p.some((a, i) => q.some((c, j) =>
    sharedLength(a, p[(i + 1) % p.length], c, q[(j + 1) % q.length]) > EPSILON));
}

export function transformPolygon(points, { rotation = 0, reflect = false, x = 0, y = 0 } = {}) {
  const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return points.map(([px, py]) => {
    if (reflect) px = -px;
    return [px * c - py * s + x, px * s + py * c + y].map(n => near(n, Math.round(n)) ? Math.round(n) : n);
  });
}

function congruenceSignature(points) {
  const variants = [];
  for (const direction of [points, [...points].reverse()]) {
    for (let start = 0; start < points.length; start++) {
      const p = direction.map((_, i) => direction[(i + start) % points.length]);
      variants.push(JSON.stringify(p.flatMap((a, i) => p.slice(i + 1).map(b =>
        Math.round(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) * 1e8)))));
    }
  }
  return variants.sort()[0];
}

// Split at all vertices, cancel interior edges, then merge collinear boundary
// segments. This compares silhouettes independently of their piece partition.
export function boundarySegments(pieces) {
  const polygons = pieces.map(p => ccw(p.points ?? p));
  const vertices = polygons.flat(), segments = new Map();
  const pointKey = p => p.map(n => Math.round(n * 1e8)).join(',');
  for (const polygon of polygons) for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], v = sub(b, a);
    const length2 = v[0] ** 2 + v[1] ** 2;
    const t = p => (sub(p, a)[0] * v[0] + sub(p, a)[1] * v[1]) / length2;
    const cuts = [a, b, ...vertices.filter(p => near(cross(v, sub(p, a)), 0) && t(p) > EPSILON && t(p) < 1 - EPSILON)]
      .sort((p, q) => t(p) - t(q));
    for (let j = 0; j < cuts.length - 1; j++) {
      const p = cuts[j], q = cuts[j + 1];
      if (pointKey(p) === pointKey(q)) continue;
      const key = `${pointKey(p)}:${pointKey(q)}`, reverse = `${pointKey(q)}:${pointKey(p)}`;
      if (segments.has(reverse)) segments.delete(reverse);
      else segments.set(key, [p, q]);
    }
  }
  const result = [...segments.values()];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < result.length; i++) for (let j = 0; j < result.length; j++) {
      if (i === j) continue;
      const [a, b] = result[i], [c, d] = result[j];
      if (pointKey(b) === pointKey(c) && near(cross(sub(b, a), sub(d, c)), 0)) {
        result[i] = [a, d]; result.splice(j, 1); changed = true; break outer;
      }
    }
  }
  return result;
}

export function silhouetteSignature(pieces) {
  const boundary = boundarySegments(pieces), variants = [];
  // Every edge in these stimuli lies on the 45-degree lattice. Any rotation
  // mapping one such silhouette onto another is therefore a multiple of 45°.
  for (const reflect of [false, true]) for (let rotation = 0; rotation < 360; rotation += 45) {
    const edges = boundary.map(edge => transformPolygon(edge, { rotation, reflect }));
    const all = edges.flat(), minX = Math.min(...all.map(p => p[0])), minY = Math.min(...all.map(p => p[1]));
    const key = p => [p[0] - minX, p[1] - minY].map(n => Math.round(n * 1e7)).join(',');
    variants.push(edges.map(([a, b]) => [key(a), key(b)].sort().join(':')).sort().join(';'));
  }
  return variants.sort()[0];
}

export function validateFigure(figure) {
  const errors = [], pieces = figure.pieces;
  if (pieces.length !== 7) errors.push('Expected seven pieces');
  const unused = [...PIECES];
  for (const p of pieces) {
    const index = unused.findIndex(q => q.type === p.type && congruenceSignature(q.points) === congruenceSignature(p.points));
    if (index < 0) errors.push('Piece is not an unused congruent standard piece');
    else unused.splice(index, 1);
  }
  if (unused.length) errors.push('Missing standard pieces');
  const area = pieces.reduce((sum, p) => sum + polygonArea(p.points), 0);
  if (!near(area, 8)) errors.push('Expected total area eight');
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    if (intersectionArea(pieces[i].points, pieces[j].points) > EPSILON) errors.push(`Overlap ${i}/${j}`);
  }
  const reached = new Set(pieces.length ? [0] : []);
  for (let pass = 0; pass < pieces.length; pass++) for (const i of reached) for (let j = 0; j < pieces.length; j++) {
    if (sharesEdge(pieces[i].points, pieces[j].points)) reached.add(j);
  }
  if (reached.size !== pieces.length) errors.push('Pieces are not edge-connected');
  return { valid: errors.length === 0, errors, area };
}

export function validateFigures(figures) {
  const errors = figures.flatMap(f => validateFigure(f).errors.map(e => `${f.id}: ${e}`));
  const signatures = figures.map(f => silhouetteSignature(f.pieces));
  if (new Set(signatures).size !== figures.length) errors.push('Equivalent silhouettes under rotation/reflection');
  return { valid: errors.length === 0, errors };
}
