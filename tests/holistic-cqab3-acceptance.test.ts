// Synthetic cqab3 acceptance. Every extraction, classification, and generation reply is offline.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DraftAct, JevAction, JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { deadlines } from './support/s4-integration/harness.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
type Strategy = typeof strategies[number];
const seed = 731;
const scene = createTrialV2({ seed });
const anchors = modelView(scene).anchors;
const first = anchors[0].id;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3', 'holistic_v3');
const feature = '丸い輪に小さな突起が付く';
const otherFeature = '楕円の穴が一つある';
const name = '輪かざり札';
const suggestion = '呼び名を「' + name + '」にしませんか？';
const boundSuggestion = '丸い輪に突起が付いた形を「' + name + '」と呼びませんか？';
const clarify = '丸い輪に小さな突起が付く形のことですか？';
const clarifyAgain = 'どの図形か確かめたいです。楕円の穴が一つある形ですか？';
const adoption = 'はい、この形を「' + name + '」と呼びましょう。';
const affirmation = 'うん、いいよ。';
const description = '丸い輪に小さな突起が付いています。';

type Antecedent = Pick<LocalClaimView, 'speaker' | 'act' | 'name'>;
type Segment = {
  text: string;
  aspect: LocalSegmentProposal['aspect'];
  act: LocalAct;
  targets?: string[];
  name?: string;
  respondsToTurn?: number;
  antecedent?: Antecedent;
};
function extractedSegment(segment: Segment): LocalSegmentProposal {
  return {
    segmentId: '1', quote: segment.text, proposition: segment.text, aspect: segment.aspect,
    name: segment.name ?? null, targets: segment.targets ?? [], linkedIssueId: null,
    respondsToTurn: segment.respondsToTurn ?? null,
  };
}
type Draft = { text: string; naming?: DraftAct };
type Turn = {
  human: string;
  local?: Segment;
  publicClaim?: Segment;
  referent?: 'none' | 'figure_0';
  actions: JevAction[];
  feature?: string;
  drafts: Draft[];
};
type Saved = {
  ownLedger: JevPrivateState['ledger'];
  jevTraces: JevTurnTrace[];
  events: { speaker: string; seq: number; text: string }[];
};
type OfferedClaim = Antecedent & Pick<LocalClaimView, 'id' | 'sourceTurn'>;

async function fixture(strategy: Strategy) {
  let turn: Turn;
  let requests: JevDecisionPayload[] = [];
  let localReplies: { act?: string; antecedent?: OfferedClaim }[] = [];
  let sentExtractions: LocalSegmentProposal[] = [];
  let inputs: JevDecisionInput[] = [];
  let generated: string[] = [];
  let saved: Saved | undefined;
  let responseNo = 0;
  const transport = {
    enabled: true, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    readKey: async () => 'sk-or-synthetic-offline-cqab3-key-000000',
    async fetchImpl(_url: string, init: RequestInit) {
      const request = JSON.parse(String(init.body)) as JevDecisionPayload;
      const state = JSON.parse(request.state) as { aiSeq?: number; priorClaims?: OfferedClaim[]; draft?: string };
      requests.push(request);
      const localReply: typeof localReplies[number] = {};
      const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        const labels = Object.keys(question.criteria);
        let choice: string | undefined;
        if (key === 'human_referent') choice = turn.referent ?? 'none';
        if (key === 'repair_issue' || key === 'basis') choice = 'none';
        if (key === 'prospect') choice = 'no_open_issue';
        if (key === 'action') choice = turn.actions.find(action => labels.includes(action));
        if (key === 'target') choice = 'figure_0';
        if (key === 'feature' || key === 'name') {
          const expected = key === 'name' ? name : turn.feature;
          choice = labels.find(label => JSON.parse(question.criteria[label]).value === expected);
        }
        if (key === 'draft_naming') {
          const draft = turn.drafts[generated.length - 1];
          assert.equal(state.draft, draft.text);
          choice = draft.naming ?? 'none';
        }
        if (key === 'segment_0_act' || key === 'segment_0_antecedent' || key === 'segment_0_support') {
          const isAi = state.aiSeq !== undefined || key === 'segment_0_support';
          const segment = isAi ? turn.publicClaim : turn.local;
          assert.ok(segment, key);
          if (key === 'segment_0_act') {
            choice = segment.act;
            if (!isAi) localReply.act = choice;
          }
          if (key === 'segment_0_support') choice = 'expressed';
          if (key === 'segment_0_antecedent') {
            choice = 'none';
            if (segment.antecedent) {
              const { speaker, act, name } = segment.antecedent;
              const index = state.priorClaims?.findIndex(claim =>
                claim.speaker === speaker && claim.act === act && claim.name === name) ?? -1;
              assert.ok(state.priorClaims && index >= 0, 'the real antecedent must be offered');
              choice = 'claim_' + index;
              if (!isAi) localReply.antecedent = state.priorClaims[index];
            }
          }
        }
        assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
        return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
          labels.map(label => [label, Number(label === choice)]),
        ) }];
      }));
      if (localReply.act) localReplies.push(localReply);
      return Response.json({ model: request.model, id: 'synthetic-cqab3-' + ++responseNo, usage: { cost: 0 }, answers });
    },
  };
  const native = createJevDecisionClient(transport)!;
  const task = await createNamingTaskV2({
    strategy, seed, runDir: null, createTrial: () => scene, utteranceStyle: profile.utteranceStyle,
    client: { async complete(_messages: unknown, { phase }: { phase: string }) {
      if (phase === 'local_extraction') {
        if (turn.local) sentExtractions.push(extractedSegment(turn.local));
        return { text: JSON.stringify(sentExtractions) };
      }
      if (phase === 'ai_extraction') {
        return { text: JSON.stringify(turn.publicClaim ? [extractedSegment(turn.publicClaim)] : []) };
      }
      assert.equal(phase, 'generation');
      const draft = turn.drafts[generated.length];
      assert.ok(draft, 'unexpected generation attempt');
      generated.push(draft.text);
      return { text: draft.text, model: 'synthetic-cqab3-luna' };
    } },
    jevResearch: {
      profile, technicalTrial: { version: 'adaptive_repair_v3' },
      ledger: new RunBudget({ lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 1 }),
      observer: { async observeAll() {
        return {
          observedAt: '2026-01-01T00:00:00.000Z',
          figures: anchors.map((a: { id: string; bbox: object }) => ({
            id: a.id, region: a.bbox, holistic: [],
            analytic: { shapes: [feature, otherFeature], composition: '輪と小さな突起が接する', relations: [] },
            unknowns: [], reobservations: [],
          })),
        };
      }, async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); } },
      jevDecision: { ...native, async decide(next: JevDecisionInput, options?: Parameters<typeof native.decide>[1]) {
        inputs.push(structuredClone(next));
        return native.decide(next, options);
      } },
      localGrounding: {
        classifier: createJevLocalTestClassifier({
          ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy,
        })!,
        timeoutMs: profile.timeouts.localMs, aiPublicTransport: transport, aiPublicClaims: profile.localGrounding.aiPublicClaims,
      },
    },
    onPersist(record: unknown) { saved = structuredClone(record) as Saved; },
  });
  return {
    async say(next: Turn) {
      turn = next;
      requests = [];
      localReplies = [];
      sentExtractions = [];
      inputs = [];
      generated = [];
      const { eventId } = task.message(next.human, 'offline-cqab3-' + task.getState().events.length);
      await task.whenIdle();
      const trace = saved?.jevTraces.at(-1);
      const options = requests.find(request => request.questions.action)?.questions.action.criteria;
      const input = inputs.at(-1);
      assert.ok(saved && trace && input && options, 'the actual decision must be requested and persisted');
      assert.equal(trace.lastEventId, eventId);
      const { events, aiStatus } = task.getState();
      const latest = events.at(-1);
      const lastSavedEvent = saved.events.at(-1);
      if (latest?.speaker === 'ai') {
        assert.equal(lastSavedEvent?.speaker, 'ai');
        assert.equal(lastSavedEvent.text, latest.text);
      }
      const ai = latest?.speaker === 'ai' ? { text: latest.text, seq: lastSavedEvent?.seq } : null;
      return { saved, trace, input, options, ai, aiStatus, sentExtractions, localReplies, generated };
    },
  };
}
type Outcome = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['say']>>;

function published(outcome: Outcome, action: JevAction, speech: string) {
  assert.equal(outcome.trace.status, 'committed', outcome.trace.errorCode ?? 'turn must commit');
  assert.equal(outcome.aiStatus, 'idle');
  assert.equal(outcome.trace.executed?.action, action);
  assert.equal(outcome.trace.publicSpeech, speech);
  assert.ok(outcome.ai);
  assert.equal(outcome.ai.text, speech);
  assert.ok(Number.isInteger(outcome.ai.seq) && outcome.ai.seq !== undefined, 'the public reply has a persisted turn number');
  return outcome.ai.seq;
}

const humanName: Antecedent = { speaker: 'human', act: 'name_propose', name };
const aiName: Antecedent = { speaker: 'ai', act: 'name_accept', name };
const aiFeature: Antecedent = { speaker: 'ai', act: 'assert', name: null };
function approval(text: string, lastAiTurn: number, antecedent: Antecedent): Segment {
  return { text, aspect: 'name', act: 'name_propose', respondsToTurn: lastAiTurn, antecedent };
}

function assertApprovalReply(outcome: Outcome, lastAiTurn: number, antecedent: Antecedent) {
  assert.equal(outcome.sentExtractions.length, 1);
  const segment = outcome.sentExtractions[0];
  assert.equal(segment.aspect, 'name');
  assert.equal(segment.name, null);
  assert.equal(segment.respondsToTurn, lastAiTurn);
  assert.equal(outcome.localReplies.length, 1);
  const reply = outcome.localReplies[0];
  assert.equal(reply.act, 'name_propose');
  const source = reply.antecedent;
  assert.ok(source, 'the classifier must select a real antecedent');
  assert.deepEqual({ speaker: source.speaker, act: source.act, name: source.name }, antecedent);
  if (antecedent.speaker === 'human') assert.ok(source.sourceTurn < lastAiTurn, 'the human proposal predates the AI reply');
  else assert.equal(source.sourceTurn, lastAiTurn);
}

function latestClaim(outcome: Outcome, text: string) {
  return outcome.input.priorClaims.find(claim => claim.speaker === 'human' && claim.quote === text);
}

for (const strategy of strategies) {
  test(strategy + ': an approval linked to a pending human proposal keeps accept and oral adoption out', async () => {
    const f = await fixture(strategy);
    const proposed = await f.say({
      human: suggestion, local: { text: suggestion, aspect: 'name', act: 'name_propose', name },
      actions: ['confirm'], feature, drafts: [{ text: clarify }],
    });
    const priorAiTurn = published(proposed, 'confirm', clarify);
    assert.deepEqual(latestClaim(proposed, suggestion)?.targets, []);
    assert.equal(proposed.saved.ownLedger[first]?.status, 'unassigned');

    const text = 'その呼び名でいい？';
    const outcome = await f.say({
      human: text, local: approval(text, priorAiTurn, humanName), actions: ['accept', 'confirm'],
      feature: otherFeature, drafts: [{ text: affirmation, naming: 'adopt_other' }, { text: clarifyAgain }],
    });
    assertApprovalReply(outcome, priorAiTurn, humanName);
    assert.deepEqual(outcome.saved.ownLedger, proposed.saved.ownLedger);
    assert.equal(outcome.generated[0], affirmation);
    assert.deepEqual({
      inheritedName: latestClaim(outcome, text)?.name,
      namingRequest: outcome.trace.namingRequest, accept: Object.hasOwn(outcome.options, 'accept'),
      agree: Object.hasOwn(outcome.options, 'agree'), oralAdoptionPublished: outcome.ai?.text === affirmation,
    }, { inheritedName: name, namingRequest: true, accept: false, agree: false, oralAdoptionPublished: false });
    published(outcome, 'confirm', clarifyAgain);
  });

  for (const antecedent of [humanName, aiName]) {
    test(strategy + ': an agreed name can be reconfirmed through the ' + antecedent.speaker + ' claim', async () => {
      const f = await fixture(strategy);
      const agreed = await f.say({
        human: boundSuggestion, referent: 'figure_0',
        local: { text: boundSuggestion, aspect: 'name', act: 'name_propose', name, targets: [first] },
        actions: ['agree'], drafts: [{ text: adoption, naming: 'adopt_chosen' }],
      });
      const priorAiTurn = published(agreed, 'agree', adoption);
      assert.deepEqual(agreed.saved.ownLedger[first], { status: 'agreed', name });

      const text = 'いい？';
      const outcome = await f.say({
        human: text, local: approval(text, priorAiTurn, antecedent), actions: ['accept', 'confirm'],
        feature: otherFeature, drafts: [{ text: affirmation, naming: 'adopt_other' }, { text: clarifyAgain }],
      });
      assertApprovalReply(outcome, priorAiTurn, antecedent);
      assert.deepEqual(outcome.saved.ownLedger, agreed.saved.ownLedger);
      assert.deepEqual({
        inheritedName: latestClaim(outcome, text)?.name,
        namingRequest: outcome.trace.namingRequest, namingReconfirm: outcome.trace.namingReconfirm,
        accept: Object.hasOwn(outcome.options, 'accept'), publicReply: outcome.ai?.text,
      }, {
        inheritedName: name,
        namingRequest: undefined, namingReconfirm: true, accept: true, publicReply: affirmation,
      });
      published(outcome, 'accept', affirmation);
    });
  }

  test(strategy + ': a nameless feature claim does not supply a name to an approval segment', async () => {
    const f = await fixture(strategy);
    const described = await f.say({
      human: '模様を一つ説明してもらえますか？', actions: ['accept'],
      drafts: [{ text: description }], publicClaim: { text: description, aspect: 'part', act: 'assert', targets: [first] },
    });
    const priorAiTurn = published(described, 'accept', description);
    const text = 'その呼び名でいい？';
    const neutralReply = '先ほどは図形の特徴を説明しました。';
    const outcome = await f.say({
      human: text, local: approval(text, priorAiTurn, aiFeature), actions: ['accept'],
      drafts: [{ text: neutralReply }],
    });
    assertApprovalReply(outcome, priorAiTurn, aiFeature);
    assert.ok(outcome.input.priorClaims.every(claim => claim.name === null));
    assert.deepEqual(outcome.input.agreeNames, []);
    assert.equal(outcome.trace.namingRequest, undefined);
    assert.equal(outcome.trace.namingReconfirm, undefined);
    assert.deepEqual(outcome.saved.ownLedger, described.saved.ownLedger);
    published(outcome, 'accept', neutralReply);
  });
}
