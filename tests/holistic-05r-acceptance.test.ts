// Independent 05r acceptance. All dialogue, observation, requests and responses are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DraftAct, JevAction, JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3, LOCAL_FUNCTION_CRITERIA_V3 } from '../dialogue-model/runtime/local-grounding/classify.ts';
import { createObservationCache } from '../dialogue-model/runtime/observation/cache.ts';
import { prepareParticipantJev } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { buildRecords, MODEL, OWN } from './support/s4-v3-records.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { buildJevLocalTestPayload, createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3, researchHash } from '../dialogue-model/runtime/v2/research-profile.ts';
import { deadlines } from './support/s4-integration/harness.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
type Strategy = typeof strategies[number];
const seed = 586;
const scene = createTrialV2({ seed });
const anchors = modelView(scene).anchors;
const slots = anchors.map((anchor: { id: string }) => anchor.id);
const [first, second] = slots;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), observationMs: 5000, localMs: 5000, decisionMs: 5000, generationMs: 5000,
}, 'two_stage_v3', 'holistic_v3');
const feature = '丸い台に細い柱が接する';
const otherFeature = '楕円の穴が一つある';
const name = '灯台印';
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
type Referent = 'none' | 'figure_0' | 'figure_1';
type Turn = {
  human: string;
  local?: Segment[];
  publicClaims?: Segment[];
  referent?: Referent;
  action: JevAction;
  target?: 'figure_0' | 'figure_1';
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
    readKey: async () => 'sk-or-synthetic-offline-05r-key-000000',
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
          probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
      }));
      return Response.json({ model: request.model, id: 'gen-05r-' + ++responseNo, usage: { cost: 0 }, answers: responses });
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
      return { text: draft.text, model: 'synthetic-05r-luna' };
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
      const { eventId } = task.message(next.human, 'offline-05r-' + task.getState().events.length);
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
      return { before, after, trace, speech, input, options, requests, aiStatus: task.getState().aiStatus };
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
const describeText = '丸い台に細い柱が付いた形があります。';
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

const approval = 'それでいい？';
const oralAdoption = 'うん、その呼び方にしましょう。';
const followUp = '呼び名を決める前に、' + otherFeature + '形か教えてください。';

for (const strategy of strategies) {
  for (const targets of ['unbound', 'two figures'] as const) {
    test('1 ' + strategy + ' treats a name taken by another figure as a request (' + targets + ')', async () => {
      const f = await fixture(strategy);
      const firstAgreement = await f.say(readyToAdopt);
      assertAgreedOnFirst(firstAgreement);
      const text = '楕円の穴があるもう一つの形も「' + name + '」と呼びませんか？';
      const extracted = targets === 'unbound' ? [] : [first, second];
      const result = await f.say({
        human: text, local: [{ ...proposal, text, targets: extracted }], referent: 'figure_1',
        prefer: 'accept', action: 'confirm', target: 'figure_1', feature: otherFeature,
        drafts: [{ text: oralAdoption, naming: 'adopt_other' }, { text: followUp }],
      });
      const claim = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === text);
      assert.equal(claim?.act, 'name_propose');
      assert.equal(claim?.name, name);
      assert.deepEqual(claim?.targets, extracted);
      assert.equal(result.input.humanReferent?.scores?.[second], 1);
      assert.deepEqual(result.after.ownLedger, firstAgreement.after.ownLedger);
      assert.deepEqual({
        request: result.trace.namingRequest, reconfirmation: result.trace.namingReconfirm,
        accept: Object.hasOwn(result.options, 'accept'), agree: Object.hasOwn(result.options, 'agree'),
        publicSpeech: result.speech,
      }, { request: true, reconfirmation: undefined, accept: false, agree: false, publicSpeech: followUp });
      published(result, 'confirm', followUp);
    });
  }

  for (const short of [true, false]) {
    test('1 ' + strategy + (short ? ' accepts an immediate same-figure confirmation' : ' accepts a scoped confirmation of the same name'), async () => {
      const f = await fixture(strategy);
      const agreement = await f.say(readyToAdopt);
      assertAgreedOnFirst(agreement);
      const text = short ? 'いい？' : 'この丸い台の形は、先ほどの「' + name + '」でいいですか？';
      const affirmation = short ? 'うん、いいよ。' : 'はい、先ほどの呼び方で大丈夫です。';
      const result = await f.say({
        human: text, local: [approvalRequest(text, boundText, short ? [] : [first])], referent: 'figure_0',
        action: 'accept', target: 'figure_0', drafts: [{ text: affirmation, naming: 'adopt_other' }],
      });
      assertInherited(result, text, boundText, [first]);
      assert.equal(result.input.humanReferent?.scores?.[first], 1);
      assert.ok(Object.hasOwn(result.options, 'accept'));
      published(result, 'accept', affirmation);
      assert.deepEqual(result.after.ownLedger, agreement.after.ownLedger);
    });
  }

  test('2 ' + strategy + ' retains a short fragment classified as approval of a human proposal', async () => {
    const f = await fixture(strategy);
    const initial = await f.say(firstClarification);
    published(initial, 'confirm', clarify);
    const result = await f.say({
      human: '先ほど私が出した呼び方のことですが、' + approval,
      local: [approvalRequest(approval, suggestion)], referent: 'none',
      prefer: 'accept', action: 'confirm', target: 'figure_0', feature: otherFeature,
      drafts: [{ text: oralAdoption, naming: 'adopt_other' }, { text: clarifyAgain }],
    });
    const local = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === approval);
    const source = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === suggestion);
    assert.ok(result.requests.some(request => request.questions.segment_0_act), 'the fragment was classified');
    assert.ok(source);
    assert.equal(result.input.humanReferent?.scores?.none, 1);
    assert.deepEqual(result.after.ownLedger, initial.after.ownLedger);
    assert.deepEqual({
      act: local?.act, name: local?.name, linkedTo: local?.respondsTo, request: result.trace.namingRequest,
      accepts: Object.hasOwn(result.options, 'accept'), agrees: Object.hasOwn(result.options, 'agree'), publicSpeech: result.speech,
    }, { act: 'name_propose', name, linkedTo: source.id, request: true, accepts: false, agrees: false, publicSpeech: clarifyAgain });
    assertInherited(result, approval, suggestion, []);
    published(result, 'confirm', clarifyAgain);
  });

  for (const act of ['agree', 'acknowledge'] as const) {
    test('2 ' + strategy + ' an ordinary ' + act + ' adds no naming evidence', async () => {
      const f = await fixture(strategy);
      published(await f.say(describe), 'accept', describeText);
      const text = act === 'agree' ? 'そのとおりです。' : 'うん。';
      const local: Segment = act === 'agree'
        ? { text, aspect: 'part', act, antecedent: { speaker: 'ai', quote: describeText } }
        : { text, aspect: 'progress', act };
      const reply = 'では輪郭をもう少し見てみましょう。';
      const result = await f.say({ human: text, local: [local], action: 'accept', target: 'figure_0', drafts: plain(reply) });
      published(result, 'accept', reply);
      const claim = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === text);
      assert.ok(claim);
      assert.equal(claim.name, null);
      assert.ok(claim.act === act || claim.act === 'acknowledge');
      assert.equal(result.trace.namingRequest, undefined);
      assert.deepEqual(result.input.agreeNames, []);
      assert.ok(!Object.hasOwn(result.options, 'agree'));
      assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
    });
  }

  test('3 ' + strategy + ' preserves the independent observation when approval refers to the wrong figure', async () => {
    const f = await fixture(strategy);
    const notice = '名前の案ですね。';
    published(await f.say({ ...readyToAdopt, action: 'accept', drafts: plain(notice) }), 'accept', notice);
    const observation = 'こちらには楕円の穴があります。';
    const request = 'この別の形にも、その呼び名でいいですか？';
    const response = '穴がある形ですね。先ほどの候補とは別に考えましょう。';
    const result = await f.say({
      human: observation + request, local: [
        { text: observation, aspect: 'part', act: 'assert', targets: [second] },
        approvalRequest(request, boundText, [second]),
      ], action: 'accept', target: 'figure_1', referent: 'figure_1', drafts: plain(response),
    });
    published(result, 'accept', response);
    assert.ok(result.requests.some(q => q.questions.segment_0_act && q.questions.segment_1_act));
    assert.equal(result.input.humanReferent?.scores?.[second], 1);
    const observationClaim = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === observation);
    const approvalClaim = result.input.priorClaims.find(c => c.speaker === 'human' && c.quote === request);
    assert.ok(observationClaim, 'a bad name link must not abort verification of the other segment');
    assert.equal(observationClaim.act, 'assert');
    assert.equal(observationClaim.aspect, 'part');
    assert.deepEqual(observationClaim.targets, [second]);
    assert.ok(approvalClaim === undefined || (approvalClaim.name === null && approvalClaim.respondsTo === null));
    assert.ok(!result.input.agreeNames?.some(candidate => candidate.figureId === second));
    assert.deepEqual(result.after.ownLedger, result.before.ownLedger);
  });
}

const modelId = 'synthetic-05r-participant';
const participantLunaRequest = { timeoutMs: null, maxCompletionTokens: 1000 };
const participantTimeouts = {
  observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000,
};
const participantProfile = researchTrialProfileV3(participantLunaRequest, participantTimeouts, 'two_stage_v3', 'holistic_v4');
const legacyProfile = researchTrialProfileV3(participantLunaRequest, participantTimeouts, 'two_stage_v3', 'holistic_v2');
const factText = '呼び名を最初に挙げた人も記録するのですか？';
async function participantSetup(t: TestContext, strategy: Strategy) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), '05r-participant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDirectory = join(directory, 'cache');
  await mkdir(cacheDirectory, { mode: 0o700 });
  const view = modelView(scene);
  const memo = {
    figures: anchors.map((anchor: { id: string }) => ({
      id: anchor.id, holistic: [], analytic: { shapes: [feature, otherFeature], composition: '台と柱が接する', relations: [] },
      unknowns: [],
    })),
  };
  const cache = await createObservationCache({
    directory: cacheDirectory, modelId, onMiss: 'observe',
    client: { async complete() { return { text: JSON.stringify(memo), model: modelId }; } },
  });
  const hit = await cache.get({ ownImage: { mimeType: view.mimeType, base64: view.png.toString('base64') }, ownAnchors: anchors });
  const configFile = join(directory, 'config.json');
  const baseAssignmentFile = join(directory, 'assignment.json');
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 'participant_jev_config_v1', seed, cacheDirectory, modelId, memoSha256: researchHash(hit.memo),
    questionLayout: 'two_stage_v3', technicalTrial, lunaRequest: participantLunaRequest, timeouts: participantTimeouts,
    limits: { lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 0.05 },
  }), { mode: 0o600 });
  await writeFile(baseAssignmentFile, JSON.stringify({
    schemaVersion: 'base_assignment_config_v1', configId: '34813912-f485-41dd-8831-18b9ef635de9',
    revision: 1, strategy, seed, referenceMemory: true,
  }), { mode: 0o600 });
  const localRequests: JevDecisionPayload[] = [];
  let responseId = 0;
  const prepared = await prepareParticipantJev({
    configFile, baseAssignmentFile,
    clientConfig: { provider: 'cloudflare', purpose: 'dialogue_turn', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'offline-05r-only' },
    readKey: async () => 'sk-or-synthetic-05r-participant-00000000',
    async fetchImpl(_url, options) {
      if (options?.method === 'GET') return Response.json({ ready: true, purpose: 'dialogue_turn', provider: 'openai', model: modelId });
      const body = JSON.parse(String(options?.body));
      if (body.questions) {
        const req = body as JevDecisionPayload;
        if (req.questions.segment_0_act && !Object.hasOwn(JSON.parse(req.state), 'aiSeq')) localRequests.push(req);
        const answers = Object.fromEntries(Object.entries(req.questions).map(([key, question]) => {
          const labels = Object.keys(question.criteria);
          const choice = key === 'action' ? 'accept' : key === 'human_referent' || key === 'target' || key.endsWith('_antecedent')
            || key === 'repair_issue' || key === 'basis' ? 'none' : key === 'prospect' ? 'no_open_issue'
            : key.endsWith('_act') ? 'ask' : labels[0];
          assert.ok(labels.includes(choice), key + ' did not offer ' + choice);
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
        }));
        return Response.json({ model: req.model, id: 'gen-05r-participant-' + ++responseId, usage: { cost: 0 }, answers });
      }
      const content = body.messages[1]?.content;
      let state: { candidateText?: string; publicTurns?: Array<{ speaker: string; text: string }> } = {};
      if (typeof content === 'string' && content.startsWith('{')) state = JSON.parse(content);
      const latestHuman = state.publicTurns?.filter(event => event.speaker === 'human').at(-1)?.text;
      const text = state.candidateText ? '[]'
        : state.publicTurns ? extraction(latestHuman === factText ? [{ text: factText, aspect: 'name', act: 'ask' }] : [])
          : '発言を受け取りました。';
      return Response.json({ model: modelId, choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  type ParticipantRecord = Saved & { options: { profileSha256: string; dialoguePolicy?: string } };
  async function makeTask(restore?: ParticipantRecord, creationProfile?: typeof participantProfile) {
    const value = { strategy, seed, referenceMemory: true, restore };
    const wiring = await prepared.taskOptions(value);
    assert.ok(wiring.jevResearch);
    let saved: ParticipantRecord | undefined;
    // Pin the profile for new fixtures. Restore selects its saved profile through the ordinary wiring.
    const task = await createNamingTaskV2({
      ...value, ...wiring, runDir: null, createTrial: () => scene,
      ...(creationProfile ? { jevResearch: { ...wiring.jevResearch, profile: creationProfile } } : {}),
      onPersist(record: unknown) { saved = structuredClone(record) as ParticipantRecord; },
    });
    return {
      task,
      record() { assert.ok(saved); return saved; },
    };
  }
  return { makeTask, localRequests };
}

for (const strategy of strategies) {
  test('6 ' + strategy + ' keeps the classification version on ordinary participant restore', async t => {
    const { makeTask, localRequests } = await participantSetup(t, strategy);
    const old = await makeTask(undefined, legacyProfile);
    old.task.message('では始めましょう。', 'offline-05r-warmup');
    await old.task.whenIdle();
    assert.equal(old.task.getState().aiStatus, 'idle');
    const source = JSON.parse(JSON.stringify(old.record())) as ReturnType<typeof old.record>;
    assert.equal(source.options.profileSha256, researchHash(legacyProfile));

    const restarted = await makeTask(source);
    assert.equal(restarted.record().options.profileSha256, source.options.profileSha256);
    const fresh = await makeTask(undefined, participantProfile);
    assert.equal(fresh.record().options.profileSha256, researchHash(participantProfile));
    assert.equal(restarted.record().options.dialoguePolicy, 'holistic_v2');
    assert.equal(fresh.record().options.dialoguePolicy, 'holistic_v4');

    for (const [version, session, expected] of [
      ['holistic_v2', restarted, LOCAL_FUNCTION_CRITERIA_V3],
      ['holistic_v4', fresh, LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3],
    ] as const) {
      await t.test(version + ' actual next send uses its own closed-set text', async () => {
        const before = localRequests.length;
        session.task.message(factText, 'offline-05r-classification');
        await session.task.whenIdle();
        assert.equal(session.task.getState().aiStatus, 'idle');
        const requests = localRequests.slice(before);
        assert.equal(requests.length, 1);
        const request = requests[0];
        const expectedRequest = buildJevLocalTestPayload({ ...JSON.parse(request.state), ownSlots: slots }, 'two_stage_v3', version);
        assert.equal(hash(request), hash(expectedRequest), 'the actual request must match the restored or new profile');
        assert.deepEqual(request.questions.segment_0_act.criteria, expected);
      });
    }
  });
}

type Records = Awaited<ReturnType<typeof buildRecords>>;
type ReplayResult = Awaited<ReturnType<typeof pairedInterventionReplay>>;
function localSend(side: ReplayResult['sides'][number]) {
  const index = side.requests.findIndex(request => request.phase === 'local_function');
  assert.ok(index >= 0, 'the real replay must carry local classification');
  const request = side.requests[index];
  return { index, request, body: request.payload as JevDecisionPayload };
}
function withClassificationVersion(records: Records, version: 'holistic_v2' | 'holistic_v3') {
  const copy = structuredClone(records);
  const trial = copy.trials[0];
  const { tape, result } = trial.replay[0];
  const pair = copy.evidence.pairedReplay[0];
  const ownSlots = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
  const sides = [...result.sides, pair.left, pair.right] as ReplayResult['sides'];
  for (const side of sides) {
    const { index, request, body } = localSend(side);
    const expected = buildJevLocalTestPayload({ ...JSON.parse(body.state), ownSlots }, 'two_stage_v3', version);
    assert.equal(expected.state, body.state, 'the classification input is unchanged');
    request.payload = expected;
    request.preProjectionPayloadSha256 = request.payloadSha256 = hash(expected);
    if (side.label === trial.label) {
      const logged = tape.recorded.expectedRequests[index];
      assert.equal(logged.phase, 'local_function');
      logged.requestSha256 = request.preProjectionPayloadSha256;
      assert.equal(trial.calls[index].phase, 'local_function');
      trial.calls[index].requestSha256 = request.preProjectionPayloadSha256;
    }
  }
  return copy;
}
function s4Statuses(records: Records) {
  const checks = interventionChecks(records);
  return ['shape', 'binding', 'execution', 'replay'].map(kind =>
    checks.find(check => check.id === 'intervention.trial.0.attempt.0.' + kind)?.status);
}
for (const strategy of strategies) {
  test('7 ' + strategy + ' compares replayed local classification with the recorded profile and send', async t => {
    const source = await buildRecords({
      label: strategy, dialoguePolicy: 'holistic_v3', technicalTrial,
      turns: [{ human: suggestion, plan: { action: 'confirm', target: 'figure_0', referent: 'none', speech: clarify,
        act: 'name_propose', extraction: extraction([proposal]) } }],
    });
    const current = withClassificationVersion(source, 'holistic_v3');
    await t.test('both replay labels reproduce the independently built v3 send fingerprint', async () => {
      const trial = current.trials[0];
      const { tape } = trial.replay[0];
      const expected = tape.recorded.expectedRequests.find((entry: { phase: string }) => entry.phase === 'local_function');
      assert.ok(expected?.actualSendMeasured);
      const own = { ...OWN, ownImage: { ...OWN.ownImage, mimeType: 'image/png' as const } };
      const replay = await pairedInterventionReplay(tape, own, MODEL, trial.profile);
      assert.deepEqual({
        sends: replay.sides.map(side => [side.label, localSend(side).request.preProjectionPayloadSha256]),
        reproduced: replay.recordedPayloadsReproduced, status: replay.status,
      }, {
        sends: strategies.map(label => [label, expected.requestSha256]),
        reproduced: true, status: 'same_material_intervention_verified',
      });
      for (const side of replay.sides) {
        assert.deepEqual(localSend(side).body.questions.segment_0_act.criteria, LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3);
      }
      assert.deepEqual(s4Statuses(current), ['pass', 'pass', 'pass', 'pass']);
    });
    await t.test('S4 refuses old criteria with consistent fingerprints and a v3 profile', () => {
      const stale = withClassificationVersion(source, 'holistic_v2');
      const trial = stale.trials[0];
      assert.equal(trial.profile.dialoguePolicy, 'holistic_v3');
      const { tape, result } = trial.replay[0];
      const indices = new Set<number>();
      for (const side of result.sides as ReplayResult['sides']) {
        const { index, request, body } = localSend(side);
        assert.deepEqual(body.questions.segment_0_act.criteria, LOCAL_FUNCTION_CRITERIA_V3);
        assert.equal(request.preProjectionPayloadSha256, hash(body));
        assert.equal(request.payloadSha256, hash(body));
        assert.equal(tape.recorded.expectedRequests[index].requestSha256, hash(body));
        assert.equal(trial.calls[index].requestSha256, hash(body));
        indices.add(index);
      }
      assert.equal(indices.size, 1);
      const verdicts = s4Statuses(stale);
      assert.ok(verdicts.includes('mismatch'), 'S4 accepted old criteria: ' + verdicts.join(', '));
    });
  });
}
