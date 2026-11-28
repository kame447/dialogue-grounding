import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, ADMIN_HEADERS } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { PreparedObservationPoolStatus } from '../workers/tangram-experiment/src/admin/prepared-observation-port.ts';
import type { SettingsView } from '../workers/tangram-experiment/src/admin/reception-port.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';

const TOKEN = 'synthetic-admin-token-01234567890123456789';
const ORIGIN = 'https://example.test', PATH = '/admin/reception-settings/observations', PRIVATE = 'PRIVATE-MEMO-KEY-UPSTREAM';
const view: SettingsView = {
  protocol: { revision: 2, savedAt: '2026-11-28T00:00:00.000Z', sha256: 'a'.repeat(64),
    protocol: { protocolId: '44444444-4444-4444-8444-444444444444', allowedOrders: [['repair-first', 'bypass-enabled']],
      seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0' } },
  mode: { value: 'unset', revision: 0 }, protocolHistory: [], modeHistory: [],
};
const status: PreparedObservationPoolStatus = { supported: true, protocolRevision: 2, targetPerOrder: 4,
  orders: [{ orderIndex: 0, order: ['repair-first', 'bypass-enabled'], ready: 3, queued: 1, preparing: 0, failed: 0 }], errorCode: null };
function fixture() {
  const calls: { op: string; input?: unknown }[] = [];
  let current: unknown = structuredClone(status), result: unknown = { ok: true }, failed: string | null = null;
  const deps: AdminDeps = {
    token: TOKEN, limiter: { async limit() { return { success: true }; } },
    async listPage() { return { items: [], next: null }; }, async getSummary() { return null; }, async getRecord() { return null; },
    async deleteRecord() {}, async audit() { return []; }, summarizeLatency,
    receptionSettings: {
      async read() { calls.push({ op: 'settings' }); return structuredClone(view); },
      async saveProtocol() { throw new Error('unexpected save'); }, async saveMode() { throw new Error('unexpected save'); },
      async savePostGenerationCheck() { throw new Error('unexpected save'); },
    },
    preparedObservations: {
      async status() { calls.push({ op: 'status' }); if (failed === 'status') throw new Error(PRIVATE); return structuredClone(current) as PreparedObservationPoolStatus; },
      async prepare(input) { calls.push({ op: 'prepare', input }); if (failed === 'prepare') throw new Error(PRIVATE);
        return result as Awaited<ReturnType<NonNullable<AdminDeps['preparedObservations']>['prepare']>>; },
    },
  };
  return { deps, calls, setStatus(value: unknown) { current = value; }, setResult(value: unknown) { result = value; }, fail(op: string) { failed = op; } };
}
function get(path = PATH, method = 'GET') {
  return new Request(ORIGIN + path, { method, headers: { Authorization: 'Bearer ' + TOKEN } });
}
function post(body = 'expectedProtocolRevision=2', headers: Record<string, string> = {}) {
  return new Request(ORIGIN + PATH, { method: 'POST', body, headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN,
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
}
const requests = () => [get(), get('/admin/reception-settings'), post()];

test('optional preparation port leaves existing callers unchanged', async () => {
  const f = fixture(); delete f.deps.preparedObservations;
  for (const request of [get(), post()]) assert.equal((await handleAdmin(request, f.deps)).status, 404);
  const page = await handleAdmin(get('/admin/reception-settings'), f.deps);
  assert.equal(page.status, 200); assert.doesNotMatch(await page.text(), /初回観察メモ|reception-settings\/observations/u);
  assert.deepEqual(f.calls, [{ op: 'settings' }]);
});

test('credentials and rate limiting guard preparation reads and writes before any port call', async () => {
  for (const override of [{ token: undefined }, { token: 'short' }, { limiter: undefined }]) {
    for (const request of requests()) { const f = fixture();
      assert.equal((await handleAdmin(request, { ...f.deps, ...override })).status, 404); assert.deepEqual(f.calls, []); }
  }
  for (const request of requests()) {
    const f = fixture(); request.headers.delete('Authorization'); request.headers.set('Cookie', 'tangram_session=' + 'a'.repeat(64));
    assert.equal((await handleAdmin(request, f.deps)).status, 401); assert.deepEqual(f.calls, []);
  }
  for (const request of requests()) {
    const f = fixture(); f.deps.limiter = { async limit() { return { success: false }; } };
    assert.equal((await handleAdmin(request, f.deps)).status, 429); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); assert.equal((await handleAdmin(new Request(ORIGIN + PATH + '?token=' + TOKEN), f.deps)).status, 401); assert.deepEqual(f.calls, []);
});

test('GET and HEAD expose only preparation counts and never request generation', async () => {
  for (const method of ['GET', 'HEAD']) {
    const f = fixture(); f.setStatus({ ...status, memo: PRIVATE, cacheKey: PRIVATE,
      orders: status.orders.map(row => ({ ...row, entries: [{ memo: PRIVATE, cacheKey: PRIVATE }] })) });
    const response = await handleAdmin(get(PATH, method), f.deps);
    assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/u);
    const body = await response.text(); assert.deepEqual(JSON.parse(body), status); assert.doesNotMatch(body, /PRIVATE|cacheKey|memo/u);
    assert.deepEqual(f.calls, [{ op: 'status' }]);
    for (const [name, value] of Object.entries(ADMIN_HEADERS)) assert.equal(response.headers.get(name), value);
    assert.equal(response.headers.get('Set-Cookie'), null); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('invalid or failed status is private, and unknown error text is replaced with a closed code', async () => {
  for (const value of [null, { ...status, orders: [{ ...status.orders[0], ready: -1, memo: PRIVATE }] },
    { ...status, orders: [{ ...status.orders[0], order: [PRIVATE] }] }]) {
    const f = fixture(); f.setStatus(value); const response = await handleAdmin(get(), f.deps);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'unavailable' });
  }
  const f = fixture(); f.fail('status'); const response = await handleAdmin(get(), f.deps);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE/u);
  const g = fixture(); g.setStatus({ ...status, errorCode: PRIVATE });
  assert.deepEqual(await (await handleAdmin(get(), g.deps)).json(), { ...status, errorCode: 'unavailable' });
});

test('settings page shows order counts and the explicit preparation action without starting it', async () => {
  const f = fixture(); f.setStatus({ ...status, memo: PRIVATE, orders: [{ ...status.orders[0], memo: PRIVATE }] });
  const response = await handleAdmin(get('/admin/reception-settings'), f.deps), html = await response.text(); assert.equal(response.status, 200);
  for (const text of ['初回観察メモ', '準備済み', '待機中', '準備中', '失敗', 'repair-first → bypass-enabled', '観察メモを準備']) assert.ok(html.includes(text), text);
  assert.match(html, /action="\/admin\/reception-settings\/observations"/u); assert.match(html, /name="expectedProtocolRevision" value="2"/u);
  assert.doesNotMatch(html, /PRIVATE|cacheKey|<script|\son\w+=/u); assert.deepEqual(f.calls, [{ op: 'settings' }, { op: 'status' }]);
});

test('empty, pending, unsupported and stale preparation states have actionable minimal messages', async () => {
  const cases: [PreparedObservationPoolStatus, string, boolean][] = [
    [{ ...status, orders: [{ ...status.orders[0], ready: 0, queued: 0 }] }, '受付を許可する前に、観察メモを準備してください。', true],
    [{ ...status, orders: [{ ...status.orders[0], ready: 0 }] }, '受付を許可する前に、観察メモの準備完了を待ってください。', true],
    [{ ...status, supported: false }, '現在の設定は事前準備の対象外です。', false],
    [{ ...status, protocolRevision: 1 }, '設定が変わりました。', false],
    [{ ...status, errorCode: 'preparation_failed' }, '一部の観察メモを準備できませんでした。', true],
    [{ ...status, errorCode: 'preparation_interrupted' }, '準備が中断されました。', true],
  ];
  for (const [value, message, button] of cases) {
    const f = fixture(); f.setStatus(value); const html = await (await handleAdmin(get('/admin/reception-settings'), f.deps)).text();
    assert.ok(html.includes(message), message); assert.equal(html.includes('action="' + PATH + '"'), button); assert.equal(f.calls.some(call => call.op === 'prepare'), false);
  }
  const f = fixture(); f.fail('status'); const response = await handleAdmin(get('/admin/reception-settings'), f.deps), html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /準備状況を確認できませんでした/u);
  assert.match(html, /action="\/admin\/reception-settings\/protocol"/u); assert.doesNotMatch(html, /PRIVATE/u);
});

test('only a valid same-origin form requests preparation once and redirects', async () => {
  const f = fixture(); const response = await handleAdmin(post(), f.deps);
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/admin/reception-settings');
  assert.deepEqual(f.calls, [{ op: 'prepare', input: { expectedProtocolRevision: 2 } }]);
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) assert.equal(response.headers.get(name), value);
  const invalidOrigins: Record<string, string>[] = [{ Origin: 'https://evil.test' }, { Origin: '' },
    { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }];
  for (const headers of invalidOrigins) {
    const g = fixture(); assert.equal((await handleAdmin(post(undefined, headers), g.deps)).status, 403); assert.deepEqual(g.calls, []);
  }
  for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
    const g = fixture(); assert.equal((await handleAdmin(get(PATH, method), g.deps)).status, 404); assert.deepEqual(g.calls, []);
  }
});

test('malformed, duplicated, unknown and oversized preparation fields never schedule work', async () => {
  for (const body of ['', 'expectedProtocolRevision=0', 'expectedProtocolRevision=-1', 'expectedProtocolRevision=2.0', 'expectedProtocolRevision=01',
    'expectedProtocolRevision=9007199254740992', 'expectedProtocolRevision=2&expectedProtocolRevision=2',
    'expectedProtocolRevision=2&memo=' + PRIVATE, 'expectedProtocolRevision=' + '9'.repeat(4200)]) {
    const f = fixture(); const response = await handleAdmin(post(body), f.deps);
    assert.equal(response.status, 400, body.slice(0, 100)); assert.deepEqual(f.calls, []); assert.doesNotMatch(await response.text(), /PRIVATE/u);
  }
  const f = fixture(); assert.equal((await handleAdmin(post(undefined, { 'Content-Type': 'application/json' }), f.deps)).status, 400); assert.deepEqual(f.calls, []);
});

test('preparation refusal and exceptions show closed messages without private backend data', async () => {
  for (const [error, expected, message] of [['conflict', 409, '設定が変わりました。'], ['unconfigured', 409, '準備に必要な設定がありません。'],
    ['unavailable', 503, '準備の状況を確認できませんでした。'], [PRIVATE, 503, '準備の状況を確認できませんでした。']] as const) {
    const f = fixture(); f.setResult({ ok: false, error }); const response = await handleAdmin(post(), f.deps), html = await response.text();
    assert.equal(response.status, expected); assert.ok(html.includes(message)); assert.doesNotMatch(html, /PRIVATE/u); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.fail('prepare'); const response = await handleAdmin(post(), f.deps);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|していません/u);
});
