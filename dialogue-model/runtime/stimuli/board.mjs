import { createHash } from 'node:crypto';
import { FIGURES } from './figures.mjs';
import { transformPolygon } from './geometry.mjs';
import { fitPolygons, renderPolygons } from './render.mjs';

export const SLOTS = Object.freeze(['上段左', '上段中', '上段右', '下段左', '下段中', '下段右']);
export const BOARD_WIDTH = 1200;
export const BOARD_HEIGHT = 800;
const VERSION = 'tangram-prototype-v1';

function seedHash(seed) {
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be a safe integer');
  return createHash('sha256').update(`${VERSION}:${seed}`).digest();
}
function randomSource(seed) {
  let state = seedHash(seed).readUInt32LE();
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle(array, random) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Research-side layout only. Never include this or key in a model request.
export function createLayouts({ seed }) {
  const random = randomSource(seed);
  const humanIds = shuffle(FIGURES.map(f => f.id), random);
  let aiIds;
  // Rejection sampling avoids a predictable cyclic relation between boards.
  for (let attempt = 0; attempt < 64; attempt++) {
    aiIds = shuffle(humanIds, random);
    if (aiIds.every((id, i) => id !== humanIds[i])) break;
  }
  // Bounded fallback still guarantees a different location for every figure.
  if (aiIds.some((id, i) => id === humanIds[i])) aiIds = humanIds.slice(1).concat(humanIds[0]);
  const rotations = Object.fromEntries(humanIds.map(id => [id, Math.floor(random() * 4) * 90]));
  return {
    human: humanIds.map((figureId, i) => ({ slot: SLOTS[i], figureId, rotation: rotations[figureId] })),
    ai: aiIds.map((figureId, i) => ({ slot: SLOTS[i], figureId, rotation: (rotations[figureId] + (1 + Math.floor(random() * 3)) * 90) % 360 })),
  };
}

function renderBoard(layout) {
  // One common scale for both boards and all figures preserves equal area.
  const extent = Math.max(...FIGURES.flatMap(f => {
    const all = f.pieces.flatMap(p => p.points);
    return [Math.max(...all.map(p => p[0])) - Math.min(...all.map(p => p[0])), Math.max(...all.map(p => p[1])) - Math.min(...all.map(p => p[1]))];
  }));
  const scale = 312 / extent;
  const polygons = layout.flatMap(({ figureId, rotation }, i) => {
    const figure = FIGURES.find(f => f.id === figureId);
    return fitPolygons(figure.pieces.map(p => transformPolygon(p.points, { rotation })), {
      x: (i % 3) * 400, y: Math.floor(i / 3) * 400, width: 400, height: 400, scale,
    });
  });
  return renderPolygons(polygons, { width: BOARD_WIDTH, height: BOARD_HEIGHT });
}

export function createTrial({ seed }) {
  const layouts = createLayouts({ seed });
  return {
    trialId: `${VERSION}-${seedHash(seed).toString('hex').slice(0, 16)}`,
    seed,
    human: { png: renderBoard(layouts.human), mimeType: 'image/png' },
    ai: { png: renderBoard(layouts.ai), mimeType: 'image/png' },
    key: Object.fromEntries(['human', 'ai'].map(side => [side, Object.fromEntries(layouts[side].map(({ slot, figureId }) => [slot, figureId]))])),
  };
}
