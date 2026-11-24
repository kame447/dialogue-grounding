import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract.ts';
import { MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import { canonicalReceptionProtocolV2, receptionProtocolSha256 } from '../dialogue-model/runtime/v2/reception.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { handleRequest } from '../workers/research-ai-proxy/src/index.mjs';
import { configuredParticipantPin, participantChoices } from '../workers/research-ai-proxy/src/participant-transport.ts';

registerHooks({ resolve(name, context, next) {
  if (name === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}};export class WorkerEntrypoint extends DurableObject {}', shortCircuit: true };
  }
  if (name.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(name, context.parentURL);
    if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
  }
  return next(name, context);
} });
const { TangramSession }: any = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href);

const pin = validateParticipantModelPin({
  schemaVersion: 'participant_model_pin_v1', terraModelId: 'gpt-6.1-terra-2026-11-01',
  lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261014',
});
const settings = {
  PARTICIPANT_MODEL_PIN_JSON: JSON.stringify(pin), DIALOGUE_MODEL: 'gpt-6-luna', VISION_MODEL: 'gpt-6.1-terra',
  RESEARCH_PROXY_TOKEN: 'synthetic-participant-token-for-mock-only',
  UPSTREAM_API_KEY: 'synthetic-upstream-key-for-mock-only', RESEARCH_DECISIONS_ENABLED: 'true',
  OPENROUTER_DECISIONS_API_KEY: 'sk-or-synthetic-participant-choice-mock',
};
const protocol = {
  schemaVersion: 'reception_protocol_v2', protocolId: '047e8558-d48e-4fc2-b9c4-65456cc77dbb', revision: 1,
  allowedOrders: [['bypass-enabled', 'repair-first']], seedPolicy: 'shared', referenceMemory: true,
  betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
};
const sha256 = receptionProtocolSha256(canonicalReceptionProtocolV2(protocol));
const displayed = { protocolId: protocol.protocolId, revision: protocol.revision, sha256 };
const approvedLimits = { lunaCalls: 60, lunaTokens: 300_000, lunaPosts: 60, jevPosts: 60, jevUsd: 0.05 };
const chatResponse = (model: unknown, content: string) => ({
  model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 },
});
type Choices = Record<string, { criteria: Record<string, string> }>;
function answers(questions: Choices, observe = false) {
  return Object.fromEntries(Object.entries(questions).map(([name, { criteria }]) => {
    const keys = Object.keys(criteria);
    const selection = observe ? { action: 'request_observation', target: 'figure_0' }[name as 'action' | 'target'] : undefined;
    const choice = selection && keys.includes(selection) ? selection
      : name === 'action' && keys.includes('accept') ? 'accept' : keys.includes('none') ? 'none' : keys[0];
    return [name, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(key => [key, Number(choice === key)])) }];
  }));
}

function memory() {
  let items = new Map<string, any>();
  let pending: Promise<unknown> = Promise.resolve();
  const view = (m: Map<string, any>) => ({
    async get(key: string) { return structuredClone(m.get(key)); },
    async put(entries: Record<string, unknown>) { for (const [key, value] of Object.entries(entries)) m.set(key, structuredClone(value)); },
    async delete(key: string) { return m.delete(key); },
  });
  return {
    async get(key: string) { return view(items).get(key); },
    async deleteAlarm() {},
    transaction<T>(fn: (tx: ReturnType<typeof view>) => Promise<T>) {
      const update = pending.then(async () => {
        const staged = structuredClone(items), result = await fn(view(staged));
        items = staged;
        return result;
      });
      pending = update.catch(() => {});
      return update;
    },
  };
}

function harness(enabled = true) {
  const storage = memory(), calls: Array<{ kind: string; expected: string; body: any }> = [];
  const controlled: { policy: unknown; terra: unknown; luna: unknown; jev: unknown; legacyCalls: number; observe: boolean } =
    { policy: { ...pin }, terra: pin.terraModelId, luna: pin.lunaModelId, jev: pin.jevModelId, legacyCalls: 0, observe: false };
  let slots: string[] = [];
  const env = {
    PARTICIPANT_TERRA_ENABLED: enabled ? 'on' : 'off',
    PARTICIPANT_TERRA_LIMITS_JSON: JSON.stringify(approvedLimits),
    V2_UTTERANCE_STYLE: 'concise',
    AI_PROXY: { async chat() { controlled.legacyCalls++; throw new Error('synthetic legacy call'); } },
    PARTICIPANT_AI_PROXY: {
      async participantPolicy() { return controlled.policy; },
      async participantChat(body: any, expected: string) {
        calls.push({ kind: body.purpose, expected, body });
        if (body.purpose === 'visual_observation') {
          const args = JSON.parse(body.messages[1].content);
          if (args.figureIds) {
            return { status: 200, data: chatResponse(controlled.terra, JSON.stringify({ figures: args.figureIds.map((figureId: string) =>
              ({ figureId, supports: ['三角を含む'], contradicts: [], unknown: [] })) })) };
          }
          slots = args.ownAnchors.map(({ id }: { id: string }) => id);
          const figures = slots.map(id => ({ id, holistic: [], analytic: { shapes: ['三角'], composition: '辺がつながる', relations: [] }, unknowns: [] }));
          return { status: 200, data: chatResponse(controlled.terra, JSON.stringify({ figures })) };
        }
        const first = body.messages[0].content, last = body.messages.at(-1).content;
        const text = first === MEMO_LOCAL_EXTRACTION_INSTRUCTIONS || first === MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS ? '[]'
          : String(last).includes('JSON') ? JSON.stringify(Object.fromEntries(slots.map(id => [id, '合成名']))) : 'なるほど、聞かせてくれてありがとう。';
        return { status: 200, data: chatResponse(controlled.luna, text) };
      },
      async participantChoices(body: { state: string; questions: Choices }, expected: string) {
        calls.push({ kind: 'choices', expected, body });
        const observe = controlled.observe && Object.hasOwn(body.questions.action?.criteria ?? {}, 'request_observation');
        if (observe) controlled.observe = false;
        const data = { id: 'gen-synthetic', model: controlled.jev, usage: { cost: 0 }, answers: answers(body.questions, observe) };
        // Exercise the proxy's real validation of each positive Jev stage.
        return controlled.jev === pin.jevModelId ? participantChoices(settings, body, expected, async () => Response.json(data))
          : { status: 200, data };
      },
    },
  };

  function makeSession() {
    const session = new TangramSession({ storage, id: { toString: () => 'c'.repeat(64) }, waitUntil() {} }, env);
    session.settings = async () => ({ mode: { value: 'on', revision: 1 }, protocol: { protocol, revision: 1, sha256 } });
    return session;
  }
  let session = makeSession();
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    session.fetch(new Request('https://session.invalid/api/' + path, { method, ...(body === undefined ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })) as Promise<Response>;

  return {
    storage, calls, controlled, env, request,
    evict() { session = makeSession(); },
    async receive() {
      assert.equal(await session.registerBaseOwner(), true);
      const result = await request('reception', undefined, 'POST');
      assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
    },
    approve() { return session.adminApproveReception({ expectedRevision: 0, order: 0, protocol: displayed, participantModelPin: null }); },
    async start(expectedRecordId?: string) {
      const reception = await storage.get('reception:v1');
      return request('start', { version: 2, expectedReceptionRevision: reception.revision, ...(expectedRecordId ? { expectedRecordId } : {}) });
    },
    async idle() { await session.trial?.whenIdle(); },
    async complete(recordId: string, trial: { scene: { shapes: Array<{ id: string }> }; events: unknown[] }) {
      const submitted = await request('names', { expectedRecordId: recordId, confirm: true, expectedEventCount: trial.events.length,
        names: Object.fromEntries(trial.scene.shapes.map(({ id }) => [id, '人間側の合成名'])) });
      assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()));
    },
  };
}
async function jsonOk(response: Response) {
  const result = await response.json();
  assert.ok(response.status === 200 || response.status === 202, JSON.stringify(result));
  return result;
}

test('Worker approval persists one private pin, both trial conditions use it, and eviction restores the same record', async () => {
  const h = harness();
  await h.receive();
  const approved = await h.approve();
  assert.deepEqual(approved.plan.participantModelPin, pin);
  assert.deepEqual((await h.storage.get('reception:v1')).plan.participantModelPin, pin);
  assert.equal(h.calls.length, 0, 'approval does not infer');
  h.env.PARTICIPANT_TERRA_ENABLED = 'off'; // Does not change an approval already on disk.
  const first = await jsonOk(await h.start());
  const firstId = first.trial.sessionId;
  assert.equal(h.calls.length, 1);
  const opening = '三角の部分があります。';
  h.controlled.observe = true;
  await jsonOk(await h.request('message', { expectedRecordId: firstId, text: opening }));
  await h.idle();
  const one = await h.storage.get('record:' + firstId);
  assert.equal(one.strategy, 'bypass-enabled');
  assert.deepEqual(one.options.participantModelPin, pin);
  assert.equal(one.options.jevResearch, true);
  assert.equal(one.queueState.errorCode, null, JSON.stringify({
    attempts: one.attempts?.map(({ error, errorCode }: any) => ({ error, errorCode })),
    traces: one.jevTraces?.map(({ error, decision, ...trace }: any) => ({ error, decision, status: trace.status, generationErrorCode: trace.generationErrorCode })),
    requests: one.requests, calls: h.calls.map(({ kind, body }) => [kind, Object.keys(body.questions ?? {})]),
  }));
  assert.ok(one.events.some((event: any) => event.text === 'なるほど、聞かせてくれてありがとう。'));
  const sends = h.calls.length;
  h.evict();
  assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, firstId);
  assert.equal(h.calls.length, sends);
  await h.complete(firstId, (await jsonOk(await h.request('state'))).trial);

  const second = await jsonOk(await h.start(firstId));
  const secondId = second.trial.sessionId;
  const two = await h.storage.get('record:' + secondId);
  assert.equal(two.strategy, 'repair-first');
  assert.equal(two.seed, one.seed);
  assert.deepEqual(two.options.participantModelPin, pin);
  assert.equal(two.initialObservation.memoSha256, one.initialObservation.memoSha256);
  h.controlled.observe = true;
  await jsonOk(await h.request('message', { expectedRecordId: secondId, text: opening }));
  await h.idle();
  const finalized = await h.storage.get('record:' + secondId);
  assert.equal(finalized.queueState.errorCode, null);
  assert.ok(finalized.events.some((event: any) => event.text === 'なるほど、聞かせてくれてありがとう。'));
  const observations = h.calls.filter(({ kind }) => kind === 'visual_observation')
    .map(({ body }) => JSON.parse(body.messages[1].content));
  assert.equal(observations.filter(({ ownAnchors }) => ownAnchors.length === 6).length, 1,
    'shared seed and pin reuse the initial Terra memo');
  assert.equal(observations.filter(({ figureIds }) => figureIds?.length === 1).length, 2,
    'each condition performs its own targeted Terra call');
  assert.equal(one.jevTraces[0].reobservations.length, 1);
  assert.equal(finalized.jevTraces[0].reobservations.length, 1);
  assert.equal(one.jevTraces[0].intervention.policy, 'bypass_acceptance_v1:accept');
  assert.equal(finalized.jevTraces[0].intervention.policy, 'bypass_acceptance_v1:veto');
  assert.equal(h.controlled.legacyCalls, 0);
  assert.ok(h.calls.some(({ kind }) => kind === 'choices'));
  assert.ok(h.calls.some(({ kind }) => kind === 'dialogue_turn'));
  for (const { kind, expected, body } of h.calls) {
    assert.equal(expected, kind === 'choices' ? pin.jevModelId : kind === 'dialogue_turn' ? pin.lunaModelId : pin.terraModelId);
    const wire = JSON.stringify(body);
    assert.equal(/data:image/u.test(wire), kind === 'visual_observation');
    assert.doesNotMatch(wire, /service-binding-only|participantModelPin|ANSWER_KEY_CANARY/u);
  }
  const state = await jsonOk(await h.request('state'));
  assert.doesNotMatch(JSON.stringify(state), /gpt-6|typesafe\/jev|participantModelPin|ownAnchors|observationMemo|data:image/u);
});

test('approved trial limits survive Worker recreation and apply to both conditions after an env change', async () => {
  const h = harness();
  await h.receive();
  await h.approve();
  const first = await jsonOk(await h.start());
  const recordId = first.trial.sessionId;
  assert.deepEqual((await h.storage.get('record:' + recordId)).jevLedger.limits, approvedLimits);

  h.env.PARTICIPANT_TERRA_LIMITS_JSON = JSON.stringify({ ...approvedLimits, jevPosts: 59 });
  h.evict();
  const restored = await jsonOk(await h.request('state'));
  assert.equal(restored.trial.sessionId, recordId);
  assert.deepEqual((await h.storage.get('record:' + recordId)).jevLedger.limits, approvedLimits);

  await h.complete(recordId, restored.trial);
  const second = await jsonOk(await h.start(recordId));
  const secondRecord = await h.storage.get('record:' + second.trial.sessionId);
  assert.equal(secondRecord.strategy, 'repair-first');
  assert.deepEqual(secondRecord.jevLedger.limits, approvedLimits);
  assert.deepEqual((await h.storage.get('reception:v1')).plan.participantLimits, approvedLimits);
  assert.doesNotMatch(JSON.stringify(second), /participantLimits|jevPosts/u);
});

test('an existing trial from a model-only plan restores with its recorded limits', async () => {
  const h = harness();
  await h.receive();
  await h.approve();
  await h.storage.transaction(async tx => {
    const reception = await tx.get('reception:v1');
    delete reception.plan.participantLimits;
    await tx.put({ 'reception:v1': reception });
  });
  const first = await jsonOk(await h.start());
  const recordId = first.trial.sessionId;
  assert.deepEqual((await h.storage.get('record:' + recordId)).jevLedger.limits, approvedLimits);

  h.env.PARTICIPANT_TERRA_LIMITS_JSON = 'invalid';
  h.evict();
  const restored = await jsonOk(await h.request('state'));
  assert.equal(restored.trial.sessionId, recordId);
  assert.equal(h.calls.filter(({ kind }) => kind === 'visual_observation').length, 1);
});

test('Worker legacy approval still starts and restores through legacy options after Terra opt-in', async () => {
  const h = harness(false);
  await h.receive();
  const approved = await h.approve();
  assert.equal(Object.hasOwn(approved.plan, 'participantModelPin'), false);
  assert.equal(Object.hasOwn(approved.plan, 'participantLimits'), false);
  h.env.PARTICIPANT_TERRA_ENABLED = 'on';
  h.controlled.policy = null;
  h.env.PARTICIPANT_TERRA_LIMITS_JSON = 'invalid';
  const started = await jsonOk(await h.start());
  h.evict();
  const restored = await jsonOk(await h.request('state'));
  assert.equal(restored.trial.sessionId, started.trial.sessionId);
  const saved = await h.storage.get('record:' + started.trial.sessionId);
  assert.equal(saved.options.utteranceStyle, 'concise');
  assert.equal(Object.hasOwn(saved.options, 'participantModelPin'), false);
  assert.equal(Object.hasOwn(saved.options, 'jevResearch'), false);
  assert.equal(h.calls.length, 0);
});

test('unavailable policy refuses approval, and a pin changed after approval refuses trial start without sending', async () => {
  const h = harness();
  await h.receive();
  h.controlled.policy = null;
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  assert.equal((await h.storage.get('reception:v1')).plan, null);
  h.controlled.policy = { ...pin, jevModelId: 'typesafe/jev-1.14-20261002' };
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  h.controlled.policy = { ...pin };
  Object.defineProperty(h.controlled.policy, Symbol.dispose, { value() {}, enumerable: false });
  await h.approve();
  h.controlled.policy = { ...pin, terraModelId: 'gpt-6.1-terra-2026-11-02' };
  assert.equal((await h.start()).status, 409);
  assert.equal(h.calls.length, 0);
});

for (const [role, different] of [
  ['terra', 'gpt-6.1-terra-2026-11-02'], ['luna', 'gpt-6-luna-2026-10-02'], ['jev', 'typesafe/jev-1.14-20261002'],
] as const) {
  test('Worker refuses missing or changed ' + role + ' return IDs before publishing', async () => {
    for (const bad of [undefined, different]) {
      const h = harness();
      h.controlled[role] = bad;
      await h.receive();
      await h.approve();
      const started = await h.start();
      if (role === 'terra') {
        assert.equal(started.status, 409);
        assert.deepEqual(h.calls.map(({ kind }) => kind), ['visual_observation']);
        continue;
      }
      const firstId = (await jsonOk(started)).trial.sessionId;
      await jsonOk(await h.request('message', { expectedRecordId: firstId, text: '合成の手掛かりです。' }));
      await h.idle();
      const saved = await h.storage.get('record:' + firstId);
      const expectedKind = role === 'luna' ? 'dialogue_turn' : 'choices';
      assert.ok(h.calls.some(({ kind }) => kind === expectedKind));
      assert.equal(saved.jevLedger.haltReason, 'model_mismatch');
      assert.notEqual(saved.queueState.errorCode, null);
      assert.equal(saved.events.filter((event: any) => event.speaker === 'ai').length, 1);
      assert.equal(h.controlled.legacyCalls, 0);
    }
  });
}

test('private Luna proxy checks the raw returned ID before any fallback and forwards text only', async () => {
  assert.deepEqual(configuredParticipantPin(settings), pin);
  for (const [model, expectedStatus] of [[undefined, 502], ['gpt-6-luna', 502], [pin.lunaModelId, 200]] as const) {
    const request = new Request('https://mock.invalid/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + settings.RESEARCH_PROXY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'dialogue_turn', messages: [{ role: 'user', content: '合成の発話' }] }),
    });
    const response = await handleRequest(request, settings, async (_url, init) => {
      assert.equal(init?.redirect, 'manual');
      return Response.json(chatResponse(model, '模擬返答'));
    }, pin.lunaModelId);
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await response.json(), expectedStatus === 200 ? {
      ...chatResponse(model, '模擬返答'), choices: [{ message: { role: 'assistant', content: '模擬返答' }, finish_reason: 'stop' }],
    } : { error: 'model_mismatch' });
  }
  const request = new Request('https://mock.invalid/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + settings.RESEARCH_PROXY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'dialogue_turn', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } },
    ] }] }),
  });
  let sent = false;
  const refused = await handleRequest(request, settings, async () => { sent = true; return Response.json({}); }, pin.lunaModelId);
  assert.equal(refused.status, 400);
  assert.equal(sent, false);
});

test('private Jev proxy checks raw identity, uses only the fixed endpoint and rejects image material', async () => {
  const questions = { action: { type: 'choice', instructions: '合成の設問', criteria: { accept: '合成候補' } } };
  const body = { model: 'typesafe/jev-1.14', state: '{"text":"合成の状態"}', questions };
  for (const model of [undefined, 'typesafe/jev-1.14-20261002', pin.jevModelId]) {
    const response = await participantChoices(settings, body, pin.jevModelId, async (url, init) => {
      assert.equal(String(url), 'https://openrouter.ai/api/alpha/decisions');
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return Response.json({ model, id: 'gen-synthetic', answers: answers(questions), usage: { cost: 0 }, raw: 'RAW_CANARY' });
    });
    if (model !== pin.jevModelId) assert.deepEqual(response, { status: 502, data: { error: 'model_mismatch' } });
    else {
      assert.equal(response.status, 200);
      assert.equal('raw' in response.data, false);
    }
  }
  let sent = false;
  const refused = await participantChoices(settings, { ...body, state: '{"text":"data:image/png;base64,c3ludGhldGlj"}' },
    pin.jevModelId, async () => { sent = true; return Response.json({}); });
  assert.equal(refused.status, 400);
  assert.equal(sent, false);
});

test('pinned capabilities have their own Service entrypoint and no public HTTP route', async () => {
  const { InternalParticipantProxy, default: publicProxy }: any =
    await import(new URL('../workers/research-ai-proxy/src/worker.ts', import.meta.url).href);
  const capability = new InternalParticipantProxy({}, settings);
  assert.deepEqual(await capability.participantPolicy(), pin);
  assert.deepEqual(await capability.participantChat({ purpose: 'visual_observation' }, pin.lunaModelId),
    { status: 409, data: { error: 'model_mismatch' } });
  assert.deepEqual(await capability.participantChoices({}, 'typesafe/jev-1.14-20261002'),
    { status: 409, data: { error: 'model_mismatch' } });
  const response = await publicProxy.fetch(new Request('https://mock.invalid/v1/participant-choices', {
    method: 'POST', headers: { Authorization: 'Bearer ' + settings.RESEARCH_PROXY_TOKEN },
  }), settings);
  assert.equal(response.status, 404);
});
