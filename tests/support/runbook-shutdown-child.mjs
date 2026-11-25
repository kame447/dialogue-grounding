// Owned test child only. No product seam, upstream, external process or real environment.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { startNamingServer } from '../../dialogue-model/runtime/web/server.mjs';
const { attachLocalShutdown } = await import('../../dialogue-model/runtime/web/local-shutdown.ts');
const [mode, directory, timeout] = process.argv.slice(2);
if (mode === 'controller') {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  attachLocalShutdown({ drainAndClose() { process.send({ kind: 'drain' }); return promise; } }, { timeoutMs: Number(timeout) });
  process.on('message', m => { if (m === 'release') resolve(); if (m === 'reject') reject(Error('PRIVATE_TEST_ERROR_MUST_NOT_LEAK')); });
  process.send({ kind: 'ready' });
} else {
  let armed = false, release;
  const gate = new Promise(r => { release = r; });
  const original = fs.rename;
  fs.rename = async (from, to) => {
    if (armed && String(to).endsWith('.owner.json') && (await fs.readFile(from, 'utf8')).includes('shutdown_synthetic_message')) {
      armed = false; process.send({ kind: 'held' }); await gate;
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  const server = await startNamingServer({ port: 0, client: { complete: () => new Promise(() => {}) },
    baseAssignmentFile: directory + '/assignment.json', baseStoreRoot: directory + '/owners' });
  attachLocalShutdown(server, { timeoutMs: Number(timeout) });
  process.on('message', m => { if (m === 'arm') { armed = true; process.send({ kind: 'armed' }); } if (m === 'release') release(); });
  process.send({ kind: 'ready', port: server.address().port });
}
