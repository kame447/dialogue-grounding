// audit/06 R1, R2 and R4 (S4 side) through the public seam: genuine runtime records -> pairedInterventionReplay -> interventionChecks.
// R1: agree evidence per request (compaction) and the agree detail catalog; R2: wall-clock latency of the alternative's detail evidence and a
// reobservation after the repair prospect; R4: the local-rule failure trace. Synthetic data only; no network, key or study text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { buildRecords, normal, runTurn, OLD } from './support/s4-v3-records.ts';
import type { Plan } from './support/s4-v3-records.ts';

const checksOf = (records: any) => interventionChecks(records);
const status = (records: any, suffix: string, attempt = 0) => checksOf(records).find((c: any) => c.id === `intervention.trial.0.attempt.${attempt}.` + suffix)?.status;
const all = (n: any, attempt = 0) => ['shape', 'binding', 'execution', 'replay'].map(k => status(n, k, attempt));
const PASS = ['pass', 'pass', 'pass', 'pass'];
const V3 = { version: 'adaptive_repair_v3' } as const;
const NEUTRAL: Plan = { action: 'accept', target: 'none' };
const IDS = Object.keys(OLD.state.ledger) as string[];
const tr = (n: any) => n.trials[0];
const traceCopies = (n: any) => [tr(n).attempts[0], tr(n).turns[0].trace[0]];
const stateCopies = (n: any) => [tr(n).turns[0].state, tr(n).lastCommittedState];
const sideCopies = (n: any) => [...tr(n).replay[0].result.sides, n.evidence.pairedReplay[0].left, n.evidence.pairedReplay[0].right];

// ---- R2a: the recorded and the replayed wall-clock latency of the alternative's detail evidence are independent
const VETO_TURNS = [{ human: 'この形はどうですか', plan: { action: 'confirm', target: 'figure_0' } },
  { human: 'どこのことか分かりません', plan: { action: 'defer', target: 'figure_1', issue: 'issue_0', actionScores: { confirm: 0.7, repair: 0.6, defer: 1 } } }];
const setLatency = (n: any, recorded: number, replayed: number) => {
  for (const t of traceCopies(n)) t.intervention.detailEvidence.latencyMs = recorded;
  for (const s of stateCopies(n)) s.judgments.at(-1).jevTurn.intervention.detailEvidence.latencyMs = recorded;
  for (const s of sideCopies(n)) if (s.label === tr(n).label) s.intervention.detailEvidence.latencyMs = replayed;
};
test('R2a: recorded 45 ms vs replayed 1 ms of the alternative detail evidence passes; the record keeps its own measurement', async () => {
  const n = await buildRecords({ dialoguePolicy: 'holistic_v3', technicalTrial: V3, turns: VETO_TURNS });
  assert.equal(typeof traceCopies(n)[0].intervention.detailEvidence.latencyMs, 'number', 'the veto produced a detail evidence');
  assert.deepEqual(all(n), PASS);
  setLatency(n, 45, 1);
  assert.deepEqual(all(n), PASS);
  setLatency(n, 471, 569);
  assert.deepEqual(all(n), PASS);
});

test('R2a controls: each latency is still a finite non-negative number of its own run; every reproducible leaf stays strict', async () => {
  const n = await buildRecords({ dialoguePolicy: 'holistic_v3', technicalTrial: V3, turns: VETO_TURNS });
  setLatency(n, 45, 1);
  for (const [name, edit] of [
    ['recorded latency negative', (x: any) => { for (const t of traceCopies(x)) t.intervention.detailEvidence.latencyMs = -1; for (const s of stateCopies(x)) s.judgments.at(-1).jevTurn.intervention.detailEvidence.latencyMs = -1; }],
    ['replayed latency not a number', (x: any) => { for (const s of sideCopies(x)) if (s.label === tr(x).label) s.intervention.detailEvidence.latencyMs = null; }],
    ['recorded detail score swapped', (x: any) => { for (const t of traceCopies(x)) { const k = Object.keys(t.intervention.detailEvidence.scores)[0]; const q = t.intervention.detailEvidence.scores[k]; const labels = Object.keys(q); q[labels[0]] = 0.123; } }],
    ['recorded detail cost changed', (x: any) => { for (const t of traceCopies(x)) t.intervention.detailEvidence.costUsd = 0.5; }],
  ] as Array<[string, (x: any) => void]>) {
    const x = structuredClone(n); edit(x);
    assert.notEqual(status(x, 'replay'), 'pass', name);
  }
});

// ---- R2b: a reobservation after the repair prospect, adaptive on/off x reobservation on/off, through the real runtime
const PRIOR_CONFIRM = { human: 'この形はどうですか', plan: { action: 'confirm', target: 'figure_0' } as Plan };
for (const adaptive of [false, true]) for (const reobserve of [false, true]) test(`R2b: prior confirm, ${adaptive ? 'adaptive' : 'plain'}, ${reobserve ? 'with' : 'without'} a self-side reobservation, ends in accept: all four checks pass`, async () => {
  const n = await buildRecords({ dialoguePolicy: 'holistic_v3', ...(adaptive ? { technicalTrial: V3 } : {}), turns: [PRIOR_CONFIRM, { human: 'もう少し詳しく見てください', plan: { ...NEUTRAL, reobserve } }] });
  assert.deepEqual(all(n), PASS);
  const t = tr(n).attempts[0];
  assert.deepEqual(t.decisions.map((d: any) => d.action), reobserve ? ['request_observation', 'accept'] : ['accept']);
  assert.equal(Object.hasOwn(t, 'repairProspect'), adaptive);
  assert.equal(t.reobservations.length, reobserve ? 1 : 0);
});

test('R2b controls: after the prospect, a later decision must carry the preceding reobservation result and the used allowance; an unrelated memo is a mismatch', async () => {
  const n = await buildRecords({ dialoguePolicy: 'holistic_v3', technicalTrial: V3, turns: [PRIOR_CONFIRM, { human: 'もう少し詳しく見てください', plan: { ...NEUTRAL, reobserve: true } }] });
  assert.deepEqual(all(n), PASS);
  const tamper = (edit: (x: any) => void) => { const x = structuredClone(n); edit(x); return status(x, 'replay'); };
  // The replayed results (tape) no longer match what the later request carries: an unrelated memo for the same figure.
  assert.equal(tamper(x => { const e = tr(x).replay[0]; e.tape.common.reobservations[0].figures[0].supports = ['unrelated-feature']; }), 'mismatch');
  // The recorded trace's own reobservation result differs from the tape's.
  assert.equal(tamper(x => { for (const t of traceCopies(x)) t.reobservations[0].result.figures[0].supports = ['unrelated-feature']; }), 'mismatch');
  // The prospect-time first decision cannot carry a merged memo, and the allowance after one reobservation is spent.
  assert.equal(tamper(x => { const e = tr(x).replay[0]; e.tape.common.reobservations = []; }), 'mismatch');
});

// ---- R1: public agree evidence per request, and the agree detail catalog
const PROPOSAL = (k: number, name = '船') => ({ human: `この形を${name}と呼びたいです`, plan: { ...NEUTRAL, act: 'name_propose',
  extraction: JSON.stringify([{ segmentId: 's1', quote: `この形を${name}と呼びたいです`, targets: [IDS[k]], aspect: 'name', proposition: `${name}と呼ぶ`, name, linkedIssueId: null, respondsToTurn: null }]) } as Plan });
for (const adaptive of [false, true]) test(`R1 detail (${adaptive ? 'adaptive' : 'plain'}): agree over a figure with one public proposal and an observation-derived candidate verifies with the public name only`, async () => {
  const n = await buildRecords({ dialoguePolicy: 'holistic_v3', ...(adaptive ? { technicalTrial: V3 } : {}), turns: [PROPOSAL(2), { human: 'そうですね', plan: { action: 'agree', target: 'figure_2', speech: 'はい、「船」と呼びましょう。' } }] });
  const t = tr(n).attempts[0];
  assert.equal(t.executed.action, 'agree');
  assert.deepEqual(tr(n).lastCommittedState.judgments.at(-1).jevTurn.agreeNames.map((a: any) => [a.name, a.figureId]), [['船', IDS[2]]]);
  const q = tr(n).replay[0].result.sides[0].requests.find((r: any) => r.provider === 'jev' && r.payload.questions.name)!.payload.questions.name.criteria;
  assert.equal(Object.keys(q).length, 1, JSON.stringify(q));
  assert.deepEqual(all(n), PASS);
  // Swapping the evidence to another figure: the saved source no longer matches the live claims.
  for (const s of stateCopies(n)) for (const a of s.judgments.at(-1).jevTurn.agreeNames) a.figureId = IDS[3];
  assert.equal(status(n, 'replay'), 'mismatch');
});

const FILLER = (h: number, s: number, f: number) => [PROPOSAL(2), { human: 'あ'.repeat(h), plan: { ...NEUTRAL, speech: 'い'.repeat(s) } }, { human: 'う'.repeat(f), plan: NEUTRAL }];
const firstActionRequest = (n: any) => tr(n).replay[0].result.sides[0].requests.find((r: any) => r.provider === 'jev' && r.payload.questions.action)!;
for (const adaptive of [false, true]) test(`R1 compaction (${adaptive ? 'adaptive' : 'plain'}): a source turn inside the 32-event window but compacted out of the request omits agree and still verifies; the short control keeps it`, async () => {
  const opts = adaptive ? { technicalTrial: V3 } : {};
  const compacted = await buildRecords({ dialoguePolicy: 'holistic_v3', ...opts, turns: FILLER(6000, 6000, 6000) });
  const request = firstActionRequest(compacted);
  assert.ok(!JSON.parse(request.payload.state).publicTurns.some((t: any) => t.turn === 1), 'turn 1 was compacted out');
  assert.ok(!('agree' in request.payload.questions.action.criteria), 'agree is withheld');
  assert.deepEqual(tr(compacted).lastCommittedState.judgments.at(-1).jevTurn.agreeNames.map((a: any) => a.sourceTurn), [1], 'the saved evidence still names turn 1 (32-event window)');
  assert.deepEqual(all(compacted), PASS);
  const short = await buildRecords({ dialoguePolicy: 'holistic_v3', ...opts, turns: FILLER(2500, 1000, 1500) });
  const kept = firstActionRequest(short);
  assert.ok(JSON.parse(kept.payload.state).publicTurns.some((t: any) => t.turn === 1));
  assert.ok('agree' in kept.payload.questions.action.criteria);
  assert.deepEqual(all(short), PASS);
});

test('R1 compaction controls: a forged agree label, a swapped source figure or a forged omission is a mismatch', async () => {
  const n = await buildRecords({ dialoguePolicy: 'holistic_v3', turns: FILLER(2500, 1000, 1500) });
  const swapped = structuredClone(n);
  for (const s of stateCopies(swapped)) for (const a of s.judgments.at(-1).jevTurn.agreeNames) a.figureId = IDS[4];
  assert.equal(status(swapped, 'replay'), 'mismatch');
  const dropped = structuredClone(n);
  for (const s of stateCopies(dropped)) s.judgments.at(-1).jevTurn.agreeNames = [];
  assert.equal(status(dropped, 'replay'), 'mismatch', 'the request offered agree, so an empty saved evidence is a forged omission');
});

// ---- R4 (S4 side): the local-rule failure trace through the public seam, in the real runtime's own shape
const FORBIDDEN: Array<[string, any]> = [['propose_name', { kind: 'none' }], ['propose_name', { kind: 'multiple', figureIds: [IDS[1], IDS[3]] }], ['confirm', { kind: 'none' }],
  ['repair', { kind: 'none' }], ['revisit', { kind: 'none' }], ['agree', { kind: 'none' }], ['agree', { kind: 'multiple', figureIds: [IDS[1], IDS[3]] }], ['request_observation', { kind: 'none' }]];
/** NORMAL records plus one failed attempt of the real runtime on the following human turn (own turn entry, so the attempt has an independent owner source). */
async function withFailedAttempt(plan: Plan) {
  const n = await buildRecords({ dialoguePolicy: 'holistic_v3', turns: [{ human: 'この形を見てください', plan: NEUTRAL }] });
  const m = normal.run.manifest, profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, 'two_stage_v3', 'holistic_v3')));
  const tape = tr(n).replay[0].tape, after = tr(n).lastCommittedState, last = tape.events.at(-1).seq;
  const events = [...tape.events, { id: 'ai-x', seq: last + 1, speaker: 'ai', text: 'ええ。' }, { id: 'human-x', seq: last + 2, speaker: 'human', text: 'もう一度' }];
  let failure: any;
  try { await runTurn(profile, tr(n).label, structuredClone(after), events, plan, undefined); } catch (e) { failure = e; }
  assert.ok(failure && failure.traces, 'the runtime refused the turn');
  const t = failure.traces.at(-1);
  tr(n).attempts.push(t);
  tr(n).turns.push({ turn: t.turnIndex, publicText: null, trace: [t], state: structuredClone(after) });
  return { n, failure };
}
const failedCopies = (n: any) => [tr(n).attempts[1], tr(n).turns[1].trace[0]];
const injection = (action: string, target: any) => ({ action, target, name: null, feature: null, observe: null, decisionKind: 'mock', calibrated: false,
  evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: null } });

test('R4-S4: all eight forbidden injected cells verify through the public seam; the native failure trace (invalid_response) still does', async () => {
  for (const [action, target] of FORBIDDEN) {
    const { n, failure } = await withFailedAttempt({ action, target: 'none', inject: injection(action, target) });
    assert.equal(failure.decisionRejectionCode, 'action_target_not_allowed', action);
    assert.deepEqual(all(n, 1), PASS, `${action} x ${target.kind}`);
  }
  const native = await withFailedAttempt({ action: 'accept', target: 'none', forceAction: 'agree' });
  const t = tr(native.n).attempts[1];
  assert.equal(t.decisionFailure.evidence.stages[0].error, 'invalid_response');
  assert.equal(Object.hasOwn(t, 'decisionRejectionCode'), false);
  assert.deepEqual(all(native.n, 1), PASS);
});

test('R4-S4 controls: an upper rule name deleted, an upper rule changed to agree_without_public_proposal, or a stage-zero latency of 19 ms are refused', async () => {
  const { n } = await withFailedAttempt({ action: 'revisit', target: 'none', inject: injection('revisit', { kind: 'none' }) });
  assert.deepEqual(all(n, 1), PASS);
  for (const [name, edit] of [
    ['upper decisionRejectionCode deleted', (c: any) => { delete c.decisionRejectionCode; }],
    ['upper decisionRejectionCode changed to agree_without_public_proposal', (c: any) => { c.decisionRejectionCode = 'agree_without_public_proposal'; }],
    ['stage-zero evidence latency 19', (c: any) => { c.decisionFailure.evidence.latencyMs = 19; }],
    ['error changed', (c: any) => { c.errorCode = 'decision_failed'; }],
  ] as Array<[string, (c: any) => void]>) {
    const x = structuredClone(n);
    for (const c of failedCopies(x)) edit(c);
    assert.equal(status(x, 'shape', 1), 'mismatch', name);
  }
});
