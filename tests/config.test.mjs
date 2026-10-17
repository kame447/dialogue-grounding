import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dialogue-model/runtime/config.mjs";

test("config selects the provider without storing credentials in URLs", () => {
  const config = loadConfig({
    RESEARCH_AI_PROVIDER: "gemini",
    RESEARCH_AI_MODEL: "test-vision-model",
    RESEARCH_AI_API_KEY: "test-key",
    RESEARCH_AI_MAX_COMPLETION_TOKENS: "300",
  });
  assert.equal(config.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(config.model, "test-vision-model");
  assert.equal(config.maxCompletionTokens, 300);
  assert.equal(config.apiKey, "test-key");
});

test("config rejects missing secrets, insecure external endpoints and invalid model names", () => {
  assert.throws(() => loadConfig({ RESEARCH_AI_MODEL: "m" }), /RESEARCH_AI_API_KEY/);
  assert.throws(() => loadConfig({ RESEARCH_AI_API_KEY: "test-key" }), /RESEARCH_AI_MODEL/);
  assert.throws(() => loadConfig({
    RESEARCH_AI_MODEL: "m",
    RESEARCH_AI_API_KEY: "test-key",
    RESEARCH_AI_BASE_URL: "http://example.com/v1",
  }), /HTTPS/);
  assert.throws(() => loadConfig({
    RESEARCH_AI_PROVIDER: "custom",
    RESEARCH_AI_MODEL: "m",
    RESEARCH_AI_API_KEY: "test-key",
  }), /RESEARCH_AI_BASE_URL/);
});

test("loopback HTTP is allowed for isolated integration tests", () => {
  const config = loadConfig({
    RESEARCH_AI_PROVIDER: "custom",
    RESEARCH_AI_MODEL: "test",
    RESEARCH_AI_API_KEY: "local-key",
    RESEARCH_AI_BASE_URL: "http://127.0.0.1:9999/v1",
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:9999/v1");
});

test("unset timeout permits the client image-aware default, and explicit timeout stays validated", () => {
  const env = { RESEARCH_AI_MODEL: "model", RESEARCH_AI_API_KEY: "local-key" };
  assert.equal(loadConfig(env).timeoutMs, undefined);
  assert.equal(loadConfig({ ...env, RESEARCH_AI_TIMEOUT_MS: "90000" }).timeoutMs, 90000);
  assert.throws(() => loadConfig({ ...env, RESEARCH_AI_TIMEOUT_MS: "0" }), /RESEARCH_AI_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ...env, RESEARCH_AI_TIMEOUT_MS: "120001" }), /RESEARCH_AI_TIMEOUT_MS/);
});
