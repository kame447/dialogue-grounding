// Starts the real orientation-app/server.ts on a free port with a private state directory. For tests only.
// The file name deliberately does not match node --test's test-file patterns.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';

export type ReviewServer = {
  url: string;
  dir: string;
  statePath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  get(path: string): Promise<any>;
  post(path: string, body: unknown, status?: number): Promise<any>;
};

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
  return address.port;
}

export async function reviewServer(dir = mkdtempSync(join(tmpdir(), 'orientation-review-test-'))): Promise<ReviewServer> {
  const port = await freePort(), url = 'http://127.0.0.1:' + port;
  let child: ChildProcess | null = null;
  const stop = async () => { if (child && child.exitCode === null) { const end = once(child, 'exit'); child.kill(); await end; } child = null; };
  return {
    url, dir, statePath: join(dir, 'review-state.json'), stop,
    async start() {
      const proc = child = spawn(process.execPath, [new URL('./server.ts', import.meta.url).pathname], { env: { ...process.env, REVIEW_PORT: String(port), REVIEW_STATE_DIR: dir }, stdio: 'pipe' });
      let err = ''; proc.stderr!.on('data', c => err += c); proc.stdout!.resume();
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(url + '/api/state')).ok) return; } catch {}
        if (proc.exitCode !== null) break;
        await new Promise(r => setTimeout(r, 50));
      }
      throw Error(err || 'server failed');
    },
    async close() { await stop(); rmSync(dir, { recursive: true, force: true }); },
    async get(path) { const r = await fetch(url + path); assert.equal(r.status, 200, 'GET ' + path); return r.json(); },
    async post(path, body, status = 200) {
      const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, status, 'POST ' + path); return r.json();
    },
  };
}
