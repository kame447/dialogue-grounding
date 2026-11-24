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
// holistic_v1: the memo's readings are not name candidates, so propose_name is not offered unless a public name exists.
const stageOneH = (id: string, action: string, override: Record<string, number> = {}) => stageOne(id, action, override, ACTIONS.filter(a => !['agree', 'propose_name'].includes(a)));
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
    ...(tape.generationRetryVersion ? {} : { generationRetryVersion: 'jev_generation_retry_v1' }),
    observer: { async observeAll() { return structuredClone(tape.state.observationMemo); },
      async reobserve(input: any) { const result = learn ? learn(input) : structuredClone(fixed.shift()); made.push(structuredClone(result));
        await client.complete(buildReobservationMessages(input), { phase: 'observation_targeted' }); return result; } },
    jevDecision: { decide: (i: any, o: any) => native.decide(i, o), completeDetail: (i: any, s: any, o: any) => native.completeDetail!(i, s, o),
      ...(profile.dialoguePolicy ? { classifyDraftAct: (i: any, o: any) => native.classifyDraftAct!(i, o) } : {}) },
    localGrounding: { classifier: createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.localMs, researchLimits: { maxDeadlineMs: 600000 } })!,
      aiPublicTransport: { readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs } },
    onJevTurnTrace: (t: any) => traces.push(t) } as any);
  const result: any = await runtime.runAiTurn({ events: tape.events, privateState: tape.state, lastEventId: tape.events.at(-1).id, requestSeq: tape.events.at(-1).seq });
  assert.deepEqual([luna.length, jev.length], [0, 0]);
  return { trace: { ...structuredClone(traces.at(-1)), status: 'committed' }, state: structuredClone(result.privateState), reobservations: made };
}
/** NORMAL rebuilt as one canonical trial of the given layout, label and Jev responses (the s4-two-stage-v2 pattern). */
async function records(layout: 'two_stage_v2' | 'two_stage_v3', jev: any[], { reobservation = false, label = 'bypass-enabled' as 'repair-first' | 'bypass-enabled', generationText = null as string | null, humanText = null as string | null,
  retry = null as { drafts: [string, string]; current: boolean; fallback?: boolean } | null, policy = null as 'holistic_v1' | 'holistic_v2' | 'holistic_v3' | null, draftAnswers = [] as Array<string | { choice: string; extra: Record<string, unknown> }> } = {}) {
  const n = structuredClone(normal), tr = n.trials[0], m = n.run.manifest;
  const profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, layout, policy)));
  const digest = hash(profile);
  for (const s of [n.run, n.summary, tr]) { s.profile = structuredClone(profile); s.profileSha256 = digest; }
  tr.identity.profile = digest;
  tr.label = label; m.trials[0].label = label; n.summary.runOrder[0].label = label;
  const tape: any = { ...structuredClone(OLD), common: { ...structuredClone(OLD.common), jev }, recorded: { label, expectedRequests: [] } };
  if (humanText !== null) tape.events.at(-1).text = humanText;
  if (draftAnswers.length) for (const side of Object.values(tape.tails) as any[]) side.jev = [...draftAnswers.map((c, i) => jevResponse('draft-' + i,
    { draft_naming: typeof c === 'string' ? answer(c, ['adopt_chosen', 'adopt_other', 'decline_or_hold', 'propose_question', 'recount_only', 'none'])
      : { ...answer(c.choice, ['adopt_chosen', 'adopt_other', 'decline_or_hold', 'propose_question', 'recount_only', 'none']), ...c.extra } })), ...side.jev];
  if (generationText !== null) {
    for (const side of Object.values(tape.tails ?? {}) as any[]) {
      for (const l of side.luna ?? []) if (l.phase === 'generation') l.response = { ...l.response, text: generationText };
    }
    for (const l of tape.common.luna ?? []) if (l.phase === 'generation') l.response = { ...l.response, text: generationText };
  }
  if (retry) {
    if (retry.current) tape.generationRetryVersion = 'jev_generation_retry_v2';
    for (const side of Object.values(tape.tails) as any[]) {
      side.luna = side.luna.filter((l: any) => !retry.fallback || l.phase !== 'ai_extraction').flatMap((l: any) => l.phase === 'generation'
        ? retry.drafts.map(text => ({ ...l, response: { ...l.response, text } })) : [l]);
    }
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

const generationRequests = (side: any) => side.requests.filter((request: any) => request.role === 'generation');
const retryInstruction = '公開発話を書き直してください。選択済みの行動を変更しないでください。';
const retryVersion = 'jev_generation_retry_v2';

function changeRetry(records: any, label: string, edit: (content: string) => string) {
  for (const side of sideCopies(records).filter(side => side.label === label)) {
    const request = generationRequests(side)[1], body = request.payload;
    body.messages.at(-1).content = edit(body.messages.at(-1).content);
    request.completeMessagesSha256 = hash(body.messages);
    request.preProjectionPayloadSha256 = request.payloadSha256 = hash(body);
    // Synchronize all wire hashes so only the independently reconstructed prompt can fail.
    const trial = records.trials[0];
    if (trial.label === label) {
      const index = side.requests.indexOf(request);
      const expected = trial.replay[0].tape.recorded.expectedRequests[index];
      expected.messagesSha256 = request.completeMessagesSha256;
      expected.requestSha256 = request.preProjectionPayloadSha256;
      const call = trial.calls[index];
      call.requestSha256 = request.completeMessagesSha256;
      call.expectedHttpRequestSha256 = call.httpRequestSha256 = request.preProjectionPayloadSha256;
      trial.http.find((receipt: any) => receipt.callId === call.id).requestSha256 = request.preProjectionPayloadSha256;
    }
  }
}

test('both strategies get the same validated initial action block again, including candidate name or feature and target', async () => {
  for (const action of ['confirm', 'propose_name'] as const) {
    const isName = action === 'propose_name';
    const detail = isName ? { name: answer('name_0', ['name_0']) }
      : { feature: answer('feature_0', ['feature_0', 'feature_1']) };
    const n = await records('two_stage_v3', [
      stageOne('retry', action), stageTwo('retry', action, 'figure_2'), jevResponse('retry-detail', detail),
    ], { retry: { current: true, drafts: isName
      ? ['上端の形は「name-2」と呼ぶのはどうでしょう？', '「name-2」と呼ぶのはどうでしょう？']
      : ['上端が尖っていますか？', '尖った部分がありますか？'] } });
    pass(n);
    const trial = n.trials[0];
    assert.equal(trial.attempts[0].generationRetryVersion, retryVersion);
    const captured = trial.replay[0].result.sides.map((side: any) => {
      const [initial, retry] = generationRequests(side).map((request: any) => request.payload.messages);
      const actionMessage = initial.find((message: any) => message.role === 'system' && message.content.includes('"targetSlot"'));
      const judgment = JSON.parse(actionMessage.content.split('\n').at(-1));
      assert.deepEqual(judgment, { ...trial.attempts[0].finalAction, target: side.executed.target, detailFigureIds: side.executed.detailFigureIds });
      assert.equal(judgment.action, action);
      assert.equal(judgment.candidateName, isName ? 'name-2' : null);
      assert.equal(judgment.discriminatingFeature, isName ? null : 'feature-2');
      assert.deepEqual(retry.slice(0, -1), initial);
      const expected = retryInstruction + '\n' + actionMessage.content + '\n';
      assert.ok(retry.at(-1).content.startsWith(expected));
      assert.match(retry.at(-1).content.slice(expected.length), /^前の下書きに画面の向き/u);
      return retry;
    });
    assert.deepEqual(captured[0], captured[1]);
  }
});

test('historical and current retry records pass only their own S4 version and reject byte edits', async () => {
  const decisions = [stageOne('retry', 'accept'), stageTwo('retry', 'accept', 'none')];
  const drafts: [string, string] = ['右側に張り出しがあります。', 'そう見えるんですね。'];
  const legacy = await records('two_stage_v3', decisions, { retry: { current: false, drafts } });
  const current = await records('two_stage_v3', decisions, { retry: { current: true, drafts } });
  pass(legacy);
  pass(current);
  assert.equal(Object.hasOwn(legacy.trials[0].attempts[0], 'generationRetryVersion'), false);
  const readRetry = (n: any) => generationRequests(n.trials[0].replay[0].result.sides[0])[1].payload.messages.at(-1).content;
  for (const [record, transform] of [
    [legacy, () => readRetry(current)],
    [current, () => readRetry(legacy)],
    [legacy, (text: string) => text.replace('尖りの数', '尖りの量')],
    [current, (text: string) => text.replace('尖りの数', '尖りの量')],
    [current, (text: string) => text.replace('"action":"accept"', '"action":"agree"')],
  ] as const) {
    // Test the actual request and the counterfactual condition independently.
    for (const label of ['bypass-enabled', 'repair-first']) {
      const tampered = structuredClone(record);
      changeRetry(tampered, label, transform);
      assert.deepEqual(['shape', 'binding', 'execution', 'replay'].map(k => status(tampered, k)), ['pass', 'pass', 'pass', 'mismatch']);
    }
  }
  const earlyOrientationReason = '前の下書きに画面の向きに依存する語（上下左右・上端・下端・右向き等）が含まれていました。相手の画面では図形が回転しているため、上下左右を使わず、尖りの数・大小・くぼみ・四角い部分とのつながりなど回転しても変わらない特徴だけで書き直してください。';
  const earlyLegacy = structuredClone(legacy);
  changeRetry(earlyLegacy, 'bypass-enabled', () => retryInstruction + earlyOrientationReason);
  changeRetry(earlyLegacy, 'repair-first', () => retryInstruction + earlyOrientationReason);
  pass(earlyLegacy);
  const versionDrift = structuredClone(current);
  delete versionDrift.trials[0].replay[0].tape.generationRetryVersion;
  assert.equal(status(versionDrift, 'replay'), 'mismatch');
});

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

test('a retry reason is checked against the draft of the condition that wrote it, whichever condition is the recorded one', async () => {
  const decisions = [stageOne('retry', 'accept'), stageTwo('retry', 'accept', 'none')];
  const namingReason = '前の下書きは名称の決定・合意を表していました。決定・合意を表明せず、このactionの範囲で書き直してください。';
  const orientationOnly = await records('two_stage_v3', decisions, { retry: { current: true, drafts: ['右側に張り出しがあります。', 'そう見えるんですね。'] } });
  pass(orientationOnly);
  const read = (n: any, label: string) => generationRequests(n.trials[0].replay[0].result.sides.find((s: any) => s.label === label))[1].payload.messages.at(-1).content as string;
  // The draft only had an orientation leak: a name/agreement-decision reason is wrong on either side, recorded or comparison.
  for (const label of ['bypass-enabled', 'repair-first']) {
    const wrong = structuredClone(orientationOnly);
    changeRetry(wrong, label, (text: string) => text + namingReason);
    assert.equal(status(wrong, 'replay'), 'mismatch', label);
  }
  // Both drafts really contain an orientation leak and a name decision: the reasons that follow from them are accepted on both sides.
  const both = await records('two_stage_v3', decisions, { retry: { current: true, drafts: ['右側に張り出しがあります。この形は「name-0」にしましょう。', 'そう見えるんですね。'] } });
  pass(both);
  for (const label of ['bypass-enabled', 'repair-first']) assert.ok(read(both, label).includes(namingReason), label);
});

test('a working-note retry reason is accepted only for a draft that has one, on either condition; older records carry none', async () => {
  const decisions = [stageOne('retry', 'accept'), stageTwo('retry', 'accept', 'none')];
  const noteReason = '前の下書きに、英語の作業メモや複数の返答案が混じっていました。日本語の一つの返答だけにして書き直してください。';
  const genuine = await records('two_stage_v3', decisions, { retry: { current: true, drafts: ['そう見えるんですね。same? Need Japanese natural, ask confirm. Avoid confusing target.', 'そう見えるんですね。'] } });
  pass(genuine);
  const read = (n: any, label: string) => generationRequests(n.trials[0].replay[0].result.sides.find((s: any) => s.label === label))[1].payload.messages.at(-1).content as string;
  for (const label of ['bypass-enabled', 'repair-first']) assert.ok(read(genuine, label).endsWith(noteReason), label);
  // The draft has no working note: adding the reason is wrong on the recorded and on the comparison condition alike.
  const plain = await records('two_stage_v3', decisions, { retry: { current: true, drafts: ['右側に張り出しがあります。', 'そう見えるんですね。'] } });
  pass(plain);
  for (const label of ['bypass-enabled', 'repair-first']) {
    const wrong = structuredClone(plain);
    changeRetry(wrong, label, (text: string) => text + noteReason);
    assert.equal(status(wrong, 'replay'), 'mismatch', label);
  }
  // Dropping the reason the draft requires is refused too.
  for (const label of ['bypass-enabled', 'repair-first']) {
    const dropped = structuredClone(genuine);
    changeRetry(dropped, label, (text: string) => text.slice(0, -noteReason.length));
    assert.equal(status(dropped, 'replay'), 'mismatch', label);
  }
});

test('quoted features are one reply, while two complete quoted questions require a working-note retry', async () => {
  const decisions = [stageOne('quoted', 'accept'), stageTwo('quoted', 'accept', 'none')];
  const features = '・『切れ目のある輪』\n・『輪についた細い棒』\nこの両方がある形ですか？';
  const alternatives = '・『輪には切れ目がありますか？』\n・「輪に細い棒がついていますか？」';
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    const plain = await records('two_stage_v3', decisions, { label, generationText: features });
    pass(plain);
    assert.deepEqual(plain.trials[0].attempts[0].generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(plain.trials[0].attempts[0].publicSpeech, features);

    const retried = await records('two_stage_v3', decisions, { label, retry: { current: true, drafts: [alternatives, features] } });
    pass(retried);
    assert.deepEqual(retried.trials[0].attempts[0].generationGuard, { violations: ['working_note'], regenerated: true, fallback: false });
  }
});

test('quoted observations from the public history retain their punctuation in publication and S4 replay', async () => {
  const decisions = [stageOne('public-quote', 'accept'), stageTwo('public-quote', 'accept', 'none')];
  const first = '輪に切れ目がある。', second = '細い棒が輪に接している。';
  const humanText = '特徴は「' + first + '」「' + second + '」です。';
  const quotes = '・「' + first + '」\n・『' + second + '』\nこの二つがそろう形ですか？';
  const workReason = '前の下書きに、英語の作業メモや複数の返答案が混じっていました。日本語の一つの返答だけにして書き直してください。';
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    const plain = await records('two_stage_v3', decisions, { label, humanText, generationText: quotes });
    pass(plain);
    assert.deepEqual(plain.trials[0].attempts[0].generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(plain.trials[0].attempts[0].publicSpeech, quotes);

    const retried = await records('two_stage_v3', decisions, { label, humanText,
      retry: { current: true, drafts: ['右側に張り出しがあります。\n' + quotes, quotes] } });
    pass(retried);
    assert.deepEqual(retried.trials[0].attempts[0].generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: false });
    assert.equal(retried.trials[0].attempts[0].publicSpeech, quotes);
    const other = label === 'repair-first' ? 'bypass-enabled' : 'repair-first';
    changeRetry(retried, other, content => content + workReason);
    assert.equal(status(retried, 'replay'), 'mismatch');
  }
});

test('S4 applies the working-note check to orientation-only fallback drafts from the current version', async () => {
  const decisions = [stageOne('fallback', 'accept'), stageTwo('fallback', 'accept', 'none')];
  const drafts: [string, string] = ['右側に張り出しがあります。', '上端がとがっています。'];
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    for (const current of [false, true]) {
      const original = await records('two_stage_v3', decisions, { label, retry: { current, drafts, fallback: true } });
      assert.deepEqual(original.trials[0].attempts[0].generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
      pass(original);
      for (const index of [0, 1]) {
        // Add text ignored by the historical runtime; keep the capture's two requests and final published fallback.
        const edited = structuredClone(original), tape = edited.trials[0].replay[0].tape;
        const addNote = (tail: any) => { tail.luna.filter((l: any) => l.phase === 'generation')[index].response.text += ' Need another reply.'; };
        addNote(tape.tails[label]);
        for (const side of sideCopies(edited).filter(s => s.label === label)) {
          addNote(side.material.tail);
          side.materialSha256 = hash(side.material);
        }
        if (current) assert.equal(status(edited, 'replay'), 'mismatch');
        else pass(edited);
      }
    }
  }
});

test('the comparison condition must carry exactly the reasons its own draft shows (orientation and a name decision), and older layouts none of the v3 ones', async () => {
  const decisions = [stageOne('retry', 'accept'), stageTwo('retry', 'accept', 'none')];
  const namingReason = '前の下書きは名称の決定・合意を表していました。決定・合意を表明せず、このactionの範囲で書き直してください。';
  const mixed = await records('two_stage_v3', decisions, { retry: { current: true, drafts: ['右側に出ています。この形は「name-0」にしましょう。', 'そう見えるんですね。'] } });
  pass(mixed);
  for (const label of ['bypass-enabled', 'repair-first']) {
    assert.ok((generationRequests(mixed.trials[0].replay[0].result.sides.find((s: any) => s.label === label))[1].payload.messages.at(-1).content as string).includes(namingReason), label);
    const dropped = structuredClone(mixed);
    changeRetry(dropped, label, (text: string) => text.replace(namingReason, ''));
    assert.equal(status(dropped, 'replay'), 'mismatch', `${label}: the name-decision reason may not be dropped`);
  }
});

const DRAFT_MISMATCH = '前の下書きの命名に関する行為が、選んだ行動と合っていませんでした。選んだ行動の範囲で、命名に関する行為を行動に合わせて書き直してください。';
test('holistic_v1: a naming-wording draft is asked, a mismatch regenerates, and S4 requires the reason on both conditions', async () => {
  const decisions = [stageOneH('retry', 'accept'), stageTwo('retry', 'accept', 'none')];
  const record = await records('two_stage_v3', decisions, { policy: 'holistic_v2', draftAnswers: ['adopt_chosen'],
    retry: { current: true, drafts: ['この形は「name-0」で呼びましょう。', 'そう見えるんですね。'] } });
  pass(record);
  const t = record.trials[0].turns[0].trace[0];
  assert.deepEqual(t.generationGuard, { violations: ['draft_act_mismatch'], regenerated: true, fallback: false });
  assert.equal(t.draftActs.length, 1);
  assert.equal(t.draftActs[0].choice, 'adopt_chosen');
  for (const label of ['bypass-enabled', 'repair-first']) {
    const dropped = structuredClone(record);
    changeRetry(dropped, label, (text: string) => text.replace(DRAFT_MISMATCH, ''));
    assert.equal(status(dropped, 'replay'), 'mismatch', label);
  }
});
test('holistic_v1: S4 refuses an altered or dropped question record', async () => {
  const decisions = [stageOneH('retry', 'accept'), stageTwo('retry', 'accept', 'none')];
  const record = await records('two_stage_v3', decisions, { policy: 'holistic_v2', draftAnswers: ['adopt_chosen'],
    retry: { current: true, drafts: ['この形は「name-0」で呼びましょう。', 'そう見えるんですね。'] } });
  pass(record);
  const tr = record.trials[0];
  const copiesOfTrace = (n: any) => [n.trials[0].attempts[0], n.trials[0].turns[0].trace[0]];
  const tampered = structuredClone(record);
  for (const t of copiesOfTrace(tampered)) t.draftActs[0].choice = 'none';
  assert.ok(checksOf(tampered).some((c: any) => c.status !== 'pass'), 'altered label');
  const noRecord = structuredClone(record);
  for (const t of copiesOfTrace(noRecord)) delete t.draftActs;
  assert.ok(checksOf(noRecord).some((c: any) => c.status !== 'pass'), 'dropped record');
  assert.ok(tr.turns[0].trace[0].draftActs.every((a: any) => a.status === 'ok'));
});

test('holistic_v1: an orientation-only fallback record passes with no question, and one that carries a question record is refused', async () => {
  const decisions = [stageOneH('fallback', 'accept'), stageTwo('fallback', 'accept', 'none')];
  const drafts: [string, string] = ['右側に張り出しがあります。', '上端がとがっています。'];
  const original = await records('two_stage_v3', decisions, { policy: 'holistic_v2', retry: { current: true, drafts, fallback: true } });
  assert.deepEqual(original.trials[0].attempts[0].generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
  assert.equal(original.trials[0].attempts[0].draftActs, undefined);
  pass(original);
  const mixed = structuredClone(original);
  for (const t of [mixed.trials[0].attempts[0], mixed.trials[0].turns[0].trace[0]]) t.draftActs = [{ draft: 'initial', draftSha256: 'a'.repeat(64), triggers: ['naming_words'], status: 'ok', choice: 'adopt_chosen',
    scores: Object.fromEntries(['adopt_chosen', 'adopt_other', 'decline_or_hold', 'propose_question', 'recount_only', 'none'].map(k => [k, Number(k === 'adopt_chosen')])),
    model: 'typesafe/jev-1.14', responseId: 'gen-x', costUsd: 0, latencyMs: 1, error: null }];
  assert.ok(checksOf(mixed).some((c: any) => c.status !== 'pass'));
});

const ACTS6 = ['adopt_chosen', 'adopt_other', 'decline_or_hold', 'propose_question', 'recount_only', 'none'];
const decisionsAccept = () => [stageOneH('retry', 'accept'), stageTwo('retry', 'accept', 'none')];
const traceCopies = (n: any) => [n.trials[0].attempts[0], n.trials[0].turns[0].trace[0]];

test('05d-3: a regular record whose first draft is not a question target and only the retry is asked is accepted', async () => {
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: ['recount_only'],
    retry: { current: true, drafts: ['右側が尖っています。', 'さっきの「name-0」は相手の案ですね。'] } });
  pass(record);
  assert.deepEqual(record.trials[0].attempts[0].draftActs.map((a: any) => a.draft), ['retry']);
});

test('05d-4: an unusable first answer recovered by a good retry answer is accepted; the unconfirmed draft stays unpublished', async () => {
  const drafts: [string, string] = ['この形は「name-0」で呼びましょう。', 'さっきの「name-0」は相手の案ですね。'];
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: ['bogus', 'recount_only'], retry: { current: true, drafts } });
  pass(record);
  const t = record.trials[0].attempts[0];
  assert.deepEqual(t.draftActs.map((a: any) => [a.draft, a.status, a.choice]), [['initial', 'error', null], ['retry', 'ok', 'recount_only']]);
  assert.deepEqual(t.generationGuard, { violations: ['draft_act_unconfirmed'], regenerated: true, fallback: false });
  const forged = structuredClone(record);
  for (const c of traceCopies(forged)) c.draftActs = c.draftActs.slice(1);
  assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'), 'a dropped error act');
});

test('05d-5: the comparison side is verified against its own final draft and answer', async () => {
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: ['recount_only'], generationText: 'さっきの「name-0」は相手の案ですね。' });
  pass(record);
  for (const label of ['bypass-enabled', 'repair-first']) {
    const forged = structuredClone(record), other = label === 'bypass-enabled' ? 'repair-first' : 'bypass-enabled';
    const bad = (tail: any) => { const a = tail.jev.find((j: any) => j.answers?.draft_naming).answers.draft_naming; a.choice = 'adopt_other'; a.probabilities = Object.fromEntries(ACTS6.map(k => [k, Number(k === 'adopt_other')])); };
    bad(forged.trials[0].replay[0].tape.tails[other]);
    for (const side of sideCopies(forged).filter((x: any) => x.label === other)) { bad(side.material.tail); side.materialSha256 = hash(side.material); }
    assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'), other + ' final draft refused');
  }
});

test('05d-6: draftSha256 is recomputed from the draft text', async () => {
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: ['recount_only'], generationText: 'さっきの「name-0」は相手の案ですね。' });
  pass(record);
  const forged = structuredClone(record);
  for (const c of traceCopies(forged)) c.draftActs[0].draftSha256 = '0'.repeat(64);
  assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'));
});

const NAMING_DRAFT = 'この形は「name-0」で呼びましょう。', RECOUNT_DRAFT = 'さっきの「name-0」は相手の案ですね。';
const forgeBoth = (record: any, label: string, edit: (tail: any) => void) => {
  const forged = structuredClone(record);
  edit(forged.trials[0].replay[0].tape.tails[label]);
  for (const side of sideCopies(forged).filter((x: any) => x.label === label)) { edit(side.material.tail); side.materialSha256 = hash(side.material); }
  return forged;
};
const draftAnswerOf = (tail: any) => tail.jev.find((j: any) => j.answers?.draft_naming).answers.draft_naming;

test('05e-1: a normally published text must be the last checked generation draft', async () => {
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', generationText: '輪の部分が見えます。' });
  pass(record);
  const forged = structuredClone(record);
  for (const t of traceCopies(forged)) t.publicSpeech = 'この形は「丸形」と呼びましょう。';
  forged.trials[0].turns[0].publicText = 'この形は「丸形」と呼びましょう。';
  assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'));
});

test('05e-2: an out-of-range optional confidence is an unusable answer in the run and in S4, on both the recorded and the comparison side', async () => {
  const bad = { choice: 'recount_only', extra: { confidence: 2 } };
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: [bad, 'recount_only'], retry: { current: true, drafts: [NAMING_DRAFT, RECOUNT_DRAFT] } });
  pass(record);
  assert.deepEqual(record.trials[0].attempts[0].draftActs.map((a: any) => [a.status, a.error]), [['error', 'invalid_response'], ['ok', null]]);
  const single = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: ['recount_only'], generationText: RECOUNT_DRAFT });
  pass(single);
  for (const label of ['bypass-enabled', 'repair-first']) {
    const forged = forgeBoth(single, label, tail => { draftAnswerOf(tail).confidence = 2; });
    assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'), label + ' unconfirmed final draft');
  }
});

test('05e-3: a failed question answer is checked against its own send: id, cost, reason, triggers', async () => {
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: [{ choice: 'recount_only', extra: { confidence: 2 } }, 'recount_only'],
    retry: { current: true, drafts: [NAMING_DRAFT, RECOUNT_DRAFT] } });
  pass(record);
  const forgeries: Array<[string, (a: any) => void]> = [['cost', a => { a.costUsd = 0.034; }], ['response id', a => { a.responseId = 'gen-other'; }],
    ['reason', a => { a.error = 'timeout'; }], ['triggers', a => { a.triggers = ['agree_action']; }]];
  for (const [name, edit] of forgeries) {
    const forged = structuredClone(record);
    for (const t of traceCopies(forged)) edit(t.draftActs[0]);
    assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'), name);
  }
});

test('05e-4: a comparison retry that can neither publish nor fall back (naming fault, then orientation fault) is never a success', async () => {
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', draftAnswers: ['adopt_other'], retry: { current: true, drafts: [NAMING_DRAFT, 'そう見えるんですね。'] } });
  pass(record);
  for (const label of ['bypass-enabled', 'repair-first']) {
    const forged = forgeBoth(record, label, tail => { tail.luna.filter((l: any) => l.phase === 'generation')[1].response.text = '右側が尖っています。'; });
    assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'), label);
  }
});

const forgeGeneration = (record: any, label: string, index: number, text: string) =>
  forgeBoth(record, label, tail => { tail.luna.filter((l: any) => l.phase === 'generation')[index].response.text = text; });
import { buildRecords } from './support/s4-v3-records.ts';
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC } from '../dialogue-model/runtime/local-grounding/extract.ts';
// holistic_v1: the only name candidate is a name said in public (the memo's readings are explanations); a partner mention is such a name.
const mentionQuote = '船という見方もありますね。';
const finalChecks = (n: any) => checksOf(n).filter((c: any) => c.id.includes('.attempt.0.'));
const namedRecords = (policy: 'holistic_v1' | 'holistic_v2' | 'holistic_v3' = 'holistic_v2') => buildRecords({ dialoguePolicy: policy, turns: [
  { human: mentionQuote, plan: { action: 'accept', target: 'none', act: 'assert', extraction: JSON.stringify([{ segmentId: 's1', quote: '船', targets: [Object.keys(OLD.state.ledger)[2]],
    aspect: 'name', proposition: '船という見方', name: '船', linkedIssueId: null, respondsToTurn: null }]) } },
  { human: 'どう呼びましょうか。', plan: { action: 'propose_name', target: 'figure_2', speech: '「船」と呼ぶのはどうでしょう？' } }] });

test('05f-1: when both drafts are orientation-only the derived fallback is required, in the flag and in the published text', async () => {
  const drafts: [string, string] = ['右側が尖っています。', '上端が尖っています。'];
  const original = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', retry: { current: true, drafts, fallback: true } });
  pass(original);
  const forged = structuredClone(original);
  for (const t of traceCopies(forged)) { t.generationGuard.fallback = false; t.publicSpeech = drafts[1]; }
  forged.trials[0].turns[0].publicText = drafts[1];
  assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'));
});

test('05f-2: a comparison propose_name draft must show the chosen name; one that does is accepted', async () => {
  const record = await namedRecords();
  assert.equal(record.trials[0].attempts[0].executed.action, 'propose_name');
  assert.ok(finalChecks(record).length >= 4 && finalChecks(record).every((c: any) => c.status === 'pass'));
  for (const label of ['bypass-enabled', 'repair-first']) {
    assert.ok(finalChecks(forgeGeneration(record, label, 0, '呼び名をひとつ考えてみました。')).some((c: any) => c.status !== 'pass'), label + ' (name not shown)');
  }
});

test('05f-3: a comparison draft that defers naming is unsolicited unless a question about the same figure follows', async () => {
  const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', generationText: '輪の部分が見えます。' });
  pass(record);
  for (const label of ['bypass-enabled', 'repair-first']) {
    assert.ok(checksOf(forgeGeneration(record, label, 0, '名前を決めるのは待ちましょう。')).some((c: any) => c.status !== 'pass'), label + ' (deferral)');
  }
  // The recorded condition is bypass-enabled; the comparison condition's draft that keeps asking about the same figure is allowed.
  pass(forgeGeneration(record, 'repair-first', 0, '名前を決めるのは待ちましょう。輪に切れ目がありますか？'));
});

test('05f: the run, its dynamic replay and S4 agree on the deferral and name-not-shown contrasts', async () => {
  const dynamic = async (record: any) => (await pairedInterventionReplay(structuredClone(record.trials[0].replay[0].tape), OWN as any, MODEL, record.trials[0].profile) as any).status;
  const accept = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', generationText: '輪の部分が見えます。' });
  const deferral = forgeGeneration(accept, 'repair-first', 0, '名前を決めるのは待ちましょう。');
  const followed = forgeGeneration(accept, 'repair-first', 0, '名前を決めるのは待ちましょう。輪に切れ目がありますか？');
  assert.notEqual(await dynamic(deferral), 'same_material_intervention_verified');
  assert.equal(await dynamic(followed), 'same_material_intervention_verified');
  pass(followed);
  assert.ok(checksOf(deferral).some((c: any) => c.status !== 'pass'));
  const named = await namedRecords();
  const hidden = forgeGeneration(named, 'repair-first', 0, '呼び名をひとつ考えてみました。');
  assert.notEqual(await dynamic(hidden), 'same_material_intervention_verified');
  assert.ok(finalChecks(hidden).some((c: any) => c.status !== 'pass'));
});

test('05g: internal items (field names, local ids, an echo of the send\'s own instructions) in a first draft rewritten safely are accepted; one such comparison draft alone is refused', async () => {
  const dynamic = async (record: any) => (await pairedInterventionReplay(structuredClone(record.trials[0].replay[0].tape), OWN as any, MODEL, record.trials[0].profile) as any).status;
  const echo = '画像はあなた自身に提示された図形だけです。相手の画像・内部認識・正しい対応表は見えません。';
  for (const first of ['この形のissueIdは違います。', '2:local1 の話です。', echo]) {
    const record = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', retry: { current: true, drafts: [first, 'そう見えるんですね。'] } });
    pass(record);
    assert.deepEqual(record.trials[0].attempts[0].generationGuard.regenerated, true);
    assert.ok(record.trials[0].attempts[0].generationGuard.violations.length >= 1, first);
    assert.equal(await dynamic(record), 'same_material_intervention_verified', first);
    const single = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', generationText: 'そう見えるんですね。' });
    const bad = forgeGeneration(single, 'repair-first', 0, first);
    assert.ok(checksOf(bad).some((c: any) => c.status !== 'pass'), 'comparison: ' + first);
    assert.notEqual(await dynamic(bad), 'same_material_intervention_verified', 'dynamic: ' + first);
  }
});

import { AI_FUNCTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/jev-ai-public.ts';
test('05h: not_reached only where material outside the record is needed; provable contradictions stay mismatch', async () => {
  const hiddenLine = AI_FUNCTION_INSTRUCTIONS.split(/\r?\n/u).map((l: string) => l.trim()).find((l: string) => l.length >= 24)!;
  const aiOn = (n: any) => n.trials[0].profile.localGrounding?.aiPublicClaims === true;
  const hidden = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', retry: { current: true, drafts: [hiddenLine, 'そう見えるんですね。'] } });
  const states = checksOf(hidden).map((c: any) => c.status);
  assert.ok(aiOn(hidden), 'AI public claims are on in this material');
  assert.ok(!states.includes('mismatch'), 'a regeneration only a hidden instruction explains is not a mismatch');
  assert.ok(states.includes('not_reached'));
  // issueId explains the regeneration; adding a text-decidable code afterwards is a provable contradiction.
  const issue = await records('two_stage_v3', decisionsAccept(), { policy: 'holistic_v2', retry: { current: true, drafts: ['この形のissueIdは違います。', 'そう見えるんですね。'] } });
  pass(issue);
  for (const code of ['internal_image', 'internal_credential']) {
    const forged = structuredClone(issue);
    for (const t of traceCopies(forged)) t.generationGuard.violations = [...t.generationGuard.violations, code];
    assert.ok(checksOf(forged).some((c: any) => c.status === 'mismatch'), code);
  }
});

// 05j-B1: each policy version reproduces its own requests; a record relabelled with the other version (profile, digests, materials) is refused.
function relabel(record: any, policy: 'holistic_v1' | 'holistic_v2' | 'holistic_v3') {
  const forged = structuredClone(record), oldProfile = forged.trials[0].profile, oldDigest = forged.trials[0].profileSha256;
  const profile = { ...oldProfile, dialoguePolicy: policy }, digest = hash(profile);
  const walk = (x: any): any => {
    if (typeof x === 'string') return x === oldDigest ? digest : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      if (x.id === 'research_trial_profile_v3' && x.dialoguePolicy !== undefined) return { ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])), dialoguePolicy: policy };
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    }
    return x;
  };
  const out = walk(forged);
  for (const side of sideCopies(out)) side.materialSha256 = hash(side.material);
  return out;
}
test('05j-B1: holistic_v1 reproduces the earlier candidates, holistic_v2 the public-name rule, and a relabelled record is refused', async () => {
  const v1 = await records('two_stage_v3', [stageOne('p', 'propose_name'), stageTwo('p', 'propose_name', 'figure_2'), jevResponse('p-detail', { name: answer('name_0', ['name_0']) })],
    { policy: 'holistic_v1', generationText: '「name-2」と呼ぶのはどうでしょう？' });
  pass(v1);
  assert.equal(v1.trials[0].profile.dialoguePolicy, 'holistic_v1');
  assert.ok(!checksOf(relabel(v1, 'holistic_v2')).every((c: any) => c.status === 'pass'), 'v1 record under v2');
  const v2 = await namedRecords();
  assert.equal(v2.trials[0].profile.dialoguePolicy, 'holistic_v2');
  assert.ok(!finalChecks(relabel(v2, 'holistic_v1')).every((c: any) => c.status === 'pass'), 'v2 record under v1');
});

function changeExtraction(records: any, label: string, content: string) {
  let changed = 0;
  for (const side of sideCopies(records).filter(x => x.label === label)) {
    for (const request of side.requests.filter((q: any) => q.provider === 'luna' && q.phase === 'local_extraction')) {
      const body = request.payload;
      body.messages[0].content = content;
      request.completeMessagesSha256 = hash(body.messages);
      request.preProjectionPayloadSha256 = request.payloadSha256 = hash(body);
      changed++;
    }
    side.materialSha256 = hash(side.material);
  }
  return changed;
}
test('05k-B1: the extraction instruction of a holistic record is checked against its policy version', async () => {
  for (const [policy, own, other] of [['holistic_v1', MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC],
    ['holistic_v2', MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC, MEMO_LOCAL_EXTRACTION_INSTRUCTIONS]] as const) {
    const record = await records('two_stage_v3', policy === 'holistic_v1' ? [stageOne('x', 'accept'), stageTwo('x', 'accept', 'none')] : decisionsAccept(), { policy: policy as any });
    pass(record);
    const sent = sideCopies(record).flatMap((x: any) => x.requests).filter((q: any) => q.phase === 'local_extraction').map((q: any) => q.payload.messages[0].content);
    assert.ok(sent.length > 0 && sent.every((c: string) => c === own), policy + ' sends its own extraction text');
    for (const label of ['bypass-enabled', 'repair-first']) {
      const forged = structuredClone(record);
      assert.ok(changeExtraction(forged, label, other) > 0);
      assert.ok(checksOf(forged).some((c: any) => c.status !== 'pass'), policy + ' / ' + label + ' with the other version\'s text');
    }
  }
});

test('05l: a human-proposed name left in the public names or candidates is refused by S4 for holistic_v2 (full claims decide), and accepted where the earlier rule allowed it', async () => {
  const [s0, s1] = Object.keys(OLD.state.ledger);
  const build = (policy: 'holistic_v1' | 'holistic_v2' | null) => buildRecords({ dialoguePolicy: policy, turns: [
    { human: 'この二つのどちらかに、帆って呼び名はどう？', plan: { action: 'accept', target: 'none', act: 'name_propose', extraction: JSON.stringify([{ segmentId: 's1', quote: '帆', targets: [s0, s1],
      aspect: 'name', proposition: '帆と呼ぶ提案', name: '帆', linkedIssueId: null, respondsToTurn: null }]) } },
    { human: '他の図形はどう呼びますか。', plan: { action: 'propose_name', target: 'figure_2', name: '帆', speech: '「帆」と呼ぶのはどうでしょう？' } }] });
  // The earlier rule only excludes the figures the proposal named, so this is a valid holistic_v1 record: AI proposes the partner's name for figure 2.
  const v1 = await build('holistic_v1');
  assert.equal(v1.trials[0].attempts[0].executed.name, '帆');
  assert.ok(finalChecks(v1).length >= 4 && finalChecks(v1).every((c: any) => c.status === 'pass'), 'holistic_v1 positive control');
  const asV2 = relabel(v1, 'holistic_v2');
  assert.ok(finalChecks(asV2).some((c: any) => c.status === 'mismatch'), 'the same record under holistic_v2');
  // The regular v2 record (the partner name is not offered) still passes.
  const v2 = await namedRecords();
  assert.ok(finalChecks(v2).every((c: any) => c.status === 'pass'));
  // A regular v2 record whose turn carries the partner proposal: the full claims name it and the request does not offer it.
  const withProposal = await buildRecords({ dialoguePolicy: 'holistic_v2', turns: [
    { human: 'この二つのどちらかに、帆って呼び名はどう？', plan: { action: 'accept', target: 'none', act: 'name_propose', extraction: JSON.stringify([{ segmentId: 's1', quote: '帆', targets: [s0, s1],
      aspect: 'name', proposition: '帆と呼ぶ提案', name: '帆', linkedIssueId: null, respondsToTurn: null }]) } },
    { human: 'どうですか。', plan: { action: 'accept', target: 'none' } }] });
  assert.equal(withProposal.trials[0].profile.dialoguePolicy, 'holistic_v2');
  assert.ok(finalChecks(withProposal).length >= 4 && finalChecks(withProposal).every((c: any) => c.status === 'pass'));
});

test('05m: a withdrawn partner proposal is no longer a proposal: the regular holistic_v2 record (both strategies) is accepted', async () => {
  const [s0, s1, , s3] = Object.keys(OLD.state.ledger);
  const seg = (quote: string, targets: string[], name: string | null) => JSON.stringify([{ segmentId: 's1', quote, targets, aspect: 'name', proposition: quote, name, linkedIssueId: null, respondsToTurn: null }]);
  const proposal = { human: 'この二つのどちらかに、帆って呼び名はどう？', plan: { action: 'accept', target: 'none', act: 'name_propose', extraction: seg('帆', [s0, s1], '帆') } };
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    // two turns: the partner withdraws the named proposal, then the AI may propose that name (the proposal no longer exists).
    const named = await buildRecords({ label, dialoguePolicy: 'holistic_v2', turns: [proposal,
      { human: 'さっきの「帆」という私の案は取り下げます。', plan: { action: 'accept', target: 'none', act: 'withdraw', antecedent: 'claim_0', extraction: seg('帆', [s0, s1], '帆'), respondsToTurn: 3 } as any },
      { human: 'どう呼びましょう。', plan: { action: 'propose_name', target: 'figure_2', name: '帆', speech: '「帆」と呼ぶのはどうでしょう？' } }] });
    assert.equal(named.trials[0].attempts[0].executed.name, '帆', label);
    assert.ok(finalChecks(named).length >= 4 && finalChecks(named).every((c: any) => c.status === 'pass'), label + ' (named withdrawal)');
    // three turns: a withdrawal that omits the name, then a neutral mention of the same name for another figure and the AI's proposal of it.
    const nameless = await buildRecords({ label, dialoguePolicy: 'holistic_v2', turns: [proposal,
      { human: 'さっきの案は取り下げます。', plan: { action: 'accept', target: 'none', act: 'withdraw', antecedent: 'claim_0', extraction: seg('取り下げます', [s0, s1], null) } },
      { human: 'こちらには「帆」という見方もありますね。', plan: { action: 'propose_name', target: 'figure_3', name: '帆', act: 'assert', speech: '「帆」と呼ぶのはどうでしょう？',
        extraction: seg('帆', [s3], '帆') } }] });
    assert.equal(nameless.trials[0].attempts[0].executed.name, '帆', label);
    assert.ok(finalChecks(nameless).length >= 4 && finalChecks(nameless).every((c: any) => c.status === 'pass'), label + ' (nameless withdrawal)');
  }
});

test('05p: holistic_v3 leaves accept out of a typed naming request with no agree candidate; S4 applies the same table and refuses a record of another version', async () => {
  const s3 = Object.keys(OLD.state.ledger)[3];
  const proposal = 'これ、かかしとかどう？';
  const seg = JSON.stringify([{ segmentId: 's1', quote: 'かかし', targets: [], aspect: 'name', proposition: 'かかしと呼ぶ提案', name: 'かかし', linkedIssueId: null, respondsToTurn: null }]);
  const turn = (action: string, target: string, speech: string) => ({ human: proposal, plan: { action, target, act: 'name_propose', speech, extraction: seg } });
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    const v3 = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [turn('confirm', 'figure_3', 'どの形のことですか？')] });
    assert.equal(v3.trials[0].attempts[0].executed.action, 'confirm', label);
    const offered = Object.keys(sideCopies(v3)[0].requests.find((q: any) => q.provider === 'jev' && q.payload.questions.action).payload.questions.action.criteria);
    assert.ok(!offered.includes('accept') && offered.includes('confirm'), label + ': accept is not offered');
    assert.ok(finalChecks(v3).length >= 4 && finalChecks(v3).every((c: any) => c.status === 'pass'), label + ' (v3 record)');
    assert.ok(!finalChecks(relabel(v3, 'holistic_v2')).every((c: any) => c.status === 'pass'), label + ': a v3 record under v2');
    const v2 = await buildRecords({ label, dialoguePolicy: 'holistic_v2', turns: [turn('accept', 'none', 'そう見えるんですね。')] });
    assert.ok(finalChecks(v2).length >= 4 && finalChecks(v2).every((c: any) => c.status === 'pass'), label + ' (v2 keeps accept)');
    assert.ok(!finalChecks(relabel(v2, 'holistic_v3')).every((c: any) => c.status === 'pass'), label + ': a v2 record under v3');
  }
  void s3;
});

// 05p-B1/B4: the closed set offered is the one source; a saved score table or ranking without accept (holistic_v3 typed naming request) is read back, in both strategies.
const unboundSeg = JSON.stringify([{ segmentId: 's1', quote: 'かかし', targets: [], aspect: 'name', proposition: 'かかしと呼ぶ提案', name: 'かかし', linkedIssueId: null, respondsToTurn: null }]);
for (const original of ['defer', 'move_on'] as const) {
  test(`05p-B1 (${original}): a veto over a score table without accept leaves a state that reads back, a next turn that runs and a record S4 and the replay accept`, async () => {
    for (const label of ['repair-first', 'bypass-enabled'] as const) {
      const veto = { human: 'これ、かかしとかどう？', plan: { action: original, target: 'figure_3', act: 'name_propose', extraction: unboundSeg,
        speech: label === 'repair-first' ? 'どの形のことですか？' : 'この話は後にしましょう。', actionScores: { [original]: 0.6, confirm: 0.29, repair: 0.11 } } };
      // The veto turn is the final turn: S4 and the dynamic replay (asserted inside buildRecords) read the ranking without accept.
      const record = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [veto] });
      assert.equal(record.trials[0].attempts[0].executed.action, label === 'repair-first' ? 'confirm' : original, label);
      assert.ok(finalChecks(record).length >= 4 && finalChecks(record).every((c: any) => c.status === 'pass'),
        label + ' ' + JSON.stringify(finalChecks(record).filter((c: any) => c.status !== 'pass').map((c: any) => [c.id, c.status, c.reason])));
      // The state this turn leaves is read back by the next human turn (buildRecords runs it through the runtime's own state validation).
      const next = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [veto, { human: 'どうですか。', plan: { action: 'accept', target: 'none' } }] });
      assert.ok(finalChecks(next).every((c: any) => c.status === 'pass'), label + ' next turn');
    }
  });
}

test('05q-B: S4 reads the approval request (a name proposal that carries the earlier name) as a typed naming request: the regular holistic_v3 record (both strategies) passes without accept', async () => {
  const askSeg = JSON.stringify([{ segmentId: 's1', quote: 'その呼び名でよいですか？', targets: [], aspect: 'name', proposition: 'その呼び名でよいですか', name: null, linkedIssueId: null, respondsToTurn: 1 }]);
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    const record = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [
      { human: 'これ、かかしとかどう？', plan: { action: 'confirm', target: 'figure_3', act: 'name_propose', extraction: unboundSeg, speech: 'どの形のことですか？' } },
      { human: 'その呼び名でよいですか？', plan: { action: 'confirm', target: 'figure_3', act: 'name_propose', antecedent: 'claim_0', extraction: askSeg, speech: 'どの形のことか、もう少し教えてください。' } }] });
    const offered = Object.keys(sideCopies(record)[0].requests.find((q: any) => q.provider === 'jev' && q.payload.questions.action).payload.questions.action.criteria);
    assert.ok(!offered.includes('accept') && !offered.includes('agree'), label + ': ' + offered.join());
    assert.ok(finalChecks(record).length >= 4 && finalChecks(record).every((c: any) => c.status === 'pass'), label);
    assert.ok(!finalChecks(relabel(record, 'holistic_v2')).every((c: any) => c.status === 'pass'), label + ': under holistic_v2');
  }
});

test('05p-B2: S4 applies the same referent-contest rule to the agree candidates: the regular holistic_v3 records (both strategies) pass, a record of another version is refused', async () => {
  const s3 = Object.keys(OLD.state.ledger)[3];
  const speech = '角ばった塊に細い脚が付いた形のように見えます。';
  const ai = JSON.stringify([{ segmentId: 'shape', quote: speech, targets: [s3], aspect: 'construal', proposition: '角ばった塊に脚が付く', name: null, linkedIssueId: null, respondsToTurn: null }]);
  const describe = { human: 'どんな図形がありますか？', plan: { action: 'confirm', target: 'figure_3', speech, aiExtraction: ai } };
  const between = { human: 'そう、その特徴がある図形です。', plan: { action: 'accept', target: 'figure_3', referent: 'multiple' } };
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    // The partner said two figures remain possible: the proposal is not bound to the described figure, so agree is not offered and the AI asks.
    const contested = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [describe, between,
      { human: 'これ、かかしとかどう？', plan: { action: 'confirm', target: 'figure_3', act: 'name_propose', referent: 'none', extraction: unboundSeg, speech: 'どの形のことですか？' } }] });
    const offered = Object.keys(sideCopies(contested)[0].requests.find((q: any) => q.provider === 'jev' && q.payload.questions.action).payload.questions.action.criteria);
    assert.ok(!offered.includes('agree') && !offered.includes('accept'), label + ': ' + offered.join());
    assert.ok(finalChecks(contested).length >= 4 && finalChecks(contested).every((c: any) => c.status === 'pass'), label + ' (contested)');
    assert.ok(!finalChecks(relabel(contested, 'holistic_v2')).every((c: any) => c.status === 'pass'), label + ': under holistic_v2');
    // The estimate singles the figure out: the proposal binds and the agreement is regular.
    const single = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [describe, { ...between, plan: { ...between.plan, referent: 'figure_3' } },
      { human: 'これ、かかしとかどう？', plan: { action: 'agree', target: 'figure_3', name: 'かかし', act: 'name_propose', referent: 'figure_3', extraction: unboundSeg, speech: '「かかし」と呼びましょう。' } }] });
    assert.equal(single.trials[0].attempts[0].executed.action, 'agree', label);
    assert.ok(finalChecks(single).length >= 4 && finalChecks(single).every((c: any) => c.status === 'pass'), label + ' (single)');
  }
});

test('05q-C: the copies of a committed turn (trace and saved state) agree in every shared field, the estimate agrees with the tape\'s Jev response, and the marker is recomputed', async () => {
  const stateCopies = (n: any) => [n.trials[0].turns[0].state, n.trials[0].lastCommittedState];
  const lastJudgment = (state: any) => state.judgments.at(-1).jevTurn;
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    const record = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [{ human: 'そうそう、それです。', plan: { action: 'accept', target: 'figure_3', referent: 'figure_3' } }] });
    assert.ok(finalChecks(record).length >= 4 && finalChecks(record).every((c: any) => c.status === 'pass'), label + ' (regular)');
    const flip = (hr: any) => { hr.scores = Object.fromEntries(Object.keys(hr.scores).map(k => [k, Number(k === 'multiple')])); };
    const bad = (n: any) => !finalChecks(n).every((c: any) => c.status === 'pass');
    const traceOnly = structuredClone(record); for (const t of traceCopies(traceOnly)) flip(t.humanReferent);
    assert.ok(bad(traceOnly), label + ': the trace says another estimate than the saved turn');
    const stateOnly = structuredClone(record); for (const st of stateCopies(stateOnly)) flip(lastJudgment(st).humanReferent);
    assert.ok(bad(stateOnly), label + ': the saved turn says another estimate than the trace');
    const bothNotTape = structuredClone(record); for (const t of traceCopies(bothNotTape)) flip(t.humanReferent); for (const st of stateCopies(bothNotTape)) flip(lastJudgment(st).humanReferent);
    assert.ok(bad(bothNotTape), label + ': consistent copies that differ from the tape response');
    // The marker: forged on a turn without a naming request, in the saved state only.
    const forged = structuredClone(record); for (const st of stateCopies(forged)) lastJudgment(st).namingRequest = true;
    assert.ok(bad(forged), label + ': a marker forged in the saved state');
    const named = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [{ human: 'これ、かかしとかどう？', plan: { action: 'confirm', target: 'figure_3', act: 'name_propose', extraction: unboundSeg, speech: 'どの形のことですか？' } }] });
    assert.ok(finalChecks(named).every((c: any) => c.status === 'pass'), label + ' (named, regular)');
    const removed = structuredClone(named); for (const st of stateCopies(removed)) delete lastJudgment(st).namingRequest;
    assert.ok(bad(removed), label + ': a marker removed from the saved state only');
  }
});

test('05r: S4 recomputes the reconfirmation marker and the inherited-name source with the same shared functions: the regular holistic_v3 records (both strategies) pass, tampered markers do not', async () => {
  const s3 = Object.keys(OLD.state.ledger)[3];
  const speech = '角ばった塊に細い脚が付いた形のように見えます。';
  const ai = JSON.stringify([{ segmentId: 'shape', quote: speech, targets: [s3], aspect: 'construal', proposition: 'x', name: null, linkedIssueId: null, respondsToTurn: null }]);
  const seg = (quote: string, name: string | null) => JSON.stringify([{ segmentId: 's1', quote, targets: [], aspect: 'name', proposition: quote, name, linkedIssueId: null, respondsToTurn: null }]);
  const describe = { human: 'どんな図形がありますか？', plan: { action: 'confirm', target: 'figure_3', speech, aiExtraction: ai } };
  const agreedTurn = { human: 'これ、かかしとかどう？', plan: { action: 'agree', target: 'figure_3', name: 'かかし', act: 'name_propose', referent: 'figure_3', extraction: seg('かかし', 'かかし'), speech: '「かかし」と呼びましょう。' } };
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    // A reconfirmation of the agreed name: marked, accept stays, no naming-act question.
    const again = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [describe, agreedTurn,
      { human: 'で、さっきのかかしでいい？', plan: { action: 'accept', target: 'none', act: 'name_propose', referent: 'none', extraction: seg('かかし', 'かかし'), speech: 'うん、いいよ。' } }] });
    const t = again.trials[0].attempts[0];
    assert.equal(t.namingReconfirm, true, label);
    assert.equal(t.namingRequest, undefined);
    assert.ok(finalChecks(again).length >= 4 && finalChecks(again).every((c: any) => c.status === 'pass'), label + ' (reconfirm) ' + JSON.stringify(finalChecks(again).filter((c: any) => c.status !== 'pass').map((c: any) => [c.id, c.reason])));
    const noMarker = structuredClone(again);
    for (const x of traceCopies(noMarker)) delete x.namingReconfirm;
    assert.ok(!finalChecks(noMarker).every((c: any) => c.status === 'pass'), label + ': the marker removed');
    const asRequest = structuredClone(again);
    for (const x of traceCopies(asRequest)) { delete x.namingReconfirm; x.namingRequest = true; }
    assert.ok(!finalChecks(asRequest).every((c: any) => c.status === 'pass'), label + ': a reconfirmation passed off as an open request');
    // A short re-approval after an unbound proposal: the carried name takes the proposal's turn as its source, so agree is offered and regular.
    const short = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [describe,
      { human: 'これ、かかしとかどう？', plan: { action: 'confirm', target: 'figure_3', act: 'name_propose', referent: 'figure_3', extraction: seg('かかし', 'かかし'), speech: 'どの形のことですか？' } },
      { human: 'その呼び名でいい？', plan: { action: 'agree', target: 'figure_3', name: 'かかし', act: 'name_propose', antecedent: 'claim_1', referent: 'figure_3', extraction: seg('その呼び名でいい？', null), speech: '「かかし」と呼びましょう。' } }] });
    assert.equal(short.trials[0].attempts[0].executed.action, 'agree', label);
    assert.ok(finalChecks(short).length >= 4 && finalChecks(short).every((c: any) => c.status === 'pass'), label + ' (short re-approval) ' + JSON.stringify(finalChecks(short).filter((c: any) => c.status !== 'pass').map((c: any) => [c.id, c.reason])));
  }
});

test('05s: S4 derives the question triggers of a reconfirmation without the wording trigger: the affirming draft carries no question record, a question record on it is refused', async () => {
  const s3 = Object.keys(OLD.state.ledger)[3];
  const speech = '角ばった塊に細い脚が付いた形のように見えます。';
  const ai = JSON.stringify([{ segmentId: 'shape', quote: speech, targets: [s3], aspect: 'construal', proposition: 'x', name: null, linkedIssueId: null, respondsToTurn: null }]);
  const seg = (quote: string, name: string | null) => JSON.stringify([{ segmentId: 's1', quote, targets: [], aspect: 'name', proposition: quote, name, linkedIssueId: null, respondsToTurn: null }]);
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    const record = await buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: [{ human: 'どんな図形がありますか？', plan: { action: 'confirm', target: 'figure_3', speech, aiExtraction: ai } },
      { human: 'これ、かかしとかどう？', plan: { action: 'agree', target: 'figure_3', name: 'かかし', act: 'name_propose', referent: 'figure_3', extraction: seg('かかし', 'かかし'), speech: '「かかし」と呼びましょう。' } },
      { human: 'それで、さっきの「かかし」でいい？', plan: { action: 'accept', target: 'none', act: 'name_propose', referent: 'none', extraction: seg('かかし', 'かかし'), speech: 'はい、その呼び方で大丈夫です。' } }] });
    assert.equal(record.trials[0].attempts[0].namingReconfirm, true, label);
    assert.equal(record.trials[0].attempts[0].draftActs, undefined, label);
    assert.ok(finalChecks(record).length >= 4 && finalChecks(record).every((c: any) => c.status === 'pass'), label);
    const extra = structuredClone(record);
    const row = { draft: 'initial', draftSha256: 'a'.repeat(64), triggers: ['naming_words'], status: 'ok', choice: 'none', scores: Object.fromEntries(['adopt_chosen', 'adopt_other', 'decline_or_hold', 'propose_question', 'recount_only', 'none'].map(k => [k, Number(k === 'none')])), model: 'typesafe/jev-1.14', responseId: 'gen-x', costUsd: 0, latencyMs: 1, error: null };
    for (const x of traceCopies(extra)) x.draftActs = [row];
    for (const st of [extra.trials[0].turns[0].state, extra.trials[0].lastCommittedState]) st.judgments.at(-1).jevTurn.draftActs = [row];
    assert.ok(!finalChecks(extra).every((c: any) => c.status === 'pass'), label + ': a question the wording alone would have opened');
  }
});
