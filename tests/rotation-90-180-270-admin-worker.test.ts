// #269 管理画面: 既定が保存・承認・開始まで効くこと、移行の後の承認、承認済みの受付と開始済みの試行の不変。
// 実際の Worker → 受付の DO → AdminIndex を通す。差し替えるのは試行の生成だけで、モデルは呼ばない。合成の値で研究条件を決めない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clone, config, raw } from './support/s5-base/support.ts';
import { checkedValues, submittedFrom } from './support/settings-form.ts';
import { createTrialV2, trialStimulusV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';

registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const { default: edge, TangramSession, AdminIndex }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/index.ts').href);
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init); }
};
const NEW = 'relative_90_180_270', origin = 'https://rotation.invalid', adminToken = 'synthetic-admin-token-01234567890123456789';
const RF = 'repair-first', BE = 'bypass-enabled';

function memory() {
  let values = new Map<string, any>(), queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const view = (map: Map<string, any>) => ({
    async get(key: string) { return clone(map.get(key)); },
    async put(updates: Record<string, unknown>) { for (const [k, v] of Object.entries(updates)) map.set(k, clone(v)); },
    async delete(keys: string | string[]) { let n = 0; for (const k of Array.isArray(keys) ? keys : [keys]) n += Number(map.delete(k)); return n; },
    async list({ prefix, reverse, limit }: { prefix: string; reverse?: boolean; limit?: number }) {
      let rows = [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows.reverse(); if (limit) rows = rows.slice(0, limit); return new Map(rows);
    },
  });
  return { snapshot: () => clone(Object.fromEntries(values)), get: (k: string) => view(values).get(k),
    put: (u: Record<string, unknown>) => enqueue(() => view(values).put(u)), delete: (k: string | string[]) => enqueue(() => view(values).delete(k)),
    list: (o: any) => view(values).list(o),
    transaction(fn: (tx: any) => Promise<any>) { return enqueue(async () => { const staged = clone(values), r = await fn(view(staged)); values = staged; return r; }); },
    async setAlarm() {}, async deleteAlarm() {} };
}
/** workerd RPC results carry a non-enumerable function-valued Symbol.dispose. */
function rpc(target: any) {
  return new Proxy(target, { get(t, key) {
    const value = t[key];
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      const result = await value.apply(t, args);
      if (result && typeof result === 'object') Object.defineProperty(result, Symbol.dispose, { value() {}, enumerable: false });
      return result;
    };
  } });
}

function harness() {
  const stores = new Map<string, ReturnType<typeof memory>>(), objects = new Map<string, any>(), inputs: any[] = [], pending: Promise<unknown>[] = [];
  const indexStorage = memory();
  // The release before this change has no startup step; restartAsCurrent() starts this release on the same storage.
  let index: any = new AdminIndex({ storage: indexStorage }, {});
  const objectEnv: any = { BASE_ASSIGNMENT_JSON: JSON.stringify(config()), RECEPTION_REQUIRED: 'on',
    ADMIN_INDEX: { idFromName: (id: string) => id, get: () => rpc(index) },
    AI_PROXY: { async chat() { throw Error('no synthetic test may call a model'); } } };
  function get(id: string) {
    if (!stores.has(id)) stores.set(id, memory());
    if (!objects.has(id)) {
      const o = new TangramSession({ storage: stores.get(id), id: { toString: () => id }, waitUntil(p: Promise<unknown>) { pending.push(p); } }, objectEnv);
      o.createTrial = async (input: any) => {
        inputs.push({ ...input, restore: input.restore ? clone(input.restore) : null });
        const record = clone(input.restore ?? raw());
        if (!input.restore) {
          record.recordId = crypto.randomUUID(); record.seed = input.seed; record.strategy = input.strategy; record.options.referenceMemory = input.referenceMemory;
          record.options.rotationMode = input.rotationMode;
          if (input.openingMode) record.options.openingMode = input.openingMode;
          if (input.figureSelection) record.options.figureSelection = input.figureSelection;
          // The real generator's record, since a non-legacy figure selection must be carried by the stimulus.
          record.stimulus = trialStimulusV2(createTrialV2({ seed: input.seed, rotationMode: input.rotationMode,
            ...(input.figureSelection ? { figureSelection: input.figureSelection } : {}) }));
        }
        const task = { getState: () => ({ version: 2, sessionId: record.recordId, status: record.status, events: [], submitted: false, aiSubmitted: false }),
          persistNow: async () => input.onPersist(clone(record)), whenIdle: async () => {}, message: () => ({ eventId: 'synthetic', duplicate: false }),
          retry: async () => {}, submitHuman: async () => ({}), submitAI: async () => ({}) };
        await input.onPersist(clone(record)); return task;
      };
      objects.set(id, o);
    }
    return objects.get(id);
  }
  const env = { ...objectEnv, NAMING_SESSIONS: { idFromName: (id: string) => id, idFromString: (id: string) => id, get },
    ADMIN_TOKEN: adminToken, ADMIN_RATE_LIMIT: { async limit() { return { success: true }; } },
    ASSETS: { async fetch() { return new Response('<html></html>'); } }, START_RATE_LIMIT: { async limit() { return { success: true }; } },
    QUESTIONNAIRE_RATE_LIMIT: { async limit() { return { success: true }; } } };
  const call = (path: string, init: RequestInit = {}) => edge.fetch(new Request(origin + path, init), env) as Promise<Response>;
  return {
    get index() { return index; }, inputs,
    snapshot: (cookie: string) => stores.get(cookie.split('=')[1])!.snapshot(),
    evict() { objects.clear(); },
    async restartAsCurrent() {
      const startups: Promise<unknown>[] = [];
      index = new AdminIndex({ storage: indexStorage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => { const run = fn(); startups.push(run); return run; },
        waitUntil() {} }, {});
      await Promise.all(startups);
    },
    async done() { await Promise.all(pending); },
    async browser() { const r = await call('/'); assert.equal(r.status, 200); return r.headers.get('set-cookie')!.split(';')[0]; },
    post: (path: string, cookie: string, body?: unknown) => call(path, { method: 'POST', headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    get: (path: string, cookie: string) => call(path, { headers: { Cookie: cookie } }),
    /** A researcher request with the admin credentials; a form is posted as a browser posts it. */
    admin: (path: string, form?: URLSearchParams, accept = 'text/html') => call(path, { method: form ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + adminToken, Origin: origin, 'Sec-Fetch-Site': 'same-origin', Accept: accept,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, ...(form ? { body: String(form) } : {}) }),
  };
}
type H = ReturnType<typeof harness>;
const reception = (h: H, cookie: string) => h.snapshot(cookie)['reception:v1'];
const waitingBrowser = async (h: H) => { const cookie = await h.browser(); assert.equal((await h.post('/api/reception', cookie)).status, 200); return cookie; };
const start = (h: H, cookie: string) => h.post('/api/start', cookie, { version: 2, expectedReceptionRevision: reception(h, cookie).revision });

/** The approval form for this reception exactly as the reception list shows it: the displayed protocol version rides in hidden fields. */
async function approvalFormOf(h: H, cookie: string, order = 0) {
  const { receptionId, number } = reception(h, cookie), page = await (await h.admin('/admin/receptions')).text();
  const body = page.match(new RegExp(`<form method="post" action="/admin/reception/${receptionId}/approve">([\\s\\S]*?)</form>`, 'u'))?.[1];
  assert.ok(body, 'the list offers approval for this reception');
  const form = new URLSearchParams();
  for (const [, name, value] of body.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/gu)) form.set(name, value);
  form.set('order', String(order)); form.set('confirm', number);
  return form;
}
const approveWith = (h: H, cookie: string, form: URLSearchParams) => h.admin(`/admin/reception/${reception(h, cookie).receptionId}/approve`, form, 'application/json');
async function approved(h: H, cookie: string, form: URLSearchParams) {
  const response = await approveWith(h, cookie, form);
  assert.equal(response.status, 200, await response.text());
}
/** Per figure: the AI side's turn relative to the human side, from the real generator. */
function relativeTurns(input: { seed: number; rotationMode: string; figureSelection?: unknown }) {
  const trial = createTrialV2(input as never), { angles } = trialStimulusV2(trial);
  const byFigure = (side: 'human' | 'ai') => Object.fromEntries(Object.entries(trial.key[side] as Record<string, string>).map(([slot, figure]) => [figure, angles[side][slot]]));
  const human = byFigure('human'), ai = byFigure('ai');
  return Object.keys(human).map(figure => (ai[figure] - human[figure] + 360) % 360);
}
/** The previous release saves a protocol: no reference memory, so neither a model nor an observation stock is involved. */
async function savePreviousProtocol(h: H, patch: Record<string, unknown> = {}) {
  const current = (await h.index.readReceptionSettings()).protocol;
  const result = await h.index.saveReceptionProtocol({ expectedRevision: current?.revision ?? 0, fields: { allowedOrders: [[BE, RF], [RF]], seedPolicy: 'per_trial',
    referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
    figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] }, figureSetPolicy: 'shared', ...patch } });
  assert.equal(result.ok, true);
}

test('the default is effective end to end: the page\'s preselected rotation is saved, approved and started, and the AI side turns 90, 180 or 270 degrees', async () => {
  const h = harness(); await h.restartAsCurrent();
  const page = await (await h.admin('/admin/reception-settings')).text();
  const chosen = checkedValues(page, 'rotationMode');
  assert.equal(chosen.length, 1, 'one rotation is preselected on the first visit');
  const form = submittedFrom(page);
  for (const [name, value] of [['orders', 'rf-be'], ['seedPolicy', 'shared'], ['referenceMemory', 'off'], ['betweenTrials', 'none'], ['receptionNumberFormat', 'daily_seq3'],
    ['figureMode', 'seeded_random'], ['figureSetPolicy', 'shared']]) form.set(name, value);
  assert.equal((await h.admin('/admin/reception-settings/protocol', form)).status, 303);

  const cookie = await waitingBrowser(h);
  await approved(h, cookie, await approvalFormOf(h, cookie));
  assert.deepEqual(reception(h, cookie).plan.trials.map((t: any) => t.rotationMode), [chosen[0], chosen[0]]);
  assert.equal((await start(h, cookie)).status, 200);
  const input = h.inputs.find(i => !i.restore);
  assert.equal(input.rotationMode, chosen[0]);
  const turns = relativeTurns(input);
  assert.equal(turns.length, 3);
  assert.ok(turns.every(turn => [90, 180, 270].includes(turn)), JSON.stringify(turns));
  await h.done();
});

test('after the startup switch a new approval carries the new revision and mode, and an approved reception keeps its frozen plan and started trial', async () => {
  const h = harness();
  await savePreviousProtocol(h);
  const a = await waitingBrowser(h), b = await waitingBrowser(h);
  const staleForB = await approvalFormOf(h, b);
  assert.equal(staleForB.get('protocolRevision'), '1');
  await approved(h, a, await approvalFormOf(h, a));
  const startedA = await start(h, a);
  assert.equal(startedA.status, 200);
  const recordA: string = (await startedA.json()).trial.sessionId;
  const settledA = h.snapshot(a);
  const oldSha = (await h.index.readReceptionSettings()).protocol.sha256;

  await h.restartAsCurrent();
  const saved = (await h.index.readReceptionSettings()).protocol;
  assert.deepEqual([saved.revision, saved.protocol.rotationMode], [2, NEW]);
  assert.notEqual(saved.sha256, oldSha);
  const settings = await (await h.admin('/admin/reception-settings')).text();
  assert.deepEqual(checkedValues(settings, 'rotationMode'), [NEW]);
  assert.ok(settings.includes('revision 2') && settings.includes(oldSha) && settings.includes(saved.sha256), 'the history keeps the old revision and its sha256');
  assert.doesNotMatch(settings, /設定が変わりました/u);

  // The approved reception and its started trial are untouched, and the trial still restores with the mode it was made with.
  assert.deepEqual(h.snapshot(a), settledA);
  assert.deepEqual([reception(h, a).plan.protocolRevision, reception(h, a).plan.trials.map((t: any) => t.rotationMode)], [1, ['relative_pm90', 'relative_pm90']]);
  h.evict(); h.inputs.length = 0;
  assert.equal((await (await h.get('/api/state', a)).json()).trial.sessionId, recordA);
  assert.equal(h.inputs.find(i => i.restore).restore.options.rotationMode, 'relative_pm90');

  // The form shown before the switch is refused; the form shown after it passes against the new revision.
  const refused = await approveWith(h, b, staleForB);
  assert.equal(refused.status, 409); assert.equal((await refused.json()).error, 'protocol_changed');
  assert.equal(reception(h, b).status, 'pending');
  const fresh = await approvalFormOf(h, b);
  assert.deepEqual([fresh.get('protocolRevision'), fresh.get('protocolSha256')], ['2', saved.sha256]);
  await approved(h, b, fresh);
  assert.deepEqual([reception(h, b).plan.protocolRevision, reception(h, b).plan.protocolSha256], [2, saved.sha256]);
  assert.deepEqual(reception(h, b).plan.trials.map((t: any) => t.rotationMode), [NEW, NEW]);

  h.inputs.length = 0;
  assert.equal((await start(h, b)).status, 200);
  const input = h.inputs.find(i => !i.restore);
  assert.equal(input.rotationMode, NEW);
  assert.ok(relativeTurns(input).every(turn => [90, 180, 270].includes(turn)));

  const list = await (await h.admin('/admin/receptions')).text();
  const shown = [a, b].map(cookie => list.match(new RegExp(`data-id="${reception(h, cookie).receptionId}"[\\s\\S]*?data-label="回転">([^<]*)</td>`, 'u'))?.[1]);
  assert.deepEqual(shown, ['±90°', '90°・180°・270°']);
  await h.done();
});
