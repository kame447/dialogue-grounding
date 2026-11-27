import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BYPASS_ACCEPTANCE_V1_CANONICAL_JSON, BYPASS_ACCEPTANCE_V1_TABLE_SHA256 } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { BYPASS_ACCEPTANCE_V2_CANONICAL_JSON, BYPASS_ACCEPTANCE_V2_TABLE_SHA256 } from '../dialogue-model/runtime/decision/human-led-move-on.ts';
import { BYPASS_ACCEPTANCE_V3_CANONICAL_JSON, BYPASS_ACCEPTANCE_V3_TABLE_SHA256, applyIssueHandling, issueHandlingForStrategy, issueHandlingMatchesSource } from '../dialogue-model/runtime/decision/issue-handling.ts';
import type { IssueHandlingInput, JevIssueRef, SwitchFunction, NonBypassAlternative } from '../dialogue-model/runtime/decision/issue-handling.ts';
import type { JevDecisionStageEvidence, RepairHistoryEntry } from '../dialogue-model/runtime/decision/contract.ts';

type Decision = Parameters<typeof applyIssueHandling>[1];
const a = { kind: 'single', figureId: 'shape-a' } as const;
const b = { kind: 'single', figureId: 'shape-b' } as const;
const none = { kind: 'none' } as const;
const unknown = { kind: 'unknown' } as const;
const current = { kind: 'resolve_issue', issueId: '7:local0', claimId: '7:local0', sourceTurn: 7 } as const;
const old = { kind: 'resolve_issue', issueId: '2:local0', claimId: '2:local0', sourceTurn: 2 } as const;
const history: RepairHistoryEntry = { turn: 8, issueId: current.issueId, action: 'confirm', question: 'どの部分ですか？',
  partnerClaims: [], candidatesBefore: [a.figureId], candidatesAfter: [a.figureId],
  addedClaimIds: [], removedClaimIds: [], progress: 'unchanged' };
const base = { turn: 10, ownSlots: [a.figureId, b.figureId, 'shape-c', 'shape-d'], priorClaims: [], repairHistory: [], previousAction: null } satisfies IssueHandlingInput;
const forecast: IssueHandlingInput['repairProspect'] = { status: 'ok', issue: { choice: 'issue', turn: 8, issueId: current.issueId },
  prospect: 'stalled', basis: 'repetition', scores: { repair_issue: {}, prospect: {}, basis: {} } };
const recorded = { ...base, repairHistory: [history], repairProspect: forecast,
  priorClaims: [{ id: current.claimId, turn: 7, issueId: current.issueId, sourceTurn: 7,
    speaker: 'human', targets: [a.figureId], aspect: 'question', act: 'ask' }] } satisfies IssueHandlingInput;

function decision(action: Decision['action'], { target = a as Decision['target'], issue = unknown as JevIssueRef,
  initiator = 'other', switchFunction = 'resolve_old_issue' as SwitchFunction,
  alternative = 'confirm' as NonBypassAlternative, commitment = 'insufficient' } = {}): Decision {
  const stage = (stage: JevDecisionStageEvidence['stage'], choices: JevDecisionStageEvidence['choices'], scores = {}) => ({
    stage, model: null, responseId: null, choices, scores, latencyMs: 0, costUsd: null,
  });
  const first = stage('action', { action, human_move_on_source: initiator, commitment_state: commitment },
    { human_move_on_source: { human_request: 1, other: 0, unclear: 0 } });
  return { action, target, name: null, feature: null, observe: null, decisionKind: 'jev_local_test', calibrated: false,
    ...(['hold_open', 'carry_over', 'revisit', 'consult'].includes(action) ? { issue } : {}),
    ...(action === 'carry_over' ? { destination: { kind: 'partner_choice' } } : {}),
    evidence: { ...first, stages: [first, stage('detail', { switch_function: switchFunction, non_bypass_alternative: alternative })] } };
}

test('the three canonical tables retain their approved digests', () => {
  for (const [json, digest] of [[BYPASS_ACCEPTANCE_V1_CANONICAL_JSON, BYPASS_ACCEPTANCE_V1_TABLE_SHA256],
    [BYPASS_ACCEPTANCE_V2_CANONICAL_JSON, BYPASS_ACCEPTANCE_V2_TABLE_SHA256],
    [BYPASS_ACCEPTANCE_V3_CANONICAL_JSON, BYPASS_ACCEPTANCE_V3_TABLE_SHA256]]) {
    assert.equal(createHash('sha256').update(json).digest('hex'), digest);
  }
  assert.deepEqual(issueHandlingForStrategy('repair-first').vetoHandlings, ['hold_open', 'carry_over']);
  assert.deepEqual(issueHandlingForStrategy('bypass-enabled').vetoHandlings, []);
});

test('grounded hold, including an unknown issue, inherits the complete scope of the unchanged issue', () => {
  for (const ownSlots of [base.ownSlots, [...base.ownSlots, 'shape-e', 'shape-f']]) {
    const input = { ...base, ownSlots };
    const hold = decision('hold_open', { target: none });
    const allowed = applyIssueHandling(input, hold, 'bypass-enabled');
    const refused = applyIssueHandling(input, hold, 'repair-first');
    assert.equal(allowed.intervention.reasonCode, 'no_intervention');
    assert.equal(allowed.executed.action, 'hold_open');
    assert.equal(refused.intervention.reasonCode, 'vetoed_issue_handling');
    assert.deepEqual(refused.intervention.handling.anchor, { kind: 'human_turn', turn: 10 });
    assert.deepEqual(refused.executed.target, { kind: 'multiple', figureIds: ownSlots });
    assert.deepEqual(refused.executed.visualPurpose, unknown);
  }
  const hold = decision('hold_open', { issue: current, alternative: 'repair' });
  const result = applyIssueHandling(recorded, hold, 'repair-first');
  assert.equal(result.executed.action, 'repair');
  assert.deepEqual(result.executed.target, a);
  assert.deepEqual(result.executed.visualPurpose, current);
});

test('carry-over uses claim, latest relevant history, then previous action as its anchor', () => {
  const prev = { turn: 9, decisionTurn: 8, action: 'confirm', target: a, name: null, feature: null } as const;
  const input = { ...recorded, previousAction: prev, repairHistory: [history, { ...history, turn: 9 }] };
  for (const [data, original, anchor] of [
    [input, decision('carry_over', { issue: current, alternative: 'consult' }), { kind: 'issue_claim', claimId: current.claimId, sourceTurn: current.sourceTurn }],
    [input, decision('carry_over', { alternative: 'consult' }), { kind: 'repair_history', turn: 9 }],
    [{ ...input, repairHistory: [] }, decision('carry_over', { alternative: 'consult' }), { kind: 'previous_action', turn: 8 }],
  ] as const) {
    const accepted = applyIssueHandling(data, original, 'bypass-enabled');
    const refused = applyIssueHandling(data, original, 'repair-first');
    assert.equal(accepted.executed.action, 'carry_over');
    assert.deepEqual(refused.intervention.handling.anchor, anchor);
    assert.equal(refused.executed.action, 'consult');
    assert.deepEqual(refused.executed.target, original.target);
    assert.deepEqual(refused.executed.issue, original.issue);
    assert.equal(refused.executed.destination, undefined);
  }
});

test('unanchored and human-led handling are adopted in both strategies, with independent evidence', () => {
  for (const label of ['bypass-enabled', 'repair-first']) {
    const unanchored = applyIssueHandling(base, decision('carry_over'), label);
    const human = applyIssueHandling(recorded, decision('carry_over', { initiator: 'human_request' }), label);
    assert.equal(unanchored.intervention.reasonCode, 'unanchored');
    assert.equal(unanchored.intervention.handling.anchor, null);
    assert.equal(human.intervention.reasonCode, 'human_led');
    assert.deepEqual(human.intervention.humanMoveOn, { source: 'human', publicTurn: 10, openRepairTurns: [8] });
    assert.equal(unanchored.executed.action, 'carry_over');
    assert.equal(human.executed.action, 'carry_over');
  }
  const unclear = applyIssueHandling(recorded, decision('hold_open', { initiator: 'unclear' }), 'repair-first');
  assert.equal(unclear.intervention.handling.initiator, 'ai');
  assert.equal(unclear.intervention.disposition, 'rejected');
});

test('revisit may become carry-over with an unbound destination; its alternative stays on the current problem', () => {
  const original = decision('revisit', { target: b, switchFunction: 'secure_progress', alternative: 'consult' });
  const adopted = applyIssueHandling(recorded, original, 'bypass-enabled');
  const refused = applyIssueHandling(recorded, original, 'repair-first');
  assert.equal(adopted.executed.action, 'carry_over');
  assert.deepEqual(adopted.executed.destination, { kind: 'old_issue', issue: unknown, targets: [b.figureId] });
  assert.equal(adopted.intervention.original.action, 'revisit');
  assert.equal(adopted.intervention.handling.via, 'revisit');
  assert.deepEqual(adopted.intervention.handling.source, { target: a, issue: current, derivation: 'repair_prospect_issue' });
  assert.deepEqual(adopted.intervention.handling.anchor, { kind: 'issue_claim', claimId: current.claimId, sourceTurn: current.sourceTurn });
  assert.equal(refused.executed.action, 'consult');
  assert.deepEqual(refused.executed.issue, current);
  assert.deepEqual(refused.executed.target, a);
});

test('revisit-derived carry-over records the newest overlapping history when no claim supplies its anchor', () => {
  const original = decision('revisit', { target: b, switchFunction: 'secure_progress', alternative: 'consult' });
  const input = { ...base, repairHistory: [{ ...history, turn: 1 }, { ...history, turn: 3 }],
    repairProspect: { ...forecast, issue: { choice: 'issue', turn: 1, issueId: history.issueId } } } satisfies IssueHandlingInput;
  const result = applyIssueHandling(input, original, 'repair-first');
  assert.deepEqual(result.intervention.handling.source, { target: a, issue: unknown, derivation: 'repair_prospect_issue' });
  assert.deepEqual(result.intervention.handling.anchor, { kind: 'repair_history', turn: 3 });
  assert.equal(result.intervention.disposition, 'rejected');
});

test('an empty prospect falls back to the preceding execution; returning within that figure stays in its scope', () => {
  const currentAction = { turn: 9, decisionTurn: 8, action: 'confirm', target: a, name: null, feature: null, visualPurpose: current } as const;
  const input = { ...recorded, repairHistory: [{ ...history, candidatesAfter: [] }], previousAction: currentAction };
  const found = applyIssueHandling(input, decision('revisit', { issue: old, switchFunction: 'secure_progress' }), 'bypass-enabled');
  assert.deepEqual(found.intervention.handling.source, { target: a, issue: current, derivation: 'previous_action' });
  assert.deepEqual(found.executed.destination, { kind: 'same_figure_other_issue' });
  const pruned = applyIssueHandling({ ...input, priorClaims: [] }, decision('revisit', { issue: old, switchFunction: 'secure_progress' }), 'bypass-enabled');
  assert.deepEqual(pruned.intervention.handling.source?.issue, unknown);
  assert.deepEqual(pruned.intervention.handling.anchor, { kind: 'previous_action', turn: 8 });
});

test('the later retained claim wins at the same source and claim turns', () => {
  const latest = { ...recorded.priorClaims[0], id: '7:local1' };
  const input = { ...recorded, priorClaims: [...recorded.priorClaims, latest] };
  const original = decision('revisit', { target: b, switchFunction: 'secure_progress' });
  const result = applyIssueHandling(input, original, 'repair-first');
  assert.deepEqual(result.intervention.handling.anchor, { kind: 'issue_claim', claimId: latest.id, sourceTurn: 7 });
});

test('revisit stays common when it resolves the old issue, the function is unclear, or there is no distinct current problem', () => {
  for (const label of ['bypass-enabled', 'repair-first']) for (const [input, issue, switchFunction, flags] of [
    [recorded, current, 'secure_progress', ['secure_progress_without_current_problem']],
    [base, old, 'secure_progress', ['secure_progress_without_current_problem']],
    [recorded, old, 'resolve_old_issue', []], [recorded, old, 'unclear', ['switch_function_unclear']],
  ] as const) {
    const result = applyIssueHandling(input, decision('revisit', { issue, switchFunction }), label);
    assert.equal(result.executed.action, 'revisit');
    assert.equal(result.intervention.handling.class, 'revisit');
    assert.deepEqual(result.intervention.handling.flags, flags);
    assert.equal(result.intervention.alternative, null);
  }
});

test('recording D8 does not change the plan or introduce another veto action', () => {
  for (const action of ['accept', 'consult', 'close', 'agree', 'confirm', 'repair'] as const) {
    for (const commitment of ['conflicting', 'supported', 'insufficient']) {
      const result = applyIssueHandling(recorded, decision(action, { commitment }), 'repair-first');
      assert.equal(result.intervention.disposition, 'adopted');
      assert.equal(result.intervention.handling.commitmentState, commitment);
      assert.equal(result.intervention.reasonCode, 'not_in_veto_set');
      assert.equal(result.executed.action, action);
    }
  }
});

test('previous-action anchors and unscoped human sources use the decision turn, not the AI event number', () => {
  const perTurnIssue = { kind: 'resolve_issue', claimId: '9:local0', issueId: '9:local0', sourceTurn: 9 } as const;
  const { claimId, issueId, sourceTurn } = perTurnIssue;
  const input: IssueHandlingInput = { ...base, turn: 11,
    priorClaims: [{ ...recorded.priorClaims[0], id: claimId, issueId, sourceTurn, turn: 9, targets: [] }],
    previousAction: { action: 'hold_open', target: a, issue: perTurnIssue, name: null, feature: null, turn: 10, decisionTurn: 9 },
  };
  const original = decision('revisit', { target: b, switchFunction: 'secure_progress' });
  const result = applyIssueHandling(input, original, 'repair-first');
  assert.deepEqual(result.intervention.handling.anchor, { kind: 'issue_claim', claimId, sourceTurn });
  assert.deepEqual(result.executed.visualPurpose, perTurnIssue);
  assert.equal(issueHandlingMatchesSource(perTurnIssue, a, input.turn, input.priorClaims[0], input.previousAction), true);
  assert.equal(issueHandlingMatchesSource(perTurnIssue, b, input.turn, input.priorClaims[0], input.previousAction), false);
  assert.equal(issueHandlingMatchesSource(perTurnIssue, a, input.turn, input.priorClaims[0]), false);
});
