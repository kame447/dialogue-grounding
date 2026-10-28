// Synthetic receptions and protocols exercise the response format only; no research condition is chosen here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const { handleAdmin, ADMIN_HEADERS }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/admin/routes.ts').href);
const { summarizeLatency }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/admin/latency.ts').href);
const { default: edge, TangramSession, AdminIndex }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/index.ts').href);
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init); }
};

const TOKEN = 'synthetic-admin-token-01234567890123456789';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PROTOCOL = '44444444-4444-4444-8444-444444444444';
const SHA = 'c'.repeat(64);
const ORIGIN = 'https://example.test';
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MESSAGES: Record<string, string> = {
  not_found: '受付が見つかりません。',
  invalid_request: 'フォームの内容を確認できませんでした。開き直してから操作してください。',
  invalid_confirmation: '確認欄に、表示された番号を正確に入力してください。',
  conflict: '受付の状態が変わりました。開き直してから操作してください。',
  invalid_order: '条件順序を選んでください。',
  protocol_unconfigured: 'プロトコルが未設定のため、許可できません。',
  protocol_changed: '設定が変わりました。開き直してから許可してください。',
  reception_closed: '受付を使わない設定のため、許可できません。',
};
const UNKNOWN_RESULT = '受付一覧を開き直して、状態を確認してください。';
const STATUS: Record<string, number> = { not_found: 404, invalid_request: 400, invalid_confirmation: 400, conflict: 409, invalid_order: 400,
  protocol_unconfigured: 409, protocol_changed: 409, reception_closed: 409, reception_unavailable: 503 };
function fixture() {
  const row: any = { receptionId: ID, number: '007', createdAt: '2026-10-27T00:00:00.000Z', status: 'pending', revision: 3, plan: null, trials: [] };
  let protocol: any = { configured: true, mode: 'on', protocolId: PROTOCOL, revision: 7, sha256: SHA, allowedOrders: [['bypass-enabled'], ['repair-first']],
    rotationMode: 'relative_pm90', betweenTrials: 'none' };
  let result: any = { ok: true }, failure: Error | null = null, readFailure: Error | null = null;
  const calls: string[] = [];
  const receptions = {
    async protocol() { calls.push('protocol'); return protocol; },
    async listPage() { calls.push('listPage'); if (readFailure) throw readFailure; return { items: [row], next: null }; },
    async get(id: string) { calls.push('get'); if (readFailure) throw readFailure; return id === ID ? row : null; },
    async approve() { calls.push('approve'); if (failure) throw failure; return result; },
    async cancel() { calls.push('cancel'); if (failure) throw failure; return result; },
  };
  const deps: any = { token: TOKEN, limiter: { async limit() { return { success: true }; } }, async listPage() { return { items: [], next: null }; },
    async getSummary() { return null; }, async getRecord() { return null; }, async deleteRecord() {}, async audit() { return []; }, summarizeLatency, receptions };
  return { deps, row, calls, mutations: () => calls.filter(c => c === 'approve' || c === 'cancel').length,
    setProtocol(p: any) { protocol = p; }, setResult(r: any) { result = r; },
    fail(error = new Error('PRIVATE-BACKEND-DETAIL upstream token')) { failure = error; }, failReads() { readFailure = new Error('PRIVATE-READ-DETAIL'); } };
}
function post(action: 'approve' | 'cancel', values: Record<string, string> = {}, accept: string | null = BROWSER, id = ID) {
  const body = new URLSearchParams({ expectedRevision: '3', confirm: '007',
    ...(action === 'approve' ? { order: '1', protocolId: PROTOCOL, protocolRevision: '7', protocolSha256: SHA } : {}), ...values });
  return new Request(`${ORIGIN}/admin/reception/${id}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN,
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...(accept === null ? {} : { Accept: accept }) }, body });
}
async function page(r: Response, status: number, title: string, text: string) {
  assert.equal(r.status, status); assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) assert.equal(r.headers.get(name), value);
  assert.equal(r.headers.get('Set-Cookie'), null);
  const html = await r.text();
  assert.ok(html.includes(`<h1>${title}</h1>`), title); assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /\{"error"|<script|\son\w+=|\sstyle=|PRIVATE|SECRET/u);
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]), ['/admin/style.css', '/admin/receptions']);
  return html;
}
async function json(r: Response, status: number, error: string) {
  assert.equal(r.status, status); assert.match(r.headers.get('Content-Type') ?? '', /^application\/json/u); assert.deepEqual(await r.json(), { error });
}

// Route-level validation failures: the route refuses before any mutation is attempted.
const routeFailures: [string, 'approve' | 'cancel', (f: ReturnType<typeof fixture>) => Request][] = [
  ['not_found', 'approve', () => post('approve', {}, BROWSER, OTHER)],
  ['invalid_request', 'approve', () => post('approve', { extra: '<script>SECRET-EXTRA</script>' })],
  ['invalid_request', 'cancel', () => post('cancel', { expectedRevision: '3.0' })],
  ['invalid_confirmation', 'approve', () => post('approve', { confirm: '<script>SECRET-CONFIRM</script>' })],
  ['invalid_confirmation', 'cancel', () => post('cancel', { confirm: 'SECRET-CONFIRM' })],
  ['conflict', 'approve', f => { f.row.revision = 4; return post('approve'); }],
  ['conflict', 'cancel', f => { f.row.status = 'in_progress'; f.row.trials = [{ index: 0, recordId: OTHER }]; return post('cancel'); }],
  ['invalid_order', 'approve', () => post('approve', { order: '' })],
  ['protocol_unconfigured', 'approve', f => { f.setProtocol({ configured: false, mode: 'on' }); return post('approve'); }],
  ['protocol_changed', 'approve', () => post('approve', { protocolRevision: '6', order: '9' })],
  ['reception_closed', 'approve', f => { f.setProtocol({ configured: true, mode: 'off', protocolId: PROTOCOL, revision: 7, sha256: SHA, allowedOrders: [['repair-first']], rotationMode: 'relative_pm90', betweenTrials: 'none' }); return post('approve'); }],
];
for (const [code, action, build] of routeFailures) test(`route-level ${action} failure ${code}: browser page, no mutation; other clients keep JSON`, async () => {
  const title = action === 'approve' ? '許可していません' : '取り消していません';
  const f = fixture(); await page(await handleAdmin(build(f), f.deps), STATUS[code], title, MESSAGES[code]); assert.equal(f.mutations(), 0);
  for (const accept of [null, 'application/json', 'text/html, application/json']) {
    const g = fixture(), request = build(g), headers = new Headers(request.headers);
    if (accept === null) headers.delete('Accept'); else headers.set('Accept', accept);
    await json(await handleAdmin(new Request(request, { headers }), g.deps), STATUS[code], code); assert.equal(g.mutations(), 0);
  }
});

// Backend refusals: the mutation was attempted exactly once; the closed result code chooses the page.
for (const action of ['approve', 'cancel'] as const) for (const code of ['not_found', 'conflict', 'invalid_order', 'protocol_unconfigured', 'protocol_changed', 'reception_closed']) {
  if (action === 'cancel' && !['not_found', 'conflict'].includes(code)) continue;
  test(`backend ${action} refusal ${code}: one attempt, browser page with the same status`, async () => {
    const f = fixture(), before = JSON.stringify(f.row); f.setResult({ ok: false, error: code });
    await page(await handleAdmin(post(action), f.deps), STATUS[code], action === 'approve' ? '許可していません' : '取り消していません', MESSAGES[code]);
    assert.equal(f.mutations(), 1); assert.equal(JSON.stringify(f.row), before);
    const g = fixture(); g.setResult({ ok: false, error: code }); await json(await handleAdmin(post(action, {}, null), g.deps), STATUS[code], code);
  });
}

test('503 never claims the operation did not happen, and never reflects backend exception text', async () => {
  for (const action of ['approve', 'cancel'] as const) {
    const title = action === 'approve' ? '許可の結果を確認できません' : '取消の結果を確認できません';
    const thrown = fixture(); thrown.fail();
    const html = await page(await handleAdmin(post(action), thrown.deps), 503, title, UNKNOWN_RESULT); assert.equal(thrown.mutations(), 1);
    assert.doesNotMatch(html, /していません/u);
    const unknown = fixture(); unknown.setResult({ ok: false, error: 'PRIVATE-UNLISTED-CODE' });
    await page(await handleAdmin(post(action), unknown.deps), 503, title, UNKNOWN_RESULT);
    const reads = fixture(); reads.failReads();
    await page(await handleAdmin(post(action), reads.deps), 503, title, UNKNOWN_RESULT); assert.equal(reads.mutations(), 0);
    const machine = fixture(); machine.fail(); await json(await handleAdmin(post(action, {}, 'application/json'), machine.deps), 503, 'reception_unavailable');
  }
});

test('successful operations are unchanged: browser forms redirect, JSON clients get ok', async () => {
  for (const action of ['approve', 'cancel'] as const) {
    const f = fixture(), r = await handleAdmin(post(action), f.deps); assert.equal(r.status, 303); assert.equal(r.headers.get('Location'), '/admin/receptions');
    const g = fixture(), j = await handleAdmin(post(action, {}, 'application/json'), g.deps); assert.equal(j.status, 200); assert.deepEqual(await j.json(), { ok: true });
  }
});

test('reception list and entry read failures give a short page to browsers and JSON to other clients', async () => {
  const get = (path: string, accept: string | null) => new Request(ORIGIN + path, { headers: { Authorization: 'Bearer ' + TOKEN, ...(accept === null ? {} : { Accept: accept }) } });
  const f = fixture(); f.failReads();
  const html = await page(await handleAdmin(get('/admin/receptions', BROWSER), f.deps), 503, '受付一覧', '受付を確認できませんでした。開き直してから操作してください。');
  assert.doesNotMatch(html, /PRIVATE/u);
  await json(await handleAdmin(get('/admin/receptions', null), f.deps), 503, 'reception_unavailable');
  // The generic record-list message keeps its existing back link to /admin.
  const { renderMessage }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/admin/render.ts').href);
  assert.match(renderMessage('t', 'm'), /<a href="\/admin">一覧へ<\/a>/u);
});

test('real edge: a stale approval form posted by a browser gets the 409 page and leaves the reception unchanged', async () => {
  const clone = <T>(v: T): T => structuredClone(v);
  const memory = () => {
    let values = new Map<string, any>(), queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(fn: () => Promise<T>) => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };
    const view = (map: Map<string, any>) => ({ async get(k: string) { return clone(map.get(k)); },
      async put(u: Record<string, unknown>) { for (const [k, v] of Object.entries(u)) map.set(k, clone(v)); },
      async delete(keys: string | string[]) { let n = 0; for (const k of [keys].flat()) n += Number(map.delete(k)); return n; },
      async list({ prefix }: { prefix: string }) { return new Map([...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); } });
    return { snapshot: () => clone(Object.fromEntries(values)), get: (k: string) => view(values).get(k), put: (u: Record<string, unknown>) => enqueue(() => view(values).put(u)),
      delete: (k: string | string[]) => enqueue(() => view(values).delete(k)), list: (o: any) => view(values).list(o),
      transaction(fn: (tx: any) => Promise<any>) { return enqueue(async () => { const staged = clone(values), r = await fn(view(staged)); values = staged; return r; }); },
      async setAlarm() {}, async deleteAlarm() {} };
  };
  const index = new AdminIndex({ storage: memory() }, {}), stores = new Map<string, ReturnType<typeof memory>>(), objects = new Map<string, any>(), pending: Promise<unknown>[] = [];
  const fields = { allowedOrders: [['repair-first']], seedPolicy: 'shared', referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90' };
  assert.equal((await index.saveReceptionProtocol({ expectedRevision: 0, fields })).ok, true);
  assert.equal((await index.saveReceptionMode({ expectedRevision: 0, value: 'on' })).ok, true);
  const env: any = { ADMIN_TOKEN: TOKEN, ADMIN_INDEX: { idFromName: (n: string) => n, get: () => index },
    ADMIN_RATE_LIMIT: { async limit() { return { success: true }; } }, START_RATE_LIMIT: { async limit() { return { success: true }; } },
    AI_PROXY: { async chat() { throw Error('no synthetic test may call a model'); } }, ASSETS: { async fetch() { return new Response('<html></html>'); } } };
  env.NAMING_SESSIONS = { idFromName: (n: string) => n, idFromString: (n: string) => n, get: (id: string) => {
    if (!stores.has(id)) stores.set(id, memory());
    if (!objects.has(id)) objects.set(id, new TangramSession({ storage: stores.get(id), id: { toString: () => id }, waitUntil(p: Promise<unknown>) { pending.push(p); } }, env));
    return objects.get(id);
  } };
  const pageResponse = await edge.fetch(new Request(ORIGIN + '/'), env), cookie = pageResponse.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await edge.fetch(new Request(ORIGIN + '/api/reception', { method: 'POST', headers: { Cookie: cookie } }), env)).status, 200);
  const store = stores.get(cookie.split('=')[1])!, reception = store.snapshot()['reception:v1'];
  const shown = (await index.readReceptionSettings()).protocol;
  assert.equal((await index.saveReceptionProtocol({ expectedRevision: 1, fields: { ...fields, rotationMode: 'relative_0' } })).ok, true);
  const before = store.snapshot();
  const r = await edge.fetch(new Request(`${ORIGIN}/admin/reception/${reception.receptionId}/approve`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN,
    Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', Accept: BROWSER },
    body: new URLSearchParams({ expectedRevision: '0', confirm: reception.number ?? reception.receptionId.slice(0, 8), order: '0',
      protocolId: shown.protocol.protocolId, protocolRevision: String(shown.revision), protocolSha256: shown.sha256 }) }), env);
  await page(r, 409, '許可していません', MESSAGES.protocol_changed);
  assert.deepEqual(store.snapshot(), before); await Promise.all(pending);
});
