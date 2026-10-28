// Synthetic selections exercise the researcher form only; they never prescribe research conditions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, ADMIN_HEADERS } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';

const TOKEN = 'synthetic-admin-token-01234567890123456789';
const ORIGIN = 'https://example.test';
const PROTOCOL = '44444444-4444-4444-8444-444444444444';
const saved = { revision: 2, savedAt: '2026-10-28T00:00:00.000Z', sha256: 'c'.repeat(64), protocol: { schemaVersion: 'reception_protocol_v2', protocolId: PROTOCOL, revision: 2,
  allowedOrders: [['bypass-enabled', 'repair-first'], ['repair-first']], seedPolicy: 'per_trial', referenceMemory: false, betweenTrials: 'questionnaire_required',
  receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0' } };
function fixture(state: 'unsaved' | 'saved' = 'saved') {
  const calls: { op: string; args: unknown[] }[] = [];
  let result: any = { ok: true }, failure: Error | null = null;
  const port = {
    async read() { calls.push({ op: 'read', args: [] }); if (failure) throw failure;
      return state === 'unsaved' ? { protocol: null, mode: { value: 'unset', revision: 0 }, protocolHistory: [], modeHistory: [] }
        : { protocol: saved, mode: { value: 'off', revision: 1, savedAt: '2026-10-28T00:00:00.000Z' },
          protocolHistory: [saved, { ...saved, revision: 1, sha256: 'b'.repeat(64), protocol: { ...saved.protocol, revision: 1, rotationMode: 'relative_pm90' } }],
          modeHistory: [{ revision: 1, value: 'off', savedAt: '2026-10-28T00:00:00.000Z', protocolRevision: 2 }] }; },
    async saveProtocol(input: unknown) { calls.push({ op: 'saveProtocol', args: [input] }); if (failure) throw failure; return result; },
    async saveMode(input: unknown) { calls.push({ op: 'saveMode', args: [input] }); if (failure) throw failure; return result; },
  };
  const deps: AdminDeps = { token: TOKEN, limiter: { async limit() { return { success: true }; } },
    async listPage() { return { items: [], next: null }; }, async getSummary() { return null; }, async getRecord() { return null; },
    async deleteRecord() {}, async audit() { return []; }, summarizeLatency, receptionSettings: port } as AdminDeps;
  return { deps, calls, setResult(v: unknown) { result = v; }, fail() { failure = new Error('PRIVATE upstream detail'); } };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.op !== 'read');
const get = (headers: Record<string, string> = {}) => new Request(ORIGIN + '/admin/reception-settings', { headers: { Authorization: 'Bearer ' + TOKEN, ...headers } });
const protocolBody = () => new URLSearchParams([['expectedRevision', '2'], ['orders', 'be-rf'], ['orders', 'rf'], ['seedPolicy', 'shared'], ['referenceMemory', 'on'],
  ['betweenTrials', 'none'], ['rotationMode', 'relative_pm90'], ['receptionNumberFormat', 'daily_seq3']]);
function post(kind: 'protocol' | 'mode', body: string | URLSearchParams = kind === 'protocol' ? protocolBody() : new URLSearchParams({ expectedRevision: '1', value: 'on' }),
  headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/admin/reception-settings/${kind}`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN,
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: String(body) });
}
const requests = () => [get(), post('protocol'), post('mode')];

test('settings routes are absent without the port and fail closed without token or limiter', async () => {
  const { receptionSettings: _, ...deps } = fixture().deps;
  for (const r of requests()) assert.equal((await handleAdmin(r, deps as AdminDeps)).status, 404);
  for (const override of [{ token: undefined }, { token: 'short' }, { limiter: undefined }])
    for (const r of requests()) { const f = fixture(); assert.equal((await handleAdmin(r, { ...f.deps, ...override })).status, 404); assert.equal(f.calls.length, 0); }
});

test('credentials and the existing rate limit guard every settings route; cookies and URL tokens do not authorize', async () => {
  for (const r of requests()) {
    const f = fixture(); r.headers.delete('Authorization'); r.headers.set('Cookie', 'tangram_session=' + 'a'.repeat(64));
    assert.equal((await handleAdmin(r, f.deps)).status, 401); assert.equal(f.calls.length, 0);
  }
  assert.equal((await handleAdmin(new Request(ORIGIN + '/admin/reception-settings?token=' + TOKEN), fixture().deps)).status, 401);
  for (const r of requests()) {
    const f = fixture(); f.deps.limiter = { async limit() { return { success: false }; } };
    assert.equal((await handleAdmin(r, f.deps)).status, 429); assert.equal(f.calls.length, 0);
  }
});

test('settings POSTs require same origin, and GET or HEAD never saves', async () => {
  for (const kind of ['protocol', 'mode'] as const) for (const headers of [{ Origin: 'https://evil.test' }, { Origin: '' }, { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    const f = fixture(); assert.equal((await handleAdmin(post(kind, undefined, headers), f.deps)).status, 403); assert.equal(f.calls.length, 0);
  }
  for (const method of ['GET', 'HEAD']) for (const kind of ['protocol', 'mode']) {
    const f = fixture(); const r = await handleAdmin(new Request(`${ORIGIN}/admin/reception-settings/${kind}?${protocolBody()}`, { method, headers: { Authorization: 'Bearer ' + TOKEN } }), f.deps);
    assert.equal(r.status, 404); assert.equal(writes(f).length, 0);
  }
});

test('a valid protocol form saves exactly the selected values in the fixed order list; success redirects', async () => {
  const f = fixture(); const r = await handleAdmin(post('protocol'), f.deps);
  assert.equal(r.status, 303); assert.equal(r.headers.get('Location'), '/admin/reception-settings');
  assert.deepEqual(writes(f), [{ op: 'saveProtocol', args: [{ expectedRevision: 2, fields: { allowedOrders: [['bypass-enabled', 'repair-first'], ['repair-first']],
    seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90' } }] }]);
  const reversed = new URLSearchParams([...protocolBody()].sort(([a], [b]) => b.localeCompare(a)));
  const g = fixture(); assert.equal((await handleAdmin(post('protocol', reversed), g.deps)).status, 303);
  assert.deepEqual(writes(g), writes(f), 'submission order never changes the saved order list');
  const m = fixture(); assert.equal((await handleAdmin(post('mode'), m.deps)).status, 303);
  assert.deepEqual(writes(m), [{ op: 'saveMode', args: [{ expectedRevision: 1, value: 'on' }] }]);
});

test('missing, unselected, unknown, duplicated or oversized fields never save and are never filled with a default', async () => {
  const without = (name: string) => { const b = protocolBody(); b.delete(name); return b; };
  const withValue = (name: string, value: string) => { const b = protocolBody(); b.set(name, value); return b; };
  const bodies = [without('orders'), without('seedPolicy'), without('referenceMemory'), without('betweenTrials'), without('rotationMode'), without('receptionNumberFormat'),
    without('expectedRevision'), withValue('rotationMode', ''), withValue('rotationMode', 'relative_90'), withValue('betweenTrials', 'rest'), withValue('referenceMemory', 'true'),
    withValue('orders', 'rf-rf'), withValue('expectedRevision', '-1'), withValue('expectedRevision', '2.0'), withValue('receptionNumberFormat', 'daily_seq4'),
    new URLSearchParams([...protocolBody(), ['orders', 'rf']]), new URLSearchParams([...protocolBody(), ['seedPolicy', 'shared']]),
    new URLSearchParams([...protocolBody(), ['extra', '1']]), new URLSearchParams([...protocolBody(), ['pad', 'x'.repeat(1100)]])];
  for (const body of bodies) { const f = fixture(); const r = await handleAdmin(post('protocol', body), f.deps); assert.equal(r.status, 400, String(body)); assert.equal(writes(f).length, 0);
    assert.match(await r.text(), /保存していません/); }
  for (const body of ['expectedRevision=1', 'value=on', 'expectedRevision=1&value=', 'expectedRevision=1&value=ON', 'expectedRevision=1&value=on&value=on', 'expectedRevision=1&value=on&extra=1']) {
    const f = fixture(); assert.equal((await handleAdmin(post('mode', body), f.deps)).status, 400); assert.equal(writes(f).length, 0);
  }
  const f = fixture(); assert.equal((await handleAdmin(post('protocol', protocolBody(), { 'Content-Type': 'application/json' }), f.deps)).status, 400); assert.equal(writes(f).length, 0);
  const invalidUtf8 = new Request(post('protocol'), { body: new Uint8Array([0x6f, 0x72, 0x64, 0x65, 0x72, 0x73, 0x3d, 0xff]) });
  const g = fixture(); assert.equal((await handleAdmin(invalidUtf8, g.deps)).status, 400); assert.equal(writes(g).length, 0);
});

test('save outcomes are closed: conflict, unconfigured protocol and backend failure never reflect upstream text', async () => {
  for (const [kind, error, status, text] of [['protocol', 'conflict', 409, '他の画面で設定が変わりました。開き直してから保存してください。'],
    ['mode', 'conflict', 409, '他の画面で設定が変わりました。開き直してから保存してください。'], ['protocol', 'invalid', 400, 'すべての項目を選んでください。'],
    ['mode', 'protocol_unconfigured', 409, 'プロトコルを保存してから、受付を使ってください。'], ['protocol', 'surprise', 503, '保存していません']] as const) {
    const f = fixture(); f.setResult({ ok: false, error }); const r = await handleAdmin(post(kind), f.deps);
    assert.equal(r.status, status); assert.ok((await r.text()).includes(text), kind + ' ' + error);
  }
  for (const kind of ['protocol', 'mode'] as const) {
    const f = fixture(); f.fail(); const r = await handleAdmin(post(kind), f.deps); assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /PRIVATE/);
  }
  const f = fixture(); f.fail(); const r = await handleAdmin(get(), f.deps); assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /PRIVATE/);
});

test('unsaved page preselects nothing; saved page preselects the current values and shows complete history', async () => {
  const unsaved = await (await handleAdmin(get(), fixture('unsaved').deps)).text();
  assert.doesNotMatch(unsaved, /\b(checked|selected)\b/); assert.match(unsaved, /未設定のため、受付を許可できません/); assert.match(unsaved, /未設定（使わない）/);
  assert.match(unsaved, /name="expectedRevision" value="0"/);
  for (const name of ['orders', 'seedPolicy', 'referenceMemory', 'betweenTrials', 'rotationMode', 'receptionNumberFormat']) assert.match(unsaved, new RegExp(`name="${name}"`));
  assert.match(unsaved, /provisional-v0/);
  const html = await (await handleAdmin(get(), fixture().deps)).text();
  const checked = [...html.matchAll(/<input\b[^>]*name="(\w+)"[^>]*value="([^"]*)"[^>]*\bchecked\b/g)].map(m => m[1] + '=' + m[2]).sort();
  assert.deepEqual(checked, ['betweenTrials=questionnaire_required', 'orders=be-rf', 'orders=rf', 'receptionNumberFormat=daily_seq3', 'referenceMemory=off', 'rotationMode=relative_0', 'seedPolicy=per_trial']);
  for (const text of ['受付の設定', '現在：使わない', 'revision 2', '保存しても、許可済みの受付の計画は変わりません。', 'c'.repeat(64), 'b'.repeat(64), 'relative_pm90', '受付を使う'])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script|\son\w+=|\sstyle=/i);
});

test('settings responses keep the exact admin headers without cookies or CORS', async () => {
  const cases = [get(), post('protocol'), post('mode'), post('protocol', 'orders=rf'), post('mode', undefined, { Origin: 'https://evil.test' })];
  for (const request of cases) {
    const r = await handleAdmin(request, fixture().deps);
    for (const [name, value] of Object.entries(ADMIN_HEADERS)) assert.equal(r.headers.get(name), value);
    assert.equal(r.headers.get('Set-Cookie'), null); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  }
});
