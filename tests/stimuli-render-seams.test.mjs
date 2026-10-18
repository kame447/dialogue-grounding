import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createLayouts, createTrial } from '../dialogue-model/runtime/stimuli/board.mjs';
import { renderPolygons } from '../dialogue-model/runtime/stimuli/render.mjs';

function pixelsOf(png) {
  let width, height;
  const data = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
    }
    if (type === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0);
    raw.copy(pixels, y * width, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return { width, height, pixels };
}

// Independent silhouette fixtures: only the exterior outline, with no piece
// edges. The oracle does not call the production geometry or rasterizer.
const outlines = {
  F1: [[1,0],[2,0],[2,3],[1,4],[0,4],[1,3],[1,2],[0,2],[-1,1],[0,0],[-1,0],[0,-1]],
  F2: [[2,0],[0,2],[-1,2],[-1,1],[0,1],[0,-1],[1,-1],[2,-2],[3,-1],[4,-2],[4,-1],[3,0]],
  F3: [[0,2],[0,0],[-1,0],[-1,-1],[1,-1],[2,-2],[3,-1],[1,1],[2,2],[2,3],[1,2]],
  F4: [[2,0],[0,2],[-1,2],[0,1],[0,0],[-1,-1],[0,-2],[1,-2],[1,-1],[2,-2],[3,-1],[3,0],[2,-1]],
  F5: [[1,0],[2,0],[2,1],[3,1],[2,2],[2,3],[1,2],[0,2],[-1,1],[-1,0],[0,-1],[1,-1]],
  F6: [[2,0],[0,2],[1,2],[1,3],[0,4],[-1,4],[0,3],[-1,2],[-2,2],[-2,1],[-1,1],[-2,0]],
};

// Board geometry is rational (scale 312/5). In units of 1/20 pixel both
// vertices and the 2x2 sample centers are integers, so these cross products
// classify samples exactly, without scanline intersection rounding.
function placedOutline({ figureId, rotation }) {
  const points = outlines[figureId].map(([x, y]) => {
    for (let r = 0; r < rotation; r += 90) [x, y] = [-y, x];
    return [x, y];
  });
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const midX2 = Math.min(...xs) + Math.max(...xs);
  const midY2 = Math.min(...ys) + Math.max(...ys);
  return points.map(([x, y]) => [4000 + (2 * x - midX2) * 624, 4000 + (2 * y - midY2) * 624]);
}

function containsExactly(points, x, y) {
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)
      && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return null;
    if ((ay > y) !== (by > y) && (by > ay ? cross > 0 : cross < 0)) inside = !inside;
  }
  return inside;
}

for (const seed of [4, 17, 2026]) test(`seed ${seed}: board pixels match exact exterior outlines, including internal seams and exterior gaps`, () => {
  const trial = createTrial({ seed }), layouts = createLayouts({ seed });
  for (const side of ['human', 'ai']) {
    const { width, pixels } = pixelsOf(trial[side].png);
    for (const [slot, entry] of layouts[side].entries()) {
      const outline = placedOutline(entry);
      let checked = 0, interior = 0, exterior = 0;
      const mismatches = [];
      for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
        let white = 0, onExterior = false;
        for (const dy of [5, 15]) for (const dx of [5, 15]) {
          const contains = containsExactly(outline, x * 20 + dx, y * 20 + dy);
          if (contains === null) onExterior = true;
          else if (!contains) white++;
        }
        // Exterior boundary samples have a legitimate half-open ownership
        // choice. Interior piece edges are absent from this exception.
        if (onExterior) continue;
        const px = slot % 3 * 400 + x, py = Math.floor(slot / 3) * 400 + y;
        const expected = Math.round(white * 255 / 4), actual = pixels[py * width + px];
        if (actual !== expected && mismatches.length < 8) mismatches.push({ x: px, y: py, expected, actual });
        checked++;
        if (white === 0) interior++;
        if (white === 4) exterior++;
      }
      assert.ok(checked > 150000 && interior > 25000 && exterior > 100000);
      assert.deepEqual(mismatches, [], `${side} slot ${slot} ${entry.figureId} rotation ${entry.rotation}`);
    }
  }
});

test('shared edges are watertight at every supersampling level, winding and arbitrary rotation', () => {
  const square = [[0,0],[61,0],[61,61],[0,61]];
  const split = [[[0,0],[61,0],[0,61]], [[61,61],[0,61],[61,0]]];
  for (const supersample of [1, 2, 3, 4]) for (const rotation of [0, 37, 90, 135, 180, 270]) {
    const angle = rotation * Math.PI / 180;
    const place = points => points.map(([x, y]) => [
      73.2 + (x - 30.5) * Math.cos(angle) - (y - 30.5) * Math.sin(angle),
      75.7 + (x - 30.5) * Math.sin(angle) + (y - 30.5) * Math.cos(angle),
    ]);
    const options = { width: 150, height: 150, supersample };
    const expected = renderPolygons([place(square)], options);
    for (const pieces of [split, [...split].reverse().map(p => [...p].reverse())]) {
      assert.deepEqual(renderPolygons(pieces.map(place), options), expected, `s=${supersample}, rotation=${rotation}`);
    }
  }
});

test('a real subpixel gap keeps its sample coverage; clipping and holes are preserved', () => {
  const options = { width: 32, height: 32, supersample: 4 };
  // The slit is only 0.3 px wide, but crosses two of the four sample columns.
  const rectangles = [
    [[-4,2],[15.6,2],[15.6,30],[-4,30]],
    [[15.9,2],[36,2],[36,30],[15.9,30]],
  ];
  const { pixels } = pixelsOf(renderPolygons(rectangles, options));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    assert.equal(pixels[y * 32 + x], y < 2 || y >= 30 ? 255 : x === 15 ? 128 : 0);
  }
  // A bounded hole must also stay white instead of being filled as a seam.
  const bars = [
    [[2,2],[30,2],[30,8],[2,8]], [[2,24],[30,24],[30,30],[2,30]],
    [[2,8],[8,8],[8,24],[2,24]], [[24,8],[30,8],[30,24],[24,24]],
  ];
  const hole = pixelsOf(renderPolygons(bars, options)).pixels;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const black = x >= 2 && x < 30 && y >= 2 && y < 30 && !(x >= 8 && x < 24 && y >= 8 && y < 24);
    assert.equal(hole[y * 32 + x], black ? 0 : 255);
  }
});
