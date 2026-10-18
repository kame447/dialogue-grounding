import { inflateSync } from 'node:zlib';

/**
 * RESEARCHER ONLY. Input is one public OWN 400x400 cell PNG from
 * cropOwnCells(), or exactly its six outputs for diagnoseOwnCells(). Callers
 * must enforce ownership: pixels cannot prove it. Never supply a trial,
 * source polygons, Figure IDs, keys, other boards or participant images.
 * No I/O, model calls, prompt integration, recognition or cross-board matching.
 *
 * Example: diagnoseOwnCells(cropOwnCells(publicOwnPng)). Only an explicitly
 * reviewed later experiment may consider adding any results to model input.
 */
export const PIXEL_FEATURE_LIMITATION = 'Researcher pixel computation is not evidence that Luna sees the same shape and cannot substitute for a direct live model benchmark. Descriptors can collide (including reflections); differences are not calibrated recognition confidence. Only exact 0/90/180/270 pixel rotations are tested; arbitrary-angle rerasterization, scaling and threshold-crossing antialiasing may change results. Hull deficit includes holes and disconnected gaps, not just concavity.';

const SIZE = 400, PIXELS = SIZE * SIZE;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SLOT_LABELS = ['R1C1', 'R1C2', 'R1C3', 'R2C1', 'R2C2', 'R2C3'];
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function invalid() { throw new TypeError('Invalid or unsupported own-cell PNG'); }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function paeth(a, b, c) {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

// Deliberately narrow cropOwnCells output contract: 8-bit opaque grayscale,
// noninterlaced, IHDR/consecutive IDAT/IEND only. Reject metadata altogether.
// A local decoder avoids importing stimulus definitions or model clients.
function decode(png) {
  if (!Buffer.isBuffer(png) || png.length < 57 || png.length > 1024 * 1024 || !png.subarray(0, 8).equals(SIGNATURE)) invalid();
  let offset = 8, header = false, data = false, end = false;
  const parts = [];
  while (offset < png.length) {
    if (png.length - offset < 12) invalid();
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) invalid();
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) invalid();
    if (!header && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (header || length !== 13 || body.readUInt32BE(0) !== SIZE || body.readUInt32BE(4) !== SIZE ||
          !body.subarray(8).equals(Buffer.from([8, 0, 0, 0, 0]))) invalid();
      header = true;
    } else if (type === 'IDAT') { data = true; parts.push(body); }
    else if (type === 'IEND') {
      if (!data || length !== 0 || offset + 12 !== png.length) invalid();
      end = true;
    } else invalid();
    offset += length + 12;
  }
  if (!end) invalid();
  const rawLength = (SIZE + 1) * SIZE;
  let raw;
  try {
    const compressed = Buffer.concat(parts);
    const result = inflateSync(compressed, { maxOutputLength: rawLength, info: true });
    if (result.buffer.length !== rawLength || result.engine.bytesWritten !== compressed.length) invalid();
    raw = result.buffer;
  } catch { invalid(); }
  const pixels = Buffer.alloc(PIXELS);
  for (let y = 0; y < SIZE; y++) {
    const start = y * (SIZE + 1), filter = raw[start];
    if (filter > 4) invalid();
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x, a = x ? pixels[i - 1] : 0;
      const b = y ? pixels[i - SIZE] : 0, c = x && y ? pixels[i - SIZE - 1] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      pixels[i] = (raw[start + x + 1] + prediction) & 255;
    }
  }
  return pixels;
}
function options({ threshold = 127, radialBins = 8 } = {}) {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 254) throw new TypeError('threshold must be an integer from 0 to 254');
  if (!Number.isInteger(radialBins) || radialBins < 1 || radialBins > 16) throw new TypeError('radialBins must be an integer from 1 to 16');
  return { threshold, radialBins };
}
function hullArea(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (sequence) => {
    const out = [];
    for (const p of sequence) {
      while (out.length >= 2 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  const hull = [...half(points), ...half([...points].reverse())];
  let twiceArea = 0;
  hull.forEach((p, i) => { const q = hull[(i + 1) % hull.length]; twiceArea += p[0] * q[1] - p[1] * q[0]; });
  return Math.abs(twiceArea) / 2;
}
function describe(pixels, { threshold, radialBins }) {
  let count = 0, minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  const corners = [];
  for (let y = 0; y < SIZE; y++) {
    let left = SIZE, right = -1;
    for (let x = 0; x < SIZE; x++) if (pixels[y * SIZE + x] <= threshold) {
      count++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      left = Math.min(left, x); right = Math.max(right, x);
    }
    if (right >= 0) {
      minX = Math.min(minX, left); maxX = Math.max(maxX, right);
      minY = Math.min(minY, y); maxY = y;
      // Extremes of occupied unit squares suffice for the full pixel hull.
      corners.push([left, y], [right + 1, y], [left, y + 1], [right + 1, y + 1]);
    }
  }
  const width = count ? maxX - minX + 1 : 0, height = count ? maxY - minY + 1 : 0;
  const boxArea = width * height, diagonalSquared = width * width + height * height;
  const black = Array(radialBins).fill(0), white = Array(radialBins).fill(0);
  if (count) for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    // Integer doubled offsets around the box centre avoid axis/order rounding.
    const dx = 2 * x - minX - maxX, dy = 2 * y - minY - maxY;
    const bin = Math.min(radialBins - 1, Math.floor(Math.sqrt((dx * dx + dy * dy) / diagonalSquared) * radialBins));
    (pixels[y * SIZE + x] <= threshold ? black : white)[bin]++;
  }
  // Integer moment numerators stay below Number.MAX_SAFE_INTEGER at 400x400.
  // Sorted covariance eigenvalues discard principal-axis direction and sign.
  const xx = count ? (sxx * count - sx * sx) / count ** 2 / diagonalSquared : 0;
  const yy = count ? (syy * count - sy * sy) / count ** 2 / diagonalSquared : 0;
  const xy = count ? (sxy * count - sx * sy) / count ** 2 / diagonalSquared : 0;
  const gap = Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2);
  const convexHullAreaPixels = count ? hullArea(corners) : 0;
  return {
    status: count ? 'foreground' : 'empty', threshold, radialBins,
    foregroundPixels: count, convexHullAreaPixels,
    touchesCellEdge: count > 0 && (minX === 0 || minY === 0 || maxX === SIZE - 1 || maxY === SIZE - 1),
    features: {
      areaFraction: count / PIXELS,
      boundingShortFraction: Math.min(width, height) / SIZE,
      boundingLongFraction: Math.max(width, height) / SIZE,
      boundingFill: count ? count / boxArea : 0,
      momentMinor: Math.max(0, (xx + yy - gap) / 2), momentMajor: (xx + yy + gap) / 2,
      hullDeficitFraction: count ? 1 - count / convexHullAreaPixels : 0,
      // Each ring's black/white areas divided by total bounding-box area.
      // Their joint sum is 1 for nonempty cells, 0 for empty cells.
      radialForeground: black.map(n => boxArea ? n / boxArea : 0),
      radialBackground: white.map(n => boxArea ? n / boxArea : 0),
    },
  };
}
function flatten(features) {
  return Object.fromEntries(Object.entries(features).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((v, i) => [`${name}.${i}`, v]) : [[name, value]]));
}
function rotate(pixels) {
  const out = Buffer.alloc(PIXELS);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) out[x * SIZE + SIZE - 1 - y] = pixels[y * SIZE + x];
  return out;
}

/** Thresholded silhouette, not ink intensity or semantic object recognition.
 * White canvas outside the foreground box is ignored except in areaFraction.
 * Empty cells are explicit; a clipped silhouette is flagged, never repaired. */
export function describeOwnCellPng(ownCellPng, configuration) {
  return describe(decode(ownCellPng), options(configuration));
}

/** Independently recompute descriptors on four exact pixel permutations.
 * Stability is a numerical diagnostic (absolute tolerance 1e-12), not proof
 * of visual recognition. No best orientation or shape identity is inferred. */
export function compareOwnCellRotations(ownCellPng, configuration) {
  const settings = options(configuration);
  let pixels = decode(ownCellPng);
  const views = [0, 90, 180, 270].map(degreesCW => {
    const descriptor = describe(pixels, settings);
    pixels = rotate(pixels);
    return { degreesCW, descriptor };
  });
  const vectors = views.map(v => flatten(v.descriptor.features));
  const stability = Object.fromEntries(Object.keys(vectors[0]).map(name => {
    const values = vectors.map(vector => vector[name]), min = Math.min(...values), max = Math.max(...values);
    return [name, { min, max, spread: max - min, stable: max - min <= 1e-12 }];
  }));
  return { views, stability, allStable: Object.values(stability).every(v => v.stable), limitation: PIXEL_FEATURE_LIMITATION };
}

/** Exactly six crops from ONE own board, in cropOwnCells order. Pairwise
 * deltas compare only own slots; no identity, correspondence or answer key.
 * Max delta weights normalized features equally for inspection only, with
 * no acceptance threshold or interpretation as match likelihood. */
export function diagnoseOwnCells(ownCellPngs, configuration) {
  if (!Array.isArray(ownCellPngs) || ownCellPngs.length !== 6 || Array.from({ length: 6 }, (_, i) => ownCellPngs[i]).some(png => !Buffer.isBuffer(png))) {
    throw new TypeError('Expected exactly six own-cell PNG Buffers from one own board');
  }
  const slots = ownCellPngs.map((png, i) => ({ ownSlot: SLOT_LABELS[i], ...compareOwnCellRotations(png, configuration) }));
  const pairwise = [];
  for (let a = 0; a < slots.length; a++) for (let b = a + 1; b < slots.length; b++) {
    const first = slots[a].views[0].descriptor, second = slots[b].views[0].descriptor;
    const comparable = first.status === 'foreground' && second.status === 'foreground';
    const av = flatten(first.features), bv = flatten(second.features);
    const absoluteDeltas = comparable ? Object.fromEntries(Object.keys(av).map(name => [name, Math.abs(av[name] - bv[name])])) : null;
    pairwise.push({ ownSlots: [slots[a].ownSlot, slots[b].ownSlot], comparable, absoluteDeltas,
      maxNormalizedDelta: comparable ? Math.max(...Object.values(absoluteDeltas)) : null });
  }
  return { researcherOnly: true, settings: options(configuration), slots, pairwise, limitation: PIXEL_FEATURE_LIMITATION };
}
