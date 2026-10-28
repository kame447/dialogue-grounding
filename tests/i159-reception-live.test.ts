// #159: the reception list updates itself while open. Synthetic receptions only; no research condition is chosen here.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { handleAdmin, ADMIN_HEADERS, LIVE_CSP } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import { RECEPTIONS_LIVE_JS, VISIBLE_POLL_MS, HIDDEN_POLL_MS, FORCED_REFRESH_MS } from '../workers/tangram-experiment/src/admin/receptions-live.ts';
import { createReceptionAdminPort } from '../workers/tangram-experiment/src/admin/reception-adapter.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import type { ReceptionAdminRow, ReceptionProtocolStatus } from '../workers/tangram-experiment/src/admin/reception-port.ts';
import { FakeDocument, FakeElement, parse } from './support/i159-fake-dom.ts';

const TOKEN = 'synthetic-admin-token-01234567890123456789';
const ORIGIN = 'https://example.test';
const PROTOCOL = '44444444-4444-4444-8444-444444444444';
const SHA = 'c'.repeat(64);
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const old = '2026-10-27T00:00:00.000Z';

function fixture(options: { version?: boolean } = {}) {
  const rows: ReceptionAdminRow[] = [
    { receptionId: id(1), number: 'synthetic-001', createdAt: old, status: 'pending', revision: 1, plan: null, trials: [] },
    { receptionId: id(2), number: 'synthetic-002', createdAt: old, status: 'approved', revision: 2,
      plan: { order: ['repair-first'], rotationMode: 'relative_pm90', betweenTrials: 'none' }, trials: [] },
  ];
  let protocol: ReceptionProtocolStatus = { configured: true, mode: 'on', protocolId: PROTOCOL, revision: 7, sha256: SHA,
    allowedOrders: [['repair-first']], rotationMode: 'relative_pm90', betweenTrials: 'none' };
  let counter = 1, versionFails = false;
  const calls: string[] = [];
  const receptions: NonNullable<AdminDeps['receptions']> = {
    async protocol() { calls.push('protocol'); return protocol; },
    async listPage() { calls.push('listPage'); return { items: structuredClone(rows), next: null }; },
    async get() { return null; },
    async approve() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };
  if (options.version !== false) receptions.version = async (since: string | null) => {
    calls.push('version'); if (versionFails) throw new Error('PRIVATE index failure');
    return { version: counter.toString(16).padStart(64, '0'), newPending: since === null ? null : rows.filter(r => r.status === 'pending' && r.createdAt >= since).length };
  };
  let allowed = true;
  const deps: AdminDeps = { token: TOKEN, limiter: { async limit() { return { success: allowed }; } },
    async listPage() { return { items: [], next: null }; }, async getSummary() { return null; }, async getRecord() { return null; },
    async deleteRecord() {}, async audit() { return []; }, summarizeLatency, receptions };
  return { deps, rows, calls, change() { counter++; }, setProtocol(p: ReceptionProtocolStatus) { protocol = p; counter++; },
    failVersion() { versionFails = true; }, limit(on: boolean) { allowed = !on; } };
}
const get = (path: string, headers: Record<string, string> = {}) => new Request(ORIGIN + path, { headers: { Authorization: 'Bearer ' + TOKEN, ...headers } });

test('version endpoint requires admin credentials, is rate limited and absent without the version port', async () => {
  const f = fixture();
  const anonymous = await handleAdmin(new Request(ORIGIN + '/admin/receptions/version'), f.deps);
  assert.equal(anonymous.status, 401); assert.match(anonymous.headers.get('WWW-Authenticate') ?? '', /^Basic /);
  assert.equal((await handleAdmin(get('/admin/receptions/version', { Authorization: 'Bearer wrong-token-0123456789012345678901' }), f.deps)).status, 401);
  assert.deepEqual(f.calls, []);
  f.limit(true); assert.equal((await handleAdmin(get('/admin/receptions/version'), f.deps)).status, 429);
  assert.equal((await handleAdmin(get('/admin/receptions/version'), fixture({ version: false }).deps)).status, 404);
  const { receptions: _, ...none } = fixture().deps;
  for (const path of ['/admin/receptions/version', '/admin/receptions.js']) assert.equal((await handleAdmin(get(path), none)).status, 404);
});

test('version endpoint returns only an opaque version with the admin headers; failures are a closed 503', async () => {
  const f = fixture();
  const response = await handleAdmin(get('/admin/receptions/version'), f.deps);
  assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) assert.equal(response.headers.get(name), value, name);
  const text = await response.text(); assert.deepEqual(Object.keys(JSON.parse(text)), ['version']); assert.match(JSON.parse(text).version, /^[a-f0-9]{64}$/);
  for (const secret of [id(1), 'synthetic-001', PROTOCOL]) assert.ok(!text.includes(secret), secret);
  f.failVersion(); const failed = await handleAdmin(get('/admin/receptions/version'), f.deps);
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: 'reception_unavailable' });
});

test('script is served only after authentication, as a same-origin JavaScript file with the admin headers', async () => {
  const f = fixture();
  assert.equal((await handleAdmin(new Request(ORIGIN + '/admin/receptions.js'), f.deps)).status, 401);
  const response = await handleAdmin(get('/admin/receptions.js'), f.deps);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) assert.equal(response.headers.get(name), value, name);
  assert.equal(await response.text(), RECEPTIONS_LIVE_JS);
  assert.doesNotMatch(RECEPTIONS_LIVE_JS, /localStorage|sessionStorage|indexedDB|Notification|document\.cookie|innerHTML|eval\(|new Function/);
  assert.doesNotMatch(RECEPTIONS_LIVE_JS, /https?:\/\//);
});

test('live page: version is read before the list, one self-hosted script, CSP adds only script/connect self', async () => {
  const f = fixture();
  const response = await handleAdmin(get('/admin/receptions'), f.deps); const html = await response.text();
  assert.deepEqual(f.calls, ['version', 'protocol', 'listPage']);
  assert.equal(LIVE_CSP, ADMIN_HEADERS['Content-Security-Policy'] + "; script-src 'self'; connect-src 'self'");
  assert.equal(response.headers.get('Content-Security-Policy'), LIVE_CSP);
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) if (name !== 'Content-Security-Policy') assert.equal(response.headers.get(name), value, name);
  assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g), ['<script src="/admin/receptions.js" defer></script>']);
  assert.doesNotMatch(html, /\son\w+=/i);
  assert.match(html, new RegExp(`data-version="${'0'.repeat(63)}1"`)); assert.match(html, /data-since="\d{4}-\d{2}-\d{2}T[\d:.]+Z"/);
  assert.match(html, /<p id="reception-new" role="status" aria-live="polite"><\/p>/);
  // Other admin pages keep the script-free CSP.
  for (const path of ['/admin/entry', '/admin']) assert.equal((await handleAdmin(get(path), f.deps)).headers.get('Content-Security-Policy'), ADMIN_HEADERS['Content-Security-Policy']);
});

test('without a usable version the list renders as before: no script, no live regions, the strict CSP', async () => {
  for (const f of [fixture({ version: false }), (() => { const x = fixture(); x.failVersion(); return x; })()]) {
    const response = await handleAdmin(get('/admin/receptions'), f.deps); const html = await response.text();
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Security-Policy'), ADMIN_HEADERS['Content-Security-Policy']);
    assert.doesNotMatch(html, /<script|data-version|reception-new/);
  }
});

// ---- The client script, run in node:vm against the real admin routes ----
type Timer = { fn: () => void; ms: number };
async function client(f: ReturnType<typeof fixture>, path = '/admin/receptions') {
  const document = new FakeDocument(await (await handleAdmin(get(path), f.deps)).text());
  const timers: Timer[] = []; const requests: { url: string; init: any }[] = [];
  const windowListeners = new Map<string, () => void>();
  let reply: ((url: string) => Response | Promise<Response> | null) = () => null;
  const context = vm.createContext({
    document, navigator: { onLine: true }, location: { pathname: new URL(ORIGIN + path).pathname, search: new URL(ORIGIN + path).search },
    window: { addEventListener: (type: string, fn: () => void) => windowListeners.set(type, fn) },
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t: Timer) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    fetch: async (url: string, init: any) => {
      requests.push({ url, init });
      return reply(url) ?? handleAdmin(new Request(ORIGIN + url, { headers: { Authorization: 'Bearer ' + TOKEN, ...init.headers } }), f.deps);
    },
    DOMParser: class { parseFromString(html: string) { const root = parse(html, new FakeDocument('')); return { getElementById: (x: string) => root.getElementById(x) }; } },
    Set, Map, Date, Math, Number, Boolean, Error, Array, AbortSignal,
  });
  vm.runInContext(RECEPTIONS_LIVE_JS, context);
  // A poll cycle ends by scheduling the next one (or by stopping); wait for that rather than a fixed number of turns.
  const settle = async (done: () => boolean) => { for (let i = 0; i < 1000 && !done(); i++) await new Promise(r => setTimeout(r, 2)); };
  return {
    document, timers, requests, windowListeners,
    reply(fn: (url: string) => Response | Promise<Response> | null) { reply = fn; },
    settle,
    async tick() {
      const t = timers.shift(); assert.ok(t, 'a poll is scheduled'); const sent = requests.length; t.fn();
      await settle(() => timers.length > 0 || (requests.length > sent && document.getElementById('reception-sync')!.textContent.includes('開き直して')));
      return t.ms;
    },
    row: (n: number) => document.root.querySelector(`tr[data-id="${id(n)}"]`) as FakeElement | null,
    notice: () => document.getElementById('reception-new')!.textContent,
    sync: () => document.getElementById('reception-sync')!.textContent,
  };
}

test('receptions shown on first load are never new; an unchanged version fetches nothing else', async () => {
  const f = fixture(); const c = await client(f);
  assert.equal(c.notice(), ''); assert.equal(c.document.title, '受付一覧'); assert.equal(c.timers[0].ms, VISIBLE_POLL_MS);
  await c.tick();
  assert.deepEqual(c.requests.map(r => r.url), ['/admin/receptions/version']);
  assert.deepEqual(c.requests[0].init.credentials, 'same-origin'); assert.equal(c.requests[0].init.cache, 'no-store'); assert.equal(c.requests[0].init.redirect, 'error');
  assert.equal(c.notice(), ''); assert.ok(!c.row(1)!.classList.contains('new'));
  // An existing reception changing state is an update, not a new arrival.
  f.rows[0].status = 'approved'; f.rows[0].revision = 2; f.change(); await c.tick();
  assert.equal(c.row(1)!.getAttribute('data-status'), 'approved'); assert.equal(c.notice(), ''); assert.equal(c.document.title, '受付一覧');
});

test('a new pending reception is shown and counted once; untouched rows keep their nodes; approval clears it', async () => {
  const f = fixture(); const c = await client(f); const first = c.row(1)!, input = first.querySelector('input[name="confirm"]') as FakeElement;
  input.value = 'synthetic-0';
  f.rows.unshift({ receptionId: id(3), number: 'synthetic-003', createdAt: new Date().toISOString(), status: 'pending', revision: 1, plan: null, trials: [] });
  f.change(); await c.tick();
  assert.deepEqual(c.requests.map(r => r.url), ['/admin/receptions/version', '/admin/receptions']);
  assert.equal(c.requests[1].init.headers.Accept, 'text/html');
  assert.equal(c.notice(), '新しい受付 1件'); assert.equal(c.document.title, '(1) 受付一覧');
  assert.ok(c.row(3)!.classList.contains('new')); assert.ok(c.row(3)!.querySelector('form[action$="/approve"]'));
  assert.equal(c.row(1), first); assert.equal(input.value, 'synthetic-0', 'an unchanged row keeps what was typed');
  const rowsInOrder = c.document.root.querySelectorAll('tr[data-id]').map(r => r.getAttribute('data-id'));
  assert.deepEqual(rowsInOrder, [id(3), id(1), id(2)]);
  // Same state again: no second announcement.
  f.change(); await c.tick(); assert.equal(c.notice(), '新しい受付 1件');
  f.rows[0].status = 'approved'; f.rows[0].revision = 2; f.change(); await c.tick();
  assert.equal(c.notice(), ''); assert.equal(c.document.title, '受付一覧'); assert.ok(!c.row(3)!.classList.contains('new'));
});

test('a row holding focus is never replaced; it is refreshed after focus leaves, and focus survives reordering', async () => {
  const f = fixture(); const c = await client(f); const row = c.row(1)!, input = row.querySelector('input[name="confirm"]') as FakeElement;
  input.focus(); input.value = 'synthetic-00'; input.selectionStart = input.selectionEnd = 12;
  f.rows[0].revision = 5; f.change(); await c.tick();
  assert.equal(c.row(1), row); assert.equal(input.value, 'synthetic-00'); assert.equal(c.document.activeElement, input);
  assert.equal(row.querySelector('input[name="expectedRevision"]')!.getAttribute('value'), '1');
  // Version unchanged, but the kept row is stale: the page is fetched again.
  await c.tick(); assert.equal(c.requests.filter(r => r.url === '/admin/receptions').length, 2); assert.equal(c.row(1), row);
  // Leaving the field keeps what was typed, together with the hidden values it was shown with.
  c.document.activeElement = c.document.body; await c.tick();
  assert.equal(c.row(1), row); assert.equal(input.value, 'synthetic-00'); assert.equal(row.querySelector('input[name="expectedRevision"]')!.getAttribute('value'), '1');
  input.value = ''; await c.tick();
  assert.notEqual(c.row(1), row); assert.equal(c.row(1)!.querySelector('input[name="expectedRevision"]')!.getAttribute('value'), '5');
  // Reordering moves a focused row back into place with focus and caret restored.
  const second = c.row(2)!, focus = second.querySelector('a, input, button') as FakeElement | null;
  const target = focus ?? second; target.focus(); (target as FakeElement).selectionStart = 1;
  f.rows.reverse(); f.change(); await c.tick();
  assert.equal(c.row(2), second); assert.equal(c.document.activeElement, target);
});

test('a protocol or mode change redraws every row form; the status paragraphs follow', async () => {
  const f = fixture(); const c = await client(f); const row = c.row(1)!;
  f.setProtocol({ configured: true, mode: 'off', protocolId: PROTOCOL, revision: 7, sha256: SHA, allowedOrders: [['repair-first']], rotationMode: 'relative_pm90', betweenTrials: 'none' });
  await c.tick();
  assert.notEqual(c.row(1), row); assert.equal(c.row(1)!.querySelector('form[action$="/approve"]'), null);
  assert.match(c.document.getElementById('reception-list')!.textContent, /受付を使わない設定です/);
});

test('rows that were not on this page and are older than it are not counted as new (paging)', async () => {
  const f = fixture(); const c = await client(f);
  f.rows.push({ receptionId: id(4), number: 'synthetic-004', createdAt: old, status: 'pending', revision: 1, plan: null, trials: [] });
  f.change(); await c.tick();
  assert.ok(c.row(4)); assert.equal(c.notice(), ''); assert.ok(!c.row(4)!.classList.contains('new'));
});

test('from zero receptions to one: the list appears and the new one is announced', async () => {
  const f = fixture(); f.rows.length = 0; const c = await client(f);
  assert.equal(c.document.root.querySelector('tbody'), null); assert.equal(c.notice(), '');
  await c.tick(); assert.equal(c.notice(), '');
  f.rows.push({ receptionId: id(5), number: 'synthetic-005', createdAt: new Date().toISOString(), status: 'pending', revision: 1, plan: null, trials: [] });
  f.change(); await c.tick();
  assert.ok(c.row(5)); assert.equal(c.notice(), '新しい受付 1件');
});

test('hidden tabs poll every minute; returning to the tab or coming online checks at once; offline stops', async () => {
  const f = fixture(); const c = await client(f);
  c.document.visibilityState = 'hidden'; await c.tick(); assert.equal(c.timers[0].ms, HIDDEN_POLL_MS);
  c.document.visibilityState = 'visible'; c.document.dispatch('visibilitychange'); assert.equal(c.timers.length, 1); assert.equal(c.timers[0].ms, 0);
  await c.tick(); assert.equal(c.timers[0].ms, VISIBLE_POLL_MS);
  c.windowListeners.get('offline')!(); assert.equal(c.timers.length, 0);
  c.windowListeners.get('online')!(); assert.equal(c.timers[0].ms, 0);
});

test('a visible page is refetched periodically even when the best-effort version did not change', async () => {
  const f = fixture(); const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
  try {
    const c = await client(f); await c.tick(); assert.equal(c.requests.length, 1);
    shift = FORCED_REFRESH_MS; await c.tick(); assert.deepEqual(c.requests.slice(1).map(r => r.url), ['/admin/receptions/version', '/admin/receptions']);
  } finally { Date.now = realNow; }
});

test('errors back off; 429 waits for Retry-After; lost authentication stops polling', async () => {
  const f = fixture(); const c = await client(f);
  c.reply(() => new Response('', { status: 503 }));
  await c.tick(); assert.equal(c.timers[0].ms, VISIBLE_POLL_MS); assert.notEqual(c.sync(), '');
  await c.tick(); assert.equal(c.timers[0].ms, VISIBLE_POLL_MS * 2);
  await c.tick(); assert.equal(c.timers[0].ms, VISIBLE_POLL_MS * 4);
  // Returning to the tab during a backoff does not skip it.
  c.document.dispatch('visibilitychange'); assert.ok(c.timers[0].ms > VISIBLE_POLL_MS * 3);
  c.reply(() => new Response('', { status: 429, headers: { 'Retry-After': '90' } })); await c.tick(); assert.equal(c.timers[0].ms, 90000);
  c.reply(() => null); await c.tick(); assert.equal(c.sync(), ''); assert.equal(c.timers[0].ms, VISIBLE_POLL_MS);
  c.reply(() => new Response('', { status: 401 })); await c.tick();
  assert.equal(c.timers.length, 0); assert.match(c.sync(), /開き直して/);
  c.document.dispatch('visibilitychange'); c.windowListeners.get('online')!(); assert.equal(c.timers.length, 0);
});

test('adapter version changes with index rows and settings, and never calls a participant object', async () => {
  let rows: unknown[] = [{ receptionId: id(1), objectId: 'a'.repeat(64), createdAt: old, number: '001', status: 'pending', revision: 1, trials: [] }];
  let settings: unknown = { protocol: null, mode: { value: 'unset', revision: 0 } };
  const port = createReceptionAdminPort({ index: { async listReceptions() { return rows as never; }, async getReception() { return null; } },
    owner() { throw new Error('owner must not be called'); }, async readSettings() { return settings; } });
  const v = async (since: string | null = null) => (await port.version!(since));
  const a = (await v()).version; assert.match(a, /^[a-f0-9]{64}$/); assert.equal((await v()).version, a); assert.equal((await v()).newPending, null);
  assert.equal((await v(old)).newPending, 1); assert.equal((await v('2026-10-28T00:00:00.000Z')).newPending, 0); assert.equal((await v(old)).version, a);
  rows = [{ ...(rows[0] as object), status: 'approved', revision: 2 }]; const b = (await v()).version; assert.notEqual(b, a); assert.equal((await v(old)).newPending, 0);
  settings = { protocol: null, mode: { value: 'off', revision: 1, savedAt: old } }; const c = (await v()).version; assert.notEqual(c, b);
  settings = { protocol: null, mode: { value: 'on', revision: 1, savedAt: 'not a date' } };
  await assert.rejects(v());
});

test('version endpoint: a valid since adds only a count of newer pending receptions; anything else is ignored', async () => {
  const f = fixture(); f.rows.push({ receptionId: id(6), number: 'synthetic-006', createdAt: '2026-10-29T01:00:00.000Z', status: 'pending', revision: 1, plan: null, trials: [] });
  const body = async (q: string) => (await handleAdmin(get('/admin/receptions/version' + q), f.deps)).json();
  assert.deepEqual(Object.keys(await body('?since=2026-10-29T00:00:00.000Z')), ['version', 'newPending']);
  assert.equal((await body('?since=2026-10-29T00:00:00.000Z')).newPending, 1);
  for (const bad of ['?since=yesterday', '?since=2026-10-29', '?since=2026-02-30T00:00:00.000Z', '?since=%3Cscript%3E']) {
    const text = JSON.stringify(await body(bad)); assert.deepEqual(Object.keys(JSON.parse(text)), ['version'], bad); assert.doesNotMatch(text, /script|yesterday/);
  }
});

test('a later page counts new receptions from the server and highlights none of its own rows', async () => {
  const f = fixture(); const c = await client(f, '/admin/receptions?after=' + id(9));
  await c.tick(); assert.match(c.requests[0].url, /^\/admin\/receptions\/version\?since=\d{4}-/); assert.equal(c.notice(), '');
  f.rows.unshift({ receptionId: id(3), number: 'synthetic-003', createdAt: new Date().toISOString(), status: 'pending', revision: 1, plan: null, trials: [] });
  f.change(); await c.tick();
  assert.equal(c.notice(), '新しい受付 1件'); assert.equal(c.document.title, '(1) 受付一覧');
  assert.ok(c.document.root.querySelectorAll('tr[data-id]').every(r => !r.classList.contains('new')));
  assert.equal(c.requests.at(-1)!.url, '/admin/receptions?after=' + id(9), 'the same page is refetched, never moved to the first page');
});

test('the count follows the latest state even while a typed row is kept as it was', async () => {
  const f = fixture(); const c = await client(f);
  f.rows.unshift({ receptionId: id(3), number: 'synthetic-003', createdAt: new Date().toISOString(), status: 'pending', revision: 1, plan: null, trials: [] });
  f.change(); await c.tick(); assert.equal(c.notice(), '新しい受付 1件');
  const row = c.row(3)!; (row.querySelector('input[name="confirm"]') as FakeElement).value = 'synthetic-003';
  f.rows[0].status = 'cancelled'; f.rows[0].revision = 2; f.change(); await c.tick();
  assert.equal(c.row(3), row, 'typed row kept'); assert.equal(c.notice(), ''); assert.equal(c.document.title, '受付一覧');
  assert.ok(!row.classList.contains('new'));
  // Polling never writes: only the version, protocol and list reads happen.
  assert.deepEqual([...new Set(f.calls)].sort(), ['listPage', 'protocol', 'version']);
});

test('a broken page response keeps the list and typed values; version success alone does not end a backoff', async () => {
  const f = fixture(); const c = await client(f); const row = c.row(1)!, input = row.querySelector('input[name="confirm"]') as FakeElement; input.value = 'x';
  f.change();
  for (const broken of [new Response('<p>x</p>', { status: 200, headers: { 'Content-Type': 'text/plain' } }), new Response('<html><body>no list</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    new Response('', { status: 503 })]) {
    c.reply(url => url.startsWith('/admin/receptions/version') ? null : broken); await c.tick();
    assert.equal(c.row(1), row); assert.equal(input.value, 'x'); assert.notEqual(c.sync(), '');
  }
  assert.equal(c.timers[0].ms, VISIBLE_POLL_MS * 4);
});

test('one check at a time: events during a slow request add no second request; 429 waits are bounded and kept', async () => {
  const f = fixture(); const c = await client(f); let release!: (r: Response) => void;
  c.reply(() => new Promise<Response>(r => { release = r; }));
  const first = c.timers.shift()!; first.fn(); await new Promise(r => setImmediate(r));
  c.document.dispatch('visibilitychange'); c.windowListeners.get('online')!(); for (const t of c.timers.splice(0)) t.fn();
  assert.equal(c.requests.length, 1);
  release(new Response('', { status: 429 })); await c.settle(() => c.timers.length > 0);
  assert.equal(c.timers.length, 1); assert.equal(c.timers[0].ms, 60000, 'missing Retry-After waits a minute');
  c.document.dispatch('visibilitychange'); assert.ok(c.timers[0].ms > 55000, 'returning to the tab does not skip Retry-After');
  c.reply(() => new Response('', { status: 429, headers: { 'Retry-After': '99999' } })); await c.tick(); assert.equal(c.timers[0].ms, 600000);
});
