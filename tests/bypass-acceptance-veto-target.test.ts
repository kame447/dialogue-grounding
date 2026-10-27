// Synthetic H1/H2 reproductions from PLAN-ADAPTIVE-r0 §2.1 and §2.2(b)(c).
// No private dialogue, real transport, or utterance-generation assertions (H3).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JEV_ACTIONS} from '../dialogue-model/runtime/decision/contract.ts';
import type {JevAction, JevDecisionInput, JevTarget} from '../dialogue-model/runtime/decision/contract.ts';
import {createJevDecisionClient, JEV_DECISION_MODEL} from '../dialogue-model/runtime/decision/jev-decision.ts';
import type {JevDecisionPayload} from '../dialogue-model/runtime/decision/jev-decision.ts';
import {applyBypassAcceptance, interventionForStrategy, planBypassAcceptance} from '../dialogue-model/runtime/decision/bypass-acceptance.ts';

const repairFirst = interventionForStrategy('repair-first');
const bypassEnabled = interventionForStrategy('bypass-enabled');
const openTarget: JevTarget = {kind: 'single', figureId: 'own-0'};
const nextTarget: JevTarget = {kind: 'single', figureId: 'own-1'};
const none: JevTarget = {kind: 'none'};

function input(previous: 'confirm' | 'repair' | null = 'confirm'): JevDecisionInput {
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

// Stage-one scores are deliberately near one-hot, not calibrated probabilities.
// The same fake client provides ordinary detail evidence when confirm is selected.
function client(target: JevTarget, scores: Partial<Record<JevAction, number>>) {
  return createJevDecisionClient({
    enabled: true,
    readKey: async () => 'sk-or-SYNTHETIC-veto-target-only',
    fetchImpl: async (_url, init) => {
      const p = JSON.parse(init.body as string) as JevDecisionPayload;
      const targetLabel = target.kind === 'single' ? `figure_${target.figureId === 'own-0' ? 0 : 1}` : target.kind;
      const answers = Object.fromEntries(Object.entries(p.questions).map(([key, q]) => {
        const choice = key === 'action' ? 'move_on' : key === 'target' ? targetLabel : key.startsWith('candidate_') ? 'exclude' : Object.keys(q.criteria)[0];
        const probabilities = Object.fromEntries(Object.keys(q.criteria).map(label => [
          label, key === 'action' ? scores[label as JevAction] ?? (label === 'move_on' ? 1 : 0) : Number(label === choice),
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

// Future contract: when B adds the opt-in rerank API, enable it at these calls
// before removing todo. Keep the current tests above on the legacy/default path.
for (const previous of ['confirm', 'repair', null] as const) {
  for (const target of [none, nextTarget]) {
    test(`desired: ${previous ?? 'latest repairHistory'} redirects ${target.kind} to unresolved target and repair-only candidates`,
      {todo: 'PLAN §2.2(b)(c): enable B open-issue rerank option, then remove todo'}, async () => {
        const i = input(previous), c = client(target, {confirm: 0.06, accept: 0.05}), original = await c.decide(i);
        const plan = planBypassAcceptance(i, original, repairFirst);
        assert.deepEqual(plan.rerank!.selected, {action: 'confirm', target: openTarget});
        assert.deepEqual(plan.rerank!.ranking, [{action: 'confirm', score: 0.06}, {action: 'repair', score: 0}, {action: 'revisit', score: 0}]);
        assert.notEqual(plan.rerank!.policyId, 'saved_action_scores_v1');
        const result = await applyBypassAcceptance(i, original, repairFirst, c.completeDetail);
        assert.equal(result.executed.action, 'confirm');
        assert.deepEqual(result.executed.target, openTarget);
        assert.deepEqual(result.executed.detailFigureIds, ['own-0']);
        assert.equal(result.intervention.reasonCode, 'vetoed_bypass_action');
      });
  }
}

test('desired fallback: absent unresolved target preserves current behavior',
  {todo: 'PLAN §2.2(b): run with B open-issue rerank option, then remove todo'}, async () => {
    const i = input(null);
    i.issueSummary = '';
    i.repairHistory = [];
    const c = client(none, {accept: 0.01}), original = await c.decide(i);
    const plan = planBypassAcceptance(i, original, repairFirst);
    assert.deepEqual(plan.rerank!.selected, {action: 'accept', target: none});
    assert.equal(plan.rerank!.policyId, 'saved_action_scores_v1');
    const result = await applyBypassAcceptance(i, original, repairFirst, c.completeDetail);
    assert.equal(result.executed.action, 'accept');
    assert.deepEqual(result.executed.target, none);
  });
