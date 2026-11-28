import test from 'node:test';
import assert from 'node:assert/strict';
import { createPartGeometry, PART_GEOMETRY_VERSION, validatePartGeometry } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import type { PartGeometry, PartPoint } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import { FIGURE_BANK } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { transformPolygon } from '../dialogue-model/runtime/stimuli/geometry.mjs';

const points = (index = 0) => FIGURE_BANK[index].pieces.map(p => p.points.map(([x, y]): PartPoint => [x, y]));
const rect = (x: number, y: number, w: number, h: number): PartPoint[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const part = (g: PartGeometry, members: number[]) => g.parts.find(p => JSON.stringify(p.members) === JSON.stringify(members))!;

test('actual composed pentagons retain concavity and distinguish visible edges from inferred cuts', () => {
  const geometry = createPartGeometry(points());
  assert.equal(geometry.version, PART_GEOMETRY_VERSION);
  assert.deepEqual(geometry.origin, [-1, -1]);
  assert.deepEqual(geometry.size, [3, 5]);
  const convex = part(geometry, [1, 2, 3]);
  assert.equal(convex.shape, 'pentagon');
  assert.equal(convex.sides, 5);
  assert.equal(convex.convex, true);
  assert.deepEqual(convex.outlines, [[[0, 2], [1, 1], [3, 1], [3, 3], [1, 3]]]);
  assert.deepEqual(convex.edgeVisibility, [[1, 0.5, 1, 0.5, 1]]);
  const concave = part(geometry, [1, 2, 4]);
  assert.equal(concave.shape, 'pentagon');
  assert.equal(concave.convex, false);
  assert.ok(concave.edgeVisibility.flat().includes(0));
  assert.equal(geometry.parts.filter(p => p.members.length === 1 && p.shape === 'pentagon').length, 0);
  assert.deepEqual(geometry.parts.filter(p => p.members.length === 1).map(p => p.shape),
    ['triangle', 'triangle', 'triangle', 'triangle', 'triangle', 'square', 'parallelogram']);
});

test('all connected subsets are retained, while point contacts and separated members are excluded', () => {
  const geometry = createPartGeometry(points());
  const subsets = geometry.parts.map(p => p.members.join(','));
  assert.equal(new Set(subsets).size, subsets.length);
  assert.equal(geometry.parts.length, 34);
  for (let mask = 1; mask < 128; mask++) {
    const members = Array.from({ length: 7 }, (_, i) => i + 1).filter(i => mask & 2 ** (i - 1));
    const pending = [members[0]], visited = new Set<number>();
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const [a, b] of geometry.adjacency) {
        const neighbor = a === current ? b : b === current ? a : null;
        if (neighbor !== null && members.includes(neighbor) && !visited.has(neighbor)) pending.push(neighbor);
      }
    }
    assert.equal(subsets.includes(members.join(',')), visited.size === members.length, members.join(','));
  }
  // In F1, pieces 3 and 4 touch only at the origin; 4 and 5 share a complete edge.
  assert.ok(!subsets.includes('3,4'));
  assert.ok(subsets.includes('4,5'));
  assert.ok(subsets.includes('1,2,3,4,5,6,7'));
});

test('holes and point-branching boundaries are not classified as ordinary polygons', () => {
  const ring = [rect(0, 0, 2, 1), rect(2, 0, 2, 1), rect(3, 1, 1, 2),
    rect(2, 3, 2, 1), rect(0, 3, 2, 1), rect(0, 2, 1, 1), rect(0, 1, 1, 1)];
  const whole = createPartGeometry(ring).parts.at(-1)!;
  assert.equal(whole.shape, 'compound');
  assert.equal(whole.sides, null);
  assert.equal(whole.convex, null);
  assert.deepEqual(whole.outlines, [[[0, 0], [4, 0], [4, 4], [0, 4]], [[1, 1], [1, 3], [3, 3], [3, 1]]]);
  assert.ok(whole.edgeVisibility.flat().every(v => v === 1));
  const touchingHoles = [rect(0, 0, 2, 1), rect(2, 0, 2, 1), rect(0, 1, 1, 1),
    rect(2, 1, 2, 1), rect(0, 2, 2, 1), rect(3, 2, 1, 1), rect(0, 3, 4, 1)];
  const branching = createPartGeometry(touchingHoles).parts.at(-1)!;
  assert.equal(branching.shape, 'compound');
  assert.equal(branching.sides, null);
  assert.ok(branching.outlines.length > 1);
});

test('drawing rotations preserve every member set and shape while positions follow the display', () => {
  const polygons = points(), original = createPartGeometry(polygons);
  for (const rotation of [90, 180, 270]) for (const reflect of [false, true]) {
    const changed = createPartGeometry(polygons.map(p => transformPolygon(p, { rotation, reflect, x: 300, y: 200 })));
    assert.deepEqual(changed.parts.map(p => [p.members, p.shape, p.sides, p.convex]),
      original.parts.map(p => [p.members, p.shape, p.sides, p.convex]));
    assert.deepEqual(changed.adjacency, original.adjacency);
    for (let i = 0; i < original.parts.length; i++) {
      const expected = original.parts[i].outlines.flat().map(([x, y]) =>
        transformPolygon([[x + original.origin[0], y + original.origin[1]]], { rotation, reflect, x: 300, y: 200 })[0]);
      const actual = changed.parts[i].outlines.flat().map(([x, y]) => [x + changed.origin[0], y + changed.origin[1]]);
      assert.deepEqual(actual.map(p => JSON.stringify(p)).sort(), expected.map(p => JSON.stringify(p)).sort());
    }
  }
});

test('records roundtrip independently and reject omissions, extra fields and altered geometry', () => {
  const geometry = createPartGeometry(points());
  const restored = validatePartGeometry(JSON.parse(JSON.stringify(geometry)));
  assert.deepEqual(restored, geometry);
  assert.notEqual(restored, geometry);
  restored.parts[0].outlines[0][0][0] = 999;
  assert.notEqual(restored.parts[0].outlines[0][0][0], geometry.parts[0].outlines[0][0][0]);
  for (const mutate of [
    (g: any) => { g.answerKey = 'hidden'; },
    (g: any) => { g.parts[0].figureId = 'F1'; },
    (g: any) => { g.parts.splice(2, 1); },
    (g: any) => { g.parts[0].shape = 'pentagon'; },
    (g: any) => { g.parts[0].edgeVisibility[0][0] = 1; },
    (g: any) => { g.adjacency.pop(); },
    (g: any) => { g.size[0]++; },
    (g: any) => { g.parts[0].outlines[0][0][0] += 0.5; },
  ]) {
    const damaged = structuredClone(geometry);
    mutate(damaged);
    assert.throws(() => validatePartGeometry(damaged), /invalid_part_geometry/u);
  }
});

test('invalid original polygons fail before emitting incomplete or overlapping candidates', () => {
  assert.throws(() => createPartGeometry(points().slice(1)), /invalid_part_geometry/u);
  const overlap = points(); overlap[1] = structuredClone(overlap[0]);
  assert.throws(() => createPartGeometry(overlap), /invalid_part_geometry/u);
  const apart = points(); apart[6] = apart[6].map(([x, y]) => [x + 20, y]);
  assert.throws(() => createPartGeometry(apart), /invalid_part_geometry/u);
  const repeated = points(); repeated[0][1] = [...repeated[0][0]];
  assert.throws(() => createPartGeometry(repeated), /invalid_part_geometry/u);
  const nan = points(); nan[0][0][0] = NaN;
  assert.throws(() => createPartGeometry(nan), /invalid_part_geometry/u);
});

test('all bank figures have complete validated catalogs within the six-figure observation budget', () => {
  const sizes: number[] = [];
  for (const figure of FIGURE_BANK) {
    const g = createPartGeometry(figure.pieces.map(p => p.points.map(([x, y]): PartPoint => [400 + 48 * x, 400 + 48 * y])));
    assert.equal(g.parts.filter(p => p.members.length === 1).length, 7);
    assert.equal(g.parts.filter(p => p.members.length === 7).length, 1);
    assert.ok(g.parts.some(p => p.shape === 'pentagon'), figure.id);
    assert.deepEqual(validatePartGeometry(g), g, figure.id);
    const json = JSON.stringify(g);
    assert.ok(!/figureId|human|answerKey/u.test(json));
    sizes.push(json.length);
  }
  assert.ok(sizes.sort((a, b) => b - a).slice(0, 6).reduce((s, n) => s + n, 0) < 64000);
});
