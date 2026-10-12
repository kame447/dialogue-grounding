import type { BlockLayout, StimulusSet } from '../domain/types';

/** Seedable mulberry32 pseudo-random number generator. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createLayout(set: StimulusSet, rng: () => number): BlockLayout {
  const ids = set.stimuli.map((stimulus) => stimulus.id);
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error('Stimulus set must contain at least two unique ids');
  const human = shuffle(ids, rng);
  const shuffled = shuffle(ids, rng);
  // A cyclic shift of a permutation always gives a derangement; try a random shift.
  const shift = 1 + Math.floor(rng() * (ids.length - 1));
  const partner = Array.from({ length: ids.length }, (_, i) => shuffled[(i + shift) % ids.length]);
  // Derange against the human layout even though the independently shuffled cycle is already distinct internally.
  for (let i = 0; i < ids.length; i += 1) {
    if (partner[i] === human[i]) {
      const j = (i + 1) % ids.length;
      [partner[i], partner[j]] = [partner[j], partner[i]];
    }
  }
  if (partner.some((id, i) => id === human[i])) {
    const offset = 1;
    const rotated = human.map((_, i) => human[(i + offset) % human.length]);
    for (let i = 0; i < partner.length; i += 1) if (rotated[i] === human[i]) throw new Error('Unable to create derangement');
    return { human, partner: rotated };
  }
  return { human, partner };
}
