// Independent 05q acceptance. All upstream responses, dialogue and records are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DialoguePolicy, DraftAct, JevAction, JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { deadlines } from './support/s4-integration/harness.ts';
import { buildRecords, OWN, runTurn } from './support/s4-v3-records.ts';
import type { Label, Turn as ReplayTurn } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const seed = 955;
const scene = createTrialV2({ seed });
const anchors = modelView(scene).anchors;
const slots = anchors.map((anchor: { id: string }) => anchor.id);
const [first, second] = slots;
const trialProfile = (policy: DialoguePolicy | null = 'holistic_v3') => researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3', policy);
const feature = '角の丸い台に細い突起が付く';
const otherFeature = '小さな穴が一つある';
const name = '小舟印';
const suggestion = '目印の名前を「' + name + '」にしませんか？';
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
const actionId = 'gen-05q-valid-action';
const targetId = 'gen-05q-invalid-target';

async function fixture(strategy: Label, policy: DialoguePolicy | null = 'holistic_v3') {
  const profile = trialProfile(policy);
  let turn: Turn;
  let requests: JevDecisionPayload[] = [];
  let inputs: JevDecisionInput[] = [];
  let generated: string[] = [];
  let saved: Saved | undefined;
  let responseNo = 0;
  let selectedAction: JevAction;
  const drafts = () => selectedAction === 'agree' && turn.agreeDraft ? [turn.agreeDraft] : turn.drafts;
  const transport = {
    enabled: true, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    readKey: async () => 'sk-or-synthetic-offline-05q-key-000000',
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
        // Only the failure-record fixture corrupts a native response. The response envelope and usage still describe a real send.
        assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
        return [key, { type: 'choice', choice: turn.badTarget && key === 'target' ? 'figure_99' : choice,
          probabilities: Object.fromEntries(labels.map(label =>
            [label, key === 'human_referent' && turn.referentScores ? turn.referentScores[label as Referent] ?? 0 : Number(label === choice)])) }];
      }));
      const billedAction = turn.badTarget && keys.includes('action');
      const billedTarget = turn.badTarget && keys.includes('target');
      return Response.json({ model: request.model,
        id: billedAction ? actionId : billedTarget ? targetId : 'gen-05q-' + ++responseNo,
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
        return { text: draft.text, model: 'synthetic-05q-luna' };
      } },
      jevResearch: {
        profile, technicalTrial,
        ledger: new RunBudget({ lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 1 }),
        observer: { async observeAll() {
          return {
            observedAt: '2026-01-01T00:00:00.000Z',
            figures: anchors.map((a: { id: string; bbox: object }) => ({
              id: a.id, region: a.bbox, holistic: [], analytic: { shapes: [feature, otherFeature], composition: '台と突起がつながる', relations: [] },
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
    return task;
  }
  let task = await open();
  function record() {
    assert.ok(saved, 'task must persist its record');
    return saved;
  }
  return {
    record,
    async say(next: Turn) {
      turn = next;
      requests = [];
      generated = [];
      inputs = [];
      const before = record();
      const { eventId } = task.message(next.human, 'offline-05q-' + task.getState().events.length);
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
      return { before, after, trace, speech, input, options, requests, generated };
    },
    async restore(source: Saved) {
      const previous = saved;
      saved = undefined;
      try {
        await open(JSON.parse(JSON.stringify(source)) as Saved);
        return record();
      } finally {
        saved = previous;
      }
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

const describeText = '丸い角の台から細い突起が出た図形が見えます。';
function describe(id: string): Segment {
  return { text: describeText, act: 'assert', aspect: 'part', targets: [id] };
}
const introduce: Turn = {
  human: '候補を一つ選んで、見える特徴を教えてください。', action: 'accept', target: 'figure_0',
  drafts: plain(describeText), publicClaims: [describe(first)],
};
const compare = 'その特徴がある形は二つです。どちらなのかは、まだ絞れません。';
function twoCandidates(ids: string[]): Segment {
  return { text: compare, aspect: 'referent', act: 'assert', targets: ids };
}
const leaveAmbiguous: Turn = {
  human: compare, local: [twoCandidates([first, second])], referent: 'multiple',
  action: 'accept', target: 'figures_0_1', drafts: plain('まだ候補が二つあるのですね。'),
};
const pickOneText = '見比べたら、細い突起が付いた丸い角の台だけを指していました。';
const pickOne: Turn = {
  human: pickOneText, local: [{ text: pickOneText, aspect: 'referent', act: 'assert', targets: [first] }],
  referent: 'figure_0', action: 'accept', target: 'figure_0', drafts: plain('同じ輪郭を見ているのですね。'),
};
const agreement: Pick<Turn, 'prefer' | 'agreeDraft'> = { prefer: 'agree', agreeDraft: { text: adoption, naming: 'adopt_chosen' } };
const tryNaming: Turn = { ...firstClarification, ...agreement };

function stillUnnamed(result: Outcome, question = clarify) {
  assert.deepEqual({
    agree: Object.hasOwn(result.options, 'agree'),
    speech: result.speech,
    agreed: Object.values(result.after.ownLedger).filter(entry => entry.status === 'agreed'),
  }, { agree: false, speech: question, agreed: [] });
  assert.deepEqual(result.input.agreeNames, []);
  published(result, 'confirm', question);
  assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
}
function adopted(result: Outcome) {
  assert.equal(Object.hasOwn(result.options, 'agree'), true);
  assert.deepEqual(result.input.agreeNames?.map(candidate => ({ name: candidate.name, figureId: candidate.figureId })), [{ name, figureId: first }]);
  published(result, 'agree', adoption);
  assert.deepEqual(result.after.ownLedger[first], { status: 'agreed', name });
  assert.deepEqual(Object.entries(result.after.ownLedger).filter(([, entry]) => entry.status === 'agreed').map(([id]) => id), [first]);
}

// The extracted approval carries no literal name. Its verified claim inherits
// the name from the human proposal selected by the classifier.
function approvalRequest(text: string, antecedent: string): Segment {
  return { text, aspect: 'name', act: 'name_propose', antecedent: { speaker: 'human', quote: antecedent } };
}

for (const strategy of strategies) {
  for (const both of [false, true]) {
    test('2 ' + strategy + ' keeps ambiguity when the AI ' + (both ? 'repeats both candidates' : 'restates a feature'), async () => {
      const f = await fixture(strategy);
      published(await f.say(introduce), 'accept', describeText);
      const statement = both ? '私からも、似た形が二つ見えます。' : '見えている方は台から細い突起が出ています。';
      const draft = statement + (both ? 'どちらでしょうか？' : 'この形でしょうか？');
      const repeated = await f.say({
        ...leaveAmbiguous, action: 'confirm', target: both ? 'figures_0_1' : 'figure_0', feature,
        drafts: plain(draft), publicClaims: [{
          text: statement, aspect: both ? 'referent' : 'part', act: 'assert', targets: both ? [first, second] : [first],
        }],
      });
      published(repeated, 'confirm', draft);
      assert.equal(repeated.trace.humanReferent?.scores?.multiple, 1);
      const result = await f.say({ ...tryNaming, feature: otherFeature, drafts: plain(clarifyAgain) });
      assert.equal(result.trace.humanReferent?.scores?.none, 1);
      assert.deepEqual(result.input.priorClaims.find(c => c.quote === statement && c.speaker === 'ai')?.targets, both ? [first, second] : [first]);
      assert.deepEqual(result.input.priorClaims.find(c => c.quote === suggestion && c.act === 'name_propose')?.targets, []);
      stillUnnamed(result, clarifyAgain);
    });
  }

  for (const both of [true, false]) {
    test('3 ' + strategy + (both ? ' cannot adopt a two-target proposal' : ' can adopt a single-target proposal'), async () => {
      const f = await fixture(strategy);
      await f.say(introduce);
      const offered = both ? 'まだ片方に決めていませんが、この二つのどちらかを「' + name + '」と呼びませんか？'
        : '細い突起が付いた丸い角の台を「' + name + '」と呼びませんか？';
      const targets = both ? [first, second] : [first];
      const result = await f.say({
        ...tryNaming, human: offered, referent: both ? 'multiple' : 'figure_0',
        local: [{ ...proposal, text: offered, targets }],
      });
      assert.equal(result.trace.humanReferent?.scores?.[both ? 'multiple' : first], 1);
      assert.deepEqual(result.input.priorClaims.find(c => c.quote === offered && c.act === 'name_propose')?.targets, targets);
      if (both) stillUnnamed(result);
      else adopted(result);
    });
  }

  for (const shared of [false, true]) {
    test('4 ' + strategy + ' none-first preserves ' + (shared ? 'the shared figure' : 'the unresolved pair'), async () => {
      const f = await fixture(strategy);
      await f.say(introduce);
      const prior = await f.say(shared ? pickOne : leaveAmbiguous);
      assert.equal(prior.trace.humanReferent?.scores?.[shared ? first : 'multiple'], 1);
      const result = await f.say({ ...tryNaming, referent: 'none',
        referentScores: shared ? { none: 0.91, figure_1: 0.09 } : { none: 0.91, figure_0: 0.09 } });
      assert.equal(result.trace.humanReferent?.scores?.none, 0.91);
      assert.equal(result.trace.humanReferent?.scores?.[shared ? second : first], 0.09);
      if (shared) adopted(result);
      else stillUnnamed(result);
    });
  }

  test('4 ' + strategy + ' a new single-figure estimate can resolve a pending unbound proposal', async () => {
    const f = await fixture(strategy);
    await f.say(introduce);
    await f.say(leaveAmbiguous);
    const pending = await f.say({ ...firstClarification, referent: 'none' });
    published(pending, 'confirm', clarify);
    assert.deepEqual(pending.after.ownLedger, pending.before.ownLedger);
    const updated = await f.say({ ...pickOne, ...agreement });
    assert.equal(updated.trace.humanReferent?.scores?.[first], 1);
    adopted(updated);
  });

  for (const recall of [false, true]) {
    test('5 ' + strategy + (recall ? ' directly recalls an agreed name' : ' directly answers who proposed the name'), async () => {
      const f = await fixture(strategy);
      if (recall) {
        await f.say(introduce);
        adopted(await f.say({ ...tryNaming, referent: 'figure_0', local: [{ ...proposal, targets: [first] }] }));
      } else {
        published(await f.say(firstClarification), 'confirm', clarify);
      }
      const question = recall ? '先ほど採用した名前は何でしたか？' : 'その名前の案を最初に出したのはどちらでしたか？';
      const answer = recall ? '先ほど決めた名前は「' + name + '」でした。' : 'その案を出したのは、あなたです。';
      const result = await f.say({
        human: question, local: [{ text: question, aspect: 'name', act: 'ask',
          targets: recall ? [first] : [], antecedent: { speaker: 'human', quote: suggestion } }],
        action: 'confirm', prefer: 'accept', target: 'figure_0', feature: otherFeature,
        drafts: plain(answer),
      });
      const fact = result.input.priorClaims.find(c => c.quote === question);
      assert.equal(fact?.act, 'ask');
      assert.equal(fact?.respondsTo, result.input.priorClaims.find(c => c.quote === suggestion)?.id);
      assert.deepEqual({
        accept: Object.hasOwn(result.options, 'accept'), namingRequest: result.input.namingRequest, action: result.trace.executed?.action,
      }, { accept: true, namingRequest: undefined, action: 'accept' });
      published(result, 'accept', answer);
      assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
    });
  }

  test('5 ' + strategy + ' blocks oral approval when the requested name has no grounded figure', async () => {
    const f = await fixture(strategy);
    published(await f.say(firstClarification), 'confirm', clarify);
    const question = '今の呼び名を採用しても大丈夫ですか？';
    const unsupported = 'はい、その呼び方で決めましょう。';
    const result = await f.say({
      human: question, local: [approvalRequest(question, suggestion)], action: 'confirm', prefer: 'accept',
      target: 'figure_0', feature: otherFeature, drafts: [{ text: unsupported, naming: 'adopt_other' }, { text: clarifyAgain }],
    });
    assert.equal(result.input.priorClaims.find(c => c.quote === question)?.respondsTo,
      result.input.priorClaims.find(c => c.quote === suggestion)?.id);
    assert.ok(!Object.hasOwn(result.options, 'accept') && !Object.hasOwn(result.options, 'agree'));
    assert.deepEqual(result.generated, [unsupported, clarifyAgain]);
    published(result, 'confirm', clarifyAgain);
    assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
  });
}

const replaySlots: string[] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const [replayFirst, replaySecond] = replaySlots;
const neutral: ReplayTurn = {
  human: '小さな穴はありますか？', plan: { action: 'accept', target: 'none', referent: 'none', speech: '小さな穴が見えます。' },
};
const explicitName: ReplayTurn = {
  human: suggestion,
  plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '名前の案ですね。',
    act: 'name_propose', extraction: extraction([{ ...proposal, targets: [replayFirst] }]) },
};

type Records = Awaited<ReturnType<typeof buildRecords>>;
const s4Kinds = ['shape', 'binding', 'execution', 'replay'] as const;
function s4Statuses(records: Records, attempt = 0) {
  const checks = interventionChecks(records);
  return s4Kinds.map(kind => checks.find(check => check.id === 'intervention.trial.0.attempt.' + attempt + '.' + kind)?.status);
}
function passingS4(records: Records, attempt = 0) {
  assert.deepEqual(s4Statuses(records, attempt), ['pass', 'pass', 'pass', 'pass']);
}
function rejectedS4(records: Records, attempt = 0) {
  const statuses = s4Statuses(records, attempt);
  assert.ok(statuses.includes('mismatch'), 'S4 must reject the conflicting record. Actual verdicts: ' + statuses.join(', '));
}
function savedCopies(records: Records): JevPrivateState[] {
  const trial = records.trials[0];
  return [trial.lastCommittedState, trial.turns.at(-1).state];
}
function traceCopies(records: Records, attempt = 0): JevTurnTrace[] {
  const trial = records.trials[0];
  return [trial.attempts[attempt], trial.turns[attempt].trace[0]];
}
function nextEvents(records: Records, human: string) {
  const trial = records.trials[0];
  const tape = trial.replay[0].tape;
  const seq = tape.events.at(-1).seq;
  return [...tape.events,
    { id: 'ai-' + (seq + 1), seq: seq + 1, speaker: 'ai', text: trial.attempts.at(-1).publicSpeech },
    { id: 'human-' + (seq + 2), seq: seq + 2, speaker: 'human', text: human }];
}

const markerCases = [
  { policy: 'holistic_v3', edit: 'add' },
  { policy: 'holistic_v3', edit: 'delete' },
  { policy: 'holistic_v3', edit: 'move' },
  { policy: 'holistic_v2', edit: 'add' },
  { policy: null, edit: 'add' },
] as const;
type MarkerEdit = typeof markerCases[number]['edit'];
function corruptSavedMarker(state: JevPrivateState, edit: MarkerEdit) {
  const turns = state.judgments.map(entry => entry.jevTurn);
  const last = turns.at(-1);
  assert.ok(last);
  if (edit === 'delete' || edit === 'move') {
    const named = edit === 'move' ? turns.at(-2) : last;
    assert.equal(named?.namingRequest, true);
    delete named!.namingRequest;
  }
  if (edit === 'add' || edit === 'move') {
    assert.equal(last.namingRequest, undefined);
    last.namingRequest = true;
  }
}

for (const strategy of strategies) {
  for (const { policy, edit } of markerCases) {
    test('1 ' + strategy + ' ' + (policy ?? 'versionless') + ' rejects saved-only marker ' + edit, async t => {
      const turns = edit === 'add' ? [neutral] : edit === 'delete' ? [explicitName] : [explicitName, neutral];
      const canonical = await buildRecords({ label: strategy, dialoguePolicy: policy, technicalTrial, turns });
      passingS4(canonical);
      const copy = structuredClone(canonical);
      for (const state of savedCopies(copy)) corruptSavedMarker(state, edit);
      const trial = canonical.trials[0];

      await t.test('validates saved state before the next turn', async () => {
        const events = nextEvents(canonical, neutral.human);
        const control = await runTurn(trial.profile, strategy, trial.lastCommittedState, events, neutral.plan, technicalTrial);
        assert.equal(control.speech, neutral.plan.speech);
        await assert.rejects(runTurn(trial.profile, strategy, copy.trials[0].lastCommittedState, events, neutral.plan, technicalTrial),
          { code: 'invalid_state' });
      });
      await t.test('refuses participant restore with unchanged public trace', async () => {
        const f = await fixture(strategy, policy);
        const named: Turn = { ...firstClarification, local: [{ ...proposal, targets: [first] }],
          referent: 'figure_0', action: 'accept', drafts: plain('名前の案ですね。') };
        const plainTurn: Turn = { human: neutral.human, action: 'accept', drafts: plain(neutral.plan.speech!) };
        if (edit !== 'add') await f.say(named);
        const genuine = edit === 'delete' ? f.record() : (await f.say(plainTurn)).after;
        const clean = await f.restore(genuine);
        assert.deepEqual(clean.jevTraces, genuine.jevTraces);
        const corrupt = structuredClone(genuine);
        corruptSavedMarker(corrupt.queueState.privateState, edit);
        assert.deepEqual(corrupt.jevTraces, genuine.jevTraces);
        await assert.rejects(f.restore(corrupt), { code: 'invalid_options' });
      });
      await t.test('fails S4 when only saved copies were changed', () => {
        assert.deepEqual(traceCopies(copy), traceCopies(canonical));
        rejectedS4(copy);
      });
    });
  }
}

type FailureEvidence = NonNullable<NonNullable<JevTurnTrace['decisionFailure']>['evidence']>;
function failureStages(trace: JevTurnTrace): FailureEvidence {
  assert.equal(trace.status, 'error');
  assert.equal(trace.errorCode, 'decision_failed');
  assert.equal(trace.publicSpeech, null);
  assert.equal(trace.executed, null);
  const evidence = trace.decisionFailure?.evidence;
  assert.ok(evidence);
  assert.deepEqual(evidence.stages.map(stage => [stage.stage, stage.status]), [['action', 'ok'], ['target', 'error']]);
  assert.equal(evidence.stages[0].choices.action, 'confirm');
  return evidence;
}
function forgeFailureMarker(trace: JevTurnTrace) {
  const stages = failureStages(trace).stages;
  assert.equal(trace.namingRequest, undefined);
  assert.ok(Object.hasOwn(stages[0].scores.action, 'accept'));
  trace.namingRequest = true;
  delete stages[0].scores.action.accept;
}

for (const strategy of strategies) {
  for (const policy of ['holistic_v3', 'holistic_v2'] as const) {
    test('1 ' + strategy + ' ' + policy + ' rejects a marker with no failure-turn claim evidence', async t => {
      await t.test('participant restore preserves the real failed-stage costs and rejects the forged marker', async () => {
        const f = await fixture(strategy, policy);
        const failed = await f.say({
          human: '縁の厚さはどのくらいですか？', action: 'confirm', target: 'figure_0', feature, badTarget: true, drafts: [],
        });
        const evidence = failureStages(failed.trace);
        assert.deepEqual(evidence.stages.map(stage => [stage.error, stage.responseId, stage.costUsd]),
          [[null, actionId, actionCost], ['invalid_response', targetId, targetCost]]);
        assert.equal(evidence.costUsd, actionCost + targetCost);
        assert.deepEqual((await f.restore(failed.after)).jevTraces.at(-1)?.decisionFailure?.evidence, evidence);
        if (policy === 'holistic_v3') {
          const named = await fixture(strategy, policy);
          const typed = await named.say({ ...firstClarification, badTarget: true, drafts: [] });
          assert.equal(typed.trace.namingRequest, true);
          const typedEvidence = failureStages(typed.trace);
          assert.equal(typedEvidence.costUsd, actionCost + targetCost);
          assert.deepEqual((await named.restore(typed.after)).jevTraces.at(-1)?.decisionFailure?.evidence, typedEvidence);
        }
        const corrupt = structuredClone(failed.after);
        forgeFailureMarker(corrupt.jevTraces.at(-1)!);
        await assert.rejects(f.restore(corrupt), { code: 'invalid_options' });
      });
      await t.test('S4 rejects the same contradiction even without a tape for the failed turn', async () => {
        const records = await buildRecords({ label: strategy, dialoguePolicy: policy, technicalTrial, turns: [neutral] });
        passingS4(records);
        const trial = records.trials[0];
        const events = nextEvents(records, '縁の厚さはどのくらいですか？');
        let trace: JevTurnTrace | undefined;
        try {
          // The synthetic target request has no valid reply, after a valid action reply.
          await runTurn(trial.profile, strategy, trial.lastCommittedState, events,
            { action: 'confirm', target: 'none', referent: 'none' }, technicalTrial);
        } catch (error) {
          trace = (error as { traces?: JevTurnTrace[] }).traces?.at(-1);
        }
        assert.ok(trace);
        failureStages(trace);
        trial.attempts.push(trace);
        trial.turns.push({ turn: trace.turnIndex, publicText: null, trace: [structuredClone(trace)], state: structuredClone(trial.lastCommittedState) });
        passingS4(records, 1);
        const corrupt = structuredClone(records);
        for (const copy of traceCopies(corrupt, 1)) forgeFailureMarker(copy);
        rejectedS4(corrupt, 1);
      });
    });
  }
}

function setMultiple(scores: Record<string, number>) {
  assert.ok(Object.hasOwn(scores, 'multiple'));
  for (const key of Object.keys(scores)) scores[key] = Number(key === 'multiple');
}
for (const strategy of strategies) {
  test('6 ' + strategy + ' rejects contradictory human referent estimates in S4', async t => {
    const final = pickOneText + suggestion;
    const records = await buildRecords({ label: strategy, dialoguePolicy: 'holistic_v3', technicalTrial, turns: [
      { ...neutral, plan: { ...neutral.plan, target: 'figure_0', speech: describeText, aiExtraction: extraction([describe(replayFirst)]) } },
      { human: compare, plan: { action: 'accept', target: 'figures_0_1', referent: 'multiple', speech: 'まだ候補が二つなのですね。',
        act: 'assert', extraction: extraction([twoCandidates([replayFirst, replaySecond])]) } },
      { human: final, plan: { action: 'agree', target: 'figure_0', referent: 'figure_0', speech: adoption,
        act: 'name_propose', extraction: extraction([proposal]), name } },
    ] });
    passingS4(records);
    const trial = records.trials[0];
    assert.equal(trial.attempts[0].humanReferent.scores[replayFirst], 1);
    assert.equal(trial.lastCommittedState.judgments.at(-1).jevTurn.humanReferent.scores[replayFirst], 1);
    assert.deepEqual(trial.lastCommittedState.ledger[replayFirst], { status: 'agreed', name });

    await t.test('trace contradicts the judgment and replay response', () => {
      const copy = structuredClone(records);
      for (const trace of traceCopies(copy)) setMultiple(trace.humanReferent!.scores!);
      rejectedS4(copy);
    });
    await t.test('saved judgment contradicts the trace and replay response', () => {
      const copy = structuredClone(records);
      for (const state of savedCopies(copy)) setMultiple(state.judgments.at(-1)!.jevTurn.humanReferent!.scores!);
      rejectedS4(copy);
    });
    await t.test('tape response contradicts the trace and saved judgment', () => {
      const copy = structuredClone(records);
      const answers = copy.trials[0].replay[0].tape.common.jev.find((entry: { answers: Record<string, unknown> }) =>
        Object.hasOwn(entry.answers, 'human_referent')).answers.human_referent;
      assert.equal(answers.choice, 'figure_0');
      answers.choice = 'multiple';
      setMultiple(answers.probabilities);
      rejectedS4(copy);
    });
  });
}
