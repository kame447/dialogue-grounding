import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateFigures } from '../dialogue-model/runtime/stimuli/geometry.mjs';
import { createLayoutsV2, createTrialV2, modelView, participantView, trialStimulusV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { approveReception, canonicalReceptionProtocolV2, createReception, receptionProtocolSha256 } from '../dialogue-model/runtime/v2/reception.ts';
import type { ProtocolFigureSelection, ReceptionProtocolV2, ReceptionProtocolV3 } from '../dialogue-model/runtime/v2/reception.ts';
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract.ts';
import { MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';

registerHooks({ resolve(name, context, next) {
  if (name === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  }
  if (name.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(name, context.parentURL);
    if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
  }
  return next(name, context);
} });
// Cloudflare supports forwarding a streaming request without Node's duplex hint.
const NativeRequest = Request;
before(() => {
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } as RequestInit : init);
    }
  };
});
after(() => { globalThis.Request = NativeRequest; });
const worker: any = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href);
const bankUrl = new URL('../dialogue-model/runtime/stimuli/figure-bank.ts', import.meta.url);
const bankAvailable = existsSync(fileURLToPath(bankUrl));
// Keep the legacy controls runnable on main before the bank existed.
const bank = bankAvailable ? await import(bankUrl.href) as typeof import('../dialogue-model/runtime/stimuli/figure-bank.ts') : null;
const validateV3 = (await import('../dialogue-model/runtime/v2/reception.ts')).validateReceptionProtocolV3;
function figureBank() {
  assert.ok(bank, 'figure bank unavailable on this revision');
  return bank;
}

const v2: ReceptionProtocolV2 = {
  schemaVersion: 'reception_protocol_v2', protocolId: '7ae34915-4017-48f4-ad2d-69874ad4cf56', revision: 1,
  allowedOrders: [['bypass-enabled', 'repair-first']], seedPolicy: 'shared', referenceMemory: true,
  betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
};
const customIds = ['F4', 'F8', 'F15', 'F21', 'F26', 'F29'];
const custom = { mode: 'custom', figureIds: customIds } as const;
function v3(figureSelection: ProtocolFigureSelection, figureSetPolicy: 'shared' | 'per_trial' = 'shared',
  rest: Partial<ReceptionProtocolV3> = {}): ReceptionProtocolV3 {
  return { ...v2, schemaVersion: 'reception_protocol_v3', figureSelection, figureSetPolicy, ...rest };
}
const ownerId = '7'.repeat(64);
const now = '2026-01-08T03:00:00.000Z';
const pair = ['bypass-enabled', 'repair-first'] as const;
const legacy = Array.from({ length: 6 }, (_, i) => 'F' + (i + 1));
const knownRandom = ['F11', 'F16', 'F19', 'F27', 'F22', 'F2']; // From #186 at selection seed 41.
const nextRandom = ['F29', 'F11', 'F23', 'F18', 'F28', 'F10'];
const ascending = (ids: readonly string[]) => [...ids].sort();
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pin = { schemaVersion: 'participant_model_pin_v1',
  terraModelId: 'gpt-6.1-terra-2026-11-01', lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261014',
};
const oldLimits = { lunaCalls: 60, lunaPosts: 60, lunaTokens: 300_000, jevPosts: 60, jevUsd: 0.05 };
const adminToken = 'synthetic-local-admin-i180-0123456789';
const generated = '輪郭が細長く見えます。';

function settings(protocol: ReceptionProtocolV2 | ReceptionProtocolV3) {
  let canonical;
  if (protocol.schemaVersion === 'reception_protocol_v3') {
    assert.equal(typeof validateV3, 'function', 'v3 reception protocol unavailable on this revision');
    canonical = JSON.stringify(validateV3(protocol));
  } else canonical = canonicalReceptionProtocolV2(protocol);
  const sha256 = receptionProtocolSha256(canonical);
  return { revision: protocol.revision, sha256, protocol, savedAt: now };
}
function approval(protocol: ReceptionProtocolV2 | ReceptionProtocolV3) {
  const { sha256 } = settings(protocol);
  return { expectedRevision: 0, order: 0, protocol: { protocolId: protocol.protocolId, revision: protocol.revision, sha256 } };
}
function resolvePlan(protocol: ReceptionProtocolV3, random: number[]) {
  const reception = createReception({ receptionId: 'a23b0e66-163a-4ab8-821c-e4d5f8e0912b',
    objectId: ownerId, createdAt: now, number: null });
  const shown = approval(protocol);
  const seed = () => { const next = random.shift(); assert.notEqual(next, undefined, 'unexpected random draw'); return next!; };
  return approveReception(reception, { ...shown, protocol, expected: shown.protocol, approvedAt: now, randomSeed: seed });
}

test('legacy and four-figure presets, seeded and custom sets preserve their matching figures in both rotation modes', () => {
  const { FIGURE_BANK, FIGURE_SETS, PILOT_FIGURE_SET_ID, resolveFigureSelection } = figureBank();
  assert.deepEqual(FIGURE_BANK.map(figure => figure.id), Array.from({ length: 30 }, (_, index) => 'F' + (index + 1)));
  assert.deepEqual(validateFigures(FIGURE_BANK), { valid: true, errors: [] });
  const legacySets = Object.entries(FIGURE_SETS).filter(([id]) => id !== PILOT_FIGURE_SET_ID);
  assert.deepEqual(legacySets.map(([id]) => id), ['legacy-v1', 'bank-set-a', 'bank-set-b', 'bank-set-c', 'bank-set-d']);
  assert.deepEqual(legacySets.map(([, ids]) => ids), Array.from({ length: 5 }, (_, set) =>
    Array.from({ length: 6 }, (_, index) => 'F' + (set * 6 + index + 1))));
  assert.deepEqual(FIGURE_SETS[PILOT_FIGURE_SET_ID], ['F1', 'F2', 'F3', 'F4']);
  const specs = [
    ...Object.entries(FIGURE_SETS).map(([setId, expected]) => ({ selection: { mode: 'preset', setId }, expected })),
    { selection: { mode: 'seeded_random', selectionSeed: 41 }, expected: knownRandom },
    { selection: custom, expected: customIds },
  ];
  for (const { selection, expected } of specs) {
    assert.deepEqual(resolveFigureSelection(selection).figureIds, expected);
    for (const rotationMode of ['relative_pm90', 'relative_0'] as const) {
      const layout = createLayoutsV2({ seed: 2489, rotationMode, figureSelection: selection });
      for (const side of [layout.human, layout.ai]) {
        assert.deepEqual(ascending(side.map(figure => figure.figureId)), ascending(expected));
        for (let i = 0; i < side.length; i++) {
          const a = side[i].bbox;
          assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= 1200 && a.y + a.h <= 800);
          for (const { bbox: b } of side.slice(i + 1)) {
            assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
          }
        }
      }
      assert.equal(new Set([...layout.human, ...layout.ai].map(figure => figure.id)).size, expected.length * 2);
      for (const shape of layout.human) {
        const same = layout.ai.find(candidate => candidate.figureId === shape.figureId)!;
        const delta = (same.rotation - shape.rotation + 360) % 360;
        assert.ok(rotationMode === 'relative_0' ? delta === 0 : delta === 90 || delta === 270);
        assert.ok(Math.hypot(same.center.x - shape.center.x, same.center.y - shape.center.y) >= 96);
      }
    }
  }
  for (const ids of [customIds.slice(1), [...customIds, 'F30'], [...customIds.slice(1), customIds[1]], [...customIds.slice(1), 'F31']]) {
    assert.throws(() => resolveFigureSelection({ mode: 'custom', figureIds: ids }), TypeError);
  }
});

test('figure assignment is independent of placement seeds and per-trial selection is random-only', async () => {
  const selection = { mode: 'seeded_random', selectionSeed: 41 } as const;
  const same = await resolvePlan(v3(selection, 'shared', { seedPolicy: 'per_trial' }), [101, 202]);
  assert.equal(same.plan?.schemaVersion, 'reception_plan_v3');
  assert.deepEqual(same.plan.trials.map(trial => trial.seed), [101, 202]);
  for (const trial of same.plan.trials) assert.deepEqual(trial.figureSelection.figureIds, knownRandom);
  const different = await resolvePlan(v3(selection, 'per_trial'), [101]);
  assert.equal(different.plan?.schemaVersion, 'reception_plan_v3');
  const [first, second] = different.plan.trials;
  assert.equal(first.seed, second.seed);
  assert.deepEqual(first.figureSelection.figureIds, knownRandom);
  assert.deepEqual(second.figureSelection.figureIds, nextRandom);
  assert.notDeepEqual(ascending(first.figureSelection.figureIds), ascending(second.figureSelection.figureIds));
  for (const fixed of [custom, { mode: 'preset', setId: 'bank-set-d' } as const]) {
    assert.throws(() => validateV3(v3(fixed, 'per_trial')), { code: 'protocol_unconfigured' });
  }
});

test('pre-bank rendering reproduces the PNGs and answer-key bytes recorded on 80d3e8c', () => {
  for (const [rotationMode, trialId, aiPng, key] of [
    ['relative_pm90', 'tangram-prototype-v2-1ee5b51a2eb8e5c8',
      '3c90e4519c0699aba6fe7593e101d0d14e2592b798c904ae11cb4e49310f3e20', '5b2e493635b6c0a69bdc96d9c2cc8376f2bd71bffd7b92d9e9bd9fe3a7d270ce'],
    ['relative_0', 'tangram-prototype-v2-e93551eebf52f891',
      '71f0230ae15312bae087c303ef0cecceafb2a0a8e720bbc251680993b65b3895', 'd94bd2535a4d2ba7b39adfce70f5ec632b660a469c5d27d523df2ac62d72805f'],
  ] as const) {
    const trial = createTrialV2({ seed: 2489, rotationMode });
    assert.equal(trial.trialId, trialId);
    assert.equal(sha(trial.human.png), '0c6fc33bbfc6141857586ed455334ce42c3bd3abf3259864c818f482fa7390e7');
    assert.equal(sha(trial.ai.png), aiPng);
    assert.equal(sha(JSON.stringify(trial.key)), key);
    assert.equal(Object.hasOwn(trialStimulusV2(trial)!, 'figureIds'), false);
  }
});

function memory() {
  let entries = new Map<string, unknown>();
  let pending: Promise<unknown> = Promise.resolve();
  const view = (values: Map<string, unknown>) => ({
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(updates: Record<string, unknown>) {
      for (const [key, value] of Object.entries(updates)) values.set(key, structuredClone(value));
    },
    async delete(key: string) { return values.delete(key); },
  });
  return {
    async get<T = any>(key: string): Promise<T> { return await view(entries).get(key) as T; },
    async deleteAlarm() {},
    transaction<T>(fn: (tx: ReturnType<typeof view>) => Promise<T>) {
      const operation = pending.then(async () => {
        const staged = new Map(entries);
        const result = await fn(view(staged));
        entries = staged;
        return result;
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}

type ChoiceRequest = { criteria: Record<string, string> };
type Call = { role: 'terra' | 'luna' | 'jev' | 'legacy'; expectedId: string | null; body: any };
function workerHarness(initialProtocol: ReceptionProtocolV2 | ReceptionProtocolV3, terra = false) {
  const storage = memory();
  const calls: Call[] = [];
  let protocol = initialProtocol;
  let ownSlots: string[] = [];
  let targeted = false;
  let badTerra = false;
  const mode = { value: 'on', revision: 1, savedAt: now };
  const readReceptionSettings = async () => ({ mode, protocol: settings(protocol) });
  const fakeIndex = { readReceptionSettings, async receptionProtocolHistory() { return []; }, async receptionModeHistory() { return []; },
    async listFigurePresets() { return [{ id: 'trio-01-v1', revision: 1, name: '3図形（F1–F3）', figureIds: ['F1', 'F2', 'F3'] }]; } };
  const rate = { async limit() { return { success: true }; } };
  const chat = (model: string, content: string) => ({
    status: 200, data: { model, choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 } },
  });
  function lunaDraft(body: { messages: Array<{ content: unknown }> }) {
    const first = body.messages[0].content;
    if ([MEMO_LOCAL_EXTRACTION_INSTRUCTIONS, MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS].includes(String(first))) return '[]';
    return String(body.messages.at(-1)?.content).includes('JSON')
      ? JSON.stringify(Object.fromEntries(ownSlots.map(slot => [slot, '合成の名前']))) : generated;
  }
  const env = {
    PARTICIPANT_TERRA_ENABLED: terra ? 'on' : 'off',
    PARTICIPANT_TERRA_LIMITS_JSON: JSON.stringify(oldLimits),
    V2_UTTERANCE_STYLE: 'concise',
    ADMIN_TOKEN: adminToken, ADMIN_RATE_LIMIT: rate,
    ADMIN_INDEX: { idFromName: () => 'synthetic-admin-index', get: () => fakeIndex },
    NAMING_SESSIONS: { idFromName: (name: string) => name, get: () => session },
    START_RATE_LIMIT: rate, IP_ACTION_RATE_LIMIT: rate, SESSION_ACTION_RATE_LIMIT: rate,
    GLOBAL_ACTION_RATE_LIMIT: rate, QUESTIONNAIRE_RATE_LIMIT: rate,
    AI_PROXY: { async chat(body: any) {
      calls.push({ role: 'legacy', expectedId: null, body });
      return chat('synthetic-legacy', lunaDraft(body));
    } },
    PARTICIPANT_AI_PROXY: {
      async participantPolicy() { return { ...pin }; },
      async participantChat(body: any, expectedId: string) {
        const visual = body.purpose === 'visual_observation';
        calls.push({ role: visual ? 'terra' : 'luna', expectedId, body });
        if (!visual) return chat(pin.lunaModelId, lunaDraft(body));
        const args = JSON.parse(body.messages[1].content);
        const model = badTerra ? 'gpt-6.1-terra-2026-11-02' : pin.terraModelId;
        if (args.figureIds) {
          return chat(model, JSON.stringify({ figures: args.figureIds.map((figureId: string) => ({
            figureId, supports: ['輪郭が細長い'], contradicts: [], unknown: [],
          })) }));
        }
        ownSlots = args.ownAnchors.map((anchor: { id: string }) => anchor.id);
        return chat(model, JSON.stringify({ figures: ownSlots.map(id => ({ id, holistic: [],
          analytic: { shapes: ['細長い輪郭'], composition: '辺がつながる', relations: [] }, unknowns: [],
        })) }));
      },
      async participantChoices(body: { questions: Record<string, ChoiceRequest> }, expectedId: string) {
        calls.push({ role: 'jev', expectedId, body });
        const reobserve = targeted && Object.hasOwn(body.questions.action?.criteria ?? {}, 'request_observation');
        if (reobserve) targeted = false;
        const answers = Object.fromEntries(Object.entries(body.questions).map(([question, { criteria }]) => {
          const wanted = reobserve && question === 'action' ? 'request_observation'
            : reobserve && question === 'target' ? 'figure_0' : question === 'action' ? 'accept' : 'none';
          const labels = Object.keys(criteria);
          const choice = labels.includes(wanted) ? wanted : labels[0];
          return [question, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }];
        }));
        return { status: 200, data: { model: pin.jevModelId, id: 'gen-i180-acceptance', answers, usage: { cost: 0 } } };
      },
    },
  };
  function make() {
    const created = new worker.TangramSession({ storage, id: { toString: () => ownerId }, waitUntil() {} }, env);
    created.settings = readReceptionSettings;
    return created;
  }
  let session = make();
  function request(path: string, body?: unknown, options: { method?: string; auth?: string; cookie?: boolean } = {}): Promise<Response> {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    return worker.default.fetch(new Request('https://figure-bank.invalid' + path, {
      method, headers: { ...(options.cookie === false ? {} : { Cookie: 'tangram_session=' + ownerId }),
        ...(options.auth ? { Authorization: options.auth } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
  }
  const reception = () => storage.get('reception:v1');
  return {
    calls, env, request, reception,
    setProtocol(next: ReceptionProtocolV2 | ReceptionProtocolV3) { protocol = next; },
    setOwnSlots(slots: string[]) { ownSlots = slots; },
    requestObservation() { targeted = true; },
    mismatchTerra() { badTerra = true; },
    evict() { session = make(); },
    async receive() {
      assert.equal(await session.registerBaseOwner(), true);
      return json(await request('/api/reception', undefined, { method: 'POST' }));
    },
    approve(shown = approval(protocol)) { return session.adminApproveReception(shown); },
    async start(previous?: string) {
      return request('/api/start', { version: 2, expectedReceptionRevision: (await reception()).revision,
        ...(previous ? { expectedRecordId: previous } : {}) });
    },
    async message(recordId: string) {
      await json(await request('/api/message', { expectedRecordId: recordId, text: '輪郭を比べています。', clientId: 'synthetic-turn' }));
      await session.trial.whenIdle();
      return storage.get('record:' + recordId);
    },
    async finish(recordId: string, trial: { scene: { shapes: Array<{ id: string }> }; events: unknown[] }) {
      return json(await request('/api/names', { expectedRecordId: recordId, confirm: true, expectedEventCount: trial.events.length,
        names: Object.fromEntries(trial.scene.shapes.map(({ id }) => [id, '参加者の合成名'])) }));
    },
    record(recordId: string) { return storage.get('record:' + recordId); },
  };
}

async function json(response: Response) {
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
const privateFields = /"(?:key|figureId|figureIds|figureSetId|figureSelection|figureSetPolicy|selectionSeed|bankVersion|seed|protocolSha256|assignment|participantModelPin|participantLimits|ownAnchors|observationMemo|scoring|stimulus)"\s*:|"F(?:[1-9]|[12]\d|30)"|data:image\//u;
function participantOnly(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), privateFields);
}
function aiCount(record: { events: Array<{ speaker: string }> }) {
  return record.events.filter(event => event.speaker === 'ai').length;
}

for (const [policy, selection, assigned] of [
  ['shared', custom, [customIds, customIds]],
  ['per_trial', { mode: 'seeded_random', selectionSeed: 41 }, [knownRandom, nextRandom]],
] as const) {
  test('approval freezes ' + policy + ' figure selection, placement and rotation in both public Worker trials', async () => {
    const initial = v3(selection, policy, { rotationMode: 'relative_0' });
    const h = workerHarness(initial);
    participantOnly(await h.receive());
    const stale = approval(initial);
    h.setProtocol(v3(selection, policy, { revision: 2, rotationMode: 'relative_0' }));
    await assert.rejects(h.approve(stale), { code: 'protocol_changed' });
    const approved = await h.approve();
    const locked = approved.plan;
    assert.deepEqual(locked.trials.map((trial: any) => trial.figureSelection.figureIds), assigned);
    h.setProtocol(v3({ mode: 'preset', setId: 'bank-set-d' }, 'shared', { revision: 3, rotationMode: 'relative_pm90' }));
    let previous: string | undefined;
    let previousScene: unknown;
    for (const [index, strategy] of pair.entries()) {
      const start = await json(await h.start(previous));
      participantOnly(start);
      const id = start.trial.sessionId;
      const definition = locked.trials[index];
      const expected = createTrialV2({ seed: definition.seed, rotationMode: 'relative_0', figureSelection: definition.figureSelection });
      if (index > 0) {
        if (policy === 'shared') assert.deepEqual(start.trial.scene, previousScene);
        else assert.notDeepEqual(start.trial.scene, previousScene);
      }
      const before = await h.record(id);
      assert.equal(before.strategy, strategy);
      assert.deepEqual(before.options.figureSelection, definition.figureSelection);
      assert.deepEqual(before.stimulus, trialStimulusV2(expected));
      assert.deepEqual(start.trial.scene, participantView(expected));
      h.setOwnSlots(modelView(expected).anchors.map((anchor: { id: string }) => anchor.id));
      h.evict();
      const restored = await json(await h.request('/api/state'));
      assert.deepEqual(restored.trial.scene, start.trial.scene);
      participantOnly(restored);
      const finished = await h.finish(id, restored.trial);
      participantOnly(finished);
      const record = await h.record(id);
      assert.deepEqual(record.scoring.key, expected.key);
      assert.deepEqual((await h.reception()).plan, locked);
      previous = id;
      previousScene = restored.trial.scene;
      h.setProtocol(v3({ mode: 'seeded_random', selectionSeed: 42 }, 'per_trial', { revision: 4 }));
    }
    participantOnly(await json(await h.request('/api/records')));
    participantOnly(await json(await h.request('/api/records/' + previous + '/review')));
  });
}

test('a saved pre-bank Worker trial still restores the same scene and keeps the legacy record shape', async () => {
  const h = workerHarness(v2);
  await h.receive();
  const admitted = await h.approve();
  assert.equal(admitted.plan.schemaVersion, 'reception_plan_v2');
  const before = await json(await h.start());
  const id = before.trial.sessionId;
  const original = await h.record(id);
  assert.equal(Object.hasOwn(original.options, 'figureSelection'), false);
  assert.equal(Object.hasOwn(original.stimulus, 'figureIds'), false);
  const expected = createTrialV2({ seed: original.seed, rotationMode: 'relative_pm90' });
  h.setProtocol(bankAvailable ? v3(custom, 'shared', { revision: 8, rotationMode: 'relative_0' })
    : { ...v2, revision: 8, rotationMode: 'relative_0' });
  h.evict();
  const after = await json(await h.request('/api/state'));
  assert.deepEqual(after.trial.scene, before.trial.scene);
  assert.deepEqual(after.trial.scene, participantView(expected));
  const restored = await h.record(id);
  assert.deepEqual(restored.stimulus, original.stimulus);
  assert.equal(Object.hasOwn(restored.options, 'figureSelection'), false);
  assert.deepEqual(ascending(Object.values(expected.key.human) as string[]), legacy);
  participantOnly(after);
});

test('per-trial random approval cannot silently give both trials the same six figures', async () => {
  // The legacy shuffle can draw the same unordered set from distinct seeds.
  const distinctCases = [
    { selectionSeed: 37658, draws: [2489] },
    { selectionSeed: null, draws: [2489, 138, 1274, 41, 42] },
  ];
  for (const { selectionSeed, draws } of distinctCases) {
    const protocol = v3({ mode: 'seeded_random', selectionSeed }, 'per_trial');
    const approved = await resolvePlan(protocol, [...draws]);
    assert.equal(approved.plan?.schemaVersion, 'reception_plan_v3');
    const [first, second] = approved.plan.trials;
    assert.notDeepEqual(ascending(first.figureSelection.figureIds), ascending(second.figureSelection.figureIds),
      'different selection seeds can still contain the exact same six figures');
    const repeated = await resolvePlan(protocol, [...draws]);
    assert.deepEqual(repeated.plan, approved.plan);
  }
});

test('the figure catalogue is researcher-only and renders the 30 figures, the new-reception presets and the older six sets through the Worker', async () => {
  const h = workerHarness(v2);
  for (const auth of [undefined, 'Bearer synthetic-wrong-token']) {
    const denied = await h.request('/admin/figures', undefined, { cookie: false, auth });
    assert.equal(denied.status, 401);
    assert.doesNotMatch(await denied.text(), /tangram-bank-v1|<svg/u);
  }
  const listed = await h.request('/admin/figures', undefined, { cookie: false, auth: 'Bearer ' + adminToken });
  assert.equal(listed.status, 200);
  assert.match(listed.headers.get('Content-Security-Policy') ?? '', /style-src 'self'/u);
  const html = await listed.text();
  const { FIGURE_BANK, FIGURE_SETS } = figureBank();
  const labels = [...html.matchAll(/<svg[^>]+aria-label="(F\d+)"/gu)].map(match => match[1]);
  assert.deepEqual(labels, [...FIGURE_BANK.map(figure => figure.id), 'F1', 'F2', 'F3', ...Object.values(FIGURE_SETS).flat()]);
  for (const name of Object.keys(FIGURE_SETS)) assert.ok(html.includes('<h3>' + name + '</h3>'));
  const publicAlias = await h.request('/api/figures', undefined, { auth: 'Bearer ' + adminToken });
  assert.equal(publicAlias.status, 404);
  participantOnly(await publicAlias.json());
});

test('Terra observes the approved custom AI board, reuses only its memo and preserves both pinned condition limits', async () => {
  const h = workerHarness(v3(custom), true);
  await h.receive();
  const approved = await h.approve();
  assert.deepEqual(approved.plan.participantModelPin, pin);
  assert.deepEqual(approved.plan.participantLimits, oldLimits);
  assert.deepEqual(h.calls.slice(), [], 'the old capped plan does not preobserve');
  h.env.PARTICIPANT_TERRA_ENABLED = 'off';
  const [definition] = approved.plan.trials;
  const full = createTrialV2({ seed: definition.seed, rotationMode: 'relative_pm90', figureSelection: custom });
  const own = modelView(full);
  const human = participantView(full);
  const image = 'data:image/png;base64,' + own.png.toString('base64');
  const partnerImage = 'data:image/png;base64,' + full.human.png.toString('base64');
  const localIds = new Set(own.anchors.map((anchor: { id: string }) => anchor.id));
  let previous: string | undefined;
  let memoSha: string | undefined;
  for (const strategy of pair) {
    const beforeStart = h.calls.length;
    const started = await json(await h.start(previous));
    assert.deepEqual(h.calls.slice(beforeStart).map(call => call.role), previous === undefined ? ['terra'] : []);
    const id = started.trial.sessionId;
    assert.deepEqual(started.trial.scene, human);
    participantOnly(started);
    const before = await h.record(id);
    assert.equal(before.strategy, strategy);
    assert.deepEqual(before.options.participantModelPin, pin);
    assert.deepEqual(before.jevLedger.limits, oldLimits);
    assert.deepEqual(before.stimulus, trialStimulusV2(full));
    if (memoSha !== undefined) assert.equal(before.initialObservation.memoSha256, memoSha);
    memoSha = before.initialObservation.memoSha256;
    h.requestObservation();
    const after = await h.message(id);
    assert.equal(after.queueState.errorCode, null);
    assert.equal(aiCount(after), aiCount(before) + 1);
    assert.equal(after.jevTraces[0].reobservations.length, 1);
    const count = h.calls.length;
    h.evict();
    const restored = await json(await h.request('/api/state'));
    assert.equal(restored.trial.sessionId, id);
    assert.equal(h.calls.length, count);
    assert.deepEqual((await h.record(id)).jevLedger.limits, oldLimits);
    h.env.PARTICIPANT_TERRA_LIMITS_JSON = JSON.stringify({ ...oldLimits, jevPosts: 1 });
    await h.finish(id, restored.trial);
    previous = id;
  }
  const visual = h.calls.filter(call => call.role === 'terra');
  assert.equal(visual.length, 3, 'shared initial memo plus one targeted call per condition');
  assert.deepEqual(JSON.parse(visual[0].body.messages[1].content).ownAnchors,
    [...own.anchors].sort((a, b) => a.id.localeCompare(b.id)));
  for (const { body } of visual.slice(1)) {
    const ids: string[] = JSON.parse(body.messages[1].content).figureIds;
    assert.equal(ids.length, 1);
    assert.ok(localIds.has(ids[0]));
  }
  for (const { role, expectedId, body } of h.calls) {
    const wire = JSON.stringify(body);
    assert.notEqual(role, 'legacy');
    assert.equal(expectedId, role === 'terra' ? pin.terraModelId : role === 'luna' ? pin.lunaModelId : pin.jevModelId);
    assert.equal(wire.includes(image), role === 'terra');
    assert.ok(!wire.includes(partnerImage));
    assert.doesNotMatch(wire, /"(?:key|figureSetId|figureSelection|bankVersion)"\s*:|"F(?:[1-9]|[12]\d|30)"/u);
  }
  participantOnly(await json(await h.request('/api/state')));
});

test('a mismatched Terra return cannot open a bank trial', async () => {
  const h = workerHarness(v3(custom), true);
  await h.receive();
  await h.approve();
  h.mismatchTerra();
  const denied = await h.start();
  assert.equal(denied.status, 409);
  participantOnly(await denied.json());
  assert.deepEqual(h.calls.map(call => call.role), ['terra']);
});


test('a different random set at the same placement seed gets a fresh private Terra observation', async () => {
  const h = workerHarness(v3({ mode: 'seeded_random', selectionSeed: 41 }, 'per_trial'), true);
  await h.receive();
  const approved = await h.approve();
  const [first, next] = approved.plan.trials;
  assert.equal(first.seed, next.seed);
  const started = await json(await h.start());
  await h.finish(started.trial.sessionId, started.trial);
  await json(await h.start(started.trial.sessionId));
  const observations = h.calls.filter(call => call.role === 'terra');
  assert.equal(observations.length, 2);
  const expected = approved.plan.trials.map((trial: any) => {
    const model = modelView(createTrialV2({ seed: trial.seed, rotationMode: trial.rotationMode, figureSelection: trial.figureSelection }));
    return 'data:image/png;base64,' + model.png.toString('base64');
  });
  assert.notEqual(expected[0], expected[1]);
  observations.forEach(({ body, expectedId }, index) => {
    assert.equal(expectedId, pin.terraModelId);
    assert.ok(JSON.stringify(body).includes(expected[index]));
    assert.ok(!JSON.stringify(body).includes(expected[1 - index]));
  });
});
