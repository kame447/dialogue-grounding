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
            choice = Object.keys(criteria).find(label => JSON.parse(criteria[label]).value === turn[key]) ?? Object.keys(criteria)[0];
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
      // The naming scope of a saved record follows its generation version (v11 scoped_v6, v8-v10 scoped_v5, v7 scoped_v4, v6 scoped_v3).
      const state = (saved as any).queueState?.privateState;
      if (state && Object.hasOwn(state, 'agreeNameScopeVersion')) state.agreeNameScopeVersion = ({ 11: 'scoped_v6', 10: 'scoped_v5', 9: 'scoped_v5', 8: 'scoped_v5', 7: 'scoped_v4', 6: 'scoped_v3' } as Record<number, string>)[Number(version.replace('jev_generation_retry_v', ''))] ?? state.agreeNameScopeVersion;
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

// Audit 31 B-31A-1: a confirmation and a withdrawal in one utterance; the saved record must restore on the ordinary entrance and take the next utterance.
const confirmSeg = { text: 'その呼び名でいいですか？', aspect: 'name' as const, act: 'name_propose' as const, targets: [] as string[],
  antecedent: { speaker: 'human' as const, proposition: firstProposal } };
const withdrawSeg = { text: 'やっぱり、さっきの名前の案は取り下げます。', aspect: 'name' as const, act: 'withdraw' as const, targets: [] as string[],
  antecedent: { speaker: 'human' as const, proposition: firstProposal } };
const independent = { text: '代わりに「月輪」はどうですか？', aspect: 'name' as const, act: 'name_propose' as const, name: '月輪', targets: [first] };
const reply = '輪に切れ目があるか確認してもいいですか？';
const combos: Array<[string, Segment[], boolean]> = [
  ['confirm and withdraw together (the audit 31 case)', [confirmSeg, withdrawSeg], false],
  ['confirm only', [confirmSeg], true],
  ['withdraw only', [withdrawSeg], false],
  ['confirm, withdraw, then an independent new name', [confirmSeg, withdrawSeg, independent], true],
];
for (const strategy of strategies) for (const [label, local, marked] of combos) {
  test(strategy + ' B-31A-1: ' + label + ' restores after a restart and takes the next utterance', async () => {
    const trial = session(strategy, memo, profile, 200);
    await trial.start();
    await trial.say(broad);
    await keepNamePending(trial);
    const text = local.map(s => s.text).join('');
    const turn = await trial.say({ human: text, local, action: 'confirm', target: 0, feature: ringGap, drafts: [reply] });
    assert.equal(turn.trace.status, 'committed', 'turn: ' + turn.trace.errorCode + ' ' + JSON.stringify(turn.trace.decisionRejectionCode ?? null));
    const saved = trial.record() as any;
    const z = saved.queueState.privateState.judgments.at(-1).jevTurn;
    assert.equal(Object.hasOwn(z, 'namingRequest'), marked, 'marker of the combined turn');
    const restarted = session(strategy, memo, profile, 200);
    await restarted.start();
    await restarted.restoreFrom(saved);
    const next = await restarted.say({ human: '台の幅についてはどうですか？', action: 'confirm', target: 0, feature: baseWidth, drafts: ['台が環より細いか確認してもいいですか？'] });
    assert.equal(next.trace.status, 'committed', 'next utterance: ' + next.trace.errorCode);
  });
}


// Audit 31 B-31A-2: holistic_v3; an agreed name that was deferred and then proposed again is a request, not a reconfirmation.
const reproposeText = 'さっきの「' + originalName + '」でいいですか？';
const reproposal: Segment = { text: reproposeText, aspect: 'name', act: 'name_propose', name: originalName, targets: [first] };
const deferTurn: Turn = { human: 'いったん、呼び名は保留にしましょう。', action: 'defer', target: 0, drafts: ['では、呼び名は保留にします。'] };
for (const strategy of strategies) {
  const fresh = async () => { const t = session(strategy, memo, holisticV3Profile, 200); await t.start(); return t; };
  const restores = async (saved: unknown) => { const t = await fresh(); await t.restoreFrom(saved); };
  // The repair-first strategy vetoes a defer (the audit's demonstration is bypass-enabled), so the sequence exists only there.
  if (strategy === 'bypass-enabled') test(strategy + ' holistic_v3 B-31A-2: agree, defer, propose again: the genuine request restores; a reconfirmation in state and trace is refused', async () => {
    const trial = await fresh();
    await trial.say(broad);
    await keepNamePending(trial);
    const agreement = await trial.say(adopt);
    published(agreement, 'agree', single(first), agreeSpeech);
    const deferred = await trial.say(deferTurn);
    assert.equal(deferred.trace.status, 'committed', 'defer: ' + deferred.trace.errorCode);
    const again = await trial.say({ human: reproposeText, local: [reproposal], action: 'accept', target: 0, drafts: ['台の話ですね。'] });
    assert.equal(again.trace.status, 'committed', 'repropose: ' + again.trace.errorCode);
    const saved = trial.record() as any;
    const last = saved.queueState.privateState.judgments.at(-1).jevTurn;
    console.error('HW_B31B', strategy, 'marker', Object.hasOwn(last, 'namingRequest') ? 'request' : Object.hasOwn(last, 'namingReconfirm') ? 'reconfirm' : 'none', 'ledger', JSON.stringify(saved.ownLedger[first]));
    assert.ok(Object.hasOwn(last, 'namingRequest'));
    await restores(saved);
    const bad = JSON.parse(JSON.stringify(saved));
    const j = bad.queueState.privateState.judgments.at(-1);
    const t = bad.jevTraces.find((x: any) => x.turnIndex === j.turnIndex && x.status === 'committed');
    for (const z of [j.jevTurn, t]) { delete z.namingRequest; z.namingReconfirm = true; }
    await assert.rejects(restores(bad));
  });
  test(strategy + ' holistic_v3 B-31A-2: a genuine reconfirmation of a still-agreed name still restores', async () => {
    const trial = await fresh();
    await trial.say(broad);
    await keepNamePending(trial);
    await trial.say(adopt);
    const again = await trial.say({ human: reproposeText, local: [reproposal], action: 'accept', target: 0, drafts: ['「' + originalName + '」ですね。'] });
    assert.equal(again.trace.status, 'committed', 'reconfirm: ' + again.trace.errorCode);
    const saved = trial.record() as any;
    const last = saved.queueState.privateState.judgments.at(-1).jevTurn;
    console.error('HW_B31B-ctl', strategy, Object.hasOwn(last, 'namingReconfirm') ? 'reconfirm' : Object.hasOwn(last, 'namingRequest') ? 'request' : 'none');
    await restores(saved);
  });
}
