import { visualPurposeMatchesSource } from './contract.ts';
import type { JevDecision, JevExecutedDecision, JevPriorAction, JevTarget, JevVisualPurpose, RepairHistoryEntry, RepairProspectMaterial } from './contract.ts';
import { humanMoveOnEvidence, MOVE_ON_SOURCE_QUESTION, validMoveOnSource } from './human-led-move-on.ts';
import type { HumanMoveOnEvidence } from './human-led-move-on.ts';
import type { LocalClaimView } from '../local-grounding/contract.ts';

export const ISSUE_HANDLING_VERSION = 'jev_issue_handling_v1';
export const BYPASS_ACCEPTANCE_V3_VERSION = 'bypass_acceptance_v3';
export const BYPASS_ACCEPTANCE_V3_CANONICAL_JSON = '{"alternative":{"labels":["confirm","repair","consult"],"question":"non_bypass_alternative","stage":"detail"},"anchor":"issue_handling_anchor_v1","humanLed":{"choice":"human_request","question":"human_move_on_source"},"policies":{"bypass-enabled":{"policy":"bypass_acceptance_v3:accept","vetoHandlings":[]},"repair-first":{"policy":"bypass_acceptance_v3:veto","vetoHandlings":["hold_open","carry_over"]}},"switchFunction":{"choice":"secure_progress","question":"switch_function","retypes":{"revisit":"carry_over"}},"version":"bypass_acceptance_v3"}';
export const BYPASS_ACCEPTANCE_V3_TABLE_SHA256 = '2c978ae7bdef1aa5109400aebf708eacfdb1ccdabb65e716419a4d262efb4cd5';
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
export type ExecutedDecisionV21 = Omit<JevExecutedDecision, 'action' | 'feature'> & {
  action: Exclude<JevActionV21, 'request_observation'>; feature: null; issue?: JevIssueRef; destination?: CarryDestination;
};
type IssueHandlingOriginal = Omit<JevDecision, 'action'> & {
  action: JevActionV21; issue?: JevIssueRef; destination?: CarryDestination; alternativeSharedClaimIds?: string[];
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
  failure: null;
};
export type IssueHandlingInput = {
  turn: number;
  ownSlots: readonly string[];
  priorClaims: readonly LocalClaimView[];
  repairHistory: readonly RepairHistoryEntry[];
  repairProspect?: RepairProspectMaterial;
  previousAction: (Omit<JevPriorAction, 'action'> & {
    action: JevActionV21; issue?: JevIssueRef; visualPurpose?: JevIssueRef; destination?: CarryDestination;
  }) | null;
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

export function issueHandlingMatchesSource(issue: JevIssueRef, target: JevTarget, turn: number,
  claim: Pick<LocalClaimView, 'id' | 'issueId' | 'sourceTurn' | 'targets' | 'speaker'>): boolean {
  return visualPurposeMatchesSource(issue, target, claim) ||
    issue.kind === 'resolve_issue' && issue.issueId === claim.issueId && issue.claimId === claim.id &&
    issue.sourceTurn === turn && claim.sourceTurn === turn && claim.speaker === 'human' && claim.targets.length === 0;
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
  return p && p.turn < input.turn && ['confirm', 'repair', 'hold_open', 'consult', 'revisit'].some(action => action === p.action) ? p : null;
}

function prospectIssue(input: IssueHandlingInput) {
  const p = input.repairProspect;
  if (p?.status !== 'ok' || p.prospect === 'no_open_issue' || p.issue.choice !== 'issue') return null;
  const { turn, issueId } = p.issue;
  return input.repairHistory.find(entry => entry.turn === turn && entry.turn < input.turn && entry.issueId === issueId && entry.candidatesAfter.length) ?? null;
}

function currentProblem(input: IssueHandlingInput): { source: HandlingSource; anchor: HandlingAnchor } | null {
  const entry = prospectIssue(input);
  const claims = input.priorClaims.filter(claim => claim.aspect !== 'progress' && claim.act !== 'withdraw');
  if (entry) {
    const target = targetFromIds(entry.candidatesAfter);
    const claim = claims.filter(c => c.issueId === entry.issueId && targetsOverlap(targetFromIds(c.targets), target))
      .sort((a, b) => b.sourceTurn - a.sourceTurn || b.turn - a.turn)[0];
    const issue: JevIssueRef = claim ? { kind: 'resolve_issue', issueId: claim.issueId, claimId: claim.id, sourceTurn: claim.sourceTurn }
      : { kind: 'unknown' };
    return { source: { target, issue, derivation: 'repair_prospect_issue' }, anchor: { kind: 'repair_history', turn: entry.turn } };
  }
  const previous = previousRepair(input);
  if (!previous || previous.target.kind === 'none') return null;
  const ref = (previous.action === 'confirm' || previous.action === 'repair' ? previous.visualPurpose : previous.issue) ?? { kind: 'unknown' };
  const issue = ref.kind === 'resolve_issue' && !claims.some(claim => issueHandlingMatchesSource(ref, previous.target, previous.turn, claim))
    ? { kind: 'unknown' as const } : ref;
  return { source: { target: previous.target, issue, derivation: 'previous_action' }, anchor: { kind: 'previous_action', turn: previous.turn } };
}

export function issueAlternativeTarget(input: IssueHandlingInput, selection: { action: JevActionV21; target: JevTarget }): JevTarget | null {
  const target = selection.action === 'revisit' ? currentProblem(input)?.source.target
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
    return { kind: 'previous_action', turn: previous.turn };
  }
  return null;
}

function requiredChoice<T extends string>(choice: string | undefined, labels: readonly T[]): T {
  const parsed = labels.find(label => label === choice);
  if (!parsed) throw new TypeError('invalid_issue_handling_decision');
  return parsed;
}

/** Pure projection of a validated Jev decision and the same public-derived inputs used to make it. */
export function applyIssueHandling(input: IssueHandlingInput, decision: IssueHandlingOriginal, strategy: unknown): {
  executed: ExecutedDecisionV21; intervention: InterventionTraceV2;
} {
  const config = issueHandlingForStrategy(strategy);
  const { action, target, name, feature, detailFigureIds, sharedClaimIds, visualPurpose, issue, destination, evidence, alternativeSharedClaimIds } = decision;
  if (action === 'request_observation' || !JEV_ACTIONS_V21.includes(action) || feature !== null) throw new TypeError('invalid_issue_handling_decision');
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
        const currentIssue = current?.source.issue;
        if (!current || currentIssue?.kind === 'resolve_issue' && issue.kind === 'resolve_issue' && currentIssue.issueId === issue.issueId) {
          handling.flags.push('secure_progress_without_current_problem');
        } else {
          const next: CarryDestination = targetsOverlap(current.source.target, target) ? { kind: 'same_figure_other_issue' }
            : { kind: 'old_issue', issue, targets: [...issueTargetIds(target)] };
          handling.class = 'carry_over';
          handling.via = 'revisit';
          handling.source = current.source;
          handling.anchor = current.anchor;
          handling.destination = next;
          planned = { action: 'carry_over', target: current.source.target, issue: current.source.issue,
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
  return structuredClone({ executed: alternative ?? planned, intervention });
}
