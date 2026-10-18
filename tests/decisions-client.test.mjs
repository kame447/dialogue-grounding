import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionComparisonClient, DecisionConnectionError } from "../dialogue-model/runtime/decisions-client.mjs";
import { DECISION_ACTIONS } from "../workers/research-ai-proxy/src/decisions.mjs";

const config = Object.freeze({
  provider: "cloudflare", baseUrl: "https://research.example/v1",
  apiKey: "test-only-proxy-token-not-an-openrouter-key",
});
const probabilities = Object.fromEntries(
  DECISION_ACTIONS.map((action) => [action, action === "accept" ? 0.84 : 0.02])
);

test("Decision comparison client routes through research Worker, never direct OpenRouter", async () => {
  const seen = [];
  const client = createDecisionComparisonClient(config, async (url, init) => {
    seen.push({ url, init });
    const purpose = JSON.parse(init.body).purpose;
    const model = purpose === "decision_jev" ? "typesafe/jev-1.14-20261014" : "openai/gpt-6-luna-decisions";
    return Response.json({ purpose, model, action: "accept", probabilities, usage: { inputTokens: 52, costUsd: 0.000002 } });
  });
  const state = "人間は鳥の見立てだけを提示。対象は不明。";
  const a = await client.chooseAction({ purpose: "decision_jev", state });
  const b = await client.chooseAction({ purpose: "decision_luna", state });
  assert.equal(a.action, "accept");
  assert.equal(b.action, "accept");
  assert.deepEqual(seen.map((item) => item.url),
    ["https://research.example/v1/decisions", "https://research.example/v1/decisions"]);
  assert.deepEqual(seen.map((item) => JSON.parse(item.init.body).state), [state, state]);
  assert.equal(seen[0].init.headers.Authorization, "Bearer " + config.apiKey);
});

test("Comparison client refuses invalid purpose and malformed provider responses", async () => {
  const client = createDecisionComparisonClient(config, async () =>
    Response.json({ purpose: "decision_jev", model: "other-model", action: "accept", probabilities }));
  await assert.rejects(client.chooseAction({ purpose: "custom", state: "test" }),
    (error) => error instanceof DecisionConnectionError && error.code === "invalid_request");
  await assert.rejects(client.chooseAction({ purpose: "decision_jev", state: "test" }),
    (error) => error instanceof DecisionConnectionError && error.code === "invalid_response");
  assert.throws(() => createDecisionComparisonClient({ ...config, provider: "custom" }),
    (error) => error.code === "invalid_config");
});

test("Comparison client never retries an uncertain, billable POST", async () => {
  let count = 0;
  const client = createDecisionComparisonClient(config, async () => {
    count++;
    throw new Error("private upstream response");
  });
  await assert.rejects(client.chooseAction({ purpose: "decision_jev", state: "test" }),
    (error) => error.code === "network_error" && !error.message.includes("private"));
  assert.equal(count, 1);
});
