import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dialogue-model/runtime/config.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";

const token = "local-worker-access-token-at-least-32-chars";
const env = {
  RESEARCH_AI_PROVIDER: "cloudflare",
  RESEARCH_AI_BASE_URL: "https://my-research-worker.workers.dev",
  RESEARCH_AI_MODEL: "vision-model-for-test",
  RESEARCH_PROXY_TOKEN: token,
};

test("Cloudflare config uses proxy token, not an upstream provider key", () => {
  const config = loadConfig({ ...env, RESEARCH_AI_API_KEY: "do-not-use-this-key" });
  assert.equal(config.provider, "cloudflare");
  assert.equal(config.apiKey, token);
  assert.equal(config.baseUrl, "https://my-research-worker.workers.dev/v1");
});

test("Cloudflare client posts to authenticated Worker route", async () => {
  let url;
  let auth;
  const client = createChatClient(loadConfig(env), async (destination, options) => {
    url = destination.toString();
    auth = options.headers.Authorization;
    return Response.json({
      model: "vision-model-for-test",
      choices: [{ message: { content: "認識しました" } }],
    });
  });
  const result = await client.complete([{ role: "user", content: "図形について話しましょう" }]);
  assert.equal(result.text, "認識しました");
  assert.equal(url, "https://my-research-worker.workers.dev/v1/chat/completions");
  assert.equal(auth, "Bearer " + token);
});

test("Cloudflare mode rejects missing or weak proxy token and incorrect path", () => {
  assert.throws(() => loadConfig({ ...env, RESEARCH_PROXY_TOKEN: "" }), /RESEARCH_PROXY_TOKEN/);
  assert.throws(() => loadConfig({ ...env, RESEARCH_PROXY_TOKEN: "short" }), /32 characters/);
  assert.throws(() => loadConfig({
    ...env, RESEARCH_AI_BASE_URL: "https://my-research-worker.workers.dev/foo",
  }), /\/v1/);
});
