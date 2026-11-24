import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract.ts';
import { MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import { canonicalReceptionProtocolV2, canonicalReceptionProtocolV3, receptionProtocolSha256, receptionSummary, validateReceptionPlan } from '../dialogue-model/runtime/v2/reception.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { FIGURE_SETS } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { handleRequest } from '../workers/research-ai-proxy/src/index.mjs';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';
import { configuredParticipantPin, participantChoices, participantUsageChoices } from '../workers/research-ai-proxy/src/participant-transport.ts';

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

function harness(enabled = true, selectedProtocol: typeof protocol & {
  figureSelection?: { mode: string; setId: string }; figureSetPolicy?: string;
} = protocol) {
  const canonical = selectedProtocol.schemaVersion === 'reception_protocol_v3'
    ? canonicalReceptionProtocolV3(selectedProtocol) : canonicalReceptionProtocolV2(selectedProtocol);
  const sha256 = receptionProtocolSha256(canonical);
  const displayed = { protocolId: selectedProtocol.protocolId, revision: selectedProtocol.revision, sha256 };
  const storage = memory(), calls: Array<{ kind: string; expected: string; body: any }> = [];
  const controlled: { policy: unknown; terra: unknown; luna: unknown; jev: unknown; legacyCalls: number; observe: boolean; mixedUsage: boolean; invalidTerra?: boolean; rejectJev?: boolean;
    usageChat?: (body: any, expected: string) => Promise<any>; holdChoice?: () => Promise<void> } =
    { policy: { ...pin }, terra: pin.terraModelId, luna: pin.lunaModelId, jev: pin.jevModelId, legacyCalls: 0, observe: false, mixedUsage: false };
  let slots: string[] = [];
  const env = {
    PARTICIPANT_TERRA_ENABLED: enabled ? 'on' : 'off',
    PARTICIPANT_TERRA_PROFILE: PARTICIPANT_PRODUCTION_PROFILE as string | undefined,
    PARTICIPANT_TERRA_LIMITS_JSON: JSON.stringify(approvedLimits),
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
          const figures = slots.map(id => ({ id, holistic: [], analytic: { shapes: ['三角'], composition: '辺がつながる', relations: [] }, unknowns: [] }));
          return mock(controlled.terra, JSON.stringify({ figures }));
        }
        const first = body.messages[0].content, last = body.messages.at(-1).content;
        const text = first === MEMO_LOCAL_EXTRACTION_INSTRUCTIONS || first === MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS ? '[]'
          : String(last).includes('JSON') ? JSON.stringify(Object.fromEntries(slots.map(id => [id, '合成名']))) : 'なるほど、聞かせてくれてありがとう。';
        return mock(controlled.luna, text);
      },
      async participantUsagePolicy() { return this.participantPolicy(); },
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
        const data = { id: 'gen-synthetic', model: controlled.jev, usage: controlled.mixedUsage ? { cost: body.questions.action ? 0.07 : null, input_tokens: 5, output_tokens: 3 } : { cost: 0 },
          answers: answers(body.questions, observe) };
        // Exercise the proxy's real validation of each positive Jev stage.
        return controlled.jev === pin.jevModelId ? (usageOnly ? participantUsageChoices : participantChoices)(settings, body, expected, async () => Response.json(data))
          : { status: 200, data };
      },
    },
  };

  function makeSession() {
    const session = new TangramSession({ storage, id: { toString: () => 'c'.repeat(64) }, waitUntil() {} }, env);
    session.settings = async () => ({ mode: { value: 'on', revision: 1 }, protocol: { protocol: selectedProtocol, revision: selectedProtocol.revision, sha256 } });
    return session;
  }
  let session = makeSession();
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    session.fetch(new Request('https://session.invalid/api/' + path, { method, ...(body === undefined ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })) as Promise<Response>;

  return {
    storage, calls, controlled, env, request,
    evict() { session = makeSession(); },
    adminRecord(recordId: string) { return session.adminRecord(recordId); },
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
    [{ assignmentId, trialIndex: 0, errorCode: 'initialization_failed' }]);
  assert.deepEqual(failed.usage, await h.storage.get('participant-usage:' + assignmentId));
  const meter = failed.usage.phases.terra.initial_observation;
  assert.deepEqual([meter.posts, meter.knownUsd, meter.inputTokens, meter.outputTokens, meter.missingCostPosts], [1, 0.021, 17, 6, 0]);
  assert.equal((await h.request('state')).status, 409);
  assert.equal((await h.start()).status, 409);
  assert.equal(h.calls.length, 1);
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

test('a failed start before reservation has no usage journal in the reception export', async () => {
  const h = harness();
  await h.receive();
  const { receptionId } = await h.approve();
  h.controlled.policy = null;
  assert.equal((await h.start()).status, 409);
  h.evict();
  const snapshot = await jsonOk(await h.admin('/admin/reception/' + receptionId + '/usage.json'));
  const { assignmentId, trialIndex, errorCode, usage } = snapshot.failedStarts[0];
  assert.equal(snapshot.failedStarts.length, 1);
  assert.match(assignmentId, /^[0-9a-f-]+$/u);
  assert.deepEqual({ trialIndex, errorCode, usage }, { trialIndex: 0, errorCode: 'initialization_failed', usage: null });
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
