import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { main, startNamingServer } from '../dialogue-model/runtime/web/server.mjs';

// A missing preimplementation export is an assertion failure, not a skipped suite.
// Test dependency stubs use only the public callbacks exercised here.
const runMain: any = main;
const modulePath = '../dialogue-model/runtime/web/local-operator-options.ts';
const api: any = await import(modulePath).catch(() => null);
const token = 'synthetic-only-operator-01234567890123456789';
const env = { RESEARCH_AI_PROVIDER: 'custom', RESEARCH_AI_MODEL: 'synthetic',
  RESEARCH_AI_API_KEY: 'synthetic-client-only', RESEARCH_AI_BASE_URL: 'http://127.0.0.1:1/v1' };
function read(value: any) {
  assert.equal(typeof api?.readLocalOperatorOptions, 'function');
  return api.readLocalOperatorOptions(value);
}
function limiter(clock: () => number) {
  assert.equal(typeof api?.createLocalAdminLimiter, 'function');
  return api.createLocalAdminLimiter(clock);
}
function fixedError(error: any) {
  assert.ok(error instanceof api.LocalOperatorConfigError);
  assert.equal(error.name, 'LocalOperatorConfigError');
  assert.equal(error.code, 'invalid_operator_config');
  assert.equal(error.message, 'invalid_operator_config');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.ok(!String(error.stack).includes(token));
  return true;
}
async function quiet<T>(fn: () => Promise<T>) {
  const logs: string[] = [], old = console.log;
  console.log = (...args: any[]) => { logs.push(args.join(' ')); };
  try { return { value: await fn(), logs }; } finally { console.log = old; }
}

test('operator absent has exact undefined options, no discovery or default admin', () => {
  assert.deepEqual(read({}), { adminToken: undefined, adminLimiter: undefined, participantContactText: undefined });
});
test('operator token and public contact preserve literal values and build real limiter', async () => {
  const result = read({ ADMIN_TOKEN: token, PARTICIPANT_CONTACT_TEXT: 'Contact & "operator"', OTHER: ['ignored'] });
  assert.deepEqual(Object.keys(result).sort(), ['adminLimiter', 'adminToken', 'participantContactText']);
  assert.equal(result.adminToken, token); assert.equal(result.participantContactText, 'Contact & "operator"');
  for (let i = 0; i < 30; i++) assert.deepEqual(await result.adminLimiter.limit({ key: 'admin:loopback' }), { success: true });
  assert.deepEqual(await result.adminLimiter.limit({ key: 'admin:loopback' }), { success: false });
});
for (const [name, value] of Object.entries({ null: null, array: ['good'], nested: [['good']], number: 32,
  bool: true, object: {}, empty: '', short: 'x'.repeat(31), long: 'x'.repeat(513), space: ' '.repeat(32),
  newline: token + '\n', control: token + '\u007f', unicode: token + 'é' })) {
  test('token rejects ' + name + ' with fixed error', () => {
    assert.equal(typeof api?.LocalOperatorConfigError, 'function');
    assert.throws(() => read({ ADMIN_TOKEN: value }), fixedError);
  });
}
for (const [name, value] of Object.entries({ null: null, array: ['contact'], number: 9, empty: '',
  long: 'x'.repeat(501), angle: '<contact>', newline: 'contact\n', del: 'contact\u007f' })) {
  test('contact rejects ' + name + ' with fixed error', () => {
    assert.equal(typeof api?.LocalOperatorConfigError, 'function');
    assert.throws(() => read({ PARTICIPANT_CONTACT_TEXT: value }), fixedError);
  });
}
for (const name of ['ADMIN_TOKEN', 'PARTICIPANT_CONTACT_TEXT']) {
  test(name + ' accessor is refused without executing it', () => {
    let reads = 0; const value = Object.defineProperty({}, name, { enumerable: true, get() { reads++; throw Error(token); } });
    assert.equal(typeof api?.LocalOperatorConfigError, 'function');
    assert.throws(() => read(value), fixedError); assert.equal(reads, 0);
  });
}
for (const [name, value] of Object.entries({ null: null, array: [], string: token, number: 8 })) {
  test('invalid environment container ' + name, () => {
    assert.equal(typeof api?.LocalOperatorConfigError, 'function'); assert.throws(() => read(value), fixedError);
  });
}
test('primitive token inclusive length boundaries and contact-only mode', () => {
  assert.equal(read({ ADMIN_TOKEN: 'x'.repeat(32) }).adminToken.length, 32);
  assert.equal(read({ ADMIN_TOKEN: 'x'.repeat(512) }).adminToken.length, 512);
  assert.deepEqual(read({ PARTICIPANT_CONTACT_TEXT: 'contact' }), { adminToken: undefined, adminLimiter: undefined, participantContactText: 'contact' });
});

test('rolling window exact boundary and denied requests do not extend timestamps', async () => {
  let now = 0; const l = limiter(() => now), key = { key: 'admin:a' };
  for (let i = 0; i < 30; i++) assert.equal((await l.limit(key)).success, true);
  now = 59999; assert.equal((await l.limit(key)).success, false);
  now = 60000; assert.equal((await l.limit(key)).success, true);
  for (let i = 0; i < 29; i++) assert.equal((await l.limit(key)).success, true);
  assert.equal((await l.limit(key)).success, false);
});
test('per-key isolation and bound64 refuse live eviction but permit expired reuse', async () => {
  let now = 0; const l = limiter(() => now);
  for (let i = 0; i < 64; i++) assert.equal((await l.limit({ key: 'admin:' + i })).success, true);
  assert.equal((await l.limit({ key: 'admin:new' })).success, false);
  for (let i = 0; i < 29; i++) assert.equal((await l.limit({ key: 'admin:0' })).success, true);
  assert.equal((await l.limit({ key: 'admin:0' })).success, false);
  now = 60000; assert.equal((await l.limit({ key: 'admin:new' })).success, true);
});
for (const [name, bad] of Object.entries({ negative: -1, nan: NaN, infinity: Infinity })) {
  test('bad clock ' + name + ' refuses without clearing previous state', async () => {
    let now = 100; const l = limiter(() => now);
    for (let i = 0; i < 30; i++) await l.limit({ key: 'admin:a' });
    now = bad; assert.equal((await l.limit({ key: 'admin:a' })).success, false);
    now = 100; assert.equal((await l.limit({ key: 'admin:a' })).success, false);
  });
}
test('backward clock and thrown clock refuse', async () => {
  let now = 100; const l = limiter(() => now);
  assert.equal((await l.limit({ key: 'admin:a' })).success, true);
  now = 99; assert.equal((await l.limit({ key: 'admin:a' })).success, false);
  const bad = limiter(() => { throw Error('synthetic-clock'); });
  assert.deepEqual(await bad.limit({ key: 'admin:a' }), { success: false });
});
for (const [name, value] of Object.entries({ undefined: undefined, null: null, array: [], missing: {},
  nonstring: { key: ['admin:a'] }, empty: { key: '' } })) {
  test('invalid limiter input ' + name + ' fails closed', async () => {
    const l = limiter(() => 0); assert.deepEqual(await l.limit(value), { success: false });
  });
}

test('CLI forwards valid credentials and contact only as private setup options, no log values', async () => {
  let opts: any;
  const result = await quiet(() => runMain(['--port', '0'], { ...env, ADMIN_TOKEN: token, PARTICIPANT_CONTACT_TEXT: 'SYNTHETIC_CONTACT_CANARY' }, {
    createClient: () => ({}), startServer: async (value: any) => { opts = value; return { address: () => ({ port: 17 }) }; }
  }));
  assert.equal(opts.adminToken, token); assert.equal(opts.participantContactText, 'SYNTHETIC_CONTACT_CANARY');
  assert.equal(typeof opts.adminLimiter?.limit, 'function');
  assert.doesNotMatch(result.logs.join(''), /synthetic-only-operator|SYNTHETIC_CONTACT_CANARY/);
});
test('invalid CLI config stops all clients and listening with fixed private-free error', async () => {
  assert.equal(typeof api?.LocalOperatorConfigError, 'function');
  let calls = 0;
  await assert.rejects(runMain([], { ...env, ADMIN_TOKEN: ['bad'] } as any, {
    createClient: () => { calls++; return {}; }, createDecisionClient: () => { calls++; },
    createGroundingClient: () => { calls++; }, startServer: async () => { calls++; return { address: () => ({ port: 1 }) }; }
  }), fixedError); assert.equal(calls, 0);
});
test('help bypasses invalid credentials and all clients', async () => {
  let calls = 0; await quiet(() => runMain(['--help'], { ADMIN_TOKEN: null } as any, {
    createClient: () => { calls++; }, startServer: async () => { calls++; }
  })); assert.equal(calls, 0);
});
test('no CLI token argument ingress', async () => {
  let calls = 0; await assert.rejects(runMain(['--admin-token', token], env, {
    createClient: () => { calls++; }, startServer: async () => { calls++; }
  })); assert.equal(calls, 0);
});

test('public HTTP enforces real CLI limiter, socket key, auth and contact escaping', async t => {
  // Start via actual main/startNamingServer. The injected client cannot call an upstream.
  const root = await mkdtemp('/private/tmp/SandyNoether-g6-http-');
  const owners = root + '/owners'; await mkdir(owners, { mode: 0o700 });
  let server: any;
  t.after(async () => { if (server) await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); });
  const result = await quiet(() => runMain(['--port', '0', '--base-store-root', owners], { ...env,
    ADMIN_TOKEN: token, PARTICIPANT_CONTACT_TEXT: 'Contact & "operator"' }, {
    createClient: () => ({}), startServer: async (opts: any) => { server = await startNamingServer(opts); return server; }
  }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base + '/'); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /Contact &amp; &quot;operator&quot;/);
  assert.ok(!html.includes(token)); assert.ok(!result.logs.join('').includes(token));
  for (const header of [undefined, 'unsupported xyz']) {
    const r = await fetch(base + '/admin', { headers: header ? { Authorization: header } : {} });
    assert.equal(r.status, 401); assert.ok(r.headers.get('www-authenticate')); await r.text();
  }
  for (let i = 0; i < 30; i++) {
    const r = await fetch(base + '/admin', { headers: { Authorization: i % 2 ? 'Bearer wrong' : 'Bearer ' + token,
      'CF-Connecting-IP': 'spoof-' + i, 'X-Forwarded-For': 'spoof-' + i } });
    assert.equal(r.status, i % 2 ? 401 : 200); await r.text();
  }
  const r = await fetch(base + '/admin', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60');
  assert.ok(!(await r.text()).includes(token));
});
