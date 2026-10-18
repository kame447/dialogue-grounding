import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createTrial } from '../dialogue-model/runtime/stimuli/board.mjs';
import { cropOwnCells } from '../dialogue-model/runtime/visual/own-image-rotation.mjs';
import { describeOwnCellPng, compareOwnCellRotations, diagnoseOwnCells, PIXEL_FEATURE_LIMITATION } from '../dialogue-model/runtime/diagnostics/pixel-invariant-features.mjs';

// Independent fixture PNG codec and transpose/reverse rotation oracle.
const N = 400, SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, body = Buffer.alloc(0)) {
  const bytes = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length); bytes.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
function pack(parts) { return Buffer.concat([SIGNATURE, ...parts.map(([type, body]) => chunk(type, body))]); }
function encode(pixels, filter = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(N); header.writeUInt32BE(N, 4); header[8] = 8;
  const raw = Buffer.alloc((N + 1) * N);
  for (let y = 0; y < N; y++) {
    const f = filter === 'mixed' ? y % 5 : filter;
    raw[y * (N + 1)] = f;
    for (let x = 0; x < N; x++) {
      const i = y * N + x, a = x ? pixels[i - 1] : 0, b = y ? pixels[i - N] : 0, c = x && y ? pixels[i - N - 1] : 0;
      let prediction = 0;
      if (f === 1) prediction = a;
      if (f === 2) prediction = b;
      if (f === 3) prediction = Math.floor((a + b) / 2);
      if (f === 4) {
        const p = a + b - c;
        prediction = [a, b, c].reduce((best, v) => Math.abs(p - v) < Math.abs(p - best) ? v : best);
      }
      raw[y * (N + 1) + x + 1] = (pixels[i] - prediction + 256) % 256;
    }
  }
  return pack([['IHDR', header], ['IDAT', deflateSync(raw)], ['IEND']]);
}
function parts(png) {
  const out = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    out.push([png.toString('ascii', at + 4, at + 8), png.subarray(at + 8, at + 8 + size)]);
    at += size + 12;
  }
  return out;
}
function decodeCrop(png) {
  const data = parts(png), raw = inflateSync(Buffer.concat(data.filter(p => p[0] === 'IDAT').map(p => p[1])));
  const pixels = Buffer.alloc(N * N);
  for (let y = 0; y < N; y++) {
    assert.equal(raw[y * (N + 1)], 0);
    raw.copy(pixels, y * N, y * (N + 1) + 1, (y + 1) * (N + 1));
  }
  return pixels;
}
function turn(pixels) {
  const out = Buffer.alloc(pixels.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[y * N + x] = pixels[x * N + y];
  for (let y = 0; y < N; y++) out.subarray(y * N, (y + 1) * N).reverse();
  return out;
}
function bitmap(predicate, { dx = 0, dy = 0 } = {}) {
  return Buffer.from(Array.from({ length: N * N }, (_, i) => predicate(i % N - dx, Math.floor(i / N) - dy) ? 0 : 255));
}
function rect(x, y) { return x >= 100 && x < 120 && y >= 150 && y < 190; }
const rectangle = bitmap(rect), fixture = encode(rectangle);
function near(a, b, tolerance = 1e-12) { assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`); }

test('rectangle has analytic area, unordered bounds, fill, covariance and pixel-square hull', () => {
  const d = describeOwnCellPng(fixture);
  assert.equal(d.status, 'foreground'); assert.equal(d.foregroundPixels, 800);
  assert.equal(d.convexHullAreaPixels, 800); assert.equal(d.touchesCellEdge, false);
  assert.equal(d.features.areaFraction, 800 / 160000);
  assert.equal(d.features.boundingShortFraction, 20 / 400);
  assert.equal(d.features.boundingLongFraction, 40 / 400);
  assert.equal(d.features.boundingFill, 1); assert.equal(d.features.hullDeficitFraction, 0);
  near(d.features.momentMinor, (20 ** 2 - 1) / 12 / (20 ** 2 + 40 ** 2));
  near(d.features.momentMajor, (40 ** 2 - 1) / 12 / (20 ** 2 + 40 ** 2));
  near(d.features.radialForeground.reduce((a, b) => a + b), 1);
  assert.ok(d.features.radialBackground.every(v => v === 0));
});

test('L-shaped raster has known hull deficit; holes and gaps are explicitly not semantic concavity', () => {
  const cell = bitmap((x, y) => x >= 50 && x < 150 && y >= 50 && y < 150 && (x < 100 || y >= 100));
  const d = describeOwnCellPng(encode(cell));
  assert.equal(d.foregroundPixels, 7500); assert.equal(d.convexHullAreaPixels, 8750);
  near(d.features.hullDeficitFraction, 1 / 7);
  assert.match(PIXEL_FEATURE_LIMITATION, /holes and disconnected gaps/);
});

test('empty white and near-white backgrounds are explicit and never produce NaN or spurious shape', () => {
  for (const gray of [255, 254, 250]) {
    const d = describeOwnCellPng(encode(Buffer.alloc(N * N, gray)));
    assert.equal(d.status, 'empty'); assert.equal(d.foregroundPixels, 0);
    assert.equal(d.convexHullAreaPixels, 0); assert.equal(d.touchesCellEdge, false);
    assert.ok(Object.values(d.features).flat().every(v => Number.isFinite(v) && v === 0));
    assert.equal(compareOwnCellRotations(encode(Buffer.alloc(N * N, gray))).allStable, true);
  }
  const report = diagnoseOwnCells(Array.from({ length: 6 }, () => encode(Buffer.alloc(N * N, 255))));
  assert.ok(report.pairwise.every(p => !p.comparable && p.absoluteDeltas === null && p.maxNormalizedDelta === null));
});

test('full-cell, single-pixel and diagonal pixels have finite rotation invariants and clipping flags', () => {
  for (const pixels of [Buffer.alloc(N * N), bitmap((x, y) => x === 0 && y === 0), bitmap((x, y) => x === y)]) {
    const d = describeOwnCellPng(encode(pixels));
    assert.equal(d.touchesCellEdge, true);
    assert.ok(Object.values(d.features).flat().every(Number.isFinite));
    assert.equal(compareOwnCellRotations(encode(pixels)).allStable, true);
  }
});

test('translation on white canvas does not change descriptors or expose oriented position', () => {
  assert.deepEqual(describeOwnCellPng(encode(bitmap(rect, { dx: 71, dy: -53 }))), describeOwnCellPng(fixture));
  const asymmetric = bitmap((x, y) => (x >= 100 && x < 200 && y >= 80 && y < 110) || (x >= 150 && x < 180 && y >= 100 && y < 250));
  let pixels = asymmetric;
  const baseline = describeOwnCellPng(encode(pixels));
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(describeOwnCellPng(encode(pixels)), baseline);
    pixels = turn(pixels);
  }
});

test('stable descriptors do not imply unique recognition: mirror rasters can collide', () => {
  const asymmetric = bitmap((x, y) => x >= 100 && x < 200 && y >= 100 && y < 200 && (x < 140 || y > 170));
  const mirror = Buffer.from(asymmetric);
  for (let y = 0; y < N; y++) mirror.subarray(y * N, (y + 1) * N).reverse();
  assert.notDeepEqual(mirror, asymmetric);
  assert.deepEqual(describeOwnCellPng(encode(asymmetric)), describeOwnCellPng(encode(mirror)));
});

test('same area and bounds can still be distinguished by radial white occupancy, moments and hull', () => {
  const squareWithHole = bitmap((x, y) => x >= 100 && x < 200 && y >= 100 && y < 200 && !(x >= 130 && x < 170 && y >= 130 && y < 170));
  const squareWithNotch = bitmap((x, y) => x >= 100 && x < 200 && y >= 100 && y < 200 && !(x >= 160 && x < 200 && y >= 100 && y < 140));
  const a = describeOwnCellPng(encode(squareWithHole)), b = describeOwnCellPng(encode(squareWithNotch));
  assert.equal(a.foregroundPixels, b.foregroundPixels);
  assert.equal(a.features.boundingFill, b.features.boundingFill);
  assert.notDeepEqual(a.features.radialBackground, b.features.radialBackground);
  assert.notEqual(a.features.momentMajor, b.features.momentMajor);
  assert.notEqual(a.features.hullDeficitFraction, b.features.hullDeficitFraction);
  near([...a.features.radialForeground, ...a.features.radialBackground].reduce((s, v) => s + v), 1);
});

test('minor grayscale/antialias changes away from the threshold preserve the silhouette exactly', () => {
  const soft = Buffer.from(rectangle);
  for (let i = 0; i < soft.length; i++) soft[i] = soft[i] === 0 ? 8 + i % 12 : 240 + i % 16;
  assert.deepEqual(describeOwnCellPng(encode(soft)), describeOwnCellPng(fixture));
  const edge = Buffer.from(rectangle);
  for (let y = 150; y < 190; y++) { edge[y * N + 100] = 80; edge[y * N + 120] = 192; }
  const jitter = Buffer.from(edge);
  for (let i = 0; i < jitter.length; i++) if (jitter[i] === 80 || jitter[i] === 192) jitter[i] += i % 3 - 1;
  assert.deepEqual(describeOwnCellPng(encode(edge)), describeOwnCellPng(encode(jitter)));
  assert.equal(compareOwnCellRotations(encode(jitter)).allStable, true);
});

test('threshold-crossing antialias perturbation is measurable, small here, and not promised invariant', () => {
  const edge = Buffer.from(rectangle), changed = Buffer.from(rectangle);
  for (let y = 150; y < 190; y++) { edge[y * N + 120] = 127; changed[y * N + 120] = 128; }
  const a = describeOwnCellPng(encode(edge)), b = describeOwnCellPng(encode(changed));
  assert.equal(a.foregroundPixels - b.foregroundPixels, 40);
  near(a.features.areaFraction - b.features.areaFraction, 40 / 160000);
  assert.ok(Math.abs(a.features.boundingLongFraction - b.features.boundingLongFraction) <= 1 / N);
  assert.match(PIXEL_FEATURE_LIMITATION, /threshold-crossing antialiasing may change results/);
});

test('multiple own-board seeds: independent four pixel rotations agree exactly, own slots remain distinct', () => {
  for (const seed of [-1, 0, 9, 10, 0x527a9c3d, Number.MAX_SAFE_INTEGER]) {
    // Only the own public PNG is selected. No key/layout/other image is read
    // or passed to the diagnostic; source definitions only generate fixtures.
    const { ai: { png } } = createTrial({ seed });
    const crops = cropOwnCells(png), before = crops.map(p => Buffer.from(p));
    const report = diagnoseOwnCells(crops);
    assert.equal(report.researcherOnly, true); assert.equal(report.slots.length, 6); assert.equal(report.pairwise.length, 15);
    assert.deepEqual(report.slots.map(s => s.ownSlot), ['R1C1', 'R1C2', 'R1C3', 'R2C1', 'R2C2', 'R2C3']);
    for (let slot = 0; slot < 6; slot++) {
      const result = report.slots[slot]; let pixels = decodeCrop(crops[slot]);
      const expected = describeOwnCellPng(encode(pixels));
      assert.equal(result.allStable, true);
      assert.deepEqual(result.views.map(v => v.degreesCW), [0, 90, 180, 270]);
      result.views.forEach(view => {
        assert.deepEqual(view.descriptor, describeOwnCellPng(encode(pixels)));
        assert.deepEqual(view.descriptor, expected);
        pixels = turn(pixels);
      });
      assert.deepEqual(pixels, decodeCrop(crops[slot]));
    }
    // Distinct in these own fixtures is only a measured descriptor property,
    // not a ground-truth matching accuracy claim or guarantee for new shapes.
    assert.ok(report.pairwise.every(p => p.comparable && p.maxNormalizedDelta > 0));
    assert.deepEqual(crops, before);
  }
});

test('within-own-board comparisons report zero for rotated duplicates and reject sparse/wrapped inputs', () => {
  const cells = [fixture, encode(turn(rectangle)), fixture, fixture, fixture, fixture];
  const report = diagnoseOwnCells(cells);
  assert.ok(report.pairwise.every(p => p.maxNormalizedDelta === 0));
  for (const bad of [undefined, {}, { cells }, [], cells.slice(1), [...cells, fixture], Array(6), [fixture, fixture, fixture, fixture, fixture, {}]]) {
    assert.throws(() => diagnoseOwnCells(bad), /Expected exactly six own-cell PNG Buffers/);
  }
});

for (const filter of [0, 1, 2, 3, 4, 'mixed']) test(`PNG row filter ${filter} preserves exact descriptors`, () => {
  assert.deepEqual(describeOwnCellPng(encode(rectangle, filter)), describeOwnCellPng(fixture));
});

test('consecutive split IDAT is accepted; malformed PNG, metadata and expanded/trailing data fail closed', () => {
  const [header, data, end] = parts(fixture), middle = Math.floor(data[1].length / 2);
  assert.deepEqual(describeOwnCellPng(pack([header, ['IDAT', data[1].subarray(0, middle)], ['IDAT', data[1].subarray(middle)], end])), describeOwnCellPng(fixture));
  const corrupt = Buffer.from(fixture); corrupt[29] ^= 1;
  const badHeader = Buffer.from(header[1]); badHeader[9] = 2;
  const raw = inflateSync(data[1]), badFilter = Buffer.from(raw); badFilter[0] = 5;
  const badSize = Buffer.from(header[1]); badSize.writeUInt32BE(1200);
  const cases = [undefined, {}, new Uint8Array(fixture), Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1), fixture.subarray(0, -1),
    Buffer.concat([fixture, Buffer.from([0])]), corrupt, pack([header, data]), pack([header, end]), pack([data, header, end]),
    pack([header, header, data, end]), pack([['IHDR', badHeader], data, end]), pack([['IHDR', badSize], data, end]),
    pack([header, ['IDAT', Buffer.from('PRIVATE bad zlib')], end]),
    pack([header, ['IDAT', deflateSync(badFilter)], end]), pack([header, ['IDAT', deflateSync(raw.subarray(1))], end]),
    pack([header, ['IDAT', deflateSync(Buffer.concat([raw, raw]))], end]),
    pack([header, ['IDAT', Buffer.concat([data[1], Buffer.from([0])])], end]),
    ...['tEXt', 'iTXt', 'tRNS', 'gAMA', 'acTL', 'PLTE', 'ABCD'].map(type => pack([header, [type, Buffer.from('PRIVATE')], data, end])),
  ];
  for (const value of cases) for (const call of [describeOwnCellPng, compareOwnCellRotations]) {
    assert.throws(() => call(value), e => e instanceof TypeError && e.message === 'Invalid or unsupported own-cell PNG');
  }
});

test('validated settings are explicit and deterministic without changing input', () => {
  const before = Buffer.from(fixture);
  for (const radialBins of [1, 3, 8, 16]) {
    const result = compareOwnCellRotations(fixture, { radialBins, threshold: 100 });
    assert.equal(result.allStable, true);
    assert.equal(result.views[0].descriptor.features.radialForeground.length, radialBins);
    assert.deepEqual(result, compareOwnCellRotations(fixture, { radialBins, threshold: 100 }));
  }
  for (const threshold of [-1, 255, 1.5, NaN, '127']) assert.throws(() => describeOwnCellPng(fixture, { threshold }), /threshold must/);
  for (const radialBins of [0, 17, 1.5, NaN, '8']) assert.throws(() => describeOwnCellPng(fixture, { radialBins }), /radialBins must/);
  assert.deepEqual(fixture, before);
});

test('researcher-only module has only built-in zlib dependency and no metadata, network or model access', async () => {
  const poison = { png: fixture, get key() { throw new Error('key read'); }, get human() { throw new Error('partner read'); } };
  assert.throws(() => describeOwnCellPng(poison), /Invalid or unsupported own-cell PNG/);
  const code = await readFile(new URL('../dialogue-model/runtime/diagnostics/pixel-invariant-features.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]), ['node:zlib']);
  assert.doesNotMatch(code, /\b(?:fetch|readFile|writeFile|createTrial|createLayouts|FIGURES|process\.env|complete)\s*(?:\(|\[|\.)/);
  assert.match(PIXEL_FEATURE_LIMITATION, /not evidence that Luna sees the same shape/);
  assert.match(PIXEL_FEATURE_LIMITATION, /cannot substitute for a direct live model benchmark/);
});
