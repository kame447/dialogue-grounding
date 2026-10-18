// Regression for the memory-ON reply failure: one stalled upstream call (seen
// live at ~85 s) failed the whole turn. Local mocks only; no paid request.
import test from "node:test";
import assert from "node:assert/strict";
import { AIConnectionError, createChatClient } from "../dialogue-model/runtime/client.mjs";
import { createLunaJudge, JUDGE_TIME_BUDGET_MS, JUDGE_MIN_RETRY_MS } from "../dialogue-model/runtime/judgment/luna.mjs";
import { createOwnLedger, SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { createDialogueV2, GENERATION_TIMEOUT_MS } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";

type Message = { role: string; content: unknown };
type Options = { phase?: string; timeoutMs?: number };
const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const config = { provider: "cloudflare", purpose: "dialogue_turn", apiKey: "k".repeat(40), baseUrl: "https://example.invalid/v1" };
const never = () => new Promise<never>(() => {});
const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: {} }), { headers: { "Content-Type": "application/json" } });

function judgeInput(memory: boolean) {
  return { version: 2, image, ownAnchors: anchors, strategy: "bypass-enabled" as const, ownLedger: createOwnLedger(ids),
    publicHistory: [{ role: "user" as const, content: "家みたいなのありますね" }],
    ...(memory ? { referenceContext: { graph: createReferenceGraph({ slots: ids }), turn: 2,
      publicTurns: [{ turn: 2, speaker: "human" as const, text: "家みたいなのありますね" }] } } : {}) };
}

test("client deadline holds even when fetchImpl ignores the abort signal (DO RPC adapter)", async () => {
  let sent = 0;
  const client = createChatClient({ ...config, timeoutMs: 20 }, async () => { sent++; return never(); });
  const t0 = Date.now();
  await assert.rejects(client.complete([{ role: "user", content: "x" }]), (error: AIConnectionError) => error.code === "timeout");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(sent, 1, "a timed-out POST is never replayed");
});

test("per-call timeoutMs only shortens the configured deadline", async () => {
  const client = createChatClient({ ...config, timeoutMs: 5000 }, async () => never());
  const t0 = Date.now();
  await assert.rejects(client.complete([{ role: "user", content: "x" }], { timeoutMs: 15 }), /timeout/u);
  assert.ok(Date.now() - t0 < 1000);
  const capped = createChatClient({ ...config, timeoutMs: 15 }, async () => never());
  await assert.rejects(capped.complete([{ role: "user", content: "x" }], { timeoutMs: 60000 }), /timeout/u);
  await assert.rejects(capped.complete([{ role: "user", content: "x" }], { timeoutMs: 0 }), /Invalid call timeout/u);
});

for (const memory of [false, true]) test(`a judge connection failure falls back once, without failing the turn (memory=${memory})`, async () => {
  const calls: Options[] = [];
  const judge = createLunaJudge({ async complete(_m: Message[], options: Options) { calls.push(options);
    throw new AIConnectionError("timeout"); } });
  const result = await judge.judge(judgeInput(memory));
  assert.deepEqual(result, { ...SAFE_JUDGMENT, ...(memory ? { reference: null } : {}) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, "judgment");
  assert.equal(calls[0].timeoutMs, JUDGE_TIME_BUDGET_MS);
  assert.deepEqual(judge.getDiagnostics().at(-1), { attempts: 1, fallback: true, failures: ["connection_timeout"], ...(memory ? { memoryFallback: false } : {}) });
});

test("non-connection errors still propagate", async () => {
  const judge = createLunaJudge({ async complete() { throw new Error("programming error"); } });
  await assert.rejects(judge.judge(judgeInput(false)), /programming error/u);
});

test("the validation retry gets the remaining budget, and is skipped when too little remains", async () => {
  for (const [elapsed, expectRetry] of [[10000, true], [JUDGE_TIME_BUDGET_MS - JUDGE_MIN_RETRY_MS + 1, false]] as const) {
    let clock = 0;
    const calls: Options[] = [];
    const judge = createLunaJudge({ async complete(_m: Message[], options: Options) {
      calls.push(options); clock += elapsed;
      return { text: calls.length === 1 ? "not json" : JSON.stringify(SAFE_JUDGMENT) };
    } }, { now: () => clock });
    assert.deepEqual(await judge.judge(judgeInput(false)), SAFE_JUDGMENT);
    assert.equal(calls.length, expectRetry ? 2 : 1);
    if (expectRetry) assert.equal(calls[1].timeoutMs, JUDGE_TIME_BUDGET_MS - elapsed);
    else assert.deepEqual(judge.getDiagnostics().at(-1), { attempts: 1, fallback: true, failures: ["invalid_json", "time_budget"] });
  }
});

test("budget options are validated", () => {
  const client = { async complete() { return { text: "{}" }; } };
  assert.throws(() => createLunaJudge(client, { timeBudgetMs: 0 }), /budget/u);
  assert.throws(() => createLunaJudge(client, { minRetryMs: 1.5 }), /budget/u);
});

test("memory ON: a stalled judge call still yields a public reply through the real client", async () => {
  let posts = 0;
  // The first POST (judge) stalls forever and ignores the signal, like the live RPC path.
  const client = createChatClient({ ...config, timeoutMs: 5000 }, async () => (++posts === 1 ? never() : ok("たしかに、家みたいな形がありますね。")));
  const dialogue = createDialogueV2({ client, strategy: "bypass-enabled", image, anchors, referenceMemory: true,
    judge: createLunaJudge(client, { timeBudgetMs: 30, minRetryMs: 10 }) });
  const events = [{ id: "event-1", seq: 1, speaker: "human", text: "家みたいなのありますね" }];
  const t0 = Date.now();
  const turn = await dialogue.runAiTurn({ events, lastEventId: "event-1", privateState: dialogue.initialPrivateState(), signal: new AbortController().signal });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(posts, 2);
  assert.equal(turn.text, "たしかに、家みたいな形がありますね。");
  const committed = turn.privateState.judgments.at(-1)!;
  assert.equal(committed.judgment.action, "accept");
  assert.deepEqual(committed.validation.failures, ["connection_timeout"]);
  assert.deepEqual(turn.privateState.ledger, createOwnLedger(ids));
});

// Generation bound (follow-up): one retry only for a stall or a pre-response failure.
function scriptedGeneration(failures: Array<AIConnectionError | null>) {
  const generation: Options[] = [];
  const client = { async complete(_m: Message[], options: Options = {}) {
    if (options.phase !== "generation") return { text: JSON.stringify(SAFE_JUDGMENT) };
    generation.push(options);
    const failure = failures[generation.length - 1];
    if (failure) throw failure;
    return { text: "家みたいな形がありますね。" };
  } };
  return { client, generation };
}
const failureOf = (code: string, preResponse: boolean, status?: number) =>
  Object.assign(new AIConnectionError(code, status), { preResponse });
const humanEvents = [{ id: "event-1", seq: 1, speaker: "human", text: "家みたいなのありますね" }];
async function turn(client: { complete(m: Message[], o?: Options): Promise<{ text: string }> }) {
  const dialogue = createDialogueV2({ client, strategy: "repair-first", image, anchors, referenceMemory: true });
  const run = dialogue.runAiTurn({ events: humanEvents, lastEventId: "event-1", privateState: dialogue.initialPrivateState(), signal: new AbortController().signal });
  return { run, attempts: () => dialogue.getAttempts() };
}

for (const [name, failure] of [["timeout", failureOf("timeout", false)], ["pre-response network", failureOf("network_error", true)]] as const) {
  test(`generation: a ${name} failure gets exactly one retry with the bounded deadline`, async () => {
    const { client, generation } = scriptedGeneration([failure]);
    const { run, attempts } = await turn(client);
    const result = await run;
    assert.equal(result.text, "家みたいな形がありますね。");
    assert.deepEqual(generation.map((o) => o.timeoutMs), [GENERATION_TIMEOUT_MS, GENERATION_TIMEOUT_MS]);
    assert.equal(result.privateState.judgments.at(-1)!.generationRetried, true);
    assert.equal(attempts().at(-1)!.errorCode, undefined);
  });
}

test("generation: a post-response HTTP failure is not replayed; the trace keeps only sanitized fields", async () => {
  const { client, generation } = scriptedGeneration([failureOf("provider_http_error", false, 502)]);
  const { run, attempts } = await turn(client);
  await assert.rejects(run, /provider_http_error/u);
  assert.equal(generation.length, 1);
  const trace = attempts().at(-1)!;
  assert.equal(trace.errorCode, "provider_http_error");
  assert.equal(trace.errorPhase, "generation");
  assert.equal(trace.errorStatus, 502);
  assert.ok(Number.isInteger(trace.errorElapsedMs) && trace.errorElapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(trace), /AI connection failed|stack/u);
});

test("generation: two stalls fail the turn as before (participant can retry)", async () => {
  const { client, generation } = scriptedGeneration([failureOf("timeout", false), failureOf("timeout", false)]);
  const { run, attempts } = await turn(client);
  await assert.rejects(run, /timeout/u);
  assert.equal(generation.length, 2);
  assert.equal(attempts().at(-1)!.errorCode, "timeout");
});

test("judgment-phase errors are tagged without their message", async () => {
  const client = { async complete() { throw Object.assign(new Error("PRIVATE raw upstream body"), { code: "Not A Code!" }); } };
  const { run, attempts } = await turn(client);
  await assert.rejects(run);
  const trace = attempts().at(-1)!;
  assert.equal(trace.errorCode, "error");
  assert.equal(trace.errorPhase, "judgment");
  assert.equal(trace.errorStatus, null);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE/u);
});

test("the naming task records both generation attempts in requests, with codes", async () => {
  const { client } = scriptedGeneration([failureOf("timeout", false)]);
  const records: Array<{ requests: Array<{ kind: string; status: string; errorCode?: string }> }> = [];
  const task = await createNamingTaskV2({ client, seed: 5151, strategy: "bypass-enabled", referenceMemory: true, runDir: null,
    onPersist: async (record: never) => { records.push(structuredClone(record)); } });
  task.message("家みたいなのありますね", "c-1");
  await task.whenIdle();
  await task.persistNow();
  const generation = records.at(-1)!.requests.filter((r) => r.kind === "generation");
  assert.deepEqual(generation.map((r) => [r.status, r.errorCode ?? null]), [["error", "timeout"], ["ok", null]]);
});
