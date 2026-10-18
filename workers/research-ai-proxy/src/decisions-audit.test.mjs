import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './index.mjs';
import { buildDecisionPayload, sanitizeDecision, DECISION_ACTIONS, DECISION_MODELS, OPENROUTER_DECISIONS_URL } from './decisions.mjs';

// Handwritten synthetic fixtures matching the raw REST schema (not SDK casing).
const TOKEN = 'audit-proxy-token-at-least-thirty-two-characters';
const KEY = 'sk-or-audit-private-key-canary';
const env = { RESEARCH_PROXY_TOKEN: TOKEN, RESEARCH_DECISIONS_ENABLED: 'true', OPENROUTER_DECISIONS_API_KEY: KEY,
  UPSTREAM_PROVIDER: 'openai', DIALOGUE_MODEL: 'gpt-6-luna', UPSTREAM_API_KEY: 'audit-existing-chat-key' };
const probabilities = Object.fromEntries(DECISION_ACTIONS.map(action => [action, action === 'confirm' ? 1 : 0]));
const rawResult = purpose => ({ id: 'gen-synthetic-audit-response', provider: purpose === 'decision_jev' ? 'TypeSafe' : 'OpenAI',
  model: DECISION_MODELS[purpose] + (purpose === 'decision_jev' ? '-20261014' : '-20261006'),
  answers: { action: { type: 'choice', choice: 'confirm', probabilities, confidence: 1 } },
  usage: { input_tokens: 887, output_tokens: 86, cost: 0.000037254 } });
const request = (body = { purpose: 'decision_jev', state: '合成の公開発話' }, path = '/v1/decisions') => new Request('https://audit.test' + path,
  { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('audit: actual dated-build formats, integer probabilities and nonzero output tokens are accepted for both models', async () => {
  for (const purpose of Object.keys(DECISION_MODELS)) {
    const raw = rawResult(purpose), seen = [];
    const result = await handleRequest(request({ purpose, state: '合成の公開発話' }), env, async (url, init) => {
      seen.push({ url, init }); return Response.json(raw);
    });
    assert.equal(result.status, 200);
    const clean = await result.json();
    assert.equal(clean.model, raw.model); assert.deepEqual(clean.probabilities, probabilities);
    assert.equal(clean.confidence, 1); assert.equal(clean.provider, raw.provider); assert.equal(clean.id, raw.id);
    assert.equal(clean.usage.outputTokens, 86); assert.equal(clean.usage.inputTokens, 887); assert.equal(clean.usage.costUsd, raw.usage.cost);
    assert.deepEqual(Object.keys(clean).sort(), ['action', 'confidence', 'id', 'model', 'probabilities', 'provider', 'purpose', 'usage']);
    assert.equal(seen[0].url, OPENROUTER_DECISIONS_URL);
    assert.equal(seen[0].init.headers.Authorization, 'Bearer ' + KEY);
    const payload = JSON.parse(seen[0].init.body);
    assert.deepEqual(Object.keys(payload).sort(), ['model', 'questions', 'state']);
    assert.equal(payload.model, DECISION_MODELS[purpose]);
    assert.deepEqual(Object.keys(payload.questions.action).sort(), ['criteria', 'instructions', 'type']);
    assert.deepEqual(Object.keys(payload.questions.action.criteria), DECISION_ACTIONS);
  }
});

test('audit: authenticate before body access, disabled/configuration checks, or any upstream request', async () => {
  let reads = 0, calls = 0;
  const bad = { url: 'https://audit.test/v1/decisions', method: 'POST', headers: new Headers({ 'Content-Type': 'text/plain' }),
    get body() { reads++; throw new Error('must not read'); } };
  const gatedEnv = { ...env, get RESEARCH_DECISIONS_ENABLED() { throw new Error('authentication must come first'); } };
  const response = await handleRequest(bad, gatedEnv, async () => { calls++; });
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthorized' });
  assert.equal(reads, 0); assert.equal(calls, 0);
  for (const configuration of [
    { ...env, RESEARCH_DECISIONS_ENABLED: undefined }, { ...env, RESEARCH_DECISIONS_ENABLED: false },
    { ...env, RESEARCH_DECISIONS_ENABLED: 'false' }, { ...env, OPENROUTER_DECISIONS_API_KEY: undefined },
    { ...env, OPENROUTER_DECISIONS_API_KEY: '' }, { ...env, OPENROUTER_DECISIONS_API_KEY: 'not-an-openrouter-key' },
  ]) {
    assert.equal((await handleRequest(request(), configuration, async () => { calls++; })).status, 503);
  }
  assert.equal(calls, 0);
});

test('audit: text-only research subset rejects arbitrary models, URLs, questions and image/object/array states without fetching', async () => {
  let calls = 0;
  const valid = { purpose: 'decision_jev', state: '公開済みの合成文' };
  for (const body of [
    { ...valid, model: 'external/model' }, { ...valid, url: 'http://127.0.0.1/private' },
    { ...valid, questions: {} }, { ...valid, purpose: 'toString' },
    ...[null, [], {}, ['text', { type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }],
      { nested: { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } } }].map(state => ({ ...valid, state })),
  ]) {
    assert.equal(buildDecisionPayload(body), null);
    assert.equal((await handleRequest(request(body), env, async () => { calls++; })).status, 400);
  }
  assert.equal(calls, 0);
});

test('audit: all documented upstream error statuses and exception bodies are sanitized with no retry', async () => {
  for (const status of [400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529]) {
    let calls = 0;
    const result = await handleRequest(request(), env, async () => { calls++;
      return Response.json({ error: { code: status, message: KEY, metadata: { raw: KEY } } }, { status }); });
    assert.equal(calls, 1); assert.equal(result.status, status === 402 ? 402 : status === 429 ? 429 : 502);
    assert.deepEqual(await result.json(), { error: status === 402 ? 'upstream_payment_required' : status === 429 ? 'upstream_rate_limited' : 'upstream_error' });
  }
  for (const [upstream, error] of [[async () => { throw new Error(KEY); }, 'upstream_unavailable'], [async () => new Response(KEY), 'invalid_upstream_response']]) {
    const result = await handleRequest(request(), env, upstream);
    assert.equal(result.status, 502); assert.deepEqual(await result.json(), { error });
  }
});

test('audit: success sanitizer keeps bounded provider/id and numeric usage while stripping extra metadata and rejecting answer contamination', () => {
  const source = { ...rawResult('decision_jev'), provider: 'synthetic-provider', id: 'gen-synthetic-id', extra: KEY, error: { message: KEY },
    usage: { input_tokens: KEY, output_tokens: KEY, cost: KEY, extra: KEY } };
  const clean = sanitizeDecision(source, DECISION_MODELS.decision_jev, 'decision_jev');
  assert.ok(!JSON.stringify(clean).includes(KEY)); assert.equal(clean.provider, source.provider); assert.equal(clean.id, source.id);
  assert.equal(clean.usage.inputTokens, null); assert.equal(clean.usage.outputTokens, null); assert.equal(clean.usage.costUsd, null);
  // Real ids are 'gen-…'; anything else, or over 128 chars, is dropped.
  for (const [provider, id] of [['p'.repeat(64), 'gen-' + 'i'.repeat(124)], ['p'.repeat(65), 'gen-' + 'i'.repeat(125)], ['p', 'i'.repeat(20)], [17, {}]]) {
    const result = sanitizeDecision({ ...source, provider, id }, DECISION_MODELS.decision_jev, 'decision_jev');
    assert.equal(result.provider, typeof provider === 'string' && provider.length <= 64 ? provider : null);
    assert.equal(result.id, typeof id === 'string' && /^gen-[A-Za-z0-9_-]{1,124}$/.test(id) ? id : null);
  }
  for (const mutation of [
    { ...source, model: 'typesafe/jev-1.14-' + KEY },
    { ...source, answers: { action: { ...source.answers.action, confidence: KEY } } },
    { ...source, answers: { action: { ...source.answers.action, probabilities: { ...probabilities, metadata: KEY } } } },
  ]) assert.equal(sanitizeDecision(mutation, DECISION_MODELS.decision_jev, 'decision_jev'), null);
});

test('audit: Decisions flags do not change existing chat route, secret, URL, model or response', async () => {
  const calls = [], responses = [];
  for (const enabled of ['true', 'false']) {
    const response = await handleRequest(request({ purpose: 'dialogue_turn', messages: [{ role: 'user', content: '合成の挨拶' }] }, '/v1/chat/completions'),
      { ...env, RESEARCH_DECISIONS_ENABLED: enabled }, async (url, init) => {
        calls.push({ url, authorization: init.headers.Authorization, body: JSON.parse(init.body) });
        return Response.json({ model: 'gpt-6-luna', choices: [{ message: { content: 'こんにちは' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      });
    assert.equal(response.status, 200); responses.push(await response.json());
  }
  assert.deepEqual(calls[0], calls[1]); assert.deepEqual(responses[0], responses[1]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer ' + env.UPSTREAM_API_KEY); assert.equal(calls[0].body.model, 'gpt-6-luna');
});


test('audit: successful upstream provider/id must not reflect the Worker OpenRouter secret', async () => {
  for (const value of [KEY, 'Bearer ' + KEY, 'gen-dec-' + KEY]) {
    const result = await handleRequest(request(), env, async () => Response.json({ ...rawResult('decision_jev'), provider: value, id: value }));
    const body = await result.text();
    assert.ok(!body.includes(KEY), 'allowlisted success metadata must still scrub the actual Worker secret');
  }
});
