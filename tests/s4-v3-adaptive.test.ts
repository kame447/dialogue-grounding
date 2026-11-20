// audit/06 F3-F6 through the public seam: pairedInterventionReplay -> verifyRecords-style interventionChecks. The adaptive turns (first-turn agree-label
// omission, open_issue_v1 returning to an explicit earlier issue, ordinary re-ranking) are replayed from a genuine multi-turn history; controls that
// swap the trial version, the issue or the source must mismatch and missing evidence must stay unverified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { interventionChecks, s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { buildRecords, normal, runTurn, OLD } from './support/s4-v3-records.ts';
import type { Plan } from './support/s4-v3-records.ts';

const checksOf = (records: any) => interventionChecks(records);
const status = (records: any, suffix: string) => checksOf(records).find((c: any) => c.id === 'intervention.trial.0.attempt.0.' + suffix)?.status;
const all = (n: any) => ['shape', 'binding', 'execution', 'replay'].map(k => status(n, k));
const PASS = ['pass', 'pass', 'pass', 'pass'];
const V3 = { version: 'adaptive_repair_v3' } as const;
const trace = (n: any) => n.trials[0].attempts[0];
/** Every copy of the committed attempt: attempt, turn trace, turn state and last state judgments. */
const traceCopies = (n: any) => [trace(n), n.trials[0].turns[0].trace[0]];
const stateCopies = (n: any) => [n.trials[0].turns[0].state, n.trials[0].lastCommittedState];
const NEUTRAL: Plan = { action: 'accept', target: 'none' };

test('F3 (1) adaptive first turn: agreeNames=[] saved, agree absent, the replay verifies through the public seam', async () => {
  const n = await buildRecords({ technicalTrial: V3, turns: [{ human: 'この形を見てください', plan: NEUTRAL }] });
  assert.deepEqual(all(n), PASS);
  const j = n.trials[0].lastCommittedState.judgments[0].jevTurn;
  assert.deepEqual(j.agreeNames, []);
  assert.ok(Array.isArray(j.repairFacts) && j.repairGate);
  const q = n.trials[0].replay[0].result.sides[0].requests.find((r: any) => r.provider === 'jev').payload.questions;
  assert.ok(!('agree' in q.action.criteria));
});

test('F3 (1) controls: swapped version, dropped claim and a claim on a non-adaptive tape are mismatches; absent evidence is unverified', async () => {
  const n = await buildRecords({ technicalTrial: V3, turns: [{ human: 'この形を見てください', plan: NEUTRAL }] });
  for (const [name, edit] of [
    ['version v2 claimed for a v3 record', (t: any) => { t.technicalTrial = { version: 'adaptive_repair_v2' }; }],
    ['version v1 claimed for a v3 record', (t: any) => { t.technicalTrial = { version: 'adaptive_repair_v1' }; }],
    ['claim dropped from an adaptive record', (t: any) => { delete t.technicalTrial; }],
    ['unknown version', (t: any) => { t.technicalTrial = { version: 'adaptive_repair_v9' }; }],
  ] as Array<[string, (t: any) => void]>) {
    const x = structuredClone(n), entry = x.trials[0].replay[0];
    edit(entry.tape);
    for (const side of [...entry.result.sides, x.evidence.pairedReplay[0].left, x.evidence.pairedReplay[0].right]) { if (side.material.technicalTrial) { if (entry.tape.technicalTrial) side.material.technicalTrial = entry.tape.technicalTrial; else delete side.material.technicalTrial; } }
    assert.equal(status(x, 'replay'), 'mismatch', name);
  }
  // A non-adaptive record cannot claim to be adaptive: the trace has no gate or facts, only a v1 claim could stand, and then the trial text is proven absent.
  const plain = await buildRecords({ turns: [{ human: 'この形を見てください', plan: NEUTRAL }] });
  assert.deepEqual(all(plain), PASS);
  const forged = structuredClone(plain), e = forged.trials[0].replay[0];
  e.tape.technicalTrial = { version: 'adaptive_repair_v1' };
  for (const side of [...e.result.sides, forged.evidence.pairedReplay[0].left, forged.evidence.pairedReplay[0].right]) side.material.technicalTrial = e.tape.technicalTrial;
  assert.equal(status(forged, 'replay'), 'mismatch');
  // Missing evidence: no saved state for the committed attempt cannot be passed on.
  const missing = structuredClone(n);
  delete missing.trials[0].turns[0].state; delete missing.trials[0].lastCommittedState;
  assert.notEqual(status(missing, 'replay'), 'pass');
});

test('F3 (2) open_issue_v1: a veto of defer returns to the explicit earlier issue and verifies; swapped issue / source / candidates mismatch', async () => {
  const turns = [{ human: 'この形はどうですか', plan: { action: 'confirm', target: 'figure_0' } },
    { human: 'どこのことか分かりません', plan: { action: 'defer', target: 'figure_1', issue: 'issue_0', actionScores: { confirm: 0.7, repair: 0.6, defer: 1 } } }];
  const n = await buildRecords({ technicalTrial: V3, turns });
  assert.deepEqual(all(n), PASS);
  const t = trace(n);
  assert.equal(t.intervention.rerank.policyId, 'saved_action_scores_open_issue_v1');
  assert.deepEqual(t.intervention.rerank.source.candidates, [t.executed.target.figureId]);
  assert.equal(t.repairProspect.issue.choice, 'issue');
  const edits: Array<[string, (x: any) => void]> = [
    ['issue turn swapped in the trace', x => { for (const c of traceCopies(x)) c.intervention.rerank.source.issueTurn += 1; }],
    ['issue id swapped in the trace', x => { for (const c of traceCopies(x)) c.intervention.rerank.source.issueId = 'x:forged'; }],
    ['candidate set swapped in the trace', x => { for (const c of traceCopies(x)) c.intervention.rerank.source.candidates = ['s-0004']; }],
    ['prospect issue turned into none in the trace', x => { for (const c of traceCopies(x)) c.repairProspect = { ...c.repairProspect, issue: { choice: 'none' } }; }],
    ['prospect score swapped in the trace', x => { for (const c of traceCopies(x)) c.repairProspect.scores.prospect.stalled = 0.5; }],
  ];
  for (const [name, edit] of edits) {
    const x = structuredClone(n); edit(x);
    for (const s of stateCopies(x)) { const jt = s.judgments.at(-1).jevTurn; jt.intervention = structuredClone(trace(x).intervention); jt.repairProspect = structuredClone(trace(x).repairProspect); }
    assert.ok(all(x).includes('mismatch'), name + ' ' + all(x));
  }
});

test('F3 (3) ordinary re-ranking after a prospect that names no issue verifies; a forged open-issue ranking for it mismatches', async () => {
  const turns = [{ human: 'この形はどうですか', plan: { action: 'confirm', target: 'figure_0' } },
    { human: 'どれのことでしょう', plan: { action: 'move_on', target: 'figure_2', issue: 'none', actionScores: { accept: 0.2, confirm: 0.5, repair: 0.4, close: 0.1, move_on: 1 } } }];
  const n = await buildRecords({ technicalTrial: V3, turns });
  assert.deepEqual(all(n), PASS);
  const t = trace(n);
  assert.equal(t.intervention.rerank.policyId, 'saved_action_scores_v1');
  assert.deepEqual(t.executed.target, t.decisions.at(-1).target);
  assert.equal(t.repairProspect.issue.choice, 'none');
  const x = structuredClone(n);
  for (const c of [...traceCopies(x), ...stateCopies(x).map((s: any) => s.judgments.at(-1).jevTurn)]) {
    c.repairProspect = { ...c.repairProspect, issue: { choice: 'issue', turn: 1, issueId: null } };
  }
  assert.ok(all(x).includes('mismatch'), all(x).join());
});

test('F5-S4: a multiple revisit keeps every slot of a mixed ledger; one slot rewritten in both state copies mismatches', async () => {
  const slots = normal.trials[0].replay[0].result.sides[0].material.own.ownAnchors.map((a: any) => a.id);
  const ledger = Object.fromEntries(slots.map((id: string, i: number) => [id, [{ status: 'agreed', name: '船' }, { status: 'tentative', name: '船' }, { status: 'deferred', name: '山' },
    { status: 'unassigned', name: null }, { status: 'tentative', name: '橋' }, { status: 'unassigned', name: null }][i]]));
  const turns = [{ human: '二つのどちらかです', plan: { action: 'revisit', target: 'figures_0_3' } }];
  const n = await buildRecords({ label: 'bypass-enabled', turns, ledger });
  assert.deepEqual(all(n), PASS);
  assert.deepEqual(n.trials[0].lastCommittedState.ledger, ledger);
  const x = structuredClone(n);
  for (const s of stateCopies(x)) s.ledger[slots[3]] = { status: 'agreed', name: '勝手な名前' };
  const s = all(x);
  assert.ok(s.includes('mismatch'), s.join());
  // Only the last committed copy changed: the turn state and the last state differ from each other.
  const y = structuredClone(n); y.trials[0].lastCommittedState.ledger[slots[3]] = { status: 'agreed', name: '勝手な名前' };
  assert.ok(all(y).includes('mismatch'));
  // The same tampering on a single-target revisit is a legitimate ledger update and is not judged by this rule.
  const single = await buildRecords({ label: 'bypass-enabled', turns: [{ human: 'この形です', plan: { action: 'revisit', target: 'figure_3' } }], ledger });
  assert.deepEqual(all(single), PASS);
});

test('F5-S4: confirm / repair on a candidate set and an unresolved defer also keep the ledger', async () => {
  for (const plan of [{ action: 'confirm', target: 'figures_0_1' }, { action: 'defer', target: 'figures_0_1' }, { action: 'defer', target: 'none' }]) {
    const n = await buildRecords({ label: 'bypass-enabled', turns: [{ human: '二つのどちらかです', plan }] });
    assert.deepEqual(all(n), PASS, plan.action + plan.target);
    const x = structuredClone(n), id = Object.keys(n.trials[0].lastCommittedState.ledger)[2];
    for (const s of stateCopies(x)) s.ledger[id] = { status: 'tentative', name: '改変' };
    assert.ok(all(x).includes('mismatch'), plan.action + plan.target);
  }
});

test('F6-S4: the local-rule failure record verifies on v3 only, in both places, and nothing looser', () => {
  const evidence = () => ({ schemaVersion: 'jev_decision_failure_v1', questionLayout: 'two_stage_v3', callIndex: 3, error: 'invalid_decision', rejectionCode: 'action_target_not_allowed',
    model: null, responseId: null, costUsd: null, latencyMs: 0, inputBudget: null, stages: [] });
  const base = () => { const t = structuredClone(trace(normalRecordsSync())); return t; };
  const failed = (over: any = {}, ev: any = {}) => ({ ...base(), status: 'error', errorCode: 'invalid_decision', decisions: [], intervention: null, executed: null, finalAction: null, publicSpeech: null,
    decisionRejectionCode: 'action_target_not_allowed', decisionFailure: { evidence: { ...evidence(), ...ev } }, ...over });
  const shape = (t: any, layout = 'two_stage_v3') => s4Probe.traceShape(t, layout);
  assert.equal(shape(failed()), true);
  assert.equal(shape(failed({}, { questionLayout: 'two_stage_v2' }), 'two_stage_v2'), false);
  assert.equal(shape(failed({ decisionRejectionCode: undefined })), false);
  assert.equal(shape(failed({ errorCode: 'decision_failed' })), false);
  assert.equal(shape(failed({}, { model: 'typesafe/jev-1.14' })), false);
  assert.equal(shape(failed({}, { costUsd: 0 })), false);
  assert.equal(shape(failed({}, { inputBudget: { maxChars: 20000, stateChars: 1, omitted: {} } })), false);
  assert.equal(shape(failed({}, { error: 'inconsistent_decision' })), false);
  assert.equal(shape(failed({}, { stages: [{}] })), false);
  const stray = failed(); delete (stray as any).decisionFailure;
  assert.equal(shape(stray), false);
});
let cached: any;
function normalRecordsSync() { return cached ??= structuredClone(normal); }

// ---- F4: the runtime's own window for the agree evidence -------------------------------------------------------------------------------
const FIG = ['s-0000', 's-0001', 's-0002', 's-0003', 's-0004', 's-0005'];
const claim = (id: string, name: string, sourceTurn: number, turn: number, target: string, over: any = {}) => ({ kind: 'claim', id, issueId: id, turn, sourceTurn, targets: [target], aspect: 'name',
  act: 'name_propose', proposition: name, name, speaker: 'human', quote: name, respondsTo: null, source: 'human_utterance', ...over });
/** A turn-44 shape: public events 1..44, the window is turns 13..44; only turn 40 names ポポ, the older claims name words that exist only outside the window. */
function agreeCase(names: any[], { aiPublic = true, claims = [] as any[], events = undefined as any } = {}) {
  const ev = events ?? Array.from({ length: 44 }, (_, i) => ({ id: 'e' + (i + 1), seq: i + 1, speaker: i % 2 ? 'ai' : 'human',
    text: i + 1 === 40 ? 'それはポポです' : [4, 6, 7].includes(i + 1) ? ['うさぎ', 'ねこ', 'くま'][[4, 6, 7].indexOf(i + 1)] + 'です' : '発話' + (i + 1) }));
  const graph = { records: [claim('40:h1', 'ポポ', 40, 44, FIG[2]), claim('4:h1', 'うさぎ', 4, 5, FIG[0]), claim('6:h1', 'ねこ', 6, 7, FIG[1]), claim('7:h1', 'くま', 7, 8, FIG[3]), ...claims] };
  const state = { ledger: Object.fromEntries(FIG.map(id => [id, { status: 'unassigned', name: null }])), graph,
    judgments: [{ turnIndex: 44, lastEventId: 'e44', status: 'committed', jevTurn: { attemptNumber: 44, agreeNames: names } }] };
  const tr = { turns: [{ turn: 44, state }], lastCommittedState: state, profile: { id: 'research_trial_profile_v3', questionLayout: 'two_stage_v3', localGrounding: { enabled: true, aiPublicClaims: aiPublic } } };
  return s4Probe.agreeSource(tr, { turnIndex: 44, lastEventId: 'e44', attemptNumber: 44 }, JSON.stringify([44, 'e44', 44]), { events: ev });
}
test('F4: the one genuine source inside the 32-turn window passes; sources outside it are refused (also when the old sources are listed again)', () => {
  const genuine = [{ name: 'ポポ', figureId: FIG[2], sourceTurn: 40 }];
  assert.deepEqual(agreeCase(genuine), { known: true, names: genuine });
  const widened = [...genuine, { name: 'うさぎ', figureId: FIG[0], sourceTurn: 4 }, { name: 'ねこ', figureId: FIG[1], sourceTurn: 6 }, { name: 'くま', figureId: FIG[3], sourceTurn: 7 }];
  assert.equal(agreeCase(widened), 'invalid');
  assert.equal(agreeCase([{ name: 'うさぎ', figureId: FIG[0], sourceTurn: 4 }]), 'invalid');
  assert.equal(agreeCase([]), 'invalid');
  assert.equal(agreeCase([{ name: 'ポポ', figureId: FIG[2], sourceTurn: 41 }]), 'invalid');
  assert.equal(agreeCase([{ name: 'ポポ', figureId: FIG[1], sourceTurn: 40 }]), 'invalid');
});
test('F4: an inherited name takes the earliest windowed turn that holds it; a duplicated seq is dropped when AI public claims are on; the 160 newest claims count', () => {
  // A name_accept that inherits the name: its own sourceTurn text lacks the literal, so the earliest windowed turn holding it is the source.
  const inherit = [claim('44:a1', 'ポポ', 43, 44, FIG[2], { act: 'name_accept', speaker: 'ai' })];
  const names = [{ name: 'ポポ', figureId: FIG[2], sourceTurn: 40 }, { name: 'ポポ', figureId: FIG[2], sourceTurn: 40 }];
  assert.deepEqual(agreeCase(names, { claims: inherit }), { known: true, names });
  // Turn 40 appearing twice: with AI public claims on the duplicate seq leaves the window, so the source disappears; without them it stays.
  const events = Array.from({ length: 44 }, (_, i) => ({ id: 'e' + (i + 1), seq: i + 1, speaker: 'human', text: i + 1 === 40 ? 'それはポポです' : '発話' + (i + 1) }));
  events.push({ id: 'e40b', seq: 40, speaker: 'ai', text: 'ポポですね' });
  const genuine = [{ name: 'ポポ', figureId: FIG[2], sourceTurn: 40 }];
  assert.equal(agreeCase(genuine, { events }), 'invalid');
  assert.deepEqual((agreeCase([], { events }) as any).names, []);
  assert.deepEqual(agreeCase(genuine, { events, aiPublic: false }), { known: true, names: genuine });
  // A v3 judgment without saved agree evidence is a forged omission; without a judgment the source is unknown.
  const lost = structuredClone({ turns: [{ turn: 44, state: { judgments: [{ turnIndex: 44, lastEventId: 'e44', jevTurn: { attemptNumber: 44 } }], ledger: {}, graph: { records: [] } } }],
    profile: { id: 'research_trial_profile_v3', questionLayout: 'two_stage_v3' } });
  assert.equal(s4Probe.agreeSource(lost, { turnIndex: 44, lastEventId: 'e44' }, JSON.stringify([44, 'e44', 44]), { events: [] }), 'invalid');
  assert.deepEqual(s4Probe.agreeSource({ turns: [], profile: lost.profile }, { turnIndex: 44, lastEventId: 'e44' }, JSON.stringify([44, 'e44', 44]), { events: [] }), { known: false, names: undefined });
});

// ---- F6 end to end: the runtime's own trace of a refused injected decision is what S4 accepts ---------------------------------------------
const INJECTED_CELLS: Array<[string, any]> = [['agree', { kind: 'multiple', figureIds: ['s-0000', 's-0001'] }], ['propose_name', { kind: 'none' }], ['confirm', { kind: 'none' }],
  ['revisit', { kind: 'none' }], ['request_observation', { kind: 'none' }]];
test('F6: every injected forbidden pair leaves action_target_not_allowed in the trace and its failure record, and S4 accepts exactly that trace', async () => {
  const m = normal.run.manifest, profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, 'two_stage_v3')));
  for (const [action, target] of INJECTED_CELLS) {
    const inject = { action, target, name: null, feature: null, observe: null, decisionKind: 'mock', calibrated: false, evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: null } };
    let failure: any;
    try { await runTurn(profile, 'bypass-enabled', structuredClone(OLD.state), structuredClone(OLD.events), { action, target: 'none', inject }, undefined); } catch (e) { failure = e; }
    assert.ok(failure && failure.code === 'invalid_decision', action + ' ' + failure?.code);
    assert.equal(failure.decisionRejectionCode, 'action_target_not_allowed');
    const t = failure.traces.at(-1);
    assert.equal(t.decisionRejectionCode, 'action_target_not_allowed');
    assert.deepEqual(t.decisionFailure.evidence.stages, []);
    assert.equal(t.decisionFailure.evidence.rejectionCode, 'action_target_not_allowed');
    assert.equal(s4Probe.traceShape(t, 'two_stage_v3'), true, action);
    assert.equal(s4Probe.traceShape(t, 'two_stage_v2'), false);
    const looser = structuredClone(t); looser.decisionFailure.evidence.stages = [{}];
    assert.equal(s4Probe.traceShape(looser, 'two_stage_v3'), false);
  }
});
