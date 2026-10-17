import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PIECES } from '../dialogue-model/runtime/stimuli/pieces.mjs';
import { FIGURES } from '../dialogue-model/runtime/stimuli/figures.mjs';
import { polygonArea, intersectionArea, sharesEdge, transformPolygon, silhouetteSignature, validateFigure, validateFigures } from '../dialogue-model/runtime/stimuli/geometry.mjs';
import { renderFigure, renderPolygons } from '../dialogue-model/runtime/stimuli/render.mjs';
import { createTrial, createLayouts, SLOTS } from '../dialogue-model/runtime/stimuli/board.mjs';

// Independent PNG reader verifies chunk CRCs and decodes the actual image data.
function readPng(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8, width, height;
  const types = [], data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of buffer.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    assert.equal(buffer.readUInt32BE(offset + 8 + length), (crc ^ 0xffffffff) >>> 0);
    types.push(type);
    if (type === 'IHDR') {
      assert.equal(length, 13);
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      assert.deepEqual([...body.subarray(8)], [8, 0, 0, 0, 0]);
    }
    if (type === 'IDAT') data.push(body);
    offset += length + 12;
  }
  assert.equal(offset, buffer.length);
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const raw = inflateSync(Buffer.concat(data)), pixels = Buffer.alloc(width * height);
  assert.equal(raw.length, (width + 1) * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0);
    raw.copy(pixels, y * width, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return { width, height, pixels };
}
const blackFraction = pixels => pixels.reduce((sum, p) => sum + (255 - p) / 255, 0) / pixels.length;

test('six fixed figures each use the seven congruent, nonoverlapping, edge-connected pieces of area eight', () => {
  assert.equal(PIECES.length, 7);
  assert.deepEqual(PIECES.map(p => polygonArea(p.points)), [2, 2, 1, 0.5, 0.5, 1, 1]);
  assert.deepEqual(FIGURES.map(f => f.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
  for (const figure of FIGURES) {
    assert.deepEqual(validateFigure(figure), { valid: true, errors: [], area: 8 }, figure.id);
    assert.ok(figure.pieces.every(p => p.points.every(v => v.every(Number.isInteger))));
  }
  assert.deepEqual(validateFigures(FIGURES), { valid: true, errors: [] });
});

test('geometric clipping distinguishes overlap, shared edges and point contact', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(intersectionArea(square, square), 1);
  assert.equal(intersectionArea(square, [[0, 0], [1, 0], [0, 1]]), 0.5);
  const partial = transformPolygon(square, { x: 0.25, y: 0.5 });
  assert.equal(intersectionArea(square, partial), 0.375);
  const neighbor = transformPolygon(square, { x: 1 });
  assert.equal(intersectionArea(square, neighbor), 0);
  assert.equal(sharesEdge(square, neighbor), true);
  const corner = transformPolygon(square, { x: 1, y: 1 });
  assert.equal(intersectionArea(square, corner), 0);
  assert.equal(sharesEdge(square, corner), false);
  assert.equal(intersectionArea([...square].reverse(), partial), 0.375);
  assert.equal(sharesEdge(square, [[1, 0.25], [2, 0.25], [1, 0.75]]), true);
});

test('validation rejects distorted, overlapping, missing and disconnected pieces', () => {
  const clone = () => structuredClone(FIGURES[0]);
  const distorted = clone(); distorted.pieces[0].points[1][0] += 1;
  assert.equal(validateFigure(distorted).valid, false);
  const overlapping = clone(); overlapping.pieces[1].points = overlapping.pieces[0].points;
  assert.ok(validateFigure(overlapping).errors.some(e => e.startsWith('Overlap')));
  const missing = clone(); missing.pieces.pop();
  assert.equal(validateFigure(missing).valid, false);
  const disconnected = clone(); disconnected.pieces[6].points = transformPolygon(disconnected.pieces[6].points, { x: 100 });
  assert.ok(validateFigure(disconnected).errors.includes('Pieces are not edge-connected'));
});

test('silhouette identity removes piece boundaries and is invariant to translation, rotation and reflection', () => {
  const square = [{ points: [[0, 0], [2, 0], [2, 2], [0, 2]] }];
  const split = [{ points: [[0, 0], [2, 0], [0, 2]] }, { points: [[2, 2], [0, 2], [2, 0]] }];
  assert.equal(silhouetteSignature(square), silhouetteSignature(split));
  for (const figure of FIGURES) for (const reflect of [false, true]) for (let rotation = 0; rotation < 360; rotation += 45) {
    const transformed = figure.pieces.map(p => ({ ...p, points: transformPolygon(p.points, { rotation, reflect, x: 8, y: -7 }) }));
    assert.equal(silhouetteSignature(transformed), silhouetteSignature(figure.pieces));
  }
  const duplicate = { ...FIGURES[0], id: 'duplicate', pieces: FIGURES[0].pieces.map(p => ({ ...p, points: transformPolygon(p.points, { rotation: 90, reflect: true, x: 10 }) })) };
  assert.equal(validateFigures([FIGURES[0], duplicate]).valid, false);
});

test('standalone silhouettes produce valid deterministic PNGs with reasonable black area', () => {
  for (const figure of FIGURES) {
    const png = renderFigure(figure), decoded = readPng(png);
    assert.equal(decoded.width, 400); assert.equal(decoded.height, 400);
    const fraction = blackFraction(decoded.pixels);
    assert.ok(fraction > 0.15 && fraction < 0.55, `${figure.id}: ${fraction}`);
    assert.deepEqual(png, renderFigure(figure));
    assert.equal(decoded.pixels[0], 255);
  }
  // A tiled square has exactly the same pixels as its unsplit polygon: no seams.
  const square = [[10, 10], [90, 10], [90, 90], [10, 90]];
  const options = { width: 100, height: 100 };
  assert.deepEqual(renderPolygons([square], options), renderPolygons([[[10, 10], [90, 10], [10, 90]], [[90, 90], [10, 90], [90, 10]]], options));
});

test('board keys are six-slot bijections and every figure changes position and rotation without reflection', () => {
  const ids = FIGURES.map(f => f.id).sort();
  const orders = new Set();
  for (let seed = 0; seed < 100; seed++) {
    const layout = createLayouts({ seed });
    assert.deepEqual(layout, createLayouts({ seed }));
    orders.add(layout.ai.map(p => p.figureId).join(','));
    for (const side of ['human', 'ai']) {
      assert.deepEqual(layout[side].map(p => p.slot), SLOTS);
      assert.deepEqual(layout[side].map(p => p.figureId).sort(), ids);
      assert.ok(layout[side].every(p => [0, 90, 180, 270].includes(p.rotation) && !p.reflect));
    }
    for (const human of layout.human) {
      const ai = layout.ai.find(p => p.figureId === human.figureId);
      assert.notEqual(ai.slot, human.slot);
      assert.notEqual(ai.rotation, human.rotation);
    }
  }
  assert.ok(orders.size > 30);
  assert.throws(() => createTrial({ seed: '1' }), TypeError);
  assert.throws(() => createTrial({ seed: 1.5 }), TypeError);
  assert.throws(() => createTrial({ seed: Number.MAX_SAFE_INTEGER + 1 }), TypeError);
});

test('trial PNGs match their key and rotated silhouettes, contain no metadata, and reproduce by seed', () => {
  const trial = createTrial({ seed: 2026 }), repeat = createTrial({ seed: 2026 });
  assert.deepEqual(trial, repeat);
  assert.notEqual(trial.trialId, createTrial({ seed: 2027 }).trialId);
  assert.notDeepEqual(trial.human.png, trial.ai.png);
  const decoded = Object.fromEntries(['human', 'ai'].map(side => [side, readPng(trial[side].png)]));
  const layout = createLayouts({ seed: 2026 });
  for (const side of ['human', 'ai']) {
    assert.equal(trial[side].mimeType, 'image/png');
    assert.equal(decoded[side].width, 1200); assert.equal(decoded[side].height, 800);
    assert.deepEqual(Object.keys(trial.key[side]), SLOTS);
    assert.deepEqual(Object.values(trial.key[side]).sort(), FIGURES.map(f => f.id).sort());
    assert.deepEqual(trial.key[side], Object.fromEntries(layout[side].map(p => [p.slot, p.figureId])));
    const fraction = blackFraction(decoded[side].pixels);
    assert.ok(fraction > 0.12 && fraction < 0.35, String(fraction));
  }
  // Crop matching figures from the two images and rotate the human crop to the
  // AI orientation. Near-identical coverage verifies actual rendered placement.
  for (const human of layout.human) {
    const ai = layout.ai.find(p => p.figureId === human.figureId);
    const humanIndex = SLOTS.indexOf(human.slot), aiIndex = SLOTS.indexOf(ai.slot);
    let error = 0;
    const turns = ((ai.rotation - human.rotation + 360) % 360) / 90;
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      let tx = x, ty = y;
      for (let turn = 0; turn < turns; turn++) [tx, ty] = [399 - ty, tx];
      const hp = decoded.human.pixels[(Math.floor(humanIndex / 3) * 400 + y) * 1200 + (humanIndex % 3) * 400 + x];
      const ap = decoded.ai.pixels[(Math.floor(aiIndex / 3) * 400 + ty) * 1200 + (aiIndex % 3) * 400 + tx];
      error += Math.abs(hp - ap);
    }
    assert.ok(error / (400 * 400 * 255) < 0.001, `${human.figureId}: rotation pixel error ${error}`);
  }
});

test('preview writes only eight PNGs with slot filenames and prints researcher key only to stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tangram-preview-'));
  try {
    const output = execFileSync(process.execPath, ['dialogue-model/runtime/stimuli/preview.mjs', '--seed', '17', '--out', directory], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    const report = JSON.parse(output), files = await readdir(directory);
    assert.equal(files.length, 8);
    assert.deepEqual(report.key, createTrial({ seed: 17 }).key);
    assert.ok(files.every(f => f.endsWith('.png') && !/F[1-6]/u.test(f)));
    for (const file of files) readPng(await readFile(join(directory, file)));
    assert.equal(Object.keys(report.singleFigureFiles).length, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
