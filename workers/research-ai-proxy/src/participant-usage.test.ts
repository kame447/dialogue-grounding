import test from 'node:test';
import assert from 'node:assert/strict';
import { participantChoices, participantUsageChoices } from './participant-transport.ts';
import { handleRequest } from './index.mjs';

const pin = { schemaVersion: 'participant_model_pin_v1', terraModelId: 'gpt-6.1-terra-2026-11-01',
  lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261014' };
const env = {
  PARTICIPANT_MODEL_PIN_JSON: JSON.stringify(pin), DIALOGUE_MODEL: 'gpt-6-luna', VISION_MODEL: 'gpt-6.1-terra',
  RESEARCH_PROXY_TOKEN: 'synthetic-proxy-token-for-mock-use', UPSTREAM_API_KEY: 'synthetic-key-mock-only',
  RESEARCH_DECISIONS_ENABLED: 'true', OPENROUTER_DECISIONS_API_KEY: 'sk-or-synthetic-decisions-mock',
};
const body = { model: 'typesafe/jev-1.14', state: '{}',
  questions: { action: { type: 'choice', instructions: 'synthetic', criteria: { accept: 'synthetic' } } } };
const answers = { action: { type: 'choice', choice: 'accept', probabilities: { accept: 1 } } };

test('new private choice path reports null cost and token counts without changing old choice validation', async () => {
  const reply = (usage: unknown, model = pin.jevModelId, answer: object = answers) =>
    async () => Response.json({ model, id: 'gen-synthetic', answers: answer, usage, extras: 'RAW_CANARY' });
  const missing = { input_tokens: 7, output_tokens: 2 };
  const result = await participantUsageChoices(env, body, pin.jevModelId, reply(missing));
  assert.deepEqual(result, { status: 200, data: { model: pin.jevModelId, id: 'gen-synthetic', answers,
    usage: { cost: null, prompt_tokens: 7, completion_tokens: 2 } } });
  assert.equal((await participantChoices(env, body, pin.jevModelId, reply(missing))).status, 502);
  for (const cost of [-1, '0.1', {}]) {
    assert.equal((await participantUsageChoices(env, body, pin.jevModelId, reply({ ...missing, cost }))).status, 502);
  }
  assert.equal((await participantUsageChoices(env, body, pin.jevModelId, reply(missing, pin.lunaModelId))).status, 502);
  assert.equal((await participantUsageChoices(env, body, pin.jevModelId, reply(missing, pin.jevModelId, {}))).status, 502);
});

test('private chat accounting exposes only the optional normalized cost and public chat keeps its schema', async () => {
  for (const [expected, cost, expectedCost] of [[pin.lunaModelId, 0.23, 0.23], [pin.lunaModelId, undefined, null],
    [null, 0.23, undefined]] as const) {
    const request = new Request('https://proxy.invalid/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'dialogue_turn', messages: [{ role: 'user', content: 'synthetic' }] }),
    });
    const response = await handleRequest(request, env, async () => Response.json({
      model: pin.lunaModelId, choices: [{ message: { content: 'synthetic' } }],
      usage: { prompt_tokens: 7, completion_tokens: 4, cost, extra: 'RAW_CANARY' },
    }), expected, true);
    assert.equal(response.status, 200);
    const result = await response.json() as { usage: unknown };
    assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 4, ...(expectedCost === undefined ? {} : { cost: expectedCost }) });
  }
});

test('choice rejection accounts only sanitized usage from a pinned successful upstream response', async () => {
  const rejected = { model: pin.jevModelId, answers: {}, usage: {
    cost: 0.012, input_tokens: 18, output_tokens: 5, private: 'RAW_CANARY',
  } };
  assert.deepEqual(await participantUsageChoices(env, body, pin.jevModelId, async () => Response.json(rejected)), {
    status: 502, data: { error: 'invalid_upstream_response' },
    verifiedUsage: { model: pin.jevModelId, costUsd: 0.012, inputTokens: 18, outputTokens: 5 },
  });
  assert.deepEqual(await participantChoices(env, body, pin.jevModelId, async () => Response.json(rejected)), {
    status: 502, data: { error: 'invalid_upstream_response' },
  });
  assert.deepEqual(await participantUsageChoices(env, body, pin.jevModelId, async () => Response.json({
    ...rejected, model: pin.lunaModelId,
  })), { status: 502, data: { error: 'model_mismatch' } });
  for (const status of [402, 429]) {
    assert.deepEqual(await participantUsageChoices(env, body, pin.jevModelId, async () => Response.json(rejected, { status })),
      { status, data: { error: 'upstream_error' } });
  }
});

test('output-limit metadata reaches only the pinned private caller and never the HTTP body', async () => {
  for (const [expected, usageOnly] of [[null, true], [pin.lunaModelId, false], [pin.lunaModelId, true]] as const) {
    const request = new Request('https://proxy.invalid/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'dialogue_turn', messages: [{ role: 'user', content: 'synthetic' }] }),
    });
    const received: unknown[] = [];
    const response = await handleRequest(request, env, async () => Response.json({
      model: pin.lunaModelId, choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { cost: 0.037, prompt_tokens: 70, completion_tokens: 'malformed', extra: 'RAW_CANARY' },
    }), expected, usageOnly, usage => received.push(usage));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'upstream_output_limit' });
    assert.deepEqual(received, expected && usageOnly ?
      [{ model: pin.lunaModelId, costUsd: 0.037, inputTokens: 70, outputTokens: null }] : []);
  }
});

// #206 item 3: the chat upstream (api.openai.com, UPSTREAM_PROVIDER openai) reports token counts and no cost; only a numeric `usage.cost` from the upstream is forwarded.
// A missing cost therefore stays missing (null), never zero and never computed: the proxy holds no price table.
test('usage-only chat: an upstream that reports no cost yields cost null with the tokens kept; a reported cost is forwarded unchanged', async () => {
  const call = async (usage: unknown, purpose: 'dialogue_turn' | 'visual_observation', model: string) => {
    const request = new Request('https://proxy.invalid/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEARCH_PROXY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(purpose === 'dialogue_turn' ? { purpose, messages: [{ role: 'user', content: 'synthetic' }] }
        : { purpose, messages: [{ role: 'user', content: 'synthetic' }] }) });
    const response = await handleRequest(request, env, async () => Response.json({ model, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage }), model, true);
    assert.equal(response.status, 200);
    return (await response.json() as { usage: Record<string, unknown> }).usage;
  };
  for (const [purpose, model] of [['dialogue_turn', pin.lunaModelId], ['visual_observation', pin.terraModelId]] as const) {
    assert.deepEqual(await call({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }, purpose, model), { prompt_tokens: 120, completion_tokens: 30, cost: null }, purpose + ': no upstream cost');
    assert.deepEqual(await call({ prompt_tokens: 120, completion_tokens: 30, cost: 0.0125 }, purpose, model), { prompt_tokens: 120, completion_tokens: 30, cost: 0.0125 }, purpose + ': a reported cost is kept');
    for (const bad of [-1, '0.1', null, Number.NaN]) {
      assert.equal((await call({ prompt_tokens: 1, completion_tokens: 1, cost: bad }, purpose, model)).cost, null, purpose + ': an unusable cost is missing, not zero');
    }
  }
});
