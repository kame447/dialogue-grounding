import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Optional, experimental own-board pixel aid. No caller currently injects it.
 * The caller must pass ONLY the PNG already visible to the AI: pixels cannot
 * establish who owns an image. Never pass a trial, another participant's PNG,
 * a key, layouts, source polygons, annotations, or scoring results.
 *
 * Contract: opaque 8-bit grayscale, noninterlaced 1200x800 PNG, six 400px
 * cells. All five PNG row filters and consecutive split IDATs are supported.
 * Text chunks are discarded without interpretation; other ancillary features
 * (including transparency, animation and color management) are unsupported.
 * Output has only IHDR/IDAT/IEND; labels describe own positions, not identity
 * or cross-board correspondence. Every image pixel is copied exactly once
 * per view; no recognition, normalization, rescaling, reflection or drawing
 * of shapes occurs. Headers are separate from the 400x400 image rectangles.
 *
 * Right angles cover the current synthetic board rotations. A future board
 * with 45-degree or arbitrary rotations needs a separately reviewed rotation
 * set/interpolation policy; this aid does not canonicalize arbitrary angles.
 * It does not demonstrate improved recognition or approve an experiment.
 */

// Keep this participant-visible vocabulary local: importing board.mjs would
// also load researcher-side layouts and source figures into this module graph.
export const OWN_SLOT_LABELS = Object.freeze({
  R1C1: '上段左', R1C2: '上段中', R1C3: '上段右',
  R2C1: '下段左', R2C2: '下段中', R2C3: '下段右',
});
const SLOT_ENTRIES = Object.entries(OWN_SLOT_LABELS);
const ROTATIONS = [0, 90, 180, 270];
const CELL = 400, BOARD_WIDTH = 1200, BOARD_HEIGHT = 800;
const HEADER = 32, GROUP_WIDTH = CELL * 2, GROUP_HEIGHT = HEADER + (HEADER + CELL) * 2;
const SHEET_WIDTH = GROUP_WIDTH * 3, SHEET_HEIGHT = GROUP_HEIGHT * 2;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function invalid() { throw new TypeError('Invalid or unsupported own-board PNG'); }
function paeth(a, b, c) {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

function decodeOwnBoard(png) {
  if (!Buffer.isBuffer(png) || png.length < 57 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(SIGNATURE)) invalid();
  let offset = 8, headerSeen = false, dataSeen = false, dataEnded = false, endSeen = false;
  const compressed = [];
  while (offset < png.length) {
    if (png.length - offset < 12) invalid();
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) invalid();
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) invalid();
    if (!headerSeen && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (headerSeen || length !== 13 || body.readUInt32BE(0) !== BOARD_WIDTH || body.readUInt32BE(4) !== BOARD_HEIGHT ||
          !body.subarray(8).equals(Buffer.from([8, 0, 0, 0, 0]))) invalid();
      headerSeen = true;
    } else if (type === 'IDAT') {
      if (dataEnded) invalid();
      dataSeen = true;
      compressed.push(body);
    } else if (type === 'IEND') {
      if (!dataSeen || length !== 0 || offset + 12 !== png.length) invalid();
      endSeen = true;
    } else {
      // Only non-rendering text metadata is allowed, then entirely discarded.
      if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) invalid();
      if (dataSeen) dataEnded = true;
    }
    offset += length + 12;
  }
  if (!endSeen) invalid();
  const rawLength = (BOARD_WIDTH + 1) * BOARD_HEIGHT;
  let raw;
  try {
    const data = Buffer.concat(compressed);
    const result = inflateSync(data, { maxOutputLength: rawLength, info: true });
    if (result.buffer.length !== rawLength || result.engine.bytesWritten !== data.length) invalid();
    raw = result.buffer;
  } catch { invalid(); } // Never propagate zlib's raw error or input data.
  const pixels = Buffer.alloc(BOARD_WIDTH * BOARD_HEIGHT);
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    const start = y * (BOARD_WIDTH + 1), filter = raw[start];
    if (filter > 4) invalid();
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const i = y * BOARD_WIDTH + x;
      const a = x ? pixels[i - 1] : 0, b = y ? pixels[i - BOARD_WIDTH] : 0;
      const c = x && y ? pixels[i - BOARD_WIDTH - 1] : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      pixels[i] = (raw[start + x + 1] + predictor) & 255;
    }
  }
  return pixels;
}

// Local pixel-only encoder avoids transitive imports of stimulus definitions.
function chunk(type, body) {
  const tagAndBody = Buffer.concat([Buffer.from(type), body]);
  const output = Buffer.alloc(body.length + 12);
  output.writeUInt32BE(body.length);
  tagAndBody.copy(output, 4);
  output.writeUInt32BE(crc32(tagAndBody), body.length + 8);
  return output;
}
function encodeGray(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function cropPixels(png) {
  const pixels = decodeOwnBoard(png);
  return SLOT_ENTRIES.map((_, index) => {
    const cell = Buffer.alloc(CELL * CELL);
    for (let y = 0; y < CELL; y++) {
      const start = (Math.floor(index / 3) * CELL + y) * BOARD_WIDTH + index % 3 * CELL;
      pixels.copy(cell, y * CELL, start, start + CELL);
    }
    return cell;
  });
}

/** Explicit researcher diagnostic: six fresh, metadata-free PNG Buffers in own
 * slot order (R1C1, R1C2, R1C3, R2C1, R2C2, R2C3). No automatic injection. */
export function cropOwnCells(png) {
  return cropPixels(png).map(pixels => encodeGray(CELL, CELL, pixels));
}

// Tiny fixed ASCII header font, not additional stimulus sprites.
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};
function label(pixels, text, x, y) {
  for (const character of text) {
    FONT[character].forEach((row, dy) => [...row].forEach((bit, dx) => {
      if (bit === '1') for (let sy = 0; sy < 3; sy++) {
        const start = (y + dy * 3 + sy) * SHEET_WIDTH + x + dx * 3;
        pixels.fill(0, start, start + 3);
      }
    }));
    x += 18;
  }
}

/** Returns null unless enabled is explicitly true. No file/network access.
 * Manifest rects are pixels in the output; degreesCW is relative to the own
 * crop. Inverse rotation is (360 - degreesCW) % 360, with no interpolation.
 * Example (after researcher review):
 *   createOwnImageRotationSheet(ownPng, { enabled: true })
 * Caller must apply the same aid setting to both comparison strategies.
 */
export function createOwnImageRotationSheet(ownPng, { enabled = false } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  if (!enabled) return null;
  const cells = cropPixels(ownPng), pixels = Buffer.alloc(SHEET_WIDTH * SHEET_HEIGHT, 255);
  const slots = SLOT_ENTRIES.map(([name, slot], index) => {
    const groupX = index % 3 * GROUP_WIDTH, groupY = Math.floor(index / 3) * GROUP_HEIGHT;
    label(pixels, name, groupX + 12, groupY + 5);
    const views = ROTATIONS.map((degreesCW, turn) => {
      const x = groupX + turn % 2 * CELL, titleY = groupY + HEADER + Math.floor(turn / 2) * (HEADER + CELL);
      const y = titleY + HEADER;
      label(pixels, `${degreesCW} CW`, x + 12, titleY + 5);
      for (let sy = 0; sy < CELL; sy++) for (let sx = 0; sx < CELL; sx++) {
        let dx, dy;
        if (turn === 0) [dx, dy] = [sx, sy];
        else if (turn === 1) [dx, dy] = [CELL - 1 - sy, sx];
        else if (turn === 2) [dx, dy] = [CELL - 1 - sx, CELL - 1 - sy];
        else [dx, dy] = [sy, CELL - 1 - sx];
        pixels[(y + dy) * SHEET_WIDTH + x + dx] = cells[index][sy * CELL + sx];
      }
      return { degreesCW, rect: { x, y, width: CELL, height: CELL } };
    });
    return { label: name, slot, sourceRect: { x: index % 3 * CELL, y: Math.floor(index / 3) * CELL, width: CELL, height: CELL }, views };
  });
  return {
    png: encodeGray(SHEET_WIDTH, SHEET_HEIGHT, pixels), mimeType: 'image/png',
    width: SHEET_WIDTH, height: SHEET_HEIGHT, slots,
    description: 'Own board only. R1/R2 are original top/bottom rows; C1/C2/C3 are original left/middle/right columns. CW means clockwise rotation of that own cell. Labels do not identify another participant\'s slots.',
    limitation: 'Only 0/90/180/270 degrees; 45-degree or arbitrary rotations and reflections are not handled. Recognition benefit requires a separate diagnostic.',
  };
}
