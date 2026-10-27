import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, config } from './support/s5-base/support.ts';
const { startNamingServer }: any = await import(pathToFileURL(join(root, 'dialogue-model/runtime/web/server.mjs')).href);
const { createNamingTaskV2 }: any = await import(pathToFileURL(join(root, 'dialogue-model/runtime/v2/naming-task-v2.mjs')).href);
async function cold(t: any) {
  const dir = await mkdtemp(join(await realpath(tmpdir()),'SandyNoether-s5-body-')), owners = join(dir, 'owners'), file = join(dir, 'config.json');
  await mkdir(owners, { mode: 0o700 }); await writeFile(file, JSON.stringify(config()), { mode: 0o600 });
  const counts = { factory: 0, restore: 0, model: 0 }; let server: any;
  const options = { port: 0, baseStoreRoot: owners, baseAssignmentFile: file,
    client: { async complete() { counts.model++; throw Error('unexpected synthetic model call'); } },
    createTaskV2: async (args: any) => { counts.factory++; if (args.restore !== null) counts.restore++; return await createNamingTaskV2(args); } };
  const open = async () => { server = await startNamingServer(options); };
  const close = async () => { if (server) { const s = server; server = null; await new Promise<void>((r, j) => s.close((e: any) => e ? j(e) : r())); } };
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  await open(); let base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base), cookie = page.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const started=await request('/api/start', { version: 2 });assert.equal(started.status, 200);const recordId=(await started.json()).trial.sessionId;assert.equal(counts.factory, 1);
  await close(); counts.factory = counts.restore = 0; await open(); base = 'http://127.0.0.1:' + server.address().port;
  const ownerFile = join(owners, cookie.split('=')[1] + '.owner.json');
  return { counts, request, recordId, bytes: () => readFile(ownerFile, 'utf8') };
}
for (const [label, value] of [['null', null], ['array', []], ['number', 42], ['string', 'synthetic'], ['true', true], ['false', false]] as [string, unknown][]) {
  test('local cold nonobject message rejects before restore: ' + label, async t => {
    const h = await cold(t), before = await h.bytes(); const r = await h.request('/api/message', value);
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'invalid_request' });
    assert.equal(h.counts.factory, 0); assert.equal(h.counts.restore, 0); assert.equal(h.counts.model, 0); assert.equal(await h.bytes(), before);
  });
}
for (const path of ['/api/start', '/api/retry', '/api/names', '/api/ai-submit']) test('local cold common nonobject body gate ' + path, async t => {
  const h = await cold(t); const r = await h.request(path, null);
  assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'invalid_request' });
  assert.equal(h.counts.factory, 0); assert.equal(h.counts.restore, 0); assert.equal(h.counts.model, 0);
});
test('local valid object field-error control reaches one real cold restore', async t => {
  const h = await cold(t); const r = await h.request('/api/message', {expectedRecordId:h.recordId});
  assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'invalid_message' });
  assert.equal(h.counts.factory, 1); assert.equal(h.counts.restore, 1); assert.equal(h.counts.model, 0);
});
