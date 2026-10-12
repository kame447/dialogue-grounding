import { describe, expect, it } from 'vitest';
import { createLayout, createRng } from './layout';
import { STIMULUS_SETS } from './sets';

describe('stimulus layout', () => {
  it('is deterministic and partner layout is a derangement', () => {
    const first = createLayout(STIMULUS_SETS.alpha, createRng(2026));
    const second = createLayout(STIMULUS_SETS.alpha, createRng(2026));
    expect(first).toEqual(second);
    expect(first.human).toHaveLength(6);
    expect(new Set(first.human)).toEqual(new Set(first.partner));
    expect(first.partner.every((id, slot) => id !== first.human[slot])).toBe(true);
  });
});
