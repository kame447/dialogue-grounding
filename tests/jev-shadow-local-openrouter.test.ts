// Temporary local OpenRouter diagnostic: mock fetch and mock Keychain only, no real key, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest as handleWorkerRequest } from "../workers/research-ai-proxy/src/index.mjs";
import { GROUNDING_LEVELS, GROUNDING_MODELS, OPENROUTER_DECISIONS_URL } from "../workers/research-ai-proxy/src/grounding.ts";
import { parseGroundingVerdict } from "../dialogue-model/runtime/grounding/client.ts";
import { buildGroundingEvidence } from "../dialogue-model/runtime/grounding/evidence.ts";
import { createLocalOpenRouterJudge, keychainKeyReader, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, LocalOpenRouterError } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/local-openrouter.ts";
import { main } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/run.ts";

const KEY = "sk-or-local-diagnostic-canary-key-000";
const TOKEN = "local-openrouter-proxy-token-at-least-32-chars";
const scores = <L extends string>(levels: readonly L[], chosen: L) =>
  Object.fromEntries(levels.map((level) => [level, level === chosen ? 0.7 : 0.075])) as Record<L, number>;
const upstreamBody = (cost: number | null = 0.0001, extra: Record<string, unknown> = {}) => ({
  model: GROUNDING_MODELS.grounding_jev + "-20261014", provider: "TypeSafe", id: "gen-local-synthetic",
  answers: {
    identification: { type: "choice", choice: "supported", probabilities: scores(GROUNDING_LEVELS.identification, "supported"), confidence: 0.7 },
    name_agreement: { type: "choice", choice: "no_name", probabilities: scores(GROUNDING_LEVELS.name_agreement, "no_name"), confidence: 0.6 },
  },
  usage: { input_tokens: 2500, output_tokens: 100, ...(cost === null ? {} : { cost }) },
  ...extra,
});
type Captured = { url: string; init: RequestInit };
const recorder = (respond: () => Response = () => Response.json(upstreamBody())) => {
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(); };
  return { calls, fetchImpl };
};
const readKey = async () => KEY;
const state = buildGroundingEvidence({ events: [{ seq: 1, speaker: "ai", text: "どれから？" }, { seq: 2, speaker: "human", text: "三角が上のやつ" }], asOfSeq: 2 }).state;

test("payload parity: the local request is byte-identical to what the proxy sends upstream, and the verdict matches", async () => {
  const proxy = recorder();
  const env = { RESEARCH_PROXY_TOKEN: TOKEN, RESEARCH_GROUNDING_ENABLED: "true", OPENROUTER_DECISIONS_API_KEY: KEY };
  const response = await handleWorkerRequest(new Request("https://proxy.test/v1/grounding-evidence", { method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "grounding_jev", state }) }),
    env as never, proxy.fetchImpl as never);
  assert.equal(response.status, 200);
  const local = recorder();
  const verdict = await createLocalOpenRouterJudge({ readKey, fetchImpl: local.fetchImpl }).judge({ purpose: "grounding_jev", state });
  assert.equal(local.calls.length, 1);
  assert.equal(local.calls[0].url, OPENROUTER_DECISIONS_URL);
  assert.equal(local.calls[0].url, proxy.calls[0].url);
  assert.equal(local.calls[0].init.body, proxy.calls[0].init.body, "same model, state, questions, instructions and criteria");
  assert.deepEqual(local.calls[0].init.headers, proxy.calls[0].init.headers);
  assert.equal(local.calls[0].init.method, "POST");
  const viaProxy = parseGroundingVerdict(await response.json(), "grounding_jev", 0);
  assert.deepEqual({ ...verdict, latencyMs: 0 }, viaProxy);
  assert.equal(verdict.criteriaVersion, "grounding-criteria/v2");
  assert.equal(verdict.nameAgreement.level, "no_name");
});

test("keychain reader: execFile without a shell, exact arguments, fails closed without leaking output", async () => {
  const seen: unknown[][] = [];
  const ok = keychainKeyReader(((file: string, args: readonly string[], options: unknown, cb: (e: Error | null, out: string) => void) => {
    seen.push([file, args, options]); cb(null, KEY + "\n"); }) as never);
  assert.equal(await ok(), KEY);
  assert.deepEqual(seen[0][0], "security");
  assert.deepEqual(seen[0][1], ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
  for (const [error, out] of [[null, "not-an-openrouter-key"], [new Error("security: item " + KEY), KEY], [null, ""]] as const) {
    const bad = keychainKeyReader(((_f: string, _a: unknown, _o: unknown, cb: (e: Error | null, out: string) => void) => cb(error, out)) as never);
    await assert.rejects(bad(), (e: unknown) => e instanceof LocalOpenRouterError && e.code === "key_unavailable" && !e.message.includes(KEY));
  }
});

test("key leak in a response aborts; error statuses map to codes without reading the body", async () => {
  const leaky = recorder(() => new Response(JSON.stringify(upstreamBody(0.0001, { note: KEY })), { status: 200 }));
  await assert.rejects(createLocalOpenRouterJudge({ readKey, fetchImpl: leaky.fetchImpl }).judge({ purpose: "grounding_jev", state }),
    (e: unknown) => e instanceof LocalOpenRouterError && e.code === "key_leak" && !e.message.includes(KEY));
  for (const [status, code] of [[401, "unauthorized"], [402, "payment_required"], [404, "not_found"], [429, "rate_limited"], [500, "upstream_error"]] as const) {
    let body: Response | null = null;
    const failing = recorder(() => (body = new Response("echo " + KEY, { status })));
    await assert.rejects(createLocalOpenRouterJudge({ readKey, fetchImpl: failing.fetchImpl }).judge({ purpose: "grounding_jev", state }),
      (e: unknown) => e instanceof LocalOpenRouterError && e.code === code);
    assert.equal(body!.bodyUsed, false, "error bodies are not read");
  }
  const malformed = recorder(() => Response.json({ model: "other/model", answers: {} }));
  await assert.rejects(createLocalOpenRouterJudge({ readKey, fetchImpl: malformed.fetchImpl }).judge({ purpose: "grounding_jev", state }), /invalid_response/);
  const v1 = recorder(() => Response.json({ ...upstreamBody(), answers: { ...upstreamBody().answers,
    name_agreement: { type: "choice", choice: "unclear", probabilities: { agreed: 0.1, unclear: 0.7, not_agreed: 0.1, unknown: 0.1 } } } }));
  await assert.rejects(createLocalOpenRouterJudge({ readKey, fetchImpl: v1.fetchImpl }).judge({ purpose: "grounding_jev", state }), /invalid_response/,
    "a 4-level (v1-shaped) answer is rejected");
});

test("cost cap: stops before a call that could exceed $0.05, and a missing cost fails closed", async () => {
  const pricey = recorder(() => Response.json(upstreamBody(0.03)));
  const judge = createLocalOpenRouterJudge({ readKey, fetchImpl: pricey.fetchImpl });
  await judge.judge({ purpose: "grounding_jev", state });
  await assert.rejects(judge.judge({ purpose: "grounding_jev", state }), /cost_cap/);
  assert.equal(pricey.calls.length, 1, "the second call is never sent");
  assert.equal(judge.spentUsd, 0.03);
  const silent = recorder(() => Response.json(upstreamBody(null)));
  await assert.rejects(createLocalOpenRouterJudge({ readKey, fetchImpl: silent.fetchImpl }).judge({ purpose: "grounding_jev", state }), /cost_unreported/);
  assert.throws(() => createLocalOpenRouterJudge({ readKey, costCapUsd: 0.06 }), /costCapUsd/);
});

const synthetic = (caseId: string, over: Record<string, unknown> = {}) => ({
  caseId, source: "synthetic", groupId: "SYN-" + caseId, split: "holdout", externalModelAllowed: true,
  history: [{ speaker: "self", text: "どれから？" }, { speaker: "partner", text: "三角が上のやつ" }], judgedTurnIndex: 1,
  expected: { target: "insufficient", name: "no_name" }, labelQuality: "derived", goldVersion: "synthetic-gold/v3", ...over });

test("CLI: opt-in, synthetic-only, call cap, stop codes, private 0700/0600 output with no key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-local-"));
  const casesPath = join(dir, "cases.jsonl");
  writeFileSync(casesPath, [synthetic("a"), synthetic("b"), synthetic("c")].map((c) => JSON.stringify(c)).join("\n") + "\n");
  const out = join(dir, "out");
  const ok = recorder();
  const lines: string[] = [];
  const run = await main(["--cases", casesPath, "--out", out, "--client", "local-openrouter", "--max-calls", "2"], (l) => lines.push(l), { readKey, fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls.length, 2, "the call cap holds");
  assert.equal(run.meta.client, "local-openrouter");
  assert.equal(run.meta.stopped, "budget_exhausted");
  assert.deepEqual(run.meta.criteriaVersions, ["grounding-criteria/v2"]);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  for (const f of readdirSync(out)) {
    assert.equal(statSync(join(out, f)).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(out, f), "utf8").includes(KEY));
  }
  assert.ok(!lines.join("").includes(KEY));
  const argv = (extra: string[]) => ["--cases", casesPath, "--out", join(dir, "o2"), "--client", "local-openrouter", ...extra];
  const never = async () => { throw new Error("must not call"); };
  await assert.rejects(main(argv(["--max-calls", "52"]), () => {}, { readKey, fetchImpl: never }), /between 1 and 51/);
  await assert.rejects(main(argv([]), () => {}, { readKey, fetchImpl: never }), /between 1 and 51/);
  await assert.rejects(main(argv(["--max-calls", "5", "--cost-cap-usd", "0.06"]), () => {}, { readKey, fetchImpl: never }), /cost-cap-usd/);
  const capped = recorder(() => Response.json(upstreamBody(0.004)));
  const small = await main(argv(["--max-calls", "3", "--cost-cap-usd", "0.005"]), () => {}, { readKey, fetchImpl: capped.fetchImpl });
  assert.equal(capped.calls.length, 1, "a per-invocation cap below $0.05 is honoured");
  assert.equal(small.meta.stopped, "cost_cap");
  await assert.rejects(main([...argv(["--max-calls", "5"]), "--record", casesPath], () => {}, { readKey, fetchImpl: never }), /synthetic --cases only/);
  for (const bad of [synthetic("h", { source: "historical" }), synthetic("ai", { source: "ai_session" }), synthetic("x", { externalModelAllowed: false })]) {
    const p = join(dir, "bad.jsonl");
    writeFileSync(p, JSON.stringify(synthetic("a")) + "\n" + JSON.stringify(bad) + "\n");
    await assert.rejects(main(["--cases", p, "--out", join(dir, "o3"), "--client", "local-openrouter", "--max-calls", "5"], () => {}, { readKey, fetchImpl: never }), /refuses the file/);
  }
  const unauthorized = recorder(() => new Response("", { status: 401 }));
  const stopped = await main(["--cases", casesPath, "--out", join(dir, "o4"), "--client", "local-openrouter", "--max-calls", "3"], () => {}, { readKey, fetchImpl: unauthorized.fetchImpl });
  assert.equal(unauthorized.calls.length, 1, "401 stops the run");
  assert.equal(stopped.meta.stopped, "unauthorized");
  await assert.rejects(main(["--cases", casesPath, "--out", "dialogue-model/tmp-local", "--client", "local-openrouter", "--max-calls", "1"], () => {}, { readKey, fetchImpl: never }), /repository_output_forbidden/);
});
