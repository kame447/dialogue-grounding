import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openBaseFileStore, registerBaseOwner } from '../dialogue-model/runtime/web/base-assignment-store.ts';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';

async function root(t: any) {
  const path = await fs.mkdtemp('/private/tmp/SandyNoether-g5f1-');
  t.after(() => fs.rm(path, { recursive: true, force: true })); return path;
}
for (const layer of ['store', 'drain']) for (const fault of ['none', 'ENOENT', 'EACCES', 'EIO']) {
  test('G5F1 ' + layer + ' close ' + fault + ' distinguishes missing from I/O failure', async t => {
    const path = await root(t); let close: () => Promise<void>, lock: string;
    if (layer === 'store') {
      const owner = 'd'.repeat(64); await registerBaseOwner(path, owner, Date.now());
      const handle = await openBaseFileStore({ root: path, ownerId: owner, now: Date.now });
      close = () => handle.close(); lock = path + '/.' + owner + '.lock';
    } else {
      const server: any = await (startNamingServer as any)({ port: 0, client: {}, baseStoreRoot: path });
      t.after(() => new Promise<void>(r => server.close(() => r())));
      const page = await fetch('http://127.0.0.1:' + server.address().port + '/'); assert.equal(page.status, 200); await page.text();
      close = () => server.drainAndClose(); lock = path + '/' + (await fs.readdir(path)).find(p => p.endsWith('.lock'));
    }
    const bytes = await fs.readFile(lock), owners = (await fs.readdir(path)).filter(p => p.endsWith('.owner.json'));
    const ownerBefore = await fs.readFile(path + '/' + owners[0]);
    // Test-only missing-file fixture, not a recovery recipe or a second-writer permission.
    if (fault === 'ENOENT') await fs.unlink(lock);
    const original = fs.lstat; let hits = 0;
    fs.lstat = (async (value: any, ...args: any[]) => {
      if (String(value) === lock) {
        hits++;
        if (fault === 'EACCES' || fault === 'EIO') throw Object.assign(Error('synthetic lock metadata fault'), { code: fault });
      }
      return (original as any)(value, ...args);
    }) as any;
    syncBuiltinESMExports();
    try { if (fault === 'EACCES' || fault === 'EIO') await assert.rejects(close()); else await close(); }
    finally { fs.lstat = original; syncBuiltinESMExports(); }
    assert.equal(hits, 1);
    assert.deepEqual(await fs.readFile(path + '/' + owners[0]), ownerBefore);
    if (fault === 'EACCES' || fault === 'EIO') assert.deepEqual(await fs.readFile(lock), bytes);
    else assert.equal((await fs.readdir(path)).filter(p => p.endsWith('.lock')).length, 0);
  });
}
const preload = new URL('./support/runbook-lock-close-preload.mjs', import.meta.url).pathname;
for (const signal of ['SIGINT', 'SIGTERM'] as const) for (const fault of ['EACCES', 'EIO']) {
  test('G5F1 direct CLI ' + signal + '/' + fault + ' exits1 without forcing own lock', { timeout: 15000 }, async t => {
    const path = await root(t), messages: any[] = [];
    const child = spawn(process.execPath, ['--import', preload, 'dialogue-model/runtime/web/server.mjs', '--port', '0', '--base-store-root', path], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, RESEARCH_AI_PROVIDER: 'custom', RESEARCH_AI_MODEL: 'synthetic',
        RESEARCH_AI_API_KEY: 'synthetic-unused', RESEARCH_AI_BASE_URL: 'http://127.0.0.1:1/v1',
        SYNTHETIC_LOCK_CLOSE_ROOT: path, SYNTHETIC_LOCK_CLOSE_CODE: fault }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let stdout = '', stderr = '', ended = false;
    child.on('message', m => messages.push(m)); child.stdout!.on('data', b => { stdout += b.toString(); }); child.stderr!.on('data', b => { stderr += b.toString(); });
    const exited = once(child, 'exit').then(([code, sig]) => { ended = true; return { code, signal: sig }; });
    t.after(async () => { if (!ended) { child.kill('SIGKILL'); await exited; } });
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('owned CLI readiness missing')), 8000);
      child.stdout!.on('data', () => { const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    });
    const page = await fetch('http://127.0.0.1:' + port + '/'); assert.equal(page.status, 200); await page.text();
    const lock = path + '/' + (await fs.readdir(path)).find(p => p.endsWith('.lock')), bytes = await fs.readFile(lock);
    child.kill(signal); const result = await exited;
    assert.equal(messages.filter(x => x.kind === 'lock_lstat_hit').length, 1);
    assert.deepEqual(result, { code: 1, signal: null }); assert.equal(stderr.trim(), 'shutdown_incomplete');
    assert.deepEqual(await fs.readFile(lock), bytes);
  });
}
