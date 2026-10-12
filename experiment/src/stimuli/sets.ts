import type { Stimulus, StimulusSet, StimulusSetId } from '../domain/types';
import { NORMALIZED_LAYOUTS, TAN_LAYOUTS } from './stimulus-data';

export { TAN_LAYOUTS };

/** Researcher-only neutral label: the shapes come from a seeded search, so no figurative meaning is claimed. */
function describe(index: number): string {
  const pts = NORMALIZED_LAYOUTS[index].flatMap((t) => t.polygon);
  const w = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
  const h = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
  const shape = w / h > 1.4 ? '横長' : w / h < 0.7 ? '縦長' : '中間';
  return `DEMO自作:探索生成シルエット#${index + 1}（${shape}・7片・妥当性未検証）`;
}

const makeSet = (id: StimulusSetId, offset: number): StimulusSet => ({
  id,
  label: id === 'alpha' ? 'DEMO α' : 'DEMO β',
  stimuli: NORMALIZED_LAYOUTS.slice(offset, offset + 6).map((pieces, index) => ({
    id: `${id}-${index + 1}`,
    setId: id,
    polygons: pieces.map((piece) => piece.polygon),
    researcherNote: describe(offset + index),
  })),
});

export const STIMULUS_SETS: Record<StimulusSetId, StimulusSet> = { alpha: makeSet('alpha', 0), beta: makeSet('beta', 6) };

const BY_ID = new Map(Object.values(STIMULUS_SETS).flatMap((set) => set.stimuli.map((s) => [s.id, s] as const)));

export function getStimulus(id: string): Stimulus {
  const item = BY_ID.get(id);
  if (!item) throw new Error(`Unknown stimulus: ${id}`);
  return item;
}
