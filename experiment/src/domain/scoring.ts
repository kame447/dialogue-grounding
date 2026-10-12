import { normalizeName } from './names';
import type { BlockState } from './types';

export interface ScoredPair {
  stimulusId: string;
  humanSlot: number;
  partnerSlot: number;
  humanName: string | null;
  partnerName: string | null;
  match: boolean;
}

/**
 * Raw, per-stimulus comparison of the two independent submissions.
 * A stimulus counts as matched when both sides gave the same (normalised) name
 * for that same stimulus. Duplicate names are prevented before locking, so they
 * are not scored here. This is a DEMO preview, not a research result.
 */
export function scoreBlock(block: BlockState): { pairs: ScoredPair[]; matched: number; complete: boolean } {
  const pairs = block.layout.human.map((stimulusId, humanSlot) => {
    const humanName = block.humanNames?.[stimulusId] ?? null;
    const partnerName = block.partnerNames?.[stimulusId] ?? null;
    return {
      stimulusId,
      humanSlot,
      partnerSlot: block.layout.partner.indexOf(stimulusId),
      humanName,
      partnerName,
      match: humanName !== null && partnerName !== null && normalizeName(humanName) === normalizeName(partnerName),
    };
  });
  return { pairs, matched: pairs.filter((p) => p.match).length, complete: block.humanNames !== null && block.partnerNames !== null };
}
