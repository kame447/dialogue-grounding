// Synthetic 05p acceptance. Native choice requests are answered by an offline transport.
import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionForStrategy } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import type { DraftAct, JevAction, JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { deadlines } from './support/s4-integration/harness.ts';
import { buildRecords, OWN, runTurn } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const seed = 305;
const scene = createTrialV2({ seed });
const anchors = modelView(scene).anchors;
const slots = anchors.map((anchor: { id: string }) => anchor.id);
const [first, second] = slots;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3');
const feature = '輪に短い柄が接する';
const otherFeature = '縁に浅い切れ目がある';
const name = '月つまみ';
const suggestion = '仮の呼び名を「' + name + '」にしませんか？';
const clarify = '指している形を確かめたいです。' + feature + '形でしょうか？';
const clarifyAgain = '同じ形か確かめるために、' + otherFeature + '形か教えてください。';
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
type Turn = {
  human: string;
  local?: Segment[];
  publicClaims?: Segment[];
  referent?: 'none' | 'multiple' | 'figure_0';
  action: JevAction;
  target?: 'figure_0' | 'figures_0_1';
  feature?: string;
  prefer?: 'agree' | 'accept';
  drafts: Array<{ text: string; naming?: DraftAct }>;
  agreeDraft?: { text: string; naming: DraftAct };
  badTarget?: true;
};
type Saved = {
  ownLedger: JevPrivateState['ledger'];
  queueState: { privateState: JevPrivateState };
  jevTraces: JevTurnTrace[];
};
const plain = (text: string) => [{ text }];
const firstClarification: Turn = {
  human: suggestion, local: [proposal], action: 'confirm', target: 'figure_0', feature, drafts: plain(clarify),
};
const actionCost = 0.00002;
const targetCost = 0.00003;
const actionId = 'gen-05p-valid-action';
const targetId = 'gen-05p-invalid-target';

async function fixture(strategy: Label) {
  let turn: Turn;
  let requests: JevDecisionPayload[] = [];
  let inputs: JevDecisionInput[] = [];
  let nativeFailure: unknown;
  let generated: string[] = [];
  let saved: Saved | undefined;
  let responseNo = 0;
  let selectedAction: JevAction;
  const drafts = () => selectedAction === 'agree' && turn.agreeDraft ? [turn.agreeDraft] : turn.drafts;
  const transport = {
    enabled: true, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    readKey: async () => 'sk-or-synthetic-offline-05p-key-000000',
    async fetchImpl(_url: string, init: RequestInit) {
      const request = JSON.parse(String(init.body)) as JevDecisionPayload;
      const state = JSON.parse(request.state) as {
        aiSeq?: number; priorClaims?: Pick<LocalClaimView, 'speaker' | 'proposition'>[]; draft?: string;
      };
      requests.push(request);
      const keys = Object.keys(request.questions);
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
        if (key === 'target') choice = selectedAction === 'accept' && turn.prefer === 'accept' ? 'none' : turn.target ?? 'none';
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
        // Only B4 corrupts a native response. The response envelope and usage still describe a real send.
        assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
        return [key, { type: 'choice', choice: turn.badTarget && key === 'target' ? 'figure_99' : choice,
          probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
      }));
      const billedAction = turn.badTarget && keys.includes('action');
      const billedTarget = turn.badTarget && keys.includes('target');
      return Response.json({ model: request.model,
        id: billedAction ? actionId : billedTarget ? targetId : 'gen-05p-' + ++responseNo,
        usage: { cost: billedAction ? actionCost : billedTarget ? targetCost : 0 }, answers: responses });
    },
  };
  const native = createJevDecisionClient(transport)!;
  async function open(restore?: Saved) {
    const task = await createNamingTaskV2({
      strategy, seed, runDir: null, createTrial: () => scene, restore: restore ?? null, utteranceStyle: profile.utteranceStyle,
      client: { async complete(_messages: unknown, { phase }: { phase: string }) {
        if (phase === 'local_extraction') return { text: extraction(turn.local) };
        if (phase === 'ai_extraction') return { text: extraction(turn.publicClaims) };
        assert.equal(phase, 'generation');
        const draft = drafts()[generated.length];
        assert.ok(draft, 'unexpected generation attempt');
        generated.push(draft.text);
        return { text: draft.text, model: 'synthetic-05p-luna' };
      } },
      jevResearch: {
        profile, technicalTrial,
        ledger: new RunBudget({ lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 1 }),
        observer: { async observeAll() {
          return {
            observedAt: '2026-01-01T00:00:00.000Z',
            figures: anchors.map((a: { id: string; bbox: object }) => ({
              id: a.id, region: a.bbox, holistic: [], analytic: { shapes: [feature, otherFeature], composition: '輪と柄が接する', relations: [] },
              unknowns: [], reobservations: [],
            })),
          };
        }, async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); } },
        jevDecision: { ...native, async decide(next: JevDecisionInput, options?: Parameters<typeof native.decide>[1]) {
          inputs.push(structuredClone(next));
          return native.decide(next, { ...options, onFailureEvidence(evidence) {
            nativeFailure = structuredClone(evidence);
            options?.onFailureEvidence?.(evidence);
          } });
        } },
        localGrounding: {
          classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy })!,
          timeoutMs: profile.timeouts.localMs, aiPublicTransport: transport, aiPublicClaims: profile.localGrounding.aiPublicClaims,
        },
      },
      onPersist(record: unknown) { saved = structuredClone(record) as Saved; },
    });
    return task;
  }
  let task = await open();
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
      nativeFailure = undefined;
      const before = record();
      const { eventId } = task.message(next.human, 'offline-05p-' + task.getState().events.length);
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
      return { before, after, trace, speech, input, options, requests, generated, nativeFailure };
    },
    async restore() {
      const restored = JSON.parse(JSON.stringify(record())) as Saved;
      saved = undefined;
      task = await open(restored);
      return record();
    },
  };
}
type Outcome = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['say']>>;
function published(outcome: Outcome, action: JevAction, text: string) {
  assert.equal(outcome.trace.status, 'committed', outcome.trace.errorCode ?? 'turn must commit');
  assert.equal(outcome.trace.executed?.action, action);
  assert.equal(outcome.trace.publicSpeech, text);
  assert.equal(outcome.speech, text);
}

for (const policy of ['holistic_v3', 'holistic_v2'] as const) {
  for (const original of ['defer', 'move_on'] as const) {
    test('B1 ' + policy + ' ' + original + ' survives a first-turn veto and replays on both labels', async t => {
      const older = policy === 'holistic_v2';
      const scores = older ? { [original]: 0.6, confirm: 0.25, repair: 0.1, accept: 0.05 }
        : { [original]: 0.6, confirm: 0.29, repair: 0.11 };
      const speech = '形がまだ分からないので、輪郭の手がかりを教えてください。';
      const ids = OWN.ownAnchors.map((a: { id: string }) => a.id);
      for (const label of strategies) {
        const records = await buildRecords({ label, dialoguePolicy: policy, technicalTrial, turns: [{
          human: suggestion, plan: { action: original, target: 'figure_0', actionScores: scores,
            speech, extraction: extraction([proposal]), act: 'name_propose' },
        }] });
        const trial = records.trials[0];
        const trace = trial.attempts[0];
        const restored = trial.lastCommittedState;
        const { tape, result } = trial.replay[0];
        const vetoed = label === 'repair-first';
        assert.equal(trace.status, 'committed');
        assert.equal(trace.publicSpeech, speech);
        assert.equal(trace.decisions[0].action, original);
        assert.deepEqual(trace.decisions[0].target, { kind: 'single', figureId: ids[0] });
        assert.equal(trace.executed.action, vetoed ? 'confirm' : original);
        assert.deepEqual(trace.executed.target, trace.decisions[0].target);
        assert.deepEqual(restored.judgments.at(-1).jevTurn.agreeNames, []);
        const offered = trace.decisions[0].evidence.stages[0].scores.action;
        assert.equal(Object.hasOwn(offered, 'accept'), older);
        if (vetoed) {
          const ranking = trace.intervention.rerank;
          assert.equal(ranking.policyId, 'saved_action_scores_v1');
          assert.deepEqual(ranking.ranking.filter((item: { score: number }) => item.score > 0),
            older ? [{ action: 'confirm', score: 0.25 }, { action: 'repair', score: 0.1 }, { action: 'accept', score: 0.05 }]
              : [{ action: 'confirm', score: 0.29 }, { action: 'repair', score: 0.11 }]);
          assert.equal(ranking.ranking.some((item: { action: string }) => item.action === 'accept'), older);
        }
        await t.test(label + ' state validates after JSON round trip', () => {
          const snapshot = JSON.parse(JSON.stringify(restored));
          const intervention = interventionForStrategy(label);
          assert.deepEqual(validateJevPrivateStateV2(snapshot, ids, intervention, 'two_stage_v3', policy), snapshot);
          if (!older) assert.throws(() => validateJevPrivateStateV2(snapshot, ids, intervention, 'two_stage_v3'), { code: 'invalid_state' });
        });
        await t.test(label + ' processes the next public human turn', async () => {
          const seq = tape.events.at(-1).seq;
          const events = [...tape.events, { id: 'ai-' + (seq + 1), seq: seq + 1, speaker: 'ai', text: speech },
            { id: 'human-' + (seq + 2), seq: seq + 2, speaker: 'human', text: '縁に小さな切れ目が見えます。' }];
          const followUp = '切れ目があるのですね。';
          const next = await runTurn(trial.profile, label, restored, events, { action: 'accept', target: 'none', speech: followUp },
            technicalTrial);
          assert.equal(next.speech, followUp);
          assert.equal(next.trace.executed.action, 'accept');
          assert.equal(next.state.judgments.length, restored.judgments.length + 1);
        });
        await t.test(label + ' passes S4 and verifies the same material in dynamic replay', () => {
          assert.equal(result.status, 'same_material_intervention_verified');
          assert.deepEqual(result.sides.map((side: { label: string; executed: { action: string } }) =>
            [side.label, side.executed.action]), [['repair-first', 'confirm'], ['bypass-enabled', original]]);
          const checks = interventionChecks(records);
          const expected = ['shape', 'binding', 'execution', 'replay'];
          const verdicts = expected.map(check => [check, checks.find(c => c.id === 'intervention.trial.0.attempt.0.' + check)?.status]);
          assert.deepEqual(verdicts, expected.map(check => [check, 'pass']));
        });
      }
    });
  }
}

for (const strategy of strategies) {
  for (const ambiguous of [true, false]) {
    test('B2 ' + strategy + (ambiguous ? ' keeps two possible referents unnamed' : ' adopts the name for a shared referent'),
      async () => {
        const f = await fixture(strategy);
        const description = '一つは輪に短い柄が付いた形です。';
        const firstTurn = await f.say({
          human: '似ている候補を一つ説明してください。', action: 'accept', target: 'figure_0',
          drafts: plain(description), publicClaims: [{ text: description, aspect: 'part', act: 'assert', targets: [first] }],
        });
        published(firstTurn, 'accept', description);
        assert.deepEqual(firstTurn.trace.executed?.target, { kind: 'single', figureId: first });
        const reply = ambiguous ? 'ええ、その特徴がある二つのうちの一つです。まだどちらかは分かりません。'
          : '輪に短い柄が付いた、いま説明してもらった一つの形を指しています。';
        const replySegment: Segment = ambiguous
          ? { text: reply, aspect: 'referent', act: 'agree', targets: [first, second], antecedent: { speaker: 'ai', quote: description } }
          : { text: reply, aspect: 'referent', act: 'assert', targets: [first] };
        const acknowledgment = ambiguous ? 'まだ候補が二つあるのですね。' : '同じ形を指しているのですね。';
        const prior = await f.say({
          human: reply, local: [replySegment], referent: ambiguous ? 'multiple' : 'figure_0',
          action: 'accept', target: ambiguous ? 'figures_0_1' : 'figure_0', drafts: plain(acknowledgment),
        });
        published(prior, 'accept', acknowledgment);
        assert.equal(prior.trace.humanReferent?.scores?.[ambiguous ? 'multiple' : first], 1);
        // The name proposal adds no referent evidence. Pick agree if the real menu allows it.
        const result = await f.say({ ...firstClarification, prefer: 'agree', agreeDraft: { text: adoption, naming: 'adopt_chosen' } });
        assert.equal(result.trace.humanReferent?.scores?.none, 1);
        const verifiedProposal = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === suggestion);
        assert.equal(verifiedProposal?.act, 'name_propose');
        assert.deepEqual(verifiedProposal?.targets, []);
        if (ambiguous) {
          assert.deepEqual({
            published: result.speech, nameInLedger: Object.values(result.after.ownLedger).filter(e => e.name !== null),
            agreeOffered: Object.hasOwn(result.options, 'agree'),
          }, { published: clarify, nameInLedger: [], agreeOffered: false });
          published(result, 'confirm', clarify);
          assert.deepEqual(result.after.ownLedger, prior.after.ownLedger);
        } else {
          assert.deepEqual(result.input.agreeNames, [{ name, figureId: first, sourceTurn: result.input.turn }]);
          published(result, 'agree', adoption);
          assert.deepEqual(result.after.ownLedger[first], { status: 'agreed', name });
        }
      });
  }
}

const approval = 'いま出した呼び名を使ってもいいですか？';
const approvalClaim: Segment = { text: approval, aspect: 'name', act: 'name_propose', antecedent: { speaker: 'human', quote: suggestion } };
const approvalTurn: Turn = {
  human: approval, local: [approvalClaim], action: 'confirm', target: 'figure_0', feature: otherFeature, drafts: plain(clarifyAgain),
};

for (const strategy of strategies) {
  test('B3 ' + strategy + ' retains the link to an unbound proposal and can ask for clarification', async () => {
    const f = await fixture(strategy);
    const initial = await f.say(firstClarification);
    published(initial, 'confirm', clarify);
    const result = await f.say(approvalTurn);
    published(result, 'confirm', clarifyAgain);
    const proposed = result.input.priorClaims.find(c => c.quote === suggestion);
    const requested = result.input.priorClaims.find(c => c.quote === approval);
    assert.ok(proposed && requested);
    assert.deepEqual({
      response: requested.respondsTo, requestTargets: requested.targets, acceptOffered: Object.hasOwn(result.options, 'accept'),
      agreeOffered: Object.hasOwn(result.options, 'agree'),
    }, { response: proposed.id, requestTargets: [], acceptOffered: false, agreeOffered: false });
    assert.equal(requested.act, 'name_propose');
    assert.equal(requested.aspect, 'name');
    assert.equal(requested.name, proposed.name);
    assert.deepEqual(proposed.targets, []);
    assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
  });

  test('B3 ' + strategy + ' keeps a spoken-only approval draft private', async () => {
    const f = await fixture(strategy);
    published(await f.say(firstClarification), 'confirm', clarify);
    const unsupported = 'ええ、その呼び方に賛成です。';
    const result = await f.say({
      ...approvalTurn, prefer: 'accept',
      drafts: [{ text: unsupported, naming: 'adopt_other' }, { text: clarifyAgain }],
    });
    assert.equal(result.generated[0], unsupported);
    assert.notEqual(result.speech, unsupported);
    assert.notEqual(result.trace.publicSpeech, unsupported);
    assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
    if (result.trace.status === 'committed') published(result, 'confirm', clarifyAgain);
    else {
      assert.equal(result.trace.errorCode, 'unsafe_generation');
      assert.equal(result.speech, null);
    }
  });

  const backchannel = 'はい、聞いています。';
  const featureQuestion = '縁に浅い切れ目はありますか？';
  for (const local of [
    { text: backchannel, aspect: 'progress', act: 'acknowledge' },
    { text: featureQuestion, aspect: 'part', act: 'ask' },
  ] satisfies Segment[]) {
    test('B3 ' + strategy + ' leaves accept for ' + local.act + ' unrelated to naming', async () => {
      const f = await fixture(strategy);
      published(await f.say(firstClarification), 'confirm', clarify);
      const reply = local.act === 'ask' ? 'こちらからは浅い切れ目が見えます。' : '続きを聞かせてください。';
      const result = await f.say({ human: local.text, local: [local], action: 'accept', drafts: plain(reply) });
      published(result, 'accept', reply);
      assert.ok(Object.hasOwn(result.options, 'accept'));
      assert.ok(!Object.hasOwn(result.options, 'agree'));
      assert.ok(!result.requests.some(r => r.questions.draft_naming));
      assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
    });
  }

  test('B4 ' + strategy + ' restores both native stages and costs after target rejects', async () => {
    const f = await fixture(strategy);
    const result = await f.say({ ...firstClarification, badTarget: true, drafts: [] });
    assert.ok(!Object.hasOwn(result.options, 'accept'));
    assert.equal(result.trace.status, 'error');
    assert.equal(result.trace.errorCode, 'decision_failed');
    assert.equal(result.trace.executed, null);
    assert.equal(result.speech, null);
    assert.deepEqual(result.generated, []);
    assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
    const expected = [
      { stage: 'action', status: 'ok', error: null, responseId: actionId, costUsd: actionCost },
      { stage: 'target', status: 'error', error: 'invalid_response', responseId: targetId, costUsd: targetCost },
    ];
    type Evidence = NonNullable<NonNullable<JevTurnTrace['decisionFailure']>['evidence']>;
    type Stage = Evidence['stages'][number];
    const stageSummary = (stage: Stage) => {
      const { stage: name, status, error, responseId, costUsd } = stage;
      return { stage: name, status, error, responseId, costUsd };
    };
    const observed = result.nativeFailure as { stages: Stage[] };
    assert.ok(observed, 'the native decision client must report the failed call');
    assert.deepEqual(observed.stages.map(stageSummary), expected, 'the actual native client observed both responses');
    const evidence = result.trace.decisionFailure?.evidence;
    assert.ok(evidence, 'both native stages must survive the failure trace projection');
    assert.equal(evidence.questionLayout, 'two_stage_v3');
    assert.equal(evidence.error, 'invalid_response');
    assert.equal(evidence.responseId, targetId);
    assert.equal(evidence.costUsd, actionCost + targetCost);
    assert.deepEqual(evidence.stages.map(stageSummary), expected);
    assert.equal(evidence.stages[0].choices.action, 'confirm');
    const restored = await f.restore();
    assert.deepEqual(restored.jevTraces.at(-1)?.decisionFailure, result.trace.decisionFailure);
  });
}
