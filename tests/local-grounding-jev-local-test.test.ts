// Synthetic fixtures, loopback HTTP and a fake Keychain reader only. No live API.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { setImmediate as nextLoop } from "node:timers/promises";
import { createJevLocalTestClassifier, buildJevLocalTestPayload, JEV_LOCAL_TEST_MODEL, JevLocalTestError } from "../dialogue-model/runtime/local-grounding/jev-local-test.ts";
import type { JevLocalTestPayload } from "../dialogue-model/runtime/local-grounding/jev-local-test.ts";
import { keychainKeyReader, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/local-openrouter.ts";
import { buildLocalClassificationState, createLocalFunctionClassifier } from "../dialogue-model/runtime/local-grounding/classify.ts";
import { LOCAL_ACTS } from "../dialogue-model/runtime/local-grounding/contract.ts";
import type { LocalClassificationInput } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { OPENROUTER_DECISIONS_URL } from "../workers/research-ai-proxy/src/grounding.ts";

const KEY = "sk-or-SYNTHETIC-jev-local-test-key-000000";
const input: LocalClassificationInput = { turn: 2,
  publicTurns: [{ turn: 1, speaker: "ai", text: "この形を船と呼びませんか。四角い部分があります" },
    { turn: 2, speaker: "human", text: "船でいいです。でも三角は下です" }],
  segments: [{ segmentId: "s1", quote: "船でいいです", targets: ["own-a"], aspect: "name", proposition: "船という名前を採用する",
    name: "船", linkedIssueId: "1:name", respondsToTurn: 1 },
  { segmentId: "s2", quote: "三角は下です", targets: ["own-a"], aspect: "orientation", proposition: "三角は下にある",
    name: null, linkedIssueId: null, respondsToTurn: null }],
  priorClaims: [{ id: "1:ai1", turn: 1, issueId: "1:name", targets: ["own-a"], aspect: "name", act: "name_propose",
    proposition: "船という名前を提案する", name: "船", speaker: "ai", sourceTurn: 1, quote: "船と呼びませんか",
    respondsTo: null, source: "ai_hypothesis" },
  { id: "1:ai2", turn: 1, issueId: "1:part", targets: ["own-a"], aspect: "part", act: "assert",
    proposition: "四角い部分がある", name: null, speaker: "ai", sourceTurn: 1, quote: "四角い部分があります",
    respondsTo: null, source: "ai_hypothesis" }] };
const code = (wanted: string) => (e: unknown) => e instanceof JevLocalTestError && e.code === wanted;
const readKey = async () => KEY;
const metadata = { classifierKind: "jev_local_test", calibrated: false, model: JEV_LOCAL_TEST_MODEL };

function answer(payload: JevLocalTestPayload, cost: number | null = 0.0001) {
  return { model: JEV_LOCAL_TEST_MODEL as string, id: "gen-local-test", provider: "TypeSafe",
    answers: Object.fromEntries(Object.entries(payload.questions).map(([name, q]) => {
      const labels = Object.keys(q.criteria);
      const selected = name.endsWith("_act") ? name.startsWith("segment_0_") ? "name_accept" : "assert" : labels.includes("claim_0") ? "claim_0" : "none";
      return [name, { type: "choice", choice: selected, probabilities: Object.fromEntries(labels.map((l) => [l, l === selected ? 1 : 0])), confidence: 1 }];
    })), usage: { input_tokens: 100, output_tokens: 0, ...(cost === null ? {} : { cost }) } };
}
type Reply = { status?: number; body?: unknown; raw?: string };
async function loopback(t: TestContext, respond: (payload: JevLocalTestPayload) => Reply = (p) => ({ body: answer(p) })) {
  const requests: Array<{ method: string | undefined; authorization: string | undefined; payload: JevLocalTestPayload }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as JevLocalTestPayload;
    requests.push({ method: req.method, authorization: req.headers.authorization, payload });
    const reply = respond(payload);
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.equal(url, OPENROUTER_DECISIONS_URL);
    assert.equal(init.redirect, "error");
    return fetch(`http://127.0.0.1:${address.port}`, init);
  };
  return { requests, fetchImpl };
}

test("default off: construction reads no Keychain, does no HTTP and cannot be mislabeled by a generic call", () => {
  let calls = 0;
  const readKey = async () => { calls++; throw new Error("must not read"); };
  const fetchImpl = async () => { calls++; throw new Error("must not fetch"); };
  assert.equal(createJevLocalTestClassifier(), null);
  assert.equal(createJevLocalTestClassifier({ readKey, fetchImpl }), null);
  assert.equal(createJevLocalTestClassifier({ enabled: false, readKey, fetchImpl }), null);
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl });
  assert.deepEqual(classifier?.metadata, metadata);
  assert.equal(classifier?.lastEvidence, null);
  assert.equal(calls, 0);
  // @ts-expect-error Only the model-checked adapter can provide this experimental identity.
  assert.throws(() => createLocalFunctionClassifier({ classifierKind: "jev_local_test", call: async () => [] }));
});

test("Keychain uses the existing service/account with execFile, once and at call time only", async (t) => {
  const seen: unknown[][] = [];
  const reader = keychainKeyReader((file, args, options, callback) => {
    seen.push([file, args, options]);
    callback(null, KEY + "\n");
  });
  const http = await loopback(t);
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey: reader, fetchImpl: http.fetchImpl })!;
  assert.equal(seen.length, 0);
  await classifier.classify(input);
  await classifier.classify(input);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], { timeout: 5000, maxBuffer: 4096 }]);
  assert.equal(http.requests.length, 2);
});

test("wire uses fixed model/URL, two closed choices per segment, safe aliases and the existing state whitelist", async (t) => {
  const http = await loopback(t);
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await classifier.classify(input);
  const request = http.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.authorization, "Bearer " + KEY);
  assert.equal(request.payload.model, JEV_LOCAL_TEST_MODEL);
  assert.equal(request.payload.state, buildLocalClassificationState(input));
  assert.deepEqual(Object.keys(request.payload), ["model", "state", "questions"]);
  const questions = request.payload.questions;
  assert.equal(Object.keys(questions).length, 4);
  assert.deepEqual(Object.keys(questions.segment_0_act.criteria), [...LOCAL_ACTS]);
  assert.deepEqual(Object.keys(questions.segment_0_antecedent.criteria), ["none", "claim_0", "claim_1"]);
  assert.match(questions.segment_0_antecedent.criteria.claim_0, /1:ai1/);
  assert.ok(Object.entries(questions).every(([name, q]) => q.type === "choice" && /^[a-z][a-z0-9_]*$/.test(name) &&
    Object.keys(q.criteria).length <= 255 && Object.keys(q.criteria).every((l) => /^[a-z][a-z0-9_]*$/.test(l))));
  assert.deepEqual(result, [{ segmentId: "s1", act: "name_accept", respondsToClaimId: "1:ai1", rawScore: 1 },
    { segmentId: "s2", act: "assert", respondsToClaimId: "1:ai1", rawScore: 1 }]);
  assert.deepEqual(classifier.metadata, metadata);
  assert.equal(Object.isFrozen(classifier.metadata), true);
  assert.equal(classifier.lastEvidence?.status, "ok");
  assert.deepEqual(classifier.lastEvidence?.choices, result);
  assert.equal(classifier.lastEvidence?.costUsd, 0.0001);
  assert.equal(classifier.lastEvidence?.responseId, "gen-local-test");
  assert.equal(classifier.lastEvidence?.model, JEV_LOCAL_TEST_MODEL);
  assert.equal(classifier.lastEvidence?.error, null);
  assert.deepEqual(Object.keys(classifier.lastEvidence!), ["callIndex", "classifierKind", "status", "model", "responseId", "choices", "latencyMs", "costUsd", "error"]);
});

test("identical requests for both strategies; gold, images, future turns and unknown fields are never forwarded", async (t) => {
  const http = await loopback(t);
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    await classifier.classify({ ...input, strategy, ownImage: "IMAGE_CANARY", partnerImage: "PARTNER_CANARY", gold: "GOLD_CANARY",
      publicTurns: [...input.publicTurns.map((v) => ({ ...v, gold: "GOLD_CANARY" })), { turn: 3, speaker: "ai", text: "FUTURE_CANARY" }],
      segments: input.segments.map((v) => ({ ...v, gold: "GOLD_CANARY" })),
      priorClaims: input.priorClaims.map((v) => ({ ...v, secret: "SECRET_CANARY" })) } as LocalClassificationInput);
  }
  assert.deepEqual(http.requests[0].payload, http.requests[1].payload);
  assert.doesNotMatch(JSON.stringify(http.requests[0].payload), /CANARY|repair-first|bypass-enabled|strategy/);
});

test("no antecedent candidates still use only none; no segments skip without Keychain or HTTP", async (t) => {
  const http = await loopback(t);
  let reads = 0;
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey: async () => { reads++; return KEY; }, fetchImpl: http.fetchImpl })!;
  assert.deepEqual(await classifier.classify({ ...input, segments: [] }), []);
  assert.equal(reads, 0);
  assert.equal(http.requests.length, 0);
  assert.equal(classifier.lastEvidence?.status, "skipped");
  assert.equal(classifier.lastEvidence?.model, null);
  const result = await classifier.classify({ ...input, priorClaims: [] });
  assert.ok(result.every((v) => v.respondsToClaimId === null));
  assert.deepEqual(Object.keys(http.requests[0].payload.questions.segment_0_antecedent.criteria), ["none"]);
  assert.equal(classifier.lastEvidence?.callIndex, 2);
});

test("accepts only exact Jev-1.14 or its dated snapshot, preserving the actual response ID", async (t) => {
  let model = JEV_LOCAL_TEST_MODEL as string;
  const http = await loopback(t, (p) => ({ body: { ...answer(p), model } }));
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  for (const accepted of [JEV_LOCAL_TEST_MODEL, JEV_LOCAL_TEST_MODEL + "-20261014"]) {
    model = accepted;
    await classifier.classify(input);
    assert.equal(classifier.lastEvidence?.model, accepted);
  }
  for (const rejected of ["typesafe/jev-1.13", "typesafe/jev-1.14-latest", "typesafe/jev-1.14-2026101", "typesafe/jev-1.14-20261014-extra", "sk-secret-model"]) {
    model = rejected;
    await assert.rejects(classifier.classify(input), code("model_mismatch"));
    assert.equal(classifier.lastEvidence?.model, null);
    assert.equal(classifier.lastEvidence?.status, "error");
    assert.deepEqual(classifier.lastEvidence?.choices, []);
    assert.doesNotMatch(JSON.stringify(classifier.lastEvidence), /sk-secret/);
  }
});

test("a refused, missing, out-of-set, extra-key or malformed choice rejects every segment", async (t) => {
  const patches: Array<(a: ReturnType<typeof answer>) => unknown> = [
    (a) => ({ ...a, answers: { ...a.answers, segment_0_act: { type: "refusal" } } }),
    (a) => ({ ...a, answers: { ...a.answers, segment_0_act: { ...a.answers.segment_0_act, choice: "whole_figure_agreed" } } }),
    (a) => ({ ...a, answers: { ...a.answers, segment_1_antecedent: { ...a.answers.segment_1_antecedent, choice: "claim_999" } } }),
    (a) => ({ ...a, answers: { ...a.answers, segment_1_act: { ...a.answers.segment_1_act, private: "RAW_CANARY" } } }),
    (a) => ({ ...a, answers: { ...a.answers, segment_0_act: { ...a.answers.segment_0_act, probabilities: { assert: 1 } } } }),
    (a) => ({ ...a, answers: { ...a.answers, segment_0_act: { ...a.answers.segment_0_act, confidence: -1 } } }),
    (a) => ({ ...a, answers: { ...a.answers, segment_0_act: { ...a.answers.segment_0_act, probabilities: { ...a.answers.segment_0_act.probabilities, assert: -1 } } } }),
    (a) => ({ ...a, answers: { ...a.answers, fabricated_segment: a.answers.segment_0_act } }),
    (a) => ({ ...a, answers: Object.fromEntries(Object.entries(a.answers).filter(([k]) => k !== "segment_1_act")) }),
  ];
  let patch = patches[0];
  const http = await loopback(t, (p) => ({ body: patch(answer(p)) }));
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  for (patch of patches) {
    await assert.rejects(classifier.classify(input), code("invalid_response"));
    assert.equal(classifier.lastEvidence?.status, "error");
    assert.deepEqual(classifier.lastEvidence?.choices, []);
    assert.equal(classifier.lastEvidence?.model, JEV_LOCAL_TEST_MODEL);
  }
});

test("errors and evidence contain no key, provider body, prompt, arbitrary error code or cause", async (t) => {
  const http = await loopback(t, () => ({ raw: "RAW_CANARY sk-secret PROMPT_CANARY" }));
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(classifier.classify(input), (e: unknown) => {
    assert.ok(code("invalid_response")(e));
    assert.doesNotMatch(inspect(e, { showHidden: true }) + JSON.stringify(classifier.lastEvidence), /CANARY|sk-secret|cause/);
    return true;
  });
  for (const operation of [
    { readKey: async () => { throw Object.assign(new Error(KEY + " PROMPT_CANARY"), { code: "RAW_CANARY", cause: KEY }); }, fetchImpl: http.fetchImpl, expected: "key_unavailable" },
    { readKey, fetchImpl: async () => { throw Object.assign(new Error(KEY + " PROMPT_CANARY"), { code: "RAW_CANARY", cause: KEY }); }, expected: "network_error" },
  ]) {
    const failing = createJevLocalTestClassifier({ enabled: true, ...operation })!;
    await assert.rejects(failing.classify(input), (e: unknown) => {
      assert.ok(code(operation.expected)(e));
      assert.doesNotMatch(inspect(e, { showHidden: true }) + JSON.stringify(failing.lastEvidence), /CANARY|SYNTHETIC|cause/);
      return true;
    });
  }
});

test("response key echoes, including JSON-escaped echoes, stop before publishing evidence", async (t) => {
  for (const escaped of [false, true]) {
    const http = await loopback(t, (p) => ({ raw: JSON.stringify({ ...answer(p), unexpected: KEY }).replace(KEY, escaped ? "\\u0073" + KEY.slice(1) : KEY) }));
    const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
    await assert.rejects(classifier.classify(input), code("key_leak"));
    assert.equal(classifier.lastEvidence?.model, null);
    assert.doesNotMatch(JSON.stringify(classifier.lastEvidence), /SYNTHETIC/);
    assert.equal(classifier.leaks(KEY), true);
  }
});

test("key in state is blocked before HTTP and malformed keys fail without a credential fallback", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("must not call"); };
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl })!;
  await assert.rejects(classifier.classify({ ...input, publicTurns: [...input.publicTurns, { turn: 1, speaker: "human", text: KEY }] }), code("key_leak"));
  for (const key of ["", "wrong-key", "sk-or-short"]) {
    await assert.rejects(createJevLocalTestClassifier({ enabled: true, readKey: async () => key, fetchImpl })!.classify(input), code("key_unavailable"));
  }
  assert.equal(calls, 0);
});

test("HTTP failures map to fixed codes with no error-body reads or automatic retries", async (t) => {
  for (const [status, expected] of [[401, "unauthorized"], [403, "unauthorized"], [402, "payment_required"], [404, "not_found"], [429, "rate_limited"], [503, "upstream_error"]] as const) {
    const http = await loopback(t, () => ({ status, raw: KEY + " RAW_CANARY PROMPT_CANARY" }));
    let reads = 0;
    const fetchImpl = async (url: string, init: RequestInit) => {
      const response = await http.fetchImpl(url, init);
      response.text = async () => { reads++; throw new Error("error body must not be read"); };
      return response;
    };
    const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl })!;
    await assert.rejects(classifier.classify(input), code(expected));
    assert.equal(reads, 0);
    assert.equal(http.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(classifier.lastEvidence), /SYNTHETIC|CANARY/);
    await assert.rejects(classifier.classify(input), code("cost_cap"));
    assert.equal(http.requests.length, 1, "unknown billable outcome halts subsequent spending");
  }
});

test("observed-cost stop rule prevents the next estimated overspend and missing costs halt the instance", async (t) => {
  const expensive = await loopback(t, (p) => ({ body: answer(p, 0.03) }));
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: expensive.fetchImpl })!;
  await classifier.classify(input);
  assert.equal(classifier.spentUsd, 0.03);
  await assert.rejects(classifier.classify(input), code("cost_cap"));
  assert.equal(expensive.requests.length, 1);
  assert.equal(classifier.lastEvidence?.model, null, "failed later calls clear earlier success proof");
  const unreported = await loopback(t, (p) => ({ body: answer(p, null) }));
  const silent = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: unreported.fetchImpl })!;
  await assert.rejects(silent.classify(input), code("cost_unreported"));
  await assert.rejects(silent.classify(input), code("cost_cap"));
  assert.equal(unreported.requests.length, 1);
  const overshoot = await loopback(t, (p) => ({ body: answer(p, 0.06) }));
  const costly = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: overshoot.fetchImpl })!;
  await assert.rejects(costly.classify(input), code("cost_cap"));
  assert.equal(costly.lastEvidence?.costUsd, 0.06);
  assert.deepEqual(costly.lastEvidence?.choices, []);
});

test("timeouts bound key reads, ignored fetch cancellation and ignored body cancellation", async () => {
  const payload = buildJevLocalTestPayload(input);
  const readers = [
    { readKey: () => new Promise<string>(() => {}), fetchImpl: async () => Response.json(answer(payload)) },
    { readKey, fetchImpl: () => new Promise<Response>(() => {}) },
    { readKey, fetchImpl: async () => { const r = new Response(); r.text = () => new Promise(() => {}); return r; } },
  ];
  for (const dependencies of readers) {
    const classifier = createJevLocalTestClassifier({ enabled: true, ...dependencies, timeoutMs: 5 })!;
    await assert.rejects(classifier.classify(input), code("timeout"));
    assert.equal(classifier.lastEvidence?.status, "error");
    assert.deepEqual(classifier.lastEvidence?.choices, []);
  }
});

test("pre-abort never reads the key; caller abort reaches transport and cannot leak its reason", async () => {
  let reads = 0, entered: () => void = () => {};
  const started = new Promise<void>((r) => { entered = r; });
  let signal: AbortSignal | null | undefined;
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey: async () => { reads++; return KEY; },
    fetchImpl: (_url, init) => { signal = init.signal; entered(); return new Promise(() => {}); } })!;
  const controller = new AbortController();
  controller.abort(KEY + " RAW_CANARY");
  await assert.rejects(classifier.classify(input, { signal: controller.signal }), code("aborted"));
  assert.equal(reads, 0);
  const live = new AbortController();
  const pending = classifier.classify(input, { signal: live.signal });
  await started;
  live.abort(KEY + " RAW_CANARY");
  await assert.rejects(pending, code("aborted"));
  assert.equal(signal?.aborted, true);
  assert.doesNotMatch(JSON.stringify(classifier.lastEvidence), /SYNTHETIC|CANARY/);
});

test("late responses cannot overwrite a timed-out call or account unverified late costs", async () => {
  let release: (r: Response) => void = () => {};
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, timeoutMs: 5,
    fetchImpl: () => new Promise((r) => { release = r; }) })!;
  await assert.rejects(classifier.classify(input), code("timeout"));
  const evidence = classifier.lastEvidence;
  release(Response.json(answer(buildJevLocalTestPayload(input))));
  await nextLoop();
  assert.deepEqual(classifier.lastEvidence, evidence);
  assert.equal(classifier.spentUsd, 0);
  await assert.rejects(classifier.classify(input), code("cost_cap"));
});

test("sequential evidence has distinct call indexes and is detached from caller mutation", async (t) => {
  let id = "gen-first";
  const http = await loopback(t, (p) => ({ body: { ...answer(p), id } }));
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await classifier.classify(input);
  const first = classifier.lastEvidence!;
  first.choices[0].segmentId = "changed";
  result[0].act = "unknown";
  assert.equal(classifier.lastEvidence?.choices[0].segmentId, "s1");
  assert.equal(classifier.lastEvidence?.choices[0].act, "name_accept");
  id = "gen-second";
  await classifier.classify(input);
  assert.equal(classifier.lastEvidence?.callIndex, 2);
  assert.equal(classifier.lastEvidence?.responseId, id);
  assert.equal(classifier.callCount, 2);
  assert.equal(first.callIndex, 1);
});

test("concurrent requests cannot bypass the budget or replace newer failure evidence", async () => {
  let entered: () => void = () => {}, release: (r: Response) => void = () => {};
  const started = new Promise<void>((r) => { entered = r; });
  let calls = 0;
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: () => {
    calls++; entered(); return new Promise((r) => { release = r; });
  } })!;
  const first = classifier.classify(input);
  await started;
  await assert.rejects(classifier.classify(input), code("busy"));
  release(Response.json(answer(buildJevLocalTestPayload(input))));
  await first;
  assert.equal(calls, 1);
  assert.equal(classifier.lastEvidence?.callIndex, 2);
  assert.equal(classifier.lastEvidence?.error, "busy");
});

test("invalid options and input fail before reading a credential or making HTTP requests", async () => {
  let reads = 0;
  const readKey = async () => { reads++; return KEY; };
  for (const options of [{ costCapUsd: 0 }, { costCapUsd: 0.06 }, { costCapUsd: Infinity }, { timeoutMs: 0 }]) {
    assert.throws(() => createJevLocalTestClassifier({ enabled: true, readKey, ...options }), code("invalid_options"));
  }
  const classifier = createJevLocalTestClassifier({ enabled: true, readKey })!;
  await assert.rejects(classifier.classify({ ...input, turn: 0 }), code("invalid_request"));
  await assert.rejects(classifier.classify(input, { timeoutMs: 0 }), code("invalid_options"));
  assert.equal(reads, 0);
});
