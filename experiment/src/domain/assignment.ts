import type { Assignment, SequenceId } from './types';

/**
 * Four counterbalanced sequences: condition order (AB/BA) crossed with
 * stimulus-set order (alpha/beta). Each participant sees each set exactly once.
 */
export const SEQUENCES: Record<SequenceId, Assignment> = {
  S1: { sequenceId: 'S1', blocks: [{ round: 1, condition: 'A', stimulusSet: 'alpha' }, { round: 2, condition: 'B', stimulusSet: 'beta' }] },
  S2: { sequenceId: 'S2', blocks: [{ round: 1, condition: 'B', stimulusSet: 'alpha' }, { round: 2, condition: 'A', stimulusSet: 'beta' }] },
  S3: { sequenceId: 'S3', blocks: [{ round: 1, condition: 'A', stimulusSet: 'beta' }, { round: 2, condition: 'B', stimulusSet: 'alpha' }] },
  S4: { sequenceId: 'S4', blocks: [{ round: 1, condition: 'B', stimulusSet: 'beta' }, { round: 2, condition: 'A', stimulusSet: 'alpha' }] },
};

export const SEQUENCE_IDS: SequenceId[] = ['S1', 'S2', 'S3', 'S4'];

/** Round-robin by participant index (0-based). Production must assign server-side. */
export function sequenceForIndex(index: number): SequenceId {
  const i = ((Math.floor(index) % 4) + 4) % 4;
  return SEQUENCE_IDS[i];
}

export function isValidAssignment(a: Assignment): boolean {
  const [b1, b2] = a.blocks;
  return b1.condition !== b2.condition && b1.stimulusSet !== b2.stimulusSet && b1.round === 1 && b2.round === 2;
}
