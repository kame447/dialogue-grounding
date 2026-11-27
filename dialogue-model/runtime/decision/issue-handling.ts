import { visualPurposeMatchesSource } from './contract.ts';
import type { JevDecision, JevExecutedDecision, JevPriorAction, JevTarget, JevVisualPurpose, RepairHistoryEntry, RepairProspectMaterial } from './contract.ts';
import { humanMoveOnEvidence, MOVE_ON_SOURCE_QUESTION, validMoveOnSource } from './human-led-move-on.ts';
import type { HumanMoveOnEvidence } from './human-led-move-on.ts';
import type { LocalClaimView } from '../local-grounding/contract.ts';

export const ISSUE_HANDLING_VERSION = 'jev_issue_handling_v1';
export const BYPASS_ACCEPTANCE_V3_VERSION = 'bypass_acceptance_v3';
export const BYPASS_ACCEPTANCE_V3_CANONICAL_JSON = '{"alternative":{"labels":["confirm","repair","consult"],"question":"non_bypass_alternative","stage":"detail"},"anchor":"issue_handling_anchor_v1","extras":{"alternativeQuestion":"extra_alt","dropOnRejectedMove":true,"handlings":["confirm","repair","hold_open"],"question":"extra","stage":"extras"},"humanLed":{"choice":"human_request","question":"human_move_on_source"},"policies":{"bypass-enabled":{"policy":"bypass_acceptance_v3:accept","vetoHandlings":[]},"repair-first":{"policy":"bypass_acceptance_v3:veto","vetoHandlings":["hold_open","carry_over"]}},"switchFunction":{"choice":"secure_progress","question":"switch_function","retypes":{"revisit":"carry_over"}},"version":"bypass_acceptance_v3"}';
export const BYPASS_ACCEPTANCE_V3_TABLE_SHA256 = 'f73ca8d09ee097721d43f8b71764faa5e65dd2596a9badffe55860081973dc2b';
export const issueHandlingReference = Object.freeze({ version: BYPASS_ACCEPTANCE_V3_VERSION, tableSha256: BYPASS_ACCEPTANCE_V3_TABLE_SHA256 });

export const JEV_ACTIONS_V21 = Object.freeze(['accept', 'propose_name', 'confirm', 'repair', 'hold_open', 'revisit',
  'agree', 'carry_over', 'consult', 'close', 'request_observation'] as const);
export type JevActionV21 = typeof JEV_ACTIONS_V21[number];
export type JevIssueRef = JevVisualPurpose;
export type CarryDestination =
  | { kind: 'partner_choice' | 'same_figure_naming' | 'same_figure_other_issue' }
  | { kind: 'other_figure'; figureId: string }
  | { kind: 'old_issue'; issue: JevIssueRef; targets: string[] };

export const NON_BYPASS_ALTERNATIVES = Object.freeze(['confirm', 'repair', 'consult'] as const);
export const SWITCH_FUNCTIONS = Object.freeze(['resolve_old_issue', 'secure_progress', 'unclear'] as const);
export const COMMITMENT_STATES = Object.freeze(['not_due', 'supported', 'conflicting', 'insufficient', 'unclear'] as const);
export type NonBypassAlternative = typeof NON_BYPASS_ALTERNATIVES[number];
export type SwitchFunction = typeof SWITCH_FUNCTIONS[number];
export type CommitmentState = typeof COMMITMENT_STATES[number];
export type ExtraHandling = 'confirm' | 'repair' | 'hold_open';
export type BoundIssueRef = Extract<JevIssueRef, { kind: 'resolve_issue' }>;
type ExtraBase = { target: JevTarget; name: null; feature: null; observe: null };
export type ExecutedExtra = ExtraBase & (
  | { action: 'confirm' | 'repair'; visualPurpose: BoundIssueRef; detailFigureIds: [] }
  | { action: 'hold_open' | 'consult'; issue: BoundIssueRef }
);
export type ExtraSelection = { index: number; original: ExecutedExtra };
export type ExtraTrace = ExtraSelection & {
  handling: { class: 'hold_open' | 'other'; initiator: 'ai' | null; anchor: HandlingAnchor | null; alternative: NonBypassAlternative | null };
  disposition: 'adopted' | 'rejected' | 'dropped';
  reasonCode: 'no_intervention' | 'not_in_veto_set' | 'vetoed_issue_handling' | 'primary_move_rejected';
  executed: ExecutedExtra | null;
};
export type ExecutedDecisionV21 = Omit<JevExecutedDecision, 'action' | 'feature'> & {
  action: Exclude<JevActionV21, 'request_observation'>; feature: null; issue?: JevIssueRef; destination?: CarryDestination; extras?: ExecutedExtra[];
};
type HandlingAnchor =
  | { kind: 'human_turn' | 'repair_history' | 'previous_action'; turn: number }
  | { kind: 'issue_claim'; claimId: string; sourceTurn: number };
type HandlingSource = { target: JevTarget; issue: JevIssueRef; derivation: 'selected' | 'repair_prospect_issue' | 'previous_action' };
export type IssueHandlingRecord = {
  schemaVersion: typeof ISSUE_HANDLING_VERSION;
  class: 'hold_open' | 'carry_over' | 'revisit' | 'other';
  via: 'revisit' | null;
  source: HandlingSource | null;
  destination: CarryDestination | null;
  initiator: 'ai' | 'human' | null;
  anchor: HandlingAnchor | null;
  switchFunction: SwitchFunction | null;
  flags: ('switch_function_unclear' | 'secure_progress_without_current_problem')[];
  commitmentState: CommitmentState;
  alternative: NonBypassAlternative | null;
};
type IssueHandlingStrategy = 'repair-first' | 'bypass-enabled';
export type IssueHandlingPolicy = Readonly<{
  policy: 'bypass_acceptance_v3:veto' | 'bypass_acceptance_v3:accept';
  vetoHandlings: readonly ('hold_open' | 'carry_over')[];
  tableSha256: typeof BYPASS_ACCEPTANCE_V3_TABLE_SHA256;
}>;
export type InterventionTraceV2 = {
  schemaVersion: 'jev_intervention_v2';
  policy: IssueHandlingPolicy['policy'];
  disposition: 'adopted' | 'rejected';
  reasonCode: 'no_intervention' | 'not_in_veto_set' | 'human_led' | 'unanchored' | 'vetoed_issue_handling';
  original: ExecutedDecisionV21;
  planned: ExecutedDecisionV21;
  handling: IssueHandlingRecord;
  alternative: ExecutedDecisionV21 | null;
  humanMoveOn?: HumanMoveOnEvidence;
  extras?: ExtraTrace[];
  failure: null;
};
export type IssueHandlingInput = {
  turn: number;
  ownSlots: readonly string[];
  priorClaims: readonly Pick<LocalClaimView, 'id' | 'issueId' | 'sourceTurn' | 'turn' | 'targets' | 'speaker' | 'act' | 'aspect'>[];
  repairHistory: readonly Pick<RepairHistoryEntry, 'turn' | 'issueId' | 'candidatesAfter'>[];
  repairProspect?: RepairProspectMaterial;
  previousAction: JevPriorAction | null;
};
const policies = (JSON.parse(BYPASS_ACCEPTANCE_V3_CANONICAL_JSON) as {
  policies: Record<IssueHandlingStrategy, Omit<IssueHandlingPolicy, 'tableSha256'>>;
}).policies;

export function issueHandlingForStrategy(strategy: unknown): IssueHandlingPolicy {
  if (strategy !== 'repair-first' && strategy !== 'bypass-enabled') throw new TypeError('invalid_intervention');
  const { policy, vetoHandlings } = policies[strategy];
  return Object.freeze({ policy, vetoHandlings: Object.freeze([...vetoHandlings]), tableSha256: BYPASS_ACCEPTANCE_V3_TABLE_SHA256 });
}

export function issueTargetIds(target: JevTarget): readonly string[] {
  return target.kind === 'single' ? [target.figureId] : target.kind === 'multiple' ? target.figureIds : [];
}

export function previousIssueHandlingTransition(turn: number, decisionTurn: number): JevPriorAction {
  return { turn, decisionTurn, action: 'carry_over', target: { kind: 'none' }, name: null, feature: null,
    issue: { kind: 'unknown' }, destination: { kind: 'partner_choice' } };
}

export function issueHandlingMatchesSource(issue: JevIssueRef, target: JevTarget, turn: number,
  claim: Pick<LocalClaimView, 'id' | 'issueId' | 'sourceTurn' | 'targets' | 'speaker'>, previousAction?: JevPriorAction | null): boolean {
  if (visualPurposeMatchesSource(issue, target, claim)) return true;
  if (issue.kind !== 'resolve_issue' || issue.issueId !== claim.issueId || issue.claimId !== claim.id ||
      issue.sourceTurn !== claim.sourceTurn || claim.speaker !== 'human' || claim.targets.length !== 0) return false;
  if (claim.sourceTurn === turn) return true;
  if (!previousAction || previousAction.turn >= turn || previousAction.decisionTurn !== claim.sourceTurn || !targetsOverlap(target, previousAction.target)) return false;
  const previous = previousAction.visualPurpose ?? previousAction.issue;
  return previous?.kind === 'resolve_issue' && previous.issueId === issue.issueId && previous.claimId === issue.claimId && previous.sourceTurn === issue.sourceTurn;
}

function targetFromIds(ids: readonly string[]): JevTarget {
  return ids.length === 0 ? { kind: 'none' } : ids.length === 1 ? { kind: 'single', figureId: ids[0] }
    : { kind: 'multiple', figureIds: [...ids] };
}

function targetsOverlap(a: JevTarget, b: JevTarget): boolean {
  const ids = issueTargetIds(b);
  return issueTargetIds(a).some(id => ids.includes(id));
}

function previousRepair(input: IssueHandlingInput) {
  const p = input.previousAction;
  return p && p.decisionTurn !== undefined && p.decisionTurn < p.turn && p.turn < input.turn &&
    ['confirm', 'repair', 'hold_open', 'consult', 'revisit'].some(action => action === p.action) ? { ...p, decisionTurn: p.decisionTurn } : null;
}

function prospectIssue(input: IssueHandlingInput) {
  const p = input.repairProspect;
  if (p?.status !== 'ok' || p.prospect === 'no_open_issue' || p.issue.choice !== 'issue') return null;
  const { turn, issueId } = p.issue;
  return input.repairHistory.find(entry => entry.turn === turn && entry.turn < input.turn && entry.issueId === issueId && entry.candidatesAfter.length) ?? null;
}

function currentProblem(input: IssueHandlingInput): HandlingSource | null {
  const entry = prospectIssue(input);
  const claims = input.priorClaims.filter(claim => claim.aspect !== 'progress' && claim.act !== 'withdraw');
  if (entry) {
    const target = targetFromIds(entry.candidatesAfter);
    const claim = claims.filter(c => c.issueId === entry.issueId && targetsOverlap(targetFromIds(c.targets), target))
      .sort((a, b) => a.sourceTurn - b.sourceTurn || a.turn - b.turn).at(-1);
    const issue: JevIssueRef = claim ? { kind: 'resolve_issue', issueId: claim.issueId, claimId: claim.id, sourceTurn: claim.sourceTurn }
      : { kind: 'unknown' };
    return { target, issue, derivation: 'repair_prospect_issue' };
  }
  const previous = previousRepair(input);
  if (!previous || previous.target.kind === 'none') return null;
  const ref = (previous.action === 'confirm' || previous.action === 'repair' ? previous.visualPurpose : previous.issue) ?? { kind: 'unknown' };
  const issue = ref.kind === 'resolve_issue' && !claims.some(claim => issueHandlingMatchesSource(ref, previous.target, previous.decisionTurn, claim))
    ? { kind: 'unknown' as const } : ref;
  return { target: previous.target, issue, derivation: 'previous_action' };
}

export function issueAlternativeTarget(input: IssueHandlingInput, selection: Pick<JevDecision, 'action' | 'target'>): JevTarget | null {
  const target = selection.action === 'revisit' ? currentProblem(input)?.target
    : selection.action === 'hold_open' || selection.action === 'carry_over' ? selection.target : undefined;
  return target?.kind === 'none' ? targetFromIds(input.ownSlots) : target ?? null;
}

function carryAnchor(input: IssueHandlingInput, source: HandlingSource): HandlingAnchor | null {
  if (source.issue.kind === 'resolve_issue') return { kind: 'issue_claim', claimId: source.issue.claimId, sourceTurn: source.issue.sourceTurn };
  const latest = input.repairHistory.filter(entry => entry.turn < input.turn && targetsOverlap(source.target, targetFromIds(entry.candidatesAfter)))
    .sort((a, b) => b.turn - a.turn)[0];
  if (latest) return { kind: 'repair_history', turn: latest.turn };
  const previous = previousRepair(input);
  if (previous && (source.target.kind === 'none' || previous.target.kind === 'none' || targetsOverlap(previous.target, source.target))) {
    return { kind: 'previous_action', turn: previous.decisionTurn };
  }
  return null;
}

function requiredChoice<T extends string>(choice: string | undefined, labels: readonly T[]): T {
  const parsed = labels.find(label => label === choice);
  if (!parsed) throw new TypeError('invalid_issue_handling_decision');
  return parsed;
}

export function projectExtraHandling(action: ExtraHandling | NonBypassAlternative, target: JevTarget, issue: BoundIssueRef): ExecutedExtra {
  const core = { target, name: null, feature: null, observe: null };
  return action === 'hold_open' || action === 'consult' ? { action, ...core, issue }
    : { action, ...core, visualPurpose: issue, detailFigureIds: [] };
}

export function applyExtraIssueHandling(input: Pick<IssueHandlingInput, 'turn' | 'ownSlots'>, selections: readonly ExtraSelection[],
  choices: Readonly<Record<string, string>>, primary: Pick<InterventionTraceV2, 'disposition' | 'handling' | 'policy'>): ExtraTrace[] {
  const drop = primary.disposition === 'rejected' && primary.handling.class === 'carry_over';
  const repairFirst = primary.policy === 'bypass_acceptance_v3:veto';
  return selections.map(({ index, original }) => {
    if (original.action === 'consult') throw new TypeError('invalid_issue_handling_decision');
    const hold = original.action === 'hold_open';
    const alternative = hold ? requiredChoice(choices[`extra_alt_${index}`], NON_BYPASS_ALTERNATIVES) : null;
    const handling = { class: hold ? 'hold_open' as const : 'other' as const, initiator: hold ? 'ai' as const : null,
      anchor: hold ? { kind: 'human_turn' as const, turn: input.turn } : null, alternative };
    if (drop) return { index, original, handling, disposition: 'dropped', reasonCode: 'primary_move_rejected', executed: null };
    if (repairFirst && alternative && 'issue' in original) {
      const target = original.target.kind === 'none' && alternative !== 'consult' ? targetFromIds(input.ownSlots) : original.target;
      return { index, original, handling, disposition: 'rejected', reasonCode: 'vetoed_issue_handling',
        executed: projectExtraHandling(alternative, target, original.issue) };
    }
    return { index, original, handling, disposition: 'adopted', reasonCode: repairFirst ? 'not_in_veto_set' : 'no_intervention', executed: original };
  });
}

/** Pure projection of a validated Jev decision and the same public-derived inputs used to make it. */
export function applyIssueHandling(input: IssueHandlingInput, decision: JevDecision, strategy: unknown): {
  executed: ExecutedDecisionV21; intervention: InterventionTraceV2;
} {
  const config = issueHandlingForStrategy(strategy);
  const { action, target, name, feature, detailFigureIds, sharedClaimIds, visualPurpose, issue, destination, evidence, alternativeSharedClaimIds } = decision;
  if (action === 'request_observation' || action === 'defer' || action === 'move_on' || feature !== null) throw new TypeError('invalid_issue_handling_decision');
  const original = structuredClone({ action, target, name, feature, observe: null,
    ...(detailFigureIds ? { detailFigureIds } : {}), ...(sharedClaimIds ? { sharedClaimIds } : {}),
    ...(visualPurpose ? { visualPurpose } : {}), ...(issue ? { issue } : {}), ...(destination ? { destination } : {}) });
  const first = evidence.stages?.find(stage => stage.stage === 'action');
  const detail = evidence.stages?.find(stage => stage.stage === 'detail')?.choices;
  const handling: IssueHandlingRecord = {
    schemaVersion: ISSUE_HANDLING_VERSION, class: 'other', via: null, source: null, destination: null, initiator: null,
    anchor: null, switchFunction: null, flags: [], commitmentState: requiredChoice(first?.choices.commitment_state, COMMITMENT_STATES), alternative: null,
  };
  let planned: ExecutedDecisionV21 = original;
  if (action === 'hold_open' || action === 'carry_over' || action === 'revisit') {
    if (!issue || action === 'carry_over' && !destination) throw new TypeError('invalid_issue_handling_decision');
    handling.class = action;
    handling.source = { target, issue, derivation: 'selected' };
    handling.destination = destination ?? null;
    handling.alternative = requiredChoice(detail?.non_bypass_alternative, NON_BYPASS_ALTERNATIVES);
    if (action === 'revisit') {
      handling.switchFunction = requiredChoice(detail?.switch_function, SWITCH_FUNCTIONS);
      if (handling.switchFunction === 'unclear') handling.flags.push('switch_function_unclear');
      if (handling.switchFunction === 'secure_progress') {
        const current = currentProblem(input);
        const currentIssue = current?.issue;
        if (!current || currentIssue?.kind === 'resolve_issue' && issue.kind === 'resolve_issue' && currentIssue.issueId === issue.issueId) {
          handling.flags.push('secure_progress_without_current_problem');
        } else {
          const next: CarryDestination = targetsOverlap(current.target, target) ? { kind: 'same_figure_other_issue' }
            : { kind: 'old_issue', issue, targets: [...issueTargetIds(target)] };
          handling.class = 'carry_over';
          handling.via = 'revisit';
          handling.source = current;
          handling.destination = next;
          planned = { action: 'carry_over', target: current.target, issue: current.issue,
            destination: next, name: null, feature: null, observe: null };
        }
      }
    }
  }
  const subject = handling.class;
  const bypass = subject === 'hold_open' || subject === 'carry_over';
  const human = bypass && first?.choices[MOVE_ON_SOURCE_QUESTION] === 'human_request' &&
    validMoveOnSource(first.choices[MOVE_ON_SOURCE_QUESTION], first.scores[MOVE_ON_SOURCE_QUESTION]);
  if (bypass) {
    handling.initiator = human ? 'human' : 'ai';
    handling.anchor ??= subject === 'hold_open' ? { kind: 'human_turn', turn: input.turn } : carryAnchor(input, handling.source!);
  }
  const reasonCode = !bypass ? config.vetoHandlings.length ? 'not_in_veto_set' : 'no_intervention' : human ? 'human_led' : !handling.anchor ? 'unanchored'
    : config.vetoHandlings.includes(subject) ? 'vetoed_issue_handling' : 'no_intervention';
  let alternative: ExecutedDecisionV21 | null = null;
  if (reasonCode === 'vetoed_issue_handling') {
    const { target: sourceTarget, issue: sourceIssue } = handling.source!;
    const action = handling.alternative!;
    alternative = { action, target: action !== 'consult' && sourceTarget.kind === 'none' ? targetFromIds(input.ownSlots) : sourceTarget,
      name: null, feature: null, observe: null,
      ...(action === 'consult' ? { issue: sourceIssue } : { visualPurpose: sourceIssue, detailFigureIds: [] }),
      ...(action === 'confirm' && alternativeSharedClaimIds?.length ? { sharedClaimIds: [...alternativeSharedClaimIds] } : {}) };
  }
  const intervention: InterventionTraceV2 = { schemaVersion: 'jev_intervention_v2', policy: config.policy,
    disposition: alternative ? 'rejected' : 'adopted', reasonCode, original, planned, handling, alternative,
    ...(human ? { humanMoveOn: humanMoveOnEvidence(input.turn, input.repairHistory) } : {}), failure: null };
  let executed = alternative ?? planned;
  if (decision.extras?.length) {
    const extras = applyExtraIssueHandling(input, decision.extras, evidence.stages?.find(stage => stage.stage === 'extras')?.choices ?? {}, intervention);
    intervention.extras = extras;
    const published = extras.flatMap(extra => extra.executed ? [extra.executed] : []);
    if (published.length) executed = { ...executed, extras: published };
  }
  return structuredClone({ executed, intervention });
}
