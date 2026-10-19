// Synthetic data, fake Keychain and loopback HTTP only. Never invoke a live model.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { setImmediate as nextLoop } from "node:timers/promises";
import { createJevDecisionClient, buildJevDecisionPayload, validateJevDecision, JEV_DECISION_MODEL, JevDecisionError } from "../dialogue-model/runtime/decision/jev-decision.ts";
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
      const selected = preferences[key] ?? (key === "action" ? "accept" : "none");
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
  assert.deepEqual(client.metadata, { decisionKind: "jev_local_test", calibrated: false, model: JEV_DECISION_MODEL, questionLayout: "joint_choices_v1" });
  await client.decide(fixture()); await client.decide(fixture());
  assert.equal(reads, 1); assert.equal(http.requests.length, 2);
  assert.equal(http.requests[0].authorization, "Bearer " + KEY);
});

test("Jev alone selects agree with a public name, and evidence contains complete raw choices and scores", async t => {
  const input = fixture();
  const http = await httpMock(t, p => ({ body: answer(p, { action: "agree", target: "figure_0", name_0: "name_1" }) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide({ ...input, lunaAction: "confirm" } as JevDecisionInput);
  assert.equal(result.action, "agree"); assert.equal(result.name, "船");
  assert.deepEqual(result.target, { kind: "single", figureId: "own-0" }); assert.equal(result.feature, null);
  assert.equal(result.observe, null); assert.equal(result.decisionKind, "jev_local_test"); assert.equal(result.calibrated, false);
  assert.equal(result.evidence.model, JEV_DECISION_MODEL); assert.equal(result.evidence.responseId, "gen-jev-decision");
  assert.equal(result.evidence.choices.action, "agree"); assert.equal(result.evidence.scores.action.agree, 1);
  assert.equal(Object.keys(result.evidence.choices).length, 16);
  assert.equal(result.evidence.inputBudget?.stateChars, http.requests[0].payload.state.length);
  assert.equal(result.evidence.inputBudget?.maxChars, 20000);
  assert.deepEqual(validateJevDecision(result, input), result);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|prompt|"publicTurns":\[/);
  assert.equal(client.lastEvidence?.status, "ok");
  assert.doesNotMatch(http.requests[0].payload.state, /lunaAction/);
});

test("request observation specifies one own figure and a visual issue, then a fresh decision uses the result", async t => {
  let second = false;
  const http = await httpMock(t, p => ({ body: answer(p, second ? { action: "repair", target: "figure_0", feature_0: "feature_2" } :
    { action: "request_observation", target: "multiple", observe_target: "figure_0", observe_aspect: "construal" }) }));
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
  assert.equal(Object.hasOwn(http.requests[1].payload.questions.action.criteria, "request_observation"), false);
  assert.match(http.requests[1].payload.state, /耳とは限らない/);
  assert.equal(client.callCount, 2);
});

test("only target-scoped name/feature answers are used; irrelevant answers cannot alter the selected act", async t => {
  let preferences = { action: "confirm", target: "figure_1", feature_1: "feature_0", name_0: "name_1", feature_0: "feature_1" };
  const http = await httpMock(t, p => ({ body: answer(p, preferences) }));
  const client = createJevDecisionClient({ enabled: true, readKey, fetchImpl: http.fetchImpl })!;
  const result = await client.decide(fixture());
  assert.equal(result.feature, "三角1"); assert.equal(result.name, null); assert.equal(result.action, "confirm");
  preferences = { ...preferences, action: "agree", target: "multiple" };
  await assert.rejects(client.decide(fixture()), code("inconsistent_decision"));
  assert.equal(client.lastEvidence?.status, "error"); assert.deepEqual(client.lastEvidence?.choices, {});
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
