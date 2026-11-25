import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { startNamingServer, main } from '../dialogue-model/runtime/web/server.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { registerBaseOwner } from '../dialogue-model/runtime/web/base-assignment-store.ts';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Portable private temp root (macOS /private/tmp is absent on Linux CI).
const PRIVATE_TMP = realpathSync(tmpdir());
const modulePath = '../dialogue-model/runtime/web/local-shutdown.ts';
const api: any = await import(modulePath).catch(() => null);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
async function directory(t: any) {
  const root = await fs.mkdtemp(PRIVATE_TMP + '/SandyNoether-g5-test-'); await fs.mkdir(root + '/owners', { mode: 0o700 });
  await fs.writeFile(root + '/assignment.json', JSON.stringify({ schemaVersion: 'base_assignment_config_v1',
    configId: '91bccb79-039e-4196-a336-717fe071a55d', revision: 1, strategy: 'repair-first', seed: 937, referenceMemory: false }), { mode: 0o600 });
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
async function actual(t: any, options: any = {}) {
  const root = await directory(t); let input: any;
  const server: any = await (startNamingServer as any)({ port: 0, baseAssignmentFile: root + '/assignment.json', baseStoreRoot: root + '/owners',
    client: { complete: () => new Promise(() => {}) }, createTaskV2: async (v: any) => { input = v; return createNamingTaskV2(v); }, ...options });
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base + '/'); assert.equal(page.status, 200); await page.text();
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const post = (path: string, value: unknown) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { root, server, base, cookie, post, get input() { return input; } };
}
function launch(t: any, args: string[], env: Record<string, string | undefined> = {}, ipc = false) {
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', finished = false;
  child.stdout!.on('data', b => { stdout += b.toString(); }); child.stderr!.on('data', b => { stderr += b.toString(); });
  const exited = once(child, 'exit').then(([code, signal]) => { finished = true; return { code, signal }; });
  t.after(async () => { if (!finished) { child.kill('SIGKILL'); await exited; } });
  const messages: any[] = [];
  child.on('message', m => messages.push(m));
  async function waitFor(kind: string) {
    const result = messages.find(x => x.kind === kind); if (result) return result;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('owned child setup did not reach ' + kind)); }, 8000);
      const onMessage = (m: any) => { if (m.kind === kind) { cleanup(); resolve(m); } };
      const onExit = () => { cleanup(); reject(Error('owned child setup exited: ' + stderr.slice(0, 150))); };
      function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
      child.on('message', onMessage); child.once('exit', onExit);
    });
  }
  return { child, exited, waitFor, messages, get stdout() { return stdout; }, get stderr() { return stderr; }, get finished() { return finished; } };
}
const childScript = new URL('./support/runbook-shutdown-child.mjs', import.meta.url).pathname;
for (const signal of ['SIGINT', 'SIGTERM'] as const) test('actual direct CLI ' + signal + ' exits0, unlocks and restores same Cookie', { timeout: 20000 }, async t => {
  const root = await directory(t);
  const args = ['dialogue-model/runtime/web/server.mjs', '--port', '0', '--base-assignment-file', root + '/assignment.json', '--base-store-root', root + '/owners'];
  const env = { RESEARCH_AI_PROVIDER: 'custom', RESEARCH_AI_MODEL: 'synthetic', RESEARCH_AI_API_KEY: 'synthetic', RESEARCH_AI_BASE_URL: 'http://127.0.0.1:1/v1' };
  const c = launch(t, args, env);
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('direct CLI readiness')), 8000);
    c.child.stdout!.on('data', () => { const match = c.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const base = 'http://127.0.0.1:' + port, page = await fetch(base + '/'); const cookie = page.headers.get('set-cookie')!.split(';')[0]; await page.text();
  const r = await fetch(base + '/api/start', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"version":2}' });
  assert.equal(r.status, 200); const id = (await r.json()).trial.sessionId;
  c.child.kill(signal); assert.deepEqual(await c.exited, { code: 0, signal: null });
  assert.equal((await fs.readdir(root + '/owners')).filter(x => x.endsWith('.lock')).length, 0);
  const reopened: any = await (startNamingServer as any)({ port: 0, client: {}, baseAssignmentFile: root + '/assignment.json', baseStoreRoot: root + '/owners' });
  try { const s = await fetch('http://127.0.0.1:' + reopened.address().port + '/api/state', { headers: { Cookie: cookie } });
    assert.equal(s.status, 200); assert.equal((await s.json()).trial.sessionId, id);
  } finally { await new Promise<void>(r => reopened.close(() => r())); }
});
for (const value of [0, -1, 60001, 1.5, NaN, '1000', null]) test('shutdown rejects invalid timeout ' + String(value) + ' without listeners', () => {
  assert.equal(typeof api?.attachLocalShutdown, 'function');
  const counts = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
  assert.throws(() => api.attachLocalShutdown({ drainAndClose: async () => {} }, { timeoutMs: value }), { message: 'invalid_shutdown_options' });
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s)), counts);
});
test('programmatic main/help adds no signal handlers; opt-in detach removes only its own', async () => {
  assert.equal(typeof api?.attachLocalShutdown, 'function'); const counts = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
  const detach = api.attachLocalShutdown({ drainAndClose: async () => {} });
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s)), counts.map(n => n + 1)); detach();
  const log = console.log; console.log = () => {};
  try { await main(['--help'], {}); } finally { console.log = log; }
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s)), counts);
});
test('duplicate signals join one drain and one deadline until successful release', { timeout: 10000 }, async t => {
  const c = launch(t, [childScript, 'controller', '', '2000'], {}, true); await c.waitFor('ready');
  c.child.kill('SIGINT'); await c.waitFor('drain'); c.child.kill('SIGTERM'); await delay(60);
  assert.equal(c.finished, false); assert.equal(c.messages.filter(x => x.kind === 'drain').length, 1);
  c.child.send('release'); assert.deepEqual(await c.exited, { code: 0, signal: null }); assert.equal(c.stderr, '');
});
for (const outcome of ['reject', 'deadline']) test('controller ' + outcome + ' exits1 with fixed nonprivate diagnosis', { timeout: 10000 }, async t => {
  const c = launch(t, [childScript, 'controller', '', '300'], {}, true); await c.waitFor('ready');
  c.child.kill('SIGTERM'); await c.waitFor('drain'); if (outcome === 'reject') c.child.send('reject');
  assert.deepEqual(await c.exited, { code: 1, signal: null }); assert.equal(c.stderr.trim(), 'shutdown_incomplete');
});
test('real held save survives signal and duplicate, release commits before clean exit', { timeout: 15000 }, async t => {
  const root = await directory(t), c = launch(t, [childScript, 'save', root, '3000'], {}, true), ready = await c.waitFor('ready');
  const base = 'http://127.0.0.1:' + ready.port, page = await fetch(base + '/'); const cookie = page.headers.get('set-cookie')!.split(';')[0]; await page.text();
  const post = (path: string, value: any) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const started=await post('/api/start', { version: 2 });assert.equal(started.status, 200);const recordId=(await started.json()).trial.sessionId;
  c.child.send('arm'); await c.waitFor('armed'); const response = post('/api/message', { text: 'shutdown_synthetic_message', clientId: 'g5-message', expectedRecordId:recordId });
  await c.waitFor('held'); c.child.kill('SIGINT'); await delay(50); c.child.kill('SIGTERM');
  assert.equal(c.finished, false); assert.equal((await fs.readdir(root + '/owners')).filter(x => x.endsWith('.lock')).length, 1);
  c.child.send('release'); assert.equal((await response).status, 202);
  assert.deepEqual(await c.exited, { code: 0, signal: null });
  const files = await fs.readdir(root + '/owners'); assert.equal(files.filter(x => x.endsWith('.lock')).length, 0);
  const saved = JSON.parse(await fs.readFile(root + '/owners/' + files.find(x => x.endsWith('.owner.json')), 'utf8'));
  assert.ok(JSON.stringify(saved).includes('shutdown_synthetic_message')); assert.equal(saved.owner.admissions.initial.status, 'active');
});
test('held actual save past deadline leaves lock and valid old committed bytes', { timeout: 10000 }, async t => {
  const root = await directory(t), c = launch(t, [childScript, 'save', root, '200'], {}, true), ready = await c.waitFor('ready');
  const base = 'http://127.0.0.1:' + ready.port, page = await fetch(base + '/'); const cookie = page.headers.get('set-cookie')!.split(';')[0]; await page.text();
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const started=await fetch(base + '/api/start', { method: 'POST', headers, body: '{"version":2}' });assert.equal(started.status, 200);const recordId=(await started.json()).trial.sessionId;
  const path = root + '/owners/' + (await fs.readdir(root + '/owners')).find(x => x.endsWith('.owner.json'));
  c.child.send('arm'); await c.waitFor('armed');
  const response = fetch(base + '/api/message', { method: 'POST', headers, body: JSON.stringify({text:'shutdown_synthetic_message',expectedRecordId:recordId}) }).catch(() => null);
  await c.waitFor('held'); const before = await fs.readFile(path); c.child.kill('SIGINT');
  assert.deepEqual(await c.exited, { code: 1, signal: null }); await response;
  assert.equal(c.stderr.trim(), 'shutdown_incomplete'); assert.deepEqual(await fs.readFile(path), before);
  assert.equal((await fs.readdir(root + '/owners')).filter(x => x.endsWith('.lock')).length, 1);
});

for (const stage of ['store-open', 'before-persist']) test('disconnected handler ' + stage + ' stays tracked until finally and late store closes', { timeout: 10000 }, async t => {
  const entered = gate(), release = gate(); let created = 0;
  const x = await actual(t, stage === 'before-persist' ? { createTaskV2: async (v: any) => { created++; entered.release(); await release.promise; return createNamingTaskV2(v); } } : {});
  assert.equal(typeof x.server.drainAndClose, 'function');
  const originalOpen = fs.open;
  if (stage === 'store-open') {
    await registerBaseOwner(x.root + '/owners', 'c'.repeat(64), Date.now());
    fs.open = (async (path: any, ...args: any[]) => { if (String(path).endsWith('.' + 'c'.repeat(64) + '.lock')) { entered.release(); await release.promise; } return (originalOpen as any)(path, ...args); }) as any;
    syncBuiltinESMExports();
  }
  let req: ReturnType<typeof request>;
  try {
    req = request(x.base + (stage === 'store-open' ? '/api/state' : '/api/start'), { method: stage === 'store-open' ? 'GET' : 'POST',
      headers: { Cookie: stage === 'store-open' ? 'naming_session=' + 'c'.repeat(64) : x.cookie, 'Content-Type': 'application/json' } });
    req.on('error', () => {}); req.end(stage === 'before-persist' ? '{"version":2}' : undefined); await entered.promise; req.destroy();
    let done = false; const drain = x.server.drainAndClose().then(() => { done = true; });
    await delay(50); assert.equal(done, false); release.release(); await drain;
    assert.equal(done, true); assert.equal((await fs.readdir(x.root + '/owners')).filter(v => v.endsWith('.lock')).length, 0);
    if (stage === 'before-persist') assert.equal(created, 1);
  } finally { release.release(); fs.open = originalOpen; syncBuiltinESMExports(); }
});
test('drain joins, seals late persist before storage, and propagates real close failure', { timeout: 10000 }, async t => {
  const x = await actual(t); assert.equal(typeof x.server.drainAndClose, 'function'); assert.equal((await x.post('/api/start', { version: 2 })).status, 200);
  const p = x.server.drainAndClose(); assert.equal(x.server.drainAndClose(), p); await p;
  const path = x.root + '/owners/' + (await fs.readdir(x.root + '/owners')).find(v => v.endsWith('.owner.json')), before = await fs.readFile(path);
  await assert.rejects(x.input.onPersist({}), { name: 'NamingTaskError', code: 'record_write_failed' });
  assert.deepEqual(await fs.readFile(path), before); assert.equal((await fs.readdir(x.root + '/owners')).filter(v => v.endsWith('.lock')).length, 0);
  const y = await actual(t); assert.equal(typeof y.server.drainAndClose, 'function');
  const unlink = fs.unlink; let hits = 0;
  fs.unlink = (async (path: any) => { if (String(path).startsWith(y.root) && String(path).endsWith('.lock')) { hits++; throw Error('synthetic-close-fault'); } return unlink(path); }) as any;
  syncBuiltinESMExports(); try { await assert.rejects(y.server.drainAndClose()); } finally { fs.unlink = unlink; syncBuiltinESMExports(); }
  assert.equal(hits, 1); assert.equal((await fs.readdir(y.root + '/owners')).filter(v => v.endsWith('.lock')).length, 1);
});
test('new pipelined handler after latch gets503 without starting another admission', { timeout: 10000 }, async t => {
  const entered = gate(), release = gate(); let factories = 0;
  const x = await actual(t, { createTaskV2: async (v: any) => { factories++; entered.release(); await release.promise; return createNamingTaskV2(v); } });
  assert.equal(typeof x.server.drainAndClose, 'function');
  const url = new URL(x.base), socket = createConnection(Number(url.port), '127.0.0.1'); t.after(() => socket.destroy()); await once(socket, 'connect');
  let wire = ''; const response = new Promise<void>(resolve => { socket.on('data', b => { wire += b.toString(); if (wire.includes('503')) { socket.destroy(); resolve(); } }); });
  socket.write('POST /api/start HTTP/1.1\r\nHost: ' + url.host + '\r\nCookie: ' + x.cookie + '\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{"version":2}');
  await entered.promise; const drain = x.server.drainAndClose();
  socket.write('GET /api/state HTTP/1.1\r\nHost: ' + url.host + '\r\nCookie: ' + x.cookie + '\r\nConnection: close\r\n\r\n');
  await delay(20); release.release(); await response; await drain;
  assert.equal(factories, 1); assert.match(wire, /503 Service Unavailable/); assert.match(wire, /"error":"trial_unavailable"/);
});
