// 05w acceptance. All dialogue, observations, extraction, and upstream replies are synthetic.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { JevAction } from '../dialogue-model/runtime/decision/contract.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createObservationCache } from '../dialogue-model/runtime/observation/cache.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchHash, researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { prepareParticipantJev } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import type { buildRecords, Label, MODEL, OWN, Turn as ReplayTurn } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const seed = 812;
const scene = createTrialV2({ seed });
const view = modelView(scene);
const first = view.anchors[0].id;
const modelId = 'synthetic-05w-luna';
const lunaRequest = { timeoutMs: null, maxCompletionTokens: 1000 };
const timeouts = {
  observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000,
};
const v3Profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v3');
// Hash of the closed-set criteria as sent by 80d0cfd, in its original key order.
const v3CriteriaSha256 = '08ba5880bf6bfcd09609bb651a22542e39c4c378d0bc3b884ac5c8a83da0bdb8';
const feature = '小さな輪が台に接している';
const alias = '輪どまり';
const neutral = '見取り図では輪のある形を「' + alias + '」と記しています。';
const proposedSpeech = '「' + alias + '」と呼ぶのはどうでしょう？';
const humanProposal = '輪のあるこの形を「' + alias + '」と呼びませんか？';
const adoption = 'はい、この形を「' + alias + '」と呼びましょう。';
const approval = 'その呼び名でいい？';
const affirmation = 'うん、いいよ。';
const clarification = '小さな輪が台に接している形のことですか？';
const receipt = '呼び方についての質問ですね。';

type Segment = Pick<LocalSegmentProposal, 'quote' | 'aspect'> & Partial<Pick<LocalSegmentProposal, 'name' | 'targets' | 'respondsToTurn'>>;
function extract(segment: Segment): LocalSegmentProposal {
  return {
    segmentId: '1', quote: segment.quote, proposition: segment.quote, aspect: segment.aspect,
    name: segment.name ?? null, targets: segment.targets ?? [], respondsToTurn: segment.respondsToTurn ?? null, linkedIssueId: null,
  };
}
type WireClaim = Pick<LocalClaimView, 'speaker' | 'act' | 'name' | 'sourceTurn'>;
type Script = {
  human: string;
  segment?: Segment;
  act?: LocalAct;
  antecedent?: Pick<WireClaim, 'speaker' | 'act' | 'name'>;
  referent?: 'figure_0' | 'none';
  actions: JevAction[];
  replies: Partial<Record<JevAction, string>>;
};
type Saved = {
  options: { profileSha256: string; dialoguePolicy?: string };
  ownLedger: JevPrivateState['ledger'];
  events: { speaker: string; text: string; seq: number }[];
  jevTraces: JevTurnTrace[];
};

async function participant(t: TestContext, strategy: Label) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), '05w-participant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDirectory = join(directory, 'cache');
  await mkdir(cacheDirectory, { mode: 0o700 });
  const cache = await createObservationCache({
    directory: cacheDirectory, modelId, onMiss: 'observe',
    client: { async complete() {
      return { text: JSON.stringify({
        figures: view.anchors.map((anchor: { id: string }) => ({
          id: anchor.id, holistic: [], analytic: { shapes: [feature], composition: '輪と台がつながる', relations: [] }, unknowns: [],
        })),
      }), model: modelId };
    } },
  });
  const { memo } = await cache.get({
    ownImage: { mimeType: view.mimeType, base64: view.png.toString('base64') }, ownAnchors: view.anchors,
  });
  const configFile = join(directory, 'config.json');
  const baseAssignmentFile = join(directory, 'assignment.json');
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 'participant_jev_config_v1', seed, cacheDirectory, modelId, memoSha256: researchHash(memo),
    questionLayout: 'two_stage_v3', technicalTrial, lunaRequest, timeouts,
    limits: { lunaCalls: 70, lunaPosts: 70, lunaTokens: 100000, jevPosts: 100, jevUsd: 0.05 },
  }), { mode: 0o600 });
  await writeFile(baseAssignmentFile, JSON.stringify({
    schemaVersion: 'base_assignment_config_v1', configId: 'd67da8f5-77ce-450c-897d-d7a7e8e4d634',
    revision: 1, strategy, seed, referenceMemory: true,
  }), { mode: 0o600 });

  let script: Script;
  let action: JevAction | undefined;
  let menu: string[] | undefined;
  let localSends: JevDecisionPayload[] = [];
  let extractionSends: LocalSegmentProposal[] = [];
  let localReplies: { act: LocalAct; antecedent?: WireClaim }[] = [];
  let responseNo = 0;
  const readKey = async () => 'sk-or-synthetic-05w-offline-key-000000';
  const fetchImpl: NonNullable<Parameters<typeof prepareParticipantJev>[0]['fetchImpl']> = async (_url, options) => {
    if (options?.method === 'GET') return Response.json({ ready: true, purpose: 'dialogue_turn', provider: 'openai', model: modelId });
    const body = JSON.parse(String(options?.body));
    if (body.questions) {
      const request = body as JevDecisionPayload;
      const state = JSON.parse(request.state) as { aiSeq?: number; priorClaims?: WireClaim[] };
      const isHumanLocal = Boolean(request.questions.segment_0_act) && state.aiSeq === undefined;
      let antecedent: WireClaim | undefined;
      if (isHumanLocal) localSends.push(request);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        const labels = Object.keys(question.criteria);
        let choice: string | undefined;
        if (key === 'human_referent') choice = script.referent ?? 'none';
        if (key === 'prospect') choice = 'no_open_issue';
        if (key === 'repair_issue' || key === 'basis') choice = 'none';
        if (key === 'action') {
          menu = labels;
          action = script.actions.find(candidate => labels.includes(candidate));
          choice = action;
        }
        if (key === 'target') choice = action === 'accept' ? 'none' : 'figure_0';
        if (key === 'feature' || key === 'name') {
          const value = key === 'feature' ? feature : alias;
          choice = labels.find(label => JSON.parse(question.criteria[label]).value === value);
        }
        if (key === 'draft_naming') {
          if (action === 'agree') choice = 'adopt_chosen';
          else if (action === 'propose_name') choice = 'propose_question';
          else choice = action === 'accept' && script.replies.accept === affirmation ? 'adopt_other' : 'none';
        }
        if (isHumanLocal && key === 'segment_0_act') choice = script.act;
        if (isHumanLocal && key === 'segment_0_antecedent') {
          choice = 'none';
          if (script.antecedent) {
            const { speaker, act, name } = script.antecedent;
            const index = state.priorClaims?.findIndex(claim => claim.speaker === speaker && claim.act === act && claim.name === name) ?? -1;
            assert.ok(state.priorClaims && index >= 0, 'the intended public claim must actually be offered');
            antecedent = state.priorClaims[index];
            choice = 'claim_' + index;
          }
        }
        assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
        return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
      }));
      if (isHumanLocal) {
        assert.ok(script.act);
        localReplies.push({ act: script.act, antecedent });
      }
      return Response.json({ model: request.model, id: 'gen-05w-' + ++responseNo, usage: { cost: 0 }, answers });
    }
    const content = body.messages[1]?.content;
    const state = typeof content === 'string' && content.startsWith('{')
      ? JSON.parse(content) as { candidateText?: string; publicTurns?: unknown[] } : {};
    let text = '[]';
    if (state.publicTurns && !state.candidateText && script.segment) {
      const segment = extract(script.segment);
      extractionSends.push(segment);
      text = JSON.stringify([segment]);
    }
    if (!state.publicTurns && !state.candidateText) {
      assert.ok(action);
      const reply = script.replies[action];
      assert.ok(reply, 'reply for the action selected from the native menu');
      text = reply;
    }
    return Response.json({ model: modelId, choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  const prepared = await prepareParticipantJev({
    configFile, baseAssignmentFile,
    clientConfig: { provider: 'cloudflare', purpose: 'dialogue_turn', baseUrl: 'https://synthetic.invalid/v1', apiKey: '05w-offline-only' },
    readKey, fetchImpl,
  });

  return async function makeTask(restore?: Saved, createV3 = false) {
    const options = { strategy, seed, referenceMemory: true, restore };
    const wiring = await prepared.taskOptions(options);
    assert.ok(wiring.jevResearch);
    // Create a v3 record even in a shallow checkout, then restore it through ordinary participant wiring.
    const jevResearch = createV3 ? {
      ...wiring.jevResearch, profile: v3Profile,
      localGrounding: {
        ...wiring.jevResearch.localGrounding,
        classifier: createJevLocalTestClassifier({
          enabled: true, readKey, fetchImpl, timeoutMs: v3Profile.timeouts.localMs,
          questionLayout: v3Profile.questionLayout, dialoguePolicy: v3Profile.dialoguePolicy,
        })!,
      },
    } : wiring.jevResearch;
    let record: Saved | undefined;
    const task = await createNamingTaskV2({
      ...options, ...wiring, jevResearch, runDir: null, createTrial: () => scene,
      onPersist(value: unknown) { record = structuredClone(value) as Saved; },
    });
    function saved() {
      assert.ok(record);
      return record;
    }
    return {
      profile: jevResearch.profile, saved,
      async say(next: Script) {
        script = next;
        action = undefined;
        menu = undefined;
        localSends = [];
        extractionSends = [];
        localReplies = [];
        const { eventId } = task.message(next.human, 'offline-05w-' + task.getState().events.length);
        await task.whenIdle();
        const after = saved();
        const trace = after.jevTraces.at(-1);
        const publicEvent = task.getState().events.at(-1);
        const savedEvent = after.events.at(-1);
        assert.ok(trace && menu, 'the requested turn must reach the native action question');
        assert.equal(trace.lastEventId, eventId);
        assert.equal(trace.status, 'committed', trace.errorCode ?? 'turn must commit');
        assert.equal(task.getState().aiStatus, 'idle');
        assert.equal(publicEvent?.speaker, 'ai');
        assert.equal(savedEvent?.speaker, 'ai');
        assert.equal(savedEvent.text, publicEvent.text);
        assert.equal(savedEvent.text, trace.publicSpeech);
        return { trace, after, menu: menu as string[], ai: savedEvent, localSends, extractionSends, localReplies };
      },
    };
  };
}

type Session = Awaited<ReturnType<Awaited<ReturnType<typeof participant>>>>;
type Outcome = Awaited<ReturnType<Session['say']>>;
function assertV3Criteria(outcome: Outcome) {
  assert.equal(outcome.localSends.length, 1);
  const criteria = outcome.localSends[0].questions.segment_0_act.criteria;
  assert.equal(createHash('sha256').update(JSON.stringify(criteria), 'utf8').digest('hex'), v3CriteriaSha256);
}

function assertApprovalWire(outcome: Outcome, lastAiTurn: number, act: LocalAct) {
  assert.deepEqual(outcome.extractionSends, [extract({ quote: approval, aspect: 'name', respondsToTurn: lastAiTurn })]);
  assert.equal(outcome.localSends.length, 1);
  assert.equal(outcome.localReplies.length, 1);
  const reply = outcome.localReplies[0];
  assert.equal(reply.act, 'name_propose');
  assert.ok(reply.antecedent);
  assert.equal(reply.antecedent.speaker, 'ai');
  assert.equal(reply.antecedent.act, act);
  assert.equal(reply.antecedent.name, alias);
  assert.equal(reply.antecedent.sourceTurn, lastAiTurn);
}

for (const strategy of strategies) {
  test('B1 ' + strategy + ' answers a request to approve the AI’s tentative name', async t => {
    const makeTask = await participant(t, strategy);
    const session = await makeTask();
    const proposed = await session.say({
      human: neutral, segment: { quote: neutral, aspect: 'name', name: alias, targets: [first] },
      act: 'assert', referent: 'figure_0', actions: ['propose_name'], replies: { propose_name: proposedSpeech },
    });
    assert.equal(proposed.localReplies[0]?.act, 'assert');
    assert.equal(proposed.trace.executed?.action, 'propose_name');
    assert.equal(proposed.ai.text, proposedSpeech);
    assert.deepEqual(proposed.after.ownLedger[first], { status: 'tentative', name: alias });

    const result = await session.say({
      human: approval, segment: { quote: approval, aspect: 'name', respondsToTurn: proposed.ai.seq },
      act: 'name_propose', antecedent: { speaker: 'ai', act: 'name_propose', name: alias }, referent: 'figure_0',
      actions: ['accept', 'agree', 'confirm'], replies: { accept: receipt, agree: adoption, confirm: clarification },
    });
    assertApprovalWire(result, proposed.ai.seq, 'name_propose');
    assert.equal(result.trace.namingRequest, true);
    assert.ok(result.menu.includes('agree'), 'the named figure has a legal agree');
    assert.deepEqual({
      acceptOffered: result.menu.includes('accept'), action: result.trace.executed?.action,
      publicSpeech: result.ai.text, ledger: result.after.ownLedger[first],
    }, {
      acceptOffered: false, action: 'agree', publicSpeech: adoption, ledger: { status: 'agreed', name: alias },
    });
  });

  test('B1 ' + strategy + ' can acknowledge reconfirmation of an agreed name', async t => {
    const session = await (await participant(t, strategy))();
    const agreed = await session.say({
      human: humanProposal, segment: { quote: humanProposal, aspect: 'name', name: alias, targets: [first] },
      act: 'name_propose', referent: 'figure_0', actions: ['agree'], replies: { agree: adoption },
    });
    assert.equal(agreed.trace.executed?.action, 'agree');
    assert.deepEqual(agreed.after.ownLedger[first], { status: 'agreed', name: alias });

    const result = await session.say({
      human: approval, segment: { quote: approval, aspect: 'name', respondsToTurn: agreed.ai.seq },
      act: 'name_propose', antecedent: { speaker: 'ai', act: 'name_accept', name: alias }, referent: 'figure_0',
      actions: ['accept', 'confirm'], replies: { accept: affirmation, confirm: clarification },
    });
    assertApprovalWire(result, agreed.ai.seq, 'name_accept');
    assert.equal(result.trace.namingReconfirm, true);
    assert.notEqual(result.trace.namingRequest, true);
    assert.ok(result.menu.includes('accept'));
    assert.equal(result.trace.executed?.action, 'accept');
    assert.equal(result.ai.text, affirmation);
    assert.deepEqual(result.after.ownLedger, agreed.after.ownLedger);
  });

  test('B2 ' + strategy + ' persists holistic_v4 for a new technical trial', async t => {
    const fresh = await (await participant(t, strategy))();
    await fresh.say({ human: 'では始めましょう。', actions: ['accept'], replies: { accept: 'はい、始めましょう。' } });
    assert.equal(fresh.saved().options.profileSha256, researchHash(fresh.profile));
    assert.equal(fresh.saved().options.dialoguePolicy, 'holistic_v4');
  });

  test('B2 ' + strategy + ' sends the v3 classification text after restoring a v3 trial', async t => {
    const makeTask = await participant(t, strategy);
    const old = await makeTask(undefined, true);
    const warmup = 'この輪は台に接していますか？';
    const original = await old.say({
      human: warmup, segment: { quote: warmup, aspect: 'part', targets: [first] }, act: 'ask',
      actions: ['accept'], replies: { accept: 'はい、接しています。' },
    });
    assertV3Criteria(original);
    const snapshot = JSON.parse(JSON.stringify(old.saved())) as Saved;
    assert.equal(snapshot.options.profileSha256, researchHash(v3Profile));
    assert.equal(snapshot.options.dialoguePolicy, 'holistic_v3');

    const restored = await makeTask(snapshot);
    assert.equal(restored.saved().options.dialoguePolicy, 'holistic_v3');
    assert.equal(restored.saved().options.profileSha256, snapshot.options.profileSha256);
    const question = '呼び名を記録に残すのですか？';
    const result = await restored.say({
      human: question, segment: { quote: question, aspect: 'name' }, act: 'ask',
      actions: ['accept'], replies: { accept: 'ええ、記録に残します。' },
    });
    assertV3Criteria(result);
    assert.equal(result.after.options.dialoguePolicy, 'holistic_v3');
    assert.equal(result.after.options.profileSha256, snapshot.options.profileSha256);
  });
}

const git = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const oldRevision = '80d0cfd3c1e61f408aa9a6c92d82a828b4cf6e9e';

test('B2 replays the unmodified v3 tapes generated at 80d0cfd', async t => {
  try {
    await git('git', ['cat-file', '-e', oldRevision + '^{commit}'], { cwd: root });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) {
      t.skip('historical Git object is unavailable in this checkout');
      return;
    }
    throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), '05w-archived-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'source.tar');
  await git('git', ['archive', '--output=' + archive, oldRevision,
    'package.json', 'dialogue-model/runtime', 'workers/research-ai-proxy/src',
    'tests/support/s4-v3-records.ts', 'tests/support/s4-integration',
  ], { cwd: root });
  await git('tar', ['-xf', archive, '-C', directory]);
  const old = await import(pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href) as {
    buildRecords: typeof buildRecords; OWN: typeof OWN; MODEL: typeof MODEL;
  };
  const slot = old.OWN.ownAnchors[3].id;
  const turns: ReplayTurn[] = [
    { human: '気になる輪郭について教えてください。', plan: {
      action: 'confirm', target: 'figure_3', speech: clarification,
      aiExtraction: JSON.stringify([extract({ quote: clarification, aspect: 'part', targets: [slot] })]),
    } },
    { human: humanProposal, plan: {
      action: 'agree', target: 'figure_3', name: alias, act: 'name_propose', referent: 'figure_3', speech: adoption,
      extraction: JSON.stringify([extract({ quote: humanProposal, aspect: 'name', name: alias, targets: [slot] })]),
    } },
  ];

  for (const label of strategies) {
    for (const antecedent of [null, { speaker: 'human', act: 'name_propose', choice: 'claim_1' },
      { speaker: 'ai', act: 'name_accept', choice: 'claim_2' }] as const) {
      await t.test(label + (antecedent ? ' approval linked to ' + antecedent.speaker : ' agrees before the short approval'), async () => {
        const finalTurns: ReplayTurn[] = antecedent ? [...turns, { human: approval, plan: {
          action: 'accept', target: 'none', referent: 'figure_3', act: 'name_propose', antecedent: antecedent.choice,
          extraction: JSON.stringify([extract({ quote: approval, aspect: 'name', respondsToTurn: 4 })]), speech: affirmation,
        } }] : turns;
        const records = await old.buildRecords({ label, dialoguePolicy: 'holistic_v3', turns: finalTurns });
        const trial = records.trials[0];
        const { tape, result: oldReplay } = trial.replay[0];
        assert.equal(trial.profile.dialoguePolicy, 'holistic_v3');
        assert.equal(oldReplay.status, 'same_material_intervention_verified');
        assert.equal(oldReplay.recordedPayloadsReproduced, true);
        if (antecedent) {
          assert.equal(trial.attempts[0].namingReconfirm, undefined, 'the archived verifier discarded the request');
          assert.equal(tape.events.at(-2).speaker, 'ai');
          assert.equal(tape.events.at(-2).seq, 4);
          const local = oldReplay.sides[0].requests.find((request: { phase: string }) => request.phase === 'local_function');
          assert.ok(local);
          const state = JSON.parse(local.payload.state) as { priorClaims: WireClaim[] };
          const claim = state.priorClaims[Number(antecedent.choice.slice('claim_'.length))];
          assert.equal(claim.speaker, antecedent.speaker);
          assert.equal(claim.act, antecedent.act);
          assert.equal(claim.name, alias);
        }
        const before = hash(tape);
        assert.equal(old.OWN.ownImage.mimeType, 'image/png');
        const own = { ...old.OWN, ownImage: { ...old.OWN.ownImage, mimeType: 'image/png' as const } };
        const replay = await pairedInterventionReplay(tape, own, old.MODEL, trial.profile);
        assert.equal(hash(tape), before, 'the historical tape and its sends stay unchanged');
        assert.deepEqual({
          status: replay.status, common: replay.commonEqual, policy: replay.policyConformant,
          reproduced: replay.recordedPayloadsReproduced,
        }, {
          status: 'same_material_intervention_verified', common: true, policy: true, reproduced: true,
        });
      });
    }
  }
});
