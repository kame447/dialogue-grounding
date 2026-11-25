// audit/02 §3-§5 (A, B, C2, D, E groups and the research budget ceiling) at the client/contract boundary.
// Synthetic data, fake Keychain and loopback HTTP only. Never invokes a live model.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { createJevDecisionClient, buildJevDecisionPayload, buildJevDecisionDetailPayload, buildHumanReferentPayload, buildRepairProspectPayload,
  buildJevCandidateSetPayload, validateJevDecision, projectDecisionFailureEvidence, checkDecisionFailureEvidence, JevDecisionError,
  TWO_STAGE_V2_CANDIDATE_SETS, TWO_STAGE_V2_STAGES, TWO_STAGE_V2_CANDIDATE_SET_INSTRUCTIONS, TWO_STAGE_V2_OBSERVE_TARGETS, candidateSetLabel,
  JEV_DECISION_MODEL } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { JEV_ACTIONS } from "../dialogue-model/runtime/decision/contract.ts";
import type { JevDecisionInput, JevQuestionLayout, JevDecision } from "../dialogue-model/runtime/decision/contract.ts";
import { applyBypassAcceptance, interventionForStrategy, BYPASS_ACCEPTANCE_V1_CANONICAL_JSON, BYPASS_ACCEPTANCE_V1_TABLE_SHA256,
  BYPASS_ACCEPTANCE_V1 } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import { createJevLocalTestClassifier } from "../dialogue-model/runtime/local-grounding/jev-local-test.ts";
import { createJevAiFunctionClassifier, createJevAiSupportChecker } from "../dialogue-model/runtime/local-grounding/jev-ai-public.ts";
import { DEFAULT_COST_CAP_USD, RESEARCH_MAX_JEV_USD } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/local-openrouter.ts";
import { researchHash, researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { RESEARCH_MAX_DEADLINE_MS } from "../dialogue-model/runtime/v2/research-timeouts.ts";
import { OPENROUTER_DECISIONS_URL } from "../workers/research-ai-proxy/src/grounding.ts";

const KEY = "sk-or-SYNTHETIC-two-stage-v2-key-0000000";
const readKey = async () => KEY;
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const slots = Array.from({ length: 6 }, (_, i) => `own-${i}`);
const memo = { observedAt: "2026-11-20T00:00:00.000Z", figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
  holistic: [{ construal: i === 0 ? "船" : `見立て${i}`, basis: ["細い部分"], status: "hypothesis" as const }],
  analytic: { shapes: [`三角${i}`, `四角${i}`], composition: `構成${i}`, relations: [`関係${i}`] }, unknowns: [], reobservations: [] })) };
function base(): JevDecisionInput {
  return { turn: 4, ownSlots: slots, observations: structuredClone(memo), issueSummary: "対象が未特定", priorClaims: [], repairHistory: [], previousAction: null,
    publicTurns: [{ turn: 1, speaker: "ai", text: "まず、どの図形から話しましょうか？" }, { turn: 2, speaker: "human", text: "細長い形を船と呼びたいです" },
      { turn: 3, speaker: "ai", text: "この形を船と呼ぶのはどうですか" }, { turn: 4, speaker: "human", text: "どれのことか分からないです" }],
    publicNames: [{ name: "船", figureId: slots[0], sourceTurn: 3 }] } as JevDecisionInput;
}
function rich(): JevDecisionInput {
  return { ...base(), agreeNames: [{ name: "船", figureId: slots[0], sourceTurn: 3 }], reobservationAllowed: true,
    humanReferent: { status: "ok", scores: { "own-0": 0.1, "own-1": 0.1, "own-2": 0.05, "own-3": 0.1, "own-4": 0.05, "own-5": 0.05, none: 0, multiple: 0.55 } } };
}
type Answer = { model: string; id: string; answers: Record<string, unknown>; usage: Record<string, number> };
function answer(payload: JevDecisionPayload, preferences: Record<string, string> = {}, cost: number | null = 0.0001): Answer {
  return { model: JEV_DECISION_MODEL, id: "gen-two-stage-v2", answers: Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => {
    const selected = preferences[key] ?? (key === "action" ? "accept" : key === "target" ? "none" : key.startsWith("candidate_") && key !== "candidate_set" ? "exclude" : Object.keys(q.criteria)[0]);
    return [key, { type: "choice", choice: selected, probabilities: Object.fromEntries(Object.keys(q.criteria).map(l => [l, l === selected ? 0.75 : 0.25 / (Object.keys(q.criteria).length - 1)])), confidence: 1 }];
  })), usage: { input_tokens: 10, output_tokens: 0, ...(cost === null ? {} : { cost }) } };
}
type Reply = { body?: unknown; raw?: string; status?: number; delayMs?: number };
async function httpMock(t: TestContext, respond: (p: JevDecisionPayload, index: number) => Reply) {
  const requests: JevDecisionPayload[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as JevDecisionPayload;
    requests.push(payload);
    const result = respond(payload, requests.length - 1);
    if (result.delayMs) await new Promise(r => setTimeout(r, result.delayMs));
    if (res.destroyed) return;
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(result.raw ?? JSON.stringify(result.body ?? {}));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { requests, fetchImpl: async (url: string, init: RequestInit) => {
    assert.equal(url, OPENROUTER_DECISIONS_URL);
    return fetch(`http://127.0.0.1:${address.port}`, init);
  } };
}
/** Answers each stage by its question keys: stage one, the candidate set, then detail. */
function staged(choices: { stage1: Record<string, string>; set?: string; detail?: Record<string, string> }, cost: (key: string) => number | null = () => 0.0001) {
  return (p: JevDecisionPayload): Reply => {
    const keys = Object.keys(p.questions);
    if (keys.includes("action")) return { body: answer(p, choices.stage1, cost("stage1")) };
    if (keys.includes("candidate_set")) return { body: answer(p, choices.set ? { candidate_set: choices.set } : {}, cost("set")) };
    return { body: answer(p, choices.detail ?? {}, cost("detail")) };
  };
}
const code = (wanted: string) => (e: unknown) => e instanceof JevDecisionError && e.code === wanted;
const client = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>, questionLayout: JevQuestionLayout, extra = {}) =>
  createJevDecisionClient({ enabled: true, readKey, fetchImpl, questionLayout, ...extra })!;

// Digests computed at the base commit 2dbf7e2 from the same synthetic inputs, before any change.
const V1_BASE_DIGESTS: Record<string, string> = {
  "base.stage1": "67597674023b003b64662a89cfce4a8b44b6dcc877aaa1e353499b804aa41c67",
  "base.referent": "022fab4b3ee13a2c8651e3f10cbc418910dbd2cd324e4d4fe740c5538857f31b",
  "base.prospect": "3195046006b55369a9a52432ee972808ea8555cb0e7a67cd78105bb64ac0e83d",
  "base.detail.confirmSingle": "88f1afa8d22cbd702dfc719c42d9a9842d9b109014d45056d94f738ea2ae6ae1",
  "base.detail.repairMultiple": "b47e1b366e3827d625123f09b33a869df26321afe30e8ad97fe6f64dd5ecde02",
  "base.detail.proposeSingle": "7837dc7f61d3b57400dceb06dfa73f0f9bdad198d6fdfc59792a26cce9e6539d",
  "base.detail.observeMultiple": "86badd4c0a3a574acd2103b59b775f667eadbaa974c352445485a18ed23a7fde",
  "rich.stage1": "ed229b33a0b3e3e277658fd4aa5eaf5531760c93d3abe1bdfff907f0bcb55aa8",
  "rich.referent": "022fab4b3ee13a2c8651e3f10cbc418910dbd2cd324e4d4fe740c5538857f31b",
  "rich.prospect": "c7ca274af10839d3d92f63da1f558323e84e28ffff0594a60e9801157739611b",
  "rich.detail.confirmSingle": "0400d9c74a052c2fc5381810b308227f9085f86ad8d35a08cdff08be99670b12",
  "rich.detail.repairMultiple": "0ec7f1fb312ef39585b9181b7431dccbc0ea14858e56aa50920e0fcf4e7b4455",
  "rich.detail.proposeSingle": "2da2e5837d04e8aeb01cdcc6d9a3570deed64eadc322af725a4f3a3c9445d423",
  "rich.detail.observeMultiple": "dac24d7b9097c9e7b73cd22418206462db8ac534fb3525163ad41aaf76f24d76",
  "rich.detail.agreeSingle": "fbc03c8bfb3fa9b1b3c22fa65981c46a8ae8491e21b9f2c43be50691c225767e",
};

test("C2-1: two_stage_v1 request bodies stay byte-identical to the base commit", () => {
  for (const [name, input] of Object.entries({ base: base(), rich: rich() })) {
    assert.equal(sha(buildJevDecisionPayload(input)), V1_BASE_DIGESTS[`${name}.stage1`]);
    assert.equal(sha(buildJevDecisionPayload(input, { questionLayout: "two_stage_v1" })), V1_BASE_DIGESTS[`${name}.stage1`]);
    assert.equal(sha(buildHumanReferentPayload(input)), V1_BASE_DIGESTS[`${name}.referent`]);
    assert.equal(sha(buildRepairProspectPayload(input)), V1_BASE_DIGESTS[`${name}.prospect`]);
    const selections = { confirmSingle: { action: "confirm", target: { kind: "single", figureId: "own-1" } },
      repairMultiple: { action: "repair", target: { kind: "multiple", figureIds: ["own-0", "own-2"] } },
      proposeSingle: { action: "propose_name", target: { kind: "single", figureId: "own-0" } },
      observeMultiple: { action: "request_observation", target: { kind: "multiple", figureIds: ["own-1", "own-3"] } },
      ...(name === "rich" ? { agreeSingle: { action: "agree", target: { kind: "single", figureId: "own-0" } } } : {}) } as const;
    for (const [label, selected] of Object.entries(selections)) assert.equal(sha(buildJevDecisionDetailPayload(input, selected as never)), V1_BASE_DIGESTS[`${name}.detail.${label}`], label);
  }
  assert.equal(Object.keys(buildJevDecisionPayload(base()).questions).length, 8);
  assert.equal(createJevDecisionClient({ enabled: true, readKey })!.metadata.questionLayout, "two_stage_v1");
  // The v1 research profile is unchanged; only an explicit v2 changes its digest.
  const lunaRequest = { timeoutMs: null, maxCompletionTokens: 1000 }, timeouts = { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 };
  assert.equal(researchHash(researchTrialProfileV3(lunaRequest, timeouts)), researchHash(researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v1")));
  assert.equal(researchTrialProfileV3(lunaRequest, timeouts).questionLayout, "two_stage_v1");
  assert.equal(researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v2").questionLayout, "two_stage_v2");
  assert.notEqual(researchHash(researchTrialProfileV3(lunaRequest, timeouts)), researchHash(researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v2")));
  assert.throws(() => researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v9" as never), /invalid_question_layout/);
});

test("C2-2: v2 stage one asks action and target only; the candidate set lists exactly the 57 subsets of 2-6 own figures", () => {
  const input = rich(), v1 = buildJevDecisionPayload(input), v2 = buildJevDecisionPayload(input, { questionLayout: "two_stage_v2" });
  assert.deepEqual(Object.keys(v2.questions), ["action", "target"]);
  assert.deepEqual(v2.questions.action.criteria, v1.questions.action.criteria);
  assert.deepEqual(v2.questions.target.criteria, v1.questions.target.criteria);
  assert.equal(v2.state, v1.state, "same material; the layout changes the questions only");
  assert.ok(v2.questions.action.instructions.includes(TWO_STAGE_V2_STAGES) && !v1.questions.action.instructions.includes(TWO_STAGE_V2_STAGES));
  const sets = TWO_STAGE_V2_CANDIDATE_SETS, sizes = [2, 3, 4, 5, 6].map(n => sets.filter(s => s.length === n).length);
  assert.deepEqual(sizes, [15, 20, 15, 6, 1]); assert.equal(sets.length, 57);
  const labels = sets.map(candidateSetLabel);
  assert.equal(new Set(labels).size, 57);
  for (let i = 1; i < sets.length; i++) { // size, then lexicographic slot order
    const a = sets[i - 1], b = sets[i];
    assert.ok(a.length < b.length || a.length === b.length && a.join(",") < b.join(","));
    assert.ok(b.every((x, j) => j === 0 || x > b[j - 1]));
  }
  const setPayload = buildJevCandidateSetPayload(input, "confirm");
  assert.deepEqual(Object.keys(setPayload.questions), ["candidate_set"]);
  const criteria = setPayload.questions.candidate_set.criteria;
  assert.deepEqual(Object.keys(criteria), labels);
  for (const set of sets) assert.ok(criteria[candidateSetLabel(set)].includes(JSON.stringify(set.map(i => slots[i]))));
  assert.ok(setPayload.questions.candidate_set.instructions.endsWith(TWO_STAGE_V2_CANDIDATE_SET_INSTRUCTIONS));
  assert.deepEqual(JSON.parse(setPayload.state).selected, { action: "confirm", target: { kind: "multiple" } });
  // D: the added stage carries no condition, strategy, seed or partner material.
  for (const payload of [v2, setPayload]) assert.doesNotMatch(JSON.stringify(payload), /repair-first|bypass-enabled|bypass_acceptance|veto|strategy|seed|human-side|partner/u);
  assert.ok(buildJevDecisionDetailPayload(input, { action: "request_observation", target: { kind: "multiple", figureIds: ["own-1", "own-3"] } }, { questionLayout: "two_stage_v2" })!
    .questions.observe_targets.instructions.endsWith(TWO_STAGE_V2_OBSERVE_TARGETS));
});

test("C2-5 / §3: v2 POST counts per selection, with the multiple set and detail carried into the decision", async t => {
  const cases: Array<{ name: string; stage1: Record<string, string>; set?: string; detail?: Record<string, string>; posts: number; check: (d: JevDecision) => void }> = [
    { name: "single, no detail", stage1: { action: "accept", target: "figure_1" }, posts: 1, check: d => assert.deepEqual(d.target, { kind: "single", figureId: "own-1" }) },
    { name: "single, detail", stage1: { action: "confirm", target: "figure_1" }, posts: 2, check: d => assert.equal(d.evidence.stages!.length, 2) },
    { name: "multiple, no detail", stage1: { action: "defer", target: "multiple" }, set: "figures_0_2", posts: 2,
      check: d => assert.deepEqual(d.target, { kind: "multiple", figureIds: ["own-0", "own-2"] }) },
    { name: "multiple, confirm", stage1: { action: "confirm", target: "multiple" }, set: "figures_1_3_4", posts: 3,
      check: d => { assert.deepEqual(d.target, { kind: "multiple", figureIds: ["own-1", "own-3", "own-4"] }); assert.deepEqual(d.evidence.stages!.map(s => s.stage), ["action_target", "multiple_candidates", "detail"]);
        assert.ok(d.detailFigureIds!.every(id => ["own-1", "own-3", "own-4"].includes(id))); } },
    { name: "multiple, request_observation", stage1: { action: "request_observation", target: "multiple" }, set: "figures_0_5", posts: 3,
      check: d => { assert.ok(d.observe!.figureIds.every(id => ["own-0", "own-5"].includes(id))); assert.equal(d.evidence.stages!.length, 3); } },
  ];
  for (const c of cases) {
    const http = await httpMock(t, staged(c));
    const decision = await client(http.fetchImpl, "two_stage_v2").decide(rich());
    assert.equal(http.requests.length, c.posts, c.name); c.check(decision);
    assert.equal(decision.evidence.costUsd, decision.evidence.stages!.reduce((n, s) => n + s.costUsd!, 0));
    assert.deepEqual(validateJevDecision(decision, rich(), { questionLayout: "two_stage_v2" }), decision, c.name);
    assert.throws(() => validateJevDecision(decision, rich()), (e: unknown) => e instanceof JevDecisionError, "v1 validation refuses v2 evidence");
  }
  // agree/propose_name with a multiple or no target stop after stage one: no candidate-set POST.
  for (const [action, target, error, rule] of [["agree", "multiple", "invalid_decision", "name_requires_single_target"], ["propose_name", "multiple", "invalid_decision", "name_requires_single_target"],
    ["agree", "none", "invalid_decision", "name_requires_single_target"], ["confirm", "none", "invalid_decision", "detail_target_required"],
    ["request_observation", "none", "invalid_decision", "detail_target_required"], ["agree", "figure_1", "inconsistent_decision", "name_required"]]) {
    const http = await httpMock(t, staged({ stage1: { action, target } }));
    const c = client(http.fetchImpl, "two_stage_v2");
    await assert.rejects(c.decide(rich()), code(error), `${action}/${target}`);
    assert.equal(http.requests.length, 1, `${action}/${target} sends no further POST`);
    assert.equal(c.lastEvidence!.rejectionCode, rule); assert.equal(c.lastEvidence!.stages[0].rejectionCode, rule);
  }
});

test("C2-2: malformed candidate-set answers, unknown cost and timeout fail closed with no detail POST", async t => {
  for (const label of ["figures_1_0", "figures_0_0", "figures_0_6", "figures_0", "figures_", "subset_0"]) {
    const http = await httpMock(t, p => Object.keys(p.questions).includes("candidate_set") ?
      { body: (b => (b.answers.candidate_set = { type: "choice", choice: label, probabilities: (b.answers.candidate_set as { probabilities: unknown }).probabilities, confidence: 1 }, b))(answer(p)) }
      : staged({ stage1: { action: "confirm", target: "multiple" } })(p));
    await assert.rejects(client(http.fetchImpl, "two_stage_v2").decide(rich()), code("invalid_response"), label);
    assert.equal(http.requests.length, 2, label);
  }
  for (const mutate of [(b: Answer) => { delete b.answers.candidate_set; }, (b: Answer) => { b.answers.extra = b.answers.candidate_set; }]) {
    const http = await httpMock(t, p => Object.keys(p.questions).includes("candidate_set") ? { body: (b => (mutate(b), b))(answer(p)) } : staged({ stage1: { action: "confirm", target: "multiple" } })(p));
    await assert.rejects(client(http.fetchImpl, "two_stage_v2").decide(rich()), code("invalid_response")); assert.equal(http.requests.length, 2);
  }
  const unpriced = await httpMock(t, staged({ stage1: { action: "confirm", target: "multiple" } }, key => key === "set" ? null : 0.0001));
  await assert.rejects(client(unpriced.fetchImpl, "two_stage_v2").decide(rich()), code("cost_unreported")); assert.equal(unpriced.requests.length, 2);
  const slow = await httpMock(t, p => Object.keys(p.questions).includes("candidate_set") ? { body: answer(p), delayMs: 400 } : staged({ stage1: { action: "confirm", target: "multiple" } })(p));
  await assert.rejects(client(slow.fetchImpl, "two_stage_v2", { timeoutMs: 150 }).decide(rich()), code("timeout"));
  await new Promise(r => setTimeout(r, 450)); assert.equal(slow.requests.length, 2, "no detail POST after the set stage timed out");
});

test("C2: replay rejects missing, extra, swapped, substituted or relabelled stages", async t => {
  const http = await httpMock(t, staged({ stage1: { action: "confirm", target: "multiple" }, set: "figures_1_3_4" }));
  const good = await client(http.fetchImpl, "two_stage_v2").decide(rich()), stages = good.evidence.stages!;
  const variants: Array<[string, (d: JevDecision) => void, string]> = [
    ["missing set stage", d => { d.evidence.stages = [stages[0], stages[2]]; }, "invalid_response"],
    ["extra stage", d => { d.evidence.stages = [stages[0], stages[1], stages[1], stages[2]]; }, "invalid_response"],
    ["swapped order", d => { d.evidence.stages = [stages[0], stages[2], stages[1]]; }, "invalid_response"],
    ["other set label", d => { d.evidence.stages![1].choices.candidate_set = "figures_1_2"; }, "inconsistent_decision"],
    ["stage renamed", d => { d.evidence.stages![1].stage = "detail"; }, "invalid_response"],
    ["target changed", d => { (d.target as { figureIds: string[] }).figureIds = ["own-1", "own-3"]; }, "inconsistent_decision"],
    ["stage-one target not multiple", d => { d.evidence.stages![0].choices.target = "figure_1"; d.evidence.choices.target = "figure_1"; }, "inconsistent_decision"],
  ];
  for (const [name, mutate, wanted] of variants) {
    const d = structuredClone(good); mutate(d);
    assert.throws(() => validateJevDecision(d, rich(), { questionLayout: "two_stage_v2" }), code(wanted), name);
  }
});

test("A1-A3 (v1): include 0 or 1 under multiple rejects before detail for every action; 2 and 6 succeed", async t => {
  for (const [candidates, action] of [[{}, "confirm"], ...["accept", "close", "defer", "move_on", "revisit", "confirm", "repair", "request_observation"].map(a => [{ candidate_2: "include" }, a] as const)] as Array<[Record<string, string>, string]>) {
    const http = await httpMock(t, p => ({ body: { ...answer(p, { action, target: "multiple", ...candidates }), extra: "RAW_CANARY" } }));
    const c = client(http.fetchImpl, "two_stage_v1"), input = { ...base(), issueSummary: "PROMPT_CANARY" };
    await assert.rejects(c.decide(input), (e: unknown) => {
      assert.ok(code("inconsistent_decision")(e)); assert.doesNotMatch(inspect(e, { showHidden: true }), /CANARY|choices|rejectionCode|candidate_/); return true;
    });
    assert.equal(http.requests.length, 1); assert.equal(c.lastEvidence!.rejectionCode, "multiple_requires_candidates"); assert.equal(c.lastEvidence!.stages.length, 1);
  }
  for (const included of [[0, 2], [0, 1, 2, 3, 4, 5]]) {
    const http = await httpMock(t, p => ({ body: answer(p, { action: "defer", target: "multiple", ...Object.fromEntries(included.map(i => [`candidate_${i}`, "include"])) }) }));
    const d = await client(http.fetchImpl, "two_stage_v1").decide(base());
    assert.deepEqual(d.target, { kind: "multiple", figureIds: included.map(i => slots[i]) });
  }
});

test("A4-A6 (v1 and v2): agree is offered only with eligible names, needs an eligible figure, and needs a single target", async t => {
  for (const layout of ["two_stage_v1", "two_stage_v2"] as const) {
    assert.equal(Object.hasOwn(buildJevDecisionPayload({ ...rich(), agreeNames: [] }, { questionLayout: layout }).questions.action.criteria, "agree"), false);
    assert.equal(Object.hasOwn(buildJevDecisionPayload(rich(), { questionLayout: layout }).questions.action.criteria, "agree"), true);
    const wrong = await httpMock(t, staged({ stage1: { action: "agree", target: "figure_1" } }));
    const c = client(wrong.fetchImpl, layout);
    await assert.rejects(c.decide(rich()), code("inconsistent_decision")); assert.equal(c.lastEvidence!.rejectionCode, "name_required"); assert.equal(wrong.requests.length, 1);
    const right = await httpMock(t, staged({ stage1: { action: "agree", target: "figure_0" } }));
    const agreed = await client(right.fetchImpl, layout).decide(rich());
    assert.equal(agreed.name, "船"); assert.equal(right.requests.length, 2);
    for (const target of ["none", "multiple"]) {
      const http = await httpMock(t, p => ({ body: answer(p, { action: "agree", target, candidate_0: "include", candidate_1: "include" }) }));
      const named = client(http.fetchImpl, layout);
      await assert.rejects(named.decide(rich()), code("invalid_decision")); assert.equal(named.lastEvidence!.rejectionCode, "name_requires_single_target"); assert.equal(http.requests.length, 1);
    }
  }
});

test("B1: onFailureEvidence receives only this decide call's failed evidence, and its projection is closed", async t => {
  const http = await httpMock(t, p => Object.keys(p.questions).includes("human_referent") ? { status: 500 } : { body: answer(p, { action: "repair", target: "multiple", candidate_1: "include" }) });
  const c = client(http.fetchImpl, "two_stage_v1"), seen: unknown[] = [], input = { ...base(), issueSummary: "PROMPT_CANARY" };
  await assert.rejects(c.decide(input, { onFailureEvidence: e => seen.push(e) }), code("inconsistent_decision"));
  assert.equal(seen.length, 1);
  const projected = projectDecisionFailureEvidence(seen[0], "two_stage_v1")!;
  assert.ok(projected);
  assert.equal(projected.rejectionCode, "multiple_requires_candidates"); assert.equal(projected.error, "inconsistent_decision");
  assert.equal(projected.callIndex, c.lastEvidence!.callIndex); assert.deepEqual(projected.stages[0].choices, c.lastEvidence!.stages[0].choices);
  assert.deepEqual(projected.stages[0].scores, c.lastEvidence!.stages[0].scores); assert.equal(projected.stages[0].status, "error");
  assert.deepEqual(projectDecisionFailureEvidence(c.lastEvidence, "two_stage_v1"), projected);
  assert.deepEqual(checkDecisionFailureEvidence(structuredClone(projected)), projected);
  assert.doesNotMatch(JSON.stringify(projected), /CANARY|criteria|instructions|"publicTurns":\[|Bearer|sk-or/);
  // Success, referent, prospect and detail calls never report through this hook.
  const ok = await httpMock(t, staged({ stage1: { action: "accept", target: "figure_0" } }));
  const okClient = client(ok.fetchImpl, "two_stage_v1");
  await okClient.decide(base(), { onFailureEvidence: e => seen.push(e) });
  await okClient.estimateReferent(base(), { onFailureEvidence: e => seen.push(e) });
  await okClient.estimateRepairProspect(base(), { onFailureEvidence: e => seen.push(e) });
  await c.estimateReferent(base(), { onFailureEvidence: e => seen.push(e) });
  await assert.rejects(c.completeDetail(base(), { action: "confirm", target: { kind: "single", figureId: "own-1" } }, { onFailureEvidence: e => seen.push(e) }));
  assert.equal(seen.length, 1);
  // A v2 name_required failure keeps its single stage and rule.
  const v2 = await httpMock(t, staged({ stage1: { action: "agree", target: "figure_2" } }));
  const v2Client = client(v2.fetchImpl, "two_stage_v2"), v2Seen: unknown[] = [];
  await assert.rejects(v2Client.decide(rich(), { onFailureEvidence: e => v2Seen.push(e) }), code("inconsistent_decision"));
  const v2Projected = projectDecisionFailureEvidence(v2Seen[0], "two_stage_v2")!;
  assert.equal(v2Projected.rejectionCode, "name_required"); assert.deepEqual(Object.keys(v2Projected.stages[0].choices), ["action", "target"]);
  assert.equal(projectDecisionFailureEvidence(v2Seen[0], "two_stage_v1"), null, "a v2 stage-one shape is not a v1 record");
});

test("B3: the closed failure record rejects any key, label, value or stage outside its shape", async t => {
  const http = await httpMock(t, staged({ stage1: { action: "confirm", target: "multiple" }, set: "figures_0_1" }, key => key === "detail" ? null : 0.0001));
  const seen: unknown[] = [];
  await assert.rejects(client(http.fetchImpl, "two_stage_v2").decide(rich(), { onFailureEvidence: e => seen.push(e) }), code("cost_unreported"));
  const good = projectDecisionFailureEvidence(seen[0], "two_stage_v2")!;
  assert.deepEqual(good.stages.map(s => [s.stage, s.status]), [["action_target", "ok"], ["multiple_candidates", "ok"], ["detail", "error"]]);
  assert.deepEqual(good.stages[2].choices, {}, "a missing answer stays missing, never filled");
  const tamper: Array<[string, (v: any) => void]> = [
    ["extra top key", v => { v.prompt = "x"; }], ["extra stage key", v => { v.stages[0].note = "x"; }],
    ["unknown target label", v => { v.stages[0].choices.target = "figure_9"; }], ["score out of range", v => { v.stages[0].scores.action.accept = 2; }],
    ["foreign model", v => { v.model = "other/model"; }], ["bad response id", v => { v.stages[0].responseId = "raw error text"; }],
    ["rejection mismatch", v => { v.rejectionCode = "name_required"; }], ["unknown code", v => { v.error = "Error: upstream said no"; }],
    ["v1 shape under v2", v => { v.stages[0].choices.candidate_0 = "include"; v.stages[0].scores.candidate_0 = { include: 1, exclude: 0 }; }],
    ["set stage under v1", v => { v.questionLayout = "two_stage_v1"; }], ["stage order", v => { v.stages.reverse(); }],
    ["non-final error stage", v => { v.stages[0].status = "error"; }], ["budget", v => { v.inputBudget.maxChars = 1; }],
    ["set label", v => { v.stages[1].choices.candidate_set = "figures_5_0"; }],
  ];
  for (const [name, mutate] of tamper) { const v = structuredClone(good); mutate(v); assert.equal(checkDecisionFailureEvidence(v), null, name); }
  assert.equal(projectDecisionFailureEvidence({ ...(seen[0] as object), status: "ok" }, "two_stage_v2"), null);
  assert.equal(projectDecisionFailureEvidence("decision failed", "two_stage_v2"), null);
});

test("D3: the bypass table and veto set are unchanged; under v2 a veto keeps the multiple set and stage-one action scores", async t => {
  assert.equal(createHash("sha256").update(BYPASS_ACCEPTANCE_V1_CANONICAL_JSON).digest("hex"), BYPASS_ACCEPTANCE_V1_TABLE_SHA256);
  assert.equal(BYPASS_ACCEPTANCE_V1_TABLE_SHA256, "376d569120ca36a3eceaf5ab95410f7eb83f25fbb681e7566a684b97c35165c8");
  assert.deepEqual(BYPASS_ACCEPTANCE_V1.policies["repair-first"].vetoActions, ["defer", "move_on"]);
  assert.deepEqual(BYPASS_ACCEPTANCE_V1.policies["bypass-enabled"].vetoActions, []);
  const http = await httpMock(t, staged({ stage1: { action: "defer", target: "multiple" }, set: "figures_2_4" }));
  const decision = await client(http.fetchImpl, "two_stage_v2").decide(rich());
  const veto = await applyBypassAcceptance(rich(), decision, interventionForStrategy("repair-first"), undefined, { questionLayout: "two_stage_v2" });
  assert.equal(veto.intervention.disposition, "rejected"); assert.deepEqual(veto.intervention.original.target, { kind: "multiple", figureIds: ["own-2", "own-4"] });
  assert.deepEqual(veto.executed.target, { kind: "multiple", figureIds: ["own-2", "own-4"] });
  const rerank = veto.intervention.rerank!;
  for (const r of rerank.ranking) assert.equal(r.score, decision.evidence.stages![0].scores.action[r.action]);
  const accept = await applyBypassAcceptance(rich(), decision, interventionForStrategy("bypass-enabled"), undefined, { questionLayout: "two_stage_v2" });
  assert.equal(accept.intervention.disposition, "adopted"); assert.deepEqual(accept.executed.target, decision.target);
  await assert.rejects(applyBypassAcceptance(rich(), decision, interventionForStrategy("bypass-enabled")), { code: "invalid_original" });
  await assert.rejects(applyBypassAcceptance(rich(), decision, interventionForStrategy("bypass-enabled"), undefined, { questionLayout: "two_stage_v9" } as never), { code: "invalid_options" });
});

test("E: ten Jev actions; request_observation is offered only while reobservation is allowed, in both layouts", () => {
  assert.equal(JEV_ACTIONS.length, 10); assert.equal(JEV_ACTIONS.at(-1), "request_observation");
  for (const layout of ["two_stage_v1", "two_stage_v2"] as const) {
    assert.equal(Object.hasOwn(buildJevDecisionPayload({ ...rich(), reobservationAllowed: false }, { questionLayout: layout }).questions.action.criteria, "request_observation"), false);
    assert.equal(Object.hasOwn(buildJevDecisionPayload(rich(), { questionLayout: layout }).questions.action.criteria, "request_observation"), true);
  }
  assert.throws(() => buildJevCandidateSetPayload({ ...rich(), reobservationAllowed: false }, "request_observation"), code("invalid_input"));
  assert.throws(() => buildJevDecisionPayload(base(), { questionLayout: "two_stage_v9" as never }), code("invalid_options"));
  assert.throws(() => createJevDecisionClient({ enabled: true, readKey, questionLayout: "two_stage_v9" as never }), code("invalid_options"));
});

test("budget ceiling: research callers may set up to 0.45 USD; the default path keeps 0.05", () => {
  assert.equal(DEFAULT_COST_CAP_USD, 0.05); assert.equal(RESEARCH_MAX_JEV_USD, 0.45);
  const researchLimits = { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS };
  const adapters: Array<[string, (o: Record<string, unknown>) => unknown]> = [
    ["decision", o => createJevDecisionClient({ enabled: true, readKey, ...o })], ["local", o => createJevLocalTestClassifier({ enabled: true, readKey, ...o })],
    ["ai function", o => createJevAiFunctionClassifier({ readKey, ...o })], ["ai support", o => createJevAiSupportChecker({ readKey, ...o })],
  ];
  for (const [name, make] of adapters) {
    assert.ok(make({ costCapUsd: 0.45, researchLimits }), name);
    assert.ok(make({ costCapUsd: 0.15, researchLimits }), name);
    assert.ok(make({ costCapUsd: 0.05 }), name);
    assert.ok(make({}), `${name} unspecified uses the 0.05 default`);
    for (const costCapUsd of [0.450001, 0, -0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.1", null])
      assert.throws(() => make({ costCapUsd, researchLimits }), (e: unknown) => (e as { code?: string })?.code === "invalid_options", `${name} ${costCapUsd}`);
    assert.throws(() => make({ costCapUsd: 0.06 }), (e: unknown) => (e as { code?: string })?.code === "invalid_options", `${name} without research limits`);
  }
});
