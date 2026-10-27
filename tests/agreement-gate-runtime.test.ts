// SPEC-AGREEMENT-GATE-r2: synthetic public material only; no private run, key or transport.
// Pure gate cases belong to agreement-gate.test.ts. This file exercises runtime and restore boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileDialogue} from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import {createMockJevDecisionClient} from '../dialogue-model/runtime/decision/mocks.ts';
import {buildRepairProspectPayload, validateRepairProspectMaterial} from '../dialogue-model/runtime/decision/jev-decision.ts';
import type {JevDecisionClient, JevDecisionInput, RepairHistoryEntry, RepairProspectMaterial} from '../dialogue-model/runtime/decision/contract.ts';
import {interventionForStrategy} from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import {validateJevPrivateStateV2} from '../dialogue-model/runtime/v2/jev-turn.ts';
import {applyReferenceUpdate} from '../dialogue-model/runtime/memory/reference-graph.mjs';
import {createNamingTaskV2} from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import {createTrialV2, modelView} from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import {RunBudget} from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import {ids, anchors, image, memo, profile} from './support/s4-integration/harness.ts';

type Mode = 'adaptive_repair_v1' | 'adaptive_repair_v2' | 'off';
const X = ids[0], Y = ids[1], publicName = '階段';
const emptyGate = () => ({version: 'agreement_gate_v1', closed: []});
const closure = {turn: 2, issueId: '2:local1', agreeTurn: 6};
const entry = (turn = 2, target = X): RepairHistoryEntry => ({turn, issueId: `${turn}:local1`, action: 'confirm',
  question: '細い部分がありますか', partnerClaims: [], candidatesBefore: [target], candidatesAfter: [target],
  addedClaimIds: [], removedClaimIds: [], progress: 'unchanged'});

// Minimal committed mock judgments, using the same adopted projection as jev-repair-prospect.test.ts.
// Gate evidence is historical: at turns 2 and 6 no earlier committed agree exists.
function committed(turnIndex: number, action: 'confirm' | 'agree' | 'accept' | 'propose_name' | 'repair', mode: Mode) {
  const target = action === 'accept' ? {kind: 'none'} : {kind: 'single', figureId: X};
  const name = ['agree', 'propose_name'].includes(action) ? publicName : null;
  const feature = ['confirm', 'repair'].includes(action) ? '細い部分' : null;
  const executed = {action, target, name, feature, observe: null};
  return {turnIndex, lastEventId: `h${turnIndex}`, status: 'committed',
    judgment: {action, targetSlot: target.kind === 'single' ? X : null, candidateName: name, discriminatingFeature: feature, note: null},
    generationGuard: {violations: [], regenerated: false, fallback: false},
    localGrounding: {status: 'ok', segments: 0, accepted: 0, rejected: [], classifierKind: 'unverified_injected', latencyMs: 0, attemptNumber: 1},
    jevTurn: {attemptNumber: 1, decision: {...executed, calibrated: false, decisionKind: 'mock',
      evidence: {model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: 0}}, executed,
      intervention: {schemaVersion: 'jev_intervention_v1', policy: 'bypass_acceptance_v1:veto', disposition: 'adopted',
        reasonCode: 'not_in_veto_set', original: structuredClone(executed), rerank: null, alternative: null, detailEvidence: null, failure: null},
      ...(mode === 'adaptive_repair_v2' ? {repairGate: emptyGate()} : {})}};
}

function prospect(input: JevDecisionInput): RepairProspectMaterial {
  const payload = buildRepairProspectPayload(input);
  const chosen = [...input.repairHistory].filter(r => r.turn < input.turn).sort((a, b) => a.turn - b.turn).slice(-8)[0]!;
  const scores = Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => [key,
    Object.fromEntries(Object.keys(q.criteria).map(label => [label, label === (key === 'repair_issue' ? 'issue_0' : key === 'prospect' ? 'progressing' : 'new_information') ? 1 : 0]))]));
  return validateRepairProspectMaterial({status: 'ok', issue: {choice: 'issue', turn: chosen.turn, issueId: chosen.issueId},
    prospect: 'progressing', basis: 'new_information', scores}, input.repairHistory, input.turn);
}

function harness({mode = 'adaptive_repair_v2', estimator = true, priorAction = 'agree', otherIssue = false,
  reopen, demoted = false, tentative = false}: {mode?: Mode; estimator?: boolean; priorAction?: 'agree' | 'accept' | 'propose_name';
    otherIssue?: boolean; reopen?: 'deny' | 'name_reject'; demoted?: boolean; tentative?: boolean} = {}) {
  const inputs: Record<'referent' | 'prospect' | 'decide', JevDecisionInput[]> = {referent: [], prospect: [], decide: []};
  const messages: any[] = [], traces: any[] = [];
  const mock = createMockJevDecisionClient(() => ({action: 'accept', target: {kind: 'none'}, name: null, feature: null, observe: null}));
  const jevDecision: JevDecisionClient = {
    async estimateReferent(input) { inputs.referent.push(structuredClone(input)); return {status: 'unknown', scores: null,
      model: null, responseId: null, costUsd: null, latencyMs: 0, inputBudget: null, calibrated: false}; },
    async decide(input, options) { inputs.decide.push(structuredClone(input)); return mock.decide(input, options); },
    ...(estimator ? {async estimateRepairProspect(input: JevDecisionInput) { inputs.prospect.push(structuredClone(input)); return prospect(input); }} : {}),
  };
  const text = reopen === 'name_reject' ? '階段という名前にはしません' : reopen === 'deny' ? '階段ではありません' : '次の図形へ進みたいです';
  const events = [{id: 'h2', seq: 2, speaker: 'human', text: 'この形を確認したいです'},
    {id: 'a3', seq: 3, speaker: 'ai', text: '細い部分がありますか'},
    {id: 'h4', seq: 4, speaker: 'human', text: '階段と呼びましょう'},
    {id: 'a5', seq: 5, speaker: 'ai', text: '階段と呼びましょう'},
    {id: 'h6', seq: 6, speaker: 'human', text: '階段でよいです'},
    {id: 'a7', seq: 7, speaker: 'ai', text: demoted ? '細い部分を修復します' : '階段で合意しました'},
    {id: 'h8', seq: 8, speaker: 'human', text}];
  const runtime = createProfileDialogue(profile(), {strategy: 'repair-first', referenceMemory: true, decisionMode: 'jev', image, anchors, jevDecision,
    client: {async complete(m: any[], o: any) {
      messages.push({messages: structuredClone(m), phase: o.phase});
      return {text: o.phase === 'local_extraction' && reopen ? JSON.stringify([{segmentId: 's1', quote: text, targets: [X],
        aspect: 'name', proposition: text, name: publicName, linkedIssueId: '4:local1', respondsToTurn: 5}]) :
        ['local_extraction', 'ai_extraction'].includes(o.phase) ? '[]' : 'なるほど。'};
    }}, observer: {async observeAll() {return memo();}, async reobserve() {throw Error('unused');}},
    localGrounding: {classifier: {async classify(input: any) {return input.segments.map((s: any) => ({segmentId: s.segmentId,
      act: reopen, respondsToClaimId: '5:ai1', rawScore: 1}));}},
      aiPublicTransport: {readKey: async () => {throw Error('unexpected key read');}, fetchImpl: async () => {throw Error('unexpected transport');}}},
    onJevTurnTrace: (trace: any) => traces.push(structuredClone(trace)),
    ...(mode === 'off' ? {} : {technicalTrial: {version: mode}})} as any);
  const state: any = runtime.initialPrivateState();
  state.observationMemo = memo();
  state.repairHistory = [entry(), ...(otherIssue ? [entry(4, Y)] : [])];
  state.judgments = [committed(2, 'confirm', mode), committed(6, priorAction, mode), ...(demoted ? [committed(7, 'repair', mode)] : [])];
  state.ledger[X] = {status: demoted ? 'unassigned' : priorAction === 'agree' && !tentative ? 'agreed' : 'tentative', name: demoted ? null : publicName};
  const claims = [
    {id: '4:local1', act: 'name_propose', speaker: 'human', sourceTurn: 4, quote: events[2].text, respondsTo: null},
    {id: '5:ai1', act: 'name_propose', speaker: 'ai', sourceTurn: 5, quote: events[3].text, respondsTo: null},
    {id: '6:local1', act: 'name_accept', speaker: 'human', sourceTurn: 6, quote: events[4].text, respondsTo: '5:ai1'},
  ].map(c => ({kind: 'claim', ...c, issueId: '4:local1', targets: [X], aspect: 'name', proposition: c.quote, name: publicName,
    source: c.speaker === 'human' ? 'partner_statement' : 'ai_hypothesis'}));
  for (const claim of claims) state.graph = applyReferenceUpdate(state.graph,
    {expectedRevision: state.graph.revision, turn: claim.sourceTurn, operations: [claim]},
    {generationSucceeded: true, publicTurns: events.filter(e => e.seq <= claim.sourceTurn).map(e => ({turn: e.seq, speaker: e.speaker, text: e.text}))});
  return {runtime, state, inputs, messages, traces, run: () => runtime.runAiTurn({events, privateState: state, lastEventId: 'h8', requestSeq: 8})};
}

test('synthetic I: v2 closes the agreed turn-2 confirm for inference, skips prospect and preserves research evidence', async () => {
  const h = harness(), before = structuredClone(h.state.repairHistory), result = await h.run();
  assert.equal(h.inputs.prospect.length, 0);
  assert.deepEqual(h.inputs.referent[0].repairHistory, []);
  assert.deepEqual(h.inputs.decide[0].repairHistory, []);
  assert.ok(!Object.hasOwn(h.inputs.decide[0], 'repairProspect'));
  const gate = {version: 'agreement_gate_v1', closed: [closure]};
  assert.deepEqual(h.traces[0].repairGate, gate);
  assert.deepEqual(h.runtime.getAttempts()[0].repairGate, gate);
  assert.deepEqual(result.privateState.judgments.at(-1).jevTurn.repairGate, gate);
  assert.deepEqual(result.privateState.repairHistory, before);
  assert.deepEqual(h.state.repairHistory, before);
  assert.equal(result.privateState.judgments.at(-1).judgment.action, 'accept', 'ordinary Jev action remains its own choice');
  assert.ok(!JSON.stringify(h.messages).includes('repairGate'));
});

test('synthetic I: v1 still estimates and sends the historical issue to Jev', async () => {
  const h = harness({mode: 'adaptive_repair_v1'}), result = await h.run();
  assert.equal(h.inputs.prospect.length, 1);
  assert.deepEqual(h.inputs.prospect[0].repairHistory, [entry()]);
  assert.deepEqual(h.inputs.decide[0].repairHistory, [entry()]);
  assert.deepEqual(h.inputs.decide[0].repairProspect?.issue, {choice: 'issue', turn: 2, issueId: '2:local1'});
  assert.ok(!Object.hasOwn(h.traces[0], 'repairGate'));
  assert.ok(!Object.hasOwn(result.privateState.judgments.at(-1).jevTurn, 'repairGate'));
  assert.deepEqual(validateJevPrivateStateV2(result.privateState, ids, interventionForStrategy('repair-first')), result.privateState);
});

for (const priorAction of ['accept', 'propose_name'] as const) test(`v2 without agree (${priorAction}) leaves the issue eligible for prospect`, async () => {
  const h = harness({priorAction}); await h.run();
  assert.equal(h.inputs.prospect.length, 1);
  assert.deepEqual(h.inputs.decide[0].repairHistory, [entry()]);
  assert.deepEqual(h.traces[0].repairGate, emptyGate());
});

test('v2 keeps a different figure unresolved and exposes only that issue as a prospect choice', async () => {
  const h = harness({otherIssue: true}), result = await h.run();
  assert.equal(h.inputs.prospect.length, 1);
  for (const phase of ['referent', 'prospect', 'decide'] as const) assert.deepEqual(h.inputs[phase][0].repairHistory, [entry(4, Y)], phase);
  assert.deepEqual(h.inputs.decide[0].repairProspect?.issue, {choice: 'issue', turn: 4, issueId: '4:local1'});
  assert.deepEqual(h.traces[0].repairGate.closed, [closure]);
  assert.deepEqual(result.privateState.repairHistory, [entry(), entry(4, Y)]);
});

for (const reopen of ['deny', 'name_reject'] as const) test(`v2 reopens the issue from the current human ${reopen} before estimating`, async () => {
  const h = harness({reopen}); await h.run();
  assert.ok(h.inputs.decide[0].priorClaims.some(c => c.sourceTurn === 8 && c.speaker === 'human' && c.act === reopen && c.targets.includes(X)), 'current-turn claim must actually pass local verification');
  assert.equal(h.inputs.prospect.length, 1);
  assert.deepEqual(h.inputs.decide[0].repairHistory, [entry()]);
  assert.deepEqual(h.traces[0].repairGate, emptyGate());
});

for (const options of [{demoted: true}, {tentative: true}]) test(`r2 reopens after repair or when the decision-time ledger is tentative: ${JSON.stringify(options)}`, async () => {
  const h = harness(options); await h.run();
  assert.equal(h.inputs.prospect.length, 1);
  assert.deepEqual(h.inputs.decide[0].repairHistory, [entry()]);
  assert.deepEqual(h.traces[0].repairGate, emptyGate());
});

test('OFF preserves input, generation, trace and saved-state bytes with or without the estimator method', async t => {
  t.mock.method(performance, 'now', () => 1000);
  const a = harness({mode: 'off', estimator: false}), b = harness({mode: 'off'});
  const ar = await a.run(), br = await b.run();
  assert.equal(JSON.stringify(a.inputs), JSON.stringify(b.inputs));
  assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages));
  assert.equal(JSON.stringify(a.runtime.getAttempts()), JSON.stringify(b.runtime.getAttempts()));
  assert.equal(JSON.stringify(ar), JSON.stringify(br));
  assert.ok(!JSON.stringify(br).includes('repairGate'));
});

test('v1 and OFF runtimes reject repairGate-bearing saves', async () => {
  for (const mode of ['adaptive_repair_v1', 'off'] as const) {
    const h = harness({mode}), result = await h.run(), saved = structuredClone(result.privateState);
    assert.doesNotThrow(() => h.runtime.snapshotGraph(saved), `${mode} valid baseline`);
    saved.judgments.at(-1).jevTurn.repairGate = emptyGate();
    assert.throws(() => h.runtime.snapshotGraph(saved), {code: 'invalid_state'}, mode);
  }
});

test('v2 runtime rejects a judgment missing its gate', async () => {
  const h = harness(), result = await h.run(), saved = structuredClone(result.privateState);
  assert.doesNotThrow(() => h.runtime.snapshotGraph(saved));
  delete saved.judgments[0].jevTurn.repairGate;
  assert.throws(() => h.runtime.snapshotGraph(saved), {code: 'invalid_state'});
});

test('restore validates v2 closure provenance and prospect against the eligible history', async () => {
  const h = harness({otherIssue: true}), result = await h.run(), saved = JSON.parse(JSON.stringify(result.privateState));
  const validate = (s: any) => validateJevPrivateStateV2(s, ids, interventionForStrategy('repair-first'));
  assert.deepEqual(validate(saved), saved);
  assert.doesNotThrow(() => h.runtime.snapshotGraph(saved));
  const last = (s: any) => s.judgments.at(-1).jevTurn;
  for (const [label, tamper] of [
    ['unjustified closure of other figure', (s: any) => last(s).repairGate.closed.push({turn: 4, issueId: '4:local1', agreeTurn: 6})],
    ['agreeTurn is not an agree', (s: any) => {last(s).repairGate.closed[0].agreeTurn = 4;}],
    ['closed issue reclaimed by prospect', (s: any) => {last(s).repairProspect.issue = {choice: 'issue', turn: 2, issueId: '2:local1'};}],
    ['gate removal restores an extra prospect option', (s: any) => {last(s).repairGate.closed = [];}],
  ] as const) {
    const bad = structuredClone(saved); tamper(bad);
    assert.throws(() => validate(bad), {code: 'invalid_state'}, label);
  }
  // Later ledger state must not retroactively invalidate an earlier decision-time closure.
  const later = structuredClone(saved); later.ledger[X] = {status: 'tentative', name: publicName};
  assert.deepEqual(validate(later), later);
});

test('participant restore keeps v1 records compatible and rejects opening them with v2 config', async () => {
  const seed = 909, trial = createTrialV2({seed}), own = modelView(trial), p = profile();
  const observation = {observedAt: '2026-10-20T00:00:00.000Z', figures: own.anchors.map((a: any) => ({id: a.id, region: a.bbox,
    holistic: [], analytic: {shapes: ['三角'], composition: '二つの部分が接する', relations: []}, unknowns: [], reobservations: []}))};
  let saved: any;
  const research = {profile: p, observer: {async observeAll() {return structuredClone(observation);}, async reobserve() {throw Error('unused');}},
    jevDecision: createMockJevDecisionClient(() => ({action: 'accept', target: {kind: 'none'}, name: null, feature: null, observe: null})),
    localGrounding: {classifier: {async classify() {return [];}}, timeoutMs: p.timeouts.localMs, aiPublicClaims: true},
    ledger: new RunBudget({lunaCalls: 100, lunaPosts: 100, lunaTokens: 100000, jevPosts: 100, jevUsd: 0.05}),
    technicalTrial: {version: 'adaptive_repair_v1'}};
  const options: any = {seed, strategy: 'repair-first', referenceMemory: true, runDir: null, createTrial: () => trial,
    client: {async complete() {throw Error('unexpected generation');}}, jevResearch: research,
    onPersist: async (r: any) => {saved = structuredClone(r);}};
  await createNamingTaskV2(options);
  const record = structuredClone(saved);
  await assert.doesNotReject(createNamingTaskV2({...options, restore: record}));
  // Prove v2 itself is supported before testing the mismatch (avoids an invalid-config false positive).
  const v2 = {...research, technicalTrial: {version: 'adaptive_repair_v2'}};
  await assert.doesNotReject(createNamingTaskV2({...options, jevResearch: v2}));
  await assert.rejects(createNamingTaskV2({...options, jevResearch: v2, restore: record}), {code: 'invalid_options'});
});
