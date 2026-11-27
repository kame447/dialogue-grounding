import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { interventionChecks } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";

const options = {
  dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3", judgmentMaterialVersion: "jev_repair_quality_v1",
  technicalTrial: { version: "adaptive_repair_v3" }, generationRetryVersion: "jev_generation_retry_v23", agreeNameScopeVersion: "jev_naming_v3",
} as const;
const replayCheck = (records: Awaited<ReturnType<typeof buildRecords>>) => interventionChecks(records).find(check => check.id.endsWith(".replay"));
function rewriteComparison(records: Awaited<ReturnType<typeof buildRecords>>, index: number, edit: (messages: { role: string; content: string }[]) => void) {
  for (const side of [records.trials[0].replay[0].result.sides[1], records.evidence.pairedReplay[0].right]) {
    const request = side.requests.filter((entry: { phase: string }) => entry.phase === "generation")[index];
    assert.ok(request);
    edit(request.payload.messages);
    request.payloadSha256 = hash(request.payload);
    request.preProjectionPayloadSha256 = hash(request.payload);
    request.completeMessagesSha256 = hash(request.payload.messages);
  }
}

test("v23 S4 verifies the single plan, full retry restatement and new instruction source", async () => {
  const records = await buildRecords({ ...options, figureCount: 4, turns: [{ human: "切り込みをもう少し見比べたいです。", plan: {
    action: "accept", target: "none",
    drafts: ["この図形をいったん置いて、次のを見よう。", "切り込みをもう少し見比べましょう。"],
    choose: (key, _criteria, { generationCalls }) => key === "draft_topic_shift"
      ? generationCalls === 1 ? "unsupported_shift" : "within_plan"
      : key === "human_move_on_source" ? "other" : key === "commitment_state" ? "not_due" : undefined,
  } }] });
  const baseline = replayCheck(records);
  assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
  const comparison = records.trials[0].replay[0].result.sides[1];
  const [initial, retry] = comparison.requests.filter((entry: { phase: string }) => entry.phase === "generation");
  assert.ok(initial.payload.messages[2].content.startsWith("以下の計画に従って発話してください。\n"));
  assert.ok(retry.payload.messages.at(-1).content.includes(initial.payload.messages[2].content));

  const truncated = structuredClone(records);
  rewriteComparison(truncated, 1, messages => {
    messages.at(-1)!.content = messages.at(-1)!.content.replace("以下の計画に従って発話してください。\n", "");
  });
  assert.equal(replayCheck(truncated)?.status, "mismatch");

  const changedRule = structuredClone(records);
  for (const index of [0, 1]) rewriteComparison(changedRule, index, messages => {
    messages[1].content = messages[1].content.replace("repair の行動（複数の扱いでは repair の部分）だけ", "どの行動でも");
  });
  assert.equal(replayCheck(changedRule)?.status, "mismatch");

  const incomplete = structuredClone(records);
  const source = "v2/generation-prompt-v23.ts";
  assert.match(incomplete.run.promptSources.files[source], /^[a-f0-9]{64}$/u);
  delete incomplete.run.promptSources.files[source];
  incomplete.trials[0].identity.prompts = hash(incomplete.run.promptSources);
  assert.equal(replayCheck(incomplete)?.status, "mismatch");
});

test("v23 S4 reprojects multipart actions and refuses a replaced target", async () => {
  const first = "切り込みは二つですか？", second = "ふくらみはどの部分ですか？";
  const records = await buildRecords({ ...options, figureCount: 6, turns: [{ human: first + second, plan: {
    action: "confirm", target: "figure_0", act: "ask",
    extraction: JSON.stringify([first, second].map((quote, index) => ({ segmentId: `s${index}`, quote,
      targets: [OWN.ownAnchors[index].id], aspect: "question", proposition: quote, name: null, linkedIssueId: null, respondsToTurn: null,
    }))),
    speech: JSON.stringify({ parts: ["切り込みどうしはどのようにつながっていますか？", "ふくらみというのは、丸い部分ですか？"]
      .map((text, item) => ({ item, text })), observationFeatures: [] }),
    aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
    choose: (key, criteria) => key === "visual_purpose" ? Object.keys(criteria).find(label => label.startsWith("issue_"))
      : key === "extra_0" ? "repair" : key === "human_move_on_source" ? "other" : key === "commitment_state" ? "insufficient" : undefined,
  } }] });
  const baseline = replayCheck(records);
  assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
  const altered = structuredClone(records);
  rewriteComparison(altered, 0, messages => {
    const lines = messages[2].content.split("\n");
    const plan = JSON.parse(lines.at(-1)!);
    assert.equal(plan.items[1].action, "repair");
    plan.items[1].target.figureId = OWN.ownAnchors[5].id;
    lines[lines.length - 1] = JSON.stringify(plan);
    messages[2].content = lines.join("\n");
  });
  assert.equal(replayCheck(altered)?.status, "mismatch");
});

test("v23 S4 binds the old and substituted plans across publication recovery", async () => {
  const records = await buildRecords({ ...options, figureCount: 4, turns: [{ human: "舟に見えます。", plan: {
    action: "confirm", target: "figure_0", drafts: ["{}", "{}", "お話の形は、帆が立った舟のように見えます。"],
    choose: (key, _criteria, { generationCalls }) => generationCalls >= 2 && key === "action" ? "accept"
      : generationCalls >= 2 && key === "target" ? "none" : key === "publication_continuation" ? "acknowledge_unresolved"
      : key === "human_move_on_source" ? "other" : key === "commitment_state" ? "insufficient" : undefined,
  } }] });
  const baseline = replayCheck(records);
  assert.equal(baseline?.status, "pass", JSON.stringify(baseline));
  const altered = structuredClone(records);
  for (const index of [0, 1]) rewriteComparison(altered, index, messages => {
    messages[2].content = messages[2].content.replace(/"action":"confirm"/u, '"action":"repair"');
  });
  assert.equal(replayCheck(altered)?.status, "mismatch");
});
