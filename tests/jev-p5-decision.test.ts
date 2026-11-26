import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHumanReferentPayload, buildJevDecisionDetailPayload, buildJevDecisionPayload, buildRepairProspectPayload,
  createJevDecisionClient, JEV_DECISION_MODEL, projectDecisionFailureEvidence, validateJevDecision,
} from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { applyBypassAcceptance, interventionForStrategy } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import { createMockJevDecisionClient } from "../dialogue-model/runtime/decision/mocks.ts";
import { decodeMaterialV5 } from "../dialogue-model/runtime/decision/judgment-material-v5.ts";
import type { JevDecisionInput } from "../dialogue-model/runtime/decision/contract.ts";
import type { LocalClaimView } from "../dialogue-model/runtime/local-grounding/contract.ts";

const v3 = { questionLayout: "two_stage_v3", dialoguePolicy: "holistic_v5" } as const;
const v3Options = { questionLayout: v3.questionLayout } as const;
const slots = ["own-0", "own-1", "own-2", "own-3", "own-4", "own-5"];
const target = { kind: "single" as const, figureId: slots[0] };
const readKey = async () => "sk-or-SYNTHETIC-p5-decision-000000";

function fixture({ fill = false, longEvidence = false } = {}): JevDecisionInput {
  const reading: LocalClaimView = {
    id: "1:reading", turn: 1, sourceTurn: 1, issueId: "1:reading", speaker: "human", source: "partner_statement",
    act: "construe", aspect: "construal", targets: [slots[0]], name: null, quote: "鳥に見えます", proposition: "鳥のような形",
    respondsTo: null,
  };
  const support: LocalClaimView = { ...reading, id: "2:support", turn: 2, sourceTurn: 2, speaker: "ai",
    source: "ai_hypothesis", act: "agree", quote: "こちらも鳥に見えます", respondsTo: reading.id };
  const format = (quote: string) => longEvidence ? quote + "長".repeat(10500) : quote;
  const turn = fill ? 66 : 4;
  return {
    p5Enabled: true, sharedConstruals: [{
      id: `sc:${reading.id}`, claimIds: [reading.id, support.id], figureIds: [slots[0]], construal: reading.proposition,
      openDetails: [{ issueId: "2:detail", aspect: "part", state: "unconfirmed", proposition: "先の形" }],
    }], judgmentLedger: [], turn, ownSlots: slots, previousAction: null, issueSummary: "", priorClaims: [reading, support],
    publicTurns: [
      { turn: 1, speaker: reading.speaker, text: format(reading.quote) },
      { turn: 2, speaker: support.speaker, text: format(support.quote) },
      ...Array.from({ length: turn - 3 }, (_, i) => ({ turn: i + 3, speaker: "ai" as const,
        text: fill ? `公開発話 ${i + 3}` + "保".repeat(600) : "次に確認しましょう。" })),
      { turn, speaker: "human", text: "大まかにはそれで大丈夫です。" },
    ],
    observations: { observedAt: "2000-01-01T00:00:00Z", figures: slots.map(id => ({
      id, region: { x: 0, y: 0, w: 1, h: 1 }, holistic: [],
      analytic: { shapes: ["尖った先"], composition: "", relations: [] }, unknowns: [], reobservations: [],
    })) }, publicNames: [],
    repairHistory: [{ turn: 2, issueId: "2:detail", action: "confirm", question: "先は尖っていますか？",
      partnerClaims: [], candidatesBefore: [slots[0]], candidatesAfter: [slots[0]], addedClaimIds: [], removedClaimIds: [], progress: "unknown" }],
  };
}

function mockTransport() {
  const sent: JevDecisionPayload[] = [];
  let preferredAction = "accept";
  let failDetail = false;
  const fetchImpl = async (_url: string, request: RequestInit) => {
    const payload: JevDecisionPayload = JSON.parse(String(request.body));
    sent.push(payload);
    if (failDetail && Object.hasOwn(payload.questions, "shared_construal")) return new Response("", { status: 502 });
    const preferences: Record<string, string> = { action: preferredAction, target: "figure_0", shared_construal: "use_0",
      human_referent: "none", repair_issue: "none", prospect: "uncertain", basis: "none" };
    return Response.json({ model: JEV_DECISION_MODEL, id: "gen-synthetic", usage: { cost: 0 },
      answers: Object.fromEntries(Object.entries(payload.questions).map(([key, question]) => {
        const labels = Object.keys(question.criteria);
        const choice = preferences[key] ?? labels[0];
        assert.ok(labels.includes(choice));
        return [key, { type: "choice", choice,
          probabilities: Object.fromEntries(labels.map(label => [label,
            label === choice ? 1 : key === "action" && label === "accept" ? 0.5 : 0])) }];
      })) });
  };
  const client = createJevDecisionClient({ ...v3, enabled: true, readKey, fetchImpl })!;
  return { client, sent, useMoveOn() { preferredAction = "move_on"; }, failSharedDetail() { failDetail = true; } };
}

test("referent, prospect, action, target, detail and veto detail keep the same P5 material and early public evidence", async () => {
  const input = fixture({ fill: true });
  const { client, sent, useMoveOn } = mockTransport();
  assert.equal((await client.estimateReferent(input)).status, "ok");
  assert.equal((await client.estimateRepairProspect(input)).status, "ok");
  const original = await client.decide(input, v3);
  assert.deepEqual(original.sharedClaimIds, input.sharedConstruals![0].claimIds);
  const untouched = await applyBypassAcceptance(input, original, interventionForStrategy("bypass-enabled"), undefined, v3Options);
  assert.deepEqual(untouched.executed.sharedClaimIds, original.sharedClaimIds);
  useMoveOn();
  const vetoed = await client.decide(input, v3);
  const afterVeto = await applyBypassAcceptance(input, vetoed, interventionForStrategy("repair-first"),
    (next, selected) => client.completeDetail(next, selected), v3Options);
  assert.equal(afterVeto.intervention.reasonCode, "vetoed_bypass_action");
  assert.equal(afterVeto.executed.action, "accept");
  assert.deepEqual(afterVeto.executed.sharedClaimIds, original.sharedClaimIds);
  assert.throws(() => validateJevDecision({ ...original, sharedClaimIds: ["1:reading", "forged"] }, input, v3Options),
    { code: "inconsistent_decision" });
  assert.deepEqual(sent.map(p => Object.keys(p.questions)), [
    ["human_referent"], ["repair_issue", "prospect", "basis"], ["action"], ["target"], ["shared_construal"],
    ["action"], ["target"], ["shared_construal"],
  ]);

  let first;
  for (const payload of sent) {
    const { selected: _selected, inputBudget, ...material } = JSON.parse(payload.state);
    assert.ok(payload.state.length <= 20000);
    assert.ok(inputBudget.omitted.publicTurns > 0);
    assert.deepEqual(material.sharedConstruals, input.sharedConstruals);
    assert.deepEqual(decodeMaterialV5({ ...material, inputBudget }).sharedConstruals, input.sharedConstruals);
    assert.deepEqual(material.claims.map((row: string[]) => row[0]), ["1:reading", "2:support"]);
    assert.deepEqual(material.publicTurns.slice(0, 2), ["U1 h: 鳥に見えます", "U2 ai: こちらも鳥に見えます"]);
    if (first === undefined) first = material;
    else assert.deepEqual(material, first);
  }
});

test("missing or unaffordable P5 source evidence fails before sending a request", async () => {
  const original = fixture();
  const input = { ...original, publicTurns: original.publicTurns.slice(1) };
  for (const build of [buildHumanReferentPayload, buildRepairProspectPayload]) assert.throws(() => build(input), { code: "invalid_input" });
  assert.throws(() => buildJevDecisionPayload(input, v3), { code: "invalid_input" });
  const overBudget = fixture({ longEvidence: true });
  const { client, sent } = mockTransport();
  await assert.rejects(client.decide(overBudget, v3), { code: "invalid_input" });
  assert.equal(sent.length, 0);
  const { p5Enabled: _mode, ...version12 } = fixture();
  assert.throws(() => buildJevDecisionPayload(version12, v3), { code: "invalid_input" });
  const { sharedConstruals: _shared, ...legacy } = version12;
  assert.ok(!Object.hasOwn(JSON.parse(buildJevDecisionPayload(legacy, v3).state), "sharedConstruals"));
  assert.equal(buildJevDecisionDetailPayload(legacy, { action: "accept", target }, v3Options), null);
});

test("claim compaction exhausts unrelated rows without evicting a candidate's proof", () => {
  const input = fixture();
  const support = input.priorClaims[1];
  input.priorClaims = [...input.priorClaims, ...Array.from({ length: 130 }, (_, i) => ({
    ...support, id: `2:filler-${i}`, act: "assert" as const, aspect: "part" as const,
    respondsTo: null, proposition: "別の細部" + "細".repeat(135),
  }))];
  const { claims, inputBudget } = JSON.parse(buildJevDecisionPayload(input, v3).state);
  assert.ok(inputBudget.omitted.claims > 0);
  assert.deepEqual(claims.slice(0, 2).map((row: string[]) => row[0]), ["1:reading", "2:support"]);
});

test("only a covering figure is offered; a strict naming request can still confirm without accepting a name", async () => {
  const input = fixture();
  assert.equal(buildJevDecisionDetailPayload(input, { action: "accept", target: { ...target, figureId: slots[1] } }, v3Options), null);
  const naming = { ...input, namingRequest: true as const, namingRequestStrict: true as const };
  assert.ok(!Object.hasOwn(buildJevDecisionPayload(naming, v3).questions.action.criteria, "accept"));
  const detail = buildJevDecisionDetailPayload(naming, { action: "confirm", target }, v3Options)!;
  assert.deepEqual(Object.keys(detail.questions), ["feature", "shared_construal"]);
  const mock = createMockJevDecisionClient(() => ({ action: "confirm", target, feature: "尖った先",
    name: null, observe: null, sharedClaimIds: input.sharedConstruals![0].claimIds }));
  assert.deepEqual((await mock.decide(naming)).sharedClaimIds, input.sharedConstruals![0].claimIds);
});

test("the existing input budget allows 65 supported alternatives and no fixed label cap", () => {
  const input = fixture();
  const [reading, support] = input.priorClaims;
  const pairs = Array.from({ length: 65 }, (_, i) => [
    { ...reading, id: `r${i}`, issueId: `r${i}`, proposition: "鳥" },
    { ...support, id: `s${i}`, issueId: `r${i}`, respondsTo: `r${i}`, proposition: "鳥" },
  ]);
  input.priorClaims = pairs.flat();
  input.sharedConstruals = pairs.map(([r, s]) => ({
    id: `sc:${r.id}`, claimIds: [r.id, s.id], figureIds: [slots[0]], construal: r.proposition, openDetails: [],
  }));
  const payload = buildJevDecisionDetailPayload(input, { action: "accept", target }, v3Options)!;
  assert.equal(Object.keys(payload.questions.shared_construal.criteria).length, 66);
  assert.deepEqual(JSON.parse(payload.questions.shared_construal.criteria.use_64).claimIds, ["r64", "s64"]);
});

test("a failed accept detail is admissible evidence only under the P5 mode", async () => {
  const input = fixture(), { client, failSharedDetail } = mockTransport();
  failSharedDetail();
  let failure: unknown;
  await assert.rejects(client.decide(input, { ...v3, onFailureEvidence(raw) { failure = raw; } }), { code: "upstream_error" });
  assert.equal(projectDecisionFailureEvidence(failure, v3.questionLayout), null);
  const checked = projectDecisionFailureEvidence(failure, v3.questionLayout, { p5Enabled: true });
  assert.deepEqual(checked?.stages.map(({ stage, status }) => [stage, status]),
    [["action", "ok"], ["target", "ok"], ["detail", "error"]]);
});

test("a recorded P5 detail requires the closed consecutive menu labels", async () => {
  const { client } = mockTransport();
  const { evidence } = await client.decide(fixture(), v3);
  const failure = { ...evidence, callIndex: 1, status: "error", error: "timeout", rejectionCode: null,
    stages: evidence.stages!.map(stage => ({ ...stage, status: "ok", error: null, rejectionCode: null })) };
  const mode = { p5Enabled: true };
  assert.ok(projectDecisionFailureEvidence(failure, v3.questionLayout, mode));
  const detail = failure.stages[2];
  detail.choices.shared_construal = "use_2";
  detail.scores.shared_construal = { none: 0, use_2: 1 };
  assert.equal(projectDecisionFailureEvidence(failure, v3.questionLayout, mode), null);
});
