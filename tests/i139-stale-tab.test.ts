import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { privateBaseOptions } from './support/s5-private-options.mjs';
import { config, clone } from './support/s5-base/support.ts';
import { emptyAdminIndex } from './support/i139-empty-admin-index.ts';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
  }
  return next(specifier, context);
} });
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const { TangramSession, AdminIndex }: any = await import(pathToFileURL(sourceRoot + '/workers/tangram-experiment/src/index.ts').href);
type Requester = (path: string, body?: unknown) => Promise<Response>;

// Only model I/O is synthetic. Both adapters use real tasks, assignment state,
// archives and questionnaire routes. No external requests or credentials.
function model() {
  let calls = 0;
  return { get calls() { return calls; }, async complete(messages: any[]) {
    calls++;
    const text = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const memo = text.match(/内部参照ID（非公開[^\n]*\n(\[.*\])/);
    const ids = memo ? JSON.parse(memo[1]).map((entry: any) => entry.id) : [];
    const last = messages.at(-1)?.content;
    return { text: text.includes('【非公開の対話判断】')
      ? JSON.stringify({ action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null })
      : typeof last === 'string' && last.includes('最終提出要求')
        ? JSON.stringify(Object.fromEntries(ids.map((id: string) => [id, 'Synthetic name'])))
        : 'Synthetic acknowledgement.', model: 'synthetic-offline', latencyMs: 0 };
  } };
}
async function harness(t: any, adapter: string) {
  const client = model();
  if (adapter === 'local') {
    const options = await privateBaseOptions(t);
    const server = createNamingServer({ client, ...options });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise<void>((resolve, reject) => server.close((e?: Error) => e ? reject(e) : resolve())));
    const origin = 'http://127.0.0.1:' + (server.address() as any).port;
    const page = await fetch(origin); await page.text();
    const cookie = page.headers.get('set-cookie')!.split(';')[0];
    const request: Requester = (path, body) => fetch(origin + path, { headers: { Cookie: cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { request, client, prepare: async (id: string) => {
      const r = await fetch(origin + '/admin/record/' + id + '/prepare-next', { method: 'POST',
        headers: { Authorization: 'Bearer ' + options.adminToken, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 201);
    } };
  }
  let values = new Map<string, any>();
  const pending: Promise<unknown>[] = [];
  const storage = {
    async get(key: string) { return clone(values.get(key)); },
    async put(updates: Record<string, unknown>) { for (const [key, value] of Object.entries(updates)) values.set(key, clone(value)); },
    async delete(keys: string | string[]) { let n = 0; for (const key of Array.isArray(keys) ? keys : [keys]) n += Number(values.delete(key)); return n; },
    async transaction(fn: (tx: any) => Promise<any>) { const before = clone(values); try { return await fn(this); } catch (e) { values = before; throw e; } },
    async setAlarm() {}, async deleteAlarm() {},
  };
  const object = new TangramSession({ storage, id: { toString: () => 'a'.repeat(64) }, waitUntil(p: Promise<unknown>) { pending.push(p); } }, {
    BASE_ASSIGNMENT_JSON: JSON.stringify(config()), ADMIN_INDEX: emptyAdminIndex(AdminIndex), AI_PROXY: { async chat(payload: any) {
      const reply = await client.complete(payload.messages);
      return { status: 200, data: { model: reply.model, choices: [{ message: { content: reply.text } }] } };
    } },
  });
  assert.equal(await object.registerBaseOwner(), true);
  t.after(async () => { await Promise.all(pending); });
  const request: Requester = (path, body) => object.fetch(new Request('https://synthetic.invalid' + path, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }));
  return { request, client, prepare: async (id: string) => { await object.adminPrepareNext(id); } };
}
const bodies = (trial: any): Record<string, object> => ({
  '/api/message': { text: 'Synthetic stale-tab message', clientId: 'stale-tab-message' },
  '/api/names': { confirm: true, names: Object.fromEntries(trial.scene.shapes.map((s: any) => [s.id, null])) },
  '/api/ai-submit': {}, '/api/retry': {},
});
async function state(request: Requester) {
  const r = await request('/api/state'); assert.equal(r.status, 200); return (await r.json()).trial;
}
async function start(request: Requester) {
  const r = await request('/api/start', { version: 2 }); assert.equal(r.status, 200); return (await r.json()).trial;
}
async function nextTrial(h: Awaited<ReturnType<typeof harness>>) {
  const first = await start(h.request);
  const r = await h.request('/api/names', { ...bodies(first)['/api/names'], expectedRecordId: first.sessionId });
  assert.equal(r.status, 200); assert.equal((await r.json()).trial.status, 'completed');
  await h.prepare(first.sessionId);
  const second = await state(h.request);
  assert.notEqual(second.sessionId, first.sessionId);
  return { first, second };
}
for (const adapter of ['worker', 'local']) {
  for (const path of ['/api/message', '/api/names', '/api/ai-submit', '/api/retry']) {
    for (const expected of ['stale', 'missing']) test(`i139 ${adapter} ${path}: ${expected} expectation is rejected without changing the current trial`, async t => {
      const h = await harness(t, adapter), { first, second } = await nextTrial(h);
      const before = await state(h.request), calls = h.client.calls;
      // Two tabs share an owner; tab A retained first.sessionId while tab B
      // moved to second. Valid current shape names ensure no other gate masks it.
      const response = await h.request(path, { ...bodies(second)[path], ...(expected === 'stale' ? { expectedRecordId: first.sessionId } : {}) });
      const after = await state(h.request);
      assert.deepEqual(after, before, 'events, submissions and names must not change');
      assert.equal(h.client.calls, calls, 'rejected writes must not invoke the model');
      assert.deepEqual([response.status, await response.json()], [409, { error: 'trial_changed' }]);
    });
    test(`i139 ${adapter} ${path}: matching expectation preserves success`, async t => {
      const h = await harness(t, adapter), current = await start(h.request);
      const r = await h.request(path, { ...bodies(current)[path], expectedRecordId: current.sessionId });
      assert.equal(r.status, path === '/api/message' ? 202 : 200);
      assert.equal((await r.json()).trial.sessionId, current.sessionId);
    });
    test(`i139 ${adapter} ${path}: no trial keeps trial_required`, async t => {
      const h = await harness(t, adapter);
      const r = await h.request(path, {});
      assert.deepEqual([r.status, await r.json()], [400, { error: 'trial_required' }]);
    });
  }
  test(`i139 ${adapter}: late questionnaire writes only the record named in its path`, async t => {
    const h = await harness(t, adapter), { first, second } = await nextTrial(h);
    const before = await state(h.request);
    const response = await h.request('/api/records/' + first.sessionId + '/questionnaire', { answers: { smoothness: 4 }, submit: false });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).recordId, first.sessionId);
    const old = await (await h.request('/api/records/' + first.sessionId + '/questionnaire')).json();
    assert.equal(old.questionnaire.answers.smoothness, 4);
    assert.equal((await (await h.request('/api/records/' + second.sessionId + '/questionnaire')).json()).questionnaire, null);
    assert.deepEqual(await state(h.request), before);
  });
}
