// Synthetic protocols below exercise configuration, never prescribe research conditions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, ADMIN_HEADERS } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { ROOT_MATRIX, OTHER_ROOT_MATRIX } from './support/i139-qr-oracle.ts';
import { ADMIN_USER } from '../workers/tangram-experiment/src/admin/auth.ts';

const TOKEN = 'synthetic-admin-token-01234567890123456789';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const RECORD = '33333333-3333-4333-8333-333333333333';
const PROTOCOL = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://example.test';
type Strategy = 'repair-first' | 'bypass-enabled';
type Row = { receptionId: string; number: string | null; createdAt: string; status: 'pending' | 'approved' | 'in_progress' | 'finished' | 'cancelled'; revision: number;
  plan: { order: Strategy[] } | null; trials: { index: number; recordId: string | null }[] };
type Protocol = { configured: false } | { configured: true; protocolId: string; revision: number; allowedOrders: Strategy[][] };
type Result = { ok: true } | { ok: false; error: 'not_found' | 'conflict' | 'invalid_order' | 'protocol_unconfigured' | 'reception_unavailable' };
// This structural fake is the proposed ReceptionAdminPort contract, audited before implementation.
function fixture() {
  const row: Row = { receptionId: ID, number: 'synthetic-007', createdAt: '2026-10-27T00:00:00.000Z', status: 'pending', revision: 3, plan: null, trials: [] };
  let protocol: Protocol = { configured: true, protocolId: PROTOCOL, revision: 7, allowedOrders: [['bypass-enabled'], ['repair-first', 'bypass-enabled']] };
  const calls: { op: string; args: unknown[] }[] = [];
  let result: Result = { ok: true };
  let failure: Error | null = null;
  const receptions = {
    async protocol() { calls.push({ op: 'protocol', args: [] }); return protocol; },
    async listPage(after: string | null) { calls.push({ op: 'listPage', args: [after] }); return { items: [
      { ...row, receptionId: OTHER, number: 'synthetic-008', status: 'in_progress' as const, plan: { order: ['bypass-enabled'] as Strategy[] }, trials: [{ index: 0, recordId: RECORD }] }, row,
    ], next: 'cursor<&' }; },
    async get(id: string) { calls.push({ op: 'get', args: [id] }); return id === ID ? row : null; },
    async approve(id: string, input: { order: number; expectedRevision: number }): Promise<Result> { calls.push({ op: 'approve', args: [id, input] }); if (failure) throw failure; return result; },
    async cancel(id: string, input: { expectedRevision: number }): Promise<Result> { calls.push({ op: 'cancel', args: [id, input] }); if (failure) throw failure; return result; },
  };
  const deps: AdminDeps & { receptions: typeof receptions } = { token: TOKEN, limiter: { async limit() { return { success: true }; } },
    async listPage() { return { items: [], next: null }; }, async getSummary() { return null; }, async getRecord() { return null; },
    async deleteRecord() { calls.push({ op: 'deleteRecord', args: [] }); }, async audit() { return []; }, summarizeLatency, receptions };
  return { deps, calls, row, setProtocol(value: Protocol) { protocol = value; }, setResult(value: Result) { result = value; }, fail() { failure = new Error('PRIVATE upstream token and prompt'); } };
}
function get(path = '/admin/receptions', headers: Record<string, string> = {}) { return new Request(ORIGIN + path, { headers: { Authorization: 'Bearer ' + TOKEN, ...headers } }); }
function post(action = 'approve', values: Record<string, string> = {}, headers: Record<string, string> = {}, id = ID) {
  return new Request(`${ORIGIN}/admin/reception/${id}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN,
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ expectedRevision: '3', confirm: 'synthetic-007', ...(action === 'approve' ? { order: '1' } : {}), ...values }) });
}
async function error(response: Response, status: number, code: string) { assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code }); }
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.op === 'approve' || c.op === 'cancel');
const requests = () => [get(), get('/admin/entry'), post(), post('cancel')];

test('reception routes are absent without the optional port; existing record list still works', async () => {
  const f = fixture(); const { receptions: _, ...deps } = f.deps;
  for (const request of [get(), get('/admin/entry'), post(), post('cancel')]) assert.equal((await handleAdmin(request, deps)).status, 404);
  assert.equal((await handleAdmin(get('/admin'), deps)).status, 200);
});
test('all reception routes require admin credentials; participant cookie and URL token do not authorize', async () => {
  for (const path of ['/admin/receptions', '/admin/entry', `/admin/reception/${ID}/approve`, `/admin/reception/${ID}/cancel`]) {
    const f = fixture(); const request = path.includes('/reception/') ? post(path.endsWith('cancel') ? 'cancel' : 'approve') : get(path);
    request.headers.delete('Authorization'); request.headers.set('Cookie', 'tangram_session=' + 'a'.repeat(64));
    const response = await handleAdmin(request, f.deps); assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Basic realm="tangram-admin"/); assert.equal(f.calls.length, 0);
  }
  assert.equal((await handleAdmin(new Request(ORIGIN + '/admin/receptions?token=' + TOKEN), fixture().deps)).status, 401);
});
test('reception routes fail closed without token/limiter and use existing credentialed rate limit', async () => {
  for (const override of [{ token: undefined }, { token: 'short' }, { limiter: undefined }]) {
    for (const request of [get(), get('/admin/entry'), post(), post('cancel')]) assert.equal((await handleAdmin(request, { ...fixture().deps, ...override })).status, 404);
  }
  for (const request of [get(), get('/admin/entry'), post(), post('cancel')]) {
    const f = fixture(); let key = ''; f.deps.limiter = { async limit(input) { key = input.key; return { success: false }; } };
    request.headers.set('CF-Connecting-IP', '198.51.100.7'); request.headers.set('X-Forwarded-For', 'untrusted');
    const r = await handleAdmin(request, f.deps); assert.equal(r.status, 429); assert.equal(r.headers.get('Retry-After'), '60'); assert.equal(key, 'admin:198.51.100.7'); assert.equal(f.calls.length, 0);
  }
});
test('wrong Bearer/Basic are limited without port reads, and correct Basic reaches all four routes', async () => {
  for (const authorization of ['Bearer incorrect-synthetic-token', 'Basic ' + btoa(ADMIN_USER + ':incorrect-synthetic-token')]) {
    for (const request of requests()) {
      const f = fixture(); let attempts = 0; f.deps.limiter = { async limit() { attempts++; return { success: true }; } };
      request.headers.set('Authorization', authorization);
      assert.equal((await handleAdmin(request, f.deps)).status, 401); assert.equal(attempts, 1); assert.equal(f.calls.length, 0);
    }
    for (const request of requests()) {
      const f = fixture(); f.deps.limiter = { async limit() { return { success: false }; } }; request.headers.set('Authorization', authorization);
      assert.equal((await handleAdmin(request, f.deps)).status, 429); assert.equal(f.calls.length, 0);
    }
  }
  for (const request of requests()) {
    const f = fixture(); request.headers.set('Authorization', 'Basic ' + btoa(ADMIN_USER + ':' + TOKEN));
    assert.equal((await handleAdmin(request, f.deps)).status, request.method === 'POST' ? 303 : 200);
  }
});
test('approve and cancel require same origin before reading or mutating receptions', async () => {
  for (const action of ['approve', 'cancel']) for (const headers of [{ Origin: 'https://evil.test' }, { Origin: '' }, { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }] as Record<string,string>[]) {
    const f = fixture(); assert.equal((await handleAdmin(post(action, {}, headers), f.deps)).status, 403); assert.equal(f.calls.length, 0);
  }
});
test('list has pending first, escaped values/cursors, configured order choices and record links', async () => {
  const f = fixture(); f.row.number = '<script>alert(1)</script>"';
  const response = await handleAdmin(get('/admin/receptions?after=previous'), f.deps); assert.equal(response.status, 200); const html = await response.text();
  assert.deepEqual(f.calls.filter(c => c.op === 'listPage'), [{ op: 'listPage', args: ['previous'] }]);
  const pendingForm = html.indexOf(`/admin/reception/${ID}/approve`), startedRow = html.indexOf('synthetic-008');
  assert.ok(pendingForm >= 0 && startedRow >= 0, 'both pending form and started row exist'); assert.ok(pendingForm < startedRow);
  for (const expected of [PROTOCOL, '2026-10-27T00:00:00.000Z', 'expectedRevision', 'value="3"', 'name="confirm"', 'name="order"', 'value="0"', 'value="1"', 'bypass-enabled', 'repair-first', `/admin/record/${RECORD}`, '/admin/entry']) assert.ok(html.includes(expected), expected);
  assert.match(html, /after=cursor%3C%26/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script|\son\w+=/i);
  assert.match(html, /revision\s*7/);
  const select = html.match(/<select\b[^>]*name="order"[^>]*>([\s\S]*?)<\/select>/)?.[1]; assert.ok(select);
  const labels = [...select.matchAll(/<option\b[^>]*value="(\d+)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(labels.map(([index]) => index), ['0', '1']);
  assert.match(labels[0][1], /bypass-enabled/); assert.doesNotMatch(labels[0][1], /repair-first/);
  assert.ok(labels[1][1].indexOf('repair-first') >= 0); assert.ok(labels[1][1].indexOf('bypass-enabled') > labels[1][1].indexOf('repair-first'));
});
test('unconfigured protocol hides approval form and rejects POST, but permits cancellation', async () => {
  const f = fixture(); f.setProtocol({ configured: false }); const html = await (await handleAdmin(get(), f.deps)).text();
  assert.match(html, /プロトコルが未設定のため、許可できません/); assert.doesNotMatch(html, /\/approve"/); assert.match(html, /\/cancel"/);
  await error(await handleAdmin(post(), f.deps), 409, 'protocol_unconfigured'); assert.equal(mutations(f).length, 0);
  assert.equal((await handleAdmin(post('cancel'), f.deps)).status, 303);
});
test('approval passes only selected index and expected revision to the port; HTML redirects and JSON returns ok', async () => {
  for (const json of [false, true]) {
    const f = fixture(); const r = await handleAdmin(post('approve', {}, json ? { Accept: 'application/json' } : {}), f.deps);
    assert.deepEqual(mutations(f), [{ op: 'approve', args: [ID, { order: 1, expectedRevision: 3 }] }]);
    if (json) { assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true }); }
    else { assert.equal(r.status, 303); assert.equal(r.headers.get('Location'), '/admin/receptions'); }
  }
});
test('UUID prefix confirms unnumbered reception and cancellation uses compare-and-swap revision', async () => {
  const f = fixture(); f.row.number = null;
  const r = await handleAdmin(post('cancel', { confirm: ID.slice(0, 8) }), f.deps); assert.equal(r.status, 303);
  assert.deepEqual(mutations(f), [{ op: 'cancel', args: [ID, { expectedRevision: 3 }] }]);
});
test('approved but unstarted may cancel; started receptions and CAS conflicts never delete records', async () => {
  const unstarted = fixture(); unstarted.row.status = 'approved'; unstarted.row.plan = { order: ['bypass-enabled'] }; unstarted.row.trials = [{ index: 0, recordId: null }];
  assert.equal((await handleAdmin(post('cancel'), unstarted.deps)).status, 303); assert.equal(mutations(unstarted).length, 1);
  for (const status of ['in_progress', 'finished'] as const) {
    const f = fixture(); f.row.status = status; f.row.trials = [{ index: 0, recordId: RECORD }];
    await error(await handleAdmin(post('cancel'), f.deps), 409, 'conflict'); assert.equal(mutations(f).length, 0); assert.equal(f.calls.some(c => c.op === 'deleteRecord'), false);
  }
  const raced = fixture(); raced.setResult({ ok: false, error: 'conflict' });
  await error(await handleAdmin(post('cancel'), raced.deps), 409, 'conflict'); assert.equal(mutations(raced).length, 1); assert.equal(raced.calls.some(c => c.op === 'deleteRecord'), false);
});
test('valid percent-encoded forms accept exactly 1024 bytes and reject 1025 bytes without mutation', async () => {
  for (const action of ['approve', 'cancel']) for (const length of [1024, 1025]) {
    const f = fixture();
    const fields = { expectedRevision: '3', confirm: 'x'.repeat(400), ...(action === 'approve' ? { order: '1' } : {}) };
    let raw = new URLSearchParams(fields).toString();
    if ((length - raw.length) % 2 !== 0) { fields.confirm += 'x'; raw = new URLSearchParams(fields).toString(); }
    f.row.number = fields.confirm; let remaining = (length - raw.length) / 2;
    raw = raw.replace(/[A-Za-z0-9-]/g, c => remaining-- > 0 ? '%' + c.charCodeAt(0).toString(16).padStart(2, '0') : c);
    assert.equal(new TextEncoder().encode(raw).byteLength, length); assert.deepEqual(Object.fromEntries(new URLSearchParams(raw)), fields);
    const r = await handleAdmin(new Request(post(action), { body: raw }), f.deps);
    if (length === 1024) { assert.equal(r.status, 303); assert.equal(mutations(f).length, 1); }
    else { await error(r, 400, 'invalid_request'); assert.equal(mutations(f).length, 0); }
  }
});
test('invalid order, revision, confirmation and oversized/non-form bodies never mutate', async () => {
  for (const order of ['-1', '2', '1.0', '1e0', 'NaN', '', '999999999999999999999999']) { const f = fixture(); await error(await handleAdmin(post('approve', { order }), f.deps), 400, 'invalid_order'); assert.equal(mutations(f).length, 0); }
  for (const action of ['approve', 'cancel']) {
    for (const expectedRevision of ['-1', '0', '3.5', 'NaN', '3e0', '']) { const f = fixture(); await error(await handleAdmin(post(action, { expectedRevision }), f.deps), 400, 'invalid_request'); assert.equal(mutations(f).length, 0); }
    for (const confirm of ['', 'wrong', 'synthetic-007 ']) { const f = fixture(); await error(await handleAdmin(post(action, { confirm }), f.deps), 400, 'invalid_confirmation'); assert.equal(mutations(f).length, 0); }
    for (const request of [post(action, { extra: 'x'.repeat(1100) }), post(action, {}, { 'Content-Type': 'application/json' })]) { const f = fixture(); await error(await handleAdmin(request, f.deps), 400, 'invalid_request'); assert.equal(mutations(f).length, 0); }
    const duplicate = post(action); const text = await duplicate.text(); const f = fixture();
    await error(await handleAdmin(new Request(duplicate, { body: text + '&expectedRevision=4' }), f.deps), 400, 'invalid_request'); assert.equal(mutations(f).length, 0);
  }
});
test('unknown IDs return 404; port conflicts include double approval and revision races, closed errors only', async () => {
  for (const action of ['approve', 'cancel']) {
    const unknown = fixture(); await error(await handleAdmin(post(action, {}, {}, OTHER), unknown.deps), 404, 'not_found'); assert.equal(mutations(unknown).length, 0);
    for (const [code, status] of [['not_found', 404], ['conflict', 409], ['invalid_order', 400], ['protocol_unconfigured', 409], ['reception_unavailable', 503]] as const) {
      const f = fixture(); f.setResult({ ok: false, error: code }); await error(await handleAdmin(post(action), f.deps), status, code);
    }
    const f = fixture(); f.fail(); await error(await handleAdmin(post(action), f.deps), 503, 'reception_unavailable');
  }
});
test('an already approved reception is not approved twice and stale visible revision is rejected', async () => {
  for (const patch of [{ status: 'approved' as const }, { revision: 4 }]) {
    const f = fixture(); Object.assign(f.row, patch); await error(await handleAdmin(post(), f.deps), 409, 'conflict'); assert.equal(mutations(f).length, 0);
  }
});
test('entry URL and QR use only request origin plus root, never query/admin data or forwarded origin', async () => {
  const request = get('/admin/entry?token=PRIVATE&order=repair-first', { 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'http' });
  const response = await handleAdmin(request, fixture().deps); assert.equal(response.status, 200); const html = await response.text();
  assert.match(html, /href="https:\/\/example\.test\/"/); assert.match(html, /<svg\b/);
  assert.doesNotMatch(html, /PRIVATE|evil\.test|repair-first|\?token|data:|<script|<style|\sstyle=|\son\w+=|<use|<image/i);
});
test('actual entry response QR equals independent root oracle across queries and forwarded headers; changed origin changes QR', async () => {
  const cases = [
    [ORIGIN + '/admin/entry', ROOT_MATRIX],
    [ORIGIN + '/admin/entry?token=PRIVATE&next=/admin/reception/' + ID, ROOT_MATRIX],
    ['https://another.test:8443/admin/entry?order=PRIVATE', OTHER_ROOT_MATRIX],
  ];
  for (const [url, matrix] of cases) {
    const request = new Request(url, { headers: { Authorization: 'Bearer ' + TOKEN, Forwarded: 'host=evil.test;proto=http', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'http' } });
    const r = await handleAdmin(request, fixture().deps); assert.equal(r.status, 200); const html = await r.text();
    const root = new URL('/', url).href; assert.ok(html.includes(`href="${root}"`));
    const svg = html.match(/<svg\b[\s\S]*?<\/svg>/g); assert.ok(svg); assert.equal(svg.length, 1);
    const cells = [...svg[0].matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"\s*\/?\s*>/g)].map(m => `${Number(m[1]) - 4},${Number(m[2]) - 4}`);
    const expected = matrix.split('\n').flatMap((row, y) => [...row].flatMap((v, x) => v === '1' ? [`${x},${y}`] : []));
    assert.deepEqual(cells.sort(), expected.sort(), root);
  }
});
test('with reception port enabled, unrelated legacy records keep list/detail/export/deletion semantics', async () => {
  const f = fixture(); const legacy = { recordId: RECORD, version: 2, startedAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:01:00.000Z',
    status: 'completed', strategy: 'repair-first', events: [{ seq: 1, speaker: 'human', text: 'synthetic legacy utterance' }], scoring: { synthetic: true }, questionnaire: { version: 1, status: 'submitted', answers: { synthetic: 4 } } };
  const summary = summarizeRecord(legacy, 'a'.repeat(64), summarizeLatency(legacy)); const removed: unknown[] = [];
  f.deps.listPage = async () => ({ items: [summary], next: null }); f.deps.getSummary = async id => id === RECORD ? summary : null;
  f.deps.getRecord = async entry => { assert.deepEqual(entry, summary); return legacy; }; f.deps.deleteRecord = async entry => { removed.push(entry); };
  const list = await handleAdmin(get('/admin'), f.deps); assert.equal(list.status, 200); assert.ok((await list.text()).includes(`/admin/record/${RECORD}`));
  const detail = await handleAdmin(get(`/admin/record/${RECORD}`), f.deps); assert.equal(detail.status, 200); assert.match(await detail.text(), /synthetic legacy utterance/);
  const exported = await handleAdmin(get(`/admin/record/${RECORD}.json`), f.deps); assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('Content-Disposition'), `attachment; filename="tangram-record-${RECORD}.json"`); assert.deepEqual(await exported.json(), legacy);
  const deletion = (confirm: string) => new Request(`${ORIGIN}/admin/record/${RECORD}/delete`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ confirm }) });
  assert.equal((await handleAdmin(deletion('incorrect'), f.deps)).status, 400); assert.deepEqual(removed, []);
  const deleted = await handleAdmin(deletion(RECORD), f.deps); assert.equal(deleted.status, 303); assert.equal(deleted.headers.get('Location'), '/admin?deleted=1'); assert.deepEqual(removed, [summary]);
});
test('all new response paths retain exact ADMIN_HEADERS without CORS or cookie writes', async () => {
  const expected = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' };
  assert.deepEqual(ADMIN_HEADERS, expected);
  const cases: { request: Request; f: ReturnType<typeof fixture>; status: number }[] = [
    { request: get(), f: fixture(), status: 200 }, { request: get('/admin/entry'), f: fixture(), status: 200 },
    { request: post(), f: fixture(), status: 303 }, { request: post('cancel'), f: fixture(), status: 303 },
    { request: post('approve', { order: '-1' }), f: fixture(), status: 400 }, { request: post('approve', {}, { Origin: 'https://evil.test' }), f: fixture(), status: 403 },
    { request: get('/admin/receptions', { Authorization: 'Bearer wrong' }), f: fixture(), status: 401 },
  ];
  const limited = fixture(); limited.deps.limiter = { async limit() { return { success: false }; } }; cases.push({ request: get(), f: limited, status: 429 });
  const conflict = fixture(); conflict.setResult({ ok: false, error: 'conflict' }); cases.push({ request: post(), f: conflict, status: 409 });
  const failed = fixture(); failed.fail(); cases.push({ request: post(), f: failed, status: 503 });
  for (const { request, f, status } of cases) {
    const r = await handleAdmin(request, f.deps); assert.equal(r.status, status); for (const [name, value] of Object.entries(expected)) assert.equal(r.headers.get(name), value);
    assert.equal(r.headers.get('Set-Cookie'), null); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  }
});
