import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick, setTimeout as pause } from 'node:timers/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { SAFE_JUDGMENT } from '../dialogue-model/runtime/judgment/schema.mjs';
import { buildDecisionEvidence } from '../dialogue-model/runtime/v2/decision-evidence.mjs';
import { createDecisionComparisonClient } from '../dialogue-model/runtime/decisions-client.mjs';
import { handleRequest } from '../workers/research-ai-proxy/src/index.mjs';
import { DECISION_ACTIONS, DECISION_MODELS } from '../workers/research-ai-proxy/src/decisions.mjs';

const trial = createTrialV2({ seed: 338 });
const model = modelView(trial);
const probabilities = Object.fromEntries(DECISION_ACTIONS.map(action => [action, action === 'agree' ? 1 : 0]));
const shadowResult = purpose => ({ purpose, model: DECISION_MODELS[purpose], action: 'agree', probabilities, confidence: 1, usage: { inputTokens: 12, costUsd: 0.01 } });
const publicEvent = (seq, text) => ({ seq, turn: seq, id: `event-${seq}`, speaker: 'human', text, at: '2026-10-18T00:00:00.000Z' });
function makeDialogue(decisionShadowClient = null, { generationGate = null } = {}) {
  const calls = [];
  const client = { async complete(messages, options = {}) {
    calls.push({ messages: structuredClone(messages), phase: options.phase });
    if (options.phase === 'generation' && generationGate) await generationGate;
    return { text: options.phase === 'final_submission' ? JSON.stringify(Object.fromEntries(model.anchors.map((a, i) => [a.id, '名' + i]))) : 'FUTURE-REPLY-CANARY「話題名」' };
  } };
  const dialogue = createDialogueV2({ client, strategy: 'repair-first', image: { mimeType: model.mimeType, base64: model.png.toString('base64') },
    anchors: model.anchors, judge: { async judge() { return { ...SAFE_JUDGMENT, action: 'propose_name', targetSlot: model.anchors[0].id, candidateName: '話題名' }; } },
    decisionShadowClient });
  const signal = new AbortController();
  const run = () => dialogue.runAiTurn({ events: [publicEvent(1, '公開された形の相談')], signal: signal.signal,
    lastEventId: 'event-1', privateState: dialogue.initialPrivateState() });
  return { dialogue, calls, signal, run };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('audit: both real dated-build formats survive client-to-Worker round trip without model or URL selection by the caller', async () => {
  const config = { provider: 'cloudflare', baseUrl: 'https://audit.test/v1', apiKey: 'audit-client-proxy-token-more-than-thirty-two-chars' };
  const env = { RESEARCH_PROXY_TOKEN: config.apiKey, RESEARCH_DECISIONS_ENABLED: 'true', OPENROUTER_DECISIONS_API_KEY: 'sk-or-audit-worker-only' };
  const upstream = [];
  const client = createDecisionComparisonClient(config, async (url, init) => handleRequest(new Request(url, init), env, async (destination, request) => {
    const body = JSON.parse(request.body); upstream.push({ destination, body });
    return Response.json({ id: 'gen-synthetic-audit-id', provider: 'synthetic-audit-provider',
      model: body.model + (body.model.startsWith('typesafe/') ? '-20261014' : '-20261006'),
      answers: { action: { type: 'choice', choice: 'agree', probabilities, confidence: 1 } },
      usage: { input_tokens: 887, output_tokens: 86, cost: 0.000037254 } });
  }));
  for (const purpose of Object.keys(DECISION_MODELS)) {
    const result = await client.chooseAction({ purpose, state: '合成の公開入力', model: 'ignored/model', url: 'https://invalid.test' });
    assert.equal(result.action, 'agree'); assert.equal(result.model.startsWith(DECISION_MODELS[purpose] + '-'), true);
    assert.equal(result.confidence, 1); assert.equal(result.usage.inputTokens, 887); assert.equal(result.usage.outputTokens, 86);
    assert.equal(result.provider, 'synthetic-audit-provider'); assert.equal(result.id, 'gen-synthetic-audit-id');
  }
  assert.deepEqual(upstream.map(r => r.body.model), Object.values(DECISION_MODELS));
  assert.ok(upstream.every(r => r.destination === 'https://openrouter.ai/api/alpha/decisions'));
});

test('audit: shadow uses only the turn snapshot and own hypotheses; public payload, ledger and final submission stay unchanged', async () => {
  const seen = [];
  const baseline = makeDialogue(), shadow = makeDialogue({ async chooseAction(args) { seen.push(args); return shadowResult(args.purpose); } });
  const normal = await baseline.run(), observed = await shadow.run();
  await nextTick();
  assert.equal(observed.text, normal.text); assert.deepEqual(observed.privateState.ledger, normal.privateState.ledger);
  assert.equal(observed.privateState.ledger[model.anchors[0].id].status, 'tentative');
  assert.equal(seen.length, 2); assert.equal(seen[0].state, seen[1].state);
  const payload = JSON.parse(seen[0].state);
  assert.deepEqual(payload.publicUtterances, [{ speaker: '相手', text: '公開された形の相談' }]);
  for (const secret of ['FUTURE-REPLY-CANARY', trial.trialId, trial.human.png.toString('base64'), model.png.toString('base64'), JSON.stringify(trial.key)]) {
    assert.ok(!seen[0].state.includes(secret));
  }
  for (const figureId of Object.values(trial.key.ai)) assert.ok(!seen[0].state.includes('"' + figureId + '"'));
  const oldEvidence = seen[0].state;
  const mutation = buildDecisionEvidence({ events: [{ ...publicEvent(1, '公開された形の相談'), privateKey: trial.key, future: 'PRIVATE-FUTURE' }],
    ownLedger: baseline.dialogue.initialPrivateState().ledger, judgment: { ...SAFE_JUDGMENT, privateKey: trial.key }, strategy: 'repair-first' });
  assert.ok(!mutation.includes('PRIVATE-FUTURE')); assert.ok(!oldEvidence.includes('privateKey'));
  await baseline.dialogue.finalRequest({ events: [], privateState: normal.privateState });
  await shadow.dialogue.finalRequest({ events: [], privateState: observed.privateState });
  assert.deepEqual(shadow.calls, baseline.calls);
  assert.equal(baseline.dialogue.getAttempts()[0].decisionShadow, undefined, 'default OFF');
});

test('audit: delayed shadow must not block public generation or hold the turn open', async () => {
  const started = deferred(), release = deferred();
  const app = makeDialogue({ async chooseAction({ purpose }) { started.resolve(); await release.promise; return shadowResult(purpose); } });
  let finished = false;
  const pending = app.run().then(result => { finished = true; return result; });
  try {
    await started.promise;
    await nextTick();
    assert.equal(app.calls.filter(c => c.phase === 'generation').length, 1, 'shadow latency must not delay the public generator');
    assert.equal(finished, true, 'shadow must not extend the queue-owned single-flight slot');
  } finally { release.resolve(); await pending; }
});

test('audit: superseding a turn during a pending shadow must not start stale paid generation', async () => {
  const started = deferred(), release = deferred(), generation = deferred();
  const app = makeDialogue({ async chooseAction({ purpose }) { started.resolve(); await release.promise; return shadowResult(purpose); } },
    { generationGate: generation.promise });
  const pending = app.run().then(result => ({ result }), error => ({ error }));
  try {
    await started.promise; await nextTick();
    const before = app.calls.filter(c => c.phase === 'generation').length;
    app.signal.abort(); release.resolve(); generation.resolve();
    const outcome = await pending;
    assert.equal(outcome.error?.name, 'AbortError');
    assert.equal(app.calls.filter(c => c.phase === 'generation').length, before, 'cancellation must not fall through the shadow catch into generation');
  } finally { release.resolve(); generation.resolve(); await pending; }
});

test('audit: shadow failures remain private in persisted research records and do not change scoring', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'decisions-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const received = [], scored = [], shadowGate = deferred();
  t.after(() => shadowGate.resolve());
  const task = await createNamingTaskV2({ seed: 338, strategy: 'repair-first', runDir: directory, createTrial: () => trial,
    judge: { async judge() { return SAFE_JUDGMENT; } },
    client: { async complete(_messages, { phase }) {
      return { text: phase === 'final_submission' ? JSON.stringify(Object.fromEntries(model.anchors.map(a => [a.id, '同じ名前']))) : '公開の返答' };
    } },
    scoreTrial(args) { scored.push(args); return { success: false, provisional: true, matchedCount: 0, total: 6, figures: [] }; },
    decisionShadowClient: { async chooseAction(args) { received.push(args); await shadowGate.promise;
      if (args.purpose === 'decision_jev') throw new Error('PRIVATE-PROVIDER-ERROR'); return shadowResult(args.purpose); } } });
  task.message('公開の相談'); await task.whenIdle(); await nextTick();
  const state = JSON.stringify(task.getState());
  assert.doesNotMatch(state, /decisionShadow|probabilities|PRIVATE-PROVIDER|decision_jev|decision_luna/);
  assert.equal(task.getState().aiStatus, 'idle');
  const [file] = (await readdir(directory)).filter(file => file.endsWith('.json'));
  const initial = JSON.parse(await readFile(join(directory, file), 'utf8'));
  assert.equal(initial.options.decisionShadow, true);
  assert.deepEqual(initial.attempts[0].decisionShadow, { status: 'pending' });
  assert.deepEqual(initial.judgments[0].decisionShadow, { status: 'pending' });
  shadowGate.resolve();
  let record = initial;
  // Observe background persistence without causing a new task action/write.
  for (let tries = 0; tries < 100 && !Array.isArray(record.attempts[0].decisionShadow); tries++) {
    await pause(10); record = JSON.parse(await readFile(join(directory, file), 'utf8'));
  }
  assert.deepEqual(record.attempts[0].decisionShadow.map(item => item.status), ['error', 'ok']);
  assert.deepEqual(record.judgments[0].decisionShadow, { status: 'pending' });
  assert.deepEqual(record.events, initial.events); assert.deepEqual(record.ownLedger, initial.ownLedger);
  assert.deepEqual(record.publicHistory, initial.publicHistory);
  assert.deepEqual(task.researcherView().attempts[0].decisionShadow, record.attempts[0].decisionShadow);
  assert.doesNotMatch(JSON.stringify(task.getState()), /decisionShadow|probabilities|PRIVATE-PROVIDER|decision_jev|decision_luna/);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE-PROVIDER-ERROR/);
  assert.equal(received.length, 2); assert.equal(scored.length, 0);
  await task.submitHuman({ names: Object.fromEntries(Object.keys(trial.key.human).map(id => [id, '同じ名前'])) });
  assert.equal(scored.length, 0); await task.submitAI(); assert.equal(scored.length, 1);
  assert.deepEqual(scored[0].key, trial.key);
  assert.deepEqual(scored[0].humanSubmission, Object.fromEntries(Object.keys(trial.key.human).map(id => [id, '同じ名前'])));
  assert.deepEqual(scored[0].aiSubmission, Object.fromEntries(model.anchors.map(a => [a.id, '同じ名前'])));
});
