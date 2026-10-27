import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clone, config, load } from './support/s5-base/support.ts';

// Same in-process Cloudflare shim used by s5-base-worker.test.ts. No browser,
// network, real AI proxy, production data, or real credentials are involved.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return {
    url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true,
  };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
  }
  return next(specifier, context);
} });
const root = process.env.S5_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { default: edge, TangramSession }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/index.ts').href);
const oldNow = Date.now;
Date.now = () => 946684800001;
after(() => { Date.now = oldNow; });

const initialOwner = load('OWNER-ACTIVE.json');
const originalId: string = initialOwner.ownerId;
const originalRecord = initialOwner.admissions.initial.record;
const originalCookie = 'tangram_session=' + originalId;
const request = (path: string, cookie?: string, body?: unknown, site?: string) => new Request('https://i136.invalid' + path, {
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(site ? { 'Sec-Fetch-Site': site } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
});
const responseCookie = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? null;

function harness() {
  const stores = new Map<string, Map<string, any>>();
  const objects = new Map<string, any>();
  const pending: Promise<unknown>[] = [];
  let modelCalls = 0;
  stores.set(originalId, new Map(Object.entries(clone({
    'base:owner:v1': initialOwner, active: originalRecord,
    ['record:' + originalRecord.recordId]: originalRecord,
    ledger: { [originalRecord.recordId]: 946684800000 },
  }))));
  const objectEnv = {
    BASE_ASSIGNMENT_JSON: JSON.stringify(config()), RECORD_RETENTION_DAYS: '30',
    AI_PROXY: { async chat() { modelCalls++; throw Error('unexpected synthetic model call'); } },
  };
  const getObject = (id: string) => {
    if (!stores.has(id)) stores.set(id, new Map());
    if (!objects.has(id)) {
      let values = stores.get(id)!;
      const storage = {
        async get(key: string) { return clone(values.get(key)); },
        async put(updates: Record<string, unknown>) { for (const [key, value] of Object.entries(updates)) values.set(key, clone(value)); },
        async delete(keys: string | string[]) { let count = 0; for (const key of Array.isArray(keys) ? keys : [keys]) count += Number(values.delete(key)); return count; },
        async transaction(fn: (tx: any) => Promise<any>) {
          const before = clone(values);
          try { return await fn(this); } catch (error) { values = before; stores.set(id, values); throw error; }
        },
        async setAlarm() {}, async deleteAlarm() {},
      };
      objects.set(id, new TangramSession({ storage, id: { toString: () => id }, waitUntil(promise: Promise<unknown>) { pending.push(promise); } }, objectEnv));
    }
    return objects.get(id);
  };
  const env = {
    ...objectEnv,
    NAMING_SESSIONS: { idFromName: (id: string) => id, get: getObject },
    ASSETS: { async fetch() { return new Response('<html><head></head><body></body></html>'); } },
  };
  return {
    fetch: (input: Request) => edge.fetch(input, env) as Promise<Response>,
    sessionFetch: (input: Request) => getObject(originalId).fetch(input) as Promise<Response>,
    evict() { objects.clear(); },
    originalSnapshot: () => clone(Object.fromEntries(stores.get(originalId)!)),
    async done() { await Promise.all(pending); assert.equal(modelCalls, 0); },
  };
}

for (const site of ['same-origin', 'none', 'cross-site']) test('i136 same Cookie second tab preserves active trial and transcript: ' + site, async () => {
  const h = harness();
  const a = await h.fetch(request('/api/state', originalCookie));
  assert.equal(a.status, 200);
  const before = await a.json();
  assert.equal(before.trial.sessionId, originalRecord.recordId);
  assert.ok(before.trial.events.length > 0, 'synthetic archived transcript was restored');
  const snapshot = h.originalSnapshot();
  const pageB = await h.fetch(request('/', originalCookie, undefined, site));
  assert.equal(pageB.status, 200);
  assert.equal(responseCookie(pageB), originalCookie);
  const b = await h.fetch(request('/api/state', originalCookie));
  assert.equal(b.status, 200);
  assert.deepEqual(await b.json(), before);
  const again = await h.fetch(request('/api/state', originalCookie));
  assert.deepEqual(await again.json(), before);
  assert.deepEqual(h.originalSnapshot(), snapshot);
  await h.done();
});

test('i136 another profile cookie-less page does not delete original DO or its cold-restored trial', async () => {
  const h = harness();
  const before = await (await h.fetch(request('/api/state', originalCookie))).json();
  const snapshot = h.originalSnapshot();
  const otherPage = await h.fetch(request('/'));
  assert.equal(otherPage.status, 200);
  const otherCookie = responseCookie(otherPage);
  assert.ok(otherCookie);
  assert.notEqual(otherCookie, originalCookie);
  const otherState = await h.fetch(request('/api/state', otherCookie));
  assert.equal(otherState.status, 200);
  assert.equal((await otherState.json()).trial, null);
  assert.deepEqual(h.originalSnapshot(), snapshot, 'other profile must not touch original storage');
  h.evict();
  const restored = await h.fetch(request('/api/state', originalCookie));
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), before);
  const afterRestore = h.originalSnapshot();
  // Cold restore can advance persistence metadata; the retained research record
  // and the active admission must still be unchanged.
  assert.deepEqual(afterRestore.active, snapshot.active);
  assert.deepEqual(afterRestore['record:' + originalRecord.recordId], snapshot['record:' + originalRecord.recordId]);
  assert.equal(afterRestore['base:owner:v1'].activeKey, snapshot['base:owner:v1'].activeKey);
  assert.deepEqual(afterRestore['base:owner:v1'].admissions, snapshot['base:owner:v1'].admissions);
  await h.done();
});

test('i136 DO repeated start from second tab refuses replacement of active trial', async () => {
  const h = harness();
  const before = await (await h.fetch(request('/api/state', originalCookie))).json();
  const snapshot = h.originalSnapshot();
  // Direct DO fetch matches s5-base-worker.test.ts: Node's Request constructor
  // requires duplex for streamed proxy bodies, while Cloudflare's does not.
  const start = await h.sessionFetch(request('/api/start', originalCookie, { version: 2 }));
  assert.equal(start.status, 409);
  assert.deepEqual(await start.json(), { error: 'busy' });
  assert.deepEqual(await (await h.fetch(request('/api/state', originalCookie))).json(), before);
  assert.deepEqual(h.originalSnapshot(), snapshot);
  await h.done();
});

// The fix: a page load issues a SameSite=Lax cookie, which browsers send on a
// top-level navigation from another site, so that entry reaches the cross-site
// case above (same id kept) instead of arriving cookie-less. A cookie-less page
// load still issues a new id; that is the other-profile case and is unchanged.
// The browser behaviour itself is checked by the real-browser E2E (Issue #136).
test('i136 page loads issue a SameSite=Lax session cookie so cross-site entries keep the shared id', async () => {
  const h = harness();
  for (const page of [await h.fetch(request('/', originalCookie, undefined, 'cross-site')), await h.fetch(request('/'))]) {
    const set = page.headers.get('set-cookie') ?? '';
    assert.match(set, /; SameSite=Lax$/);
    assert.doesNotMatch(set, /SameSite=Strict/);
  }
  await h.done();
});
