// Independent 05t acceptance. All dialogue, observation, requests and responses are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { deadlines } from './support/s4-integration/harness.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
type Strategy = typeof strategies[number];
const seed = 468;
const scene = createTrialV2({ seed });
const anchors = modelView(scene).anchors;
const slots = anchors.map((anchor: { id: string }) => anchor.id);
const [first, second] = slots;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3', 'holistic_v3');
const feature = '丸い台に細い柱が接する';
const otherFeature = '楕円の穴が一つある';
const name = '台つなぎ';
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
  feature?: string;
  tryAgree?: true;
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
  const drafts = () => selectedAction === 'agree' && turn.preferredDraft ? [turn.preferredDraft] : turn.drafts;
  const transport = {
    enabled: true, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    readKey: async () => 'sk-or-synthetic-offline-05t-key-000000',
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
          const agreeOnFirst = turn.tryAgree && inputs.at(-1)?.agreeNames?.some(candidate =>
            candidate.figureId === first && candidate.name === name);
          selectedAction = agreeOnFirst && labels.includes('agree') ? 'agree' : turn.action;
          choice = selectedAction;
        }
        if (key === 'target') {
          choice = selectedAction === 'agree' ? 'figure_0' : turn.target ?? 'none';
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
      return Response.json({ model: request.model, id: 'gen-05t-' + ++responseNo, usage: { cost: 0 }, answers: responses });
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
      return { text: draft.text, model: 'synthetic-05t-luna' };
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
      const { eventId } = task.message(next.human, 'offline-05t-' + task.getState().events.length);
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
const initialProposal: Turn = {
  human: boundText, local: [{ text: boundText, aspect: 'name', act: 'name_propose', name, targets: [first] }],
  action: 'accept', target: 'figure_0', referent: 'figure_0', drafts: plain('呼び名の案ですね。'),
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
  for (const history of ['two candidates', 'other figure', 'narrowed again', 'immediate'] as const) {
    test('1 ' + strategy + ' uses the latest meaningful referent for short approval (' + history + ')', async () => {
      const f = await fixture(strategy);
      const proposed = await f.say(initialProposal);
      published(proposed, 'accept', initialProposal.drafts[0].text);
      assert.equal(proposed.input.humanReferent?.scores?.[first], 1);
      assert.deepEqual(proposed.input.agreeNames?.map(candidate => [candidate.figureId, candidate.name]), [[first, name]]);
      assert.deepEqual(proposed.after.ownLedger, proposed.before.ownLedger);

      const observe = async (text: string, referent: Referent, targets: string[], reply: string) => {
        const result = await f.say({
          human: text, local: [{ text, aspect: 'referent', act: 'assert', targets }],
          referent, action: 'accept', drafts: plain(reply),
        });
        published(result, 'accept', reply);
        assert.equal(result.input.humanReferent?.scores?.[referent === 'figure_0' ? first : referent === 'figure_1' ? second : referent], 1);
        assert.deepEqual(result.input.priorClaims.find(claim => claim.quote === text)?.targets, targets);
        assert.deepEqual(result.after.ownLedger, proposed.after.ownLedger);
      };
      if (history === 'two candidates' || history === 'narrowed again') {
        await observe('丸い台がある形は二つで、どちらかはまだ決められません。', 'multiple', [first, second],
          '候補が二つ残っているのですね。');
      }
      if (history === 'other figure') {
        await observe('いま指しているのは、楕円の穴があるもう一つの形です。', 'figure_1', [second],
          '別の形についての話ですね。');
      }
      if (history === 'narrowed again') {
        await observe('見比べたら、最初の台に細い柱が接する方でした。', 'figure_0', [first],
          '探していた形を絞れたのですね。');
      }

      const text = history === 'immediate' ? 'いい？' : 'さっき私が出した呼び名で大丈夫ですか？';
      const otherFigure = history === 'other figure';
      const reply = otherFigure ? '名前を決める前に、楕円の穴が一つある形のことか教えてください。' : clarify;
      const result = await f.say({
        human: text, local: [approvalRequest(text, boundText)], referent: 'none',
        tryAgree: true, action: 'confirm', target: otherFigure ? 'figure_1' : 'figure_0',
        feature: otherFigure ? otherFeature : feature,
        drafts: plain(reply), preferredDraft: { text: adoption, naming: 'adopt_chosen' },
      });
      assert.equal(result.input.humanReferent?.scores?.none, 1);
      const original = result.input.priorClaims.find(claim => claim.speaker === 'human' && claim.quote === boundText);
      const request = result.input.priorClaims.find(claim => claim.speaker === 'human' && claim.quote === text);
      assert.ok(original && request);
      assert.deepEqual(original.targets, [first]);
      assert.equal(request.act, 'name_propose');
      assert.equal(request.name, name);
      assert.equal(request.respondsTo, original.id);
      if (history === 'immediate' || history === 'narrowed again') {
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
}

type Records = Awaited<ReturnType<typeof buildRecords>>;
type ReplaySide = Awaited<ReturnType<typeof pairedInterventionReplay>>['sides'][number];
function s4Statuses(records: Records) {
  const checks = interventionChecks(records);
  return ['shape', 'binding', 'execution', 'replay'].map(kind =>
    checks.find(check => check.id === 'intervention.trial.0.attempt.0.' + kind)?.status);
}
function localClassification(side: ReplaySide) {
  const matches = side.requests.filter(request => request.phase === 'local_function');
  assert.equal(matches.length, 1);
  const request = matches[0];
  return { index: side.requests.indexOf(request), request, body: request.payload as JevDecisionPayload };
}

const gitExec = promisify(execFile);
const historicalRevisions = [
  ['legacy', '58a95113ed19effca56e8bd58bd4a46638764231'],
  ['style', '07116ae12249f73a49854c4d79d5d22ab60ba640'],
] as const;
const historicalPlans = [
  { action: 'accept', target: 'none', speech: '輪郭についての質問ですね。' },
  { action: 'accept', target: 'figure_0', speech: '丸い台の縁に切れ目が見えます。' },
  { action: 'confirm', target: 'figure_0', speech: '切れ目が一つある台でしょうか？' },
] as const;
const gitRoot = fileURLToPath(new URL('../', import.meta.url));

for (const [lineage, revision] of historicalRevisions) {
  test('2 S4 accepts unedited ' + lineage + ' records generated at ' + revision.slice(0, 7), async t => {
    try {
      await gitExec('git', ['cat-file', '-e', revision + '^{commit}'], { cwd: gitRoot });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) {
        t.skip('historical Git objects are unavailable in this checkout');
        return;
      }
      throw error;
    }
    const directory = await mkdtemp(join(tmpdir(), '05t-archived-runtime-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const tarPath = join(directory, 'source.tar');
    await gitExec('git', ['archive', '--output=' + tarPath, revision], { cwd: gitRoot });
    await gitExec('tar', ['-xf', tarPath, '-C', directory]);
    const archived = await import(pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href) as {
      buildRecords: typeof buildRecords;
      OWN: typeof OWN;
    };
    const human = '丸い台の輪郭に切れ目はありますか？';
    const ownFirst = archived.OWN.ownAnchors[0].id;
    const segment: Segment = { text: human, aspect: 'part', act: 'ask', targets: [ownFirst] };

    for (const label of strategies) {
      for (const adaptive of [false, true]) {
        for (const plan of historicalPlans) {
          await t.test(label + ' ' + plan.action + '/' + plan.target + (adaptive ? ' with technical trial' : ' without technical trial'), async () => {
            const records = await archived.buildRecords({
              label, ...(adaptive ? { technicalTrial } : {}),
              turns: [{ human, plan: { ...plan, act: 'ask', extraction: extraction([segment]) } }],
            });
            const trial = records.trials[0];
            assert.equal(trial.profile.questionLayout, 'two_stage_v3');
            assert.equal(trial.profile.dialoguePolicy, undefined);
            for (const side of trial.replay[0].result.sides as ReplaySide[]) {
              const { index, body, request } = localClassification(side);
              assert.equal(JSON.parse(body.state).segments.length, 1);
              assert.equal(request.preProjectionPayloadSha256, trial.replay[0].tape.recorded.expectedRequests[index].requestSha256);
            }
            const canonical = hash(records);
            const statuses = s4Statuses(records);
            assert.equal(hash(records), canonical);
            assert.deepEqual(statuses, ['pass', 'pass', 'pass', 'pass']);
          });
        }
      }
    }
  });
}

for (const label of strategies) {
  test('2 ' + label + ' rejects mixed criteria in an otherwise consistent holistic_v2 record', async () => {
    const human = '目印を「' + name + '」と呼びませんか？';
    const canonical = await buildRecords({
      label, dialoguePolicy: 'holistic_v2', technicalTrial,
      turns: [{ human, plan: {
        action: 'accept', target: 'none', referent: 'none', act: 'name_propose', speech: '呼び名の案ですね。',
        extraction: extraction([{ text: human, aspect: 'name', act: 'name_propose', name }]),
      } }],
    });
    assert.deepEqual(s4Statuses(canonical), ['pass', 'pass', 'pass', 'pass']);
    const tampered = structuredClone(canonical);
    const trial = tampered.trials[0];
    const { tape, result } = trial.replay[0];
    const pair = tampered.evidence.pairedReplay[0];
    for (const side of [...result.sides, pair.left, pair.right] as ReplaySide[]) {
      const { index, body, request } = localClassification(side);
      const question = body.questions.segment_0_act;
      assert.deepEqual(question.criteria, LOCAL_FUNCTION_CRITERIA_V3);
      assert.notEqual(question.criteria.ask, LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3.ask);
      question.criteria = { ...question.criteria, ask: LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3.ask };
      const fingerprint = hash(body);
      request.preProjectionPayloadSha256 = request.payloadSha256 = fingerprint;
      if (side.label === label) {
        assert.equal(tape.recorded.expectedRequests[index].phase, 'local_function');
        assert.equal(trial.calls[index].phase, 'local_function');
        tape.recorded.expectedRequests[index].requestSha256 = fingerprint;
        trial.calls[index].requestSha256 = fingerprint;
      }
    }
    assert.deepEqual(s4Statuses(tampered), ['pass', 'pass', 'pass', 'mismatch']);
  });
}
