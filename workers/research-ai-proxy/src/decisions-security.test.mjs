// Security regression tests for enabling the research Decisions route in the
// deployed proxy. Synthetic fixtures only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleRequest } from "./index.mjs";
import { DECISION_ACTIONS, DECISION_MODELS, OPENROUTER_DECISIONS_URL } from "./decisions.mjs";

const TOKEN = "security-proxy-token-at-least-thirty-two-characters";
const KEY = "sk-or-security-canary-openrouter-key";
const CHAT_KEY = "security-canary-chat-upstream-key";
const SECRETS = [TOKEN, KEY, CHAT_KEY];
const env = { RESEARCH_PROXY_TOKEN: TOKEN, RESEARCH_DECISIONS_ENABLED: "true", OPENROUTER_DECISIONS_API_KEY: KEY,
  UPSTREAM_PROVIDER: "openai", DIALOGUE_MODEL: "gpt-6-luna", UPSTREAM_API_KEY: CHAT_KEY, MAX_COMPLETION_TOKENS: "8192" };
const probabilities = Object.fromEntries(DECISION_ACTIONS.map((action) => [action, action === "confirm" ? 0.9 : 0.0125]));
const decision = { model: DECISION_MODELS.decision_jev + "-20261014", provider: "TypeSafe", id: "gen-synthetic",
  answers: { action: { type: "choice", choice: "confirm", probabilities, confidence: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 1, cost: 0.00001 } };
const body = { purpose: "decision_jev", state: "合成の公開発話" };
const request = (path, { method = "POST", bearer = TOKEN, contentType = "application/json", payload = body, headers = {} } = {}) =>
  new Request("https://security.test" + path, { method,
    headers: { ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...(method === "POST" && contentType ? { "Content-Type": contentType } : {}), ...headers },
    ...(method === "POST" ? { body: typeof payload === "string" ? payload : JSON.stringify(payload) } : {}) });
const noUpstream = () => { let calls = 0; return { fetch: async () => { calls++; throw new Error("must not be called"); }, get calls() { return calls; } }; };
async function textOf(response) {
  const text = await response.text();
  for (const secret of SECRETS) assert.ok(!text.includes(secret), "response must not echo a secret");
  return text;
}

test("security: deployed config enables Decisions by a plain flag and holds no secret values", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.vars.RESEARCH_DECISIONS_ENABLED, "true");
  // The grounding-evidence shadow route ships disabled; enabling it needs a separate researcher decision.
  assert.equal(config.vars.RESEARCH_GROUNDING_ENABLED, "false");
  assert.deepEqual(Object.keys(config.vars).sort(), ["DIALOGUE_MODEL", "MAX_COMPLETION_TOKENS", "RESEARCH_DECISIONS_ENABLED", "RESEARCH_GROUNDING_ENABLED", "UPSTREAM_PROVIDER"]);
  assert.equal(config.main, "src/worker.ts");
  assert.equal(config.observability.enabled, false);
  assert.doesNotMatch(source, /sk-or-|OPENROUTER_DECISIONS_API_KEY|UPSTREAM_API_KEY|RESEARCH_PROXY_TOKEN/);
});

test("security: both Decisions routes require the proxy token and echo no secret", async () => {
  for (const [path, method] of [["/v1/decisions", "POST"], ["/v1/decision-policy", "GET"]]) {
    for (const bearer of [null, "wrong-token-at-least-thirty-two-characters-long", TOKEN + "x", KEY, CHAT_KEY]) {
      const upstream = noUpstream();
      const response = await handleRequest(request(path, { method, bearer }), env, upstream.fetch);
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(await textOf(response)), { error: "unauthorized" });
      assert.equal(upstream.calls, 0);
    }
    // Basic and lowercase schemes are not accepted.
    const basic = await handleRequest(request(path, { method, bearer: null, headers: { Authorization: "Basic " + TOKEN } }), env);
    assert.equal(basic.status, 401);
    // Missing or short proxy token: fail closed before authentication.
    for (const RESEARCH_PROXY_TOKEN of [undefined, "", "short"]) {
      const response = await handleRequest(request(path, { method }), { ...env, RESEARCH_PROXY_TOKEN }, noUpstream().fetch);
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(await textOf(response)), { error: "service_unconfigured" });
    }
  }
});

test("security: Decisions fail closed when disabled or the OpenRouter key is missing", async () => {
  for (const [patch, error] of [[{ RESEARCH_DECISIONS_ENABLED: undefined }, "decisions_disabled"], [{ RESEARCH_DECISIONS_ENABLED: "TRUE" }, "decisions_disabled"],
    [{ RESEARCH_DECISIONS_ENABLED: "false" }, "decisions_disabled"], [{ OPENROUTER_DECISIONS_API_KEY: undefined }, "decisions_unconfigured"],
    [{ OPENROUTER_DECISIONS_API_KEY: "" }, "decisions_unconfigured"], [{ OPENROUTER_DECISIONS_API_KEY: CHAT_KEY }, "decisions_unconfigured"]]) {
    const upstream = noUpstream();
    const response = await handleRequest(request("/v1/decisions"), { ...env, ...patch }, upstream.fetch);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(await textOf(response)), { error });
    assert.equal(upstream.calls, 0);
    const policy = await handleRequest(request("/v1/decision-policy", { method: "GET" }), { ...env, ...patch });
    assert.equal((JSON.parse(await textOf(policy))).ready, false);
  }
  const ready = await handleRequest(request("/v1/decision-policy", { method: "GET" }), env);
  assert.deepEqual(JSON.parse(await textOf(ready)), { ready: true, enabled: true, models: DECISION_MODELS, textOnly: true });
});

test("security: Decisions enforce body size, method and content type before any upstream call", async () => {
  const upstream = noUpstream();
  const cases = [
    [request("/v1/decisions", { method: "GET" }), 405, "method_not_allowed"],
    [request("/v1/decisions", { method: "PUT", payload: body }), 405, "method_not_allowed"],
    [request("/v1/decision-policy", { method: "POST" }), 405, "method_not_allowed"],
    [request("/v1/decisions", { contentType: "text/plain" }), 415, "unsupported_media_type"],
    [request("/v1/decisions", { contentType: null }), 415, "unsupported_media_type"],
    [request("/v1/decisions", { payload: "{not json" }), 400, "invalid_json"],
    [request("/v1/decisions", { headers: { "Content-Length": String(18 * 1024 * 1024 + 1) } }), 413, "request_too_large"],
    [request("/v1/decisions", { payload: { ...body, state: "x".repeat(18 * 1024 * 1024) } }), 413, "request_too_large"],
  ];
  for (const [req, status, error] of cases) {
    const response = await handleRequest(req, env, upstream.fetch);
    assert.equal(response.status, status, error);
    assert.deepEqual(JSON.parse(await textOf(response)), { error });
  }
  assert.equal(upstream.calls, 0);
});

test("security: unknown or near-miss paths are 404 with or without a token", async () => {
  for (const path of ["/", "/v1", "/v1/decisions/", "/v1/Decisions", "/v1/decision", "/v1/decisions/extra", "/v1/decision-policy/",
    "/v1/grounding-evidence/", "/v1/grounding", "/api/alpha/decisions", "/v1/chat/completions/", "/admin"]) {
    for (const bearer of [TOKEN, null]) {
      const upstream = noUpstream();
      const response = await handleRequest(request(path, { bearer }), env, upstream.fetch);
      assert.equal(response.status, 404, path);
      assert.deepEqual(JSON.parse(await textOf(response)), { error: "not_found" });
      assert.equal(upstream.calls, 0);
    }
  }
});

test("security: the client cannot choose the model, upstream URL, questions or headers", async () => {
  const seen = [];
  const upstream = async (url, init) => { seen.push({ url, init }); return Response.json(decision); };
  for (const extra of [{ model: "openai/gpt-5" }, { url: "https://attacker.test/" }, { upstream: "https://attacker.test/" },
    { provider: "other" }, { questions: { action: { type: "choice" } } }, { headers: { Authorization: "Bearer x" } }, { api_key: KEY }]) {
    const response = await handleRequest(request("/v1/decisions", { payload: { ...body, ...extra } }), env, upstream);
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(await textOf(response)), { error: "invalid_request" });
  }
  assert.equal(seen.length, 0);
  for (const purpose of Object.keys(DECISION_MODELS)) {
    const response = await handleRequest(request("/v1/decisions", { payload: { purpose, state: "合成" },
      headers: { "X-Upstream-Url": "https://attacker.test/", "X-Model": "other" } }), env, upstream);
    assert.equal(response.status, purpose === "decision_jev" ? 200 : 502);
    await textOf(response);
  }
  assert.deepEqual(seen.map(({ url }) => url), [OPENROUTER_DECISIONS_URL, OPENROUTER_DECISIONS_URL]);
  assert.deepEqual(seen.map(({ init }) => JSON.parse(init.body).model), Object.values(DECISION_MODELS));
  for (const { init } of seen) {
    assert.deepEqual(Object.keys(init.headers).sort(), ["Authorization", "Content-Type"]);
    assert.equal(init.headers.Authorization, "Bearer " + KEY);
    assert.ok(!init.body.includes(TOKEN) && !init.body.includes(CHAT_KEY) && !init.body.includes(KEY));
  }
});

test("security: upstream 402/429/5xx/timeout map to fixed codes with no upstream body", async (t) => {
  for (const [status, expected, error] of [[402, 402, "upstream_payment_required"], [429, 429, "upstream_rate_limited"],
    [401, 502, "upstream_error"], [500, 502, "upstream_error"], [503, 502, "upstream_error"]]) {
    const response = await handleRequest(request("/v1/decisions"), env,
      async () => new Response("upstream says " + KEY + TOKEN, { status }));
    assert.equal(response.status, expected);
    assert.deepEqual(JSON.parse(await textOf(response)), { error });
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const pending = handleRequest(request("/v1/decisions"), env, (_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal;
    init.signal.addEventListener("abort", () => reject(new Error("aborted " + KEY)));
  }));
  // The Worker arms its 15 s timer just before calling upstream.
  while (!signal) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(14_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const timeout = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(timeout.status, 504);
  assert.deepEqual(JSON.parse(await textOf(timeout)), { error: "upstream_timeout" });
});

test("security: chat completions and model policy are identical with Decisions on, off or unkeyed", async () => {
  const calls = [], responses = [], policies = [];
  for (const patch of [{}, { RESEARCH_DECISIONS_ENABLED: "false" }, { RESEARCH_DECISIONS_ENABLED: undefined, OPENROUTER_DECISIONS_API_KEY: undefined }]) {
    const configured = { ...env, ...patch };
    const response = await handleRequest(request("/v1/chat/completions", { payload: { purpose: "dialogue_turn",
      messages: [{ role: "system", content: "合成" }, { role: "user", content: "合成の挨拶" }], max_completion_tokens: 100 } }),
    configured, async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return Response.json({ model: "gpt-6-luna", choices: [{ message: { content: "こんにちは" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 } });
    });
    assert.equal(response.status, 200);
    responses.push(JSON.parse(await textOf(response)));
    policies.push(JSON.parse(await textOf(await handleRequest(request("/v1/model-policy", { method: "GET" }), configured))));
  }
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[2], calls[0]);
  assert.deepEqual(responses[1], responses[0]);
  assert.deepEqual(responses[2], responses[0]);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Authorization", "Content-Type"]);
  assert.equal(calls[0].headers.Authorization, "Bearer " + CHAT_KEY);
  assert.ok(!calls[0].body.includes(KEY));
  assert.deepEqual(JSON.parse(calls[0].body), { model: "gpt-6-luna",
    messages: [{ role: "system", content: "合成" }, { role: "user", content: "合成の挨拶" }], max_completion_tokens: 100 });
  for (const policy of policies) assert.deepEqual(policy, { purpose: "dialogue_turn", provider: "openai", model: "gpt-6-luna", ready: true });
});

test("security: the service-binding entrypoint exposes chat and grounding only, never Decisions", async () => {
  const source = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const start = source.indexOf("export class InternalResearchProxy");
  assert.ok(start >= 0);
  const classBody = source.slice(start, source.indexOf("\n}\n", start));
  const methods = [...classBody.matchAll(/^ {2}(?:async\s+)?(?:static\s+)?([A-Za-z_$#][\w$]*)\s*\(/gm)].map((match) => match[1]);
  assert.deepEqual(methods, ["chat", "grounding"]);
  assert.match(classBody, /'\/v1\/chat\/completions'/);
  assert.match(classBody, /'\/v1\/grounding-evidence'/);
  assert.doesNotMatch(classBody, /decision|OPENROUTER/i);
  // The forwarder only accepts these two fixed paths.
  assert.match(source, /path: '\/v1\/chat\/completions' \| '\/v1\/grounding-evidence'/);
});

