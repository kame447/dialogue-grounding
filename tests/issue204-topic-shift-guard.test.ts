import assert from "node:assert/strict";
import test from "node:test";
import { GENERATION_RETRY_V22 as GENERATION_V22, ISSUE_HANDLING_GENERATION } from "../dialogue-model/runtime/v2/deferred-ai-extraction.ts";
import { buildJevDraftActPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { DraftTopicShiftResult } from "../dialogue-model/runtime/decision/contract.ts";
import { issueHandlingForStrategy } from "../dialogue-model/runtime/decision/issue-handling.ts";
import { validateJevPrivateStateV2 } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OWN, runTurn, type Plan } from "./support/s4-v3-records.ts";
import type { RecordedGenerationRetryVersion } from "../dialogue-model/runtime/v2/generation-guard.ts";

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5", "bypass_acceptance_v3", "jev_repair_quality_v1");
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const draft = (text: string) => JSON.stringify({ text, observationFeatures: [] });
const emptyFeatures = JSON.stringify({ segments: [], visualFeatures: { sources: [] } });
const stay = "今の図形の半円の切り込みを確かめたいです。";
const bareMove = "この図形をいったん置いて、次のを見よう。";
const clearMove = "次の図形に進みましょう。";
const safeReply = "今の図形の切り込みは半円に見えます。";
const preface = "次の図形に進む前に、今の切り込みを確かめたいです。";
const timely = "その切り込みは半円に見えますか？";
const keep = "other";
const twoQuestions = ["細い台とのつながり方は同じですか？", "丸い切り込みもありますか？"];
const twoAnswers = ["細い台は、どんな部分につながっていますか？", "切り込みは、どんな形に見えますか？"];
const parts = (first: string, second: string) => JSON.stringify({
  parts: [{ item: 0, text: first }, { item: 1, text: second }], observationFeatures: [],
});
const questions = JSON.stringify(twoQuestions.map((quote, i) => ({ segmentId: `question-${i}`, quote, proposition: quote,
  targets: [OWN.ownAnchors[i].id], aspect: "question", name: null, linkedIssueId: null, respondsToTurn: null })));

type Label = "repair-first" | "bypass-enabled";
const labels: Label[] = ["repair-first", "bypass-enabled"];
const choose = (choices: Record<string, string> = {}): Plan["choose"] => (key, criteria) => {
  if (choices[key] !== undefined) return choices[key];
  if (key === "visual_purpose") return Object.keys(criteria).find(label => label.startsWith("issue_")) ?? "unknown";
  if (key === "human_move_on_source") return keep;
  if (key === "commitment_state") return "insufficient";
  return undefined;
};
const acceptPlan = (response: Pick<Plan, "speech" | "drafts">, choices = {}): Plan => ({ action: "accept", target: "none", ...response,
  choose: choose(choices) });
const confirmPlan = (response: Pick<Plan, "speech" | "drafts">): Plan => ({ action: "confirm", target: "figure_0", ...response,
  aiExtraction: emptyFeatures, choose: choose() });
const multiPlan = (response: Pick<Plan, "speech" | "drafts">): Plan => ({ ...confirmPlan(response), act: "ask", extraction: questions,
  choose: choose({ extra_0: "confirm" }) });
const carryPlan = (response: Pick<Plan, "speech" | "drafts">): Plan => ({ action: "carry_over", target: "none", ...response,
  aiExtraction: emptyFeatures, choose: choose({ human_move_on_source: "human_request", handled_issue: "unknown",
    carry_destination: "partner_choice", non_bypass_alternative: "confirm" }) });
const name = "輪の舟";
const nameRequest = `この図形は「${name}」と呼びませんか？`;
const nameAgreement = `では「${name}」と呼びましょう。`;
const partnerMove = "ではご希望どおり、次の図形を見ましょう。";
const nameAndMove = (humanMove: string): Plan => ({ action: "agree", target: "figure_0", name, act: "name_propose",
  extraction: JSON.stringify([{ segmentId: "name", quote: nameRequest, proposition: nameRequest, name, aspect: "name",
    targets: [OWN.ownAnchors[0].id], linkedIssueId: null, respondsToTurn: null }]),
  speech: JSON.stringify({ text: nameAgreement, moveOn: humanMove }), choose: choose({ human_move_on_source: "human_request",
    naming_grounding: "grounded_name_0", naming_evidence: "turn_1", draft_human_move_on: "honors_request" }) });

async function turn(label: Label, human: string, plan: Plan, generation: RecordedGenerationRetryVersion = ISSUE_HANDLING_GENERATION, agreedName?: string) {
  const before = initialState({ profile, generationRetryVersion: generation, agreeNameScopeVersion: "jev_naming_v2" });
  const result = await runTurn(profile, label, before, [{ id: "event-1", seq: 1, speaker: "human", text: human }], plan, technicalTrial, generation);
  assert.equal(result.publication.status, "committed");
  const expectedLedger = agreedName === undefined ? before.ledger
    : { ...before.ledger, [OWN.ownAnchors[0].id]: { name: agreedName, status: "agreed" } };
  assert.deepEqual(result.state.ledger, expectedLedger);
  return result;
}

function withVerdicts(plan: Plan, ...verdicts: DraftTopicShiftResult["choice"][]): Plan {
  return { ...plan, choose: (key, criteria, context) => key === "draft_topic_shift"
    ? verdicts[Math.max(0, context.generationCalls - 1)] : plan.choose?.(key, criteria, context) };
}
const topicPosts = (result: Awaited<ReturnType<typeof turn>>) => result.jev.filter(response => response.answers.draft_topic_shift);
function reason(result: Awaited<ReturnType<typeof turn>>) {
  const trace = result.trace.intervention;
  assert.ok(trace && typeof trace === "object");
  return trace.reasonCode;
}
function extraAction(result: Awaited<ReturnType<typeof turn>>) {
  const execution = result.trace.executed;
  return "extras" in execution ? execution.extras?.[0]?.action : undefined;
}

for (const label of labels) {
  test(`443bf88 ${label} publishes an elliptical move under a non-veto accept`, async () => {
    const r = await turn(label, stay, acceptPlan({ speech: bareMove }));
    assert.equal(r.speech, bareMove);
    assert.equal(r.trace.executed.action, "accept");
    assert.equal(reason(r), label === "repair-first" ? "not_in_veto_set" : "no_intervention");
    assert.equal(r.trace.draftActs, undefined);
  });

  test(`443bf88 ${label} checks each part lexically, leaving an elliptical move in the extra unchecked`, async () => {
    const r = await turn(label, twoQuestions.join(""), multiPlan({ speech: parts(twoAnswers[0], bareMove) }));
    assert.deepEqual(r.trace.generatedPublication?.parts?.map(part => part.item), [0, 1]);
    assert.equal(r.trace.executed.action, "confirm");
    assert.equal(extraAction(r), "confirm");
    assert.equal(r.speech, [twoAnswers[0], bareMove].join("\n"));
    assert.equal(r.trace.draftActs, undefined);
  });

  test(`443bf88 ${label} blocks an explicit move and rewrites a remaining preface false positive`, async () => {
    const explicit = await turn(label, stay, acceptPlan({ drafts: [clearMove, safeReply] }));
    const prefaced = await turn(label, stay, confirmPlan({ drafts: [draft(preface), draft(timely)] }));
    for (const [result, expected] of [[explicit, safeReply], [prefaced, timely]] as const) {
      assert.equal(result.speech, expected);
      assert.deepEqual(result.trace.generationGuard.violations, ["unsupported_topic_shift"]);
      assert.equal(result.trace.generationGuard.regenerated, true);
    }
  });

  test(`443bf88 ${label} can honor a human move through the selected carry destination`, async () => {
    const r = await turn(label, "この図形は置いて、次の図形に進みたいです。", carryPlan({ speech: draft(clearMove) }));
    assert.equal(r.speech, clearMove);
    assert.equal(r.trace.executed.action, "carry_over");
    assert.equal(reason(r), "human_led");
  });

  test(`443bf88 ${label} confirms a name and the requested move in one existing semantic POST`, async () => {
    const r = await turn(label, nameRequest + "そのあと、次の図形に進みたいです。", nameAndMove(partnerMove), ISSUE_HANDLING_GENERATION, name);
    assert.equal(r.speech, `${nameAgreement}\n${partnerMove}`);
    assert.deepEqual(r.jev.filter(response => response.answers.draft_naming).map(response => Object.keys(response.answers)), [
      ["draft_naming", "draft_human_move_on"],
    ]);
  });
}

test("v22 asks about every section without asking a naming question on a plain accept", () => {
  const main = twoAnswers[0];
  const topicShiftPlan = { humanRequestedMove: false, sections: [
    { item: 0, start: 0, end: main.length, action: "accept", target: { kind: "none" } },
    { item: 1, start: main.length + 1, end: main.length + 1 + bareMove.length, action: "confirm",
      target: { kind: "single", figureId: OWN.ownAnchors[0].id } },
  ] } as const;
  const input = { turn: 1, publicTurns: [{ turn: 1, speaker: "human" as const, text: stay }],
    selected: { action: "accept", name: null, target: { kind: "none" } } as const, draft: `${main}\n${bareMove}`,
    semanticNaming: { currentTurnSource: false }, issueHandlingVersion: "jev_issue_handling_v1" as const };
  const payload = buildJevDraftActPayload({ ...input, reasons: ["topic_shift"], topicShiftPlan }, "holistic_v5");
  assert.deepEqual(JSON.parse(payload.state).topicShiftPlan, topicShiftPlan);
  assert.deepEqual(Object.keys(payload.questions), ["draft_topic_shift"]);
  assert.deepEqual(Object.keys(payload.questions.draft_topic_shift.criteria), ["within_plan", "unsupported_shift", "unclear"]);
  const combined = buildJevDraftActPayload({ ...input, reasons: ["quoted_other", "topic_shift"], topicShiftPlan }, "holistic_v5");
  assert.deepEqual(Object.keys(combined.questions), ["draft_naming", "draft_topic_shift"]);
  const badPlan = structuredClone(topicShiftPlan);
  assert.throws(() => buildJevDraftActPayload({ ...input, reasons: ["topic_shift"],
    topicShiftPlan: { ...badPlan, sections: [{ ...badPlan.sections[0], end: 1 }, badPlan.sections[1]] } }, "holistic_v5"));
});

test("v22 rejects the elliptical accept draft and sends identical requests for the same plan in both strategies", async () => {
  const requestHashes = [];
  for (const label of labels) {
    const r = await turn(label, stay, withVerdicts(acceptPlan({ drafts: [bareMove, safeReply] }), "unsupported_shift", "within_plan"), GENERATION_V22);
    assert.equal(r.speech, safeReply);
    assert.deepEqual(r.trace.generationGuard.violations, ["unsupported_topic_shift"]);
    assert.deepEqual(topicPosts(r).map(post => Object.keys(post.answers)), [["draft_topic_shift"], ["draft_topic_shift"]]);
    assert.deepEqual(r.trace.draftActs?.map(proof => [proof.draft, proof.topicShift?.choice, proof.choice]), [
      ["initial", "unsupported_shift", null], ["retry", "within_plan", null],
    ]);
    const restore = (state: unknown) => validateJevPrivateStateV2(state, OWN.ownAnchors.map(({ id }: { id: string }) => id),
      issueHandlingForStrategy(label), "two_stage_v3", "holistic_v5", GENERATION_V22, undefined, r.publication.durable.events);
    assert.doesNotThrow(() => restore(r.state));
    const forged = structuredClone(r.state);
    forged.judgments[0].jevTurn.draftActs.at(-1).topicShift.choice = "unsupported_shift";
    assert.throws(() => restore(forged), { code: "invalid_state" });
    const detached = structuredClone(r.state);
    detached.judgments[0].jevTurn.draftActs.at(-1).draftSha256 = "1".repeat(64);
    assert.throws(() => restore(detached), { code: "invalid_state" });
    requestHashes.push(r.httpBodies);
  }
  assert.deepEqual(requestHashes[0], requestHashes[1]);
});

for (const label of labels) {
  test(`v22 ${label} rejects an elliptical move inside an extra confirmation`, async () => {
    const r = await turn(label, twoQuestions.join(""), withVerdicts(multiPlan({ drafts: [
      parts(twoAnswers[0], bareMove), parts(twoAnswers[0], twoAnswers[1]),
    ] }), "unsupported_shift", "within_plan"), GENERATION_V22);
    assert.equal(r.speech, twoAnswers.join("\n"));
    assert.equal(extraAction(r), "confirm");
    assert.deepEqual(r.trace.generatedPublication?.parts?.map(part => part.item), [0, 1]);
    assert.deepEqual(r.trace.generationGuard.violations, ["unsupported_topic_shift"]);
    assert.equal(topicPosts(r).length, 2);
  });

  test(`v22 ${label} accepts a preface, negation and past account, and rejects a later move`, async () => {
    const controls = [preface, "次の図形には進みません。今の切り込みを確かめたいです。",
      "さっき別の図形に移ったときにも切り込みを見ました。今の切り込みを確かめたいです。"];
    for (const text of controls) {
      const r = await turn(label, stay, withVerdicts(confirmPlan({ speech: draft(text) }), "within_plan"), GENERATION_V22);
      assert.equal(r.speech, text);
      assert.equal(r.trace.generationGuard.regenerated, false);
      assert.equal(topicPosts(r).length, 1);
    }
    const r = await turn(label, stay, withVerdicts(confirmPlan({ drafts: [draft(preface + clearMove), draft(timely)] }),
      "unsupported_shift", "within_plan"), GENERATION_V22);
    assert.equal(r.speech, timely);
    assert.deepEqual(r.trace.generationGuard.violations, ["unsupported_topic_shift"]);
  });

  test(`v22 ${label} honors a human move and rewrites a destination outside the selected carry`, async () => {
    const request = "この図形は置いて、次の図形に進みたいです。";
    const fromAccept = await turn(label, request, withVerdicts(acceptPlan({ speech: clearMove }, { human_move_on_source: "human_request" }),
      "within_plan"), GENERATION_V22);
    assert.equal(fromAccept.speech, clearMove);
    assert.equal(fromAccept.trace.executed.action, "accept");
    const carried = await turn(label, request, withVerdicts(carryPlan({ drafts: [
      draft(clearMove + "そのあとは私が決める別の図形へ行きましょう。"), draft(clearMove),
    ] }), "unsupported_shift", "within_plan"), GENERATION_V22);
    assert.equal(carried.speech, clearMove);
    assert.equal(reason(carried), "human_led");
    assert.ok("destination" in carried.trace.executed);
    assert.deepEqual(carried.trace.executed.destination, { kind: "partner_choice" });
    assert.deepEqual(carried.trace.generationGuard.violations, ["unsupported_topic_shift"]);
  });

  test(`v22 ${label} preserves a closing consultation but does not authorize a figure shift in consult`, async () => {
    const closing = "まだ呼び名が決まっていない形があります。ここまでにしますか？";
    const close = await turn(label, "未解決の形がありますが、ここまででいいですか？", withVerdicts({ action: "close", target: "none",
      speech: closing, choose: choose({ human_move_on_source: "human_request" }) }, "within_plan"), GENERATION_V22);
    assert.equal(close.speech, closing);
    assert.deepEqual(close.trace.generatedPublication?.close, { unresolved: true, initiator: "human" });
    const consult = await turn(label, "この形はまだ分かりません。", withVerdicts({ action: "consult", target: "none",
      drafts: [bareMove, "この形の確認を続けるか、相談してもいいですか？"], choose: choose({ handled_issue: "unknown" }) },
      "unsupported_shift", "within_plan"), GENERATION_V22);
    assert.equal(consult.trace.executed.action, "consult");
    assert.deepEqual(consult.trace.generationGuard.violations, ["unsupported_topic_shift"]);
    assert.equal(consult.speech, "この形の確認を続けるか、相談してもいいですか？");
  });

  test(`v22 ${label} checks naming, the requested move and topic scope in a single POST`, async () => {
    const r = await turn(label, nameRequest + "そのあと、次の図形に進みたいです。",
      withVerdicts(nameAndMove(partnerMove), "within_plan"), GENERATION_V22, name);
    assert.equal(r.speech, `${nameAgreement}\n${partnerMove}`);
    assert.deepEqual(topicPosts(r).map(post => Object.keys(post.answers)), [["draft_naming", "draft_human_move_on", "draft_topic_shift"]]);
    assert.equal(r.jev.filter(response => response.answers.draft_naming).length, 1);
  });
}

test("v22 retries a semantically unclear draft without treating missing evidence as permission", async () => {
  const r = await turn("repair-first", stay, withVerdicts(acceptPlan({ drafts: [bareMove, safeReply] }), "unclear", "within_plan"), GENERATION_V22);
  assert.equal(r.speech, safeReply);
  assert.deepEqual(r.trace.generationGuard.violations, ["draft_topic_shift_unconfirmed"]);
  assert.equal(r.trace.draftActs?.[0]?.topicShift?.choice, "unclear");
});

test("v22 keeps an AI-selected carry destination subject to the existing intervention", async () => {
  const change = "つながり方はまだ分かりません。次は切り込みのある形を見てみましょう。";
  for (const label of labels) {
    const adopted = label === "bypass-enabled";
    const defaults = choose({ carry_destination: "figure_1", non_bypass_alternative: "confirm", extra_0: "confirm" });
    const r = await turn(label, twoQuestions.join(""), withVerdicts({ action: "carry_over", target: "figure_0",
      act: "ask", extraction: questions, speech: adopted ? parts(change, twoAnswers[1]) : draft(twoAnswers[0]),
      aiExtraction: emptyFeatures, choose: (key, criteria, context) => key === "handled_issue"
        ? Object.keys(criteria).find(choice => choice.startsWith("issue_")) : defaults?.(key, criteria, context),
    }, "within_plan"), GENERATION_V22);
    assert.equal(reason(r), adopted ? "no_intervention" : "vetoed_issue_handling");
    assert.equal(r.trace.executed.action, adopted ? "carry_over" : "confirm");
    assert.equal(r.speech, adopted ? [change, twoAnswers[1]].join("\n") : twoAnswers[0]);
    assert.equal(topicPosts(r).length, 1);
  }
});

test("v22 publishes neither draft when both semantic checks fail to return a response", async () => {
  await assert.rejects(turn("repair-first", stay, {
    ...acceptPlan({ drafts: [bareMove, safeReply] }), failQuestion: "draft_topic_shift",
  }, GENERATION_V22), (error: Error & { code?: string; traces?: Array<Awaited<ReturnType<typeof turn>>["trace"]> }) => {
    assert.equal(error.code, "unsafe_generation");
    const trace = error.traces?.at(-1);
    assert.equal(trace?.publicSpeech, null);
    assert.deepEqual(trace?.generationGuard.violations, ["draft_topic_shift_unconfirmed"]);
    assert.deepEqual(trace?.draftActs?.map(proof => [proof.draft, proof.status, proof.topicShift]), [
      ["initial", "error", undefined], ["retry", "error", undefined],
    ]);
    return true;
  });
});
