// audit/05 §6 at the client/contract boundary for the explicit two_stage_v3 layout: the 30-cell table, the closed
// action then target questions, forced illegal answers, evidence tampering, layout crossing and the bypass re-ranking.
// The expected table below is a literal oracle; it is never generated from the implementation.
// Synthetic data, fake Keychain and loopback HTTP only. Never invokes a live model.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createJevDecisionClient, buildJevDecisionPayload, buildJevTargetPayload, buildJevDecisionDetailPayload, validateJevDecision,
  projectDecisionFailureEvidence, checkDecisionFailureEvidence, JevDecisionError, TWO_STAGE_V2_CANDIDATE_SETS, TWO_STAGE_V3_STAGES,
  TWO_STAGE_V3_TARGET_INSTRUCTIONS, candidateSetLabel, JEV_DECISION_MODEL } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { JEV_ACTIONS } from "../dialogue-model/runtime/decision/contract.ts";
import type { JevAction, JevDecisionInput, JevQuestionLayout, JevDecision } from "../dialogue-model/runtime/decision/contract.ts";
import { applyBypassAcceptance, planBypassAcceptance, interventionForStrategy, BYPASS_ACCEPTANCE_V1_CANONICAL_JSON,
  BYPASS_ACCEPTANCE_V1_TABLE_SHA256 } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import { researchTrialProfileV3, researchHash } from "../dialogue-model/runtime/v2/research-profile.ts";
import { OPENROUTER_DECISIONS_URL } from "../workers/research-ai-proxy/src/grounding.ts";

const KEY = "sk-or-SYNTHETIC-two-stage-v3-key-0000000";
const readKey = async () => KEY;
const slots = Array.from({ length: 6 }, (_, i) => `own-${i}`);
const memo = (features = true) => ({ observedAt: "2026-11-20T00:00:00.000Z", figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
  holistic: [{ construal: i === 0 ? "船" : `見立て${i}`, basis: ["細い部分"], status: "hypothesis" as const }],
  analytic: features ? { shapes: [`三角${i}`, `四角${i}`], composition: `構成${i}`, relations: [`関係${i}`] } : { shapes: [], composition: "", relations: [] },
  unknowns: [], reobservations: [] })) });
function base(): JevDecisionInput {
  return { turn: 4, ownSlots: slots, observations: memo(), issueSummary: "対象が未特定", priorClaims: [], repairHistory: [], previousAction: null,
    publicTurns: [{ turn: 1, speaker: "ai", text: "まず、どの図形から話しましょうか？" }, { turn: 2, speaker: "human", text: "細長い形を船と呼びたいです" },
      { turn: 3, speaker: "ai", text: "この形を船と呼ぶのはどうですか" }, { turn: 4, speaker: "human", text: "どれのことか分からないです" }],
    publicNames: [{ name: "船", figureId: slots[0], sourceTurn: 3 }] } as JevDecisionInput;
}
/** agreeNames only for own-0; every figure still has name candidates (its holistic construal) and features. */
const rich = (): JevDecisionInput => ({ ...base(), agreeNames: [{ name: "船", figureId: slots[0], sourceTurn: 3 }], reobservationAllowed: true });
/** No agree evidence at all, no name candidates, no features and no re-observation allowance. */
function bare(): JevDecisionInput {
  const i = { ...base(), publicNames: [], agreeNames: [], reobservationAllowed: false, observations: memo(false) } as JevDecisionInput;
  for (const f of i.observations.figures) f.holistic = [];
  return i;
}

type Answer = { model: string; id: string; answers: Record<string, unknown>; usage: Record<string, number> };
function answer(payload: JevDecisionPayload, preferences: Record<string, string> = {}, cost = 0.0001, top = 0.75): Answer {
  return { model: JEV_DECISION_MODEL, id: "gen-two-stage-v3", answers: Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => {
    const labels = Object.keys(q.criteria), selected = preferences[key] ?? labels[0];
    return [key, { type: "choice", choice: selected, probabilities: Object.fromEntries(labels.map(l => [l, l === selected ? top : (1 - top) / (labels.length - 1 || 1)])), confidence: 1 }];
  })), usage: { input_tokens: 10, output_tokens: 0, cost } };
}
type Reply = { body?: unknown; raw?: string; status?: number };
async function httpMock(t: TestContext, respond: (p: JevDecisionPayload, index: number) => Reply) {
  const requests: JevDecisionPayload[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as JevDecisionPayload;
    requests.push(payload);
    const result = respond(payload, requests.length - 1);
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
/** Answers by question key: action, target, then detail. Scores of the action question can be overridden. */
function staged(plan: { action: string; target?: string; detail?: Record<string, string>; actionScores?: Record<string, number> }) {
  return (p: JevDecisionPayload): Reply => {
    const keys = Object.keys(p.questions);
    if (keys.includes("action")) {
      const a = answer(p, { action: plan.action });
      if (plan.actionScores) {
        const labels = Object.keys(p.questions.action.criteria);
        (a.answers.action as any).probabilities = Object.fromEntries(labels.map(l => [l, plan.actionScores![l] ?? (l === plan.action ? 0.5 : 0.01)]));
      }
      return { body: a };
    }
    if (keys.includes("target")) return { body: answer(p, plan.target === undefined ? {} : { target: plan.target }) };
    return { body: answer(p, plan.detail ?? {}) };
  };
}
const client = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>, questionLayout: JevQuestionLayout = "two_stage_v3", extra = {}) =>
  createJevDecisionClient({ enabled: true, readKey, fetchImpl, questionLayout, ...extra })!;
const code = (wanted: string) => (e: unknown) => e instanceof JevDecisionError && e.code === wanted;
const setLabels = TWO_STAGE_V2_CANDIDATE_SETS.map(candidateSetLabel);

// ---- Literal oracle: audit/05 §2, 30 cells. none / single / multiple, true = legal when the material supports it.
type Kinds = { none: boolean; single: boolean; multiple: boolean };
const LEGAL: Record<JevAction, Kinds> = {
  accept: { none: true, single: true, multiple: true }, propose_name: { none: false, single: true, multiple: false },
  confirm: { none: false, single: true, multiple: true }, repair: { none: false, single: true, multiple: true },
  defer: { none: true, single: true, multiple: true }, revisit: { none: false, single: true, multiple: true },
  agree: { none: false, single: true, multiple: false }, move_on: { none: true, single: true, multiple: true },
  close: { none: true, single: true, multiple: true }, request_observation: { none: false, single: true, multiple: true } };
const CELLS = JEV_ACTIONS.flatMap(a => (["none", "single", "multiple"] as const).map(k => [a, k, LEGAL[a][k]] as const));
test("oracle: the literal table has 22 legal and 8 illegal cells", () => {
  assert.equal(CELLS.length, 30);
  assert.equal(CELLS.filter(c => c[2]).length, 22);
  assert.deepEqual(CELLS.filter(c => !c[2]).map(c => `${c[0]}x${c[1]}`).sort(),
    ["agreexmultiple", "agreexnone", "confirmxnone", "propose_namexmultiple", "propose_namexnone", "repairxnone", "request_observationxnone", "revisitxnone"].sort());
});

/** Targets one action's stage-two question offers in `rich()` (agree only for own-0; every figure has names and features). */
function expectedLabels(action: JevAction): string[] {
  const out: string[] = [];
  if (LEGAL[action].none) out.push("none");
  if (LEGAL[action].single) out.push(...(action === "agree" ? ["figure_0"] : slots.map((_, i) => `figure_${i}`)));
  if (LEGAL[action].multiple) out.push(...setLabels);
  return out;
}

test("payload: stage one is one closed action question; stage two carries only the targets that action may take", () => {
  const p1 = buildJevDecisionPayload(rich(), { questionLayout: "two_stage_v3" });
  assert.deepEqual(Object.keys(p1.questions), ["action"]);
  assert.deepEqual(Object.keys(p1.questions.action.criteria), [...JEV_ACTIONS]);
  assert.ok(p1.questions.action.instructions.includes(TWO_STAGE_V3_STAGES));
  for (const action of JEV_ACTIONS) {
    const p2 = buildJevTargetPayload(rich(), action);
    assert.deepEqual(Object.keys(p2.questions), ["target"], action);
    assert.deepEqual(Object.keys(p2.questions.target.criteria), expectedLabels(action), action);
    assert.ok(Object.keys(p2.questions.target.criteria).length <= 64);
    assert.ok(p2.questions.target.instructions.includes(TWO_STAGE_V3_TARGET_INSTRUCTIONS));
    assert.deepEqual(JSON.parse(p2.state).selected, { action });
    assert.deepEqual(Object.keys(JSON.parse(p2.state)).filter(k => ["strategy", "policy", "agreeNames"].includes(k)), []);
  }
});

test("payload: stage one omits an action with no legal target or detail in the material", () => {
  const b = Object.keys(buildJevDecisionPayload(bare(), { questionLayout: "two_stage_v3" }).questions.action.criteria);
  assert.deepEqual(b, ["accept", "defer", "revisit", "move_on", "close"]);
  // Name evidence on one figure other than the agree-evidence figure never opens agree for the others.
  const i = { ...rich(), agreeNames: [{ name: "船", figureId: slots[2], sourceTurn: 3 }] } as JevDecisionInput;
  i.publicNames = [{ name: "船", figureId: slots[2], sourceTurn: 3 }];
  assert.deepEqual(Object.keys(buildJevTargetPayload(i, "agree").questions.target.criteria), ["figure_2"]);
  const noNames = bare(); noNames.observations = memo();
  noNames.observations.figures.forEach(f => { f.holistic = []; });
  assert.ok(!("propose_name" in buildJevDecisionPayload(noNames, { questionLayout: "two_stage_v3" }).questions.action.criteria));
  assert.ok("confirm" in buildJevDecisionPayload(noNames, { questionLayout: "two_stage_v3" }).questions.action.criteria);
  assert.throws(() => buildJevTargetPayload(bare(), "agree"), code("invalid_decision"));
  assert.throws(() => buildJevTargetPayload(bare(), "request_observation"), code("invalid_input"));
});

test("payload: a feature action offers only the sets that hold a feature candidate", () => {
  const i = rich();
  i.observations.figures.forEach((f, k) => { if (k !== 3) f.analytic = { shapes: [], composition: "", relations: [] }; });
  const labels = Object.keys(buildJevTargetPayload(i, "confirm").questions.target.criteria);
  assert.deepEqual(labels.filter(l => l.startsWith("figure_")), ["figure_3"]);
  const sets = TWO_STAGE_V2_CANDIDATE_SETS.filter(s => s.includes(3)).map(candidateSetLabel);
  assert.deepEqual(labels.filter(l => l.startsWith("figures_")), sets);
  assert.ok(!labels.includes("none"));
});

test("30 cells: every legal cell completes in at most three POSTs; the action stage is saved unconditionally", async t => {
  let legal = 0;
  for (const [action, kind, ok] of CELLS) {
    if (!ok) continue;
    legal++;
    const target = kind === "none" ? "none" : kind === "single" ? "figure_1" : "figures_1_3";
    const detail = ["propose_name", "agree"].includes(action) ? {} : undefined;
    const planned = action === "agree" ? { action, target: "figure_0" } : { action, target, ...(detail ? { detail } : {}) };
    const http = await httpMock(t, staged(planned));
    const c = client(http.fetchImpl);
    const d = await c.decide(rich());
    const needsDetail = ["propose_name", "agree", "confirm", "repair", "request_observation"].includes(action);
    assert.equal(http.requests.length, 2 + (needsDetail ? 1 : 0), `${action}x${kind}`);
    assert.deepEqual(d.evidence.stages!.map(s => s.stage), ["action", "target", ...(needsDetail ? ["detail"] : [])], `${action}x${kind}`);
    assert.equal(d.action, action);
    const resolved = action === "agree" ? "single" : kind;
    assert.equal(d.target.kind, resolved);
    assert.deepEqual(Object.keys(d.evidence.choices), ["action"]);
    assert.deepEqual(Object.keys(d.evidence.scores.action), [...JEV_ACTIONS]);
    if (kind === "multiple") assert.deepEqual(d.target, { kind: "multiple", figureIds: ["own-1", "own-3"] });
    assert.deepEqual(validateJevDecision(d, rich(), { questionLayout: "two_stage_v3" }), d);
  }
  assert.equal(legal, 22);
});

test("30 cells: every illegal cell is absent from its question, refused when forced and refused when injected", async t => {
  for (const [action, kind, ok] of CELLS) {
    if (ok) continue;
    const offered = Object.keys(buildJevTargetPayload(rich(), action).questions.target.criteria);
    const forbidden = kind === "none" ? ["none"] : kind === "multiple" ? setLabels : slots.map((_, i) => `figure_${i}`);
    for (const label of forbidden) assert.ok(!offered.includes(label), `${action}x${kind} offers ${label}`);
    // (b) a service answering an unoffered label fails closed after exactly two POSTs: no detail, no decision.
    const wrong = kind === "none" ? "none" : kind === "multiple" ? "figures_1_3" : "figure_1";
    const http = await httpMock(t, staged({ action, target: wrong }));
    const c = client(http.fetchImpl);
    await assert.rejects(() => c.decide(rich()), code("invalid_response"), `${action}x${kind}`);
    assert.equal(http.requests.length, 2, `${action}x${kind}`);
    assert.equal(c.lastEvidence!.status, "error");
    // (c) an injected client decision with the same illegal pair is refused by the contract validator.
    const target = kind === "none" ? { kind: "none" } : kind === "single" ? { kind: "single", figureId: "own-1" } : { kind: "multiple", figureIds: ["own-1", "own-3"] };
    const injected = { action, target, name: null, feature: null, observe: null, decisionKind: "mock", calibrated: false,
      evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: null } };
    assert.throws(() => validateJevDecision(injected, rich(), { questionLayout: "two_stage_v3" }), e => e instanceof JevDecisionError &&
      ["invalid_decision", "inconsistent_decision"].includes(e.code), `${action}x${kind}`);
  }
});

test("agree for a figure without its own agree evidence is neither offered, accepted nor injectable", async t => {
  assert.ok(!Object.keys(buildJevTargetPayload(rich(), "agree").questions.target.criteria).includes("figure_1"));
  const http = await httpMock(t, staged({ action: "agree", target: "figure_1" }));
  await assert.rejects(() => client(http.fetchImpl).decide(rich()), code("invalid_response"));
  assert.equal(http.requests.length, 2);
  const injected = { action: "agree", target: { kind: "single", figureId: "own-1" }, name: "見立て1", feature: null, observe: null, detailFigureIds: ["own-1"],
    decisionKind: "mock", calibrated: false, evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: null } };
  assert.throws(() => validateJevDecision(injected, rich(), { questionLayout: "two_stage_v3" }), e => e instanceof JevDecisionError && ["invalid_decision", "inconsistent_decision"].includes(e.code));
});

test("set sizes 2 and 6, a single-feature source and a one-figure observation stay inside the chosen target", async t => {
  for (const [label, ids] of [["figures_0_1", ["own-0", "own-1"]], ["figures_0_1_2_3_4_5", slots]] as const) {
    const http = await httpMock(t, staged({ action: "revisit", target: label }));
    const d = await client(http.fetchImpl).decide(rich());
    assert.deepEqual(d.target, { kind: "multiple", figureIds: [...ids] });
    assert.equal(d.name, null); assert.equal(d.feature, null); assert.deepEqual(d.detailFigureIds, []);
    assert.equal(http.requests.length, 2);
  }
  // Only own-1 and own-4 carry a feature; confirming the set {1,2} keeps the target and records the single source.
  const i = rich();
  i.observations.figures.forEach((f, k) => { if (![1, 4].includes(k)) f.analytic = { shapes: [], composition: "", relations: [] }; });
  const http = await httpMock(t, staged({ action: "confirm", target: "figures_1_2" }));
  const d = await client(http.fetchImpl).decide(i);
  assert.deepEqual(d.target, { kind: "multiple", figureIds: ["own-1", "own-2"] });
  assert.deepEqual(d.detailFigureIds, ["own-1"]);
  assert.ok(d.feature !== null && d.feature.includes("1"));
  // A one-figure re-observation inside a multiple target does not change the action target.
  const obs = await httpMock(t, staged({ action: "request_observation", target: "figures_1_3", detail: { observe_targets: "subset_0", observe_aspect: "part" } }));
  const o = await client(obs.fetchImpl).decide(rich());
  assert.deepEqual(o.target, { kind: "multiple", figureIds: ["own-1", "own-3"] });
  assert.deepEqual(o.observe!.figureIds, ["own-1"]);
  assert.deepEqual(Object.keys(JSON.parse(obs.requests[2].state).selected), ["action", "target"]);
});

test("re-observation allowance: request_observation disappears after the allowance is spent, in both stages", () => {
  const spent = { ...rich(), reobservationAllowed: false };
  assert.ok(!("request_observation" in buildJevDecisionPayload(spent, { questionLayout: "two_stage_v3" }).questions.action.criteria));
  assert.throws(() => buildJevTargetPayload(spent, "request_observation"), code("invalid_input"));
  assert.throws(() => validateJevDecision({ action: "request_observation", target: { kind: "single", figureId: "own-1" }, name: null, feature: null,
    observe: { figureIds: ["own-1"], aspect: "part", question: "q", partnerConstrual: null }, decisionKind: "mock", calibrated: false,
    evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: null } }, spent, { questionLayout: "two_stage_v3" }), code("inconsistent_decision"));
});

test("a stage-two failure carries a closed failure record that restores; tampered records are refused", async t => {
  const http = await httpMock(t, staged({ action: "agree", target: "figure_4" }));
  let raw: unknown;
  const c = client(http.fetchImpl);
  await assert.rejects(() => c.decide(rich(), { onFailureEvidence: e => { raw = e; } }), code("invalid_response"));
  const record = projectDecisionFailureEvidence(raw, "two_stage_v3");
  assert.ok(record);
  assert.deepEqual(record.stages.map(s => [s.stage, s.status]), [["action", "ok"], ["target", "error"]]);
  assert.deepEqual(Object.keys(record.stages[0].choices), ["action"]);
  assert.deepEqual(checkDecisionFailureEvidence(record), record);
  assert.equal(projectDecisionFailureEvidence(raw, "two_stage_v2"), null);
  const mutations: Array<[string, (r: any) => void]> = [
    ["v2 stage name", r => { r.stages[0].stage = "action_target"; }],
    ["layout swapped", r => { r.questionLayout = "two_stage_v2"; }],
    ["stage dropped", r => { r.stages.shift(); }],
    ["stages reversed", r => { r.stages.reverse(); }],
    ["extra target question", r => { r.stages[0].choices.target = "none"; r.stages[0].scores.target = { none: 1 }; }],
    ["target answers without a verified model and cost", r => { r.stages[1].choices = { target: "figure_9" }; r.stages[1].scores = { target: { figure_9: 1 } }; }],
    ["action stage without always-legal actions", r => { delete r.stages[0].scores.action.accept; }],
    ["rule named on the action stage of a longer record", r => { r.rejectionCode = "name_required"; r.error = "inconsistent_decision"; }],
  ];
  for (const [name, mutate] of mutations) {
    const clone = structuredClone(record);
    mutate(clone);
    assert.equal(checkDecisionFailureEvidence(clone), null, name);
  }
});

test("tampered successful evidence is refused: stage order, names, labels and layout crossing", async t => {
  const http = await httpMock(t, staged({ action: "confirm", target: "figures_1_3" }));
  const good = await client(http.fetchImpl).decide(rich());
  const check = (d: unknown, layout: JevQuestionLayout = "two_stage_v3") => validateJevDecision(d, rich(), { questionLayout: layout });
  assert.deepEqual(check(good), good);
  assert.throws(() => check(good, "two_stage_v2"), JevDecisionError);
  assert.throws(() => check(good, "two_stage_v1"), JevDecisionError);
  const mutations: Array<[string, (d: any) => void]> = [
    ["stage dropped", d => { d.evidence.stages.splice(1, 1); }],
    ["stages swapped", d => { d.evidence.stages.splice(0, 2, d.evidence.stages[1], d.evidence.stages[0]); }],
    ["v2 stage name", d => { d.evidence.stages[0].stage = "action_target"; }],
    ["target label exchanged for another set", d => { d.evidence.stages[1].choices.target = "figures_1_4"; }],
    ["decision target exchanged for another set", d => { d.target = { kind: "multiple", figureIds: ["own-1", "own-4"] }; }],
    ["action exchanged", d => { d.action = "repair"; }],
    ["action stage label outside the offered set", d => { d.evidence.stages[0].choices.action = "agree"; d.evidence.choices.action = "agree"; }],
    ["scores exchanged", d => { d.evidence.scores = structuredClone(d.evidence.scores); d.evidence.scores.action.accept = 0.123; }],
    ["cost not the sum", d => { d.evidence.costUsd = 9; }],
  ];
  for (const [name, mutate] of mutations) {
    const clone = structuredClone(good);
    mutate(clone);
    assert.throws(() => check(clone), JevDecisionError, name);
  }
  // A v2 decision never validates as v3, nor a v3 decision as v2 (cross-layout restore stays refused).
  const v2 = await httpMock(t, p => Object.keys(p.questions).includes("action") ? { body: answer(p, { action: "defer", target: "multiple" }) }
    : Object.keys(p.questions).includes("candidate_set") ? { body: answer(p, { candidate_set: "figures_1_3" }) } : { body: answer(p) });
  const old = await client(v2.fetchImpl, "two_stage_v2").decide(rich());
  assert.throws(() => check(old), JevDecisionError);
});

test("budget: one decision costs at most three POSTs and never more than v2's ceiling", async t => {
  for (const planned of [{ action: "confirm", target: "figures_0_2" }, { action: "accept", target: "none" }]) {
    const http = await httpMock(t, staged(planned));
    await client(http.fetchImpl).decide(rich());
    assert.ok(http.requests.length <= 3);
  }
  const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: 1000 } as never, { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 } as never, "two_stage_v3");
  assert.equal(profile.questionLayout, "two_stage_v3");
  assert.equal(profile.interventionPolicy.tableSha256, BYPASS_ACCEPTANCE_V1_TABLE_SHA256);
  assert.notEqual(researchHash(profile), researchHash(researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: 1000 } as never,
    { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 } as never, "two_stage_v2")));
});

// ---- bypass acceptance: both strategies, veto, re-ranking
const repairFirst = interventionForStrategy("repair-first");
const bypassEnabled = interventionForStrategy("bypass-enabled");
const TARGET_LABEL = { none: "none", single: "figure_1", multiple: "figures_1_3" } as const;
const TARGETS = { none: { kind: "none" }, single: { kind: "single", figureId: "own-1" }, multiple: { kind: "multiple", figureIds: ["own-1", "own-3"] } } as const;
// Independent expectation of the executable alternatives per original target kind (audit/05 §5), figure own-1 has no agree evidence.
const RERANK: Record<"none" | "single" | "multiple", JevAction[]> = {
  none: ["accept", "close"],
  single: ["accept", "propose_name", "confirm", "repair", "revisit", "close"],
  multiple: ["accept", "confirm", "repair", "revisit", "close"] };

for (const original of ["defer", "move_on"] as const) for (const kind of ["none", "single", "multiple"] as const) {
  test(`bypass v3: ${original} x ${kind}: bypass-enabled adopts, repair-first re-ranks only legal alternatives and keeps the target`, async t => {
    // agree and propose_name get the highest scores: neither may win for a multiple or no target, nor agree for a figure without evidence.
    const scores = { agree: 0.4, propose_name: 0.3, confirm: 0.1, repair: 0.09, revisit: 0.08, accept: 0.02, close: 0.01, [original]: 0.5 } as Record<string, number>;
    const http = await httpMock(t, staged({ action: original, target: TARGET_LABEL[kind], actionScores: scores }));
    const c = client(http.fetchImpl), input = rich();
    const decision = await c.decide(input);
    const enabled = await applyBypassAcceptance(input, decision, bypassEnabled, undefined, { questionLayout: "two_stage_v3" });
    assert.equal(enabled.intervention.disposition, "adopted");
    assert.equal(enabled.executed.action, original);
    const plan = planBypassAcceptance(input, decision, repairFirst, { questionLayout: "two_stage_v3" });
    assert.equal(plan.disposition, "rejected");
    assert.deepEqual(plan.rerank!.ranking.map(r => r.action).sort(), [...RERANK[kind]].sort());
    assert.deepEqual(plan.rerank!.ranking.map(r => r.score), plan.rerank!.ranking.map(r => scores[r.action]));
    assert.deepEqual(plan.rerank!.selected!.target, TARGETS[kind]);
    assert.ok(!["defer", "move_on", "request_observation"].includes(plan.rerank!.selected!.action));
    for (const forbidden of ["agree", "propose_name"] as const) if (kind !== "single" || forbidden === "agree") assert.ok(!plan.rerank!.ranking.some(r => r.action === forbidden));
    assert.equal(BYPASS_ACCEPTANCE_V1_TABLE_SHA256, "376d569120ca36a3eceaf5ab95410f7eb83f25fbb681e7566a684b97c35165c8");
    assert.ok(BYPASS_ACCEPTANCE_V1_CANONICAL_JSON.includes('"vetoActions":["defer","move_on"]'));
  });
}

test("bypass v3: ties follow the JEV_ACTIONS order and a re-ranked revisit x multiple keeps its candidate set", async t => {
  const scores = { revisit: 0.4, confirm: 0.4, repair: 0.4, accept: 0.1, close: 0.1, defer: 0.5 } as Record<string, number>;
  const http = await httpMock(t, staged({ action: "defer", target: "figures_1_3", actionScores: scores }));
  const decision = await client(http.fetchImpl).decide(rich());
  const plan = planBypassAcceptance(rich(), decision, repairFirst, { questionLayout: "two_stage_v3" });
  assert.deepEqual(plan.rerank!.ranking.map(r => r.action), ["confirm", "repair", "revisit", "accept", "close"]);
  const top = { ...scores, revisit: 0.45 };
  const http2 = await httpMock(t, staged({ action: "defer", target: "figures_1_3", actionScores: top }));
  const d2 = await client(http2.fetchImpl).decide(rich());
  const r = await applyBypassAcceptance(rich(), d2, repairFirst, undefined, { questionLayout: "two_stage_v3" });
  assert.deepEqual(r.executed, { action: "revisit", target: { kind: "multiple", figureIds: ["own-1", "own-3"] }, name: null, feature: null, observe: null, detailFigureIds: [] });
});

test("bypass v3: a decision whose action scores lost a ranked action is refused before any alternative", async t => {
  const http = await httpMock(t, staged({ action: "move_on", target: "figure_1" }));
  const decision = await client(http.fetchImpl).decide(rich());
  const broken = structuredClone(decision) as any;
  delete broken.evidence.scores.action.confirm; delete broken.evidence.stages[0].scores.action.confirm;
  assert.throws(() => planBypassAcceptance(rich(), broken, repairFirst, { questionLayout: "two_stage_v3" }), (e: any) => e.code === "invalid_original");
  assert.throws(() => planBypassAcceptance(rich(), decision, repairFirst, { questionLayout: "two_stage_v2" }), (e: any) => e.code === "invalid_original");
});

test("bypass v3: public name evidence is zero, detail lists are empty, a veto never turns an earlier veto into evidence", async t => {
  const input = bare();
  const http = await httpMock(t, staged({ action: "move_on", target: "figure_2" }));
  const decision = await client(http.fetchImpl).decide(input);
  const plan = planBypassAcceptance(input, decision, repairFirst, { questionLayout: "two_stage_v3" });
  assert.deepEqual(plan.rerank!.ranking.map(r => r.action).sort(), ["accept", "close", "revisit"]);
  // The previous action of a vetoed defer is the executed action, not the original: a defer never ran, so open-issue revisit is not eligible.
  const i = { ...input, previousAction: { turn: 3, action: "accept", target: { kind: "single", figureId: "own-2" }, name: null, feature: null } } as JevDecisionInput;
  const http2 = await httpMock(t, staged({ action: "defer", target: "figure_2" }));
  const again = planBypassAcceptance(i, await client(http2.fetchImpl).decide(i), repairFirst, { questionLayout: "two_stage_v3" });
  assert.deepEqual(again.rerank!.ranking.map(r => r.action).sort(), ["accept", "close", "revisit"]);
});

test("detail payloads keep v1/v2 behaviour: selected legality only applies to the explicit v3 layout", () => {
  const selected = { action: "revisit", target: { kind: "none" } } as const;
  assert.equal(buildJevDecisionDetailPayload(rich(), selected as never), null);
  assert.equal(buildJevDecisionDetailPayload(rich(), selected as never, { questionLayout: "two_stage_v2" }), null);
  assert.throws(() => buildJevDecisionDetailPayload(rich(), selected as never, { questionLayout: "two_stage_v3" }), code("invalid_decision"));
});
