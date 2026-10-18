import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createTrial, SLOTS } from '../dialogue-model/runtime/stimuli/board.mjs';
import { OWN_SLOT_LABELS, cropOwnCells, createOwnImageRotationSheet } from '../dialogue-model/runtime/visual/own-image-rotation.mjs';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Independent fixture encoder and reader: no production codec/crop/rotation
// helpers are reused as the expected answer.
function chunk(type, body = Buffer.alloc(0)) {
  const bytes = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length); bytes.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function chunks(png) {
  assert.deepEqual(png.subarray(0, 8), SIGNATURE);
  const result = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    assert.deepEqual(png.subarray(offset, offset + length + 12), chunk(type, body));
    result.push({ type, body }); offset += length + 12;
    assert.ok(offset <= png.length);
  }
  return result;
}
function pack(parts) { return Buffer.concat([SIGNATURE, ...parts.map(({ type, body }) => chunk(type, body))]); }
function decode(png) {
  const parts = chunks(png);
  assert.deepEqual(parts.map(p => p.type), ['IHDR', 'IDAT', 'IEND']);
  const header = parts[0].body, width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  assert.deepEqual([...header.subarray(8)], [8, 0, 0, 0, 0]);
  const raw = inflateSync(parts[1].body), pixels = Buffer.alloc(width * height);
  assert.equal(raw.length, (width + 1) * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0);
    raw.copy(pixels, y * width, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return { width, height, pixels };
}
function encode(pixels, { filter = 0, width = 1200, height = 800 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filter === 'mixed' ? y % 5 : filter;
    raw[y * (width + 1)] = f;
    for (let x = 0; x < width; x++) {
      const at = y * width + x, left = x ? pixels[at - 1] : 0, above = y ? pixels[at - width] : 0;
      const corner = x && y ? pixels[at - width - 1] : 0;
      let prediction = 0;
      if (f === 1) prediction = left;
      if (f === 2) prediction = above;
      if (f === 3) prediction = Math.floor((left + above) / 2);
      if (f === 4) {
        const p = left + above - corner;
        const choices = [left, above, corner];
        prediction = choices.reduce((best, value) => Math.abs(p - value) < Math.abs(p - best) ? value : best);
      }
      raw[y * (width + 1) + x + 1] = (pixels[at] - prediction + 256) % 256;
    }
  }
  return pack([{ type: 'IHDR', body: header }, { type: 'IDAT', body: deflateSync(raw) }, { type: 'IEND' }]);
}
function extract(image, { x, y, width, height }) {
  const out = Buffer.alloc(width * height);
  for (let row = 0; row < height; row++) {
    const start = (y + row) * image.width + x;
    image.pixels.copy(out, row * width, start, start + width);
  }
  return out;
}
function ownCells(image) {
  return Array.from({ length: 6 }, (_, i) => extract(image, { x: i % 3 * 400, y: Math.floor(i / 3) * 400, width: 400, height: 400 }));
}
// Clockwise = transpose then reverse each row. This differs from the module's
// source-coordinate scatter and independently checks direction and reversibility.
function rotate(cell, times) {
  let result = Buffer.from(cell);
  while (times-- > 0) {
    const transpose = Buffer.alloc(result.length);
    for (let row = 0; row < 400; row++) for (let col = 0; col < 400; col++) transpose[row * 400 + col] = result[col * 400 + row];
    for (let row = 0; row < 400; row++) transpose.subarray(row * 400, (row + 1) * 400).reverse();
    result = transpose;
  }
  return result;
}
function exact(actual, expected) { assert.ok(actual.equals(expected), 'every grayscale pixel must equal the expected own cell'); }
const pixels = Buffer.from(Array.from({ length: 1200 * 800 }, (_, i) => {
  const y = Math.floor(i / 1200), x = i % 1200;
  return (x * 17 + y * 29 + Math.floor(x / 400) * 31 + Math.floor(y / 400) * 73) & 255;
}));
const fixture = encode(pixels);

test('aid is disabled by default, accepts only explicit boolean opt-in, and does no default decoding', () => {
  assert.equal(createOwnImageRotationSheet(fixture), null);
  assert.equal(createOwnImageRotationSheet(undefined), null);
  const poison = new Proxy({}, { get() { throw new Error('must not inspect image'); } });
  assert.equal(createOwnImageRotationSheet(poison, { enabled: false }), null);
  for (const enabled of ['true', 1, null, {}]) assert.throws(() => createOwnImageRotationSheet(fixture, { enabled }), /enabled must be boolean/);
});

test('cropOwnCells gives six exact fresh 400x400 grayscale PNGs in own slot order', () => {
  const expected = ownCells({ width: 1200, pixels });
  const crops = cropOwnCells(fixture), repeat = cropOwnCells(fixture);
  assert.equal(crops.length, 6);
  crops.forEach((png, i) => {
    const image = decode(png);
    assert.equal(image.width, 400); assert.equal(image.height, 400);
    exact(image.pixels, expected[i]);
    assert.notEqual(png, repeat[i]); assert.deepEqual(png, repeat[i]);
  });
});

test('all 24 views exactly preserve arbitrary grayscale values and invert every supported right angle', () => {
  const before = Buffer.from(fixture), sheet = createOwnImageRotationSheet(fixture, { enabled: true });
  const output = decode(sheet.png), expected = ownCells({ width: 1200, pixels });
  assert.equal(output.width, 2400); assert.equal(output.height, 1792);
  assert.equal(sheet.width, output.width); assert.equal(sheet.height, output.height);
  assert.equal(sheet.mimeType, 'image/png'); assert.equal(sheet.slots.length, 6);
  sheet.slots.forEach((slot, i) => {
    assert.deepEqual(slot.sourceRect, { x: i % 3 * 400, y: Math.floor(i / 3) * 400, width: 400, height: 400 });
    assert.deepEqual(slot.views.map(v => v.degreesCW), [0, 90, 180, 270]);
    slot.views.forEach((view, t) => {
      assert.deepEqual(view.rect, { x: i % 3 * 800 + t % 2 * 400, y: Math.floor(i / 3) * 896 + 64 + Math.floor(t / 2) * 432, width: 400, height: 400 });
      const crop = extract(output, view.rect);
      exact(crop, rotate(expected[i], t));
      exact(rotate(crop, (4 - t) % 4), expected[i]);
    });
  });
  assert.deepEqual(fixture, before);
});

test('exact-pixel oracle rejects one-pixel shift, noise, and a wrong own slot', () => {
  const source = ownCells({ width: 1200, pixels }), output = decode(createOwnImageRotationSheet(fixture, { enabled: true }).png);
  const actual = extract(output, { x: 0, y: 64, width: 400, height: 400 });
  exact(actual, source[0]);
  const noisy = Buffer.from(source[0]); noisy[12345] ^= 1;
  const shifted = Buffer.concat([source[0].subarray(1), source[0].subarray(0, 1)]);
  for (const wrong of [noisy, shifted, source[1]]) assert.throws(() => exact(actual, wrong), /every grayscale pixel/);
});

// Decode the fixed header glyphs from the actual rendered bitmap. These golden
// bit patterns verify labels, not merely the returned manifest strings.
const GLYPHS = {
  '01110/10001/10011/10101/11001/10001/01110': '0',
  '00100/01100/00100/00100/00100/00100/01110': '1',
  '01110/10001/00001/00010/00100/01000/11111': '2',
  '11110/00001/00001/01110/00001/00001/11110': '3',
  '11111/00001/00010/00100/01000/01000/01000': '7',
  '01110/10001/10001/01110/10001/10001/01110': '8',
  '01110/10001/10001/01111/00001/00001/01110': '9',
  '11110/10001/10001/11110/10100/10010/10001': 'R',
  '01111/10000/10000/10000/10000/10000/01111': 'C',
  '10001/10001/10001/10101/10101/10101/01010': 'W',
  '00000/00000/00000/00000/00000/00000/00000': ' ',
};
function readLabel(image, x, y, count) {
  let result = '';
  for (let i = 0; i < count; i++) {
    const rows = [];
    for (let row = 0; row < 7; row++) {
      let bits = '';
      for (let col = 0; col < 5; col++) {
        const block = extract(image, { x: x + i * 18 + col * 3, y: y + row * 3, width: 3, height: 3 });
        assert.ok(block.every(v => v === block[0]));
        assert.ok(block[0] === 0 || block[0] === 255);
        bits += block[0] === 0 ? '1' : '0';
      }
      rows.push(bits);
    }
    const letter = GLYPHS[rows.join('/')]; assert.notEqual(letter, undefined); result += letter;
  }
  return result;
}
test('raster row/column and CW labels match exported own-slot vocabulary and retain the 2x3 layout', () => {
  const labels = ['R1C1', 'R1C2', 'R1C3', 'R2C1', 'R2C2', 'R2C3'];
  assert.deepEqual(Object.keys(OWN_SLOT_LABELS), labels);
  assert.deepEqual(Object.values(OWN_SLOT_LABELS), SLOTS);
  assert.ok(Object.isFrozen(OWN_SLOT_LABELS));
  const sheet = createOwnImageRotationSheet(fixture, { enabled: true }), image = decode(sheet.png);
  sheet.slots.forEach((slot, i) => {
    assert.equal(slot.label, labels[i]); assert.equal(slot.slot, SLOTS[i]);
    const x = i % 3 * 800, y = Math.floor(i / 3) * 896;
    assert.equal(readLabel(image, x + 12, y + 5, 4), labels[i]);
    slot.views.forEach(view => {
      const text = `${view.degreesCW} CW`;
      assert.equal(readLabel(image, view.rect.x + 12, view.rect.y - 27, text.length), text);
    });
  });
});

test('blank own board produces only labels outside image rectangles, with no hidden shape sprites', () => {
  const sheet = createOwnImageRotationSheet(encode(Buffer.alloc(1200 * 800, 255)), { enabled: true });
  const image = decode(sheet.png), allowed = Buffer.alloc(image.pixels.length);
  for (let i = 0; i < 6; i++) {
    const slot = sheet.slots[i], x = i % 3 * 800, y = Math.floor(i / 3) * 896;
    const markText = (tx, ty, length) => {
      for (let row = 0; row < 21; row++) allowed.fill(1, (ty + row) * 2400 + tx, (ty + row) * 2400 + tx + length * 18 - 3);
    };
    markText(x + 12, y + 5, 4);
    slot.views.forEach(view => {
      assert.ok(extract(image, view.rect).every(p => p === 255));
      markText(view.rect.x + 12, view.rect.y - 27, `${view.degreesCW} CW`.length);
    });
  }
  for (let i = 0; i < image.pixels.length; i++) if (!allowed[i]) assert.equal(image.pixels[i], 255);
});

test('actual own synthetic boards at reproducible randomized seeds preserve every crop and rotation', () => {
  let state = 0x527a9c3d;
  const seeds = [-1, 0, Number.MAX_SAFE_INTEGER];
  for (let i = 0; i < 5; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; seeds.push(state); }
  for (const seed of seeds) {
    // Only this one PNG crosses the production API boundary; no trial/key,
    // counterpart image, layout or source figure is passed to the module.
    const { ai: { png } } = createTrial({ seed });
    const expected = ownCells(decode(png)), crops = cropOwnCells(png);
    const sheet = createOwnImageRotationSheet(png, { enabled: true }), actual = decode(sheet.png);
    expected.forEach((cell, i) => {
      exact(decode(crops[i]).pixels, cell);
      sheet.slots[i].views.forEach((view, t) => exact(extract(actual, view.rect), rotate(cell, t)));
    });
  }
});

for (const filter of [0, 1, 2, 3, 4, 'mixed']) test(`PNG filter ${filter} decodes to exactly the same grayscale crops`, () => {
  const actual = cropOwnCells(encode(pixels, { filter })).map(decode);
  ownCells({ width: 1200, pixels }).forEach((cell, i) => exact(actual[i].pixels, cell));
});

test('split consecutive IDATs are accepted without changing pixels', () => {
  const [header, data, end] = chunks(fixture), mid = Math.floor(data.body.length / 2);
  const split = pack([header, { type: 'IDAT', body: data.body.subarray(0, mid) }, { type: 'IDAT', body: data.body.subarray(mid) }, end]);
  assert.deepEqual(cropOwnCells(split), cropOwnCells(fixture));
});

test('text metadata is ignored and cannot leak into PNGs, labels, manifest or errors', () => {
  const secret = 'PRIVATE-KEY-HUMAN-IMAGE-FIGURE-ID-FUTURE-TURN';
  const [header, data, end] = chunks(fixture);
  const texts = ['tEXt', 'zTXt', 'iTXt'].map(type => ({ type, body: Buffer.from(`Comment\0${secret}`) }));
  const withMetadata = pack([header, ...texts, data, end, /* no trailing data */]);
  assert.deepEqual(cropOwnCells(withMetadata), cropOwnCells(fixture));
  const sheet = createOwnImageRotationSheet(withMetadata, { enabled: true });
  assert.deepEqual(sheet, createOwnImageRotationSheet(fixture, { enabled: true }));
  assert.ok(!JSON.stringify({ ...sheet, png: undefined }).includes(secret));
  for (const output of [sheet.png, ...cropOwnCells(withMetadata)]) assert.ok(!output.includes(secret));
  const invalid = Buffer.from(withMetadata); invalid[0] = 0;
  assert.throws(() => cropOwnCells(invalid), error => error.message === 'Invalid or unsupported own-board PNG' && !error.message.includes(secret));
});

test('API rejects image/trial wrappers and imports only built-in zlib, with no researcher or I/O dependencies', async () => {
  const poisoned = { png: fixture, key: 'PRIVATE', human: 'PRIVATE', get figureId() { throw new Error('metadata read'); } };
  assert.throws(() => cropOwnCells(poisoned), /Invalid or unsupported own-board PNG/);
  assert.throws(() => createOwnImageRotationSheet(poisoned, { enabled: true }), /Invalid or unsupported own-board PNG/);
  const code = await readFile(new URL('../dialogue-model/runtime/visual/own-image-rotation.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]), ['node:zlib']);
  assert.doesNotMatch(code, /\b(?:fetch|readFile|writeFile|createTrial|createLayouts|FIGURES|process\.env)\s*(?:\(|\[|\.)/);
});

test('malformed, oversized and unsupported PNGs fail closed with a stable sanitized error', () => {
  const [header, data, end] = chunks(fixture);
  const changedHeader = (offset, value) => { const body = Buffer.from(header.body); body[offset] = value; return { type: 'IHDR', body }; };
  const corruptCrc = Buffer.from(fixture); corruptCrc[29] ^= 1;
  const raw = inflateSync(data.body);
  const badFilter = Buffer.from(raw); badFilter[0] = 5;
  const cases = [
    undefined, {}, new Uint8Array(fixture), Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1),
    fixture.subarray(0, 7), fixture.subarray(0, -1), Buffer.concat([fixture, Buffer.from([0])]), corruptCrc,
    pack([header, data]), pack([header, end]), pack([data, header, end]), pack([header, header, data, end]),
    pack([header, data, { type: 'IEND', body: Buffer.from([0]) }]),
    ...[0, 4, 8, 9, 10, 11, 12].map(at => pack([changedHeader(at, 1), data, end])),
    ...['tRNS', 'acTL', 'fcTL', 'fdAT', 'gAMA', 'PLTE', 'ABCD'].map(type => pack([header, { type, body: Buffer.alloc(0) }, data, end])),
    pack([header, data, { type: 'tEXt', body: Buffer.from('x\0y') }, data, end]),
    pack([header, { type: 'IDAT', body: Buffer.from('PRIVATE zlib failure') }, end]),
    pack([header, { type: 'IDAT', body: deflateSync(badFilter) }, end]),
    pack([header, { type: 'IDAT', body: deflateSync(raw.subarray(1)) }, end]),
    pack([header, { type: 'IDAT', body: deflateSync(Buffer.concat([raw, Buffer.from([0])])) }, end]),
    pack([header, { type: 'IDAT', body: Buffer.concat([data.body, Buffer.from([0])]) }, end]),
  ];
  for (const png of cases) for (const call of [() => cropOwnCells(png), () => createOwnImageRotationSheet(png, { enabled: true })]) {
    assert.throws(call, error => error instanceof TypeError && error.message === 'Invalid or unsupported own-board PNG');
  }
});

test('output is deterministic and documents own-only labels and unsupported non-right-angle views', () => {
  const first = createOwnImageRotationSheet(fixture, { enabled: true });
  assert.deepEqual(first, createOwnImageRotationSheet(Buffer.from(fixture), { enabled: true }));
  assert.match(first.description, /Own board only/); assert.match(first.description, /do not identify another/);
  assert.match(first.limitation, /45-degree or arbitrary rotations and reflections are not handled/);
});
