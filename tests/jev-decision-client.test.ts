// Synthetic data, fake Keychain and loopback HTTP only. Never invoke a live model.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { setImmediate as nextLoop } from "node:timers/promises";
import { createJevDecisionClient, buildJevDecisionPayload, buildJevDecisionDetailPayload, parseJevActionTargetChoices, validateJevDecision,
  buildHumanReferentPayload, validateHumanReferentEstimate, JEV_DECISION_MODEL, JEV_DECISION_REJECTION_CODES, JevDecisionError } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionInput } from "../dialogue-model/runtime/decision/contract.ts";
import { keychainKeyReader, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/local-openrouter.ts";
import { OPENROUTER_DECISIONS_URL } from "../workers/research-ai-proxy/src/grounding.ts";

const KEY = "sk-or-SYNTHETIC-jev-decision-key-000000";
const readKey = async () => KEY;
function fixture(): JevDecisionInput {
  const slots = Array.from({ length: 6 }, (_, i) => `own-${i}`);
  return { turn: 2, ownSlots: slots, publicTurns: [{ turn: 1, speaker: "ai", text: "この形を船と呼ぶのはどうですか" }, { turn: 2, speaker: "human", text: "牛に見えるけど、名前は船でいいです" }],
    observations: { observedAt: "2026-10-20T00:00:00.000Z", figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
      holistic: [{ construal: i === 0 ? "馬" : `見立て${i}`, basis: ["頭のような部分"], status: "hypothesis" }],
      analytic: { shapes: [`三角${i}`], composition: `構成${i}`, relations: [] }, unknowns: [], reobservations: [] })) },
    issueSummary: "向きは未解決", priorClaims: [], publicNames: [{ name: "船", figureId: slots[0], sourceTurn: 1 }], repairHistory: [], previousAction: null };
}
function answer(payload: JevDecisionPayload, preferences: Record<string, string> = {}, model: string = JEV_DECISION_MODEL, cost: number | null = 0.0001) {
  return { model, id: "gen-jev-decision", provider: "TypeSafe",
    answers: Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => {
      const selected = preferences[key] ?? (key === "action" ? "accept" : key === "target" ? "none" : key.startsWith("candidate_") ? "exclude" : Object.keys(q.criteria)[0]);
      return [key, { type: "choice", choice: selected, probabilities: Object.fromEntries(Object.keys(q.criteria).map(l => [l, l === selected ? 1 : 0])), confidence: 1 }];
    })), usage: { input_tokens: 100, output_tokens: 0, ...(cost === null ? {} : { cost }) } };
}
type Reply = { body?: unknown; raw?: string; status?: number };
async function httpMock(t: TestContext, respond: (p: JevDecisionPayload) => Reply = p => ({ body: answer(p) })) {
  const requests: Array<{ payload: JevDecisionPayload; authorization: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as JevDecisionPayload;
    requests.push({ payload, authorization: req.headers.authorization });
    const result = respond(payload);
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(result.raw ?? JSON.stringify(result.body ?? {}));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { requests, fetchImpl: async (url: string, init: RequestInit) => {
    assert.equal(url, OPENROUTER_DECISIONS_URL); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    return fetch(`http://127.0.0.1:${address.port}`, init);
  } };
}
const code = (wanted: string) => (e: unknown) => e instanceof JevDecisionError && e.code === wanted;

test("S1-c: none repair/confirm with included candidates records rejection before detail", async t => {
  for (const action of ["repair", "confirm"]) {
    const http = await httpMock(t, p => ({ body: answer(p, { action, target: "none", candidate_0: "include", candidate_1: "include" }) }));
    const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
    const input = fixture(), before = structuredClone(input);
    await assert.rejects(client.decide(input), code("invalid_decision"));
    assert.deepEqual(input, before);
    assert.equal(http.requests.length, 1);
    const failed = client.lastEvidence!;
    assert.equal(failed.status, "error"); assert.equal(failed.error, "invalid_decision");
    assert.equal(failed.rejectionCode, "detail_target_required");
    assert.equal(failed.choices.action, action); assert.equal(failed.choices.target, "none");
    assert.equal(failed.choices.candidate_0, "include"); assert.equal(failed.choices.candidate_1, "include");
    assert.equal(failed.stages.length, 1); assert.equal(failed.stages[0].stage, "action_target");
    assert.equal(failed.stages[0].status, "error"); assert.equal(failed.stages[0].rejectionCode, "detail_target_required");
  }
});

test("off mode and construction do no I/O; Keychain uses existing service/account at decide time only", async t => {
  let reads = 0;
  const reader = keychainKeyReader((file, args, options, callback) => {
    reads++; assert.equal(file, "security");
    assert.deepEqual(args, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    assert.deepEqual(options, { timeout: 5000, maxBuffer: 4096 }); callback(null, KEY);
  });
  const http = await httpMock(t);
  assert.equal(createJevDecisionClient(), null);
  assert.equal(createJevDecisionClient({ enabled: false, readKey: reader, fetchImpl: http.fetchImpl }), null);
  const client = createJevDecisionClient({ enabled: true, readKey: reader, fetchImpl: http.fetchImpl })!;
  assert.equal(reads, 0); assert.equal(client.lastEvidence, null);
  assert.deepEqual(client.metadata, { decisionKind: "jev_local_test", calibrated: false, model: JEV_DECISION_MODEL, questionLayout: "two_stage_v1" });
  await client.decide(fixture()); await client.decide(fixture());
  assert.equal(reads, 1); assert.equal(http.requests.length, 2);
  assert.equal(http.requests[0].authorization, "Bearer " + KEY);
});

test("Jev alone selects agree with a public name, and evidence contains complete raw choices and scores", async t => {
  const input = fixture();
  const http = await httpMock(t, p => ({ body: answer(p, { action: "agree", target: "figure_0", name: "name_1" }) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide({ ...input, lunaAction: "confirm" } as JevDecisionInput);
  assert.equal(result.action, "agree"); assert.equal(result.name, "船");
  assert.deepEqual(result.target, { kind: "single", figureId: "own-0" }); assert.equal(result.feature, null);
  assert.equal(result.observe, null); assert.equal(result.decisionKind, "jev_local_test"); assert.equal(result.calibrated, false);
  assert.equal(result.evidence.model, JEV_DECISION_MODEL); assert.equal(result.evidence.responseId, "gen-jev-decision");
  assert.equal(result.evidence.choices.action, "agree"); assert.equal(result.evidence.scores.action.agree, 1);
  assert.equal(Object.keys(result.evidence.choices).length, 8);
  assert.equal(result.evidence.inputBudget?.stateChars, http.requests[0].payload.state.length);
  assert.equal(result.evidence.inputBudget?.maxChars, 20000);
  assert.deepEqual(validateJevDecision(result, input), result);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|prompt|"publicTurns":\[/);
  assert.equal(client.lastEvidence?.status, "ok");
  assert.equal(client.lastEvidence?.rejectionCode, null);
  assert.doesNotMatch(http.requests[0].payload.state, /lunaAction/);
});

test("request observation specifies one own figure and a visual issue, then a fresh decision uses the result", async t => {
  let second = false;
  const http = await httpMock(t, p => ({ body: answer(p, second ? { action: "repair", target: "figure_0", feature: "feature_2" } :
    { action: "request_observation", target: "multiple", candidate_0: "include", candidate_1: "include", observe_targets: "subset_0", observe_aspect: "construal" }) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const input = fixture();
  const observation = await client.decide(input);
  assert.equal(observation.action, "request_observation");
  assert.equal(observation.target.kind, "multiple");
  assert.deepEqual(observation.observe?.figureIds, ["own-0"]);
  assert.equal(observation.observe?.aspect, "construal");
  assert.match(observation.observe!.question, /牛に見える/);
  assert.equal(observation.observe?.partnerConstrual, null, "the program does not infer a semantic construal from a raw utterance");
  assert.deepEqual(validateJevDecision(observation, input), observation);
  input.observations.figures[0].reobservations.push({ observedAt: "2026-10-20T00:00:01.000Z", figureId: "own-0",
    issue: { aspect: "construal", question: "牛の見立てを確認", partnerConstrual: "牛" }, supports: ["角のような尖りがある"], contradicts: ["耳とは限らない"], unknown: [] });
  input.reobservationAllowed = false;
  second = true;
  const repaired = await client.decide(input);
  assert.equal(repaired.action, "repair"); assert.equal(repaired.feature, "角のような尖りがある");
  assert.equal(Object.hasOwn(http.requests[2].payload.questions.action.criteria, "request_observation"), false);
  assert.match(http.requests[2].payload.state, /耳とは限らない/);
  assert.equal(client.callCount, 2);
  assert.equal(http.requests.length, 4, "reobservation has two decisions, each with at most two HTTP requests");
});

test("only target-scoped name/feature answers are used; irrelevant answers cannot alter the selected act", async t => {
  let preferences: Record<string, string> = { action: "confirm", target: "figure_1", feature: "feature_0", name: "name_1" };
  const http = await httpMock(t, p => ({ body: answer(p, preferences) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide(fixture());
  assert.equal(result.feature, "三角1"); assert.equal(result.name, null); assert.equal(result.action, "confirm");
  preferences = { ...preferences, action: "agree", target: "multiple", candidate_0: "include", candidate_1: "include" };
  await assert.rejects(client.decide(fixture()), code("invalid_decision"));
  assert.equal(client.lastEvidence?.status, "error"); assert.equal(client.lastEvidence?.choices.target, "multiple");
  assert.equal(client.lastEvidence?.rejectionCode, "name_requires_single_target");
});

test("rejected first-stage selections retain closed labels and fixed reasons without a second call", async t => {
  const cases: Array<{ preferences: Record<string, string>; error: string; rule: string }> = [
    { preferences: { action: "agree", target: "none" }, error: "invalid_decision", rule: "name_requires_single_target" },
    { preferences: { action: "propose_name", target: "multiple", candidate_0: "include", candidate_1: "include" }, error: "invalid_decision", rule: "name_requires_single_target" },
    { preferences: { action: "confirm", target: "none" }, error: "invalid_decision", rule: "detail_target_required" },
    { preferences: { action: "repair", target: "multiple", candidate_0: "include" }, error: "inconsistent_decision", rule: "multiple_requires_candidates" },
  ];
  let preferences: Record<string, string> = {}, malformed = false;
  const http = await httpMock(t, p => {
    const body = answer(p, preferences);
    if (malformed) body.answers.candidate_5.choice = "RAW_CANARY";
    return { body: { ...body, extra: "RAW_CANARY" } };
  });
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const input = { ...fixture(), issueSummary: "PROMPT_CANARY" };
  for (const c of cases) {
    preferences = c.preferences;
    await assert.rejects(client.decide(input), (e: unknown) => {
      assert.ok(code(c.error)(e));
      assert.doesNotMatch(inspect(e, { showHidden: true }), /CANARY|SYNTHETIC|choices|rejectionCode|cause/); return true;
    });
    const evidence = client.lastEvidence!;
    assert.equal(evidence.status, "error"); assert.equal(evidence.error, c.error);
    assert.equal(evidence.rejectionCode, c.rule); assert.ok(JEV_DECISION_REJECTION_CODES.includes(evidence.rejectionCode!));
    const expected = Object.fromEntries(Object.entries(answer(http.requests.at(-1)!.payload, preferences).answers).map(([key, a]) => [key, a.choice]));
    assert.deepEqual(evidence.choices, expected); assert.equal(Object.keys(evidence.choices).length, 8);
    assert.equal(evidence.stages.length, 1); assert.equal(evidence.stages[0].rejectionCode, c.rule);
    assert.equal(evidence.model, JEV_DECISION_MODEL); assert.equal(evidence.responseId, "gen-jev-decision");
    assert.equal(evidence.costUsd, 0.0001); assert.equal(evidence.callIndex, http.requests.length);
    assert.doesNotMatch(JSON.stringify(evidence), /CANARY|SYNTHETIC|criteria|instructions|"publicTurns":\[/);
    evidence.choices.action = "close";
    assert.equal(client.lastEvidence?.choices.action, preferences.action);
  }
  assert.equal(http.requests.length, cases.length, "one rejected request per decide, without retry or detail");
  preferences = {};
  await client.decide(input);
  assert.equal(client.lastEvidence?.rejectionCode, null); assert.equal(client.lastEvidence?.status, "ok");
  malformed = true;
  await assert.rejects(client.decide(input), code("invalid_response"));
  assert.deepEqual(client.lastEvidence?.choices, {}); assert.deepEqual(client.lastEvidence?.scores, {});
  assert.equal(client.lastEvidence?.rejectionCode, null);
});

test("validator rejects injected act changes, forged actual model, score maps and omission evidence", async t => {
  const http = await httpMock(t);
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const input = fixture(), value = await client.decide(input);
  assert.throws(() => validateJevDecision({ ...value, action: "close" }, input), code("inconsistent_decision"));
  assert.throws(() => validateJevDecision({ ...value, evidence: { ...value.evidence, model: "openai/luna" } }, input), code("model_mismatch"));
  assert.throws(() => validateJevDecision({ ...value, evidence: { ...value.evidence, scores: {} } }, input), code("invalid_response"));
  assert.throws(() => validateJevDecision({ ...value, evidence: { ...value.evidence, inputBudget: undefined } }, input), code("invalid_response"));
});

test("compacted wire input reports exact omission counts even when the model call later fails", async t => {
  const input = fixture();
  input.repairHistory = Array.from({ length: 64 }, (_, i) => ({ turn: 1, issueId: `issue-${i}`, action: "confirm" as const,
    question: "確認".repeat(200), partnerClaims: [], candidatesBefore: ["own-0"], candidatesAfter: ["own-0"],
    addedClaimIds: [], removedClaimIds: [], progress: "unknown" as const }));
  const http = await httpMock(t);
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide(input);
  assert.ok(result.evidence.inputBudget!.omitted.repairHistory > 0);
  assert.equal(result.evidence.inputBudget!.stateChars, http.requests[0].payload.state.length);
  assert.ok(result.evidence.inputBudget!.stateChars <= 20000);
  assert.deepEqual(validateJevDecision(result, input), result);
  const failing = createJevDecisionClient({ enabled: true, readKey, fetchImpl: async () => { throw new Error("RAW_CANARY"); } })!;
  await assert.rejects(failing.decide(input), code("network_error"));
  assert.deepEqual(failing.lastEvidence?.inputBudget, result.evidence.inputBudget);
});

test("malformed, partial, unknown and refused answers fail with no fallback or retry", async t => {
  let patch = (p: JevDecisionPayload): unknown => ({ ...answer(p), answers: {} });
  const http = await httpMock(t, p => ({ body: patch(p) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const patches: Array<(p: JevDecisionPayload) => unknown> = [p => ({ ...answer(p), answers: {} }),
    p => { const a = answer(p); a.answers.action.choice = "luna_decides"; return a; },
    p => { const a = answer(p); return { ...a, answers: { ...a.answers, action: { type: "refusal" } } }; },
    p => { const a = answer(p); return { ...a, answers: { ...a.answers, action: { ...a.answers.action, raw: "RAW_CANARY" } } }; },
    p => { const a = answer(p); a.answers.action.probabilities.accept = -1; return a; },
    p => { const a = answer(p); a.answers.action.probabilities = { accept: 1 }; return a; },
    p => { const a = answer(p); return { ...a, answers: { ...a.answers, extra: a.answers.action } }; }];
  for (patch of patches) await assert.rejects(client.decide(fixture()), code("invalid_response"));
  assert.equal(http.requests.length, patches.length);
  assert.deepEqual(client.lastEvidence?.choices, {});
});

test("actual model allows only Jev-1.14 and dated snapshots; response IDs are bounded", async t => {
  let model = JEV_DECISION_MODEL as string, id = "gen-first";
  const http = await httpMock(t, p => ({ body: { ...answer(p, {}, model), id } }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  for (model of [JEV_DECISION_MODEL, JEV_DECISION_MODEL + "-20261014"]) {
    const result = await client.decide(fixture()); assert.equal(result.evidence.model, model);
    assert.deepEqual(validateJevDecision(result, fixture()), result);
  }
  model = "typesafe/jev-1.13";
  await assert.rejects(client.decide(fixture()), code("model_mismatch"));
  assert.equal(client.lastEvidence?.model, null);
  model = JEV_DECISION_MODEL; id = "RAW_CANARY";
  assert.equal((await client.decide(fixture())).evidence.responseId, null);
});

test("credentials, prompts and provider errors cannot leak into typed errors or evidence", async t => {
  const http = await httpMock(t, () => ({ raw: "RAW_CANARY PROMPT_CANARY " + KEY }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(client.decide(fixture()), (e: unknown) => {
    assert.ok(code("key_leak")(e));
    assert.doesNotMatch(inspect(e, { showHidden: true }) + JSON.stringify(client.lastEvidence), /CANARY|SYNTHETIC|cause/); return true;
  });
  for (const [expected, dependencies] of [
    ["key_unavailable", { readKey: async () => { throw new Error(KEY + " PROMPT_CANARY"); } }],
    ["network_error", { readKey, fetchImpl: async () => { throw Object.assign(new Error(KEY + " PROMPT_CANARY"), { code: "RAW_CANARY" }); } }],
  ] as const) {
    const failing = createJevDecisionClient({ enabled: true, ...dependencies })!;
    await assert.rejects(failing.decide(fixture()), (e: unknown) => {
      assert.ok(code(expected)(e)); assert.doesNotMatch(inspect(e, { showHidden: true }) + JSON.stringify(failing.lastEvidence), /CANARY|SYNTHETIC|cause/); return true;
    });
  }
});

test("JSON-escaped key echoes and keys in input are rejected before exposing a decision", async t => {
  const http = await httpMock(t, p => ({ raw: JSON.stringify({ ...answer(p), extra: KEY }).replace(KEY, "\\u0073" + KEY.slice(1)) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(client.decide(fixture()), code("key_leak"));
  const before = http.requests.length;
  const blocked = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(blocked.decide({ ...fixture(), issueSummary: KEY }), code("key_leak"));
  assert.equal(http.requests.length, before);
});

test("HTTP failures do not read error bodies, retry, redirect or fall back to Luna", async t => {
  for (const [status, expected] of [[401, "unauthorized"], [402, "payment_required"], [404, "not_found"], [429, "rate_limited"], [503, "upstream_error"]] as const) {
    const http = await httpMock(t, () => ({ status, raw: KEY + " PROMPT_CANARY" }));
    let reads = 0;
    const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: async (url, init) => {
      const response = await http.fetchImpl(url, init);
      response.text = async () => { reads++; throw new Error("must not read"); }; return response;
    } })!;
    await assert.rejects(client.decide(fixture()), code(expected)); assert.equal(reads, 0); assert.equal(http.requests.length, 1);
    await assert.rejects(client.decide(fixture()), code("cost_cap")); assert.equal(http.requests.length, 1);
  }
});

test("observed-cost cap stops further spending, and unreported costs fail closed", async t => {
  let cost: number | null = 0.03;
  const http = await httpMock(t, p => ({ body: answer(p, {}, JEV_DECISION_MODEL, cost) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await client.decide(fixture()); assert.equal(client.spentUsd, 0.03);
  await assert.rejects(client.decide(fixture()), code("cost_cap")); assert.equal(http.requests.length, 1);
  cost = null;
  const unreported = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(unreported.decide(fixture()), code("cost_unreported"));
  await assert.rejects(unreported.decide(fixture()), code("cost_cap")); assert.equal(http.requests.length, 2);
});

test("timeouts include credentials, transport and body; pre-abort reads nothing; late data cannot commit", async () => {
  const input = fixture(), payload = buildJevDecisionPayload(input);
  for (const deps of [{ readKey: () => new Promise<string>(() => {}), fetchImpl: async () => Response.json(answer(payload)) },
    { readKey, fetchImpl: () => new Promise<Response>(() => {}) },
    { readKey, fetchImpl: async () => { const r = new Response(); r.text = () => new Promise(() => {}); return r; } }]) {
    const client = createJevDecisionClient({ enabled: true, ...deps, timeoutMs: 5 })!;
    await assert.rejects(client.decide(input), code("timeout")); assert.equal(client.lastEvidence?.status, "error");
  }
  let reads = 0;
  const controller = new AbortController(); controller.abort("SECRET_CANARY");
  const client = createJevDecisionClient({ enabled: true, readKey: async () => { reads++; return KEY; } })!;
  await assert.rejects(client.decide(input, { signal: controller.signal }), code("aborted")); assert.equal(reads, 0);
  let release: (r: Response) => void = () => {};
  const late = createJevDecisionClient({ enabled: true, readKey, timeoutMs: 5, fetchImpl: () => new Promise(r => { release = r; }) })!;
  await assert.rejects(late.decide(input), code("timeout")); const evidence = late.lastEvidence;
  release(Response.json(answer(payload))); await nextLoop(); assert.deepEqual(late.lastEvidence, evidence); assert.equal(late.spentUsd, 0);
});

test("caller mutation cannot change provenance during an HTTP call, and evidence copies remain detached", async t => {
  const input = fixture();
  const http = await httpMock(t, p => { input.ownSlots = ["changed"]; return { body: answer(p) }; });
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide(input);
  result.evidence.choices.action = "close";
  assert.equal(client.lastEvidence?.choices.action, "accept");
  const evidence = client.lastEvidence!; evidence.choices.action = "repair";
  assert.equal(client.lastEvidence?.choices.action, "accept");
});

test("caller cancellation reaches the in-flight transport and strips the abort reason", async () => {
  let entered: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | null | undefined;
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: (_url, init) => {
    signal = init.signal; entered(); return new Promise(() => {});
  } })!;
  const controller = new AbortController(), pending = client.decide(fixture(), { signal: controller.signal });
  await started; controller.abort("RAW_CANARY " + KEY);
  await assert.rejects(pending, code("aborted"));
  assert.equal(signal?.aborted, true);
  assert.doesNotMatch(JSON.stringify(client.lastEvidence), /CANARY|SYNTHETIC/);
});

test("invalid configuration or input fails before any credential read", async () => {
  let reads = 0;
  const readKey = async () => { reads++; return KEY; };
  for (const options of [{ costCapUsd: 0.06 }, { costCapUsd: -1 }, { timeoutMs: 0 }]) {
    assert.throws(() => createJevDecisionClient({ enabled: true, readKey, ...options }), code("invalid_options"));
  }
  const client = createJevDecisionClient({ enabled: true, readKey })!;
  await assert.rejects(client.decide({ ...fixture(), turn: 0 }), code("invalid_input"));
  assert.equal(reads, 0);
});

test("actions without details use one request and preserve the selected candidate subset", async t => {
  let action = "accept";
  const http = await httpMock(t, p => ({ body: answer(p, { action, target: "multiple", candidate_0: "include", candidate_2: "include" }) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  for (action of ["accept", "defer", "move_on", "revisit", "close"]) {
    const before = http.requests.length;
    const result = await client.decide(fixture());
    assert.equal(http.requests.length, before + 1);
    assert.deepEqual(result.target, { kind: "multiple", figureIds: ["own-0", "own-2"] });
    assert.deepEqual(parseJevActionTargetChoices(fixture(), result.evidence.choices), { action, target: result.target });
    assert.throws(() => parseJevActionTargetChoices(fixture(), { ...result.evidence.choices, candidate_0: "RAW_CANARY" }), code("invalid_response"));
    assert.throws(() => parseJevActionTargetChoices(fixture(), { ...result.evidence.choices, extra: "none" }), code("invalid_response"));
    assert.equal(result.evidence.stages?.length, 1); assert.deepEqual(result.detailFigureIds, []);
    assert.equal(result.evidence.costUsd, 0.0001);
    assert.equal(buildJevDecisionDetailPayload(fixture(), { action: result.action, target: result.target }), null);
    assert.deepEqual(validateJevDecision(result, fixture()), result);
  }
});

test("multiple confirm and repair ask only scoped feature unions and preserve all feature sources", async t => {
  const input = fixture();
  input.observations.figures[0].analytic.shapes.push("共通の四角");
  input.observations.figures[2].analytic.shapes.push("共通の四角");
  let action = "confirm";
  const http = await httpMock(t, p => {
    if (p.questions.action) return { body: answer(p, { action, target: "multiple", candidate_0: "include", candidate_2: "include" }) };
    assert.deepEqual(Object.keys(p.questions), ["feature"]);
    const entries = Object.entries(p.questions.feature.criteria).map(([label, raw]) => ({ label, ...JSON.parse(raw) }));
    assert.ok(entries.every(c => c.figureIds.every((id: string) => ["own-0", "own-2"].includes(id))));
    assert.ok(entries.some(c => c.value === "三角2" && c.figureIds[0] === "own-2"));
    assert.equal(entries.some(c => c.value === "三角1"), false);
    const label = entries.find(c => c.value === "共通の四角")!.label;
    return { body: answer(p, { feature: label }, JEV_DECISION_MODEL + "-20261014", 0.0002) };
  });
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  for (action of ["confirm", "repair"]) {
    const result = await client.decide(input);
    assert.deepEqual(result.target, { kind: "multiple", figureIds: ["own-0", "own-2"] });
    assert.equal(result.feature, "共通の四角"); assert.deepEqual(result.detailFigureIds, ["own-0", "own-2"]);
    assert.deepEqual(result.evidence.stages!.map(s => s.stage), ["action_target", "detail"]);
    assert.equal(result.evidence.model, JEV_DECISION_MODEL + "-20261014");
    assert.equal(result.evidence.costUsd, 0.0001 + 0.0002);
    assert.deepEqual(validateJevDecision(result, input), result);
    assert.throws(() => validateJevDecision({ ...result, detailFigureIds: ["own-1"] }, input), code("inconsistent_decision"));
    const forged = structuredClone(result); forged.evidence.stages![1].choices.feature = "feature_999";
    assert.throws(() => validateJevDecision(forged, input), code("invalid_response"));
    const missing = structuredClone(result); missing.evidence.stages!.pop();
    assert.throws(() => validateJevDecision(missing, input), code("invalid_response"));
  }
  assert.equal(http.requests.length, 4); assert.equal(client.callCount, 2);
});

test("reobservation subsets are nonempty and entirely within the exact first-stage candidates", async t => {
  let index = 0;
  const http = await httpMock(t, p => {
    const reply = answer(p, p.questions.action ? { action: "request_observation", target: "multiple", candidate_1: "include", candidate_3: "include", candidate_5: "include" } :
      { observe_targets: "subset_6", observe_aspect: "part" });
    reply.id = `gen-stage-${++index}`;
    if (!p.questions.action) {
      assert.deepEqual(Object.keys(p.questions), ["observe_targets", "observe_aspect"]);
      const sets = Object.values(p.questions.observe_targets.criteria).map(s => JSON.parse(s) as string[]);
      assert.equal(sets.length, 7);
      assert.ok(sets.every(ids => ids.length && ids.every(id => ["own-1", "own-3", "own-5"].includes(id))));
      assert.equal(Object.hasOwn(p.questions.observe_aspect.criteria, "none"), false);
    }
    return { body: reply };
  });
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide(fixture());
  assert.deepEqual(result.observe?.figureIds, ["own-1", "own-3", "own-5"]);
  assert.deepEqual(result.evidence.stages!.map(s => s.responseId), ["gen-stage-1", "gen-stage-2"]);
  assert.equal(result.evidence.responseId, "gen-stage-2");
  assert.deepEqual(validateJevDecision(result, fixture()), result);
});

test("second-stage failure preserves first-stage proof, charges both responses, and cannot publish or retry", async t => {
  const http = await httpMock(t, p => {
    const reply = answer(p, { action: "confirm", target: "figure_0" });
    if (!p.questions.action) reply.answers.feature.choice = "RAW_CANARY";
    return { body: { ...reply, extra: "PROMPT_CANARY" } };
  });
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(client.decide(fixture()), code("invalid_response"));
  const evidence = client.lastEvidence!;
  assert.equal(http.requests.length, 2); assert.equal(evidence.status, "error");
  assert.equal(evidence.costUsd, 0.0002); assert.equal(client.spentUsd, 0.0002);
  assert.equal(evidence.stages.length, 2); assert.equal(evidence.stages[0].status, "ok");
  assert.equal(evidence.stages[1].status, "error"); assert.equal(evidence.stages[1].error, "invalid_response");
  assert.equal(evidence.stages[0].choices.action, "confirm"); assert.deepEqual(evidence.stages[1].choices, {});
  assert.equal(evidence.rejectionCode, null); assert.doesNotMatch(JSON.stringify(evidence), /CANARY|SYNTHETIC/);
});

test("the observed-cost guard is checked again before stage two without another HTTP request", async t => {
  const http = await httpMock(t, p => ({ body: answer(p, { action: "confirm", target: "figure_0" }, JEV_DECISION_MODEL, 0.03) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(client.decide(fixture()), code("cost_cap"));
  assert.equal(http.requests.length, 1); assert.equal(client.spentUsd, 0.03);
  assert.equal(client.lastEvidence?.stages[0].status, "ok");
  assert.equal(client.lastEvidence?.stages[1].error, "cost_cap");
  assert.equal(client.lastEvidence?.stages[1].costUsd, null);
});

test("second-stage timeout and abort retain stage one; late data cannot alter evidence or costs", async () => {
  for (const aborted of [false, true]) {
    let release: (r: Response) => void = () => {};
    let secondPayload: JevDecisionPayload | undefined;
    let calls = 0;
    const controller = new AbortController();
    const client = createJevDecisionClient({ enabled: true, readKey, timeoutMs: 1000, fetchImpl: async (_url, init) => {
      const p = JSON.parse(init.body as string) as JevDecisionPayload;
      calls++;
      if (p.questions.action) return Response.json(answer(p, { action: "repair", target: "figure_0" }));
      secondPayload = p;
      const pending = new Promise<Response>(r => { release = r; });
      if (aborted) controller.abort("SECRET_CANARY");
      return pending;
    } })!;
    await assert.rejects(client.decide(fixture(), { signal: controller.signal }), code(aborted ? "aborted" : "timeout"));
    const before = client.lastEvidence;
    assert.equal(calls, 2); assert.equal(before?.stages[0].status, "ok");
    assert.equal(before?.stages[1].error, aborted ? "aborted" : "timeout");
    release(Response.json(answer(secondPayload!))); await nextLoop();
    assert.deepEqual(client.lastEvidence, before); assert.equal(client.spentUsd, 0.0001);
    await assert.rejects(client.decide(fixture()), code("cost_cap")); assert.equal(calls, 2);
  }
});

test("stage two uses a detached source snapshot and reports its own bounded input budget", async t => {
  const input = fixture(), original = structuredClone(input);
  input.repairHistory = Array.from({ length: 200 }, (_, i) => ({ turn: 1, issueId: `issue-${i}`, action: "confirm" as const,
    question: "確認".repeat(200), partnerClaims: [], candidatesBefore: ["own-0"], candidatesAfter: ["own-0"], addedClaimIds: [], removedClaimIds: [], progress: "unknown" as const }));
  const saved = structuredClone(input);
  const http = await httpMock(t, p => {
    if (p.questions.action) { input.ownSlots = ["MUTATION_CANARY"]; input.observations = { ...original.observations, figures: [] }; }
    assert.doesNotMatch(JSON.stringify(p), /MUTATION_CANARY/);
    return { body: answer(p, { action: "confirm", target: "figure_0" }) };
  });
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide(input);
  assert.equal(result.evidence.stages?.length, 2);
  for (const [i, stage] of result.evidence.stages!.entries()) {
    assert.equal(stage.inputBudget?.stateChars, http.requests[i].payload.state.length);
    assert.ok(stage.inputBudget!.stateChars <= 20000); assert.ok(stage.inputBudget!.omitted.repairHistory > 0);
  }
  assert.deepEqual(validateJevDecision(result, saved), result);
  const bad = structuredClone(result); bad.evidence.stages![1].inputBudget!.stateChars--;
  assert.throws(() => validateJevDecision(bad, saved), code("invalid_response"));
  const copy = client.lastEvidence!; copy.stages[0].choices.action = "close";
  assert.equal(client.lastEvidence?.stages[0].choices.action, "confirm");
});

test("a secret echo in stage two keeps only stage-one proof and halts unknown billable outcomes", async t => {
  const http = await httpMock(t, p => p.questions.action ? { body: answer(p, { action: "confirm", target: "figure_0" }) } :
    { raw: JSON.stringify({ ...answer(p), extra: KEY }).replace(KEY, "\\u0073" + KEY.slice(1)) });
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  await assert.rejects(client.decide(fixture()), code("key_leak"));
  assert.equal(http.requests.length, 2); assert.equal(client.lastEvidence?.stages[0].status, "ok");
  assert.equal(client.lastEvidence?.stages[1].error, "key_leak"); assert.deepEqual(client.lastEvidence?.stages[1].choices, {});
  assert.doesNotMatch(JSON.stringify(client.lastEvidence), /SYNTHETIC|extra|u0073/);
  await assert.rejects(client.decide(fixture()), code("cost_cap")); assert.equal(http.requests.length, 2);
});

test("human referent scores are a separate eight-label measurement, preserved without normalization or a winner", async t => {
  const input = fixture();
  let reads = 0;
  const raw = { figure_0: 0.8, figure_1: 0.8, figure_2: 0.1, figure_3: 0.1, figure_4: 0.1, figure_5: 0.1, none: 0.2, multiple: 0.4 };
  const http = await httpMock(t, p => {
    if (!p.questions.human_referent) return { body: answer(p, { action: "move_on", target: "figure_5" }) };
    assert.deepEqual(Object.keys(p.questions), ["human_referent"]);
    assert.equal(Object.keys(p.questions.human_referent.criteria).length, 8);
    const reply = answer(p, { human_referent: "multiple" }, JEV_DECISION_MODEL + "-20261014");
    reply.answers.human_referent.probabilities = raw;
    return { body: reply };
  });
  const client = createJevDecisionClient({ enabled: true, readKey: async () => { reads++; return KEY; }, fetchImpl: http.fetchImpl })!;
  const estimate = await client.estimateReferent(input);
  assert.equal(estimate.status, "ok"); assert.equal(estimate.calibrated, false);
  assert.deepEqual(estimate.scores, Object.fromEntries([...input.ownSlots.map((id, i) => [id, raw[`figure_${i}` as keyof typeof raw]]), ["none", 0.2], ["multiple", 0.4]]));
  assert.ok(Math.abs(Object.values(estimate.scores!).reduce((a, b) => a + b) - 1) > 1, "raw scores are not normalized");
  assert.equal(estimate.model, JEV_DECISION_MODEL + "-20261014");
  assert.equal(estimate.inputBudget?.stateChars, http.requests[0].payload.state.length);
  assert.equal(client.callCount, 0); assert.equal(client.referentCallCount, 1); assert.equal(client.lastEvidence, null);
  assert.deepEqual(validateHumanReferentEstimate(estimate, input), estimate);
  const saved = structuredClone(estimate);
  const result = await client.decide({ ...input, humanReferent: estimate });
  assert.deepEqual(result.target, { kind: "single", figureId: "own-5" });
  assert.equal(result.evidence.choices.target, "figure_5");
  assert.deepEqual(JSON.parse(http.requests[1].payload.state).humanReferent, { status: "ok", scores: estimate.scores });
  assert.deepEqual(estimate, saved); assert.deepEqual(client.lastReferentEvidence, saved);
  assert.equal(client.callCount, 1); assert.equal(client.referentCallCount, 1); assert.equal(reads, 1);
  assert.equal(client.spentUsd, 0.0002);
  estimate.scores!["own-0"] = 0;
  assert.equal(client.lastReferentEvidence?.scores?.["own-0"], 0.8);
});

test("missing, foreign, extra and out-of-range referent scores become unknown without completion", async t => {
  let patch: (r: ReturnType<typeof answer>) => unknown = r => r;
  const http = await httpMock(t, p => ({ body: patch(answer(p)) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const patches = [
    (r: ReturnType<typeof answer>) => { delete r.answers.human_referent.probabilities.figure_0; return r; },
    (r: ReturnType<typeof answer>) => { r.answers.human_referent.probabilities.figure_0 = -0.01; return r; },
    (r: ReturnType<typeof answer>) => { r.answers.human_referent.probabilities.figure_0 = 1.01; return r; },
    (r: ReturnType<typeof answer>) => { r.answers.human_referent.probabilities.figure_0 = NaN; return r; },
    (r: ReturnType<typeof answer>) => { r.answers.human_referent.probabilities.partner = 0.4; return r; },
    (r: ReturnType<typeof answer>) => { r.answers.human_referent.choice = "RAW_CANARY"; return r; },
    (r: ReturnType<typeof answer>) => ({ ...r, answers: {} }),
    (r: ReturnType<typeof answer>) => ({ ...r, model: "typesafe/jev-1.13" }),
  ];
  for (patch of patches) {
    const value = await client.estimateReferent(fixture());
    assert.equal(value.status, "unknown"); assert.equal(value.scores, null);
    assert.deepEqual(validateHumanReferentEstimate(value, fixture()), value);
    assert.doesNotMatch(JSON.stringify(value), /RAW_CANARY|SYNTHETIC|probabilities/);
  }
  assert.equal(http.requests.length, patches.length); assert.equal(client.callCount, 0);
  patch = r => r;
  assert.equal((await client.estimateReferent(fixture())).status, "ok");
  assert.equal((await client.decide(fixture())).action, "accept", "a known-cost invalid estimate does not block the action call");
});

test("referent transport errors and timeout become unknown; abort remains typed and late data stays detached", async t => {
  const http = await httpMock(t, () => ({ status: 503, raw: KEY + " PROMPT_CANARY" }));
  const failed = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const unknown = await failed.estimateReferent(fixture());
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.scores, null);
  assert.equal(unknown.model, null); assert.equal(unknown.responseId, null);
  assert.doesNotMatch(JSON.stringify(unknown), /CANARY|SYNTHETIC/);
  assert.equal((await failed.estimateReferent(fixture())).status, "unknown"); assert.equal(http.requests.length, 1);
  const noKey = createJevDecisionClient({ enabled: true, readKey: async () => { throw new Error(KEY + " PROMPT_CANARY"); } })!;
  assert.equal((await noKey.estimateReferent(fixture())).status, "unknown");
  let release: (r: Response) => void = () => {};
  const late = createJevDecisionClient({ enabled: true, readKey, timeoutMs: 5, fetchImpl: () => new Promise(r => { release = r; }) })!;
  const timed = await late.estimateReferent(fixture());
  assert.equal(timed.status, "unknown"); const snapshot = late.lastReferentEvidence;
  release(Response.json(answer(buildHumanReferentPayload(fixture())))); await nextLoop();
  assert.deepEqual(late.lastReferentEvidence, snapshot); assert.equal(late.spentUsd, 0);
  const controller = new AbortController(); controller.abort("SECRET_CANARY");
  await assert.rejects(late.estimateReferent(fixture(), { signal: controller.signal }), code("aborted"));
});

test("referent estimation and action decisions share the same cost stop rule", async t => {
  const http = await httpMock(t, p => ({ body: answer(p, {}, JEV_DECISION_MODEL, 0.03) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  assert.equal((await client.estimateReferent(fixture())).status, "ok");
  await assert.rejects(client.decide(fixture()), code("cost_cap"));
  assert.equal(client.spentUsd, 0.03); assert.equal(http.requests.length, 1);
  assert.equal((await client.estimateReferent(fixture())).status, "unknown"); assert.equal(http.requests.length, 1);
});

test("the referent validator rejects forged metadata, partial maps and unknown fields with fixed errors", async t => {
  const http = await httpMock(t);
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const value = await client.estimateReferent(fixture());
  const patches = [
    { status: "secret" }, { calibrated: true }, { scores: {} }, { scores: { ...value.scores, "own-0": Infinity } },
    { model: "LUNA_CANARY" }, { responseId: "RAW_CANARY" }, { costUsd: -1 }, { latencyMs: -1 },
    { inputBudget: null }, { raw: "PROMPT_CANARY" }, { status: "unknown" },
  ];
  for (const patch of patches) assert.throws(() => validateHumanReferentEstimate({ ...value, ...patch }, fixture()), (error: unknown) => {
    assert.ok(error instanceof JevDecisionError); assert.doesNotMatch(inspect(error, { showHidden: true }), /CANARY|SYNTHETIC|cause/); return true;
  });
  const copy = validateHumanReferentEstimate(value, fixture()); copy.scores!["own-0"] = 0.123;
  assert.notDeepEqual(copy.scores, value.scores);
});
