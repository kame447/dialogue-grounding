import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, memoExtractionPrompt } from '../dialogue-model/runtime/local-grounding/extract.ts';
import { MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS, memoAiExtractionPrompt } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import { canonicalReceptionProtocolV2, canonicalReceptionProtocolV3, PILOT012_PARTICIPANT_PROFILE, PILOT012_V18_PARTICIPANT_PROFILE,
  PILOT012_V19_PARTICIPANT_PROFILE, receptionProtocolSha256, receptionSummary, validateReceptionPlan } from '../dialogue-model/runtime/v2/reception.ts';
import { VISUAL_FEATURE_GENERATION } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { VISUAL_FEATURE_DRAFT_V19 } from '../dialogue-model/runtime/v2/visual-feature-evidence.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { FIGURE_SETS, PILOT_FIGURE_SET_ID } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { CLAIM_PRUNE_V2, CLAIM_PRUNE_V3, REFERENCE_LIMITS } from '../dialogue-model/runtime/memory/reference-graph.mjs';
import { validateBoundBaseRecord } from '../dialogue-model/runtime/v2/base-assignment-data.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { handleRequest } from '../workers/research-ai-proxy/src/index.mjs';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';
import { configuredParticipantPin, participantChoices, participantUsageChoices } from '../workers/research-ai-proxy/src/participant-transport.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V1, INITIAL_OBSERVATION_STRUCTURED_V2,
  type InitialObservationGeneration } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { buildObservationMessages } from '../dialogue-model/runtime/observation/observe.ts';
import { SHAPE_TERMINOLOGY, SHAPE_TERMINOLOGY_GENERATION } from '../dialogue-model/runtime/shape-terminology.ts';

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
const { TangramSession, default: participantWorker }: any = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href);

// Node needs a duplex flag for the body stream forwarded by the Worker.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } as RequestInit : init);
  }
};

const { InternalParticipantProxy }: any = await import(new URL('../workers/research-ai-proxy/src/worker.ts', import.meta.url).href);
const adminToken = 'synthetic-admin-token-for-offline-test-only';
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
const figureBankProtocol = { ...protocol, schemaVersion: 'reception_protocol_v3',
  figureSelection: { mode: 'preset', setId: 'bank-set-b' }, figureSetPolicy: 'shared' };
const approvedLimits = { lunaCalls: 60, lunaTokens: 300_000, lunaPosts: 60, jevPosts: 60, jevUsd: 0.05 };
const chatResponse = (model: unknown, content: string) => ({
  model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 },
});
type Choices = Record<string, { criteria: Record<string, string> }>;
function answers(questions: Choices, observe = false, selectedAction?: string,
  choose?: (name: string) => string | undefined, secondAction?: string) {
  return Object.fromEntries(Object.entries(questions).map(([name, { criteria }]) => {
    const keys = Object.keys(criteria);
    const selection = observe && name === 'action' ? 'request_observation'
      : name === 'action' && selectedAction ? selectedAction
        : observe && (name === 'target' || name === 'observation_target') ? 'figure_0' : undefined;
    const scripted = choose?.(name);
    if (scripted !== undefined) assert.ok(keys.includes(scripted), 'scripted choice must be offered: ' + name);
    const choice = scripted ?? (selection && keys.includes(selection) ? selection
      : name === 'action' && keys.includes('accept') ? 'accept' : keys.includes('none') ? 'none' : keys[0]);
    return [name, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(key =>
      [key, choice === key ? 1 : name === 'action' && key === secondAction ? 0.9 : 0])) }];
  }));
}

function memory() {
  let items = new Map<string, any>();
  let pending: Promise<unknown> = Promise.resolve();
  const view = (m: Map<string, any>) => ({
    async get(key: string) { return structuredClone(m.get(key)); },
    async put(entries: Record<string, unknown> | string, value?: unknown) {
      for (const [key, item] of Object.entries(typeof entries === 'string' ? { [entries]: value } : entries)) {
        m.set(key, structuredClone(item));
      }
    },
    async list({ prefix }: { prefix: string }) {
      return new Map([...m].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
    },
    async delete(key: string) { return m.delete(key); },
  });
  return {
    async get(key: string) { return view(items).get(key); },
    async put(entries: Record<string, unknown>) { await view(items).put(entries); },
    async list(prefix: string) { return view(items).list({ prefix }); },
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(enabled = true, selectedProtocol: typeof protocol & {
  figureSelection?: { mode: string; setId?: string; selectionSeed?: number }; figureSetPolicy?: string;
} = protocol, preobserve = false) {
  const canonical = selectedProtocol.schemaVersion === 'reception_protocol_v3'
    ? canonicalReceptionProtocolV3(selectedProtocol) : canonicalReceptionProtocolV2(selectedProtocol);
  const sha256 = receptionProtocolSha256(canonical);
  const displayed = { protocolId: selectedProtocol.protocolId, revision: selectedProtocol.revision, sha256 };
  const storage = memory(), calls: Array<{ kind: string; expected: string; body: any }> = [];
  const background: Promise<unknown>[] = [];
  const controlled: { policy: unknown; terra: unknown; luna: unknown; jev: unknown; legacyCalls: number; observe: boolean; mixedUsage: boolean; invalidTerra?: boolean; rejectJev?: boolean; selectedAction?: string; observationName?: string;
    usageChat?: (body: any, expected: string) => Promise<any>; holdChoice?: () => Promise<void>;
    onStartObservationRead?: () => void;
    choose?: (name: string, body: { state: string; questions: Choices }) => string | undefined;
    wrongChoiceModel?: (questions: Choices) => boolean; secondAction?: string } =
    { policy: { ...pin }, terra: pin.terraModelId, luna: pin.lunaModelId, jev: pin.jevModelId, legacyCalls: 0, observe: false, mixedUsage: false };
  let slots: string[] = [];
  const env = {
    PARTICIPANT_TERRA_ENABLED: enabled ? 'on' : 'off',
    PARTICIPANT_TERRA_PROFILE: PARTICIPANT_PRODUCTION_PROFILE as string | undefined,
    PARTICIPANT_TERRA_GENERATION_ENABLED: undefined as string | undefined,
    PARTICIPANT_TERRA_ALL_ROLES_ENABLED: undefined as string | undefined,
    PARTICIPANT_DIALOGUE_PROFILE: undefined as string | undefined,
    PARTICIPANT_TERRA_LIMITS_JSON: JSON.stringify(approvedLimits),
    PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION: undefined as string | undefined,
    V2_UTTERANCE_STYLE: 'concise',
    AI_PROXY: { async chat() { controlled.legacyCalls++; throw new Error('synthetic legacy call'); } },
    PARTICIPANT_AI_PROXY: {
      async participantPolicy() { return controlled.policy; },
      async participantChat(body: any, expected: string) {
        calls.push({ kind: body.purpose, expected, body });
        const mock = (id: unknown, text: string) => {
          const data = chatResponse(id, text);
          return { status: 200, data: controlled.mixedUsage ? { ...data, usage: {
            prompt_tokens: 310_000, completion_tokens: 3, cost: body.purpose === 'dialogue_turn' ? 0.2 : null,
          } } : data };
        };
        if (body.purpose === 'visual_observation') {
          const args = JSON.parse(body.messages[1].content);
          if (controlled.invalidTerra && !args.figureIds) return { status: 200, data: {
            ...chatResponse(controlled.terra, '{}'), usage: { cost: 0.021, prompt_tokens: 17, completion_tokens: 6 },
          } };
          if (args.figureIds) {
            return mock(controlled.terra, JSON.stringify({ figures: args.figureIds.map((figureId: string) =>
              ({ figureId, supports: ['三角を含む'], contradicts: [], unknown: [] })) }));
          }
          slots = args.ownAnchors.map(({ id }: { id: string }) => id);
          const figures = slots.map(id => ({ id, holistic: controlled.observationName
            ? [{ construal: controlled.observationName, basis: ['三角'], status: 'hypothesis' }] : [], analytic: { shapes: ['三角'], composition: '辺がつながる', relations: [] }, unknowns: [] }));
          return mock(controlled.terra, JSON.stringify({ figures }));
        }
        const first = body.messages[0].content, last = body.messages.at(-1).content;
        const text = first === MEMO_LOCAL_EXTRACTION_INSTRUCTIONS || first === MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS ? '[]'
          : String(last).includes('JSON') ? JSON.stringify(Object.fromEntries(slots.map(id => [id, '合成名']))) : 'なるほど、聞かせてくれてありがとう。';
        return mock(controlled.luna, text);
      },
      async participantUsagePolicy() { return this.participantPolicy(); },
      participantUsagePolicyV2: undefined as (() => Promise<unknown>) | undefined,
      participantUsagePolicyV3: undefined as (() => Promise<unknown>) | undefined,
      participantUsageGeneration: undefined as ((body: unknown, expected: string) => Promise<any>) | undefined,
      participantInitialObservationPolicy: undefined as ((generation?: InitialObservationGeneration) => Promise<unknown>) | undefined,
      async participantUsageChat(body: any, expected: string) {
        const overridden = await controlled.usageChat?.(body, expected);
        return overridden ?? this.participantChat(body, expected);
      },
      async participantUsageChoices(body: { state: string; questions: Choices }, expected: string) {
        return this.participantChoices(body, expected, true);
      },
      async participantChoices(body: { state: string; questions: Choices }, expected: string, usageOnly = false) {
        calls.push({ kind: 'choices', expected, body });
        await controlled.holdChoice?.();
        const observe = controlled.observe && Object.hasOwn(body.questions.action?.criteria ?? {}, 'request_observation');
        if (observe) controlled.observe = false;
        if (controlled.rejectJev && body.questions.action) {
          return participantUsageChoices(settings, body, expected, async () => Response.json({
            model: pin.jevModelId, answers: {}, usage: { cost: 0.012, input_tokens: 18, output_tokens: 5 },
          }));
        }
        const model = controlled.wrongChoiceModel?.(body.questions) ? 'typesafe/jev-1.14-20261002' : controlled.jev;
        const data = { id: 'gen-synthetic', model, usage: controlled.mixedUsage ? { cost: body.questions.action ? 0.07 : null, input_tokens: 5, output_tokens: 3 } : { cost: 0 },
          answers: answers(body.questions, observe, controlled.selectedAction,
            name => controlled.choose?.(name, body), controlled.secondAction) };
        // Exercise the proxy's real validation of each positive Jev stage.
        return controlled.jev === pin.jevModelId ? (usageOnly ? participantUsageChoices : participantChoices)(settings, body, expected, async () => Response.json(data))
          : { status: 200, data };
      },
    },
  };

  function makeSession(warmup: boolean) {
    const session = new TangramSession({ storage, id: { toString: () => 'c'.repeat(64) },
      waitUntil(promise: Promise<unknown>) { background.push(promise); } }, env);
    session.settings = async () => ({ mode: { value: 'on', revision: 1 }, protocol: { protocol: selectedProtocol, revision: selectedProtocol.revision, sha256 } });
    // Existing start-path cases use the same frozen approval with no warmup scheduled, as on a pre-deployment reception.
    if (!warmup) session.schedulePreobservations = async () => {};
    const cache = session.preobservations.startCache, read = cache.read;
    cache.read = (key: string, signal?: AbortSignal) => {
      controlled.onStartObservationRead?.();
      return read(key, signal);
    };
    return session;
  }
  let session = makeSession(preobserve);
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    session.fetch(new Request('https://session.invalid/api/' + path, { method, ...(body === undefined ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })) as Promise<Response>;

  return {
    storage, calls, controlled, env, request,
    async settleBackground() { await Promise.all(background.splice(0)); },
    evict(warmup = preobserve) { session = makeSession(warmup); },
    adminRecord(recordId: string) { return session.adminRecord(recordId); },
    browserRequest(request: Request) {
      return participantWorker.fetch(request, { ...env,
        NAMING_SESSIONS: { idFromName: (name: string) => name, get: () => session },
      }) as Promise<Response>;
    },
    admin(path: string, authenticated = true) {
      const index = {
        async getReception() { return receptionSummary(await storage.get('reception:v1')); },
        async listReceptions() { return [await this.getReception()]; },
        async readReceptionSettings() {
          const savedAt = '2026-01-01T00:00:00.000Z';
          return { mode: { value: 'on', revision: 1, savedAt }, protocol: { protocol: selectedProtocol, revision: selectedProtocol.revision, sha256, savedAt } };
        },
      };
      return participantWorker.fetch(new Request('https://session.invalid' + path, { headers:
        authenticated ? { Authorization: 'Bearer ' + adminToken } : { Cookie: 'tangram_session=' + 'c'.repeat(64) },
      }), { ...env,
        ADMIN_TOKEN: adminToken, ADMIN_RATE_LIMIT: { async limit() { return { success: true }; } },
        ADMIN_INDEX: { idFromName: () => 'index', get: () => index },
        NAMING_SESSIONS: { idFromString: () => 'owner', get: () => session },
      }) as Promise<Response>;
    },
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

test('an output-limited Luna answer remains unpublished and its known usage is counted once', async t => {
  const h = harness();
  const proxy = new InternalParticipantProxy({}, settings);
  let outputs = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    outputs++;
    return Response.json({ model: pin.lunaModelId, choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { cost: 0.037, prompt_tokens: 70, completion_tokens: 24 }, raw: 'RAW_CANARY' });
  });
  h.controlled.usageChat = async (body, expected) => {
    const first = body.messages[0].content;
    if (body.purpose === 'dialogue_turn' && first !== MEMO_LOCAL_EXTRACTION_INSTRUCTIONS && first !== MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS) {
      return proxy.participantUsageChat(body, expected);
    }
  };
  await h.receive();
  await h.approve();
  const { trial } = await jsonOk(await h.start());
  await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '合成の手掛かりです。' }));
  await h.idle();
  const record = await h.adminRecord(trial.sessionId);
  const meter = record.jevLedger.phases.luna.generation;
  assert.deepEqual([outputs, meter.posts, meter.knownUsd, meter.inputTokens, meter.outputTokens], [1, 1, 0.037, 70, 24]);
  assert.deepEqual([meter.unknownPosts, meter.missingCostPosts, meter.missingInputTokenPosts, meter.missingOutputTokenPosts], [0, 0, 0, 0]);
  assert.equal(record.jevLedger.latest.luna.status, 'failed');
  assert.ok(record.requests.some((request: any) => request.httpStatus === 422));
  assert.equal(record.queueState.errorCode, 'ai_unavailable');
  assert.equal(record.events.filter((event: any) => event.speaker === 'ai').length, 1);
  h.evict();
  const state = await jsonOk(await h.request('state'));
  assert.doesNotMatch(JSON.stringify(state), /0\.037|RAW_CANARY|verifiedUsage|knownUsd|prompt_tokens/u);
  assert.deepEqual((await h.adminRecord(trial.sessionId)).jevLedger, record.jevLedger);
  assert.equal(outputs, 1);
});

test('a Jev response without answers is rejected and its known usage remains in the action ledger', async () => {
  const h = harness();
  h.controlled.rejectJev = true;
  await h.receive();
  await h.approve();
  const { trial } = await jsonOk(await h.start());
  await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '合成の手掛かりです。' }));
  await h.idle();
  const record = await h.adminRecord(trial.sessionId);
  const meter = record.jevLedger.phases.jev.action_target;
  assert.deepEqual([meter.posts, meter.knownUsd, meter.inputTokens, meter.outputTokens], [1, 0.012, 18, 5]);
  assert.deepEqual([meter.unknownPosts, meter.missingCostPosts, meter.missingInputTokenPosts, meter.missingOutputTokenPosts], [0, 0, 0, 0]);
  assert.equal(record.jevLedger.latest.jev.status, 'failed');
  assert.equal(record.queueState.errorCode, 'ai_unavailable');
  assert.equal(record.events.filter((event: any) => event.speaker === 'ai').length, 1);
});

for (const selected of [protocol, figureBankProtocol]) test(
  `${selected.schemaVersion} exports a failed first observation by reception and assignment after Worker recreation`, async () => {
  const h = harness(true, selected);
  h.controlled.invalidTerra = true;
  await h.receive();
  const { receptionId, plan } = await h.approve();
  const bank = selected.schemaVersion === 'reception_protocol_v3';
  assert.equal(plan.schemaVersion, bank ? 'reception_plan_v3' : 'reception_plan_v2');
  if (bank) assert.deepEqual(plan.trials[0].figureSelection.figureIds, FIGURE_SETS['bank-set-b']);
  const error = await h.start();
  assert.equal(error.status, 409);
  assert.deepEqual(await error.json(), { error: 'trial_unavailable' });
  const owner = await h.storage.get('base:owner:v1');
  const entry = owner.admissions[owner.activeKey];
  const assignmentId = entry.assignment.assignmentId;
  assert.equal(entry.status, 'failed');
  assert.equal(entry.errorCode, 'initialization_failed');
  assert.equal(entry.record, null);
  assert.deepEqual(await h.storage.get('ledger'), {});
  assert.deepEqual(h.calls.map(call => call.kind), ['visual_observation']);
  const path = '/admin/reception/' + receptionId + '/usage.json';
  h.evict();
  const denied = await h.admin(path, false);
  assert.equal(denied.status, 401);
  const unknown = await h.admin('/admin/reception/74c43c3b-0b83-4622-aa85-62c760f13ebb/usage.json');
  assert.equal(unknown.status, 404);
  const listing = await h.admin('/admin/receptions');
  assert.equal(listing.status, 200);
  const html = await listing.text();
  assert.ok(html.includes(`href="${path}"`));
  assert.ok(html.includes(bank ? 'bank-set-b' : 'legacy-v1'));
  assert.doesNotMatch(html, /knownUsd|initialization_failed/u);
  const exported = await h.admin(path);
  assert.equal(exported.headers.get('Cache-Control'), 'no-store');
  assert.match(exported.headers.get('Content-Disposition') ?? '', /attachment/u);
  const snapshot = await jsonOk(exported);
  assert.equal(snapshot.receptionId, receptionId);
  const [failed] = snapshot.failedStarts;
  assert.deepEqual(snapshot.failedStarts.map(({ usage: _usage, ...value }: any) => value),
    [{ assignmentId, trialIndex: 0, errorCode: 'initialization_failed', failureCause: 'observation_invalid' }]);
  assert.equal(entry.failureCause, 'observation_invalid');
  assert.deepEqual(failed.usage, await h.storage.get('participant-usage:' + assignmentId));
  const meter = failed.usage.phases.terra.initial_observation;
  assert.deepEqual([meter.posts, meter.knownUsd, meter.inputTokens, meter.outputTokens, meter.missingCostPosts], [1, 0.021, 17, 6, 0]);
  assert.equal((await h.request('state')).status, 409);
  assert.equal((await h.start()).status, 409);
  assert.equal(h.calls.length, 1);
});

// Production runs per_trial: the second condition has its own stimulus, so it calls Terra again instead of reusing the first memo (a shared seed never exercises this).
test('per_trial: a second condition whose Terra memo is invalid fails as initialization_failed with a closed cause, and the first condition stays intact', async () => {
  const h = harness(true, { ...protocol, seedPolicy: 'per_trial' } as typeof protocol);
  await h.receive();
  const { receptionId } = await h.approve();
  const first = await jsonOk(await h.start());
  const firstId = first.trial.sessionId;
  await h.complete(firstId, (await jsonOk(await h.request('state'))).trial);
  const firstRecord = await h.storage.get('record:' + firstId);
  assert.equal(h.calls.filter(call => call.kind === 'visual_observation').length, 1);

  const before = h.calls.length;
  h.controlled.invalidTerra = true;
  const second = await h.start(firstId);
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'trial_unavailable' });
  const owner = await h.storage.get('base:owner:v1');
  const failedKey = Object.keys(owner.admissions).find(key => owner.admissions[key].status === 'failed');
  assert.ok(failedKey, 'the second condition is a failed admission');
  const entry = owner.admissions[failedKey];
  assert.equal(entry.assignment.source.trialIndex, 1);
  assert.equal(entry.errorCode, 'initialization_failed');
  assert.equal(entry.failureCause, 'observation_invalid');
  assert.equal(entry.record, null);
  assert.deepEqual(h.calls.slice(before).map(call => call.kind), ['visual_observation'], 'a new stimulus asks Terra again (per_trial), once, and nothing else is called');

  const exported = await jsonOk(await h.admin('/admin/reception/' + receptionId + '/usage.json'));
  const [failed] = exported.failedStarts;
  assert.deepEqual(exported.failedStarts.map(({ usage: _usage, ...value }: any) => value),
    [{ assignmentId: entry.assignment.assignmentId, trialIndex: 1, errorCode: 'initialization_failed', failureCause: 'observation_invalid' }]);
  const meter = failed.usage.phases.terra.initial_observation;
  assert.deepEqual([meter.posts, meter.missingCostPosts], [1, 0], 'the Terra call is metered as received (ok at HTTP level)');
  assert.equal(failed.usage.phases.jev.action_target.posts + failed.usage.phases.luna.generation.posts, 0);
  assert.deepEqual(await h.storage.get('record:' + firstId), firstRecord, 'the finished first condition is unchanged');
  assert.equal(JSON.stringify(exported).includes('gen-'), false);
});

test('a structured reception keeps its version and second condition across a proxy rollback', async t => {
  const h = harness();
  const generation = INITIAL_OBSERVATION_STRUCTURED_V1;
  const proxy = new InternalParticipantProxy({}, settings);
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = generation;
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = () => proxy.participantInitialObservationPolicy();
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    posts++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.response_format?.json_schema?.strict, true);
    const { data } = await h.env.PARTICIPANT_AI_PROXY.participantChat({ purpose: 'visual_observation', messages: body.messages },
      pin.terraModelId);
    return Response.json(data);
  });
  h.controlled.usageChat = async (body, expected) => body.purpose === 'visual_observation'
    ? proxy.participantUsageChat(body, expected) : undefined;
  await h.receive();
  const { plan } = await h.approve();
  assert.equal(plan.initialObservationGeneration, generation);
  assert.equal(posts, 0);
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = undefined;
  const { trial: first } = await jsonOk(await h.start());
  const firstRecord = await h.storage.get('record:' + first.sessionId);
  assert.equal(firstRecord.options.initialObservationGeneration, generation);
  assert.equal(firstRecord.assignment.source.plan.initialObservationGeneration, generation);
  assert.equal(posts, 1);
  h.evict();
  assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, first.sessionId);
  await h.complete(first.sessionId, (await jsonOk(await h.request('state'))).trial);
  const receptionBefore = await h.storage.get('reception:v1');
  const ownerBefore = await h.storage.get('base:owner:v1');
  const completedBefore = await h.storage.get('record:' + first.sessionId);
  const callsBefore = h.calls.length;
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = async () => { throw new Error('synthetic unknown RPC method'); };
  h.evict();
  const blocked = await h.start(first.sessionId);
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: 'trial_unavailable' });
  assert.deepEqual(await h.storage.get('reception:v1'), receptionBefore);
  assert.deepEqual(await h.storage.get('base:owner:v1'), ownerBefore);
  assert.deepEqual(await h.storage.get('record:' + first.sessionId), completedBefore);
  assert.equal((await h.adminRecord(first.sessionId)).status, 'completed');
  assert.deepEqual((await jsonOk(await h.admin('/admin/reception/' + receptionBefore.receptionId + '/usage.json'))).failedStarts, []);
  assert.equal(h.calls.length, callsBefore);
  assert.equal(posts, 1);
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = () => proxy.participantInitialObservationPolicy();
  const { trial: second } = await jsonOk(await h.start(first.sessionId));
  const secondRecord = await h.storage.get('record:' + second.sessionId);
  assert.equal(secondRecord.options.initialObservationGeneration, generation);
  assert.equal(secondRecord.assignment.source.plan.initialObservationGeneration, generation);
  assert.equal(secondRecord.initialObservation.memoSha256, firstRecord.initialObservation.memoSha256);
  assert.equal(secondRecord.jevLedger.phases.terra.initial_observation.cacheHits, 1);
  assert.equal(posts, 1);
});

test('a Luna approval still uses Luna after Terra becomes the new default, including restore and condition two', async () => {
  const h = harness();
  await h.receive();
  await h.approve();
  h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'on';
  h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV2 = async () => assert.fail('saved Luna requires the original policy');
  const first = (await jsonOk(await h.start())).trial;
  h.evict();
  assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, first.sessionId);
  await h.complete(first.sessionId, first);
  const second = (await jsonOk(await h.start(first.sessionId))).trial;
  await jsonOk(await h.request('message', { expectedRecordId: second.sessionId, text: '三角の部分があります。' }));
  await h.idle();
  for (const id of [first.sessionId, second.sessionId]) {
    const saved = await h.storage.get('record:' + id);
    assert.deepEqual(saved.options.participantModelPin, pin);
    assert.equal(saved.jevLedger.latest.luna.model, pin.lunaModelId);
    assert.equal(Object.hasOwn(saved.jevLedger.phases.terra, 'generation'), false);
  }
});

test('new Terra approval routes generation and final submissions to exact Terra in both conditions', async t => {
  const h = harness();
  const generationPin = { ...pin, schemaVersion: 'participant_model_pin_v2', generationModelId: pin.terraModelId };
  const proxy = new InternalParticipantProxy({}, settings);
  h.env.PARTICIPANT_TERRA_GENERATION_ENABLED = 'on';
  h.controlled.observationName = '仮の塔';
  await h.receive();
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  const lookupGenerationPin = () => proxy.participantUsagePolicyV2();
  h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV2 = lookupGenerationPin;
  h.env.PARTICIPANT_AI_PROXY.participantUsageGeneration = (body, expected) => proxy.participantUsageGeneration(body, expected);
  h.env.PARTICIPANT_TERRA_ENABLED = 'off';
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  h.env.PARTICIPANT_TERRA_ENABLED = 'on';
  const posts: string[] = [];
  const text = 'そうなんですね、教えてくれてありがとう。';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, pin.terraModelId);
    assert.ok(body.messages.every((message: { content: unknown }) => typeof message.content === 'string'));
    const final = String(body.messages.at(-1).content).includes('JSON');
    posts.push(final ? 'final_submission' : 'generation');
    const visual = h.calls.find(call => call.kind === 'visual_observation');
    const { ownAnchors } = JSON.parse(visual?.body.messages[1].content) as { ownAnchors: Array<{ id: string }> };
    return Response.json({
      ...chatResponse(pin.terraModelId, final ? JSON.stringify(Object.fromEntries(ownAnchors.map(({ id }) => [id, '合成名']))) : text),
      usage: { cost: 0.021, prompt_tokens: 17, completion_tokens: 6 },
    });
  });
  const approved = await h.approve();
  assert.deepEqual(approved.plan.participantModelPin, generationPin);
  h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'on';
  let predecessor: string | undefined;
  for (const strategy of ['bypass-enabled', 'repair-first']) {
    const before = await h.storage.get('reception:v1');
    const owner = await h.storage.get('base:owner:v1');
    const other = 'gpt-6.1-terra-2026-11-02';
    h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV2 = async () => ({ ...generationPin, terraModelId: other, generationModelId: other });
    assert.equal((await h.start(predecessor)).status, 409);
    assert.deepEqual(await h.storage.get('reception:v1'), before);
    assert.deepEqual(await h.storage.get('base:owner:v1'), owner);
    h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV2 = lookupGenerationPin;
    const { trial } = await jsonOk(await h.start(predecessor));
    h.controlled.observe = true;
    await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '三角の部分があります。' }));
    await h.idle();
    const state = (await jsonOk(await h.request('state'))).trial;
    assert.ok(state.events.some((event: { text: string }) => event.text === text));
    await h.complete(trial.sessionId, state);
    const saved = await h.storage.get('record:' + trial.sessionId);
    assert.equal(saved.strategy, strategy);
    assert.equal(saved.jevTraces[0].decisionMenuVersion, 'action_conditioned_targets_v1');
    const scores = saved.jevTraces[0].decisions[0].evidence.scores;
    assert.ok(Object.hasOwn(scores.action, 'propose_name'));
    assert.equal(Object.hasOwn(scores.action, 'agree'), false);
    assert.equal(Object.hasOwn(scores, 'agree_target'), false);
    assert.deepEqual(saved.options.participantModelPin, generationPin);
    assert.ok(saved.requests.some((row: any) => row.kind === 'generation' && row.model === pin.terraModelId));
    const { phases, latest } = saved.jevLedger;
    assert.equal(latest.terra.model, pin.terraModelId);
    assert.equal(latest.terra.phase, 'final_submission');
    assert.equal(latest.jev.model, pin.jevModelId);
    assert.ok(phases.luna.ai_extraction.posts > 0);
    assert.equal(latest.luna.model, pin.lunaModelId);
    for (const phase of ['generation', 'final_submission']) {
      const meter = phases.terra[phase];
      assert.deepEqual([meter.calls, meter.posts, meter.knownUsd, meter.inputTokens, meter.outputTokens], [1, 1, 0.021, 17, 6]);
    }
    assert.ok(phases.terra.reobservation.posts > 0);
    h.evict();
    assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, trial.sessionId);
    predecessor = trial.sessionId;
  }
  assert.deepEqual(posts, ['generation', 'final_submission', 'generation', 'final_submission']);
});

test('v3 routes all four text roles to real private Terra transport and preserves both condition slots', async t => {
  const h = harness();
  const proxy = new InternalParticipantProxy({}, { ...settings, VISION_MODEL: pin.terraModelId });
  const expectedPin = { schemaVersion: 'participant_model_pin_v3', terraModelId: pin.terraModelId, jevModelId: pin.jevModelId };
  const service = h.env.PARTICIPANT_AI_PROXY;
  const lookup = () => proxy.participantUsagePolicyV3();
  const routeText = (body: unknown, expected: string) => proxy.participantUsageGeneration(body, expected);
  h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'on';
  h.env.PARTICIPANT_TERRA_GENERATION_ENABLED = 'on';
  service.participantUsagePolicyV2 = () => proxy.participantUsagePolicyV2();
  service.participantUsageGeneration = routeText;
  h.controlled.usageChat = async (body, expected) => {
    assert.equal(body.purpose, 'visual_observation');
    assert.equal(expected, pin.terraModelId);
    return proxy.participantUsageChat(body, expected);
  };
  const posts: string[] = [];
  let slots: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, pin.terraModelId);
    const first = body.messages[0].content, last = String(body.messages.at(-1).content);
    let phase: string, response: string;
    if (body.messages.some((message: { content: unknown }) => Array.isArray(message.content))) {
      const args = JSON.parse(body.messages[1].content);
      if (args.figureIds) {
        phase = 'reobservation';
        response = JSON.stringify({ figures: args.figureIds.map((figureId: string) =>
          ({ figureId, supports: ['三角を含む'], contradicts: [], unknown: [] })) });
      } else {
        phase = 'initial_observation';
        slots = args.ownAnchors.map(({ id }: { id: string }) => id);
        response = JSON.stringify({ figures: slots.map(id => ({ id, holistic: [],
          analytic: { shapes: ['三角'], composition: '辺がつながる', relations: [] }, unknowns: [] })) });
      }
    } else if (first === MEMO_LOCAL_EXTRACTION_INSTRUCTIONS || first === MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS) {
      phase = first === MEMO_LOCAL_EXTRACTION_INSTRUCTIONS ? 'dialogue' : 'ai_extraction';
      response = '[]';
    } else if (last.includes('JSON')) {
      phase = 'final_submission';
      response = JSON.stringify(Object.fromEntries(slots.map(id => [id, '合成名'])));
    } else {
      phase = last.includes('公開発話を書き直してください') ? 'rewrite' : 'generation';
      response = phase === 'generation' ? 'human_referent' : 'なるほど、聞かせてくれてありがとう。';
    }
    posts.push(phase);
    assert.doesNotMatch(JSON.stringify(body), /ANSWER_KEY_CANARY|participantModelPin|service-binding-only/u);
    return Response.json({ ...chatResponse(pin.terraModelId, response),
      usage: { cost: phase === 'ai_extraction' ? null : 0.021, prompt_tokens: 17, completion_tokens: 6 } });
  });
  await h.receive();
  const received = await h.storage.get('reception:v1');
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  service.participantUsagePolicyV3 = service.participantUsagePolicyV2;
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  service.participantUsagePolicyV3 = lookup;
  service.participantUsageGeneration = undefined;
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  assert.deepEqual(await h.storage.get('reception:v1'), received);
  assert.equal(posts.length, 0);
  service.participantUsageGeneration = routeText;

  const approved = await h.approve();
  assert.deepEqual(approved.plan.participantModelPin, expectedPin);
  h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'off';
  let predecessor: string | undefined;
  for (const strategy of ['bypass-enabled', 'repair-first']) {
    const before = await h.storage.get('reception:v1');
    const owner = await h.storage.get('base:owner:v1');
    const countBefore: number = posts.length;
    service.participantUsagePolicyV3 = undefined;
    assert.equal((await h.start(predecessor)).status, 409);
    service.participantUsagePolicyV3 = async () => ({ ...expectedPin, terraModelId: 'gpt-6.1-terra-2026-11-02' });
    assert.equal((await h.start(predecessor)).status, 409);
    assert.deepEqual(await h.storage.get('reception:v1'), before);
    assert.deepEqual(await h.storage.get('base:owner:v1'), owner);
    assert.equal(posts.length, countBefore);

    service.participantUsagePolicyV3 = lookup;
    const { trial } = await jsonOk(await h.start(predecessor));
    h.controlled.observe = true;
    await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '三角の部分があります。' }));
    await h.idle();
    const state = (await jsonOk(await h.request('state'))).trial;
    assert.ok(state.events.some((event: { text: string }) => event.text === 'なるほど、聞かせてくれてありがとう。'));
    await h.complete(trial.sessionId, state);
    const saved = await h.storage.get('record:' + trial.sessionId);
    assert.equal(saved.strategy, strategy);
    assert.deepEqual(saved.options.participantModelPin, expectedPin);
    assert.equal(saved.jevTraces[0].generationGuard.regenerated, true);
    const { phases, latest, returnedModels } = saved.jevLedger;
    assert.deepEqual(phases.luna, {});
    assert.equal(latest.luna, null);
    assert.equal(latest.terra.model, pin.terraModelId);
    assert.equal(latest.terra.phase, 'final_submission');
    assert.equal(latest.jev.model, pin.jevModelId);
    assert.ok(phases.jev.action_target.posts > 0);
    assert.deepEqual(returnedModels.luna, {});
    assert.deepEqual(returnedModels.jev.action_target, { model: pin.jevModelId, ok: phases.jev.action_target.posts });
    const expectedPosts = { initial_observation: predecessor ? 0 : 1, reobservation: 1,
      dialogue: 1, generation: 2, ai_extraction: 1, final_submission: 1 };
    for (const [phase, count] of Object.entries(expectedPosts)) {
      const meter = phases.terra[phase];
      assert.deepEqual(returnedModels.terra[phase], count ? { model: pin.terraModelId, ok: count } : undefined);
      assert.deepEqual([meter.posts, meter.inputTokens, meter.outputTokens, meter.unknownPosts,
        meter.missingCostPosts, meter.knownUsd], [count, 17 * count, 6 * count, 0,
        phase === 'ai_extraction' ? count : 0, phase === 'ai_extraction' ? 0 : 0.021 * count]);
    }
    assert.equal(phases.terra.initial_observation.cacheHits, predecessor ? 1 : 0);
    h.evict();
    assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, trial.sessionId);
    assert.deepEqual((await h.adminRecord(trial.sessionId)).jevLedger, saved.jevLedger);
    assert.doesNotMatch(JSON.stringify(await jsonOk(await h.request('state'))), /returnedModels/u);
    predecessor = trial.sessionId;
  }
  const perCondition = ['dialogue', 'reobservation', 'generation', 'rewrite', 'ai_extraction', 'final_submission'];
  assert.deepEqual(posts, ['initial_observation', ...perCondition, ...perCondition]);
});

test('v3 rejects wrong or missing model IDs from either extraction before publication', async t => {
  for (const [phase, id] of [['dialogue', pin.lunaModelId], ['ai_extraction', undefined]] as const) {
    const h = harness();
    const proxy = new InternalParticipantProxy({}, settings);
    h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'on';
    h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV3 = () => proxy.participantUsagePolicyV3();
    h.env.PARTICIPANT_AI_PROXY.participantUsageGeneration = (body, expected) => proxy.participantUsageGeneration(body, expected);
    const posts: string[] = [];
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, pin.terraModelId);
      const first = body.messages[0].content;
      const current = first === MEMO_LOCAL_EXTRACTION_INSTRUCTIONS ? 'dialogue'
        : first === MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS ? 'ai_extraction' : 'generation';
      posts.push(current);
      return Response.json(chatResponse(current === phase ? id : pin.terraModelId,
        current === 'generation' ? 'なるほど、聞かせてくれてありがとう。' : '[]'));
    });
    await h.receive();
    await h.approve();
    const { trial } = await jsonOk(await h.start());
    const event = await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '三角の部分があります。' }));
    await h.idle();
    const saved = await h.adminRecord(trial.sessionId);
    assert.equal(saved.queueState.errorCode, 'ai_unavailable');
    assert.deepEqual(saved.queueState.pendingHumanEventIds, [event.eventId]);
    assert.equal(saved.events.at(-1).id, event.eventId);
    assert.equal(saved.jevLedger.halted, true);
    assert.equal(saved.jevLedger.latest.terra.phase, phase);
    assert.equal(saved.jevLedger.latest.terra.status, 'model_mismatch');
    assert.equal(saved.jevLedger.latest.terra.model, null);
    assert.equal(saved.jevLedger.returnedModels.terra[phase], undefined);
    assert.equal(saved.jevLedger.phases.terra[phase].unknownPosts, 1);
    assert.equal(saved.jevLedger.latest.luna, null);
    assert.deepEqual(posts, phase === 'dialogue' ? ['dialogue'] : ['dialogue', 'generation', 'ai_extraction']);
    mock.mock.restore();
  }
});

test('private Terra generation closes on missing configuration, wrong expected ID and wrong actual ID', async t => {
  const proxy = new InternalParticipantProxy({}, settings);
  const unavailable = new InternalParticipantProxy({}, { ...settings, PARTICIPANT_MODEL_PIN_JSON: undefined });
  const body = { purpose: 'dialogue_turn', messages: [{ role: 'user', content: '合成発話' }], model: pin.lunaModelId };
  let returned: unknown, posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    posts++;
    assert.equal(JSON.parse(String(init.body)).model, pin.terraModelId);
    return Response.json(chatResponse(returned, '非公開の模擬応答'));
  });
  assert.equal(await unavailable.participantUsagePolicyV2(), null);
  assert.equal(await unavailable.participantUsagePolicyV3(), null);
  assert.equal((await unavailable.participantUsageGeneration(body, pin.terraModelId)).status, 503);
  assert.equal((await proxy.participantUsageGeneration(body, pin.lunaModelId)).status, 409);
  assert.equal((await proxy.participantUsageGeneration({ ...body, purpose: 'visual_observation' }, pin.terraModelId)).status, 400);
  assert.equal(posts, 0);
  for (returned of [undefined, pin.lunaModelId]) {
    assert.deepEqual(await proxy.participantUsageGeneration(body, pin.terraModelId), { status: 502, data: { error: 'model_mismatch' } });
  }
  assert.equal(posts, 2);
});

test('P5 dialogue profile keeps management reads available and blocks incomplete or mixed bindings', async () => {
  const h = harness();
  const proxy = new InternalParticipantProxy({}, settings);
  h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'on';
  h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV3 = () => proxy.participantUsagePolicyV3();
  h.env.PARTICIPANT_AI_PROXY.participantUsageGeneration = async (payload, expected) => {
    const body = payload as { messages: { content: string }[] };
    if (!body.messages.at(-1)?.content.includes('JSON')) {
      return { status: 200, data: chatResponse(expected, 'なるほど、聞かせてくれてありがとう。') };
    }
    const initial = h.calls.find(call => call.kind === 'visual_observation');
    const { ownAnchors } = JSON.parse(initial?.body.messages[1].content) as { ownAnchors: { id: string }[] };
    return { status: 200, data: chatResponse(expected, JSON.stringify(Object.fromEntries(ownAnchors.map(({ id }) => [id, '合成名'])))) };
  };
  const error = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  };
  const put = (items: Record<string, unknown>) => h.storage.transaction(tx => tx.put(items));

  await h.receive();
  const approved = await h.approve();
  assert.equal(Object.hasOwn(approved.plan, 'participantDialogueProfile'), false);
  const before = await h.storage.get('base:owner:v1');
  await error(await h.request('start', { version: 2, expectedReceptionRevision: approved.revision,
    participantDialogueProfile: 'participant_dialogue_v12' }), 400, 'invalid_request');

  for (const profile of [v13Dialogue, v13NamingV4Dialogue]) {
    const p5Approved = { ...approved, plan: { ...approved.plan, participantDialogueProfile: profile } };
    delete p5Approved.plan.memoryPruneVersion;
    await put({ 'reception:v1': p5Approved });
    const listing = await h.admin('/admin/receptions');
    assert.equal(listing.status, 200);
    assert.ok((await listing.text()).includes('data-id="' + approved.receptionId + '"'));
    await error(await h.start(), 409, 'trial_unavailable');
    assert.deepEqual(await h.storage.get('reception:v1'), p5Approved);
    assert.deepEqual(await h.storage.get('base:owner:v1'), before);
    assert.equal(h.calls.length, 0);
  }
  await put({ 'reception:v1': { ...approved, plan: { ...approved.plan, participantDialogueProfile: 'unknown' } } });
  await error(await h.start(), 409, 'reception_unavailable');
  assert.deepEqual(await h.storage.get('base:owner:v1'), before);
  assert.equal(h.calls.length, 0);

  await put({ 'reception:v1': approved });
  h.env.PARTICIPANT_DIALOGUE_PROFILE = v12Dialogue;
  const { trial } = await jsonOk(await h.start());
  const recordKey = 'record:' + trial.sessionId;
  await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '形を確認したいです。' }));
  await h.idle();
  const legacy = await h.storage.get(recordKey);
  assert.equal(Object.hasOwn(legacy.options, 'participantDialogueProfile'), false);
  assert.equal(legacy.jevTraces[0].decisionMenuVersion, 'action_conditioned_targets_v1');
  h.evict();
  const restored = (await jsonOk(await h.request('state'))).trial;
  assert.equal(restored.sessionId, trial.sessionId);
  assert.deepEqual((await h.storage.get(recordKey)).queueState.privateState, legacy.queueState.privateState);
  await h.complete(trial.sessionId, restored);
  const existing = await h.storage.get('reception:v1');
  const originalOwner = await h.storage.get('base:owner:v1');
  const originalRecord = await h.storage.get(recordKey);

  // A profile change in a stored plan must not reinterpret either a warm or a cold keyless trial.
  const marked = structuredClone(existing);
  marked.plan.participantDialogueProfile = 'participant_dialogue_v13_p5';
  const sent = h.calls.length;
  await put({ 'reception:v1': marked });
  await error(await h.request('retry', { expectedRecordId: trial.sessionId }), 409, 'trial_unavailable');
  assert.deepEqual(await h.storage.get('base:owner:v1'), originalOwner);
  assert.equal(h.calls.length, sent);

  const owner = structuredClone(originalOwner);
  const admission = owner.admissions[owner.activeKey];
  admission.assignment.source.plan = structuredClone(marked.plan);
  const record = structuredClone(originalRecord);
  record.assignment = structuredClone(admission.assignment);
  record.options.participantDialogueProfile = marked.plan.participantDialogueProfile;
  assert.doesNotThrow(() => validateBoundBaseRecord(record, admission.assignment));
  for (const profile of [undefined, 'participant_dialogue_v12']) {
    const mismatched = { ...record, options: { ...record.options, participantDialogueProfile: profile } };
    assert.throws(() => validateBoundBaseRecord(mismatched, admission.assignment), { code: 'assignment_record_invalid' });
  }
  assert.throws(() => validateBoundBaseRecord({ ...originalRecord, options: record.options }, originalRecord.assignment),
    { code: 'assignment_record_invalid' });
  admission.record = record;
  await put({ 'reception:v1': marked, 'base:owner:v1': owner, active: record, [recordKey]: record });

  await error(await h.request('retry', { expectedRecordId: trial.sessionId }), 409, 'trial_unavailable');
  h.evict();
  await error(await h.request('retry', { expectedRecordId: trial.sessionId }), 409, 'trial_unavailable');
  await error(await h.start(trial.sessionId), 409, 'trial_unavailable');
  assert.deepEqual(await h.storage.get('reception:v1'), marked);
  assert.deepEqual(await h.storage.get('base:owner:v1'), owner);
  assert.deepEqual(await h.storage.get(recordKey), record);
  assert.equal(h.calls.length, sent);
  assert.deepEqual((await h.adminRecord(trial.sessionId)).options, record.options);

  await put({ 'reception:v1': existing, 'base:owner:v1': originalOwner, active: originalRecord, [recordKey]: originalRecord });
  const next = (await jsonOk(await h.start(trial.sessionId))).trial;
  assert.equal(Object.hasOwn((await h.storage.get('record:' + next.sessionId)).options, 'participantDialogueProfile'), false);
  assert.deepEqual(await h.storage.get(recordKey), originalRecord);
});

test('a proxy without the structured capability cannot approve or use up the first trial', async () => {
  const h = harness();
  const generation = INITIAL_OBSERVATION_STRUCTURED_V1;
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = generation;
  await h.receive();
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  assert.equal((await h.storage.get('reception:v1')).plan, null);
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = async () => generation;
  await h.approve();
  const receptionBefore = await h.storage.get('reception:v1');
  const ownerBefore = await h.storage.get('base:owner:v1');
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = undefined;
  const reply = await h.start();
  assert.equal(reply.status, 409);
  assert.deepEqual(await reply.json(), { error: 'trial_unavailable' });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.storage.get('reception:v1'), receptionBefore);
  assert.deepEqual(await h.storage.get('base:owner:v1'), ownerBefore);
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = async () => generation;
  h.controlled.usageChat = async (body, expected) => {
    assert.equal(body.initial_observation_generation, generation);
    const { status, data } = await h.env.PARTICIPANT_AI_PROXY.participantChat(body, expected);
    return { status, data: { ...data, initial_observation_generation: generation } };
  };
  const { trial } = await jsonOk(await h.start());
  assert.equal((await h.storage.get('record:' + trial.sessionId)).options.initialObservationGeneration, generation);
  assert.deepEqual(h.calls.map(({ kind }) => kind), ['visual_observation']);
});

test('a reserved initial observation can settle after its assignment is marked interrupted', async () => {
  const h = harness();
  let signalStarted!: () => void;
  let reply!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const upstream = new Promise(resolve => { reply = resolve; });
  let sends = 0;
  h.controlled.usageChat = async () => { sends++; signalStarted(); return upstream; };
  await h.receive();
  const { receptionId } = await h.approve();
  const pending = h.start();
  await started;
  h.evict();
  assert.equal((await h.request('state')).status, 409);
  const path = '/admin/reception/' + receptionId + '/usage.json';
  const before = (await jsonOk(await h.admin(path))).failedStarts[0];
  assert.equal(before.errorCode, 'start_interrupted');
  assert.equal(before.usage.latest.terra.status, 'reserved');
  reply({ status: 200, data: { ...chatResponse(pin.terraModelId, '{}'), usage: {
    cost: 0.021, prompt_tokens: 17, completion_tokens: 6,
  } } });
  assert.equal((await pending).status, 409);
  const after = (await jsonOk(await h.admin(path))).failedStarts[0];
  assert.equal(after.assignmentId, before.assignmentId);
  assert.equal(after.errorCode, before.errorCode);
  assert.equal(after.usage.latest.terra.costUsd, 0.021);
  assert.equal(after.usage.phases.terra.initial_observation.posts, 1);
  assert.deepEqual(await h.storage.get('ledger'), {});
  assert.equal(sends, 1);
});

test('an unavailable saved policy leaves the reception and usage journal unchanged', async () => {
  const h = harness();
  await h.receive();
  const { receptionId } = await h.approve();
  h.controlled.policy = null;
  const before = await h.storage.get('reception:v1');
  const owner = await h.storage.get('base:owner:v1');
  assert.equal((await h.start()).status, 409);
  h.evict();
  const snapshot = await jsonOk(await h.admin('/admin/reception/' + receptionId + '/usage.json'));
  assert.deepEqual(snapshot.failedStarts, []);
  assert.deepEqual(await h.storage.get('reception:v1'), before);
  assert.deepEqual(await h.storage.get('base:owner:v1'), owner);
  assert.equal(h.calls.length, 0);
});

test('Worker approval persists one private pin, both trial conditions use it, and eviction restores the same record', async () => {
  const h = harness();
  h.controlled.mixedUsage = true;
  h.env.PARTICIPANT_TERRA_LIMITS_JSON = 'invalid';
  await h.receive();
  const approved = await h.approve();
  assert.deepEqual(approved.plan.participantModelPin, pin);
  assert.equal(approved.plan.participantRuntimeProfile, PARTICIPANT_PRODUCTION_PROFILE);
  assert.equal(Object.hasOwn(approved.plan, 'participantLimits'), false);
  assert.deepEqual((await h.storage.get('reception:v1')).plan.participantModelPin, pin);
  assert.equal(h.calls.length, 0, 'approval does not infer');
  h.env.PARTICIPANT_TERRA_ENABLED = 'off'; // Does not change an approval already on disk.
  h.env.PARTICIPANT_TERRA_PROFILE = undefined;
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
  assert.equal(one.options.participantRuntimeProfile, PARTICIPANT_PRODUCTION_PROFILE);
  assert.equal(one.jevLedger.phases.terra.initial_observation.posts, 1);
  assert.equal(one.jevLedger.phases.terra.initial_observation.missingCostPosts, 1);
  assert.equal(one.jevLedger.phases.jev.action_target.knownUsd, 0.14);
  assert.ok(one.jevLedger.phases.jev.human_referent.missingCostPosts > 0);
  assert.equal(one.jevLedger.phases.luna.generation.knownUsd, 0.2);
  assert.ok(one.jevLedger.phases.luna.generation.inputTokens > approvedLimits.lunaTokens);
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
  assert.deepEqual((await h.storage.get('record:' + firstId)).jevLedger, one.jevLedger);
  await h.complete(firstId, (await jsonOk(await h.request('state'))).trial);

  const second = await jsonOk(await h.start(firstId));
  const secondId = second.trial.sessionId;
  const two = await h.storage.get('record:' + secondId);
  assert.equal(two.strategy, 'repair-first');
  assert.equal(two.seed, one.seed);
  assert.deepEqual(two.options.participantModelPin, pin);
  assert.equal(two.options.participantRuntimeProfile, one.options.participantRuntimeProfile);
  assert.equal(two.jevLedger.phases.terra.initial_observation.posts, 0);
  assert.equal(two.jevLedger.phases.terra.initial_observation.cacheHits, 1);
  assert.equal(two.initialObservation.memoSha256, one.initialObservation.memoSha256);
  h.controlled.observe = true;
  await jsonOk(await h.request('message', { expectedRecordId: secondId, text: opening }));
  await h.idle();
  const finalized = await h.storage.get('record:' + secondId);
  assert.equal(finalized.queueState.errorCode, null);
  assert.equal(finalized.jevLedger.phases.jev.action_target.knownUsd, 0.14);
  assert.equal(finalized.jevLedger.phases.terra.reobservation.posts, 1);
  assert.equal(finalized.jevLedger.phases.luna.generation.knownUsd, 0.2);
  assert.ok(finalized.events.some((event: any) => event.text === 'なるほど、聞かせてくれてありがとう。'));
  const observations = h.calls.filter(({ kind }) => kind === 'visual_observation')
    .map(({ body }) => JSON.parse(body.messages[1].content));
  assert.equal(observations.filter(({ ownAnchors }) => ownAnchors.length === 6).length, 1,
    'shared seed and pin reuse the initial Terra memo');
  assert.equal(observations.filter(({ figureIds }) => figureIds?.length === 1).length, 2,
    'each condition performs its own targeted Terra call');
  assert.equal(one.jevTraces[0].decisionMenuVersion, 'action_conditioned_targets_v1');
  assert.equal(finalized.jevTraces[0].decisionMenuVersion, 'action_conditioned_targets_v1');
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
  assert.doesNotMatch(JSON.stringify(state), /gpt-6|typesafe\/jev|participantModelPin|participantRuntimeProfile|participant_production_usage|missingCostPosts|knownUsd|ownAnchors|observationMemo|data:image/u);
});

for (const profile of [undefined, PARTICIPANT_PRODUCTION_PROFILE]) test(
  `v3 figure-bank and ${profile ? 'production usage' : 'saved limits'} remain fixed across conditions and restore`, async () => {
  const h = harness(true, figureBankProtocol);
  h.env.PARTICIPANT_TERRA_PROFILE = profile;
  await h.receive();
  const approved = await h.approve();
  assert.equal(approved.plan.schemaVersion, 'reception_plan_v3');
  assert.deepEqual(approved.plan.participantModelPin, pin);
  if (profile) {
    assert.equal(approved.plan.participantRuntimeProfile, profile);
    assert.equal(Object.hasOwn(approved.plan, 'participantLimits'), false);
    assert.throws(() => validateReceptionPlan({ ...approved.plan, participantLimits: approvedLimits }));
    assert.throws(() => validateReceptionPlan({ ...approved.plan, participantRuntimeProfile: 'future_profile' }));
    const { participantModelPin: _pin, ...withoutPin } = approved.plan;
    assert.throws(() => validateReceptionPlan(withoutPin));
  } else {
    assert.deepEqual(approved.plan.participantLimits, approvedLimits);
    assert.equal(Object.hasOwn(approved.plan, 'participantRuntimeProfile'), false);
  }
  assert.equal(h.calls.length, 0);

  const check = async (trial: { sessionId: string }, index: number) => {
    const record = await h.storage.get('record:' + trial.sessionId);
    const expected = approved.plan.trials[index];
    assert.equal(record.strategy, expected.strategy);
    assert.deepEqual(record.options.participantModelPin, pin);
    if (profile) {
      assert.equal(record.options.participantRuntimeProfile, profile);
      assert.equal(record.jevLedger.schemaVersion, profile);
      assert.equal(record.jevLedger.assignmentId, record.assignment.assignmentId);
      assert.equal(Object.hasOwn(record.jevLedger, 'limits'), false);
    } else {
      assert.deepEqual(record.jevLedger.limits, approvedLimits);
      assert.equal(Object.hasOwn(record.options, 'participantRuntimeProfile'), false);
    }
    assert.deepEqual(record.options.figureSelection, expected.figureSelection);
    assert.deepEqual(record.stimulus.figureIds, FIGURE_SETS['bank-set-b']);
    assert.doesNotMatch(JSON.stringify(trial), /bank-set-b|figureSelection|figureIds|participantModelPin|participantLimits|participantRuntimeProfile|knownUsd|observationMemo|gpt-6/u);
    return record;
  };
  const first = (await jsonOk(await h.start())).trial;
  const record = await check(first, 0);
  const model = modelView(createTrialV2({ seed: record.seed, rotationMode: record.options.rotationMode,
    figureSelection: record.options.figureSelection }));
  assert.equal(h.calls[0].expected, pin.terraModelId);
  const parts = h.calls[0].body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
  const image = parts.find((part: any) => part.type === 'image_url');
  assert.ok(image?.image_url.url === 'data:' + model.mimeType + ';base64,' + model.png.toString('base64'));

  h.env.PARTICIPANT_TERRA_ENABLED = 'off';
  h.env.PARTICIPANT_TERRA_PROFILE = profile ? undefined : PARTICIPANT_PRODUCTION_PROFILE;
  h.env.PARTICIPANT_TERRA_LIMITS_JSON = 'invalid';
  h.evict();
  const restored = (await jsonOk(await h.request('state'))).trial;
  assert.equal(restored.sessionId, first.sessionId);
  assert.deepEqual(restored.scene, first.scene);
  assert.equal(h.calls.length, 1);
  await h.complete(first.sessionId, restored);
  const scored = await h.storage.get('record:' + first.sessionId);
  const expectedIds = [...FIGURE_SETS['bank-set-b']].sort();
  assert.deepEqual(Object.values(scored.scoring.key.human).sort(), expectedIds);
  assert.deepEqual(Object.values(scored.scoring.key.ai).sort(), expectedIds);
  const sends = h.calls.length;
  const second = (await jsonOk(await h.start(first.sessionId))).trial;
  const secondRecord = await check(second, 1);
  assert.equal(h.calls.length, sends, 'second condition reuses the observation of the same AI board');
  assert.equal(secondRecord.initialObservation.memoSha256, record.initialObservation.memoSha256);
  h.evict();
  assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, second.sessionId);
  assert.equal(h.calls.length, sends);
  h.controlled.observe = true;
  await jsonOk(await h.request('message', { expectedRecordId: second.sessionId, text: '三角の部分があります。' }));
  await h.idle();
  const reviewed = await check(second, 1);
  assert.equal(reviewed.queueState.errorCode, null);
  assert.equal(reviewed.jevTraces[0].reobservations.length, 1);
  const targeted = h.calls.filter(({ kind }) => kind === 'visual_observation').at(-1);
  assert.equal(targeted?.expected, pin.terraModelId);
  const targetedParts = targeted?.body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
  assert.ok(targetedParts?.find((part: any) => part.type === 'image_url')?.image_url.url === image?.image_url.url);
});

test('approved trial limits survive Worker recreation and apply to both conditions after an env change', async () => {
  const h = harness();
  await h.receive();
  h.env.PARTICIPANT_TERRA_PROFILE = undefined;
  await h.approve();
  const first = await jsonOk(await h.start());
  const recordId = first.trial.sessionId;
  assert.deepEqual((await h.storage.get('record:' + recordId)).jevLedger.limits, approvedLimits);

  h.env.PARTICIPANT_TERRA_LIMITS_JSON = JSON.stringify({ ...approvedLimits, jevPosts: 59 });
  h.env.PARTICIPANT_TERRA_PROFILE = PARTICIPANT_PRODUCTION_PROFILE;
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

test('a budgeted participant trial still stops at its saved Jev ceiling', async () => {
  const h = harness();
  await h.receive();
  h.env.PARTICIPANT_TERRA_PROFILE = undefined;
  await h.approve();
  const { trial } = await jsonOk(await h.start());
  h.controlled.mixedUsage = true;
  await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '合成の手掛かりです。' }));
  await h.idle();
  const record = await h.storage.get('record:' + trial.sessionId);
  assert.equal(record.jevLedger.halted, true);
  assert.notEqual(record.queueState.errorCode, null);
  assert.equal(record.events.filter((event: any) => event.speaker === 'ai').length, 1);
});

test('an existing trial from a model-only plan restores with its recorded limits', async () => {
  const h = harness();
  await h.receive();
  h.env.PARTICIPANT_TERRA_PROFILE = undefined;
  await h.approve();
  await h.storage.transaction(async tx => {
    const reception = await tx.get('reception:v1');
    delete reception.plan.participantLimits; // Archived pin-only format.
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

test('a v2 pinned reception saves constrained decisions and retries the same pending event 16', async () => {
  const h = harness(true, { ...protocol, allowedOrders: [['repair-first', 'bypass-enabled']] });
  const generationPin = { ...pin, schemaVersion: 'participant_model_pin_v2', generationModelId: pin.terraModelId };
  h.env.PARTICIPANT_TERRA_GENERATION_ENABLED = 'on';
  h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV2 = async () => generationPin;
  h.env.PARTICIPANT_AI_PROXY.participantUsageGeneration = async () =>
    ({ status: 200, data: chatResponse(pin.terraModelId, '三角の部分がある形でしょうか？') });
  h.controlled.selectedAction = 'confirm';
  await h.receive();
  await h.approve();
  const { trial } = await jsonOk(await h.start());
  const recordId = trial.sessionId, key = 'record:' + recordId;
  for (let i = 0; i < 7; ++i) {
    await jsonOk(await h.request('message', { expectedRecordId: recordId, text: '三角の部分があります。', clientId: 'prior-' + i }));
    await h.idle();
    const saved = await h.storage.get(key);
    assert.equal(saved.queueState.errorCode, null);
    assert.equal(saved.jevTraces.at(-1).finalAction.action, 'confirm');
    assert.equal(saved.jevTraces.at(-1).decisionMenuVersion, 'action_conditioned_targets_v1');
    assert.equal(Object.hasOwn(saved.jevTraces.at(-1).decisions[0].evidence.scores.action, 'propose_name'), false);
  }
  h.controlled.rejectJev = true;
  const event = await jsonOk(await h.request('message', { expectedRecordId: recordId,
    clientId: 'synthetic-event-16', text: 'この図形は塔と呼びたいです。続けましょう。' }));
  await h.idle();
  const before = await h.storage.get(key);
  assert.equal(event.eventId, 'event-16');
  assert.deepEqual(before.queueState.pendingHumanEventIds, [event.eventId]);
  assert.equal(before.queueState.errorCode, 'ai_unavailable');
  assert.ok(Object.values(before.queueState.privateState.ledger).every((row: any) => row.status === 'unassigned'));
  const calls = h.calls.length;
  h.evict();
  assert.equal((await jsonOk(await h.request('state'))).trial.events.at(-1).id, event.eventId);
  assert.equal(h.calls.length, calls);
  h.controlled.rejectJev = false;
  h.controlled.selectedAction = 'defer';
  await jsonOk(await h.request('retry', { expectedRecordId: recordId }));
  await h.idle();
  const after = await h.storage.get(key);
  assert.equal(after.queueState.errorCode, null);
  assert.deepEqual(after.queueState.pendingHumanEventIds, []);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.jevTraces.at(-1).lastEventId, event.eventId);
  assert.equal(after.jevTraces.at(-1).decisionMenuVersion, 'action_conditioned_targets_v1');
  assert.equal(after.jevTraces.at(-1).intervention.disposition, 'rejected');
  assert.deepEqual(after.queueState.privateState.judgments.slice(0, before.queueState.privateState.judgments.length),
    before.queueState.privateState.judgments);
  h.evict();
  assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, recordId);
});

test('a restored reserved turn waits for the existing explicit retry and preserves its client ID', async () => {
  const h = harness();
  await h.receive();
  await h.approve();
  const { trial } = await jsonOk(await h.start());
  let reject!: (error: Error) => void;
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>((_resolve, fail) => { reject = fail; });
  h.controlled.holdChoice = () => { started(); return hold; };
  const body = { expectedRecordId: trial.sessionId, clientId: 'synthetic-event', text: '合成の手掛かりです。' };
  const accepted = await jsonOk(await h.request('message', body));
  await reached;
  const key = 'record:' + trial.sessionId;
  const owner = await h.storage.get('base:owner:v1');
  const interrupted = await h.storage.get(key);
  const journalKey = 'participant-usage:' + interrupted.assignment.assignmentId;
  const journal = await h.storage.get(journalKey);
  assert.equal(interrupted.queueState.errorCode, null);
  assert.deepEqual(interrupted.queueState.pendingHumanEventIds, [accepted.eventId]);
  assert.equal(journal.latest.jev.status, 'reserved');
  assert.deepEqual((await h.adminRecord(trial.sessionId)).jevLedger, journal);

  // Drop the interrupted instance. Preserve the pre-response storage snapshot,
  // including the independently committed provider reservation.
  reject(new Error('synthetic interruption'));
  await h.idle();
  delete h.controlled.holdChoice;
  await h.storage.transaction(tx => tx.put({ [key]: interrupted, 'base:owner:v1': owner, [journalKey]: journal }));
  const sends = h.calls.length;
  for (let i = 0; i < 3; ++i) {
    h.evict();
    const state = await jsonOk(await h.request('state'));
    assert.equal(state.trial.aiStatus, 'error');
    assert.equal(state.trial.events.at(-1).id, accepted.eventId);
    assert.deepEqual((await h.storage.get(key)).queueState.pendingHumanEventIds, [accepted.eventId]);
    assert.equal(h.calls.length, sends);
  }
  assert.equal((await jsonOk(await h.request('message', body))).eventId, accepted.eventId);
  await h.idle();
  assert.equal(h.calls.length, sends);
  await jsonOk(await h.request('retry', { expectedRecordId: trial.sessionId }));
  const completed = await h.storage.get(key);
  assert.equal(completed.queueState.errorCode, null);
  assert.equal(completed.events.filter((event: any) => event.speaker === 'human').length, 1);
  assert.equal(completed.events.filter((event: any) => event.speaker === 'ai').length, 2);
  assert.ok(completed.jevLedger.phases.jev.human_referent.unknownPosts > 0);
});

test('unknown and mixed profiles fail before inference, including damaged saved records', async () => {
  for (const change of ['unknown', 'mixed', 'missing_journal', 'mixed_record']) {
    const h = harness();
    await h.receive();
    await h.approve();
    let recordId: string | undefined;
    if (change === 'missing_journal' || change === 'mixed_record') {
      recordId = (await jsonOk(await h.start())).trial.sessionId;
      h.evict();
    }
    await h.storage.transaction(async tx => {
      if (!recordId) {
        const reception = await tx.get('reception:v1');
        if (change === 'unknown') reception.plan.participantRuntimeProfile = 'future_version';
        else reception.plan.participantLimits = approvedLimits;
        await tx.put({ 'reception:v1': reception });
      } else {
        const owner = await tx.get('base:owner:v1');
        const record = owner.admissions[owner.activeKey].record;
        if (change === 'missing_journal') await tx.delete('participant-usage:' + record.assignment.assignmentId);
        else {
          record.jevLedger.limits = approvedLimits;
          await tx.put({ 'base:owner:v1': owner, ['record:' + recordId]: record });
        }
      }
    });
    const sends = h.calls.length;
    const rejected = recordId ? await h.request('state') : await h.start();
    assert.equal(rejected.status, 409);
    assert.equal(h.calls.length, sends);
  }
});

test('unavailable policy refuses approval, and a pin changed after approval refuses trial start without sending', async () => {
  const h = harness();
  await h.receive();
  const usagePolicy = h.env.PARTICIPANT_AI_PROXY.participantUsagePolicy;
  h.env.PARTICIPANT_AI_PROXY.participantUsagePolicy = async () => { throw new Error('old proxy'); };
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  h.env.PARTICIPANT_AI_PROXY.participantUsagePolicy = usagePolicy;
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
      assert.equal(saved.jevLedger.halted, true);
      assert.equal(saved.jevLedger.latest[role].status, 'model_mismatch');
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
      // Workers' fetch rejects redirect 'error' with a TypeError; only 'follow' and 'manual' exist there, and a redirect must never be followed with the key.
      assert.equal(init?.redirect, 'manual');
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return Response.json({ model, id: 'gen-synthetic', answers: answers(questions), usage: { cost: 0 }, raw: 'RAW_CANARY' });
    });
    if (model !== pin.jevModelId) assert.deepEqual(response, { status: 502, data: { error: 'model_mismatch' } });
    else {
      assert.equal(response.status, 200);
      assert.equal('raw' in response.data, false);
    }
  }
  // A redirect is handed back unfollowed and refused; neither choices path forwards the key to another host.
  for (const choices of [participantChoices, participantUsageChoices]) {
    for (const status of [301, 302, 307, 308]) {
      const redirected = await choices(settings, body, pin.jevModelId, async () => new Response(null, { status, headers: { Location: 'https://other.invalid/' } }));
      assert.deepEqual(redirected, { status: 502, data: { error: 'upstream_error' } });
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

const v12Dialogue = 'participant_dialogue_v12';
const v13Dialogue = 'participant_dialogue_v13_p5';
const v13NamingV4Dialogue = 'participant_dialogue_v13_p5_naming_v4';
const p5Question = 'どのような形に見えますか？';
const p5Reading = '鳥のような形に見えます。';
const p5Support = '私にも鳥に見えます。';
const v12Check = '細い部分がつながっています。そちらの形にも半円の切り込みがありますか？';
const v12Answer = 'はい、こちらの形にも半円の切り込みがあります。';

function v12Transport(t: TestContext, h: ReturnType<typeof harness>) {
  const env = h.env;
  const proxy = new InternalParticipantProxy({}, { ...settings, VISION_MODEL: pin.terraModelId });
  const lookup = () => proxy.participantUsagePolicyV3();
  env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'on';
  env.PARTICIPANT_AI_PROXY.participantUsagePolicyV3 = lookup;
  env.PARTICIPANT_AI_PROXY.participantUsageGeneration = (body, expected) => proxy.participantUsageGeneration(body, expected);
  h.controlled.usageChat = (body, expected) => proxy.participantUsageChat(body, expected);
  h.controlled.selectedAction = 'confirm';
  let slots: string[] = [];
  let decisionSlot: string;
  const visualSource = () => ({ figureId: decisionSlot, path: ['analytic', 'shapes', 0] });
  const textPhases: string[] = [];
  const prompts: { phase: string; system: string[] }[] = [];
  const options = { wrongPhase: '', rewrite: false, quotedDraft: false, sharedReading: false, structuredConfirmation: false,
    failVisualExtraction: false };
  function segment(quote: string, aspect: string, targets: string[], respondsToTurn: number | null = null) {
    return { segmentId: quote.slice(0, 4), quote, aspect, targets, proposition: quote, name: null, linkedIssueId: null, respondsToTurn };
  }
  h.controlled.choose = (name, body) => {
    const material = JSON.parse(body.state);
    const criteria = body.questions[name].criteria;
    if (name === 'human_referent' || name === 'target') return 'figure_0';
    if (options.sharedReading && name === 'shared_construal') return 'use_0';
    if (options.sharedReading && /^segment_\d+_act$/u.test(name)) return material.aiSeq !== undefined ? 'construe' : 'agree';
    if (/^segment_\d+_act$/u.test(name)) {
      return material.aiSeq !== undefined
        ? Number(name.split('_')[1]) === 1 ? 'ask' : 'assert' : 'agree';
    }
    if (/^segment_\d+_answer$/u.test(name)) return options.sharedReading ? 'unknown' : 'answers_checked_point';
    if (name.endsWith('_antecedent') && material.aiSeq === undefined) {
      const index = material.priorClaims?.findLastIndex((c: { act: string }) => c.act === (options.sharedReading ? 'construe' : 'ask'));
      return index >= 0 && Object.hasOwn(criteria, 'claim_' + index) ? 'claim_' + index : 'none';
    }
    return undefined;
  };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, pin.terraModelId);
    const first = String(body.messages[0].content), last = String(body.messages.at(-1).content);
    let phase: string, response: string;
    if (body.messages.some((message: { content: unknown }) => Array.isArray(message.content))) {
      const args = JSON.parse(body.messages[1].content);
      if (args.figureIds) {
        phase = 'reobservation';
        response = JSON.stringify({ figures: args.figureIds.map((figureId: string) =>
          ({ figureId, supports: ['半円の切り込みがある'], contradicts: [], unknown: [] })) });
      } else {
        phase = 'initial_observation';
        slots = args.ownAnchors.map(({ id }: { id: string }) => id);
        response = JSON.stringify({ figures: slots.map(id => ({ id, holistic: [],
          analytic: { shapes: ['半円の切り込み'], composition: '細い部分がつながる', relations: [] }, unknowns: [] })) });
      }
    } else if (first === memoExtractionPrompt(true, false) || first === memoExtractionPrompt(true, true) ||
        first === memoExtractionPrompt(true, false, SHAPE_TERMINOLOGY_GENERATION) ||
        first === memoExtractionPrompt(true, true, SHAPE_TERMINOLOGY_GENERATION)) {
      phase = 'dialogue';
      const state = JSON.parse(body.messages.slice(1).map((m: { content: string }) => m.content.split('\n').at(-1)).join(''));
      const latest = state.publicTurns.at(-1);
      decisionSlot = state.ownSlots[0];
      response = JSON.stringify(options.sharedReading
        ? latest.text === p5Support ? [segment(p5Support, 'construal', [decisionSlot], latest.turn - 1)] : []
        : latest.text === v12Answer ? [segment(v12Answer, 'contour', [], latest.turn - 1)] : []);
    } else if (first === memoAiExtractionPrompt(SHAPE_TERMINOLOGY_GENERATION, true)) {
      phase = 'ai_extraction';
      if (options.failVisualExtraction) {
        options.failVisualExtraction = false;
        return new Response(null, { status: 502 });
      }
      const { candidateText } = JSON.parse(body.messages.slice(1).map((m: { content: string }) => m.content.split('\n').at(-1)).join(''));
      assert.equal(candidateText, v12Check);
      response = JSON.stringify({ segments: [], visualFeatures: { sources: [
        { source: visualSource(), quote: 'そちらの形にも半円の切り込みがありますか？' },
      ] } });
    } else if (first === MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS || first === memoAiExtractionPrompt(SHAPE_TERMINOLOGY_GENERATION)) {
      phase = 'ai_extraction';
      if (options.sharedReading) {
        const { candidateText } = JSON.parse(body.messages[1].content);
        response = JSON.stringify(candidateText === p5Reading ? [segment(p5Reading, 'construal', [decisionSlot])] : []);
      } else {
        response = JSON.stringify([segment('細い部分がつながっています。', 'part', [decisionSlot]),
          segment('そちらの形にも半円の切り込みがありますか？', 'question', [])]);
      }
    } else if (body.messages.some((message: { content: unknown }) => String(message.content).includes(VISUAL_FEATURE_DRAFT_V19))) {
      phase = 'generation';
      response = JSON.stringify({ text: v12Check, observationFeatures: [visualSource()] });
    } else if (options.structuredConfirmation && body.messages.some((message: { content: unknown }) =>
      String(message.content).includes('checkedFeatureとtext'))) {
      phase = last.includes('公開発話を書き直してください') ? 'rewrite' : 'generation';
      response = JSON.stringify({ checkedFeature: '半円の切り込み', text: v12Check });
    } else if (last.includes('JSON')) {
      phase = 'final_submission';
      response = JSON.stringify(Object.fromEntries(slots.map(id => [id, null])));
    } else {
      phase = last.includes('公開発話を書き直してください') ? 'rewrite' : 'generation';
      response = options.sharedReading ? (last === p5Question ? p5Reading : 'なるほど。')
        : options.rewrite && phase === 'generation' ? 'human_referent'
        : options.quotedDraft ? v12Check + '「輪」に見えるところを教えてください。' : v12Check;
      options.rewrite = false;
    }
    assert.doesNotMatch(JSON.stringify(body), /participantModelPin|service-binding-only|ANSWER_KEY_CANARY/u);
    textPhases.push(phase);
    prompts.push({ phase, system: body.messages.filter((message: { role: string }) => message.role === 'system')
      .map((message: { content: unknown }) => String(message.content)) });
    return Response.json(chatResponse(options.wrongPhase === phase ? pin.lunaModelId : pin.terraModelId, response));
  });
  return { lookup, options, textPhases, prompts,
    observationPolicy: (generation?: InitialObservationGeneration) => proxy.participantInitialObservationPolicy(generation) };
}

test('Terra preobserve keeps the approved P5 pin, accounts a shared board once, and starts from the cache after eviction', async t => {
  const h = harness(true, figureBankProtocol, true);
  const transport = v12Transport(t, h);
  h.env.PARTICIPANT_DIALOGUE_PROFILE = v13NamingV4Dialogue;
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = INITIAL_OBSERVATION_STRUCTURED_V1;
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = transport.observationPolicy;
  await h.receive();
  const [result, duplicate] = await Promise.allSettled([h.approve(), h.approve()]);
  assert.equal(result.status, 'fulfilled');
  assert.equal(duplicate.status, 'rejected');
  if (result.status !== 'fulfilled' || duplicate.status !== 'rejected') assert.fail();
  assert.equal(duplicate.reason.code, 'reception_conflict');
  const approved = result.value;
  assert.equal(approved.plan.participantDialogueProfile, v13NamingV4Dialogue);
  assert.equal(approved.plan.participantModelPin.schemaVersion, 'participant_model_pin_v3');
  await h.settleBackground();
  assert.deepEqual(transport.textPhases, ['initial_observation']);
  assert.equal((await h.storage.get('base:owner:v1')).activeKey, null);
  assert.deepEqual((await h.storage.get('reception:v1')).trials, []);
  const usagePath = '/admin/reception/' + approved.receptionId + '/usage.json';
  assert.equal((await h.admin(usagePath, false)).status, 401);
  const exported = await jsonOk(await h.admin(usagePath));
  assert.deepEqual(exported.failedStarts, []);
  assert.equal(exported.preobservations.length, 1);
  const [warm] = exported.preobservations;
  assert.deepEqual(warm.trialIndices, [0, 1]);
  assert.equal(warm.status, 'ready');
  assert.ok(Date.parse(warm.finishedAt) >= Date.parse(warm.startedAt));
  assert.equal(warm.usage.assignmentId, undefined);
  assert.deepEqual(warm.usage.returnedModels.terra.initial_observation, { model: pin.terraModelId, ok: 1 });
  const meter = warm.usage.phases.terra.initial_observation;
  assert.deepEqual([meter.calls, meter.posts, meter.unknownPosts, meter.inputTokens, meter.outputTokens, meter.missingCostPosts], [1, 1, 0, 5, 3, 1]);
  h.evict();
  assert.deepEqual(await jsonOk(await h.admin(usagePath)), exported);
  const start = await jsonOk(await h.start());
  const record = await h.storage.get('record:' + start.trial.sessionId);
  const initial = record.jevLedger.phases.terra.initial_observation;
  assert.deepEqual([initial.calls, initial.posts, initial.cacheHits], [1, 0, 1]);
  assert.deepEqual(transport.textPhases, ['initial_observation']);
  assert.doesNotMatch(JSON.stringify(start), /preobservations|returnedModels|terra_initial_observation|gpt-6|ownAnchors|knownUsd/u);
  await h.complete(start.trial.sessionId, start.trial);
  const second = await jsonOk(await h.start(start.trial.sessionId));
  const secondRecord = await h.storage.get('record:' + second.trial.sessionId);
  const secondInitial = secondRecord.jevLedger.phases.terra.initial_observation;
  assert.deepEqual([secondInitial.posts, secondInitial.cacheHits], [0, 1]);
  assert.deepEqual(transport.textPhases.filter(phase => phase === 'initial_observation'), ['initial_observation']);
});

test('Terra preobserve v2 keeps approval, start and first response timing private across eviction', async t => {
  const h = harness(true, figureBankProtocol, true);
  const transport = v12Transport(t, h);
  h.env.PARTICIPANT_DIALOGUE_PROFILE = v13NamingV4Dialogue;
  const env = h.env.PARTICIPANT_AI_PROXY;
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = INITIAL_OBSERVATION_STRUCTURED_V2;
  await h.receive();
  env.participantInitialObservationPolicy = () => transport.observationPolicy();
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  assert.equal(transport.textPhases.length, 0);
  env.participantInitialObservationPolicy = transport.observationPolicy;
  const approved = await h.approve();
  assert.equal(approved.plan.initialObservationGeneration, INITIAL_OBSERVATION_STRUCTURED_V2);
  await h.settleBackground();

  env.participantInitialObservationPolicy = () => transport.observationPolicy();
  assert.equal((await h.start()).status, 409);
  assert.deepEqual((await h.storage.get('reception:v1')).trials, []);
  env.participantInitialObservationPolicy = transport.observationPolicy;
  const start = await jsonOk(await h.start());
  const recordId = start.trial.sessionId;
  assert.deepEqual(transport.textPhases, ['initial_observation']);
  await jsonOk(await h.request('message', { expectedRecordId: recordId, text: '細い部分が目印になりそうですね。' }));
  await h.idle();
  h.evict();
  const participant = await jsonOk(await h.request('state'));
  assert.doesNotMatch(JSON.stringify([start, participant]), /startRequestReceivedAt|initialMemoReadStartedAt|initialMemoReadyAt|trialStartedAt|firstHumanReceivedAt|firstAiReplyAt|initialObservationCacheHit/u);

  const path = '/admin/reception/' + approved.receptionId + '/usage.json';
  assert.equal((await h.admin(path, false)).status, 401);
  const { timing, preobservations } = await jsonOk(await h.admin(path));
  assert.equal(timing.approvedAt, approved.plan.approvedAt);
  assert.equal(preobservations.length, 1);
  assert.deepEqual(preobservations[0].trialIndices, [0, 1]);
  const [clock] = timing.trials;
  assert.equal(clock.trialIndex, 0);
  assert.equal(clock.initialObservationCacheHit, true);
  const times = [timing.approvedAt, preobservations[0].startedAt, preobservations[0].finishedAt,
    clock.startRequestReceivedAt, clock.initialMemoReadStartedAt, clock.initialMemoReadyAt, clock.trialStartedAt,
    clock.firstHumanReceivedAt, clock.firstAiReplyAt].map(Date.parse);
  assert.ok(times.every((time, i) => Number.isFinite(time) && (i === 0 || time >= times[i - 1])));
  assert.equal(transport.textPhases.filter(p => p === 'initial_observation').length, 1);
});

async function verifyPilot012WorkerProfile(t: TestContext,
  participantProfile: typeof PILOT012_PARTICIPANT_PROFILE | typeof PILOT012_V18_PARTICIPANT_PROFILE | typeof PILOT012_V19_PARTICIPANT_PROFILE,
  generation: 'jev_generation_retry_v17' | typeof SHAPE_TERMINOLOGY_GENERATION | typeof VISUAL_FEATURE_GENERATION) {
  const h = harness(true, figureBankProtocol, true);
  const transport = v12Transport(t, h);
  transport.options.sharedReading = true;
  h.controlled.selectedAction = 'accept';
  h.env.PARTICIPANT_DIALOGUE_PROFILE = participantProfile;
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = transport.observationPolicy;
  await h.receive();

  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = INITIAL_OBSERVATION_STRUCTURED_V1;
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  assert.equal((await h.storage.get('reception:v1')).plan, null);
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = undefined;

  const { plan } = await h.approve();
  assert.equal(plan.participantDialogueProfile, participantProfile);
  assert.equal(plan.participantModelPin.schemaVersion, 'participant_model_pin_v3');
  assert.equal(plan.memoryPruneVersion, CLAIM_PRUNE_V3);
  assert.equal(plan.initialObservationGeneration, INITIAL_OBSERVATION_STRUCTURED_V2);
  assert.throws(() => validateReceptionPlan({ ...plan, memoryPruneVersion: CLAIM_PRUNE_V2 }));
  assert.throws(() => validateReceptionPlan({ ...plan, initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V1 }));
  assert.throws(() => validateReceptionPlan({ ...plan, participantDialogueProfile: v13NamingV4Dialogue }));
  await h.settleBackground();

  h.env.PARTICIPANT_DIALOGUE_PROFILE = participantProfile === PILOT012_PARTICIPANT_PROFILE
    ? PILOT012_V18_PARTICIPANT_PROFILE : PILOT012_PARTICIPANT_PROFILE;
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = INITIAL_OBSERVATION_STRUCTURED_V1;
  h.evict();
  let predecessor: string | undefined;
  for (const strategy of plan.order) {
    const { trial } = await jsonOk(await h.start(predecessor));
    assert.equal(trial.scene.shapes.length, 6);
    const id = trial.sessionId;
    const key = 'record:' + id;
    const start = await h.storage.get(key);
    assert.equal(start.strategy, strategy);
    assert.deepEqual(start.assignment.source.plan, plan);
    assert.deepEqual(start.options.participantModelPin, plan.participantModelPin);
    assert.equal(start.options.participantDialogueProfile, participantProfile);
    assert.equal(start.options.initialObservationGeneration, INITIAL_OBSERVATION_STRUCTURED_V2);
    assert.equal(start.options.memoryPruneVersion, CLAIM_PRUNE_V3);
    assert.equal(start.queueState.privateState.graph.memoryPruneVersion, CLAIM_PRUNE_V3);
    assert.equal(start.queueState.privateState.agreeNameScopeVersion, 'jev_naming_v1');
    assert.equal(start.options.generationRetryVersion, generation);
    assert.equal(start.options.dialoguePolicy, 'holistic_v5');
    assert.equal(start.options.questionLayout, 'two_stage_v3');
    assert.equal(start.options.interventionPolicy.version, 'bypass_acceptance_v2');
    assert.deepEqual(start.options.technicalTrial, { version: 'adaptive_repair_v3' });
    assert.equal(start.events[0].origin, 'generated_opening');
    assert.doesNotMatch(JSON.stringify(trial), /participantDialogueProfile|claim_prune_v3|jev_repair_quality_v1|structured_outputs_v2/u);

    const callStart = h.calls.length;
    await jsonOk(await h.request('message', { expectedRecordId: id, text: p5Question }));
    await h.idle();
    const stored = await h.storage.get(key);
    assert.equal(stored.queueState.errorCode, null);
    assert.equal(stored.jevTraces.at(-1).status, 'committed');
    const action = h.calls.slice(callStart).find(call => call.kind === 'choices' && Object.hasOwn(call.body.questions, 'action'));
    assert.ok(action);
    const material = JSON.parse(action.body.state);
    assert.equal(material.judgmentMaterialVersion, 'jev_repair_quality_v1');
    assert.ok(material.referenceEvidence);
    assert.equal(material.visualPurposeVersion, generation === VISUAL_FEATURE_GENERATION ? 'jev_visual_purpose_v1' : undefined);

    const sent = [...transport.textPhases];
    h.evict();
    const restored = (await jsonOk(await h.request('state'))).trial;
    assert.equal(restored.sessionId, id);
    assert.deepEqual(transport.textPhases, sent);
    assert.deepEqual((await h.storage.get(key)).queueState.privateState, stored.queueState.privateState);
    await h.complete(id, restored);
    predecessor = id;
  }
  assert.equal(transport.textPhases.filter(phase => phase === 'initial_observation').length, 1);
}

test('pilot012 pins the integrated versions at approval and preserves them through both trials and cold restore',
  t => verifyPilot012WorkerProfile(t, PILOT012_PARTICIPANT_PROFILE, 'jev_generation_retry_v17'));

test('pilot012 v18 pins the terminology generation at approval and preserves it through both trials and cold restore',
  t => verifyPilot012WorkerProfile(t, PILOT012_V18_PARTICIPANT_PROFILE, SHAPE_TERMINOLOGY_GENERATION));

test('pilot012 v19 preserves the approved six-figure profile through both trials and cold restore',
  t => verifyPilot012WorkerProfile(t, PILOT012_V19_PARTICIPANT_PROFILE, VISUAL_FEATURE_GENERATION));

test('Terra preobserve makes a separate validated memo for each distinct frozen AI board', async () => {
  const h = harness(true, { ...figureBankProtocol, figureSetPolicy: 'per_trial',
    figureSelection: { mode: 'seeded_random', selectionSeed: 201 } }, true);
  await h.receive();
  const approved = await h.approve();
  await h.settleBackground();
  const visual = h.calls.filter(({ kind }) => kind === 'visual_observation');
  assert.equal(visual.length, 2);
  for (const { seed, rotationMode, figureSelection } of approved.plan.trials) {
    const model = modelView(createTrialV2({ seed, rotationMode, figureSelection }));
    const expected = buildObservationMessages({
      ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') },
      ownAnchors: [...model.anchors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    });
    assert.equal(visual.filter(({ body }) => JSON.stringify(body.messages) === JSON.stringify(expected)).length, 1);
  }
  const entries = await h.storage.list('terra_initial_observation_v1:');
  assert.equal(entries.size, 2);
  const { preobservations } = await jsonOk(await h.admin('/admin/reception/' + approved.receptionId + '/usage.json'));
  assert.deepEqual(preobservations.map(({ trialIndices }: any) => trialIndices[0]).sort(), [0, 1]);
  for (const { status, usage } of preobservations) {
    assert.equal(status, 'ready');
    assert.equal(usage.phases.terra.initial_observation.posts, 1);
  }
});

test('Terra preobserve joins a concurrent start after approval returns while Terra is still running', { timeout: 10_000 }, async () => {
  const h = harness(true, protocol, true);
  const entered = gate(), release = gate(), reading = gate();
  h.controlled.onStartObservationRead = reading.resolve;
  let visualPosts = 0;
  h.controlled.usageChat = async ({ purpose }) => {
    assert.equal(purpose, 'visual_observation');
    ++visualPosts;
    entered.resolve();
    await release.promise;
  };
  await h.receive();
  const approved = await h.approve();
  await entered.promise;
  const { preobservations } = await jsonOk(await h.admin('/admin/reception/' + approved.receptionId + '/usage.json'));
  assert.equal(preobservations[0].status, 'preparing');
  assert.equal(preobservations[0].usage.phases.terra.initial_observation.unknownPosts, 1);
  const start = h.start();
  try {
    await reading.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(visualPosts, 1);
  } finally { release.resolve(); }
  const { trial } = await jsonOk(await start);
  await h.settleBackground();
  const record = await h.storage.get('record:' + trial.sessionId);
  assert.equal(visualPosts, 1);
  assert.deepEqual([record.jevLedger.phases.terra.initial_observation.posts,
    record.jevLedger.phases.terra.initial_observation.cacheHits], [0, 1]);
});

test('Terra preobserve does not warm an old approved reception on eviction or approval replay', async () => {
  const h = harness();
  await h.receive();
  const approved = await h.approve();
  h.evict(true);
  const duplicate = h.approve();
  await assert.rejects(duplicate, { code: 'reception_conflict' });
  await h.settleBackground();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await jsonOk(await h.admin('/admin/reception/' + approved.receptionId + '/usage.json')),
    { receptionId: approved.receptionId, failedStarts: [] });
  await jsonOk(await h.start());
  assert.deepEqual(h.calls.map(({ kind }) => kind), ['visual_observation']);
});

test('Terra preobserve leaves approvals using the legacy capped ledger on their existing start path', async () => {
  const h = harness(true, protocol, true);
  h.env.PARTICIPANT_TERRA_PROFILE = undefined;
  await h.receive();
  const approved = await h.approve();
  await h.settleBackground();
  assert.deepEqual(approved.plan.participantLimits, approvedLimits);
  assert.deepEqual(h.calls, []);
  await jsonOk(await h.start());
  assert.deepEqual(h.calls.map(({ kind }) => kind), ['visual_observation']);
});

for (const failure of ['invalid_response', 'timeout', 'interrupted', 'cold_restart']) {
  test('Terra preobserve falls back after ' + failure + ' and preserves separate usage', async () => {
    const h = harness(true, protocol, true);
    const entered = gate(), interrupt = gate();
    const bodies: string[] = [];
    h.controlled.usageChat = async (body, expected) => {
      assert.equal(expected, pin.terraModelId);
      bodies.push(JSON.stringify(body));
      if (bodies.length > 1) return;
      entered.resolve();
      if (failure === 'timeout') return { status: 504, data: { error: 'synthetic_private_timeout' } };
      if (failure === 'cold_restart') {
        await interrupt.promise;
        throw new Error('synthetic proxy interruption');
      }
      if (failure === 'interrupted') throw new Error('synthetic proxy interruption');
      return { status: 200, data: { ...chatResponse(pin.terraModelId, '{}'),
        usage: { cost: 0.021, prompt_tokens: 17, completion_tokens: 6 } } };
    };
    await h.receive();
    const approved = await h.approve();
    try {
      await entered.promise;
      if (failure === 'cold_restart') h.evict();
      else await h.settleBackground();
      const { trial } = await jsonOk(await h.start());
      const record = await h.storage.get('record:' + trial.sessionId);
      assert.deepEqual([record.jevLedger.phases.terra.initial_observation.posts,
        record.jevLedger.phases.terra.initial_observation.cacheHits], [1, 0]);
      assert.deepEqual(bodies, [bodies[0], bodies[0]]);
      const { preobservations } = await jsonOk(await h.admin('/admin/reception/' + approved.receptionId + '/usage.json'));
      const [warm] = preobservations;
      assert.equal(warm.status, failure === 'cold_restart' ? 'unconfirmed' : 'failed');
      assert.equal(warm.usage.phases.terra.initial_observation.posts, 1);
      assert.equal(warm.usage.phases.terra.initial_observation.unknownPosts, failure === 'invalid_response' ? 0 : 1);
      if (failure === 'invalid_response') {
        assert.deepEqual(warm.usage.returnedModels.terra.initial_observation, { model: pin.terraModelId, ok: 1 });
        assert.equal(warm.usage.phases.terra.initial_observation.knownUsd, 0.021);
      }
      if (failure === 'timeout') assert.equal(warm.errorCode, 'timeout');
    } finally {
      interrupt.resolve();
      await h.settleBackground();
    }
  });
}

test('human-led move-on keeps the v15 pin and requires its committed trace on cold restore', async t => {
  const h = harness(true, { ...figureBankProtocol, allowedOrders: [['repair-first', 'bypass-enabled']] });
  v12Transport(t, h);
  const profile = 'participant_dialogue_v13_p5_human_led_move_on';
  h.env.PARTICIPANT_DIALOGUE_PROFILE = profile;
  const choose = h.controlled.choose;
  h.controlled.choose = (name, body) => name === 'human_move_on_source' ? 'human_request'
    : name === 'target' ? 'none' : choose?.(name, body);
  h.controlled.selectedAction = 'move_on';
  await h.receive();
  const approval = await h.approve();
  assert.equal(approval.plan.participantDialogueProfile, profile);
  const { trial } = await jsonOk(await h.start());
  const id = trial.sessionId;
  await jsonOk(await h.request('message', { expectedRecordId: id, text: 'いったん別の話に移りたいです。' }));
  await h.idle();
  const recordKey = 'record:' + id;
  const record = await h.storage.get(recordKey);
  assert.equal(record.queueState.errorCode, null);
  assert.equal(record.options.generationRetryVersion, 'jev_generation_retry_v15');
  assert.equal(record.queueState.privateState.agreeNameScopeVersion, 'scoped_v11');
  assert.equal(record.options.interventionPolicy.version, 'bypass_acceptance_v2');
  assert.equal(record.jevTraces[0].intervention.reasonCode, 'human_led_move_on');
  const posts = h.calls.length;
  h.env.PARTICIPANT_DIALOGUE_PROFILE = 'participant_dialogue_v13_p5_semantic_guard';
  h.evict();
  const restored = await jsonOk(await h.request('state'));
  assert.equal(restored.trial.sessionId, id);
  assert.equal(h.calls.length, posts);
  assert.doesNotMatch(JSON.stringify(restored), /humanMoveOn|human_move_on_source|interventionPolicy|bypass_acceptance_v2/u);

  const missingTrace = { ...record, jevTraces: [] };
  await h.storage.transaction(async tx => {
    const owner = await tx.get('base:owner:v1');
    owner.admissions[owner.activeKey].record = missingTrace;
    await tx.put({ 'base:owner:v1': owner, [recordKey]: missingTrace });
  });
  h.evict();
  const rejected = await h.request('state');
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: 'trial_unavailable' });
  assert.equal(h.calls.length, posts);
});

for (const strategy of ['repair-first', 'bypass-enabled']) {
  test('#206 Worker interrupt pauses a failed ' + strategy + ' turn across cold restore', async t => {
    const order = strategy === 'repair-first' ? ['repair-first', 'bypass-enabled'] : ['bypass-enabled', 'repair-first'];
    const h = harness(true, { ...figureBankProtocol, allowedOrders: [order] });
    const transport = v12Transport(t, h);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = 'participant_dialogue_v12_naming_v4';
    const interrupt = (expectedRecordId: string, authenticated = true) => h.browserRequest(
      new Request('https://session.invalid/api/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
          ...(authenticated ? { Cookie: 'tangram_session=' + 'c'.repeat(64) } : {}) },
        body: JSON.stringify({ expectedRecordId }),
      }),
    );
    const assertError = async (response: Response, status: number, error: string) => {
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    };

    await h.receive();
    await h.approve();
    const { trial } = await jsonOk(await h.start());
    const id = trial.sessionId;
    const key = 'record:' + id;
    await assertError(await interrupt(id), 409, 'ai_busy');

    h.controlled.rejectJev = true;
    const { eventId } = await jsonOk(await h.request('message', {
      expectedRecordId: id, clientId: 'pause-synthetic', text: 'この形を確認したいです。',
    }));
    await h.idle();
    assert.equal((await jsonOk(await h.request('state'))).trial.dialogueRecovery, 'retry');
    const failedRetry = await jsonOk(await h.request('retry', { expectedRecordId: id }));
    assert.equal(failedRetry.trial.dialogueRecovery, 'retry');
    const failed = await h.storage.get(key);
    assert.equal(failed.assignment.strategy, strategy);
    assert.equal(failed.jevLedger.halted, false);
    assert.deepEqual(failed.queueState.pendingHumanEventIds, [eventId]);
    const sends = { choices: h.calls.length, text: transport.textPhases.length };
    await assertError(await interrupt(id, false), 401, 'session_required');
    await assertError(await interrupt('stale-record-id'), 409, 'trial_changed');
    assert.deepEqual(await h.storage.get(key), failed);

    h.evict();
    const paused = (await jsonOk(await interrupt(id))).trial;
    assert.equal(paused.dialogueRecovery, 'paused');
    assert.equal(paused.aiStatus, 'error');
    assert.equal(paused.events.at(-1).id, eventId);
    const saved = await h.storage.get(key);
    assert.equal(saved.dialogueInterruption, 'participant_paused');
    assert.deepEqual(saved.events, failed.events);
    assert.deepEqual(saved.queueState, failed.queueState);
    assert.deepEqual(saved.jevTraces, failed.jevTraces);

    h.evict();
    const restored = (await jsonOk(await h.request('state'))).trial;
    assert.equal(restored.sessionId, id);
    assert.equal(restored.dialogueRecovery, 'paused');
    assert.deepEqual(restored.events, paused.events);
    assert.equal((await jsonOk(await interrupt(id))).trial.dialogueRecovery, 'paused');
    const repeatedPause = await h.storage.get(key);
    assert.deepEqual({ ...repeatedPause, updatedAt: saved.updatedAt }, saved);
    assert.equal(h.calls.length, sends.choices);
    assert.equal(transport.textPhases.length, sends.text);

    h.controlled.rejectJev = false;
    const resumed = (await jsonOk(await h.request('retry', { expectedRecordId: id }))).trial;
    assert.equal(resumed.dialogueRecovery, 'active');
    const completedTurn = await h.storage.get(key);
    assert.equal(Object.hasOwn(completedTurn, 'dialogueInterruption'), false);
    assert.deepEqual(completedTurn.queueState.pendingHumanEventIds, []);
    assert.deepEqual(completedTurn.events.slice(0, failed.events.length), failed.events);
    assert.equal(completedTurn.events.length, failed.events.length + 1);
    assert.equal(completedTurn.events.at(-1).speaker, 'ai');
    assert.equal(completedTurn.jevTraces.at(-1).lastEventId, eventId);
  });
}

for (const [status, cause] of [[504, 'observation_timeout'], [503, 'observation_unavailable']] as const) {
  test('#206 Worker initial observation records ' + cause + ' only in private usage', async t => {
    const h = harness();
    const transport = v12Transport(t, h);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = v12Dialogue;
    let visualCalls = 0;
    h.controlled.usageChat = async (body, expected) => {
      assert.equal(body.purpose, 'visual_observation');
      assert.equal(expected, pin.terraModelId);
      visualCalls++;
      return { status, data: { error: 'synthetic_private_upstream_canary' } };
    };
    await h.receive();
    const { receptionId } = await h.approve();
    const response = await h.start();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'trial_unavailable' });
    const owner = await h.storage.get('base:owner:v1');
    const entry = owner.admissions[owner.activeKey];
    assert.equal(entry.status, 'failed');
    assert.equal(entry.record, null);
    assert.equal(entry.errorCode, 'initialization_failed');
    assert.equal(entry.failureCause, cause);

    h.evict();
    const path = '/admin/reception/' + receptionId + '/usage.json';
    assert.equal((await h.admin(path, false)).status, 401);
    const exported = await jsonOk(await h.admin(path));
    assert.equal(exported.failedStarts.length, 1);
    const [failed] = exported.failedStarts;
    assert.deepEqual(
      { assignmentId: failed.assignmentId, trialIndex: failed.trialIndex, errorCode: failed.errorCode, failureCause: failed.failureCause },
      { assignmentId: entry.assignment.assignmentId, trialIndex: 0, errorCode: 'initialization_failed', failureCause: cause },
    );
    const meter = failed.usage.phases.terra.initial_observation;
    assert.equal(meter.posts, 1);
    assert.doesNotMatch(JSON.stringify(exported), /synthetic_private_upstream_canary/u);
    assert.equal((await h.start()).status, 409);
    assert.equal(visualCalls, 1);
    assert.deepEqual(transport.textPhases, []);
    assert.deepEqual(h.calls, []);
  });
}

for (const { order, dialogueProfile, scope } of [
  { order: ['repair-first', 'bypass-enabled'], dialogueProfile: v12Dialogue, scope: 'scoped_v7' },
  { order: ['bypass-enabled', 'repair-first'], dialogueProfile: v12Dialogue, scope: 'scoped_v7' },
  { order: ['repair-first', 'bypass-enabled'], dialogueProfile: 'participant_dialogue_v12_naming_v2', scope: 'scoped_v9' },
  { order: ['repair-first', 'bypass-enabled'], dialogueProfile: 'participant_dialogue_v12_naming_v3', scope: 'scoped_v10' },
  { order: ['repair-first', 'bypass-enabled'], dialogueProfile: 'participant_dialogue_v12_naming_v4', scope: 'scoped_v11' },
]) {
  test('U6-B v12 private Worker transport, restore, and both conditions ' + order[0] + ' ' + scope, async t => {
    const receptionProtocol = order[0] === 'repair-first' ? figureBankProtocol : protocol;
    const h = harness(true, { ...receptionProtocol, allowedOrders: [order] });
    const v12 = v12Transport(t, h);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = dialogueProfile;
    await h.receive();
    const approval = await h.approve();
    assert.equal(approval.plan.participantDialogueProfile, dialogueProfile);
    assert.equal(approval.plan.schemaVersion, receptionProtocol.schemaVersion === 'reception_protocol_v3' ? 'reception_plan_v3' : 'reception_plan_v2');
    assert.equal(approval.plan.participantModelPin.schemaVersion, 'participant_model_pin_v3');
    assert.equal(approval.plan.memoryPruneVersion, CLAIM_PRUNE_V2);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = scope === 'scoped_v7' ? undefined :
      scope === 'scoped_v9' ? v12Dialogue : 'participant_dialogue_v12_naming_v2';
    h.evict();

    const missingPrune = structuredClone(await h.storage.get('reception:v1'));
    delete missingPrune.plan.memoryPruneVersion;
    const ownerBeforeStart = await h.storage.get('base:owner:v1');
    await h.storage.transaction(tx => tx.put({ 'reception:v1': missingPrune }));
    assert.equal((await h.start()).status, 409);
    assert.deepEqual(await h.storage.get('reception:v1'), missingPrune);
    assert.deepEqual(await h.storage.get('base:owner:v1'), ownerBeforeStart);
    assert.deepEqual(v12.textPhases, []);
    await h.storage.transaction(tx => tx.put({ 'reception:v1': approval }));

    let predecessor: string | undefined;
    for (const strategy of order) {
      const { trial } = await jsonOk(await h.start(predecessor));
      const id = trial.sessionId;
      const key = 'record:' + id;
      const start = await h.storage.get(key);
      assert.equal(start.strategy, strategy);
      assert.equal(start.assignment.source.plan.participantDialogueProfile, dialogueProfile);
      assert.equal(start.assignment.source.plan.memoryPruneVersion, CLAIM_PRUNE_V2);
      assert.equal(start.options.participantDialogueProfile, dialogueProfile);
      assert.deepEqual(start.options.participantModelPin, approval.plan.participantModelPin);
      assert.equal(start.options.memoryPruneVersion, CLAIM_PRUNE_V2);
      assert.equal(start.queueState.privateState.graph.memoryPruneVersion, CLAIM_PRUNE_V2);
      assert.doesNotMatch(JSON.stringify(trial), /participantDialogueProfile|scoped_v(?:7|9|10|11)|holistic_v5|claim_prune_v2/u);
      assert.equal(start.options.questionLayout, 'two_stage_v3');
      assert.equal(start.options.dialoguePolicy, 'holistic_v5');
      assert.equal(start.options.generationRetryVersion, 'jev_generation_retry_v12');
      assert.equal(start.options.jevNamingRestoreVersion, 'ai_name_acceptances_v1');
      assert.deepEqual(start.options.technicalTrial, { version: 'adaptive_repair_v3' });
      assert.equal(start.queueState.privateState.agreeNameScopeVersion, scope);

      h.controlled.observe = true;
      v12.options.rewrite = true;
      const sendMessage = (text: string, clientId: string) => h.request('message', { expectedRecordId: id, text, clientId });
      let count = h.calls.length;
      const promptStart = v12.prompts.length;
      await jsonOk(await sendMessage('形を一つ確認したいです。', 'check'));
      await h.idle();
      const choiceCalls = h.calls.slice(count).filter(x => x.kind === 'choices');
      const turnOne = choiceCalls.map(x => Object.keys(x.body.questions));
      const checked = await h.storage.get(key);
      assert.equal(checked.queueState.errorCode, null);
      assert.equal(checked.jevTraces[0].generationGuard.regenerated, true);
      assert.equal(checked.jevTraces[0].reobservations.length, 1, JSON.stringify(turnOne));
      assert.deepEqual(checked.jevTraces[0].decisions.map((x: any) => x.evidence.stages.map((s: any) => s.stage)),
        [['action', 'target', 'detail'], ['action', 'target', 'detail']]);
      const turnPrompts = v12.prompts.slice(promptStart);
      assert.match(turnPrompts.find(p => p.phase === 'dialogue')?.system[0] ?? '', /場所しか手がかりのない部分はtargets: \[\]/u);
      for (const phase of ['generation', 'rewrite']) {
        const system = turnPrompts.find(p => p.phase === phase)?.system.join('\n') ?? '';
        assert.match(system, /場所だけでは自分のどの図形か決まりません/u);
        assert.match(system, /口調は相手の直近の発話と会話の流れに合わせ/u);
      }
      for (const key of ['human_referent', 'action', 'target', 'observe_aspect', 'feature']) {
        const prompt = choiceCalls.find(x => Object.hasOwn(x.body.questions, key))?.body.questions[key].instructions;
        assert.match(prompt ?? '', /相手の画面での図形の場所/u, key);
      }
      count = h.calls.length;
      await jsonOk(await sendMessage(v12Answer, 'answer'));
      await h.idle();
      const turnTwo = h.calls.slice(count).filter(x => x.kind === 'choices').map(x => Object.keys(x.body.questions));
      const answered = await h.storage.get(key);
      assert.equal(answered.queueState.errorCode, null);
      const last = answered.jevTraces.at(-1);
      assert.equal(last.local.claims[0]?.source, 'partner_labelled_answer',
        JSON.stringify({ local: last.local.verification, localStatus: last.local.localStatus,
          classifier: last.local.classifier?.verdicts, application: last.aiPublic?.application, turnTwo }));
      assert.equal(answered.jevTraces.at(-1).executed.action, 'confirm');
      t.diagnostic(JSON.stringify({ strategy, check: turnOne, answer: turnTwo }));

      h.controlled.rejectJev = true;
      await jsonOk(await sendMessage('もう一度形を比べたいです。', 'pending'));
      await h.idle();
      const pending = await h.storage.get(key);
      assert.equal(pending.queueState.errorCode, 'ai_unavailable');
      const pendingId = pending.queueState.pendingHumanEventIds[0];
      count = h.calls.length;
      h.evict();
      assert.equal((await jsonOk(await h.request('state'))).trial.events.at(-1).id, pendingId);
      assert.equal(h.calls.length, count);
      h.controlled.rejectJev = false;
      const retryPromptStart = v12.prompts.length;
      await jsonOk(await h.request('retry', { expectedRecordId: id }));
      await h.idle();
      const retried = await h.storage.get(key);
      assert.deepEqual(retried.queueState.pendingHumanEventIds, []);
      assert.equal(retried.jevTraces.at(-1).lastEventId, pendingId);
      assert.equal(retried.queueState.privateState.graph.memoryPruneVersion, CLAIM_PRUNE_V2);
      assert.match(v12.prompts.slice(retryPromptStart).find(p => p.phase === 'generation')?.system.join('\n') ?? '',
        /場所だけでは自分のどの図形か決まりません/u);
      await h.complete(id, (await jsonOk(await h.request('state'))).trial);
      const saved = await h.storage.get(key);
      assert.equal(saved.status, 'completed');
      assert.deepEqual(saved.jevLedger.returnedModels.luna, {});
      for (const stat of Object.values(saved.jevLedger.returnedModels.terra) as { model: string }[]) assert.equal(stat.model, pin.terraModelId);
      for (const stat of Object.values(saved.jevLedger.returnedModels.jev) as { model: string }[]) assert.equal(stat.model, pin.jevModelId);

      if (predecessor === undefined) {
        const reception = await h.storage.get('reception:v1');
        const owner = await h.storage.get('base:owner:v1');
        const calls = h.calls.length;
        await h.storage.transaction(tx => tx.put({ [key]: { ...saved, options: { ...saved.options, generationRetryVersion: 'jev_generation_retry_v11' } } }));
        assert.equal((await h.start(id)).status, 409);
        const mismatchedScope = structuredClone(saved);
        mismatchedScope.queueState.privateState.agreeNameScopeVersion = scope === 'scoped_v11' ? 'scoped_v10' : 'scoped_v11';
        await h.storage.transaction(tx => tx.put({ [key]: mismatchedScope }));
        assert.equal((await h.start(id)).status, 409);
        const missingPrune = structuredClone(saved);
        delete missingPrune.queueState.privateState.graph.memoryPruneVersion;
        await h.storage.transaction(tx => tx.put({ [key]: missingPrune }));
        assert.equal((await h.start(id)).status, 409);
        assert.deepEqual(await h.storage.get('reception:v1'), reception);
        assert.deepEqual(await h.storage.get('base:owner:v1'), owner);
        assert.equal(h.calls.length, calls);
        await h.storage.transaction(tx => tx.put({ [key]: saved }));
        h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV3 = undefined;
        assert.equal((await h.start(id)).status, 409);
        assert.deepEqual(await h.storage.get('reception:v1'), reception);
        h.env.PARTICIPANT_AI_PROXY.participantUsagePolicyV3 = v12.lookup;
      }
      predecessor = id;
    }
    assert.equal(v12.textPhases.filter(x => x === 'reobservation').length, 2);
    assert.equal(v12.textPhases.filter(x => x === 'rewrite').length, 2);
    assert.equal(v12.textPhases.filter(x => x === 'final_submission').length, 2);
    assert.equal(h.controlled.legacyCalls, 0);
  });
}

test('U6-B approval rejects unsupported environment and missing v3 before sending', async t => {
  const h = harness();
  const transport = v12Transport(t, h);
  await h.receive();
  const before = await h.storage.get('reception:v1');
  h.env.PARTICIPANT_DIALOGUE_PROFILE = 'unknown';
  await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  for (const profile of [v12Dialogue, v13Dialogue, v13NamingV4Dialogue]) {
    h.env.PARTICIPANT_DIALOGUE_PROFILE = profile;
    h.env.PARTICIPANT_TERRA_PROFILE = PARTICIPANT_PRODUCTION_PROFILE;
    h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = undefined;
    await assert.rejects(h.approve(), { code: 'reception_unavailable' });
    h.env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED = 'on';
    h.env.PARTICIPANT_TERRA_PROFILE = undefined;
    await assert.rejects(h.approve(), { code: 'reception_unavailable' });
  }
  assert.deepEqual(await h.storage.get('reception:v1'), before);
  assert.deepEqual(transport.textPhases, []);
  assert.deepEqual(h.calls, []);
});

for (const phase of ['initial_observation', 'dialogue', 'reobservation', 'generation', 'rewrite', 'ai_extraction', 'final_submission']) {
  test('U6-B rejects a mismatched Terra model during ' + phase, async t => {
    const h = harness();
    const transport = v12Transport(t, h);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = v12Dialogue;
    await h.receive();
    await h.approve();
    transport.options.wrongPhase = phase;
    const started = await h.start();
    if (phase === 'initial_observation') {
      assert.equal(started.status, 409);
      assert.deepEqual(await started.json(), { error: 'trial_unavailable' });
      assert.deepEqual(transport.textPhases, [phase]);
      return;
    }
    const { trial } = await jsonOk(started);
    const id = trial.sessionId;
    if (phase === 'final_submission') {
      const submitted = await h.request('names', { expectedRecordId: id, confirm: true, expectedEventCount: trial.events.length,
        names: Object.fromEntries(trial.scene.shapes.map(({ id }: { id: string }) => [id, null])) });
      assert.notEqual(submitted.status, 200);
      const record = await h.storage.get('record:' + id);
      assert.equal(record.aiSubmission, null);
      assert.equal(record.jevLedger.halted, true);
    } else {
      transport.options.rewrite = phase === 'rewrite';
      h.controlled.observe = phase === 'reobservation';
      await jsonOk(await h.request('message', { expectedRecordId: id, text: '形を一つ確認したいです。' }));
      await h.idle();
      const record = await h.storage.get('record:' + id);
      assert.equal(record.queueState.errorCode, 'ai_unavailable');
      assert.equal(record.jevLedger.halted, true);
      assert.equal(record.queueState.privateState.judgments.length, 0);
      assert.ok(!record.events.some((e: { text: string }) => e.text === v12Check));
    }
    assert.equal(transport.textPhases.at(-1), phase);
  });
}

for (const stage of ['human_referent', 'action', 'target', 'observe_targets', 'feature',
  'local_answer', 'ai_function', 'ai_support', 'repair_issue', 'draft_naming']) {
  test('U6-B rejects a mismatched Jev model during ' + stage, async t => {
    const h = harness();
    const transport = v12Transport(t, h);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = v12Dialogue;
    await h.receive();
    await h.approve();
    const { trial } = await jsonOk(await h.start());
    const id = trial.sessionId;
    const send = (text: string) => h.request('message', { expectedRecordId: id, text });
    const prior = stage === 'local_answer' || stage === 'repair_issue';
    if (prior) {
      await jsonOk(await send('形を一つ確認したいです。'));
      await h.idle();
    }
    transport.options.quotedDraft = stage === 'draft_naming';
    h.controlled.observe = stage === 'observe_targets';
    let mismatches = 0;
    h.controlled.wrongChoiceModel = questions => {
      const keys = Object.keys(questions);
      const mismatch = stage === 'local_answer' ? keys.some(k => k.endsWith('_answer'))
        : stage === 'ai_function' ? keys.some(k => k.endsWith('_act')) && !keys.some(k => k.endsWith('_answer'))
          : stage === 'ai_support' ? keys.some(k => k.endsWith('_support')) : Object.hasOwn(questions, stage);
      if (mismatch) mismatches++;
      return mismatch;
    };
    await jsonOk(await send(prior ? v12Answer : '形を一つ確認したいです。'));
    await h.idle();
    const record = await h.storage.get('record:' + id);
    assert.equal(mismatches, 1, 'the intended private RPC must receive the mismatched reply');
    assert.equal(record.queueState.errorCode, 'ai_unavailable');
    assert.equal(record.jevLedger.halted, true);
    assert.equal(record.queueState.privateState.judgments.length, Number(prior));
    assert.equal(record.jevLedger.latest.jev.status, 'model_mismatch');
  });
}

test('U6-B long dialogue stays within the existing private choice transport bounds', async t => {
  const h = harness();
  const transport = v12Transport(t, h);
  h.env.PARTICIPANT_DIALOGUE_PROFILE = v12Dialogue;
  await h.receive();
  await h.approve();
  const { trial } = await jsonOk(await h.start());
  const id = trial.sessionId;
  const turns = REFERENCE_LIMITS.publicTurns + 1;
  for (let i = 0; i < turns; i++) {
    await jsonOk(await h.request('message', { expectedRecordId: id, clientId: 'long-' + i,
      text: (i + 1) + '回目。' + '折れ曲がる輪郭の細い部分について、形のつながりを順番に比べたいです。'.repeat(7) }));
    await h.idle();
    const record = await h.storage.get('record:' + id);
    assert.equal(record.queueState.errorCode, null, 'turn ' + (i + 1));
    assert.equal(record.queueState.privateState.judgments.length, i + 1);
  }
  const requests = h.calls.filter(x => x.kind === 'choices').map(x => x.body);
  const max = (numbers: number[]) => Math.max(...numbers);
  const measured = {
    turns,
    posts: requests.length,
    maxStateChars: max(requests.map(x => x.state.length)),
    maxQuestions: max(requests.map(x => Object.keys(x.questions).length)),
    maxOptions: max(requests.flatMap(x => Object.values(x.questions as Choices).map(q => Object.keys(q.criteria).length))),
    maxBytes: max(requests.map(x => new TextEncoder().encode(JSON.stringify(x)).byteLength)),
  };
  assert.ok(measured.maxStateChars <= 40_000);
  assert.ok(measured.maxQuestions <= 128);
  assert.ok(measured.maxOptions <= 256);
  assert.ok(measured.maxBytes <= 1024 * 1024);
  assert.equal(transport.textPhases.filter(x => x === 'generation').length, turns);
  t.diagnostic(JSON.stringify(measured));
});

for (const strategy of ['repair-first', 'bypass-enabled']) {
  test('U6-B ' + strategy + ' counts the decision and any veto detail by request', async t => {
    const h = harness(true, { ...protocol, allowedOrders: [[strategy]] });
    v12Transport(t, h);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = v12Dialogue;
    h.controlled.selectedAction = 'defer';
    h.controlled.secondAction = 'confirm';
    await h.receive();
    await h.approve();
    const { trial } = await jsonOk(await h.start());
    await jsonOk(await h.request('message', { expectedRecordId: trial.sessionId, text: '形を一つ確認したいです。' }));
    await h.idle();
    const saved = await h.storage.get('record:' + trial.sessionId);
    assert.equal(saved.queueState.errorCode, null);
    const trace = saved.jevTraces[0], repair = strategy === 'repair-first';
    assert.equal(trace.decisions[0].action, 'defer');
    assert.equal(trace.executed.action, repair ? 'confirm' : 'defer');
    assert.equal(trace.intervention.disposition, repair ? 'rejected' : 'adopted');
    assert.deepEqual(trace.decisions[0].evidence.stages.map((s: { stage: string }) => s.stage), ['action', 'target']);
    const requests = h.calls.filter(x => x.kind === 'choices').map(x => Object.keys(x.body.questions));
    assert.deepEqual(requests.filter(keys => keys.some(k => ['action', 'target', 'feature'].includes(k))),
      repair ? [['action'], ['target'], ['feature']] : [['action'], ['target']]);
    t.diagnostic(JSON.stringify({ strategy, posts: requests.length, decisionAndVetoDetail: repair ? 3 : 2 }));
  });
}

for (const { order, dialogueProfile, scope, generationVersion = 'jev_generation_retry_v13' } of [
  { order: ['repair-first', 'bypass-enabled'], dialogueProfile: v13Dialogue, scope: 'scoped_v7' },
  { order: ['bypass-enabled', 'repair-first'], dialogueProfile: v13Dialogue, scope: 'scoped_v7' },
  { order: ['repair-first', 'bypass-enabled'], dialogueProfile: v13NamingV4Dialogue, scope: 'scoped_v11' },
  { order: ['bypass-enabled', 'repair-first'], dialogueProfile: v13NamingV4Dialogue, scope: 'scoped_v11' },
  { order: ['repair-first', 'bypass-enabled'], dialogueProfile: 'participant_dialogue_v13_p5_discriminating_confirmation',
    scope: 'scoped_v11', generationVersion: 'jev_generation_retry_v16' },
]) {
  const version = generationVersion === 'jev_generation_retry_v16' ? 'v16' : 'v13';
  test('U6 ' + version + ' P5 keeps the approved profile, adoption and cold restore in order ' + order[0] + ' ' + scope, async t => {
    const receptionProtocol = order[0] === 'repair-first' ? figureBankProtocol : protocol;
    const h = harness(true, { ...receptionProtocol, allowedOrders: [order] });
    const transport = v12Transport(t, h);
    transport.options.sharedReading = true;
    h.controlled.selectedAction = 'accept';
    h.env.PARTICIPANT_DIALOGUE_PROFILE = dialogueProfile;
    await h.receive();
    const approval = await h.approve();
    assert.equal(approval.plan.participantDialogueProfile, dialogueProfile);
    assert.equal(approval.plan.participantModelPin.schemaVersion, 'participant_model_pin_v3');
    assert.equal(approval.plan.memoryPruneVersion, CLAIM_PRUNE_V2);
    h.env.PARTICIPANT_DIALOGUE_PROFILE = v12Dialogue;
    h.evict();

    let predecessor: string | undefined;
    for (const strategy of order) {
      const { trial } = await jsonOk(await h.start(predecessor));
      assert.doesNotMatch(JSON.stringify(trial), /participantDialogueProfile|scoped_v(?:7|11)|holistic_v5|claim_prune_v2/u);
      const id = trial.sessionId, key = 'record:' + id;
      const start = await h.storage.get(key);
      assert.equal(start.strategy, strategy);
      assert.equal(start.assignment.source.plan.participantDialogueProfile, dialogueProfile);
      assert.equal(start.options.participantDialogueProfile, dialogueProfile);
      assert.deepEqual(start.options.participantModelPin, approval.plan.participantModelPin);
      assert.equal(start.options.memoryPruneVersion, CLAIM_PRUNE_V2);
      assert.equal(start.queueState.privateState.graph.memoryPruneVersion, CLAIM_PRUNE_V2);
      assert.equal(start.queueState.privateState.agreeNameScopeVersion, scope);
      assert.equal(start.options.questionLayout, 'two_stage_v3');
      assert.equal(start.options.dialoguePolicy, 'holistic_v5');
      assert.equal(start.options.generationRetryVersion, generationVersion);
      assert.equal(start.options.jevNamingRestoreVersion, 'ai_name_acceptances_v1');
      assert.deepEqual(start.options.technicalTrial, { version: 'adaptive_repair_v3' });

      const send = (text: string) => h.request('message', { expectedRecordId: id, text });
      const promptStart = transport.prompts.length, callStart = h.calls.length;
      await jsonOk(await send(p5Question));
      await h.idle();
      await jsonOk(await send(p5Support));
      await h.idle();
      const stored = await h.storage.get(key);
      assert.equal(stored.queueState.errorCode, null);
      const trace = stored.jevTraces.at(-1);
      assert.equal(trace.status, 'committed');
      assert.equal(trace.publicSpeech, 'なるほど。');
      assert.equal(trace.sharedConstruals.length, 1);
      assert.deepEqual(trace.executed.sharedClaimIds, trace.sharedConstruals[0].claimIds);
      assert.deepEqual(stored.queueState.privateState.ledger, start.queueState.privateState.ledger);
      assert.deepEqual(stored.jevLedger.returnedModels.jev.detail, { model: pin.jevModelId, ok: 1 });
      const sentChoices = h.calls.slice(callStart).filter(x => x.kind === 'choices');
      for (const key of ['human_referent', 'action', 'target', 'shared_construal']) {
        const prompt = sentChoices.find(x => Object.hasOwn(x.body.questions, key))?.body.questions[key].instructions;
        assert.match(prompt ?? '', /相手の画面での図形の場所/u, key);
      }
      const prompts = transport.prompts.slice(promptStart);
      assert.match(prompts.find(p => p.phase === 'dialogue')?.system[0] ?? '', /場所しか手がかりのない部分はtargets: \[\]/u);
      const generation = prompts.filter(p => p.phase === 'generation').at(-1)?.system.join('\n') ?? '';
      assert.match(generation, /場所だけでは自分のどの図形か決まりません/u);
      assert.match(generation, /大まかな共同参照の目印/u);

      const sent = h.calls.length;
      h.evict();
      const restored = (await jsonOk(await h.request('state'))).trial;
      assert.equal(restored.sessionId, id);
      assert.equal(h.calls.length, sent);
      assert.deepEqual((await h.storage.get(key)).queueState.privateState, stored.queueState.privateState);
      if (dialogueProfile === v13NamingV4Dialogue && predecessor === undefined) {
        const replaceActiveRecord = async (record: typeof stored) => {
          await h.storage.transaction(async tx => {
            const owner = await tx.get('base:owner:v1');
            owner.admissions[owner.activeKey].record = record;
            await tx.put({ 'base:owner:v1': owner, [key]: record });
          });
          h.evict();
        };
        const wrongScope = structuredClone(stored);
        wrongScope.queueState.privateState.agreeNameScopeVersion = 'scoped_v7';
        await replaceActiveRecord(wrongScope);
        const rejected = await h.request('state');
        assert.equal(rejected.status, 409);
        assert.deepEqual(await rejected.json(), { error: 'trial_unavailable' });
        assert.equal(h.calls.length, sent);
        await replaceActiveRecord(stored);
      }
      await jsonOk(await send('続けましょう。'));
      await h.idle();
      const continuing = await h.storage.get(key);
      assert.equal(continuing.jevTraces.at(-1).status, 'committed');
      assert.equal(continuing.jevTraces.at(-1).generationRetryVersion, generationVersion);
      await h.complete(id, (await jsonOk(await h.request('state'))).trial);
      const completed = await h.storage.get(key);
      assert.equal(completed.status, 'completed');
      assert.deepEqual(completed.jevLedger.returnedModels.luna, {});
      if (predecessor === undefined) {
        await h.storage.transaction(tx => tx.put({ [key]: { ...completed,
          options: { ...completed.options, generationRetryVersion: 'jev_generation_retry_v12' } } }));
        assert.equal((await h.start(id)).status, 409);
        await h.storage.transaction(tx => tx.put({ [key]: completed }));
      }
      predecessor = id;
    }
    assert.equal(h.controlled.legacyCalls, 0);
    assert.ok(h.calls.every(call => call.kind !== 'choices' || !Object.hasOwn(call.body.questions, 'draft_shared_claim')));
  });
}

for (const { dialogueProfile, generation } of [
  { dialogueProfile: PILOT012_PARTICIPANT_PROFILE, generation: 'jev_generation_retry_v17' },
  { dialogueProfile: PILOT012_V18_PARTICIPANT_PROFILE, generation: SHAPE_TERMINOLOGY_GENERATION },
  { dialogueProfile: PILOT012_V19_PARTICIPANT_PROFILE, generation: VISUAL_FEATURE_GENERATION },
]) test(`four-figure production Worker (${generation}) completes both conditions through observation, dialogue, cold restore, scoring and review`, async t => {
  const h = harness(true, { ...figureBankProtocol, seedPolicy: 'per_trial',
    figureSelection: { mode: 'preset', setId: PILOT_FIGURE_SET_ID } });
  const transport = v12Transport(t, h);
  transport.options.structuredConfirmation = true;
  h.env.PARTICIPANT_DIALOGUE_PROFILE = dialogueProfile;
  h.env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION = INITIAL_OBSERVATION_STRUCTURED_V2;
  h.env.PARTICIPANT_AI_PROXY.participantInitialObservationPolicy = transport.observationPolicy;
  await h.receive();
  const approved = await h.approve();
  assert.equal(approved.plan.participantRuntimeProfile, PARTICIPANT_PRODUCTION_PROFILE);
  assert.equal(approved.plan.participantModelPin.schemaVersion, 'participant_model_pin_v3');
  assert.equal(approved.plan.participantDialogueProfile, dialogueProfile);
  assert.equal(approved.plan.initialObservationGeneration, INITIAL_OBSERVATION_STRUCTURED_V2);
  assert.equal(approved.plan.memoryPruneVersion, CLAIM_PRUNE_V3);
  assert.deepEqual(approved.plan.trials.map((trial: any) => trial.figureSelection.figureIds),
    [['F1', 'F2', 'F3', 'F4'], ['F1', 'F2', 'F3', 'F4']]);
  const privateFields = /figureSelection|figureIds|figureSetId|bankVersion|observationMemo|ownAnchors|participantModelPin|jevLedger|jevTraces|visualPurpose|visualFeatures|data:image/u;
  let predecessor: string | undefined;
  for (const strategy of ['bypass-enabled', 'repair-first']) {
    const { trial } = await jsonOk(await h.start(predecessor));
    const id = trial.sessionId, recordKey = 'record:' + id;
    assert.equal(trial.scene.shapes.length, 4);
    assert.doesNotMatch(JSON.stringify(trial), privateFields);
    const initial = await h.storage.get(recordKey);
    assert.equal(initial.strategy, strategy);
    assert.equal(initial.options.participantDialogueProfile, dialogueProfile);
    assert.equal(initial.options.initialObservationGeneration, INITIAL_OBSERVATION_STRUCTURED_V2);
    assert.equal(initial.options.generationRetryVersion, generation);
    assert.equal(initial.queueState.privateState.graph.memoryPruneVersion, CLAIM_PRUNE_V3);
    assert.equal(initial.queueState.privateState.observationMemo.figures.length, 4);
    assert.equal(initial.queueState.privateState.graph.slots.length, 4);
    assert.equal(Object.keys(initial.queueState.privateState.ledger).length, 4);
    assert.equal(initial.jevLedger.phases.terra.initial_observation.posts, 1);
    const visual = generation === VISUAL_FEATURE_GENERATION;
    transport.options.failVisualExtraction = visual && predecessor === undefined;
    const callStart = h.calls.length, promptStart = transport.prompts.length;
    await jsonOk(await h.request('message', { expectedRecordId: id, text: '形を一つ確認したいです。', clientId: 'four-figure-turn' }));
    await h.idle();
    if (visual && predecessor === undefined) {
      const failed = await h.storage.get(recordKey);
      assert.equal(failed.queueState.errorCode, 'ai_unavailable');
      assert.equal(failed.jevTraces.at(-1).status, 'error');
      assert.equal(failed.jevTraces.at(-1).publicSpeech, null);
      assert.equal(failed.queueState.pendingHumanEventIds.length, 1);
      assert.equal(failed.events.at(-1).speaker, 'human');
      assert.deepEqual(failed.queueState.privateState, initial.queueState.privateState);
      h.evict();
      const pending = (await jsonOk(await h.request('state'))).trial;
      assert.equal(pending.dialogueRecovery, 'retry');
      await jsonOk(await h.request('retry', { expectedRecordId: id }));
      await h.idle();
    }
    const speaking = await h.storage.get(recordKey);
    assert.equal(speaking.queueState.errorCode, null);
    assert.equal(speaking.jevTraces.at(-1).status, 'committed');
    const action = h.calls.slice(callStart).find(call => call.kind === 'choices' && Object.hasOwn(call.body.questions, 'action'));
    assert.ok(action);
    const usesTerminology = visual || generation === SHAPE_TERMINOLOGY_GENERATION;
    if (visual) {
      const trace = speaking.jevTraces.at(-1);
      assert.equal(trace.executed.feature, null);
      assert.deepEqual(trace.executed.detailFigureIds, []);
      assert.deepEqual(trace.executed.visualPurpose, { kind: 'clarify_reference' });
      assert.deepEqual(trace.generatedPublication.visualFeatures.sources[0].source,
        { figureId: trace.executed.target.figureId, path: ['analytic', 'shapes', 0] });
      assert.equal(transport.textPhases.slice(promptStart).filter(phase => phase === 'ai_extraction').length, 1);
    }
    assert.equal(action.body.questions.action.instructions.includes(SHAPE_TERMINOLOGY), usesTerminology);
    for (const phase of ['dialogue', 'generation', 'ai_extraction']) {
      const prompt = transport.prompts.slice(promptStart).find(call => call.phase === phase);
      assert.ok(prompt, phase);
      assert.equal(prompt.system.join('\n').includes(SHAPE_TERMINOLOGY), usesTerminology, phase);
    }
    assert.ok(speaking.events.some((event: any) => event.speaker === 'ai' && event.text === v12Check),
      JSON.stringify({ events: speaking.events, executed: speaking.jevTraces.at(-1).executed, publicSpeech: speaking.jevTraces.at(-1).publicSpeech, textPhases: transport.textPhases }));
    const publicBeforeRestore = (await jsonOk(await h.request('state'))).trial;
    const callsBeforeRestore = h.calls.length, textBeforeRestore = transport.textPhases.length;
    h.evict();
    const restored = (await jsonOk(await h.request('state'))).trial;
    assert.equal(restored.sessionId, id);
    assert.deepEqual(restored.scene, trial.scene);
    assert.deepEqual(restored.events, publicBeforeRestore.events);
    assert.deepEqual((await h.storage.get(recordKey)).queueState.privateState, speaking.queueState.privateState);
    assert.equal(h.calls.length, callsBeforeRestore);
    assert.equal(transport.textPhases.length, textBeforeRestore);
    if (visual && predecessor === undefined) {
      const replaceRecord = async (record: typeof speaking) => {
        await h.storage.transaction(async tx => {
          const owner = await tx.get('base:owner:v1');
          owner.admissions[owner.activeKey].record = record;
          await tx.put({ 'base:owner:v1': owner, [recordKey]: record });
        });
        h.evict();
      };
      const changed = structuredClone(speaking);
      changed.jevTraces.at(-1).generatedPublication.visualFeatures.sources[0].quote = '公開されていない特徴';
      changed.queueState.privateState.judgments.at(-1).generatedPublication.visualFeatures.sources[0].quote = '公開されていない特徴';
      await replaceRecord(changed);
      const rejected = await h.request('state');
      assert.equal(rejected.status, 409);
      assert.equal(h.calls.length, callsBeforeRestore);
      await replaceRecord(speaking);
      assert.equal((await jsonOk(await h.request('state'))).trial.sessionId, id);
    }
    await h.complete(id, restored);
    const completed = await h.storage.get(recordKey);
    assert.equal(completed.status, 'completed');
    assert.equal(Object.keys(completed.humanSubmission).length, 4);
    assert.equal(Object.keys(completed.aiSubmission).length, 4);
    assert.equal(completed.scoring.result.total, 4);
    assert.equal(completed.scoring.result.figures.length, 4);
    validateBoundBaseRecord(completed, completed.assignment);
    h.evict();
    const locked = await jsonOk(await h.request('records/' + id + '/review'));
    assert.equal(locked.resultLocked, true);
    assert.equal(Object.hasOwn(locked, 'result'), false);
    assert.deepEqual(locked.scene, trial.scene);
    const { form } = await jsonOk(await h.request('records/' + id + '/questionnaire'));
    await jsonOk(await h.request('records/' + id + '/questionnaire', {
      answers: Object.fromEntries(form.items.map((item: { id: string }) => [item.id, 4])), comment: '', submit: true,
    }));
    const review = await jsonOk(await h.request('records/' + id + '/review'));
    assert.equal(review.resultLocked, false);
    assert.equal(review.result.total, 4);
    assert.equal(review.result.figures.length, 4);
    assert.deepEqual(review.scene, trial.scene);
    assert.doesNotMatch(JSON.stringify(review), privateFields);
    assert.deepEqual((await h.storage.get('reception:v1')).plan, approved.plan);
    predecessor = id;
  }
  assert.equal(transport.textPhases.filter(phase => phase === 'initial_observation').length, 2);
  assert.equal(h.controlled.legacyCalls, 0);
});
