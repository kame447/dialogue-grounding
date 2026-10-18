import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./index.mjs";
import { DECISION_ACTIONS, DECISION_MODELS, OPENROUTER_DECISIONS_URL } from "./decisions.mjs";

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
