// Synthetic upstream choices and drafts pass through the participant v3 runtime.
// The published drafts establish reachability and state effects. Actual wording,
// action choice and conversational progress require the scripted live evaluation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { participantLedgerFetch } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { DraftAct, JevAction, JevTarget } from '../dialogue-model/runtime/decision/contract.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { interventionChecks, s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { priorClaimViews } from '../dialogue-model/runtime/local-grounding/derive.ts';
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
const lunaRequest = { timeoutMs: null, maxCompletionTokens: null };
const timeouts = { ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000 };
const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3');
const legacyFallbackProfile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v4');
const holisticV3Profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v3');
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
  antecedent?: Pick<LocalClaimView, 'speaker' | 'proposition'> & { pick?: 'first' | 'last' };
  respondsToTurn?: number;
};
type Turn = {
  human: string;
  local?: Segment[];
  publicClaims?: Segment[];
  action: JevAction;
  target?: number | readonly number[];
  humanReferent?: number;
  feature?: string;
  name?: string;
  drafts: string[];
  draftActs?: Readonly<Record<string, DraftAct>>;
  agreeSpeech?: string;
};
type Names = Record<string, string | null>;
type SavedTrial = {
  options: { dialoguePolicy?: string };
  ownLedger: JevPrivateState['ledger'];
  queueState: { privateState: JevPrivateState; pendingHumanEventIds: string[]; closed: boolean };
  jevTraces: JevTurnTrace[];
  turnTimings: { requestSeq: number; lastEventId: string }[];
  requests: { kind: string; requestSeq: number | null; retryCount: number }[];
  aiSubmission: Names | null;
  finalError: string | null;
  dialogueInterruption?: 'participant_paused' | 'budget_exhausted';
};
type Message = { role: string; content: unknown };
type DraftRequest = { draft: string; reasons: string[] };
const descriptions = (segments: Segment[]) => JSON.stringify(segments.map((segment, index): LocalSegmentProposal => ({
  segmentId: String(index + 1), quote: segment.text, proposition: segment.text, aspect: segment.aspect,
  targets: segment.targets ?? [], name: segment.name ?? null, linkedIssueId: null, respondsToTurn: segment.respondsToTurn ?? null,
})));

function targetLabel(target: Turn['target']) {
  if (target === undefined) return 'none';
  if (typeof target === 'number') return 'figure_' + target;
  return 'figures_' + target.join('_');
}

function session(strategy: Strategy, observation: Memo = memo, trialProfile = profile, lunaCalls = 90, transientStatus?: number) {
  let current: Turn | undefined;
  let choseAgreement = false;
  const draftAt = (turn: Turn, index: number) => choseAgreement && index === 0 ? turn.agreeSpeech : turn.drafts[index];
  let actionRequests: JevDecisionPayload[] = [];
  let draftRequests: DraftRequest[] = [];
  let generationRequests: Message[][] = [];
  let finalDrafts: Names[] = [];
  let finalCalls = 0;
  let responseId = 0;
  let saved: SavedTrial | undefined;
  let draftForTransport = '';
  let generationPosts = 0;
  let ledger: RunBudget;
  const create = async (restore?: SavedTrial) => {
    ledger = new RunBudget({ lunaCalls, lunaPosts: 90, lunaTokens: 100000, jevPosts: 90, jevUsd: 1 });
    const generationClient = createChatClient({ apiKey: 'synthetic-only', baseUrl: 'https://offline.example/v1', model: 'synthetic-luna' },
      participantLedgerFetch(ledger, 'luna', 'synthetic-luna', async () => {
        if (++generationPosts === 1) return new Response(null, { status: transientStatus });
        return Response.json({ model: 'synthetic-luna', choices: [{ message: { content: draftForTransport } }],
          usage: { prompt_tokens: 8, completion_tokens: 3 } });
      }), { sleep: async () => {} });
    const transport = {
      enabled: true, timeoutMs: trialProfile.timeouts.decisionMs, questionLayout: trialProfile.questionLayout,
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
          if (key === 'action') {
            choseAgreement = Boolean(turn.agreeSpeech) && Object.hasOwn(criteria, 'agree');
            choice = choseAgreement ? 'agree' : turn.action;
          }
          if (key === 'target') choice = targetLabel(turn.target);
          if (key === 'draft_naming') {
            const { draft, reasons } = JSON.parse(request.state) as DraftRequest;
            draftRequests.push({ draft, reasons });
            assert.equal(draft, draftAt(turn, generationRequests.length - 1), 'judge the draft just generated');
            choice = turn.draftActs?.[draft] ?? 'none';
          }
          if (key === 'human_referent') {
            const referent = turn.humanReferent ?? turn.target;
            choice = typeof referent === 'number' ? targetLabel(referent) : referent ? 'multiple' : 'none';
          }
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
                const matching = (state.priorClaims ?? []).flatMap((claim, at) => claim.speaker === antecedent.speaker &&
                  claim.proposition === antecedent.proposition ? [at] : []);
                // Two published questions can carry the same wording; the classifier may pick either one (audit 26).
                const index = (antecedent.pick === 'last' ? matching.at(-1) : matching[0]) ?? -1;
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
      utteranceStyle: trialProfile.utteranceStyle,
      client: { async complete(messages: Message[], { phase, timeoutMs }: { phase: string; timeoutMs?: number }) {
        if (phase === 'final_submission') {
          const draft = finalDrafts[finalCalls++];
          assert.ok(draft, 'unexpected final submission');
          return { text: JSON.stringify(draft), model: 'synthetic-luna' };
        }
        assert.ok(current);
        if (phase === 'local_extraction') return { text: descriptions(current.local ?? []) };
        if (phase === 'ai_extraction') return { text: descriptions(current.publicClaims ?? []) };
        assert.equal(phase, 'generation');
        const draft = draftAt(current, generationRequests.length);
        generationRequests.push(structuredClone(messages));
        assert.ok(draft, 'unexpected generation');
        if (transientStatus !== undefined) {
          draftForTransport = draft;
          return generationClient.complete(messages, { timeoutMs });
        }
        return { text: draft, model: 'synthetic-luna' };
      } },
      jevResearch: {
        profile: trialProfile, technicalTrial,
        ledger,
        jevDecision: createJevDecisionClient(transport)!,
        observer: {
          async observeAll() { return structuredClone(observation); },
          async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
        },
        localGrounding: {
          classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: trialProfile.timeouts.localMs, dialoguePolicy: trialProfile.dialoguePolicy })!,
          aiPublicTransport: transport, aiPublicClaims: trialProfile.localGrounding.aiPublicClaims,
          timeoutMs: trialProfile.timeouts.localMs,
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
    async restoreFrom(saved: unknown) { task = await create(JSON.parse(JSON.stringify(saved)) as SavedTrial); },
    /** The ordinary restore entrance, from a record whose generation version is the given one (a version pinned by a saved record decides the trial). */
    async restoreAs(version: string) {
      const saved = JSON.parse(JSON.stringify(record())) as SavedTrial & { options: { generationRetryVersion?: string } };
      saved.options.generationRetryVersion = version;
      task = await create(saved);
    },
    interrupt() { return task.interruptDialogue(); },
    async resumeWith(turn: Turn) {
      current = turn;
      generationRequests = [];
      await Promise.all([task.retry(), task.retry()]);
      return generationRequests.length;
    },
    async say(turn: Turn) {
      current = turn;
      actionRequests = [];
      draftRequests = [];
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
      return { before: initial, after, trace, speech, actionRequests, draftRequests, generationRequests };
    },
    submit(drafts: Names[]) {
      finalDrafts = drafts;
      return task.submitAI();
    },
    record, finalCalls: () => finalCalls,
    usage: () => ledger.snapshot(),
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
  assert.equal(s4Probe.traceShape(turn.trace, profile.questionLayout, turn.after.options.dialoguePolicy), true);
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
  text: approval, aspect: 'name', act: 'name_propose', targets: [first],
  antecedent: { speaker: 'human', proposition: firstProposal },
};
const broad: Turn = {
  human: '見えている図形を一つ選んで、全体としてどんな形か教えてください。', action: 'accept', target: 0, drafts: [fullShape],
  publicClaims: [{ text: fullShape, aspect: 'referent', act: 'assert', targets: [first] }],
};
const sharedReferent: Segment = {
  text: 'はい、その環飾りの形を指しています。',
  aspect: 'referent', act: 'agree', targets: [first],
  antecedent: { speaker: 'ai', proposition: fullShape },
};
const proposalQuestion = '呼び名を決める前に、環に切れ目がある形か確認してもいいですか？';
const holdProposal: Turn = {
  human: sharedReferent.text + firstProposal, local: [sharedReferent, proposal(firstProposal)],
  action: 'confirm', target: 0, feature: ringGap,
  drafts: [proposalQuestion],
};
async function keepNamePending(trial: ReturnType<typeof session>) {
  const turn = await trial.say(holdProposal);
  published(turn, 'confirm', single(first), proposalQuestion);
  unchanged(turn);
}
const adopt: Turn = {
  human: approval, local: [approvalClaim], action: 'agree', target: 0, name: originalName, drafts: [agreeSpeech],
  draftActs: { [agreeSpeech]: 'adopt_chosen' },
};

async function paired(
  check: (trial: ReturnType<typeof session>, strategy: Strategy) => Promise<void>,
  observation?: Memo,
  trialProfile = profile,
) {
  const runs = await Promise.allSettled(strategies.map(async strategy => {
    const trial = session(strategy, observation, trialProfile);
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
    await keepNamePending(trial);
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
      await keepNamePending(trial);
      const newer = related ? `同じ形の別案として「${differentName}」を出します。`
        : `閉じた環の方には「${differentName}」を提案します。`;
      const feature = related ? baseWidth : '環が閉じている';
      const question = related ? '呼び名を決める前に、台が環より細い形か教えてください。'
        : '二つの形を区別したいです。今回の案は環が閉じている方ですか？';
      // A proposal for the second figure leaves both figures in the AI's question.
      const next = await trial.say({
        human: newer, local: [proposal(newer, differentName, [related ? first : second])],
        action: 'confirm', target: related ? 0 : [0, 1], humanReferent: related ? 0 : 1, feature, drafts: [question],
      });
      published(next, 'confirm', related ? single(first) : multi([first, second]), question);
      assert.equal(next.trace.humanReferent?.scores?.[related ? first : second], 1);
      unchanged(next);
      const query = 'その形について最初に出した呼び方は何でしたか？';
      const waiting = await trial.say({
        human: query, local: [{ ...approvalClaim, text: query, act: 'ask' }],
        action: 'accept', target: 0, drafts: ['先に出した案についての質問ですね。'],
      });
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
    const firstQuestion = ringGap + '形でしょうか？';
    const secondQuestion = '同じ形か確かめたいです。' + baseWidth + '形でしょうか？';
    const proposed = await trial.say({ human: unbound, local: [proposal(unbound, originalName, [])],
      action: 'confirm', target: 0, feature: ringGap, drafts: [firstQuestion] });
    const ambiguous = await trial.say({
      human: approval, local: [{
        text: approval, aspect: 'name', act: 'name_propose', antecedent: { speaker: 'human', proposition: unbound },
      }], action: 'confirm', target: 0, feature: baseWidth, drafts: [secondQuestion],
    });
    published(proposed, 'confirm', single(first), firstQuestion);
    published(ambiguous, 'confirm', single(first), secondQuestion);
    for (const turn of [proposed, ambiguous]) {
      assert.ok(!Object.hasOwn(offered(turn, 'action'), 'accept'));
      assert.ok(!Object.hasOwn(offered(turn, 'action'), 'agree'));
      unchanged(turn);
    }
  });
  for (const mode of ['withdrawal', 'denial'] as const) {
    await paired(async trial => {
      await trial.say(broad);
      await keepNamePending(trial);
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
    await keepNamePending(trial);
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
    await keepNamePending(trial);
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
    await keepNamePending(trial);
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

for (const [policy, activeProfile, action] of [
  ['holistic_v3', holisticV3Profile, 'accept'],
  ['holistic_v4', profile, 'confirm'],
] as const) {
  test('05d-1 ' + policy + ': a linked approval checks the draft before publishing the safe reply', async () => {
    await paired(async trial => {
      await trial.say(broad);
      await keepNamePending(trial);
      const askApproval = '先に挙げた呼び方でよさそうですか？';
      const assent = 'ええ、その呼び方に賛成です。';
      const account = 'その呼び方を提案したのはそちらです。';
      const reply = action === 'accept' ? account : account + '台が環より細い形か教えてください。';
      // The typed request triggers both checks without a name quote or naming formula in either draft.
      const turn = await trial.say({ human: askApproval, local: [{ ...approvalClaim, text: askApproval }],
        action, target: 0, ...(action === 'confirm' ? { feature: baseWidth } : {}), drafts: [assent, reply],
        draftActs: { [assent]: 'adopt_other', [reply]: 'recount_only' } });
      published(turn, action, single(first), reply);
      assert.ok(Object.hasOwn(offered(turn, 'action'), 'agree'));
      assert.equal(Object.hasOwn(offered(turn, 'action'), 'accept'), action === 'accept');
      assert.equal(turn.generationRequests.length, 2);
      assert.deepEqual(turn.draftRequests, [assent, reply].map(draft => ({ draft, reasons: ['typed_context'] })));
      checkedDrafts(turn, [['initial', assent, 'adopt_other'], ['retry', reply, 'recount_only']]);
      assert.deepEqual(turn.trace.generationGuard, { violations: ['draft_act_mismatch'], regenerated: true, fallback: false });
      assert.ok(!trial.publicState().events.some((event: { text: string }) => event.text === assent));
      assert.equal(turn.after.ownLedger[first].status, 'unassigned');
      unchanged(turn);
    }, undefined, activeProfile);
  });
}

test('05d-2: the same name quote is checked while tentative and exempt after agreement', async () => {
  await paired(async trial => {
    await trial.say(broad);
    const name = '輪縁';
    const remembered = `以前この形を「${name}」と呼んだ人がいました。`;
    const suggestion = `「${name}」という呼び名はどうでしょう？`;
    const proposed = await trial.say({ human: sharedReferent.text + 'この輪郭はどんな印象ですか？' + remembered,
      local: [sharedReferent, { text: remembered, aspect: 'name', act: 'assert', name, targets: [first] }],
      action: 'propose_name', target: 0, name, drafts: [suggestion] });
    published(proposed, 'propose_name', single(first), suggestion);
    assert.deepEqual(proposed.after.ownLedger[first], { status: 'tentative', name });
    assert.deepEqual(proposed.draftRequests, [], 'a quote of the selected proposal alone is exempt');
    assert.equal(proposed.trace.draftActs, undefined);

    const human = 'その形の縁について聞かせてください。';
    const adoptTentative = `ええ、「${name}」に賛成です。`;
    const mention = `「${name}」の縁の話ですね。`;
    const tentative = await trial.say({ human, action: 'accept', target: 0, drafts: [adoptTentative, mention],
      draftActs: { [adoptTentative]: 'adopt_other', [mention]: 'recount_only' } });
    published(tentative, 'accept', single(first), mention);
    assert.equal(tentative.generationRequests.length, 2);
    assert.deepEqual(tentative.draftRequests, [adoptTentative, mention].map(draft => ({ draft, reasons: ['quoted_other'] })));
    checkedDrafts(tentative, [['initial', adoptTentative, 'adopt_other'], ['retry', mention, 'recount_only']]);
    assert.deepEqual(tentative.trace.generationGuard, { violations: ['draft_act_mismatch'], regenerated: true, fallback: false });
    assert.ok(!trial.publicState().events.some((event: { text: string }) => event.text === adoptTentative));
    unchanged(tentative);

    const offer = `この図形に「${name}」という名前を提案します。`;
    const adoption = `はい、「${name}」でお願いします。`;
    const agreed = await trial.say({ human: offer, local: [proposal(offer, name)], action: 'agree', target: 0,
      name, drafts: [adoption], draftActs: { [adoption]: 'adopt_chosen' } });
    published(agreed, 'agree', single(first), adoption);
    assert.deepEqual(agreed.after.ownLedger[first], { status: 'agreed', name });

    const control = await trial.say({ human, action: 'accept', target: 0, drafts: [mention] });
    published(control, 'accept', single(first), mention);
    assert.equal(control.generationRequests.length, 1);
    assert.deepEqual(control.draftRequests, []);
    assert.equal(control.trace.draftActs, undefined);
    unchanged(control);
  });
});

test('Two orientation violations allow the existing fallback when both drafts adopt the chosen name', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await keepNamePending(trial);
    const initial = '上端に切れ目があります。' + agreeSpeech;
    const second = '右側に切れ目があります。' + agreeSpeech;
    const turn = await trial.say({ ...adopt, drafts: [initial, second],
      draftActs: { [initial]: 'adopt_chosen', [second]: 'adopt_chosen' } });
    published(turn, 'agree', single(first), `「${originalName}」にしましょう。`);
    assert.equal(turn.generationRequests.length, 2);
    assert.deepEqual(turn.trace.generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
    assert.deepEqual(turn.after.ownLedger[first], { status: 'agreed', name: originalName });
  }, memo, legacyFallbackProfile);
});

test('New v5 keeps the input pending after two orientation violations and publishes no fixed dialogue', async () => {
  await paired(async trial => {
    const before = trial.record();
    const turn = await trial.say({ ...broad, drafts: ['上端に穴があります。', '右端に穴があります。'] });
    assert.equal(turn.generationRequests.length, 2);
    assert.equal(turn.trace.generationRetryVersion, 'jev_generation_retry_v11'); // the default of a new v5 trial
    assert.equal(turn.trace.errorCode, 'unsafe_generation');
    assert.equal(turn.trace.publicSpeech, null);
    assert.equal(turn.speech, null);
    assert.deepEqual(turn.trace.generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: false });
    assert.deepEqual(turn.after.queueState.privateState, before.queueState.privateState);
    assert.equal(turn.after.queueState.pendingHumanEventIds.length, 1);
    assert.equal(turn.after.queueState.closed, false);
    assert.equal(s4Probe.traceShape(turn.trace, profile.questionLayout, profile.dialoguePolicy), true);
    assert.equal(s4Probe.traceShape({ ...turn.trace, generationGuard: { ...turn.trace.generationGuard, fallback: true } },
      profile.questionLayout, profile.dialoguePolicy), false);
  });
});

test('New v5 recovers a transient 503 within the same generation and the existing POST accounting', async () => {
  for (const strategy of strategies) {
    const ready = session(strategy, memo, profile, 90, 503);
    await ready.start();
    const turn = await ready.say(broad);
    published(turn, 'accept', single(first), broad.drafts[0]);
    assert.equal(turn.generationRequests.length, 1);
    assert.deepEqual(turn.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(ready.publicState().dialogueRecovery, 'active');
    assert.deepEqual(ready.record().queueState.pendingHumanEventIds, []);
    const sends = ready.usage().sends.filter(send => send.provider === 'luna' && send.phase === 'generation');
    const timing = turn.after.turnTimings.at(-1)!;
    assert.equal(timing.lastEventId, turn.trace.lastEventId);
    assert.deepEqual(sends.map(send => send.turn), [timing.requestSeq, timing.requestSeq]);
    assert.deepEqual(sends.map(send => send.outputTokens), [null, 3]);
    const requests = turn.after.requests.filter(request => request.kind === 'generation');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].retryCount, 1);
    assert.equal(requests[0].requestSeq, timing.requestSeq);
  }
});

test('New v5 can pause and resume a saved pending turn, or remain incomplete at the existing limit', async () => {
  const rejected = { ...broad, drafts: ['上端に穴があります。', '右端に穴があります。'] };
  for (const strategy of strategies) {
    const ready = session(strategy);
    await ready.start();
    const failed = await ready.say(rejected);
    const pending = failed.after.queueState.pendingHumanEventIds;
    assert.equal(ready.publicState().dialogueRecovery, 'retry');
    await ready.interrupt();
    assert.equal(ready.record().dialogueInterruption, 'participant_paused');
    assert.deepEqual(ready.record().queueState.pendingHumanEventIds, pending);
    assert.deepEqual(ready.record().ownLedger, failed.before.ownLedger);
    await ready.restore();
    assert.equal(ready.publicState().dialogueRecovery, 'paused');
    assert.equal(await ready.resumeWith(broad), 1);
    assert.equal(ready.publicState().dialogueRecovery, 'active');
    assert.deepEqual(ready.record().queueState.pendingHumanEventIds, []);
    assert.equal(ready.record().jevTraces.at(-1)?.lastEventId, pending[0]);
    assert.equal(ready.record().dialogueInterruption, undefined);

    const exhausted = session(strategy, memo, profile, 3);
    await exhausted.start();
    const stopped = await exhausted.say(rejected);
    assert.equal(stopped.generationRequests.length, 2);
    assert.equal(exhausted.publicState().dialogueRecovery, 'unavailable');
    assert.equal(exhausted.record().dialogueInterruption, 'budget_exhausted');
    await exhausted.restore();
    assert.equal(await exhausted.resumeWith(broad), 0);
    assert.equal(exhausted.record().aiSubmission, null);
    assert.deepEqual(exhausted.record().queueState.pendingHumanEventIds, stopped.after.queueState.pendingHumanEventIds);
    assert.equal(exhausted.publicState().status, 'dialogue');
  }
});

test('An orientation retry refusing the chosen name cannot be published as an agreement fallback', async () => {
  await paired(async trial => {
    await trial.say(broad);
    await keepNamePending(trial);
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
  await keepNamePending(trial);
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

async function audit16Check(dialogue: ReturnType<typeof session>, target: number | readonly number[],
  { questionTargets = [], feature = ringGap, opening, questionAspect = 'question' }: {
    questionTargets?: string[]; feature?: string; opening?: Pick<Turn, 'human' | 'local'>; questionAspect?: 'question' | 'part';
  } = {}) {
  const description = '台は輪より細く見えます。';
  const outline = '環の縁が途中で切れています。';
  const question = typeof target !== 'number' ? 'いまの二つのうち、どちらの形ですか？'
    : feature === ringGap ? 'そちらが見ているのもこの形ですか？' : '台の幅も同じ図形についてですか？';
  const check = await dialogue.say({
    human: typeof target === 'number' ? '輪のついた形を照らし合わせたいです。' : '輪に似た形が二つあり、まだ区別できません。',
    ...opening, action: 'confirm', target, feature, drafts: [description + outline + question],
    publicClaims: [
      { text: description, act: 'assert', aspect: 'part', targets: [first] },
      { text: outline, act: 'assert', aspect: 'contour', targets: [first] },
      { text: question, act: 'ask', aspect: questionAspect, targets: questionTargets },
    ],
  });
  assert.equal(check.speech, description + outline + question);
  assert.equal(check.trace.executed?.action, 'confirm');
  assert.deepEqual(check.trace.executed?.target,
    typeof target === 'number' ? single(first) : { kind: 'multiple', figureIds: [first, second] });
  const claims = check.trace.aiPublic?.pending?.candidates;
  assert.deepEqual(claims?.map(({ act, aspect, targets }) => ({ act, aspect, targets })), [
    { act: 'assert', aspect: 'part', targets: [first] },
    { act: 'assert', aspect: 'contour', targets: [first] },
    { act: 'ask', aspect: questionAspect, targets: questionTargets },
  ]);
  return { quote: question, sourceTurn: claims![2].sourceTurn };
}

async function audit16Answer(dialogue: ReturnType<typeof session>, question: { quote: string; sourceTurn: number },
  act: 'agree' | 'acknowledge' | 'assert', target: number | readonly number[],
  { aspect = 'referent', targets = [], human = act === 'agree' ? 'はい、まさにそれです。' : 'ええ、質問は分かりました。' }: {
    aspect?: 'referent' | 'part' | 'question'; targets?: string[]; human?: string;
  } = {}) {
  const answered = await dialogue.say({
    human, action: 'accept', target, drafts: ['形の照らし合わせを続けましょう。'],
    local: [{ text: human, act, aspect, targets, respondsToTurn: question.sourceTurn,
      antecedent: { speaker: 'ai', proposition: question.quote } }],
  });
  assert.equal(answered.trace.status, 'committed');
  assert.equal(answered.trace.executed?.action, 'accept');
  assert.equal(answered.after.ownLedger[first].name, null, 'a confirmation of the figure does not name it');
  const claims = priorClaimViews(answered.after.queueState.privateState.graph);
  const asked = claims.find(claim => claim.speaker === 'ai' && claim.sourceTurn === question.sourceTurn && claim.quote === question.quote);
  assert.ok(asked, 'the actual published question is the antecedent');
  const reply = claims.find(claim => claim.speaker === 'human' && claim.quote === human);
  return { asked, reply, ledger: answered.after.ownLedger };
}

async function audit16Name(dialogue: ReturnType<typeof session>, feature = baseWidth, nameTargets: string[] = [first],
  proposal = 'この形は「' + originalName + '」と呼びませんか？') {
  const human = proposal;
  const named = await dialogue.say({
    human, action: 'confirm', target: 0, feature, name: originalName,
    local: [{ text: human, act: 'name_propose', aspect: 'name', targets: nameTargets, name: originalName }],
    agreeSpeech, drafts: [feature + '形ですか？'], draftActs: { [agreeSpeech]: 'adopt_chosen' },
  });
  assert.equal(named.trace.status, 'committed');
  assert.ok(named.trace.namingRequest);
  const action = named.actionRequests.find(request => request.questions.action);
  assert.ok(action);
  return { named, offered: Object.hasOwn(action.questions.action.criteria, 'agree') };
}

for (const strategy of strategies) {
  test(`Audit 16 B1 ${strategy} keeps a short answer to a targetless question and submits the later agreed name`, async () => {
    const dialogue = session(strategy);
    await dialogue.start();
    const question = await audit16Check(dialogue, 0);
    const { asked, reply } = await audit16Answer(dialogue, question, 'agree', 0);
    const { named, offered } = await audit16Name(dialogue);
    await dialogue.restore();
    const submitted = Object.fromEntries(figureIds.map(figureId => [
      figureId, figureId === first && named.speech === agreeSpeech ? originalName : null,
    ]));
    await dialogue.submit([submitted]);
    const saved = dialogue.record();
    assert.deepEqual({
      linkedAnswer: reply?.act === 'agree' && reply.respondsTo === asked.id,
      offered, action: named.trace.executed?.action, target: named.trace.executed?.target,
      speech: named.speech, entry: saved.ownLedger[first], submitted: saved.aiSubmission?.[first],
    }, { linkedAnswer: true, offered: true, action: 'agree', target: single(first),
      speech: agreeSpeech, entry: { status: 'agreed', name: originalName }, submitted: originalName });
    assert.equal(dialogue.publicState().aiSubmitted, true);
    assert.equal(dialogue.finalCalls(), 1);
    assert.deepEqual(saved.ownLedger, named.after.ownLedger);
    assert.deepEqual(saved.aiSubmission, submitted);
  });

  for (const [control, target, act] of [
    ['a backchannel', 0, 'acknowledge'],
    ['an elliptical reply to a two-figure question', [0, 1], 'agree'],
  ] as const) {
    test(`Audit 16 B1 ${strategy} keeps names pending after ${control}`, async () => {
      const dialogue = session(strategy);
      await dialogue.start();
      const question = await audit16Check(dialogue, target);
      await audit16Answer(dialogue, question, act, target);
      const { named, offered } = await audit16Name(dialogue);
      assert.equal(offered, false);
      assert.equal(named.trace.executed?.action, 'confirm');
      assert.equal(named.speech, baseWidth + '形ですか？');
      assert.deepEqual(named.after.ownLedger, named.before.ownLedger);
    });
  }
}

const audit17SpareFeature = '台に短い切れ込みがある';

function checkAudit17Pending({ named, offered }: Awaited<ReturnType<typeof audit16Name>>, feature = baseWidth) {
  assert.equal(offered, false);
  assert.equal(named.trace.executed?.action, 'confirm');
  assert.equal(named.trace.executed?.feature, feature);
  assert.equal(named.speech, feature + '形ですか？');
  assert.deepEqual(named.after.ownLedger, named.before.ownLedger);
  assert.ok(Object.values(named.after.ownLedger).every(entry => entry.name === null));
}

for (const strategy of strategies) {
  for (const [label, questionTargets, aspect, answerTargets, human] of [
    ['a referent answer to a question that identifies the figure', [first], 'referent', [first], undefined],
    ['a part answer to a question without an extracted target', [], 'part', [first], undefined],
    ['「それそれ」', [], 'referent', [], 'それそれ'],
    ['「そうそう！それ」', [], 'referent', [], 'そうそう！それ'],
  ] as const) {
    test(`Audit 17 ${strategy} keeps ${label} and submits the name proposed afterward`, async () => {
      const dialogue = session(strategy);
      await dialogue.start();
      const question = await audit16Check(dialogue, 0, { questionTargets: [...questionTargets] });
      const { asked, reply, ledger } = await audit16Answer(dialogue, question, 'agree', 0,
        { aspect, targets: [...answerTargets], human });
      assert.ok(Object.values(ledger).every(entry => entry.name === null), 'the pointing answer itself does not name anything');

      const { named, offered } = await audit16Name(dialogue);
      await dialogue.restore();
      const submitted: Names = Object.fromEntries(figureIds.map(figureId => [
        figureId, figureId === first && named.speech === agreeSpeech ? originalName : null,
      ]));
      await dialogue.submit([submitted]);
      const saved = dialogue.record();
      assert.deepEqual({
        answer: reply && { act: reply.act, aspect: reply.aspect, targets: reply.targets, respondsTo: reply.respondsTo, issueId: reply.issueId },
        offered, action: named.trace.executed?.action, target: named.trace.executed?.target,
        speech: named.speech, entry: saved.ownLedger[first], submitted: saved.aiSubmission?.[first],
      }, {
        answer: { act: 'agree', aspect: asked.aspect, targets: [first], respondsTo: asked.id, issueId: asked.issueId },
        offered: true, action: 'agree', target: single(first), speech: agreeSpeech,
        entry: { status: 'agreed', name: originalName }, submitted: originalName,
      });
      assert.equal(dialogue.finalCalls(), 1);
      assert.equal(dialogue.publicState().aiSubmitted, true);
      assert.deepEqual(saved.ownLedger, named.after.ownLedger);
      assert.deepEqual(saved.aiSubmission, submitted);
    });
  }

  for (const [label, target, act, aspect, targets, human] of [
    ['a backchannel', 0, 'acknowledge', 'part', [first], 'ええ、質問は分かりました。'],
    ['an answer about a different figure', 0, 'agree', 'part', [second], '私が指すのは切れ目のない輪です。そう、それです。'],
    ['an elliptical answer with two candidates still open', [0, 1], 'agree', 'part', [first], 'はい、まさにそれです。'],
    ['a bare 「はい」 even if classified as agree', 0, 'agree', 'referent', [first], 'はい'],
    ['a bare 「うん」 even if classified as agree', 0, 'agree', 'referent', [first], 'うん'],
  ] as const) {
    test(`Audit 17 ${strategy} keeps the name pending after ${label}`, async () => {
      const dialogue = session(strategy);
      await dialogue.start();
      const question = await audit16Check(dialogue, target);
      await audit16Answer(dialogue, question, act, target, { aspect, targets: [...targets], human });
      checkAudit17Pending(await audit16Name(dialogue));
    });
  }

  test(`Audit 17 ${strategy} keeps the name pending when the reply answers an older question`, async () => {
    const observation = structuredClone(memo);
    observation.figures[0].analytic.shapes.push(audit17SpareFeature);
    const dialogue = session(strategy, observation);
    await dialogue.start();
    const old = await audit16Check(dialogue, 0, { questionTargets: [first] });
    const latest = await audit16Check(dialogue, 0, { feature: baseWidth });
    assert.notEqual(old.quote, latest.quote);
    assert.ok(old.sourceTurn < latest.sourceTurn);
    await audit16Answer(dialogue, old, 'agree', 0, { aspect: 'part', targets: [first] });
    checkAudit17Pending(await audit16Name(dialogue, audit17SpareFeature), audit17SpareFeature);
  });

  test(`Audit 17 ${strategy} keeps the name pending when only approval of the name is requested`, async () => {
    const dialogue = session(strategy);
    await dialogue.start();
    const previous = 'この形の呼び名には「' + originalName + '」を提案します。';
    const question = await audit16Check(dialogue, 0, {
      questionTargets: [first],
      opening: { human: previous, local: [{ text: previous, act: 'name_propose', aspect: 'name', targets: [first], name: originalName }] },
    });
    const human = '先の呼び名で大丈夫ですか？';
    const named = await dialogue.say({
      human, action: 'confirm', target: 0, feature: baseWidth, name: originalName,
      local: [{ text: human, act: 'name_propose', aspect: 'name', targets: [], respondsToTurn: question.sourceTurn,
        antecedent: { speaker: 'human', proposition: previous } }],
      agreeSpeech, drafts: [baseWidth + '形ですか？'], draftActs: { [agreeSpeech]: 'adopt_chosen' },
    });
    const action = named.actionRequests.find(request => request.questions.action);
    assert.ok(action);
    assert.ok(named.trace.namingRequest, 'the earlier name is being approved, so the naming request must reach the decision');
    checkAudit17Pending({ named, offered: Object.hasOwn(action.questions.action.criteria, 'agree') });
  });
}

// Audit 19: an acknowledgement of the question's meaning must not become confirmation of the figure.
for (const strategy of strategies) {
  const proposal = '「' + originalName + '」とかどう？';
  const afterReply = async (questionAspect: 'question' | 'part', act: 'agree' | 'acknowledge', aspect: 'part' | 'question', human: string) => {
    const dialogue = session(strategy);
    await dialogue.start();
    const question = await audit16Check(dialogue, 0, { questionTargets: [], questionAspect });
    await audit16Answer(dialogue, question, act, 0, { aspect, targets: [], human });
    return { dialogue, named: await audit16Name(dialogue, baseWidth, [], proposal) };
  };
  for (const [label, act] of [['agree/part', 'agree'], ['acknowledge', 'acknowledge']] as const) {
    test(`Audit 19 ${strategy} keeps names pending after 「質問の意味は分かりました。」 (${label}) to a targetless ask/part, then an untargeted proposal`, async () => {
      const { dialogue, named } = await afterReply('part', act, 'part', '質問の意味は分かりました。');
      checkAudit17Pending(named);
      await dialogue.restore();
      await dialogue.submit([Object.fromEntries(figureIds.map(figureId => [figureId, null]))]);
      const saved = dialogue.record();
      assert.ok(Object.values(saved.ownLedger).every(entry => entry.name === null));
      assert.ok(Object.values(saved.aiSubmission ?? {}).every(value => value === null));
    });
  }
  for (const [questionAspect, aspect] of [['part', 'part'], ['question', 'question']] as const) {
    test(`Audit 19 ${strategy} leaves 「ええ、分かりました。」 to an ask/${questionAspect} without a name candidate`, async () => {
      const { named } = await afterReply(questionAspect, 'agree', aspect, 'ええ、分かりました。');
      checkAudit17Pending(named);
    });
  }
  for (const [questionAspect, aspect] of [['part', 'part'], ['question', 'question'], ['part', 'referent']] as const) {
    for (const human of ['それそれ', 'そうそう！それ']) {
      test(`Audit 19 ${strategy} still confirms ${human} to an ask/${questionAspect} (${aspect}) and submits a later agreed name`, async () => {
        const dialogue = session(strategy);
        await dialogue.start();
        const question = await audit16Check(dialogue, 0, { questionTargets: [], questionAspect });
        const { asked, reply } = await audit16Answer(dialogue, question, 'agree', 0, { aspect, targets: [], human });
        assert.deepEqual({ act: reply?.act, targets: reply?.targets, respondsTo: reply?.respondsTo }, { act: 'agree', targets: [first], respondsTo: asked.id });
        const { named, offered } = await audit16Name(dialogue);
        assert.equal(offered, true);
        assert.equal(named.speech, agreeSpeech);
        await dialogue.restore();
        await dialogue.submit([Object.fromEntries(figureIds.map(figureId => [figureId, figureId === first ? originalName : null]))]);
        assert.deepEqual(dialogue.record().ownLedger[first], { status: 'agreed', name: originalName });
      });
    }
  }
}

// Audit v9 (generation guard: the forms accepted as an own-side marker or a quotation of the partner's words).
// Synthetic sentences only. v9 accepts the forms; v8 keeps its earlier judgment; the guard's standard itself is unchanged in both.
const v8 = 'jev_generation_retry_v8', v9 = 'jev_generation_retry_v9', v10 = 'jev_generation_retry_v10', v11 = 'jev_generation_retry_v11';
async function pairedAs(version: string, check: (trial: ReturnType<typeof session>, strategy: Strategy) => Promise<void>) {
  const runs = await Promise.allSettled(strategies.map(async strategy => {
    const trial = session(strategy);
    await trial.start();
    await trial.restoreAs(version);
    await check(trial, strategy);
  }));
  const failures = runs.flatMap((run, index) => run.status === 'rejected' ? [new Error(strategies[index], { cause: run.reason })] : []);
  if (failures.length) throw new AggregateError(failures, 'paired synthetic acceptance (' + version + ')');
}
const claimOf = (text: string) => [{ text, act: 'assert' as const, aspect: 'part' as const, targets: [first] }];
async function heldAs(trial: ReturnType<typeof session>, draft: string) {
  const before = trial.record();
  const turn = await trial.say({ ...broad, drafts: [draft, draft], publicClaims: claimOf(draft) });
  assert.equal(turn.generationRequests.length, 2, 'the same draft is regenerated once and rejected again');
  assert.equal(turn.trace.errorCode, 'unsafe_generation');
  assert.equal(turn.speech, null);
  assert.equal(turn.trace.publicSpeech, null);
  assert.equal(turn.trace.generationGuard.fallback, false);
  assert.deepEqual(turn.after.queueState.privateState, before.queueState.privateState);
  assert.equal(turn.after.queueState.pendingHumanEventIds.length, 1);
  return turn;
}
async function publishedAs(trial: ReturnType<typeof session>, draft: string) {
  const turn = await trial.say({ ...broad, drafts: [draft], publicClaims: claimOf(draft) });
  published(turn, 'accept', single(first), draft);
  assert.equal(turn.generationRequests.length, 1);
  assert.deepEqual(turn.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
  return turn;
}

// [label, draft, the code v8 reports]
const v9Accepted = [
  ['an own-side possessive before a direction word', 'こちらの上の三角形の突起に、細い切れ目があります。', 'orientation_leak'],
  ['an own-side 「の画面で」', 'こちらの画面で上端に切れ目があります。', 'orientation_leak'],
  ['the partner\'s words quoted with 「そちらでいう」', 'そうかもしれないね。こちらの画面では切れ目が見えるので、そちらでいう左向きの先に対応する可能性はありそう。', 'shared_view_assumption'],
  ['an own-side possessive with a rotation remark', 'うん、90度回して考えると、こちらの上の三角形の突起がそちらの左向きのとがった先にあたりそうだね。', 'orientation_leak'],
  ['an own-side 「の画面で」 in a longer correspondence question', 'こちらの画面で上部中央にある三角形の突起が、そちらでは左向きの先にあたり、その両側から続く形ですか？', 'orientation_leak'],
] as const;
// Still rejected in both versions: a direction word with no marker, and an assertion about the partner's side.
const bothRejected = [
  ['a direction word with no marker', '上端に切れ目があります。', 'orientation_leak'],
  ['an unmarked own-side description beside a partner direction', 'うん、こちらの切れ目がそちらの左向きのとがった先にあたりそうだね。', 'orientation_leak'],
  ['an assertion about the partner\'s side after an own-side marker', 'こちらの画面では切れ目が上にあるよ。そちらでは右側にあるはずだね。', 'shared_view_assumption'],
] as const;

for (const [label, draft] of v9Accepted) {
  test(`Audit v9 publishes ${label} under v9 in both strategies`, async () => {
    await pairedAs(v9, async trial => {
      const turn = await publishedAs(trial, draft);
      assert.equal(turn.trace.generationRetryVersion, v9);
    });
  });
  test(`Audit v9 keeps the v8 judgment for ${label}`, async () => {
    const code = v9Accepted.find(entry => entry[1] === draft)![2];
    await pairedAs(v8, async trial => {
      const turn = await heldAs(trial, draft);
      assert.equal(turn.trace.generationRetryVersion, v8);
      assert.deepEqual(turn.trace.generationGuard, { violations: [code], regenerated: true, fallback: false });
    });
  });
}
for (const [label, draft, code] of bothRejected) {
  for (const version of [v8, v9]) {
    test(`Audit v9 still rejects ${label} under ${version.slice(-2)} in both strategies`, async () => {
      await pairedAs(version, async trial => {
        const turn = await heldAs(trial, draft);
        assert.equal(turn.trace.generationRetryVersion, version);
        assert.deepEqual(turn.trace.generationGuard, { violations: [code], regenerated: true, fallback: false });
      });
    });
  }
}
test('Audit v9 v10 is the version a new holistic_v5 trial starts with, and a v8 record keeps v8 across a restore', async () => {
  await paired(async trial => {
    const turn = await trial.say({ ...broad, drafts: ['上端に穴があります。', '右端に穴があります。'] });
    assert.equal(turn.trace.generationRetryVersion, v11);
  });
  await pairedAs(v8, async trial => {
    await trial.restore();
    const turn = await heldAs(trial, 'こちらの画面で上端に切れ目があります。');
    assert.equal(turn.trace.generationRetryVersion, v8);
  });
});

// Audit 20: the target supplied to an empty-target question is used only by a reply that passed the direct affirmation check,
// whenever the reply arrives. A reply one exchange later, or one that is not an affirmation, names nothing.
const audit20Proposal = '「' + originalName + '」とかどう？';
async function audit20Gap(dialogue: ReturnType<typeof session>, act: 'assert' | 'acknowledge') {
  const human = '少し考えさせてください。';
  const turn = await dialogue.say({ human, action: 'accept', target: 0, drafts: ['ええ、ゆっくりどうぞ。'],
    local: [{ text: human, act, aspect: 'progress', targets: [] }] });
  assert.equal(turn.trace.status, 'committed');
  assert.equal(turn.trace.executed?.action, 'accept');
}
for (const strategy of strategies) {
  const late = async (gap: 'assert' | 'acknowledge', act: 'agree' | 'acknowledge' | 'assert', human: string) => {
    const dialogue = session(strategy);
    await dialogue.start();
    const question = await audit16Check(dialogue, 0, { questionTargets: [], questionAspect: 'part' });
    await audit20Gap(dialogue, gap);
    await audit16Answer(dialogue, question, act, 0, { aspect: 'part', targets: [], human });
    return { dialogue, named: await audit16Name(dialogue, baseWidth, [], audit20Proposal) };
  };
  for (const [label, act] of [['assert/part with no target right after the question (NB-20N-2)', 'assert'], ['agree/part with no target right after the question', 'agree']] as const) {
    test(`Audit 20 ${strategy} keeps names pending and submits unnamed after ${label}`, async () => {
      const dialogue = session(strategy);
      await dialogue.start();
      const question = await audit16Check(dialogue, 0, { questionTargets: [], questionAspect: 'part' });
      await audit16Answer(dialogue, question, act, 0, { aspect: 'part', targets: [], human: '質問の意味は分かりました。' });
      checkAudit17Pending(await audit16Name(dialogue, baseWidth, [], audit20Proposal));
      await dialogue.restore();
      await dialogue.submit([Object.fromEntries(figureIds.map(figureId => [figureId, null]))]);
      assert.ok(Object.values(dialogue.record().ownLedger).every(entry => entry.name === null));
    });
  }
  for (const [label, gap, act, human] of [
    ['agree/part after an assert/progress exchange', 'assert', 'agree', '質問の意味は分かりました。'],
    ['agree/part after an acknowledge exchange', 'acknowledge', 'agree', '質問の意味は分かりました。'],
    ['acknowledge after an exchange', 'acknowledge', 'acknowledge', '質問の意味は分かりました。'],
    ['assert/part with no target (NB-20N-2)', 'assert', 'assert', '質問の意味は分かりました。'],
    ['assert/part with no target after an acknowledge exchange', 'acknowledge', 'assert', '質問の意味は分かりました。'],
    ['「ええ、分かりました。」 as agree/part', 'assert', 'agree', 'ええ、分かりました。'],
  ] as const) {
    test(`Audit 20 ${strategy} keeps names pending, publishes none and submits unnamed after a late ${label}`, async () => {
      const { dialogue, named } = await late(gap, act, human);
      checkAudit17Pending(named);
      await dialogue.restore();
      await dialogue.submit([Object.fromEntries(figureIds.map(figureId => [figureId, null]))]);
      const saved = dialogue.record();
      assert.ok(Object.values(saved.ownLedger).every(entry => entry.name === null));
      assert.ok(Object.values(saved.aiSubmission ?? {}).every(value => value === null));
    });
  }
}
for (const [label, draft] of [
  ['a quotation of the partner\'s words that compares the two screens (NB-21N-1)', 'そちらでいう左向きの先は、こちらと同じ向きですね。'],
  ['a negated own-side 「の画面で」 (NB-21N-3)', 'こちらの画面でなく、上端に穴があります。'],
] as const) {
  test(`Audit 20 v9 rejects ${label} in both strategies`, async () => {
    await pairedAs(v9, async trial => {
      const turn = await heldAs(trial, draft);
      assert.equal(turn.trace.generationRetryVersion, v9);
      assert.ok(turn.trace.generationGuard.violations.length > 0);
    });
  });
}

// Audit 22: after the participant states a direction on their side, a draft that states a different direction for the partner's side is rejected
// even when it opens with 「そちらでいうと」; a draft that really quotes the partner's wording is still accepted in v9.
const stated = 'こちらの図では輪の先が左を向いています。';
const statedTurn = {
  human: stated + 'そちらからはどう見えますか？',
  local: [{ text: stated, act: 'assert' as const, aspect: 'orientation' as const, targets: [first] }],
};
async function audit22Held(trial: ReturnType<typeof session>, draft: string, version: string) {
  const before = trial.record();
  const turn = await trial.say({ ...broad, ...statedTurn, drafts: [draft, draft], publicClaims: claimOf(draft) });
  assert.equal(turn.trace.generationRetryVersion, version);
  assert.equal(turn.generationRequests.length, 2, 'the same draft is regenerated once and rejected again');
  assert.equal(turn.trace.errorCode, 'unsafe_generation');
  assert.equal(turn.speech, null);
  assert.equal(turn.trace.publicSpeech, null);
  assert.equal(turn.trace.generationGuard.fallback, false);
  assert.ok(turn.trace.generationGuard.violations.length > 0);
  assert.deepEqual(turn.after.queueState.privateState, before.queueState.privateState);
  assert.equal(turn.after.queueState.pendingHumanEventIds.length, 1);
  assert.ok(!trial.publicState().events.some((event: { text: string }) => event.text === draft));
}
for (const draft of ['そちらでは、輪の先は右向きですね。', 'そちらでいうと、輪の先は右向きですね。']) {
  for (const version of [v8, v9]) {
    test(`Audit 22 ${version.slice(-2)} rejects both drafts of 「${draft}」 and publishes nothing, in both strategies`, async () => {
      await pairedAs(version, trial => audit22Held(trial, draft, version));
    });
  }
}
for (const draft of [
  'そちらでいう左向きの先は、こちらの輪の切れ目に対応していますか？',
  'こちらの画面では輪の先が切れているので、そちらでいう左向きの先に対応する可能性はありそう。',
]) {
  test(`Audit 22 v9 still publishes a draft that quotes the partner's wording: 「${draft}」`, async () => {
    await pairedAs(v9, async trial => {
      const turn = await trial.say({ ...broad, ...statedTurn, drafts: [draft], publicClaims: claimOf(draft) });
      published(turn, 'accept', single(first), draft);
      assert.deepEqual(turn.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
      assert.equal(turn.trace.generationRetryVersion, v9);
    });
  });
}

// Audit 22n (NB-22N-2): the exemption for 「そちらでいう」 covers only the quoted phrase right after it. A direction word or a statement about
// the partner's side later in the same clause is judged as before.
const afterQuotation = [
  'そちらでいう『3』は、左上にV字状のくぼみがありますね。',
  'そちらでいう『星』は、そちらの上端に切れ目がありますよ。',
  'そちらでいう『星』ですが、右上に穴があります。',
  'そちらでいう『3』は、そちらの上端に切れ目がありますよ。',
  '相手のいうことは分かりました、上の突起がとがっていますね。',
];
for (const draft of afterQuotation) {
  for (const version of [v8, v9]) {
    test(`Audit 22n ${version.slice(-2)} rejects both drafts of 「${draft}」 and publishes nothing, in both strategies`, async () => {
      await pairedAs(version, trial => audit22Held(trial, draft, version));
    });
  }
}
test('Audit 22n v9 still publishes a draft whose quoted term is followed by a correspondence question', async () => {
  const draft = 'そちらでいう『3』は、こちらの輪の切れ目に対応していますか？';
  await pairedAs(v9, async trial => {
    const turn = await trial.say({ ...broad, ...statedTurn, drafts: [draft], publicClaims: claimOf(draft) });
    published(turn, 'accept', single(first), draft);
    assert.deepEqual(turn.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(turn.trace.generationRetryVersion, v9);
  });
});

// Audit v10 (candidate): a quotation of the partner's wording excuses a direction word only when the participant said that word in public.
const saidLowerLeft = 'こちらの図では輪の切れ目から左下に突起があります。';
const saidFacingLeft = 'こちらの図では輪の先が左向きになっています。';
const sayingTurn = (text: string) => ({ human: text, local: [{ text, act: 'assert' as const, aspect: 'orientation' as const, targets: [first] }] });
async function v10Held(trial: ReturnType<typeof session>, said: string, draft: string, version: string) {
  const before = trial.record();
  const turn = await trial.say({ ...broad, ...sayingTurn(said), drafts: [draft, draft], publicClaims: claimOf(draft) });
  assert.equal(turn.trace.generationRetryVersion, version);
  assert.equal(turn.generationRequests.length, 2, 'the same draft is regenerated once and rejected again');
  assert.equal(turn.trace.errorCode, 'unsafe_generation');
  assert.equal(turn.speech, null);
  assert.equal(turn.trace.publicSpeech, null);
  assert.equal(turn.trace.generationGuard.fallback, false);
  assert.ok(turn.trace.generationGuard.violations.length > 0);
  assert.deepEqual(turn.after.queueState.privateState, before.queueState.privateState);
  assert.ok(!trial.publicState().events.some((event: { text: string }) => event.text === draft));
}
async function v10Published(trial: ReturnType<typeof session>, said: string, draft: string, version: string) {
  const turn = await trial.say({ ...broad, ...sayingTurn(said), drafts: [draft], publicClaims: claimOf(draft) });
  published(turn, 'accept', single(first), draft);
  assert.deepEqual(turn.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
  assert.equal(turn.trace.generationRetryVersion, version);
}
const unsaidDirection = 'そちらでいう輪の切れ目から右上に、小さな突起がありますね。';
test('Audit v10 rejects a quoted phrase whose direction word the participant never said, in both strategies', async () => {
  await pairedAs(v10, trial => v10Held(trial, saidLowerLeft, unsaidDirection, v10));
});
test('Audit v10 keeps the v9 judgment for the same draft (v9 publishes it) in both strategies', async () => {
  await pairedAs(v9, trial => v10Published(trial, saidLowerLeft, unsaidDirection, v9));
});
test('Audit v10 publishes the quotation when the participant did say that direction word, in both strategies', async () => {
  await pairedAs(v10, trial => v10Published(trial, saidLowerLeft, 'そちらでいう輪の切れ目から左下に、小さな突起がありますね。', v10));
});
for (const draft of [...afterQuotation, 'そちらでは、輪の先は右向きですね。', 'そちらでいうと、輪の先は右向きですね。']) {
  test(`Audit v10 rejects 「${draft}」 after the participant's statement, in both strategies`, async () => {
    await pairedAs(v10, trial => v10Held(trial, stated, draft, v10));
  });
}
for (const draft of [
  'そちらでいう左向きの先は、こちらの輪の切れ目に対応していますか？',
  'こちらの画面では輪の先が切れているので、そちらでいう左向きの先に対応する可能性はありそう。',
  'そちらでいうとがった左向きの先は、こちらの輪の切れ目に対応していますか？',
]) {
  for (const version of [v9, v10]) {
    test(`Audit v10 ${version.slice(-2)} publishes 「${draft}」 when the participant said 左向き, in both strategies`, async () => {
      await pairedAs(version, trial => v10Published(trial, saidFacingLeft, draft, version));
    });
  }
}
// 「そちらでいうとがった…」 is not the conditional 「いうと」: v10 publishes it, v9 keeps rejecting it.
for (const draft of ['そちらでいうとがった左向きの先に対応する可能性はありそう。']) {
  test(`Audit v10 publishes 「${draft}」 and v9 still rejects it, in both strategies`, async () => {
    await pairedAs(v10, trial => v10Published(trial, saidFacingLeft, draft, v10));
    await pairedAs(v9, trial => v10Held(trial, saidFacingLeft, draft, v9));
  });
}
// ai_bound_target belongs to v9 and later: v9 and v10 records keep it across a restore; a v8 record that carries one is refused.
for (const strategy of strategies) {
  const build = async (version: string) => {
    const dialogue = session(strategy);
    await dialogue.start();
    await dialogue.restoreAs(version);
    const question = await audit16Check(dialogue, 0, { questionTargets: [], questionAspect: 'part' });
    await audit16Answer(dialogue, question, 'acknowledge', 0, { aspect: 'part', targets: [] });
    return dialogue;
  };
  const bound = (record: any) => (record.referenceGraph.claims as Array<{ source: string }>).filter(claim => claim.source === 'ai_bound_target');
  for (const version of [v9, v10]) {
    test(`Audit v10 ${strategy} keeps an ai_bound_target claim across a restore as ${version.slice(-2)}`, async () => {
      const dialogue = await build(version);
      assert.equal(bound(dialogue.record()).length, 1, 'the supplied target of the targetless question is recorded as ai_bound_target');
      await dialogue.restore();
    });
  }
  test(`Audit v10 ${strategy} refuses a v8 record that carries an ai_bound_target claim`, async () => {
    const dialogue = await build(v8);
    const untouched = dialogue.record();
    assert.equal(bound(untouched).length, 0, 'v8 records the supplied target without the provenance');
    await dialogue.restoreFrom(untouched);
    const tampered = JSON.parse(JSON.stringify(untouched));
    const claim = tampered.queueState.privateState.graph.records.find((entry: { kind: string; source: string }) => entry.kind === 'claim' && entry.source === 'ai_hypothesis');
    assert.ok(claim, 'an AI question claim exists to rewrite');
    claim.source = 'ai_bound_target';
    await assert.rejects(dialogue.restoreFrom(tampered));
  });
}

// #197: an ordinary participant restore compares the executed action of a saved trace with the saved state's own copy.
for (const strategy of strategies) {
  test(`#197 ${strategy} refuses a restore whose trace executed action differs from the saved state`, async () => {
    const dialogue = session(strategy);
    await dialogue.start();
    await dialogue.say(broad);
    const untouched = dialogue.record();
    await dialogue.restoreFrom(untouched);
    const tampered = JSON.parse(JSON.stringify(untouched));
    const trace = tampered.jevTraces.find((entry: { status: string }) => entry.status === 'committed');
    assert.ok(trace?.executed, 'a committed trace carries its executed decision');
    trace.executed.action = trace.executed.action === 'confirm' ? 'accept' : 'confirm';
    await assert.rejects(dialogue.restoreFrom(tampered));
  });
}

// Audit v11 (candidate, issues #202, #204, #198). Each fixed form is checked in both strategies through the ordinary entrance; the same input under v10 keeps its judgment.
const saidFacingLeftTwo = 'こちらの図では輪の先が左を向いています。';
const guardCases = [
  // [label, participant text, draft, v10 outcome, v11 outcome]
  ['an own-side 「の上の…」 clause swallowing an unsaid partner-side direction (NB-21N-2)', saidFacingLeft, 'こちらの上の突起は、そちらの上側にあるはずだね。', 'published', 'held'],
  ['an own-side 「の上の中央」 (NB-21N-4)', saidFacingLeft, 'こちらの上の中央に、細い切れ目があります。', 'held', 'published'],
  ['a bracketed direction word nobody said (audit 24)', saidFacingLeft, 'そちらでいう「右上の突起」の先は、切れ目になっていますね。', 'published', 'held'],
  ['a paraphrase of what the participant said (audit 24 c)', saidFacingLeftTwo, 'そちらでいう左向きの先に対応する可能性はありそう。', 'held', 'published'],
  ['「そちらでいうとがっている…」 (NB-24N-3)', saidFacingLeft, 'そちらでいうとがっている左向きの先に対応する可能性はありそう。', 'held', 'published'],
  ['a question about 「そちらの」 plus a direction word', saidFacingLeft, 'そちらの左向きの先端が、この突起に対応しますか？', 'held', 'published'],
] as const;
const guardStillRejected = [
  ['an unmarked direction word', saidFacingLeft, '上端に切れ目があります。'],
  ['an assertion about the partner view the participant did not make', saidFacingLeft, 'そちらの画像では右端に小さな穴が見えます。'],
  ['a quoted phrase whose direction word was never said', saidLowerLeft, 'そちらでいう輪の切れ目から右上に、小さな突起がありますね。'],
] as const;
for (const [label, said, draft, outcome10, outcome11] of guardCases) {
  for (const [version, outcome] of [[v10, outcome10], [v11, outcome11]] as const) {
    test(`Audit v11 ${version.slice(-2)} ${outcome === 'held' ? 'rejects' : 'publishes'} ${label}, in both strategies`, async () => {
      await pairedAs(version, trial => outcome === 'held' ? v10Held(trial, said, draft, version) : v10Published(trial, said, draft, version));
    });
  }
}
for (const [label, said, draft] of guardStillRejected) {
  for (const version of [v10, v11]) {
    test(`Audit v11 ${version.slice(-2)} still rejects ${label}, in both strategies`, async () => {
      await pairedAs(version, trial => v10Held(trial, said, draft, version));
    });
  }
}
// A word the participant corrected away is not excused by a later quotation (audit 24 b).
test('Audit v11 rejects a quotation of a direction word the participant corrected, v10 publishes it, in both strategies', async () => {
  const first = '輪の切れ目から右上に突起があります。';
  const correction = '右上ではなく、左下でした。';
  const draft = 'そちらでいう輪の切れ目から右上に、小さな突起がありますね。';
  for (const [version, held] of [[v10, false], [v11, true]] as const) {
    await pairedAs(version, async trial => {
      await trial.say({ ...broad, ...sayingTurn('こちらの図では' + first), drafts: ['ええ、見えています。'], publicClaims: claimOf('ええ、見えています。') });
      const turn = await trial.say({ ...broad, ...sayingTurn(correction), drafts: held ? [draft, draft] : [draft], publicClaims: claimOf(draft) });
      if (held) { assert.equal(turn.trace.errorCode, 'unsafe_generation'); assert.equal(turn.speech, null); }
      else assert.equal(turn.speech, draft);
    });
  }
});

// Reply rules (through the real run: decision, publication, restore).
for (const strategy of strategies) {
  const build = async (version: string) => {
    const dialogue = session(strategy);
    await dialogue.start();
    await dialogue.restoreAs(version);
    return dialogue;
  };
  const gap = async (dialogue: ReturnType<typeof session>) => {
    const turn = await dialogue.say({ human: 'はい、続けてください。', action: 'accept', target: 0, drafts: ['では続けます。'] });
    assert.equal(turn.trace.status, 'committed');
  };
  for (const [version, offeredAfterRecheck] of [[v10, true], [v11, false]] as const) {
    test(`Audit v11 ${strategy} ${version.slice(-2)}: a re-check question that answers an older one ${offeredAfterRecheck ? 'leaves' : 'withdraws'} the earlier confirmation (NB-19N-1)`, async () => {
      const dialogue = await build(version);
      const question = await audit16Check(dialogue, 0, { questionTargets: [first] });
      await audit16Answer(dialogue, question, 'agree', 0, { aspect: 'referent', targets: [first], human: 'はい、まさにそれです。' });
      await gap(dialogue);
      const human = '本当に同じ図形ですか？';
      const turn = await dialogue.say({ human, action: 'accept', target: 0, drafts: ['そうです。'],
        local: [{ text: human, act: 'ask', aspect: 'referent', targets: [], respondsToTurn: question.sourceTurn + 4, antecedent: { speaker: 'ai', proposition: question.quote } }] });
      assert.equal(turn.trace.status, 'committed');
      const { offered } = await audit16Name(dialogue, baseWidth, [], audit20Proposal);
      assert.equal(offered, offeredAfterRecheck);
    });
  }
  for (const [version, offeredAfterDenial] of [[v10, true], [v11, false]] as const) {
    test(`Audit v11 ${strategy} ${version.slice(-2)}: a denied figure ${offeredAfterDenial ? 'can still be offered' : 'is not offered'} to a later nameless proposal (NB-19N-3)`, async () => {
      const dialogue = await build(version);
      const question = await audit16Check(dialogue, 0, { questionTargets: [first] });
      const human = 'いえ、その図形ではありません。';
      const denied = await dialogue.say({ human, action: 'accept', target: 0, drafts: ['台と環が一続きの形のことです。'],
        publicClaims: [{ text: '台と環が一続きの形のことです。', act: 'assert', aspect: 'part', targets: [first] }],
        local: [{ text: human, act: 'deny', aspect: 'referent', targets: [first], respondsToTurn: question.sourceTurn, antecedent: { speaker: 'ai', proposition: question.quote } }] });
      assert.equal(denied.trace.status, 'committed');
      const { offered } = await audit16Name(dialogue, baseWidth, [], audit20Proposal);
      assert.equal(offered, offeredAfterDenial);
    });
  }
  // #198: the approval request answers the AI's question about the name; v10 keeps losing the request mark, v11 marks it.
  for (const [version, marked] of [[v10, false], [v11, true]] as const) {
    test(`Audit v11 ${strategy} ${version.slice(-2)}: an approval request after the AI's question ${marked ? 'marks' : 'does not mark'} a naming request (#198)`, async () => {
      const dialogue = await build(version);
      const previous = 'この形の呼び名には「' + originalName + '」を提案します。';
      const question = await audit16Check(dialogue, 0, { questionTargets: [first],
        opening: { human: previous, local: [{ text: previous, act: 'name_propose', aspect: 'name', targets: [], name: originalName }] } });
      const human = 'それなら、いい？';
      const named = await dialogue.say({ human, action: 'confirm', target: 0, feature: baseWidth, name: originalName,
        local: [{ text: human, act: 'name_propose', aspect: 'name', targets: [], respondsToTurn: question.sourceTurn, antecedent: { speaker: 'ai', proposition: question.quote } }],
        agreeSpeech, drafts: [baseWidth + '形ですか？'], draftActs: { [agreeSpeech]: 'adopt_chosen' } });
      assert.equal(named.trace.status, 'committed');
      assert.equal(Boolean(named.trace.namingRequest), marked);
    });
  }
  // Not fixed (research judgment): a bare acknowledgement of an ask/part whose target was extracted keeps its judgment in v10 and v11.
  for (const version of [v10, v11]) {
    test(`Audit v11 ${strategy} ${version.slice(-2)}: an acknowledgement of an ask/part with an extracted target keeps offering the name (unchanged, #202 item 3)`, async () => {
      const dialogue = await build(version);
      const question = await audit16Check(dialogue, 0, { questionTargets: [first], questionAspect: 'part' });
      await audit16Answer(dialogue, question, 'agree', 0, { aspect: 'part', targets: [first], human: '質問の意味は分かりました。' });
      const { offered } = await audit16Name(dialogue, baseWidth, [], audit20Proposal);
      assert.equal(offered, true);
    });
  }
}

// Audit 25 (Astra): reproductions of the two v11 regressions, through the ordinary entrance in both strategies. Synthetic wording only.
const correctedName = '星窓';
for (const strategy of strategies) {
  const askAboutShape = '輪より台が細いこの図形のことですか？';
  const proposalOf = (name: string) => '「' + name + '」と呼びませんか？';
  for (const version of [v10, v11]) {
    test(`Audit 25 ${strategy} ${version.slice(-2)}: a corrected name is not offered again after a nameless approval request (#198)`, async () => {
      const dialogue = session(strategy);
      await dialogue.start();
      await dialogue.restoreAs(version);
      const first_ = 'この形は' + proposalOf(originalName);
      await audit16Check(dialogue, 0, { questionTargets: [first],
        opening: { human: first_, local: [{ text: first_, act: 'name_propose', aspect: 'name', targets: [], name: originalName }] } });
      const second = 'やっぱり、この環飾りは' + proposalOf(correctedName);
      const description = '台は輪より細く見えます。';
      const asked = await dialogue.say({ human: second, action: 'confirm', target: 0, feature: baseWidth, drafts: [description + askAboutShape],
        publicClaims: [{ text: description, act: 'assert', aspect: 'part', targets: [first] }, { text: askAboutShape, act: 'ask', aspect: 'question', targets: [first] }],
        local: [{ text: second, act: 'name_propose', aspect: 'name', targets: [first], name: correctedName }] });
      assert.equal(asked.trace.status, 'committed');
      const aiTurn = asked.after.jevTraces.at(-1)!.turnIndex + 1;
      const reply = 'はい、その形です。それなら、その名前でいい？';
      const agreeSpeechCorrected = 'この形は「' + correctedName + '」と呼びましょう。';
      const named = await dialogue.say({ human: reply, action: 'agree', target: 0, name: correctedName, agreeSpeech: agreeSpeechCorrected,
        drafts: [agreeSpeechCorrected], draftActs: { [agreeSpeechCorrected]: 'adopt_chosen' },
        local: [
          { text: 'はい、その形です。', act: 'agree', aspect: 'question', targets: [first], respondsToTurn: aiTurn, antecedent: { speaker: 'ai', proposition: askAboutShape } },
          { text: 'それなら、その名前でいい？', act: 'name_propose', aspect: 'name', targets: [], respondsToTurn: aiTurn, antecedent: { speaker: 'ai', proposition: askAboutShape } },
        ] });
      assert.equal(named.trace.status, 'committed', 'named:' + named.trace.errorCode);
      const offered = (named.after.queueState.privateState.judgments.at(-1)!.jevTurn.agreeNames as Array<{ name: string }>).map(entry => entry.name).sort();
      assert.deepEqual(offered, [correctedName], 'the corrected name alone is a candidate');
      assert.equal(named.speech, agreeSpeechCorrected);
      assert.deepEqual(named.after.ownLedger[first], { status: 'agreed', name: correctedName });
      await dialogue.restore();
      await dialogue.submit([Object.fromEntries(figureIds.map(figureId => [figureId, figureId === first ? correctedName : null]))]);
      assert.deepEqual(dialogue.record().ownLedger[first], { status: 'agreed', name: correctedName });
    });
  }
  test(`Audit 25 ${strategy} v11: with a single proposal the approval request still inherits the name (#198)`, async () => {
    const dialogue = session(strategy);
    await dialogue.start();
    const previous = 'この形は' + proposalOf(originalName);
    const question = await audit16Check(dialogue, 0, { questionTargets: [first],
      opening: { human: previous, local: [{ text: previous, act: 'name_propose', aspect: 'name', targets: [], name: originalName }] } });
    const reply = 'はい、その形です。それなら、その名前でいい？';
    const named = await dialogue.say({ human: reply, action: 'agree', target: 0, name: originalName, agreeSpeech, drafts: [agreeSpeech], draftActs: { [agreeSpeech]: 'adopt_chosen' },
      local: [
        { text: 'はい、その形です。', act: 'agree', aspect: 'question', targets: [first], respondsToTurn: question.sourceTurn, antecedent: { speaker: 'ai', proposition: question.quote } },
        { text: 'それなら、その名前でいい？', act: 'name_propose', aspect: 'name', targets: [], respondsToTurn: question.sourceTurn, antecedent: { speaker: 'ai', proposition: question.quote } },
      ] });
    assert.equal(named.trace.status, 'committed', 'named:' + named.trace.errorCode);
    assert.equal(Boolean(named.trace.namingRequest), true);
    assert.deepEqual((named.after.queueState.privateState.judgments.at(-1)!.jevTurn.agreeNames as Array<{ name: string }>).map(entry => entry.name), [originalName]);
    assert.deepEqual(named.after.ownLedger[first], { status: 'agreed', name: originalName });
  });

  // #204: a legitimate quotation about the same figure after one exchange is published, in v11 as in v10.
  for (const version of [v10, v11]) {
    test(`Audit 25 ${strategy} ${version.slice(-2)}: a quotation about the same figure after one exchange is published (#204)`, async () => {
      const dialogue = session(strategy);
      await dialogue.start();
      await dialogue.restoreAs(version);
      const said = 'こちらの図では、輪の先が左向きです。';
      await dialogue.say({ ...broad, ...sayingTurn(said), drafts: ['その先は輪の切れ目につながっていますか？'],
        publicClaims: [{ text: 'その先は輪の切れ目につながっていますか？', act: 'ask', aspect: 'question', targets: [first] }] });
      const human = 'はい、つながっています。そちらの図だとどうですか？';
      const initial = 'こちらの画面では輪に切れ目があるので、そちらでいう左向きの先に対応するかもしれません。';
      const retry = 'そちらでいう左向きの先は、こちらの画面では輪の切れ目に当たる部分でしょうか？';
      const turn = await dialogue.say({ ...broad, human, drafts: [initial, retry], publicClaims: claimOf(initial),
        local: [{ text: human, act: 'agree', aspect: 'question', targets: [first] }] });
      assert.equal(turn.trace.status, 'committed', turn.trace.errorCode ?? 'the turn was held');
      assert.ok(turn.speech === initial || turn.speech === retry, 'one of the two drafts is published');
      assert.equal(turn.trace.generationRetryVersion, version);
    });
  }
}

// Audit 26 (Astra): the same confirming question asked twice. The classifier may tie the nameless approval request to the earlier of the two identical questions.
for (const strategy of strategies) {
  const repeated = 'そちらが見ているのもこの形ですか？';
  const description = '台は輪より細く見えます。';
  const proposalOf = (name: string) => '「' + name + '」と呼びませんか？';
  const ask = async (dialogue: ReturnType<typeof session>, opening: Pick<Turn, 'human' | 'local'>, correction: string | null) => {
    const check = await audit16Check(dialogue, 0, { questionTargets: [first], opening });
    assert.equal(check.quote, repeated);
    const human = correction ?? '本当にこの形ですよね？';
    const asked = await dialogue.say({ human, action: 'confirm', target: 0, feature: baseWidth, drafts: [description + repeated],
      publicClaims: [{ text: description, act: 'assert', aspect: 'part', targets: [first] }, { text: repeated, act: 'ask', aspect: 'question', targets: [first] }],
      local: [correction === null ? { text: human, act: 'ask', aspect: 'question', targets: [] }
        : { text: human, act: 'name_propose', aspect: 'name', targets: [first], name: correctedName }] });
    assert.equal(asked.trace.status, 'committed');
    return asked.after.jevTraces.at(-1)!.turnIndex + 1;
  };
  const approval = (aiTurn: number) => ({
    // The first half answers the latest question; the second half is tied to the earlier, identical one.
    local: [
      { text: 'はい、その形です。', act: 'agree' as const, aspect: 'question' as const, targets: [first], respondsToTurn: aiTurn, antecedent: { speaker: 'ai' as const, proposition: repeated, pick: 'last' as const } },
      { text: 'それなら、その名前でいい？', act: 'name_propose' as const, aspect: 'name' as const, targets: [], respondsToTurn: aiTurn, antecedent: { speaker: 'ai' as const, proposition: repeated, pick: 'first' as const } },
    ],
  });
  const reply = 'はい、その形です。それなら、その名前でいい？';
  for (const version of [v10, v11]) {
    test(`Audit 26 ${strategy} ${version.slice(-2)}: a corrected name stays alone through publication, ledger, restore and submission when the approval request is tied to the earlier identical question (#198)`, async () => {
      const dialogue = session(strategy);
      await dialogue.start();
      await dialogue.restoreAs(version);
      const first_ = 'この形は' + proposalOf(originalName);
      const aiTurn = await ask(dialogue, { human: first_, local: [{ text: first_, act: 'name_propose', aspect: 'name', targets: [], name: originalName }] },
        'やっぱり、この環飾りは' + proposalOf(correctedName));
      const speech = 'この形は「' + correctedName + '」と呼びましょう。';
      const named = await dialogue.say({ human: reply, action: 'agree', target: 0, name: correctedName, agreeSpeech: speech, drafts: [speech],
        draftActs: { [speech]: 'adopt_chosen' }, ...approval(aiTurn) });
      assert.equal(named.trace.status, 'committed', 'named:' + named.trace.errorCode);
      const offered = (named.after.queueState.privateState.judgments.at(-1)!.jevTurn.agreeNames as Array<{ name: string }>).map(entry => entry.name).sort();
      assert.deepEqual(offered, [correctedName], 'the corrected name alone is a candidate');
      assert.equal(named.speech, speech);
      assert.deepEqual(named.after.ownLedger[first], { status: 'agreed', name: correctedName });
      await dialogue.restore();
      await dialogue.submit([Object.fromEntries(figureIds.map(figureId => [figureId, figureId === first ? correctedName : null]))]);
      assert.deepEqual(dialogue.record().ownLedger[first], { status: 'agreed', name: correctedName });
    });
  }
  // Control: with a single proposal the same approval request keeps inheriting the name.
  test(`Audit 26 ${strategy} v11: with a single proposal and a repeated question the approval request still inherits the name (#198)`, async () => {
    const dialogue = session(strategy);
    await dialogue.start();
    const first_ = 'この形は' + proposalOf(originalName);
    const aiTurn = await ask(dialogue, { human: first_, local: [{ text: first_, act: 'name_propose', aspect: 'name', targets: [], name: originalName }] }, null);
    const speech = 'この形は「' + originalName + '」と呼びましょう。';
    const named = await dialogue.say({ human: reply, action: 'agree', target: 0, name: originalName, agreeSpeech: speech, drafts: [speech],
      draftActs: { [speech]: 'adopt_chosen' }, ...approval(aiTurn) });
    assert.equal(named.trace.status, 'committed', 'named:' + named.trace.errorCode);
    assert.equal(Boolean(named.trace.namingRequest), true);
    assert.deepEqual((named.after.queueState.privateState.judgments.at(-1)!.jevTurn.agreeNames as Array<{ name: string }>).map(entry => entry.name), [originalName]);
    assert.deepEqual(named.after.ownLedger[first], { status: 'agreed', name: originalName });
  });
}
