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
const answer = (choice: string, keys: string[]) => ({ type: 'choice', choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) });
/** NORMAL's material with v2 answers: stage one (accept, multiple), then the candidate set figures_0_2. */
function v2Tape() {
  const old = normal.trials[0].replay[0].tape, first = old.common.jev[0];
  const actions = Object.keys(first.answers.action.probabilities), targets = Object.keys(first.answers.target.probabilities);
  return { ...structuredClone(old), common: { ...structuredClone(old.common), jev: [
    { model: 'typesafe/jev-1.14', id: 'gen-s4-v2-stage-one', usage: { cost: 0 }, answers: { action: answer('accept', actions), target: answer('multiple', targets) } },
    { model: 'typesafe/jev-1.14', id: 'gen-s4-v2-candidate-set', usage: { cost: 0 }, answers: { candidate_set: answer('figures_0_2', SET_LABELS) } }] },
    recorded: { label: 'bypass-enabled', expectedRequests: [] as any[] } };
}
/** The recorded side's own run: the same native serializers and fixed responses as the replay, keeping the trace and state. */
async function recordedRun(profile: any, tape: any, label: 'repair-first' | 'bypass-enabled') {
  const luna = [...tape.common.luna, ...tape.tails[label].luna], jev = [...tape.common.jev, ...tape.tails[label].jev], traces: any[] = [];
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
    observer: { async observeAll() { return structuredClone(tape.state.observationMemo); }, async reobserve() { throw Error('unused'); } },
    jevDecision: { decide: (i: any, o: any) => native.decide(i, o), completeDetail: (i: any, s: any, o: any) => native.completeDetail!(i, s, o) },
    localGrounding: { classifier: createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.localMs, researchLimits: { maxDeadlineMs: 600000 } })!,
      aiPublicTransport: { readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs } },
    onJevTurnTrace: (t: any) => traces.push(t) } as any);
  const result: any = await runtime.runAiTurn({ events: tape.events, privateState: tape.state, lastEventId: tape.events.at(-1).id, requestSeq: tape.events.at(-1).seq });
  assert.deepEqual([luna.length, jev.length], [0, 0]);
  return { trace: { ...structuredClone(traces.at(-1)), status: 'committed' }, state: structuredClone(result.privateState) };
}
/** NORMAL rebuilt as one canonical v2 trial: profile, attempt, turn, state, calls, POSTs and the paired replay evidence. */
async function v2Records() {
  const n = structuredClone(normal), tr = n.trials[0], m = n.run.manifest;
  const profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, 'two_stage_v2'))), digest = hash(profile);
  for (const s of [n.run, n.summary, tr]) { s.profile = structuredClone(profile); s.profileSha256 = digest; }
  tr.identity.profile = digest;
  const tape = v2Tape();
  const probe: any = await pairedInterventionReplay(tape as any, OWN as any, MODEL, profile);
  const recorded = probe.sides.find((s: any) => s.label === tape.recorded.label);
  tape.recorded.expectedRequests = recorded.requests.map((r: any, i: number) => ({ provider: r.provider, phase: r.phase, requestSha256: r.preProjectionPayloadSha256,
    actualSendMeasured: true, sendIds: [i + 1], ...(r.provider === 'luna' ? { messagesSha256: r.completeMessagesSha256 } : {}) }));
  const result: any = await pairedInterventionReplay(tape as any, OWN as any, MODEL, profile);
  assert.equal(result.status, 'same_material_intervention_verified', String(result.error));
  const { trace, state } = await recordedRun(profile, tape, tape.recorded.label as 'bypass-enabled');
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
