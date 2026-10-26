import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { privateBaseOptions } from './support/s5-private-options.mjs';

// Connect the existing durable clientId oracle to real BASE HTTP + owner storage.
// No injected task, saved record, judge, or completed state; only model I/O is fake.
test('BASE HTTP restart preserves a message receipt and resending it does not rerun the model', { timeout: 15_000 }, async t => {
  let modelCalls = 0;
  const client = {
    async complete(messages: Array<{ role: string; content: unknown }>) {
      modelCalls++;
      const judging = messages.some(message => message.role === 'system'
        && typeof message.content === 'string' && message.content.includes('【非公開の対話判断】'));
      return {
        text: judging
          ? JSON.stringify({ action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null })
          : 'Synthetic acknowledgement.',
        model: 'synthetic-offline-luna', latencyMs: 0,
      };
    },
  };
  let server: Server | null = null;
  let origin = '';
  const close = async () => {
    if (!server) return;
    const current = server;
    server = null;
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  };
  t.after(close);
  const options = { client, ...(await privateBaseOptions(t, { seed: 731 })), hideStrategy: true };
  const open = async () => {
    server = createNamingServer(options);
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
  };
  await open();
  const page = await fetch(origin);
  await page.text();
  assert.equal(page.status, 200);
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie ?? '', /^naming_session=[a-f0-9]{64}$/);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      headers: { Cookie: cookie!, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get('set-cookie'), null);
    return { status: response.status, json: await response.json() as any };
  };
  const idle = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = await request('/api/state');
      assert.equal(state.status, 200);
      assert.notEqual(state.json.trial.aiStatus, 'error');
      if (!state.json.busy && state.json.trial.aiStatus === 'idle') return state.json.trial;
      await delay(10);
    }
    assert.fail('synthetic conversation did not become idle');
  };

  try {
    const started = await request('/api/start', { version: 2 });
    assert.equal(started.status, 200);
    assert.equal(modelCalls, 0, 'scripted opening uses no model');
    const message = { text: 'Synthetic first shape description.', clientId: 'restart-stable-message' };
    const accepted = await request('/api/message', message);
    assert.equal(accepted.status, 202);
    const before = await idle();
    assert.equal(modelCalls, 2, 'one judgment and one response');

    await close();
    await open();
    const restored = await idle();
    assert.equal(restored.sessionId, started.json.trial.sessionId);
    assert.deepEqual(restored.events, before.events);
    assert.equal(modelCalls, 2, 'idle restore does not rerun a turn');

    const resent = await request('/api/message', message);
    assert.equal(resent.status, 202);
    assert.equal(resent.json.eventId, accepted.json.eventId);
    const deduplicated = await idle();
    assert.deepEqual(deduplicated.events, before.events);
    assert.equal(deduplicated.events.filter((event: any) => event.speaker === 'human' && event.text === message.text).length, 1);
    assert.equal(modelCalls, 2, 'same clientId cannot generate another model request');

    const continued = await request('/api/message', { text: 'Synthetic next shape description.', clientId: 'restart-next-message' });
    assert.equal(continued.status, 202);
    assert.notEqual(continued.json.eventId, accepted.json.eventId);
    const final = await idle();
    assert.equal(final.sessionId, before.sessionId);
    assert.deepEqual(final.events.slice(0, before.events.length), before.events);
    assert.deepEqual(final.events.slice(before.events.length).map((event: any) => event.speaker), ['human', 'ai']);
    assert.equal(modelCalls, 4, 'a fresh clientId still makes one normal turn');
  } finally {
    await close();
  }
});
