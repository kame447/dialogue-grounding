import test from 'node:test';
import assert from 'node:assert/strict';
import { isExcessiveTraffic } from '../workers/tangram-experiment/src/soft-limits.ts';

class Counter {
  constructor(limit) { this.max = limit; this.counts = new Map(); }
  async limit({ key }) {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { success: count <= this.max };
  }
  count(key) { return this.counts.get(key) ?? 0; }
}

function bindings() {
  return {
    START_RATE_LIMIT: new Counter(40),
    SESSION_ACTION_RATE_LIMIT: new Counter(30),
    IP_ACTION_RATE_LIMIT: new Counter(120),
    GLOBAL_ACTION_RATE_LIMIT: new Counter(300),
  };
}
function request(path, { method = 'POST', ip = '203.0.113.42', forwardedFor = '' } = {}) {
  return new Request(`https://tangram.test${path}`, {
    method,
    headers: { 'CF-Connecting-IP': ip, ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
  });
}

test('page loads and frequent status polling have no limits or counter cost', async () => {
  const limits = bindings();
  for (let i = 0; i < 1000; i++) {
    assert.equal(await isExcessiveTraffic(request('/api/state', { method: 'GET' }), limits, 'session'), false);
    assert.equal(await isExcessiveTraffic(request('/', { method: 'GET' }), limits, 'session'), false);
  }
  for (const counter of Object.values(limits)) assert.equal(counter.counts.size, 0);
});

test('trial starts tolerate a classroom-sized burst but block 41+ starts per minute from one IP', async () => {
  const limits = bindings();
  for (let i = 0; i < 40; i++) assert.equal(await isExcessiveTraffic(request('/api/start'), limits, `s-${i}`), false);
  assert.equal(await isExcessiveTraffic(request('/api/start'), limits, 's-41'), true);
  assert.equal(await isExcessiveTraffic(request('/api/start', { ip: '203.0.113.43' }), limits, 'different-person'), false);
});

test('a long research dialogue has no total turn limit; only clearly excessive one-minute bursts are stopped', async () => {
  const limits = bindings();
  for (let i = 0; i < 30; i++) assert.equal(await isExcessiveTraffic(request('/api/message'), limits, 'original'), false);
  assert.equal(await isExcessiveTraffic(request('/api/message'), limits, 'original'), true);
  assert.equal(await isExcessiveTraffic(request('/api/message'), limits, 'another-session'), false);
  assert.equal(limits.IP_ACTION_RATE_LIMIT.count('203.0.113.42'), 31);
});

test('multiple sessions on one IP share a loose paid-action flood limit; spoofed X-Forwarded-For has no effect', async () => {
  const limits = bindings();
  for (let i = 0; i < 120; i++) {
    const session = `s-${Math.floor(i / 20)}`;
    assert.equal(await isExcessiveTraffic(request('/api/message', { forwardedFor: `10.0.0.${i}` }), limits, session), false);
  }
  assert.equal(await isExcessiveTraffic(request('/api/retry'), limits, 's-6'), true);
  assert.equal(await isExcessiveTraffic(request('/api/names', { ip: '203.0.113.43' }), limits, 'new-session'), false);
});

test('a high global rate across many IPs is also limited; unrelated endpoints are not', async () => {
  const limits = bindings();
  for (let i = 0; i < 300; i++) {
    const identity = Math.floor(i / 10);
    assert.equal(await isExcessiveTraffic(request('/api/message', { ip: `203.0.113.${identity + 1}` }), limits, `s-${identity}`), false);
  }
  assert.equal(await isExcessiveTraffic(request('/api/ai-submit', { ip: '198.51.100.42' }), limits, 'other'), true);
  assert.equal(await isExcessiveTraffic(request('/api/not-a-route'), limits, 'other'), false);
  assert.equal(await isExcessiveTraffic(request('/api/message'), limits, null), false);
});
