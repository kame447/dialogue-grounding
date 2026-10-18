// Two-axis grounding-evidence route: synthetic fixtures only, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest as handleWorkerRequest } from "../workers/research-ai-proxy/src/index.mjs";
import { GROUNDING_LEVELS, GROUNDING_MODELS, IDENTIFICATION_CRITERIA, NAME_AGREEMENT_CRITERIA, OPENROUTER_DECISIONS_URL,
  buildGroundingPayload, sanitizeGroundingVerdict } from "../workers/research-ai-proxy/src/grounding.ts";
import { createGroundingJudgeClient, GroundingConnectionError } from "../dialogue-model/runtime/grounding/client.ts";

type Upstream = (url: string, init: RequestInit) => Promise<Response>;
const handleRequest = (request: Request, workerEnv: Record<string, unknown>, upstreamFetch?: Upstream): Promise<Response> =>
  handleWorkerRequest(request, workerEnv as never, upstreamFetch as never);

const TOKEN = "grounding-proxy-token-at-least-thirty-two-characters";
const KEY = "sk-or-grounding-canary-openrouter-key";
const CHAT_KEY = "grounding-canary-chat-upstream-key";
const env = { RESEARCH_PROXY_TOKEN: TOKEN, RESEARCH_GROUNDING_ENABLED: "true", RESEARCH_DECISIONS_ENABLED: "false",
  OPENROUTER_DECISIONS_API_KEY: KEY, UPSTREAM_PROVIDER: "openai", DIALOGUE_MODEL: "gpt-6-luna", UPSTREAM_API_KEY: CHAT_KEY };
const scores = <L extends string>(levels: readonly L[], chosen: L) =>
  Object.fromEntries(levels.map((level) => [level, level === chosen ? 0.7 : 0.1])) as Record<L, number>;
const upstream = (patch: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) => ({
  model: GROUNDING_MODELS.grounding_jev + "-20261014", provider: "TypeSafe", id: "gen-synthetic-grounding",
  answers: {
    identification: { type: "choice", choice: "insufficient", probabilities: scores(GROUNDING_LEVELS.identification, "insufficient"), confidence: 0.7 },
    name_agreement: { type: "choice", choice: "unclear", probabilities: scores(GROUNDING_LEVELS.name_agreement, "unclear"), confidence: 0.6 },
    ...answers,
  },
  usage: { input_tokens: 900, output_tokens: 2, cost: 0.00004 },
  ...patch,
});
const body = { purpose: "grounding_jev", state: "合成の公開対話: 相手「鳥っぽいのから」" };
const request = (path = "/v1/grounding-evidence", { method = "POST", bearer = TOKEN as string | null, payload = body as unknown } = {}) =>
  new Request("https://grounding.test" + path, { method,
    headers: { ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}) });
async function safeText(response: Response) {
  const text = await response.text();
  for (const secret of [TOKEN, KEY, CHAT_KEY]) assert.ok(!text.includes(secret));
  return text;
}
const never = () => { throw new Error("upstream must not be called"); };

test("grounding route is off by default and has its own flag, separate from Decisions", async () => {
  for (const [patch, error] of [[{ RESEARCH_GROUNDING_ENABLED: undefined }, "grounding_disabled"],
    [{ RESEARCH_GROUNDING_ENABLED: "false", RESEARCH_DECISIONS_ENABLED: "true" }, "grounding_disabled"],
    [{ RESEARCH_GROUNDING_ENABLED: "1" }, "grounding_disabled"],
    [{ OPENROUTER_DECISIONS_API_KEY: undefined }, "grounding_unconfigured"],
    [{ OPENROUTER_DECISIONS_API_KEY: CHAT_KEY }, "grounding_unconfigured"]] as const) {
    const response = await handleRequest(request(), { ...env, ...patch }, never);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(await safeText(response)), { error });
  }
  // Enabling grounding does not enable the Decisions action route.
  const decisions = await handleRequest(request("/v1/decisions", { payload: { purpose: "decision_jev", state: "合成" } }), env, never);
  assert.equal(decisions.status, 503);
  const policy = await handleRequest(request("/v1/grounding-policy", { method: "GET" }), { ...env, RESEARCH_GROUNDING_ENABLED: undefined });
  assert.equal(JSON.parse(await safeText(policy)).ready, false);
});

test("grounding route and policy require the proxy token and enforce method", async () => {
  for (const bearer of [null, "wrong-token-at-least-thirty-two-characters-long", KEY]) {
    for (const [path, method] of [["/v1/grounding-evidence", "POST"], ["/v1/grounding-policy", "GET"]]) {
      const response = await handleRequest(request(path, { method, bearer }), env, never);
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(await safeText(response)), { error: "unauthorized" });
    }
  }
  assert.equal((await handleRequest(request("/v1/grounding-evidence", { method: "GET" }), env, never)).status, 405);
  assert.equal((await handleRequest(request("/v1/grounding-policy", { method: "POST" }), env, never)).status, 405);
  const policy = await handleRequest(request("/v1/grounding-policy", { method: "GET" }), env);
  assert.deepEqual(JSON.parse(await safeText(policy)), { ready: true, enabled: true, models: GROUNDING_MODELS,
    levels: { identification: ["supported", "insufficient", "contradicted", "unknown"], name_agreement: ["agreed", "unclear", "not_agreed", "unknown"] },
    textOnly: true });
});

test("one upstream call carries both closed-set questions with server-owned model, URL and criteria", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const response = await handleRequest(request(), env, async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Response.json(upstream());
  });
  assert.equal(response.status, 200);
  const data = JSON.parse(await safeText(response));
  assert.deepEqual(Object.keys(data).sort(), ["id", "identification", "model", "nameAgreement", "provider", "purpose", "usage"]);
  assert.equal(data.identification.level, "insufficient");
  assert.equal(data.nameAgreement.level, "unclear");
  assert.equal(data.usage.costUsd, 0.00004);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, OPENROUTER_DECISIONS_URL);
  assert.deepEqual(seen[0].init.headers, { "Content-Type": "application/json", Authorization: "Bearer " + KEY });
  const payload = JSON.parse(String(seen[0].init.body));
  assert.deepEqual(Object.keys(payload), ["model", "state", "questions"]);
  assert.equal(payload.model, "typesafe/jev-1.14");
  assert.equal(payload.state, body.state);
  assert.deepEqual(Object.keys(payload.questions), ["identification", "name_agreement"]);
  assert.deepEqual(payload.questions.identification.criteria, IDENTIFICATION_CRITERIA);
  assert.deepEqual(payload.questions.name_agreement.criteria, NAME_AGREEMENT_CRITERIA);
  for (const question of Object.values(payload.questions) as { type: string; instructions: string }[]) {
    assert.equal(question.type, "choice");
    assert.match(question.instructions, /未検証の仮説/);
    assert.match(question.instructions, /aiOwnNotes・aiPriorActsOnTarget・aiMemory も、AI側の非公開の作業メモや解釈の記録であり、証拠ではありません/);
    assert.match(question.instructions, /unknown/);
  }
  assert.ok(!String(seen[0].init.body).includes(TOKEN) && !String(seen[0].init.body).includes(CHAT_KEY));
});

test("grounding requests cannot choose the model, questions or levels", async () => {
  for (const payload of [{ ...body, model: "other/model" }, { ...body, questions: {} }, { ...body, levels: ["agreed"] },
    { purpose: "decision_jev", state: "合成" }, { purpose: "grounding_luna", state: "合成" }, { purpose: "grounding_jev", state: " " },
    { purpose: "grounding_jev", state: "x".repeat(20_001) }, { purpose: "grounding_jev", state: { answerKey: "secret" } }, null, []]) {
    assert.equal(buildGroundingPayload(payload), null);
    const response = await handleRequest(request("/v1/grounding-evidence", { payload }), env, never);
    assert.equal(response.status, 400);
  }
});

test("out-of-set or incomplete axis answers are rejected (fail closed)", async () => {
  const id = GROUNDING_LEVELS.identification, name = GROUNDING_LEVELS.name_agreement;
  const bad = [
    upstream({ model: "other/model" }),
    upstream({ model: "typesafe/jev-1.14-forged" }),
    upstream({ model: KEY }),
    upstream({ answers: { identification: upstream().answers.identification } }),
    upstream({}, { identification: { type: "choice", choice: "probably", probabilities: scores(id, "supported") } }),
    upstream({}, { identification: { type: "choice", choice: "correct", probabilities: { ...scores(id, "supported"), correct: 0.9 } } }),
    upstream({}, { name_agreement: { type: "choice", choice: "agreed", probabilities: { agreed: 1 } } }),
    upstream({}, { name_agreement: { type: "choice", choice: "agreed", probabilities: { ...scores(name, "agreed"), agreed: 1.5 } } }),
    upstream({}, { name_agreement: { type: "score", choice: "agreed", probabilities: scores(name, "agreed") } }),
    upstream({}, { name_agreement: { type: "choice", choice: "agreed", probabilities: scores(name, "agreed"), confidence: KEY } }),
    upstream({}, { identification: { type: "choice", choice: "supported", probabilities: { ...scores(id, "supported"), unknown: Number.NaN } } }),
    { answers: null },
  ];
  for (const result of bad) {
    const response = await handleRequest(request(), env, async () => Response.json(result));
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(await safeText(response)), { error: "invalid_upstream_response" });
  }
  assert.equal(sanitizeGroundingVerdict(upstream({ provider: KEY, id: "gen-" + KEY }), "typesafe/jev-1.14", "grounding_jev")?.provider, null);
});

test("upstream errors and timeouts map to fixed codes without bodies", async (t) => {
  for (const [status, expected] of [[402, 402], [429, 429], [500, 502]]) {
    const response = await handleRequest(request(), env, async () => new Response(KEY + TOKEN, { status }));
    assert.equal(response.status, expected);
    await safeText(response);
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const pending = handleRequest(request(), env, (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    signal = init.signal ?? undefined;
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  while (!signal) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  assert.equal((await pending).status, 504);
});

test("client end to end: verdict through the Worker; 404/503/invalid/timeout/abort become codes", async (t) => {
  const config = { provider: "cloudflare", baseUrl: "https://grounding.test/v1", apiKey: TOKEN };
  const through = (fetchUpstream: (url: string, init: RequestInit) => Promise<Response>, workerEnv: Record<string, unknown> = env) =>
    createGroundingJudgeClient(config, async (url, init) => handleRequest(new Request(url, init), workerEnv, fetchUpstream));
  const verdict = await through(async () => Response.json(upstream())).judge(body as { purpose: "grounding_jev"; state: string });
  assert.equal(verdict.identification.level, "insufficient");
  assert.equal(verdict.nameAgreement.level, "unclear");
  assert.equal(verdict.usage?.costUsd, 0.00004);
  assert.ok(verdict.latencyMs >= 0);
  assert.ok(!JSON.stringify(verdict).includes(KEY));

  const code = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { assert.ok(error instanceof GroundingConnectionError); return (error as GroundingConnectionError).code; }
    return "resolved";
  };
  const live404 = createGroundingJudgeClient(config, async () => Response.json({ error: "not_found" }, { status: 404 }));
  assert.equal(await code(live404.judge(body as never)), "not_found");
  assert.equal(await code(through(never as never, { ...env, RESEARCH_GROUNDING_ENABLED: "false" }).judge(body as never)), "disabled");
  const forged = createGroundingJudgeClient(config, async () => Response.json({ purpose: "grounding_jev", model: "typesafe/jev-1.14",
    identification: { level: "correct", scores: {}, confidence: null }, nameAgreement: { level: "agreed", scores: {}, confidence: null } }));
  assert.equal(await code(forged.judge(body as never)), "invalid_response");
  assert.equal(await code(live404.judge({ purpose: "grounding_jev", state: "" })), "invalid_request");
  assert.equal(await code(live404.judge(body as never, { timeoutMs: 0 })), "invalid_request");
  assert.throws(() => createGroundingJudgeClient({ ...config, provider: "openai" }), GroundingConnectionError);

  const hanging = createGroundingJudgeClient(config, (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const controller = new AbortController();
  const aborted = code(hanging.judge(body as never, { signal: controller.signal }));
  controller.abort();
  assert.equal(await aborted, "aborted");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timed = code(hanging.judge(body as never, { timeoutMs: 50 }));
  t.mock.timers.tick(50);
  assert.equal(await timed, "timeout");
});
