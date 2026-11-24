// Independent 05s acceptance. All dialogue, observation, requests and responses are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DraftAct, JevAction, JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3, LOCAL_FUNCTION_CRITERIA_V3 } from '../dialogue-model/runtime/local-grounding/classify.ts';
import { buildRecords, MODEL, OWN } from './support/s4-v3-records.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { buildJevLocalTestPayload, createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { deadlines } from './support/s4-integration/harness.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
type Strategy = typeof strategies[number];
const seed = 631;
const scene = createTrialV2({ seed });
const anchors = modelView(scene).anchors;
const slots = anchors.map((anchor: { id: string }) => anchor.id);
const [first, second] = slots;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3', 'holistic_v3');
const feature = '丸い台に細い柱が接する';
const otherFeature = '楕円の穴が一つある';
const name = '環台印';
const clarify = '同じ図形を見ているか確かめたいです。' + feature + '形でしょうか？';
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
type Referent = 'none' | 'multiple' | 'figure_0' | 'figure_1';
type Target = 'figure_0' | 'figure_1' | 'figures_0_1';
type Turn = {
  human: string;
  local?: Segment[];
  publicClaims?: Segment[];
  referent?: Referent;
  action: JevAction;
  target?: Target;
  preferredTarget?: Target;
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
    readKey: async () => 'sk-or-synthetic-offline-05s-key-000000',
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
          const agreeOnFirst = turn.prefer === 'agree' && inputs.at(-1)?.agreeNames?.some(candidate =>
            candidate.figureId === first && candidate.name === name);
          const preferred = turn.prefer === 'accept' || agreeOnFirst ? turn.prefer : undefined;
          selectedAction = preferred && labels.includes(preferred) ? preferred : turn.action;
          choice = selectedAction;
        }
        if (key === 'target') {
          const targeted = selectedAction === turn.prefer ? turn.preferredTarget ?? turn.target : turn.target;
          choice = targeted ?? 'none';
        }
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
          probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
      }));
      return Response.json({ model: request.model, id: 'gen-05s-' + ++responseNo, usage: { cost: 0 }, answers: responses });
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
      return { text: draft.text, model: 'synthetic-05s-luna' };
    } },
    jevResearch: {
      profile, technicalTrial,
      ledger: new RunBudget({ lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 1 }),
      observer: { async observeAll() {
        return {
          observedAt: '2026-01-01T00:00:00.000Z',
          figures: anchors.map((a: { id: string; bbox: object }) => ({
            id: a.id, region: a.bbox, holistic: [], analytic: { shapes: [feature, otherFeature], composition: '丸い台と柱が接する', relations: [] },
            unknowns: [], reobservations: [],
          })),
        };
      }, async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); } },
      jevDecision: { ...native, async decide(next: JevDecisionInput, options?: Parameters<typeof native.decide>[1]) {
        inputs.push(structuredClone(next));
        return native.decide(next, options);
      } },
      localGrounding: {
        classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy })!,
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
      const { eventId } = task.message(next.human, 'offline-05s-' + task.getState().events.length);
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

const boundText = '丸い台に細い柱が付いた形を「' + name + '」と呼びませんか？';
const readyToAdopt: Turn = {
  human: boundText, local: [{ text: boundText, aspect: 'name', act: 'name_propose', name, targets: [first] }],
  action: 'agree', target: 'figure_0', referent: 'figure_0', drafts: [{ text: adoption, naming: 'adopt_chosen' }],
};
function approvalRequest(text: string, original: string, targets: string[] = []): Segment {
  return { text, aspect: 'name', act: 'name_propose', targets, antecedent: { speaker: 'human', quote: original } };
}
function assertAgreedOnFirst(result: Outcome) {
  published(result, 'agree', adoption);
  assert.deepEqual(result.after.ownLedger[first], { status: 'agreed', name });
  assert.deepEqual(Object.entries(result.after.ownLedger)
    .filter(([, entry]) => entry.name === name).map(([id]) => id), [first]);
}

for (const strategy of strategies) {
  for (const referent of ['multiple', 'figure_1', 'figure_0'] as const) {
    test('1 ' + strategy + ' resolves pending-name approval from the current ' + referent + ' estimate', async () => {
      const f = await fixture(strategy);
      const open = '分かりました。呼び名の案ですね。';
      const proposed = await f.say({ ...readyToAdopt, action: 'accept', drafts: plain(open) });
      published(proposed, 'accept', open);
      assert.deepEqual(proposed.after.ownLedger, proposed.before.ownLedger);
      assert.deepEqual(proposed.input.agreeNames?.map(candidate => [candidate.figureId, candidate.name]), [[first, name]]);
      const text = 'その呼び名でいいですか？';
      const lead = referent === 'multiple' ? '似た形が二つあって、まだどちらか決められませんが、'
        : referent === 'figure_1' ? 'いま指しているのは穴のある別の形です。' : 'いま指しているのは丸い台に柱が付いた形です。';
      const reply = referent === 'figure_1' ? '先ほどの形と区別したいです。楕円の穴が一つある形でしょうか？' : clarify;
      const result = await f.say({
        human: lead + text, local: [approvalRequest(text, boundText)], referent,
        prefer: 'agree', preferredTarget: 'figure_0', action: 'confirm',
        target: referent === 'figure_1' ? 'figure_1' : 'figure_0', feature: referent === 'figure_1' ? otherFeature : feature,
        drafts: plain(reply), preferredDraft: { text: adoption, naming: 'adopt_chosen' },
      });
      const source = result.input.priorClaims.find(claim => claim.speaker === 'human' && claim.quote === boundText);
      assert.deepEqual(source?.targets, [first]);
      const estimate = referent === 'multiple' ? 'multiple' : referent === 'figure_1' ? second : first;
      assert.equal(result.input.humanReferent?.scores?.[estimate], 1);
      if (referent === 'figure_0') {
        const relayed = result.input.priorClaims.find(claim => claim.speaker === 'human' && claim.quote === text);
        assert.ok(source && relayed);
        assert.equal(relayed.act, 'name_propose');
        assert.equal(relayed.respondsTo, source.id);
        assert.equal(relayed.name, source.name);
        assert.ok(Object.hasOwn(result.options, 'agree'));
        assertAgreedOnFirst(result);
      } else {
        assert.deepEqual({
          eligibleOnFirst: result.input.agreeNames?.some(candidate => candidate.figureId === first && candidate.name === name),
          speech: result.speech, ledger: result.after.ownLedger,
        }, { eligibleOnFirst: false, speech: reply, ledger: proposed.after.ownLedger });
        published(result, 'confirm', reply);
      }
    });
  }

  for (const referent of ['multiple', 'none'] as const) {
    for (const link of [true, false]) {
      test('2 ' + strategy + ' reconfirms an explicit same-figure name with ' + referent + ' and ' + (link ? 'a link' : 'no link'), async () => {
        const f = await fixture(strategy);
        const agreed = await f.say(readyToAdopt);
        assertAgreedOnFirst(agreed);
        const otherQuestion = 'もう一つの形には楕円の穴がありますか？';
        const otherSegment: Segment = { text: otherQuestion, aspect: 'part', act: 'ask', targets: [second] };
        const otherAnswer = 'もう一つの形には楕円の穴が見えます。';
        if (referent === 'none') {
          const intervening = await f.say({
            human: otherQuestion, local: [otherSegment], referent: 'figure_1', action: 'accept', target: 'figure_1',
            drafts: plain(otherAnswer),
          });
          published(intervening, 'accept', otherAnswer);
          assert.equal(intervening.input.humanReferent?.scores?.[second], 1);
        }
        const text = '丸い台に細い柱が付いた形の呼び名は「' + name + '」でいいですか？';
        const segment: Segment = { text, aspect: 'name', act: 'name_propose', targets: [first], name,
          ...(link ? { antecedent: { speaker: 'human', quote: boundText } } : {}) };
        const affirmative = 'はい、その呼び方で大丈夫です。' + (referent === 'multiple' ? otherAnswer : '');
        const result = await f.say({
          human: referent === 'multiple' ? text + otherQuestion : text,
          local: referent === 'multiple' ? [segment, otherSegment] : [segment],
          referent, prefer: 'accept', preferredTarget: referent === 'multiple' ? 'figures_0_1' : 'figure_0',
          action: 'confirm', target: 'figure_0', feature, drafts: plain(clarify),
          preferredDraft: { text: affirmative, naming: 'adopt_other' },
        });
        assert.equal(result.input.humanReferent?.scores?.[referent], 1);
        const proposal = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === boundText);
        const claim = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === text);
        assert.ok(proposal && claim);
        assert.equal(claim.act, 'name_propose');
        assert.equal(claim.name, name);
        assert.deepEqual(claim.targets, [first]);
        assert.equal(claim.respondsTo, link ? proposal.id : null);
        if (referent === 'multiple') {
          assert.deepEqual(result.input.priorClaims.find(c => c.quote === otherQuestion)?.targets, [second]);
        }
        assert.deepEqual(result.after.ownLedger, agreed.after.ownLedger);
        assert.deepEqual({
          reconfirmation: result.trace.namingReconfirm, namingRequest: result.trace.namingRequest,
          accept: Object.hasOwn(result.options, 'accept'), speech: result.speech,
        }, { reconfirmation: true, namingRequest: undefined, accept: true, speech: affirmative });
        published(result, 'accept', affirmative);
      });
    }
  }
}

type Records = Awaited<ReturnType<typeof buildRecords>>;
type ReplayResult = Awaited<ReturnType<typeof pairedInterventionReplay>>;
function localSend(side: ReplayResult['sides'][number]) {
  const index = side.requests.findIndex(request => request.phase === 'local_function');
  assert.ok(index >= 0, 'the replay must contain the local classification request');
  const request = side.requests[index];
  return { index, request, body: request.payload as JevDecisionPayload };
}
function s4Statuses(records: Records) {
  const checks = interventionChecks(records);
  return ['shape', 'binding', 'execution', 'replay'].map(kind =>
    checks.find(check => check.id === 'intervention.trial.0.attempt.0.' + kind)?.status);
}
const own = { ...OWN, ownImage: { ...OWN.ownImage, mimeType: 'image/png' as const } };
const ownSlots = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);

function changeCriteria(records: Records, variant: 'mixed' | 'two_stage_v1') {
  const copy = structuredClone(records);
  const trial = copy.trials[0];
  const { result, tape } = trial.replay[0];
  const { left, right } = copy.evidence.pairedReplay[0];
  const sides = [...result.sides, left, right] as ReplayResult['sides'];
  for (const side of sides) {
    const { index, request, body } = localSend(side);
    const question = body.questions.segment_0_act;
    assert.deepEqual(question.criteria, LOCAL_FUNCTION_CRITERIA_V3);
    const altered = variant === 'mixed'
      ? { ...question.criteria, ask: LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3.ask }
      : buildJevLocalTestPayload({ ...JSON.parse(body.state), ownSlots }, 'two_stage_v1').questions.segment_0_act.criteria;
    assert.notDeepEqual(altered, question.criteria);
    question.criteria = altered;
    const fingerprint = hash(body);
    request.preProjectionPayloadSha256 = request.payloadSha256 = fingerprint;
    if (side.label === trial.label) {
      assert.equal(tape.recorded.expectedRequests[index].phase, 'local_function');
      assert.equal(trial.calls[index].phase, 'local_function');
      tape.recorded.expectedRequests[index].requestSha256 = fingerprint;
      trial.calls[index].requestSha256 = fingerprint;
    }
  }
  return copy;
}

for (const strategy of strategies) {
  test('3 ' + strategy + ' only accepts the legacy criteria for a holistic_v2 record', async t => {
    const human = '目印としてこの形を「' + name + '」と呼びませんか？';
    const source = await buildRecords({
      label: strategy, dialoguePolicy: 'holistic_v2', technicalTrial,
      turns: [{ human, plan: { action: 'accept', target: 'none', referent: 'none', speech: '名前の案ですね。',
        act: 'name_propose', extraction: extraction([{ text: human, aspect: 'name', act: 'name_propose', name }]) } }],
    });
    const trial = source.trials[0];
    assert.equal(trial.profile.dialoguePolicy, 'holistic_v2');
    assert.deepEqual(s4Statuses(source), ['pass', 'pass', 'pass', 'pass']);
    const original = await pairedInterventionReplay(trial.replay[0].tape, own, MODEL, trial.profile);
    assert.equal(original.status, 'same_material_intervention_verified');
    for (const side of original.sides) {
      const { index, request, body } = localSend(side);
      assert.deepEqual(body.questions.segment_0_act.criteria, LOCAL_FUNCTION_CRITERIA_V3);
      assert.equal(request.preProjectionPayloadSha256, trial.replay[0].tape.recorded.expectedRequests[index].requestSha256);
    }
    for (const variant of ['mixed', 'two_stage_v1'] as const) {
      await t.test('S4 rejects ' + variant + ' criteria even with matching recorded hashes', async () => {
        const copy = changeCriteria(source, variant);
        const edited = copy.trials[0];
        const { tape, result } = edited.replay[0];
        for (const side of result.sides as ReplayResult['sides']) {
          const { index, request, body } = localSend(side);
          assert.equal(hash(body), request.payloadSha256);
          assert.equal(request.payloadSha256, request.preProjectionPayloadSha256);
          assert.equal(request.preProjectionPayloadSha256, tape.recorded.expectedRequests[index].requestSha256);
          assert.equal(request.preProjectionPayloadSha256, edited.calls[index].requestSha256);
        }
        const replay = await pairedInterventionReplay(tape, own, MODEL, edited.profile);
        assert.equal(replay.status, 'same_material_intervention_mismatch');
        assert.equal(replay.recordedPayloadsReproduced, false);
        const verdicts = s4Statuses(copy);
        assert.ok(verdicts.includes('mismatch'), 'S4 accepted ' + variant + ': ' + verdicts.join(', '));
      });
    }
  });
}
