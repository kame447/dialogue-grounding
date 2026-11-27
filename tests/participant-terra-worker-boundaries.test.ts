import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../workers/research-ai-proxy/src/index.mjs';
import {
  requireExactParticipantModel, resolveWorkerParticipantModelPin, validateParticipantModelPin,
} from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import {
  createWorkerTerraObserver,
} from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import type { WorkerTerraCache } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import type { ReobservationInput } from '../dialogue-model/runtime/observation/contract.ts';
import type { ObservationMessage } from '../dialogue-model/runtime/observation/observe.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V1, INITIAL_OBSERVATION_STRUCTURED_V2, INITIAL_OBSERVATION_V2_INSTRUCTIONS,
  type InitialObservationGeneration } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';

const configured = {
  schemaVersion: 'participant_model_pin_v1' as const,
  terraModelId: 'gpt-6.1-terra-2026-11-01',
  lunaModelId: 'gpt-6-luna-2026-10-01',
  jevModelId: 'typesafe/jev-1.14-20261001',
};
const pin = validateParticipantModelPin(configured);
const other = validateParticipantModelPin({ ...configured, terraModelId: 'gpt-6.1-terra-2026-11-02' });
const own = {
  ownImage: { mimeType: 'image/png' as const, base64: Buffer.from('synthetic AI board').toString('base64') },
  ownAnchors: Array.from({ length: 6 }, (_, i) => ({
    id: 's-000' + i, bbox: { x: i * 20, y: 0, w: 10, h: 10 }, centroid: { x: i * 20 + 5, y: 5 },
  })),
};
const privateData = { partnerImage: 'PARTNER_BOARD_CANARY', key: 'ANSWER_KEY_CANARY', future: 'FUTURE_TURN_CANARY' };
const initial = { figures: own.ownAnchors.map(({ id }) => ({
  id, holistic: [], analytic: { shapes: ['三角'], composition: '辺でつながる', relations: [] }, unknowns: [],
})) };
const selected = own.ownAnchors[2].id;
const targeted = { figures: [{ figureId: selected, supports: ['小さい三角'], contradicts: [], unknown: [] }] };
const now = () => new Date('2026-01-01T00:00:00.000Z');
type Payload = { purpose: 'visual_observation'; messages: ObservationMessage[] };
function response({ model = pin.terraModelId, value = initial as unknown } = {}) {
  return { status: 200, data: { model, choices: [{ message: { content: JSON.stringify(value) } }] } };
}
function memory() {
  const entries = new Map<string, unknown>();
  const cache: WorkerTerraCache = {
    async read(key) { return structuredClone(entries.get(key)); },
    async putIfAbsent(key, entry) {
      if (!entries.has(key)) entries.set(key, structuredClone(entry));
      return structuredClone(entries.get(key));
    },
  };
  return { cache, entries };
}

test('approval detaches the model pin and both trials keep the same exact identities', () => {
  const source = { ...configured };
  const approvedPin = validateParticipantModelPin(source);
  source.terraModelId = other.terraModelId;
  assert.deepEqual(approvedPin, pin);
  const trial1 = resolveWorkerParticipantModelPin({ approvedPin, configuredPin: pin });
  const trial2 = resolveWorkerParticipantModelPin({ approvedPin, configuredPin: pin });
  assert.deepEqual(trial1, trial2);
  for (const config of [other, { ...pin, lunaModelId: 'gpt-6-luna' }, { ...pin, jevModelId: 'typesafe/jev-1.14' }]) {
    assert.throws(() => resolveWorkerParticipantModelPin({ approvedPin, configuredPin: config }), { code: 'model_mismatch' });
  }
  assert.throws(() => resolveWorkerParticipantModelPin({ approvedPin }), { code: 'invalid_model_pin' });
});

test('legacy and pinned restores cannot switch runtimes or adopt current defaults', () => {
  assert.equal(resolveWorkerParticipantModelPin({ configuredPin: pin }), null);
  assert.equal(resolveWorkerParticipantModelPin({ configuredPin: pin, restoredOptions: { referenceMemory: true } }), null);
  const restoredOptions = { jevResearch: true, participantModelPin: pin };
  assert.deepEqual(resolveWorkerParticipantModelPin({ approvedPin: pin, configuredPin: pin, restoredOptions }), pin);
  assert.throws(() => resolveWorkerParticipantModelPin({ configuredPin: pin, restoredOptions }), { code: 'invalid_model_pin' });
  for (const old of [{ referenceMemory: true }, { jevResearch: false, participantModelPin: pin }, { jevResearch: true }]) {
    assert.throws(() => resolveWorkerParticipantModelPin({ approvedPin: pin, configuredPin: pin, restoredOptions: old }), { code: 'invalid_model_pin' });
  }
  assert.throws(() => resolveWorkerParticipantModelPin({
    approvedPin: pin, configuredPin: pin, restoredOptions: { jevResearch: true, participantModelPin: other },
  }), { code: 'model_mismatch' });
});

test('model checks are exact and fail with closed codes for missing or unrelated IDs', () => {
  for (const id of [undefined, null, other.terraModelId, 'gpt-6.1-terra', pin.lunaModelId]) {
    assert.throws(() => requireExactParticipantModel(pin.terraModelId, id), { code: 'model_mismatch', message: 'model_mismatch' });
  }
  assert.doesNotThrow(() => requireExactParticipantModel(pin.terraModelId, pin.terraModelId));
  assert.throws(() => validateParticipantModelPin({ ...pin, terraModelId: pin.lunaModelId }), { code: 'invalid_model_pin' });
  assert.throws(() => validateParticipantModelPin({ ...pin, strategy: 'repair-first' }), { code: 'invalid_model_pin' });
});

test('both phases use the Terra purpose and only the bound AI projection and targeted context', async () => {
  const calls: Payload[] = [];
  const observer = createWorkerTerraObserver({ modelPin: pin, own: { ...own, ...privateData }, now,
    async visual(request, signal) {
      assert.equal(signal.aborted, false);
      calls.push(structuredClone(request));
      return response({ value: calls.length === 1 ? initial : targeted });
    } });
  const memo = await observer.observeAll({ ...own, ...privateData });
  const request: ReobservationInput & typeof privateData = { ...own, ...privateData, memo,
    figureIds: [selected], issue: { aspect: 'part', question: '小さい三角はありますか？', partnerConstrual: null } };
  assert.deepEqual((await observer.reobserve(request)).figures, targeted.figures);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call), ['purpose', 'messages']);
    assert.equal(call.purpose, 'visual_observation');
    const body = JSON.stringify(call);
    assert.ok(body.includes('data:image/png;base64,' + own.ownImage.base64));
    for (const canary of Object.values(privateData)) assert.ok(!body.includes(canary));
    assert.ok(!body.includes(pin.terraModelId));
  }
  assert.ok(JSON.stringify(calls[0]).includes(own.ownAnchors[0].id));
  assert.ok(!JSON.stringify(calls[1]).includes(own.ownAnchors[0].id));
  await assert.rejects(observer.observeAll({ ...own, ownImage: { ...own.ownImage, base64: 'dGVzdA==' } }), { code: 'invalid_input' });
  await assert.rejects(observer.reobserve({ ...request, figureIds: ['s-abcd'] }), { code: 'invalid_input' });
  assert.equal(calls.length, 2);
});

test('Terra text parts accepted by the proxy are read for initial and targeted observation', async () => {
  const env = {
    RESEARCH_PROXY_TOKEN: 'synthetic-only-proxy-token-for-tests-184',
    UPSTREAM_API_KEY: 'synthetic-only-upstream-key',
    DIALOGUE_MODEL: pin.lunaModelId,
    VISION_MODEL: pin.terraModelId,
  };
  const observer = createWorkerTerraObserver({ own, modelPin: pin, now, async visual(payload) {
    const request = new Request('https://mock.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN },
      body: JSON.stringify(payload),
    });
    const isTargeted = Object.hasOwn(JSON.parse(String(payload.messages[1].content)), 'figureIds');
    const json = JSON.stringify(isTargeted ? targeted : initial);
    const reply = await handleRequest(request, env, async () => Response.json({
      model: pin.terraModelId, choices: [{ message: { content: [
        { type: 'text', text: json.slice(0, 13) },
        { type: 'refusal', refusal: 'ignored non-text part' },
        { type: 'text', text: json.slice(13) },
      ] } }],
    }), pin.terraModelId);
    assert.equal(reply.status, 200);
    return { status: reply.status, data: await reply.json() };
  } });
  const memo = await observer.observeAll(own);
  assert.deepEqual(memo.figures.map(({ id }) => id), own.ownAnchors.map(({ id }) => id));
  const result = await observer.reobserve({ ...own, memo, figureIds: [selected],
    issue: { aspect: 'part', question: '小さい三角はありますか？', partnerConstrual: null } });
  assert.deepEqual(result.figures, targeted.figures);
});

test('missing actual Terra ID and mismatched build never become initial or targeted evidence', async () => {
  let call = 0;
  const observer = createWorkerTerraObserver({ own, modelPin: pin, now,
    async visual() {
      call += 1;
      if (call === 1) return { status: 200, data: { choices: response().data.choices } };
      if (call === 2) return response();
      return response({ model: other.terraModelId, value: targeted });
    } });
  await assert.rejects(observer.observeAll(own), { code: 'invalid_response' });
  const memo = await observer.observeAll(own);
  await assert.rejects(observer.reobserve({ ...own, memo, figureIds: [selected],
    issue: { aspect: 'part', question: '確認', partnerConstrual: null } }), { code: 'invalid_response' });
});

test('initial memo is shared for the same exact model and board and isolated by model and board', async () => {
  const { entries, cache } = memory();
  let requests = 0;
  const observer = (modelPin = pin, board = own) => createWorkerTerraObserver({ own: board, modelPin, cache, now,
    async visual() { requests += 1; return response({ model: modelPin.terraModelId }); } });
  const memo = await observer().observeAll(own);
  assert.deepEqual(await observer().observeAll({ ...own, ownAnchors: [...own.ownAnchors].reverse() }), memo);
  assert.equal(requests, 1);
  await observer(other).observeAll(own);
  const different = { ...own, ownImage: { ...own.ownImage, base64: 'dGVzdA==' } };
  await observer(pin, different).observeAll(different);
  assert.equal(entries.size, 3);
  assert.equal(requests, 3);
  assert.ok(!JSON.stringify([...entries]).includes(own.ownImage.base64));
});

test('the structured initial request uses the fixed proxy schema and a separate cache key', async () => {
  const { cache, entries } = memory();
  const generation = INITIAL_OBSERVATION_STRUCTURED_V1;
  const env = {
    RESEARCH_PROXY_TOKEN: 'synthetic-only-proxy-token-for-tests-184',
    UPSTREAM_API_KEY: 'synthetic-only-upstream-key',
    DIALOGUE_MODEL: pin.lunaModelId,
    VISION_MODEL: pin.terraModelId,
  };
  const calls: Array<{ initial: boolean; payload: any }> = [];
  let upstreamChoice = { message: { content: JSON.stringify(initial) }, finish_reason: 'stop' };
  const observer = (initialObservationGeneration?: InitialObservationGeneration, sharedCache?: WorkerTerraCache) =>
    createWorkerTerraObserver({ own, modelPin: pin, now, initialObservationGeneration, cache: sharedCache,
      async visual(payload) {
        const request = new Request('https://mock.invalid/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN },
          body: JSON.stringify({ ...payload, response_format: { type: 'json_object' }, schema: 'synthetic-client-schema' }),
        });
        const isInitial = !Object.hasOwn(JSON.parse(String(payload.messages[1].content)), 'figureIds');
        const reply = await handleRequest(request, env, async (_url, init) => {
          calls.push({ initial: isInitial, payload: JSON.parse(String(init?.body)) });
          const choice = isInitial ? upstreamChoice : { ...upstreamChoice, message: { content: JSON.stringify(targeted) } };
          return Response.json({ model: pin.terraModelId, choices: [choice], usage: { prompt_tokens: 5, completion_tokens: 3 } });
        }, pin.terraModelId);
        return { status: reply.status, data: await reply.json() };
      } });

  const legacy = await observer(undefined, cache).observeAll(own);
  const [legacyKey] = entries.keys();
  // This board's key, captured from b30521f.
  assert.equal(legacyKey, 'terra_initial_observation_v1:cf46abec22b6ec66bc9c5e54cc4e84504fcf63dc9b13f2e625939e2dd5a36a83');
  const legacyEntry = structuredClone(entries.get(legacyKey));
  const structured = observer(generation, cache);
  const memo = await structured.observeAll(own);
  assert.deepEqual(memo, legacy);
  assert.equal(entries.size, 2);
  assert.deepEqual(entries.get(legacyKey), legacyEntry);
  assert.deepEqual(await observer(undefined, cache).observeAll(own), legacy);
  assert.deepEqual(await structured.observeAll(own), memo);
  assert.equal(calls.length, 2, 'each generation reads only its own previously written memo');
  assert.deepEqual((await structured.reobserve({ ...own, memo, figureIds: [selected],
    issue: { aspect: 'part', question: '確認', partnerConstrual: null } })).figures, targeted.figures);

  const [old, next, reobserve] = calls;
  assert.deepEqual(calls.map(call => call.initial), [true, true, false]);
  const { response_format: format, ...sent } = next.payload;
  assert.deepEqual(sent, old.payload, 'the generation selector and incoming schema never leave the proxy');
  assert.equal(Object.hasOwn(reobserve.payload, 'response_format'), false);
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.strict, true);
  const schema = format.json_schema.schema;
  const figures = schema.properties.figures;
  assert.deepEqual([figures.minItems, figures.maxItems], [6, 6]);
  for (const [object, keys] of [
    [schema, ['figures']],
    [figures.items, ['id', 'holistic', 'analytic', 'unknowns']],
    [figures.items.properties.holistic.items, ['construal', 'basis', 'status']],
    [figures.items.properties.analytic, ['shapes', 'composition', 'relations']],
  ]) {
    assert.deepEqual(object.required, keys);
    assert.equal(object.additionalProperties, false);
  }
  for (const body of [
    { purpose: 'visual_observation', messages: reobserve.payload.messages },
    { purpose: 'dialogue_turn', messages: old.payload.messages },
  ]) {
    const reply = await handleRequest(new Request('https://mock.invalid/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN },
      body: JSON.stringify({ ...body, initial_observation_generation: generation }),
    }), env, async () => assert.fail('structured generation must only reach upstream for initial observation'));
    assert.equal(reply.status, 400);
    assert.deepEqual(await reply.json(), { error: 'invalid_request' });
  }

  const validText = JSON.stringify(initial);
  const duplicate = { figures: [initial.figures[1], ...initial.figures.slice(1)] };
  const extra = { ...initial, extra: 'synthetic' };
  for (const choice of [
    { message: { content: validText, refusal: 'synthetic refusal' }, finish_reason: 'stop' },
    { message: { content: validText }, finish_reason: 'length' },
    { message: { content: validText }, finish_reason: 'content_filter' },
    { message: { content: JSON.stringify(duplicate) }, finish_reason: 'stop' },
    { message: { content: JSON.stringify(extra) }, finish_reason: 'stop' },
  ]) {
    upstreamChoice = choice;
    const empty = memory();
    await assert.rejects(observer(generation, empty.cache).observeAll(own), { code: 'invalid_response' });
    assert.equal(empty.entries.size, 0);
  }
  const oldProxy = createWorkerTerraObserver({ own, modelPin: pin, now, initialObservationGeneration: generation,
    async visual() {
      return { status: 200, data: { model: pin.terraModelId, choices: [{ message: { content: validText }, finish_reason: 'stop' }] } };
    } });
  await assert.rejects(oldProxy.observeAll(own), { code: 'invalid_response' });

  upstreamChoice = { message: { content: validText }, finish_reason: 'stop' };
  const beforeV2 = calls.length;
  const v2 = observer(INITIAL_OBSERVATION_STRUCTURED_V2, cache);
  assert.deepEqual(await v2.observeAll(own), legacy);
  assert.deepEqual(await v2.observeAll(own), legacy);
  assert.equal(entries.size, 3);
  assert.equal(calls.length, beforeV2 + 1, 'v2 misses the legacy and v1 cache entries, then hits its own');
  const v2Body = calls.at(-1)!.payload;
  assert.equal(v2Body.messages[0].content, INITIAL_OBSERVATION_V2_INSTRUCTIONS);
  assert.notEqual(v2Body.messages[0].content, next.payload.messages[0].content);
  assert.deepEqual(v2Body.messages.slice(1), next.payload.messages.slice(1));
  assert.deepEqual(v2Body.response_format, format);
  for (const messages of [next.payload.messages, reobserve.payload.messages]) {
    const reply = await handleRequest(new Request('https://mock.invalid/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN },
      body: JSON.stringify({ purpose: 'visual_observation', messages, initial_observation_generation: INITIAL_OBSERVATION_STRUCTURED_V2 }),
    }), env, async () => assert.fail('v2 must pass through its fixed initial instruction'));
    assert.equal(reply.status, 400);
  }
});

test('cache corruption rejects without a model call and the first stored memo wins', async () => {
  const { entries, cache } = memory();
  const launch = (composition: string) => createWorkerTerraObserver({ own, modelPin: pin, cache, now,
    async visual() {
      const value = structuredClone(initial);
      value.figures[0].analytic.composition = composition;
      return response({ value });
    } }).observeAll(own);
  const [first, second] = await Promise.all([launch('小さな三角'), launch('正方形')]);
  assert.deepEqual(first, second);
  assert.equal(entries.size, 1);
  const [key] = entries.keys();
  entries.set(key, { ...(entries.get(key) as object), memoSha256: '0'.repeat(64) });
  const checked = createWorkerTerraObserver({ own, modelPin: pin, cache, now,
    async visual() { assert.fail('a corrupt cache must not contact the model'); } });
  await assert.rejects(checked.observeAll(own), { code: 'invalid_response' });
});

test('the Worker observation port inherits the proxy redirect rejection in both phases', async () => {
  const env = {
    RESEARCH_PROXY_TOKEN: 'synthetic-only-proxy-token-for-tests-184',
    UPSTREAM_API_KEY: 'synthetic-only-upstream-key',
    UPSTREAM_PROVIDER: 'openai',
    DIALOGUE_MODEL: pin.lunaModelId,
    VISION_MODEL: pin.terraModelId,
  };
  let sends = 0;
  const observer = createWorkerTerraObserver({ own, modelPin: pin, now, async visual(payload) {
    const request = new Request('https://mock.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN },
      body: JSON.stringify(payload),
    });
    const reply = await handleRequest(request, env, async (url, init) => {
      sends += 1;
      assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
      assert.equal(init?.redirect, 'manual');
      assert.equal(JSON.parse(String(init?.body)).model, pin.terraModelId);
      if (sends === 2) return Response.json(response().data);
      return new Response(null, { status: 307, headers: { Location: 'https://untrusted.invalid/' } });
    });
    assert.equal(reply.headers.get('location'), null);
    assert.equal(reply.status, sends === 2 ? 200 : 502);
    return { status: reply.status, data: await reply.json() };
  } });
  await assert.rejects(observer.observeAll(own), { code: 'unavailable', message: 'unavailable' });
  const memo = await observer.observeAll(own);
  await assert.rejects(observer.reobserve({ ...own, memo, figureIds: [selected],
    issue: { aspect: 'part', question: '三角はありますか？', partnerConstrual: null } }),
  { code: 'unavailable', message: 'unavailable' });
  assert.equal(sends, 3);
});
