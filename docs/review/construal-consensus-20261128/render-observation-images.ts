// Observation images for the 120 orientation construal consensus (2026-11-28).
// Reads geometry only (outlines, centroid, area, shape name, contacts); the
// catalog's construal text is never read or written here, so the images and
// facts cannot anchor observers on earlier drafts.
//
//   node docs/review/construal-consensus-20261128/render-observation-images.ts <outDir>
//
// Outputs (outDir must not exist yet):
//   single/<figure>@<rotation>/{silhouette,regions}.png  480x480, one orientation
//   opus/sNN-silhouettes.png, opus/sNN-regions.png       1200x800, six orientations
//   opus/facts.json, opus/mapping.json                   sheet/position -> facts / id
//   terra-{a,b,c,d}/item-NN-{silhouette,regions}.png, terra-*/items.json
//   terra-mapping.json, manifest.json
// The silhouette is drawn by the experiment renderer (render.mjs): black on a
// white background without internal boundaries. Region images colour the
// user-confirmed primary regions, separate them with white lines on internal
// boundaries only, and label them P1..Pn at the stored centroid.
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIMARY_REGION_TEMPLATES, PRIMARY_REGION_CATALOG_REVISION } from '../../../dialogue-model/runtime/stimuli/primary-regions-data.ts';
import { renderPolygons } from '../../../dialogue-model/runtime/stimuli/render.mjs';

type Point = [number, number];
type Part = { id: string; outlines: Point[][]; centroid: Point; shapeName: string; areaPercent: number; bbox: number[]; tipDirection?: string; contacts: { part: string; direction: string; relation: string }[] };
type Template = { figureId: string; rotation: number; size: [number, number]; regions: Part[] };

const outDir = process.argv[2];
if (!outDir) throw Error('usage: render-observation-images.ts <outDir>');
if (existsSync(outDir)) throw Error('output directory already exists: ' + outDir);

const COLORS = ['#80aacd', '#d9b16c', '#80b7a1', '#ad95c5', '#e18c88'];
const LABEL = '#152433';
const MAX_EXTENT = 540;
const SEED = 20261128;
const templates = (PRIMARY_REGION_TEMPLATES as unknown as Template[]).map(t => ({
  id: t.figureId + '@' + t.rotation, figureId: t.figureId, rotation: t.rotation, size: t.size,
  parts: t.regions.map(p => ({ id: p.id, outlines: p.outlines, centroid: p.centroid, shapeName: p.shapeName, areaPercent: p.areaPercent, bbox: p.bbox, tipDirection: p.tipDirection, contacts: p.contacts })),
}));
if (templates.length !== 120) throw Error('expected 120 orientations');
if (Math.max(...templates.flatMap(t => t.size)) > MAX_EXTENT) throw Error('figure larger than the common scale');
type Item = (typeof templates)[number];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const random = rng(SEED);
function shuffle<T>(values: T[]): T[] {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
function encodeRgb(width: number, height: number, rgb: Uint8Array) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));

// Placement of one orientation inside a square cell, at a scale common to all figures.
function place(t: Item, cellX: number, cellY: number, cell: number, pad: number) {
  const s = (cell - 2 * pad) / MAX_EXTENT;
  const ox = cellX + (cell - t.size[0] * s) / 2, oy = cellY + (cell - t.size[1] * s) / 2;
  return (p: Point): Point => [ox + p[0] * s, oy + p[1] * s];
}

function fillLoops(label: Int8Array, w: number, h: number, loops: Point[][], value: number) {
  const ys = loops.flat().map(p => p[1]);
  const y0 = Math.max(0, Math.ceil(Math.min(...ys) - 0.5)), y1 = Math.min(h - 1, Math.floor(Math.max(...ys) - 0.5));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5, xs: number[] = [];
    for (const loop of loops) for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) xs.push(a[0] + (sy - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const l = Math.max(0, Math.ceil(xs[k] - 0.5)), r = Math.min(w, Math.ceil(xs[k + 1] - 0.5));
      if (r > l) label.fill(value, y * w + l, y * w + r);
    }
  }
}

// Square dilation of a mask by radius r, computed with per-row and per-column prefix sums.
function dilate(mask: Uint8Array, w: number, h: number, r: number) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), prefix = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + mask[y * w + x];
    for (let x = 0; x < w; x++) if (prefix[Math.min(w, x + r + 1)] - prefix[Math.max(0, x - r)] > 0) tmp[y * w + x] = 1;
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) prefix[y + 1] = prefix[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) if (prefix[Math.min(h, y + r + 1)] - prefix[Math.max(0, y - r)] > 0) out[y * w + x] = 1;
  }
  return out;
}

const FONT: Record<string, string[]> = {
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
function drawText(rgb: Uint8Array, w: number, h: number, text: string, cx: number, cy: number, scale: number, color: string, halo: number, anchor: 'center' | 'topleft' = 'center') {
  const tw = text.length * 5 * scale + (text.length - 1) * scale, th = 7 * scale;
  const left = Math.round(anchor === 'center' ? cx - tw / 2 : cx), top = Math.round(anchor === 'center' ? cy - th / 2 : cy);
  const on: Point[] = [];
  [...text].forEach((ch, i) => FONT[ch].forEach((row, gy) => [...row].forEach((bit, gx) => {
    if (bit !== '1') return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) on.push([left + i * 6 * scale + gx * scale + dx, top + gy * scale + dy]);
  })));
  const paint = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= w || y >= h) return; rgb.set(c, (y * w + x) * 3); };
  if (halo > 0) for (const [x, y] of on) for (let dy = -halo; dy <= halo; dy++) for (let dx = -halo; dx <= halo; dx++) paint(x + dx, y + dy, [255, 255, 255]);
  for (const [x, y] of on) paint(x, y, hex(color));
}

// Colour image of the primary regions for one or more placed orientations.
function renderRegions(width: number, height: number, cells: { item: Item; cellX: number; cellY: number; cell: number; pad: number; number?: string }[]) {
  const ss = 4, w = width * ss, h = height * ss, label = new Int8Array(w * h).fill(-1);
  for (const c of cells) {
    const at = place(c.item, c.cellX, c.cellY, c.cell, c.pad);
    c.item.parts.forEach((p, i) => fillLoops(label, w, h, p.outlines.map(loop => loop.map(q => { const [x, y] = at(q); return [x * ss, y * ss] as Point; })), i));
  }
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = label[i];
    if (a < 0) continue;
    if (x + 1 < w && label[i + 1] >= 0 && label[i + 1] !== a) { edge[i] = 1; edge[i + 1] = 1; }
    if (y + 1 < h && label[i + w] >= 0 && label[i + w] !== a) { edge[i] = 1; edge[i + w] = 1; }
  }
  const line = dilate(edge, w, h, Math.round(1.2 * ss));
  const palette = COLORS.map(hex), rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0];
    for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) {
      const i = (y * ss + dy) * w + x * ss + dx, a = label[i];
      const c = a < 0 || line[i] ? [255, 255, 255] : palette[a];
      sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
    }
    rgb.set(sum.map(v => Math.round(v / (ss * ss))), (y * width + x) * 3);
  }
  for (const c of cells) {
    const at = place(c.item, c.cellX, c.cellY, c.cell, c.pad);
    for (const p of c.item.parts) { const [x, y] = at(p.centroid); drawText(rgb, width, height, p.id, x, y, c.cell >= 480 ? 3 : 2, LABEL, 2); }
    if (c.number) drawText(rgb, width, height, c.number, c.cellX + 10, c.cellY + 10, 3, '#8a96a3', 0, 'topleft');
  }
  return encodeRgb(width, height, rgb);
}

function renderSilhouette(width: number, height: number, cells: { item: Item; cellX: number; cellY: number; cell: number; pad: number }[]) {
  const polygons = cells.flatMap(c => { const at = place(c.item, c.cellX, c.cellY, c.cell, c.pad); return c.item.parts.flatMap(p => p.outlines.map(loop => loop.map(at))); });
  return renderPolygons(polygons, { width, height, supersample: 2 }) as Buffer;
}

// Geometric facts that are fixed by the confirmed partition; no construal text.
function facts(t: Item) {
  return {
    aspect: { width: t.size[0], height: t.size[1] },
    parts: t.parts.map(p => ({
      id: p.id, shapeName: p.shapeName, areaPercent: p.areaPercent,
      widthPercent: Math.round(p.bbox[2] / t.size[0] * 100), heightPercent: Math.round(p.bbox[3] / t.size[1] * 100),
      centroidPercent: [Math.round(p.centroid[0] / t.size[0] * 100), Math.round(p.centroid[1] / t.size[1] * 100)],
      ...(p.tipDirection ? { tipDirection: p.tipDirection } : {}),
      contacts: p.contacts.map(c => ({ part: c.part, direction: c.direction, relation: c.relation })),
    })),
  };
}

const files: Record<string, string> = {};
function save(rel: string, data: Buffer | string) {
  const path = join(outDir, rel);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  files[rel] = createHash('sha256').update(data).digest('hex');
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

mkdirSync(outDir, { recursive: true, mode: 0o700 });
for (const t of templates) {
  const cell = [{ item: t, cellX: 0, cellY: 0, cell: 480, pad: 36 }];
  save(`single/${t.id}/silhouette.png`, renderSilhouette(480, 480, cell));
  save(`single/${t.id}/regions.png`, renderRegions(480, 480, cell));
}

// Opus sheets: four passes of five sheets; each pass holds every figure once in a random
// orientation and order, and two orientations of one figure are never on the same or
// neighbouring sheets.
const figureIds = [...new Set(templates.map(t => t.figureId))];
const passRotation = new Map(figureIds.map(f => [f, shuffle([0, 90, 180, 270])]));
const order: Item[] = [];
let previous: Map<string, number> | null = null;
for (let pass = 0; pass < 4; pass++) {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 10000) throw Error('could not build a spread order');
    const permutation = shuffle(figureIds), offset = new Map(permutation.map((f, i) => [f, Math.floor(i / 6)]));
    const last = previous;
    if (last && !figureIds.every(f => 5 + offset.get(f)! - last.get(f)! >= 2)) continue;
    order.push(...permutation.map(f => templates.find(t => t.figureId === f && t.rotation === passRotation.get(f)![pass])!));
    previous = offset;
    break;
  }
}
const opusMapping: Record<string, string> = {}, opusFacts: Record<string, unknown> = {};
for (let s = 0; s < 20; s++) {
  const sheet = 's' + String(s + 1).padStart(2, '0');
  const cells = order.slice(s * 6, s * 6 + 6).map((item, k) => ({ item, cellX: (k % 3) * 400, cellY: Math.floor(k / 3) * 400, cell: 400, pad: 32, number: String(k + 1) }));
  save(`opus/${sheet}-silhouettes.png`, renderSilhouette(1200, 800, cells));
  save(`opus/${sheet}-regions.png`, renderRegions(1200, 800, cells));
  cells.forEach((c, k) => { opusMapping[sheet + '-' + (k + 1)] = c.item.id; opusFacts[sheet + '-' + (k + 1)] = facts(c.item); });
}
save('opus/mapping.json', json(opusMapping));
save('opus/facts.json', json(opusFacts));

// Terra folders: one rotation per folder, so a Terra observer sees each figure once; items are shuffled.
const rotations = shuffle([0, 90, 180, 270]);
const terraMapping: Record<string, Record<string, string>> = {};
['a', 'b', 'c', 'd'].forEach((name, k) => {
  const items = shuffle(templates.filter(t => t.rotation === rotations[k]));
  const folder = 'terra-' + name, mapping: Record<string, string> = {}, list: unknown[] = [];
  items.forEach((t, i) => {
    const item = 'item-' + String(i + 1).padStart(2, '0'), cell = [{ item: t, cellX: 0, cellY: 0, cell: 480, pad: 36 }];
    save(`${folder}/${item}-silhouette.png`, renderSilhouette(480, 480, cell));
    save(`${folder}/${item}-regions.png`, renderRegions(480, 480, cell));
    mapping[item] = t.id; list.push({ item, silhouette: `${item}-silhouette.png`, regions: `${item}-regions.png`, ...facts(t) });
  });
  save(`${folder}/items.json`, json(list));
  terraMapping[folder] = mapping;
});
save('terra-mapping.json', json(terraMapping));
save('manifest.json', json({
  schemaVersion: 'construal_observation_images_v1', catalogRevision: PRIMARY_REGION_CATALOG_REVISION, seed: SEED,
  orientations: templates.length, commonScale: { maxExtent: MAX_EXTENT, singleCell: 480, singlePad: 36, sheetCell: 400, sheetPad: 32 },
  colors: COLORS, silhouetteRenderer: 'dialogue-model/runtime/stimuli/render.mjs renderPolygons (supersample 2)', files,
}));
console.log(JSON.stringify({ outDir, images: Object.keys(files).filter(f => f.endsWith('.png')).length, files: Object.keys(files).length }));
