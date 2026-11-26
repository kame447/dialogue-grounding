// Independent 05x acceptance. Dialogue, observations and all upstream replies are synthetic.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { interventionForStrategy } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import type { InterventionReplayTape, ReplaySegment } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createObservationCache } from '../dialogue-model/runtime/observation/cache.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchHash, researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { prepareParticipantJev } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { bindCurrentS4PromptSources, MODEL, normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { buildRecords, Label, Plan, Turn } from './support/s4-v3-records.ts';

type Policy = 'holistic_v3' | 'holistic_v4';
type Profile = ReturnType<typeof researchTrialProfileV3>;
type Records = Awaited<ReturnType<typeof buildRecords>>;
type Send = InterventionReplayTape['recorded']['expectedRequests'][number];
type ReplaySide = Awaited<ReturnType<typeof pairedInterventionReplay>>['sides'][number];
type PublicEvent = InterventionReplayTape['events'][number];
const strategies = ['repair-first', 'bypass-enabled'] as const;
const policies = ['holistic_v3', 'holistic_v4'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const alias = '輪つぎ札';
const feature = '台に小さな輪がつながる';
const locate = '小さな輪が台についている形ですか？';
const suggestion = 'この台に輪が付いた形を「' + alias + '」と呼びませんか？';
const adoption = 'はい、この形を「' + alias + '」と呼びましょう。';
const approval = 'その呼び名でいい？';
const confirmation = 'うん、いいよ。';
const receipt = '呼び名の候補を聞きました。';
const readKey = async () => 'sk-or-synthetic-05x-offline-key-000000';
const lunaModel = 'synthetic-luna-model';

function extraction(quote: string, aspect: LocalSegmentProposal['aspect'], targets: string[] = [],
    name: string | null = null, respondsToTurn: number | null = null) {
  return JSON.stringify([{
    segmentId: '1', quote, proposition: quote, aspect, targets, name, respondsToTurn, linkedIssueId: null,
  } satisfies LocalSegmentProposal]);
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
    if (key.endsWith('_act')) choice = state.aiSeq === undefined ? plan.act : 'assert';
    if (key.endsWith('_antecedent')) choice = state.aiSeq === undefined ? plan.antecedent ?? 'none' : 'none';
    if (key.endsWith('_support')) choice = 'expressed';
    assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
    return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
      labels.map(label => [label, Number(label === choice)]),
    ) }];
  }));
  return { model: request.model, id: 'gen-05x-' + responseNo, usage: { cost: 0 }, answers };
}

function approvalTurns(slot: string, antecedent: 'claim_1' | 'claim_2'): Turn[] {
  return [
    { human: 'どの形を探しているか照らし合わせたいです。', plan: {
      action: 'confirm', target: 'figure_3', speech: locate, aiExtraction: extraction(locate, 'part', [slot]),
    } },
    { human: suggestion, plan: {
      action: 'agree', target: 'figure_3', name: alias, act: 'name_propose', referent: 'figure_3', speech: adoption,
      extraction: extraction(suggestion, 'name', [slot], alias),
    } },
    { human: approval, plan: {
      action: 'accept', target: 'none', referent: 'figure_3', act: 'name_propose', antecedent, speech: confirmation,
      extraction: extraction(approval, 'name', [], null, 4),
    } },
  ];
}

const own = { ...OWN, ownImage: { ...OWN.ownImage, mimeType: 'image/png' as const } };
async function s4Turn(profile: Profile, label: Label, state: InterventionReplayTape['state'], events: PublicEvent[], plan: Plan) {
  const material: ReplaySegment = { luna: [], jev: [], reobservations: [] };
  const sends: Send[] = [];
  const traces: JevTurnTrace[] = [];
  let lastLuna: ReplaySegment['luna'][number];
  let cut: { luna: number; jev: number } | undefined;
  function capture(provider: Send['provider'], phase: string, payload: object) {
    sends.push({ provider, phase, requestSha256: hash(payload), actualSendMeasured: true, sendIds: [sends.length + 1],
      ...(provider === 'luna' ? { messagesSha256: hash((payload as { messages: unknown }).messages) } : {}) });
  }
  const luna = createChatClient({
    provider: 'cloudflare', purpose: profile.modelPolicy.purpose, baseUrl: 'https://synthetic.invalid/v1',
    apiKey: 'synthetic-05x-only', timeoutMs: profile.timeouts.lunaAttemptMs,
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
  const native = createJevDecisionClient(transport)!;
  const runtime = createProfileDialogue(profile, {
    strategy: label, image: own.ownImage, anchors: [...own.ownAnchors],
    observer: {
      async observeAll() { return structuredClone(OLD.state.observationMemo); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: {
      async complete(messages: Parameters<typeof luna.complete>[0], options: { phase: string; timeoutMs?: number }) {
        const { phase } = options;
        assert.ok(['local_extraction', 'ai_extraction', 'generation'].includes(phase));
        const text = phase === 'local_extraction' ? plan.extraction ?? '[]'
          : phase === 'ai_extraction' ? plan.aiExtraction ?? '[]' : plan.speech!;
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
      classifier: createJevLocalTestClassifier({
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

async function currentRecords(label: Label, policy: Policy, turns: Turn[]): Promise<Records> {
  const records = structuredClone(normal);
  await bindCurrentS4PromptSources(records);
  const trial = records.trials[0];
  const manifest = records.run.manifest;
  const profile = researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, 'two_stage_v3', policy);
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
    const result = await s4Turn(profile, label, state, events, turn.plan);
    state = result.state;
    append('ai', result.trace.publicSpeech!);
  }

  const finalTurn = turns.at(-1)!;
  append('human', finalTurn.human);
  const repair = await s4Turn(profile, 'repair-first', state, events, finalTurn.plan);
  const bypass = await s4Turn(profile, 'bypass-enabled', state, events, finalTurn.plan);
  assert.deepEqual(repair.common, bypass.common);
  const selected = label === 'repair-first' ? repair : bypass;
  const tape: InterventionReplayTape = {
    schemaVersion: 'parity_intervention_replay_v1', state, events, common: repair.common,
    tails: { 'repair-first': repair.tail, 'bypass-enabled': bypass.tail },
    recorded: { label, expectedRequests: selected.sends },
  };
  const result = await pairedInterventionReplay(tape, own, MODEL, profile);
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
  const checks = interventionChecks(records);
  return Object.fromEntries(['shape', 'binding', 'execution', 'replay'].map(kind => [
    kind, checks.find(check => check.id === 'intervention.trial.0.attempt.0.' + kind)?.status,
  ]));
}

function relabel(records: Records, policy: Policy): Records {
  const trial = records.trials[0];
  const oldFingerprint = trial.profileSha256;
  const newFingerprint = hash({ ...trial.profile, dialoguePolicy: policy });
  function rewrite(value: unknown): unknown {
    if (typeof value === 'string') return value === oldFingerprint ? newFingerprint : value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== 'object') return value;
    const record = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    if (record.id === 'research_trial_profile_v3' && record.dialoguePolicy !== undefined) record.dialoguePolicy = policy;
    return record;
  }
  const relabelled = rewrite(records) as Records;
  const relabelledTrial = relabelled.trials[0];
  const storedReplay = relabelledTrial.replay[0];
  const { left, right } = relabelled.evidence.pairedReplay[0];
  for (const side of [...storedReplay.result.sides, left, right]) side.materialSha256 = hash(side.material);
  const originalReplay = trial.replay[0];
  assert.equal(relabelledTrial.profile.dialoguePolicy, policy);
  assert.equal(relabelledTrial.profileSha256, newFingerprint);
  assert.deepEqual(relabelledTrial.calls, trial.calls);
  assert.deepEqual(relabelledTrial.http, trial.http);
  assert.deepEqual(relabelledTrial.attempts, trial.attempts);
  assert.deepEqual(storedReplay.tape, originalReplay.tape, 'keep the actual tape and captured send fingerprints');
  assert.deepEqual(storedReplay.result.sides.map((side: ReplaySide) => side.requests),
    originalReplay.result.sides.map((side: ReplaySide) => side.requests));
  return relabelled;
}

const antecedents = [
  { key: 'claim_1', speaker: 'human', act: 'name_propose', sourceTurn: 3 },
  { key: 'claim_2', speaker: 'ai', act: 'name_accept', sourceTurn: 4 },
] as const;
type Antecedent = typeof antecedents[number];
function assertApprovalRecord(records: Records, antecedent: Antecedent, reconfirmed: boolean) {
  const trial = records.trials[0];
  const { tape, result } = trial.replay[0];
  assert.deepEqual(tape.events.slice(-2).map((event: PublicEvent) => [event.seq, event.speaker, event.text]),
    [[4, 'ai', adoption], [5, 'human', approval]]);
  const speech = trial.attempts[0];
  assert.equal(speech.executed.action, 'accept');
  assert.equal(speech.publicSpeech, confirmation);
  assert.equal(speech.namingRequest, undefined);
  assert.equal(speech.namingReconfirm, reconfirmed ? true : undefined);

  const local = result.sides[0].requests.find((request: ReplaySide['requests'][number]) => request.phase === 'local_function');
  assert.ok(local);
  const state = JSON.parse((local.payload as JevDecisionPayload).state);
  const proposal = state.segments[0];
  assert.equal(proposal.aspect, 'name');
  assert.equal(proposal.name, null);
  assert.equal(proposal.respondsToTurn, 4);
  const source = state.priorClaims[Number(antecedent.key.slice('claim_'.length))];
  assert.equal(source.speaker, antecedent.speaker);
  assert.equal(source.act, antecedent.act);
  assert.equal(source.name, alias);
  assert.equal(source.sourceTurn, antecedent.sourceTurn);
  assert.ok(tape.common.jev.some((response: { answers?: { segment_0_antecedent?: { choice: string } } }) =>
    response.answers?.segment_0_antecedent?.choice === antecedent.key));
}

async function rejectsCrossVersionReplay(records: Records, { input = own, model = MODEL, allowPipelineFailure = false } = {}) {
  const { replay: [{ tape }], profile } = records.trials[0];
  const before = hash(records);
  const dynamic = await pairedInterventionReplay(tape, input, model, profile);
  if (allowPipelineFailure && dynamic.status === 'not_reached') {
    assert.equal(dynamic.error, 'replay_pipeline_failed');
  } else {
    assert.equal(dynamic.status, 'same_material_intervention_mismatch');
  }
  const statuses = s4Statuses(records);
  assert.equal(hash(records), before, 'checking a record cannot change it');
  assert.equal(statuses.replay, 'mismatch', JSON.stringify(statuses));
}

for (const label of strategies) {
  for (const policy of policies) {
    for (const antecedent of antecedents) {
      test('1 ' + label + ' ' + policy + ' with ' + antecedent.speaker + ' antecedent', async t => {
        const records = await currentRecords(label, policy, approvalTurns(own.ownAnchors[3].id, antecedent.key));
        assertApprovalRecord(records, antecedent, policy === 'holistic_v4');
        await t.test('the original record passes all four S4 checks', () => {
          assert.deepEqual(s4Statuses(records), { shape: 'pass', binding: 'pass', execution: 'pass', replay: 'pass' });
        });
        await t.test('S4 rejects relabelling with the other policy and its matching fingerprint', async () => {
          const toV4 = policy === 'holistic_v3';
          // The earlier state can contain an accept score that v4 rejects before replay.
          await rejectsCrossVersionReplay(relabel(records, toV4 ? 'holistic_v4' : 'holistic_v3'), { allowPipelineFailure: toV4 });
        });
      });
    }
  }
}

const git = promisify(execFile);
const archivedRevision = 'eca0e6af76affd79217c996141f1733d4d217bd8';
test('1 S4 rejects records genuinely produced by eca0e6a under different v3 approval rules', async t => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  try {
    await git('git', ['cat-file', '-e', archivedRevision + '^{commit}'], { cwd });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) {
      t.skip('historical Git object is unavailable in this checkout');
      return;
    }
    throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), '05x-archived-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'source.tar');
  await git('git', ['archive', '--output=' + archive, archivedRevision, 'package.json', 'dialogue-model/runtime',
    'workers/research-ai-proxy/src', 'tests/support/s4-v3-records.ts', 'tests/support/s4-integration'], { cwd });
  await git('tar', ['-xf', archive, '-C', directory]);
  const old = await import(pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href) as {
    buildRecords: typeof buildRecords; OWN: typeof OWN; MODEL: typeof MODEL;
  };
  assert.equal(old.OWN.ownImage.mimeType, 'image/png');
  const oldOwn = { ...old.OWN, ownImage: { ...old.OWN.ownImage, mimeType: 'image/png' as const } };
  for (const label of strategies) {
    for (const antecedent of antecedents) {
      await t.test(label + ' with ' + antecedent.speaker + ' antecedent', async () => {
        const records = await old.buildRecords({
          label, dialoguePolicy: 'holistic_v3', turns: approvalTurns(oldOwn.ownAnchors[3].id, antecedent.key),
        });
        assert.equal(records.trials[0].profile.dialoguePolicy, 'holistic_v3');
        assert.equal(records.trials[0].replay[0].result.status, 'same_material_intervention_verified');
        assertApprovalRecord(records, antecedent, true);
        await rejectsCrossVersionReplay(records, { input: oldOwn, model: old.MODEL });
      });
    }
  }
});

const seed = 589;
const scene = createTrialV2({ seed });
const view = modelView(scene);
const figureIds = view.anchors.map((item: { id: string }) => item.id);
const [first] = figureIds;
const lunaRequest = { timeoutMs: null, maxCompletionTokens: 1000 };
const timeouts = {
  observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000,
};
const participantProfile = (policy: Policy) => researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', policy);
type Saved = {
  options: { dialoguePolicy?: Policy; profileSha256: string };
  queueState: { privateState: JevPrivateState };
  ownLedger: JevPrivateState['ledger'];
  jevTraces: JevTurnTrace[];
  events: PublicEvent[];
};
async function participant(t: TestContext, label: Label) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), '05x-participant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDirectory = join(directory, 'cache');
  await mkdir(cacheDirectory, { mode: 0o700 });
  const cache = await createObservationCache({
    directory: cacheDirectory, modelId: lunaModel, onMiss: 'observe',
    client: { async complete() {
      return { model: lunaModel, text: JSON.stringify({ figures: figureIds.map((id: string) => ({
        id, holistic: [], analytic: { shapes: [feature], composition: '台に輪が接する', relations: [] }, unknowns: [],
      })) }) };
    } },
  });
  const { memo } = await cache.get({
    ownImage: { mimeType: view.mimeType, base64: view.png.toString('base64') }, ownAnchors: view.anchors,
  });
  const configFile = join(directory, 'config.json');
  const baseAssignmentFile = join(directory, 'assignment.json');
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 'participant_jev_config_v1', seed, cacheDirectory, modelId: lunaModel, memoSha256: researchHash(memo),
    questionLayout: 'two_stage_v3', technicalTrial, lunaRequest, timeouts,
    limits: { lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 0.05 },
  }), { mode: 0o600 });
  await writeFile(baseAssignmentFile, JSON.stringify({
    schemaVersion: 'base_assignment_config_v1', configId: '71264ee0-87fb-4337-8817-c36cb6055299',
    revision: 1, strategy: label, seed, referenceMemory: true,
  }), { mode: 0o600 });

  let plan: Plan;
  let responseNo = 0;
  const fetchImpl: NonNullable<Parameters<typeof prepareParticipantJev>[0]['fetchImpl']> = async (_url, options) => {
    if (options?.method === 'GET') return Response.json({ ready: true, purpose: 'dialogue_turn', provider: 'openai', model: lunaModel });
    const body = JSON.parse(String(options?.body));
    if (body.questions) return Response.json(choiceResponse(body, plan, ++responseNo));
    const content = body.messages[1]?.content;
    const state = typeof content === 'string' && content.startsWith('{') ? JSON.parse(content) : {};
    const text = state.candidateText ? '[]' : state.publicTurns ? plan.extraction ?? '[]' : plan.speech!;
    return Response.json({ model: lunaModel, choices: [{ message: { content: text } }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
  };
  const prepared = await prepareParticipantJev({
    configFile, baseAssignmentFile,
    clientConfig: { provider: 'cloudflare', purpose: 'dialogue_turn', baseUrl: 'https://synthetic.invalid/v1', apiKey: '05x-offline-only' },
    readKey, fetchImpl,
  });
  return async function open({ policy, restore }: { policy?: Policy; restore?: Saved } = {}) {
    const options = { seed, strategy: label, referenceMemory: true, restore };
    const wiring = await prepared.taskOptions(options);
    assert.ok(wiring.jevResearch);
    const profile = participantProfile(policy ?? 'holistic_v4');
    // The explicit version is for new fixture records only. Restores always go through the current participant wiring.
    const jevResearch = policy === undefined ? wiring.jevResearch : {
      ...wiring.jevResearch, profile,
      localGrounding: {
        ...wiring.jevResearch.localGrounding,
        classifier: createJevLocalTestClassifier({
          enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.localMs,
          questionLayout: profile.questionLayout, dialoguePolicy: profile.dialoguePolicy,
        })!,
      },
    };
    let saved: Saved | undefined;
    const task = await createNamingTaskV2({
      ...options, ...wiring, jevResearch, runDir: null, createTrial: () => scene,
      onPersist(record: unknown) { saved = structuredClone(record) as Saved; },
    });
    function record() {
      assert.ok(saved);
      return saved;
    }
    return {
      record,
      async say(turn: Turn) {
        plan = turn.plan;
        const { eventId } = task.message(turn.human, 'offline-05x-' + task.getState().events.length);
        await task.whenIdle();
        const trace = record().jevTraces.at(-1);
        assert.ok(trace);
        assert.equal(trace.status, 'committed', trace.errorCode ?? 'turn must commit');
        assert.equal(trace.lastEventId, eventId);
        assert.equal(trace.executed?.action, plan.action);
        assert.equal(trace.publicSpeech, plan.speech);
        assert.equal(task.getState().events.at(-1)?.text, plan.speech);
        assert.equal(task.getState().aiStatus, 'idle');
        return record();
      },
    };
  };
}

function propose(action: 'accept' | 'agree'): Turn {
  return { human: suggestion, plan: {
    action, target: action === 'agree' ? 'figure_0' : 'none', name: alias,
    referent: 'figure_0', act: 'name_propose', speech: action === 'agree' ? adoption : receipt,
    extraction: extraction(suggestion, 'name', [first], alias),
  } };
}
function validate(saved: Saved, label: Label, policy: Policy) {
  return validateJevPrivateStateV2(saved.queueState.privateState, figureIds, interventionForStrategy(label), 'two_stage_v3', policy);
}
function assertRestored(source: Saved, restored: Saved, policy: Policy) {
  assert.equal(restored.options.dialoguePolicy, policy);
  assert.equal(restored.options.profileSha256, researchHash(participantProfile(policy)));
  assert.deepEqual(restored.queueState.privateState, source.queueState.privateState);
  assert.deepEqual(restored.ownLedger, source.ownLedger);
  assert.deepEqual(restored.jevTraces, source.jevTraces);
  assert.deepEqual(restored.events, source.events);
}

for (const label of strategies) {
  for (const action of ['accept', 'agree'] as const) {
    test('2 ' + label + ' v3 naming request with accept ' + (action === 'accept' ? 'executed' : 'only scored'), async t => {
      const open = await participant(t, label);
      const v3 = await open({ policy: 'holistic_v3' });
      const source = await v3.say(propose(action));
      const judgment = source.queueState.privateState.judgments.at(-1)!;
      assert.equal(judgment.jevTurn.namingRequest, true);
      assert.equal(judgment.jevTurn.executed?.action, action);
      const scores = judgment.jevTurn.decision.evidence!.stages![0].scores.action;
      assert.ok(Object.hasOwn(scores, 'accept') && Object.hasOwn(scores, 'agree'));
      const v4 = {
        ...structuredClone(source),
        options: { ...source.options, dialoguePolicy: 'holistic_v4' as const, profileSha256: researchHash(participantProfile('holistic_v4')) },
      };
      assert.deepEqual(v4.queueState, source.queueState);
      assert.deepEqual(v4.jevTraces, source.jevTraces);

      await t.test('the unchanged v3 record validates and restores', async () => {
        assert.deepEqual(validate(source, label, 'holistic_v3'), source.queueState.privateState);
        const restored = await open({ restore: source });
        assertRestored(source, restored.record(), 'holistic_v3');
      });
      await t.test('private-state validation rejects the same history under v4', () => {
        assert.throws(() => validate(v4, label, 'holistic_v4'), { code: 'invalid_state' });
      });
      await t.test('ordinary participant restore rejects v4 with the matching fingerprint', async () => {
        await assert.rejects(open({ restore: v4 }), { code: 'invalid_options' });
      });
    });
  }

  test('2 ' + label + ' v4 keeps accept valid for a naming reconfirmation', async t => {
    const open = await participant(t, label);
    const session = await open({ policy: 'holistic_v4' });
    const agreed = await session.say(propose('agree'));
    const human = 'この形は「' + alias + '」で大丈夫ですか？';
    const source = await session.say({ human, plan: {
      action: 'accept', target: 'none', referent: 'figure_0', act: 'name_propose', speech: confirmation,
      extraction: extraction(human, 'name', [first], alias),
    } });
    const trace = source.jevTraces.at(-1)!;
    assert.equal(trace.namingReconfirm, true);
    assert.equal(trace.namingRequest, undefined);
    assert.deepEqual(source.ownLedger, agreed.ownLedger);
    assert.deepEqual(validate(source, label, 'holistic_v4'), source.queueState.privateState);
    const restored = await open({ restore: source });
    assertRestored(source, restored.record(), 'holistic_v4');
  });
}
