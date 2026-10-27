// Synthetic legacy H1/H2 controls and PLAN-ADAPTIVE-r1 §2.2(b')(c') cases.
// No private dialogue, real transport, or utterance-generation assertions (H3).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JEV_ACTIONS} from '../dialogue-model/runtime/decision/contract.ts';
import type {JevAction, JevDecisionInput, JevTarget} from '../dialogue-model/runtime/decision/contract.ts';
import {createJevDecisionClient, JEV_DECISION_MODEL} from '../dialogue-model/runtime/decision/jev-decision.ts';
import type {JevDecisionPayload} from '../dialogue-model/runtime/decision/jev-decision.ts';
import {applyBypassAcceptance, interventionForStrategy, planBypassAcceptance, isOpenIssueRerankRecord} from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import type {BypassAcceptanceInput, RepairProspectMaterial, InterventionTrace, ExecutedDecision} from '../dialogue-model/runtime/decision/bypass-acceptance.ts';

const repairFirst = interventionForStrategy('repair-first');
const bypassEnabled = interventionForStrategy('bypass-enabled');
const openTarget: JevTarget = {kind: 'single', figureId: 'own-0'};
const nextTarget: JevTarget = {kind: 'single', figureId: 'own-1'};
const none: JevTarget = {kind: 'none'};

function input(previous: 'confirm' | 'repair' | null = 'confirm'): BypassAcceptanceInput {
  const i = JSON.parse(readFileSync(new URL('./fixtures/bypass-acceptance/MINIMAL-INPUT.json', import.meta.url), 'utf8')) as JevDecisionInput;
  i.turn = 3;
  i.publicTurns = [
    {turn: 1, speaker: 'ai', text: 'Does this shape have an upper point?'},
    {turn: 2, speaker: 'human', text: 'I cannot tell which point you mean.'},
    {turn: 3, speaker: 'human', text: 'Can we check that part again?'},
  ];
  i.issueSummary = 'The upper point remains unresolved.';
  i.previousAction = previous === null ? null : {
    turn: 1, action: previous, target: structuredClone(openTarget), name: null, feature: 'feature-0',
  };
  i.repairHistory = [{
    turn: 1, issueId: 'synthetic-open-issue', action: previous ?? 'confirm',
    question: 'Does this shape have an upper point?', partnerClaims: [],
    candidatesBefore: ['own-0'], candidatesAfter: ['own-0'],
    addedClaimIds: [], removedClaimIds: [], progress: 'unchanged',
  }];
  return i;
}

const openIssueOptions = {rerank: 'open_issue_v1'} as const;
function material(issue: Extract<RepairProspectMaterial, {status: 'ok'}>['issue'] = {choice: 'issue', turn: 1, issueId: 'synthetic-open-issue'}): Extract<RepairProspectMaterial, {status: 'ok'}> {
  return {status: 'ok', issue, prospect: 'uncertain', basis: 'partner_uncertain', scores: {
    repair_issue: {issue_0: 0.8, none: 0.1, unknown: 0.1},
    prospect: {progressing: 0.1, stalled: 0.1, uncertain: 0.8, no_open_issue: 0},
    basis: {new_information: 0, candidate_narrowed: 0, candidate_widened: 0, repetition: 0.1, partner_uncertain: 0.9, other_figure_benefit: 0, none: 0},
  }};
}
function withIssue(previous: 'confirm' | 'repair' | null = 'confirm'): BypassAcceptanceInput {
  return {...input(previous), repairProspect: material()};
}

// Stage-one scores are deliberately near one-hot, not calibrated probabilities.
// The same fake client provides ordinary detail evidence when confirm is selected.
function client(target: JevTarget, scores: Partial<Record<JevAction, number>>, action: 'move_on' | 'defer' = 'move_on') {
  return createJevDecisionClient({
    enabled: true,
    readKey: async () => 'sk-or-SYNTHETIC-veto-target-only',
    fetchImpl: async (_url, init) => {
      const p = JSON.parse(init.body as string) as JevDecisionPayload;
      const targetLabel = target.kind === 'single' ? `figure_${target.figureId === 'own-0' ? 0 : 1}` : target.kind;
      const answers = Object.fromEntries(Object.entries(p.questions).map(([key, q]) => {
        const choice = key === 'action' ? action : key === 'target' ? targetLabel : key.startsWith('candidate_') ? 'exclude' : Object.keys(q.criteria)[0];
        const probabilities = Object.fromEntries(Object.keys(q.criteria).map(label => [
          label, key === 'action' ? scores[label as JevAction] ?? (label === action ? 1 : 0) : Number(label === choice),
        ]));
        return [key, {type: 'choice', choice, probabilities}];
      }));
      return new Response(JSON.stringify({model: JEV_DECISION_MODEL, id: 'gen-synthetic-veto-target', usage: {cost: 0}, answers}));
    },
  })!;
}

for (const previous of ['confirm', 'repair'] as const) {
  test(`current H1: ${previous} unresolved, move_on target none becomes accept`, async () => {
    const i = input(previous), c = client(none, {accept: 0.01});
    const original = await c.decide(i);
    assert.equal(original.decisionKind, 'jev_local_test');
    assert.equal(original.evidence.stages![0].stage, 'action_target');
    const before = structuredClone({i, original});
    const plan = planBypassAcceptance(i, original, repairFirst);
    assert.deepEqual(plan.rerank!.ranking, [{action: 'accept', score: 0.01}, {action: 'close', score: 0}]);
    assert.deepEqual(plan.rerank!.selected, {action: 'accept', target: none});
    const result = await applyBypassAcceptance(i, original, repairFirst, c.completeDetail);
    assert.equal(result.intervention.disposition, 'rejected');
    assert.equal(result.intervention.reasonCode, 'vetoed_bypass_action');
    assert.equal(result.executed.action, 'accept');
    assert.deepEqual(result.executed.target, none);
    assert.equal(result.intervention.detailEvidence, null);
    assert.equal(c.callCount, 1, 'accept needs no detail call');
    assert.deepEqual({i, original}, before);
  });
}

test('current H1/H2: confirm 0.06 beats accept 0.05 but retains the move_on destination', async () => {
  const i = input(), c = client(nextTarget, {confirm: 0.06, accept: 0.05});
  const original = await c.decide(i);
  const plan = planBypassAcceptance(i, original, repairFirst);
  assert.deepEqual(plan.rerank!.ranking.slice(0, 2), [{action: 'confirm', score: 0.06}, {action: 'accept', score: 0.05}]);
  assert.deepEqual(plan.rerank!.selected, {action: 'confirm', target: nextTarget});
  const result = await applyBypassAcceptance(i, original, repairFirst, c.completeDetail);
  assert.equal(result.executed.action, 'confirm');
  assert.deepEqual(result.executed.target, nextTarget);
  assert.deepEqual(result.executed.detailFigureIds, ['own-1']);
  assert.equal(result.intervention.detailEvidence!.stage, 'detail');
  assert.equal(c.callCount, 2);
});

test('current H2 boundary: zero alternative scores tie in JEV_ACTIONS order, accept wins', async () => {
  const i = input(), c = client(nextTarget, {}), original = await c.decide(i);
  const plan = planBypassAcceptance(i, original, repairFirst);
  assert.deepEqual(plan.rerank!.ranking, JEV_ACTIONS.filter(a => !['defer', 'move_on', 'request_observation'].includes(a)).map(action => ({action, score: 0})));
  const result = await applyBypassAcceptance(i, original, repairFirst, c.completeDetail);
  assert.equal(result.executed.action, 'accept');
});

for (const target of [none, nextTarget]) {
  test(`control: bypass-enabled adopts move_on with ${target.kind} target`, async () => {
    const i = input(), c = client(target, {confirm: 0.06, accept: 0.05}), original = await c.decide(i);
    const plan = planBypassAcceptance(i, original, bypassEnabled);
    assert.equal(plan.disposition, 'adopted');
    assert.equal(plan.reasonCode, 'no_intervention');
    assert.equal(plan.rerank, null);
    const result = await applyBypassAcceptance(i, original, bypassEnabled, async () => {throw Error('unexpected detail call');});
    assert.equal(result.intervention.reasonCode, 'no_intervention');
    assert.deepEqual(result.executed, {action: 'move_on', target, name: null, feature: null, observe: null, detailFigureIds: []});
    assert.equal(c.callCount, 1);
  });
}

// The six controls above stay on the legacy/default path. A selected issue is
// explicit material; previousAction and repairHistory alone never select one.
for (const previous of ['confirm', 'repair', null] as const) {
  for (const target of [none, nextTarget]) {
    test(`open issue: explicit choice with previous ${previous ?? 'none'} redirects ${target.kind} to repair candidates`, async () => {
        const i = withIssue(previous), c = client(target, {confirm: 0.06, accept: 0.95}), original = await c.decide(i);
        const before = structuredClone({i, original});
        const plan = planBypassAcceptance(i, original, repairFirst, openIssueOptions);
        assert.deepEqual(plan.rerank!.selected, {action: 'confirm', target: openTarget});
        assert.deepEqual(plan.rerank!.ranking, [{action: 'confirm', score: 0.06}, {action: 'repair', score: 0}]);
        assert.equal(plan.rerank!.policyId, 'saved_action_scores_open_issue_v1');
        assert.ok(plan.rerank!.policyId === 'saved_action_scores_open_issue_v1');
        assert.deepEqual(plan.rerank!.source, {issueTurn: 1, issueId: 'synthetic-open-issue', choice: 'issue', candidates: ['own-0']});
        assert.deepEqual(plan.original.target, target);
        assert.deepEqual({i, original}, before);
        assert.ok(Object.isFrozen(plan.rerank!.selected!.target));
      });
  }
}

// The decision input boundary rejects an issue choice that names no saved history entry,
// so these never reach the rerank's defensive fallback.
for (const [name, edit] of [
  ['absent repairHistory', (i: BypassAcceptanceInput) => { i.issueSummary = ''; i.repairHistory = []; i.repairProspect = material(); }],
  ['unmatched turn', (i: BypassAcceptanceInput) => { i.repairProspect = material({choice: 'issue', turn: 2, issueId: 'synthetic-open-issue'}); }],
  ['unmatched issueId', (i: BypassAcceptanceInput) => { i.repairProspect = material({choice: 'issue', turn: 1, issueId: 'another-issue'}); }],
] as const) {
  test(`open issue boundary: ${name} is rejected before any rerank`, async () => {
    const i = input(name === 'absent repairHistory' ? null : 'confirm');
    const c = client(none, {accept: 0.01}), original = await c.decide(i);
    edit(i);
    await assert.rejects(c.decide(i));
    assert.throws(() => planBypassAcceptance(i, original, repairFirst, openIssueOptions), {code: 'invalid_input'});
  });
}

for (const action of ['move_on', 'defer'] as const) {
  test(`open issue: vetoed ${action} uses saved scores and JEV_ACTIONS ties, including zero`, async () => {
    const i = withIssue(), c = client(none, {repair: 0.2, confirm: 0.1, accept: 0.9}, action), original = await c.decide(i);
    const plan = planBypassAcceptance(i, original, repairFirst, openIssueOptions);
    assert.deepEqual(plan.rerank!.ranking, [{action: 'repair', score: 0.2}, {action: 'confirm', score: 0.1}]);
    const tieClient = client(none, {}, action), tied = await tieClient.decide(i);
    const tie = planBypassAcceptance(i, tied, repairFirst, openIssueOptions);
    assert.deepEqual(tie.rerank!.ranking, [{action: 'confirm', score: 0}, {action: 'repair', score: 0}]);
    assert.deepEqual(tie.rerank!.selected, {action: 'confirm', target: openTarget});
  });
}

test('open issue: multiple candidates are preserved in stored order', async () => {
  const i = withIssue();
  i.repairHistory = [{...i.repairHistory[0], candidatesAfter: ['own-2', 'own-0']}];
  const c = client(none, {confirm: 0.2}), original = await c.decide(i);
  const p = planBypassAcceptance(i, original, repairFirst, openIssueOptions);
  assert.deepEqual(p.rerank!.selected, {action: 'confirm', target: {kind: 'multiple', figureIds: ['own-2', 'own-0']}});
  assert.deepEqual(p.rerank!.ranking.map(r => r.action), ['confirm', 'repair']);
});

test('open issue: the chosen history entry, including a null issueId, overrides a newer entry', async () => {
  const i = withIssue();
  i.repairHistory = [{...i.repairHistory[0], issueId: null}, {...i.repairHistory[0], turn: 2, candidatesAfter: ['own-1']}];
  i.repairProspect = material({choice: 'issue', turn: 1, issueId: null});
  i.repairProspect.scores.repair_issue = {issue_0: 0.8, issue_1: 0.1, none: 0.1, unknown: 0};
  const c = client(nextTarget, {confirm: 0.2}), original = await c.decide(i);
  const p = planBypassAcceptance(i, original, repairFirst, openIssueOptions);
  assert.deepEqual(p.rerank!.selected, {action: 'confirm', target: openTarget});
  assert.ok(p.rerank!.policyId === 'saved_action_scores_open_issue_v1');
  assert.deepEqual(p.rerank!.source, {issueTurn: 1, issueId: null, choice: 'issue', candidates: ['own-0']});
});

for (const previous of [null, 'confirm', 'repair', 'defer-other', 'defer-same'] as const) {
  test(`open issue: revisit eligibility after ${previous ?? 'no previous action'}`, async () => {
    const i = withIssue();
    i.previousAction = previous === null ? null : {...i.previousAction!, action: previous === 'defer-other' || previous === 'defer-same' ? 'defer' : previous,
      target: previous === 'defer-other' ? nextTarget : openTarget, feature: previous.startsWith('defer') ? null : 'feature-0'};
    const c = client(none, {revisit: 0.9, confirm: 0.2, repair: 0.1}), original = await c.decide(i);
    const p = planBypassAcceptance(i, original, repairFirst, openIssueOptions);
    assert.equal(p.rerank!.ranking.some(r => r.action === 'revisit'), previous === 'defer-same');
    if (previous === 'defer-same') {
      const r = await applyBypassAcceptance(i, original, repairFirst, undefined, openIssueOptions);
      assert.deepEqual(r.executed, {action: 'revisit', target: openTarget, name: null, feature: null, observe: null, detailFigureIds: []});
      assert.equal(c.callCount, 1);
      assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, i.previousAction), true);
      assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots), false);
      assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, {...i.previousAction!, target: nextTarget}), false);
    }
  });
}

test('open issue: revisit recognizes the same multiple candidate set without narrowing it', async () => {
  const i = withIssue();
  i.repairHistory = [{...i.repairHistory[0], candidatesAfter: ['own-2', 'own-0']}];
  i.previousAction = {...i.previousAction!, action: 'defer', target: {kind: 'multiple', figureIds: ['own-0', 'own-2']}, feature: null};
  const c = client(none, {revisit: 0.9}), original = await c.decide(i);
  const r = await applyBypassAcceptance(i, original, repairFirst, undefined, openIssueOptions);
  assert.deepEqual(r.executed.target, {kind: 'multiple', figureIds: ['own-2', 'own-0']});
  assert.equal(r.executed.action, 'revisit');
  assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, i.previousAction), true);
});

for (const [name, prospect] of [
  ['absent', undefined],
  ['failed estimate', {status: 'unknown', issue: null, prospect: null, basis: null, scores: null}],
  ['none choice', material({choice: 'none'})],
  ['unknown choice', material({choice: 'unknown'})],
] as const) {
  test(`open issue fallback: ${name} is byte-identical to saved-action rerank`, async () => {
    const i = input();
    if (prospect !== undefined) i.repairProspect = prospect;
    const c = client(nextTarget, {accept: 0.9, confirm: 0.8}), original = await c.decide(i);
    const baseline = planBypassAcceptance(i, original, repairFirst);
    assert.equal(JSON.stringify(planBypassAcceptance(i, original, repairFirst, openIssueOptions)), JSON.stringify(baseline));
    const r = await applyBypassAcceptance(i, original, repairFirst, undefined, openIssueOptions);
    const legacy = await applyBypassAcceptance(i, original, repairFirst);
    assert.equal(JSON.stringify(r), JSON.stringify(legacy));
    assert.equal(r.intervention.rerank!.policyId, 'saved_action_scores_v1');
  });
}

test('open issue fallback: empty candidates or no executable repair candidates retain the old policyId', async () => {
  for (const emptyCandidates of [true, false]) {
    const i = withIssue();
    if (emptyCandidates) i.repairHistory = [{...i.repairHistory[0], candidatesAfter: []}];
    else i.observations.figures.forEach(f => {f.holistic = []; f.analytic = {shapes: [], composition: '', relations: []};});
    const c = client(none, {accept: 0.3}), original = await c.decide(i);
    const p = planBypassAcceptance(i, original, repairFirst, openIssueOptions);
    assert.equal(p.rerank!.policyId, 'saved_action_scores_v1');
    assert.deepEqual(p.rerank!.selected, {action: 'accept', target: none});
  }
});

test('open issue: no feature catalog can still revisit after a same-target defer', async () => {
  const i = withIssue();
  i.previousAction = {...i.previousAction!, action: 'defer', feature: null};
  i.observations.figures.forEach(f => {f.holistic = []; f.analytic = {shapes: [], composition: '', relations: []};});
  const c = client(none, {revisit: 0.2}), original = await c.decide(i);
  const r = await applyBypassAcceptance(i, original, repairFirst, undefined, openIssueOptions);
  assert.deepEqual(r.intervention.rerank!.ranking, [{action: 'revisit', score: 0.2}]);
  assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, i.previousAction), true);
});

test('open issue: prospect labels and scores are not a policy threshold', async () => {
  const i = withIssue(), c = client(none, {repair: 0.4}), original = await c.decide(i);
  const before = planBypassAcceptance(i, original, repairFirst, openIssueOptions);
  for (const prospect of ['progressing', 'stalled', 'no_open_issue'] as const) {
    assert.ok(i.repairProspect!.status === 'ok');
    i.repairProspect!.prospect = prospect;
    i.repairProspect!.basis = 'other_figure_benefit';
    const current = await c.decide(i);
    assert.deepEqual(planBypassAcceptance(i, current, repairFirst, openIssueOptions), before);
  }
});

test('default and explicit saved_action_scores_v1 serialize identically, even with prospect material', async () => {
  const i = withIssue(), c = client(none, {accept: 0.1}), original = await c.decide(i);
  const p = planBypassAcceptance(i, original, repairFirst);
  for (const options of [{}, {rerank: 'saved_action_scores_v1'}] as const) {
    assert.equal(JSON.stringify(planBypassAcceptance(i, original, repairFirst, options)), JSON.stringify(p));
    const r = await applyBypassAcceptance(i, original, repairFirst, undefined, options);
    assert.equal(JSON.stringify(r), JSON.stringify(await applyBypassAcceptance(i, original, repairFirst)));
  }
});

test('open issue: bypass-enabled adopts the unchanged original with no detail request', async () => {
  const i = withIssue(), c = client(none, {repair: 0.4}), original = await c.decide(i);
  const r = await applyBypassAcceptance(i, original, bypassEnabled, async () => {throw Error('unexpected');}, openIssueOptions);
  assert.equal(JSON.stringify(r), JSON.stringify(await applyBypassAcceptance(i, original, bypassEnabled)));
  assert.equal(r.intervention.rerank, null);
  assert.equal(c.callCount, 1);
});

// These exercise the real selected-detail parser. B1 adds repairProspect to
// that boundary's optional keys; until B1 is integrated these fail invalid_input.
for (const action of ['confirm', 'repair'] as const) {
  test(`open issue detail integration: ${action} uses the issue target and unchanged input material`, async () => {
    const i = withIssue(), c = client(nextTarget, {[action]: 0.5}), original = await c.decide(i);
    const before = structuredClone({i, original});
    let calls = 0;
    const r = await applyBypassAcceptance(i, original, repairFirst, async (ci, selected) => {
      calls++;
      assert.deepEqual(ci, i);
      assert.ok(Object.isFrozen((ci as BypassAcceptanceInput).repairProspect));
      assert.deepEqual(selected, {action, target: openTarget});
      return c.completeDetail!(ci, selected);
    }, openIssueOptions);
    assert.equal(calls, 1);
    assert.equal(c.callCount, 2);
    assert.equal(r.executed.action, action);
    assert.deepEqual(r.executed.target, openTarget);
    assert.deepEqual(r.executed.detailFigureIds, ['own-0']);
    assert.deepEqual({i, original}, before);
    assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots), true);
  });
}

// Synthetic persisted records for the pure new-policy proof checker. This does
// not claim a restore round-trip before the parent's jev-turn integration.
async function persistedRecord(multiple = false) {
  const i = withIssue();
  if (multiple) i.repairHistory = [{...i.repairHistory[0], candidatesAfter: ['own-2', 'own-0']}];
  const c = client(none, {confirm: 0.4, repair: 0.2}), decision = await c.decide(i);
  const plan = planBypassAcceptance(i, decision, repairFirst, openIssueOptions);
  // Only assemble synthetic detail evidence here; production retains material.
  const {repairProspect: _material, ...detailInput} = i;
  const detail = await c.completeDetail!(detailInput, plan.rerank!.selected!);
  const intervention: InterventionTrace = {schemaVersion: 'jev_intervention_v1', policy: plan.policy,
    disposition: 'rejected', reasonCode: 'vetoed_bypass_action', original: plan.original,
    rerank: plan.rerank, alternative: detail.executed, detailEvidence: detail.evidence, failure: null};
  return structuredClone({intervention, decision, executed: detail.executed as ExecutedDecision, ownSlots: i.ownSlots});
}

test('open issue persisted proof: valid single/multiple records survive JSON serialization', async () => {
  for (const multiple of [false, true]) {
    const r = JSON.parse(JSON.stringify(await persistedRecord(multiple))) as Awaited<ReturnType<typeof persistedRecord>>;
    const before = structuredClone(r);
    assert.equal(isOpenIssueRerankRecord(r.intervention, r.decision, r.executed, r.ownSlots), true);
    assert.deepEqual(r, before);
  }
});

test('open issue persisted proof: source, target, action, saved scores and ordering tampering fail', async () => {
  const record = await persistedRecord();
  const changes: Record<string, (r: any) => void> = {
    'missing source': r => {delete r.intervention.rerank.source;},
    'wrong choice': r => {r.intervention.rerank.source.choice = 'unknown';},
    'invalid source turn': r => {r.intervention.rerank.source.issueTurn = 0;},
    'selected target mismatch': r => {r.intervention.rerank.selected.target = nextTarget;},
    'foreign target': r => {
      const target = {kind: 'single', figureId: 'partner-0'};
      r.executed.target = target; r.intervention.alternative.target = target; r.intervention.rerank.selected.target = target;
    },
    'accept in ranking': r => {r.intervention.rerank.ranking.push({action: 'accept', score: 0});},
    'duplicate action': r => {r.intervention.rerank.ranking.push({...r.intervention.rerank.ranking[1]});},
    'changed score': r => {r.intervention.rerank.ranking[0].score = 0.5;},
    'wrong order': r => {r.intervention.rerank.ranking.reverse();},
    'omitted repair': r => {r.intervention.rerank.ranking.pop();},
    'no saved scores': r => {delete r.decision.evidence.stages[0].scores.action;},
    'different alternative': r => {r.intervention.alternative.action = 'repair';},
    'changed original target': r => {r.intervention.original.target = openTarget;},
  };
  for (const [name, change] of Object.entries(changes)) {
    const r = structuredClone(record);
    change(r);
    assert.equal(isOpenIssueRerankRecord(r.intervention, r.decision, r.executed, r.ownSlots), false, name);
  }
});

test('open issue persisted proof: tied scores use JEV_ACTIONS order and old policyIds are excluded', async () => {
  const r = await persistedRecord();
  r.decision.evidence.stages![0].scores.action.repair = 0.4;
  r.intervention.rerank!.ranking[1].score = 0.4;
  assert.equal(isOpenIssueRerankRecord(r.intervention, r.decision, r.executed, r.ownSlots), true);
  const swapped = structuredClone(r);
  (swapped.intervention.rerank!.ranking as unknown[]).reverse();
  assert.equal(isOpenIssueRerankRecord(swapped.intervention, swapped.decision, swapped.executed, swapped.ownSlots), false);
  const legacy = {...r.intervention, rerank: {policyId: 'saved_action_scores_v1', ranking: r.intervention.rerank!.ranking, selected: r.intervention.rerank!.selected}};
  assert.equal(isOpenIssueRerankRecord(legacy, r.decision, r.executed, r.ownSlots), false);
});

test('open issue persisted proof: an untrusted source getter is never invoked', async () => {
  const r = await persistedRecord();
  let reads = 0;
  Object.defineProperty(r.intervention.rerank!, 'source', {enumerable: true, get() {reads++; throw Error('PRIVATE_CANARY');}});
  assert.equal(isOpenIssueRerankRecord(r.intervention, r.decision, r.executed, r.ownSlots), false);
  assert.equal(reads, 0);
});
