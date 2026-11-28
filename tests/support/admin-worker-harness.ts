// A real edge → participant DO → AdminIndex for the researcher-settings tests. Only the trial factory is replaced and no model is
// ever called. Synthetic values only; none of them is a research choice.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clone, config, raw } from './s5-base/support.ts';
import { createTrialV2, trialStimulusV2 } from '../../dialogue-model/runtime/stimuli/scatter-v2.mjs';

registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
const { default: edge, TangramSession, AdminIndex }: any = await import(new URL('../../workers/tangram-experiment/src/index.ts', import.meta.url).href);
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init); }
};
export const origin = 'https://admin-worker.invalid', adminToken = 'synthetic-admin-token-01234567890123456789';
export const RF = 'repair-first', BE = 'bypass-enabled';

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

export function harness() {
  const stores = new Map<string, ReturnType<typeof memory>>(), objects = new Map<string, any>(), inputs: any[] = [], pending: Promise<unknown>[] = [];
  const indexStorage = memory();
  // The release before the startup switch has no startup step; restartAsCurrent() starts the current release on the same storage.
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
    object: (cookie: string) => get(cookie.split('=')[1]),
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
export type H = ReturnType<typeof harness>;
export const reception = (h: H, cookie: string) => h.snapshot(cookie)['reception:v1'];
export const waitingBrowser = async (h: H) => { const cookie = await h.browser(); assert.equal((await h.post('/api/reception', cookie)).status, 200); return cookie; };
export const start = (h: H, cookie: string) => h.post('/api/start', cookie, { version: 2, expectedReceptionRevision: reception(h, cookie).revision });

/** The approval form for this reception exactly as the reception list shows it: the displayed protocol version rides in hidden fields. */
export async function approvalFormOf(h: H, cookie: string, order = 0) {
  const { receptionId, number } = reception(h, cookie), page = await (await h.admin('/admin/receptions')).text();
  const body = page.match(new RegExp(`<form method="post" action="/admin/reception/${receptionId}/approve">([\\s\\S]*?)</form>`, 'u'))?.[1];
  assert.ok(body, 'the list offers approval for this reception');
  const form = new URLSearchParams();
  for (const [, name, value] of body.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/gu)) form.set(name, value);
  form.set('order', String(order)); form.set('confirm', number);
  return form;
}
export const approveWith = (h: H, cookie: string, form: URLSearchParams) =>
  h.admin(`/admin/reception/${reception(h, cookie).receptionId}/approve`, form, 'application/json');
export async function approved(h: H, cookie: string, form: URLSearchParams) {
  const response = await approveWith(h, cookie, form);
  assert.equal(response.status, 200, await response.text());
}
/** Per figure: the AI side's turn relative to the human side, from the real generator. */
export function relativeTurns(input: { seed: number; rotationMode: string; figureSelection?: unknown }) {
  const trial = createTrialV2(input as never), { angles } = trialStimulusV2(trial);
  const byFigure = (side: 'human' | 'ai') => Object.fromEntries(Object.entries(trial.key[side] as Record<string, string>).map(([slot, figure]) => [figure, angles[side][slot]]));
  const human = byFigure('human'), ai = byFigure('ai');
  return Object.keys(human).map(figure => (ai[figure] - human[figure] + 360) % 360);
}
/**
 * A protocol saved straight into the settings store, as an earlier release saved it (no reference memory, so neither a model nor an
 * observation stock is involved). The default is ±90° on three figures; a patch makes any other saved shape.
 */
export async function savePreviousProtocol(h: H, patch: Record<string, unknown> = {}) {
  const current = (await h.index.readReceptionSettings()).protocol;
  const result = await h.index.saveReceptionProtocol({ expectedRevision: current?.revision ?? 0, fields: { allowedOrders: [[BE, RF], [RF]], seedPolicy: 'per_trial',
    referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
    figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] }, figureSetPolicy: 'shared', ...patch } });
  assert.equal(result.ok, true);
}
