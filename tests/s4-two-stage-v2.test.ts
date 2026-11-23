// audit/03 F1: the independent S4 verifier accepts the canonical plan O failure record and the opt-in two_stage_v2
// layout named by the verified profile, and refuses corrupt evidence. Records come from the real runtime and the real
// offline replay over synthetic material; no network, key or study data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { createJevDecisionClient, TWO_STAGE_V2_CANDIDATE_SETS, candidateSetLabel } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { buildReobservationMessages } from '../dialogue-model/runtime/observation/observe.ts';
import { harness, image } from './support/s4-integration/harness.ts';

const normal = JSON.parse(await readFile(new URL('./support/s4-integration/NORMAL-RECORDS.json', import.meta.url), 'utf8'));
const shape = (records: any) => interventionChecks(records).find((c: any) => c.id === 'intervention.trial.0.attempt.0.shape')?.status;
const status = (records: any, suffix: string) => interventionChecks(records).find((c: any) => c.id === 'intervention.trial.0.attempt.0.' + suffix)?.status;
/** NORMAL's trial with one uncommitted attempt (the s4-boundary-hardening pattern). */
function withFailedAttempt(trace: any) {
  const n = structuredClone(normal), tr = n.trials[0];
  tr.attempts = [trace]; tr.turns = []; tr.lastCommittedState = tr.replay[0].tape.state; tr.replay = [];
  return n;
}

test('F1 v1: a canonical decide() failure record passes the S4 shape, older records too; corrupt records do not', async () => {
  const h = harness({ original: 'propose_name', multiple: true });
  await assert.rejects(h.run());
  const trace = structuredClone(h.traces.at(-1));
  assert.equal(trace.errorCode, 'invalid_decision');
  assert.equal(trace.decisionFailure.evidence.rejectionCode, 'name_requires_single_target');
  assert.equal(shape(withFailedAttempt(trace)), 'pass');
  const older = structuredClone(trace); delete older.decisionFailure;
  assert.equal(shape(withFailedAttempt(older)), 'pass');
  const unknown = structuredClone(trace); unknown.decisionFailure = { evidence: null };
  assert.equal(shape(withFailedAttempt(unknown)), 'pass');
  const variants: Array<[string, (e: any, t: any) => void]> = [
    ['extra evidence key', e => { e.note = 'x'; }],
    ['changed total cost', e => { e.costUsd = 0.12; }],
    ['action scores cut to the chosen one', e => { e.stages[0].scores.action = { propose_name: 1 }; }],
    ['rule unrelated to the stage-one answer', e => { e.stages[0].choices.action = 'accept'; }],
    ['rule with another outward code', e => { e.error = 'inconsistent_decision'; e.stages[0].error = 'inconsistent_decision'; }],
    ['failed stage turned into success', e => { Object.assign(e.stages[0], { status: 'ok', error: null, rejectionCode: null }); e.rejectionCode = null; }],
    ['response id of no stage', e => { e.responseId = 'gen-not-a-stage'; }],
    ['v2 layout inside a v1 record', e => { e.questionLayout = 'two_stage_v2'; }],
    ['record on a non-decision failure', (_e, t) => { t.errorCode = 'generation_failed'; }],
  ];
  for (const [name, mutate] of variants) {
    const t = structuredClone(trace); mutate(t.decisionFailure.evidence, t);
    assert.equal(shape(withFailedAttempt(t)), 'mismatch', name);
  }
});

const OWN = { ownImage: image, ownAnchors: normal.trials[0].replay[0].result.sides[0].material.own.ownAnchors };
const MODEL = normal.trials[0].replay[0].result.sides[0].material.model;
const SET_LABELS = TWO_STAGE_V2_CANDIDATE_SETS.map(candidateSetLabel);
const ASPECTS = ['orientation', 'part', 'contour', 'construal', 'referent'];
const OLD = normal.trials[0].replay[0].tape;
const ACTIONS = Object.keys(OLD.common.jev[0].answers.action.probabilities), TARGETS = Object.keys(OLD.common.jev[0].answers.target.probabilities);
const AFTER_REOBSERVATION = ACTIONS.filter(a => a !== 'request_observation');
const answer = (choice: string, keys: string[]) => ({ type: 'choice', choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) });
const jevResponse = (id: string, answers: Record<string, unknown>) => ({ model: 'typesafe/jev-1.14', id: 'gen-s4-' + id, usage: { cost: 0 }, answers });
const candidates = (included: number[]) => Object.fromEntries([0, 1, 2, 3, 4, 5].map(i => ['candidate_' + i, answer(included.includes(i) ? 'include' : 'exclude', ['include', 'exclude'])]));
const subsets = (n: number) => Array.from({ length: 2 ** n - 1 }, (_, i) => 'subset_' + i);
/** The recorded side's own run: the same native serializers and fixed responses as the replay, keeping the trace and state.
 * `learn` answers a reobservation from the runtime's own request once; otherwise the tape's fixed result is returned. */
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
/** NORMAL rebuilt as one canonical trial of the given layout and Jev responses: profile, attempt, turn, state, calls, POSTs and
 * the paired replay evidence. A reobservation turn adds the observation_targeted Luna call and records the runtime's own request. */
async function records(layout: 'two_stage_v1' | 'two_stage_v2', jev: any[], reobservation = false) {
  const n = structuredClone(normal), tr = n.trials[0], m = n.run.manifest;
  let profile = structuredClone(n.run.profile);
  if (layout === 'two_stage_v2') {
    profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, 'two_stage_v2')));
    const digest = hash(profile);
    for (const s of [n.run, n.summary, tr]) { s.profile = structuredClone(profile); s.profileSha256 = digest; }
    tr.identity.profile = digest;
  }
  const tape: any = { ...structuredClone(OLD), common: { ...structuredClone(OLD.common), jev }, recorded: { label: 'bypass-enabled', expectedRequests: [] } };
  if (reobservation) {
    tape.common.luna = [...tape.common.luna, { ...structuredClone(OLD.common.luna[0]), phase: 'observation_targeted' }];
    const learned = await recordedRun(profile, tape, 'bypass-enabled', (input: any) => ({ observedAt: '2026-01-01T00:00:01.000Z', issue: structuredClone(input.issue),
      figures: input.figureIds.map((figureId: string) => ({ figureId, supports: ['control-feature'], contradicts: [], unknown: [] })) }));
    tape.common.reobservations = learned.reobservations;
  }
  const probe: any = await pairedInterventionReplay(tape, OWN as any, MODEL, profile);
  const recorded = probe.sides.find((s: any) => s.label === tape.recorded.label);
  tape.recorded.expectedRequests = recorded.requests.map((r: any, i: number) => ({ provider: r.provider, phase: r.phase, requestSha256: r.preProjectionPayloadSha256,
    actualSendMeasured: true, sendIds: [i + 1], ...(r.provider === 'luna' ? { messagesSha256: r.completeMessagesSha256 } : {}) }));
  const result: any = await pairedInterventionReplay(tape, OWN as any, MODEL, profile);
  assert.equal(result.status, 'same_material_intervention_verified', String(result.error));
  const { trace, state } = await recordedRun(profile, tape, tape.recorded.label);
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
/** Canonical v2 decision: stage one (accept, multiple), then the candidate set figures_0_2. */
const v2Records = () => records('two_stage_v2', [jevResponse('v2-stage-one', { action: answer('accept', ACTIONS), target: answer('multiple', TARGETS) }),
  jevResponse('v2-candidate-set', { candidate_set: answer('figures_0_2', SET_LABELS) })]);
/** Every copy of the committed decision in the record: attempt, turn trace, turn state and last state. */
const decisions = (n: any) => { const tr = n.trials[0]; return [tr.attempts[0].decisions[0], tr.turns[0].trace[0].decisions[0],
  tr.turns[0].state.judgments[0].jevTurn.decision, tr.lastCommittedState.judgments[0].jevTurn.decision]; };

test('F1/F2 v2: a canonical two_stage_v2 record set from the real runtime and replay passes every S4 check', async () => {
  const records = await v2Records(), checks = interventionChecks(records);
  assert.ok(checks.length >= 5);
  for (const c of checks) assert.equal(c.status, 'pass', c.id + ' ' + c.reason);
  const d = records.trials[0].attempts[0].decisions[0];
  assert.deepEqual(d.evidence.stages.map((s: any) => s.stage), ['action_target', 'multiple_candidates']);
  assert.deepEqual(d.target, { kind: 'multiple', figureIds: ['s-0000', 's-0002'] });
  // The same v2 evidence under the v1 profile is not that layout.
  const v1 = structuredClone(records), base = normal.run.profile;
  for (const s of [v1.run, v1.summary, v1.trials[0]]) { s.profile = structuredClone(base); s.profileSha256 = normal.run.profileSha256; }
  v1.trials[0].identity.profile = normal.trials[0].identity.profile;
  assert.equal(shape(v1), 'mismatch');
});

test('F1 v2: corrupt candidate-set evidence fails the S4 shape or replay', async () => {
  const records = await v2Records();
  const cut = structuredClone(records); cut.trials[0].attempts[0].decisions[0].evidence.stages[1].scores.candidate_set = { figures_0_2: 1 };
  assert.equal(shape(cut), 'mismatch', 'scores cut to the chosen subset');
  const extra = structuredClone(records), stage = extra.trials[0].attempts[0].decisions[0].evidence.stages[1];
  stage.choices.extra = 'include'; stage.scores.extra = { include: 1, exclude: 0 };
  assert.equal(shape(extra), 'mismatch', 'extra question in the set stage');
  const missing = structuredClone(records);
  for (const d of decisions(missing)) d.evidence.stages.splice(1, 1);
  assert.equal(shape(missing), 'mismatch', 'set stage removed from every copy');
  // A consistent relabelling across every copy still contradicts the recorded candidate-set response.
  const relabelled = structuredClone(records);
  for (const d of decisions(relabelled)) d.evidence.stages[1].choices.candidate_set = 'figures_0_3';
  assert.equal(shape(relabelled), 'pass');
  assert.equal(status(relabelled, 'replay'), 'mismatch');
});

/** Both copies of the turn's decisions in the record (attempt and turn trace); the private state keeps only the final one. */
const traceDecisions = (n: any, index: number) => [n.trials[0].attempts[0].decisions[index], n.trials[0].turns[0].trace[0].decisions[index]];
/** Every side copy of the replayed requests: the replay result and the paired evidence. */
const sideCopies = (n: any) => [...n.trials[0].replay[0].result.sides, n.evidence.pairedReplay[0].left, n.evidence.pairedReplay[0].right];
/** Edits the projected observation_targeted request JSON in every side copy and keeps each payload hash consistent. */
const lunaRequest = (n: any, edit: (request: any) => void) => {
  for (const side of sideCopies(n)) {
    const r = side.requests.find((x: any) => x.phase === 'observation_targeted');
    const message = r.payload.messages.find((x: any) => x.role === 'user' && typeof x.content === 'string');
    const request = JSON.parse(message.content); edit(request); message.content = JSON.stringify(request); r.payloadSha256 = hash(r.payload);
  }
};

test('F1 v2 reobservation: request_observation / multiple -> candidate_set -> observe detail -> observation_targeted -> accept passes all five checks', async () => {
  const n = await records('two_stage_v2', [
    jevResponse('ro-stage-one', { action: answer('request_observation', ACTIONS), target: answer('multiple', TARGETS) }),
    jevResponse('ro-candidate-set', { candidate_set: answer('figures_0_2', SET_LABELS) }),
    jevResponse('ro-detail', { observe_targets: answer('subset_0', subsets(2)), observe_aspect: answer('orientation', ASPECTS) }),
    jevResponse('after-stage-one', { action: answer('accept', AFTER_REOBSERVATION), target: answer('none', TARGETS) })], true);
  const t = n.trials[0].attempts[0];
  assert.deepEqual(t.decisions.map((d: any) => [d.action, d.evidence.stages.map((s: any) => s.stage)]),
    [['request_observation', ['action_target', 'multiple_candidates', 'detail']], ['accept', ['action_target']]]);
  assert.deepEqual(t.decisions[0].observe.figureIds, ['s-0000']); assert.equal(t.reobservations.length, 1);
  // The targeted observation carries the own image: its projected messages cannot hash to the sent messages.
  const targeted = n.trials[0].replay[0].result.sides[0].requests.find((r: any) => r.phase === 'observation_targeted');
  assert.notEqual(hash(targeted.payload.messages), targeted.completeMessagesSha256);
  for (const c of interventionChecks(n)) assert.equal(c.status, 'pass', c.id + ' ' + c.reason);
  const variants: Array<[string, (n: any) => void]> = [
    ['candidate set of the first decision swapped', n => { for (const d of traceDecisions(n, 0)) d.evidence.stages[1].choices.candidate_set = 'figures_0_3'; }],
    ['first decision target swapped with its set', n => { for (const d of traceDecisions(n, 0)) { d.evidence.stages[1].choices.candidate_set = 'figures_0_3'; d.target.figureIds = ['s-0000', 's-0003']; } }],
    ['observation target swapped', n => { for (const d of traceDecisions(n, 0)) d.observe.figureIds = ['s-0002']; }],
    ['observation aspect swapped', n => { for (const d of traceDecisions(n, 0)) d.observe.aspect = 'part'; }],
    ['projected image not the own image', n => { for (const side of sideCopies(n)) { const r = side.requests.find((r: any) => r.phase === 'observation_targeted');
      const swap = (v: any): void => { if (v && typeof v === 'object') { if (v.projection) v.byteSha256 = '0'.repeat(64); else Object.values(v).forEach(swap); } };
      swap(r.payload); r.payloadSha256 = hash(r.payload); } }],
    // The Luna request alone differs from the Jev decision; its own hash, the sent hash and the image projection stay consistent.
    ['Luna request moved to another figure', n => lunaRequest(n, req => { req.figureIds = ['s-0002']; })],
    ['Luna request aspect changed to contour', n => lunaRequest(n, req => { req.issue.aspect = 'contour'; })],
  ];
  for (const [name, mutate] of variants) {
    const copy = structuredClone(n); mutate(copy);
    assert.equal(status(copy, 'shape'), 'pass', name);
    assert.equal(status(copy, 'replay'), 'mismatch', name);
  }
});

test('F1 v1 reobservation: request_observation / single -> observe detail -> observation_targeted -> accept passes all five checks', async () => {
  const n = await records('two_stage_v1', [
    jevResponse('v1-ro-stage-one', { action: answer('request_observation', ACTIONS), target: answer('figure_0', TARGETS), ...candidates([]) }),
    jevResponse('v1-ro-detail', { observe_targets: answer('subset_0', subsets(1)), observe_aspect: answer('contour', ASPECTS) }),
    jevResponse('v1-after-stage-one', { action: answer('accept', AFTER_REOBSERVATION), target: answer('figure_0', TARGETS), ...candidates([]) })], true);
  assert.deepEqual(n.trials[0].attempts[0].decisions.map((d: any) => d.action), ['request_observation', 'accept']);
  for (const c of interventionChecks(n)) assert.equal(c.status, 'pass', c.id + ' ' + c.reason);
  const copy = structuredClone(n); for (const d of traceDecisions(copy, 0)) d.observe.aspect = 'part';
  assert.equal(status(copy, 'replay'), 'mismatch');
});
