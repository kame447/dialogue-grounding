import assert from "node:assert/strict";
import test from "node:test";
import { isNamingIntervalBoundary } from "../dialogue-model/runtime/decision/naming-request.ts";
import { issueHandlingForStrategy } from "../dialogue-model/runtime/decision/issue-handling.ts";
import { ISSUE_HANDLING_GENERATION } from "../dialogue-model/runtime/v2/deferred-ai-extraction.ts";
import { generationGuardCodes } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { validateJevPrivateStateV2 } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OWN, runTurn, type Plan } from "./support/s4-v3-records.ts";

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5", "bypass_acceptance_v3", "jev_repair_quality_v1");
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const originalText = "うーん、どの図形のことだろう…";
const alternativeText = "どのような部分がつながっている図形ですか？";
const draft = (text: string) => JSON.stringify({ text, observationFeatures: [] });

test("v21 deferral and topic-shift checks follow the published act", () => {
  const move = "この形は保留にしましょう。次の図形に行きましょう。";
  for (const action of ["hold_open", "carry_over", "consult"] as const) {
    const codes = generationGuardCodes(move, { action, candidateName: null, v3: true, holistic: true,
      adaptive: true, factored: true, ai: true, publicTexts: [], dialoguePolicy: "holistic_v5",
      generationRetryVersion: ISSUE_HANDLING_GENERATION });
    assert.equal(codes.includes("unsolicited_deferral"), action === "hold_open", action);
    assert.equal(codes.includes("unsupported_topic_shift"), action === "hold_open", action);
  }
});

test("v21 closes a naming interval only for agreement or an actual move away", () => {
  const carry = (kind: string) => ({ judgment: { action: "carry_over" }, jevTurn: {
    executed: { target: { kind: "single" }, destination: { kind } },
  } });
  for (const kind of ["partner_choice", "other_figure", "old_issue"]) assert.equal(isNamingIntervalBoundary(carry(kind), true), true);
  for (const kind of ["same_figure_naming", "same_figure_other_issue"]) assert.equal(isNamingIntervalBoundary(carry(kind), true), false);
  assert.equal(isNamingIntervalBoundary({ judgment: { action: "hold_open" } }, true), false);
  assert.equal(isNamingIntervalBoundary({ judgment: { action: "agree" } }, true), true);
  assert.equal(isNamingIntervalBoundary({ judgment: { action: "confirm" }, generatedPublication: { transition: {} } }, true), true);
  assert.equal(isNamingIntervalBoundary({ judgment: { action: "defer" } }), true);
});

test("v21 adopts or vetoes the same grounded hold, using shared requests and no extra Jev detail", async () => {
  const before = initialState({ profile, generationRetryVersion: ISSUE_HANDLING_GENERATION, agreeNameScopeVersion: "jev_naming_v1" });
  const events = [{ id: "event-1", seq: 1, speaker: "human", text: "これが細長い方の図形ですよね？" }];
  const common = [];
  for (const label of ["bypass-enabled", "repair-first"] as const) {
    const result = await runTurn(profile, label, before, events, {
      action: "hold_open", target: "none", speech: draft(label === "bypass-enabled" ? originalText : alternativeText),
      aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
      choose: key => ({ human_move_on_source: "other", commitment_state: "insufficient",
        handled_issue: "unknown", non_bypass_alternative: "confirm" } as Record<string, string>)[key],
    }, technicalTrial, ISSUE_HANDLING_GENERATION);
    assert.equal(result.publication.status, "committed");
    const intervention = result.trace.intervention;
    assert.ok(intervention && typeof intervention === "object");
    assert.equal(intervention.schemaVersion, "jev_intervention_v2");
    assert.equal(intervention.reasonCode, label === "bypass-enabled" ? "no_intervention" : "vetoed_issue_handling");
    assert.equal(result.trace.executed.action, label === "bypass-enabled" ? "hold_open" : "confirm");
    assert.deepEqual(result.trace.generatedPublication?.visualFeatures, { sources: [] });
    assert.deepEqual(result.trace.generatedPublication?.handlingBasis, { repairHistory: [], priorClaims: [] });
    assert.deepEqual(result.state.ledger, before.ledger);
    assert.equal(result.state.repairHistory.length, label === "bypass-enabled" ? 0 : 1);
    assert.equal(result.luna.filter(call => call.phase === "ai_extraction").length, 1);
    assert.equal(result.jev.length, result.boundary.jev);
    common.push(result.httpBodies.slice(0, result.boundary.luna + result.boundary.jev));
  }
  assert.deepEqual(common[0], common[1]);
});

test("v21 records consultation about ending without closing the trial or changing the ledger", async () => {
  const before = initialState({ profile, generationRetryVersion: ISSUE_HANDLING_GENERATION, agreeNameScopeVersion: "jev_naming_v1" });
  const events = [{ id: "event-1", seq: 1, speaker: "human", text: "まだ残っている図形がありますが、ここまででいいですか？" }];
  for (const [label, source] of [["bypass-enabled", "human_request"], ["repair-first", "other"]] as const) {
    const result = await runTurn(profile, label, before, events, {
      action: "close", target: "none", speech: "呼び名がまだ決まっていない図形があります。ここまでにしますか？",
      choose: key => ({ human_move_on_source: source, commitment_state: "insufficient" } as Record<string, string>)[key],
    }, technicalTrial, ISSUE_HANDLING_GENERATION);
    assert.equal(result.publication.status, "committed");
    assert.equal(result.trace.executed.action, "close");
    const intervention = result.trace.intervention;
    assert.ok(intervention && typeof intervention === "object");
    assert.equal(intervention.disposition, "adopted");
    assert.deepEqual(result.trace.generatedPublication?.close, { unresolved: true, initiator: source === "human_request" ? "human" : "ai" });
    assert.equal(result.trace.generatedPublication?.handlingBasis, undefined);
    assert.equal(result.trace.generatedPublication?.visualFeatures, undefined);
    assert.deepEqual(result.state.ledger, before.ledger);
  }
});

const issueQuestions = ["細い台とのつながり方は同じですか？", "丸い切り込みもありますか？", "ふくらんだ部分はどんな形ですか？"];
const issueEvent = { id: "event-1", seq: 1, speaker: "human", text: issueQuestions.join("") };
const issueReply = ["細い台は、どんな部分につながっていますか？", "切り込みは、どんな形に見えますか？", "ふくらんだ部分の形を教えてください。"];
const issueExtraction = JSON.stringify(issueQuestions.map((quote, index) => ({ segmentId: `question-${index}`, quote, proposition: quote,
  targets: [OWN.ownAnchors[index].id], name: null, aspect: "question", linkedIssueId: null, respondsToTurn: null })));
const partsDraft = (...items: number[]) => JSON.stringify({
  parts: items.map(item => ({ item, text: issueReply[item] })), observationFeatures: [],
});
const multiPlan = (choices: Record<string, string>, response: Pick<Plan, "speech" | "drafts">): Plan => ({
  action: "confirm", target: "figure_0", act: "ask", extraction: issueExtraction, ...response,
  aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
  choose: (key, criteria) => key === "visual_purpose" ? Object.keys(criteria).find(label => label.startsWith("issue_"))
    : ({ human_move_on_source: "other", commitment_state: "insufficient", extra_alt_0: "confirm", extra_alt_1: "confirm", ...choices } as Record<string, string>)[key],
});

test("v21 regenerates duplicate part IDs, preserves Terra's order, and binds every part to the execution", async () => {
  const before = initialState({ profile, generationRetryVersion: ISSUE_HANDLING_GENERATION, agreeNameScopeVersion: "jev_naming_v1" });
  const result = await runTurn(profile, "bypass-enabled", before, [issueEvent], multiPlan({ extra_0: "confirm", extra_1: "repair" },
    { drafts: [partsDraft(0, 1, 1), partsDraft(2, 0, 1)] }), technicalTrial, ISSUE_HANDLING_GENERATION);
  assert.equal(result.publication.status, "committed");
  assert.equal(result.trace.generationGuard.regenerated, true);
  assert.equal(result.speech, [issueReply[2], issueReply[0], issueReply[1]].join("\n"));
  assert.deepEqual(result.trace.generatedPublication?.parts?.map(part => part.item), [2, 0, 1]);
  assert.equal(result.trace.generatedPublication?.visualPurposeSources?.length, 3);
  assert.equal(result.state.repairHistory.length, 1);
  assert.deepEqual(result.state.ledger, before.ledger);
  const validate = (state: unknown) => validateJevPrivateStateV2(state, OWN.ownAnchors.map(({ id }: { id: string }) => id),
    issueHandlingForStrategy("bypass-enabled"), "two_stage_v3", "holistic_v5", ISSUE_HANDLING_GENERATION, undefined, result.publication.durable.events);
  assert.doesNotThrow(() => validate(result.state));
  const badPart = structuredClone(result.state);
  badPart.judgments[0].generatedPublication.parts[0].end--;
  assert.throws(() => validate(badPart));
  const badDisposition = structuredClone(result.state);
  badDisposition.judgments[0].jevTurn.intervention.extras[0].disposition = "dropped";
  assert.throws(() => validate(badDisposition));
});

test("v21 guards each extra part using its own action and produces the same request for the same executed plan", async () => {
  const before = initialState({ profile, generationRetryVersion: ISSUE_HANDLING_GENERATION, agreeNameScopeVersion: "jev_naming_v1" });
  const accepted = await runTurn(profile, "bypass-enabled", before, [issueEvent], multiPlan({ extra_0: "confirm", extra_1: "leave" },
    { speech: partsDraft(0, 1) }), technicalTrial, ISSUE_HANDLING_GENERATION);
  const substituted = await runTurn(profile, "repair-first", before, [issueEvent], multiPlan({ extra_0: "hold_open", extra_1: "leave" },
    { speech: partsDraft(0, 1) }), technicalTrial, ISSUE_HANDLING_GENERATION);
  const generationSha = (result: typeof accepted) => result.httpBodies.filter(call => call.provider === "luna")[
    result.luna.findIndex(call => call.phase === "generation")].sha256;
  assert.equal(accepted.publication.status, "committed");
  assert.equal(substituted.publication.status, "committed");
  assert.equal(generationSha(accepted), generationSha(substituted));
  const forbiddenHold = JSON.stringify({ parts: [{ item: 0, text: issueReply[0] },
    { item: 1, text: "これは保留にしましょう。次の図形に行きましょう。" }], observationFeatures: [] });
  const properHold = JSON.stringify({ parts: [{ item: 0, text: issueReply[0] },
    { item: 1, text: "切り込みのところは、まだ分かりません。" }], observationFeatures: [] });
  const held = await runTurn(profile, "bypass-enabled", before, [issueEvent], multiPlan({ extra_0: "hold_open", extra_1: "leave" },
    { drafts: [forbiddenHold, properHold] }), technicalTrial, ISSUE_HANDLING_GENERATION);
  assert.equal(held.publication.status, "committed");
  assert.deepEqual(held.trace.generationGuard.violations, ["unsolicited_deferral", "unsupported_topic_shift"]);
  assert.equal(held.speech, [issueReply[0], "切り込みのところは、まだ分かりません。"].join("\n"));
});

test("v21 preserves the source of a dropped destination extra and rejects its revival on restore", async () => {
  const before = initialState({ profile, generationRetryVersion: ISSUE_HANDLING_GENERATION, agreeNameScopeVersion: "jev_naming_v1" });
  const choose = (key: string, criteria: Readonly<Record<string, string>>) => key === "handled_issue"
    ? Object.keys(criteria).find(label => label.startsWith("issue_"))
    : ({ human_move_on_source: "other", commitment_state: "insufficient", carry_destination: "figure_1",
        non_bypass_alternative: "confirm", extra_0: "confirm" } as Record<string, string>)[key];
  const results = [];
  for (const label of ["bypass-enabled", "repair-first"] as const) {
    const speech = label === "bypass-enabled" ? JSON.stringify({ parts: [
      { item: 0, text: "つながり方はまだ分かりません。次は切り込みのある形を見てみましょう。" },
      { item: 1, text: issueReply[1] },
    ], observationFeatures: [] }) : draft(issueReply[0]);
    const result = await runTurn(profile, label, before, [issueEvent], { action: "carry_over", target: "figure_0",
      act: "ask", extraction: issueExtraction, speech, choose,
      aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
    }, technicalTrial, ISSUE_HANDLING_GENERATION);
    assert.equal(result.publication.status, "committed");
    const intervention = result.trace.intervention;
    assert.ok(intervention && typeof intervention === "object" && intervention.schemaVersion === "jev_intervention_v2");
    const extra = intervention.extras?.[0];
    assert.ok(extra && "visualPurpose" in extra.original);
    assert.equal(extra.disposition, label === "bypass-enabled" ? "adopted" : "dropped");
    const { claimId } = extra.original.visualPurpose;
    assert.ok(result.trace.generatedPublication?.visualPurposeSources?.some(source => source.id === claimId));
    results.push({ result, extra });
  }
  const [accepted, vetoed] = results;
  assert.equal(vetoed.result.trace.generatedPublication?.parts, undefined);
  const modified = structuredClone(vetoed.result.state);
  modified.judgments[0].jevTurn.executed.extras = [accepted.extra.executed];
  assert.throws(() => validateJevPrivateStateV2(modified, OWN.ownAnchors.map(({ id }: { id: string }) => id),
    issueHandlingForStrategy("repair-first"), "two_stage_v3", "holistic_v5", ISSUE_HANDLING_GENERATION, undefined, vetoed.result.publication.durable.events));
});

test("v21 limits observation sources to the visual items when naming and confirmation share a reply", async () => {
  const before = initialState({ profile, generationRetryVersion: ISSUE_HANDLING_GENERATION, agreeNameScopeVersion: "jev_naming_v1" });
  const [named, checked] = OWN.ownAnchors;
  for (const figure of before.observationMemo.figures) figure.analytic.shapes = ["丸い切り込み"];
  const proposal = "その形を「帆」と呼びましょう。";
  const question = issueQuestions[1];
  const text = "丸い切り込みは、どの部分にありますか？";
  const events = [{ id: "event-1", seq: 1, speaker: "human", text: proposal + question }];
  const source = (figureId: string) => ({ figureId, path: ["analytic", "shapes", 0] });
  const response = (figureId: string) => JSON.stringify({ parts: [{ item: 0, text: "ええ、「帆」にしましょう。" },
    { item: 1, text }], observationFeatures: [source(figureId)] });
  const result = await runTurn(profile, "bypass-enabled", before, events, { action: "agree", target: "figure_0", name: "帆", referent: "figure_0",
    extraction: JSON.stringify([{ segmentId: "name", quote: proposal, proposition: proposal, targets: [named.id],
      aspect: "name", name: "帆", linkedIssueId: null, respondsToTurn: null },
    { segmentId: "question", quote: question, proposition: question, targets: [checked.id],
      aspect: "question", name: null, linkedIssueId: null, respondsToTurn: null }]),
    drafts: [response(named.id), response(checked.id)],
    aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [{ source: source(checked.id), quote: text }] } }),
    choose: key => ({ segment_0_act: "name_propose", segment_1_act: "ask", extra_0: "confirm", extra_alt_0: "confirm",
      naming_grounding: "grounded_name_0", naming_evidence: "turn_1", human_move_on_source: "other", commitment_state: "insufficient" } as Record<string, string>)[key],
  }, technicalTrial, ISSUE_HANDLING_GENERATION);
  assert.equal(result.publication.status, "committed");
  assert.equal(result.trace.generationGuard.regenerated, true);
  assert.equal(result.luna.filter(call => call.phase === "ai_extraction").length, 1);
  assert.deepEqual(result.state.ledger[named.id], { status: "agreed", name: "帆" });
  assert.deepEqual(result.trace.generatedPublication?.visualFeatures?.sources, [{ source: source(checked.id), quote: text }]);
  const tampered = structuredClone(result.state);
  tampered.judgments[0].generatedPublication.visualFeatures.sources[0].source = source(named.id);
  assert.throws(() => validateJevPrivateStateV2(tampered, OWN.ownAnchors.map(({ id }: { id: string }) => id),
    issueHandlingForStrategy("bypass-enabled"), "two_stage_v3", "holistic_v5", ISSUE_HANDLING_GENERATION, undefined, result.publication.durable.events));
});
