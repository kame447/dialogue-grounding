// PLAN-ADAPTIVE-r1 integration: prospect issue choice -> veto -> open-issue alternative -> saved state.
// Synthetic Jev wire only; no real key, fetch or utterance assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileDialogue} from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import {createJevDecisionClient} from '../dialogue-model/runtime/decision/jev-decision.ts';
import {interventionForStrategy} from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import {validateJevPrivateStateV2} from '../dialogue-model/runtime/v2/jev-turn.ts';
import {ids, anchors, image, memo, profile} from './support/s4-integration/harness.ts';

// The human proposes to move on after an AI repair question about s-0002 (turn 2).
const events = [{id: 'h1', seq: 1, speaker: 'human', text: 'Control?'}, {id: 'a2', seq: 2, speaker: 'ai', text: 'Which part do you mean?'},
  {id: 'h3', seq: 3, speaker: 'human', text: 'Let us skip it and go on.'}];
const history = [{turn: 2, issueId: null, action: 'repair', question: 'control-feature', partnerClaims: [], candidatesBefore: ['s-0002'],
  candidatesAfter: ['s-0002'], addedClaimIds: [], removedClaimIds: [], progress: 'unchanged'}];

function run({strategy = 'repair-first', enabled = true, issue = 'issue_0'} = {}) {
  const wire: any[] = [], generated: any[] = [];
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(init.body); wire.push(body); const answers: any = {};
    for (const [key, q] of Object.entries(body.questions) as any) {
      const labels = Object.keys(q.criteria);
      const choice = key === 'action' ? 'move_on' : key === 'target' ? 'figure_0' : key === 'repair_issue' ? issue :
        key.startsWith('candidate_') ? 'exclude' : labels[0];
      const probabilities = Object.fromEntries(labels.map(k => [k, key === 'action' ? (k === 'move_on' ? 1 : k === 'confirm' ? 0.4 : k === 'accept' ? 0.6 : 0) : (k === choice ? 1 : 0)]));
      answers[key] = {type: 'choice', choice, probabilities};
    }
    return Response.json({model: 'typesafe/jev-1.14', id: 'gen-synthetic-' + wire.length, usage: {cost: 0}, answers});
  };
  const core = createJevDecisionClient({enabled: true, readKey: async () => 'sk-or-SYNTHETIC-0000000000000000', fetchImpl,
    timeoutMs: 1000, researchLimits: {maxDeadlineMs: 600000}})!;
  const {estimateRepairProspect: _off, ...withoutProspect} = core as any;
  const jevDecision = enabled ? core : withoutProspect;
  const runtime = createProfileDialogue(profile(), {strategy, image, anchors, jevDecision, referenceMemory: true, decisionMode: 'jev',
    client: {async complete(messages: any[], o: any) { generated.push({messages: structuredClone(messages), phase: o.phase});
      return {text: ['local_extraction', 'ai_extraction'].includes(o.phase) ? '[]' : 'Control.'}; }},
    observer: {async observeAll() { return memo(); }, async reobserve() { throw Error('unused'); }},
    localGrounding: {classifier: {async classify() { return []; }}, aiPublicTransport: {readKey: async () => { throw Error('unused'); }, fetchImpl: async () => { throw Error('unused'); }}},
    ...(enabled ? {technicalTrial: {version: 'adaptive_repair_v1'}} : {})} as any);
  const state = runtime.initialPrivateState(); state.repairHistory = structuredClone(history);
  return {wire, generated, result: runtime.runAiTurn({events, privateState: state, lastEventId: 'h3', requestSeq: 3})};
}

test('ON repair-first: the Jev-chosen open issue redirects the vetoed move_on and survives restore', async () => {
  const r = run(), {privateState} = await r.result, z = privateState.judgments[0].jevTurn;
  assert.deepEqual(Object.keys(r.wire[1].questions), ['repair_issue', 'prospect', 'basis']);
  assert.deepEqual(z.repairProspect.issue, {choice: 'issue', turn: 2, issueId: null});
  assert.equal(z.decision.action, 'move_on');
  assert.deepEqual(z.decision.target, {kind: 'single', figureId: 's-0000'});
  assert.equal(z.executed.action, 'confirm');
  assert.deepEqual(z.executed.target, {kind: 'single', figureId: 's-0002'});
  assert.equal(z.intervention.rerank.policyId, 'saved_action_scores_open_issue_v1');
  assert.deepEqual(z.intervention.rerank.source, {issueTurn: 2, issueId: null, choice: 'issue', candidates: ['s-0002']});
  const saved = JSON.parse(JSON.stringify(privateState));
  assert.deepEqual(validateJevPrivateStateV2(saved, ids, interventionForStrategy('repair-first')), saved);
  for (const tamper of [(s: any) => { s.judgments[0].jevTurn.executed.target.figureId = 's-0000'; },
    (s: any) => { delete s.judgments[0].jevTurn.intervention.rerank.source; },
    (s: any) => { s.judgments[0].jevTurn.intervention.rerank.ranking.unshift({action: 'accept', score: 0.6}); }]) {
    const bad = structuredClone(saved); tamper(bad);
    assert.throws(() => validateJevPrivateStateV2(bad, ids, interventionForStrategy('repair-first')), {code: 'invalid_state'});
  }
  assert.ok(!JSON.stringify(r.generated).includes('repairProspect'));
});

test('ON restore requires the same-turn issue choice, a prior history entry and the recorded candidates; OFF rejects the new policy', async () => {
  const {privateState} = await run().result, saved = JSON.parse(JSON.stringify(privateState));
  const z = (s: any) => s.judgments[0].jevTurn;
  for (const [name, tamper] of [
    ['source turn', (s: any) => { z(s).intervention.rerank.source.issueTurn = 999; }],
    ['source issueId', (s: any) => { z(s).intervention.rerank.source.issueId = 'nonexistent'; }],
    ['prospect removed', (s: any) => { delete z(s).repairProspect; }],
    ['prospect unknown', (s: any) => { z(s).repairProspect = {status: 'unknown', issue: null, prospect: null, basis: null, scores: null}; }],
    ['recorded candidates', (s: any) => { z(s).intervention.rerank.source.candidates = ['s-0003']; }],
    ['history entry missing', (s: any) => { s.repairHistory = []; }],
  ] as const) {
    const bad = structuredClone(saved); tamper(bad);
    assert.throws(() => validateJevPrivateStateV2(bad, ids, interventionForStrategy('repair-first')), {code: 'invalid_state'}, name);
  }
  const off = structuredClone(saved); delete z(off).repairProspect;
  const offRuntime = createProfileDialogue(profile(), {strategy: 'repair-first', image, anchors, referenceMemory: true, decisionMode: 'jev',
    jevDecision: {async decide() { throw Error('unused'); }}, client: {async complete() { throw Error('unused'); }},
    observer: {async observeAll() { return memo(); }, async reobserve() { throw Error('unused'); }},
    localGrounding: {classifier: {async classify() { return []; }}}} as any);
  assert.throws(() => offRuntime.snapshotGraph(off), {code: 'invalid_state'});
});

test('ON bypass-enabled sends the same Jev wire and adopts move_on', async () => {
  const a = run(), b = run({strategy: 'bypass-enabled'});
  const [x, y] = await Promise.all([a.result, b.result]);
  assert.deepEqual(a.wire.slice(0, 3), b.wire.slice(0, 3));
  assert.equal(y.privateState.judgments[0].jevTurn.executed.action, 'move_on');
  assert.equal(x.privateState.judgments[0].jevTurn.executed.action, 'confirm');
});

test('ON with none/unknown issue choice and OFF keep the saved-action rerank', async () => {
  for (const options of [{issue: 'none'}, {issue: 'unknown'}, {enabled: false}]) {
    const r = run(options), {privateState} = await r.result, z = privateState.judgments[0].jevTurn;
    assert.equal(z.intervention.rerank.policyId, 'saved_action_scores_v1');
    assert.deepEqual(z.executed.target, z.decision.target);
    assert.equal(z.executed.action, 'accept');
    assert.equal(Object.hasOwn(z, 'repairProspect'), !('enabled' in options));
    assert.deepEqual(validateJevPrivateStateV2(JSON.parse(JSON.stringify(privateState)), ids, interventionForStrategy('repair-first')),
      JSON.parse(JSON.stringify(privateState)));
  }
});
