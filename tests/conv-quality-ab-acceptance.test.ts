// Synthetic v3 acceptance tests. The "change" cases cover the fixes; the
// "control" cases also pass on 07116ae. Scripted choices verify the prompts
// and runtime effects. Whether the model stops the loop needs a live check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevAction, JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import type { InterventionReplayTape, ReplaySegment } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { anchors, deadlines, ids, image, memo } from './support/s4-integration/harness.ts';
import { MODEL, normal } from './support/s4-v3-records.ts';

const [slot, otherSlot] = ids;
const feature = '丸い輪に細い棒が接する';
const alternateFeature = '輪に切れ目がある';
const name = '鍵';
const memoName = 'ランプ';
const publicAlias = '環輪';
const strategies = ['repair-first', 'bypass-enabled'] as const;
type Strategy = typeof strategies[number];
type Segment = {
  text: string;
  aspect: LocalSegmentProposal['aspect'];
  act: LocalAct;
  targets?: string[];
  name?: string;
  antecedent?: (claim: LocalClaimView) => boolean;
};
type Turn = {
  human: string;
  local?: Segment[];
  ai?: Segment[];
  action: JevAction;
  speech: string;
  target?: number | 'figures_0_1';
  referent?: number;
  referentTie?: 'multiple';
  feature?: string;
  name?: string;
  forceName?: boolean;
  agreeIfOffered?: { name: string; speech: string; figureIndex?: number };
  alternatives?: Partial<Record<JevAction, number>>;
};
type NativeRequest = {
  model: string;
  state: string;
  questions: Record<string, { criteria: Record<string, string> }>;
};
type ActionMessages = Parameters<ReturnType<typeof createChatClient>['complete']>[0];
type Attempt = { input: JevDecisionInput; wire: NativeRequest[]; generation: ActionMessages[]; trace: JevTurnTrace; state: JevPrivateState };
type Send = InterventionReplayTape['recorded']['expectedRequests'][number];

const lunaSettings = { timeoutMs: null, maxCompletionTokens: null };
const timeouts = { ...deadlines(), localMs: 3000, decisionMs: 3000, generationMs: 3000 };
const profile = researchTrialProfileV3(lunaSettings, timeouts, 'two_stage_v3');
const holisticV2Profile = researchTrialProfileV3(lunaSettings, timeouts, 'two_stage_v3', 'holistic_v2');
const versionlessProfile = researchTrialProfileV3(lunaSettings, timeouts, 'two_stage_v3', null);
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const own = { ownImage: { ...image, mimeType: 'image/png' as const }, ownAnchors: anchors };
const observation = memo();
observation.figures[0].analytic.shapes = [feature, alternateFeature];
observation.figures[0].holistic = [{ construal: memoName, basis: [feature], status: 'hypothesis' }];
const ownMemo = validateObservationMemo(observation, { ownAnchors: anchors });

const fromAi = (act: LocalAct) => (claim: LocalClaimView) => claim.speaker === 'ai' && claim.act === act;
const acknowledge = (text: string): Segment => ({ text, aspect: 'progress', act: 'acknowledge' });
const priorPublicAlias: Segment = {
  text: `以前この形を「${publicAlias}」と呼んだ人がいました。`,
  aspect: 'name', act: 'assert', name: publicAlias, targets: [slot],
};
function extract(segments: Segment[] = []): string {
  return JSON.stringify(segments.map((s, i): LocalSegmentProposal => ({
    segmentId: String(i + 1), quote: s.text, proposition: s.text, aspect: s.aspect,
    targets: s.targets ?? [], name: s.name ?? null, linkedIssueId: null, respondsToTurn: null,
  })));
}
async function replay(strategy: Strategy, scenario: Turn[], onFailure?: (attempt: Attempt) => void, trialProfile = profile) {
  const events: Array<{ id: string; seq: number; speaker: 'human' | 'ai'; text: string }> = [];
  const append = (speaker: 'human' | 'ai', text: string) => {
    const seq = events.length + 1;
    const event = { id: speaker + '-' + seq, seq, speaker, text };
    events.push(event);
    return event;
  };
  let current = scenario[0];
  let wire: NativeRequest[], generation: ActionMessages[], trace: JevTurnTrace, input: JevDecisionInput;
  let selectedAction: string;
  let material: ReplaySegment, sends: Send[], cut: { luna: number; jev: number };
  let lunaCall: ReplaySegment['luna'][number];
  function recordSend(provider: Send['provider'], phase: string, body: Record<string, unknown>) {
    sends.push({ provider, phase, requestSha256: hash(body), actualSendMeasured: true, sendIds: [sends.length + 1],
      ...(provider === 'luna' ? { messagesSha256: hash(body.messages) } : {}) });
  }
  const scriptedSpeech = () => selectedAction === 'agree' && current.agreeIfOffered
    ? current.agreeIfOffered.speech : current.speech;
  let responseId = 0;
  const readKey = async () => 'sk-or-SYNTHETIC-offline-00000000000';
  const luna = createChatClient({
    provider: 'cloudflare', purpose: trialProfile.modelPolicy.purpose, apiKey: 'synthetic-offline-replay-key',
    baseUrl: 'https://offline.invalid/v1', timeoutMs: trialProfile.timeouts.lunaAttemptMs,
  }, async (_url, options) => {
    recordSend('luna', lunaCall.phase, JSON.parse(String(options?.body)));
    return Response.json({ model: lunaCall.response.model, choices: [{ message: { content: lunaCall.response.text } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 } });
  });
  const fetchImpl = async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body)) as NativeRequest;
    wire.push(request);
    const state = JSON.parse(request.state) as { aiSeq?: number; priorClaims?: LocalClaimView[]; selected?: { action?: string } };
    const keys = Object.keys(request.questions);
    const phase = keys.includes('human_referent') ? 'human_referent' : keys.includes('draft_naming') ? 'draft_naming' : keys.includes('repair_issue') ? 'repair_prospect'
      : keys.some(key => key.endsWith('_support')) ? 'ai_support'
      : keys.some(key => key.endsWith('_act')) ? Object.hasOwn(state, 'aiSeq') ? 'ai_function' : 'local_function' : 'decision';
    recordSend('jev', phase, request);
    const answers = Object.fromEntries(Object.entries(request.questions).map(([key, { criteria }]) => {
      const labels = Object.keys(criteria);
      let choice = labels[0];
      if (key === 'draft_naming') choice = state.selected?.action === 'agree' ? 'adopt_chosen' : 'none';
      if (key === 'action') {
        const proposed = current.agreeIfOffered;
        const eligible = proposed && (proposed.figureIndex === undefined || input.agreeNames?.some(candidate =>
          candidate.figureId === ids[proposed.figureIndex!] && candidate.name === proposed.name));
        selectedAction = choice = eligible && labels.includes('agree') ? 'agree' : current.action;
      }
      const attemptingAgreement = selectedAction === 'agree' ? current.agreeIfOffered : undefined;
      if (key === 'target') {
        choice = attemptingAgreement
          ? attemptingAgreement.figureIndex === undefined ? labels.find(label => /^figure_\d+$/u.test(label)) ?? labels[0]
            : 'figure_' + attemptingAgreement.figureIndex
          : typeof current.target === 'number' ? 'figure_' + current.target : current.target ?? 'none';
      }
      if (key === 'human_referent') choice = current.referent === undefined ? 'none' : 'figure_' + current.referent;
      if (key === 'repair_issue') choice = labels.includes('issue_0') ? 'issue_0' : 'none';
      if (key === 'prospect') choice = 'uncertain';
      if (key === 'basis') choice = 'partner_uncertain';
      if (key === 'name' || key === 'feature') {
        const want = key === 'name' ? attemptingAgreement?.name ?? current.name : current.feature;
        if (want) choice = labels.find(label => JSON.parse(criteria[label]).value === want)
          ?? (attemptingAgreement ? labels[0] : 'name_999');
      }
      const match = /^segment_(\d+)_(act|antecedent|support)$/u.exec(key);
      if (match) {
        const segment = (state.aiSeq === undefined && match[2] !== 'support' ? current.local : current.ai)?.[Number(match[1])];
        assert.ok(segment, key);
        if (match[2] === 'act') choice = segment.act;
        if (match[2] === 'support') choice = 'expressed';
        if (match[2] === 'antecedent') {
          const index = segment.antecedent === undefined ? -1 : (state.priorClaims ?? []).findIndex(segment.antecedent);
          if (segment.antecedent) assert.notEqual(index, -1, 'scripted antecedent is absent');
          choice = index === -1 ? 'none' : 'claim_' + index;
        }
      }
      if (key !== 'name' || !current.forceName) assert.ok(labels.includes(choice), key + ' does not offer ' + choice);
      const tie = key === 'human_referent' ? current.referentTie : undefined;
      if (tie) assert.ok(labels.includes(tie) && tie !== choice, 'tied referent labels must both be offered');
      const probabilities = Object.fromEntries(labels.map(label => [
        label, tie ? Number(label === choice || label === tie) / 2
          : label === choice ? 1 : key === 'action' ? current.alternatives?.[label as JevAction] ?? 0 : 0,
      ]));
      return [key, { type: 'choice', choice, probabilities }];
    }));
    const response = { model: request.model, id: 'gen-conv-' + ++responseId, usage: { cost: 0 }, answers };
    material.jev.push(response);
    return Response.json(response);
  };
  const transport = { enabled: true, readKey, fetchImpl, timeoutMs: 3000, researchLimits: { maxDeadlineMs: 600000 } };
  const decision = createJevDecisionClient({ ...transport, questionLayout: trialProfile.questionLayout })!;
  const runtime = createProfileDialogue(trialProfile, {
    strategy, image, anchors, technicalTrial,
    observer: {
      async observeAll() { return structuredClone(ownMemo); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: { async complete(messages: Parameters<typeof luna.complete>[0], options: { phase: string; timeoutMs?: number }) {
      const { phase } = options;
      assert.ok(['local_extraction', 'ai_extraction', 'generation'].includes(phase));
      if (phase === 'generation') generation.push(structuredClone(messages));
      const text = phase === 'local_extraction' ? extract(current.local)
        : phase === 'ai_extraction' ? extract(current.ai) : scriptedSpeech();
      lunaCall = { phase, response: { text, model: 'synthetic-luna', usage: { inputTokens: 0, outputTokens: 0 } } };
      material.luna.push(lunaCall);
      return luna.complete(messages, options);
    } },
    jevDecision: { ...decision, async decide(next: JevDecisionInput, options?: Parameters<typeof decision.decide>[1]) {
      input = structuredClone(next);
      const result = await decision.decide(next, options);
      cut = { luna: material.luna.length, jev: material.jev.length };
      return result;
    } },
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...transport, questionLayout: trialProfile.questionLayout, dialoguePolicy: trialProfile.dialoguePolicy })!,
      aiPublicTransport: transport,
    },
    onJevTurnTrace(record: JevTurnTrace) { trace = structuredClone(record); },
  });
  let state = runtime.initialPrivateState() as InterventionReplayTape['state'];
  const snapshots = [];
  for (const turn of scenario) {
    current = turn;
    wire = [];
    generation = [];
    sends = [];
    material = { luna: [], jev: [], reobservations: [] };
    const before = state;
    const human = append('human', turn.human);
    const result = await runtime.runAiTurn({ events, privateState: state, lastEventId: human.id, requestSeq: human.seq }).catch((error: unknown) => {
      onFailure?.({ input, wire, generation, trace, state });
      throw error;
    });
    assert.ok(trace! && input!, 'a native decision must execute');
    assert.equal(trace.publicSpeech, result.text);
    assert.equal(result.text, scriptedSpeech());
    assert.equal(trace.decisions.at(-1)?.action, selectedAction!);
    assert.ok(!trace.generationGuard.fallback, 'forecast could not be published');
    assert.deepEqual(trace.generationGuard.violations, []);
    // Simulate persistence between public turns, including restore validation.
    state = JSON.parse(JSON.stringify(result.privateState)) as InterventionReplayTape['state'];
    const saved = (state.judgments ?? []).at(-1)!;
    assert.deepEqual(saved.jevTurn.agreeNames, input.agreeNames);
    assert.deepEqual(saved.jevTurn.repairFacts, input.repairFacts);
    assert.deepEqual(saved.jevTurn.executed, trace.executed);
    assert.deepEqual(saved.judgment, trace.finalAction);
    const common = { luna: material.luna.slice(0, cut!.luna), jev: material.jev.slice(0, cut!.jev), reobservations: [] };
    const tail = { luna: material.luna.slice(cut!.luna), jev: material.jev.slice(cut!.jev), reobservations: [] };
    snapshots.push({ state, saved, input, trace, wire, generation, speech: result.text as string,
      before, events: structuredClone(events), common, tail, sends });
    append('ai', result.text);
  }
  return snapshots;
}

type Snapshot = Awaited<ReturnType<typeof replay>>[number];
async function sameScenario(scenario: Turn[], trialProfile = profile): Promise<Snapshot[]> {
  const [repair, bypass] = await Promise.all(strategies.map(strategy => replay(strategy, scenario, undefined, trialProfile)));
  for (const [i, left] of repair.entries()) {
    const right = bypass[i];
    assert.deepEqual(left.wire, right.wire, 'same native inputs, criteria, and requested model');
    assert.deepEqual(left.generation, right.generation, 'same generation material and wording');
    assert.deepEqual(left.saved.judgment, right.saved.judgment);
    assert.deepEqual(left.state.ledger, right.state.ledger);
  }
  return repair;
}

async function checkS4(repair: Snapshot, bypass: Snapshot): Promise<void> {
  assert.deepEqual(repair.common, bypass.common);
  for (const [label, item] of [['repair-first', repair], ['bypass-enabled', bypass]] as const) {
    const tape: InterventionReplayTape = {
      schemaVersion: 'parity_intervention_replay_v1', state: item.before, events: item.events, technicalTrial,
      common: item.common, tails: { 'repair-first': repair.tail, 'bypass-enabled': bypass.tail },
      recorded: { label, expectedRequests: item.sends },
    };
    const result = await pairedInterventionReplay(tape, own, MODEL, JSON.parse(JSON.stringify(profile)));
    const side = result.sides.find(side => side.label === label);
    const mismatchedSends = item.sends.flatMap((send, i) => {
      const replayed = side?.requests[i];
      return replayed?.provider === send.provider && replayed.phase === send.phase &&
        replayed.preProjectionPayloadSha256 === send.requestSha256 ? [] : [send.provider + '/' + send.phase];
    });
    assert.equal(result.status, 'same_material_intervention_verified', JSON.stringify({ label, error: result.error, mismatchedSends }));
    assert.deepEqual(result.sides.map(side => side.executed), [repair.trace.executed, bypass.trace.executed]);

    const records = structuredClone(normal);
    const trial = records.trials[0];
    const profileSha256 = hash(profile);
    for (const source of [records.run, records.summary, trial, records.run.manifest]) {
      Object.assign(source, { profile, profileSha256 });
    }
    Object.assign(records.run.manifest, { timeouts: profile.timeouts, lunaRequest: profile.lunaRequest });
    trial.identity.profile = profileSha256;
    trial.label = records.run.manifest.trials[0].label = records.summary.runOrder[0].label = label;
    const turn = item.trace.turnIndex;
    trial.calls = item.sends.map((send, index) => ({
      ...structuredClone(normal.trials[0].calls.find((call: { provider: string }) => call.provider === send.provider)),
      id: index + 1, sendIds: send.sendIds, phase: send.phase, turn,
      requestSha256: send.messagesSha256 ?? send.requestSha256,
      ...(send.provider === 'luna' ? { expectedHttpRequestSha256: send.requestSha256, httpRequestSha256: send.requestSha256 } : {}),
    }));
    trial.http = item.sends.flatMap((send, index) => send.provider === 'luna' ? [{
      method: 'POST', kind: 'completion_post', phase: send.phase, callId: index + 1, sendId: index + 1,
      hashScheme: 'canonical_json_sha256', requestSha256: send.requestSha256, status: 200, outcome: 'returned',
    }] : []);
    const trace = { ...item.trace, status: 'committed' as const };
    trial.attempts = [trace];
    trial.turns = [{ ...trial.turns[0], turn, publicText: item.speech, trace: [trace], state: item.state }];
    trial.lastCommittedState = item.state;
    trial.replay = [{ tape, result }];
    records.evidence.pairedReplay = [{ trialOrder: 0, turn, left: result.sides[0], right: result.sides[1] }];
    const checks = interventionChecks(JSON.parse(JSON.stringify(records)));
    for (const id of ['identity.intervention_policy', ...['shape', 'binding', 'execution', 'replay']
      .map(check => 'intervention.trial.0.attempt.0.' + check)]) {
      const check = checks.find(candidate => candidate.id === id);
      assert.equal(check?.status, 'pass', JSON.stringify({ label, id, check }));
    }
  }
}

const actionOptions = (s: Attempt) => s.wire.find(packet => packet.questions.action)!.questions.action.criteria;
const ownFigure = { target: 0, referent: 0 } as const;

async function lastAgreementAttempt(strategy: Strategy, scenario: Turn[]): Promise<Attempt> {
  let failure: Attempt | undefined;
  try {
    return (await replay(strategy, scenario, attempt => { failure = attempt; })).at(-1)!;
  } catch (error) {
    assert.ok(failure);
    assert.ok(error instanceof Error);
    assert.match(error.message, /^(decision_failed|invalid_decision)$/u);
    assert.equal(failure.trace.status, 'error');
    assert.equal(failure.trace.publicSpeech, null);
    return failure;
  }
}

const locate: Turn = {
  human: '輪に細い棒がついた形を探しています。',
  action: 'confirm', ...ownFigure, feature, speech: feature + '形ですか？',
  ai: [{ text: feature + '形ですか？', aspect: 'part', act: 'ask', targets: [slot] }],
};
function propose(text: string, act: 'name_propose' | 'ask', namedTarget = [] as string[]): Segment {
  return { text, act, aspect: 'name', name, targets: namedTarget };
}
function offeredName(text: string): Turn {
  return { human: 'その形です。' + text, local: [
    { text: 'その形です。', aspect: 'part', act: 'assert', targets: [slot] },
    propose(text, 'name_propose'),
  ], action: 'agree', ...ownFigure, name, speech: 'いいですね。「鍵」にしましょう。' };
}

test('A change: the partner name is absent from propose_name and a fabricated choice fails before generation', async () => {
  for (const wording of ['この形、鍵とかどう？', 'この図形を鍵と呼びませんか？']) {
    const proposal = offeredName(wording);
    const requests = await Promise.all(strategies.map(async strategy => {
      let attempt: Attempt | undefined;
      await assert.rejects(replay(strategy, [locate, {
        ...proposal, human: priorPublicAlias.text + proposal.human, local: [priorPublicAlias, ...proposal.local!],
        action: 'propose_name', forceName: true, speech: '「鍵」と呼ぶのはどうでしょう？',
      }], failure => { attempt = failure; }), { code: 'decision_failed' });
      assert.ok(attempt);
      const options = attempt.wire.find(packet => packet.questions.name)?.questions.name.criteria;
      assert.ok(options, 'a native name question must be reached');
      const values = Object.values(options).map(option => JSON.parse(option).value);
      assert.deepEqual(values, [publicAlias], 'the public mention remains eligible without the partner proposal or memo reading');
      assert.ok(attempt.input.publicNames.some(candidate => candidate.name === publicAlias && candidate.figureId === slot));
      assert.deepEqual(attempt.input.agreeNames, [{ name, figureId: slot, sourceTurn: 3 }]);
      assert.equal(attempt.trace.errorCode, 'decision_failed');
      assert.equal(attempt.trace.publicSpeech, null);
      assert.deepEqual(attempt.generation, []);
      return attempt.wire;
    }));
    assert.deepEqual(requests[0], requests[1]);
  }
});

test('A control: a grounded proposal can be adopted and a factual question grants no license to agree', async () => {
  for (const wording of ['この形、鍵とかどう？', 'この図形を鍵と呼びませんか？']) {
    const [, agreed] = await sameScenario([locate, offeredName(wording)]);
    const claim = agreed.input.priorClaims.find(c => c.speaker === 'human' && c.name === name);
    assert.equal(claim?.act, 'name_propose');
    assert.deepEqual(claim.targets, []);
    assert.deepEqual(agreed.input.agreeNames, [{ name, figureId: slot, sourceTurn: 3 }]);
    assert.equal(agreed.saved.judgment.action, 'agree');
    assert.deepEqual(agreed.saved.jevTurn.executed?.target, { kind: 'single', figureId: slot });
    assert.equal(agreed.state.ledger[slot].status, 'agreed');
    assert.equal(agreed.state.ledger[slot].name, agreed.saved.judgment.candidateName);
    assert.match(agreed.speech, /「鍵」にしましょう/u);
  }
  const question = '「鍵」という名前は前にも使いましたか？';
  const [fact] = await sameScenario([{ human: question, local: [propose(question, 'ask')], action: 'accept', speech: 'まだ使っていません。' }]);
  assert.deepEqual(fact.input.agreeNames, []);
  assert.equal(Object.hasOwn(actionOptions(fact), 'agree'), false);
  assert.equal(fact.state.ledger[slot].name, null);
});

test('holistic_v3 excludes memo-only proposals, keeps human agree, and preserves the versionless catalog', async () => {
  const [unmentioned, agreed] = await sameScenario([locate, offeredName('この形に鍵ってどうかな？')]);
  assert.ok(unmentioned.input.observations.figures[0].holistic.some(reading => reading.construal === memoName));
  assert.deepEqual(unmentioned.input.publicNames, []);
  assert.equal(Object.hasOwn(actionOptions(unmentioned), 'propose_name'), false);
  assert.equal(agreed.input.nameSource, 'public_only');
  assert.equal(Object.hasOwn(actionOptions(agreed), 'propose_name'), false, 'the human proposal is not reoffered as an AI proposal');
  assert.equal(Object.hasOwn(actionOptions(agreed), 'agree'), true);
  assert.deepEqual(agreed.input.agreeNames, [{ name, figureId: slot, sourceTurn: 3 }]);
  assert.equal(agreed.saved.judgment.action, 'agree');
  assert.equal(agreed.speech, 'いいですね。「鍵」にしましょう。');
  assert.deepEqual(agreed.state.ledger[slot], { status: 'agreed', name });

  const speech = `「${memoName}」と呼ぶのはどうでしょう？`;
  const [legacy] = await sameScenario([{ ...locate, action: 'propose_name', name: memoName, speech, ai: [] }], versionlessProfile);
  assert.deepEqual(legacy.input.publicNames, []);
  assert.equal(legacy.input.nameSource, undefined);
  assert.equal(Object.hasOwn(actionOptions(legacy), 'propose_name'), true);
  const choices = legacy.wire.find(packet => packet.questions.name)?.questions.name.criteria;
  assert.ok(choices);
  assert.deepEqual(Object.values(choices).map(option => JSON.parse(option).value), [memoName]);
  assert.equal(legacy.speech, speech);
  assert.deepEqual(legacy.state.ledger[slot], { status: 'tentative', name: memoName });
});

const approvalQuestion = (text: string): Segment => ({
  text, aspect: 'name', act: 'name_propose', antecedent: c => c.speaker === 'human' && c.act === 'name_propose' && c.name === name,
});
const clarifyUnboundName = {
  action: 'confirm', target: 0, feature: alternateFeature,
  speech: 'どの形の呼び名か確かめたいです。' + alternateFeature + '形ですか？',
} as const;
const acknowledgment = (human: string, target?: number): Turn => ({
  human, local: [acknowledge(human)], action: 'accept', target, speech: 'わかりました。',
});

test('holistic_v3 narrows the naming-request catalog only when no agreement is grounded', async () => {
  const reading = '環を細い柄で支えているように見えます。';
  const describe = (targets: string[]): Turn => ({
    human: '図形のおおまかな特徴を教えてください。', action: 'accept', target: 0, speech: reading,
    ai: [{ text: reading, aspect: 'construal', act: 'construe', targets }],
  });
  const acknowledgmentOfReading = acknowledgment('ええ、そんな感じの形です。');
  const suggestion = 'これを鍵と呼ぶのはどうかな？';
  const unbound: Turn = { human: suggestion, local: [propose(suggestion, 'name_propose')], ...clarifyUnboundName };
  const [, plain, proposed] = await sameScenario([describe([]), acknowledgmentOfReading, unbound]);
  assert.equal(plain.input.namingRequest, undefined);
  assert.ok(Object.hasOwn(actionOptions(plain), 'accept'));
  assert.equal(plain.saved.judgment.action, 'accept');
  assert.deepEqual(plain.state.ledger, plain.before.ledger);
  assert.deepEqual(proposed.input.priorClaims.find(c => c.speaker === 'ai' && c.quote === reading)?.targets, []);
  const originalProposal = proposed.input.priorClaims.find(c => c.speaker === 'human' && c.quote === suggestion);
  assert.equal(originalProposal?.act, 'name_propose');
  assert.deepEqual(originalProposal?.targets, []);
  assert.equal(Object.hasOwn(actionOptions(proposed), 'accept'), false);
  assert.equal(Object.hasOwn(actionOptions(proposed), 'agree'), false);
  assert.equal(proposed.input.namingRequest, true);
  assert.deepEqual(proposed.input.agreeNames, []);
  assert.equal(proposed.saved.judgment.action, 'confirm');
  assert.match(proposed.speech, /[？?]$/u);
  assert.deepEqual(proposed.state.ledger, proposed.before.ledger);
  assert.equal(profile.dialoguePolicy, 'holistic_v3');

  const identified = '探しているのは、細い柄が付いた環の形です。';
  const narrowReferent: Turn = {
    ...acknowledgment(identified, 0), referent: 0,
    local: [{ text: identified, aspect: 'referent', act: 'assert', targets: [slot] }],
  };
  const [, shared, agreed] = await sameScenario([describe([slot]), narrowReferent, {
    ...unbound, action: 'agree', name, speech: `はい、「${name}」にしましょう。`,
  }]);
  assert.equal(shared.input.humanReferent?.scores?.[slot], 1);
  assert.equal(agreed.input.humanReferent?.scores?.none, 1);
  assert.equal(agreed.input.namingRequest, true);
  assert.deepEqual(agreed.input.agreeNames, [{ name, figureId: slot, sourceTurn: 5 }]);
  assert.ok(Object.hasOwn(actionOptions(agreed), 'agree') && Object.hasOwn(actionOptions(agreed), 'accept'));
  assert.equal(agreed.saved.judgment.action, 'agree');
  assert.equal(agreed.speech, `はい、「${name}」にしましょう。`);
  assert.deepEqual(agreed.state.ledger[slot], { status: 'agreed', name });

  const [, , legacy] = await sameScenario([describe([]), acknowledgmentOfReading, {
    ...unbound, action: 'accept', target: undefined, feature: undefined, speech: '呼び名はまだ決まっていません。',
  }], holisticV2Profile);
  assert.equal(legacy.input.namingRequest, undefined);
  assert.ok(Object.hasOwn(actionOptions(legacy), 'accept'));
  assert.ok(!Object.hasOwn(actionOptions(legacy), 'agree'));
  assert.equal(legacy.saved.judgment.action, 'accept');
  assert.deepEqual(legacy.state.ledger, legacy.before.ledger);
});

test('holistic_v3 requires clarification for a linked approval request after the proposed figure is denied', async () => {
  const question: Turn = {
    ...locate, ai: [{ text: locate.speech, act: 'ask', aspect: 'referent', targets: [slot] }],
  };
  const suggestion = '呼び名には鍵を提案します。';
  const proposal: Turn = {
    human: suggestion, local: [propose(suggestion, 'name_propose', [slot])],
    action: 'accept', target: 0, speech: '呼び名の候補ですね。',
  };
  const denial = '尋ねていたのは、今挙げた形ではありません。';
  const approval = '先ほどの呼び方を使っても構いませんか？';
  const request: Turn = {
    human: denial + approval, local: [referentResponse(denial, 'deny'), approvalQuestion(approval)],
    ...clarifyUnboundName,
  };
  const [[, eligible, asked], [, , bypass]] = await Promise.all(strategies.map(strategy => replay(strategy, [question, proposal, request])));
  assert.deepEqual(asked.wire, bypass.wire);
  assert.deepEqual(asked.state.ledger, bypass.state.ledger);
  assert.equal(asked.speech, bypass.speech);
  assert.deepEqual(asked.input.agreeNames, []);
  assert.ok(!Object.hasOwn(actionOptions(asked), 'accept') && !Object.hasOwn(actionOptions(asked), 'agree'));
  assert.equal(eligible.input.namingRequest, true);
  assert.deepEqual(eligible.input.agreeNames, [{ name, figureId: slot, sourceTurn: 3 }]);
  const source = asked.input.priorClaims.find(c => c.quote === suggestion);
  const linked = asked.input.priorClaims.find(c => c.quote === approval);
  assert.ok(source && linked);
  assert.equal(linked.respondsTo, source.id);
  assert.equal(linked.act, 'name_propose');
  assert.equal(linked.name, source.name);
  assert.deepEqual(linked.targets, [slot]);
  assert.equal(asked.input.namingRequest, true);
  assert.equal(asked.saved.judgment.action, 'confirm');
  assert.equal(asked.speech, clarifyUnboundName.speech);
  assert.deepEqual(asked.state.ledger, asked.before.ledger);
  await checkS4(asked, bypass);
});

function namingContext(): Turn[] {
  const grounded = 'その形で合っています。';
  const first = '名前は鍵がいいと思います。';
  return [
    locate,
    { human: grounded + first, local: [
      { text: grounded, act: 'assert', aspect: 'part', targets: [slot] },
      propose(first, 'name_propose', [slot]),
    ], action: 'accept',
      ...ownFigure, speech: '「鍵」が候補なんですね。' },
  ];
}
function approve(human: string): Turn {
  return { human, local: [approvalQuestion(human)], ...ownFigure, action: 'agree', name, speech: 'はい、「鍵」にしましょう。' };
}

test('A2 change: shared native criteria keep an approval request open and specify an answer', async () => {
  const [, , result] = await sameScenario([...namingContext(), approve('前に出した呼び名でよいでしょうか？')]);
  const criterion = actionOptions(result).agree;
  assert.match(criterion, /答えるまで未回答/u);
  assert.match(criterion, /相槌や見立ての説明では答えたことにならない/u);
  assert.match(criterion, /理由を具体的に確かめるconfirmかrepair/u);
});

test('A2 control: paraphrased approval requests and a resumed discussion can adopt the original name', async () => {
  for (const wording of ['この呼び名で決めて平気ですか？', '前に出した呼び名でよいでしょうか？']) {
    const [, , adopted] = await sameScenario([...namingContext(), approve(wording)]);
    const proposal = adopted.input.priorClaims.find(c => c.act === 'name_propose' && c.name === name);
    const request = adopted.input.priorClaims.find(c => c.sourceTurn === adopted.input.turn && c.quote === wording);
    assert.ok(proposal);
    assert.equal(request?.respondsTo, proposal.id);
    assert.equal(request?.act, 'name_propose');
    assert.equal(request?.name, proposal.name);
    assert.deepEqual(adopted.input.agreeNames, [{ name, figureId: slot, sourceTurn: 3 }]);
    assert.equal(adopted.saved.judgment.candidateName, name);
    assert.equal(adopted.state.ledger[slot].status, 'agreed');
    assert.equal(adopted.state.ledger[slot].name, name);
    assert.match(adopted.speech, /「鍵」にしましょう/u);
  }

  const request = approve('前に出した呼び名でよいでしょうか？');
  const clarification: Turn = {
    ...request, action: 'confirm', feature: alternateFeature,
    speech: '同じ形か確かめてから答えたいです。' + alternateFeature + '形ですか？',
  };
  const resumed = acknowledgment('続けてください。', 0);
  const interposed = await sameScenario([...namingContext(), clarification, acknowledgment('少し待ってください。', 0), {
    ...resumed, action: 'agree', name, speech: 'はい、「鍵」にしましょう。',
  }]);
  const answered = interposed.at(-1)!;
  assert.equal(answered.input.priorClaims.find(c => c.sourceTurn === answered.input.turn)?.act, 'acknowledge');
  assert.ok(answered.input.priorClaims.some(c => c.quote === request.human && c.act === 'name_propose' && c.name === name));
  assert.equal(answered.state.ledger[slot].status, 'agreed');
  assert.deepEqual(answered.input.agreeNames, [{ name, figureId: slot, sourceTurn: 3 }]);
});

test('A2 control: a reasoned clarification leaves the ledger open and a backchannel adds no name acceptance', async () => {
  const objection = '輪の切れ目が気になるので、決める前にそこを照合したいです。' + alternateFeature + '形ですか？';
  const [, , disagreed] = await sameScenario([...namingContext(), {
    ...approve('前に出した呼び名でよいでしょうか？'), action: 'confirm', feature: alternateFeature, speech: objection,
  }]);
  assert.equal(disagreed.saved.judgment.action, 'confirm');
  assert.equal(disagreed.input.agreeNames?.[0]?.name, name);
  assert.equal(disagreed.state.ledger[slot].name, null);
  assert.equal(disagreed.state.repairHistory.at(-1)?.question, alternateFeature);

  const [, , bare] = await sameScenario([...namingContext(), acknowledgment('うん', 0)]);
  assert.equal(bare.input.priorClaims.find(c => c.sourceTurn === bare.input.turn)?.act, 'acknowledge');
  assert.equal(bare.state.ledger[slot].name, null);

  const first = '呼び方は鍵でどうですか？';
  const text = 'その呼び名で決めてもいいですか？';
  const [, unclear] = await sameScenario([
    { human: first, local: [propose(first, 'name_propose')], ...clarifyUnboundName },
    { human: text, local: [approvalQuestion(text)], target: 0,
      action: 'confirm', feature, speech: '指している形がまだ分からないので確かめたいです。' + feature + '形ですか？' },
  ]);
  assert.equal(unclear.input.priorClaims.find(c => c.name === name)?.targets.length, 0);
  assert.equal(unclear.saved.judgment.action, 'confirm');
  assert.match(unclear.speech, /指している形がまだ分からない/u);
  assert.equal(unclear.state.ledger[slot].name, null);
  assert.equal(unclear.state.repairHistory.at(-1)?.question, feature);
});

test('A2 change: an unbound name cannot be adopted during a repeated approval request without a publicly shared figure', async () => {
  const proposal = '呼び名の候補に鍵を挙げます。';
  const offered: Turn = {
    human: proposal, local: [propose(proposal, 'name_propose')], ...clarifyUnboundName,
  };
  const question = `先ほど挙げた「${name}」で決めても構いませんか？`;
  const agreement = { name, speech: 'はい、「鍵」にしましょう。' };
  const request: Turn = {
    human: question, local: [approvalQuestion(question)],
    action: 'confirm', target: 0, feature, speech: locate.speech,
    agreeIfOffered: agreement,
  };
  const identified = '丸い輪に細い棒がついた形のことです。';
  const [, , adopted] = await sameScenario([locate, {
    ...offered, human: identified + proposal, ...ownFigure, action: 'accept', speech: '呼び名の候補ですね。',
    local: [{ text: identified, aspect: 'part', act: 'assert', targets: [slot] }, ...offered.local!],
  }, request]);
  const source = adopted.input.priorClaims.find(c => c.quote === proposal);
  const approval = adopted.input.priorClaims.find(c => c.quote === question);
  assert.ok(source && approval);
  assert.deepEqual(source.targets, []);
  assert.deepEqual(approval.targets, []);
  assert.equal(approval.respondsTo, source.id);
  assert.equal(approval.name, source.name);
  assert.ok(adopted.input.priorClaims.some(c => c.speaker === 'ai' && c.act === 'ask' && c.targets.includes(slot)));
  assert.deepEqual(adopted.saved.jevTurn.executed?.target, { kind: 'single', figureId: slot });
  assert.equal(adopted.saved.judgment.action, 'agree');
  assert.equal(adopted.saved.judgment.candidateName, name);
  assert.equal(adopted.speech, agreement.speech);
  assert.equal(adopted.state.ledger[slot].status, 'agreed');
  assert.equal(adopted.state.ledger[slot].name, name);

  const outcomes = await Promise.all(strategies.map(async strategy => {
    const result = await lastAgreementAttempt(strategy, [offered, request]);
    assert.ok(actionOptions(result), 'the native action question must be reached');
    assert.deepEqual(result.input.priorClaims.find(c => c.act === 'name_propose')?.targets, []);
    const question = result.input.priorClaims.find(c => c.sourceTurn === result.input.turn);
    assert.equal(question?.act, 'name_propose');
    assert.ok(result.input.priorClaims.every(c => c.targets.length === 0));
    assert.equal(result.input.humanReferent?.scores?.none, 1);
    const committed = result.state.judgments.at(-1)?.judgment.action;
    const published = result.trace.publicSpeech;
    return {
      strategy, committed, published,
      agreed: Object.entries(result.state.ledger).filter(([, entry]) => entry.status === 'agreed')
        .map(([figureId, entry]) => ({ figureId, name: entry.name })),
    };
  }));
  assert.deepEqual(outcomes.filter(({ committed, published, agreed }) =>
    committed === 'agree' || published === agreement.speech || agreed.length > 0), [],
  'name evidence alone cannot authorize publication or a ledger agreement');
});

const unboundName = '呼び名には鍵を提案します。';
const checkReferent: Turn[] = [
  { human: unboundName, local: [propose(unboundName, 'name_propose')], ...clarifyUnboundName },
  { ...locate, human: '呼び名を決める前に、形を照らし合わせたいです。',
    ai: [{ text: locate.speech, aspect: 'referent', act: 'ask', targets: [slot] }] },
];
const approvalRequest = `最初に出した「${name}」で決めてよさそうですか？`;
const proposedAgreement = { name, speech: 'では「鍵」にしましょう。' };

function referentResponse(text: string, act: 'agree' | 'deny'): Segment {
  return { text, aspect: 'referent', act,
    antecedent: c => c.speaker === 'ai' && c.aspect === 'referent' && c.act === 'ask' };
}

function checkReferentReply(response: Attempt, reply: Segment): void {
  const claims = response.input.priorClaims;
  assert.deepEqual(claims.find(c => c.act === 'name_propose' && c.name === name)?.targets, []);
  const selection = claims.find(c => c.speaker === 'ai' && c.aspect === 'referent' && c.act === 'ask');
  assert.ok(selection);
  assert.deepEqual(selection.targets, [slot]);
  const incoming = claims.find(c => c.sourceTurn === response.input.turn && c.quote === reply.text);
  assert.ok(incoming);
  assert.equal(incoming.aspect, 'referent');
  assert.equal(incoming.act, reply.act);
  assert.equal(incoming.respondsTo, selection.id);
  assert.deepEqual(incoming.targets, [slot]);
  assert.equal(incoming.name, null);
}

test('A2 change: a rejected figure cannot be named when the approval request is unchanged', async () => {
  const confirmed = referentResponse('探していたのは、今の説明の形です。', 'agree');
  const denied = referentResponse('今の説明は、私が指している形とは違います。', 'deny');
  const response = (reply: Segment, referent?: number): Turn => ({
    human: reply.text + approvalRequest, local: [reply, approvalQuestion(approvalRequest)],
    referent, ...clarifyUnboundName, agreeIfOffered: proposedAgreement,
  });
  const [initial, confirmation, adopted] = await sameScenario([...checkReferent, response(confirmed, 0)]);
  assert.equal(initial.saved.judgment.action, 'confirm');
  assert.equal(initial.saved.jevTurn.executed?.feature, alternateFeature);
  assert.deepEqual(initial.input.agreeNames, []);
  assert.equal(initial.state.ledger[slot].name, null);
  assert.equal(confirmation.saved.judgment.action, 'confirm');
  assert.deepEqual(confirmation.saved.jevTurn.executed?.target, { kind: 'single', figureId: slot });
  checkReferentReply(adopted, confirmed);
  assert.equal(adopted.input.humanReferent?.scores?.[slot], 1);
  assert.deepEqual(adopted.saved.jevTurn.executed?.target, { kind: 'single', figureId: slot });
  assert.equal(adopted.saved.judgment.action, 'agree');
  assert.equal(adopted.speech, proposedAgreement.speech);
  assert.equal(adopted.state.ledger[slot].status, 'agreed');
  assert.equal(adopted.state.ledger[slot].name, name);

  const outcomes = await Promise.all(strategies.map(async strategy => {
    const result = await lastAgreementAttempt(strategy, [...checkReferent, response(denied)]);
    checkReferentReply(result, denied);
    assert.equal(result.input.humanReferent?.scores?.none, 1);
    const question = result.input.priorClaims.find(c => c.sourceTurn === result.input.turn && c.quote === approvalRequest);
    assert.equal(question?.aspect, 'name');
    assert.equal(question?.act, 'name_propose');
    return {
      strategy,
      licensed: Object.hasOwn(actionOptions(result), 'agree'),
      committed: result.state.judgments.at(-1)?.judgment.action,
      published: result.trace.publicSpeech,
      agreed: Object.values(result.state.ledger).filter(entry => entry.status === 'agreed'),
    };
  }));
  assert.deepEqual(outcomes.filter(({ committed, published, agreed }) =>
    committed === 'agree' || published === proposedAgreement.speech || agreed.length > 0), [],
  'a referent denial must block agreement even though the request still names the same proposal');
});

test('A2 control: rejecting a different name does not reject the shared figure or the remaining proposal', async () => {
  const confirmed = referentResponse('探していたのは、今の説明の形です。', 'agree');
  const rejectedName = `その形を${publicAlias}と呼ぶ案には賛成できません。`;
  const alternative: Turn = {
    human: confirmed.text + priorPublicAlias.text, local: [confirmed, priorPublicAlias], ...ownFigure, action: 'propose_name',
    name: publicAlias, speech: `別案ですが、「${publicAlias}」と呼ぶのはどうでしょう？`,
  };
  const [, , proposed, adopted] = await sameScenario([...checkReferent, alternative, {
    human: rejectedName + approvalRequest,
    local: [{ text: rejectedName, aspect: 'name', act: 'name_reject', antecedent: fromAi('name_propose') },
      approvalQuestion(approvalRequest)],
    ...ownFigure, ...clarifyUnboundName, agreeIfOffered: proposedAgreement,
  }]);
  assert.ok(adopted.input.priorClaims.some(c => c.speaker === 'human' && c.aspect === 'referent' && c.act === 'agree' && c.targets.includes(slot)));
  const rejection = adopted.input.priorClaims.find(c => c.sourceTurn === adopted.input.turn && c.quote === rejectedName);
  assert.equal(rejection?.aspect, 'name');
  assert.equal(rejection?.act, 'name_reject');
  assert.deepEqual(proposed.state.ledger[slot], { status: 'tentative', name: publicAlias });
  assert.equal(rejection?.name, publicAlias);
  assert.deepEqual(rejection?.targets, [slot]);
  assert.equal(adopted.saved.judgment.action, 'agree');
  assert.equal(adopted.speech, proposedAgreement.speech);
  assert.equal(adopted.state.ledger[slot].status, 'agreed');
  assert.equal(adopted.state.ledger[slot].name, name);
});

const answerToPublicReferent = (claim: LocalClaimView) => claim.speaker === 'ai' && claim.aspect === 'referent' && claim.act === 'ask';
const earlierDenial = referentResponse('私が探しているのは、今挙げてもらった形ではありません。', 'deny');
const afterReferentDenial: Turn[] = [...checkReferent, {
  human: earlierDenial.text, local: [earlierDenial], action: 'accept', speech: '候補をもう少し絞りましょう。',
}];
const repeatApproval = '先ほどの「鍵」という呼び名を使うことには賛成ですか？';
const leaveOpen = alternateFeature + '形のことですか？';
const possibleFigure = 'その形も候補には入ると思います。';
const explicitAgreement = 'はい、確かめ直しました。その形で合っています。';

for (const { label, text, aspect, act, targets, referent, referentTie, adopt } of [
  { label: 'change (a) retains the rejected figure as one possibility',
    text: possibleFigure, aspect: 'referent', act: 'assert', targets: [slot] },
  { label: 'change (a) retains the denial even when a possibility names the unique referent estimate',
    text: possibleFigure, aspect: 'referent', act: 'assert', targets: [slot], referent: 0 },
  { label: 'change (b) narrows to two possibilities including the rejected figure',
    text: '見比べたところ、さっきの形か、輪に切れ目がある別の形のどちらかです。', aspect: 'referent', act: 'assert', targets: [slot, otherSlot] },
  { label: 'change (c) an assertion pointing to the same figure does not lift the denial',
    text: '確かめ直したら、指していたのはさっきの形でした。', aspect: 'referent', act: 'assert', targets: [slot], referent: 0 },
  { label: 'control (c) explicitly answers that the same figure is meant',
    text: explicitAgreement, aspect: 'referent', act: 'agree', targets: [slot], referent: 0, adopt: true },
  { label: 'control (c) explicit agreement still leaves a tied referent uncertain',
    text: explicitAgreement, aspect: 'referent', act: 'agree', targets: [slot], referent: 0, referentTie: 'multiple' },
  { label: 'control (d) asks about the figure',
    text: 'さっき挙げた形のことを聞いているんですか？', aspect: 'referent', act: 'ask', targets: [slot] },
  { label: 'control (d) acknowledges the question',
    text: 'ええ、質問は分かりました。', aspect: 'referent', act: 'acknowledge', targets: [slot] },
  { label: 'control (d) describes a feature of the figure',
    text: 'その形の棒は細いです。', aspect: 'part', act: 'assert', targets: [slot] },
] as const) {
  test('A2 after referent denial: ' + label, async () => {
    const antecedent = aspect === 'referent' ? answerToPublicReferent : undefined;
    const reply: Segment = { text, aspect, act, targets: [...targets], antecedent };
    const final: Turn = {
      human: reply.text + repeatApproval, local: [reply, approvalQuestion(repeatApproval)],
      referent, referentTie, action: 'confirm', target: 0, feature: alternateFeature, speech: leaveOpen,
      agreeIfOffered: proposedAgreement,
    };
    const pair = await Promise.all(strategies.map(strategy => replay(strategy, [...afterReferentDenial, final])));
    const [repair, bypass] = pair.map(turns => turns.at(-1)!);
    assert.deepEqual(repair.wire, bypass.wire);
    assert.deepEqual(repair.state.ledger, bypass.state.ledger);
    assert.equal(repair.speech, bypass.speech);
    await checkS4(repair, bypass);

    const outcomes = pair.map(([initial, confirmed, denied, last], i) => {
      assert.equal(initial.saved.judgment.action, 'confirm');
      assert.equal(initial.saved.jevTurn.executed?.feature, alternateFeature);
      assert.deepEqual(initial.input.agreeNames, []);
      assert.deepEqual(initial.state.ledger, initial.before.ledger);
      assert.equal(confirmed.saved.judgment.action, 'confirm');
      assert.deepEqual(confirmed.saved.jevTurn.executed?.target, { kind: 'single', figureId: slot });
      checkReferentReply(denied, earlierDenial);
      assert.deepEqual(denied.input.agreeNames, []);
      assert.equal(denied.state.ledger[slot].name, null);

      const claims = last.input.priorClaims;
      const publicQuestion = claims.find(answerToPublicReferent);
      const proposal = claims.find(c => c.speaker === 'human' && c.act === 'name_propose' && c.name === name);
      const incoming = claims.find(c => c.sourceTurn === last.input.turn && c.quote === reply.text);
      const approval = claims.find(c => c.sourceTurn === last.input.turn && c.quote === repeatApproval);
      assert.ok(publicQuestion && proposal && incoming && approval);
      assert.deepEqual(proposal.targets, []);
      assert.equal(approval.aspect, 'name');
      assert.equal(approval.act, 'name_propose');
      assert.equal(approval.name, proposal.name);
      assert.equal(approval.respondsTo, proposal.id);
      assert.equal(incoming.aspect, reply.aspect);
      assert.equal(incoming.act, reply.act);
      assert.deepEqual(incoming.targets, reply.targets);
      assert.equal(incoming.respondsTo, antecedent ? publicQuestion.id : null);
      const scores = last.input.humanReferent?.scores;
      assert.ok(scores);
      const highest = Math.max(...Object.values(scores));
      assert.deepEqual(Object.keys(scores).filter(id => scores[id] === highest),
        referentTie ? [slot, referentTie] : [referent === undefined ? 'none' : slot]);
      assert.equal(highest, referentTie ? 0.5 : 1);
      return {
        strategy: strategies[i], offered: Object.hasOwn(actionOptions(last), 'agree'),
        names: last.input.agreeNames,
        action: last.saved.judgment.action, speech: last.speech,
        feature: last.saved.jevTurn.executed?.feature,
        agreed: Object.entries(last.state.ledger).filter(([, entry]) => entry.status === 'agreed')
          .map(([figureId, entry]) => ({ figureId, name: entry.name })),
      };
    });
    assert.deepEqual(outcomes, strategies.map(strategy => ({
      strategy, offered: Boolean(adopt),
      names: adopt ? [{ name, figureId: slot, sourceTurn: repair.input.turn }] : [],
      action: adopt ? 'agree' : 'confirm',
      speech: adopt ? proposedAgreement.speech : leaveOpen,
      feature: adopt ? null : alternateFeature,
      agreed: adopt ? [{ figureId: slot, name }] : [],
    })));
  });
}

for (const multiple of [true, false]) {
  test('A2 after referent denial: a reply to a ' + (multiple ? 'two-figure question cannot' : 'single-figure question can') +
    ' authorize naming the previously denied figure', async () => {
    const question = multiple ? '輪に切れ目のある形と、輪に棒が接する形を見ています。どちらでしょう？'
      : '輪に切れ目がある形のことを指していますか？';
    const targets = multiple ? [slot, otherSlot] : [slot];
    const ask: Turn = {
      human: 'どの図形を見ているか、もう一度確かめてくれますか？',
      action: 'confirm', target: multiple ? 'figures_0_1' : 0, feature: alternateFeature, speech: question,
      ai: [{ text: question, aspect: 'referent', act: 'ask', targets }],
    };
    const text = 'はい、輪に切れ目のある形で合っています。';
    const reply: Turn = {
      human: text + repeatApproval,
      local: [{ text, act: 'agree', aspect: 'referent', targets: [slot],
        antecedent: claim => answerToPublicReferent(claim) && claim.proposition === question }, approvalQuestion(repeatApproval)],
      action: 'confirm', target: 0, referent: 0, feature, speech: locate.speech,
      agreeIfOffered: { ...proposedAgreement, figureIndex: 0 },
    };
    const runs = await Promise.all(strategies.map(strategy => replay(strategy, [...afterReferentDenial, ask, reply])));
    const [repair, bypass] = runs.map(run => run.at(-1)!);
    assert.deepEqual(repair.wire, bypass.wire);
    await checkS4(repair, bypass);
    const outcomes = runs.map(run => {
      const [denied, asked, last] = run.slice(-3);
      checkReferentReply(denied, earlierDenial);
      assert.deepEqual(asked.saved.jevTurn.executed?.target,
        multiple ? { kind: 'multiple', figureIds: targets } : { kind: 'single', figureId: slot });
      assert.deepEqual(asked.state.ledger, denied.state.ledger);
      const publicQuestion = last.input.priorClaims.find(claim => answerToPublicReferent(claim) && claim.quote === question);
      assert.ok(publicQuestion);
      assert.deepEqual(publicQuestion.targets, targets);
      const answer = last.input.priorClaims.find(claim => claim.quote === text);
      assert.equal(answer?.act, 'agree');
      assert.equal(answer?.respondsTo, publicQuestion.id);
      assert.deepEqual(answer?.targets, [slot]);
      assert.equal(last.input.humanReferent?.scores?.[slot], 1);
      return {
        nameOffered: last.input.agreeNames?.some(item => item.figureId === slot && item.name === name),
        action: last.saved.judgment.action, speech: last.speech, entry: last.state.ledger[slot],
      };
    });
    const expected = multiple
      ? { nameOffered: false, action: 'confirm', speech: locate.speech, entry: repair.before.ledger[slot] }
      : { nameOffered: true, action: 'agree', speech: proposedAgreement.speech, entry: { status: 'agreed', name } };
    assert.deepEqual(outcomes, [expected, expected]);
  });
}

const rejectedConstrual = 'フックのようには見えません。';
const construal: Turn = {
  ...locate, speech: 'フックのようにも見えます。' + locate.speech,
  ai: [{ text: 'フックのようにも見えます。', aspect: 'construal', act: 'construe', targets: [slot] }, ...locate.ai!],
};
const receiveDenial: Turn = {
  human: '形の特徴はまだ分かりません。' + rejectedConstrual,
  local: [{ text: rejectedConstrual, aspect: 'construal', act: 'deny', antecedent: fromAi('construe') }],
  action: 'accept', ...ownFigure, speech: 'フックには見えないんですね。',
};

function repairAfterDenial(action: 'confirm' | 'repair', human: string): Turn {
  const question = alternateFeature + '形ですか？';
  return {
    ...acknowledgment(human, 0), action, feature: alternateFeature, speech: '別の特徴で確かめます。' + question,
    ai: [{ text: question, act: 'ask', aspect: 'part', targets: [slot] }],
  };
}
test('B change: shared native criteria direct an unresolved backchannel toward grounded progress', async () => {
  const [, , reply] = await sameScenario([construal, receiveDenial, repairAfterDenial('confirm', 'うん')]);
  const criterion = actionOptions(reply).accept;
  assert.match(criterion, /直前のAI行動もacceptだった場合は、同じ受け止めを繰り返さない/u);
  assert.match(criterion, /観察に根拠のある別の説明や弁別特徴の確認/u);
  assert.match(criterion, /相槌は名称採用や対象同定の根拠にならない/u);
  assert.equal(reply.input.previousAction?.action, 'accept');
  assert.equal(reply.input.priorClaims.find(c => c.sourceTurn === reply.input.turn)?.act, 'acknowledge');
  assert.ok(reply.input.priorClaims.some(c => c.act === 'deny' && c.respondsTo !== null));
});

test('B control: “うん” can support actual naming, but a feature question and a backchannel supply no name evidence', async () => {
  const first: Turn = { ...locate, human: locate.human + priorPublicAlias.text, local: [priorPublicAlias],
    ai: [], action: 'propose_name', name: publicAlias, speech: `「${publicAlias}」と呼ぶのはどうでしょう？` };
  const response: Turn = { human: 'うん', local: [{ text: 'うん', aspect: 'name', act: 'name_accept', antecedent: fromAi('name_propose') }],
    action: 'agree', ...ownFigure, name: publicAlias, speech: `「${publicAlias}」にしましょう。` };
  const [proposed, named] = await sameScenario([first, response]);
  assert.deepEqual(proposed.input.agreeNames, []);
  assert.deepEqual(proposed.state.ledger[slot], { status: 'tentative', name: publicAlias });
  const claim = named.input.priorClaims.find(c => c.act === 'name_accept');
  assert.match(claim?.respondsTo ?? '', /:ai1$/u);
  assert.equal(named.state.ledger[slot].name, publicAlias);
  assert.equal(named.state.ledger[slot].status, 'agreed');

  const [, featureReply] = await sameScenario([locate, {
    ...acknowledgment('うん', 0),
    local: [{ text: 'うん', aspect: 'part', act: 'agree', antecedent: fromAi('ask') }],
  }]);
  const [, plainReply] = await sameScenario([acknowledgment('はい。'), acknowledgment('うん')]);
  for (const reply of [featureReply, plainReply]) {
    assert.deepEqual(reply.input.agreeNames, []);
    assert.equal(reply.state.ledger[slot].name, null);
    assert.equal(reply.input.priorClaims.find(c => c.sourceTurn === reply.input.turn)?.act, 'acknowledge');
  }
  assert.equal(featureReply.state.repairHistory[0]?.progress, 'unchanged');
  assert.deepEqual(plainReply.state.repairHistory, []);
  assert.equal(plainReply.saved.judgment.action, 'accept');
});
test('B control: confirm and repair can advance verified repair facts without converting a backchannel into agreement', async () => {
  for (const action of ['confirm', 'repair'] as const) {
    const answer = '輪には切れ目があります。';
    const [, before, repaired, clarified] = await sameScenario([
      construal, receiveDenial, repairAfterDenial(action, action === 'confirm' ? 'うん' : 'ええ'),
      { human: answer, local: [{ text: answer, aspect: 'part', act: 'assert', targets: [slot] }],
        ...ownFigure, action: 'accept', speech: '切れ目が見えるんですね。' },
    ]);
    assert.ok(before.input.priorClaims.some(c => c.act === 'deny' && c.respondsTo !== null));
    assert.equal(repaired.input.priorClaims.find(c => c.sourceTurn === repaired.input.turn)?.act, 'acknowledge');
    assert.equal(Object.hasOwn(actionOptions(repaired), 'agree'), false);
    assert.deepEqual(repaired.input.agreeNames, []);
    assert.ok(Object.hasOwn(actionOptions(repaired), action));
    assert.equal(repaired.saved.judgment.action, action);
    assert.equal(repaired.saved.jevTurn.executed?.feature, alternateFeature);
    assert.ok(repaired.speech.includes(alternateFeature));
    assert.deepEqual(repaired.state.ledger, before.state.ledger);
    assert.deepEqual(clarified.state.ledger, before.state.ledger);
    assert.equal(repaired.state.repairHistory.at(-1)?.question, alternateFeature);
    assert.equal(repaired.state.repairHistory.at(-1)?.progress, 'unknown');
    assert.equal(clarified.state.repairHistory.at(-1)?.progress, 'changed');
    assert.ok(clarified.state.repairHistory.at(-1)?.addedClaimIds.includes(
      clarified.input.priorClaims.find(c => c.quote === answer)?.id ?? 'missing'));
    assert.deepEqual(clarified.input.repairFacts?.map(f => f.turn), [before.state.repairHistory[0].turn, repaired.input.turn]);
    assert.equal(clarified.input.repairFacts?.at(-1)?.sameQuestionAsPrevious, false);
  }
});

test('strategy control: same action and target input; only repair-first vetoes native defer', async () => {
  const human = 'その形はまだ判断がつきません。';
  const turn: Turn = { human, action: 'defer', ...ownFigure, feature, alternatives: { confirm: 0.75 },
    speech: 'この図形は後で確かめましょう。' };
  const [[repair], [bypass]] = await Promise.all([
    replay('repair-first', [{ ...turn, speech: locate.speech }]), replay('bypass-enabled', [turn]),
  ]);
  assert.deepEqual(repair.wire.filter(p => !p.questions.feature), bypass.wire);
  assert.equal(repair.saved.jevTurn.decision.action, 'defer');
  assert.equal(bypass.saved.jevTurn.decision.action, 'defer');
  assert.equal(repair.saved.judgment.action, 'confirm');
  assert.equal(bypass.saved.judgment.action, 'defer');
  assert.equal(repair.state.repairHistory.at(-1)?.question, feature);
  assert.deepEqual(bypass.state.repairHistory, []);
});
