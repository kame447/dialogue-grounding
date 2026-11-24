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
