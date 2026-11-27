import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JEV_VISUAL_PURPOSE_VERSION } from '../dialogue-model/runtime/decision/contract.ts';
import type { JevDecisionInput, JevTarget } from '../dialogue-model/runtime/decision/contract.ts';
import {
  buildJevDecisionPayload, buildJevDecisionDetailPayload, buildJevTargetPayload, checkDecisionFailureEvidence,
  buildJevDraftActPayload, createJevDecisionClient, JEV_DECISION_MODEL, projectDecisionFailureEvidence, validateJevDecision,
} from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { applyIssueHandling, ISSUE_HANDLING_VERSION, JEV_ACTIONS_V21, issueHandlingMatchesSource,
  previousIssueHandlingTransition, projectExtraHandling } from '../dialogue-model/runtime/decision/issue-handling.ts';
import { JEV_REPAIR_QUALITY_VERSION } from '../dialogue-model/runtime/decision/repair-quality.ts';
import { SHAPE_TERMINOLOGY_GENERATION } from '../dialogue-model/runtime/shape-terminology.ts';
import type { LocalClaimView } from '../dialogue-model/runtime/local-grounding/contract.ts';

const layout = { questionLayout: 'two_stage_v3' as const };
const context = { ...layout, dialoguePolicy: 'holistic_v5' as const };
const none = { kind: 'none' } as const;
const base = JSON.parse(readFileSync(new URL('./fixtures/bypass-acceptance/MINIMAL-INPUT.json', import.meta.url), 'utf8')) as JevDecisionInput;
const scoped = (figureId: string): JevTarget => ({ kind: 'single', figureId });
const humanQuestion = 'ひとつ前の形は、細い台と丸い部分がつながっていますか？';

function input(count = 4): JevDecisionInput {
  const copy = structuredClone(base);
  const slots = ['s-000a', 's-000b', 's-000c', 's-000d', 's-000e', 's-000f'].slice(0, count);
  return { ...copy, turn: 40, ownSlots: slots,
    observations: { ...copy.observations, figures: copy.observations.figures.slice(0, count).map((figure, i) => ({ ...figure, id: slots[i] })) },
    publicTurns: [{ turn: 40, speaker: 'human', text: humanQuestion }], priorClaims: [],
    repairHistory: [], previousAction: null, judgmentLedger: [], publicNames: [],
    visualPurposeVersion: JEV_VISUAL_PURPOSE_VERSION, p5Enabled: true,
    judgmentMaterialVersion: JEV_REPAIR_QUALITY_VERSION, issueHandlingVersion: ISSUE_HANDLING_VERSION,
    shapeTerminologyVersion: SHAPE_TERMINOLOGY_GENERATION };
}

function claim(turn: number, targets: string[], overrides: Partial<LocalClaimView> = {}): LocalClaimView {
  const id = `${turn}:local0`;
  return { id, turn, sourceTurn: turn, issueId: id, targets, name: null, aspect: 'question', act: 'ask',
    proposition: humanQuestion, quote: humanQuestion, speaker: 'human', respondsTo: null, source: 'partner_statement', ...overrides };
}

test('v21 has closed action, target and detail menus across both supported board sizes', () => {
  for (const count of [4, 6]) {
    const i = input(count), first = buildJevDecisionPayload(i, context);
    assert.deepEqual(Object.keys(first.questions), ['action', 'human_move_on_source', 'commitment_state']);
    assert.ok(Object.keys(first.questions.action.criteria).every(label => JEV_ACTIONS_V21.some(action => action === label)));
    assert.equal(Object.hasOwn(first.questions.action.criteria, 'defer'), false);
    assert.equal(Object.hasOwn(first.questions.action.criteria, 'move_on'), false);
    for (const [action, keys, permitsNone] of [
      ['hold_open', ['handled_issue', 'non_bypass_alternative'], true],
      ['carry_over', ['handled_issue', 'carry_destination', 'non_bypass_alternative'], true],
      ['consult', ['handled_issue'], true],
      ['revisit', ['handled_issue', 'switch_function', 'non_bypass_alternative'], false],
      ['confirm', ['visual_purpose'], false], ['repair', ['visual_purpose'], false], ['close', [], true],
    ] as const) {
      const targets = buildJevTargetPayload(i, action).questions.target.criteria;
      assert.equal(Object.keys(targets).length, 2 ** count - Number(!permitsNone));
      assert.equal(Object.hasOwn(targets, 'none'), permitsNone);
      if (!permitsNone) assert.throws(() => buildJevDecisionDetailPayload(i, { action, target: none }, layout));
      const detail = buildJevDecisionDetailPayload(i, { action, target: scoped(i.ownSlots[0]) }, layout);
      assert.deepEqual(Object.keys(detail?.questions ?? {}), keys);
      if (detail?.questions.non_bypass_alternative) assert.deepEqual(Object.keys(detail.questions.non_bypass_alternative.criteria), ['confirm', 'repair', 'consult']);
    }
  }
});

test('handled_issue accepts a current unscoped public claim and leaves v19 visual_purpose scoped', () => {
  const i = input(), target = scoped(i.ownSlots[0]);
  const current = claim(40, []);
  i.publicTurns = [{ turn: 38, speaker: 'human', text: humanQuestion }, { turn: 39, speaker: 'human', text: humanQuestion }, ...i.publicTurns];
  i.priorClaims = [claim(38, []), claim(39, [i.ownSlots[0]]), current,
    claim(40, [], { id: '40:local1', issueId: '40:local1', aspect: 'progress', act: 'assert' }),
    claim(40, [], { id: '40:local2', issueId: '40:local2', act: 'withdraw' })];
  const detail = buildJevDecisionDetailPayload(i, { action: 'hold_open', target }, layout)!;
  const issued = Object.entries(detail.questions.handled_issue.criteria).filter(([key]) => key.startsWith('issue_')).map(([, value]) => JSON.parse(value).claimId);
  assert.deepEqual(issued, ['39:local0', current.id]);
  assert.equal(issueHandlingMatchesSource(JSON.parse(detail.questions.handled_issue.criteria.issue_1), target, 40, current), true);
  const confirm = buildJevDecisionDetailPayload(i, { action: 'confirm', target }, layout)!;
  assert.equal(JSON.parse(confirm.questions.visual_purpose.criteria.issue_0).claimId, '39:local0');
  assert.equal(Object.hasOwn(confirm.questions.visual_purpose.criteria, 'issue_1'), false);
});

test('carry destinations derive from executed open issues, live sources and the name ledger', () => {
  for (const count of [4, 6]) {
    const i = input(count), [a, b, c, d] = i.ownSlots;
    const claims = [claim(1, [a]), claim(3, [b]), claim(5, [c, d]), claim(7, [c]), claim(9, [d])];
    const closed = claim(11, [d], { issueId: claims[4].issueId, aspect: 'part', act: 'agree' });
    i.priorClaims = [...claims, closed];
    i.publicTurns = [...i.priorClaims.map(({ sourceTurn, quote }) => ({ turn: sourceTurn, speaker: 'human' as const, text: quote })), ...i.publicTurns];
    i.judgmentLedger = claims.map(source => ({ turn: source.sourceTurn, action: 'hold_open', target: scoped(source.targets[0]), name: null,
      feature: null, issue: { kind: 'resolve_issue', issueId: source.issueId, claimId: source.id, sourceTurn: source.sourceTurn } }));
    i.nameLedger = Object.fromEntries(i.ownSlots.map(id => [id, id === b || id === c
      ? { status: 'agreed' as const, name: id } : { status: 'unassigned' as const, name: null }]));
    const target = scoped(a);
    const detail = buildJevDecisionDetailPayload(i, { action: 'carry_over', target }, layout)!;
    const { criteria } = detail.questions.carry_destination;
    assert.deepEqual(Object.keys(criteria), ['partner_choice', 'figure_3', ...(count === 6 ? ['figure_4', 'figure_5'] : []),
      'same_figure_naming', 'same_figure_other_issue', 'old_0']);
    assert.deepEqual(JSON.parse(criteria.old_0), { kind: 'old_issue', issue: { kind: 'resolve_issue', issueId: claims[2].issueId,
      claimId: claims[2].id, sourceTurn: 5 }, targets: [c, d] });
    const state = JSON.parse(detail.state);
    assert.deepEqual(state.handlings[0], [1, 'hold_open', ['f0'], claims[0].issueId, null]);
    assert.deepEqual(state.figures.f0.actions[0], ['hold_open', 1]);
  }
});

test('compact v21 material keeps the latest sixteen published handlings and offers the newest eight eligible old issues', () => {
  const i = input(), [a, b] = i.ownSlots;
  i.priorClaims = Array.from({ length: 17 }, (_, index) => claim(index * 2 + 1, [b]));
  i.publicTurns = [...i.priorClaims.map(({ sourceTurn, quote }) => ({ turn: sourceTurn, speaker: 'human' as const, text: quote })), ...i.publicTurns];
  i.judgmentLedger = i.priorClaims.map(source => ({ turn: source.sourceTurn, action: 'hold_open', target: scoped(b), name: null,
    feature: null, issue: { kind: 'resolve_issue', issueId: source.issueId, claimId: source.id, sourceTurn: source.sourceTurn } }));
  const detail = buildJevDecisionDetailPayload(i, { action: 'carry_over', target: scoped(a) }, layout)!;
  assert.deepEqual(JSON.parse(detail.state).handlings.map((row: unknown[]) => row[0]), Array.from({ length: 16 }, (_, index) => index * 2 + 3));
  assert.deepEqual(Object.entries(detail.questions.carry_destination.criteria).filter(([key]) => key.startsWith('old_'))
    .map(([, value]) => JSON.parse(value).issue.sourceTurn), [33, 31, 29, 27, 25, 23, 21, 19]);
});

test('the hypothetical repair withdrawal follows the unresolved subject instead of the revisit destination', () => {
  const i = input(), [a, b] = i.ownSlots;
  i.publicationRecoveryContext = { reason: 'naming_conflict', previous: { action: 'agree', target: scoped(a), name: '輪', feature: null } };
  i.nameLedger = Object.fromEntries(i.ownSlots.map(id => [id, id === a ? { status: 'agreed', name: '輪' } : { status: 'unassigned', name: null }]));
  i.publicTurns = [{ turn: 37, speaker: 'human', text: 'まだどの形か分かりません。' },
    { turn: 38, speaker: 'ai', text: '台のある形はどうでしょうか？' }, ...i.publicTurns];
  i.previousAction = { turn: 38, decisionTurn: 37, action: 'confirm', target: scoped(a), name: null, feature: null,
    visualPurpose: { kind: 'clarify_reference' } };
  const revisit = { action: 'revisit', target: scoped(b) } as const;
  const detail = buildJevDecisionDetailPayload(i, revisit, layout)!;
  assert.ok(detail.questions.naming_withdrawal.criteria.withdraw_prior_name.includes(a));
  assert.equal(JSON.parse(detail.state).previousAction.decisionTurn, undefined);
  assert.equal(JSON.parse(detail.state).previousAction.visualPurpose, undefined);
  i.previousAction = null;
  assert.equal(buildJevDecisionDetailPayload(i, revisit, layout)!.questions.naming_withdrawal, undefined);
  const act = { turn: i.turn, publicTurns: i.publicTurns, reasons: ['naming_request'], draft: 'まだはっきりしません。',
    selected: { action: 'hold_open' as const, target: scoped(a), name: null }, semanticNaming: { currentTurnSource: false } };
  assert.throws(() => buildJevDraftActPayload(act, 'holistic_v5'));
  assert.equal(JSON.parse(buildJevDraftActPayload({ ...act, issueHandlingVersion: ISSUE_HANDLING_VERSION }, 'holistic_v5').state).selected.action,
    'hold_open');
});

test('recovery accepts the inherited public source of a replaced action on its original subject', () => {
  const i = input(), [a, b] = i.ownSlots;
  const source = claim(37, []);
  i.publicTurns = [{ turn: 37, speaker: 'human', text: source.quote },
    { turn: 38, speaker: 'ai', text: '台があるようにも見えますね。' }, ...i.publicTurns];
  i.priorClaims = [source];
  const issue = { kind: 'resolve_issue', issueId: source.issueId, claimId: source.id, sourceTurn: source.sourceTurn } as const;
  i.previousAction = { turn: 38, decisionTurn: 37, action: 'hold_open', target: scoped(a), name: null, feature: null, issue };
  i.publicationRecoveryContext = { reason: 'publication_mismatch', previous: { action: 'confirm', target: scoped(a), name: null,
    feature: null, visualPurpose: issue } };
  assert.ok(buildJevDecisionPayload(i, context).questions.publication_continuation);
  i.publicationRecoveryContext.previous.target = scoped(b);
  assert.throws(() => buildJevDecisionPayload(i, context));
});

function simulate(chosenAction: string, overrides: Record<string, string> = {},
  intercept?: (payload: JevDecisionPayload) => Response | undefined) {
  const bodies: string[] = [];
  const client = createJevDecisionClient({ enabled: true, questionLayout: 'two_stage_v3',
    readKey: async () => 'sk-or-SYNTHETIC-issue-handling-only', fetchImpl: async (_url, req) => {
      const body = String(req?.body);
      bodies.push(body);
      const payload = JSON.parse(body) as JevDecisionPayload;
      const intercepted = intercept?.(payload);
      if (intercepted) return intercepted;
      const { questions } = payload;
      const choices: Record<string, string> = { action: chosenAction, target: 'none', commitment_state: 'insufficient', human_move_on_source: 'other',
        handled_issue: 'unknown', non_bypass_alternative: 'repair', ...overrides };
      const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => {
        const labels = Object.keys(question.criteria), choice = choices[key] ?? labels[0];
        assert.ok(labels.includes(choice), key);
        return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
      }));
      return Response.json({ answers, model: JEV_DECISION_MODEL, usage: { cost: 0 } });
    } })!;
  return { client, bodies };
}

test('both strategies send identical Jev bytes and execute the same detail-stage alternative without another POST', async () => {
  const i = input(), a = simulate('hold_open'), b = simulate('hold_open');
  const originalA = validateJevDecision(await a.client.decide(i, context), i, layout);
  const originalB = validateJevDecision(await b.client.decide(i, context), i, layout);
  const first = applyIssueHandling(i, originalA, 'repair-first');
  const second = applyIssueHandling(i, originalB, 'bypass-enabled');
  assert.equal(first.executed.action, 'repair');
  assert.equal(second.executed.action, 'hold_open');
  assert.equal(a.bodies.length, 3);
  assert.deepEqual(a.bodies, b.bodies);
  assert.throws(() => validateJevDecision({ ...originalA, issue: { kind: 'resolve_mismatch' } }, i, layout));
});

test('v21 stage-three timeout retains closed evidence and cannot be read under v20', async t => {
  let measuredMs = 0;
  t.mock.method(performance, 'now', () => measuredMs);
  const i = input(), { client } = simulate('hold_open', {}, ({ questions }) => {
    if (!questions.handled_issue) return;
    measuredMs += 50000;
    return new Response(null, { status: 502 });
  });
  let raw: unknown;
  await assert.rejects(client.decide(i, { ...context, timeoutMs: 1000, onFailureEvidence: evidence => { raw = evidence; } }), { code: 'timeout' });
  const opts = { issueHandlingVersion: ISSUE_HANDLING_VERSION, figureCount: 4 } as const;
  const projected = projectDecisionFailureEvidence(raw, layout.questionLayout, opts);
  assert.ok(projected);
  assert.deepEqual(projected.stages.map(({ stage, status }) => [stage, status]), [['action', 'ok'], ['target', 'ok'], ['detail', 'error']]);
  assert.equal(checkDecisionFailureEvidence(projected, { humanLedMoveOn: true, figureCount: 4, visualPurpose: true, p5Enabled: true }), null);
  const changed = structuredClone(projected);
  changed.stages[0].scores.commitment_state.extra = 1;
  assert.equal(checkDecisionFailureEvidence(changed, opts), null);
});

function currentIssues(count = 4) {
  const i = input(count);
  const questions = ['台と丸い部分がつながっていますか？', '先端が曲がっていますか？',
    '羽は二枚ですか？', 'その部分を言い直せますか？'];
  i.publicTurns = [{ turn: 40, speaker: 'human', text: questions.join('\n') }];
  i.priorClaims = questions.map((quote, index) => claim(40, index < 3 ? [i.ownSlots[index]] : [], {
    id: `40:local${index}`, issueId: `40:local${index}`, quote, proposition: quote,
  }));
  return i;
}

const confirmMain = { target: 'figure_0', visual_purpose: 'issue_0' };
const extraStage = (body: string): JevDecisionPayload => JSON.parse(body);

test('a bound primary makes one closed extra request and keeps leave only in the stage evidence', async () => {
  const i = currentIssues(), a = simulate('confirm', { ...confirmMain, extra_0: 'hold_open', extra_1: 'repair',
    extra_2: 'leave', extra_alt_0: 'confirm', extra_alt_1: 'consult', extra_alt_2: 'repair' });
  const decision = validateJevDecision(await a.client.decide(i, context), i, layout);
  assert.equal(a.bodies.length, 4);
  const third = extraStage(a.bodies[2]), fourth = extraStage(a.bodies[3]);
  const { selected: previousSelection, ...material } = JSON.parse(third.state);
  const { selected, ...extraMaterial } = JSON.parse(fourth.state);
  assert.equal(previousSelection.action, 'confirm');
  assert.deepEqual(extraMaterial, material);
  assert.deepEqual(selected, { action: 'confirm', target: scoped(i.ownSlots[0]), visualPurpose: decision.visualPurpose });
  assert.deepEqual(Object.keys(fourth.questions), ['extra_0', 'extra_alt_0', 'extra_1', 'extra_alt_1', 'extra_2', 'extra_alt_2']);
  assert.deepEqual(Object.keys(fourth.questions.extra_0.criteria), ['leave', 'confirm', 'repair', 'hold_open']);
  assert.deepEqual(Object.keys(fourth.questions.extra_2.criteria), ['leave', 'hold_open']);
  assert.ok(fourth.questions.extra_0.instructions.includes(i.priorClaims[1].quote));
  assert.ok(fourth.questions.extra_0.instructions.includes('"targets":["f1"]'));
  assert.equal(decision.evidence.stages?.at(-1)?.choices.extra_2, 'leave');
  assert.deepEqual(decision.extras?.map(({ index, original }) => [index, original.action]), [[0, 'hold_open'], [1, 'repair']]);
  const allow = applyIssueHandling(i, decision, 'bypass-enabled');
  const repair = applyIssueHandling(i, decision, 'repair-first');
  assert.deepEqual(allow.executed.extras?.map(x => x.action), ['hold_open', 'repair']);
  assert.deepEqual(repair.executed.extras?.map(x => x.action), ['confirm', 'repair']);
  assert.deepEqual(repair.intervention.extras?.map(x => [x.reasonCode, x.handling.alternative]),
    [['vetoed_issue_handling', 'confirm'], ['not_in_veto_set', null]]);
  assert.deepEqual(allow.intervention.extras?.map(x => x.reasonCode), ['no_intervention', 'no_intervention']);
  const direct = simulate('confirm', { ...confirmMain, extra_0: 'confirm', extra_1: 'repair' });
  const directDecision = validateJevDecision(await direct.client.decide(i, context), i, layout);
  assert.deepEqual(direct.bodies, a.bodies);
  assert.deepEqual(applyIssueHandling(i, directDecision, 'bypass-enabled').executed, repair.executed);

  const leave = simulate('confirm', confirmMain);
  const left = validateJevDecision(await leave.client.decide(i, context), i, layout);
  assert.equal(left.evidence.stages?.at(-1)?.stage, 'extras');
  assert.equal(Object.hasOwn(left, 'extras'), false);
  assert.equal(Object.hasOwn(applyIssueHandling(i, left, 'repair-first').intervention, 'extras'), false);
  const removed = structuredClone(left);
  removed.evidence.stages!.pop();
  assert.throws(() => validateJevDecision(removed, i, layout), { code: 'invalid_response' });
  const forged = structuredClone(decision);
  forged.extras![1].original.target = scoped(i.ownSlots[0]);
  assert.throws(() => validateJevDecision(forged, i, layout), { code: 'inconsistent_decision' });
});

test('unscoped extras use all own figures only for a vetoed visual alternative and leave the primary choice intact', async () => {
  for (const count of [4, 6]) {
    const i = currentIssues(count), a = simulate('confirm', { ...confirmMain, extra_2: 'hold_open', extra_alt_2: 'repair' });
    const decision = validateJevDecision(await a.client.decide(i, context), i, layout);
    const allow = applyIssueHandling(i, decision, 'bypass-enabled'),
      veto = applyIssueHandling(i, decision, 'repair-first');
    assert.deepEqual(allow.executed.extras?.[0].target, none);
    assert.deepEqual(veto.executed.extras?.[0].target, { kind: 'multiple', figureIds: i.ownSlots });
    assert.deepEqual(veto.executed.target, allow.executed.target);
  }
});

test('current and destination scopes suppress duplicate or incompatible issue choices', async () => {
  const i = currentIssues(), [a, b] = i.ownSlots;
  i.publicTurns = [{ ...i.publicTurns[0], text: i.publicTurns[0].text + '\n丸い台と呼びましょう。' }];
  i.publicNames = [{ name: '丸い台', sourceTurn: 40, figureId: a }];
  i.agreeNames = [...i.publicNames];
  for (const [action, overrides, wanted] of [
    ['agree', { target: 'figure_0' }, [1, 2, 3]],
    ['hold_open', { target: 'figure_1' }, [0, 2]],
    ['hold_open', { target: 'none' }, []],
    ['carry_over', { target: 'figure_0', carry_destination: 'partner_choice' }, []],
    ['carry_over', { target: 'figure_0', carry_destination: 'same_figure_naming' }, []],
    ['carry_over', { target: 'figure_0', carry_destination: 'same_figure_other_issue' }, []],
    ['close', {}, []],
  ] as const) {
    const script = simulate(action, overrides), decision = await script.client.decide(i, context);
    validateJevDecision(decision, i, layout);
    const last = script.bodies.map(extraStage).at(-1)!;
    assert.equal(decision.evidence.stages?.at(-1)?.stage === 'extras', !!wanted.length);
    for (const [index, source] of wanted.entries()) assert.ok(last.questions[`extra_${index}`].instructions.includes(i.priorClaims[source].quote));
    assert.equal(Object.keys(last.questions).filter(key => /^extra_\d+$/u.test(key)).length, wanted.length);
  }
  i.priorClaims = [...i.priorClaims, claim(39, [b], { id: '39:extra', issueId: '39:extra', quote: '角が丸いですか？' })];
  i.publicTurns = [{ turn: 39, speaker: 'human', text: '角が丸いですか？' }, ...i.publicTurns];
  const revisit = simulate('revisit', { target: 'figure_1', handled_issue: 'issue_0', switch_function: 'resolve_old_issue' });
  const visited = validateJevDecision(await revisit.client.decide(i, context), i, layout);
  assert.equal(visited.issue?.kind === 'resolve_issue' && visited.issue.issueId, '40:local1');
  const last = extraStage(revisit.bodies.at(-1)!);
  assert.deepEqual(Object.keys(last.questions), ['extra_0']);
  assert.ok(last.questions.extra_0.instructions.includes('角が丸いですか？'));
});

test('carry-over keeps destination extras when adopted and drops them when its movement is vetoed', async () => {
  const i = currentIssues();
  for (const source of ['other', 'human_request']) {
    const simulated = simulate('carry_over', { target: 'figure_0', handled_issue: 'issue_0', carry_destination: 'figure_2',
      human_move_on_source: source, extra_0: 'confirm' });
    const decision = validateJevDecision(await simulated.client.decide(i, context), i, layout);
    const last = extraStage(simulated.bodies.at(-1)!);
    assert.deepEqual(Object.keys(last.questions), ['extra_0']);
    assert.deepEqual(Object.keys(last.questions.extra_0.criteria), ['leave', 'confirm', 'repair']);
    assert.ok(last.questions.extra_0.instructions.includes(i.priorClaims[2].quote));
    assert.equal(applyIssueHandling(i, decision, 'bypass-enabled').executed.extras?.length, 1);
    const repair = applyIssueHandling(i, decision, 'repair-first');
    assert.equal(repair.executed.extras?.length, source === 'human_request' ? 1 : undefined);
    assert.equal(repair.intervention.extras?.[0].reasonCode, source === 'human_request' ? 'not_in_veto_set' : 'primary_move_rejected');
  }
});

test('ordinary and recovery decisions use the first retained issue order and the latest usable proof', async () => {
  const i = currentIssues(), oldFirst = claim(37, i.priorClaims[1].targets, { issueId: i.priorClaims[1].issueId });
  i.publicTurns = [{ turn: 37, speaker: 'human', text: oldFirst.quote }, ...i.publicTurns];
  i.priorClaims = [oldFirst, ...i.priorClaims];
  for (const recovery of [false, true]) {
    if (recovery) i.publicationRecoveryContext = { reason: 'publication_mismatch', previous: {
      action: 'confirm', target: scoped(i.ownSlots[0]), name: null, feature: null, visualPurpose: { kind: 'unknown' },
    } };
    const scripted = simulate('accept', { extra_0: 'confirm' });
    const decision = validateJevDecision(await scripted.client.decide(i, context), i, layout);
    assert.deepEqual(decision.evidence.stages?.map(stage => stage.stage), ['action', 'target', 'extras']);
    assert.equal(Object.hasOwn(extraStage(scripted.bodies[0]).questions, 'publication_continuation'), recovery);
    assert.ok(extraStage(scripted.bodies[2]).questions.extra_0.instructions.includes(i.priorClaims[2].quote));
    assert.ok(extraStage(scripted.bodies[2]).questions.extra_1.instructions.includes(i.priorClaims[1].quote));
    assert.deepEqual(decision.extras?.[0].original, projectExtraHandling('confirm', scoped(i.ownSlots[1]),
      { kind: 'resolve_issue', issueId: oldFirst.issueId, claimId: i.priorClaims[2].id, sourceTurn: 40 }));
  }
});

test('extra timeouts and incomplete answers fail the decision and retain the attempted stage', async t => {
  let measuredMs = 0;
  t.mock.method(performance, 'now', () => measuredMs);
  for (const [code, response] of [
    ['timeout', () => { measuredMs += 50000; return new Response(null, { status: 502 }); }],
    ['invalid_response', () => Response.json({ answers: {}, model: JEV_DECISION_MODEL, usage: { cost: 0 } })],
  ] as const) {
    const i = currentIssues(), simulated = simulate('confirm', confirmMain, ({ questions }) => questions.extra_0 ? response() : undefined);
    let raw: unknown;
    await assert.rejects(simulated.client.decide(i, { ...context, timeoutMs: 1000, onFailureEvidence: evidence => { raw = evidence; } }), { code });
    const opts = { issueHandlingVersion: ISSUE_HANDLING_VERSION, figureCount: 4, visualPurpose: true } as const;
    const projected = projectDecisionFailureEvidence(raw, layout.questionLayout, opts);
    assert.ok(projected);
    assert.equal(simulated.bodies.length, 4);
    assert.deepEqual(projected.stages.map(stage => [stage.stage, stage.status]), [
      ['action', 'ok'], ['target', 'ok'], ['detail', 'ok'], ['extras', 'error'],
    ]);
    assert.equal(checkDecisionFailureEvidence(projected, { visualPurpose: true, figureCount: 4 }), null);
    const forged = structuredClone(projected);
    forged.stages.splice(2, 1);
    assert.equal(checkDecisionFailureEvidence(forged, opts), null);
  }
});

test('next-turn judgment exposes only published extras and records same-turn handlings in execution order', () => {
  const i = currentIssues(), [a, b, c, d] = i.ownSlots;
  const sources = [a, b, c, d].map((id, index) => claim(37, [id], { id: `37:claim${index}`, issueId: `37:issue${index}` }));
  const issues = sources.map(({ issueId, id, sourceTurn }) => ({ kind: 'resolve_issue' as const, issueId, claimId: id, sourceTurn }));
  i.publicTurns = [{ turn: 37, speaker: 'human', text: humanQuestion },
    { turn: 38, speaker: 'ai', text: '次の形に移りましょう。' }, ...i.publicTurns];
  i.priorClaims = [...sources, ...i.priorClaims];
  i.previousAction = previousIssueHandlingTransition(38, 37);
  i.judgmentLedger = [{ turn: 37, action: 'hold_open', target: scoped(a), name: null, feature: null,
    issue: issues[0], extras: [projectExtraHandling('confirm', scoped(b), issues[1]), projectExtraHandling('consult', scoped(c), issues[2]),
      projectExtraHandling('hold_open', scoped(d), issues[3])] }];
  const state = JSON.parse(buildJevDecisionPayload(i, context).state);
  assert.deepEqual(state.previousAction, { turn: 38, action: 'carry_over', target: none, name: null, feature: null,
    issue: { kind: 'unknown' }, destination: { kind: 'partner_choice' } });
  assert.deepEqual(state.previousExtras, [['confirm', ['f1'], issues[1].issueId], ['consult', ['f2'], issues[2].issueId],
    ['hold_open', ['f3'], issues[3].issueId]]);
  assert.deepEqual(state.handlings, [[37, 'hold_open', ['f0'], issues[0].issueId, null], [37, 'consult', ['f2'], issues[2].issueId, null],
    [37, 'hold_open', ['f3'], issues[3].issueId, null]]);
  assert.deepEqual(state.figures.f1.actions, []);
});
