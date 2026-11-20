// audit/05 §5/§6: the saved_action_scores_open_issue_v1 branch under two_stage_v3 (the adaptive formal setting).
// Synthetic input only; the stage-one scores are near one-hot, not calibrated probabilities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { JevAction, JevDecisionInput, JevTarget } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient, JEV_DECISION_MODEL } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { applyBypassAcceptance, interventionForStrategy, planBypassAcceptance, isOpenIssueRerankRecord } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import type { BypassAcceptanceInput, RepairProspectMaterial } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';

const repairFirst = interventionForStrategy('repair-first');
const V3 = { rerank: 'open_issue_v1', questionLayout: 'two_stage_v3' } as const;
const openTarget: JevTarget = { kind: 'single', figureId: 'own-0' };
const otherTarget: JevTarget = { kind: 'single', figureId: 'own-1' };

function input(previous: 'confirm' | 'repair' | null = 'confirm'): BypassAcceptanceInput {
  const i = JSON.parse(readFileSync(new URL('./fixtures/bypass-acceptance/MINIMAL-INPUT.json', import.meta.url), 'utf8')) as JevDecisionInput;
  i.turn = 3;
  i.publicTurns = [{ turn: 1, speaker: 'ai', text: 'Does this shape have an upper point?' }, { turn: 2, speaker: 'human', text: 'I cannot tell which point you mean.' },
    { turn: 3, speaker: 'human', text: 'Can we check that part again?' }];
  i.issueSummary = 'The upper point remains unresolved.';
  i.previousAction = previous === null ? null : { turn: 1, action: previous, target: structuredClone(openTarget), name: null, feature: 'feature-0' };
  i.repairHistory = [{ turn: 1, issueId: 'synthetic-open-issue', action: previous ?? 'confirm', question: 'Does this shape have an upper point?', partnerClaims: [],
    candidatesBefore: ['own-0'], candidatesAfter: ['own-0'], addedClaimIds: [], removedClaimIds: [], progress: 'unchanged' }];
  return i;
}
const material = (issue: Extract<RepairProspectMaterial, { status: 'ok' }>['issue'] = { choice: 'issue', turn: 1, issueId: 'synthetic-open-issue' }) => ({ status: 'ok', issue, prospect: 'uncertain', basis: 'partner_uncertain',
  scores: { repair_issue: { issue_0: 0.8, none: 0.1, unknown: 0.1 }, prospect: { progressing: 0.1, stalled: 0.1, uncertain: 0.8, no_open_issue: 0 },
    basis: { new_information: 0, candidate_narrowed: 0, candidate_widened: 0, repetition: 0.1, partner_uncertain: 0.9, other_figure_benefit: 0, none: 0 } } }) as Extract<RepairProspectMaterial, { status: 'ok' }>;
const withIssue = (previous: 'confirm' | 'repair' | null = 'confirm'): BypassAcceptanceInput => ({ ...input(previous), repairProspect: material() });

const labelOf = (t: JevTarget) => t.kind === 'none' ? 'none' : t.kind === 'single' ? `figure_${t.figureId.slice(4)}` : `figures_${t.figureIds.map(id => id.slice(4)).join('_')}`;
/** Two-stage v3 answers: stage one scores the actions as given, stage two picks the target, detail takes the first label. */
function client(target: JevTarget, scores: Partial<Record<JevAction, number>>, action: 'move_on' | 'defer' = 'move_on') {
  return createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-v3-open-issue-only', questionLayout: 'two_stage_v3',
    fetchImpl: async (_url, init) => {
      const p = JSON.parse(init.body as string) as JevDecisionPayload;
      const answers = Object.fromEntries(Object.entries(p.questions).map(([key, q]) => {
        const labels = Object.keys(q.criteria);
        const choice = key === 'action' ? action : key === 'target' ? labelOf(target) : labels[0];
        const probabilities = Object.fromEntries(labels.map(l => [l, key === 'action' ? scores[l as JevAction] ?? (l === action ? 1 : 0) : Number(l === choice)]));
        return [key, { type: 'choice', choice, probabilities }];
      }));
      return new Response(JSON.stringify({ model: JEV_DECISION_MODEL, id: 'gen-synthetic-v3-open', usage: { cost: 0 }, answers }));
    } })!;
}

test('open issue v3: the issue candidates become the target, repair and confirm are ranked, and the record verifies as v3', async () => {
  const i = withIssue(), c = client({ kind: 'none' }, { confirm: 0.6, repair: 0.2, accept: 0.01 }), original = await c.decide(i);
  const p = planBypassAcceptance(i, original, repairFirst, V3);
  assert.equal(p.rerank!.policyId, 'saved_action_scores_open_issue_v1');
  assert.deepEqual(p.rerank!.ranking.map(r => r.action), ['confirm', 'repair']);
  assert.deepEqual(p.rerank!.selected, { action: 'confirm', target: openTarget });
  assert.deepEqual((p.rerank as any).source, { issueTurn: 1, issueId: 'synthetic-open-issue', choice: 'issue', candidates: ['own-0'] });
  const r = await applyBypassAcceptance(i, original, repairFirst, async (inp, selected) => {
    const detail = createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-v3-open-issue-only', questionLayout: 'two_stage_v3',
      fetchImpl: async (_u, init) => { const q = JSON.parse(init.body as string) as JevDecisionPayload;
        return new Response(JSON.stringify({ model: JEV_DECISION_MODEL, id: 'gen-d', usage: { cost: 0 }, answers: Object.fromEntries(Object.entries(q.questions).map(([k, v]) => {
          const labels = Object.keys(v.criteria); return [k, { type: 'choice', choice: labels[0], probabilities: Object.fromEntries(labels.map((l, n) => [l, Number(n === 0)])) }]; })) })); } })!;
    return detail.completeDetail(inp, selected);
  }, V3);
  assert.equal(r.executed.action, 'confirm');
  assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, i.previousAction, undefined, 'two_stage_v3'), true);
  // The v3 stage-one scores cannot be read as a v2 record, nor a v2 record as v3.
  assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, i.previousAction, undefined, 'two_stage_v2'), false);
});

for (const previous of [null, 'confirm', 'repair', 'defer-other', 'defer-same', 'accept-same'] as const) {
  test(`open issue v3: revisit eligibility after ${previous ?? 'no previous action'} (a vetoed original is never evidence)`, async () => {
    const i = withIssue();
    const action = previous === 'defer-other' || previous === 'defer-same' ? 'defer' : previous === 'accept-same' ? 'accept' : previous;
    i.previousAction = previous === null ? null : { ...i.previousAction!, action: action as JevAction, target: previous === 'defer-other' ? otherTarget : openTarget, feature: ['confirm', 'repair'].includes(action!) ? 'feature-0' : null };
    const c = client({ kind: 'none' }, { revisit: 0.9, confirm: 0.2, repair: 0.1 }), original = await c.decide(i);
    const p = planBypassAcceptance(i, original, repairFirst, V3);
    assert.equal(p.rerank!.ranking.some(r => r.action === 'revisit'), previous === 'defer-same');
    if (previous === 'defer-same') {
      const r = await applyBypassAcceptance(i, original, repairFirst, undefined, V3);
      assert.deepEqual(r.executed, { action: 'revisit', target: openTarget, name: null, feature: null, observe: null, detailFigureIds: [] });
      assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, i.previousAction, undefined, 'two_stage_v3'), true);
      assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, undefined, undefined, 'two_stage_v3'), false);
      assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, { ...i.previousAction!, target: otherTarget }, undefined, 'two_stage_v3'), false);
    }
  });
}

test('open issue v3: revisit x multiple keeps the issue candidate set (order and members) and is verified', async () => {
  const i = withIssue();
  i.repairHistory = [{ ...i.repairHistory[0], candidatesAfter: ['own-2', 'own-0'] }];
  i.previousAction = { ...i.previousAction!, action: 'defer', target: { kind: 'multiple', figureIds: ['own-0', 'own-2'] }, feature: null };
  const c = client({ kind: 'none' }, { revisit: 0.9 }), original = await c.decide(i);
  const r = await applyBypassAcceptance(i, original, repairFirst, undefined, V3);
  assert.deepEqual(r.executed.target, { kind: 'multiple', figureIds: ['own-2', 'own-0'] });
  assert.equal(r.executed.action, 'revisit');
  assert.equal(isOpenIssueRerankRecord(r.intervention, original, r.executed, i.ownSlots, i.previousAction, undefined, 'two_stage_v3'), true);
  const swapped = structuredClone(r.intervention) as any; swapped.rerank.source.candidates = ['own-0', 'own-3'];
  assert.equal(isOpenIssueRerankRecord(swapped, original, r.executed, i.ownSlots, i.previousAction, undefined, 'two_stage_v3'), false);
});

test('open issue v3: tied scores follow the JEV_ACTIONS order; a source swapped to another issue is refused', async () => {
  const i = withIssue(), c = client({ kind: 'none' }, { confirm: 0.5, repair: 0.5 }), original = await c.decide(i);
  const p = planBypassAcceptance(i, original, repairFirst, V3);
  assert.deepEqual(p.rerank!.ranking.map(r => r.action), ['confirm', 'repair']);
  const wrong = { ...i, repairProspect: material({ choice: 'issue', turn: 1, issueId: 'another-issue' }) };
  assert.throws(() => planBypassAcceptance(wrong, original, repairFirst, V3), (e: any) => e.code === 'invalid_original' || e.code === 'invalid_input');
});

for (const [name, prospect] of [['absent', undefined], ['none choice', material({ choice: 'none' })]] as const) {
  test(`open issue v3 fallback: ${name} equals the saved-action rerank of the original target`, async () => {
    const i = { ...input(), ...(prospect === undefined ? {} : { repairProspect: prospect }) } as BypassAcceptanceInput;
    const c = client({ kind: 'single', figureId: 'own-1' }, { confirm: 0.6, repair: 0.2, accept: 0.1, revisit: 0.05 }), original = await c.decide(i);
    const open = planBypassAcceptance(i, original, repairFirst, V3), plain = planBypassAcceptance(i, original, repairFirst, { questionLayout: 'two_stage_v3' });
    assert.deepEqual(open, plain);
    assert.equal(open.rerank!.policyId, 'saved_action_scores_v1');
    assert.deepEqual(open.rerank!.selected!.target, otherTarget);
  });
}
