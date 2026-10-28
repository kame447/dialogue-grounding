import { createHash } from 'node:crypto';
import { FIGURES } from './figures.mjs';
import { boundarySegments, polygonArea, transformPolygon } from './geometry.mjs';
import { renderPolygons } from './render.mjs';

// Prototype presentation constants, not adopted experimental conditions.
export const BOARD_WIDTH = 1200;
export const BOARD_HEIGHT = 800;
const VERSION = 'tangram-prototype-v2';
const SCALE = 48;
const MARGIN = 32;
const GAP = 28;
const AXIS_SEPARATION = 36;
// relative_pm90: the AI side turns each figure a further ±90° (the original, and legacy-record, mode).
// relative_0: the AI side shows each figure at the same angle as the human side's same figure.
export const ROTATION_MODES = Object.freeze(['relative_pm90', 'relative_0']);

function digest(seed, scope) {
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be a safe integer');
  return createHash('sha256').update(`${VERSION}:${seed}:${scope}`).digest();
}

function randomSource(seed, scope) {
  let state = digest(seed, scope).readUInt32LE();
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function bbox(polygons) {
  const points = polygons.flat();
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Remove invisible piece boundaries before publishing browser hit geometry.
// Directed boundary loops retain their winding, including any holes.
function outlineLoops(polygons) {
  const edges = boundarySegments(polygons);
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const loops = [];
  while (edges.length) {
    const [start, firstEnd] = edges.pop();
    const loop = [start];
    let end = firstEnd;
    while (!same(end, start)) {
      loop.push(end);
      const next = edges.findIndex(([a]) => same(a, end));
      if (next < 0) throw new Error('Invalid silhouette boundary');
      end = edges.splice(next, 1)[0][1];
    }
    loops.push(loop);
  }
  return loops;
}

function areaCentroid(polygons) {
  let area = 0, x = 0, y = 0;
  for (const p of polygons) {
    let crossSum = 0, cx = 0, cy = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const cross = a[0] * b[1] - b[0] * a[1];
      crossSum += cross;
      cx += (a[0] + b[0]) * cross;
      cy += (a[1] + b[1]) * cross;
    }
    const weight = polygonArea(p);
    x += weight * cx / (3 * crossSum);
    y += weight * cy / (3 * crossSum);
    area += weight;
  }
  return { x: x / area, y: y / area };
}

const silhouettes = new Map(FIGURES.map(figure => [figure.id,
  Array.from({ length: 4 }, (_, turn) => {
    const rotated = figure.pieces.map(p => transformPolygon(p.points, { rotation: turn * 90 }));
    const box = bbox(rotated);
    const scaleAndCenter = polygons => polygons.map(p => p.map(([x, y]) => [
      (x - box.x - box.w / 2) * SCALE,
      (y - box.y - box.h / 2) * SCALE,
    ]));
    const polygons = scaleAndCenter(rotated);
    return { polygons, outlines: scaleAndCenter(outlineLoops(rotated)), bbox: bbox(polygons), centroid: areaCentroid(polygons) };
  }),
]));

// Reject wide row/column bands as well as exact alignment. No cell, ring,
// spatial slot order, or shrinking fallback is used to finish a difficult seed.
function looksAligned(entries) {
  return ['x', 'y'].some(axis => {
    const values = entries.map(p => p.center[axis]).sort((a, b) => a - b);
    const band = axis === 'x' ? BOARD_WIDTH * 0.1 : BOARD_HEIGHT * 0.12;
    if (values.some((v, i) => i + 3 < values.length && values[i + 3] - v <= band)) return true;
    return values[2] - values[0] <= band && values[5] - values[3] <= band;
  });
}

function boxesClear(a, b) {
  return a.x >= b.x + b.w + GAP || b.x >= a.x + a.w + GAP
    || a.y >= b.y + b.h + GAP || b.y >= a.y + a.h + GAP;
}

function placeSide(definitions, random, otherSide = []) {
  // Reorder independently of local IDs and source figures before placement.
  const order = shuffle(definitions, random);
  for (let attempt = 0; attempt < 256; attempt++) {
    const placed = [];
    for (const definition of order) {
      const shape = silhouettes.get(definition.figureId)[definition.rotation / 90];
      const w = shape.bbox.w, h = shape.bbox.h;
      const other = otherSide.find(p => p.figureId === definition.figureId);
      let accepted;
      for (let candidate = 0; candidate < 512; candidate++) {
        const x = MARGIN + Math.floor(random() * (BOARD_WIDTH - 2 * MARGIN - w + 1));
        const y = MARGIN + Math.floor(random() * (BOARD_HEIGHT - 2 * MARGIN - h + 1));
        const box = { x, y, w, h }, center = { x: x + w / 2, y: y + h / 2 };
        if (other && Math.hypot(center.x - other.center.x, center.y - other.center.y) < 96) continue;
        if (placed.some(p => !boxesClear(box, p.bbox)
          || Math.abs(center.x - p.center.x) < AXIS_SEPARATION
          || Math.abs(center.y - p.center.y) < AXIS_SEPARATION)) continue;
        const translate = polygons => polygons.map(p => p.map(([px, py]) => [px + center.x, py + center.y]));
        accepted = {
          ...definition, center, bbox: box,
          centroid: { x: shape.centroid.x + center.x, y: shape.centroid.y + center.y },
          polygons: translate(shape.polygons), outlines: translate(shape.outlines),
        };
        break;
      }
      if (!accepted) break;
      placed.push(accepted);
    }
    if (placed.length === 6 && !looksAligned(placed)) return shuffle(placed, random);
  }
  throw new Error('Unable to place scattered silhouettes within budget');
}

function localIds(seed, side, used) {
  const ids = [];
  // Collision resolution is deterministic, including across the two sides.
  for (let nonce = 0; ids.length < 6; nonce++) {
    const id = `s-${digest(seed, `${side}:id:${nonce}`).toString('hex').slice(0, 4)}`;
    if (!used.has(id)) { used.add(id); ids.push(id); }
  }
  return ids;
}

function rotationModeOf(rotationMode) {
  if (!ROTATION_MODES.includes(rotationMode)) throw new TypeError('unknown rotation mode');
  return rotationMode;
}

/** Researcher-only geometry and correspondence. Never send this to a participant/model. */
export function createLayoutsV2({ seed, rotationMode = 'relative_pm90' }) {
  digest(seed, 'validate');
  const mode = rotationModeOf(rotationMode);
  const used = new Set();
  const rotations = randomSource(seed, 'orientations');
  const humanRotations = new Map(FIGURES.map(f => [f.id, Math.floor(rotations() * 4) * 90]));
  const human = {}, ai = {};
  for (const [side, result] of [['human', human], ['ai', ai]]) {
    const ids = localIds(seed, side, used);
    const figures = shuffle(FIGURES, randomSource(seed, `${side}:identity`));
    result.definitions = figures.map((f, i) => ({
      id: ids[i], figureId: f.id,
      rotation: side === 'human' ? humanRotations.get(f.id) : aiRotation(humanRotations.get(f.id), rotations(), mode),
    }));
  }
  const humanLayout = placeSide(human.definitions, randomSource(seed, 'human:placement'));
  return {
    human: humanLayout,
    ai: placeSide(ai.definitions, randomSource(seed, 'ai:placement'), humanLayout),
  };
}

// The ±90° draw is consumed in both modes so every later draw keeps its position.
const aiRotation = (human, draw, mode) => mode === 'relative_0' ? human : (human + (draw < 0.5 ? 90 : 270)) % 360;

const pathOf = outlines => outlines.map(p => `M${p.map(([x, y]) => `${x},${y}`).join('L')}Z`).join('');
const sceneOf = layout => ({
  width: BOARD_WIDTH, height: BOARD_HEIGHT,
  shapes: layout.map(p => ({ id: p.id, path: pathOf(p.outlines), centroid: { ...p.centroid } })),
});

// Generation-time stimulus metadata, kept off the trial object so its relative_pm90 bytes stay unchanged.
const stimuli = new WeakMap();

/** Researcher-owned trial. Project it with participantView/modelView before sending it. */
export function createTrialV2({ seed, rotationMode = 'relative_pm90' }) {
  const mode = rotationModeOf(rotationMode);
  const layouts = createLayoutsV2({ seed, rotationMode: mode });
  const render = layout => renderPolygons(layout.flatMap(p => p.polygons), { width: BOARD_WIDTH, height: BOARD_HEIGHT });
  const trial = {
    version: 2,
    // relative_pm90 keeps its original id; other modes get an equally opaque id of their own.
    trialId: `${VERSION}-${digest(seed, mode === 'relative_pm90' ? 'trial' : `trial:${mode}`).toString('hex').slice(0, 16)}`,
    seed,
    human: { png: render(layouts.human), mimeType: 'image/png', scene: sceneOf(layouts.human) },
    ai: {
      png: render(layouts.ai), mimeType: 'image/png',
      anchors: layouts.ai.map(p => ({ id: p.id, bbox: { ...p.bbox }, centroid: { ...p.centroid } })),
    },
    key: Object.fromEntries(['human', 'ai'].map(side => [side,
      Object.fromEntries(layouts[side].map(p => [p.id, p.figureId])),
    ])),
  };
  stimuli.set(trial, { version: VERSION, rotationMode: mode, angles: Object.fromEntries(['human', 'ai'].map(side => [side,
    Object.fromEntries(layouts[side].map(p => [p.id, p.rotation])),
  ])) });
  return trial;
}

/**
 * Researcher-only: the version, rotation mode and per-slot angles this exact trial object was
 * generated with; null for anything createTrialV2 did not return (including copies).
 */
export function trialStimulusV2(trial) {
  const stimulus = trial !== null && typeof trial === 'object' ? stimuli.get(trial) : undefined;
  return stimulus ? structuredClone(stimulus) : null;
}

/** Human-only scene: no PNG of the opposite side, seed, or researcher key. */
export function participantView(trial) {
  const { width, height, shapes } = trial.human.scene;
  return { width, height, shapes: shapes.map(p => ({ id: p.id, path: p.path, centroid: { x: p.centroid.x, y: p.centroid.y } })) };
}

/** Model-only image and private local anchors. Never publish the anchors as labels. */
export function modelView(trial) {
  return {
    png: Buffer.from(trial.ai.png), mimeType: trial.ai.mimeType,
    anchors: trial.ai.anchors.map(p => ({
      id: p.id, bbox: { x: p.bbox.x, y: p.bbox.y, w: p.bbox.w, h: p.bbox.h },
      centroid: { x: p.centroid.x, y: p.centroid.y },
    })),
  };
}
