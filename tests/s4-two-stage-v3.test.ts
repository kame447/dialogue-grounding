// audit/05 F3 and the two_stage_v3 rows of §6: the independent S4 verifier accepts the explicit two_stage_v3 layout (action, target, detail),
// the multiple revisit, the veto re-ranking and the reobservation turn, and refuses tampered evidence. Records come from the real runtime and
// the real offline replay over synthetic material; the adaptive sources (open_issue_v1 re-ranking, per-figure agreeNames) cannot be replayed
// offline, so those reconstructions are proven through the verifier's test hook against hand-built request material. No network, key or study data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { interventionChecks, s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { createJevDecisionClient, TWO_STAGE_V2_CANDIDATE_SETS, candidateSetLabel } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { buildReobservationMessages } from '../dialogue-model/runtime/observation/observe.ts';
import { image } from './support/s4-integration/harness.ts';

const normal = JSON.parse(await readFile(new URL('./support/s4-integration/NORMAL-RECORDS.json', import.meta.url), 'utf8'));
const checksOf = (records: any) => interventionChecks(records);
const status = (records: any, suffix: string) => checksOf(records).find((c: any) => c.id === 'intervention.trial.0.attempt.0.' + suffix)?.status;
const OWN = { ownImage: image, ownAnchors: normal.trials[0].replay[0].result.sides[0].material.own.ownAnchors };
const MODEL = normal.trials[0].replay[0].result.sides[0].material.model;
const OLD = normal.trials[0].replay[0].tape;
const SET_LABELS = TWO_STAGE_V2_CANDIDATE_SETS.map(candidateSetLabel);
const ACTIONS = ['accept', 'propose_name', 'confirm', 'repair', 'defer', 'revisit', 'agree', 'move_on', 'close', 'request_observation'];
const ASPECTS = ['orientation', 'part', 'contour', 'construal', 'referent'];
const FIGURES = [0, 1, 2, 3, 4, 5].map(i => 'figure_' + i);
const subsets = (n: number) => Array.from({ length: 2 ** n - 1 }, (_, i) => 'subset_' + i);
/** The independent oracle of the legal target labels per action over the NORMAL material (every figure has a name, a feature and a reobservation allowance). */
const TARGETS = (action: string) => ['accept', 'defer', 'move_on', 'close'].includes(action) ? ['none', ...FIGURES, ...SET_LABELS]
  : ['propose_name', 'agree'].includes(action) ? FIGURES : [...FIGURES, ...SET_LABELS];
const answer = (choice: string, keys: string[], override: Record<string, number> = {}) => ({ type: 'choice', choice,
  probabilities: Object.fromEntries(keys.map(k => [k, override[k] ?? (k === choice ? 1 : 0)])) });
const jevResponse = (id: string, answers: Record<string, unknown>) => ({ model: 'typesafe/jev-1.14', id: 'gen-s4v3-' + id, usage: { cost: 0 }, answers });
const stageOne = (id: string, action: string, override: Record<string, number> = {}, keys = ACTIONS.filter(a => a !== 'agree')) => jevResponse(id + '-action', { action: answer(action, keys, override) });
const stageTwo = (id: string, action: string, target: string) => jevResponse(id + '-target', { target: answer(target, TARGETS(action)) });

async function recordedRun(profile: any, tape: any, label: 'repair-first' | 'bypass-enabled', learn?: (input: any) => any) {
  const luna = [...tape.common.luna, ...tape.tails[label].luna], jev = [...tape.common.jev, ...tape.tails[label].jev];
  const fixed = [...tape.common.reobservations], made: any[] = [], traces: any[] = [];
  let next: any;
  const http = createChatClient({ provider: 'cloudflare', apiKey: 'synthetic-offline-replay-key', purpose: profile.modelPolicy.purpose,
    baseUrl: 'http://offline.invalid/v1', timeoutMs: profile.timeouts.lunaAttemptMs },
  async () => Response.json({ model: next.model, choices: [{ message: { content: next.text } }],
    usage: { prompt_tokens: next.usage?.inputTokens, completion_tokens: next.usage?.outputTokens } }));
  const client = { async complete(messages: any[], options: any) { const n = luna.shift(); assert.equal(n.phase, options.phase); next = n.response; return http.complete(messages, options); } };
  const readKey = async () => 'sk-or-SYNTHETIC-offline-replay-key-0000', fetchImpl = async () => Response.json(jev.shift());
  const native = createJevDecisionClient({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs,
    researchLimits: { maxDeadlineMs: 600000 }, questionLayout: profile.questionLayout })!;
  const runtime = createProfileDialogue(profile, { client, image: OWN.ownImage, anchors: [...OWN.ownAnchors], strategy: label,
    observer: { async observeAll() { return structuredClone(tape.state.observationMemo); },
      async reobserve(input: any) { const result = learn ? learn(input) : structuredClone(fixed.shift()); made.push(structuredClone(result));
        await client.complete(buildReobservationMessages(input), { phase: 'observation_targeted' }); return result; } },
    jevDecision: { decide: (i: any, o: any) => native.decide(i, o), completeDetail: (i: any, s: any, o: any) => native.completeDetail!(i, s, o) },
    localGrounding: { classifier: createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.localMs, researchLimits: { maxDeadlineMs: 600000 } })!,
      aiPublicTransport: { readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs } },
    onJevTurnTrace: (t: any) => traces.push(t) } as any);
  const result: any = await runtime.runAiTurn({ events: tape.events, privateState: tape.state, lastEventId: tape.events.at(-1).id, requestSeq: tape.events.at(-1).seq });
  assert.deepEqual([luna.length, jev.length], [0, 0]);
  return { trace: { ...structuredClone(traces.at(-1)), status: 'committed' }, state: structuredClone(result.privateState), reobservations: made };
}
/** NORMAL rebuilt as one canonical trial of the given layout, label and Jev responses (the s4-two-stage-v2 pattern). */
async function records(layout: 'two_stage_v2' | 'two_stage_v3', jev: any[], { reobservation = false, label = 'bypass-enabled' as 'repair-first' | 'bypass-enabled', generationText = null as string | null } = {}) {
  const n = structuredClone(normal), tr = n.trials[0], m = n.run.manifest;
  const profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, layout)));
  const digest = hash(profile);
  for (const s of [n.run, n.summary, tr]) { s.profile = structuredClone(profile); s.profileSha256 = digest; }
  tr.identity.profile = digest;
  tr.label = label; m.trials[0].label = label; n.summary.runOrder[0].label = label;
  const tape: any = { ...structuredClone(OLD), common: { ...structuredClone(OLD.common), jev }, recorded: { label, expectedRequests: [] } };
  if (generationText !== null) {
    for (const side of Object.values(tape.tails ?? {}) as any[]) {
      for (const l of side.luna ?? []) if (l.phase === 'generation') l.response = { ...l.response, text: generationText };
    }
    for (const l of tape.common.luna ?? []) if (l.phase === 'generation') l.response = { ...l.response, text: generationText };
  }
  if (reobservation) {
    tape.common.luna = [...tape.common.luna, { ...structuredClone(OLD.common.luna[0]), phase: 'observation_targeted' }];
    const learned = await recordedRun(profile, tape, label, (input: any) => ({ observedAt: '2026-01-01T00:00:01.000Z', issue: structuredClone(input.issue),
      figures: input.figureIds.map((figureId: string) => ({ figureId, supports: ['control-feature'], contradicts: [], unknown: [] })) }));
    tape.common.reobservations = learned.reobservations;
  }
  const probe: any = await pairedInterventionReplay(tape, OWN as any, MODEL, profile);
  const recorded = probe.sides.find((s: any) => s.label === label);
  tape.recorded.expectedRequests = recorded.requests.map((r: any, i: number) => ({ provider: r.provider, phase: r.phase, requestSha256: r.preProjectionPayloadSha256,
    actualSendMeasured: true, sendIds: [i + 1], ...(r.provider === 'luna' ? { messagesSha256: r.completeMessagesSha256 } : {}) }));
  const result: any = await pairedInterventionReplay(tape, OWN as any, MODEL, profile);
  assert.equal(result.status, 'same_material_intervention_verified', String(result.error));
  const { trace, state } = await recordedRun(profile, tape, label);
  const template = (provider: string) => normal.trials[0].calls.find((c: any) => c.provider === provider);
  tr.calls = recorded.requests.map((r: any, i: number) => ({ ...structuredClone(template(r.provider)), id: i + 1, sendIds: [i + 1], phase: r.phase, turn: 1,
    requestSha256: r.provider === 'luna' ? r.completeMessagesSha256 : r.preProjectionPayloadSha256,
    ...(r.provider === 'luna' ? { expectedHttpRequestSha256: r.preProjectionPayloadSha256, httpRequestSha256: r.preProjectionPayloadSha256 } : {}) }));
  tr.http = recorded.requests.flatMap((r: any, i: number) => r.provider === 'luna' ? [{ method: 'POST', kind: 'completion_post', phase: r.phase, callId: i + 1, sendId: i + 1,
    hashScheme: 'canonical_json_sha256', requestSha256: r.preProjectionPayloadSha256, status: 200, outcome: 'returned' }] : []);
  tr.attempts = [trace];
  tr.turns = [{ ...structuredClone(tr.turns[0]), publicText: trace.publicSpeech, trace: [structuredClone(trace)], state: structuredClone(state) }];
  tr.lastCommittedState = structuredClone(state); tr.replay = [{ tape, result }];
  n.evidence.pairedReplay = [{ trialOrder: 0, turn: 1, left: result.sides[0], right: result.sides[1] }];
  return JSON.parse(JSON.stringify(n));
}
const pass = (n: any) => { const cs = checksOf(n); assert.ok(cs.length >= 5); for (const c of cs) assert.equal(c.status, 'pass', c.id + ' ' + c.reason); };
const sideCopies = (n: any) => [...n.trials[0].replay[0].result.sides, n.evidence.pairedReplay[0].left, n.evidence.pairedReplay[0].right];
/** Every copy of the committed decision: attempt, turn trace, turn state and last state. */
const copies = (n: any, index = 0) => { const tr = n.trials[0]; return [tr.attempts[0].decisions[index], tr.turns[0].trace[0].decisions[index],
  tr.turns[0].state.judgments[0].jevTurn.decision, tr.lastCommittedState.judgments[0].jevTurn.decision]; };

const normalV3 = () => records('two_stage_v3', [stageOne('n', 'accept'), stageTwo('n', 'accept', 'none')]);

test('v3 normal: accept / none passes all S4 checks with stages action, target', async () => {
  const n = await normalV3(); pass(n);
  const d = n.trials[0].attempts[0].decisions[0];
  assert.deepEqual(d.evidence.stages.map((s: any) => s.stage), ['action', 'target']);
  assert.deepEqual(Object.keys(d.evidence.choices), ['action']);
  assert.deepEqual(d.target, { kind: 'none' });
});

test('v3 revisit x multiple: the candidate set is kept, the judgment has no slot, the ledger is unchanged, and every S4 check passes', async () => {
  const n = await records('two_stage_v3', [stageOne('r', 'revisit'), stageTwo('r', 'revisit', 'figures_0_2')]); pass(n);
  const t = n.trials[0].attempts[0];
  assert.deepEqual(t.executed, { action: 'revisit', target: { kind: 'multiple', figureIds: ['s-0000', 's-0002'] }, name: null, feature: null, observe: null, detailFigureIds: [] });
  assert.equal(t.finalAction.targetSlot, null); assert.equal(t.finalAction.action, 'revisit');
  assert.deepEqual(n.trials[0].lastCommittedState.ledger, normal.trials[0].replay[0].tape.state.ledger);
  assert.equal(t.repairHistory.at(-1).action, 'revisit'); assert.deepEqual(t.repairHistory.at(-1).candidatesAfter, ['s-0000', 's-0002']);
});

test('v3 detail actions: confirm / single (feature) and propose_name / single (name) pass; a forged detail candidate fails', async () => {
  const confirm = await records('two_stage_v3', [stageOne('c', 'confirm'), stageTwo('c', 'confirm', 'figure_1'), jevResponse('c-detail', { feature: answer('feature_0', ['feature_0', 'feature_1']) })]); pass(confirm);
  assert.deepEqual(confirm.trials[0].attempts[0].decisions[0].evidence.stages.map((s: any) => s.stage), ['action', 'target', 'detail']);
  const name = await records('two_stage_v3', [stageOne('p', 'propose_name'), stageTwo('p', 'propose_name', 'figure_2'), jevResponse('p-detail', { name: answer('name_0', ['name_0']) })], { generationText: '「name-2」と呼ぶのはどうでしょう？' }); pass(name);
  const forged = structuredClone(name);
  for (const d of copies(forged)) { d.name = 'forged-name'; }
  for (const j of [forged.trials[0].attempts[0], forged.trials[0].turns[0].trace[0]]) { j.executed.name = 'forged-name'; j.intervention.original.name = 'forged-name'; }
  assert.deepEqual(['shape','binding','execution','replay'].map(k=>status(forged,k)), ['pass', 'mismatch', 'mismatch', 'mismatch'], 'forged name evidence');
});

test('v3 reobservation: request_observation / multiple -> target -> observe detail -> observation_targeted -> accept passes all checks', async () => {
  const keysAfter = ACTIONS.filter(a => a !== 'request_observation' && a !== 'agree');
  const n = await records('two_stage_v3', [stageOne('o', 'request_observation'), stageTwo('o', 'request_observation', 'figures_0_2'),
    jevResponse('o-detail', { observe_targets: answer('subset_0', subsets(2)), observe_aspect: answer('orientation', ASPECTS) }),
    stageOne('o2', 'accept', {}, keysAfter), stageTwo('o2', 'accept', 'none')], { reobservation: true });
  const t = n.trials[0].attempts[0];
  assert.deepEqual(t.decisions.map((d: any) => [d.action, d.evidence.stages.map((s: any) => s.stage)]),
    [['request_observation', ['action', 'target', 'detail']], ['accept', ['action', 'target']]]);
  pass(n);
});

test('v3 veto re-ranking: defer / multiple under repair-first re-ranks over that target (revisit x multiple kept) and passes; swapped original / executed fails', async () => {
  const n = await records('two_stage_v3', [stageOne('v', 'defer', { revisit: 0.9, accept: 0.1 }), stageTwo('v', 'defer', 'figures_1_3')], { label: 'repair-first' }); pass(n);
  const t = n.trials[0].attempts[0];
  assert.equal(t.intervention.disposition, 'rejected');
  assert.deepEqual(t.executed, { action: 'revisit', target: { kind: 'multiple', figureIds: ['s-0001', 's-0003'] }, name: null, feature: null, observe: null, detailFigureIds: [] });
  assert.deepEqual(t.intervention.rerank.ranking.map((r: any) => r.action), ['revisit', 'accept', 'confirm', 'repair', 'close']);
  const swapped = structuredClone(n);
  for (const x of [swapped.trials[0].attempts[0], swapped.trials[0].turns[0].trace[0]]) { const e = x.executed; x.executed = x.intervention.original; x.intervention.original = e; }
  assert.deepEqual(['shape','binding','execution','replay'].map(k=>status(swapped,k)), ['pass', 'mismatch', 'mismatch', 'mismatch'], 'original and executed exchanged');
});

test('v3 tampering: swapped candidate set, dropped stage, label outside the offered set and layout crossing are refused', async () => {
  const n = await records('two_stage_v3', [stageOne('t', 'revisit'), stageTwo('t', 'revisit', 'figures_0_2')]);
  const swapped = structuredClone(n);
  for (const d of copies(swapped)) { d.evidence.stages[1].choices.target = 'figures_0_3'; d.target.figureIds = ['s-0000', 's-0003']; }
  assert.equal(status(swapped, 'replay'), 'mismatch', 'set swapped consistently in every copy');
  const half = structuredClone(n); for (const d of copies(half)) d.evidence.stages[1].choices.target = 'figures_0_3';
  assert.deepEqual(['shape','binding','execution','replay'].map(k=>status(half,k)), ['pass', 'pass', 'pass', 'mismatch'], 'set swapped in the evidence only');
  const dropped = structuredClone(n); for (const d of copies(dropped)) d.evidence.stages.splice(1, 1);
  assert.equal(status(dropped, 'shape'), 'mismatch');
  // revisit may not take none: the label is not in its target question, in the evidence or the wire.
  const outside = structuredClone(n);
  for (const d of copies(outside)) { d.evidence.stages[1].choices.target = 'none'; d.target = { kind: 'none' }; }
  assert.deepEqual(['shape','binding','execution','replay'].map(k=>status(outside,k)), ['mismatch', 'mismatch', 'mismatch', 'mismatch'], 'none is not a revisit target');
  const noneOffered = structuredClone(n);
  for (const d of copies(noneOffered)) { d.evidence.stages[1].scores.target = { none: 1, ...d.evidence.stages[1].scores.target }; }
  assert.deepEqual(['shape','binding','execution','replay'].map(k=>status(noneOffered,k)), ['pass', 'pass', 'pass', 'mismatch'], 'none inserted into the scores of a revisit target question');
  // a v3 record under the v2 profile and a v2 record under the v3 profile are not each other's layout.
  const asV2 = structuredClone(n), p2 = JSON.parse(JSON.stringify(researchTrialProfileV3(normal.run.manifest.lunaRequest, normal.run.manifest.timeouts, 'two_stage_v2'))), h2 = hash(p2);
  for (const s of [asV2.run, asV2.summary, asV2.trials[0]]) { s.profile = structuredClone(p2); s.profileSha256 = h2; }
  asV2.trials[0].identity.profile = h2;
  assert.equal(status(asV2, 'shape'), 'mismatch');
  const v2 = await records('two_stage_v2', [jevResponse('x-1', { action: answer('accept', ACTIONS), target: answer('none', ['none', 'multiple', ...FIGURES]) })]);
  pass(v2);
  const p3 = JSON.parse(JSON.stringify(researchTrialProfileV3(normal.run.manifest.lunaRequest, normal.run.manifest.timeouts, 'two_stage_v3'))), h3 = hash(p3);
  const asV3 = structuredClone(v2);
  for (const s of [asV3.run, asV3.summary, asV3.trials[0]]) { s.profile = structuredClone(p3); s.profileSha256 = h3; }
  asV3.trials[0].identity.profile = h3;
  assert.equal(status(asV3, 'shape'), 'mismatch');
});

test('v3 request tampering: an action offered without a legal target, or a reduced target question, fails the replay', async () => {
  const n = await normalV3();
  for (const [name, edit] of [
    ['agree offered without any saved public evidence', (q: any) => { q.action.criteria.agree = 'x'; }],
    ['target question gains a label', (q: any) => { q.target.criteria.extra = 'x'; }],
    ['target question loses none', (q: any) => { delete q.target.criteria.none; }],
  ] as Array<[string, (q: any) => void]>) {
    const t = structuredClone(n);
    for (const side of sideCopies(t)) {
      for (const r of side.requests.filter((x: any) => x.provider === 'jev')) {
        const q = r.payload.questions; if (!q.action && !q.target) continue;
        if (name.startsWith('agree') && !q.action) continue; if (!name.startsWith('agree') && !q.target) continue;
        edit(q); r.payloadSha256 = hash(r.payload);
      }
    }
    assert.deepEqual(['shape','binding','execution','replay'].map(k=>status(t,k)), ['pass', 'pass', 'pass', 'mismatch'], name);
  }
});

// ---- adaptive sources, through the verifier's test hook ------------------------------------------------------------------------------
const slots = Array.from({ length: 6 }, (_, i) => 's-000' + i);
const material = (over: any = {}) => ({ turn: 9, ownSlots: slots, reobservationAllowed: true, publicNames: [],
  observations: slots.map(id => ({ figureId: id, holistic: [{ construal: '船' }], analytic: { shapes: ['三角'], composition: '構成', relations: [] }, reobservations: [] })),
  repairHistory: [], previousAction: null, ...over });
const target = (ids: string[]) => ids.length === 1 ? { kind: 'single', figureId: ids[0] } : { kind: 'multiple', figureIds: ids };
const scores = { accept: 0.1, propose_name: 0.2, confirm: 0.6, repair: 0.5, defer: 0.9, revisit: 0.7, agree: 0.3, move_on: 0.4, close: 0.05, request_observation: 0 };
const entry = { turn: 5, issueId: '5:a', action: 'confirm', question: 'q', partnerClaims: [], candidatesBefore: [slots[0], slots[2]], candidatesAfter: [slots[0], slots[2]], addedClaimIds: [], removedClaimIds: [], progress: 'unknown' };
const prospect = (over: any = {}) => ({ status: 'ok', issue: { choice: 'issue', turn: 5, issueId: '5:a' }, prospect: 'progressing', basis: 'none', scores: { repair_issue: { issue_0: 1, none: 0, unknown: 0 }, prospect: {}, basis: {} }, ...over });
const veto = (d: any) => ({ disposition: 'rejected', rerank: d });

test('F3 open_issue_v1: the recorded ranking is rebuilt from the explicit issue, with revisit only after a same-target defer', () => {
  s4Probe.setContext({});
  const base = material({ repairHistory: [entry], repairProspect: prospect() });
  const decision = { action: 'defer', target: target([slots[4], slots[5]]), evidence: { stages: [{ scores: { action: scores } }] } };
  const source = { issueTurn: 5, issueId: '5:a', choice: 'issue', candidates: [slots[0], slots[2]] };
  const mk = (ranking: any[], selected = ranking[0].action) => ({ policyId: 'saved_action_scores_open_issue_v1', ranking, selected: { action: selected, target: target([slots[0], slots[2]]) }, source });
  const noRevisit = mk([{ action: 'confirm', score: 0.6 }, { action: 'repair', score: 0.5 }]);
  assert.equal(s4Probe.rankProof(veto(noRevisit), decision, base), true, 'candidatesAfter of the issue, not the original move_on / defer target');
  const withDefer = material({ repairHistory: [entry], repairProspect: prospect(), previousAction: { turn: 8, action: 'defer', target: target([slots[2], slots[0]]) } });
  const rev = mk([{ action: 'revisit', score: 0.7 }, { action: 'confirm', score: 0.6 }, { action: 'repair', score: 0.5 }]);
  assert.equal(s4Probe.rankProof(veto(rev), decision, withDefer), true, 'previous executed defer on the same set (order-insensitive)');
  assert.equal(s4Probe.rankProof(veto(rev), decision, base), false, 'revisit without a previous defer');
  assert.equal(s4Probe.rankProof(veto(rev), decision, material({ repairHistory: [entry], repairProspect: prospect(), previousAction: { turn: 8, action: 'confirm', target: target([slots[0], slots[2]]) } })), false, 'a previous confirm is not a defer');
  assert.equal(s4Probe.rankProof(veto(rev), decision, material({ repairHistory: [entry], repairProspect: prospect(), previousAction: { turn: 8, action: 'defer', target: target([slots[0], slots[3]]) } })), false, 'defer of another set');
  // swapped source / set / selection / ranking, and the fallback ranking presented as if no issue were named
  for (const [name, bad] of [
    ['issue turn swapped', { ...noRevisit, source: { ...source, issueTurn: 4 } }],
    ['candidate set swapped', { ...noRevisit, source: { ...source, candidates: [slots[0], slots[3]] } }],
    ['selection swapped', { ...noRevisit, selected: { action: 'repair', target: target([slots[0], slots[2]]) } }],
    ['ranking order swapped', { ...noRevisit, ranking: [...noRevisit.ranking].reverse() }],
    ['score forged', { ...noRevisit, ranking: [{ action: 'confirm', score: 0.99 }, noRevisit.ranking[1]] }],
    ['plain ranking over the original target', { policyId: 'saved_action_scores_v1', ranking: [{ action: 'revisit', score: 0.7 }, { action: 'confirm', score: 0.6 }], selected: { action: 'revisit', target: decision.target } }],
  ] as Array<[string, any]>) assert.equal(s4Probe.rankProof(veto(bad), decision, base), false, name);
  // without an explicit open issue the ordinary ranking over the original target is what must be recorded
  const plain = material();
  const ordinary = s4Probe.expectedRerank(decision, plain, scores);
  assert.equal(ordinary.policyId, 'saved_action_scores_v1'); assert.deepEqual(ordinary.ranking.map((r: any) => r.action), ['revisit', 'confirm', 'repair', 'accept', 'close'], 'propose_name / agree never rank over a multiple target');
  assert.equal(s4Probe.rankProof(veto(noRevisit), decision, plain), false, 'open-issue ranking claimed without a prospect source');
});

test('F3 agree labels: omitted exactly when the saved agreeNames offer no figure; unknown source is missing, never pass', () => {
  const input = material();
  const asked = (agree: any[] | undefined, known = true) => { s4Probe.setContext({ agree, known }); return s4Probe.targetQuestion(input, 'agree').options.map((o: any) => o.label); };
  assert.deepEqual(asked(undefined), FIGURES, 'no saved agreeNames: the ordinary name catalog');
  assert.deepEqual(asked([{ name: '船', figureId: slots[0], sourceTurn: 3 }]), ['figure_0'], 'only the figure with a public naming claim');
  assert.deepEqual(asked([]), [], 'adaptive without any eligible name');
  assert.deepEqual(asked([{ name: 'x', figureId: null, sourceTurn: 3 }]), FIGURES, 'a figure-less public name serves every figure');
  assert.equal(s4Probe.legal('agree', target([slots[1]]), input), true);
  s4Probe.setContext({ agree: [{ name: '船', figureId: slots[0], sourceTurn: 3 }] });
  assert.equal(s4Probe.legal('agree', target([slots[1]]), input), false, 'a name on figure 0 is no evidence for figure 1');
  assert.equal(s4Probe.legal('agree', target([slots[0], slots[1]]), input), false, 'agree never takes a set');
  assert.equal(s4Probe.legal('propose_name', target([slots[1]]), input), true, 'propose_name uses the ordinary catalog');
  // an action question without agree and no saved source cannot be told from forgery
  const stub: any = { model: 'typesafe/jev-1.14', questions: { action: { criteria: { accept: 'x' } } } };
  s4Probe.setContext({ known: false });
  assert.equal(s4Probe.originalQuestions(stub, input, 'two_stage_v2'), null);
  s4Probe.setContext({});
});

test('F3 agree source: saved agreeNames must be literal spans backed by live eligible public naming claims, and complete', () => {
  const claim = (over: any = {}) => ({ kind: 'claim', id: '3:h1', aspect: 'name', act: 'name_propose', speaker: 'human', name: '船', targets: [slots[0]], sourceTurn: 3, respondsTo: null, ...over });
  const mk = (names: any[], claims: any[] = [claim()]) => { const state = { ledger: Object.fromEntries(slots.map(s => [s, {}])), graph: { records: claims }, judgments: [{ turnIndex: 4, lastEventId: 'e4', jevTurn: { attemptNumber: 1, agreeNames: names } }] };
    return { tr: { turns: [{ turn: 4, state }], lastCommittedState: state }, t: { turnIndex: 4, lastEventId: 'e4', attemptNumber: 1 },
      tape: { events: [{ seq: 3, id: 'e3', speaker: 'human', text: 'これは船ですね' }, { seq: 4, id: 'e4', speaker: 'human', text: 'はい' }] } }; };
  const run = (m: any) => s4Probe.agreeSource(m.tr, m.t, JSON.stringify([4, 'e4', 1]), m.tape);
  const good = [{ name: '船', figureId: slots[0], sourceTurn: 3 }];
  assert.deepEqual(run(mk(good)), { known: true, names: good });
  assert.equal(run(mk([])), 'invalid', 'forged omission: an eligible claim exists');
  assert.equal(run(mk([...good, { name: '山', figureId: slots[1], sourceTurn: 3 }])), 'invalid', 'forged name: no claim and no literal span');
  assert.equal(run(mk([{ name: '船', figureId: slots[1], sourceTurn: 3 }])), 'invalid', 'right name on another figure');
  assert.equal(run(mk([{ name: '船', figureId: slots[0], sourceTurn: 4 }])), 'invalid', 'wrong source turn');
  assert.equal(run(mk([], [claim({ act: 'name_reject' })])).hasOwnProperty('known'), true, 'a rejection is not an eligible claim, so an empty list is right');
  assert.equal(run(mk([], [claim(), { kind: 'retract', targetId: '3:h1' }])).hasOwnProperty('known'), true, 'a retracted claim is not live');
  const none = mk(good); delete (none.tr.turns[0].state.judgments[0].jevTurn as any).agreeNames;
  assert.deepEqual(run(none), { known: true, names: undefined }, 'non-adaptive judgment');
  assert.deepEqual(s4Probe.agreeSource({ turns: [], lastCommittedState: null }, { turnIndex: 4 }, 'k', { events: [] }), { known: false, names: undefined });
});

test('F3 open_issue_v1 execution record: shape, source link to the prospect choice and an earlier entry, and the executed target are all required', () => {
  const target = (ids: string[]) => ids.length === 1 ? { kind: 'single', figureId: ids[0] } : { kind: 'multiple', figureIds: ids };
  const c = [slots[0], slots[2]], source = { issueTurn: 5, issueId: '5:a', choice: 'issue', candidates: c };
  const decision = { action: 'defer', target: target([slots[4], slots[5]]), name: null, feature: null, observe: null, evidence: { stages: [{ scores: { action: scores } }] } };
  const executed = { action: 'confirm', target: target(c), name: null, feature: 'f', observe: null, detailFigureIds: [slots[0]] };
  const trace = (): any => ({ status: 'error', turnIndex: 9, decisions: [decision], executed, finalAction: null, repairProspect: prospect(), repairHistory: [entry],
    intervention: { schemaVersion: 'jev_intervention_v1', policy: 'bypass_acceptance_v1:veto', disposition: 'rejected', reasonCode: 'vetoed_bypass_action', original: { action: 'defer', target: decision.target, name: null, feature: null, observe: null },
      rerank: { policyId: 'saved_action_scores_open_issue_v1', ranking: [{ action: 'confirm', score: 0.6 }, { action: 'repair', score: 0.5 }], selected: { action: 'confirm', target: target(c) }, source },
      alternative: executed, detailEvidence: { stage: 'detail' }, failure: null } });
  assert.equal(s4Probe.relation(trace(), 'repair-first', slots), true);
  const bad: Array<[string, (t: any) => void]> = [
    ['source issue swapped', t => { t.intervention.rerank.source.issueTurn = 4; }],
    ['prospect names another issue', t => { t.repairProspect = prospect({ issue: { choice: 'issue', turn: 5, issueId: '5:b' } }); }],
    ['prospect has no explicit issue', t => { t.repairProspect = prospect({ issue: { choice: 'none' } }); }],
    ['no earlier repair entry', t => { t.repairHistory = []; }],
    ['entry of the same turn is not earlier', t => { t.turnIndex = 5; }],
    ['candidate set differs from the entry', t => { t.intervention.rerank.source.candidates = [slots[0], slots[3]]; t.executed.target = t.intervention.alternative.target = t.intervention.rerank.selected.target = target([slots[0], slots[3]]); }],
    ['executed target is the original move_on target', t => { t.executed.target = t.intervention.alternative.target = t.intervention.rerank.selected.target = decision.target; }],
    ['ranking carries a name action', t => { t.intervention.rerank.ranking.push({ action: 'agree', score: 0.3 }); }],
    ['ranking score forged', t => { t.intervention.rerank.ranking[0].score = 0.99; }],
  ];
  for (const [name, edit] of bad) { const t = trace(); edit(t); assert.equal(s4Probe.relation(t, 'repair-first', slots), false, name); }
  // an adopted bypass-enabled decision carries no re-ranking at all
  const adopted: any = trace(); Object.assign(adopted.intervention, { policy: 'bypass_acceptance_v1:accept', disposition: 'adopted', reasonCode: 'no_intervention', rerank: null, alternative: null, detailEvidence: null });
  Object.assign(adopted, { executed: adopted.intervention.original });
  assert.equal(s4Probe.relation(adopted, 'bypass-enabled', slots), true);
  assert.equal(s4Probe.relation({ ...adopted, executed: { ...adopted.executed, action: 'revisit', target: { kind: 'none' }, name: null, feature: null } }, 'bypass-enabled', slots), false, 'revisit x none is never an executed projection');
  assert.equal(s4Probe.relation({ ...adopted, intervention: { ...adopted.intervention, original: { ...adopted.intervention.original, action: 'revisit', target: target(c) } }, executed: { action: 'revisit', target: target(c), name: null, feature: null, observe: null }, decisions: [{ ...decision, action: 'revisit', target: target(c) }] }, 'bypass-enabled', slots), true, 'revisit x multiple is');
});

test('S4 orientation fallback rejects mixed name_mismatch on agree alongside self_repair, deferral and agreement', () => {
  const agreeBoat = { action: 'agree', candidateName: '舟' };
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側の「舟」にしましょう。', agreeBoat), false, 'pure orientation_leak on agree passes');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側に突起があります。', agreeBoat), true, 'missing name on agree is non-orientation violation');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。「舟」に見えますが、名前は「鳥」です。', agreeBoat), true, 'copula name_mismatch on agree is rejected');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。「舟」に見えますが、「鳥」にしましょう。', agreeBoat), true, 'adoption name_mismatch on agree is rejected');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。さっきの「鳥」とは別の形なので、「舟」にしましょう。', agreeBoat), false, 'prior-figure mention is allowed');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。すみません、訂正します。', { action: 'accept', candidateName: null }), true);
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。この形は後回しにしましょう。', { action: 'accept', candidateName: null }), true);
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側の「舟」で決まりです。', { action: 'accept', candidateName: null }), true);
  const propBoat = { action: 'propose_name', candidateName: '舟' };
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側の「舟」と呼ぶのはどうでしょう？', propBoat), false, 'pure orientation_leak on propose_name passes');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側に突起があります。', propBoat), true, 'missing name on propose_name rejected');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。「舟」に見えますが、「キリン」と呼ぶのはどうでしょう？', propBoat), true, 'substituted name on propose_name rejected');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。「舟」にも見えますが、呼び名は「鳥」を提案します。', propBoat), true, 'propose verb with label noun rejected');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側です。「舟」にも見えますが、候補は「鳥」です。', propBoat), true, 'candidate noun substitution rejected');
  assert.equal(s4Probe.s4HasNonOrientationLeak('右側の形ですが、名前は「鳥」ではなく「舟」にしませんか？', propBoat), false, 'negated correction to judged name allowed');
});
