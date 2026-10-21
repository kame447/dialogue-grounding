// Synthetic responses and injected credentials only. No live API or Keychain.
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextLoop } from "node:timers/promises";
import { createJevChoiceTransport, createJevLocalTestClassifier, JevLocalTestError, JEV_LOCAL_TEST_MODEL } from "../dialogue-model/runtime/local-grounding/jev-local-test.ts";
import type { JevChoiceInput, JevChoiceTransportOptions } from "../dialogue-model/runtime/local-grounding/jev-local-test.ts";
import { OPENROUTER_DECISIONS_URL } from "../workers/research-ai-proxy/src/grounding.ts";

const KEY = "sk-or-SYNTHETIC-choice-transport-key-0000";
const input: JevChoiceInput = { state: JSON.stringify({ candidateText: "synthetic public text" }), questions: {
  support: { type: "choice", instructions: "synthetic question", criteria: { expressed: "yes", unclear: "unknown" } },
} };
const answers = { support: { type: "choice", choice: "expressed", probabilities: { expressed: 0.75, unclear: 0.25 }, confidence: 0.8 } };
const response = (cost: number | null = 0.01, model = JEV_LOCAL_TEST_MODEL) => Response.json({
  model, id: "gen-choice-test", answers, usage: cost === null ? {} : { cost },
});
const code = (wanted: string) => (error: unknown) => error instanceof JevLocalTestError && error.code === wanted;
const options = (extra: JevChoiceTransportOptions = {}) => ({ readKey: async () => KEY, ...extra });

test("legacy builder failure still records evidence immediately, before the returned promise settles", async () => {
  let reads = 0;
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey: async () => { reads++; return KEY; },
    fetchImpl: async () => { throw new Error("must not fetch"); } })!;
  const rejected = classifier.classify(null as never);
  assert.equal(classifier.lastEvidence?.error, "invalid_request");
  assert.equal(classifier.lastEvidence?.callIndex, 1); assert.deepEqual(classifier.lastEvidence?.choices, []);
  await assert.rejects(rejected, code("invalid_request"));
  assert.equal(reads, 0);
});

test("choice transport fixes model/URL, preserves raw scores, and keeps evidence detached and closed", async () => {
  let reads = 0, calls = 0;
  const transport = createJevChoiceTransport(options({ readKey: async () => { reads++; return KEY; }, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, OPENROUTER_DECISIONS_URL); assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer " + KEY);
    assert.deepEqual(JSON.parse(init.body as string), { model: JEV_LOCAL_TEST_MODEL, ...input });
    return response();
  } }));
  const initialEvidence = transport.lastEvidence;
  assert.equal(reads, 0); assert.equal(initialEvidence, null);
  const raw = await transport.request({ ...input, model: "untrusted-model", url: "https://untrusted.invalid" } as JevChoiceInput);
  assert.deepEqual(raw, answers);
  assert.equal(reads, 1); assert.equal(calls, 1);
  assert.deepEqual(Object.keys(transport.lastEvidence!), ["callIndex", "status", "model", "responseId", "latencyMs", "costUsd", "error"]);
  const evidence = transport.lastEvidence!;
  assert.equal(evidence.status, "ok"); assert.equal(evidence.model, JEV_LOCAL_TEST_MODEL);
  assert.equal(evidence.responseId, "gen-choice-test"); assert.equal(evidence.costUsd, 0.01);
  assert.equal(evidence.error, null); assert.equal(transport.spentUsd, 0.01);
  evidence.model = "mutated";
  assert.equal(transport.lastEvidence?.model, JEV_LOCAL_TEST_MODEL);
});

test("adapter parser failure keeps billed cost, clears success evidence, and cannot bypass the next-call cap", async () => {
  let calls = 0, parsed = 0;
  const transport = createJevChoiceTransport(options({ fetchImpl: async () => { calls++; return response(0.02); } }));
  await assert.rejects(transport.request(input, {}, () => { parsed++; throw new Error("RAW_PARSER_CANARY " + KEY); }), code("invalid_response"));
  assert.equal(transport.spentUsd, 0.02);
  assert.equal(transport.lastEvidence?.status, "error"); assert.equal(transport.lastEvidence?.error, "invalid_response");
  assert.equal(transport.lastEvidence?.costUsd, 0.02); assert.equal(transport.lastEvidence?.model, JEV_LOCAL_TEST_MODEL);
  assert.doesNotMatch(JSON.stringify(transport.lastEvidence), /CANARY|SYNTHETIC|answers|probabilities/);
  const parsedResult = await transport.request(input, {}, raw => { parsed++; assert.deepEqual(raw, answers); return { rawScore: 0.75 }; });
  assert.deepEqual(parsedResult, { rawScore: 0.75 }); assert.equal(transport.spentUsd, 0.04);
  await assert.rejects(transport.request(input), code("cost_cap"));
  assert.equal(calls, 2); assert.equal(parsed, 2); assert.equal(transport.callCount, 3);
  assert.equal(transport.lastEvidence?.model, null); assert.equal(transport.lastEvidence?.costUsd, null);
});

test("model mismatch retains observed cost and prevents the adapter parser from running", async () => {
  let calls = 0, parses = 0;
  const transport = createJevChoiceTransport(options({ fetchImpl: async () => { calls++; return response(0.03, "typesafe/jev-1.13"); } }));
  await assert.rejects(transport.request(input, {}, () => { parses++; return "must not parse"; }), code("model_mismatch"));
  assert.equal(transport.spentUsd, 0.03); assert.equal(transport.lastEvidence?.costUsd, 0.03);
  assert.equal(transport.lastEvidence?.status, "error"); assert.equal(transport.lastEvidence?.model, null);
  assert.equal(transport.lastEvidence?.responseId, null);
  await assert.rejects(transport.request(input), code("cost_cap"));
  assert.equal(calls, 1); assert.equal(parses, 0);
});

test("unknown billable cost halts only its transport instance; an independent instance retains its own evidence", async () => {
  let failedCalls = 0, goodCalls = 0;
  const failed = createJevChoiceTransport(options({ fetchImpl: async () => { failedCalls++; return response(null); } }));
  const good = createJevChoiceTransport(options({ fetchImpl: async () => { goodCalls++; return response(0.01, JEV_LOCAL_TEST_MODEL + "-20261014"); } }));
  await good.request(input);
  const goodEvidence = good.lastEvidence;
  await assert.rejects(failed.request(input), code("cost_unreported"));
  assert.equal(failed.lastEvidence?.costUsd, null); assert.equal(failed.spentUsd, 0);
  await assert.rejects(failed.request(input), code("cost_cap"));
  assert.equal(failedCalls, 1); assert.deepEqual(good.lastEvidence, goodEvidence);
  await good.request(input);
  assert.equal(goodCalls, 2); assert.equal(good.spentUsd, 0.02); assert.equal(good.callCount, 2);
});

test("transport timeout isolates late costs and answers, and caller abort never becomes parser success", async () => {
  let release: (value: Response) => void = () => {};
  let parses = 0, entered: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const transport = createJevChoiceTransport(options({ timeoutMs: 5,
    fetchImpl: () => { entered(); return new Promise(resolve => { release = resolve; }); } }));
  const pending = transport.request(input, {}, () => { parses++; return "must not parse"; });
  await started;
  await assert.rejects(pending, code("timeout"));
  const evidence = transport.lastEvidence;
  release(response()); await nextLoop();
  assert.deepEqual(transport.lastEvidence, evidence); assert.equal(transport.spentUsd, 0); assert.equal(parses, 0);
  await assert.rejects(transport.request(input), code("cost_cap"));
  let reads = 0;
  const aborted = createJevChoiceTransport(options({ readKey: async () => { reads++; return KEY; },
    fetchImpl: async () => { throw new Error("must not fetch"); } }));
  const controller = new AbortController(); controller.abort("RAW_ABORT_CANARY");
  await assert.rejects(aborted.request(input, { signal: controller.signal }), code("aborted"));
  assert.equal(reads, 0); assert.equal(aborted.lastEvidence?.status, "error");
  assert.doesNotMatch(JSON.stringify(aborted.lastEvidence), /CANARY/);
});
