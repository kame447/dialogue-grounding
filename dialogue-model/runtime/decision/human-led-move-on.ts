import type { JevDecisionStageEvidence, RepairHistoryEntry } from './contract.ts';

export const BYPASS_ACCEPTANCE_V2_CANONICAL_JSON = '{"humanLedMoveOn":{"choice":"human_request","question":"human_move_on_source"},"policies":{"bypass-enabled":{"policy":"bypass_acceptance_v2:accept","vetoActions":[]},"repair-first":{"policy":"bypass_acceptance_v2:veto","vetoActions":["defer","move_on"]}},"version":"bypass_acceptance_v2"}';
export const BYPASS_ACCEPTANCE_V2_TABLE_SHA256 = '647aaa1ff240074bedcb41e0ecd42bf2aeffcf83dac9ad914cea3503a386564a';
export const MOVE_ON_SOURCE_QUESTION = 'human_move_on_source';
export const MOVE_ON_SOURCE_LABELS = Object.freeze(['human_request', 'other', 'unclear'] as const);

export const ISSUE_HANDLING_MOVE_ON_INSTRUCTIONS = '今回の人間の公開発話と直前までの公開文脈から、話題の移行・保留・終了を誰が主導したか判定してください。図形の同定や名称の合意は問っていません。';
export const ISSUE_HANDLING_MOVE_ON_CRITERIA = Object.freeze({
  human_request: '今回の人間自身が、今の図形・論点から別の図形・論点に移ること、いまの問題をいったん置くこと、または対話を終えることを明示的に提案・要求した。直前のAIの相談（続けるか別の進め方にするかの問い）への返答として、人が移ること・終えることを選んだ場合を含む。直前のAIによる移行の誘いに相槌で同意しただけの場合は含まない。',
  other: '人からの明示の希望はない。単なる相槌、別の対象への言及、引用、AIからの移行の誘いへの同意もここに含む。',
  unclear: '人自身が求めたのか、公開文脈から一意に判断できない。',
});

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

export function humanMoveOnEvidence(turn: number, history: readonly Pick<RepairHistoryEntry, 'turn'>[]): HumanMoveOnEvidence {
  return { source: 'human', publicTurn: turn, openRepairTurns: history.filter(entry => entry.turn < turn).map(entry => entry.turn) };
}
