// Engineering-only audit of provisional synthetic labels; no researcher approval.
// These checks cannot establish semantic validity or experimental generalisation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, STRATA, LABEL_DIFF_TABLE, EVAL_NOTICE, buildCaseState } from '../dialogue-model/runtime/decisions-eval/cases.mjs';
import { scoreResults, scoreBaselines } from '../dialogue-model/runtime/decisions-eval/score.mjs';
import { DECISION_ACTIONS } from '../workers/research-ai-proxy/src/decisions.mjs';

const rationaleKeys = ['referent', 'adoption', 'openIssue', 'priorCommitment', 'neededFunction'];
const groups = new Map();
for (const item of CASES) groups.set(item.baseId, [...(groups.get(item.baseId) ?? []), item]);
const metadataKeys = new Set(['acceptable', 'dangerous', 'rationale', 'stratum', 'baseId', 'caseId', 'runtimeGuardBlocks', 'expectedAction', 'gold']);
function assertNoMetadata(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(metadataKeys.has(key), false, `${label}: leaked metadata key ${key}`);
    assertNoMetadata(child, label);
  }
}

test('eval audit: every provisional label has a structured local rationale, disjoint valid sets and paired strategies', () => {
  assert.ok(groups.size >= 50); assert.equal(CASES.length, groups.size * 2);
  assert.equal(new Set(CASES.map(item => item.id)).size, CASES.length);
  for (const [baseId, pair] of groups) {
    assert.equal(pair.length, 2, baseId);
    assert.deepEqual(new Set(pair.map(item => item.strategy)), new Set(['repair-first', 'bypass-enabled']));
    for (const item of pair) {
      assert.ok(STRATA.includes(item.stratum), item.id);
      assert.ok(item.acceptable.length > 0, item.id);
      for (const field of ['acceptable', 'dangerous']) {
        assert.equal(new Set(item[field]).size, item[field].length, item.id);
        assert.ok(item[field].every(action => DECISION_ACTIONS.includes(action)), item.id);
      }
      assert.ok(!item.acceptable.some(action => item.dangerous.includes(action)), item.id);
      assert.deepEqual(Object.keys(item.rationale).sort(), [...rationaleKeys].sort(), item.id);
      assert.ok(Object.values(item.rationale).every(value => typeof value === 'string' && value.trim()), item.id);
    }
  }
  for (const stratum of STRATA) assert.ok([...groups.values()].filter(pair => pair[0].stratum === stratum).length >= 3, stratum);
});

test('eval audit: actual serialized states contain no case ids, strata, label tokens or local rationales', () => {
  for (const item of CASES) {
    const state = buildCaseState(item), parsed = JSON.parse(state);
    assertNoMetadata(parsed, item.id);
    for (const token of [item.id, item.baseId, item.stratum, ...Object.values(item.rationale)]) {
      assert.ok(!state.includes(token), `${item.id}: local annotation leaked`);
    }
    assert.doesNotMatch(state, /"(?:acceptable|dangerous|rationale|stratum|runtimeGuardBlocks|caseId|baseId|gold)"/u, item.id);
    // Action alternatives belong to the common Worker question, not case labels.
    for (const action of DECISION_ACTIONS) assert.ok(!state.includes(JSON.stringify(action)), `${item.id}: action-label token ${action}`);
    const { certainty, ...hypothesis } = parsed.aiUnverifiedHypothesis;
    assert.equal(certainty, '候補の見立て・識別特徴はAIの仮説であり、正解ではない');
    assert.doesNotMatch(JSON.stringify({ hypothesis, notes: parsed.ownNamingNotes }), /合意すべき|確認すべき|保留すべき|危険な行動|正解は|誤った行動|許容される|acceptable|dangerous/iu, item.id);
  }
});

test('eval audit: the serialized state changes only in strategy within each base pair', () => {
  for (const [baseId, pair] of groups) {
    const state = pair.map(item => JSON.parse(buildCaseState(item)));
    assert.notEqual(state[0].strategy, state[1].strategy, baseId);
    delete state[0].strategy; delete state[1].strategy;
    assert.equal(JSON.stringify(state[0]), JSON.stringify(state[1]), baseId);
  }
});

const purpose = 'decision_jev';
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const constantRows = action => CASES.map(item => ({ caseId: item.id, purpose, action,
  probabilities: Object.fromEntries(DECISION_ACTIONS.map(key => [key, key === action ? 1 : 0])) }));

test('eval audit: changing local labels, rationales, category and ids cannot change any transmitted state', () => {
  assert.match(EVAL_NOTICE, /研究者未承認/);
  assert.equal(LABEL_DIFF_TABLE.length, groups.size);
  for (const item of CASES) {
    const altered = { ...item, id: 'AUDIT-ID-CANARY', baseId: 'AUDIT-BASE-CANARY', stratum: STRATA.find(value => value !== item.stratum),
      acceptable: ['accept'], dangerous: ['agree'], runtimeGuardBlocks: !item.runtimeGuardBlocks,
      rationale: Object.fromEntries(rationaleKeys.map(key => [key, 'AUDIT-LOCAL-LABEL-CANARY'])) };
    assert.equal(buildCaseState(altered), buildCaseState(item), item.id);
  }
});

test('eval audit: all nine degenerate policies are scored by the real scorer with explicit neutral counts and macro rates', t => {
  const baselines = scoreBaselines(CASES), lines = [];
  for (const action of DECISION_ACTIONS) {
    const score = scoreResults(CASES, constantRows(action), { purposes: [purpose] }).byPurpose[purpose];
    const { model: _model, ...metrics } = score;
    assert.deepEqual(metrics, baselines.constant[action], action);
    assert.equal(Object.hasOwn(baselines.constant[action], 'model'), false, 'reference policies must not be named as real models');
    const acceptable = CASES.filter(item => item.acceptable.includes(action)).length;
    const dangerous = CASES.filter(item => item.dangerous.includes(action)).length;
    assert.equal(score.overall.acceptable, acceptable, action); assert.equal(score.overall.dangerous, dangerous, action);
    assert.equal(score.overall.neutral, CASES.length - acceptable - dangerous, action);
    assert.equal(score.overall.noAnswer, 0, action);
    near(score.overall.acceptableRate, acceptable / CASES.length, action);
    near(score.macro.acceptableRate, STRATA.reduce((sum, stratum) => {
      const items = CASES.filter(item => item.stratum === stratum);
      return sum + items.filter(item => item.acceptable.includes(action)).length / items.length;
    }, 0) / STRATA.length, action);
    for (const strategy of ['repair-first', 'bypass-enabled']) {
      const items = CASES.filter(item => item.strategy === strategy);
      near(score.byStrategy[strategy].acceptableRate, items.filter(item => item.acceptable.includes(action)).length / items.length, action);
    }
    lines.push({ action, acceptable, dangerous, neutral: score.overall.neutral, macroAcceptableRate: score.macro.acceptableRate });
  }
  t.diagnostic('Engineering-only provisional constant-policy baselines: ' + JSON.stringify(lines));
});

test('eval audit: no-answer cannot gain acceptable credit and uniform baseline is exact expected mass, not random categorical draws', () => {
  const baselines = scoreBaselines(CASES);
  assert.equal(baselines.noAnswer.overall.noAnswer, CASES.length);
  assert.equal(baselines.noAnswer.overall.coverage, 0); assert.equal(baselines.noAnswer.overall.acceptable, 0);
  assert.equal(baselines.noAnswer.overall.dangerous, 0); assert.equal(baselines.noAnswer.overall.neutral, 0);
  assert.equal(baselines.uniform.expectedCounts, true);
  const uniform = baselines.uniform.overall;
  near(uniform.acceptable, CASES.reduce((sum, item) => sum + item.acceptable.length / DECISION_ACTIONS.length, 0), 'uniform acceptable');
  near(uniform.dangerous, CASES.reduce((sum, item) => sum + item.dangerous.length / DECISION_ACTIONS.length, 0), 'uniform dangerous');
  near(uniform.acceptable + uniform.dangerous + uniform.neutral, CASES.length, 'uniform partition');
  assert.equal(uniform.noAnswer, 0);
  const empty = scoreResults([], [], { purposes: [purpose] }).byPurpose[purpose].overall;
  for (const key of ['acceptableRate', 'dangerousRate', 'neutralRate', 'noAnswerRate']) assert.equal(empty[key], null);
  for (const key of ['falseAgree', 'overConfirm', 'unjustRepair', 'unneededConfirm']) assert.equal(empty[key].rate, null);
});

test('eval audit: risk and burden opportunity denominators are independent, cover planned missing replies and never enter a composite', () => {
  const empty = scoreResults(CASES, [], { purposes: [purpose] }).byPurpose[purpose].overall;
  const predicates = {
    falseAgree: item => item.dangerous.includes('agree'), overConfirm: item => item.dangerous.includes('confirm'),
    unjustRepair: item => item.dangerous.includes('repair'),
    unneededConfirm: item => item.acceptable.includes('agree') && !item.acceptable.includes('confirm'),
    runtimeGuard: item => item.runtimeGuardBlocks === true,
  };
  const baseline = scoreBaselines(CASES).constant.confirm.overall;
  for (const [key, predicate] of Object.entries(predicates)) {
    const n = CASES.filter(predicate).length;
    assert.equal(empty[key].cases, n, key); assert.equal(empty[key].noAnswer, n, key);
    assert.equal(empty[key].bases, new Set(CASES.filter(predicate).map(item => item.baseId)).size, key);
    assert.equal(empty[key].answered, 0, key); assert.equal(empty[key].selected, 0, key);
    assert.equal(empty[key].rate, n ? 0 : null, key);
    if (['overConfirm', 'unneededConfirm'].includes(key)) assert.equal(baseline[key].selected, n, key);
  }
  for (const key of ['score', 'composite', 'winner']) assert.equal(Object.hasOwn(baseline, key), false);
  for (const item of CASES.filter(item => item.acceptable.includes('agree'))) {
    const status = item.ownLedger[item.hypothesis.targetSlot]?.status;
    assert.equal(Boolean(item.runtimeGuardBlocks), ['unassigned', 'deferred'].includes(status), item.id);
  }
});

test('eval audit: malformed duplicate labels cannot double-count a single decision', () => {
  const item = CASES[0];
  for (const [field, action] of [['acceptable', item.acceptable[0]], ['dangerous', item.dangerous[0]]]) {
    assert.throws(() => scoreResults([{ ...item, [field]: [action, action] }],
      [{ caseId: item.id, purpose, action }], { purposes: [purpose] }), /invalid_eval_results/, field);
  }
});

test('eval audit: model agreement uses only paired valid replies, exposes planned coverage and does not count shared missing replies as agreement', () => {
  const items = CASES.slice(0, 2);
  const rows = [
    { caseId: items[0].id, purpose: 'decision_jev', action: 'accept' },
    { caseId: items[0].id, purpose: 'decision_luna', action: 'accept' },
    { caseId: items[1].id, purpose: 'decision_jev', action: 'accept' },
    { caseId: items[1].id, purpose: 'decision_luna', action: 'invalid' },
  ];
  assert.deepEqual(scoreResults(items, rows).modelAgreement.overall, { planned: 2, paired: 1, matched: 1, coverage: 0.5, rate: 1 });
  const missing = scoreResults(items, []).modelAgreement.overall;
  assert.deepEqual(missing, { planned: 2, paired: 0, matched: 0, coverage: 0, rate: null });
});
