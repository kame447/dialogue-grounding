// Regression for the memory-ON reply failure: one stalled upstream call (seen
// live at ~85 s) failed the whole turn. Local mocks only; no paid request.
import test from "node:test";
import assert from "node:assert/strict";
import { AIConnectionError, createChatClient } from "../dialogue-model/runtime/client.mjs";
import { createLunaJudge, JUDGE_TIME_BUDGET_MS, JUDGE_MIN_RETRY_MS } from "../dialogue-model/runtime/judgment/luna.mjs";
import { createOwnLedger, SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";

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
  assert.deepEqual(judge.getDiagnostics().at(-1), { attempts: 2, fallback: true, failures: ["connection_timeout"], ...(memory ? { memoryFallback: false } : {}) });
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
    else assert.deepEqual(judge.getDiagnostics().at(-1)?.failures, ["invalid_json", "time_budget"]);
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
