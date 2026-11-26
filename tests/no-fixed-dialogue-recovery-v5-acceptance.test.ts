// Synthetic acceptance through the actual participant server, generation guard,
// durable queue, browser renderer and S4. Model transports are in-process stubs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { createObservationCache } from '../dialogue-model/runtime/observation/cache.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import type { RecordedGenerationRetryVersion } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchHash } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevPrivateState, JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { prepareParticipantJev } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { buildRecords, MODEL, OWN } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const timeouts = { observationMs: 20000, localMs: 20000, decisionMs: 20000,
  lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 };
const seed = 872;
const modelId = 'synthetic-luna-model';
const scene = createTrialV2({ seed, rotationMode: 'relative_pm90' });
const view = modelView(scene);
const feature = '丸い切れ目が一つある';
const human = '釣り針のような形を、切れ目の特徴で見分けられますか？';
const warmHuman = '輪郭を手掛かりにして進めたいです。';
const warmSpeech = '輪郭を手掛かりにしましょう。';
const bad = ['左側に丸い切れ目がある形ですか？', '右側に丸い切れ目が一つある形ですか？'] as const;
const generated = '丸い切れ目が一つある形のことですか？';
const historicalFallback = 'その形の特徴について、もう少し詳しく教えてもらえますか？';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const own = { ownImage: { ...OWN.ownImage, mimeType: 'image/png' as const }, ownAnchors: OWN.ownAnchors };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};

type PublicEvent = { id: string; text: string; at: string; clientId?: string; speaker: 'human' | 'ai' };
type TrialView = {
  sessionId: string; events: PublicEvent[]; aiStatus: string; status: string; busy: boolean;
  closed: boolean; submitted: boolean; aiSubmitted: boolean; scene: { shapes: Array<{ id: string }> };
};
type PrivateRecord = {
  options: { dialoguePolicy?: string; generationRetryVersion?: RecordedGenerationRetryVersion };
  queueState: {
    events: PublicEvent[]; pendingHumanEventIds: string[]; privateState: JevPrivateState;
    requestSeq: number; closed: boolean; errorCode: string | null;
  };
  jevTraces: JevTurnTrace[];
  jevLedger: { lunaPosts: number; limits: { lunaPosts: number }; halted: boolean };
  turnTimings: Array<{ lastEventId: string; pendingEventIds: string[]; requestSeq: number; outcome: string }>;
  events: PublicEvent[]; publicHistory: Array<{ role: string; content: string }>;
  scoring: unknown; humanSubmission: unknown; aiSubmission: unknown; closed: boolean; status: string;
};
type Reply = { status: number; json: { trial?: TrialView; eventId?: string; error?: string } };
type AppTask = Awaited<ReturnType<typeof createNamingTaskV2>>;

async function participant(t: TestContext, strategy: Label, options: { lunaPosts?: number } = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'no-fixed-dialogue-'));
  const cacheDirectory = join(directory, 'cache'), baseStoreRoot = join(directory, 'owners');
  await Promise.all([mkdir(cacheDirectory, { mode: 0o700 }), mkdir(baseStoreRoot, { mode: 0o700 })]);
  let server: Awaited<ReturnType<typeof startNamingServer>> | undefined;
  async function close() {
    if (!server) return;
    const current = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const memo = { figures: view.anchors.map((anchor: { id: string }) => ({
    id: anchor.id, holistic: [], analytic: { shapes: [feature], composition: '二つの部分が接する', relations: [] }, unknowns: [],
  })) };
  const cache = await createObservationCache({
    directory: cacheDirectory, modelId, onMiss: 'observe',
    client: { async complete() { return { text: JSON.stringify(memo), model: modelId }; } },
  });
  const hit = await cache.get({
    ownImage: { mimeType: view.mimeType, base64: view.png.toString('base64') }, ownAnchors: view.anchors,
  });
  const configFile = join(directory, 'configuration.json'), baseAssignmentFile = join(directory, 'assignment.json');
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 'participant_jev_config_v1', lunaRequest: { timeoutMs: null, maxCompletionTokens: 1000 }, timeouts,
    cacheDirectory, modelId, memoSha256: researchHash(hit.memo), seed, questionLayout: 'two_stage_v3', technicalTrial,
    limits: { lunaCalls: 100, lunaTokens: 100000, lunaPosts: options.lunaPosts ?? 100, jevPosts: 100, jevUsd: 0.05 },
  }), { mode: 0o600 });
  await writeFile(baseAssignmentFile, JSON.stringify({
    schemaVersion: 'base_assignment_config_v1', configId: 'e8df858c-e385-4358-a755-353992599137', revision: 1,
    strategy, seed, referenceMemory: true,
  }), { mode: 0o600 });

  const providerPosts: string[] = [];
  const generation: Array<{ message: string; text: string }> = [];
  let drafts: Array<string | (() => Promise<string>)> = [];
  let mode: 'accept' | 'confirm' = 'confirm';
  let responseNo = 0;
  const prepared = await prepareParticipantJev({
    configFile, baseAssignmentFile,
    clientConfig: { provider: 'cloudflare', purpose: 'dialogue_turn', baseUrl: 'https://offline.invalid/v1', apiKey: 'synthetic-participant-recovery' },
    readKey: async () => 'sk-or-synthetic-participant-recovery-0000',
    async fetchImpl(_url, init) {
      if (init?.method === 'GET') return Response.json({ ready: true, purpose: 'dialogue_turn', provider: 'openai', model: modelId });
      assert.equal(init?.method, 'POST');
      const raw = String(init?.body);
      providerPosts.push(raw);
      const body = JSON.parse(raw);
      if (body.questions) {
        const request = body as JevDecisionPayload;
        const answers = Object.fromEntries(Object.entries(request.questions).map(([key, { criteria }]) => {
          const labels = Object.keys(criteria);
          const target = mode === 'accept' ? 'none' : 'figure_0';
          const choice = key === 'action' ? mode : key === 'target' || key === 'human_referent' ? target
            : key === 'prospect' ? 'no_open_issue' : key === 'feature'
              ? labels.find(label => JSON.parse(criteria[label]).value === feature) : 'none';
          assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
            labels.map(label => [label, Number(label === choice)]),
          ) }];
        }));
        return Response.json({ model: request.model, id: 'gen-recovery-' + ++responseNo, usage: { cost: 0 }, answers });
      }

      const messages = body.messages as Array<{ role: string; content: unknown }>;
      let payload: { publicTurns?: unknown; candidateText?: unknown } = {};
      try { payload = JSON.parse(String(messages[1]?.content)); } catch { /* generation has plaintext instructions */ }
      let text = '[]';
      if (!payload.publicTurns && !payload.candidateText) {
        const latest = messages.filter(message => message.role === 'user').at(-1);
        assert.ok(latest && typeof latest.content === 'string', 'only dialogue completion is permitted');
        const draft = drafts.shift();
        assert.ok(draft, 'unexpected generation request');
        text = typeof draft === 'string' ? draft : await draft();
        generation.push({ message: latest.content, text });
      }
      return Response.json({ model: modelId, choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 } });
    },
  });
  assert.equal(prepared.profile.dialoguePolicy, 'holistic_v5');
  let task: AppTask | undefined;
  let saved: PrivateRecord | undefined;
  let cookie: string | undefined;
  let url = '';
  async function open() {
    const options = {
      port: 0, client: {}, baseAssignmentFile, baseStoreRoot,
      createTaskV2: async (value: Parameters<typeof createNamingTaskV2>[0]) => {
        const onPersist = value.onPersist;
        task = await createNamingTaskV2({
          ...value, ...await prepared.taskOptions({ ...value, referenceMemory: value.referenceMemory ?? true }), createTrial: () => scene,
          async onPersist(record: unknown) { saved = structuredClone(record) as PrivateRecord; await onPersist?.(record); },
        });
        return task;
      },
    };
    server = await startNamingServer(options);
    url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    cookie ??= (await fetch(url)).headers.get('set-cookie')!.split(';')[0];
  }
  await open();
  async function request(path: string, body?: Record<string, unknown>): Promise<Reply> {
    const response = await fetch(url + path, {
      headers: { Cookie: cookie!, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: await response.json() as Reply['json'] };
  }
  async function read() {
    const response = await request('/api/state');
    assert.equal(response.status, 200);
    assert.ok(response.json.trial);
    return response.json.trial;
  }
  const start = await request('/api/start', { version: 2 });
  assert.equal(start.status, 200);
  assert.ok(start.json.trial);
  const expectedRecordId = start.json.trial.sessionId;
  function record() {
    assert.ok(saved);
    return structuredClone(saved);
  }
  return {
    generation, providerPosts, record, read,
    async restart() { await close(); task = undefined; await open(); return read(); },
    script(action: typeof mode, ...texts: typeof drafts) { mode = action; drafts = [...texts]; },
    async message(text: string, clientId: string) {
      const response = await request('/api/message', { text, clientId, expectedRecordId });
      assert.equal(response.status, 202);
      assert.ok(response.json.eventId);
      return response.json.eventId;
    },
    async settle() { assert.ok(task); await task.whenIdle(); return read(); },
    retry: () => request('/api/retry', { expectedRecordId }),
    names: (state: TrialView) => request('/api/names', {
      expectedRecordId, confirm: true, expectedEventCount: state.events.length,
      names: Object.fromEntries(state.scene.shapes.map(shape => [shape.id, null])),
    }),
    submitAI: () => request('/api/ai-submit', { expectedRecordId }),
  };
}

type Participant = Awaited<ReturnType<typeof participant>>;
function assertNoPublicFailure(view: TrialView) {
  const publicJson = JSON.stringify(view);
  for (const marker of ['unsafe_generation', 'orientation_leak', 'generationGuard', 'pendingHumanEventIds',
    'synthetic-participant-recovery', historicalFallback, ...bad]) {
    assert.ok(!publicJson.includes(marker), 'participant view leaked ' + marker);
  }
}
function assertIncomplete(trial: TrialView, record: PrivateRecord) {
  assert.notEqual(trial.status, 'completed');
  assert.equal(trial.submitted, false);
  assert.equal(trial.aiSubmitted, false);
  assert.equal(record.humanSubmission, null);
  assert.equal(record.aiSubmission, null);
  assert.equal(record.scoring, null);
}

async function previousTurn(app: Participant) {
  app.script('accept', warmSpeech);
  await app.message(warmHuman, 'warmup');
  const view = await app.settle();
  assert.equal(view.events.at(-1)?.text, warmSpeech);
  return { view, record: app.record() };
}

function assertRetained(app: Participant, failed: TrialView, previous: PrivateRecord, eventId: string) {
  const record = app.record();
  assert.equal(record.options.dialoguePolicy, 'holistic_v5');
  assert.equal(failed.closed, false);
  assert.equal(record.closed, false);
  assert.equal(record.queueState.closed, false);
  assertIncomplete(failed, record);
  assert.equal(failed.events.length, previous.events.length + 1, 'only the new human input is public');
  assert.deepEqual(failed.events.slice(0, -1), previous.events.map(({ id, speaker, text, at, clientId }) =>
    ({ id, speaker, text, at, ...(clientId === undefined ? {} : { clientId }) })));
  const pending = failed.events.at(-1)!;
  assert.deepEqual([pending.id, pending.speaker, pending.text, pending.clientId], [eventId, 'human', human, 'recovery-case']);
  assert.deepEqual(record.queueState.pendingHumanEventIds, [eventId]);
  assert.equal(record.queueState.events.at(-1)?.id, eventId);
  assert.equal(record.queueState.events.at(-1)?.text, human);
  assert.deepEqual(record.queueState.privateState, previous.queueState.privateState);
  assert.equal(record.publicHistory.at(-1)?.role, 'user');
  const trace = record.jevTraces.at(-1)!;
  assert.equal(trace.lastEventId, eventId);
  assert.equal(trace.executed?.action, 'confirm');
  assert.equal(trace.status, 'error');
  assert.equal(trace.errorCode, 'unsafe_generation');
  assert.equal(trace.publicSpeech, null);
  assert.deepEqual(trace.generationGuard, { regenerated: true, fallback: false, violations: ['orientation_leak'] });
  assertNoPublicFailure(failed);
  return record;
}

const web = new URL('../dialogue-model/runtime/web/', import.meta.url);
const [script, html] = await Promise.all(['app.js', 'index.html'].map(name => readFile(new URL(name, web), 'utf8')));

// Same small DOM boundary as the web chat acceptance fixtures. The production
// renderer sees actual participant snapshots while the upstream retry is held.
class Element {
  readonly tagName: string;
  readonly attributes: Record<string, string> = {};
  children: Element[] = [];
  parent?: Element;
  value = '';
  hidden = false;
  disabled = false;
  open = false;
  scrollTop = 0;
  clientHeight = 400;
  private text = '';
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...children: Element[]) { for (const child of children) child.parent = this; this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  get scrollHeight() { return this.children.length * 200; }
  querySelectorAll(selector: string): Element[] {
    const matches = (child: Element) => selector.split(',').some(part => {
      const match = /^([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/u.exec(part);
      return match && child.tagName === match[1] && (!match[2] || child.getAttribute(match[2]) === match[3]);
    });
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  addEventListener() {}
  focus() {}
  scrollTo({ top }: { top: number }) { this.scrollTop = top; }
  getBBox() { return { x: 100, y: 150, width: 130, height: 180 }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

async function browser(trial: TrialView) {
  const root = new Element('document'), stack = [root], ids: Record<string, Element> = {};
  for (const token of html.matchAll(/<\/?([\w-]+)\b([^>]*?)>/gu)) {
    const [, tag, rest] = token;
    if (token[0].startsWith('</')) { if (stack.at(-1)?.tagName === tag) stack.pop(); continue; }
    const node = new Element(tag);
    for (const [, key, quoted, plain] of rest.matchAll(/([\w-]+)(?:="([^"]*)"|=([^\s]+))?/gu)) {
      node.setAttribute(key, quoted ?? plain ?? '');
    }
    const id = node.getAttribute('id');
    if (id) ids[id] = node;
    node.value = node.getAttribute('value') ?? '';
    stack.at(-1)!.append(node);
    if (!['input', 'meta', 'link', 'br'].includes(tag)) stack.push(node);
  }
  const later = new Map<number, () => void>(), calls: string[] = [];
  let next = { trial, busy: trial.busy };
  let timer = 0;
  const sandbox = {
    crypto: { randomUUID: () => 'browser-synthetic-only' },
    document: { getElementById: (id: string) => ids[id], createElement: (tag: string) => new Element(tag),
      createElementNS: (_: unknown, tag: string) => new Element(tag) },
    fetch: async (path: string) => {
      calls.push(path);
      return { ok: true, status: 200, json: async () => path === '/api/records' ? { records: [] } : structuredClone(next) };
    },
    setTimeout: (callback: () => void) => { later.set(++timer, callback); return timer; },
    clearTimeout: (id: number) => later.delete(id),
    acceptParticipantState: undefined as undefined | ((state: typeof next) => void),
  };
  runInNewContext(script + '\n;globalThis.acceptParticipantState = render;', sandbox);
  const tick = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  await tick();
  return {
    ids, calls, root,
    async update(snapshot: TrialView) {
      next = { trial: snapshot, busy: snapshot.busy };
      assert.ok(sandbox.acceptParticipantState);
      sandbox.acceptParticipantState(structuredClone(next));
      await tick();
    },
  };
}
function visible(element?: Element): boolean {
  for (let node = element; node; node = node.parent) if (node.hidden) return false;
  return Boolean(element);
}
function interruptionOffered(rendered: Awaited<ReturnType<typeof browser>>) {
  return rendered.root.querySelectorAll('button').some(button => visible(button) && !button.disabled &&
    button !== rendered.ids['finish-conversation'] &&
    /中断|終了|続行をやめる/u.test(button.getAttribute('aria-label') ?? button.textContent));
}

for (const strategy of strategies) {
  test(strategy + ' saves the unanswered event and restarts it exactly once through /api/retry', { timeout: 20000 }, async t => {
    const app = await participant(t, strategy);
    const before = await previousTurn(app);
    app.script('confirm', ...bad);
    const eventId = await app.message(human, 'recovery-case');
    const failed = await app.settle();
    const record = assertRetained(app, failed, before.record, eventId);
    assert.deepEqual(app.generation.slice(-2).map(draft => draft.text), [...bad]);
    const recovery = await browser(failed);
    assert.ok(visible(recovery.ids['chat-recovery']));
    assert.ok(!recovery.ids['retry-chat'].disabled, 'the paused trial still has one recovery action');

    const failedSends = app.providerPosts.length;
    const restored = await app.restart();
    assert.equal(restored.sessionId, failed.sessionId);
    assert.deepEqual(restored.events, failed.events);
    assert.equal(app.providerPosts.length, failedSends, 'loading a paused trial must not resubmit the input');
    assert.deepEqual(app.record().queueState.pendingHumanEventIds, [eventId]);
    assert.deepEqual(app.record().queueState.privateState, record.queueState.privateState);

    app.script('confirm', generated);
    const retry = await app.retry();
    assert.equal(retry.status, 200);
    const resumed = await app.settle();
    assert.equal(resumed.aiStatus, 'idle');
    assert.equal(resumed.closed, false);
    assert.deepEqual(resumed.events.slice(0, -1), failed.events);
    assert.equal(resumed.events.length, failed.events.length + 1);
    assert.equal(resumed.events.at(-1)?.speaker, 'ai');
    assert.equal(resumed.events.at(-1)?.text, generated);
    assert.deepEqual(app.generation.slice(-3).map(draft => draft.message), [human, human, human]);
    const committed = app.record();
    assert.deepEqual(committed.queueState.pendingHumanEventIds, []);
    assert.equal(committed.queueState.requestSeq, record.queueState.requestSeq + 1);
    assert.deepEqual(committed.jevTraces.filter(trace => trace.lastEventId === eventId).map(trace => trace.status),
      ['error', 'committed']);
    assert.deepEqual(committed.turnTimings.at(-1)?.pendingEventIds, [eventId]);
    assert.equal(committed.queueState.privateState.judgments.length, record.queueState.privateState.judgments.length + 1);
    assert.deepEqual(committed.queueState.privateState.ledger, record.queueState.privateState.ledger);

    const sends = app.providerPosts.length;
    await app.retry();
    assert.deepEqual((await app.read()).events, resumed.events);
    assert.equal(app.providerPosts.length, sends, 'a repeated recovery operation cannot send again after commit');
    assertNoPublicFailure(resumed);
  });

  test(strategy + ' makes zero further sends at the existing POST cap and blocks submission and scoring', { timeout: 20000 }, async t => {
    // One local extraction and the two draft completions use the whole allowance.
    const app = await participant(t, strategy, { lunaPosts: 3 });
    const before = app.record();
    app.script('confirm', ...bad);
    const eventId = await app.message(human, 'recovery-case');
    const failed = await app.settle();
    const exhausted = assertRetained(app, failed, before, eventId);
    assert.equal(exhausted.jevLedger.lunaPosts, exhausted.jevLedger.limits.lunaPosts);
    const sendCount = app.providerPosts.length;
    // Deliberately offer a good model reply if the server accidentally sends.
    app.script('confirm', generated);
    for (const _ of [0, 1]) await app.retry();
    const blocked = await app.read();
    assert.deepEqual(blocked.events, failed.events);
    for (const refusal of [await app.names(blocked), await app.submitAI()]) {
      assert.ok(refusal.status >= 400);
      assert.ok(!['invalid_request', 'invalid_submission', 'trial_changed'].includes(refusal.json.error ?? ''),
        'the request must reach the incomplete-trial guard');
    }
    assert.equal(app.providerPosts.length, sendCount);
    assert.deepEqual(app.record().queueState.pendingHumanEventIds, [eventId]);
    assert.deepEqual(app.record().queueState.privateState, before.queueState.privateState);
    assertIncomplete(await app.read(), app.record());
    const rendered = await browser(blocked);
    assert.ok(!visible(rendered.ids['retry-chat']) || rendered.ids['retry-chat'].disabled,
      'a participant control cannot offer another send once the allowance is exhausted');
    assert.ok(interruptionOffered(rendered), 'the participant can leave the incomplete trial through a non-dialogue operation');
  });

  test(strategy + ' keeps the first rejection off the participant screen during a successful rewrite', { timeout: 20000 }, async t => {
    const app = await participant(t, strategy);
    const entered = deferred(), release = deferred();
    t.after(release.resolve);
    app.script('confirm', bad[0], async () => {
      entered.resolve();
      await release.promise;
      return generated;
    });
    try {
      await app.message(human, 'recovery-case');
      await Promise.race([entered.promise, app.settle().then(() => assert.fail('the first draft did not trigger a rewrite'))]);
      const pending = await app.read();
      assert.equal(pending.aiStatus, 'thinking');
      assert.equal(pending.events.at(-1)?.text, human);
      assertNoPublicFailure(pending);
      const rendered = await browser(pending);
      assert.ok(!visible(rendered.ids['chat-recovery']));
      assert.ok(!interruptionOffered(rendered));
      assert.equal(rendered.ids.notice.textContent, '');
      assert.doesNotMatch(rendered.ids['chat-status'].textContent, /エラー|再試行|中断|棄却|進行を確認できません/u);
      assert.ok(!rendered.ids.history.textContent.includes(bad[0]));
      release.resolve();
      const complete = await app.settle();
      assert.equal(complete.aiStatus, 'idle');
      assert.equal(complete.events.at(-1)?.text, generated);
      await rendered.update(complete);
      assert.ok(!visible(rendered.ids['chat-recovery']));
      assert.ok(!interruptionOffered(rendered));
      assert.equal(rendered.ids.notice.textContent, '');
      assert.doesNotMatch(rendered.ids['chat-status'].textContent, /エラー|再試行|中断|棄却|進行を確認できません/u);
      assert.ok(rendered.ids.history.textContent.includes(generated));
      assert.ok(!rendered.ids.history.textContent.includes(bad[0]));
      assert.ok(!rendered.calls.includes('/api/retry'));
      assertNoPublicFailure(complete);
      const guard = app.record().jevTraces.at(-1)!.generationGuard;
      assert.deepEqual(guard, { regenerated: true, fallback: false, violations: ['orientation_leak'] });
    } finally {
      release.resolve();
    }
  });
}

const stages = ['shape', 'binding', 'execution', 'replay'];
const recordsFor = (label: Label, dialoguePolicy: 'holistic_v1' | 'holistic_v2' | 'holistic_v3' | 'holistic_v4' | 'holistic_v5',
  drafts: readonly string[], versions?: Pick<Parameters<typeof buildRecords>[0], 'generationRetryVersion' | 'agreeNameScopeVersion'>) => buildRecords({
  label, dialoguePolicy, technicalTrial, ...versions,
  turns: [{ human, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', drafts: [...drafts] } }],
});
type S4Records = Awaited<ReturnType<typeof recordsFor>>;

function verdicts(records: S4Records) {
  const all = interventionChecks(records);
  return stages.map(stage => all.find(check => check.id === 'intervention.trial.0.attempt.0.' + stage)?.status);
}

function substituteFixedReply(genuine: S4Records, legacy: S4Records): S4Records {
  // Keep the current v5 attempt, profile, retry version and all exact sends up to
  // the second model draft. Change only the outcome to the legacy fixed alternative.
  // The matching did-not-extract evidence and private state come from the real legacy
  // fixed path, which used the same synthetic judgment, human input, and first draft.
  const out = structuredClone(genuine);
  const trial = out.trials[0];
  const old = legacy.trials[0];
  const trace = trial.attempts[0];
  const legacyTrace = old.attempts[0];
  assert.equal(legacyTrace.publicSpeech, historicalFallback);
  assert.deepEqual(trace.executed, legacyTrace.executed);
  Object.assign(trace, {
    publicSpeech: legacyTrace.publicSpeech, generationGuard: legacyTrace.generationGuard,
    aiPublic: legacyTrace.aiPublic, repairHistory: legacyTrace.repairHistory,
  });
  trial.turns[0].trace = [structuredClone(trace)];
  trial.turns[0].publicText = trace.publicSpeech;
  const state = trial.lastCommittedState;
  state.aiPublic = structuredClone(old.lastCommittedState.aiPublic);
  state.repairHistory = structuredClone(old.lastCommittedState.repairHistory);
  const judgment = state.judgments.at(-1)!;
  judgment.generationGuard = structuredClone(legacyTrace.generationGuard);
  judgment.aiPublic = structuredClone(old.lastCommittedState.judgments.at(-1)!.aiPublic);
  trial.turns[0].state = structuredClone(state);
  const { tape, result } = trial.replay[0];
  const untilPublication = (request: { phase: string }) => request.phase !== 'ai_extraction';
  trial.calls = trial.calls.filter(untilPublication);
  trial.http = trial.http.filter(untilPublication);
  tape.recorded.expectedRequests = tape.recorded.expectedRequests.filter(untilPublication);
  for (const side of result.sides) {
    const tail = tape.tails[side.label];
    tail.luna = tail.luna.filter(untilPublication);
    const generation = tail.luna.filter((entry: { phase: string }) => entry.phase === 'generation');
    assert.equal(generation.length, 2);
    generation[1].response.text = bad[1];
    side.material.tail = structuredClone(tail);
    side.materialSha256 = hash(side.material);
    side.requests = side.requests.filter(untilPublication);
  }
  out.evidence.pairedReplay[0].left = structuredClone(result.sides[0]);
  out.evidence.pairedReplay[0].right = structuredClone(result.sides[1]);
  return JSON.parse(JSON.stringify(out)) as S4Records;
}

for (const strategy of strategies) {
  test(strategy + ' S4 accepts a model rewrite and rejects the equivalent v5 record with a fixed reply', async t => {
    const fresh = (await participant(t, strategy)).record();
    const { generationRetryVersion } = fresh.options;
    const { agreeNameScopeVersion } = fresh.queueState.privateState;
    assert.ok(generationRetryVersion);
    assert.ok(agreeNameScopeVersion);
    const good = await recordsFor(strategy, 'holistic_v5', [bad[0], generated], { generationRetryVersion, agreeNameScopeVersion });
    const old = await recordsFor(strategy, 'holistic_v4', bad);
    assert.equal(good.trials[0].attempts[0].publicSpeech, generated);
    assert.deepEqual(verdicts(good), ['pass', 'pass', 'pass', 'pass']);
    assert.deepEqual(verdicts(old), ['pass', 'pass', 'pass', 'pass']);
    const fixed = substituteFixedReply(good, old);
    assert.ok(verdicts(fixed).includes('mismatch'), 'S4 must reject the v5 fixed publication');
  });
}

// Frozen generation request bytes and the HTTP request identifiers from the
// synthetic fallback records at d4426a9. No Git history is needed to test them.
const historical = {
  holistic_v1: '846662e2a7d66f13ac08f9bcf81a2bce5a292efc7a55454029965167dd97b245',
  holistic_v2: '225cc12dc47c9284c209613e552d46e5ae06f219d7ccd9a3cdff5d7905b0923b',
  holistic_v3: '225cc12dc47c9284c209613e552d46e5ae06f219d7ccd9a3cdff5d7905b0923b',
  holistic_v4: '225cc12dc47c9284c209613e552d46e5ae06f219d7ccd9a3cdff5d7905b0923b',
} as const;
for (const policy of Object.keys(historical) as Array<keyof typeof historical>) {
  test(policy + ' preserves the fixed alternative, original generation bytes and saved replay in both strategies', async () => {
    const signatures: string[] = [];
    for (const label of strategies) {
      const saved = JSON.parse(JSON.stringify(await recordsFor(label, policy, bad))) as S4Records;
      const trial = saved.trials[0];
      assert.deepEqual(trial.attempts[0].generationGuard,
        { violations: ['orientation_leak'], regenerated: true, fallback: true });
      assert.equal(trial.attempts[0].publicSpeech, historicalFallback);
      assert.deepEqual(verdicts(saved), ['pass', 'pass', 'pass', 'pass']);

      const tape = trial.replay[0].tape;
      const bytes = JSON.stringify(tape);
      const replay = await pairedInterventionReplay(tape, own, MODEL, trial.profile);
      assert.equal(JSON.stringify(tape), bytes);
      assert.equal(replay.status, 'same_material_intervention_verified', replay.error ?? '');
      assert.equal(replay.recordedPayloadsReproduced, true);
      const side = replay.sides.find(item => item.label === label);
      assert.ok(side);
      const generation = side.requests.filter(request => request.phase === 'generation');
      assert.equal(generation.length, 2);
      for (const request of generation) assert.equal(hash(request.payload), request.preProjectionPayloadSha256);
      signatures.push(sha256(JSON.stringify({
        sends: tape.recorded.expectedRequests,
        generationBodies: generation.map(request => JSON.stringify(request.payload)),
        fallback: trial.attempts[0].publicSpeech,
      })));
    }
    assert.equal(sha256(JSON.stringify(signatures)), historical[policy]);
  });
}

test('an already saved v5 record keeps the generation policy that was recorded before the change', async t => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const exec = promisify(execFile);
  const baseline = 'd4426a9';
  try {
    await exec('git', ['cat-file', '-e', baseline + '^{commit}'], { cwd });
  } catch {
    t.skip('the baseline commit is unavailable in this checkout');
    return;
  }
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'saved-v5-generation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'old.tar');
  const helper = 'tests/support/s4-v3-records.ts';
  await exec('git', ['archive', '--output=' + archive, baseline, 'package.json', 'dialogue-model',
    helper, 'tests/support/s4-integration', 'workers'], { cwd });
  await exec('tar', ['-xf', archive, '-C', directory]);
  const archived = await import(pathToFileURL(join(directory, helper)).href) as { buildRecords: typeof buildRecords };
  for (const label of strategies) {
    const recorded = await archived.buildRecords({
      label, dialoguePolicy: 'holistic_v5', technicalTrial,
      turns: [{ human, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', drafts: [...bad] } }],
    });
    const bytes = JSON.stringify(recorded);
    const saved = JSON.parse(bytes) as S4Records;
    const trial = saved.trials[0];
    assert.equal(trial.attempts[0].publicSpeech, historicalFallback);
    assert.equal(trial.attempts[0].generationGuard.fallback, true);
    assert.deepEqual(verdicts(saved), ['pass', 'pass', 'pass', 'pass']);
    const replay = await pairedInterventionReplay(trial.replay[0].tape, own, MODEL, trial.profile);
    assert.equal(replay.status, 'same_material_intervention_verified', replay.error ?? '');
    assert.equal(replay.recordedPayloadsReproduced, true);
    assert.equal(JSON.stringify(saved), bytes, 'verification must not upgrade the saved record');
  }
});
