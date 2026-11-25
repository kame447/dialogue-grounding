// Independent acceptance for Neon 11 B2 and B3. All dialogue and transport
// material is synthetic. The actual runtime and serializers run offline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import type { DialoguePolicy, JevAction } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { ReplayTape } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { LocalAct, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { priorClaimViews } from '../dialogue-model/runtime/local-grounding/derive.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const manifest = normal.run.manifest;
const makeProfile = (policy: DialoguePolicy) =>
  researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, 'two_stage_v3', policy);
type Profile = ReturnType<typeof makeProfile>;
type Event = ReplayTape['events'][number];
type Checkpoint = { events: Event[]; state: ReplayTape['state'] };
type Message = { readonly role: string; readonly content: unknown };
type Segment = Omit<LocalSegmentProposal, 'segmentId' | 'quote' | 'proposition' | 'linkedIssueId' | 'respondsToTurn'> & {
  act: LocalAct;
  proposition: string;
  antecedent?: string;
  respondsToTurn?: number;
};
type Turn = {
  human: string;
  drafts: readonly string[];
  action: JevAction;
  target: string;
  referent?: string;
  feature?: string;
  local?: Segment;
};
const slots = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id) as string[];
const askedFeature = '楕円の穴が一つある';
const otherFeature = '細い枝が丸い台につながる';
const agreed = '弦しおり';
const tentative = '笠の飾り札';
const deferred = '木の雫札';
const sha256 = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

function start(): Checkpoint {
  const state = structuredClone(OLD.state) as ReplayTape['state'];
  const memo = state.observationMemo;
  assert.ok(memo);
  for (const index of [0, 1]) {
    memo.figures[index].analytic.shapes = [askedFeature, otherFeature];
  }
  return { state, events: [] };
}

function dialogue(profile: Profile, strategy: Label, checkpoint = start()) {
  let turn: Turn;
  let { state, events } = structuredClone(checkpoint);
  let trace: JevTurnTrace | undefined;
  let badMock: unknown;
  let count = 0;
  let nextLuna: { phase: string; text: string };
  let sends: { phase: string; raw: string }[];
  let requests: JevDecisionPayload[];
  let generation: Message[][] = [];
  const modelId = 'synthetic-luna-model';
  const memo = checkpoint.state.observationMemo;
  assert.ok(memo);

  const client = createChatClient({
    provider: 'cloudflare', purpose: profile.modelPolicy.purpose, baseUrl: 'https://offline.invalid/v1',
    apiKey: 'synthetic-neon-acceptance', timeoutMs: profile.timeouts.lunaAttemptMs,
    maxCompletionTokens: profile.lunaRequest.maxCompletionTokens ?? undefined,
  }, async (_url, init) => {
    const raw = String(init?.body);
    sends.push({ phase: nextLuna.phase, raw });
    if (nextLuna.phase === 'generation') generation.push(JSON.parse(raw).messages as Message[]);
    return Response.json({ model: modelId, choices: [{ message: { content: nextLuna.text } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 } });
  });

  const transport = {
    enabled: true, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    researchLimits: { maxDeadlineMs: 600000 }, readKey: async () => 'sk-or-synthetic-neon-acceptance-0000',
    async fetchImpl(_url: string, init: RequestInit) {
      try {
        const raw = String(init.body);
        const body = JSON.parse(raw) as JevDecisionPayload;
        requests.push(body);
        sends.push({ phase: Object.keys(body.questions).join(','), raw });
        const answers = Object.fromEntries(Object.entries(body.questions).map(([key, { criteria }]) => {
          const labels = Object.keys(criteria);
          let choice: string | undefined;
          if (key === 'human_referent') choice = turn.referent ?? (turn.target.startsWith('figures_') ? 'multiple' : turn.target);
          if (key === 'action') choice = turn.action;
          if (key === 'target') choice = turn.target;
          if (key === 'repair_issue' || key === 'basis') choice = 'none';
          if (key === 'prospect') choice = 'no_open_issue';
          if (key === 'feature' || key === 'name') {
            const expected = key === 'feature' ? turn.feature : turn.local?.name;
            choice = labels.find(label => JSON.parse(criteria[label]).value === expected);
          }
          if (key === 'segment_0_act') choice = turn.local?.act;
          if (key === 'segment_0_antecedent') {
            const antecedent = turn.local?.antecedent;
            choice = antecedent ? labels.find(label => criteria[label].includes(JSON.stringify(antecedent))) : 'none';
          }
          if (key === 'draft_naming') {
            choice = turn.action === 'agree' ? 'adopt_chosen' : turn.action === 'propose_name' ? 'propose_question' : 'none';
          }
          assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice + ' in ' + turn.human);
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
            labels.map(label => [label, Number(label === choice)]),
          ) }];
        }));
        return Response.json({ model: body.model, id: 'gen-neon-' + ++count, usage: { cost: 0 }, answers });
      } catch (error) {
        badMock = error;
        throw error;
      }
    },
  };

  const runtime = createProfileDialogue(profile, {
    strategy, technicalTrial: { version: 'adaptive_repair_v3' },
    image: OWN.ownImage, anchors: [...OWN.ownAnchors],
    observer: {
      async observeAll() { return structuredClone(memo); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: {
      async complete(messages: Parameters<typeof client.complete>[0], options: { phase: string; timeoutMs?: number }) {
        const { phase } = options;
        let text: string;
        if (phase === 'local_extraction') {
          const segment = turn.local;
          text = JSON.stringify(segment ? [{
            segmentId: '1', quote: turn.human, proposition: segment.proposition, aspect: segment.aspect,
            targets: segment.targets, name: segment.name, linkedIssueId: null, respondsToTurn: segment.respondsToTurn ?? null,
          } satisfies LocalSegmentProposal] : []);
        } else if (phase === 'ai_extraction') text = '[]';
        else {
          assert.equal(phase, 'generation');
          assert.ok(turn.drafts[generation.length], 'unexpected generation request');
          text = turn.drafts[generation.length];
        }
        nextLuna = { phase, text };
        return client.complete(messages, options);
      },
    },
    jevDecision: createJevDecisionClient(transport)!,
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy })!,
      aiPublicTransport: transport,
    },
    onJevTurnTrace(record: JevTurnTrace) { trace = record; },
  });
  if (profile.dialoguePolicy === 'holistic_v5' && events.length === 0) {
    state = { ...runtime.initialPrivateState(), observationMemo: memo };
  }
  return {
    checkpoint: () => structuredClone({ events, state }),
    async say(plan: Turn) {
      turn = plan;
      trace = undefined; badMock = undefined; sends = []; requests = []; generation = [];
      const seq = events.length + 1;
      const humanEvent: Event = { id: 'synthetic-human-' + seq, seq, speaker: 'human', text: turn.human };
      events = [...events, humanEvent];
      const result = await runtime.runAiTurn({ events, privateState: state, lastEventId: humanEvent.id, requestSeq: seq })
        .catch((error: unknown) => { throw badMock ?? error; });
      if (badMock) throw badMock;
      const captured = trace as JevTurnTrace | undefined;
      assert.ok(captured);
      assert.equal(captured.executed?.action, plan.action);
      assert.equal(result.text, plan.drafts.at(-1), 'only the scripted model response should publish');
      assert.equal(captured.publicSpeech, result.text);
      state = result.privateState as ReplayTape['state'];
      events = [...events, { id: 'synthetic-ai-' + (seq + 1), seq: seq + 1, speaker: 'ai', text: result.text }];
      return { state, trace: captured, generation, sends, requests, text: result.text as string, events: structuredClone(events) };
    },
  };
}

const accept = (human: string, speech: string, target = 'none'): Turn => ({ human, drafts: [speech], action: 'accept', target });
function nameSlot(index: number, name: string, action: 'agree' | 'propose_name'): Turn {
  const direct = action === 'agree';
  return {
    human: direct ? 'この弧のある形は「' + name + '」と呼びませんか？' : '手元のメモでこの形には「' + name + '」とあります。',
    action, target: 'figure_' + index,
    local: { aspect: 'name', act: direct ? 'name_propose' : 'assert', targets: [slots[index]], name, proposition: '呼び名は' + name },
    drafts: [direct ? 'この形を「' + name + '」と呼びましょう。' : 'この形を「' + name + '」と呼ぶのはどうですか？'],
  };
}

async function longHistory(profile: Profile) {
  // An executed defer is valid evidence from the bypass condition. Feed that
  // one saved history to both conditions to compare the subsequent input.
  const trial = dialogue(profile, 'bypass-enabled');
  if (profile.dialoguePolicy === 'holistic_v5') {
    const human = '指しているのは、楕円の穴が一つある方の形です。';
    await trial.say({
      ...accept(human, '楕円の穴が一つある方ですね。', 'figure_0'),
      local: { aspect: 'referent', act: 'assert', targets: [slots[0]], name: null, proposition: human },
    });
  }
  await trial.say(nameSlot(0, agreed, 'agree'));
  await trial.say(nameSlot(1, tentative, 'propose_name'));
  await trial.say(nameSlot(2, deferred, 'propose_name'));
  await trial.say({
    human: 'その形は見分ける手掛かりをもう少し考えてみます。',
    drafts: ['その形はあとで確かめましょう。'], action: 'defer', target: 'figure_2',
  });
  for (const clue of ['縁の形', '継ぎ目', '欠けている所', '輪の厚さ', '弧の長さ', '切り口', '曲線', 'くぼみの幅',
    'まとまり方', '太さの差', '細い部分', '広がり', '接し方', '部品の数', '縁の丸み', '輪郭全体']) {
    await trial.say(accept('輪のある形は' + clue + 'も目印になりそうです。', clue + 'も手掛かりになりますね。', 'figure_3'));
  }
  const checkpoint = trial.checkpoint();
  assert.ok(checkpoint.events.length > 32);
  assert.deepEqual(slots.map(id => checkpoint.state.ledger[id]), [
    { status: 'agreed', name: agreed }, { status: 'tentative', name: tentative }, { status: 'deferred', name: deferred },
    ...Array.from({ length: 3 }, () => ({ status: 'unassigned', name: null })),
  ]);
  return checkpoint;
}

const histories = new Map<DialoguePolicy, Promise<Checkpoint>>();
function history(policy: DialoguePolicy) {
  if (!histories.has(policy)) histories.set(policy, longHistory(makeProfile(policy)));
  return histories.get(policy)!;
}
const counts = accept('決まっていない形は、あといくつありますか？', '呼び名がまだ決まっていない形は五つです。');
const rest = accept('残っている図形を、どれか分かるように説明してもらえますか？', '丸い穴がある形や、短い枝がついている形が残っています。');
const finished = accept('これで呼び名は全部決まりましたか？', 'まだ決まっていない形があります。');
const inquiries = [['remaining count', counts], ['remaining figures', rest], ['completion check', finished]] as const;

type Outcome = Awaited<ReturnType<ReturnType<typeof dialogue>['say']>>;

function* ledgerRows(value: unknown, key: string | null = null): Generator<{ key: string | null; cells: unknown[] }> {
  if (!value || typeof value !== 'object') return;
  const children = Object.entries(value);
  yield { key, cells: children.map(([, child]) => child) };
  for (const [childKey, child] of children) yield* ledgerRows(child, Array.isArray(value) ? null : childKey);
}

const statusLabels: Record<string, readonly string[]> = {
  agreed: ['agreed', '合意', '合意済み', '確定', '確定済み'],
  tentative: ['tentative', '暫定', '仮名', '仮の名前', '提案中'],
  deferred: ['deferred', '保留', '保留中'],
  unassigned: ['unassigned', '未命名', '未割当', '未設定', '名前未設定'],
};

function includesPrivateEntry(messages: readonly Message[], index: number, state: { status: string; name: string | null }) {
  const figure = [slots[index], 'f' + index, 'figure_' + index];
  const statuses = statusLabels[state.status];
  const noName = [null, '', '名前なし', '未命名', '未設定'];
  const hasValue = (cell: unknown) => state.name === null ? noName.includes(cell as string | null) : cell === state.name;
  for (const message of messages) {
    if (message.role !== 'system') continue;
    const lines = typeof message.content === 'string' ? message.content.split('\n') : [];
    const records: unknown[] = [message.content];
    const serialized = typeof message.content === 'string' ? [message.content, ...lines] : [];
    for (const text of serialized) {
      const json = text.search(/[\[{]/u);
      if (json >= 0) {
        try { records.push(JSON.parse(text.slice(json))); } catch { /* non-JSON system text */ }
      }
    }
    for (const line of lines) {
      // A human-readable ledger may expose the association as one line per figure.
      const tokens = line.split(/[\s:=：、,「」［］【】〔〕|（）」]+/u);
      if (figure.some(id => tokens.includes(id)) && statuses.some(status => tokens.includes(status)) &&
        (state.name === null ? /null|名前なし|名前未設定|未命名/u.test(line) : line.includes(state.name))) return true;
    }
    for (const record of records) {
      for (const { key, cells } of ledgerRows(record)) {
        if ([key, ...cells].some(cell => typeof cell === 'string' && figure.includes(cell)) &&
          statuses.some(status => cells.includes(status)) && cells.some(hasValue)) return true;
      }
    }
  }
  return false;
}

function assertNoPublicIds(text: string) {
  for (const id of slots) assert.ok(!text.includes(id), 'a published message must not contain an internal figure ID');
}

const late = new Map<Label, Promise<{ checkpoint: Checkpoint; results: Outcome[]; leakedDraft: string }>>();
function inquiriesFor(strategy: Label) {
  if (!late.has(strategy)) {
    late.set(strategy, (async () => {
      const checkpoint = await history('holistic_v5');
      const profile = makeProfile('holistic_v5');
      const leakedDraft = '切れ目がある形は ' + slots[1] + ' です。';
      const results = await Promise.all(inquiries.map(([, turn]) => dialogue(profile, strategy, checkpoint).say(
        turn === rest ? { ...turn, drafts: [leakedDraft, ...turn.drafts] } : turn,
      )));
      return { checkpoint, results, leakedDraft };
    })());
  }
  return late.get(strategy)!;
}

function confirm(human: string, speech: string, target: string, feature: string, local?: Segment): Turn {
  return { human, drafts: [speech], action: 'confirm', target, feature, local };
}
const initialQuestion = '楕円の穴が一つある形のことですか？';
const firstAnswer = 'はい、一つだけ楕円の穴がある形です。';
const answer: Segment = { aspect: 'part', name: null, act: 'assert', targets: [slots[0]], proposition: '楕円の穴が一つある' };
const anotherQuestion = '細い枝が丸い台につながっている形ですか？';

function features(turn: Outcome) {
  const offered = turn.requests.find(request => request.questions.feature)?.questions.feature.criteria;
  assert.ok(offered, 'a model must choose the feature from the actual detail request');
  return Object.values(offered).map(value => (JSON.parse(value) as { value: string }).value);
}

async function priorCheck(strategy: Label, target: string) {
  const trial = dialogue(makeProfile('holistic_v5'), strategy);
  const first = await trial.say(confirm('似ている形があって、穴を手掛かりにしたいです。', initialQuestion, target, askedFeature));
  assert.ok(features(first).includes(askedFeature));
  assert.equal(first.trace.executed?.feature, askedFeature);
  if (target === 'figures_0_1') {
    assert.deepEqual(first.trace.executed?.target, { kind: 'multiple', figureIds: slots.slice(0, 2) });
  }
  return { trial, first };
}
function checkAnswered(before: Outcome, after: Outcome) {
  const claim = priorClaimViews(after.state.graph).find(item => item.speaker === 'human' && item.quote === firstAnswer);
  assert.ok(claim, 'the explicit answer must produce a verified claim');
  assert.deepEqual(claim.targets, [slots[0]]);
  const checked = after.trace.repairHistory.find(entry => entry.turn === before.trace.turnIndex);
  assert.ok(checked?.partnerClaims.some(reply => reply.id === claim.id), 'the answer must be linked to the earlier feature check');
}

function instruction(turn: Outcome, phase: 'human_referent' | 'action') {
  const question = turn.requests.find(request => request.questions[phase])?.questions[phase];
  assert.ok(question);
  return question.instructions;
}

for (const strategy of strategies) {
  for (const [index, [scenario]] of inquiries.entries()) {
    test(strategy + ' sends the full private ledger to generation for ' + scenario, async () => {
      const { checkpoint, results } = await inquiriesFor(strategy);
      const item = results[index];
      assert.ok(checkpoint.events.length > 32);
      assert.deepEqual(item.state.ledger, checkpoint.state.ledger);
      assert.ok(item.generation.length > 0);
      for (const attempt of item.generation) {
        for (const [slot, id] of slots.entries()) {
          assert.ok(includesPrivateEntry(attempt, slot, checkpoint.state.ledger[id]),
            'generation omitted the private status and name for figure ' + slot);
        }
      }
      // The provider's user role may also carry private observation context.
      // The participant transcript is made from public events, including the new reply.
      assert.equal(item.events.at(-1)?.text, item.text);
      for (const event of item.events) assertNoPublicIds(event.text);
    });
  }

  test(strategy + ' rewrites a generation draft that includes a real internal figure ID', async () => {
    const { checkpoint, results, leakedDraft } = await inquiriesFor(strategy);
    const listed = results[1];
    assert.equal(listed.generation.length, 2);
    assert.equal(listed.trace.generationGuard.regenerated, true);
    assert.equal(listed.trace.generationGuard.fallback, false);
    assert.ok(listed.trace.generationGuard.violations.includes('internal_id'));
    assert.equal(listed.text, rest.drafts[0]);
    assertNoPublicIds(listed.text);
    assert.ok(!listed.events.some(event => event.text === leakedDraft));
    assert.deepEqual(listed.state.ledger, checkpoint.state.ledger);
  });

  test(strategy + ' does not reoffer an answered feature when multiple candidates narrow to one', async () => {
    const { trial, first } = await priorCheck(strategy, 'figures_0_1');
    const narrowed = await trial.say(confirm(firstAnswer, anotherQuestion, 'figure_0', otherFeature, answer));
    checkAnswered(first, narrowed);
    assert.deepEqual(narrowed.trace.executed?.target, { kind: 'single', figureId: slots[0] });
    assert.equal(narrowed.trace.executed?.feature, otherFeature);
    assert.ok(features(narrowed).includes(otherFeature));
    assert.ok(!features(narrowed).includes(askedFeature), 'the answered feature must stay excluded after narrowing');
  });

  test(strategy + ' does not reoffer an answered feature after one accept', async () => {
    const { trial, first } = await priorCheck(strategy, 'figure_0');
    const receipt = await trial.say({ ...accept(firstAnswer, '穴の数が分かりました。', 'figure_0'), local: answer });
    checkAnswered(first, receipt);
    const further = await trial.say(confirm('では、枝のつながりでも見分けられそうですか？',
      anotherQuestion, 'figure_0', otherFeature));
    assert.equal(further.trace.executed?.feature, otherFeature);
    assert.ok(features(further).includes(otherFeature));
    assert.ok(!features(further).includes(askedFeature), 'the answered feature must stay excluded across accept');
  });

  test(strategy + ' can still ask when the earlier feature question went unanswered', async () => {
    const { trial } = await priorCheck(strategy, 'figure_0');
    await trial.say(accept('まだ手元の形を見ています。', 'はい、見てみてください。', 'figure_0'));
    const resumed = await trial.say(confirm('まだ穴の形は見分けられません。ほかに手掛かりはありますか？',
      anotherQuestion, 'figure_0', otherFeature));
    assert.ok(features(resumed).includes(askedFeature), 'an unanswered question is not a confirmed feature');
  });

  test(strategy + ' can recheck when the participant explicitly withdraws the earlier answer', async () => {
    const { trial, first } = await priorCheck(strategy, 'figure_0');
    const receipt = await trial.say({ ...accept(firstAnswer, '穴の数が分かりました。', 'figure_0'), local: answer });
    checkAnswered(first, receipt);
    const previous = priorClaimViews(receipt.state.graph).find(item => item.quote === firstAnswer);
    assert.ok(previous);
    const human = 'さっき一つと答えましたが、穴の数はもう一度確かめたいです。';
    const recheck = await trial.say({
      human, drafts: ['穴の数は確かめ直す必要がありそうですね。細い枝が丸い台につながる形ですか？'],
      action: 'repair', target: 'figure_0', feature: otherFeature,
      local: { ...answer, act: 'withdraw', proposition: '穴が一つという先の回答を取り下げる',
        respondsToTurn: previous.sourceTurn, antecedent: previous.id },
    });
    const withdrawal = priorClaimViews(recheck.state.graph).find(claim => claim.quote === human && claim.act === 'withdraw');
    assert.equal(withdrawal?.respondsTo, previous.id, 'the correction must actually withdraw the answer');
    assert.ok(features(recheck).includes(askedFeature), 'a verified correction must reopen the affected feature');
  });

  for (const phase of ['human_referent', 'action'] as const) {
    test(strategy + ' teaches the partner rotation in ' + phase, async () => {
      const { results } = await inquiriesFor(strategy);
      const instructions = instruction(results[0], phase);
      assert.ok(instructions.split(/[。\n]/u).some(sentence =>
        /相手|そちら|参加者/u.test(sentence) && /盤面|画面|図形|向き|配置/u.test(sentence) &&
        /回転|90\s*[°度]|向き[^。]{0,24}(?:異な|違う)|同じ向き[^。]{0,14}(?:限ら|ではな)/u.test(sentence)),
      phase + ' instructions must state the rotation of the partner’s board or figures');
      const other = strategy === 'repair-first' ? 'bypass-enabled' : 'repair-first';
      assert.equal(instructions, instruction((await inquiriesFor(other)).results[0], phase));
    });
  }
}

// Raw bodies captured at 3836eaf from both strategies after the same synthetic
// long history. The three final requests exercise the old generation messages
// as well as the referent and action via their ordinary native transports.
const historical = {
  holistic_v1: 'c004cbe50dbafa5ea332a113359599d7f0a5dfadbfa91b7434729744379ade76',
  holistic_v2: 'fb61e7e6849377d6950b101bca3b704b88f8af44d9eab4006680bc122f78eaaf',
  holistic_v3: 'fb61e7e6849377d6950b101bca3b704b88f8af44d9eab4006680bc122f78eaaf',
  holistic_v4: 'fb61e7e6849377d6950b101bca3b704b88f8af44d9eab4006680bc122f78eaaf',
} as const;
for (const policy of Object.keys(historical) as Array<keyof typeof historical>) {
  test(policy + ' preserves the generation and decision instruction bytes', async () => {
    const checkpoint = await history(policy);
    const profile = makeProfile(policy);
    const traces = await Promise.all(strategies.map(async strategy => Promise.all(inquiries.map(async ([, plan]) => {
      const turn = await dialogue(profile, strategy, checkpoint).say(plan);
      return ['human_referent', 'action', 'generation'].map(phase => {
        const raw = turn.sends.find(send => send.phase === phase)?.raw;
        assert.ok(raw, 'the old version must actually send ' + phase);
        return sha256(raw);
      });
    }))));
    assert.deepEqual(traces[0], traces[1], 'the compared legal actions are common to both strategies');
    assert.equal(sha256(JSON.stringify(traces)), historical[policy]);
  });
}
