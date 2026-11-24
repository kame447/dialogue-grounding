// Synthetic Luna drafts exercise the public turn boundary with local transports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { interventionChecks, s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { anchors, deadlines, ids, image, memo } from './support/s4-integration/harness.ts';
import { buildRecords } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...deadlines(), localMs: 3000, observationMs: 3000, decisionMs: 3000, generationMs: 3000,
}, 'two_stage_v3');
const [slot] = ids;
const target = { kind: 'single', figureId: slot };
const feature = '輪に切れ目がある';
const observation = memo();
observation.figures[0].analytic.shapes = [feature];
const ownMemo = validateObservationMemo(observation, { ownAnchors: anchors });
const readKey = async () => 'sk-or-SYNTHETIC-offline-public-draft-key';
const clean = '輪に切れ目がある形ですか？';
const firstNote = 'Check whether the question can be shorter.';
const secondNote = 'Keep the description concise and neutral.';
const alternatives = ['案1：輪に切れ目がある形ですか？', '案2：切れ目のある輪がついていますか？'].join('\n');
const agreeSpeech = (name: string) => `はい、この形は「${name}」と呼びましょう。`;

type Strategy = typeof strategies[number];
type Turn = { human: string; drafts: readonly string[]; name?: string };
type Message = { role: string; content: unknown };

async function run(strategy: Strategy, { human, drafts, name }: Turn) {
  const action = name === undefined ? 'confirm' : 'agree';
  const local: LocalSegmentProposal[] = name === undefined ? [] : [{
    segmentId: '1', quote: human, proposition: human, aspect: 'name', name, targets: [slot],
    linkedIssueId: null, respondsToTurn: null,
  }];
  const requests: Message[][] = [];
  const extracted: string[] = [];
  const traces: JevTurnTrace[] = [];
  let responseId = 0;
  const transport = {
    enabled: true, readKey, timeoutMs: 3000, questionLayout: profile.questionLayout,
    async fetchImpl(_url: string, init: RequestInit) {
      const { model, questions } = JSON.parse(String(init.body)) as JevDecisionPayload;
      const answers = Object.fromEntries(Object.entries(questions).map(([key, { criteria }]) => {
        const labels = Object.keys(criteria);
        const choice = key === 'action' ? action
          : key === 'target' || key === 'human_referent' ? 'figure_0'
          : key === 'name' || key === 'feature' ? labels.find(label => JSON.parse(criteria[label]).value === (key === 'name' ? name : feature))
          : labels[0];
        assert.ok(choice && labels.includes(choice), 'scripted choice must be offered for ' + key);
        return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
      }));
      return Response.json({ model, id: 'gen-public-draft-' + ++responseId, usage: { cost: 0 }, answers });
    },
  };
  const runtime = createProfileDialogue(profile, {
    strategy, image, anchors, technicalTrial: { version: 'adaptive_repair_v3' },
    observer: {
      async observeAll() { return structuredClone(ownMemo); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: { async complete(messages: Message[], { phase }: { phase: string }) {
      if (phase === 'local_extraction') return { text: JSON.stringify(local) };
      if (phase === 'ai_extraction') {
        extracted.push(String(messages.at(-1)?.content));
        return { text: '[]' };
      }
      assert.equal(phase, 'generation');
      const text = drafts[requests.length];
      requests.push(structuredClone(messages));
      assert.ok(text, 'unexpected generation attempt');
      return { text, model: 'synthetic-luna' };
    } },
    jevDecision: createJevDecisionClient(transport)!,
    localGrounding: {
      classifier: { async classify({ segments }) {
        return segments.map(({ segmentId }) => ({ segmentId, act: 'name_propose', respondsToClaimId: null, rawScore: null }));
      } },
      aiPublicTransport: transport,
    },
    onJevTurnTrace(trace) { traces.push(structuredClone(trace)); },
  });
  const privateState: JevPrivateState = runtime.initialPrivateState();
  const before = structuredClone(privateState);
  const events = [{ id: 'human-1', seq: 1, speaker: 'human', text: human }];
  const outcome = await runtime.runAiTurn({ events, privateState, lastEventId: 'human-1', requestSeq: 1 }).then(
    result => ({ result, error: null }), (error: unknown) => ({ result: null, error }),
  );
  const trace = traces.at(-1);
  assert.ok(trace);
  assert.equal(trace.finalAction?.action, action);
  assert.deepEqual(trace.executed?.target, target);
  assert.equal(trace.executed?.name, name ?? null);
  assert.deepEqual(privateState, before, 'the caller state is unchanged');
  return { ...outcome, trace, requests, extracted, before };
}

type Outcome = Awaited<ReturnType<typeof run>>;
function checkRetry(outcome: Outcome, rejected: string) {
  const { requests, trace } = outcome;
  assert.equal(requests.length, 2);
  const [first, retry] = requests;
  assert.deepEqual(retry.slice(0, -1), first, 'retry preserves the original request');
  assert.equal(retry.at(-1)?.role, 'system');
  assert.ok(!String(retry.at(-1)?.content).includes(rejected), 'retry carries no rejected draft');
  assert.equal(trace.generationGuard.regenerated, true);
  assert.equal(trace.generationGuard.fallback, false);
  assert.ok(trace.generationGuard.violations.length > 0);
  assert.equal(s4Probe.traceShape(trace, profile.questionLayout), true);
}

function checkPublished(outcome: Outcome, text: string) {
  assert.ifError(outcome.error);
  assert.equal(outcome.result?.text, text);
  assert.equal(outcome.trace.publicSpeech, text);
}

for (const strategy of strategies) {
  test(`v3 ${strategy} retries an otherwise public answer with an English editing note`, async () => {
    const draft = clean + '\n' + firstNote;
    const outcome = await run(strategy, { human: 'その形の特徴を確認できますか？', drafts: [draft, clean] });
    checkPublished(outcome, clean);
    checkRetry(outcome, firstNote);
  });

  test(`v3 ${strategy} stops before publishing or committing a name when the second draft still contains notes`, async () => {
    const name = '風見鶏';
    const speech = agreeSpeech(name);
    const outcome = await run(strategy, { name, human: `この図形は「${name}」と呼びませんか？`,
      drafts: [speech + '\n' + firstNote, speech + '\n' + secondNote] });
    assert.deepEqual({
      publicSpeech: outcome.result?.text ?? null,
      ledgerEntry: outcome.result?.privateState.ledger[slot] ?? null,
    }, { publicSpeech: null, ledgerEntry: null });
    assert.ok(outcome.error instanceof Error && 'code' in outcome.error);
    assert.equal(outcome.error.code, 'unsafe_generation');
    assert.equal(outcome.trace.status, 'error');
    assert.equal(outcome.trace.publicSpeech, null);
    assert.deepEqual(outcome.extracted, []);
    assert.deepEqual(outcome.before.ledger[slot], { status: 'unassigned', name: null });
    checkRetry(outcome, firstNote);
  });

  test(`v3 ${strategy} publishes short shape notation and a participant's English name on the first attempt`, async () => {
    const symbols = 'OK、Yに似た形にV字のくぼみとL字の折れ目がありますか？';
    const name = 'Silver Paper Kite';
    const scope = [
      { human: '図形の輪郭を一緒に確かめたいです。', drafts: [symbols] },
      { name, human: `その形の呼び名は「${name}」でどうでしょう？`, drafts: [agreeSpeech(name)] },
    ];
    for (const turn of scope) {
      const outcome = await run(strategy, turn);
      checkPublished(outcome, turn.drafts[0]);
      assert.equal(outcome.requests.length, 1);
      assert.deepEqual(outcome.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
      if (turn.name) {
        assert.deepEqual(outcome.result!.privateState.ledger[slot], { status: 'agreed', name: turn.name });
      }
    }
  });

  test(`v3 ${strategy} retries a list of alternative replies even when all are Japanese`, async () => {
    const outcome = await run(strategy, { human: 'どんな形か照合したいです。', drafts: [alternatives, clean] });
    checkPublished(outcome, clean);
    checkRetry(outcome, alternatives);
  });

  test(`v3 ${strategy} retries a list of fully quoted alternative replies`, async () => {
    const drafts = ['・「切れ目のある輪が見えますか？」', '・『輪の途中が途切れているように見えます。』'].join('\n');
    const result = await run(strategy, { human: '似た形をどう見分ければよいですか？', drafts: [drafts, clean] });
    checkPublished(result, clean);
    checkRetry(result, drafts);
    assert.ok(result.trace.generationGuard.violations.includes('working_note'));
    assert.deepEqual(result.result!.privateState.ledger, result.before.ledger);
  });

  const observations = ['輪の縁が途中で途切れています。', '細い棒が輪の縁に触れています。'];
  const askToQuote = `私には「${observations[0]}」「${observations[1]}」と見えます。` +
    'この二点を私の言い方で並べて、同じ特徴のある形か尋ねてください。';
  const askForFeatures = '照らし合わせるため、手がかりを箇条書きで教えてください。';
  const featureList = (first: string, second: string) =>
    ['手がかりは次の二つです。', `・${first}`, `・${second}`, 'この二つがそろう形ですか？'].join('\n');

  test(`v3 ${strategy} still retries new quoted replies when the participant has supplied observations`, async () => {
    const draft = featureList('「輪の開いたところが見えますか？」', '『棒は輪の縁に届いていますか？』');
    const result = await run(strategy, { human: askToQuote, drafts: [draft, clean] });
    checkPublished(result, clean);
    checkRetry(result, draft);
    assert.ok(result.trace.generationGuard.violations.includes('working_note'));
    assert.deepEqual(result.result!.privateState.ledger, result.before.ledger);
  });

  for (const { label, human, speech } of [
    { label: 'plain features', human: askForFeatures, speech: featureList('輪に切れ目がある', '細い棒が輪に接している') },
    { label: 'quoted features', human: askForFeatures, speech: featureList('「輪に切れ目がある」', '『細い棒が輪に接している』') },
    { label: 'the participant’s full observation sentences', human: askToQuote,
      speech: featureList(`「${observations[0]}」`, `『${observations[1]}』`) },
  ]) test(`v3 ${strategy} publishes one question listing ${label} on the first draft`, async () => {
    const result = await run(strategy, { human, drafts: [speech, speech] });
    assert.equal(result.requests.length, 1, JSON.stringify(result.trace.generationGuard));
    checkPublished(result, speech);
    assert.deepEqual(result.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.deepEqual(result.result!.privateState.ledger, result.before.ledger);

    // Exercise the same first draft in the paired replay harness and check the persisted turn.
    const records = await buildRecords({ label: strategy, technicalTrial: { version: 'adaptive_repair_v3' },
      turns: [{ human, plan: { action: 'confirm', target: 'figure_0', speech } }],
    });
    const trial = records.trials[0];
    assert.equal(trial.turns[0].publicText, speech);
    assert.deepEqual(trial.lastCommittedState.ledger, trial.replay[0].tape.state.ledger);
    assert.equal(trial.replay[0].result.status, 'same_material_intervention_verified');
    for (const side of trial.replay[0].result.sides) {
      assert.equal(side.requests.filter((request: { phase: string }) => request.phase === 'generation').length, 1);
    }
    const checks = interventionChecks(records);
    const required = ['identity.intervention_policy', ...['shape', 'binding', 'execution', 'replay']
      .map(check => 'intervention.trial.0.attempt.0.' + check)];
    assert.deepEqual(required.map(id => checks.find(check => check.id === id)?.status),
      required.map(() => 'pass'), JSON.stringify(checks));
  });
}
