// Synthetic upstream choices and drafts pass through the participant v3 runtime.
// The published drafts establish reachability and state effects. Actual wording,
// action choice and conversational progress require the scripted live evaluation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { DraftAct, JevAction, JevTarget } from '../dialogue-model/runtime/decision/contract.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { interventionChecks, s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import type { ObservationInput } from '../dialogue-model/runtime/observation/contract.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { deadlines } from './support/s4-integration/harness.ts';
import { buildRecords } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
type Strategy = typeof strategies[number];
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const seed = 781;
const trial = createTrialV2({ seed });
const anchors: ObservationInput['ownAnchors'] = modelView(trial).anchors;
const figureIds = anchors.map(anchor => anchor.id);
const [first, second, ribbon, fan, cup] = figureIds;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3');
const ringGap = '環に切れ目がある';
const baseWidth = '台が環より細い';
const originalName = '月枠';
const differentName = '弧箱';
const fullShape = '全体は台に載った環飾りのように見えます。';
const memo = {
  observedAt: '2026-01-01T00:00:00.000Z',
  figures: anchors.map((anchor, index) => ({
    id: anchor.id, region: { ...anchor.bbox },
    holistic: [{ construal: ['台に載った環飾り', '閉じた輪飾り', '折れた帯', '開いた扇', '角張った器', '重なる三角'][index],
      basis: ['全体の輪郭'], status: 'hypothesis' as const }],
    analytic: { shapes: [
      [ringGap, baseWidth], ['環が閉じている'], ['細長い帯が折れる'], ['一端から広がる輪郭'], ['角のある輪郭'], ['三角が重なる'],
    ][index], composition: '一続きの輪郭', relations: [] },
    unknowns: [] as string[], reobservations: [],
  })),
};
type Memo = typeof memo;
type Segment = {
  text: string;
  aspect: LocalSegmentProposal['aspect'];
  act: LocalAct;
  targets?: string[];
  name?: string;
  antecedent?: Pick<LocalClaimView, 'speaker' | 'proposition'>;
};
type Turn = {
  human: string;
  local?: Segment[];
  publicClaims?: Segment[];
  action: JevAction;
  target?: number | readonly number[];
  feature?: string;
  name?: string;
  drafts: string[];
  draftActs?: Readonly<Record<string, DraftAct>>;
};
type Names = Record<string, string | null>;
type SavedTrial = {
  ownLedger: JevPrivateState['ledger'];
  queueState: { privateState: JevPrivateState };
  jevTraces: JevTurnTrace[];
  aiSubmission: Names | null;
  finalError: string | null;
};
type Message = { role: string; content: unknown };
const descriptions = (segments: Segment[]) => JSON.stringify(segments.map((segment, index): LocalSegmentProposal => ({
  segmentId: String(index + 1), quote: segment.text, proposition: segment.text, aspect: segment.aspect,
  targets: segment.targets ?? [], name: segment.name ?? null, linkedIssueId: null, respondsToTurn: null,
})));

function targetLabel(target: Turn['target']) {
  if (target === undefined) return 'none';
  if (typeof target === 'number') return 'figure_' + target;
  return 'figures_' + target.join('_');
}

function session(strategy: Strategy, observation: Memo = memo) {
  let current: Turn | undefined;
  let actionRequests: JevDecisionPayload[] = [];
  let generationRequests: Message[][] = [];
  let finalDrafts: Names[] = [];
  let finalCalls = 0;
  let responseId = 0;
  let saved: SavedTrial | undefined;
  const create = async (restore?: SavedTrial) => {
    const transport = {
      enabled: true, timeoutMs: profile.timeouts.decisionMs, questionLayout: profile.questionLayout,
      readKey: async () => 'sk-or-SYNTHETIC-holistic-acceptance-key',
      async fetchImpl(_url: string, init: RequestInit) {
        const request = JSON.parse(String(init.body)) as JevDecisionPayload;
        const state = JSON.parse(request.state) as { aiSeq?: number; priorClaims?: LocalClaimView[] };
        const turn = current;
        assert.ok(turn);
        if (request.questions.action || request.questions.target || request.questions.feature || request.questions.name) {
          actionRequests.push(request);
        }
        const answers = Object.fromEntries(Object.entries(request.questions).map(([key, { criteria }]) => {
          let choice: string | undefined;
          if (key === 'action') choice = turn.action;
          if (key === 'target') choice = targetLabel(turn.target);
          if (key === 'draft_naming') {
            const { draft } = JSON.parse(request.state) as { draft: string };
            assert.equal(draft, turn.drafts[generationRequests.length - 1], 'judge the draft just generated');
            choice = turn.draftActs?.[draft] ?? 'none';
          }
          if (key === 'human_referent') choice = typeof turn.target === 'number' ? targetLabel(turn.target) : turn.target ? 'multiple' : 'none';
          if (key === 'repair_issue' || key === 'basis') choice = 'none';
          if (key === 'prospect') choice = 'no_open_issue';
          if (key === 'name' || key === 'feature') {
            choice = Object.keys(criteria).find(label => JSON.parse(criteria[label]).value === turn[key]);
          }
          const segmentQuestion = /^segment_(\d+)_(act|antecedent|support)$/u.exec(key);
          if (segmentQuestion) {
            const segment = (state.aiSeq !== undefined || segmentQuestion[2] === 'support' ? turn.publicClaims : turn.local)?.[Number(segmentQuestion[1])];
            assert.ok(segment, 'script missing a local claim');
            if (segmentQuestion[2] === 'act') choice = segment.act;
            if (segmentQuestion[2] === 'support') choice = 'expressed';
            if (segmentQuestion[2] === 'antecedent') {
              const antecedent = segment.antecedent;
              choice = 'none';
              if (antecedent) {
                const index = state.priorClaims?.findIndex(claim => claim.speaker === antecedent.speaker &&
                  claim.proposition === antecedent.proposition) ?? -1;
                assert.ok(index >= 0, 'antecedent must be offered');
                choice = 'claim_' + index;
              }
            }
          }
          assert.ok(choice && Object.hasOwn(criteria, choice), 'scripted choice must be offered for ' + key);
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
            Object.keys(criteria).map(label => [label, Number(label === choice)]),
          ) }];
        }));
        return Response.json({ model: request.model, id: 'gen-holistic-' + ++responseId, usage: { cost: 0 }, answers });
      },
    };
    return createNamingTaskV2({
      strategy, seed, runDir: null, createTrial: () => trial, restore: restore ?? null,
      utteranceStyle: profile.utteranceStyle,
      client: { async complete(messages: Message[], { phase }: { phase: string }) {
        if (phase === 'final_submission') {
          const draft = finalDrafts[finalCalls++];
          assert.ok(draft, 'unexpected final submission');
          return { text: JSON.stringify(draft), model: 'synthetic-luna' };
        }
        assert.ok(current);
        if (phase === 'local_extraction') return { text: descriptions(current.local ?? []) };
        if (phase === 'ai_extraction') return { text: descriptions(current.publicClaims ?? []) };
        assert.equal(phase, 'generation');
        const draft = current.drafts[generationRequests.length];
        generationRequests.push(structuredClone(messages));
        assert.ok(draft, 'unexpected generation');
        return { text: draft, model: 'synthetic-luna' };
      } },
      jevResearch: {
        profile, technicalTrial,
        ledger: new RunBudget({ lunaCalls: 90, lunaPosts: 90, lunaTokens: 100000, jevPosts: 90, jevUsd: 1 }),
        jevDecision: createJevDecisionClient(transport)!,
        observer: {
          async observeAll() { return structuredClone(observation); },
          async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
        },
        localGrounding: {
          classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs })!,
          aiPublicTransport: transport, aiPublicClaims: profile.localGrounding.aiPublicClaims,
          timeoutMs: profile.timeouts.localMs,
        },
      },
      onPersist(record: unknown) { saved = structuredClone(record) as SavedTrial; },
    });
  };
  let task: Awaited<ReturnType<typeof createNamingTaskV2>>;
  function record() {
    assert.ok(saved);
    return saved;
  }
  return {
    async start() { task = await create(); },
    async restore() { task = await create(JSON.parse(JSON.stringify(record())) as SavedTrial); },
    async say(turn: Turn) {
      current = turn;
      actionRequests = [];
      generationRequests = [];
      const initial = record();
      const { eventId } = task.message(turn.human, 'synthetic-holistic-' + task.getState().events.length);
      await task.whenIdle();
      const after = record();
      const trace = after.jevTraces.at(-1);
      assert.ok(trace, 'a v3 attempt must be persisted');
      assert.equal(trace.lastEventId, eventId);
      const events = task.getState().events as Array<{ speaker: string; text: string }>;
      const latest = events.at(-1);
      const speech = latest?.speaker === 'ai' ? latest.text : null;
      return { before: initial, after, trace, speech, actionRequests, generationRequests };
    },
    submit(drafts: Names[]) {
      finalDrafts = drafts;
      return task.submitAI();
    },
    record, finalCalls: () => finalCalls,
    publicState: () => task.getState(),
  };
}

type Outcome = Awaited<ReturnType<ReturnType<typeof session>['say']>>;
const single = (figureId: string): JevTarget => ({ kind: 'single', figureId });
const multi = (figureIds: string[]): JevTarget => ({ kind: 'multiple', figureIds });
function published(turn: Outcome, action: JevAction, target: JevTarget, speech: string) {
  assert.equal(turn.trace.status, 'committed', turn.trace.errorCode ?? 'turn was not committed');
  assert.equal(turn.speech, speech);
  assert.equal(turn.trace.publicSpeech, speech);
  assert.equal(turn.trace.executed?.action, action);
  assert.deepEqual(turn.trace.executed?.target, target);
  assert.deepEqual(turn.after.queueState.privateState.judgments.at(-1)?.jevTurn.executed, turn.trace.executed);
  assert.equal(s4Probe.traceShape(turn.trace, profile.questionLayout), true);
}
function unchanged(turn: Outcome) {
  assert.deepEqual(turn.after.ownLedger, turn.before.ownLedger);
}
function checkedDrafts(turn: Outcome, expected: ReadonlyArray<readonly ['initial' | 'retry', string, DraftAct]>) {
  const actual = turn.trace.draftActs;
  assert.deepEqual(actual?.map(record => [record.draft, record.draftSha256, record.status, record.choice]),
    expected.map(([draft, text, choice]) => [draft, createHash('sha256').update(text).digest('hex'), 'ok', choice]));
  if (turn.trace.status === 'committed') {
    assert.deepEqual(turn.after.queueState.privateState.judgments.at(-1)?.jevTurn.draftActs, actual);
  }
}
function offered(turn: Outcome, key: 'action' | 'target' | 'feature' | 'name') {
  return turn.actionRequests.find(request => request.questions[key])?.questions[key].criteria ?? {};
}
const ask = (text: string, targets: string[] = [first]): Segment => ({ text, aspect: 'part', act: 'ask', targets });
const proposal = (text: string, name = originalName, targets = [first]): Segment =>
  ({ text, aspect: 'name', act: 'name_propose', name, targets });
const agreeSpeech = `この形は「${originalName}」と呼びましょう。`;
const firstProposal = `この環飾りの呼び名に「${originalName}」を提案します。`;
const approval = 'さっきの呼び方で大丈夫ですか？';
const approvalClaim: Segment = {
  text: approval, aspect: 'name', act: 'ask', targets: [first],
  antecedent: { speaker: 'human', proposition: firstProposal },
};
const broad: Turn = {
  human: '見えている図形を一つ選んで、全体としてどんな形か教えてください。', action: 'accept', target: 0, drafts: [fullShape],
  publicClaims: [{ text: fullShape, aspect: 'referent', act: 'assert', targets: [first] }],
};
const acknowledgeProposal: Turn = {
  human: firstProposal, local: [proposal(firstProposal)], action: 'accept', drafts: ['呼び名の候補ですね。'],
};
const adopt: Turn = {
  human: approval, local: [approvalClaim], action: 'agree', target: 0, name: originalName, drafts: [agreeSpeech],
  draftActs: { [agreeSpeech]: 'adopt_chosen' },
};

async function paired(check: (trial: ReturnType<typeof session>, strategy: Strategy) => Promise<void>, observation?: Memo) {
  const runs = await Promise.allSettled(strategies.map(async strategy => {
    const trial = session(strategy, observation);
    await trial.start();
    await check(trial, strategy);
  }));
  const failures = runs.flatMap((run, index) => run.status === 'rejected' ? [new Error(strategies[index], { cause: run.reason })] : []);
  if (failures.length) throw new AggregateError(failures, 'paired synthetic acceptance');
}

test('1. A first broad question can publish an overall description with or without a familiar analogy', async () => {
  for (const analogy of [true, false]) {
    const observation = structuredClone(memo);
    if (!analogy) observation.figures[0].holistic = [];
    const draft = analogy ? fullShape : '環と細い台が一続きになった、大まかには丸みのある輪郭です。';
    await paired(async trial => {
      const turn = await trial.say({ ...broad, drafts: [draft],
        publicClaims: [{ text: draft, act: 'assert', aspect: 'referent', targets: [first] }] });
      published(turn, 'accept', single(first), draft);
      assert.equal(turn.generationRequests.length, 1);
      assert.equal(turn.trace.executed?.feature, null);
      unchanged(turn);
    }, observation);
  }
});

test('2. A first feature question can be answered directly from present, absent or uncertain observations', async () => {
  const description = '台と環が一続きの形のことです。';
  const question = '環の途中に切れ目がありますか？';
  for (const [known, feature, draft] of [
    ['present', ringGap, 'こちらで見える環には切れ目があります。'],
    ['absent', '環が閉じている', 'こちらでは環がつながっていて、切れ目はありません。'],
    ['uncertain', '', 'こちらの見え方では、切れ目の有無までは判断できません。'],
  ] as const) {
    const observation = structuredClone(memo);
    observation.figures[0].analytic.shapes = feature ? [feature] : [];
    if (known === 'uncertain') observation.figures[0].unknowns = ['環の切れ目の有無'];
    await paired(async trial => {
      const turn = await trial.say({
        human: description + question, local: [
          { text: description, aspect: 'referent', act: 'assert', targets: [first] }, ask(question),
        ], action: 'accept', target: 0, drafts: [draft],
      });
      published(turn, 'accept', single(first), draft);
      assert.equal(turn.trace.executed?.feature, null);
      assert.equal(turn.after.queueState.privateState.repairHistory.length, 0);
      unchanged(turn);
    }, observation);
  }
});

test('2. That same feature question can require a clarifying question when the referent is unresolved', async () => {
  const human = '環の途中に切れ目がありますか？';
  const clarification = 'どちらの環を指していますか。台が環より細い方でしょうか？';
  await paired(async trial => {
    const turn = await trial.say({
      human, local: [ask(human, [])], action: 'confirm', target: [0, 1], feature: baseWidth, drafts: [clarification],
    });
    published(turn, 'confirm', multi([first, second]), clarification);
    assert.equal(turn.trace.executed?.feature, baseWidth);
    assert.equal(turn.after.queueState.privateState.repairHistory.at(-1)?.question, baseWidth);
    unchanged(turn);
  });
});

test('3. A whole-shape reference can support naming without a feature question', async () => {
  const shared = 'はい、その環飾りのような全体の形を指していました。';
  await paired(async trial => {
    unchanged(await trial.say(broad));
    const turn = await trial.say({
      ...adopt, human: shared + firstProposal,
      local: [{
        text: shared, aspect: 'referent', act: 'agree', targets: [first],
        antecedent: { speaker: 'ai', proposition: fullShape },
      }, proposal(firstProposal)],
    });
    published(turn, 'agree', single(first), agreeSpeech);
    assert.equal(turn.trace.executed?.name, originalName);
    assert.equal(turn.after.queueState.privateState.repairHistory.length, 0);
    assert.deepEqual(turn.after.ownLedger[first], { status: 'agreed', name: originalName });
  });
});

test('3. A backchannel about two possible whole shapes leaves a concrete referent question to resolve', async () => {
  const alternatives = '台のある環飾りと閉じた環飾りに見える形があります。';
  const human = 'なるほど、そういう見え方なんですね。';
  const clarification = '環に切れ目がある方のことですか？';
  await paired(async trial => {
    await trial.say({ ...broad, target: [0, 1], drafts: [alternatives],
      publicClaims: [{ text: alternatives, aspect: 'construal', act: 'construe', targets: [first, second] }] });
    const turn = await trial.say({
      human, local: [{ text: human, aspect: 'progress', act: 'acknowledge' }],
      action: 'confirm', target: [0, 1], feature: ringGap, drafts: [clarification],
    });
    published(turn, 'confirm', multi([first, second]), clarification);
    assert.ok(!Object.hasOwn(offered(turn, 'action'), 'agree'));
    unchanged(turn);
  });
});

test('4. Similar candidates can be checked by a contrastive feature and an answered feature gives way to a new one', async () => {
  const compare = '環のような形が二つあって、どちらか区別できません。';
  const gapQuestion = '環に切れ目がある方ですか？';
  const confirmed = '探している形には切れ目があります。台の太さの違いも気になります。';
  const nextQuestion = '台が環より細い形ですか？';
  const observation = structuredClone(memo);
  observation.figures[1].analytic.shapes = ['環の周りに丸みがある'];
  observation.figures[1].unknowns = ['環の切れ目の有無'];
  await paired(async trial => {
    const ambiguous = await trial.say({
      human: compare, action: 'confirm', target: [0, 1], feature: ringGap, drafts: [gapQuestion],
      publicClaims: [ask(gapQuestion, [first, second])],
    });
    published(ambiguous, 'confirm', multi([first, second]), gapQuestion);
    assert.equal(ambiguous.trace.executed?.feature, ringGap);
    unchanged(ambiguous);
    const next = await trial.say({
      human: confirmed, local: [{
        text: confirmed, act: 'agree', aspect: 'part', targets: [first],
        antecedent: { speaker: 'ai', proposition: gapQuestion },
      }],
      action: 'confirm', target: [0, 1], feature: baseWidth, drafts: [nextQuestion],
    });
    published(next, 'confirm', multi([first, second]), nextQuestion);
    const features = Object.values(offered(next, 'feature')).map(option => JSON.parse(option).value);
    assert.ok(features.includes(baseWidth));
    assert.ok(!features.includes(ringGap));
    assert.ok(next.trace.repairFacts?.some(fact => fact.turn === ambiguous.trace.turnIndex));
    assert.equal(next.after.queueState.privateState.repairHistory.at(-1)?.question, baseWidth);
    unchanged(next);
    const identified = '台のある環飾りの方です。環の輪郭に切れ目があるか教えてください。';
    const direct = 'その環の輪郭には切れ目があります。';
    const answered = await trial.say({
      human: identified, local: [ask(identified)], action: 'accept', target: 0, drafts: [direct],
    });
    published(answered, 'accept', single(first), direct);
    assert.equal(answered.trace.executed?.feature, null);
    assert.deepEqual(answered.after.queueState.privateState.repairHistory.map(entry => entry.question),
      next.after.queueState.privateState.repairHistory.map(entry => entry.question));
    unchanged(answered);
  }, observation);
});

test('5. Shared impressions alone supply no naming action and leave the ledger open', async () => {
  const human = '私には台に載った環飾りのように見えます。';
  const reply = '私にも環を台に載せたような全体に見えます。';
  await paired(async trial => {
    const turn = await trial.say({
      human, local: [{ text: human, aspect: 'construal', act: 'construe', targets: [first] }],
      action: 'accept', target: 0, drafts: [reply],
    });
    published(turn, 'accept', single(first), reply);
    assert.ok(!Object.hasOwn(offered(turn, 'action'), 'agree'));
    assert.deepEqual(turn.after.queueState.privateState.judgments.at(-1)?.jevTurn.agreeNames, []);
    unchanged(turn);
  });
});

test('6. A short approval question can adopt the participant’s original name after an uninterpreted turn and restore', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await trial.say(acknowledgeProposal);
    const incomplete = 'ええと、あの……。';
    const ordinary = await trial.say({ human: incomplete, local: [{ text: incomplete, aspect: 'progress', act: 'unknown' }],
      action: 'accept', drafts: ['聞いています。'] });
    unchanged(ordinary);
    await trial.restore();
    const turn = await trial.say(adopt);
    published(turn, 'agree', single(first), agreeSpeech);
    assert.equal(turn.trace.executed?.name, originalName);
    assert.deepEqual(Object.values(offered(turn, 'name')).map(option => JSON.parse(option).value), [originalName]);
    assert.deepEqual(turn.after.ownLedger[first], { status: 'agreed', name: originalName });
  });
});

for (const related of [false, true]) {
  test(related ? '6. A replacement for the same figure retires the old proposal'
    : '6. An unrelated proposal preserves the bound name for the old figure', async () => {
    await paired(async trial => {
      await trial.say(broad);
      await trial.say(acknowledgeProposal);
      const newer = related ? `同じ形の別案として「${differentName}」を出します。`
        : `閉じた環の方には「${differentName}」を提案します。`;
      await trial.say({
        human: newer, local: [proposal(newer, differentName, [related ? first : second])],
        action: 'accept', drafts: ['呼び名の案を聞きました。'],
      });
      const waiting = await trial.say({ ...adopt, action: 'accept', name: undefined, drafts: ['先に出した案についての質問ですね。'] });
      published(waiting, 'accept', single(first), '先に出した案についての質問ですね。');
      const names = waiting.after.queueState.privateState.judgments.at(-1)?.jevTurn.agreeNames;
      assert.deepEqual(names?.filter(candidate => candidate.figureId === first).map(candidate => candidate.name),
        [related ? differentName : originalName]);
      unchanged(waiting);
      if (!related) {
        const adopted = await trial.say(adopt);
        published(adopted, 'agree', single(first), agreeSpeech);
        assert.deepEqual(adopted.after.ownLedger[first], { status: 'agreed', name: originalName });
      }
    });
  });
}

test('7. Withdrawal, referent denial and unshared names do not make an agreement available', async () => {
  await paired(async trial => {
    const unbound = `呼び名には「${originalName}」がよさそうです。`;
    await trial.say({ human: unbound, local: [proposal(unbound, originalName, [])],
      action: 'accept', drafts: ['どの図形の話かを確かめたいです。'] });
    const ambiguous = await trial.say({ human: approval, action: 'accept', drafts: ['この呼び名はどんな形を指していますか？'] });
    published(ambiguous, 'accept', { kind: 'none' }, 'この呼び名はどんな形を指していますか？');
    assert.ok(!Object.hasOwn(offered(ambiguous, 'action'), 'agree'));
    unchanged(ambiguous);
  });
  for (const mode of ['withdrawal', 'denial'] as const) {
    await paired(async trial => {
      await trial.say(broad);
      await trial.say(acknowledgeProposal);
      const reply = mode === 'withdrawal' ? '先ほどの呼び方の案を取り下げます。' : '私が指しているのはその環飾りの形ではありません。';
      const segment: Segment = mode === 'withdrawal'
        ? { text: reply, aspect: 'name', act: 'withdraw', targets: [first],
          antecedent: { speaker: 'human', proposition: firstProposal } }
        : { text: reply, aspect: 'referent', act: 'deny', targets: [first],
          antecedent: { speaker: 'ai', proposition: fullShape } };
      const response = mode === 'withdrawal' ? '別の呼び名の案を聞かせてもらえますか？' : '指している形の手がかりを教えてください。';
      const turn = await trial.say({ human: reply, local: [segment], action: 'accept', target: 0, drafts: [response] });
      published(turn, 'accept', single(first), response);
      assert.ok(!Object.hasOwn(offered(turn, 'action'), 'agree'));
      const names = turn.after.queueState.privateState.judgments.at(-1)?.jevTurn.agreeNames;
      assert.deepEqual(names, []);
      unchanged(turn);
    });
  }
});

test('8. A single reply can cover every requested figure, including one with an uncertain overall reading', async () => {
  const descriptions = ['帯を折ったような全体です。', '扇を開いたような輪郭です。', '角張った器のような全体です。'];
  const cues = ['細長い部分が折れている形があります。', '端が一部重なって見える形があります。', '角のある輪郭の形もあります。'];
  for (const scope of [{ slots: [2, 3], figures: [ribbon, fan] }, { slots: [2, 3, 4], figures: [ribbon, fan, cup] }]) {
    for (const uncertain of [false, true]) {
      const observation = structuredClone(memo);
      if (uncertain) {
        observation.figures[3].holistic = [];
        observation.figures[3].analytic.shapes = [];
        observation.figures[3].unknowns = ['端の一部が重なり全体が不明'];
      }
      observation.figures[3].analytic.composition = '端で一部が重なる輪郭';
      const texts = [...descriptions];
      if (uncertain) texts[1] = '端が重なっているため、二つ目の全体は見分けられません。';
      const speech = scope.slots.map((index, seq) => `${seq + 1}つ目は、${texts[index - 2]}`).join('');
      await paired(async trial => {
        const introduction = scope.slots.map(index => cues[index - 2]).join('');
        await trial.say({
          human: `続けて、次に見比べる候補を${scope.slots.length}つ挙げてもらえますか？`,
          action: 'accept', target: scope.slots, drafts: [introduction],
          publicClaims: scope.slots.map(index => ({
            text: cues[index - 2], act: 'assert', aspect: 'referent', targets: [figureIds[index]],
          })),
        });
        const human = `今挙げた${scope.slots.length}つをそれぞれどんな形か教えてください。`;
        const turn = await trial.say({
          human, local: [{ text: human, aspect: 'referent', act: 'ask', targets: scope.figures }],
          action: 'accept', target: scope.slots, drafts: [speech],
        });
        published(turn, 'accept', multi(scope.figures), speech);
        assert.equal(turn.generationRequests.length, 1);
        for (const index of scope.slots) assert.ok(turn.speech?.includes(texts[index - 2]));
        if (scope.slots.length === 2) assert.ok(!turn.speech?.includes(texts[2]));
        unchanged(turn);
      }, observation);
    }
  }
});

test('Both v3 strategies receive the same whole-shape guidance and replay a committed multi-figure reply', async () => {
  // This checks the shared instruction wiring as well as S4. The supplied draft
  // still cannot tell us what either model would produce from those instructions.
  const speech = '一つは編んだ帯のような形、もう一つは広げた扇のような輪郭です。';
  for (const label of strategies) {
    const records = await buildRecords({ label, technicalTrial, turns: [{
      human: 'その二つはそれぞれどんな全体形ですか？',
      plan: { action: 'accept', target: 'figures_0_1', speech },
    }] });
    const record = records.trials[0];
    const replay = record.replay[0].result;
    assert.equal(record.turns[0].publicText, speech);
    assert.deepEqual(record.lastCommittedState.ledger, record.replay[0].tape.state.ledger);
    assert.equal(replay.status, 'same_material_intervention_verified');
    const checks = interventionChecks(records);
    const required = ['identity.intervention_policy', ...['shape', 'binding', 'execution', 'replay']
      .map(part => 'intervention.trial.0.attempt.0.' + part)];
    assert.deepEqual(required.map(id => checks.find(check => check.id === id)?.status), required.map(() => 'pass'));
    const action = (side: (typeof replay.sides)[number]) =>
      side.requests.find((item: { payload: JevDecisionPayload }) => item.payload.questions?.action)?.payload;
    const generation = (side: (typeof replay.sides)[number]) =>
      side.requests.find((item: { phase: string }) => item.phase === 'generation')?.payload;
    const [repair, bypass] = replay.sides;
    assert.deepEqual(action(repair), action(bypass));
    assert.deepEqual(generation(repair), generation(bypass));
    assert.equal(repair.executed?.target.kind, 'multiple');
    assert.equal(repair.executed?.target.figureIds.length, 2);
    assert.deepEqual(repair.executed, bypass.executed);
    assert.match(action(repair).questions.action.criteria.accept, /(?:全体|見立て).{0,30}先に.{0,36}(?:すべて|それぞれ)/u);
    const system = (generation(repair).messages as Message[]).filter(message => message.role === 'system')
      .map(message => message.content).join('\n');
    assert.match(system, /全体を尋ねられた最初の説明/u);
    assert.match(system, /(?:求められた|求められたすべての)図形(?:それぞれ|ごと|すべて)/u);
  }
});

test('A rejected public agreement commits no new name', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await trial.say(acknowledgeProposal);
    const before = trial.record();
    const rejected = await trial.say({
      ...adopt, drafts: [`「${differentName}」と呼びましょう。`, `この形は「${differentName}」にしましょう。`],
    });
    assert.equal(rejected.trace.status, 'error');
    assert.equal(rejected.trace.errorCode, 'unsafe_generation');
    assert.equal(rejected.trace.publicSpeech, null);
    assert.equal(rejected.speech, null);
    assert.equal(rejected.generationRequests.length, 2);
    assert.equal(rejected.trace.executed?.name, originalName);
    assert.deepEqual(rejected.after.ownLedger, before.ownLedger);
    assert.deepEqual(rejected.after.queueState.privateState.judgments, before.queueState.privateState.judgments);
  });
});

test('An agree draft showing the expected name but refusing it is regenerated before committing agreement', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await trial.say(acknowledgeProposal);
    const refusal = `「${originalName}」という呼び名を使うことには賛成できません。`;
    const turn = await trial.say({ ...adopt, drafts: [refusal, agreeSpeech],
      draftActs: { ...adopt.draftActs, [refusal]: 'decline_or_hold' } });
    assert.equal(turn.before.ownLedger[first].status, 'unassigned');
    published(turn, 'agree', single(first), agreeSpeech);
    assert.equal(turn.generationRequests.length, 2);
    assert.equal(turn.trace.generationGuard.regenerated, true);
    assert.deepEqual(turn.trace.generationGuard.violations, ['draft_act_mismatch']);
    checkedDrafts(turn, [['initial', refusal, 'decline_or_hold'], ['retry', agreeSpeech, 'adopt_chosen']]);
    assert.ok(!trial.publicState().events.some((event: { text: string }) => event.text === refusal));
    assert.deepEqual(turn.after.ownLedger[first], { status: 'agreed', name: originalName });
  });
});

for (const [kind, declaration] of [
  ['a naming declaration', `この形の呼び名は「${originalName}」です。`],
  ['a commitment to use the name', `では『${originalName}』で呼びましょう。`],
] as const) {
  test('An accept draft making ' + kind + ' is regenerated without installing agreement', async () => {
    await paired(async trial => {
      const turn = await trial.say({ ...broad, drafts: [declaration, fullShape], draftActs: { [declaration]: 'adopt_other' } });
      published(turn, 'accept', single(first), fullShape);
      assert.equal(turn.generationRequests.length, 2);
      assert.equal(turn.trace.generationGuard.regenerated, true);
      assert.deepEqual(turn.trace.generationGuard.violations, ['draft_act_mismatch']);
      checkedDrafts(turn, [['initial', declaration, 'adopt_other']]);
      assert.ok(!trial.publicState().events.some((event: { text: string }) => event.text === declaration));
      assert.equal(turn.after.ownLedger[first].status, 'unassigned');
      unchanged(turn);
    });
  });
}

test('A natural acceptance and a factual report quoting adoption wording both publish on the first draft', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await trial.say(acknowledgeProposal);
    const recount = `「${originalName}」で呼びましょうと提案したのは、そちらです。`;
    const query = 'その名前を提案したのはどちらでしたか？';
    const report = await trial.say({ human: query, action: 'accept', target: 0,
      drafts: [recount], draftActs: { [recount]: 'recount_only' } });
    published(report, 'accept', single(first), recount);
    assert.equal(report.generationRequests.length, 1);
    checkedDrafts(report, [['initial', recount, 'recount_only']]);
    unchanged(report);

    const accepted = `はい、「${originalName}」でお願いします。`;
    const agreement = await trial.say({ ...adopt, drafts: [accepted], draftActs: { [accepted]: 'adopt_chosen' } });
    published(agreement, 'agree', single(first), accepted);
    assert.equal(agreement.generationRequests.length, 1);
    checkedDrafts(agreement, [['initial', accepted, 'adopt_chosen']]);
    assert.deepEqual(agreement.after.ownLedger[first], { status: 'agreed', name: originalName });
  });
});

test('Two orientation violations allow the existing fallback when both drafts adopt the chosen name', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await trial.say(acknowledgeProposal);
    const initial = '上端に切れ目があります。' + agreeSpeech;
    const second = '右側に切れ目があります。' + agreeSpeech;
    const turn = await trial.say({ ...adopt, drafts: [initial, second],
      draftActs: { [initial]: 'adopt_chosen', [second]: 'adopt_chosen' } });
    published(turn, 'agree', single(first), `「${originalName}」にしましょう。`);
    assert.equal(turn.generationRequests.length, 2);
    assert.deepEqual(turn.trace.generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
    assert.deepEqual(turn.after.ownLedger[first], { status: 'agreed', name: originalName });
  });
});

test('An orientation retry refusing the chosen name cannot be published as an agreement fallback', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await trial.say(acknowledgeProposal);
    const initial = '上端に切れ目があります。' + agreeSpeech;
    const refusal = `右側に切れ目があります。「${originalName}」という呼び名を使うことには賛成できません。`;
    const turn = await trial.say({ ...adopt, drafts: [initial, refusal],
      draftActs: { [initial]: 'adopt_chosen', [refusal]: 'decline_or_hold' } });
    assert.equal(turn.trace.errorCode, 'unsafe_generation');
    assert.equal(turn.trace.generationGuard.fallback, false);
    assert.equal(turn.trace.publicSpeech, null);
    assert.equal(turn.speech, null);
    assert.equal(turn.generationRequests.length, 2);
    unchanged(turn);
    assert.deepEqual(turn.after.queueState.privateState.judgments, turn.before.queueState.privateState.judgments);
  });
});

const finalNames = (): Names => Object.fromEntries(figureIds.map(figureId => [
  figureId, figureId === first ? originalName : figureId === second ? differentName : null,
]));
async function prepareSubmission(trial: ReturnType<typeof session>) {
  await trial.say(broad);
  await trial.say(acknowledgeProposal);
  const turn = await trial.say(adopt);
  published(turn, 'agree', single(first), agreeSpeech);
  assert.deepEqual(turn.after.ownLedger[first], { status: 'agreed', name: originalName });
  await trial.restore();
  assert.deepEqual(trial.record().ownLedger, turn.after.ownLedger);
  return turn.after.ownLedger;
}

test('Final submission accepts a correct first draft and preserves the returned JSON', async () => {
  await paired(async trial => {
    const ledger = await prepareSubmission(trial);
    const correct = finalNames();
    await trial.submit([correct]);
    assert.equal(trial.finalCalls(), 1);
    assert.equal(trial.publicState().aiSubmitted, true);
    assert.deepEqual(trial.record().aiSubmission, correct);
    assert.deepEqual(trial.record().ownLedger, ledger);
  });
});

for (const [problem, corrupt] of [
  ['an old name', (names: Names): Names => ({ ...names, [first]: '旧月形' })],
  ['a missing name', (names: Names): Names => ({ ...names, [first]: null })],
  ['a relocated name', (names: Names): Names => ({ ...names, [first]: null, [second]: originalName })],
] as const) {
  test('Final submission retries ' + problem + ' on an agreed figure and stores the corrected output', async () => {
    await paired(async trial => {
      const ledger = await prepareSubmission(trial);
      const correct = finalNames();
      await trial.submit([corrupt(correct), correct]);
      assert.equal(trial.finalCalls(), 2);
      assert.equal(trial.publicState().aiSubmitted, true);
      assert.deepEqual(trial.record().aiSubmission, correct);
      assert.deepEqual(trial.record().ownLedger, ledger);
    });
  });
}

test('Final submission reports the existing error after two mismatches, with no submitted JSON', async () => {
  await paired(async trial => {
    const ledger = await prepareSubmission(trial);
    const correct = finalNames();
    const firstDraft = { ...correct, [first]: '古い環飾り' };
    const secondDraft = { ...correct, [first]: null, [second]: originalName };
    await assert.rejects(trial.submit([firstDraft, secondDraft]), { code: 'submission_error' });
    assert.equal(trial.finalCalls(), 2);
    assert.equal(trial.publicState().aiSubmitted, false);
    assert.equal(trial.record().finalError, 'submission_error');
    assert.equal(trial.record().aiSubmission, null);
    assert.deepEqual(trial.record().ownLedger, ledger);
  });
});
