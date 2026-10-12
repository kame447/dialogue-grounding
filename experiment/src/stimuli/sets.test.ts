import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STIMULUS_SETS, TAN_LAYOUTS, getStimulus } from './sets';
import { StimulusSvg } from './StimulusSvg';

function area(poly: ReadonlyArray<readonly [number, number]>): number {
  return Math.abs(poly.reduce((sum, [x, y], i) => {
    const [nx, ny] = poly[(i + 1) % poly.length];
    return sum + x * ny - nx * y;
  }, 0)) / 2;
}

function signature(polygons: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): string {
  const points = polygons.flat();
  const minX = Math.min(...points.map(([x]) => x)); const maxX = Math.max(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y)); const maxY = Math.max(...points.map(([, y]) => y));
  const aspect = ((maxX - minX) / (maxY - minY)).toFixed(2);
  const vertices = points.map(([x, y]) => `${((x - minX) / (maxX - minX)).toFixed(2)},${((y - minY) / (maxY - minY)).toFixed(2)}`).sort().join(';');
  return `${aspect}|${vertices}`;
}


function edgeAdjacent(a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const [ax, ay] = a[i], [bx, by] = a[(i + 1) % a.length];
    const [cx, cy] = b[j], [dx, dy] = b[(j + 1) % b.length];
    const cross1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const cross2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    if (Math.abs(cross1) > 1e-6 || Math.abs(cross2) > 1e-6) continue;
    const length = Math.hypot(bx - ax, by - ay);
    const t1 = ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / (length * length);
    const t2 = ((dx - ax) * (bx - ax) + (dy - ay) * (by - ay)) / (length * length);
    if ((Math.min(1, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2))) * length >= 0.5 - 1e-6) return true;
  }
  return false;
}

function strictlyInside(point: readonly [number, number], poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}


function raster(polygons: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): boolean[] {
  const points = polygons.flat();
  const minX = Math.min(...points.map(([x]) => x)), maxX = Math.max(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y)), maxY = Math.max(...points.map(([, y]) => y));
  const scale = 44 / Math.max(maxX - minX, maxY - minY);
  const ox = (48 - (maxX - minX) * scale) / 2, oy = (48 - (maxY - minY) * scale) / 2;
  const mask = Array<boolean>(48 * 48).fill(false);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const p: readonly [number, number] = [minX + (x + 0.5 - ox) / scale, minY + (y + 0.5 - oy) / scale];
    mask[y * 48 + x] = polygons.some((poly) => strictlyInside(p, poly));
  }
  return mask;
}
function transformMask(mask: boolean[], rotation: number, mirror: boolean): boolean[] {
  const out = Array<boolean>(48 * 48).fill(false);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (mask[y * 48 + x]) {
    let xx = mirror ? 47 - x : x, yy = y;
    if (rotation === 90) [xx, yy] = [47 - yy, xx];
    else if (rotation === 180) [xx, yy] = [47 - xx, 47 - yy];
    else if (rotation === 270) [xx, yy] = [yy, 47 - xx];
    out[yy * 48 + xx] = true;
  }
  return out;
}
function maxIou(a: boolean[], b: boolean[]): number {
  let best = 0;
  for (const mirror of [false, true]) for (const rotation of [0, 90, 180, 270]) {
    const transformed = transformMask(b, rotation, mirror);
    let intersection = 0, union = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] && transformed[i]) intersection++; if (a[i] || transformed[i]) union++; }
    best = Math.max(best, intersection / union);
  }
  return best;
}

describe('DEMO stimulus sets', () => {
  it('contains six uniquely identified seven-tan silhouettes per set with bounded coordinates', () => {
    const all = Object.values(STIMULUS_SETS).flatMap((set) => {
      expect(set.stimuli).toHaveLength(6);
      return set.stimuli;
    });
    expect(new Set(all.map((stimulus) => stimulus.id)).size).toBe(12);
    for (const stimulus of all) {
      expect(stimulus.polygons).toHaveLength(7);
      const areas = stimulus.polygons.map(area).sort((a, b) => a - b);
      const unit = areas[0];
      expect(areas.map((value) => Math.round(value / unit))).toEqual([1, 1, 2, 2, 2, 4, 4]);
      expect(stimulus.researcherNote.startsWith('DEMO自作:')).toBe(true);
      for (const polygon of stimulus.polygons) for (const [x, y] of polygon) {
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(100);
        expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(100);
      }
    }
    const signatures = all.map((stimulus) => signature(stimulus.polygons));
    expect(new Set(signatures).size).toBe(12);
    expect(() => getStimulus('unknown')).toThrow();
  });

  it('keeps all normalized silhouettes measurably distinct and varies aspect ratios', () => {
    const all = Object.values(STIMULUS_SETS).flatMap((set) => set.stimuli);
    const masks = all.map((stimulus) => raster(stimulus.polygons));
    let maximum = 0;
    for (let i = 0; i < masks.length; i++) for (let j = i + 1; j < masks.length; j++) maximum = Math.max(maximum, maxIou(masks[i], masks[j]));
    expect(maximum).toBeLessThan(0.55);
    for (const set of Object.values(STIMULUS_SETS)) {
      const aspects = set.stimuli.map((stimulus) => {
        const points = stimulus.polygons.flat();
        return (Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x))) / (Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y)));
      });
      expect(aspects.filter((aspect) => aspect > 1.4).length, JSON.stringify(aspects)).toBeGreaterThanOrEqual(2);
      expect(aspects.filter((aspect) => aspect < 0.7).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('connects all seven tans by shared edges and has no sampled overlaps', () => {
    for (const layout of TAN_LAYOUTS) {
      expect(layout).toHaveLength(7);
      const visited = new Set([0]);
      while (true) {
        const before = visited.size;
        for (let i = 0; i < layout.length; i++) for (let j = 0; j < layout.length; j++) {
          if (visited.has(i) && !visited.has(j) && edgeAdjacent(layout[i].polygon, layout[j].polygon)) visited.add(j);
        }
        if (visited.size === before) break;
      }
      expect(visited.size).toBe(7);

      const points = layout.flatMap((piece) => piece.polygon);
      const minX = Math.min(...points.map(([x]) => x)), maxX = Math.max(...points.map(([x]) => x));
      const minY = Math.min(...points.map(([, y]) => y)), maxY = Math.max(...points.map(([, y]) => y));
      for (let ix = 0; ix < 200; ix++) for (let iy = 0; iy < 200; iy++) {
        const point = [minX + (ix + 0.5) * (maxX - minX) / 200, minY + (iy + 0.5) * (maxY - minY) / 200] as const;
        expect(layout.filter((piece) => strictlyInside(point, piece.polygon)).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('renders an accessible SVG without scoring ids or researcher notes', () => {
    const stimulus = getStimulus('alpha-1');
    const markup = renderToStaticMarkup(createElement(StimulusSvg, { stimulus, label: '図形' }));
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="図形"');
    expect(markup).toContain('viewBox="0 0 100 100"');
    expect(markup).not.toContain(stimulus.id);
    expect(markup).not.toContain(stimulus.researcherNote);
  });
});
