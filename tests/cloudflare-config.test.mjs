import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dialogue-model/runtime/config.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";

const token = "local-worker-access-token-at-least-32-chars";
const env = {
  RESEARCH_AI_PROVIDER: "cloudflare",
  RESEARCH_AI_BASE_URL: "https://my-research-worker.workers.dev",
  RESEARCH_PROXY_TOKEN: token,
};

test("Cloudflare config uses proxy token, not an upstream provider key", () => {
  const config = loadConfig({ ...env, RESEARCH_AI_API_KEY: "do-not-use-this-key" });
  assert.equal(config.provider, "cloudflare");
  assert.equal(config.apiKey, token);
  assert.equal(config.model, undefined);
  assert.equal(config.purpose, "dialogue_turn");
  assert.equal(config.baseUrl, "https://my-research-worker.workers.dev/v1");
});

test("Cloudflare client posts to authenticated Worker route", async () => {
  let url;
  let auth;
  let payload;
  const client = createChatClient(loadConfig(env), async (destination, options) => {
    url = destination.toString();
    auth = options.headers.Authorization;
    payload = JSON.parse(options.body);
    return Response.json({
      model: "vision-model-for-test",
      choices: [{ message: { content: "認識しました" } }],
    });
  });
  const result = await client.complete([{ role: "user", content: "図形について話しましょう" }]);
  assert.equal(result.text, "認識しました");
  assert.equal(url, "https://my-research-worker.workers.dev/v1/chat/completions");
  assert.equal(auth, "Bearer " + token);
  assert.equal(payload.purpose, "dialogue_turn");
  assert.equal(Object.hasOwn(payload, "model"), false);
});

test("Cloudflare mode rejects missing or weak proxy token and incorrect path", () => {
  assert.throws(() => loadConfig({ ...env, RESEARCH_PROXY_TOKEN: "" }), /RESEARCH_PROXY_TOKEN/);
  assert.throws(() => loadConfig({ ...env, RESEARCH_PROXY_TOKEN: "short" }), /32 characters/);
  assert.throws(() => loadConfig({
    ...env, RESEARCH_AI_BASE_URL: "https://my-research-worker.workers.dev/foo",
  }), /\/v1/);
});

test("authenticated Cloudflare model status comes from the Worker, not the client", async () => {
  let requestMethod;
  let requestAuth;
  const client = createChatClient(loadConfig(env), async (_url, options) => {
    requestMethod = options.method;
    requestAuth = options.headers.Authorization;
    return Response.json({
      purpose: "dialogue_turn", provider: "openai", model: "gpt-4o-mini", ready: false,
    });
  });
  const policy = await client.getModelPolicy();
  assert.equal(policy.model, "gpt-4o-mini");
  assert.equal(policy.ready, false);
  assert.equal(requestMethod, undefined);
  assert.equal(requestAuth, "Bearer " + token);
});

test("direct API clients still require an explicit model and cannot inspect Worker policy", async () => {
  const config = loadConfig({
    RESEARCH_AI_PROVIDER: "openai", RESEARCH_AI_API_KEY: "test-key",
    RESEARCH_AI_MODEL: "known-vision-model",
  });
  const client = createChatClient(config, async () => Response.json({
    choices: [{ message: { content: "OK" } }],
  }));
  assert.equal((await client.complete([{ role: "user", content: "test" }])).text, "OK");
  await assert.rejects(client.getModelPolicy(), /only available through Cloudflare/);
});
