import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clone, config, raw } from './support/s5-base/support.ts';
import { web } from './support/s5-base/http-support.ts';
import { EMPTY_TAB_SESSION_MAX_AGE_MS, MAX_EMPTY_TAB_SESSIONS, TAB_SESSION_ID } from '../workers/tangram-experiment/src/tab-sessions.ts';
import type { BrowserSession, BrowserSessionSummary } from '../workers/tangram-experiment/src/tab-sessions.ts';
import { NamingTaskError } from '../dialogue-model/runtime/naming-error.mjs';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
  }
  return next(specifier, context);
} });
const { default: worker, TangramSession, AdminIndex }: any = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href);

// The Worker accepts a forwarded request-body stream without Node's duplex flag.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init);
  }
};
const textSecret = 'synthetic private dialogue';
const nameSecret = 'synthetic private name';
const answerSecret = 'synthetic private questionnaire comment';
const draft = (expectedUpdatedAt: string | null) => ({ submit: false, answers: { mental_effort: 5 }, comment: answerSecret, expectedUpdatedAt });
const submission = (expectedUpdatedAt: string | null, comment = answerSecret) => ({
  submit: true, answers: { mental_effort: 5, task_difficulty: 4, smoothness: 3, bothersome: 2 }, comment, expectedUpdatedAt,
});
const questionnairePath = (id: string) => '/api/records/' + id + '/questionnaire';
const reviewPath = (id: string) => '/api/records/' + id + '/review';

function storage() {
  let values = new Map<string, unknown>(), pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>) => {
    const run = pending.then(fn);
    pending = run.catch(() => {});
    return run;
  };
  const view = (map: Map<string, unknown>) => ({
    async get(key: string) { return clone(map.get(key)); },
    async put(updates: Record<string, unknown>) { for (const [key, value] of Object.entries(updates)) map.set(key, clone(value)); },
    async delete(keys: string | string[]) {
      return (Array.isArray(keys) ? keys : [keys]).reduce((count, key) => count + Number(map.delete(key)), 0);
    },
    async list({ prefix }: { prefix: string }) { return new Map([...clone(map)].filter(([key]) => key.startsWith(prefix))); },
  });
  return {
    get: (key: string) => view(values).get(key),
    put: (updates: Record<string, unknown>) => serialize(() => view(values).put(updates)),
    delete: (keys: string | string[]) => serialize(() => view(values).delete(keys)),
    async deleteAlarm() {},
    transaction<T>(fn: (tx: ReturnType<typeof view>) => Promise<T>) {
      return serialize(async () => {
        const staged = clone(values), result = await fn(view(staged));
        values = staged;
        return result;
      });
    },
  };
}

async function harness(receptionMode: 'on' | 'off' = 'off') {
  const stores = new Map<string, ReturnType<typeof storage>>();
  const objects = new Map<string, any>();
  const pending: Promise<unknown>[] = [];
  let factoryCalls = 0, finalCalls = 0, failFinal = false;
  const index = new AdminIndex({ storage: storage() }, {});
  if (receptionMode === 'on') {
    const fields = { allowedOrders: [['repair-first', 'bypass-enabled']], seedPolicy: 'per_trial',
      referenceMemory: false, betweenTrials: 'questionnaire_required', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
      figureSelection: { mode: 'preset', setId: 'legacy-v1' }, figureSetPolicy: 'shared' };
    assert.equal((await index.saveReceptionProtocol({ expectedRevision: 0, fields })).ok, true);
  }
  assert.equal((await index.saveReceptionMode({ expectedRevision: 0, value: receptionMode })).ok, true);
  const permit = { limit: async () => ({ success: true }) };
  const env = {
    BASE_ASSIGNMENT_JSON: JSON.stringify(config()),
    NAMING_SESSIONS: { idFromName: (id: string) => id, get: object },
    ADMIN_INDEX: { idFromName: (id: string) => id, get: () => index },
    ASSETS: { fetch: async (request: Request) => new Response(new URL(request.url).pathname) },
    START_RATE_LIMIT: permit, SESSION_ACTION_RATE_LIMIT: permit, IP_ACTION_RATE_LIMIT: permit,
    GLOBAL_ACTION_RATE_LIMIT: permit, QUESTIONNAIRE_RATE_LIMIT: permit,
    AI_PROXY: { async chat() { assert.fail('unexpected external model call'); } },
  };
  function ownerStorage(name: string) {
    const saved = stores.get(name) ?? storage();
    stores.set(name, saved);
    return saved;
  }
  function object(id: string) {
    if (objects.has(id)) return objects.get(id);
    const instance = new TangramSession({
      storage: ownerStorage(id), id: { toString: () => id }, waitUntil: (p: Promise<unknown>) => pending.push(p),
    }, env);
    instance.createTrial = async (input: any) => {
      factoryCalls++;
      const record = clone(input.restore ?? raw());
      if (!input.restore) {
        record.recordId = crypto.randomUUID();
        record.seed = input.seed;
        record.strategy = input.strategy;
        record.options.referenceMemory = input.referenceMemory;
        record.options.rotationMode = input.rotationMode;
        if (input.openingMode) record.options.openingMode = input.openingMode;
        if (input.figureSelection) record.options.figureSelection = input.figureSelection; // frozen by a v3 plan
        record.stimulus = { version: 'synthetic-stimulus-v1', rotationMode: input.rotationMode, angles: { human: { h1: 0 }, ai: { a1: 0 } } };
      }
      const persist = () => input.onPersist(clone(record));
      const task = {
        getState: () => ({ sessionId: record.recordId, status: record.status, events: clone(record.events), aiSubmitted: Boolean(record.aiSubmission) }),
        persistNow: persist,
        whenIdle: async () => {},
        retry: async () => {},
        message(message: string) {
          assert.equal(record.closed, false);
          const eventId = crypto.randomUUID();
          record.events.push({ id: eventId, speaker: 'human', text: message, at: record.updatedAt });
          return { eventId, duplicate: false };
        },
        async submitHuman() {
          if (record.humanSubmission) throw new NamingTaskError('already_submitted');
          record.humanSubmission = { h1: nameSecret };
          record.closed = true;
          record.status = 'submitting';
          await persist();
          await task.submitAI();
        },
        async submitAI() {
          finalCalls++;
          if (failFinal) {
            record.finalError = 'ai_unavailable';
            await persist();
            throw new NamingTaskError('ai_unavailable');
          }
          record.finalError = null;
          record.aiSubmission = {};
          record.status = 'completed';
          record.scoring = { key: {}, result: { provisional: true, success: false, matchedCount: 0, total: 6, figures: [] } };
          await persist();
        },
      };
      if (!input.restore) await persist();
      return task;
    };
    objects.set(id, instance);
    return instance;
  }
  const request = (path: string, cookie?: string, tab?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    worker.fetch(new Request('https://tab-sessions.invalid' + path, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(tab === undefined ? {} : { 'X-Tab-Session': tab }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env) as Promise<Response>;
  async function browser() {
    const page = await request('/');
    assert.equal(page.status, 200);
    return page.headers.get('set-cookie')!.split(';')[0];
  }
  const rootName = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1);
  const catalog = async (cookie: string) => await ownerStorage(rootName(cookie)).get('browser:sessions:v1') as BrowserSession[] ?? [];
  async function entry(cookie: string, sessionId: string) {
    return sessionId === 'legacy' ? object(rootName(cookie)) : object((await catalog(cookie)).find(item => item.sessionId === sessionId)!.doName);
  }
  return { request, browser, catalog, entry, rootName, ownerStorage,
    get factoryCalls() { return factoryCalls; }, get finalCalls() { return finalCalls; },
    set failFinal(value: boolean) { failFinal = value; },
    async displayed() {
      const p = (await index.readReceptionSettings()).protocol;
      return { protocolId: p.protocol.protocolId, revision: p.revision, sha256: p.sha256 };
    },
    damageSettings() { index.readReceptionSettings = async () => { throw Error('synthetic outage'); }; },
    evict: () => objects.clear(),
    async drain() { await Promise.all(pending); },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function ok(response: Promise<Response>, status = 200) {
  const r = await response, body = await r.json();
  assert.equal(r.status, status, JSON.stringify(body));
  return body as any;
}
async function rejected(response: Promise<Response>, status: number, error: string) {
  assert.deepEqual(await ok(response, status), { error });
}
async function create(h: Harness, cookie: string, empty = false): Promise<string> {
  const result = await ok(h.request('/api/sessions', cookie, 'ignored-for-history', empty ? undefined : {}, 'POST'), 201);
  assert.deepEqual(Object.keys(result).sort(), ['sessionId', 'state']);
  assert.match(result.sessionId, TAB_SESSION_ID);
  assert.equal(result.state.trial, null);
  assert.deepEqual(await ok(h.request('/api/state', cookie, result.sessionId)), result.state);
  return result.sessionId;
}
async function history(h: Harness, cookie: string): Promise<{ receptionMode: string; sessions: BrowserSessionSummary[] }> {
  return ok(h.request('/api/sessions', cookie));
}
const names = (expectedRecordId: string, expectedEventCount: number) => ({ confirm: true, names: {}, expectedRecordId, expectedEventCount });

test('new tabs isolate dialogue, submission, completion and cold reload; ownership rejects arbitrary IDs', async () => {
  const h = await harness(), cookie = await h.browser(), other = await h.browser();
  await rejected(h.request('/api/sessions'), 401, 'session_required');
  await rejected(h.request('/api/sessions', 'tangram_session=' + 'f'.repeat(64)), 401, 'session_required');
  await rejected(h.request('/api/sessions', cookie, undefined, { sessionId: crypto.randomUUID() }), 400, 'invalid_request');
  assert.equal(await (await h.request('/tab-session.js', cookie)).text(), '/tab-session.js');
  const [a, b] = await Promise.all([create(h, cookie), create(h, cookie, true)]);
  assert.notEqual(a, b);
  assert.equal(h.factoryCalls, 0);
  assert.equal((await h.catalog(cookie)).length, 2);
  assert.deepEqual(await history(h, cookie), { receptionMode: 'off', sessions: [] });
  const [left, right] = await Promise.all([a, b].map(tab => ok(h.request('/api/start', cookie, tab, { version: 2 }))));
  const leftId = left.trial.sessionId, rightId = right.trial.sessionId;
  assert.notEqual(leftId, rightId);
  for (const invalid of ['', 'not-a-tab', crypto.randomUUID(), leftId]) {
    await rejected(h.request('/api/state', cookie, invalid), 404, 'not_found');
  }
  await rejected(h.request('/api/state', other, a), 404, 'not_found');
  await rejected(h.request('/api/state', 'tangram_session=' + (await h.catalog(cookie))[0].doName), 404, 'not_found');
  await rejected(h.request(reviewPath(leftId), cookie, b), 404, 'not_found');
  await rejected(h.request(questionnairePath(leftId), other, a), 404, 'not_found');
  await rejected(h.request(reviewPath(crypto.randomUUID()), cookie, a), 404, 'not_found');
  await rejected(h.request('/api/names', cookie, a, names(rightId, left.trial.events.length)), 409, 'trial_changed');
  await ok(h.request('/api/message', cookie, a, { text: textSecret, clientId: 'left-only', expectedRecordId: leftId }), 202);
  await rejected(h.request('/api/names', cookie, a, names(leftId, left.trial.events.length)), 409, 'trial_changed');
  await rejected(h.request('/api/names', cookie, a, names(leftId, -1)), 400, 'invalid_request');
  assert.equal(h.finalCalls, 0);
  assert.equal((await ok(h.request('/api/state', cookie, a))).trial.status, 'dialogue');
  const matchingNames = names(leftId, left.trial.events.length + 1);
  const completions = await Promise.all([h.request('/api/names', cookie, a, matchingNames), h.request('/api/names', cookie, a, matchingNames)]);
  assert.deepEqual(completions.map(result => result.status).sort(), [200, 400]);
  assert.equal(h.finalCalls, 1);
  await rejected(h.request('/api/ai-submit', cookie, a, { expectedRecordId: leftId }), 409, 'trial_changed');
  await rejected(h.request('/api/start', cookie, a, { version: 2 }), 409, 'trial_changed');
  const writes = await Promise.all(['first', 'second'].map(comment => h.request(questionnairePath(leftId), cookie, a, { ...draft(null), comment })));
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
  const stored = await ok(h.request(questionnairePath(leftId), cookie, a));
  await rejected(h.request(questionnairePath(leftId), cookie, a, draft(null)), 409, 'trial_changed');
  const submitted = await ok(h.request(questionnairePath(leftId), cookie, a, submission(stored.questionnaire.updatedAt)));
  await rejected(h.request(questionnairePath(leftId), cookie, a, submission(null, 'different')), 409, 'questionnaire_submitted');
  await rejected(h.request(questionnairePath(leftId), cookie, a, submission(null)), 409, 'trial_changed');
  await ok(h.request(questionnairePath(leftId), cookie, a, submission(submitted.questionnaire.updatedAt)));
  await h.drain();
  h.evict();
  assert.deepEqual(await ok(h.request('/api/state', cookie, b)), right);
  assert.equal((await ok(h.request('/api/state', cookie, a))).trial.status, 'completed');
  assert.equal((await ok(h.request('/api/state', cookie))).trial, null);
  await (await h.entry(cookie, a)).adminDelete(leftId);
  assert.equal((await h.request('/', cookie)).headers.get('set-cookie')!.split(';')[0], cookie);
  assert.deepEqual(await ok(h.request('/api/state', cookie, b)), right);
  assert.deepEqual((await history(h, cookie)).sessions.map(item => item.sessionId), [b]);
});

function assertPublicHistory(sessions: BrowserSessionSummary[], privateValues: string[]) {
  const json = JSON.stringify(sessions);
  assert.doesNotMatch(json, /"(?:events|text|names|comment|answers|strategy|seed|order|protocol|protocolId|receptionId|objectId|assignment|doName)"/u);
  for (const value of [textSecret, nameSecret, answerSecret, ...privateValues]) assert.ok(!json.includes(value));
  for (const item of sessions) {
    assert.deepEqual(Object.keys(item).sort(), ['activeRecordId', 'createdAt', 'hasUnansweredQuestionnaire', 'reception', 'records', 'resumable', 'sessionId', 'status', 'updatedAt']);
    if (item.reception) assert.deepEqual(Object.keys(item.reception).sort(), ['number', 'revision', 'status']);
    for (const record of item.records) {
      assert.deepEqual(Object.keys(record).sort(), ['active', 'questionnaire', 'recordId', 'startedAt', 'status', 'updatedAt']);
    }
  }
}

test('legacy progress is explicitly resumable and its finished record is reviewable without leaking details in browser history', async () => {
  const h = await harness(), cookie = await h.browser(), tab = await create(h, cookie);
  const state = await ok(h.request('/api/start', cookie, undefined, { version: 2 }));
  const id = state.trial.sessionId;
  await ok(h.request('/api/message', cookie, 'legacy', { expectedRecordId: id, text: textSecret }), 202);
  await h.drain();
  h.evict();
  const resumed = await ok(h.request('/api/state', cookie, 'legacy'));
  assert.equal(resumed.trial.sessionId, id);
  assert.equal(resumed.trial.events.at(-1).text, textSecret);
  const progress = (await history(h, cookie)).sessions;
  assertPublicHistory(progress, [h.rootName(cookie), ...(await h.catalog(cookie)).map(item => item.doName)]);
  assert.deepEqual(progress.map(item => [item.sessionId, item.status, item.resumable]), [['legacy', 'in_progress', true]]);
  await ok(h.request('/api/names', cookie, 'legacy', names(id, resumed.trial.events.length)));
  await ok(h.request(questionnairePath(id), cookie, 'legacy', draft(null)));
  const finished = (await history(h, cookie)).sessions;
  assertPublicHistory(finished, [h.rootName(cookie)]);
  assert.deepEqual(finished.map(item => [item.sessionId, item.status, item.resumable, item.hasUnansweredQuestionnaire]),
    [['legacy', 'finished', false, true]]);
  assert.equal(finished[0].records[0].questionnaire, 'draft');
  const review = await ok(h.request(reviewPath(id), cookie, 'legacy'));
  assert.equal(review.events.at(-1).text, textSecret);
  assert.equal(review.humanSubmission.h1, nameSecret);
  assert.equal((await ok(h.request(questionnairePath(id), cookie, 'legacy'))).questionnaire.comment, answerSecret);
  await rejected(h.request(reviewPath(id), cookie, tab), 404, 'not_found');
});

test('history classifies reception transitions and fail-closed states using only public metadata', async () => {
  const h = await harness('on'), cookie = await h.browser(), active = await create(h, cookie), cancelled = await create(h, cookie);
  const receive = (tab: string) => ok(h.request('/api/reception', cookie, tab, undefined, 'POST'));
  const current = async () => (await history(h, cookie)).sessions.find(item => item.sessionId === active)!;
  const phase = async (status: string, reception: string, resumable = true) => {
    const value = await current();
    assert.equal(value.status, status);
    assert.equal(value.reception?.status, reception);
    assert.equal(value.resumable, resumable);
    return value;
  };
  await receive(active);
  await receive(cancelled);
  await phase('waiting', 'waiting');
  assert.equal((await history(h, cookie)).receptionMode, 'on');
  const owner = await h.entry(cookie, active), cancelledOwner = await h.entry(cookie, cancelled);
  const approved = await owner.adminApproveReception({ expectedRevision: 0, order: 0, protocol: await h.displayed() });
  await cancelledOwner.adminCancelReception({ expectedRevision: 0 });
  const start = (revision: number, expectedRecordId?: string) => h.request('/api/start', cookie, active, {
    version: 2, expectedReceptionRevision: revision, ...(expectedRecordId === undefined ? {} : { expectedRecordId }),
  });
  await phase('ready', 'ready');
  const started = await ok(start(approved.revision)), firstId = started.trial.sessionId;
  await rejected(start(approved.revision), 409, 'trial_changed');
  await phase('in_progress', 'in_progress');
  h.failFinal = true;
  await rejected(h.request('/api/names', cookie, active, names(firstId, started.trial.events.length)), 502, 'ai_unavailable');
  await phase('submitting', 'in_progress');
  h.failFinal = false;
  await ok(h.request('/api/ai-submit', cookie, active, { expectedRecordId: firstId }));
  assert.equal((await phase('questionnaire_waiting', 'questionnaire')).hasUnansweredQuestionnaire, true);
  await rejected(start((await current()).reception!.revision, firstId), 409, 'questionnaire_required');
  await ok(h.request(questionnairePath(firstId), cookie, active, submission(null)));
  const ready = await phase('ready_next', 'in_progress');
  assert.equal(ready.hasUnansweredQuestionnaire, false);
  const second = await ok(start(ready.reception!.revision, firstId));
  await ok(h.request('/api/names', cookie, active, names(second.trial.sessionId, second.trial.events.length)));
  const finished = await phase('finished', 'finished', false);
  assert.equal(finished.hasUnansweredQuestionnaire, true);
  assert.deepEqual(finished.records.map(record => record.recordId).sort(), [firstId, second.trial.sessionId].sort());
  assert.equal(finished.activeRecordId, second.trial.sessionId);
  assert.deepEqual((await history(h, cookie)).sessions.map(item => [item.sessionId, item.status, item.resumable]), [
    [active, 'finished', false], [cancelled, 'cancelled', false],
  ]);
  const blocked = await create(h, cookie);
  await receive(blocked);
  await (await h.entry(cookie, blocked)).adminApproveReception({ expectedRevision: 0, order: 0, protocol: await h.displayed() });
  h.damageSettings();
  const inaccessible = await history(h, cookie);
  assert.equal(inaccessible.receptionMode, 'unavailable');
  assert.equal(inaccessible.sessions.find(item => item.sessionId === blocked)?.status, 'unavailable');
  assertPublicHistory(inaccessible.sessions, [approved.receptionId, approved.objectId, approved.plan.protocolId,
    'repair-first', 'bypass-enabled', ...(await h.catalog(cookie)).map(item => item.doName)]);
});

test('capacity reclaims old never-used slots while retaining a saved trial', async () => {
  const h = await harness(), cookie = await h.browser();
  const saved = await create(h, cookie);
  await ok(h.request('/api/start', cookie, saved, { version: 2 }));
  const empty = await Promise.all(Array.from({ length: MAX_EMPTY_TAB_SESSIONS }, () => create(h, cookie)));
  await rejected(h.request('/api/sessions', cookie, undefined, {}), 429, 'rate_limited');
  const entries = await h.catalog(cookie);
  const old = new Date(Date.now() - EMPTY_TAB_SESSION_MAX_AGE_MS - 1000).toISOString();
  await h.ownerStorage(h.rootName(cookie)).put({ 'browser:sessions:v1': entries.map(item => ({ ...item, createdAt: old })) });
  await create(h, cookie);
  assert.deepEqual((await history(h, cookie)).sessions.map(item => item.sessionId), [saved]);
  await rejected(h.request('/api/state', cookie, empty[0]), 404, 'not_found');
});

test('local sessions survive server restart, isolate data and reject stale questionnaire writes', async t => {
  const h = await web(t);
  const route = (path: string, sessionId?: string, body?: unknown, cookie = h.cookie, method = body === undefined ? 'GET' : 'POST') =>
    fetch(h.base() + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(sessionId ? { 'X-Tab-Session': sessionId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await rejected(route('/api/sessions'), 401, 'session_required');
  await h.page();
  const ownCookie = h.cookie;
  const { sessionId: a } = await ok(route('/api/sessions', undefined, undefined, ownCookie, 'POST'), 201);
  const { sessionId: b } = await ok(route('/api/sessions', undefined, {}), 201);
  assert.equal((await route('/tab-session.js')).status, 200);
  assert.deepEqual(await ok(route('/api/sessions')), { receptionMode: 'off', sessions: [] });
  const first = await ok(route('/api/start', a, { version: 2 }));
  const leftId = first.trial.sessionId;
  const second = await ok(route('/api/start', b, { version: 2 }));
  assert.notEqual(leftId, second.trial.sessionId);
  await rejected(route('/api/names', a, names(leftId, first.trial.events.length + 1)), 409, 'trial_changed');
  await h.tasks[0].complete();
  await rejected(route('/api/names', a, names(leftId, first.trial.events.length)), 400, 'already_submitted');
  await rejected(route('/api/start', a, { version: 2 }), 409, 'trial_changed');
  const writes = await Promise.all([route(questionnairePath(leftId), a, draft(null)), route(questionnairePath(leftId), a, draft(null))]);
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
  const at = (await ok(route(questionnairePath(leftId), a))).questionnaire.updatedAt;
  const secondDraft = await ok(route(questionnairePath(leftId), a, draft(at)));
  assert.notEqual(secondDraft.questionnaire.updatedAt, at);
  await rejected(route(questionnairePath(leftId), a, draft(at)), 409, 'trial_changed');
  await h.restart();
  assert.deepEqual(await ok(route('/api/state', b)), second);
  assert.equal((await ok(route('/api/state', a))).trial.status, 'completed');
  assert.equal((await ok(route('/api/state', 'legacy'))).trial, null);
  await rejected(route(questionnairePath(leftId), b), 404, 'not_found');
  await rejected(route('/api/state', crypto.randomUUID()), 404, 'not_found');
  h.cookie = '';
  await h.page();
  await rejected(route('/api/state', a), 404, 'not_found');
  assert.deepEqual(await ok(route('/api/sessions')), { receptionMode: 'off', sessions: [] });
  const owned = await ok(route('/api/sessions', undefined, undefined, ownCookie));
  assertPublicHistory(owned.sessions, [ownCookie]);
  assert.deepEqual(owned.sessions.map((item: BrowserSessionSummary) => [item.sessionId, item.status]), [[a, 'finished'], [b, 'in_progress']]);
});
