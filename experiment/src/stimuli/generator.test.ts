import { describe, expect, it } from 'vitest';
import { NORMALIZED_LAYOUTS as GENERATED } from './generator';
import { NORMALIZED_LAYOUTS as BAKED } from './stimulus-data';

describe('baked stimulus data', () => {
  it('matches a fresh run of the offline generator', () => {
    const round = (v: number) => Math.round(v * 1e4) / 1e4;
    const simplify = (layouts: typeof BAKED) => layouts.map((l) => l.map((t) => ({ kind: t.kind, polygon: t.polygon.map(([x, y]) => [round(x), round(y)]) })));
    expect(simplify(GENERATED as typeof BAKED)).toEqual(simplify(BAKED));
  }, 60_000);
});
