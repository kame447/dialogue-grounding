// Audit 20 blocker: a target the program bound to a targetless question must not reach a reply that did not pass the direct pointing check,
// whatever the act and however many turns later. Synthetic wording only; no model call.
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
const check = (questionAspect: string): Turn => ({ human: "輪のついた形を見比べたいです。", plan: {
  action: "confirm", target: "figure_0", referent: "figure_0", speech: outline + question, aiActs: ["assert", "ask"],
  aiExtraction: JSON.stringify([segment("s1", outline, "part", [first]), segment("s2", question, questionAspect, [])]) } });
// An exchange between the question and the reply: the human asks for time (assert/progress), the AI waits.
const pause: Turn = { human: "少し考えさせてください。", plan: { action: "accept", target: "figure_0", referent: "figure_0", speech: "ええ、ゆっくりどうぞ。",
  extraction: JSON.stringify([segment("s1", "少し考えさせてください。", "progress", [])]) } };
const reply = (human: string, aspect: string, act: string, respondsToTurn: number | null): Turn => ({ human, plan: { action: "accept", target: "figure_0", referent: "figure_0", speech: "輪のある形の話ですね。",
  act, antecedent: "claim_1", extraction: JSON.stringify([segment("s1", human, aspect, [], null, respondsToTurn)]) } });
const untargeted: Turn = { human: proposal, plan: { action: "confirm", target: "figure_0", referent: "figure_0", name: alias, act: "name_propose",
  extraction: JSON.stringify([segment("s1", proposal, "name", [], alias)]), speech: "輪が細い棒につながる形ですか？" } };
const statuses = (record: any) => verifyRecords(record).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
const passed = ["pass", "pass", "pass", "pass"];

for (const label of ["bypass-enabled", "repair-first"] as const) {
  const build = (version: string | undefined, turns: Turn[]) =>
    buildRecords({ label, dialoguePolicy: "holistic_v5", technicalTrial: { version: "adaptive_repair_v3" }, ...(version ? { generationRetryVersion: version as any } : {}), turns });
  const candidates = async (version: string | undefined, turns: Turn[]) => {
    const record = await build(version, [...turns, untargeted]);
    assert.deepEqual(statuses(record), passed);
    return record.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames;
  };
  const fillers: [string, Turn[]][] = [
    ["right after", [check("part"), reply("質問の意味は分かりました。", "part", "agree", 2)]],
    ["one exchange later", [check("part"), pause, reply("質問の意味は分かりました。", "part", "agree", 2)]],
    ["right after, an assertion that names no figure", [check("part"), reply("質問の意味は分かりました。", "part", "assert", 2)]],
    ["one exchange later, a plain acknowledgement", [check("part"), pause, reply("質問の意味は分かりました。", "part", "acknowledge", 2)]],
    ["one exchange later, an assertion that names no figure", [check("part"), pause, reply("質問の意味は分かりました。", "part", "assert", 2)]],
  ];
  for (const [when, turns] of fillers) {
    test(`${label}: ${when}, a reply that only says the question was understood leaves a v9 trial unnamed`, async () => {
      assert.deepEqual(await candidates(undefined, turns), []);
    });
  }
  test(`${label}: a v8 record keeps the judgment it was recorded with (the same reply one exchange later is still taken as an answer)`, async () => {
    const later = fillers[1][1];
    assert.equal((await candidates("jev_generation_retry_v8", later)).length, 1);
  });
  for (const [quote, aspect] of [["それそれ", "part"], ["そうそう！それ", "part"], ["それそれ", "question"]] as const) {
    test(`${label}: a pointing answer "${quote}" (${aspect}) right after the question still lets a later human proposal be agreed in a v9 trial`, async () => {
      const turns = [check(aspect), reply(quote, aspect, "agree", 2)];
      assert.equal((await candidates(undefined, turns)).length, 1);
    });
  }
}
