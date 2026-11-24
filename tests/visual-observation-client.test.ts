import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualObservationClient } from '../dialogue-model/runtime/observation/vision-client.ts';
import { handleRequest } from '../workers/research-ai-proxy/src/index.mjs';

test('visual client uses the dedicated policy and model without changing the dialogue transport', async () => {
  const env = { RESEARCH_PROXY_TOKEN: 'synthetic-local-test-token-not-real-1234', UPSTREAM_API_KEY: 'synthetic',
    UPSTREAM_PROVIDER: 'openai', DIALOGUE_MODEL: 'synthetic-luna', VISION_MODEL: 'synthetic-terra' };
  const requests: unknown[] = [];
  const client = createVisualObservationClient({ provider: 'cloudflare', baseUrl: 'https://mock.invalid/v1', apiKey: env.RESEARCH_PROXY_TOKEN },
    (input, init) => handleRequest(new Request(input, init), env, async (_url, options) => {
      const body = JSON.parse(String(options?.body)); requests.push(body);
      return Response.json({ model: body.model, choices: [{ message: { content: 'synthetic observation' } }] });
    }));
  const policy = await client.getModelPolicy();
  assert.equal(policy.purpose, 'visual_observation'); assert.equal(policy.model, env.VISION_MODEL); assert.equal(policy.ready, true);
  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } }] }];
  assert.equal((await client.complete(messages)).model, env.VISION_MODEL);
  assert.deepEqual(requests, [{ model: env.VISION_MODEL, messages, max_completion_tokens: 1024 }]);
});


test('visual client refuses a success response lacking an actual model ID', async () => {
  const client = createVisualObservationClient({ provider: 'cloudflare', baseUrl: 'https://mock.invalid/v1', apiKey: 'synthetic' },
    async () => Response.json({ choices: [{ message: { content: 'synthetic observation' } }] }));
  await assert.rejects(client.complete([{ role: 'user', content: 'synthetic' }]), /provider_http_error/);
});
