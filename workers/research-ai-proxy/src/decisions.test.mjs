import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./index.mjs";
import { DECISION_ACTIONS, DECISION_MODELS, OPENROUTER_DECISIONS_URL, sanitizeDecision } from "./decisions.mjs";
import { createDecisionComparisonClient } from "../../../dialogue-model/runtime/decisions-client.mjs";

const TOKEN = "local-authentication-token-longer-than-thirty-two-characters";
const env = {
  RESEARCH_PROXY_TOKEN: TOKEN,
  UPSTREAM_PROVIDER: "openai",
  UPSTREAM_API_KEY: "existing-luna-key-not-to-be-forwarded",
  DIALOGUE_MODEL: "gpt-6-luna",
  RESEARCH_DECISIONS_ENABLED: "true",
  OPENROUTER_DECISIONS_API_KEY: "sk-or-fake-research-unit-test-only",
};
const probabilities = Object.fromEntries(
  DECISION_ACTIONS.map((action) => [action, action === "accept" ? 0.84 : 0.02])
);

const req = (path, body, bearer = TOKEN, method = "POST") => new Request("https://research.test" + path, {
  method,
  headers: {
    ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
    ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
  },
  ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});

const upstreamResult = (model) => ({
  model: model === DECISION_MODELS.decision_jev ? model + "-20261014" : model,
  answers: { action: { type: "choice", choice: "accept", probabilities, confidence: 0.95 } },
  usage: { input_tokens: 98, output_tokens: 0, cost: 0.000004 },
});

test("Decisions are opt-in and a distinct secret is mandatory", async () => {
  let count = 0;
  const upstream = async () => { count++; throw new Error("should not be called"); };
  const body = { purpose: "decision_jev", state: "公開発話に曖昧さが残る" };
  assert.equal((await handleRequest(req("/v1/decisions", body), { ...env, RESEARCH_DECISIONS_ENABLED: "false" }, upstream)).status, 503);
  assert.equal((await handleRequest(req("/v1/decisions", body), { ...env, OPENROUTER_DECISIONS_API_KEY: "" }, upstream)).status, 503);
  assert.equal((await handleRequest(req("/v1/decisions", body, "incorrect-token"), env, upstream)).status, 401);
  assert.equal(count, 0);
});

test("Both models share identical server-owned questions, separate key and correct OpenRouter endpoint", async () => {
  const forwarded = [];
  for (const purpose of Object.keys(DECISION_MODELS)) {
    const res = await handleRequest(req("/v1/decisions", {
      purpose, state: "相手は鳥っぽいと言ったが図形の対応がまだ特定できていない。",
    }), env, async (url, init) => {
      forwarded.push({ url, init, payload: JSON.parse(init.body) });
      return Response.json(upstreamResult(DECISION_MODELS[purpose]));
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.purpose, purpose);
    assert.equal(data.action, "accept");
    assert.equal(data.probabilities.accept, 0.84);
    assert.equal(data.usage.costUsd, 0.000004);
    assert.equal(data.usage.inputTokens, 98);
    assert.doesNotMatch(JSON.stringify(data), /key-not-to-be-forwarded|fake-research/);
  }
  assert.deepEqual(forwarded.map(({ url }) => url), [OPENROUTER_DECISIONS_URL, OPENROUTER_DECISIONS_URL]);
  assert.equal(forwarded[0].init.headers.Authorization, "Bearer " + env.OPENROUTER_DECISIONS_API_KEY);
  assert.equal(forwarded[1].init.headers.Authorization, "Bearer " + env.OPENROUTER_DECISIONS_API_KEY);
  assert.deepEqual(forwarded.map(({ payload }) => payload.model), Object.values(DECISION_MODELS));
  assert.deepEqual(forwarded[0].payload.questions, forwarded[1].payload.questions);
  assert.deepEqual(Object.keys(forwarded[0].payload), ["model", "state", "questions"]);
  assert.deepEqual(Object.keys(forwarded[0].payload.questions.action.criteria), DECISION_ACTIONS);
});

test("Decisions never forward client-selected models, arbitrary questions or images", async () => {
  const badBodies = [
    { purpose: "decision_jev", state: "hello", model: "other-model" },
    { purpose: "decision_jev", state: "hello", questions: { action: {} } },
    { purpose: "dialogue_turn", state: "hello" },
    { purpose: "decision_luna", state: ["text", { type: "image_url", image_url: { url: "http://localhost/" } }] },
    { purpose: "decision_luna", state: "x".repeat(20_001) },
    { purpose: "decision_luna", state: " " },
    { purpose: "decision_luna", state: { hiddenTruth: "must-not-send" } },
  ];
  let calls = 0;
  const upstream = async () => { calls++; return Response.json(upstreamResult(DECISION_MODELS.decision_jev)); };
  for (const body of badBodies) {
    assert.equal((await handleRequest(req("/v1/decisions", body), env, upstream)).status, 400);
  }
  assert.equal(calls, 0);
});

test("Decision policy is authenticated, read-only and separate from the Luna chat policy", async () => {
  const policy = await handleRequest(req("/v1/decision-policy", null, TOKEN, "GET"), env);
  assert.equal(policy.status, 200);
  assert.deepEqual(await policy.json(), {
    ready: true, enabled: true, models: DECISION_MODELS, textOnly: true,
  });
  const disabled = await handleRequest(req("/v1/decision-policy", null, TOKEN, "GET"),
    { ...env, RESEARCH_DECISIONS_ENABLED: "false" });
  assert.equal((await disabled.json()).ready, false);
  assert.equal((await handleRequest(req("/v1/decision-policy", null, null, "GET"), env)).status, 401);
  const old = await handleRequest(req("/v1/model-policy", null, TOKEN, "GET"), env);
  assert.equal((await old.json()).model, "gpt-6-luna");
});

test("Invalid, misrouted and sensitive upstream results fail closed", async () => {
  const body = { purpose: "decision_jev", state: "同定はまだできていない" };
  for (const bad of [
    { ...upstreamResult(DECISION_MODELS.decision_jev), model: "other/model" },
    { ...upstreamResult(DECISION_MODELS.decision_jev), model: "typesafe/jev-1.14-forged" },
    { ...upstreamResult(DECISION_MODELS.decision_jev), answers: { action: { type: "choice", choice: "invent_name", probabilities } } },
    { ...upstreamResult(DECISION_MODELS.decision_jev), answers: { action: { type: "choice", choice: "accept", probabilities: { accept: 1 } } } },
    { ...upstreamResult(DECISION_MODELS.decision_jev), answers: { action: { type: "choice", choice: "accept", probabilities: { ...probabilities, agree: 9 } } } },
  ]) {
    const r = await handleRequest(req("/v1/decisions", body), env, async () => Response.json(bad));
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: "invalid_upstream_response" });
  }
  const rate = await handleRequest(req("/v1/decisions", body), env,
    async () => new Response("do not echo secrets", { status: 429 }));
  assert.equal(rate.status, 429);
  assert.doesNotMatch(await rate.text(), /do not echo secrets/);
  const fail = await handleRequest(req("/v1/decisions", body), env,
    async () => { throw new Error("sensitive network exception"); });
  assert.equal(fail.status, 502);
  assert.doesNotMatch(await fail.text(), /sensitive/);
});

test("Decision payment and rate limits keep their HTTP codes and never expose upstream secrets", async () => {
  for (const [status, error] of [[402, "upstream_payment_required"], [429, "upstream_rate_limited"], [500, "upstream_error"]]) {
    const response = await handleRequest(req("/v1/decisions", { purpose: "decision_jev", state: "公開発話" }), env,
      async () => new Response(env.OPENROUTER_DECISIONS_API_KEY + env.UPSTREAM_API_KEY + TOKEN, { status }));
    assert.equal(response.status, status === 500 ? 502 : status);
    assert.deepEqual(await response.json(), { error });
  }
});

test("non-JSON and invalid Decision bodies map to invalid_upstream_response without echoing secrets", async () => {
  for (const response of [new Response("<html>" + env.OPENROUTER_DECISIONS_API_KEY + "</html>"), Response.json({ key: env.UPSTREAM_API_KEY }), Response.json(null)]) {
    const result = await handleRequest(req("/v1/decisions", { purpose: "decision_luna", state: "公開発話" }), env, async () => response);
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: "invalid_upstream_response" });
  }
});

test("synthetic Jev/Luna sample shapes preserve billed output tokens and bounded metadata end to end", async () => {
  for (const purpose of Object.keys(DECISION_MODELS)) {
    const result = { ...upstreamResult(DECISION_MODELS[purpose]),
      model: DECISION_MODELS[purpose] + (purpose === "decision_jev" ? "-20261014" : "-20261006"),
      provider: purpose === "decision_jev" ? "TypeSafe" : "OpenAI", id: "gen-synthetic-request-id", usage: { input_tokens: 98, output_tokens: 86, cost: 0.000004 } };
    if (purpose === "decision_jev") result.answers.action.probabilities = Object.fromEntries(DECISION_ACTIONS.map((action) => [action, action === "accept" ? 1 : 0]));
    const client = createDecisionComparisonClient({ provider: "cloudflare", baseUrl: "https://research.test/v1", apiKey: TOKEN },
      async (url, init) => handleRequest(new Request(url, init), env, async () => Response.json(result)));
    const data = await client.chooseAction({ purpose, state: "公開発話" });
    assert.equal(data.action, "accept");
    assert.equal(data.probabilities.accept, purpose === "decision_jev" ? 1 : 0.84);
    assert.equal(data.usage.outputTokens, 86);
    assert.equal(data.provider, result.provider);
    assert.equal(data.id, "gen-synthetic-request-id");
    assert.doesNotMatch(JSON.stringify(data), /sk-or-|key-not-to-be-forwarded|local-authentication/);
  }
});

test("Decision optional metadata is bounded and invalid usage numbers become null", async () => {
  const bodies = [
    { provider: "p".repeat(64), id: "gen-" + "i".repeat(124), usage: { output_tokens: 0 } },
    { provider: "p".repeat(65), id: "gen-" + "i".repeat(125), usage: { output_tokens: -1 } },
    { provider: 10, id: {}, usage: { output_tokens: "86" } },
  ];
  for (let index = 0; index < bodies.length; index++) {
    const response = await handleRequest(req("/v1/decisions", { purpose: "decision_jev", state: "公開発話" }), env,
      async () => Response.json({ ...upstreamResult(DECISION_MODELS.decision_jev), ...bodies[index] }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.provider, index === 0 ? bodies[index].provider : null);
    assert.equal(data.id, index === 0 ? bodies[index].id : null);
    assert.equal(data.usage.outputTokens, index === 0 ? 0 : null);
  }
});

test("metadata shape and key-like text filters keep secrets out of provider/id", () => {
  const model = DECISION_MODELS.decision_jev;
  for (const field of ["provider", "id"]) {
    const malformed = field === "provider" ? ["1Provider", "Provider\n"] : ["gen-", "foreign-id", "gen-id\n"];
    for (const value of [env.OPENROUTER_DECISIONS_API_KEY, "SK-or-synthetic-secret", "gen-Sk-or-synthetic-secret", "TypeSafe sk-secret", "", "provider/foreign", null, 1, ...malformed]) {
      const data = sanitizeDecision({ ...upstreamResult(model), [field]: value }, model, "decision_jev");
      assert.equal(data[field], null);
      assert.doesNotMatch(JSON.stringify(data), /sk-or-|sk-secret/i);
    }
  }
  for (const provider of ["TypeSafe", "OpenAI", "Provider_Name-1.0"]) {
    const data = sanitizeDecision({ ...upstreamResult(model), provider, id: "gen-synthetic_123-abc" }, model, "decision_jev");
    assert.equal(data.provider, provider);
    assert.equal(data.id, "gen-synthetic_123-abc");
  }
});

test("upstream secret reflected in provider, id or model never reaches the response body", async () => {
  for (const field of ["provider", "id", "model"]) {
    const result = await handleRequest(req("/v1/decisions", { purpose: "decision_jev", state: "公開発話" }), env,
      async () => Response.json({ ...upstreamResult(DECISION_MODELS.decision_jev), [field]: env.OPENROUTER_DECISIONS_API_KEY }));
    const text = await result.text();
    assert.ok(!text.includes(env.OPENROUTER_DECISIONS_API_KEY));
    if (field === "model") {
      assert.equal(result.status, 502);
      assert.deepEqual(JSON.parse(text), { error: "invalid_upstream_response" });
    } else {
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(text)[field], null);
    }
  }
});

test("Worker scans the whole sanitized response as a second secret-reflection barrier", async () => {
  // Simulate a credential change while upstream is in flight. The response
  // guard must reject the configured value even if metadata syntax permits it.
  const reflectiveEnv = { ...env };
  const response = await handleRequest(req("/v1/decisions", { purpose: "decision_jev", state: "公開発話" }), reflectiveEnv,
    async () => {
      reflectiveEnv.OPENROUTER_DECISIONS_API_KEY = "TypeSafe";
      return Response.json({ ...upstreamResult(DECISION_MODELS.decision_jev), provider: "TypeSafe", id: "gen-safe" });
    });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "invalid_upstream_response" });
});
