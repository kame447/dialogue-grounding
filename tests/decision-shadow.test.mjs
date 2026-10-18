import test from "node:test";
import assert from "node:assert/strict";
import { buildDecisionEvidence } from "../dialogue-model/runtime/v2/decision-evidence.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createOwnLedger, SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";

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
  assert.deepEqual(researcher.privateState.judgments[0].decisionShadow.map((x) => x.action), ["confirm", "confirm"]);
  assert.ok(researcher.privateState.judgments[0].decisionShadow.every((x) => x.status === "ok"));
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
  const diagnostic = task.researcherView().privateState.judgments[0].decisionShadow;
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
