import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { after, before } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RunBudget, CALL_CAPS, ENGINEERING_LIMITS } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { DEFAULT_COST_CAP_USD } from '../dialogue-model/runtime/diagnostics/jev-shadow-eval/local-openrouter.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract.ts';
import { MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import { canonicalReceptionProtocolV2, receptionProtocolSha256 } from '../dialogue-model/runtime/v2/reception.ts';
import { validateParticipantJevConfig } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';

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
// Node requires duplex for a streamed body forwarded by the Worker.
const NativeRequest = Request;
before(() => {
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } as RequestInit : init);
    }
  };
});
after(() => { globalThis.Request = NativeRequest; });
const participantModule: any = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href);
const proxyModule: any = await import(new URL('../workers/research-ai-proxy/src/worker.ts', import.meta.url).href);

const pin = validateParticipantModelPin({
  schemaVersion: 'participant_model_pin_v1', terraModelId: 'gpt-6.1-terra-2026-11-01',
  lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261014',
});
const productionProfile = 'participant_production_usage_v1';
const previousLimits = { lunaCalls: 60, lunaTokens: 300_000, lunaPosts: 60, jevPosts: 60, jevUsd: 0.05 };
const proxyEnv = {
  PARTICIPANT_MODEL_PIN_JSON: JSON.stringify(pin), DIALOGUE_MODEL: 'gpt-6-luna', VISION_MODEL: 'gpt-6.1-terra',
  RESEARCH_PROXY_TOKEN: 'synthetic-participant-proxy-token-only',
  UPSTREAM_API_KEY: 'synthetic-upstream-key-only', RESEARCH_DECISIONS_ENABLED: 'true',
  OPENROUTER_DECISIONS_API_KEY: 'sk-or-synthetic-participant-choice-only',
};
const protocol = {
  schemaVersion: 'reception_protocol_v2', protocolId: '438808d8-70cb-4f72-aece-2a2a7f04b789', revision: 1,
  allowedOrders: [['bypass-enabled', 'repair-first']], seedPolicy: 'shared', referenceMemory: true,
  betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
};
const sha256 = receptionProtocolSha256(canonicalReceptionProtocolV2(protocol));
const id = 'a'.repeat(64);
const syntheticSpeech = '輪郭が曲がって見えます。';
const human = 'この輪郭について教えてください。';
const billing = { luna: 0.004, terra: 0.009, jev: 0.006 };
const tokens = { prompt_tokens: 14_000, completion_tokens: 100 };
type Role = keyof typeof billing;
type Choices = Record<string, { criteria: Record<string, string> }>;
type WireCall = { role: Role; phase: string; model: string; status?: number; cost?: number | null };
type Reply = (role: Role, phase: string, signal: AbortSignal | null) => Promise<Response | undefined>;

function memory() {
  let entries = new Map<string, any>();
  let queue: Promise<unknown> = Promise.resolve();
  const view = (values: Map<string, any>) => ({
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(updates: Record<string, unknown>) {
      for (const [key, value] of Object.entries(updates)) values.set(key, structuredClone(value));
    },
    async list({ prefix }: { prefix: string }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
    },
    async delete(key: string) { return values.delete(key); },
  });
  return {
    async get(key: string) { return view(entries).get(key); },
    async deleteAlarm() {},
    transaction<T>(fn: (tx: ReturnType<typeof view>) => Promise<T>) {
      const operation = queue.then(async () => {
        const staged = new Map(entries); // Values cross the transaction only through cloning get/put.
        const result = await fn(view(staged));
        entries = staged;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async copy() {
      await queue;
      const replacement = memory();
      await replacement.transaction(tx => tx.put(Object.fromEntries(entries)));
      return replacement;
    },
  };
}

function choices(questions: Choices, reobserve: boolean) {
  return Object.fromEntries(Object.entries(questions).map(([name, { criteria }]) => {
    const keys = Object.keys(criteria);
    const wanted = name === 'action' ? (reobserve ? 'request_observation' : 'accept')
      : name === 'target' && reobserve ? 'figure_0' : name.endsWith('_act') ? 'assert'
        : name.endsWith('_support') ? 'expressed' : 'none';
    const choice = keys.includes(wanted) ? wanted : keys[0];
    assert.ok(choice);
    return [name, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(key => [key, Number(choice === key)])) }];
  }));
}

function choicePhase(body: { state: string; questions: Choices }) {
  const names = Object.keys(body.questions);
  if (names.includes('action')) return 'action_target';
  if (names.includes('human_referent')) return 'human_referent';
  if (names.some(name => name.endsWith('_support'))) return 'ai_support';
  if (names.some(name => name.endsWith('_act'))) return Object.hasOwn(JSON.parse(body.state), 'aiSeq') ? 'ai_function' : 'local';
  return 'detail';
}

function harness(t: TestContext) {
  let storage = memory();
  const calls: WireCall[] = [];
  const background: Promise<unknown>[] = [];
  let ownSlots: string[] = [];
  const controlled = {
    reply: undefined as Reply | undefined,
    missingCost: new Set<Role>(),
    classifyClaims: false,
    modelMismatch: false,
    reobserve: false,
    charge: false,
    lunaTokens: tokens.prompt_tokens,
    rateLimited: false,
  };
  // The actual private Service binding runs below. Replace every upstream fetch.
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    const endpoint = String(url);
    assert.ok(['https://openrouter.ai/api/alpha/decisions', 'https://api.openai.com/v1/chat/completions'].includes(endpoint));
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    const role: Role = endpoint.includes('openrouter') ? 'jev'
      : body.messages.some((message: { content: unknown }) => Array.isArray(message.content)) ? 'terra' : 'luna';
    const first = body.messages?.[0]?.content;
    const input = role === 'terra' ? JSON.parse(body.messages[1].content) : null;
    const phase = role === 'jev' ? choicePhase(body) : role === 'terra'
      ? input.figureIds ? 'observation_targeted' : 'observation_initial'
      : first === MEMO_LOCAL_EXTRACTION_INSTRUCTIONS ? 'local_extraction'
        : first === MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS ? 'ai_extraction'
          : String(body.messages.at(-1).content).includes('JSON') ? 'final_submission' : 'generation';
    const expected = role === 'luna' ? pin.lunaModelId : role === 'terra' ? pin.terraModelId : pin.jevModelId;
    const returnedModel = controlled.modelMismatch && role === 'jev' ? 'typesafe/jev-1.14-20261001' : expected;
    const call: WireCall = { role, phase, model: body.model };
    calls.push(call);
    const overridden = await controlled.reply?.(role, phase, init.signal ?? null);
    if (overridden) {
      call.status = overridden.status;
      return overridden;
    }
    const cost = controlled.missingCost.has(role) ? null : controlled.charge ? billing[role] : 0;
    const usage = { ...(controlled.charge ? { ...tokens, prompt_tokens: role === 'luna' ? controlled.lunaTokens : tokens.prompt_tokens } : { prompt_tokens: 5, completion_tokens: 3 }),
      ...(cost === null ? {} : { cost }) };
    call.status = 200;
    call.cost = cost;
    if (role === 'jev') {
      const decide = controlled.reobserve && Object.hasOwn(body.questions.action?.criteria ?? {}, 'request_observation');
      const selected = choices(body.questions, decide);
      if (decide && body.questions.action && body.questions.target) controlled.reobserve = false;
      return Response.json({ model: returnedModel, id: 'gen-usage-' + calls.length, answers: selected, usage,
        raw: 'PRIVATE_UPSTREAM_CANARY' });
    }
    let content = syntheticSpeech;
    if (role === 'terra') {
      if (input.figureIds) {
        controlled.reobserve = false;
        content = JSON.stringify({ figures: input.figureIds.map((figureId: string) => ({
          figureId, supports: ['輪郭が曲がる'], contradicts: [], unknown: [],
        })) });
      } else {
        ownSlots = input.ownAnchors.map((anchor: { id: string }) => anchor.id);
        content = JSON.stringify({ figures: ownSlots.map(figureId => ({ id: figureId, holistic: [],
          analytic: { shapes: ['曲線'], composition: '細い輪郭', relations: [] }, unknowns: [],
        })) });
      }
    } else if (phase === 'local_extraction' || phase === 'ai_extraction') {
      const quote = phase === 'local_extraction' ? human : syntheticSpeech;
      content = JSON.stringify(controlled.classifyClaims ? [{
        segmentId: 'synthetic-feature', quote, proposition: quote, aspect: 'part', targets: [ownSlots[0]],
        name: null, linkedIssueId: null, respondsToTurn: null,
      }] : []);
    } else if (phase === 'final_submission') {
      content = JSON.stringify(Object.fromEntries(ownSlots.map(slot => [slot, null])));
    }
    return Response.json({ model: returnedModel, choices: [{ message: { content }, finish_reason: 'stop' }], usage,
      raw: 'PRIVATE_UPSTREAM_CANARY' });
  });
  const proxy = new proxyModule.InternalParticipantProxy({}, proxyEnv);
  const rate = { async limit() { return { success: !controlled.rateLimited }; } };
  const env = {
    PARTICIPANT_TERRA_ENABLED: 'on', PARTICIPANT_TERRA_PROFILE: productionProfile as string | undefined,
    PARTICIPANT_TERRA_LIMITS_JSON: JSON.stringify(previousLimits),
    PARTICIPANT_AI_PROXY: proxy, V2_UTTERANCE_STYLE: 'concise',
    AI_PROXY: { async chat() { assert.fail('unexpected legacy upstream call'); } },
    NAMING_SESSIONS: { idFromName: (name: string) => name, get: () => session },
    START_RATE_LIMIT: rate, IP_ACTION_RATE_LIMIT: rate, SESSION_ACTION_RATE_LIMIT: rate,
    GLOBAL_ACTION_RATE_LIMIT: rate, QUESTIONNAIRE_RATE_LIMIT: rate,
  };
  function worker() {
    const instance = new participantModule.TangramSession({ storage, id: { toString: () => id },
      waitUntil(promise: Promise<unknown>) { background.push(promise); } }, env);
    instance.settings = async () => ({ mode: { value: 'on', revision: 1 }, protocol: { protocol, revision: 1, sha256 } });
    return instance;
  }
  let session = worker();
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Response> =>
    participantModule.default.fetch(new Request('https://example.invalid/api/' + path, {
      method, headers: { Cookie: 'tangram_session=' + id, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
  const reception = () => storage.get('reception:v1');
  return {
    calls, controlled, env, request, reception,
    async settleBackground() { await Promise.all(background.splice(0)); },
    async approvalUsage() { return session.adminFailedStartUsage((await reception()).receptionId); },
    async receive() {
      assert.equal(await session.registerBaseOwner(), true);
      await ok(await request('reception', undefined, 'POST'));
      const result = await session.adminApproveReception({
        expectedRevision: 0, order: 0, protocol: { protocolId: protocol.protocolId, revision: protocol.revision, sha256 },
        participantModelPin: null,
      });
      assert.equal(result.status, 'approved');
    },
    async removeHistoricalPlanLimits() {
      // The earliest pinned plan had a model pin and no reception-level budget.
      await storage.transaction(async tx => {
        const saved = await tx.get('reception:v1');
        assert.deepEqual(saved.plan.participantModelPin, pin);
        delete saved.plan.participantLimits;
        await tx.put({ 'reception:v1': saved });
      });
    },
    async start(predecessor?: string) {
      return ok(await request('start', { version: 2, expectedReceptionRevision: (await reception()).revision,
        ...(predecessor ? { expectedRecordId: predecessor } : {}) }));
    },
    send(recordId: string, clientId: string) { return request('message', { expectedRecordId: recordId, clientId, text: human }); },
    async idle() { await session.trial?.whenIdle(); },
    record(recordId: string) { return storage.get('record:' + recordId); },
    adminRecord(recordId: string) { return session.adminRecord(recordId); },
    async evict({ detached = false } = {}) {
      if (detached) storage = await storage.copy();
      session = worker();
    },
    async finish(recordId: string, trial: { scene: { shapes: Array<{ id: string }> }; events: unknown[] }) {
      return ok(await request('names', { expectedRecordId: recordId, confirm: true, expectedEventCount: trial.events.length,
        names: Object.fromEntries(trial.scene.shapes.map(shape => [shape.id, '合成の名前'])) }));
    },
  };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}
type Harness = ReturnType<typeof harness>;
async function ok(response: Response) {
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
const publicAi = (record: { events: Array<{ speaker: string }> }) => record.events.filter(e => e.speaker === 'ai').length;
const recordPublicError = (record: any) => record.queueState.errorCode;
async function turn(h: Harness, recordId: string, clientId: string) {
  await ok(await h.send(recordId, clientId));
  await h.idle();
  return h.record(recordId);
}

test('both newly approved production conditions continue past all old Jev and Luna limits', { timeout: 300_000 }, async t => {
  // Three logical Luna calls per synthetic turn. Cross 60 in each condition.
  const turns = 22;
  const h = harness(t);
  h.controlled.charge = true;
  await h.receive();
  await h.settleBackground();
  const initialPlan = (await h.reception()).plan;
  assert.deepEqual(h.calls.slice(), [{ role: 'terra', phase: 'observation_initial', model: proxyEnv.VISION_MODEL,
    status: 200, cost: billing.terra }]);
  const approvalUsage = await h.approvalUsage();
  assert.deepEqual(approvalUsage.failedStarts, []);
  assert.equal(approvalUsage.preobservations.length, 1);
  const [warm] = approvalUsage.preobservations;
  assert.deepEqual(warm.trialIndices, [0, 1]);
  assert.equal(warm.status, 'ready');
  assert.deepEqual(warm.usage.returnedModels.terra.initial_observation, { model: pin.terraModelId, ok: 1 });
  const warmMeter = warm.usage.phases.terra.initial_observation;
  assert.deepEqual([warmMeter.calls, warmMeter.posts, warmMeter.inputTokens, warmMeter.outputTokens,
    warmMeter.knownUsd, warmMeter.missingCostPosts, warmMeter.unknownPosts],
    [1, 1, tokens.prompt_tokens, tokens.completion_tokens, billing.terra, 0, 0]);
  assert.equal(total(warm.usage, 'terra', 'posts'), 1);
  assert.equal(total(warm.usage, 'jev', 'posts'), 0);
  assert.equal(total(warm.usage, 'luna', 'posts'), 0);
  let previous: string | undefined;
  const archived = new Map<string, ProductionUsage>();
  for (const strategy of ['bypass-enabled', 'repair-first']) {
    const beginning = h.calls.length;
    const state = await h.start(previous);
    assert.equal(h.calls.slice(beginning).length, 0, 'start reads the validated memo without sending');
    const recordId = state.trial.sessionId;
    let record = await h.record(recordId);
    assert.equal(record.strategy, strategy);
    const baselineAi = publicAi(record);
    for (let index = 0; index < turns; index++) {
      h.controlled.reobserve = index === 0;
      h.controlled.classifyClaims = index < 12;
      record = await turn(h, recordId, strategy + '-' + index);
      assert.equal(recordPublicError(record), null, strategy + ' turn ' + (index + 1) + ' stopped: ' + JSON.stringify({
        haltReason: record.jevLedger.haltReason, trace: record.jevTraces.at(-1)?.errorCode,
      }));
      assert.equal(publicAi(record), baselineAi + index + 1);
      if (h.controlled.classifyClaims) assert.equal(record.jevTraces.at(-1)?.aiPublic.stages.ai_support.status, 'ok');
    }
    assert.equal(initialPlan.participantRuntimeProfile, productionProfile);
    assert.deepEqual(initialPlan.participantModelPin, pin);
    assert.equal(Object.hasOwn(initialPlan, 'participantLimits'), false);
    assert.equal(record.options.participantRuntimeProfile, productionProfile);
    const trialCalls = h.calls.slice(beginning);
    const num = (role: Role) => trialCalls.filter(call => call.role === role).length;
    assert.ok(num('luna') > previousLimits.lunaPosts);
    assert.ok(trialCalls.filter(call => call.role === 'luna' && call.status === 200).length > previousLimits.lunaCalls);
    for (const phase of ['local', 'ai_function', 'ai_support']) {
      assert.ok(trialCalls.filter(call => call.role === 'jev' && call.phase === phase).length > 9, phase);
    }
    assert.ok(num('jev') > previousLimits.jevPosts);
    assert.ok(num('luna') * (tokens.prompt_tokens + tokens.completion_tokens) > previousLimits.lunaTokens);
    assert.ok(num('jev') * billing.jev > previousLimits.jevUsd);
    assert.equal(trialCalls.filter(call => call.role === 'terra' && call.phase === 'observation_targeted').length, 1);
    assertProductionAccounting(record, trialCalls);
    h.env.PARTICIPANT_TERRA_ENABLED = 'off';
    h.env.PARTICIPANT_TERRA_PROFILE = undefined;
    h.env.PARTICIPANT_TERRA_LIMITS_JSON = 'invalid legacy configuration';
    const sendsBeforeRestore = h.calls.length;
    await h.evict();
    const restored = await ok(await h.request('state'));
    assert.equal(restored.trial.sessionId, recordId);
    assert.equal(h.calls.length, sendsBeforeRestore, 'settled restore makes no upstream calls');
    const savedAfter = await h.record(recordId);
    assert.deepEqual(savedAfter.options, record.options);
    assert.deepEqual(productionUsage(savedAfter), productionUsage(record));
    const next = await turn(h, recordId, strategy + '-restored');
    assert.equal(recordPublicError(next), null);
    assert.equal(publicAi(next), baselineAi + turns + 1);
    assertProductionAccounting(next, h.calls.slice(beginning));
    await h.finish(recordId, (await ok(await h.request('state'))).trial);
    const completed = await h.record(recordId);
    assert.equal(completed.status, 'completed');
    assertProductionAccounting(completed, h.calls.slice(beginning));
    archived.set(recordId, productionUsage(completed));
    assert.deepEqual((await h.reception()).plan, initialPlan);
    previous = recordId;
  }
  for (const [recordId, usage] of archived) {
    assert.deepEqual(productionUsage(await h.adminRecord(recordId)), usage);
  }
  assert.deepEqual(await h.approvalUsage(), approvalUsage);
});

type Meter = {
  calls: number;
  posts: number;
  knownUsd: number;
  missingCostPosts: number;
  unknownPosts: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
};
type ProductionUsage = {
  schemaVersion: string;
  pin: typeof pin;
  phases: Record<Role, Record<string, Meter>>;
  latest: Record<Role, { status: string; model: string | null; costUsd: number | null } | null>;
};
function productionUsage(record: { jevLedger: unknown } | null) {
  const usage = record?.jevLedger as ProductionUsage;
  assert.equal(usage?.schemaVersion, productionProfile);
  assert.deepEqual(usage.pin, pin);
  assert.equal(Object.hasOwn(usage, 'limits'), false);
  return usage;
}

const total = (usage: ProductionUsage, role: Role, field: keyof Meter) =>
  Object.values(usage.phases[role]).reduce((count, phase) => count + phase[field], 0);

function assertProductionAccounting(record: { jevLedger: unknown }, posts: WireCall[]) {
  const usage = productionUsage(record);
  const models = { luna: pin.lunaModelId, jev: pin.jevModelId, terra: pin.terraModelId };
  for (const role of ['luna', 'jev', 'terra'] as const) {
    const sends = posts.filter(post => post.role === role);
    assert.ok(sends.every(send => send.status === 200 && send.cost === billing[role]));
    assert.equal(total(usage, role, 'posts'), sends.length, role + ' POSTs must be accounted once');
    assert.equal(total(usage, role, 'inputTokens'), sends.length * tokens.prompt_tokens);
    assert.equal(total(usage, role, 'outputTokens'), sends.length * tokens.completion_tokens);
    assert.ok(Math.abs(total(usage, role, 'knownUsd') - sends.length * billing[role]) < 1e-9);
    assert.equal(total(usage, role, 'missingCostPosts'), 0);
    assert.equal(total(usage, role, 'unknownPosts'), 0);
    assert.equal(usage.latest[role]?.model, models[role]);
  }
  for (const [role, recorded, wire] of [
    ['jev', 'local', 'local'], ['jev', 'ai_function', 'ai_function'], ['jev', 'ai_support', 'ai_support'],
    ['luna', 'generation', 'generation'], ['luna', 'ai_extraction', 'ai_extraction'],
    ['terra', 'initial_observation', 'observation_initial'], ['terra', 'reobservation', 'observation_targeted'],
  ] as const) {
    assert.equal(usage.phases[role][recorded].posts, posts.filter(post => post.role === role && post.phase === wire).length,
      role + '/' + recorded);
  }
  assert.ok(total(usage, 'luna', 'calls') > previousLimits.lunaCalls);
  const initial = usage.phases.terra.initial_observation;
  assert.deepEqual([initial.calls, initial.posts, initial.cacheHits], [1, 0, 1]);
}

test('a normal response with missing cost is recorded independently from a 402 or 429 upstream failure', async t => {
  const h = harness(t);
  h.controlled.missingCost.add('terra');
  await h.receive();
  await h.settleBackground();
  const [warm] = (await h.approvalUsage()).preobservations;
  const warmMeter = warm.usage.phases.terra.initial_observation;
  assert.deepEqual([warmMeter.posts, warmMeter.missingCostPosts, warmMeter.inputTokens, warmMeter.unknownPosts], [1, 1, 5, 0]);
  const fromStart = h.calls.length;
  const recordId = (await h.start()).trial.sessionId;
  const initial = await h.record(recordId);
  h.controlled.missingCost.add('jev').add('luna');
  h.controlled.reobserve = true;
  const published = await turn(h, recordId, 'unreported-cost');
  assert.equal(recordPublicError(published), null);
  assert.equal(publicAi(published), publicAi(initial) + 1);
  const missing = productionUsage(published);
  for (const role of ['jev', 'luna', 'terra'] as const) {
    const count = h.calls.slice(fromStart).filter(call => call.role === role).length;
    assert.ok(count > 0);
    assert.equal(total(missing, role, 'missingCostPosts'), count);
    assert.equal(total(missing, role, 'inputTokens'), count * 5);
    assert.equal(total(missing, role, 'unknownPosts'), 0);
    assert.equal(missing.latest[role]?.status, 'ok');
    assert.equal(missing.latest[role]?.costUsd, null);
  }
  h.controlled.missingCost.clear();
  let visible = publicAi(published);
  let previousUsage = missing;
  for (const status of [402, 429]) {
    h.controlled.reply = async (role, phase) => role === 'jev' && phase === 'action_target' ? Response.json({ detail: 'PRIVATE_UPSTREAM_CANARY' }, { status }) : undefined;
    const before = h.calls.length;
    const failed = await turn(h, recordId, 'rejected-' + status);
    assert.notEqual(recordPublicError(failed), null);
    assert.equal(publicAi(failed), visible);
    assert.equal(h.calls.slice(before).filter(call => call.role === 'jev' && call.status === status).length, 1);
    const rejected = productionUsage(failed);
    assert.equal(rejected.latest.jev?.status, 'failed');
    assert.equal(total(rejected, 'jev', 'unknownPosts'), total(previousUsage, 'jev', 'unknownPosts') + 1);
    assert.equal(total(rejected, 'jev', 'missingCostPosts'), total(previousUsage, 'jev', 'missingCostPosts') + 1);
    assert.equal(total(rejected, 'jev', 'knownUsd'), total(previousUsage, 'jev', 'knownUsd'));
    h.controlled.reply = undefined;
    await ok(await h.request('retry', { expectedRecordId: recordId }));
    await h.idle();
    const retried = await h.record(recordId);
    assert.equal(recordPublicError(retried), null);
    assert.equal(publicAi(retried), ++visible);
    previousUsage = productionUsage(retried);
  }
});

for (const modelOnly of [false, true]) {
  test('historical ' + (modelOnly ? 'model-only' : 'model-and-limits') + ' admission retains the budget after eviction', async t => {
    const h = harness(t);
    h.env.PARTICIPANT_TERRA_PROFILE = undefined;
    await h.receive();
    assert.deepEqual((await h.reception()).plan.participantLimits, previousLimits);
    if (modelOnly) await h.removeHistoricalPlanLimits();
    const recordId = (await h.start()).trial.sessionId;
    assert.equal(recordPublicError(await turn(h, recordId, 'historical-known-cost')), null);
    const initial = await h.record(recordId);
    assert.deepEqual(initial.jevLedger.limits, previousLimits);
    h.env.PARTICIPANT_TERRA_LIMITS_JSON = 'invalid new environment';
    h.env.PARTICIPANT_TERRA_PROFILE = productionProfile;
    await h.evict();
    assert.equal((await ok(await h.request('state'))).trial.sessionId, recordId);
    h.controlled.charge = true;
    h.controlled.classifyClaims = !modelOnly;
    if (modelOnly) h.controlled.lunaTokens = previousLimits.lunaTokens + 1;
    let stopped = initial;
    for (let index = 0; index < 4 && !recordPublicError(stopped); index++) {
      stopped = await turn(h, recordId, 'historical-over-limit-' + index);
    }
    assert.notEqual(recordPublicError(stopped), null);
    assert.equal(stopped.jevLedger.haltReason, modelOnly ? 'luna_token_budget' : 'observed_jev_budget');
    assert.ok(publicAi(stopped) < publicAi(initial) + 4);
    assert.equal(Object.hasOwn(stopped.options, 'participantRuntimeProfile'), false);
    const alreadySent = h.calls.length;
    await h.evict();
    await ok(await h.request('state'));
    await h.request('retry', { expectedRecordId: recordId });
    assert.equal(h.calls.length, alreadySent);
    assert.deepEqual((await h.record(recordId)).jevLedger.limits, previousLimits);
  });
}

test('diagnostic and isolated budgets still stop at the approved limits', () => {
  assert.equal(DEFAULT_COST_CAP_USD, 0.05);
  assert.throws(() => createJevDecisionClient({ enabled: true, costCapUsd: 0.051 }), { code: 'invalid_options' });
  assert.equal(ENGINEERING_LIMITS.trialMs, 15 * 60 * 1000);
  assert.deepEqual([CALL_CAPS.observation_initial, CALL_CAPS.observation_targeted, CALL_CAPS.decision, CALL_CAPS.generation], [1, 1, 4, 2]);
  const isolatedConfig = {
    schemaVersion: 'participant_jev_config_v1', lunaRequest: { timeoutMs: null, maxCompletionTokens: null },
    timeouts: { observationMs: 20_000, localMs: 20_000, decisionMs: 20_000, lunaAttemptMs: 80_000,
      generationMs: 40_000, trialMs: 600_000 },
    cacheDirectory: '/private/tmp/synthetic-i184-cache', modelId: pin.lunaModelId, memoSha256: 'b'.repeat(64),
    seed: 421, limits: previousLimits, technicalTrial: { version: 'adaptive_repair_v3' },
  };
  assert.deepEqual(validateParticipantJevConfig(isolatedConfig).config.limits, previousLimits);
  const researchCap = { ...previousLimits, jevUsd: 1 };
  assert.deepEqual(validateParticipantJevConfig({ ...isolatedConfig, limits: researchCap }).config.limits, researchCap);
  assert.throws(() => validateParticipantJevConfig({ ...isolatedConfig, limits: { ...previousLimits, jevUsd: 1.001 } }),
    { code: 'invalid_config' });
  assert.throws(() => validateParticipantJevConfig({ ...isolatedConfig, participantRuntimeProfile: productionProfile }),
    { code: 'invalid_config' });
  const ledger = new RunBudget(previousLimits);
  ledger.observe(ledger.reserve('jev', 'decision', 1), { costUsd: previousLimits.jevUsd });
  assert.equal(ledger.haltReason, 'observed_jev_budget');
  assert.throws(() => ledger.reserve('jev', 'decision', 2), /budget_stop/u);
  const isolated = new RunBudget(researchCap);
  isolated.observe(isolated.reserve('jev', 'decision', 1), { costUsd: researchCap.jevUsd });
  assert.equal(isolated.haltReason, 'observed_jev_budget');
  assert.throws(() => isolated.reserve('jev', 'decision', 2), /budget_stop/u);
  const missing = new RunBudget(previousLimits);
  missing.observe(missing.reserve('jev', 'decision', 1), { costUsd: null });
  assert.equal(missing.stopReason(), 'jev_cost_unknown');
  assert.throws(() => missing.reserve('luna', 'generation', 1), /budget_stop/u);
});

test('duplicate submissions reuse the queued event and the public retry rate limit prevents a new send', { timeout: 6000 }, async t => {
  const h = harness(t);
  await h.receive();
  const recordId = (await h.start()).trial.sessionId;
  const entered = latch();
  const release = latch();
  h.controlled.reply = async role => {
    if (role === 'luna') {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const first = h.send(recordId, 'duplicate-client-id');
  let eventId: string;
  try {
    await entered.promise;
    const repeat = await ok(await h.send(recordId, 'duplicate-client-id'));
    eventId = (await ok(await first)).eventId;
    assert.equal(repeat.eventId, eventId);
    assert.equal(h.calls.filter(call => call.role === 'luna').length, 1);
  } finally {
    release.resolve();
    await h.idle();
  }
  const saved = await h.record(recordId);
  assert.equal(saved.events.filter((event: { speaker: string }) => event.speaker === 'human').length, 1);
  assert.equal(publicAi(saved), 2);
  await h.evict();
  const before = h.calls.length;
  assert.equal((await ok(await h.send(recordId, 'duplicate-client-id'))).eventId, eventId);
  h.controlled.rateLimited = true;
  const denied = await h.request('retry', { expectedRecordId: recordId });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal(h.calls.length, before);
});

test('a sent but unresolved POST does not automatically repeat on Worker reconstruction', { timeout: 6000 }, async t => {
  const h = harness(t);
  await h.receive();
  const recordId = (await h.start()).trial.sessionId;
  const original = await h.record(recordId);
  const entered = latch();
  const release = latch();
  let held = false;
  h.controlled.reply = async role => {
    if (role === 'luna' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  let originalIdle: Promise<void> | undefined;
  const countBefore = h.calls.length;
  try {
    await ok(await h.send(recordId, 'interrupted-client-id'));
    await entered.promise;
    originalIdle = h.idle();
    const interrupted = await h.record(recordId);
    assert.equal(interrupted.queueState.pendingHumanEventIds.length, 1);
    const sent = h.calls.length;
    assert.equal(sent, countBefore + 1);
    await h.evict({ detached: true });
    assert.equal((await ok(await h.request('state'))).trial.sessionId, recordId);
    await h.idle();
    const restored = await h.record(recordId);
    assert.equal(h.calls.length, sent);
    assert.equal(publicAi(restored), publicAi(original));
    assert.deepEqual(restored.queueState.pendingHumanEventIds, interrupted.queueState.pendingHumanEventIds);
    assert.notEqual(recordPublicError(restored), null, 'the pending turn is available for explicit retry');
    const interruptedUsage = productionUsage(restored);
    assert.equal(total(interruptedUsage, 'luna', 'unknownPosts'), 1);
    assert.equal(interruptedUsage.latest.luna?.status, 'reserved');
    await ok(await h.request('retry', { expectedRecordId: recordId }));
    await h.idle();
    const finished = await h.record(recordId);
    assert.equal(recordPublicError(finished), null);
    assert.equal(publicAi(finished), publicAi(original) + 1);
    assert.equal(h.calls.slice(sent).filter(call => call.phase === 'generation').length, 1);
    assert.equal(total(productionUsage(finished), 'luna', 'unknownPosts'), 1);
  } finally {
    release.resolve();
    await originalIdle;
  }
});

test('persistent retryable Luna failures keep the existing POST retry bound', { timeout: 6000 }, async t => {
  const h = harness(t);
  await h.receive();
  const recordId = (await h.start()).trial.sessionId;
  const before = h.calls.length;
  h.controlled.reply = async (role, phase) => role === 'luna' && phase === 'generation' ? Response.json({ detail: 'PRIVATE_UPSTREAM_CANARY' }, { status: 429 }) : undefined;
  const failed = await turn(h, recordId, 'persistent-upstream-rate-limit');
  assert.notEqual(recordPublicError(failed), null);
  assert.equal(publicAi(failed), 1);
  const attempts = h.calls.slice(before).filter(call => call.phase === 'generation');
  assert.deepEqual(attempts.map(call => [call.role, call.status]), [['luna', 429], ['luna', 429], ['luna', 429]]);
  assert.ok(failed.requests.some((entry: { retryCount: number; httpStatus: number }) => entry.retryCount === 2 && entry.httpStatus === 429));
});

test('a real per-request abort prevents publication and an automatic replay of the timed-out POST', { timeout: 6000 }, async t => {
  const h = harness(t);
  await h.receive();
  const recordId = (await h.start()).trial.sessionId;
  let aborted = false;
  h.controlled.reply = async (role, phase, signal) => {
    if (role !== 'luna' || phase !== 'generation') return undefined;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  };
  // Accelerate the existing upstream timeout only. The test still waits for
  // the abort emitted by the real proxy rather than returning a scripted 504.
  const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, delay?: number) => set(fn, delay === 85_000 ? 15 : delay));
  const before = h.calls.length;
  const failed = await turn(h, recordId, 'timed-out-post');
  assert.equal(aborted, true);
  assert.notEqual(recordPublicError(failed), null);
  assert.equal(publicAi(failed), 1);
  const attempts = h.calls.slice(before).filter(call => call.phase === 'generation');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].role, 'luna');
});

test('the approved model identity still gates publication and internal usage stays private across public routes', async t => {
  const h = harness(t);
  await h.receive();
  const started = await h.start();
  const recordId = started.trial.sessionId;
  h.controlled.charge = true;
  const withUsage = await turn(h, recordId, 'known-synthetic-usage');
  assert.equal(recordPublicError(withUsage), null);
  assert.equal(publicAi(withUsage), 2);
  const before = h.calls.length;
  h.controlled.modelMismatch = true;
  const failed = await turn(h, recordId, 'wrong-jev-build');
  assert.notEqual(recordPublicError(failed), null);
  assert.equal(publicAi(failed), publicAi(withUsage));
  assert.equal(h.calls.slice(before).filter(call => call.role === 'jev').length, 1);
  const assertPrivate = (value: unknown) => assert.doesNotMatch(JSON.stringify(value),
    /jevLedger|participant(?:Limits|ModelPin|TerraApproval|ProductionProfile|RuntimeProfile|Usage)|observedJevUsd|costUsd|knownUsd|missingCost|unknownPosts|prompt_tokens|completion_tokens|model_mismatch|PRIVATE_UPSTREAM_CANARY|typesafe\/jev|gpt-6\./iu);
  assertPrivate(started);
  assertPrivate(await ok(await h.request('state')));
  assertPrivate(await ok(await h.request('records')));
  const shielded = await h.request('records/' + recordId + '/review');
  assert.ok([200, 409].includes(shielded.status));
  assertPrivate(await shielded.json());
  const proxyPath = await proxyModule.default.fetch(new Request('https://proxy.invalid/v1/participant-choices', {
    method: 'POST', headers: { Authorization: 'Bearer ' + proxyEnv.RESEARCH_PROXY_TOKEN },
  }), proxyEnv);
  assert.equal(proxyPath.status, 404);
  assertPrivate(await proxyPath.json());
  const ordinaryChat = await proxyModule.default.fetch(new Request('https://proxy.invalid/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + proxyEnv.RESEARCH_PROXY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'dialogue_turn', messages: [{ role: 'user', content: human }],
      usageOnly: true, participantRuntimeProfile: productionProfile }),
  }), proxyEnv);
  assert.equal(ordinaryChat.status, 200);
  const ordinaryReply = await ordinaryChat.json();
  assert.equal(Object.hasOwn(ordinaryReply.usage, 'cost'), false);
  assert.doesNotMatch(JSON.stringify(ordinaryReply), /PRIVATE_UPSTREAM_CANARY|knownUsd|participantRuntimeProfile/u);
});
