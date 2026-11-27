import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyBypassAcceptance, interventionForStrategy } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import type { JevDecisionInput, JevTarget, RepairHistoryEntry } from "../dialogue-model/runtime/decision/contract.ts";
import { buildJevDecisionDetailPayload, buildJevDecisionPayload, createJevDecisionClient, JEV_DECISION_MODEL,
  validateJevDecision, type JevDecisionPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { JEV_REPAIR_QUALITY_VERSION } from "../dialogue-model/runtime/decision/repair-quality.ts";
import type { LocalClaimView } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { ids, memo } from "./support/s4-integration/harness.ts";

const layout = { questionLayout: "two_stage_v3", dialoguePolicy: "holistic_v5" } as const;
const version = "jev_visual_purpose_v1" as const;
const sharedFeature = "縁が直線でできている";
const question = "輪のつなぎ目は開いていますか";
const secondQuestion = "もう一つの形に穴はありますか";
const target = (index = 0): JevTarget => ({ kind: "single", figureId: ids[index] });

function fixture(figureCount: 4 | 6, shapes = [sharedFeature]): JevDecisionInput {
  const { observedAt, figures } = memo();
  const observations = { observedAt, figures: figures.slice(0, figureCount).map(figure => ({
    ...figure, holistic: [], analytic: { shapes: [...shapes], composition: "", relations: [] },
  })) };
  const firstClaim: LocalClaimView = { id: "3:local1", issueId: "3:issue1", turn: 3, sourceTurn: 3,
    targets: [ids[0]], aspect: "part", act: "ask", proposition: question, quote: question, name: null,
    speaker: "human", respondsTo: null, source: "partner_statement" };
  return {
    turn: 3, ownSlots: ids.slice(0, figureCount), observations, issueSummary: "", judgmentLedger: [], repairHistory: [],
    publicTurns: [{ turn: 1, speaker: "human", text: "一つ目の形を見比べたいです。" },
      { turn: 2, speaker: "ai", text: "輪郭が直線か見比べましょう。" },
      { turn: 3, speaker: "human", text: question + "。" + secondQuestion + "。" }],
    priorClaims: [firstClaim, { ...firstClaim, id: "3:local2", issueId: "3:issue2", targets: [ids[1]],
      quote: secondQuestion, proposition: secondQuestion }],
    previousAction: null, publicNames: [], judgmentMaterialVersion: JEV_REPAIR_QUALITY_VERSION,
    shapeTerminologyVersion: "jev_generation_retry_v18", p5Enabled: true, humanLedMoveOn: true,
    visualPurposeVersion: version,
  };
}

function native(choices: Record<string, string>, otherAction?: string) {
  const wire: string[] = [];
  const client = createJevDecisionClient({ ...layout, enabled: true, participantPrompts: true,
    readKey: async () => "sk-or-SYNTHETIC-v19-purpose",
    fetchImpl: async (_url, init) => {
      const body = String(init?.body);
      wire.push(body);
      const payload = JSON.parse(body) as JevDecisionPayload;
      const answers = Object.fromEntries(Object.entries(payload.questions).map(([name, { criteria }]) => {
        const labels = Object.keys(criteria);
        const choice = choices[name] ?? labels[0];
        assert.ok(labels.includes(choice), `${name}: ${choice}`);
        return [name, { type: "choice", choice, probabilities: Object.fromEntries(labels.map(label =>
          [label, label === choice ? 1 : name === "action" && label === otherAction ? 0.75 : 0])) }];
      }));
      return Response.json({ model: JEV_DECISION_MODEL, id: `gen-v19-purpose-${wire.length}`, usage: { cost: 0 }, answers });
    },
  })!;
  return { client, wire };
}

test("v19 sends a scoped public purpose, with no visual feature choice or extra call", async () => {
  for (const figureCount of [4, 6] as const) for (const action of ["confirm", "repair"] as const) {
    const input = fixture(figureCount);
    const { client, wire } = native({ action, target: "figure_0", visual_purpose: "issue_0" });
    const decision = await client.decide(input, layout);
    assert.equal(wire.length, 3);
    const detail = JSON.parse(wire.at(-1)!) as JevDecisionPayload;
    assert.deepEqual(Object.keys(detail.questions), ["visual_purpose"]);
    assert.deepEqual(Object.keys(detail.questions.visual_purpose.criteria),
      ["clarify_reference", "resolve_mismatch", "unknown", "issue_0"]);
    assert.ok(!JSON.stringify(detail.questions.visual_purpose.criteria).includes(sharedFeature));
    assert.deepEqual(JSON.parse(detail.state).repairQuality.questions, ["3:local1", "3:local2"]);
    assert.equal(JSON.parse(detail.state).visualPurposeVersion, version);
    assert.equal(decision.feature, null);
    assert.deepEqual(decision.detailFigureIds, []);
    assert.deepEqual(decision.visualPurpose, { kind: "resolve_issue", issueId: "3:issue1", claimId: "3:local1", sourceTurn: 3 });
    assert.deepEqual(validateJevDecision(decision, input, layout), decision);
    assert.throws(() => validateJevDecision({ ...decision, feature: sharedFeature }, input, layout));
    assert.throws(() => validateJevDecision({ ...decision,
      visualPurpose: { kind: "resolve_issue", issueId: "3:issue2", claimId: "3:local2", sourceTurn: 3 } }, input, layout));
    assert.throws(() => validateJevDecision({ ...decision,
      visualPurpose: { kind: "resolve_issue", issueId: "3:issue1", claimId: "3:local1", sourceTurn: 2 } }, input, layout));
    const { visualPurpose: _purpose, ...missing } = decision;
    assert.throws(() => validateJevDecision(missing, input, layout));
  }
});

test("choosing between public questions leaves the same candidate set intact", async () => {
  const input = fixture(4);
  const { client, wire } = native({ action: "confirm", target: "figures_0_1", visual_purpose: "issue_1" });
  const decision = await client.decide(input, layout);
  assert.deepEqual(decision.target, { kind: "multiple", figureIds: ids.slice(0, 2) });
  assert.deepEqual(decision.visualPurpose, { kind: "resolve_issue", issueId: "3:issue2", claimId: "3:local2", sourceTurn: 3 });
  assert.equal(decision.feature, null);
  assert.deepEqual(decision.detailFigureIds, []);
  const questions = (JSON.parse(wire.at(-1)!) as JevDecisionPayload).questions;
  assert.deepEqual(Object.keys(questions.visual_purpose.criteria).slice(-2), ["issue_0", "issue_1"]);
});

test("missing visual detail leaves confirm, repair, unknown and targeted reobservation available", async () => {
  const input = fixture(4, []);
  input.priorClaims = [];
  input.reobservationAllowed = true;
  const payload = buildJevDecisionPayload(input, layout);
  for (const action of ["confirm", "repair", "request_observation"]) assert.ok(Object.hasOwn(payload.questions.action.criteria, action));
  const commonOnly = fixture(4);
  commonOnly.priorClaims = [];
  for (const current of [input, commonOnly]) {
    const unknown = native({ action: "confirm", target: "figure_0", visual_purpose: "unknown" });
    const decision = await unknown.client.decide(current, layout);
    assert.deepEqual(decision.visualPurpose, { kind: "unknown" });
    assert.equal(decision.feature, null);
    assert.deepEqual(decision.target, target());
    assert.equal(unknown.wire.length, 3);
  }
  const reobserve = native({ action: "request_observation", target: "figure_1", observe_aspect: "part" });
  const observation = await reobserve.client.decide(input, layout);
  assert.deepEqual(observation.target, target(1));
  assert.deepEqual(observation.observe?.figureIds, [ids[1]]);
  assert.equal(observation.observe?.aspect, "part");
  assert.equal(observation.visualPurpose, undefined);
  assert.deepEqual(Object.keys(JSON.parse(reobserve.wire.at(-1)!).questions), ["observe_targets", "observe_aspect"]);
});

test("the repair-first alternative uses the same purpose detail while bypass-enabled adopts defer", async () => {
  const input = fixture(6, []);
  const issue: RepairHistoryEntry = { turn: 1, issueId: "1:issue1", action: "confirm", question,
    partnerClaims: [], candidatesBefore: [ids[0]], candidatesAfter: [ids[0]], addedClaimIds: [], removedClaimIds: [], progress: "unknown" };
  input.repairHistory = [issue];
  const { client, wire } = native({ action: "defer", target: "figure_0", repair_issue: "issue_0",
    prospect: "uncertain", basis: "partner_uncertain", visual_purpose: "unknown", human_move_on_source: "other" }, "repair");
  input.repairProspect = await client.estimateRepairProspect!(input, layout);
  const original = await client.decide(input, layout);
  const options = { questionLayout: layout.questionLayout, rerank: "open_issue_v1" } as const;
  const bypass = await applyBypassAcceptance(input, original, interventionForStrategy("bypass-enabled", "bypass_acceptance_v2"),
    undefined, options);
  assert.equal(bypass.executed.action, "defer");
  assert.equal(bypass.executed.visualPurpose, undefined);
  const before = wire.length;
  const repair = await applyBypassAcceptance(input, original, interventionForStrategy("repair-first", "bypass_acceptance_v2"),
    (current, chosen) => client.completeDetail!(current, chosen, layout), options);
  assert.equal(wire.length, before + 1);
  assert.equal(repair.executed.action, "repair");
  assert.deepEqual(repair.executed.target, target());
  assert.deepEqual(repair.executed.visualPurpose, { kind: "unknown" });
  assert.equal(repair.executed.feature, null);
  assert.equal(repair.intervention.detailEvidence?.choices.visual_purpose, "unknown");
});

test("publication recovery retains the earlier purpose and can choose a fresh purpose and continuation in the existing calls", async () => {
  const input = fixture(6);
  const previous = { action: "confirm", target: target(), name: null, feature: null,
    visualPurpose: { kind: "resolve_issue", issueId: "3:issue1", claimId: "3:local1", sourceTurn: 3 } } as const;
  input.publicationRecoveryContext = { reason: "publication_mismatch", previous };
  input.reobservationAllowed = false;
  const { client, wire } = native({ action: "repair", target: "figure_0", visual_purpose: "resolve_mismatch",
    publication_continuation: "ask_unresolved" });
  const decision = await client.decide(input, layout);
  assert.equal(wire.length, 3);
  const actionStage = JSON.parse(wire[0]) as JevDecisionPayload;
  assert.deepEqual(JSON.parse(actionStage.state).publicationRecoveryContext.previous, previous);
  assert.ok(!Object.hasOwn(actionStage.questions.action.criteria, "request_observation"));
  assert.equal(decision.evidence.stages?.[0].choices.publication_continuation, "ask_unresolved");
  assert.deepEqual(decision.visualPurpose, { kind: "resolve_mismatch" });
  assert.throws(() => buildJevDecisionPayload({ ...input, publicationRecoveryContext: { reason: "publication_mismatch",
    previous: { ...previous, visualPurpose: { ...previous.visualPurpose, sourceTurn: 2 } } } }, layout), { code: "invalid_input" });
});

test("v18 preserves the byte-for-byte action, target, and feature requests", async () => {
  const { visualPurposeVersion: _purpose, ...legacy } = fixture(6);
  const input: JevDecisionInput = { ...legacy, discriminatingConfirmation: true };
  const { client, wire } = native({ action: "confirm", target: "figure_0", feature: "feature_0" });
  const decision = await client.decide(input, layout);
  assert.equal(decision.feature, sharedFeature);
  assert.equal(decision.visualPurpose, undefined);
  const detail = buildJevDecisionDetailPayload(input, { action: "confirm", target: target() }, layout);
  assert.ok(detail?.questions.feature);
  // Measured from the unmodified 23c0bb3 implementation with this synthetic input.
  assert.equal(createHash("sha256").update(JSON.stringify(wire)).digest("hex"), "c92c52e84d1da04455c98987aa1b3103260357e65cb64552be9076fa69bdb90c");
});
