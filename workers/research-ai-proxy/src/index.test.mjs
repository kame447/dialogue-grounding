import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./index.mjs";

const env = {
  RESEARCH_PROXY_TOKEN: "a-valid-local-test-token-at-least-thirty-two-characters",
  UPSTREAM_PROVIDER: "openai",
  UPSTREAM_API_KEY: "upstream-secret-must-not-leak",
  DIALOGUE_MODEL: "vision-model-for-test",
  MAX_COMPLETION_TOKENS: "500",
};

function request(path, token, body, method = "POST", headers = {}) {
  return new Request("https://research.test" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function bodyWith(messages, extras = {}) {
  return { purpose: "dialogue_turn", messages, ...extras };
}

const simpleMessages = [{ role: "user", content: "図形について話しましょう。" }];
const result = {
  model: "provider-pinned-model",
  choices: [{ message: { role: "assistant", content: "船のように見えます。" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 20 },
};

test("Worker refuses to run without configured secrets, then requires authentication", async () => {
  let upstreamCalls = 0;
  const fetchImpl = async () => { upstreamCalls++; return Response.json(result); };
  const first = await handleRequest(
    request("/v1/chat/completions", null, bodyWith(simpleMessages)),
    { ...env, RESEARCH_PROXY_TOKEN: undefined }, fetchImpl);
  assert.equal(first.status, 503);
  const second = await handleRequest(
    request("/v1/chat/completions", "incorrect-credential", bodyWith(simpleMessages)),
    env, fetchImpl);
  assert.equal(second.status, 401);
  assert.equal(upstreamCalls, 0);
  assert.doesNotMatch(await second.text(), /secret|credential/);
});

test("Worker health check is authenticated and reports configuration status", async () => {
  const bad = await handleRequest(
    request("/health", env.RESEARCH_PROXY_TOKEN, undefined, "GET"),
    { ...env, UPSTREAM_API_KEY: "" });
  assert.equal(bad.status, 503);
  const good = await handleRequest(
    request("/health", env.RESEARCH_PROXY_TOKEN, undefined, "GET"), env);
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { status: "ready" });
  assert.equal(good.headers.get("Access-Control-Allow-Origin"), null);
});

test("Worker pins model, preserves participant image, and filters unwanted request fields", async () => {
  let sent;
  let url;
  const image = { type: "image_url", image_url: {
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  } };
  const messages = [
    { role: "system", content: "Only own participant image is included." },
    { role: "user", content: [
      { type: "text", text: "自分の図形の画像です" }, image,
    ] },
    { role: "user", content: "何の図形ですか？" },
  ];
  const res = await handleRequest(
    request("/v1/chat/completions", env.RESEARCH_PROXY_TOKEN,
      bodyWith(messages, { model: "hijacked-client-model", max_completion_tokens: 300 })),
    env,
    async (endpoint, options) => {
      url = endpoint;
      sent = { headers: options.headers, body: JSON.parse(options.body) };
      return Response.json(result);
    });
  assert.equal(res.status, 200);
  assert.equal(url, "https://api.openai.com/v1/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer upstream-secret-must-not-leak");
  assert.deepEqual(Object.keys(sent.body).sort(),
    ["max_completion_tokens", "messages", "model"]);
  assert.equal(sent.body.model, env.DIALOGUE_MODEL);
  assert.deepEqual(sent.body.messages[1].content[1], image);
  const answer = await res.json();
  assert.equal(answer.choices[0].message.content, "船のように見えます。");
  assert.deepEqual(answer.usage, { prompt_tokens: 50, completion_tokens: 20 });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("Worker never forwards unsupported models, tools, or arbitrary image URLs", async () => {
  let calls = 0;
  const upstream = async () => { calls++; return Response.json(result); };
  const cases = [
    { ...bodyWith(simpleMessages), purpose: "unauthorized-purpose", model: "unauthorized-model" },
    { messages: simpleMessages, model: env.DIALOGUE_MODEL },
    bodyWith([{ role: "tool", content: "invoke" }]),
    bodyWith([{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://localhost/secret" } },
    ] }]),
    bodyWith(simpleMessages, { max_completion_tokens: 501 }),
    bodyWith([{ role: "assistant", content: null }]),
  ];
  for (const candidate of cases) {
    const response = await handleRequest(
      request("/v1/chat/completions", env.RESEARCH_PROXY_TOKEN, candidate),
      env, upstream);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("Gemini goes to the fixed upstream endpoint and never echoes the upstream error", async () => {
  let called;
  const gemini = { ...env, UPSTREAM_PROVIDER: "gemini" };
  const response = await handleRequest(
    request("/v1/chat/completions", gemini.RESEARCH_PROXY_TOKEN,
      bodyWith(simpleMessages)),
    gemini,
    async (url) => {
      called = url;
      return new Response("upstream-secret-must-not-leak", { status: 401 });
    });
  assert.equal(called,
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /upstream-secret/);
});

test("Worker refuses unexpectedly large request, unsupported content type, and absent provider config", async () => {
  const huge = request("/v1/chat/completions", env.RESEARCH_PROXY_TOKEN,
    bodyWith(simpleMessages), "POST", { "Content-Length": String(19 * 1024 * 1024) });
  assert.equal((await handleRequest(huge, env)).status, 413);
  const wrongType = request("/v1/chat/completions", env.RESEARCH_PROXY_TOKEN,
    bodyWith(simpleMessages), "POST", { "Content-Type": "text/plain" });
  assert.equal((await handleRequest(wrongType, env)).status, 415);
  const notConfigured = await handleRequest(
    request("/v1/chat/completions", env.RESEARCH_PROXY_TOKEN, bodyWith(simpleMessages)),
    { ...env, DIALOGUE_MODEL: "" });
  assert.equal(notConfigured.status, 503);
});

test("upstream 429 and invalid response are handled without forwarding raw data", async () => {
  const req = () => request("/v1/chat/completions", env.RESEARCH_PROXY_TOKEN,
    bodyWith(simpleMessages));
  const rate = await handleRequest(req(), env,
    async () => new Response("private", { status: 429 }));
  assert.equal(rate.status, 429);
  assert.equal((await rate.json()).error, "upstream_rate_limited");
  const invalid = await handleRequest(req(), env,
    async () => Response.json({ choices: [] }));
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error, "invalid_upstream_response");
});

test("authenticated model policy is readable without consuming upstream inference", async () => {
  let calls = 0;
  const upstream = async () => { calls++; return Response.json(result); };
  const invalid = await handleRequest(
    request("/v1/model-policy", "not-the-token", undefined, "GET"), env, upstream);
  assert.equal(invalid.status, 401);
  const ready = await handleRequest(
    request("/v1/model-policy", env.RESEARCH_PROXY_TOKEN, undefined, "GET"), env, upstream);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    purpose: "dialogue_turn", provider: "openai", model: env.DIALOGUE_MODEL, ready: true,
  });
  const notReady = await handleRequest(
    request("/v1/model-policy", env.RESEARCH_PROXY_TOKEN, undefined, "GET"),
    { ...env, UPSTREAM_API_KEY: undefined }, upstream);
  assert.deepEqual(await notReady.json(), {
    purpose: "dialogue_turn", provider: "openai", model: env.DIALOGUE_MODEL, ready: false,
  });
  assert.equal(calls, 0);
});

test("Worker picks the internal model for the same client request after a configuration change", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const data = JSON.parse(options.body);
    seen.push({ url, model: data.model });
    return Response.json(result);
  };
  const requestBody = bodyWith(simpleMessages, { model: "untrusted-client-choice" });
  for (const [provider, model] of [
    ["openai", "vision-A"],
    ["openai", "vision-B"],
    ["gemini", "gemini-vision-C"],
  ]) {
    const res = await handleRequest(
      request("/v1/chat/completions", env.RESEARCH_PROXY_TOKEN, requestBody),
      { ...env, UPSTREAM_PROVIDER: provider, DIALOGUE_MODEL: model }, fetchImpl);
    assert.equal(res.status, 200);
  }
  assert.deepEqual(seen.map((row) => row.model), ["vision-A", "vision-B", "gemini-vision-C"]);
  assert.ok(seen[2].url.startsWith("https://generativelanguage.googleapis.com/"));
});
