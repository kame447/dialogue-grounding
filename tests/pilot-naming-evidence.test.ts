import assert from "node:assert/strict";
import test from "node:test";
import type { JevDecisionInput } from "../dialogue-model/runtime/decision/contract.ts";
import { buildHumanReferentPayload, buildJevDecisionDetailPayload, buildJevDecisionPayload, buildJevTargetPayload,
  buildRepairProspectPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { applyBypassAcceptance, interventionForStrategy } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import { buildJevNamingMaterial, readJevNamingGrounding } from "../dialogue-model/runtime/decision/jev-naming.ts";
import { createOwnLedger } from "../dialogue-model/runtime/judgment/schema.mjs";
import type { LocalSegmentProposal, PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { buildRecords, initialState, normal, OLD, OWN, runTurn } from "./support/s4-v3-records.ts";

const slots: string[] = OWN.ownAnchors.map((slot: { id: string }) => slot.id);
const feature = "丸い穴がある";
const name = "風見";
const propose = `呼び名を「${name}」にしませんか？`;
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const v15 = "jev_generation_retry_v15" as const;
const layout = { questionLayout: "two_stage_v3", dialoguePolicy: "holistic_v5" } as const;
const memo = structuredClone(OLD.state.observationMemo);
memo.figures[0].analytic.shapes = [feature];
const manifest = normal.run.manifest;
const profile = researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, "two_stage_v3", "holistic_v5");

function segment(quote: string, aspect: LocalSegmentProposal["aspect"], name: string | null = null): LocalSegmentProposal {
  return { segmentId: "one", respondsToTurn: null, linkedIssueId: null, targets: [slots[0]], aspect, quote, proposition: quote, name };
}

function input(approvalText = propose): JevDecisionInput {
  const publicTurns: PublicTurn[] = [
    { turn: 1, speaker: "human", text: "その形のことではなさそうです。" },
    { turn: 2, speaker: "ai", text: "穴のある形のことですか？" },
    { turn: 3, speaker: "human", text: approvalText },
  ];
  const nameClaim = { ...segment(approvalText, "name", name), id: "3:local1", turn: 3, sourceTurn: 3,
    issueId: "3:local1", speaker: "human", source: "partner_statement", respondsTo: null, act: "name_propose" } as const;
  const { names, localRejections } = buildJevNamingMaterial([nameClaim], publicTurns, 3, null);
  return { turn: 3, publicTurns, ownSlots: slots, observations: memo, issueSummary: "", priorClaims: [nameClaim],
    repairHistory: [], previousAction: null, publicNames: [], agreeNames: names, jevNaming: { localRejections },
    nameLedger: createOwnLedger(slots), namingRequest: true, namingRequestStrict: true, judgmentLedger: [],
    humanReferent: { status: "unknown", scores: null }, p5Enabled: true };
}

test("wire: public naming remains available on every own target with unknown referent and plan to accept", async () => {
  const material = input();
  const action = buildJevDecisionPayload(material, layout);
  assert.ok(Object.hasOwn(action.questions.action.criteria, "agree"));
  assert.ok(Object.hasOwn(action.questions.action.criteria, "accept"));
  assert.deepEqual(JSON.parse(action.state).namingEvidence, {
    names: [{ name, figureId: null, sourceTurn: 3 }], localRejections: [],
  });
  assert.deepEqual(Object.keys(buildJevTargetPayload(material, "agree").questions.target.criteria),
    slots.map((_, index) => `figure_${index}`));
  const detail = buildJevDecisionDetailPayload(material, { action: "agree", target: { kind: "single", figureId: slots[1] } }, layout);
  assert.ok(detail);
  assert.deepEqual(Object.keys(detail.questions), ["name", "naming_grounding", "naming_evidence"]);
  assert.deepEqual(JSON.parse(detail.questions.name.criteria.name_0), { value: name, figureIds: [slots[1]] });
  assert.deepEqual(Object.keys(detail.questions.naming_grounding.criteria), ["unresolved", "contradicted", "grounded_name_0"]);
  assert.deepEqual(Object.keys(detail.questions.naming_evidence.criteria), ["none", "turn_3"]);
  const long = buildJevDecisionDetailPayload({ ...material, turn: 256, publicTurns: [
    ...material.publicTurns, ...Array.from({ length: 253 }, (_, i) => ({
      turn: i + 4, speaker: "human" as const, text: "はい。",
    })),
  ] }, { action: "agree", target: { kind: "single", figureId: slots[1] } }, layout);
  assert.equal(JSON.parse(long!.state).publicTurns.length, 256);
  assert.deepEqual(Object.keys(long!.questions.naming_evidence.criteria), ["none", "turn_3"]);
  assert.deepEqual(JSON.parse(buildHumanReferentPayload(material).state).namingEvidence.names, material.agreeNames);
  assert.ok(buildRepairProspectPayload(material, layout).questions.prospect);
  const decision = {
    action: "agree", target: { kind: "single", figureId: slots[1] },
    name, feature: null, observe: null, decisionKind: "mock", calibrated: false,
    evidence: { model: null, responseId: null, latencyMs: 0, costUsd: null, choices: {}, scores: {} },
  };
  for (const label of ["repair-first", "bypass-enabled"] as const) {
    const result = await applyBypassAcceptance(material, decision, interventionForStrategy(label), undefined,
      { questionLayout: layout.questionLayout });
    assert.equal(result.intervention.disposition, "adopted");
    assert.deepEqual(result.executed.target, decision.target);
  }

  const { jevNaming: _, ...legacy } = material;
  const baseline = buildJevDecisionPayload({ ...legacy, agreeNames: [] }, layout);
  assert.equal(Object.hasOwn(baseline.questions.action.criteria, "agree"), false);
  assert.equal(Object.hasOwn(baseline.questions.action.criteria, "accept"), false);
  assert.equal(Object.hasOwn(JSON.parse(baseline.state), "namingEvidence"), false);
});

test("wire: absent and nonpublic names do not become legal grounds", () => {
  const material = input();
  const noName = buildJevDecisionPayload({ ...material, agreeNames: [] }, layout);
  assert.equal(Object.hasOwn(noName.questions.action.criteria, "agree"), false);
  assert.ok(Object.hasOwn(noName.questions.action.criteria, "accept"));
  for (const proposal of [{ name: "公開されていない名称", figureId: null, sourceTurn: 3 },
    { name: "穴", figureId: null, sourceTurn: 2 }]) {
    assert.throws(() => buildJevDecisionPayload({ ...material, agreeNames: [proposal] }, layout), /invalid_input/);
  }
});

test("wire: a rejected but literal human name stays evidence, not a graph acceptance", () => {
  const human = `前の「${name}」で決めよう。`;
  const turns: PublicTurn[] = [{ turn: 9, speaker: "human", text: human }];
  const segmentWithName = segment(human, "name", name);
  const evidence = { extractor: { segments: [segmentWithName] },
    classifier: { status: "ok", verdicts: [{ segmentId: "one", act: "name_accept" as const }] },
    verification: { rejected: [{ segmentId: "one", reason: "missing_claim_response" }] } };
  assert.deepEqual(buildJevNamingMaterial([], turns, 9, evidence), {
    names: [{ name, figureId: null, sourceTurn: 9 }],
    localRejections: [{ quote: human, reason: "missing_claim_response" }],
  });
  assert.equal(buildJevNamingMaterial([], turns, 9, { ...evidence,
    extractor: { segments: [{ ...segmentWithName, name: "捏造した名称" }] } }).names.length, 0);
});

test("wire: only the selected pair with an existing public source can be grounded", () => {
  const material = input();
  const outcome = (grounding: string, source: string) => readJevNamingGrounding({
    stage: "detail", choices: { name: "name_0", naming_grounding: grounding, naming_evidence: source },
  }, material.publicTurns, name, material.agreeNames!);
  assert.deepEqual(outcome("grounded_name_0", "turn_3"), { verdict: "grounded", evidenceTurn: 3 });
  assert.equal(outcome("grounded_name_1", "turn_3").verdict, "unconfirmed");
  assert.equal(outcome("grounded_name_0", "turn_1").verdict, "unconfirmed");
  assert.equal(outcome("grounded_name_0", "turn_9").verdict, "unconfirmed");
  assert.equal(outcome("unresolved", "none").verdict, "unresolved");
  assert.equal(outcome("contradicted", "none").verdict, "contradicted");
});

test("the next Jev request keeps the published recovery question open to all own figures", async () => {
  const reply = "もう一つの形には丸い穴があります。";
  const records = await buildRecords({
    dialoguePolicy: "holistic_v5", generationRetryVersion: v15, agreeNameScopeVersion: "jev_naming_v1", technicalTrial, memo,
    turns: [
      { human: propose, plan: { action: "agree", target: "figure_0", referent: "none", act: "name_propose",
        extraction: JSON.stringify([segment(propose, "name", name)]), choose: key =>
          key === "naming_grounding" ? "unresolved" : key === "naming_evidence" ? "none" : undefined } },
      { human: reply, plan: { action: "accept", target: "figure_1", referent: "figure_1", act: "assert",
        extraction: JSON.stringify([{ ...segment(reply, "part"), targets: [slots[1]] }]), speech: "丸い穴が目印になるんですね。" } },
    ],
  });
  const trial = records.trials[0];
  const { tape, result } = trial.replay[0];
  const recovered = tape.state.judgments.at(-1);
  const row = tape.state.repairHistory.at(-1);
  assert.equal(recovered.jevTurn.executed.target.figureId, slots[0]);
  assert.deepEqual(row.candidatesBefore, slots);
  for (const side of result.sides) {
    const action = side.requests.find((r: { provider: string; payload: { questions?: { action?: unknown } } }) =>
      r.provider === "jev" && Object.hasOwn(r.payload.questions ?? {}, "action"));
    assert.ok(action);
    const state = JSON.parse(action.payload.state);
    assert.deepEqual(state.previousAction, { turn: 2, action: "confirm",
      target: { kind: "multiple", figureIds: row.candidatesBefore }, name: null, feature: null });
    assert.deepEqual(Object.values(state.figures).map((figure: any) => figure.actions[0]),
      slots.map(() => ["confirm", 1, null, ["3:local1"]]));
  }
  assert.equal(recovered.judgment.targetSlot, null);
  assert.deepEqual(trial.lastCommittedState.repairHistory[0].partnerClaims[0].targets, [slots[1]]);
  assert.deepEqual(trial.lastCommittedState.ledger, tape.state.ledger);
});

for (const label of ["repair-first", "bypass-enabled"] as const) {
  test(`${label}: a selected agree can publish only after its own grounded detail`, async () => {
    const state = initialState({ profile, memo, generationRetryVersion: v15, agreeNameScopeVersion: "jev_naming_v1" });
    const events = [{ id: "event-1", seq: 1, speaker: "human", text: propose }];
    for (const verdict of ["grounded_name_0", "unresolved", "contradicted"] as const) {
      const published = await runTurn(profile, label, state, events, {
        action: "agree", target: "figure_0", referent: "none",
        extraction: JSON.stringify([segment(propose, "name", name)]), act: "name_propose",
        speech: `「${name}」と呼びましょう。`,
        choose: key => key === "naming_grounding" ? verdict : key === "naming_evidence"
          ? verdict === "grounded_name_0" ? "turn_1" : "none"
          : key === "human_referent" ? "none" : undefined,
      }, technicalTrial, v15);
      assert.equal(published.publication.status, "committed");
      assert.equal(published.trace.executed.action, "agree");
      if (verdict === "grounded_name_0") {
        assert.deepEqual(published.state.ledger[slots[0]], { status: "agreed", name });
        assert.equal(published.speech, `「${name}」と呼びましょう。`);
      } else {
        assert.deepEqual(published.state.ledger, state.ledger);
        assert.equal(published.trace.finalAction?.action, "confirm");
        assert.equal(published.trace.publicationRecovery?.reason, "naming_grounding_unresolved");
        assert.equal(published.luna.filter(call => call.phase === "generation").length, 0);
        const recovery = published.state.repairHistory.at(-1);
        assert.equal(recovery.question, published.speech);
        assert.deepEqual(recovery.candidatesBefore, slots);
        assert.equal(recovery.issueId, null);
        if (verdict === "unresolved") {
          const reply = "目印は端にある丸い穴です。";
          const next = await runTurn(profile, label, JSON.parse(JSON.stringify(published.state)),
            [...published.publication.publicEvents, { id: "event-3", seq: 3, speaker: "human", text: reply }],
            { action: "accept", target: "figure_0", referent: "figure_0", extraction: JSON.stringify([segment(reply, "part")]),
              act: "assert", speech: "丸い穴が目印になるんですね。" }, technicalTrial, v15);
          assert.equal(next.publication.status, "committed");
          assert.equal(next.state.repairHistory.find((r: { turn: number }) => r.turn === 1).partnerClaims.length, 1);
          assert.deepEqual(next.state.ledger, state.ledger);
        }
      }
    }
  });
}
