import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, copyFile, chmod, unlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Portable private temp root (macOS /private/tmp is absent on Linux CI).
const PRIVATE_TMP = realpathSync(tmpdir());

// New documentary G2 controls. This is NOT automatic runtime lock reclamation.
const moduleURL = new URL('../dialogue-model/runtime/web/server.mjs', import.meta.url).href;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function start(file: string, owners: string) {
  const source = `import {startNamingServer} from ${JSON.stringify(moduleURL)};
    const s=await startNamingServer({port:0,client:{},baseAssignmentFile:process.argv[1],baseStoreRoot:process.argv[2]});
    process.stdout.write(JSON.stringify({port:s.address().port})+'\\n');
    process.on('SIGINT',()=>s.close(()=>process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, file, owners], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', b => { stderr += b.toString(); });
  let timer: ReturnType<typeof setTimeout>;
  const ready = new Promise<{ port: number }>((resolve, reject) => {
    let out = '';
    timer = setTimeout(() => reject(Error('owned child readiness timeout')), 20000);
    child.once('error', reject); child.once('exit', () => reject(Error('owned child exited before ready: ' + stderr.slice(0, 100))));
    child.stdout.on('data', b => { out += b.toString(); if (out.includes('\n')) {
      try { resolve(JSON.parse(out.slice(0, out.indexOf('\n')))); } catch { reject(Error('invalid owned readiness')); }
    } });
  });
  const exited = once(child, 'exit');
  try { const { port } = await ready; return { child, exited, base: 'http://127.0.0.1:' + port }; }
  catch (error) { child.kill('SIGKILL'); await exited; throw error; }
  finally { clearTimeout(timer!); }
}
test('G2 owned crash, live double-writer refusal, exclusive backup/recheck/recovery and same Cookie', { timeout: 45000 }, async t => {
  const root = await mkdtemp(PRIVATE_TMP + '/SandyNoether-g6-recovery-'), owners = root + '/owners';
  const config = root + '/assignment.json'; await mkdir(owners, { mode: 0o700 });
  await writeFile(config, JSON.stringify({ schemaVersion: 'base_assignment_config_v1', configId: 'b5d3bff2-121e-4573-9fc3-f7d6e43e30ce',
    revision: 1, strategy: 'repair-first', seed: 73, referenceMemory: false }), { mode: 0o600 });
  const running: Awaited<ReturnType<typeof start>>[] = [];
  t.after(async () => {
    for (const p of running) if (p.child.exitCode === null && p.child.signalCode === null) { p.child.kill('SIGINT'); await p.exited; }
    await rm(root, { recursive: true, force: true });
  });
  const first = await start(config, owners); running.push(first);
  const page = await fetch(first.base + '/'); assert.equal(page.status, 200);
  const cookie = page.headers.get('set-cookie')!.split(';')[0]; await page.text();
  const started = await fetch(first.base + '/api/start', { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"version":2}' });
  assert.equal(started.status, 200); const original = (await started.json()).trial.sessionId;
  const names = await readdir(owners), ownerName = names.find(x => x.endsWith('.owner.json'))!;
  const ownerFile = owners + '/' + ownerName, lockFile = owners + '/.' + ownerName.slice(0, 64) + '.lock';
  const before = await readFile(ownerFile), lockBefore = await readFile(lockFile);
  const other = await start(config, owners); running.push(other);
  const denied = await fetch(other.base + '/api/state', { headers: { Cookie: cookie } });
  assert.equal(denied.status, 409); assert.deepEqual(await denied.json(), { error: 'trial_unavailable' });
  assert.equal((await fetch(other.base + '/', { headers: { Cookie: cookie } })).status, 503);
  assert.deepEqual(await readFile(ownerFile), before); assert.deepEqual(await readFile(lockFile), lockBefore);
  other.child.kill('SIGINT'); await other.exited;
  first.child.kill('SIGKILL'); await first.exited;
  assert.equal(first.child.signalCode, 'SIGKILL'); assert.deepEqual(await readFile(lockFile), lockBefore);
  const blocked = await start(config, owners); running.push(blocked);
  assert.equal((await fetch(blocked.base + '/api/state', { headers: { Cookie: cookie } })).status, 409);
  assert.equal((await fetch(blocked.base + '/', { headers: { Cookie: cookie } })).status, 503);
  blocked.child.kill('SIGINT'); await blocked.exited;

  // All possible writers here are direct owned children; no supervisor/unseen host is claimed.
  assert.ok(running.every(p => p.child.exitCode !== null || p.child.signalCode !== null));
  const backup = root + '/backup'; await mkdir(backup, { mode: 0o700 });
  const lockIdentity = await stat(lockFile), ownerBytes = await readFile(ownerFile), lockBytes = await readFile(lockFile);
  for (const path of [ownerFile, lockFile]) { const s = await stat(path); assert.equal(s.mode & 0o777, 0o600); assert.equal(s.nlink, 1); assert.ok(s.isFile()); }
  await copyFile(ownerFile, backup + '/owner.json'); await chmod(backup + '/owner.json', 0o600);
  await copyFile(lockFile, backup + '/lock'); await chmod(backup + '/lock', 0o600);
  assert.equal(digest(await readFile(backup + '/owner.json')), digest(ownerBytes));
  assert.equal(digest(await readFile(backup + '/lock')), digest(lockBytes));
  const recheck = await stat(lockFile);
  assert.deepEqual([recheck.dev, recheck.ino, recheck.size], [lockIdentity.dev, lockIdentity.ino, lockIdentity.size]);
  assert.equal(digest(await readFile(ownerFile)), digest(ownerBytes));
  assert.equal(digest(await readFile(lockFile)), digest(lockBytes));
  await unlink(lockFile); // Exactly one inspected path, after owned writers exited; never product code.
  const restored = await start(config, owners); running.push(restored);
  const state = await fetch(restored.base + '/api/state', { headers: { Cookie: cookie } });
  assert.equal(state.status, 200); assert.equal((await state.json()).trial.sessionId, original);
  const a = JSON.parse(ownerBytes.toString()).owner.admissions.initial.assignment;
  assert.deepEqual(JSON.parse((await readFile(ownerFile)).toString()).owner.admissions.initial.assignment, a);
  restored.child.kill('SIGINT'); await restored.exited;
  assert.equal((await readdir(owners)).filter(x => x.endsWith('.lock')).length, 0);
});
