import type { JevDecisionStageEvidence, RepairHistoryEntry } from './contract.ts';

export const BYPASS_ACCEPTANCE_V2_CANONICAL_JSON = '{"humanLedMoveOn":{"choice":"human_request","question":"human_move_on_source"},"policies":{"bypass-enabled":{"policy":"bypass_acceptance_v2:accept","vetoActions":[]},"repair-first":{"policy":"bypass_acceptance_v2:veto","vetoActions":["defer","move_on"]}},"version":"bypass_acceptance_v2"}';
export const BYPASS_ACCEPTANCE_V2_TABLE_SHA256 = '647aaa1ff240074bedcb41e0ecd42bf2aeffcf83dac9ad914cea3503a386564a';
export const MOVE_ON_SOURCE_QUESTION = 'human_move_on_source';
export const MOVE_ON_SOURCE_LABELS = Object.freeze(['human_request', 'other', 'unclear'] as const);

export function validMoveOnSource(choice: unknown, scores: unknown): boolean {
  if (typeof choice !== 'string' || !MOVE_ON_SOURCE_LABELS.some(label => label === choice) ||
      !scores || Object.getPrototypeOf(scores) !== Object.prototype) return false;
  const values = scores as Record<string, unknown>;
  return Object.keys(values).length === MOVE_ON_SOURCE_LABELS.length &&
    MOVE_ON_SOURCE_LABELS.every(key => {
      const score = values[key];
      return Object.hasOwn(values, key) && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1;
    });
}

export function isHumanMoveOnAnswer(stage: JevDecisionStageEvidence | undefined): boolean {
  return stage?.stage === 'action' && stage.choices.action === 'move_on' &&
    stage.choices[MOVE_ON_SOURCE_QUESTION] === 'human_request' &&
    validMoveOnSource(stage.choices[MOVE_ON_SOURCE_QUESTION], stage.scores[MOVE_ON_SOURCE_QUESTION]);
}

export type HumanMoveOnEvidence = { source: 'human'; publicTurn: number; openRepairTurns: number[] };

export function humanMoveOnEvidence(turn: number, history: readonly RepairHistoryEntry[]): HumanMoveOnEvidence {
  return { source: 'human', publicTurn: turn, openRepairTurns: history.filter(entry => entry.turn < turn).map(entry => entry.turn) };
}
