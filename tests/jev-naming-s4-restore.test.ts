import assert from "node:assert/strict";
import test from "node:test";
import { interventionForStrategy } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { validateJevPrivateStateV2 } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { buildRecords, OLD, OWN, publicFocusTurn, runTurn } from "./support/s4-v3-records.ts";
import type { Label, Plan, Turn } from "./support/s4-v3-records.ts";

const generation = "jev_generation_retry_v15";
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const options = { dialoguePolicy: "holistic_v5", generationRetryVersion: generation,
  agreeNameScopeVersion: "jev_naming_v1", technicalTrial } as const;
const slots: string[] = OWN.ownAnchors.map((a: { id: string }) => a.id);
const name = "輪のランタン";
const turnText = `その名前は「${name}」にします。`;

function proposal(verdict: string, plan: Partial<Plan> = {}, act = "name_propose"): Turn {
  return { human: turnText, plan: { action: "agree", target: "figure_1", referent: "figure_0",
    speech: `「${name}」と呼びましょう。`,
    extraction: JSON.stringify([{ segmentId: "s1", quote: turnText, proposition: turnText, targets: [slots[0]],
      respondsToTurn: null, linkedIssueId: null, aspect: "name", name }]),
    act, choose: key => key === "naming_grounding" ? verdict : key === "naming_evidence" ? "turn_3" : undefined,
    ...plan } };
}

function verify(records: Awaited<ReturnType<typeof buildRecords>>) {
  const rows = verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0."));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter(c => c.status !== "pass"), []);
}

async function record(label: Label, turn: Turn, ledger?: Record<string, any>) {
  let last: Awaited<ReturnType<typeof runTurn>> | undefined;
  const records = await buildRecords({ ...options, label, ledger, turns: [publicFocusTurn(), turn],
    onTurn: (side, result) => { if (side === label) last = result; } });
  assert.ok(last);
  verify(records);
  return { records, last };
}

function restore(label: Label, state: any, events: any[]) {
  return validateJevPrivateStateV2(JSON.parse(JSON.stringify(state)), slots, interventionForStrategy(label),
    "two_stage_v3", "holistic_v5", generation, undefined, events);
}

for (const label of ["repair-first", "bypass-enabled"] as const) {
  test(`${label} certifies a grounded name with a real human source and the selected own slot`, async () => {
    const { last, records } = await record(label, proposal("grounded_name_0"));
    assert.deepEqual(last.trace.namingGrounding, { verdict: "grounded", evidenceTurn: 3 });
    assert.deepEqual(last.state.ledger[slots[1]], { status: "agreed", name });
    assert.equal(last.state.ledger[slots[0]].status, "unassigned");
    restore(label, last.state, last.publication.publicEvents);
    const requests = records.trials[0].replay[0].result.sides[0].requests;
    const action = requests.find((r: any) => r.payload?.questions?.action);
    const target = requests.find((r: any) => r.payload?.questions?.target);
    assert.ok(Object.hasOwn(action.payload.questions.action.criteria, "accept"));
    assert.deepEqual(Object.keys(target.payload.questions.target.criteria), slots.map((_, i) => "figure_" + i));
    assert.deepEqual(JSON.parse(action.payload.state).namingEvidence.names, [{ name, figureId: null, sourceTurn: 3 }]);
    const forged = structuredClone(last.state);
    forged.judgments.at(-1).namingGrounding.evidenceTurn = 2;
    assert.throws(() => restore(label, forged, last.publication.publicEvents), { code: "invalid_state" });
    const forgedRecords = structuredClone(records);
    const trial = forgedRecords.trials[0];
    for (const copy of [trial.attempts[0], trial.turns[0].trace[0], trial.turns[0].state.judgments.at(-1),
      trial.lastCommittedState.judgments.at(-1)]) copy.namingGrounding.evidenceTurn = 2;
    const checked = verifyRecords(forgedRecords).checks;
    assert.equal(checked.find(c => c.id === "intervention.trial.0.attempt.0.binding")?.status, "pass");
    assert.equal(checked.find(c => c.id === "intervention.trial.0.attempt.0.replay")?.status, "mismatch");
  });
}

test("a rejected local naming interpretation remains evidence and an unresolved decision publishes a confirmation without generation", async () => {
  const label = "repair-first";
  const { last, records } = await record(label, proposal("unresolved", {}, "name_accept"));
  const tr = records.trials[0];
  const action = tr.replay[0].result.sides[0].requests.find((r: any) => r.payload?.questions?.action);
  assert.deepEqual(JSON.parse(action.payload.state).namingEvidence.localRejections,
    [{ quote: turnText, reason: "missing_claim_response" }]);
  assert.equal(last.trace.executed.action, "agree");
  assert.equal(last.trace.finalAction?.action, "confirm");
  assert.equal(last.trace.publicationRecovery?.reason, "naming_grounding_unresolved");
  assert.equal(last.luna.some(call => call.phase === "generation"), false);
  assert.deepEqual(last.state.ledger, tr.replay[0].tape.state.ledger);
  assert.deepEqual(last.state.repairHistory.at(-1).candidatesBefore, slots);
  const installed = restore(label, last.state, last.publication.publicEvents);
  const continued = await runTurn(tr.profile, label, installed,
    [...last.publication.publicEvents, { id: "event-5", seq: 5, speaker: "human", text: "輪と台がつながる部分です。" }],
    { action: "accept", target: "figure_0", referent: "figure_0", speech: "その部分が目印なんですね。" },
    technicalTrial, generation);
  assert.equal(continued.publication.status, "committed");
  assert.equal(continued.state.judgments[1].judgment.action, "confirm");
  assert.deepEqual(continued.state.ledger, last.state.ledger);
  const forged = structuredClone(last.state);
  forged.repairHistory.at(-1).question = "保存された公開発話と異なる質問です。";
  assert.throws(() => restore(label, forged, last.publication.publicEvents), { code: "invalid_state" });
});

test("a ledger conflict and mismatching v15 drafts each preserve the ledger", async () => {
  const label = "bypass-enabled";
  const ledger = { ...structuredClone(OLD.state.ledger), [slots[0]]: { status: "agreed", name } };
  const conflict = await record(label, proposal("grounded_name_0"), ledger);
  assert.equal(conflict.last.trace.publicationRecovery?.reason, "naming_ledger_conflict");
  assert.deepEqual(conflict.last.state.ledger, ledger);
  restore(label, conflict.last.state, conflict.last.publication.publicEvents);

  const wrongDrafts = await record(label, proposal("grounded_name_0", {
    drafts: ["別の形をろうそくと呼びましょう。", "別の形をろうそくと呼びましょう。"],
    choose: key => key === "naming_grounding" ? "grounded_name_0" : key === "naming_evidence" ? "turn_3"
      : key === "draft_naming" ? "adopt_other" : undefined,
  }));
  assert.equal(wrongDrafts.last.trace.publicationRecovery?.reason, "draft_content_mismatch");
  assert.deepEqual(wrongDrafts.last.state.ledger, OLD.state.ledger);
  restore(label, wrongDrafts.last.state, wrongDrafts.last.publication.publicEvents);
});

test("the strategy veto still distinguishes a self-initiated move from the selected replacement", async () => {
  const { records } = await record("repair-first", proposal("contradicted", {
    action: "move_on", speech: "別の形の見立ても聞かせてもらえますか？",
    actionScores: { move_on: 1, agree: 0.9 },
  }));
  const [left, right] = records.trials[0].replay[0].result.sides;
  assert.equal(left.intervention.reasonCode, "vetoed_bypass_action");
  assert.equal(left.executed.action, "agree");
  assert.equal(right.intervention.reasonCode, "no_intervention");
  assert.equal(right.executed.action, "move_on");
});
