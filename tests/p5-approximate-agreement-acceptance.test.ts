// Synthetic transport responses exercise the real v3 path and S4 replay.
// Scripted choices test the available options and saved effects. Model selection
// and the naturalness of the generated response require a separate live check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import type { InterventionReplayTape } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { deriveLocalIssues, priorClaimViews } from '../dialogue-model/runtime/local-grounding/derive.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import type { ObservationInput } from '../dialogue-model/runtime/observation/contract.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { MODEL, normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const manifest = normal.run.manifest;
const profile: ReturnType<typeof researchTrialProfileV3> = JSON.parse(JSON.stringify(
  researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, 'two_stage_v3'),
));
const own: ObservationInput = { ownImage: { ...OWN.ownImage, mimeType: 'image/png' }, ownAnchors: OWN.ownAnchors };
const [figure, other] = own.ownAnchors.map(anchor => anchor.id);
const initial: InterventionReplayTape['state'] = OLD.state;

type ClaimChoice = Pick<LocalClaimView, 'id' | 'act' | 'aspect' | 'speaker' | 'proposition'>;
type Segment = {
  text: string;
  act: LocalAct;
  aspect: LocalSegmentProposal['aspect'];
  targets?: string[];
  name?: string;
  antecedent?: (claim: ClaimChoice) => boolean;
};
type Turn = {
  human: string;
  local?: Segment[];
  ai?: Segment[];
  action?: 'accept' | 'agree' | 'repair';
  target?: string;
  referent?: string;
  speech: string;
  adopt?: string;
  retry?: string;
};
type Event = InterventionReplayTape['events'][number];
type Material = InterventionReplayTape['common'];
type WireRequest = { provider: 'luna' | 'jev'; phase: string; body: { state?: string; questions?: Record<string, { criteria: Record<string, string> }>; messages?: unknown } };

function extraction(segments: Segment[] = []) {
  return JSON.stringify(segments.map((segment, index): LocalSegmentProposal => ({
    segmentId: String(index + 1), quote: segment.text, proposition: segment.text, targets: segment.targets ?? [],
    aspect: segment.aspect, name: segment.name ?? null, linkedIssueId: null, respondsToTurn: null,
  })));
}

async function play(strategy: Label, turns: Turn[]) {
  let current: Turn, phase: string, response: Material['luna'][number]['response'];
  let wire: WireRequest[], raw: Material, trace: JevTurnTrace;
  let cut: { luna: number; jev: number };
  let choiceId = 0;
  let adopted: string | null;
  let generationCount: number;
  const readKey = async () => 'sk-or-SYNTHETIC-offline-replay-key-0000';
  const http = createChatClient({
    provider: 'cloudflare', purpose: profile.modelPolicy.purpose, apiKey: 'synthetic-offline-replay-key',
    baseUrl: 'https://offline.invalid/v1', timeoutMs: profile.timeouts.lunaAttemptMs,
    maxCompletionTokens: profile.lunaRequest.maxCompletionTokens ?? undefined,
  }, async (_url, init) => {
    wire.push({ provider: 'luna', phase, body: JSON.parse(String(init?.body)) });
    return Response.json({ model: response.model, choices: [{ message: { content: response.text } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 } });
  });
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Required<Pick<WireRequest['body'], 'questions'>> & { model: string; state: string };
    const state = JSON.parse(body.state) as { aiSeq?: number; priorClaims?: ClaimChoice[] };
    const keys = Object.keys(body.questions);
    const phase = keys.includes('human_referent') ? 'human_referent' : keys.includes('repair_issue') ? 'repair_prospect'
      : keys.some(key => key.endsWith('_support')) ? 'ai_support'
      : keys.some(key => key.endsWith('_act')) ? state.aiSeq === undefined ? 'local_function' : 'ai_function' : 'decision';
    wire.push({ provider: 'jev', phase, body });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, { criteria }]) => {
      const labels = Object.keys(criteria);
      let choice = labels[0];
      if (key === 'action') choice = current.action ?? 'accept';
      if (key === 'target') choice = current.target ?? 'figure_0';
      if (key === 'human_referent') choice = current.referent ?? 'figure_0';
      if (key === 'repair_issue') choice = 'none';
      if (key === 'prospect') choice = 'no_open_issue';
      if (key === 'basis') choice = 'none';
      if (key === 'shared_construal') {
        choice = current.adopt && labels.includes('use_0') ? 'use_0' : 'none';
        adopted = choice === 'none' ? null : choice;
      }
      const localQuestion = /^segment_(\d+)_(act|antecedent|support)$/u.exec(key);
      if (localQuestion) {
        const ai = state.aiSeq !== undefined || localQuestion[2] === 'support';
        const segment = (ai ? current.ai : current.local)?.[Number(localQuestion[1])];
        assert.ok(segment, key);
        if (localQuestion[2] === 'act') choice = segment.act;
        if (localQuestion[2] === 'support') choice = segment.antecedent ? 'expressed_responds' : 'expressed';
        if (localQuestion[2] === 'antecedent') {
          const index = segment.antecedent ? state.priorClaims?.findIndex(segment.antecedent) ?? -1 : -1;
          if (segment.antecedent) assert.ok(index >= 0, segment.text);
          choice = index < 0 ? 'none' : 'claim_' + index;
        }
      }
      assert.ok(labels.includes(choice), key + ' did not offer ' + choice);
      const probabilities = Object.fromEntries(labels.map(label => [label, Number(label === choice)]));
      return [key, { type: 'choice', choice, probabilities }];
    }));
    const result = { model: body.model, id: 'gen-p5-' + ++choiceId, usage: { cost: 0 }, answers };
    raw.jev.push(result);
    return Response.json(result);
  };
  const transport = { enabled: true, readKey, fetchImpl, questionLayout: profile.questionLayout,
    researchLimits: { maxDeadlineMs: 600000 } };
  const decision = createJevDecisionClient({ ...transport, timeoutMs: profile.timeouts.decisionMs })!;
  const runtime = createProfileDialogue(profile, {
    strategy, technicalTrial, image: own.ownImage, anchors: [...own.ownAnchors],
    observer: {
      async observeAll() { return structuredClone(initial.observationMemo!); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: { async complete(messages: Parameters<typeof http.complete>[0], options: { phase: string; timeoutMs?: number }) {
      phase = options.phase;
      const text = phase === 'local_extraction' ? extraction(current.local)
        : phase === 'ai_extraction' ? extraction(current.ai)
        : generationCount++ > 0 && current.retry !== undefined ? current.retry
        : adopted && current.adopt ? current.adopt : current.speech;
      response = { text, model: 'synthetic-luna-model', usage: { inputTokens: 0, outputTokens: 0 } };
      raw.luna.push({ phase, response });
      return http.complete(messages, options);
    } },
    jevDecision: { ...decision, async decide(...args: Parameters<typeof decision.decide>) {
      const value = await decision.decide(...args);
      cut = { luna: raw.luna.length, jev: raw.jev.length };
      return value;
    } },
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs })!,
      aiPublicTransport: transport,
    },
    onJevTurnTrace(value: JevTurnTrace) { trace = structuredClone(value); },
  });

  let state = structuredClone(initial);
  const events: Event[] = [];
  const snapshots = [];
  for (const turn of turns) {
    current = turn;
    raw = { luna: [], jev: [], reobservations: [] };
    wire = [];
    adopted = null;
    generationCount = 0;
    const before = state;
    const seq = events.length + 1;
    const human = { id: 'human-' + seq, seq, speaker: 'human' as const, text: turn.human };
    events.push(human);
    const result = await runtime.runAiTurn({ events, privateState: before, lastEventId: human.id, requestSeq: human.seq });
    if (turn.retry === undefined) assert.deepEqual(trace!.generationGuard.violations, []);
    state = JSON.parse(JSON.stringify(result.privateState)) as InterventionReplayTape['state'];
    const judgment = state.judgments.at(-1)!;
    assert.equal(judgment.judgment.action, turn.action ?? 'accept');
    assert.equal(trace!.publicSpeech, result.text);
    if (turn.retry === undefined) assert.equal(result.text, adopted ? turn.adopt : turn.speech);
    const common = { luna: raw.luna.slice(0, cut!.luna), jev: raw.jev.slice(0, cut!.jev), reobservations: [] };
    const tail = { luna: raw.luna.slice(cut!.luna), jev: raw.jev.slice(cut!.jev), reobservations: [] };
    snapshots.push({ before, state, judgment, trace: { ...trace!, status: 'committed' as const }, wire, common, tail,
      events: structuredClone(events), speech: result.text as string });
    events.push({ id: 'ai-' + (seq + 1), seq: seq + 1, speaker: 'ai', text: result.text });
  }
  return snapshots;
}

type Snapshot = Awaited<ReturnType<typeof play>>[number];
async function paired(turns: Turn[]) {
  const [repair, bypass] = await Promise.all(strategies.map(strategy => play(strategy, turns)));
  for (const [index, left] of repair.entries()) {
    const right = bypass[index];
    assert.deepEqual(left.wire, right.wire, 'same model inputs and choice criteria');
    assert.deepEqual(left.trace.executed, right.trace.executed);
    assert.deepEqual(left.state.ledger, right.state.ledger);
    assert.deepEqual(left.state.graph, right.state.graph);
    assert.equal(left.speech, right.speech);
  }
  return { 'repair-first': repair, 'bypass-enabled': bypass };
}

async function checkS4(pair: Awaited<ReturnType<typeof paired>>, turn = -1) {
  const a = pair['repair-first'].at(turn)!;
  const b = pair['bypass-enabled'].at(turn)!;
  assert.deepEqual(a.common, b.common);
  const failures = [];
  for (const label of strategies) {
    const item = pair[label].at(turn)!;
    const tape: InterventionReplayTape = {
      schemaVersion: 'parity_intervention_replay_v1', state: item.before, events: item.events, technicalTrial, common: item.common,
      ...(item.trace.generationRetryVersion ? { generationRetryVersion: item.trace.generationRetryVersion } : {}),
      tails: { 'repair-first': a.tail, 'bypass-enabled': b.tail },
      recorded: { label, expectedRequests: item.wire.map(({ provider, phase, body }, index) => ({
        provider, phase, requestSha256: hash(body), actualSendMeasured: true, sendIds: [index + 1],
        ...(provider === 'luna' ? { messagesSha256: hash(body.messages) } : {}),
      })) },
    };
    const result = await pairedInterventionReplay(tape, own, MODEL, profile);
    assert.equal(result.status, 'same_material_intervention_verified', JSON.stringify({
      error: result.error, captured: item.wire.map(({ provider, phase }) => provider + '/' + phase),
      replayed: result.sides.map(side => side.requests.map(({ provider, phase }) => provider + '/' + phase)),
    }));
    const records = structuredClone(normal);
    const trial = records.trials[0];
    const profileSha256 = hash(profile);
    for (const data of [records.run, records.summary, trial]) Object.assign(data, { profile, profileSha256 });
    Object.assign(records.run.manifest, { profile, profileSha256, timeouts: profile.timeouts, lunaRequest: profile.lunaRequest });
    trial.identity.profile = profileSha256;
    trial.label = records.run.manifest.trials[0].label = records.summary.runOrder[0].label = label;
    const observed = result.sides.find(side => side.label === label)!;
    const seq = item.trace.turnIndex;
    trial.calls = observed.requests.map((request, index) => ({
      ...structuredClone(normal.trials[0].calls.find((call: { provider: string }) => call.provider === request.provider)),
      id: index + 1, sendIds: [index + 1], phase: request.phase, turn: seq,
      requestSha256: request.provider === 'luna' ? request.completeMessagesSha256 : request.preProjectionPayloadSha256,
      ...(request.provider === 'luna' ? { expectedHttpRequestSha256: request.preProjectionPayloadSha256,
        httpRequestSha256: request.preProjectionPayloadSha256 } : {}),
    }));
    trial.http = observed.requests.flatMap((request, index) => request.provider === 'luna' ? [{
      method: 'POST', kind: 'completion_post', phase: request.phase, callId: index + 1, sendId: index + 1,
      hashScheme: 'canonical_json_sha256', requestSha256: request.preProjectionPayloadSha256, status: 200, outcome: 'returned',
    }] : []);
    trial.attempts = [item.trace];
    trial.turns = [{ ...trial.turns[0], turn: seq, publicText: item.speech, trace: [item.trace], state: item.state }];
    trial.lastCommittedState = item.state;
    trial.replay = [{ tape, result }];
    records.evidence.pairedReplay = [{ trialOrder: 0, turn: seq, left: result.sides[0], right: result.sides[1] }];
    const checks = interventionChecks(JSON.parse(JSON.stringify(records)));
    for (const check of ['shape', 'binding', 'execution', 'replay']) {
      const observed = checks.find(result => result.id === 'intervention.trial.0.attempt.0.' + check);
      if (observed?.status !== 'pass') failures.push({ label, check, observed });
    }
  }
  assert.deepEqual(failures, []);
}

const broad = '全体は風車のように見えます。';
const coarseReply = '大まかには風車っぽいです。';
const detail = '輪の縁には細い切れ目が見えます。';
const detailQuestion = 'その切れ目が丸いかは、まだ分かりません。';
const adoption = '風車らしい形を目印に話を進められます。切れ目の形はまだ照合できていません。';
const neutral = '全体の見え方について聞かせてもらいました。';
const aiBroad = (claim: ClaimChoice) => claim.speaker === 'ai' && claim.aspect === 'construal' && claim.act === 'construe';
const aiDetail = (claim: ClaimChoice) => claim.speaker === 'ai' && claim.aspect === 'part' && claim.act === 'assert';
const humanCoarse = (claim: ClaimChoice) => claim.speaker === 'human' && claim.aspect === 'construal' && claim.act === 'agree';

function introducesConstrual(targets = [figure]): Turn {
  return { human: '形全体の見え方を教えてください。', speech: broad + detail,
    ai: [{ text: broad, aspect: 'construal', act: 'construe', targets },
      { text: detail, aspect: 'part', act: 'assert', targets }] };
}
function coarseAgreement(): Turn {
  return {
    human: coarseReply + detailQuestion,
    local: [
      { text: coarseReply, aspect: 'construal', act: 'agree', antecedent: aiBroad },
      { text: detailQuestion, aspect: 'part', act: 'ask', antecedent: aiDetail },
    ], speech: neutral, adopt: adoption,
  };
}
// This checkpoint exercises reuse after the reference claims have been committed.
const checkpoint: Turn = { human: 'この話を続けられそうですか？', speech: neutral };
const coarsePrefix = () => [introducesConstrual(), { ...coarseAgreement(), adopt: undefined }];
function questionOptions(turn: Snapshot, key: string) {
  return turn.wire.find(request => request.body.questions?.[key])?.body.questions?.[key].criteria;
}
function savedSources(turn: Snapshot): string[] | undefined {
  const saved = turn.judgment.jevTurn.executed ?? {};
  return Reflect.get(saved, 'sharedClaimIds') as string[] | undefined;
}
function unchangedLedger(turn: Snapshot) {
  assert.deepEqual(turn.state.ledger, turn.before.ledger);
}
function noAdoption(turn: Snapshot) {
  assert.equal(questionOptions(turn, 'shared_construal'), undefined);
  assert.equal(savedSources(turn), undefined);
  assert.equal(Reflect.get(turn.judgment.jevTurn, 'sharedConstruals'), undefined);
}
function chosenSharedConstrual(turn: Snapshot) {
  return turn.trace.decisions.at(-1)?.evidence.stages?.find(stage => stage.stage === 'detail')?.choices.shared_construal;
}
function checkedAdoption(turn: Snapshot) {
  assert.deepEqual(Object.keys(questionOptions(turn, 'shared_construal') ?? {}), ['none', 'use_0'],
    'a shared public construal offers a closed choice between acknowledgment and adoption');
  assert.equal(chosenSharedConstrual(turn), 'use_0');
  const actions = Object.keys(questionOptions(turn, 'action') ?? {}).sort();
  assert.deepEqual(actions, [
    'accept', 'close', 'confirm', 'defer', 'move_on', 'propose_name', 'repair', 'request_observation', 'revisit',
  ].sort());
  assert.equal(turn.judgment.judgment.action, 'accept');
  const claims = priorClaimViews(turn.state.graph);
  const fromAi = claims.find(aiBroad);
  const fromHuman = claims.find(humanCoarse);
  assert.ok(fromAi && fromHuman);
  assert.equal(fromAi.issueId, fromHuman.issueId);
  assert.equal(fromHuman.respondsTo, fromAi.id);
  assert.deepEqual([...savedSources(turn) ?? []].sort(), [fromAi.id, fromHuman.id].sort());
  assert.deepEqual(JSON.parse(questionOptions(turn, 'shared_construal')!.use_0), {
    claimIds: savedSources(turn), figureIds: [figure], construal: broad,
  });
  assert.deepEqual(Reflect.get(turn.trace.executed ?? {}, 'sharedClaimIds'), savedSources(turn));
  assert.doesNotMatch(turn.speech + JSON.stringify(turn.judgment), /\bP5\b/u);
  assert.equal(turn.speech, adoption);
  unchangedLedger(turn);
}

test('P5 change (1): adopt a shared coarse construal and leave the uncertain detail open', async () => {
  const pair = await paired([...coarsePrefix(), { ...checkpoint, adopt: adoption }]);
  await checkS4(pair);
  const adopted = pair['repair-first'].at(-1)!;
  checkedAdoption(adopted);
  const claims = priorClaimViews(adopted.state.graph);
  const detailClaim = claims.find(c => c.proposition === detailQuestion);
  const fine = deriveLocalIssues(adopted.state.graph).find(issue => issue.issueId === detailClaim?.issueId);
  assert.equal(fine?.aspect, 'part');
  assert.equal(fine?.state, 'unconfirmed');
  assert.ok(fine?.claimIds.every(id => !savedSources(adopted)?.includes(id)));
  const detailRequest = adopted.wire.find(request => request.body.questions?.shared_construal);
  const offered = JSON.parse(detailRequest!.body.state!).sharedConstruals;
  assert.equal(offered.length, 1);
  assert.deepEqual(Reflect.get(adopted.judgment.jevTurn, 'sharedConstruals'), offered);
  assert.ok(offered[0].openDetails.some((entry: { issueId: string; state: string }) =>
    entry.issueId === fine?.issueId && entry.state === 'unconfirmed'));
  assert.deepEqual(adopted.judgment.jevTurn.agreeNames, []);

  const ordinary = await paired([...coarsePrefix(), checkpoint]);
  const response = ordinary['repair-first'].at(-1)!;
  assert.ok(Object.hasOwn(questionOptions(response, 'shared_construal') ?? {}, 'none'));
  assert.equal(response.trace.decisions.at(-1)?.evidence.stages?.at(-1)?.choices.shared_construal, 'none');
  assert.equal(savedSources(response), undefined);
  assert.equal(response.speech, neutral);
  unchangedLedger(response);
  await checkS4(ordinary);
});

test('P5 control (2): different construals allow explicit naming of a confirmed figure', async () => {
  const known = '輪に棒がついた形を指しています。';
  const name = '印';
  const proposal = 'この図形は印と呼びませんか？';
  const pair = await paired([{
    human: '同じ形か先に確認させてください。', speech: known + broad,
    ai: [{ text: known, aspect: 'referent', act: 'assert', targets: [figure] },
      { text: broad, aspect: 'construal', act: 'construe', targets: [figure] }],
  }, {
    human: 'その輪のある形で合っています。私には紋章に見えます。' + proposal,
    speech: 'その形の呼び名の候補ですね。',
    local: [
      { text: 'その輪のある形で合っています。', aspect: 'referent', act: 'agree',
        antecedent: c => c.speaker === 'ai' && c.aspect === 'referent' },
      { text: '私には紋章に見えます。', aspect: 'construal', act: 'construe', targets: [figure] },
      { text: proposal, aspect: 'name', act: 'name_propose', name, targets: [figure] },
    ],
  }, { human: '先ほどの呼び名を使ってもよさそうですか？', action: 'agree', speech: 'では「印」と呼びましょう。' }]);
  const named = pair['repair-first'].at(-1)!;
  assert.equal(named.trace.executed?.action, 'agree');
  assert.deepEqual(named.trace.executed?.target, { kind: 'single', figureId: figure });
  assert.equal(named.trace.executed?.name, name);
  assert.equal(named.speech, 'では「印」と呼びましょう。');
  assert.deepEqual(named.state.ledger[figure], { status: 'agreed', name });
  assert.deepEqual(named.judgment.jevTurn.agreeNames, [{ figureId: figure, name, sourceTurn: 3 }]);
  assert.equal(Object.keys(questionOptions(named, 'name') ?? {}).length, 1);
  assert.equal(named.trace.decisions.at(-1)?.evidence.stages?.at(-1)?.choices.name, 'name_0');
  noAdoption(named);
  const construals = deriveLocalIssues(named.state.graph).filter(issue => issue.aspect === 'construal');
  assert.equal(construals.length, 2);
  assert.ok(construals.every(issue => issue.state === 'unconfirmed'));
  await checkS4(pair);
});

test('P5 control (3): a backchannel or a one-sided construal supplies no adoption choice', async () => {
  const ack = 'なるほど。';
  const oneSide = '全体が風車みたいに見えます。';
  for (const turns of [
    [introducesConstrual(), { human: ack, local: [{ text: ack, aspect: 'progress', act: 'acknowledge' }], speech: 'ええ。' }],
    [{ human: oneSide, local: [{ text: oneSide, aspect: 'construal', act: 'construe', targets: [figure] }], speech: '聞かせてくれてありがとうございます。' }],
  ] satisfies Turn[][]) {
    const pair = await paired([...turns, checkpoint]);
    const accepted = pair['repair-first'].at(-1)!;
    noAdoption(pair['repair-first'].at(-2)!);
    noAdoption(accepted);
    unchangedLedger(accepted);
    assert.deepEqual(accepted.judgment.jevTurn.agreeNames, []);
    const claims = priorClaimViews(accepted.state.graph).filter(c => c.aspect === 'construal');
    assert.equal(new Set(claims.map(c => c.speaker)).size, 1);
    await checkS4(pair);
  }
});

for (const [act, text] of [
  ['ask', 'どんなところから風車を連想したんですか？'],
  ['construe', '私は帆船のように見えます。'],
] as const) {
  test('P5 audit (1) change: no shared evidence from a reply classified as ' + act, async () => {
    const reply: Turn = { human: text, local: [{ text, act, aspect: 'construal', antecedent: aiBroad }],
      speech: neutral, adopt: adoption };
    const pair = await paired([introducesConstrual(), reply, { ...checkpoint, adopt: adoption }]);
    const [, immediate, later] = pair['repair-first'];
    const claims = priorClaimViews(immediate.state.graph);
    const human = claims.find(claim => claim.speaker === 'human' && claim.quote === text);
    const ai = claims.find(aiBroad);
    assert.ok(human && ai);
    assert.equal(human.act, act);
    assert.equal(human.issueId, ai.issueId);
    assert.equal(human.respondsTo, ai.id);
    for (const turn of [immediate, later]) {
      noAdoption(turn);
      assert.equal(turn.speech, neutral);
      unchangedLedger(turn);
    }
    await checkS4(pair, 1);
    await checkS4(pair);
  });
}

test('P5 audit (2) change: support scoped to the first figure cannot be used on the second', async () => {
  const supported = '輪のあるほうなら、ざっくり風車に見えます。';
  const askOther = 'もう一つの形についてはどう見えますか？';
  const pair = await paired([introducesConstrual([figure, other]), {
    human: supported + 'もう一方はまだ判断できません。',
    local: [{ text: supported, aspect: 'construal', act: 'agree', targets: [figure], antecedent: aiBroad }], speech: neutral,
  }, {
    human: askOther, local: [{ text: askOther, aspect: 'referent', act: 'ask', targets: [other] }],
    target: 'figure_1', referent: 'figure_1', speech: neutral, adopt: 'こちらも風車らしさを目印に進めましょう。',
  }]);
  const later = pair['repair-first'].at(-1)!;
  const claims = priorClaimViews(later.state.graph);
  assert.deepEqual(claims.find(aiBroad)?.targets, [figure, other]);
  assert.deepEqual(claims.find(humanCoarse)?.targets, [figure]);
  assert.deepEqual(later.trace.executed?.target, { kind: 'single', figureId: other });
  assert.equal(questionOptions(later, 'shared_construal'), undefined);
  assert.equal(savedSources(later), undefined);
  assert.equal(later.speech, neutral);
  unchangedLedger(later);
  await checkS4(pair);
});

const bothLookAlike = 'どちらも風車っぽく見えます。';
const ambiguous = 'どちらを指すかは、これだけでは決められません。';
const twoFigures = { target: 'figures_0_1', referent: 'multiple' } as const;
const twoAdoption = '風車らしさは共通の目印にできます。' + ambiguous;
function twoFigurePrefix(): Turn[] {
  return [{ ...introducesConstrual([figure, other]), ...twoFigures }, {
    human: bothLookAlike, local: [{ text: bothLookAlike, aspect: 'construal', act: 'agree', antecedent: aiBroad }],
    speech: ambiguous, ...twoFigures,
  }];
}

test('P5 control (4): two figures sharing a description do not become a single named referent', async () => {
  const pair = await paired([...twoFigurePrefix(), { ...checkpoint, speech: ambiguous, adopt: twoAdoption, ...twoFigures }]);
  const response = pair['repair-first'].at(-1)!;
  assert.deepEqual(response.trace.executed?.target, { kind: 'multiple', figureIds: [figure, other] });
  assert.equal(response.speech, twoAdoption);
  assert.deepEqual(response.judgment.jevTurn.agreeNames, []);
  assert.equal(chosenSharedConstrual(response), 'use_0');
  const chosen = priorClaimViews(response.state.graph).filter(c => savedSources(response)?.includes(c.id));
  assert.deepEqual(chosen.map(claim => claim.speaker).sort(), ['ai', 'human']);
  assert.ok(chosen.every(claim => claim.targets.includes(figure) && claim.targets.includes(other)));
  assert.deepEqual(JSON.parse(questionOptions(response, 'shared_construal')!.use_0).figureIds, [figure, other]);
  unchangedLedger(response);
  await checkS4(pair);
});

test('P5 audit (3) change: selecting use and publishing only a backchannel records no adoption', async () => {
  const ack = 'なるほど。';
  const pair = await paired([...coarsePrefix(), { ...checkpoint, adopt: ack, retry: ack }]);
  const turn = pair['repair-first'].at(-1)!;
  assert.equal(chosenSharedConstrual(turn), 'use_0');
  assert.equal(turn.speech, ack);
  assert.equal(savedSources(turn), undefined);
  assert.equal(Reflect.get(turn.trace.executed ?? {}, 'sharedClaimIds'), undefined);
  unchangedLedger(turn);
  await checkS4(pair);
});

test('P5 audit (3) change: the orientation fallback does not record the selected adoption', async () => {
  const draft = '風車らしさを目印に進めましょう。輪の右側に切れ目があるかは、まだ分かりません。';
  const pair = await paired([...coarsePrefix(), { ...checkpoint, adopt: draft, retry: draft }]);
  const turn = pair['repair-first'].at(-1)!;
  assert.equal(chosenSharedConstrual(turn), 'use_0');
  assert.deepEqual(turn.trace.generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
  assert.doesNotMatch(turn.speech, /風車|右側/u);
  assert.equal(savedSources(turn), undefined);
  assert.equal(Reflect.get(turn.trace.executed ?? {}, 'sharedClaimIds'), undefined);
  unchangedLedger(turn);
  await checkS4(pair);
});

for (const [kind, draft] of [
  ['identity', '風車らしさを目印に話せます。これで同じ一つの図形だと分かりました。'],
  ['detail', '風車らしさを目印に話せます。輪の切れ目まで同じだと確認できました。'],
] as const) {
  test('P5 audit (3) change: the public reply does not settle unverified ' + kind, async () => {
    const ready = kind === 'identity' ? twoFigurePrefix() : coarsePrefix();
    const scope = kind === 'identity' ? { referent: 'multiple' } : {};
    const corrected = kind === 'identity' ? twoAdoption : adoption;
    const pair = await paired([...ready, { ...checkpoint, ...scope, adopt: draft, retry: corrected }]);
    const turn = pair['repair-first'].at(-1)!;
    assert.equal(chosenSharedConstrual(turn), 'use_0');
    assert.equal(turn.speech, corrected);
    assert.equal(turn.trace.generationGuard.regenerated, true);
    unchangedLedger(turn);
    await checkS4(pair);
  });
}

test('P5 audit (4) change: S4 verifies an adoption on the turn that supplies the human agreement', async () => {
  const pair = await paired([introducesConstrual(), coarseAgreement()]);
  const turn = pair['repair-first'].at(-1)!;
  assert.equal(turn.trace.turnIndex, 3);
  checkedAdoption(turn);
  const newSupport = priorClaimViews(turn.state.graph).find(humanCoarse);
  assert.equal(newSupport?.sourceTurn, turn.trace.turnIndex);
  assert.ok(!priorClaimViews(turn.before.graph).some(humanCoarse));
  await checkS4(pair);
});

const denied = '全体を風車として見ると、部品のつながりが説明できません。';
const deny: Segment = { text: denied, aspect: 'construal', act: 'deny', antecedent: aiBroad };

test('P5 control (5): a contested construal remains unresolved and has no adoption choice', async () => {
  const pair = await paired([...coarsePrefix(), {
    human: denied, local: [deny], speech: 'つながりについて確認が必要ですね。',
  }, checkpoint]);
  const contested = pair['repair-first'].at(-1)!;
  noAdoption(pair['repair-first'].at(-2)!);
  const claims = priorClaimViews(contested.state.graph);
  const disagreement = claims.find(c => c.act === 'deny');
  const issue = deriveLocalIssues(contested.state.graph).find(issue => issue.issueId === disagreement?.issueId);
  assert.equal(disagreement?.aspect, 'construal');
  assert.equal(issue?.state, 'contested');
  noAdoption(contested);
  unchangedLedger(contested);
  await checkS4(pair);
});

test('P5 control (6): explicit denial or withdrawal cannot supply current shared evidence', async () => {
  const withdrawal = 'さっき風車っぽいと言いましたが、その見立ては取り消します。';
  const retract: Segment = { text: withdrawal, aspect: 'construal', act: 'withdraw', antecedent: humanCoarse };
  for (const [reply, prefix, expected] of [
    [deny, [introducesConstrual()], 'denied'],
    [retract, coarsePrefix(), 'unconfirmed'],
  ] as const) {
    const pair = await paired([...prefix, { human: reply.text, local: [reply], speech: '見え方をもう一度考えたいですね。' }, checkpoint]);
    const after = pair['repair-first'].at(-1)!;
    noAdoption(pair['repair-first'].at(-2)!);
    const claims = priorClaimViews(after.state.graph);
    const original = claims.find(aiBroad);
    assert.ok(original);
    assert.ok(claims.some(c => c.act === reply.act && c.proposition === reply.text));
    assert.equal(deriveLocalIssues(after.state.graph).find(issue => issue.issueId === original.issueId)?.state, expected);
    if (reply.act === 'withdraw') assert.ok(!claims.some(humanCoarse));
    noAdoption(after);
    unchangedLedger(after);
    await checkS4(pair);
  }
});

test('P5 change (7): a shared reference can carry the exchange forward and a later denial can reopen repair', async () => {
  const moveForward = '風車に見えるほうを目印にして話を続けます。';
  const pair = await paired([...coarsePrefix(), { ...checkpoint, adopt: adoption }, {
    human: '大まかな目印は分かりました。', speech: moveForward,
  }, {
    human: denied, local: [deny], speech: 'つながりについて確認が必要ですね。',
  }, {
    human: 'その違いを確認してもらえますか？', action: 'repair', speech: '部品のつながりを改めて確かめたいです。',
  }, {
    human: 'その点はまだ確認できません。', speech: 'まだ照合中ですね。',
  }]);
  const [, , adopted, continuation, denial, repair, after] = pair['repair-first'];
  await checkS4(pair, 2);
  await checkS4(pair, 5);
  await checkS4(pair);
  checkedAdoption(adopted);
  assert.equal(continuation.speech, moveForward);
  assert.equal(continuation.judgment.judgment.action, 'accept');
  assert.equal(savedSources(continuation), undefined);
  noAdoption(denial);
  assert.equal(repair.judgment.judgment.action, 'repair');
  assert.ok(Object.hasOwn(questionOptions(repair, 'action') ?? {}, 'repair'));
  assert.ok(questionOptions(repair, 'feature'));
  assert.equal(repair.state.repairHistory.at(-1)?.action, 'repair');
  const rejected = priorClaimViews(repair.state.graph).find(c => c.act === 'deny');
  assert.ok(rejected);
  assert.equal(deriveLocalIssues(repair.state.graph).find(issue => issue.issueId === rejected.issueId)?.state, 'contested');
  noAdoption(after);
  for (const turn of [continuation, denial, repair, after]) unchangedLedger(turn);
});
