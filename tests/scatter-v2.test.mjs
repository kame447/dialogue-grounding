import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { FIGURES } from '../dialogue-model/runtime/stimuli/figures.mjs';
import { intersectionArea, polygonArea } from '../dialogue-model/runtime/stimuli/geometry.mjs';
import { BOARD_WIDTH, BOARD_HEIGHT, createLayoutsV2, createTrialV2, participantView, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';

// Independent exterior-only fixtures: no production boundary walk or piece
// union is used by the pixel/hit-map oracle.
const outlines = {
  F1: [[1,0],[2,0],[2,3],[1,4],[0,4],[1,3],[1,2],[0,2],[-1,1],[0,0],[-1,0],[0,-1]],
  F2: [[2,0],[0,2],[-1,2],[-1,1],[0,1],[0,-1],[1,-1],[2,-2],[3,-1],[4,-2],[4,-1],[3,0]],
  F3: [[0,2],[0,0],[-1,0],[-1,-1],[1,-1],[2,-2],[3,-1],[1,1],[2,2],[2,3],[1,2]],
  F4: [[2,0],[0,2],[-1,2],[0,1],[0,0],[-1,-1],[0,-2],[1,-2],[1,-1],[2,-2],[3,-1],[3,0],[2,-1]],
  F5: [[1,0],[2,0],[2,1],[3,1],[2,2],[2,3],[1,2],[0,2],[-1,1],[-1,0],[0,-1],[1,-1]],
  F6: [[2,0],[0,2],[1,2],[1,3],[0,4],[-1,4],[0,3],[-1,2],[-2,2],[-2,1],[-1,1],[-2,0]],
};

function placedOutline(entry) {
  const points = outlines[entry.figureId].map(([x, y]) => {
    for (let r = 0; r < entry.rotation; r += 90) [x, y] = [-y, x];
    return [x, y];
  });
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return points.map(([x, y]) => [(x - cx) * 48 + entry.center.x, (y - cy) * 48 + entry.center.y]);
}

// null denotes the true exterior boundary, where raster half-open ownership
// is allowed to choose either side. Internal seams receive no exception.
function contains(poly, x, y) {
  let inside = false;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)
      && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return null;
    if ((ay > y) !== (by > y) && (by > ay ? cross > 0 : cross < 0)) inside = !inside;
  }
  return inside;
}

function parsePath(path) {
  assert.match(path, /^(?:M-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?(?:L-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?){2,}Z)+$/u);
  return [...path.matchAll(/M([^MZ]+)Z/gu)].map(m => m[1].split('L').map(p => p.split(',').map(Number)));
}

function hits(loops, x, y) {
  let inside = false;
  for (const loop of loops) {
    const result = contains(loop, x, y);
    if (result === null) return true;
    if (result) inside = !inside;
  }
  return inside;
}

function readPng(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  const types = [], data = [];
  let width, height;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, png.readUInt32BE(offset + 8 + length));
    types.push(type);
    if (type === 'IHDR') {
      width = body.readUInt32BE(); height = body.readUInt32BE(4);
      assert.deepEqual([...body.subarray(8)], [8,0,0,0,0]);
    }
    if (type === 'IDAT') data.push(body);
    offset += length + 12;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const raw = inflateSync(Buffer.concat(data)), pixels = Buffer.alloc(width * height);
  assert.equal(raw.length, (width + 1) * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0);
    raw.copy(pixels, y * width, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return { width, height, pixels };
}

test('v2 is deterministic, independently seeded and rejects unsafe seeds', () => {
  const trial = createTrialV2({ seed: 17 });
  assert.deepEqual(createTrialV2({ seed: 17 }), trial);
  assert.equal(trial.version, 2);
  assert.match(trial.trialId, /^tangram-prototype-v2-[a-f0-9]{16}$/u);
  const other = createTrialV2({ seed: 18 });
  assert.notEqual(trial.trialId, other.trialId);
  assert.notDeepEqual(trial.human.png, trial.ai.png);
  assert.notDeepEqual(trial.human.png, other.human.png);
  for (const seed of [-1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) assert.equal(createLayoutsV2({ seed }).human.length, 6);
  for (const seed of [undefined, null, '17', NaN, Infinity, 1.5, 2 ** 53, 17n]) {
    assert.throws(() => createTrialV2({ seed }), TypeError);
  }
});

test('1000 seeds: equal scale, no cropping/collisions, irregular x and y, independent opaque bijections', () => {
  const ids = FIGURES.map(f => f.id).sort();
  const permutations = { human: new Set(), ai: new Set() }, relativeOrders = new Set();
  const firstFigures = { human: new Set(), ai: new Set() };
  for (let seed = 0; seed < 1000; seed++) {
    const layouts = createLayoutsV2({ seed });
    assert.deepEqual(createLayoutsV2({ seed }), layouts);
    const allIds = ['human', 'ai'].flatMap(side => layouts[side].map(p => p.id));
    assert.equal(new Set(allIds).size, 12);
    assert.ok(allIds.every(id => /^s-[a-f0-9]{4}$/u.test(id)));
    for (const side of ['human', 'ai']) {
      const layout = layouts[side];
      assert.equal(layout.length, 6);
      assert.deepEqual(layout.map(p => p.figureId).sort(), ids);
      permutations[side].add([...layout].sort((a, b) => a.center.x - b.center.x).map(p => p.figureId).join(','));
      firstFigures[side].add(layout[0].figureId);
      for (const p of layout) {
        assert.ok([0,90,180,270].includes(p.rotation));
        assert.equal(p.polygons.length, 7);
        assert.equal(p.polygons.reduce((sum, poly) => sum + polygonArea(poly), 0), 8 * 48 ** 2);
        assert.ok(p.bbox.x >= 32 && p.bbox.y >= 32);
        assert.ok(p.bbox.x + p.bbox.w <= BOARD_WIDTH - 32);
        assert.ok(p.bbox.y + p.bbox.h <= BOARD_HEIGHT - 32);
        assert.ok(p.polygons.flat().every(([x, y]) => Number.isInteger(x) && Number.isInteger(y)));
      }
      for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
        const a = layout[i], b = layout[j];
        assert.ok(Math.abs(a.center.x - b.center.x) >= 36);
        assert.ok(Math.abs(a.center.y - b.center.y) >= 36);
        const dx = Math.max(a.bbox.x - b.bbox.x - b.bbox.w, b.bbox.x - a.bbox.x - a.bbox.w, 0);
        const dy = Math.max(a.bbox.y - b.bbox.y - b.bbox.h, b.bbox.y - a.bbox.y - a.bbox.h, 0);
        assert.ok(Math.hypot(dx, dy) >= 28);
        if (seed < 20) for (const pa of a.polygons) for (const pb of b.polygons) assert.equal(intersectionArea(pa, pb), 0);
      }
      for (const axis of ['x', 'y']) {
        const values = layout.map(p => p.center[axis]).sort((a, b) => a - b);
        const band = axis === 'x' ? BOARD_WIDTH * 0.1 : BOARD_HEIGHT * 0.12;
        assert.ok(values[2] - values[0] > band || values[5] - values[3] > band, `${seed}: two regular bands`);
        for (let i = 0; i < 3; i++) assert.ok(values[i + 3] - values[i] > band);
      }
    }
    for (const human of layouts.human) {
      const ai = layouts.ai.find(p => p.figureId === human.figureId);
      assert.ok([90,270].includes((ai.rotation - human.rotation + 360) % 360));
      assert.ok(Math.hypot(ai.center.x - human.center.x, ai.center.y - human.center.y) >= 96);
      assert.notEqual(ai.id, human.id);
    }
    relativeOrders.add(layouts.human.map(h => layouts.ai.findIndex(a => a.figureId === h.figureId)).join(','));
  }
  for (const side of ['human', 'ai']) {
    assert.ok(permutations[side].size > 300, `${side}: source identity must not follow spatial order`);
    assert.equal(firstFigures[side].size, 6);
  }
  assert.ok(relativeOrders.size > 300, 'no fixed shared ordering or cyclic relation');
});

for (const seed of [0,17,2026]) test(`seed ${seed}: every PNG pixel and clickable exterior agrees with independent silhouettes`, () => {
  const trial = createTrialV2({ seed }), layouts = createLayoutsV2({ seed });
  for (const side of ['human', 'ai']) {
    const { width, height, pixels } = readPng(trial[side].png);
    assert.equal(width, BOARD_WIDTH); assert.equal(height, BOARD_HEIGHT);
    assert.equal(trial[side].mimeType, 'image/png');
    assert.deepEqual(Object.keys(trial.key[side]).sort(), layouts[side].map(p => p.id).sort());
    assert.deepEqual(Object.values(trial.key[side]).sort(), FIGURES.map(f => f.id).sort());
    const covered = new Uint8Array(width * height);
    let black = 0, checked = 0;
    for (const entry of layouts[side]) {
      assert.equal(trial.key[side][entry.id], entry.figureId);
      const expected = placedOutline(entry);
      const box = entry.bbox;
      const shape = side === 'human' ? trial.human.scene.shapes.find(p => p.id === entry.id) : null;
      const hitLoops = shape && parsePath(shape.path);
      let insideClicks = 0, blankClicks = 0;
      for (let y = box.y - 2; y < box.y + box.h + 2; y++) for (let x = box.x - 2; x < box.x + box.w + 2; x++) {
        const index = y * width + x;
        assert.equal(covered[index], 0);
        covered[index] = 1;
        let white = 0, onExterior = false;
        for (const dy of [0.25,0.75]) for (const dx of [0.25,0.75]) {
          const result = contains(expected, x + dx, y + dy);
          if (result === null) onExterior = true;
          else if (!result) white++;
        }
        if (!onExterior) {
          assert.equal(pixels[index], Math.round(white * 255 / 4), `${side} ${entry.id} at ${x},${y}`);
          checked++;
        }
        if (hitLoops) {
          // Unequal subpixel offsets cannot fall on a 45° exterior edge.
          const inside = contains(expected, x + 0.125, y + 0.375);
          assert.notEqual(inside, null);
          assert.equal(hits(hitLoops, x + 0.125, y + 0.375), inside);
          if (inside) insideClicks++; else blankClicks++;
        }
      }
      if (hitLoops) {
        assert.ok(insideClicks > 18000 && blankClicks > 5000);
        // SVG viewBox coordinates preserve exact hits at mobile/desktop sizes.
        for (const displayWidth of [280,390,768,1200]) {
          const ratio = displayWidth / width;
          const point = { x: entry.polygons[0].reduce((s, p) => s + p[0], 0) / 3,
            y: entry.polygons[0].reduce((s, p) => s + p[1], 0) / 3 };
          const screenX = 23 + point.x * ratio, screenY = 47 + point.y * ratio;
          assert.equal(hits(hitLoops, (screenX - 23) / ratio, (screenY - 47) / ratio), true);
          assert.equal(hits(hitLoops, box.x - 1, box.y - 1), false);
        }
      }
      const meanX = entry.polygons.reduce((s, p) => s + polygonArea(p) * p.reduce((a, q) => a + q[0], 0) / p.length, 0) / (8 * 48 ** 2);
      const meanY = entry.polygons.reduce((s, p) => s + polygonArea(p) * p.reduce((a, q) => a + q[1], 0) / p.length, 0) / (8 * 48 ** 2);
      const anchor = side === 'human' ? shape : trial.ai.anchors.find(p => p.id === entry.id);
      assert.ok(Math.abs(anchor.centroid.x - meanX) < 1e-8 && Math.abs(anchor.centroid.y - meanY) < 1e-8);
      if (side === 'ai') assert.deepEqual(anchor.bbox, box);
    }
    for (let i = 0; i < pixels.length; i++) {
      if (!covered[i]) assert.equal(pixels[i], 255, 'no labels, boxes, grids or stray ink');
      black += (255 - pixels[i]) / 255;
    }
    assert.ok(checked > 200000);
    assert.ok(Math.abs(black - 6 * 8 * 48 ** 2) < 100, 'six equal-area silhouettes, no extra marks');
  }
});

test('participant/model projections allowlist only own visible information and copy mutable data', () => {
  const trial = createTrialV2({ seed: 99 });
  trial.human.scene.gold = trial.key;
  trial.human.scene.shapes[0].figureId = 'PRIVATE';
  trial.human.scene.shapes[0].centroid.opposite = trial.ai.anchors;
  trial.ai.anchors[0].figureId = 'PRIVATE';
  trial.ai.anchors[0].bbox.key = trial.key;
  const human = participantView(trial), ai = modelView(trial);
  assert.deepEqual(Object.keys(human).sort(), ['height','shapes','width']);
  assert.deepEqual(Object.keys(ai).sort(), ['anchors','mimeType','png']);
  for (const shape of human.shapes) {
    assert.deepEqual(Object.keys(shape).sort(), ['centroid','id','path']);
    assert.deepEqual(Object.keys(shape.centroid).sort(), ['x','y']);
    parsePath(shape.path);
    assert.ok(!ai.anchors.some(a => a.id === shape.id));
  }
  for (const anchor of ai.anchors) {
    assert.deepEqual(Object.keys(anchor).sort(), ['bbox','centroid','id']);
    assert.deepEqual(Object.keys(anchor.bbox).sort(), ['h','w','x','y']);
    assert.deepEqual(Object.keys(anchor.centroid).sort(), ['x','y']);
  }
  assert.doesNotMatch(JSON.stringify(human), /PRIVATE|figureId|seed|trialId|key|F[1-6]/u);
  assert.doesNotMatch(JSON.stringify(ai.anchors), /PRIVATE|figureId|seed|trialId|key|F[1-6]/u);
  assert.deepEqual(ai.png, trial.ai.png);
  human.shapes[0].centroid.x = -100;
  ai.anchors[0].bbox.x = -100;
  ai.png.fill(0);
  assert.notEqual(trial.human.scene.shapes[0].centroid.x, -100);
  assert.notEqual(trial.ai.anchors[0].bbox.x, -100);
  assert.notEqual(trial.ai.png[0], 0);
});
