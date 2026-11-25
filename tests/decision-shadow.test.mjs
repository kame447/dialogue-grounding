import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextLoop, setTimeout as pause } from "node:timers/promises";
import { buildDecisionEvidence } from "../dialogue-model/runtime/v2/decision-evidence.mjs";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createOwnLedger, SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createDecisionComparisonClient } from "../dialogue-model/runtime/decisions-client.mjs";
import { JUDGE_TIME_BUDGET_MS } from "../dialogue-model/runtime/judgment/luna.mjs";
import { assertSameBudget, stableOptions } from "./helpers/memory-harness.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const shadowResult = (purpose) => ({ model: purpose === "decision_jev" ? "typesafe/jev-1.14" : "openai/gpt-6-luna-decisions",
  action: "accept", probabilities: { accept: 1 }, usage: { inputTokens: 20, outputTokens: 86 }, provider: "synthetic", id: "synthetic-id" });
function directDialogue(options = {}) {
  const dialogue = createDialogueV2({ client: makeModel(), strategy: "repair-first",
    image: { mimeType: "image/png", base64: "c3ludGhldGlj" },
    anchors: Array.from({ length: 6 }, (_, i) => ({ id: `s-000${i + 1}`, bbox: { x: i, y: 0, width: 1, height: 1 }, centroid: { x: i, y: 0 } })),
    ...options });
  return dialogue;
}
const publicEvent = (text = "鳥でしょうか") => ({ id: "event-1", seq: 1, turn: 1, speaker: "human", text, at: "2026-01-01T00:00:00.000Z" });
const run = (dialogue, options = {}) => dialogue.runAiTurn({ events: [publicEvent()], lastEventId: "event-1",
  privateState: dialogue.initialPrivateState(), signal: new AbortController().signal, ...options });

const makeModel = () => ({
  async complete(_messages, { phase } = {}) {
    if (phase === "judgment") return { text: JSON.stringify(SAFE_JUDGMENT) };
    if (phase === "generation") return { text: "ええ、どんな形に見えますか。" };
    throw new Error("Unexpected phase");
  },
});

test("decision evidence includes only public turns and the AI's own uncertain notes", () => {
  const ledger = createOwnLedger();
  const original = {
    events: [{ speaker: "human", text: "鳥に見える", goldAnswer: "SECRET_GOLD_ANSWER" }],
    strategy: "bypass-enabled", ownLedger: ledger,
    judgment: { ...SAFE_JUDGMENT, note: "SECRET_PRIVATE_NOTE", answerKey: "SECRET_GOLD_ANSWER" },
  };
  const evidence = buildDecisionEvidence(original);
  const parsed = JSON.parse(evidence);
  assert.deepEqual(parsed.publicUtterances, [{ speaker: "相手", text: "鳥に見える" }]);
  assert.match(parsed.strategy, /保留/);
  assert.equal(parsed.aiUnverifiedHypothesis.certainty.includes("正解ではない"), true);
  assert.ok(!evidence.includes("SECRET_"));
  assert.ok(!evidence.includes("bypass-enabled"));
  assert.ok(!evidence.includes("goldAnswer"));
  assert.ok(!evidence.includes("answerKey"));
});

test("decision evidence enforces bounded public text, declared strategy, and known own slot", () => {
  const source = { events: [{ speaker: "ai", text: "形は似ています" }],
    ownLedger: createOwnLedger(), judgment: SAFE_JUDGMENT, strategy: "repair-first" };
  assert.throws(() => buildDecisionEvidence({ ...source, strategy: "invalid" }), /invalid_public_evidence/);
  assert.throws(() => buildDecisionEvidence({ ...source, events: [{ speaker: "human", text: "x".repeat(2001) }] }), /invalid_public_evidence/);
  assert.throws(() => buildDecisionEvidence({ ...source, judgment: { ...SAFE_JUDGMENT, targetSlot: "foreign-id" } }), /invalid_ai_hypothesis/);
  assert.throws(() => buildDecisionEvidence({ ...source, events: Array.from({length: 12}, () => ({speaker: "human", text: "x".repeat(2000)})) }), /decision_state_too_large/);
});

test("v2 shadow mode sends identical evidence to Jev and Luna without changing public replies", async () => {
  const requests = [];
  const comparison = { async chooseAction(args) {
    requests.push(args);
    return { model: args.purpose === "decision_jev" ? "typesafe/jev-1.14" : "openai/gpt-6-luna-decisions",
      action: "confirm", probabilities: { confirm: 0.9 }, usage: { inputTokens: 20 } };
  } };
  const task = await createNamingTaskV2({ client: makeModel(), strategy: "repair-first", seed: 225,
    runDir: "", decisionShadowClient: comparison });
  task.message("これ、鳥に見えませんか？");
  await task.whenIdle();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].state, requests[1].state);
  assert.deepEqual(requests.map((r) => r.purpose), ["decision_jev", "decision_luna"]);
  const state = task.getState();
  assert.equal(state.events.at(-1).text, "ええ、どんな形に見えますか。");
  assert.ok(!JSON.stringify(state).includes("decisionShadow"));
  const researcher = task.researcherView();
  assert.deepEqual(researcher.privateState.judgments[0].decisionShadow, { status: "pending" });
  assert.deepEqual(researcher.attempts[0].decisionShadow.map((x) => x.action), ["confirm", "confirm"]);
  assert.ok(researcher.attempts[0].decisionShadow.every((x) => x.status === "ok"));
  assert.ok(Object.values(researcher.privateState.ledger).every((x) => x.status === "unassigned"));
});

test("v2 decision failures do not interrupt the human conversation", async () => {
  const comparison = { async chooseAction({ purpose }) {
    if (purpose === "decision_jev") throw Object.assign(new Error("provider secret"), { code: "rate_limited" });
    return { model: "openai/gpt-6-luna-decisions", action: "accept", probabilities: { accept: 1 } };
  } };
  const task = await createNamingTaskV2({ client: makeModel(), strategy: "bypass-enabled", seed: 226,
    runDir: "", decisionShadowClient: comparison });
  task.message("どの図形からにしますか？");
  await task.whenIdle();
  assert.equal(task.getState().aiStatus, "idle");
  const diagnostic = task.researcherView().attempts[0].decisionShadow;
  assert.deepEqual(diagnostic[0], { purpose: "decision_jev", status: "error", error: "decision_unavailable" });
  assert.equal(diagnostic[1].action, "accept");
  assert.ok(!JSON.stringify(diagnostic).includes("provider secret"));
});

test("v2 does not call decision services by default", async () => {
  const task = await createNamingTaskV2({ client: makeModel(), strategy: "repair-first", seed: 227, runDir: "" });
  task.message("こんにちは");
  await task.whenIdle();
  assert.equal(task.researcherView().privateState.judgments[0].decisionShadow, undefined);
});

test("never-resolving shadow calls do not delay public generation or queue completion", async () => {
  let calls = 0;
  const comparison = { chooseAction() { calls++; return new Promise(() => {}); } };
  const dialogue = directDialogue({ decisionShadowClient: comparison });
  const result = await Promise.race([run(dialogue), nextLoop().then(() => "blocked")]);
  assert.notEqual(result, "blocked");
  assert.equal(result.text, "ええ、どんな形に見えますか。");
  assert.equal(calls, 2);
  assert.deepEqual(dialogue.getAttempts()[0].decisionShadow, { status: "pending" });
  const task = await createNamingTaskV2({ client: makeModel(), strategy: "repair-first", seed: 230, runDir: "", decisionShadowClient: comparison });
  task.message("鳥でしょうか");
  assert.equal(await Promise.race([task.whenIdle().then(() => "idle"), nextLoop().then(() => "blocked")]), "idle");
  assert.equal(task.getState().aiStatus, "idle");
});

test("abort during judge reaches the caller and starts neither generation nor shadow calls", async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController();
  let generationCalls = 0, shadowCalls = 0;
  const dialogue = directDialogue({ client: { async complete() { generationCalls++; return { text: "stale" }; } },
    judge: { judge() { started.resolve(); return gate.promise; } },
    decisionShadowClient: { chooseAction() { shadowCalls++; return new Promise(() => {}); } } });
  const result = run(dialogue, { signal: controller.signal });
  await started.promise; controller.abort(); gate.resolve(SAFE_JUDGMENT);
  await assert.rejects(result, (error) => error.name === "AbortError");
  assert.equal(generationCalls, 0);
  assert.equal(shadowCalls, 0);
});

test("late results update only attempts and notify research persistence once", async () => {
  const gate = deferred(), updated = deferred();
  let updates = 0;
  const dialogue = directDialogue({ decisionShadowClient: { async chooseAction({ purpose }) { await gate.promise; return shadowResult(purpose); } },
    onResearchUpdate() { updates++; updated.resolve(); } });
  const result = await run(dialogue);
  const committed = structuredClone(result.privateState);
  assert.deepEqual(dialogue.getAttempts()[0].decisionShadow, { status: "pending" });
  gate.resolve(); await updated.promise;
  const attempts = dialogue.getAttempts();
  assert.equal(updates, 1);
  assert.ok(attempts[0].decisionShadow.every((item) => item.status === "ok"));
  assert.equal(attempts[0].decisionShadow[0].usage.outputTokens, 86);
  assert.equal(attempts[0].decisionShadow[0].provider, "synthetic");
  assert.equal(attempts[0].decisionShadow[0].id, "synthetic-id");
  assert.deepEqual(result.privateState, committed, "late shadow cannot mutate queue candidates or committed judgments");
  attempts[0].decisionShadow[0].action = "changed";
  assert.equal(dialogue.getAttempts()[0].decisionShadow[0].action, "accept");
});

test("shadow rejection, synchronous throws and failing research callbacks cannot affect the turn", async () => {
  for (const chooseAction of [() => { throw new Error("PRIVATE-SHADOW-ERROR"); }, async () => { throw new Error("PRIVATE-SHADOW-ERROR"); }]) {
    for (const onResearchUpdate of [() => { throw new Error("PRIVATE-PERSIST-ERROR"); }, async () => { throw new Error("PRIVATE-PERSIST-ERROR"); }]) {
      const dialogue = directDialogue({ decisionShadowClient: { chooseAction }, onResearchUpdate });
      const result = await run(dialogue); await nextLoop();
      assert.equal(result.text, "ええ、どんな形に見えますか。");
      assert.ok(dialogue.getAttempts()[0].decisionShadow.every((item) => item.error === "decision_unavailable"));
      assert.doesNotMatch(JSON.stringify(dialogue.getAttempts()), /PRIVATE-/);
    }
  }
});

test("evidence failure is isolated synchronously and never calls a decision service", async () => {
  let calls = 0;
  const updated = deferred();
  const dialogue = directDialogue({ decisionShadowClient: { chooseAction() { calls++; throw new Error("must not call"); } },
    onResearchUpdate: () => updated.resolve() });
  const result = await run(dialogue, { events: [publicEvent("x".repeat(2001))] });
  await updated.promise;
  assert.equal(calls, 0);
  assert.equal(result.text, "ええ、どんな形に見えますか。");
  assert.ok(dialogue.getAttempts()[0].decisionShadow.every((item) => item.error === "evidence_unavailable"));
});

test("shadow on/off preserves text, ledger and complete chat-client call sequence across turns", async () => {
  const outcomes = [];
  for (const shadow of [false, true]) {
    const calls = [], model = makeModel();
    const dialogue = directDialogue({ client: { complete(messages, options) { calls.push(structuredClone({ messages, options })); return model.complete(messages, options); } },
      decisionShadowClient: shadow ? { chooseAction: () => new Promise(() => {}) } : null });
    const first = await run(dialogue);
    const second = await run(dialogue, { events: [publicEvent(), { ...publicEvent(first.text), id: "event-2", seq: 2, speaker: "ai" },
      { ...publicEvent("続けましょう"), id: "event-3", seq: 3 }], privateState: first.privateState, lastEventId: "event-3" });
    outcomes.push({ calls, firstText: first.text, text: second.text, ledger: second.privateState.ledger });
  }
  // Only judgment timeoutMs depends on the elapsed wall-clock budget.
  const stableOutcome = ({ calls, ...outcome }) => ({ ...outcome, calls: calls.map(({ options, ...call }) => ({ ...call,
    options: options.phase === "judgment" ? stableOptions(options) : options })) });
  assert.equal(JSON.stringify(stableOutcome(outcomes[0])), JSON.stringify(stableOutcome(outcomes[1])));
  outcomes[0].calls.forEach((call, index) => assertSameBudget(call.options, outcomes[1].calls[index].options, JUDGE_TIME_BUDGET_MS));
});

test("late shadow settlement automatically persists attempts without another task action", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-shadow-persist-")), gate = deferred();
  try {
    const task = await createNamingTaskV2({ client: makeModel(), strategy: "repair-first", seed: 231, runDir: dir,
      decisionShadowClient: { async chooseAction({ purpose }) { await gate.promise; return shadowResult(purpose); } } });
    task.message("鳥でしょうか"); await task.whenIdle();
    const [file] = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    const initial = JSON.parse(await readFile(join(dir, file), "utf8"));
    assert.deepEqual(initial.attempts[0].decisionShadow, { status: "pending" });
    gate.resolve();
    // Observe the background write without calling another task persistence API.
    let record = initial;
    for (let attempt = 0; attempt < 100 && !Array.isArray(record.attempts[0].decisionShadow); attempt++) {
      await pause(10);
      record = JSON.parse(await readFile(join(dir, file), "utf8"));
    }
    assert.ok(record.attempts[0].decisionShadow.every((item) => item.status === "ok"));
    assert.deepEqual(record.judgments[0].decisionShadow, { status: "pending" });
    assert.doesNotMatch(JSON.stringify(task.getState()), /decisionShadow|synthetic-id|outputTokens/);
  } finally { gate.resolve(); await rm(dir, { recursive: true, force: true }); }
});

test("decision client maps payment/rate errors without retaining an upstream body", async () => {
  for (const [status, code] of [[402, "payment_required"], [429, "rate_limited"], [502, "upstream_error"]]) {
    const client = createDecisionComparisonClient({ provider: "cloudflare", baseUrl: "https://research.test/v1", apiKey: "synthetic-token" },
      async () => new Response("PRIVATE-API-KEY", { status }));
    await assert.rejects(client.chooseAction({ purpose: "decision_jev", state: "公開発話" }), (error) => error.code === code && !error.message.includes("PRIVATE"));
  }
});
