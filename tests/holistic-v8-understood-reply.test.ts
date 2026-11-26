// Audit 19 blocker: a reply that only says the question was understood must not confirm the figure for a later naming. Offline; no model call.
import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";
import type { Turn } from "./support/s4-v3-records.ts";

const first = OWN.ownAnchors[0].id as string;
const outline = "折れた棒に小さな輪がついています。";
const question = "そちらの輪にも途中に切れ目がありますか？";
const alias = "月枠";
const proposal = "「月枠」とかどう？";
const segment = (id: string, quote: string, aspect: string, targets: string[], name: string | null = null, respondsToTurn: number | null = null) =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn });
function check(questionAspect: string, targets: string[] = []): Turn {
  return { human: "輪のついた形を見比べたいです。", plan: {
    action: "confirm", target: "figure_0", referent: "figure_0", speech: outline + question,
    aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
      segment("s1", outline, "part", [first]), segment("s2", question, questionAspect, targets),
    ]),
  } };
}
function reply(human: string, aspect: string, act: "agree" | "acknowledge" = "agree"): Turn {
  return { human, plan: { action: "accept", target: "figure_0", referent: "figure_0", speech: "輪のある形の話ですね。",
    act, antecedent: "claim_1", extraction: JSON.stringify([segment("s1", human, aspect, [], null, 2)]) } };
}
// The human proposes a name without naming a figure.
const untargeted = (action: "agree" | "confirm"): Turn => ({ human: proposal, plan: {
  action, target: "figure_0", referent: "figure_0", name: alias, act: "name_propose",
  extraction: JSON.stringify([segment("s1", proposal, "name", [], alias)]),
  speech: action === "agree" ? "では「月枠」と呼びましょう。" : "輪が細い棒につながる形ですか？",
} });
const statuses = (record: any) => verifyRecords(record).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
const passed = ["pass", "pass", "pass", "pass"];

for (const label of ["bypass-enabled", "repair-first"] as const) {
  const modern = { label, dialoguePolicy: "holistic_v5", technicalTrial: { version: "adaptive_repair_v3" }, generationRetryVersion: "jev_generation_retry_v8" } as const;
  const agreed = async (turns: Turn[]) => {
    const record = await buildRecords({ ...modern, turns });
    assert.deepEqual(statuses(record), passed);
    return record.trials[0];
  };

  for (const [text, aspect, act] of [
    ["質問の意味は分かりました。", "part", "agree"],
    ["質問の意味は分かりました。", "part", "acknowledge"],
    ["ええ、分かりました。", "part", "agree"],
    ["ええ、分かりました。", "question", "agree"],
  ] as const) {
    test(`${label} keeps the naming open after "${text}" (${aspect}/${act}) answering an untargeted question`, async () => {
      const trial = await agreed([check(aspect === "question" ? "question" : "part"), reply(text, aspect, act), untargeted("confirm")]);
      assert.deepEqual(trial.lastCommittedState.judgments.at(-1).jevTurn.agreeNames, []);
      assert.equal(trial.lastCommittedState.ledger[first].name, null);
      // An agree judgment is not legal either: the decision is refused, so no turn names the figure.
      await assert.rejects(buildRecords({ ...modern, turns: [check(aspect === "question" ? "question" : "part"), reply(text, aspect, act), untargeted("agree")] }),
        { message: /decision_failed/u });
    });
  }

  for (const [text, aspect] of [["それそれ", "part"], ["そうそう！それ", "part"], ["それそれ", "question"], ["そうそう！それ", "question"]] as const) {
    test(`${label} still names after a pointing answer "${text}" to a ${aspect} question`, async () => {
      const trial = await agreed([check(aspect), reply(text, aspect), untargeted("agree")]);
      assert.equal(trial.lastCommittedState.ledger[first].name, alias);
      assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
    });
  }
}
