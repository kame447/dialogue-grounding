import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { web, ADMIN } from './support/s5-base/http-support.ts';

// Addendum06a C / frozen independent G2.deleted_predecessor_next404_current_B_usable.
test('deleted predecessor prepare-next returns JSON404 warm/cold and preserves current successor', async t => {
  const w = await web(t);
  assert.equal((await w.page()).status, 200);
  const started = await w.request('/api/start', { version: 2 });
  assert.equal(started.status, 200);
  const a = (await started.json()).trial.sessionId;
  await w.tasks[0].complete();
  const admin = (path: string, body: string, headers: Record<string, string> = {}) => fetch(w.base() + path, {
    method: 'POST', redirect: 'manual', headers: {
      Authorization: 'Bearer ' + ADMIN, Origin: w.base(), 'Content-Type': 'application/json', ...headers
    }, body
  });
  const nextPath = '/admin/record/' + a + '/prepare-next';
  const created = await admin(nextPath, '{}');
  assert.equal(created.status, 201);
  const b = (await created.json()).recordId;
  const deleted = await admin('/admin/record/' + a + '/delete', 'confirm=' + a, {
    'Content-Type': 'application/x-www-form-urlencoded'
  });
  assert.equal(deleted.status, 303);
  const path = w.storeRoot + '/' + (await fs.readdir(w.storeRoot)).find((p: string) => p.endsWith('.owner.json'));
  const before = await fs.readFile(path), calls = w.inputs.length;
  for (const cold of [false, true]) {
    if (cold) await w.restart();
    const response = await admin(nextPath, '{}');
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type')!, /^application\/json;/u);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await fs.readFile(path), before);
    assert.equal(w.inputs.length, calls);
    const state = await w.request('/api/state');
    assert.equal(state.status, 200);
    assert.equal((await state.json()).trial.sessionId, b);
    assert.equal(w.inputs.length, calls + Number(cold));
    if (cold) {
      const restored = w.inputs.at(-1).restore;
      assert.equal(restored.recordId, b);
      assert.deepEqual(restored.assignment, JSON.parse(before.toString()).archives[b].assignment);
    }
  }
});
