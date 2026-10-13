import { describe, expect, it } from 'vitest';
import { STIMULUS_SETS } from './sets';
import { SCENE, bounds, figureDistance, looksAligned, placeFigures, pointFigureDistance, sceneSvg, worldPolygons } from './scene';

const sets = Object.values(STIMULUS_SETS);

describe('scattered scene placement', () => {
  it('is deterministic per seed and seat, and differs between seats', () => {
    const polys = STIMULUS_SETS.alpha.stimuli.map((s) => s.polygons);
    expect(placeFigures(polys, 42, 'human')).toEqual(placeFigures(polys, 42, 'human'));
    const human = placeFigures(polys, 42, 'human');
    const ai = placeFigures(polys, 42, 'ai');
    expect(human.filter((p, i) => p.rotation !== ai[i].rotation).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps every figure inside the scene, apart from the others, irregular and fast (bounded sweep)', () => {
    const started = performance.now();
    let worst = 0;
    // Time-boxed sweep: 100 seeds × 2 sets × 2 seats.
    for (let seed = 0; seed < 100; seed++) for (const set of sets) for (const seat of ['human', 'ai']) {
      const t = performance.now();
      const placements = placeFigures(set.stimuli.map((s) => s.polygons), seed * 7919 + 1, seat);
      worst = Math.max(worst, performance.now() - t);
      const world = set.stimuli.map((s, i) => worldPolygons({ polygons: s.polygons, placement: placements[i] }));
      for (let i = 0; i < 6; i++) {
        const b = bounds(world[i]);
        expect(b.minX).toBeGreaterThanOrEqual(0);
        expect(b.minY).toBeGreaterThanOrEqual(0);
        expect(b.maxX).toBeLessThanOrEqual(SCENE.width);
        expect(b.maxY).toBeLessThanOrEqual(SCENE.height);
        // Legible size: the longer side spans at least ~15% of the scene width.
        expect(Math.max(b.maxX - b.minX, b.maxY - b.minY)).toBeGreaterThan(SCENE.width * 0.15);
        for (let j = i + 1; j < 6; j++) expect(figureDistance(world[i], world[j])).toBeGreaterThan(10);
        for (let j = 0; j < 6; j++) if (j !== i) expect(pointFigureDistance([placements[i].x, placements[i].y], world[j])).toBeGreaterThan(10);
      }
      const centres = placements.map((p) => [p.x, p.y] as [number, number]);
      expect(looksAligned(centres)).toBe(false);
      expect(new Set(centres.map(([, y]) => Math.round(y / 30))).size).toBeGreaterThan(1);
      expect(new Set(centres.map(([x]) => Math.round(x / 40))).size).toBeGreaterThan(1);
      if (performance.now() - started > 20_000) throw new Error('placement sweep exceeded its time box');
    }
    expect(worst).toBeLessThan(250);
  });

  it('flags grid-like arrangements', () => {
    expect(looksAligned([[60, 80], [200, 80], [340, 80], [60, 220], [200, 220], [340, 220]])).toBe(true);
    expect(looksAligned([[60, 40], [70, 110], [65, 180], [75, 250], [250, 90], [320, 200]])).toBe(true);
    expect(looksAligned([[70, 60], [210, 40], [330, 120], [120, 170], [250, 200], [60, 260]])).toBe(false);
  });

  it('renders one seat scene as a standalone SVG from the same contract', () => {
    const set = STIMULUS_SETS.beta;
    const placements = placeFigures(set.stimuli.map((s) => s.polygons), 7, 'ai');
    const svg = sceneSvg(set.stimuli.map((s, i) => ({ polygons: s.polygons, placement: placements[i] })));
    expect(svg.match(/<path /g)).toHaveLength(6);
    expect(svg).toContain(`viewBox="0 0 ${SCENE.width} ${SCENE.height}"`);
    expect(svg).not.toMatch(/beta-|alpha-|<text/);
  });
});
