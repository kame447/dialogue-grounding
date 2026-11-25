// Independent 05y acceptance. Dialogue, observations and all upstream replies are synthetic.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import type { InterventionReplayTape, ReplaySegment } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC } from '../dialogue-model/runtime/local-grounding/extract.ts';
import type { LocalAct, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { MODEL, normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { buildRecords, Label } from './support/s4-v3-records.ts';

type Policy = 'holistic_v3' | 'holistic_v4';
type Profile = ReturnType<typeof researchTrialProfileV3>;
type Records = Awaited<ReturnType<typeof buildRecords>>;
type Send = InterventionReplayTape['recorded']['expectedRequests'][number];
type PublicEvent = InterventionReplayTape['events'][number];
const strategies = ['repair-first', 'bypass-enabled'] as const;
const policies = ['holistic_v3', 'holistic_v4'] as const;
const alias = '環の小札';
const locate = '輪に小さな突起が付いている形でしょうか？';
const suggestion = '輪と突起のあるこの図形を「' + alias + '」と呼びませんか？';
const adoption = 'はい、この形を「' + alias + '」と呼びましょう。';
const approval = 'その呼び名でいい？';
const confirmation = 'はい、いいですよ。';
const readKey = async () => 'sk-or-synthetic-05y-offline-key-000000';
const lunaModel = 'synthetic-luna-model';

type Segment = LocalSegmentProposal & { act: LocalAct; antecedent?: string };
type Plan = {
  action: 'accept' | 'agree' | 'confirm';
  target: 'none' | 'figure_3';
  speech: string;
  referent?: 'figure_3';
  humanSegments?: Segment[];
  aiSegments?: Segment[];
};
type Turn = { human: string; plan: Plan };

const current = {
  createChatClient, createJevDecisionClient, createJevLocalTestClassifier, createProfileDialogue,
  researchTrialProfileV3, pairedInterventionReplay, MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC,
};
type Producer = typeof current;

function segment(quote: string, aspect: Segment['aspect'], act: LocalAct,
    fields: Partial<Pick<Segment, 'segmentId' | 'targets' | 'name' | 'respondsToTurn' | 'proposition' | 'antecedent'>> = {}): Segment {
  return { segmentId: '1', quote, proposition: quote, aspect, act,
    targets: [], name: null, respondsToTurn: null, linkedIssueId: null, ...fields };
}

function extraction(segments: Segment[] = []) {
  return JSON.stringify(segments.map(({ act, antecedent, ...extracted }) => extracted));
}

function choiceResponse(request: JevDecisionPayload, plan: Plan, responseNo: number) {
  const state = JSON.parse(request.state) as { aiSeq?: number };
  const answers = Object.fromEntries(Object.entries(request.questions).map(([key, { criteria }]) => {
    const labels = Object.keys(criteria);
    let choice: string | undefined = labels[0];
    if (key === 'action') choice = plan.action;
    if (key === 'target') choice = plan.target;
    if (key === 'repair_issue' || key === 'basis') choice = 'none';
    if (key === 'prospect') choice = 'no_open_issue';
    if (key === 'human_referent') choice = plan.referent ?? 'none';
    if (key === 'draft_naming') choice = plan.action === 'agree' ? 'adopt_chosen' : 'none';
    if (key === 'name') choice = labels.find(label => JSON.parse(criteria[label]).value === alias);
    const match = /^segment_(\d+)_(act|antecedent|support)$/u.exec(key);
    if (match) {
      const [, index, field] = match;
      const segments = state.aiSeq === undefined && field !== 'support' ? plan.humanSegments : plan.aiSegments;
      const scripted = segments?.[Number(index)];
      assert.ok(scripted, 'missing script for ' + key);
      if (field === 'act') choice = scripted.act;
      if (field === 'antecedent') choice = scripted.antecedent ?? 'none';
      if (field === 'support') choice = 'expressed';
    }
    assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
    return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
      labels.map(label => [label, Number(label === choice)]),
    ) }];
  }));
  return { model: request.model, id: 'gen-05y-' + responseNo, usage: { cost: 0 }, answers };
}

const detail = '丸い穴があります。';
function approvalTurns(slot: string, antecedent: 'claim_1' | 'claim_2', echo: string, redactQuote = false): Turn[] {
  const question = redactQuote ? approval + echo : approval;
  return [
    { human: '探している図形を一緒に照らし合わせましょう。', plan: {
      action: 'confirm', target: 'figure_3', speech: locate,
      aiSegments: [segment(locate, 'part', 'assert', { targets: [slot] })],
    } },
    { human: suggestion, plan: {
      action: 'agree', target: 'figure_3', referent: 'figure_3', speech: adoption,
      humanSegments: [segment(suggestion, 'name', 'name_propose', { targets: [slot], name: alias })],
    } },
    { human: question + detail, plan: {
      action: 'accept', target: 'none', referent: 'figure_3', speech: confirmation,
      humanSegments: [
        segment(question, 'name', 'name_propose', { respondsToTurn: 4, antecedent, proposition: '呼び名の承認を求める' }),
        segment(detail, 'part', 'unknown', { segmentId: '2', targets: [slot], proposition: redactQuote ? detail : echo }),
      ],
    } },
  ];
}

const openingDetail = '環の縁に小さな膨らみがあります。';
const humanFeatures = [
  '丸い穴が一つあります。', '縁に短い切れ目があります。', '台は細い板状です。', '先端は丸くなっています。',
  '棒の部分にはくびれがあります。', '角が一つ欠けています。', '台に小さな窪みがあります。', '輪郭は一続きです。',
  '輪のふちには厚みがあります。', '曲線と直線が接しています。', '突起は二つあります。', '細い部分が途中で曲がっています。',
  '幅に差があります。', '二つの部分が重なって見えます。', '外周に平らな面があります。', '端には小さな段差があります。',
];
function featureTurns(slot: string, count: 15 | 16): Turn[] {
  const features = humanFeatures.slice(0, count);
  return [
    { human: '一つだけ図形の特徴を教えてください。', plan: {
      action: 'accept', target: 'figure_3', speech: openingDetail,
      aiSegments: [segment(openingDetail, 'part', 'assert', { targets: [slot] })],
    } },
    { human: features.join(''), plan: {
      action: 'accept', target: 'none', referent: 'figure_3', speech: '見えている特徴を聞き取りました。',
      humanSegments: features.map((quote, index) => segment(quote, 'part', 'assert', { targets: [slot], segmentId: String(index + 1) })),
    } },
  ];
}

const own = { ...OWN, ownImage: { ...OWN.ownImage, mimeType: 'image/png' as const } };
async function s4Turn(profile: Profile, label: Label, state: InterventionReplayTape['state'], events: PublicEvent[], plan: Plan, producer: Producer) {
  const material: ReplaySegment = { luna: [], jev: [], reobservations: [] };
  const sends: Send[] = [];
  const traces: JevTurnTrace[] = [];
  let lastLuna: ReplaySegment['luna'][number];
  let cut: { luna: number; jev: number } | undefined;
  function capture(provider: Send['provider'], phase: string, payload: object) {
    sends.push({ provider, phase, requestSha256: hash(payload), actualSendMeasured: true, sendIds: [sends.length + 1],
      ...(provider === 'luna' ? { messagesSha256: hash((payload as { messages: unknown }).messages) } : {}) });
  }
  const luna = producer.createChatClient({
    provider: 'cloudflare', purpose: profile.modelPolicy.purpose, baseUrl: 'https://synthetic.invalid/v1',
    apiKey: 'synthetic-05y-only', timeoutMs: profile.timeouts.lunaAttemptMs,
  }, async (_url, options) => {
    capture('luna', lastLuna.phase, JSON.parse(String(options?.body)));
    return Response.json({ model: lunaModel, choices: [{ message: { content: lastLuna.response.text } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 } });
  });
  const transport = {
    enabled: true, readKey, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    researchLimits: { maxDeadlineMs: 600000 },
    async fetchImpl(_url: string, options: RequestInit) {
      const request = JSON.parse(String(options.body)) as JevDecisionPayload;
      const keys = Object.keys(request.questions);
      const state = JSON.parse(request.state) as { aiSeq?: number };
      const phase = keys.includes('human_referent') ? 'human_referent' : keys.includes('draft_naming') ? 'draft_naming'
        : keys.includes('repair_issue') ? 'repair_prospect' : keys.includes('segment_0_support') ? 'ai_support'
          : keys.includes('segment_0_act') ? state.aiSeq === undefined ? 'local_function' : 'ai_function' : 'decision';
      capture('jev', phase, request);
      const response = choiceResponse(request, plan, material.jev.length + 1);
      material.jev.push(response);
      return Response.json(response);
    },
  };
  const native = producer.createJevDecisionClient(transport)!;
  const runtime = producer.createProfileDialogue(profile, {
    strategy: label, image: own.ownImage, anchors: [...own.ownAnchors],
    observer: {
      async observeAll() { return structuredClone(OLD.state.observationMemo); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: {
      async complete(messages: Parameters<typeof luna.complete>[0], options: { phase: string; timeoutMs?: number }) {
        const { phase } = options;
        assert.ok(['local_extraction', 'ai_extraction', 'generation'].includes(phase));
        const text = phase === 'local_extraction' ? extraction(plan.humanSegments)
          : phase === 'ai_extraction' ? extraction(plan.aiSegments) : plan.speech;
        lastLuna = { phase, response: { text, model: lunaModel, usage: { inputTokens: 0, outputTokens: 0 } } };
        material.luna.push(lastLuna);
        return luna.complete(messages, options);
      },
    },
    jevDecision: {
      ...native,
      // These plans deliberately omit a referent estimate on the opening question.
      ...(plan.referent ? {} : { estimateReferent: undefined }),
      async decide(...args: Parameters<typeof native.decide>) {
        const decision = await native.decide(...args);
        cut = { luna: material.luna.length, jev: material.jev.length };
        return decision;
      },
    },
    localGrounding: {
      classifier: producer.createJevLocalTestClassifier({
        ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy,
      })!,
      aiPublicTransport: transport,
    },
    onJevTurnTrace: trace => traces.push(structuredClone(trace)),
  });
  const last = events.at(-1)!;
  const result = await runtime.runAiTurn({ events, privateState: state, lastEventId: last.id, requestSeq: last.seq });
  const trace = traces.at(-1)!;
  assert.ok(cut && trace);
  assert.equal(result.text, plan.speech);
  assert.equal(trace.publicSpeech, result.text);
  assert.equal(trace.executed?.action, plan.action);
  const { luna: l, jev: j } = cut;
  return {
    common: { luna: material.luna.slice(0, l), jev: material.jev.slice(0, j), reobservations: [] },
    tail: { luna: material.luna.slice(l), jev: material.jev.slice(j), reobservations: [] }, sends,
    state: JSON.parse(JSON.stringify(result.privateState)) as InterventionReplayTape['state'],
    trace: { ...trace, status: 'committed' as const },
  };
}

async function makeRecords(label: Label, policy: Policy, turns: Turn[], producer: Producer = current): Promise<Records> {
  const records = structuredClone(normal);
  const trial = records.trials[0];
  const manifest = records.run.manifest;
  const profile = producer.researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, 'two_stage_v3', policy);
  const profileSha256 = hash(profile);
  for (const source of [records.run, records.summary, trial]) Object.assign(source, { profile, profileSha256 });
  trial.identity.profile = profileSha256;
  trial.label = manifest.trials[0].label = records.summary.runOrder[0].label = label;

  let state: InterventionReplayTape['state'] = structuredClone(OLD.state);
  const events: PublicEvent[] = [];
  function append(speaker: 'ai' | 'human', text: string) {
    const seq = events.length + 1;
    events.push({ id: speaker + '-' + seq, seq, speaker, text });
  }
  for (const turn of turns.slice(0, -1)) {
    append('human', turn.human);
    const result = await s4Turn(profile, label, state, events, turn.plan, producer);
    state = result.state;
    append('ai', result.trace.publicSpeech!);
  }

  const finalTurn = turns.at(-1)!;
  append('human', finalTurn.human);
  const repair = await s4Turn(profile, 'repair-first', state, events, finalTurn.plan, producer);
  const bypass = await s4Turn(profile, 'bypass-enabled', state, events, finalTurn.plan, producer);
  assert.deepEqual(repair.common, bypass.common);
  const selected = label === 'repair-first' ? repair : bypass;
  const tape: InterventionReplayTape = {
    schemaVersion: 'parity_intervention_replay_v1', state, events, common: repair.common,
    tails: { 'repair-first': repair.tail, 'bypass-enabled': bypass.tail },
    recorded: { label, expectedRequests: selected.sends },
  };
  const result = await producer.pairedInterventionReplay(tape, own, MODEL, profile);
  assert.equal(result.status, 'same_material_intervention_verified', String(result.error));

  const trace = selected.trace;
  const turn = trace.turnIndex;
  trial.calls = selected.sends.map((send, index) => ({
    ...structuredClone(normal.trials[0].calls.find((call: { provider: string }) => call.provider === send.provider)),
    id: index + 1, sendIds: send.sendIds, phase: send.phase, turn,
    requestSha256: send.messagesSha256 ?? send.requestSha256,
    ...(send.provider === 'luna' ? { expectedHttpRequestSha256: send.requestSha256, httpRequestSha256: send.requestSha256 } : {}),
  }));
  trial.http = selected.sends.flatMap((send, index) => send.provider === 'luna' ? [{
    method: 'POST', kind: 'completion_post', phase: send.phase, callId: index + 1, sendId: index + 1,
    hashScheme: 'canonical_json_sha256', requestSha256: send.requestSha256, status: 200, outcome: 'returned',
  }] : []);
  trial.attempts = [trace];
  trial.turns = [{ ...trial.turns[0], turn, publicText: trace.publicSpeech, trace: [trace], state: selected.state }];
  trial.lastCommittedState = selected.state;
  trial.replay = [{ tape, result }];
  records.evidence.pairedReplay = [{ trialOrder: 0, turn, left: result.sides[0], right: result.sides[1] }];
  return JSON.parse(JSON.stringify(records));
}

function s4Statuses(records: Records) {
  const before = hash(records);
  const checks = interventionChecks(records);
  assert.equal(hash(records), before);
  return Object.fromEntries(['shape', 'binding', 'execution', 'replay'].map(kind => [
    kind, checks.find(check => check.id === 'intervention.trial.0.attempt.0.' + kind)?.status,
  ]));
}

const allPass = { shape: 'pass', binding: 'pass', execution: 'pass', replay: 'pass' };
const slot = own.ownAnchors[3].id;
const antecedents = [
  { choice: 'claim_1', speaker: 'human', act: 'name_propose', sourceTurn: 3 },
  { choice: 'claim_2', speaker: 'ai', act: 'name_accept', sourceTurn: 4 },
] as const;
type Antecedent = typeof antecedents[number];

function instructionExcerpt(producer: Producer) {
  return producer.MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC.split(/\r?\n/u)[0];
}

function assertRedactedSummary(records: Records, antecedent: Antecedent, reconfirmed: boolean) {
  const trial = records.trials[0];
  const trace: JevTurnTrace = trial.attempts[0];
  const local = trace.local;
  assert.ok(local);
  assert.equal(trace.namingReconfirm, reconfirmed ? true : undefined);
  assert.equal(trace.namingRequest, undefined);
  assert.equal(trace.executed?.action, 'accept');
  assert.equal(trace.publicSpeech, confirmation);
  assert.deepEqual(local.claims.map(claim => [claim.act, claim.name]), reconfirmed ? [['name_propose', alias]] : []);
  assert.ok(local.verification.rejected.some(entry => entry.reason === 'unknown_act'));
  const [request, observation] = local.extractor.segments;
  assert.equal(local.extractor.segments.length, 2);
  assert.equal(request.quote, approval);
  assert.equal(request.name, null);
  assert.equal(request.respondsToTurn, 4);
  assert.notEqual(request.redacted, true);
  assert.equal(observation.quote, detail);
  assert.equal(observation.proposition, '[redacted]');
  assert.equal(observation.redacted, true);

  const { tape, result } = trial.replay[0];
  assert.deepEqual(tape.events.at(-1), { speaker: 'human', seq: 5, id: 'human-5', text: approval + detail });
  const sent = result.sides[0].requests.find((request: { phase: string }) => request.phase === 'local_function');
  assert.ok(sent);
  const state = JSON.parse((sent.payload as JevDecisionPayload).state);
  const offered = state.priorClaims[Number(antecedent.choice.slice('claim_'.length))];
  assert.deepEqual(
    { speaker: offered.speaker, act: offered.act, name: offered.name, sourceTurn: offered.sourceTurn },
    { speaker: antecedent.speaker, act: antecedent.act, name: alias, sourceTurn: antecedent.sourceTurn },
  );
  assert.ok(tape.common.jev.some((response: { answers?: { segment_0_antecedent?: { choice: string } } }) =>
    response.answers?.segment_0_antecedent?.choice === antecedent.choice));
}

for (const label of strategies) {
  for (const policy of policies) {
    for (const antecedent of antecedents) {
      test('1 ' + label + ' ' + policy + ' checks a readable approval with a redacted feature summary (' + antecedent.speaker + ' antecedent)', async () => {
        const records = await makeRecords(label, policy, approvalTurns(slot, antecedent.choice, instructionExcerpt(current)));
        assertRedactedSummary(records, antecedent, policy === 'holistic_v4');
        assert.deepEqual(s4Statuses(records), allPass);
      });
    }
  }

  test('1 ' + label + ' does not verify when the approval quote itself is redacted', async () => {
    // The public utterance is synthetic. The ordinary projector removes the
    // selected quote from the extractor and claim evidence that S4 verifies.
    const records = await makeRecords(label, 'holistic_v4', approvalTurns(slot, 'claim_1', instructionExcerpt(current), true));
    const trace: JevTurnTrace = records.trials[0].attempts[0];
    const local = trace.local;
    assert.ok(local);
    assert.equal(trace.namingReconfirm, true);
    assert.equal(local.extractor.segments[0].quote, '[redacted]');
    assert.equal(local.extractor.segments[0].redacted, true);
    assert.equal(local.claims[0].quote, '[redacted]');
    assert.equal(local.claims[0].name, alias);
    assert.equal(local.extractor.segments[1].quote, detail);
    assert.notEqual(local.extractor.segments[1].redacted, true);
    const statuses = s4Statuses(records);
    assert.equal(statuses.shape, 'pass');
    assert.equal(statuses.binding, 'pass');
    assert.ok(statuses.replay === 'mismatch' || statuses.replay === 'not_reached', JSON.stringify(statuses));
  });
}

const git = promisify(execFile);
const oldRevision = 'eca0e6af76affd79217c996141f1733d4d217bd8';
async function loadArchivedProducer(t: TestContext): Promise<Producer | undefined> {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  try {
    await git('git', ['cat-file', '-e', oldRevision + '^{commit}'], { cwd });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) {
      t.skip('historical Git object is unavailable in this checkout');
      return;
    }
    throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), '05y-archived-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'source.tar');
  await git('git', ['archive', '--output=' + archive, oldRevision,
    'package.json', 'dialogue-model/runtime', 'workers/research-ai-proxy/src'], { cwd });
  await git('tar', ['-xf', archive, '-C', directory]);
  const load = (path: string) => import(pathToFileURL(join(directory, 'dialogue-model/runtime', path)).href);
  const [client, decision, classifier, runtime, profile, replay, extractor] = await Promise.all([
    load('client.mjs'), load('decision/jev-decision.ts'), load('local-grounding/jev-local-test.ts'),
    load('diagnostics/parity-live/replay.ts'), load('v2/research-profile.ts'),
    load('diagnostics/parity-live/intervention-replay.ts'), load('local-grounding/extract.ts'),
  ]);
  return {
    createChatClient: client.createChatClient,
    createJevDecisionClient: decision.createJevDecisionClient,
    createJevLocalTestClassifier: classifier.createJevLocalTestClassifier,
    createProfileDialogue: runtime.createProfileDialogue,
    researchTrialProfileV3: profile.researchTrialProfileV3,
    pairedInterventionReplay: replay.pairedInterventionReplay,
    MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC: extractor.MEMO_LOCAL_EXTRACTION_INSTRUCTIONS_HOLISTIC,
  };
}

test('1 S4 rejects genuine eca0e6a approval records even when an unrelated summary is redacted', async t => {
  const archived = await loadArchivedProducer(t);
  if (!archived) return;
  for (const label of strategies) {
    for (const antecedent of antecedents) {
      await t.test(label + ' with ' + antecedent.speaker + ' antecedent', async () => {
        const turns = approvalTurns(slot, antecedent.choice, instructionExcerpt(archived));
        const records = await makeRecords(label, 'holistic_v3', turns, archived);
        assertRedactedSummary(records, antecedent, true);
        const before = hash(records);
        const trial = records.trials[0];
        assert.equal(trial.profile.dialoguePolicy, 'holistic_v3');
        const { tape } = trial.replay[0];
        const replay = await pairedInterventionReplay(tape, own, MODEL, trial.profile);
        assert.equal(replay.status, 'same_material_intervention_mismatch');
        const statuses = s4Statuses(records);
        assert.equal(hash(records), before);
        assert.equal(statuses.replay, 'mismatch', JSON.stringify(statuses));
      });
    }
  }
});

for (const label of strategies) {
  for (const policy of policies) {
    for (const count of [15, 16] as const) {
      test('2 ' + label + ' ' + policy + ' replays one AI claim with ' + count + ' human segments', async () => {
        const records = await makeRecords(label, policy, featureTurns(slot, count));
        const trial = records.trials[0];
        const { tape, result } = trial.replay[0];
        const trace: JevTurnTrace = trial.attempts[0];
        const application = trace.aiPublic?.application;
        const local = trace.local;
        assert.ok(local && application);
        assert.equal(result.status, 'same_material_intervention_verified');
        assert.equal(application.aiSeq, 2);
        assert.equal(application.status, 'applied');
        assert.equal(application.claims.length, 1);
        assert.equal(application.claims[0].sourceTurn, 2);
        assert.equal(tape.state.aiPublic?.pending.candidates.length, 1);
        assert.deepEqual(tape.state.graph.records, []);
        assert.deepEqual(local.extractor.segments.map(item => item.quote), humanFeatures.slice(0, count));
        assert.deepEqual(local.claims.map(claim => claim.quote), humanFeatures.slice(0, 15));
        assert.deepEqual(local.verification.rejected.map(entry => entry.reason), count === 16 ? ['memory_invalid_update'] : []);
        assert.deepEqual(trial.lastCommittedState.graph.records.map((record: { id: string }) => record.id),
          [application.claims[0].id, ...local.claims.map(claim => claim.id)]);
        assert.deepEqual(s4Statuses(records), allPass);
      });
    }
  }
}
