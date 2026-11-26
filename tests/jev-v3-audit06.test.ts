// audit/06 F1, F2, F5 (restore side) and F6 for the explicit two_stage_v3 layout. Each case was run RED against 4a1b854 first.
// Synthetic data only; never a live model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJevDecisionPayload, buildJevTargetPayload, buildJevDecisionDetailPayload, JevDecisionError } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { JevTurnError } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { checkDecisionFailureEvidence } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { ids, anchors, image, memo, deadlines } from './support/s4-integration/harness.ts';

const V3 = { questionLayout: 'two_stage_v3' } as const;
const slots = Array.from({ length: 6 }, (_, i) => `own-${i}`);
const bare = () => ({ observedAt: '2026-11-20T00:00:00.000Z', figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 }, holistic: [] as any[],
  analytic: { shapes: [`形${i}`], composition: '', relations: [] as string[] }, unknowns: [] as string[], reobservations: [] as any[] })) });

/** 32 public turns, a single-figure naming proposal in turn 2 (own-0), an executed accept at turn 31; `pad` characters of old filler. */
function boundary(pad: number): JevDecisionInput {
  const publicTurns: any[] = [];
  for (let turn = 1; turn <= 32; turn++) {
    const filler = turn >= 3 && turn <= 30 ? 'あ'.repeat(Math.floor(pad / 28) + (turn - 3 < pad % 28 ? 1 : 0)) : '';
    publicTurns.push({ turn, speaker: turn % 2 ? 'ai' : 'human', text: turn === 2 ? 'この形を船と呼びたいです' : turn === 32 ? 'どれのことですか' : `発話${turn}${filler}` });
  }
  const names = [{ name: '船', figureId: slots[0], sourceTurn: 2 }];
  return { turn: 32, ownSlots: slots, observations: bare(), issueSummary: '対象が未特定', priorClaims: [], repairHistory: [],
    previousAction: { turn: 31, action: 'accept', target: { kind: 'none' }, name: null, feature: null }, publicTurns, publicNames: names, agreeNames: names, reobservationAllowed: false } as JevDecisionInput;
}
const stateOf = (p: { state: string }) => JSON.parse(p.state);
const stripSelected = (s: any) => { const { selected: _s, inputBudget: _b, ...rest } = s; return rest; };

test('F1: every stage derives candidates from the one material fixed at stage one, across the 20,000-character boundary', () => {
  let offered = 0, withheld = 0, checked = 0, longest = 0;
  for (let pad = 16600; pad <= 17400; pad += 3) {
    let input: JevDecisionInput;
    try { input = boundary(pad); buildJevDecisionPayload(input, V3); } catch (e) { if (e instanceof JevDecisionError) continue; throw e; }
    const p1 = buildJevDecisionPayload(input, V3), labels = Object.keys(p1.questions.action.criteria);
    assert.ok(p1.state.length <= 20000, `stage one state ${p1.state.length}`);
    if (labels.includes('propose_name')) longest = Math.max(longest, p1.state.length);
    for (const action of ['propose_name', 'agree'] as const) {
      if (!labels.includes(action)) { withheld++; continue; }
      offered++;
      const p2 = buildJevTargetPayload(input, action);
      assert.ok(Object.keys(p2.questions.target.criteria).includes('figure_0'), `${action} pad ${pad}`);
      const p3 = buildJevDecisionDetailPayload(input, { action, target: { kind: 'single', figureId: slots[0] } }, V3)!;
      assert.ok(p3 && Object.keys(p3.questions.name.criteria).length > 0, `${action} pad ${pad}: detail name candidate vanished`);
      for (const p of [p2, p3]) assert.ok(p.state.length <= 20000, `later stage state ${p.state.length}`);
      // Same retained material in all three requests; only `selected` (and the char count) differs.
      assert.deepEqual(stripSelected(stateOf(p2)), stripSelected(stateOf(p1)), `${action} pad ${pad}`);
      assert.deepEqual(stripSelected(stateOf(p3)), stripSelected(stateOf(p1)), `${action} pad ${pad}`);
      // The evidence shown is still in the request: its public source turn survived compaction.
      assert.ok(stateOf(p3).publicTurns.some((t: any) => t.turn === 2 && t.text.includes('船')), `${action} pad ${pad}: source turn dropped`);
      assert.ok(stateOf(p3).publicNames.some((n: any) => n.sourceTurn === 2), `${action} pad ${pad}: publicNames dropped`);
      checked++;
    }
  }
  assert.ok(offered > 20 && withheld > 20 && checked === offered, `sweep must cross the boundary: offered ${offered}, withheld ${withheld}`);
  assert.ok(longest > 19000, `the sweep reaches the 20,000 boundary region (longest offered stage-one state ${longest})`);
});

test('F1: agree evidence whose source turn the compaction dropped is not offered; v1/v2 payloads keep their old behaviour', () => {
  let dropped = 0;
  for (let pad = 16600; pad <= 17400; pad += 5) {
    const input = boundary(pad); let p1;
    try { p1 = buildJevDecisionPayload(input, V3); } catch { continue; }
    if (!stateOf(p1).publicTurns.some((t: any) => t.turn === 2)) { dropped++; assert.ok(!('agree' in p1.questions.action.criteria), `pad ${pad}`); assert.ok(!('propose_name' in p1.questions.action.criteria)); }
  }
  assert.ok(dropped > 10);
  // v2 is frozen: its payload still carries the pre-existing (uncompacted) agree evidence.
  const input = boundary(16000), v2 = buildJevDecisionPayload(input, { questionLayout: 'two_stage_v2' });
  assert.ok('agree' in v2.questions.action.criteria);
});

test('F2: without adaptive evidence (agreeNames unset or empty) v3 never offers agree, whatever the observation names say', () => {
  const input = boundary(0);
  input.observations.figures[2].holistic = [{ construal: '山', basis: ['形'], status: 'hypothesis' }];
  for (const variant of [undefined, [] as any[]]) {
    const i = { ...input, agreeNames: variant } as JevDecisionInput;
    if (variant === undefined) delete (i as any).agreeNames;
    const labels = Object.keys(buildJevDecisionPayload(i, V3).questions.action.criteria);
    assert.ok(!labels.includes('agree'));
    assert.ok(labels.includes('propose_name'), 'observation-based propose_name stays available');
    assert.throws(() => buildJevTargetPayload(i, 'agree'), (e: any) => e instanceof JevDecisionError && e.code === 'invalid_decision');
    assert.ok(buildJevTargetPayload(i, 'propose_name').questions.target.criteria.figure_2);
  }
  // The same observation names do not make agree legal for the figure that has no public proposal when another has one.
  const one = boundary(0); one.observations.figures[2].holistic = [{ construal: '山', basis: ['形'], status: 'hypothesis' }];
  assert.deepEqual(Object.keys(buildJevTargetPayload(one, 'agree').questions.target.criteria), ['figure_0']);
});

// ---- F6 through the profile entry with an injected decision client
const events = [{ id: 'human-1', seq: 1, speaker: 'human', text: 'Control?' }];
const ILLEGAL: Array<[string, any]> = [
  ['propose_name', { kind: 'none' }], ['propose_name', { kind: 'multiple', figureIds: [ids[1], ids[3]] }],
  ['confirm', { kind: 'none' }], ['repair', { kind: 'none' }], ['revisit', { kind: 'none' }],
  ['agree', { kind: 'none' }], ['agree', { kind: 'multiple', figureIds: [ids[1], ids[3]] }], ['request_observation', { kind: 'none' }]];
function injected(action: string, target: any) {
  let calls = 0;
  const decision = { action, target, name: null, feature: null, observe: null, decisionKind: 'mock', calibrated: false,
    evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: null } };
  return { client: { metadata: { questionLayout: 'two_stage_v3', decisionKind: 'mock', calibrated: false }, async decide() { calls++; return structuredClone(decision); } }, calls: () => calls };
}
const options = (jevDecision: any) => ({ strategy: 'repair-first',
  client: { async complete(_m: any, o: any) { return { text: ['local_extraction', 'ai_extraction'].includes(o.phase) ? '[]' : 'Control.' }; } },
  image, anchors, observer: { async observeAll() { return memo(); }, async reobserve() { throw Error('unused'); } }, jevDecision,
  localGrounding: { classifier: { async classify() { return []; } }, aiPublicTransport: { readKey: async () => { throw Error('unused'); }, fetchImpl: async () => { throw Error('unused'); } } },
  referenceMemory: true, decisionMode: 'jev' } as any);

for (const [action, target] of ILLEGAL) test(`F6: injected ${action} x ${target.kind} records the local rule action_target_not_allowed and nothing else`, async () => {
  const j = injected(action, target);
  const runtime = createProfileDialogue(researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, deadlines(), 'two_stage_v3'), options(j.client));
  const initial = runtime.initialPrivateState();
  await assert.rejects(() => runtime.runAiTurn({ events, privateState: initial, lastEventId: 'human-1', requestSeq: 1 }),
    (e: any) => e instanceof JevTurnError && e.code === 'invalid_decision' && e.decisionRejectionCode === 'action_target_not_allowed');
  const attempt = runtime.getAttempts().at(-1)!;
  assert.equal(attempt.errorCode, 'invalid_decision'); assert.equal(attempt.decisionRejectionCode, 'action_target_not_allowed');
  assert.equal(attempt.publicSpeech, null); assert.equal(attempt.finalAction, null);
  const evidence = attempt.decisionFailure!.evidence!;
  assert.equal(evidence.rejectionCode, 'action_target_not_allowed'); assert.equal(evidence.error, 'invalid_decision');
  assert.deepEqual(evidence.stages, []); assert.equal(evidence.model, null); assert.equal(evidence.costUsd, null); assert.equal(evidence.inputBudget, null);
  assert.deepEqual(checkDecisionFailureEvidence(structuredClone(evidence)), evidence);
  assert.equal(j.calls(), 1);
  assert.deepEqual(initial.ledger, runtime.initialPrivateState().ledger);
});

test('F6: the local-rule record is closed: a provider id, a cost, a stage or a different layout is refused', () => {
  const base: any = { schemaVersion: 'jev_decision_failure_v1', questionLayout: 'two_stage_v3', callIndex: 1, error: 'invalid_decision', rejectionCode: 'action_target_not_allowed',
    model: null, responseId: null, costUsd: null, latencyMs: 0, inputBudget: null, stages: [] };
  assert.ok(checkDecisionFailureEvidence(base));
  for (const mutate of [(e: any) => { e.costUsd = 0.001; }, (e: any) => { e.model = 'typesafe/jev-1.14'; }, (e: any) => { e.error = 'inconsistent_decision'; },
    (e: any) => { e.questionLayout = 'two_stage_v2'; }, (e: any) => { e.responseId = 'gen-x'; }, (e: any) => { e.rejectionCode = 'name_required'; }]) {
    const e = structuredClone(base); mutate(e); assert.equal(checkDecisionFailureEvidence(e), null);
  }
});
