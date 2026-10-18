import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate as nextLoop } from "node:timers/promises";
import { CASES, EVAL_NOTICE, STRATA, OWN_IDS, STRATEGIES, LABEL_DIFF_TABLE, buildCaseState } from "../dialogue-model/runtime/decisions-eval/cases.mjs";
import { PURPOSES, scoreResults, scoreBaselines } from "../dialogue-model/runtime/decisions-eval/score.mjs";
import { MAX_CALLS, main, planEvaluation, runEvaluation, createMockClient } from "../dialogue-model/runtime/diagnostics/decisions-eval.mjs";
import { DECISION_ACTIONS } from "../workers/research-ai-proxy/src/decisions.mjs";
import { buildDecisionEvidence } from "../dialogue-model/runtime/v2/decision-evidence.mjs";

const execute = promisify(execFile);
const script = resolve("dialogue-model/runtime/diagnostics/decisions-eval.mjs");
const quiet = () => {};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const probabilities = (agree = 0.2) => Object.fromEntries(DECISION_ACTIONS.map((action) => [action, action === "agree" ? agree : (1 - agree) / 8]));

test("synthetic set has 50 bases, 100 variants, all 12 strata, six fictional ids and complete local rationale", () => {
  assert.match(EVAL_NOTICE, /研究者未承認の暫定基準/);
  assert.equal(CASES.length, 100);
  assert.equal(new Set(CASES.map((value) => value.id)).size, CASES.length);
  assert.equal(new Set(CASES.map((value) => value.baseId)).size, 50);
  assert.equal(STRATA.length, 12);
  for (const stratum of STRATA) assert.ok(new Set(CASES.filter((value) => value.stratum === stratum).map((value) => value.baseId)).size >= 3);
  for (const value of CASES) {
    assert.ok(STRATA.includes(value.stratum)); assert.ok(STRATEGIES.includes(value.strategy));
    assert.deepEqual(Object.keys(value.ownLedger), OWN_IDS);
    assert.ok(OWN_IDS.every((id) => /^s-[a-z0-9]{4}$/.test(id)));
    assert.ok(value.events.length > 0);
    for (const event of value.events) {
      assert.deepEqual(Object.keys(event).sort(), ["speaker", "text"]);
      assert.ok(["human", "ai"].includes(event.speaker)); assert.equal(typeof event.text, "string"); assert.ok(event.text.trim());
    }
    assert.deepEqual(Object.keys(value.hypothesis).sort(), ["candidateName", "discriminatingFeature", "targetSlot"]);
    assert.deepEqual(Object.keys(value.rationale).sort(), ["adoption", "neededFunction", "openIssue", "priorCommitment", "referent"]);
    assert.ok(Object.values(value.rationale).every((text) => typeof text === "string" && text.trim()));
    assert.ok(value.acceptable.length > 0);
    for (const field of ["acceptable", "dangerous"]) {
      assert.equal(new Set(value[field]).size, value[field].length);
      assert.ok(value[field].every((action) => DECISION_ACTIONS.includes(action)));
    }
    assert.ok(value.acceptable.every((action) => !value.dangerous.includes(action)));
  }
});

test("both strategies share byte-identical events, own notes and hypotheses; state differs only in strategy", () => {
  for (const baseId of new Set(CASES.map((value) => value.baseId))) {
    const pair = CASES.filter((value) => value.baseId === baseId);
    assert.equal(pair.length, 2);
    const common = ({ id, strategy, acceptable, dangerous, rationale, ...shared }) => shared;
    assert.equal(JSON.stringify(common(pair[0])), JSON.stringify(common(pair[1])));
    const evidence = pair.map((value) => { const data = JSON.parse(buildCaseState(value)); delete data.strategy; return JSON.stringify(data); });
    assert.equal(evidence[0], evidence[1]);
    const diff = LABEL_DIFF_TABLE.find((value) => value.baseId === baseId);
    for (const value of pair) assert.deepEqual(diff[value.strategy], { acceptable: value.acceptable, dangerous: value.dangerous });
  }
});

test("every actual state uses the shadow builder and excludes case ids, strata, labels and rationale", () => {
  for (const value of CASES) {
    const state = buildCaseState(value);
    assert.equal(state, buildDecisionEvidence({ events: value.events, ownLedger: value.ownLedger, judgment: value.hypothesis, strategy: value.strategy }));
    assert.doesNotMatch(state, /acceptable|dangerous|runtimeGuardBlocks|rationale|stratum|baseId|synthetic-/);
    assert.ok(!state.includes(value.id)); assert.ok(!state.includes(value.baseId)); assert.ok(!state.includes(value.stratum));
    for (const text of Object.values(value.rationale)) assert.ok(!state.includes(text));
    assert.doesNotMatch(JSON.stringify({ ownLedger: value.ownLedger, hypothesis: value.hypothesis }), /合意すべき|危険|正解|許容|不許容/);
    assert.match(JSON.parse(state).aiUnverifiedHypothesis.certainty, /正解ではない/);
    const changed = { ...value, acceptable: ["SECRET_LABEL"], dangerous: ["SECRET_LABEL"], stratum: "SECRET_STRATUM", rationale: { referent: "SECRET_RATIONALE" }, id: "SECRET_ID" };
    assert.equal(buildCaseState(changed), state);
  }
});

test("label refinements include backchannel contrasts, runtime guard separation and reviewable strategy differences", () => {
  const base = (id) => CASES.find((value) => value.baseId === `synthetic-${id}`);
  assert.ok(base("020").acceptable.includes("agree"));
  assert.ok(base("021").dangerous.includes("agree"));
  assert.ok(base("022").dangerous.includes("agree"));
  assert.ok(base("025").acceptable.includes("repair")); assert.ok(!base("025").acceptable.includes("confirm"));
  assert.match(base("026").rationale.openIssue, /曖昧さは示されていない/);
  assert.ok(base("013").acceptable.includes("accept")); assert.match(base("013").rationale.neededFunction, /inform/);
  assert.ok(base("039").acceptable.includes("propose_name"));
  for (const value of CASES.filter((value) => value.runtimeGuardBlocks)) {
    assert.ok(value.acceptable.includes("agree"));
    assert.ok(["unassigned", "deferred"].includes(value.ownLedger[value.hypothesis.targetSlot].status));
  }
  assert.equal(LABEL_DIFF_TABLE.filter((value) => value.differs).length, 4);
  assert.ok(LABEL_DIFF_TABLE.every((value) => JSON.stringify(value["repair-first"].dangerous) === JSON.stringify(value["bypass-enabled"].dangerous)));
});

const arithmeticCases = [
  { id: "c1", stratum: "A", strategy: "repair-first", acceptable: ["accept"], dangerous: ["agree", "repair"] },
  { id: "c2", stratum: "A", strategy: "repair-first", acceptable: ["agree"], dangerous: ["confirm"], runtimeGuardBlocks: true },
  { id: "c3", stratum: "B", strategy: "bypass-enabled", acceptable: ["move_on"], dangerous: ["agree"] },
  { id: "c4", stratum: "B", strategy: "bypass-enabled", acceptable: ["confirm"], dangerous: ["repair"] },
  { id: "c5", stratum: "B", strategy: "repair-first", acceptable: ["accept"], dangerous: [] },
];
const jevRows = [
  { caseId: "c1", purpose: "decision_jev", action: "agree", probabilities: probabilities(0.8), latencyMs: 10, costUsd: 0.1 },
  { caseId: "c2", purpose: "decision_jev", action: "confirm", probabilities: probabilities(0.05), latencyMs: 20, costUsd: 0.2 },
  { caseId: "c3", purpose: "decision_jev", action: "move_on", probabilities: probabilities(0.1), latencyMs: 30, costUsd: 0.3 },
  { caseId: "c4", purpose: "decision_jev", error: "upstream_error", latencyMs: 40 },
  { caseId: "c5", purpose: "decision_jev", action: "defer", probabilities: probabilities(0.2), latencyMs: 50, costUsd: 0 },
];

test("scorer arithmetic uses planned denominators, neutral/no-answer, risk subsets, probabilities, latency and cost", () => {
  const score = scoreResults(arithmeticCases, jevRows).byPurpose.decision_jev;
  const overall = score.overall;
  assert.equal(overall.planned, 5); assert.equal(overall.answered, 4);
  assert.deepEqual([overall.acceptable, overall.dangerous, overall.neutral, overall.noAnswer], [1, 2, 1, 1]);
  close(overall.acceptableRate, 0.2); close(overall.dangerousRate, 0.4); close(overall.coverage, 0.8);
  assert.deepEqual(overall.falseAgree, { cases: 2, bases: 2, answered: 2, noAnswer: 0, selected: 1, rate: 0.5 });
  assert.equal(overall.overConfirm.cases, 1); assert.equal(overall.overConfirm.selected, 1);
  assert.equal(overall.unjustRepair.cases, 2); assert.equal(overall.unjustRepair.noAnswer, 1); assert.equal(overall.unjustRepair.rate, 0);
  assert.equal(overall.unneededConfirm.cases, 1); assert.equal(overall.unneededConfirm.selected, 1);
  assert.equal(overall.runtimeGuard.cases, 1); assert.equal(overall.runtimeGuard.rate, 0);
  close(overall.falseAgreeProbability.mean, 0.45); assert.equal(overall.falseAgreeProbability.max, 0.8);
  assert.deepEqual(overall.latencyMs, { count: 5, median: 30, p90: 50 }); close(overall.costUsd, 0.6); assert.equal(overall.costKnown, 4);
  close(score.byStrategy["repair-first"].dangerousRate, 2 / 3);
  close(score.macro.acceptableRate, 1 / 6);
  assert.equal(score.byStratum.B.overConfirm.rate, null);
});

test("model agreement includes only paired valid replies and reports coverage", () => {
  const lunaRows = [
    { caseId: "c1", purpose: "decision_luna", action: "accept" }, { caseId: "c2", purpose: "decision_luna", action: "agree" },
    { caseId: "c3", purpose: "decision_luna", error: "timeout" }, { caseId: "c4", purpose: "decision_luna", action: "confirm" },
    { caseId: "c5", purpose: "decision_luna", action: "defer" },
  ];
  const scores = scoreResults(arithmeticCases, [...jevRows, ...lunaRows]);
  assert.deepEqual(scores.modelAgreement.overall, { planned: 5, paired: 3, matched: 1, coverage: 0.6, rate: 1 / 3 });
  assert.equal(scores.modelAgreement.byStratum.B.paired, 1);
  assert.equal(scores.modelAgreement.byStratum.B.rate, 1);
  assert.equal(scores.modelAgreement.byStrategy["bypass-enabled"].rate, null);
});

test("empty and malformed replies have explicit missing coverage and zero-denominator nulls", () => {
  const empty = scoreResults([], []).byPurpose.decision_jev.overall;
  assert.equal(empty.acceptableRate, null); assert.equal(empty.falseAgree.rate, null); assert.equal(empty.latencyMs.median, null);
  const invalid = scoreResults(arithmeticCases, [
    { caseId: "c1", purpose: "decision_jev", action: "invented", probabilities: probabilities(1) },
    { caseId: "c2", purpose: "decision_jev", action: "agree", error: "timeout" },
  ]).byPurpose.decision_jev.overall;
  assert.equal(invalid.noAnswer, 5); assert.equal(invalid.falseAgreeProbability.count, 0);
  assert.equal(invalid.falseAgree.rate, 0);
  assert.throws(() => scoreResults(arithmeticCases, [...jevRows, jevRows[0]]), /invalid_eval_results/);
  assert.throws(() => scoreResults(arithmeticCases, [{ caseId: "foreign", purpose: "decision_jev" }]), /invalid_eval_results/);
  for (const field of ["acceptable", "dangerous"]) {
    const altered = structuredClone(arithmeticCases); altered[0][field] = ["accept", "accept"];
    assert.throws(() => scoreResults(altered, []), /invalid_eval_results/);
  }
});

test("baselines use the same scorer, uniform expected counts, burden separation and no winner", () => {
  const baselines = scoreBaselines(CASES);
  assert.deepEqual(Object.keys(baselines.constant), DECISION_ACTIONS);
  assert.equal(baselines.noAnswer.overall.noAnswer, 100);
  assert.equal(baselines.constant.confirm.overall.acceptable, 50);
  assert.equal(baselines.constant.confirm.overall.dangerous, 4);
  assert.equal(baselines.constant.confirm.overall.neutral, 46);
  assert.equal(baselines.constant.confirm.overall.overConfirm.cases, 4);
  assert.equal(baselines.constant.confirm.overall.overConfirm.bases, 2);
  assert.equal(baselines.constant.confirm.overall.unneededConfirm.cases, 18);
  assert.equal(baselines.constant.confirm.overall.unneededConfirm.bases, 9);
  close(baselines.constant.confirm.byStrategy["repair-first"].acceptableRate, 0.54);
  close(baselines.constant.confirm.byStrategy["bypass-enabled"].acceptableRate, 0.46);
  assert.equal(baselines.uniform.expectedCounts, true);
  close(baselines.uniform.overall.acceptable, Object.values(baselines.constant).reduce((sum, value) => sum + value.overall.acceptable, 0) / 9);
  close(baselines.uniform.overall.falseAgreeProbability.mean, 1 / 9);
  assert.doesNotMatch(JSON.stringify(baselines), /winner|composite|"model"/);
});

test("planning refuses more than 200 calls and concurrency above four before contacting clients", async () => {
  assert.equal(planEvaluation().plannedCalls, 200); assert.equal(MAX_CALLS, 200);
  let calls = 0;
  const client = { chooseAction() { calls++; throw new Error("must not call"); } };
  await assert.rejects(runEvaluation({ cases: [...CASES, { ...CASES[0], id: "overflow" }], client, log: quiet }), (error) => error.code === "call_cap_exceeded");
  for (const concurrency of [0, 5, 1.5, NaN]) await assert.rejects(runEvaluation({ client, concurrency, log: quiet }), (error) => error.code === "invalid_concurrency");
  assert.equal(calls, 0);
});

test("runner sends each model identical state, limits concurrency and makes exactly one attempt per planned call", async () => {
  const seen = [], fake = createMockClient();
  let live = 0, peak = 0;
  const output = await runEvaluation({ cases: CASES.slice(0, 8), concurrency: 3, log: quiet, client: { async chooseAction(request) {
    seen.push(request); live++; peak = Math.max(peak, live); await nextLoop(); live--;
    return fake.chooseAction(request);
  } } });
  assert.equal(peak, 3); assert.equal(seen.length, 16); assert.equal(output.rows.length, 16);
  for (let index = 0; index < seen.length; index += 2) {
    assert.equal(seen[index].state, seen[index + 1].state);
    assert.deepEqual([seen[index].purpose, seen[index + 1].purpose], PURPOSES);
    assert.deepEqual(Object.keys(seen[index]).sort(), ["purpose", "state"]);
  }
});

test("runner errors retain only allowlisted code/status; raw bodies, response extras and keys disappear", async () => {
  const secrets = "PRIVATE-KEY-PROMPT-UPSTREAM";
  let calls = 0;
  const result = await runEvaluation({ cases: CASES.slice(0, 1), log: quiet, client: { chooseAction() {
    calls++;
    throw Object.assign(new Error(secrets), { code: calls === 1 ? "payment_required" : secrets, status: 402, rawBody: secrets });
  } } });
  assert.equal(calls, 2);
  assert.deepEqual(result.rows.map((row) => row.error), ["payment_required", "decision_unavailable"]);
  assert.ok(result.rows.every((row) => row.status === 402));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-KEY|rawBody/);
  const invalid = await runEvaluation({ cases: CASES.slice(0, 1), log: quiet, client: { chooseAction: () => ({ action: "accept", probabilities: {}, rawBody: secrets }) } });
  assert.ok(invalid.rows.every((row) => row.error === "invalid_response"));
});

test("captured console output contains aggregate statistics and never rows, state, utterances or local annotations", async () => {
  const captured = [], original = console.log;
  console.log = (...args) => captured.push(args.join(" "));
  try { await runEvaluation({ client: createMockClient() }); }
  finally { console.log = original; }
  assert.equal(captured.length, 1);
  const output = captured.join("\n");
  const data = JSON.parse(output); assert.equal(data.plan.plannedCalls, 200); assert.ok(data.summary.byPurpose);
  assert.doesNotMatch(output, /"rows"|"state"|"rationale"|"acceptable":\[|synthetic-/);
  for (const value of CASES) {
    for (const event of value.events) assert.ok(!output.includes(event.text));
    for (const text of Object.values(value.rationale)) assert.ok(!output.includes(text));
  }
});

test("default dry-run and --mock never initialize the live client; --live requires private output", async () => {
  let live = 0;
  const deps = { log: quiet, createLiveClient() { live++; throw new Error("must not initialize"); } };
  const dry = await main([], deps); assert.equal(dry.mode, "dry-run"); assert.equal(dry.plan.plannedCalls, 200);
  const mocked = await main(["--mock"], deps); assert.equal(mocked.rows.length, 200);
  await assert.rejects(main(["--live"], deps), (error) => error.code === "output_required");
  await assert.rejects(main(["--mock", "--live"], deps), (error) => error.code === "invalid_arguments");
  assert.equal(live, 0);
});

test("--mock runs end to end, saves only private per-case rows outside the repository and prints aggregates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decisions-eval-mock-"));
  try {
    const { stdout, stderr } = await execute(process.execPath, [script, "--mock", "--out", directory], { maxBuffer: 4 * 1024 * 1024 });
    assert.equal(stderr, "");
    const printed = JSON.parse(stdout); assert.equal(printed.plan.plannedCalls, 200);
    const [filename] = await readdir(directory);
    const path = join(directory, filename);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 200); assert.equal(new Set(rows.map((row) => `${row.caseId}/${row.purpose}`)).size, 200);
    assert.ok(rows.every((row) => row.action === "accept" && row.error === null));
    assert.doesNotMatch(JSON.stringify(rows), /publicUtterances|rationale|stratum|acceptable|dangerous/);
    const expected = scoreResults(CASES, rows);
    assert.deepEqual(printed.summary, expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("repository and symlink-back output paths fail before any call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decisions-eval-path-"));
  let calls = 0;
  const client = { chooseAction() { calls++; throw new Error("must not call"); } };
  try {
    await assert.rejects(runEvaluation({ client, outDir: resolve("dialogue-model/runtime/decisions-eval"), log: quiet }), (error) => error.code === "repository_output_forbidden");
    const link = join(directory, "repo-link"); await symlink(resolve("."), link);
    await assert.rejects(runEvaluation({ client, outDir: link, log: quiet }), (error) => error.code === "repository_output_forbidden");
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
