import { deflateSync } from 'node:zlib';
import { transformPolygon } from './geometry.mjs';

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const tag = Buffer.from(type), body = Buffer.concat([tag, data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

// Grayscale PNG with precisely IHDR, IDAT and IEND; no text or other metadata.
export function encodePng(width, height, pixels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || pixels.length !== width * height) {
    throw new TypeError('Invalid grayscale image dimensions');
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth; grayscale, compression, filter and interlace = 0
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function renderPolygons(polygons, { width = 1200, height = 800, supersample = 2 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || ![1, 2, 3, 4].includes(supersample)) {
    throw new TypeError('Invalid raster dimensions or supersampling');
  }
  const w = width * supersample, h = height * supersample;
  const raster = Buffer.alloc(w * h, 255);
  const spans = Array.from({ length: h }, () => []);
  for (const points of polygons) {
    const p = points.map(([x, y]) => [x * supersample, y * supersample]);
    const start = Math.max(0, Math.ceil(Math.min(...p.map(a => a[1])) - 0.5));
    const end = Math.min(h - 1, Math.floor(Math.max(...p.map(a => a[1])) - 0.5));
    for (let y = start; y <= end; y++) {
      const scanY = y + 0.5, intersections = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        if ((a[1] <= scanY && b[1] > scanY) || (b[1] <= scanY && a[1] > scanY)) {
          const dx = b[0] - a[0];
          const x = a[0] + (scanY - a[1]) * dx / (b[1] - a[1]);
          // A conservative roundoff bound for the six arithmetic operations
          // above (the interpolation parameter lies in [0, 1]). This scales
          // with coordinate precision, never with a pixel-sized margin.
          const error = 8 * Number.EPSILON * (Math.abs(a[0]) + Math.abs(dx));
          intersections.push({ x, error });
        }
      }
      intersections.sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        spans[y].push([intersections[i], intersections[i + 1]]);
      }
    }
  }
  // Union continuous coverage before sample ownership is rounded. Separately
  // quantizing opposite evaluations of a shared edge can exclude the same
  // sample from both pieces. Only roundoff-sized gaps are treated as touching;
  // exterior endpoints and genuine gaps retain their original coordinates.
  for (let y = 0; y < h; y++) {
    const row = spans[y].sort((a, b) => a[0].x - b[0].x);
    const fill = (a, b) => {
      const left = Math.max(0, Math.ceil(a.x - 0.5));
      const right = Math.min(w, Math.ceil(b.x - 0.5));
      if (right > left) raster.fill(0, y * w + left, y * w + right);
    };
    let left, right;
    for (const [a, b] of row) {
      if (right && a.x - right.x <= a.error + right.error) {
        if (b.x > right.x || (b.x === right.x && b.error > right.error)) right = b;
      } else {
        if (right) fill(left, right);
        [left, right] = [a, b];
      }
    }
    if (right) fill(left, right);
  }
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dy = 0; dy < supersample; dy++) for (let dx = 0; dx < supersample; dx++) sum += raster[(y * supersample + dy) * w + x * supersample + dx];
    pixels[y * width + x] = Math.round(sum / supersample ** 2);
  }
  return encodePng(width, height, pixels);
}

export function fitPolygons(polygons, { x = 0, y = 0, width, height, padding = 32, scale } = {}) {
  const all = polygons.flat(), xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  scale ??= Math.min((width - 2 * padding) / (maxX - minX), (height - 2 * padding) / (maxY - minY));
  return polygons.map(p => p.map(([px, py]) => [x + width / 2 + (px - (minX + maxX) / 2) * scale, y + height / 2 + (py - (minY + maxY) / 2) * scale]));
}

export function renderFigure(figure, { width = 400, height = 400, padding = 36, rotation = 0 } = {}) {
  const polygons = figure.pieces.map(p => transformPolygon(p.points, { rotation }));
  return renderPolygons(fitPolygons(polygons, { width, height, padding }), { width, height });
}
