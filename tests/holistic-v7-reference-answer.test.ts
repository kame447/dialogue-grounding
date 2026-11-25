import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";
import type { Turn } from "./support/s4-v3-records.ts";

const [first, second] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const outline = "曲がった棒に細い輪がついています。";
const question = "見比べているのはこの図形でしょうか？";
const alias = "小さな鍵";
const proposal = "この図形は「小さな鍵」と呼んでもいいですか？";
const segment = (segmentId: string, quote: string, aspect: string, targets: string[], name: string | null = null, respondsToTurn: number | null = null) =>
  ({ segmentId, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn });

function publicCheck(figure = first): Turn {
  return { human: "輪のある図形のことを相談しましょう。", plan: {
    action: "confirm", target: "figure_0", referent: "figure_0", speech: outline + question,
    aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
      segment("s1", outline, "part", [figure]), segment("s2", question, "question", []),
    ]),
  } };
}
function acknowledgment(human: string, { targets = [] as string[], antecedent = "claim_1", respondsToTurn = 2 } = {}): Turn {
  return { human, plan: {
    action: "accept", target: "figure_0", referent: "figure_0", speech: "輪の形を見比べています。",
    act: "agree", antecedent, extraction: JSON.stringify([segment("s1", human, "referent", targets, null, respondsToTurn)]),
  } };
}
function naming(action: "agree" | "confirm"): Turn {
  return { human: proposal, plan: {
    action, target: "figure_0", referent: "figure_0", name: alias, act: "name_propose",
    extraction: JSON.stringify([segment("s1", proposal, "name", [first], alias)]),
    speech: action === "agree" ? "では「小さな鍵」と呼びましょう。" : "輪が細い棒につながる形ですか？",
  } };
}
const outcomes = (record: any) => verifyRecords(record).checks.filter(check =>
  /^intervention\.trial\.0\.attempt\.0\./u.test(check.id)).map(check => check.status);

for (const label of ["bypass-enabled", "repair-first"] as const) {
  const common = { label, dialoguePolicy: "holistic_v5", technicalTrial: { version: "adaptive_repair_v3" } } as const;
  const modern = { ...common, generationRetryVersion: "jev_generation_retry_v7" } as const;
  const human = "はい、これです。";
  test(label + " persists the linked figure answer, then makes the name available", async () => {
    const throughAnswer = await buildRecords({ ...modern, turns: [publicCheck(), acknowledgment(human)] });
    const trial = throughAnswer.trials[0];
    assert.deepEqual(outcomes(throughAnswer), ["pass", "pass", "pass", "pass"]);
    const saved = trial.lastCommittedState;
    const asked = saved.graph.records.find((claim: any) => claim.quote === question);
    const reply = trial.attempts[0].local.claims.find((claim: any) => claim.quote === human);
    assert.equal(saved.agreeNameScopeVersion, "scoped_v4");
    assert.deepEqual([reply.act, reply.targets, reply.respondsTo], ["agree", [first], asked.id]);
    assert.equal(saved.ledger[first].name, null);
    assert.deepEqual(saved.judgments.at(-1).jevTurn.agreeNames, []);
    assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
    const mixed = structuredClone(throughAnswer);
    mixed.trials[0].replay[0].tape.state.agreeNameScopeVersion = "scoped_v3";
    mixed.trials[0].turns[0].state.agreeNameScopeVersion = "scoped_v3";
    mixed.trials[0].lastCommittedState.agreeNameScopeVersion = "scoped_v3";
    assert.equal(outcomes(mixed).at(-1), "mismatch");

    const named = await buildRecords({ ...modern, turns: [publicCheck(), acknowledgment(human), naming("agree")] });
    assert.deepEqual(outcomes(named), ["pass", "pass", "pass", "pass"]);
    const established = named.trials[0];
    assert.deepEqual(established.lastCommittedState.ledger[first], { name: alias, status: "agreed" });
    assert.deepEqual(established.lastCommittedState.judgments.at(-1).jevTurn.agreeNames, [{ figureId: first, name: alias, sourceTurn: 5 }]);
    assert.equal(established.replay[0].result.recordedPayloadsReproduced, true);

    const historical = await buildRecords({ ...common, generationRetryVersion: "jev_generation_retry_v6",
      turns: [publicCheck(), acknowledgment(human), naming("confirm")] });
    assert.deepEqual(outcomes(historical), ["pass", "pass", "pass", "pass"]);
    assert.equal(historical.trials[0].lastCommittedState.agreeNameScopeVersion, "scoped_v3");
    assert.deepEqual(historical.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames, []);
  });

  for (const [reason, check, reply] of [
    ["a general backchannel typed as agree", publicCheck(), acknowledgment("ええ、分かりました。")],
    ["a conflicting public description", publicCheck(second), acknowledgment(human)],
    ["a conflicting extracted human target", publicCheck(), acknowledgment(human, { targets: [second] })],
    ["an extracted reply to an older turn", publicCheck(), acknowledgment(human, { respondsToTurn: 1 })],
  ] as const) {
    test(label + " keeps the naming proposal pending after " + reason, async () => {
      const records = await buildRecords({ ...modern, turns: [check, reply, naming("confirm")] });
      assert.deepEqual(outcomes(records), ["pass", "pass", "pass", "pass"]);
      assert.equal(records.trials[0].lastCommittedState.ledger[first].name, null);
      assert.deepEqual(records.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames, []);
    });
  }
}
