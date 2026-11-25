import assert from "node:assert/strict";
import test from "node:test";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";
import type { Turn } from "./support/s4-v3-records.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";

const [first, other] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const name = "絵筆";
const proposal = "この形の呼び名は「絵筆」でいいですか？";
const checkedDescription = "角の丸い輪に短い棒がつながっていますね。";
const affirmed = "はい、角の丸い輪に短い棒がつながっています。";
const span = (quote: string, aspect: "part" | "name", targets: string[], carriedName: string | null = null) =>
  JSON.stringify([{ segmentId: "s1", quote, proposition: quote, name: carriedName, targets, aspect, linkedIssueId: null, respondsToTurn: null }]);

const singleDescription: Turn = {
  human: "細い部品と輪の形を見比べたいです。",
  plan: { action: "confirm", target: "figure_0", referent: "figure_0", speech: checkedDescription,
    aiExtraction: span(checkedDescription, "part", [first]) },
};
const distinctAnswer: Turn = {
  human: affirmed,
  plan: { action: "accept", target: "figure_0", referent: "figure_0", speech: "輪と棒のつながりで見分けられますね。",
    act: "agree", antecedent: "claim_0", extraction: span(affirmed, "part", [first]) },
};
const ambiguous: Turn = {
  human: "輪がある形が二つあって、どちらのことか分かりません。",
  plan: { action: "confirm", target: "figures_0_1", referent: "multiple", speech: checkedDescription,
    aiExtraction: span(checkedDescription, "part", [first, other]) },
};
function lastTurn(slot: string, action: "confirm" | "agree", target: string, referent: string): Turn {
  return { human: proposal, plan: {
    action, target, referent, act: "name_propose", extraction: span(proposal, "name", [slot], name),
    ...(action === "agree" ? { name, speech: "はい、「絵筆」と呼びましょう。" } : { speech: "輪と短い棒が続く形ですか？" }),
  } };
}
const checks = (record: any) => verifyRecords(record).checks
  .filter(check => /^intervention\.trial\.0\.attempt\.0\./u.test(check.id)).map(check => check.status);

for (const label of ["bypass-enabled", "repair-first"] as const) {
  for (const [scenario, history, extracted, extractedLabel] of [
    ["extractor jumps from the checked figure", [singleDescription, distinctAnswer], other, "figure_1"],
    ["the naming question follows an unresolved pair", [ambiguous], first, "figure_0"],
  ] as const) {
    test(label + ": " + scenario, async () => {
      const common = { label, dialoguePolicy: "holistic_v5" as const,
        technicalTrial: { version: "adaptive_repair_v3" as const }, generationRetryVersion: "jev_generation_retry_v5" as const };
      const v1 = await buildRecords({ ...common, agreeNameScopeVersion: "scoped_v1",
        turns: [...history, lastTurn(extracted, "agree", extractedLabel, "figure_0")] });
      const v2 = await buildRecords({ ...common, agreeNameScopeVersion: "scoped_v2",
        turns: [...history, lastTurn(extracted, "confirm", "figure_0", "figure_0")] });
      assert.deepEqual(checks(v1), ["pass", "pass", "pass", "pass"]);
      assert.deepEqual(checks(v2), ["pass", "pass", "pass", "pass"]);
      assert.equal(v1.trials[0].lastCommittedState.ledger[extracted].status, "agreed");
      const trial = v2.trials[0], trace = trial.attempts[0], committed = trial.lastCommittedState.judgments.at(-1);
      assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
      assert.deepEqual(trace.local.claims.find((claim: any) => claim.act === "name_propose").targets, [extracted]);
      assert.equal(trace.namingRequest, true);
      assert.equal(trace.executed.action, "confirm");
      assert.deepEqual(committed.jevTurn.agreeNames, []);
      assert.deepEqual(trial.lastCommittedState.ledger, trial.replay[0].tape.state.ledger);
      const forged = structuredClone(v2);
      const legacyNames = v1.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames;
      for (const state of [forged.trials[0].lastCommittedState, forged.trials[0].turns[0].state]) {
        state.judgments.at(-1).jevTurn.agreeNames = legacyNames;
      }
      assert.equal(checks(forged).at(-1), "mismatch");
      for (const side of trial.replay[0].result.sides) {
        const choices = side.requests.find((request: any) => request.payload?.questions?.action).payload.questions.action.criteria;
        assert.ok(Object.hasOwn(choices, "confirm"));
        assert.ok(!Object.hasOwn(choices, "agree"));
      }
    });
  }

  test(label + ": a publicly checked figure still permits an agreement", async () => {
    const records = await buildRecords({ label, dialoguePolicy: "holistic_v5", generationRetryVersion: "jev_generation_retry_v5",
      technicalTrial: { version: "adaptive_repair_v3" }, agreeNameScopeVersion: "scoped_v2",
      turns: [singleDescription, distinctAnswer, lastTurn(first, "agree", "figure_0", "figure_0")] });
    const trial = records.trials[0], committed = trial.lastCommittedState.judgments.at(-1);
    assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
    assert.deepEqual(committed.jevTurn.agreeNames, [{ figureId: first, name, sourceTurn: 5 }]);
    assert.deepEqual(trial.lastCommittedState.ledger[first], { name, status: "agreed" });
    assert.deepEqual(checks(records), ["pass", "pass", "pass", "pass"]);
  });

  test(label + ": a corroborated public description supports a direct name proposal", async () => {
    const records = await buildRecords({ label, dialoguePolicy: "holistic_v5", generationRetryVersion: "jev_generation_retry_v5",
      technicalTrial: { version: "adaptive_repair_v3" }, agreeNameScopeVersion: "scoped_v2",
      turns: [singleDescription, lastTurn(first, "agree", "figure_0", "figure_0")] });
    const trial = records.trials[0];
    assert.deepEqual(trial.lastCommittedState.judgments.at(-1).jevTurn.agreeNames, [{ figureId: first, name, sourceTurn: 3 }]);
    assert.deepEqual(trial.lastCommittedState.ledger[first], { name, status: "agreed" });
    assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
    assert.deepEqual(checks(records), ["pass", "pass", "pass", "pass"]);
  });
}
