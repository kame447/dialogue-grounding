// Additional 05q acceptance. Dialogue, observation, and all upstream replies are synthetic.
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
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
type Strategy = typeof strategies[number];
const seed = 487;
const scene = createTrialV2({ seed });
const anchors = modelView(scene).anchors;
const slots = anchors.map((anchor: { id: string }) => anchor.id);
const [first, second] = slots;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3', 'holistic_v3');
const feature = '細い弧が短い棒につながる';
const otherFeature = '楕円の穴が一つある';
const name = '弧しおり';
const suggestion = 'この候補の目印を「' + name + '」にしませんか？';
const clarify = '同じ図形を見ているか確かめたいです。' + feature + '形でしょうか？';
const clarifyAgain = '見分けるために、' + otherFeature + '形か教えてください。';
const adoption = 'はい、この形を「' + name + '」と呼びましょう。';

type Segment = {
  text: string;
  aspect: LocalSegmentProposal['aspect'];
  act: LocalAct;
  targets?: string[];
  name?: string;
  antecedent?: { speaker: 'human' | 'ai'; quote: string };
};
function extraction(segments: Segment[] = []): string {
  return JSON.stringify(segments.map((segment, index): LocalSegmentProposal => ({
    segmentId: String(index + 1), quote: segment.text, proposition: segment.text, aspect: segment.aspect,
    name: segment.name ?? null, targets: segment.targets ?? [], linkedIssueId: null, respondsToTurn: null,
  })));
}
const proposal: Segment = { text: suggestion, aspect: 'name', act: 'name_propose', name };
type Referent = 'none' | 'multiple' | 'figure_0' | 'figure_1';
type Turn = {
  human: string;
  local?: Segment[];
  publicClaims?: Segment[];
  referent?: Referent;
  referentScores?: Partial<Record<Referent, number>>;
  action: JevAction;
  target?: 'figure_0' | 'figure_1' | 'figures_0_1';
  feature?: string;
  prefer?: 'agree' | 'accept';
  drafts: Array<{ text: string; naming?: DraftAct }>;
  preferredDraft?: { text: string; naming: DraftAct };
};
type Saved = {
  ownLedger: JevPrivateState['ledger'];
  jevTraces: JevTurnTrace[];
};
const plain = (text: string) => [{ text }];
const firstClarification: Turn = {
  human: suggestion, local: [proposal], action: 'confirm', target: 'figure_0', feature, drafts: plain(clarify),
};

async function fixture(strategy: Strategy) {
  let turn: Turn;
  let requests: JevDecisionPayload[] = [];
  let inputs: JevDecisionInput[] = [];
  let generated: string[] = [];
  let saved: Saved | undefined;
  let responseNo = 0;
  let selectedAction: JevAction;
  const drafts = () => selectedAction === turn.prefer && turn.preferredDraft ? [turn.preferredDraft] : turn.drafts;
  const transport = {
    enabled: true, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    readKey: async () => 'sk-or-synthetic-offline-05q-extra-key-000000',
    async fetchImpl(_url: string, init: RequestInit) {
      const request = JSON.parse(String(init.body)) as JevDecisionPayload;
      const state = JSON.parse(request.state) as {
        aiSeq?: number; priorClaims?: Pick<LocalClaimView, 'speaker' | 'proposition'>[]; draft?: string;
      };
      requests.push(request);
      const responses = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        const labels = Object.keys(question.criteria);
        let choice: string | undefined;
        if (key === 'human_referent') choice = turn.referent ?? 'none';
        if (key === 'repair_issue') choice = 'none';
        if (key === 'prospect') choice = 'no_open_issue';
        if (key === 'basis') choice = 'none';
        if (key === 'action') {
          selectedAction = turn.prefer && labels.includes(turn.prefer) ? turn.prefer : turn.action;
          choice = selectedAction;
        }
        if (key === 'target') choice = turn.target ?? 'none';
        if (key === 'feature' || key === 'name') {
          choice = labels.find(label => JSON.parse(question.criteria[label]).value === (key === 'name' ? name : turn.feature));
        }
        if (key === 'draft_naming') {
          const draft = drafts()[generated.length - 1];
          assert.equal(state.draft, draft.text);
          choice = draft.naming ?? 'none';
        }
        const segmentQuestion = /^segment_(\d+)_(act|antecedent|support)$/u.exec(key);
        if (segmentQuestion) {
          const [, index, field] = segmentQuestion;
          const claims = state.aiSeq !== undefined || field === 'support' ? turn.publicClaims : turn.local;
          const segment = claims?.[Number(index)];
          assert.ok(segment, key);
          if (field === 'act') choice = segment.act;
          if (field === 'support') choice = 'expressed';
          if (field === 'antecedent') {
            choice = 'none';
            if (segment.antecedent) {
              const { speaker, quote } = segment.antecedent;
              const at = state.priorClaims?.findIndex(c => c.speaker === speaker && c.proposition === quote) ?? -1;
              assert.ok(at >= 0, 'earlier public claim must be offered to the classifier');
              choice = 'claim_' + at;
            }
          }
        }
        assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
        return [key, { type: 'choice', choice,
          probabilities: Object.fromEntries(labels.map(label =>
            [label, key === 'human_referent' && turn.referentScores ? turn.referentScores[label as Referent] ?? 0 : Number(label === choice)])) }];
      }));
      return Response.json({ model: request.model, id: 'gen-05q-extra-' + ++responseNo, usage: { cost: 0 }, answers: responses });
    },
  };
  const native = createJevDecisionClient(transport)!;
  const task = await createNamingTaskV2({
    strategy, seed, runDir: null, createTrial: () => scene, utteranceStyle: profile.utteranceStyle,
    client: { async complete(_messages: unknown, { phase }: { phase: string }) {
      if (phase === 'local_extraction') return { text: extraction(turn.local) };
      if (phase === 'ai_extraction') return { text: extraction(turn.publicClaims) };
      assert.equal(phase, 'generation');
      const draft = drafts()[generated.length];
      assert.ok(draft, 'unexpected generation attempt');
      generated.push(draft.text);
      return { text: draft.text, model: 'synthetic-05q-extra-luna' };
    } },
    jevResearch: {
      profile, technicalTrial,
      ledger: new RunBudget({ lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 1 }),
      observer: { async observeAll() {
        return {
          observedAt: '2026-01-01T00:00:00.000Z',
          figures: anchors.map((a: { id: string; bbox: object }) => ({
            id: a.id, region: a.bbox, holistic: [], analytic: { shapes: [feature, otherFeature], composition: '弧と短い棒が接する', relations: [] },
            unknowns: [], reobservations: [],
          })),
        };
      }, async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); } },
      jevDecision: { ...native, async decide(next: JevDecisionInput, options?: Parameters<typeof native.decide>[1]) {
        inputs.push(structuredClone(next));
        return native.decide(next, options);
      } },
      localGrounding: {
        classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs })!,
        timeoutMs: profile.timeouts.localMs, aiPublicTransport: transport, aiPublicClaims: profile.localGrounding.aiPublicClaims,
      },
    },
    onPersist(record: unknown) { saved = structuredClone(record) as Saved; },
  });
  function record() {
    assert.ok(saved, 'task must persist its record');
    return saved;
  }
  return {
    async say(next: Turn) {
      turn = next;
      requests = [];
      generated = [];
      inputs = [];
      const before = record();
      const { eventId } = task.message(next.human, 'offline-05q-extra-' + task.getState().events.length);
      await task.whenIdle();
      const after = record();
      const trace = after.jevTraces.at(-1);
      const input = inputs.at(-1);
      assert.ok(input && trace);
      assert.equal(trace.lastEventId, eventId);
      const latest = task.getState().events.at(-1);
      const speech = latest?.speaker === 'ai' ? latest.text : null;
      const options = requests.find(r => r.questions.action)?.questions.action.criteria;
      assert.ok(options, 'the real action question must have been sent');
      return { before, after, trace, speech, input, options, aiStatus: task.getState().aiStatus };
    },

  };
}
type Outcome = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['say']>>;
function published(outcome: Outcome, action: JevAction, text: string) {
  assert.equal(outcome.trace.status, 'committed', outcome.trace.errorCode ?? 'turn must commit');
  assert.equal(outcome.aiStatus, 'idle');
  assert.equal(outcome.trace.executed?.action, action);
  assert.equal(outcome.trace.publicSpeech, text);
  assert.equal(outcome.speech, text);
}

const boundText = '細い弧が付いた一つの形を「' + name + '」と呼びませんか？';
const describeText = '細い弧に短い棒がつながった形があります。';
const describe: Turn = {
  human: '見えている図形を一つ説明してもらえますか？',
  action: 'accept', target: 'figure_0', drafts: plain(describeText),
  publicClaims: [{ text: describeText, aspect: 'part', act: 'assert', targets: [first] }],
};
const readyToAdopt: Turn = {
  human: boundText, local: [{ ...proposal, text: boundText, targets: [first] }],
  action: 'agree', target: 'figure_0', referent: 'figure_0', drafts: [{ text: adoption, naming: 'adopt_chosen' }],
};
function approvalRequest(text: string, original: string, targets: string[] = []): Segment {
  return { text, aspect: 'name', act: 'name_propose', targets, antecedent: { speaker: 'human', quote: original } };
}
function assertInherited(result: Outcome, text: string, original: string, targets: string[]) {
  const proposal = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === original);
  const request = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === text);
  assert.ok(proposal && request);
  assert.equal(request.act, 'name_propose');
  assert.equal(request.aspect, 'name');
  assert.equal(request.respondsTo, proposal.id);
  assert.equal(request.name, name);
  assert.deepEqual(request.targets, targets);
}
function assertAgreedOnFirst(result: Outcome) {
  published(result, 'agree', adoption);
  assert.deepEqual(result.after.ownLedger[first], { status: 'agreed', name });
  assert.deepEqual(Object.entries(result.after.ownLedger)
    .filter(([, entry]) => entry.name === name).map(([id]) => id), [first]);
}

for (const strategy of strategies) {
  for (const later of [false, true]) {
    test('1 ' + strategy + (later ? ' accepts a later reconfirmation of the agreed name' : ' accepts an immediate short reconfirmation'),
      async () => {
        const f = await fixture(strategy);
        const original = await f.say(readyToAdopt);
        assertAgreedOnFirst(original);
        if (later) {
          const topic = 'もう一つの図形には楕円の穴がありますか？';
          const speech = 'はい、穴が一つ見えます。';
          published(await f.say({
            human: topic, local: [{ text: topic, aspect: 'part', act: 'ask', targets: [second] }],
            referent: 'figure_1', action: 'accept', target: 'figure_1', drafts: plain(speech),
          }), 'accept', speech);
        }
        const text = later ? 'それで、さっきの「' + name + '」でいい？' : 'いい？';
        const affirmation = later ? 'はい、その呼び方で大丈夫です。' : 'うん、いいよ。';
        const result = await f.say({
          human: text, local: [approvalRequest(text, boundText, later ? [first] : [])],
          referent: later ? 'figure_0' : 'none',
          prefer: 'accept', action: 'confirm', target: 'figure_0', feature, drafts: plain(clarify),
          preferredDraft: { text: affirmation, naming: 'adopt_other' },
        });
        assertInherited(result, text, boundText, [first]);
        assert.ok(Object.hasOwn(result.options, 'accept'), 'a request to confirm an existing agreement offers accept');
        published(result, 'accept', affirmation);
        assert.deepEqual(result.after.ownLedger, original.after.ownLedger);
      });
  }

  test('1 ' + strategy + ' cannot adopt the same name for a different figure', async () => {
    const f = await fixture(strategy);
    const original = await f.say(readyToAdopt);
    assertAgreedOnFirst(original);
    const text = '今度は楕円の穴がある別の形も「' + name + '」と呼びませんか？';
    const forbidden = 'うん、その呼び方にしましょう。';
    const reply = '呼び名が重なると区別しにくいです。楕円の穴が一つある別の形でしょうか？';
    const result = await f.say({
      human: text, local: [{ ...proposal, text, targets: [second] }], referent: 'figure_1',
      prefer: 'agree', action: 'confirm', target: 'figure_1', feature: otherFeature,
      drafts: [{ text: forbidden, naming: 'adopt_other' }, { text: reply }],
      preferredDraft: { text: 'この別の形も「' + name + '」と呼びましょう。', naming: 'adopt_chosen' },
    });
    const request = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === text);
    assert.deepEqual(request?.targets, [second]);
    assert.equal(request?.act, 'name_propose');
    assert.equal(request?.name, name);
    assert.equal(result.input.humanReferent?.scores?.[second], 1);
    assert.ok(!Object.hasOwn(result.options, 'agree'));
    assert.deepEqual(result.input.agreeNames, []);
    assert.notEqual(result.speech, forbidden);
    published(result, 'confirm', reply);
    assert.deepEqual(result.after.ownLedger, original.after.ownLedger);
    assert.deepEqual(result.after.ownLedger[second], { status: 'unassigned', name: null });
  });

  for (const evidence of ['single', 'multiple', 'none'] as const) {
    test('2 ' + strategy + ' short approval after ' + evidence + ' referent evidence', async () => {
      const f = await fixture(strategy);
      published(await f.say(describe), 'accept', describeText);
      const proposed = await f.say(firstClarification);
      published(proposed, 'confirm', clarify);
      assert.deepEqual(proposed.input.priorClaims.find(c => c.quote === suggestion)?.targets, []);
      assert.deepEqual(proposed.after.ownLedger, proposed.before.ownLedger);

      if (evidence !== 'none') {
        const text = evidence === 'single' ? 'その弧に短い棒が付いた一つの形を指しています。'
          : '似た形が二つあって、まだどちらか決められません。';
        const response = evidence === 'single' ? 'その形のことですね。' : 'まだ二つの候補があるのですね。';
        const detail = await f.say({
          human: text, local: [{ text, aspect: 'referent', act: 'assert', targets: evidence === 'single' ? [first] : [first, second] }],
          referent: evidence === 'single' ? 'figure_0' : 'multiple', action: 'accept',
          target: evidence === 'single' ? 'figure_0' : 'figures_0_1', drafts: plain(response),
        });
        published(detail, 'accept', response);
        assert.equal(detail.input.humanReferent?.scores?.[evidence === 'single' ? first : 'multiple'], 1);
      }
      const text = 'その呼び名でいい？';
      assert.ok(!text.includes(name));
      const result = await f.say({
        human: text, local: [approvalRequest(text, suggestion)], referent: 'none',
        referentScores: evidence === 'none' ? { none: 0.91, figure_0: 0.09 } : undefined,
        prefer: 'agree', action: 'confirm', target: 'figure_0', feature: otherFeature,
        drafts: plain(clarifyAgain), preferredDraft: { text: adoption, naming: 'adopt_chosen' },
      });
      assertInherited(result, text, suggestion, []);
      assert.equal(result.input.humanReferent?.scores?.none, evidence === 'none' ? 0.91 : 1);
      if (evidence === 'single') {
        assert.deepEqual(result.input.agreeNames?.map(candidate => [candidate.figureId, candidate.name]), [[first, name]]);
        assert.ok(Object.hasOwn(result.options, 'agree'));
        assertAgreedOnFirst(result);
      } else {
        assert.ok(!Object.hasOwn(result.options, 'agree'));
        assert.deepEqual(result.input.agreeNames, []);
        published(result, 'confirm', clarifyAgain);
        assert.deepEqual(result.after.ownLedger, proposed.after.ownLedger);
      }
    });
  }
}
