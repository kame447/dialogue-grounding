// Independent acceptance for the versioned generation policy. All dialogue, observations and provider responses are synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import type { DraftAct } from '../dialogue-model/runtime/decision/contract.ts';
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
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { prepareParticipantJev } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { ResearchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { bindCurrentS4PromptSources, MODEL, normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const manifest = normal.run.manifest;
const makeProfile = (policy?: ResearchTrialProfileV3['dialoguePolicy']) =>
  researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, 'two_stage_v3', policy);
const newProfile = makeProfile();
const own = { ...OWN, ownImage: { ...OWN.ownImage, mimeType: 'image/png' as const } };
const [figure] = own.ownAnchors.map((anchor: { id: string }) => anchor.id);
const target = { kind: 'single', figureId: figure };
const original = '小さな風見';
const alternative = '青い羽根';
const agreedSpeech = 'では、この形を「' + original + '」と呼びましょう。';
const feature = '左側に丸い穴が一つある';
const safeDraft = '丸い穴が一つある形ですか？';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const modelId = 'synthetic-luna-model';

type Draft = { text: string; choice?: DraftAct };
type Turn = {
  human: string;
  action: 'agree' | 'confirm';
  name?: string;
  publicReferent?: string;
  drafts: readonly Draft[];
};
type Event = InterventionReplayTape['events'][number];
type Send = InterventionReplayTape['recorded']['expectedRequests'][number];

function namingProposal(name: string, action: 'agree' | 'confirm', drafts: readonly Draft[]): Turn {
  return { human: 'こちらでは「' + feature + '」形を「' + name + '」と呼びませんか？', action, name, drafts };
}
function extraction(turn: Turn) {
  const segments: LocalSegmentProposal[] = [];
  if (turn.publicReferent) segments.push({
    segmentId: '1', quote: turn.publicReferent, proposition: turn.publicReferent, aspect: 'referent',
    targets: [figure], name: null, linkedIssueId: null, respondsToTurn: null,
  });
  if (turn.name !== undefined) {
    const quote = turn.human.slice(turn.publicReferent?.length ?? 0);
    segments.push({
      segmentId: String(segments.length + 1), quote, proposition: quote, aspect: 'name',
      targets: [figure], name: turn.name, linkedIssueId: null, respondsToTurn: null,
    });
  }
  return JSON.stringify(segments);
}

function session(label: Label, profile: ResearchTrialProfileV3) {
  let current: Turn;
  let lastLuna: ReplaySegment['luna'][number];
  let material: ReplaySegment;
  let sends: Send[];
  let jevRequests: JevDecisionPayload[];
  let rawSends: string[];
  let generationInstructions: string[][];
  let trace: JevTurnTrace;
  let rendered: string[];
  let cut: { luna: number; jev: number };
  let responseNo = 0;
  let state: InterventionReplayTape['state'] = structuredClone(OLD.state);
  const memo = state.observationMemo!;
  const observed = memo.figures.find(figureMemo => figureMemo.id === figure)!;
  observed.analytic.shapes = [feature];
  const events: Event[] = [];
  function append(speaker: 'human' | 'ai', text: string) {
    const seq = events.length + 1;
    const event = { id: speaker + '-' + seq, seq, speaker, text };
    events.push(event);
    return event;
  }
  function recordSend(provider: Send['provider'], phase: string, raw: string) {
    rawSends.push(sha256(raw));
    const body = JSON.parse(raw);
    sends.push({ provider, phase, actualSendMeasured: true, sendIds: [sends.length + 1], requestSha256: hash(body),
      ...(provider === 'luna' ? { messagesSha256: hash((body as { messages: unknown }).messages) } : {}) });
  }
  const luna = createChatClient({
    provider: 'cloudflare', purpose: profile.modelPolicy.purpose, baseUrl: 'https://offline.invalid/v1',
    apiKey: 'synthetic-offline-generation', timeoutMs: profile.timeouts.lunaAttemptMs,
    maxCompletionTokens: profile.lunaRequest.maxCompletionTokens ?? undefined,
  }, async (_url, options) => {
    recordSend('luna', lastLuna.phase, String(options?.body));
    return Response.json({ model: modelId, choices: [{ message: { content: lastLuna.response.text } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 } });
  });
  const transport = {
    enabled: true, readKey: async () => 'sk-or-synthetic-offline-generation-0000',
    questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    researchLimits: { maxDeadlineMs: 600000 },
    async fetchImpl(_url: string, options: RequestInit) {
      const request = JSON.parse(String(options.body)) as JevDecisionPayload;
      jevRequests.push(request);
      const keys = Object.keys(request.questions);
      const phase = keys.includes('human_referent') ? 'human_referent' : keys.includes('repair_issue') ? 'repair_prospect'
        : keys.includes('draft_naming') ? 'draft_naming' : keys.includes('segment_0_act') ? 'local_function' : 'decision';
      recordSend('jev', phase, String(options.body));
      const answers = Object.fromEntries(Object.entries(request.questions).map(([key, { criteria }]) => {
        const labels = Object.keys(criteria);
        let choice;
        if (key === 'action') choice = current.action;
        if (key === 'target') choice = 'figure_0';
        if (key === 'human_referent') choice = 'figure_0';
        if (key === 'repair_issue' || key === 'basis' || /^segment_\d+_antecedent$/u.test(key)) choice = 'none';
        if (key === 'prospect') choice = 'no_open_issue';
        if (/^segment_\d+_answer$/u.test(key)) choice = 'unknown';
        if (/^segment_\d+_act$/u.test(key)) {
          choice = current.publicReferent && key === 'segment_0_act' ? 'assert' : 'name_propose';
        }
        if (key === 'feature') choice = labels.find(label => JSON.parse(criteria[label]).value === feature);
        if (key === 'name') choice = labels.find(label => JSON.parse(criteria[label]).value === current.name);
        if (key === 'draft_naming') {
          const draft = current.drafts[rendered.length - 1];
          assert.ok(draft);
          assert.equal(JSON.parse(request.state).draft, draft.text);
          choice = draft.choice ?? 'none';
        }
        assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
        return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
          labels.map(label => [label, Number(label === choice)]),
        ) }];
      }));
      const response = { model: request.model, id: 'gen-root-cause-' + ++responseNo, usage: { cost: 0 }, answers };
      material.jev.push(response);
      return Response.json(response);
    },
  };
  const native = createJevDecisionClient(transport)!;
  const runtime = createProfileDialogue(profile, {
    strategy: label, technicalTrial, image: own.ownImage, anchors: [...own.ownAnchors],
    observer: {
      async observeAll() { return structuredClone(OLD.state.observationMemo); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: {
      async complete(messages: Parameters<typeof luna.complete>[0], options: { phase: string; timeoutMs?: number }) {
        const { phase } = options;
        let text: string;
        if (phase === 'local_extraction') text = extraction(current);
        else if (phase === 'ai_extraction') text = '[]';
        else {
          assert.equal(phase, 'generation');
          const draft = current.drafts[rendered.length];
          assert.ok(draft, 'only the scripted drafts may be requested');
          text = draft.text;
          rendered.push(text);
          generationInstructions.push(messages.flatMap(message =>
            'role' in message && message.role === 'system' && 'content' in message &&
              typeof message.content === 'string' ? [message.content] : []));
        }
        lastLuna = { phase, response: { text, model: modelId, usage: { inputTokens: 0, outputTokens: 0 } } };
        material.luna.push(lastLuna);
        return luna.complete(messages, options);
      },
    },
    jevDecision: {
      ...native,
      async decide(...args: Parameters<typeof native.decide>) {
        const decision = await native.decide(...args);
        cut = { luna: material.luna.length, jev: material.jev.length };
        return decision;
      },
    },
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy })!,
      aiPublicTransport: transport,
    },
    onJevTurnTrace(record: JevTurnTrace) { trace = structuredClone(record); },
  });
  if (profile.dialoguePolicy === 'holistic_v5') {
    state = { ...runtime.initialPrivateState(), observationMemo: memo };
  }
  return {
    async say(turn: Turn) {
      current = turn;
      rendered = [];
      sends = [];
      jevRequests = [];
      rawSends = [];
      generationInstructions = [];
      material = { luna: [], jev: [], reobservations: [] };
      const before = state;
      const beforeHash = hash(before);
      const human = append('human', turn.human);
      const inputEvents = structuredClone(events);
      const outcome = await runtime.runAiTurn({ events, privateState: before, lastEventId: human.id, requestSeq: human.seq }).then(
        result => ({ result, error: null }), (error: unknown) => ({ result: null, error }),
      );
      assert.equal(hash(before), beforeHash, 'the caller state is unchanged until commit');
      assert.ok(trace! && cut!);
      assert.equal(trace!.lastEventId, human.id);
      const options = jevRequests.find(request => request.questions.action)?.questions.action.criteria;
      assert.ok(options, 'the native action question must be sent');
      if (outcome.result) {
        assert.equal(trace!.publicSpeech, outcome.result.text);
        state = JSON.parse(JSON.stringify(outcome.result.privateState)) as InterventionReplayTape['state'];
        append('ai', outcome.result.text);
      }
      return {
        ...outcome, trace: { ...trace!, ...(outcome.result ? { status: 'committed' as const } : {}) },
        before, state, inputEvents, events: structuredClone(events), options, rendered, sends, rawSends,
        generationInstructions, draftQuestions: jevRequests.filter(request => request.questions.draft_naming),
        common: { luna: material.luna.slice(0, cut!.luna), jev: material.jev.slice(0, cut!.jev), reobservations: [] },
        tail: { luna: material.luna.slice(cut!.luna), jev: material.jev.slice(cut!.jev), reobservations: [] },
      };
    },
  };
}

type Outcome = Awaited<ReturnType<ReturnType<typeof session>['say']>>;
const ownView = 'こちらの画面では左側に丸い穴が一つあります。同じ形でしょうか？';
const partnerQuestion = 'そちらの画面では丸い穴は右側に見えますか？';
const attributedQuote = '「' + feature + '」とおっしゃった形ですね。穴は一つだけですか？';
const sameOrientation = 'こちらの画面では左側に丸い穴があり、そちらの画面でも同じ左側にありますね。';
const unmarked = '左側に丸い穴が一つある形ですか？';
const quotedName = '「' + alternative + '」という呼び名を提案されたのですね。丸い穴が一つある形ですか？';
const newAdoption = 'では、その形を「' + alternative + '」と呼びましょう。';
const clean = (text: string): Draft => ({ text, choice: 'none' });
const quoteName: Draft = { text: quotedName, choice: 'recount_only' };

async function agreedSession(label: Label, profile: ResearchTrialProfileV3) {
  const trial = session(label, profile);
  const proposal = namingProposal(original, 'agree', [{ text: agreedSpeech, choice: 'adopt_chosen' }]);
  const publicReferent = '指しているのは、丸い穴が一つある方の形です。';
  const agreed = await trial.say(profile.dialoguePolicy === 'holistic_v5'
    ? { ...proposal, human: publicReferent + proposal.human, publicReferent } : proposal);
  assert.ifError(agreed.error);
  assert.equal(agreed.trace.executed?.action, 'agree');
  assert.equal(agreed.events.at(-1)?.text, agreedSpeech);
  assert.deepEqual(agreed.state.ledger[figure], { status: 'agreed', name: original });
  return { trial, agreed };
}

async function confirm(label: Label, profile: ResearchTrialProfileV3, drafts: readonly Draft[]) {
  const { trial, agreed } = await agreedSession(label, profile);
  const turn = await trial.say(namingProposal(alternative, 'confirm', drafts));
  assert.deepEqual(turn.before.ledger, agreed.state.ledger);
  assert.ok(Object.hasOwn(turn.options, 'confirm'));
  assert.ok(!Object.hasOwn(turn.options, 'agree'), 'another name cannot replace the agreed name');
  assert.equal(turn.trace.executed?.action, 'confirm');
  assert.deepEqual(turn.trace.executed?.target, target);
  assert.equal(turn.trace.executed?.name, null);
  assert.equal(turn.trace.executed?.feature, feature, 'keep the selected observation as evidence');
  assert.deepEqual(turn.state.ledger, turn.before.ledger);
  return { agreed, turn };
}

function checkPublished(turn: Outcome, speech: string, regenerated: boolean) {
  assert.ifError(turn.error);
  assert.equal(turn.result?.text, speech);
  assert.equal(turn.trace.status, 'committed');
  assert.equal(turn.trace.publicSpeech, speech);
  assert.equal(turn.events.at(-1)?.speaker, 'ai');
  assert.equal(turn.events.at(-1)?.text, speech);
  assert.equal(turn.trace.generationGuard.regenerated, regenerated);
  assert.equal(turn.trace.generationGuard.fallback, false);
  assert.equal(turn.state.judgments.at(-1)?.judgment.action, 'confirm');
  assert.equal(turn.state.judgments.at(-1)?.judgment.discriminatingFeature, feature);
}

function checkRewritten(turn: Outcome, first: string, retry: string, codes: string[]) {
  assert.deepEqual(turn.rendered, [first, retry]);
  assert.deepEqual([...turn.trace.generationGuard.violations].sort(), [...codes].sort());
  checkPublished(turn, retry, true);
}

function checkStopped(turn: Outcome, text: string, violations: string[]) {
  assert.ok(turn.error instanceof Error && 'code' in turn.error);
  assert.equal(turn.error.code, 'unsafe_generation');
  assert.equal(turn.result, null);
  assert.equal(turn.trace.status, 'error');
  assert.equal(turn.trace.publicSpeech, null);
  assert.deepEqual(turn.trace.generationGuard, { regenerated: true, fallback: false, violations });
  assert.deepEqual(turn.rendered, [text, text]);
  assert.deepEqual(turn.events, turn.inputEvents);
  assert.deepEqual(turn.state, turn.before);
}

function generationDecisionMessage(turn: Outcome, draftIndex: number) {
  const decision = turn.generationInstructions[draftIndex]?.find(message => message.includes('"discriminatingFeature":'));
  assert.ok(decision, 'a system message must carry the selected decision');
  return decision;
}

async function checkReplay(rows: readonly Outcome[], index: number, profile: ResearchTrialProfileV3) {
  const [repair, bypass] = rows;
  const item = rows[index];
  const label = strategies[index];
  assert.deepEqual(item.before.interventionPolicy,
    { version: 'bypass_acceptance_v1', tableSha256: profile.interventionPolicy.tableSha256 });
  assert.deepEqual(repair.common, bypass.common);
  const tape: InterventionReplayTape = JSON.parse(JSON.stringify({
    schemaVersion: 'parity_intervention_replay_v1', state: item.before, events: item.inputEvents,
    technicalTrial, ...(item.trace.generationRetryVersion ? { generationRetryVersion: item.trace.generationRetryVersion } : {}),
    common: item.common, tails: { 'repair-first': repair.tail, 'bypass-enabled': bypass.tail },
    recorded: { label, expectedRequests: item.sends },
  }));
  const savedHash = hash(tape);
  const replay = await pairedInterventionReplay(tape, own, MODEL, profile);
  assert.equal(hash(tape), savedHash);
  assert.equal(replay.status, 'same_material_intervention_verified', replay.error ?? '');
  assert.equal(replay.recordedPayloadsReproduced, true);
  assert.equal(replay.commonEqual, true);
  assert.equal(replay.policyConformant, true);

  const records = structuredClone(normal);
  await bindCurrentS4PromptSources(records);
  const trial = records.trials[0];
  const profileSha256 = hash(profile);
  for (const header of [records.run, records.summary, trial, records.run.manifest]) {
    Object.assign(header, { profile, profileSha256 });
  }
  trial.identity.profile = profileSha256;
  trial.label = records.run.manifest.trials[0].label = records.summary.runOrder[0].label = label;
  const turn = item.trace.turnIndex;
  trial.calls = item.sends.map((send, i) => ({
    ...structuredClone(normal.trials[0].calls.find((call: { provider: string }) => call.provider === send.provider)),
    id: i + 1, sendIds: send.sendIds, phase: send.phase, turn,
    requestSha256: send.messagesSha256 ?? send.requestSha256,
    ...(send.provider === 'luna' ? { expectedHttpRequestSha256: send.requestSha256, httpRequestSha256: send.requestSha256 } : {}),
  }));
  trial.http = item.sends.flatMap((send, i) => send.provider === 'luna' ? [{
    method: 'POST', kind: 'completion_post', phase: send.phase, callId: i + 1, sendId: i + 1,
    hashScheme: 'canonical_json_sha256', requestSha256: send.requestSha256, status: 200, outcome: 'returned',
  }] : []);
  trial.attempts = [item.trace];
  trial.turns = [{ ...trial.turns[0], turn, trace: [item.trace], state: item.state, publicText: item.trace.publicSpeech }];
  trial.lastCommittedState = item.state;
  trial.replay = [{ tape, result: replay }];
  records.evidence.pairedReplay = [{ trialOrder: 0, turn, left: replay.sides[0], right: replay.sides[1] }];
  const checks = interventionChecks(JSON.parse(JSON.stringify(records)));
  const actual = ['shape', 'binding', 'execution', 'replay'].map(kind =>
    checks.find(check => check.id === 'intervention.trial.0.attempt.0.' + kind)?.status);
  assert.deepEqual(actual, ['pass', 'pass', 'pass', 'pass'], label);
}

test('new two_stage_v3 technical trials use holistic_v5 and retain the intervention table', () => {
  const tableSha256 = '376d569120ca36a3eceaf5ab95410f7eb83f25fbb681e7566a684b97c35165c8';
  assert.deepEqual(newProfile.interventionPolicy, { version: 'bypass_acceptance_v1', tableSha256 });
  assert.deepEqual(interventionForStrategy('repair-first'), {
    policy: 'bypass_acceptance_v1:veto', vetoActions: ['defer', 'move_on'], tableSha256,
  });
  assert.deepEqual(interventionForStrategy('bypass-enabled'), {
    policy: 'bypass_acceptance_v1:accept', vetoActions: [], tableSha256,
  });
  assert.equal(newProfile.dialoguePolicy, 'holistic_v5');
});

test('a participant technical trial persists the default policy in both strategies', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'generation-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDirectory = join(directory, 'cache');
  await mkdir(cacheDirectory, { mode: 0o700 });
  const seed = 736;
  const scene = createTrialV2({ seed, rotationMode: 'relative_pm90' });
  const view = modelView(scene);
  const memo = { figures: view.anchors.map((anchor: { id: string }) => ({
    id: anchor.id, holistic: [], analytic: { shapes: [feature], composition: '平らな縁の内側に穴がある', relations: [] }, unknowns: [],
  })) };
  const memoCache = await createObservationCache({
    directory: cacheDirectory, modelId, onMiss: 'observe',
    client: { async complete() { return { text: JSON.stringify(memo), model: modelId }; } },
  });
  const observation = await memoCache.get({
    ownImage: { mimeType: view.mimeType, base64: view.png.toString('base64') }, ownAnchors: view.anchors,
  });
  const configFile = join(directory, 'config.json');
  const baseAssignmentFile = join(directory, 'assignment.json');
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 'participant_jev_config_v1', seed, cacheDirectory, modelId, memoSha256: hash(observation.memo),
    questionLayout: 'two_stage_v3', technicalTrial, lunaRequest: manifest.lunaRequest, timeouts: manifest.timeouts,
    limits: { lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 0.05 },
  }), { mode: 0o600 });
  await writeFile(baseAssignmentFile, JSON.stringify({
    schemaVersion: 'base_assignment_config_v1', configId: '97d65006-8a5d-404e-bed3-5c0dc7757735',
    revision: 1, strategy: 'repair-first', seed, referenceMemory: true,
  }), { mode: 0o600 });
  const prepared = await prepareParticipantJev({
    configFile, baseAssignmentFile,
    clientConfig: { provider: 'cloudflare', purpose: 'dialogue_turn', baseUrl: 'https://offline.invalid/v1', apiKey: 'offline-only' },
    readKey: async () => 'sk-or-synthetic-offline-generation-0000',
    async fetchImpl(_url, options) {
      assert.equal(options?.method, 'GET', 'this fixture does not send a model request');
      return Response.json({ ready: true, purpose: 'dialogue_turn', provider: 'openai', model: modelId });
    },
  });
  const policies = [];
  for (const strategy of strategies) {
    const settings = { strategy, seed, referenceMemory: true };
    const wiring = await prepared.taskOptions(settings);
    assert.ok(wiring.jevResearch);
    let saved: { options: { dialoguePolicy?: string; profileSha256: string } } | undefined;
    await createNamingTaskV2({
      ...settings, ...wiring, runDir: null, createTrial: () => scene,
      onPersist(record: unknown) { saved = structuredClone(record) as typeof saved; },
    });
    assert.ok(saved);
    assert.equal(saved.options.profileSha256, hash(wiring.jevResearch.profile));
    policies.push(saved.options.dialoguePolicy);
  }
  assert.deepEqual(policies, ['holistic_v5', 'holistic_v5']);
});

for (const label of strategies) {
  for (const [description, text] of [
    ['own perspective in the same clause', ownView],
    ['a question about the partner’s view', partnerQuestion],
    ['an attributed quotation of the partner’s public words', attributedQuote],
  ] as const) {
    test(label + ' publishes ' + description + ' on the first draft', async () => {
      const { turn } = await confirm(label, newProfile, [clean(text), clean(safeDraft)]);
      checkPublished(turn, text, false);
      assert.deepEqual(turn.rendered, [text]);
      assert.deepEqual(turn.trace.generationGuard.violations, []);
    });
  }

  for (const [description, text, violation] of [
    ['an assertion that the partner sees the same position', sameOrientation, 'shared_view_assumption'],
    ['an unmarked orientation', unmarked, 'orientation_leak'],
  ] as const) {
    test(label + ' rewrites ' + description + ' before publication', async () => {
      const { turn } = await confirm(label, newProfile, [clean(text), clean(ownView)]);
      checkRewritten(turn, text, ownView, [violation]);
      assert.ok(!turn.events.some(event => event.speaker === 'ai' && event.text === text));
      const initial = turn.generationInstructions[0].join('\n');
      assert.ok(!initial.includes('自分の画面の向きに依存する上下左右・右向き・上端・下端などの語で形を説明しないでください。'),
        'the general generation instruction must allow the same qualified own view that the guard accepts');
      const retry = turn.generationInstructions[1].at(-1);
      assert.ok(retry);
      assert.match(retry, /同じ節|同一(?:の)?節/u);
      assert.match(retry, /自分側|自分の画面|こちら/u);
    });
  }

  test(label + ' gives a nameless confirmation the rule to attribute the proposal without adopting or reproposing it', async () => {
    const { turn } = await confirm(label, newProfile, [quoteName]);
    checkPublished(turn, quotedName, false);
    assert.deepEqual(turn.trace.draftActs?.map(draft => draft.choice), ['recount_only']);
    const decision = generationDecisionMessage(turn, 0);
    const noAdoptionOrReproposal = /採用[^。\n]{0,32}(?:再提案|提案し直)[^。\n]{0,28}(?:せず|しない|しません|避け|禁止)/u;
    const noAdoption = /採用[^。\n]{0,18}(?:せず|しない|しません|してはなら|してはいけ|禁止)/u;
    const noReproposal = /(?:再提案|提案し直)[^。\n]{0,18}(?:せず|しない|しません|してはなら|してはいけ|禁止)/u;
    assert.ok(noAdoptionOrReproposal.test(decision) || noAdoption.test(decision) && noReproposal.test(decision),
      'the confirmation must forbid both adoption and reproposing the participant’s name');
    assert.match(decision, /(?:引用[^。\n]{0,18}(?:留め|とどめ|限|だけ|のみ)|引用として)/u);
    assert.match(decision, /"candidateName":null/u);
    assert.ok(decision.includes(JSON.stringify(feature)));
  });

  test(label + ' teaches that adopt_chosen requires a selected name and rewrites actual adoption', async () => {
    const { turn } = await confirm(label, newProfile, [{ text: newAdoption, choice: 'adopt_other' }, quoteName]);
    checkRewritten(turn, newAdoption, quotedName, ['draft_act_mismatch']);
    assert.deepEqual(turn.trace.draftActs?.map(draft => [draft.draft, draft.choice]),
      [['initial', 'adopt_other'], ['retry', 'recount_only']]);
    assert.equal(turn.draftQuestions.length, 2);
    for (const request of turn.draftQuestions) {
      assert.deepEqual(JSON.parse(request.state).selected, { action: 'confirm', target, name: null });
      const question = request.questions.draft_naming;
      const instruction = question.instructions + '\n' + question.criteria.adopt_chosen;
      const requiresName = /(?:選択(?:済み|された)?名|選んだ名前|選ばれた名前|selected\.name)[^。\n]{0,75}(?:非null|null\s*(?:でな(?:い|く)|以外|ではない)|名前がある(?:場合|とき)|あり(?:、|かつ)|存在|場合(?:に)?(?:限|のみ)|とき(?:に)?(?:限|だけ|のみ)|必要)/u;
      const rejectsMissingName = /(?:選択(?:済み|された)?名|選んだ名前|選ばれた名前|selected\.name)[^。\n]{0,22}(?:null|ない|空)(?:の場合|なら|とき|場合|ならば)[^。\n]{0,48}(?:adopt_chosen[^。\n]{0,18}(?:選ばない|使わない|不可|禁止)|adopt_other)/u;
      assert.ok(requiresName.test(instruction) || rejectsMissingName.test(instruction),
        'adopt_chosen requires a non-null selected name');
      assert.ok(Object.hasOwn(question.criteria, 'adopt_other'));
    }
  });

  test(label + ' stops without a fallback after two shared-view assertions', async () => {
    const { turn } = await confirm(label, newProfile, [clean(sameOrientation), clean(sameOrientation)]);
    checkStopped(turn, sameOrientation, ['shared_view_assumption']);
  });

  test(label + ' stops after repeated unauthorized adoption and orientation leakage', async () => {
    const text = unmarked + newAdoption;
    const { turn } = await confirm(label, newProfile, [
      { text, choice: 'adopt_other' }, { text, choice: 'adopt_other' },
    ]);
    checkStopped(turn, text, ['orientation_leak', 'draft_act_mismatch']);
  });
}

test('both strategies send the same v5 material and verify its retry in S4 and dynamic replay', async () => {
  const rows = await Promise.all(strategies.map(async label => {
    const { turn } = await confirm(label, newProfile, [clean(sameOrientation), clean(ownView)]);
    checkRewritten(turn, sameOrientation, ownView, ['shared_view_assumption']);
    return turn;
  }));
  assert.deepEqual(rows[0].rawSends, rows[1].rawSends);
  assert.deepEqual(rows[0].trace.executed, rows[1].trace.executed);
  for (const [index] of strategies.entries()) await checkReplay(rows, index, newProfile);
});

// The complete HTTP request bodies (including the original and retry instructions), final
// judgments and published outcomes were hashed using the synthetic fixture at 9b5efd0.
const legacyFingerprints = {
  holistic_v1: 'fdb765f01017debb80768d5c3b480d567ba541960cf47fa31915049b2ea9d0ca',
  holistic_v2: '9a9fd6f708dadc039807936d2e6efac635897dfaa7cd20974928d4706fc625e6',
  holistic_v3: 'e79ac6a3707263351cd7878a87d407ce00eb3a96b29551d23abbf551567e3138',
  holistic_v4: '3fd9ba921459ac39f3e02d02714b428b9dadc79fcb75e6b51071ee127609c7df',
} as const;
for (const policy of Object.keys(legacyFingerprints) as Array<keyof typeof legacyFingerprints>) {
  test(policy + ' preserves request bytes, decisions and both forms of replay for both strategies', async () => {
    const profile = makeProfile(policy);
    assert.equal(profile.dialoguePolicy, policy);
    const rows = await Promise.all(strategies.map(label =>
      confirm(label, profile, [clean(unmarked), quoteName])));
    const fingerprint = rows.map(({ agreed, turn }) => {
      checkRewritten(turn, unmarked, quotedName, ['orientation_leak']);
      return [agreed, turn].map(outcome => ({
        rawSends: outcome.rawSends, finalAction: outcome.trace.finalAction, executed: outcome.trace.executed,
        publicSpeech: outcome.trace.publicSpeech, guard: outcome.trace.generationGuard,
      }));
    });
    assert.equal(hash(fingerprint), legacyFingerprints[policy]);
    for (const [index] of strategies.entries()) await checkReplay(rows.map(row => row.turn), index, profile);
  });
}
