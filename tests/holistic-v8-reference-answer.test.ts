import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { validAgreeNameScope } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { directsToFigure } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";
import type { Turn } from "./support/s4-v3-records.ts";

const first = OWN.ownAnchors[0].id as string;
const outline = "折れた棒に小さな輪がついています。";
const question = "指しているのはこの図形でしょうか？";
const alias = "小さな鍵";
const askName = "この図形は「小さな鍵」と呼んでもいいですか？";
const segment = (id: string, quote: string, aspect: string, targets: string[], name: string | null = null, respondsToTurn: number | null = null) =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn });
function check(targets: string[]): Turn {
  return { human: "輪のついた形を見比べたいです。", plan: {
    action: "confirm", target: "figure_0", referent: "figure_0", speech: outline + question,
    aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
      segment("s1", outline, "part", [first]), segment("s2", question, "question", targets),
    ]),
  } };
}
function answer(human: string, aspect: string, targets: string[] = [first]): Turn {
  return { human, plan: { action: "accept", target: "figure_0", referent: "figure_0", speech: "輪のある形の話ですね。",
    act: "agree", antecedent: "claim_1", extraction: JSON.stringify([segment("s1", human, aspect, targets, null, 2)]) } };
}
function name(action: "agree" | "confirm"): Turn {
  return { human: askName, plan: {
    action, target: "figure_0", referent: "figure_0", name: alias, act: "name_propose",
    extraction: JSON.stringify([segment("s1", askName, "name", [first], alias)]),
    speech: action === "agree" ? "では「小さな鍵」と呼びましょう。" : "輪が細い棒につながる形ですか？",
  } };
}
const statuses = (record: any) => verifyRecords(record).checks.filter(check =>
  /^intervention\.trial\.0\.attempt\.0\./u.test(check.id)).map(check => check.status);
const passed = ["pass", "pass", "pass", "pass"];

test("the v8 and v7 naming scopes are isolated", () => {
  assert.equal(validAgreeNameScope("scoped_v5", "jev_generation_retry_v8"), true);
  assert.equal(validAgreeNameScope("scoped_v4", "jev_generation_retry_v7"), true);
  assert.equal(validAgreeNameScope("scoped_v4", "jev_generation_retry_v8"), false);
  assert.equal(validAgreeNameScope("scoped_v5", "jev_generation_retry_v7"), false);
});

test("v8 distinguishes pointed short affirmatives from a bare backchannel", () => {
  // Ordinary speech forms recovered from the two independent linguistic controls.
  for (const quote of ["それそれ", "そうそう！それ", "そうそう! それ。", "そうそう、それ", "それそれ!", "はい！この形です。"]) {
    assert.equal(directsToFigure(quote, true), true, quote);
  }
  for (const quote of ["はい", "うん！", "ええ、分かりました。", "そうそう！", "それでいい？"]) {
    assert.equal(directsToFigure(quote, true), false, quote);
  }
  for (const quote of ["それそれ", "そうそう！それ"]) assert.equal(directsToFigure(quote), false, quote);
});

for (const label of ["bypass-enabled", "repair-first"] as const) {
  const common = { label, dialoguePolicy: "holistic_v5", technicalTrial: { version: "adaptive_repair_v3" } } as const;
  const modern = { ...common, generationRetryVersion: "jev_generation_retry_v8" } as const;
  for (const [aspect, asked, quote] of [
    ["referent", [first], "そうそう！それ"],
    ["part", [], "それそれ"],
    ["question", [], "はい、その形です。"],
  ] as const) {
    test(label + " accepts the pointed answer for " + aspect, async () => {
      const history = [check([...asked]), answer(quote, aspect)];
      const verified = await buildRecords({ ...modern, turns: history });
      assert.deepEqual(statuses(verified), passed);
      const answered = verified.trials[0];
      const checkId = answered.lastCommittedState.graph.records.find((entry: any) => entry.quote === question).id;
      const reply = answered.attempts[0].local.claims.find((claim: any) => claim.quote === quote);
      assert.deepEqual([reply.respondsTo, reply.aspect, reply.act, reply.targets], [checkId, "question", "agree", [first]]);
      assert.equal(answered.lastCommittedState.ledger[first].name, null);
      assert.equal(answered.lastCommittedState.agreeNameScopeVersion, "scoped_v5");
      assert.equal(answered.replay[0].result.recordedPayloadsReproduced, true);

      const named = await buildRecords({ ...modern, turns: [...history, name("agree")] });
      const trial = named.trials[0];
      assert.deepEqual(statuses(named), passed);
      assert.deepEqual(trial.lastCommittedState.ledger[first], { name: alias, status: "agreed" });
      assert.deepEqual(trial.lastCommittedState.judgments.at(-1).jevTurn.agreeNames, [{ figureId: first, name: alias, sourceTurn: 5 }]);
      assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
    });
  }

  for (const [act, speech, antecedent, source] of [
    ["deny", "その図形のことではありませんでした。", "claim_1", 2],
    ["ask", "同じ図形か、もう一度確かめられますか？", "claim_1", 2],
    ["withdraw", "さっきの返事は取り消します。", "claim_2", 3],
  ] as const) {
    test(label + " stops using an earlier pointing answer after " + act, async () => {
      const correction: Turn = { human: speech, plan: {
        action: "accept", target: "figure_0", referent: "figure_0", speech: "輪のところを見比べますね。",
        act, antecedent, extraction: JSON.stringify([segment("s1", speech, "part", [first], null, source)]),
      } };
      const history = [check([]), answer("はい、その形です。", "part"), correction];
      const proof = await buildRecords({ ...modern, turns: history });
      assert.deepEqual(statuses(proof), passed);
      assert.ok(proof.trials[0].attempts[0].local.claims.some((claim: any) => claim.act === act && claim.respondsTo));
      const record = await buildRecords({ ...modern, turns: [...history, name("confirm")] });
      assert.deepEqual(statuses(record), passed);
      assert.deepEqual(record.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames, []);
      assert.equal(record.trials[0].lastCommittedState.ledger[first].name, null);
    });
  }

  test(label + " leaves a same-aspect backchannel unconfirmed", async () => {
    const context = [check([first]), answer("うん！", "question")];
    const record = await buildRecords({ ...modern, turns: [...context, name("confirm")] });
    assert.deepEqual(statuses(record), passed);
    assert.deepEqual(record.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames, []);
  });
}
