import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { web, ADMIN } from './support/s5-base/http-support.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dialogue-model/runtime/diagnostics/participant-role.ts', import.meta.url));
const authorization = { Authorization: 'Bearer ' + ADMIN };
const rolePath = (id: string) => '/admin/record/' + id + '/participant-role';
const view = (role: string) => ({ schemaVersion: 'participant_role_v1', role });

async function set(w: Awaited<ReturnType<typeof web>>, id: string, role: string, auth = true): Promise<Response> {
  return fetch(w.base() + rolePath(id), { method: 'POST', redirect: 'manual',
    headers: { ...(auth ? authorization : { Cookie: w.cookie }), Origin: w.base(), Accept: 'application/json' },
    body: new URLSearchParams({ role }) });
}

test('I209 local admin changes historic trials across restart without rewriting owner or scoring', async t => {
  let now = 946684800000;
  const w = await web(t, { now: () => now });
  assert.equal((await w.page()).status, 200);
  const start = await w.request('/api/start', { version: 2 });
  assert.equal(start.status, 200);
  const { trial: { sessionId: id } } = await start.json();
  await w.tasks[0].complete();
  const exportPath = '/admin/record/' + id + '.json';
  const getExport = () => w.request(exportPath, undefined, authorization, false).then(r => r.json());
  const baseline = await getExport();
  assert.deepEqual(baseline.participantRole, view('unclassified'));
  const ownerFilename = (await readdir(w.storeRoot)).find(file => file.endsWith('.owner.json'))!;
  const ownerPath = join(w.storeRoot, ownerFilename);
  const roleFile = join(w.storeRoot, ownerFilename.slice(0, -'.owner.json'.length) + '.' + id + '.participant-role.json');
  const ownerBytes = await readFile(ownerPath);
  assert.equal((await set(w, id, 'ai', false)).status, 401);
  assert.equal((await set(w, id, 'unknown')).status, 400);
  assert.equal((await set(w, id, 'ai')).status, 200);
  assert.equal((await stat(roleFile)).mode & 0o777, 0o600);
  assert.deepEqual(await getExport(), { ...baseline, participantRole: view('ai') });
  assert.deepEqual(await readFile(ownerPath), ownerBytes);
  await w.restart();
  assert.deepEqual(await getExport(), { ...baseline, participantRole: view('ai') });
  now += 30 * 60_000;
  assert.equal((await set(w, id, 'human')).status, 200, 'expired participant access does not hide a retained admin record');
  assert.deepEqual(await getExport(), { ...baseline, participantRole: view('human') });
  assert.deepEqual(await readFile(ownerPath), ownerBytes);
  assert.doesNotMatch(await (await w.request('/api/records')).text(), /participantRole/);
  await w.stop();
  const run = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args])).stdout);
  assert.deepEqual(await run('get', w.storeRoot, id), { recordId: id, participantRole: view('human') });
  assert.deepEqual(await run('set', w.storeRoot, id, 'unclassified'), { recordId: id, participantRole: view('unclassified') });
  assert.deepEqual(await run('list', w.storeRoot, 'unclassified'), [{ recordId: id, participantRole: view('unclassified') }]);
  assert.deepEqual(await run('list', w.storeRoot, 'human'), []);
  assert.deepEqual(await readFile(ownerPath), ownerBytes);
  const exports = await Promise.all(['human', 'ai', 'unclassified'].map(async (role, i) => {
    const filename = join(w.dir, role + '.json');
    const recordId = '00000000-0000-4000-8000-00000000000' + i;
    await writeFile(filename, JSON.stringify({ recordId, ...(role === 'unclassified' ? {} : { participantRole: view(role) }) }), { mode: 0o600 });
    return { filename, recordId, role };
  }));
  for (const { role, recordId } of exports) {
    assert.deepEqual(await run('extract', role, ...exports.map(item => item.filename)), [{ recordId, participantRole: view(role) }]);
  }
});

test('I209 local delete removes the separate role file and rejects delayed updates', async t => {
  const w = await web(t);
  await w.page();
  const r = await w.request('/api/start', { version: 2 });
  assert.equal(r.status, 200);
  const id = (await r.json()).trial.sessionId;
  assert.equal((await set(w, id, 'ai')).status, 200);
  const deleted = await fetch(w.base() + '/admin/record/' + id + '/delete', { method: 'POST', redirect: 'manual',
    headers: { ...authorization, Origin: w.base() }, body: new URLSearchParams({ confirm: id }) });
  assert.equal(deleted.status, 303);
  assert.ok(!(await readdir(w.storeRoot)).some(file => file.endsWith('.participant-role.json')));
  assert.equal((await set(w, id, 'human')).status, 404);
  assert.equal((await w.request(rolePath(id), undefined, authorization, false)).status, 404);
});
