// Mock-only: no Keychain, live provider, deployment, or participant material.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevEvaluation, parseEvaluationArguments, evaluationErrorCode } from "../dialogue-model/runtime/diagnostics/jev-decision-eval/live.ts";
import type { EvaluationDependencies } from "../dialogue-model/runtime/diagnostics/jev-decision-eval/live.ts";
import { evaluateTrialGate, evaluateRunGate, projectDecision, auditJevLocalTurn } from "../dialogue-model/runtime/diagnostics/jev-decision-eval/gate.ts";
import type { TrialReceipt } from "../dialogue-model/runtime/diagnostics/jev-decision-eval/gate.ts";
import type { JevDecision } from "../dialogue-model/runtime/decision/contract.ts";
import { SYNTHETIC_CASES } from "../dialogue-model/runtime/diagnostics/jev-decision-eval/cases.ts";
import type { SyntheticCase } from "../dialogue-model/runtime/diagnostics/jev-decision-eval/cases.ts";
import { createLunaObserver, ObservationError } from "../dialogue-model/runtime/observation/observe.ts";
import { createJevDecisionClient } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { createJevLocalTestClassifier } from "../dialogue-model/runtime/local-grounding/jev-local-test.ts";
import { verifyLocalUpdate, recordAiClaims } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { deriveLocalIssues } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";

function decision(extra: Partial<JevDecision> = {}): JevDecision {
  const result: JevDecision = { action: "accept", target: { kind: "single", figureId: "s-0001" }, name: null, feature: null, observe: null,
    decisionKind: "jev_local_test", calibrated: false, evidence: { model: "typesafe/jev-1.14-20261014", responseId: "synthetic-1",
      choices: { action: "accept" }, scores: { action: { accept: 1 } }, latencyMs: 1, costUsd: 0,
      inputBudget: { maxChars: 20000, stateChars: 1000, omitted: { publicTurns: 0, claims: 0, publicNames: 0, repairHistory: 0,
        reobservations: 0, observationDetails: 0, observationChars: 0, issueSummaryChars: 0 } } }, ...extra };
  result.evidence.stages = ["action_target", ...(["propose_name", "agree", "confirm", "repair", "request_observation"].includes(result.action) ? ["detail"] : [])]
    .map((stage): any => ({ ...structuredClone(result.evidence), stage }));
  return result;
}
function trial(): TrialReceipt {
  const anchors = Array.from({ length: 6 }, (_, i) => ({ id: `s-000${i + 1}`, bbox: { x: i * 10, y: 0, w: 8, h: 8 }, centroid: { x: i * 10 + 4, y: 4 } }));
  const selected = decision();
  const result: TrialReceipt = { caseId: "synthetic", completed: true, expectedTurns: 3, anchors,
    observations: [{ turn: null, kind: "initial", order: 1, figureIds: anchors.map(a => a.id), succeeded: true,
      memo: { observedAt: "2026-10-20T00:00:00.000Z", figures: anchors.map(a => ({ id: a.id, region: a.bbox,
        holistic: [{ construal: "牛", basis: ["二つの出っ張り"], status: "hypothesis" }],
        analytic: { shapes: ["四角"], composition: "四角と細い部分", relations: ["角でつながる"] }, unknowns: [], reobservations: [] })) } }],
    wire: [{ turn: null, phase: "observation_initial", imageCount: 1, succeeded: true }],
    turns: Array.from({ length: 3 }, (_, i) => ({ turn: i * 2 + 1, committed: true, traceMatches: true, decisions: [structuredClone(selected)], decisionOrder: [i + 2], finalAct: projectDecision(selected),
      intervention: "none_pending_researcher_decision", publicText: "なるほど、そう見えるんですね。",
      local: { turn: i * 2 + 1, verified: [], unverified: 0, classifierOk: true, pipelineOk: true, model: "typesafe/jev-1.14" },
      issues: [], ledger: Object.fromEntries(anchors.map(a => [a.id, { status: "unassigned", name: null }])), repairHistory: [], step: { text: "形の話をしよう。" } })) };
  const claim = (id: string, act: string, aspect: string, targets = ["s-0001"]): any => ({ kind: "claim", id, act, aspect, targets,
    issueId: id, proposition: "四角がある", name: null, sourceTurn: Number(id.split(":")[0]), quote: "四角がある", speaker: "human", respondsTo: null, source: "partner_statement" });
  result.turns[0].step.check = "construal_without_conflict";
  result.turns[0].local.verified = [claim("1:local1", "construe", "construal")];
  result.turns[1].step.check = "partial_agreement";
  result.turns[1].local.verified = [claim("3:local1", "agree", "part"), claim("3:local2", "deny", "part")];
  result.turns[1].issues = ["supported", "denied"].map((state, i): any => ({ issueId: `3:local${i + 1}`, aspect: "part", targets: ["s-0001"], state,
    nameState: null, name: null, claimIds: [`3:local${i + 1}`], lastTurn: 3 }));
  result.turns[2].step.check = "multiple_candidates";
  result.turns[2].local.verified = [claim("5:local1", "assert", "referent", ["s-0001", "s-0002"])];
  const observe = { figureIds: ["s-0001"], aspect: "part" as const, question: "四角はあるか", partnerConstrual: null };
  result.turns[2].decisions.unshift(decision({ action: "request_observation", observe }));
  result.turns[2].decisionOrder = [4, 6];
  const issue = { aspect: observe.aspect, question: observe.question, partnerConstrual: null };
  result.observations.push({ turn: 5, kind: "targeted", order: 5, figureIds: observe.figureIds, issue, succeeded: true,
    result: { observedAt: "2026-10-20T00:00:01.000Z", issue, figures: [{ figureId: "s-0001", supports: ["四角がある"], contradicts: [], unknown: [] }] } });
  result.wire.push({ turn: 5, phase: "observation_targeted", imageCount: 1, succeeded: true });
  result.turns[2].repairHistory = ["changed", "unchanged"].map((progress, i): any => ({ turn: 3 + i * 2, issueId: "3:local1", action: "confirm", question: "四角はあるか",
    partnerClaims: [], candidatesBefore: ["s-0001", "s-0002"], candidatesAfter: i ? ["s-0001", "s-0002"] : ["s-0001"],
    addedClaimIds: [], removedClaimIds: [], progress }));
  return result;
}

test("gate audits six own regions, image phases, all Jev decisions and every local function", () => {
  const good = trial(), result = evaluateRunGate([good], [good.caseId]);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(result.returnedModels, ["typesafe/jev-1.14-20261014"]);
  assert.deepEqual(result.counts, { turns: 3, initial: 1, targeted: 1, requests: 1, unverified: 0, invalidDecisions: 0,
    construal: 1, partial: 1, multiple: 1, denial: 1, progress: 1, stagnation: 1 });
});

test("memo ids, regions and the exactly-once initial observation cannot borrow evidence", () => {
  for (const change of [
    (t: TrialReceipt) => { t.observations[0].memo!.figures[0].id = "s-ffff"; },
    (t: TrialReceipt) => { t.observations[0].memo!.figures[0].region = { x: 999, y: 0, w: 8, h: 8 }; },
    (t: TrialReceipt) => { t.observations.push(structuredClone(t.observations[0])); },
    (t: TrialReceipt) => { t.observations.shift(); },
  ]) {
    const changed = trial(); change(changed); assert.equal(evaluateTrialGate(changed).passed, false);
  }
});

test("every image send and reobservation must match the Jev request and own figures", () => {
  for (const [code, change] of [
    ["non_observation_image", (t: TrialReceipt) => { t.wire.push({ turn: 1, phase: "local_extraction", imageCount: 1, succeeded: true }); }],
    ["observation_wire_mismatch", (t: TrialReceipt) => { t.wire[0].imageCount = 0; }],
    ["reobservation_mismatch", (t: TrialReceipt) => { t.observations[1].figureIds = ["s-0002"]; }],
    ["reobservation_mismatch", (t: TrialReceipt) => { t.observations[1].issue!.question = "別の論点"; }],
    ["reobservation_mismatch", (t: TrialReceipt) => { t.turns[2].decisions.shift(); }],
    ["reobservation_mismatch", (t: TrialReceipt) => { t.turns[2].decisions.reverse(); }],
    ["reobservation_mismatch", (t: TrialReceipt) => { t.observations[1].order = 3; }],
    ["luna_judgment_called", (t: TrialReceipt) => { t.wire.push({ turn: 1, phase: "judgment", imageCount: 0, succeeded: true }); }],
  ] as const) {
    const changed = trial(); change(changed); assert.ok(evaluateTrialGate(changed).unmet.includes(code));
  }
});

test("Jev origin includes the pre-reobservation decision, model snapshot and unchanged final act", () => {
  for (const model of ["typesafe/jev-1.14", "typesafe/jev-1.14-20261014"]) {
    const good = trial(); good.turns[0].decisions[0].evidence.model = model;
    assert.equal(evaluateTrialGate(good).passed, true);
  }
  for (const change of [
    (t: TrialReceipt) => { t.turns[2].decisions[0].decisionKind = "mock"; },
    (t: TrialReceipt) => { t.turns[0].decisions[0].evidence.model = "typesafe/jev-1.14-other"; },
    (t: TrialReceipt) => { t.turns[0].decisions[0].evidence.responseId = null; },
    (t: TrialReceipt) => { t.turns[0].finalAct!.action = "repair"; },
    (t: TrialReceipt) => { t.turns[0].finalAct!.targetSlot = "s-0002"; },
    (t: TrialReceipt) => { t.turns[0].intervention = "bypass"; },
    (t: TrialReceipt) => { t.turns[0].publicText = "その名前で決まりです。"; },
  ]) {
    const changed = trial(); change(changed); assert.equal(evaluateTrialGate(changed).passed, false);
  }
});

test("construal, partial agreement, multiple candidates and repair progress stay separate", () => {
  for (const change of [
    (t: TrialReceipt) => { t.turns[0].local.verified[0].act = "name_reject"; },
    (t: TrialReceipt) => { t.turns[1].issues[1].issueId = t.turns[1].issues[0].issueId; },
    (t: TrialReceipt) => { t.turns[1].ledger["s-0001"].status = "agreed"; },
    (t: TrialReceipt) => { t.turns[2].local.verified[0].targets = ["s-0001"]; },
    (t: TrialReceipt) => { t.turns[2].repairHistory[1].progress = "changed"; },
    (t: TrialReceipt) => { t.turns[0].local.unverified = 1; },
    (t: TrialReceipt) => { t.turns[0].local.pipelineOk = false; },
    (t: TrialReceipt) => { t.turns[0].committed = false; },
    (t: TrialReceipt) => { t.turns[0].traceMatches = false; },
    (t: TrialReceipt) => { t.turns[2].repairHistory[0].addedClaimIds = ["99:unverified"]; },
  ]) {
    const changed = trial(); change(changed); assert.equal(evaluateRunGate([changed], [changed.caseId]).passed, false);
  }
});

test("repair progress requires novel figure content; difficulty, repeats and record removal remain stagnation", () => {
  const information = ["assert", "agree", "deny", "construe", "name_propose", "name_accept", "name_reject"];
  const nonInformation = ["defer", "ask", "acknowledge", "unknown", "withdraw", "revisit"];
  for (const act of [...information, ...nonInformation]) for (const aspect of ["part", "question", "progress"]) {
    const receipt = trial(), repair = receipt.turns[2].repairHistory[0];
    const claim: any = { ...receipt.turns[1].local.verified[0], id: "5:local2", sourceTurn: 5, act, aspect, proposition: "新しい図形の内容" };
    receipt.turns[2].local.verified.push(claim);
    repair.partnerClaims = [{ id: claim.id, act: claim.act, proposition: claim.proposition, targets: claim.targets }];
    repair.candidatesAfter = [...repair.candidatesBefore];
    const informative = information.includes(act) && aspect === "part";
    repair.addedClaimIds = informative ? [claim.id] : [];
    repair.progress = informative ? "changed" : "unchanged";
    assert.equal(evaluateTrialGate(receipt).passed, true, act + ":" + aspect);
    repair.progress = informative ? "unchanged" : "changed";
    assert.ok(evaluateTrialGate(receipt).unmet.includes("repair_history_invalid"), act + ":" + aspect);
  }
  for (const after of [["s-0001", "s-0002", "s-0003"], [], ["s-0002", "s-0003"]]) {
    const receipt = trial(), repair = receipt.turns[2].repairHistory[0];
    repair.candidatesAfter = after; repair.removedClaimIds = ["3:local1"]; repair.progress = "unchanged";
    assert.equal(evaluateTrialGate(receipt).passed, true);
    repair.progress = "changed";
    assert.ok(evaluateTrialGate(receipt).unmet.includes("repair_history_invalid"));
  }
  const receipt = trial(), repair = receipt.turns[2].repairHistory[0];
  const repeated: any = { ...receipt.turns[1].local.verified[0], id: "5:local2", sourceTurn: 5, targets: ["s-0001", "s-0002", "s-0003"] };
  receipt.turns[2].local.verified.push(repeated);
  repair.partnerClaims = [{ id: repeated.id, act: repeated.act, proposition: repeated.proposition, targets: repeated.targets }];
  repair.candidatesAfter = repeated.targets; repair.progress = "unchanged";
  assert.equal(evaluateTrialGate(receipt).passed, true); // New ID and wider overlapping targets are not new content.
  repair.addedClaimIds = [repeated.id]; repair.progress = "changed";
  assert.ok(evaluateTrialGate(receipt).unmet.includes("repair_history_invalid"));
  repair.addedClaimIds = []; repair.candidatesAfter = ["s-0001"];
  assert.equal(evaluateTrialGate(receipt).passed, true); // Strict narrowing independently supplies progress.
});

test("every Jev stage contributes model validation and omission accounting once", () => {
  const receipt = trial(), evidence = receipt.turns[2].decisions[0].evidence;
  evidence.stages![1].inputBudget!.omitted.repairHistory = 4;
  const result = evaluateTrialGate(receipt);
  assert.equal(result.passed, true); assert.equal(result.inputBudget.calls, 5);
  assert.equal(result.inputBudget.omittingCalls, 1); assert.equal(result.inputBudget.omitted.repairHistory, 4);
  evidence.stages![0].model = "typesafe/jev-1.14-wrong";
  assert.ok(evaluateTrialGate(receipt).unmet.includes("jev_evidence_invalid"));
  evidence.stages![0].model = evidence.model;
  delete evidence.stages![1].inputBudget;
  assert.ok(evaluateTrialGate(receipt).unmet.includes("input_budget_unreported"));
  evidence.stages!.pop();
  assert.ok(evaluateTrialGate(receipt).unmet.includes("jev_evidence_invalid"));
});

test("Jev independent audit retains multiple AI feature targets and excludes fallback claims", () => {
  const anchors = trial().anchors, targets = anchors.slice(0, 2).map(a => a.id);
  const publicTurns = [{ turn: 1, speaker: "human" as const, text: "形の話をしよう。" },
    { turn: 2, speaker: "ai" as const, text: "四角がある形ですか？" }, { turn: 3, speaker: "human" as const, text: "そうだね。" }];
  for (const fallback of [false, true]) {
    const graph = createReferenceGraph({ slots: anchors.map(a => a.id) });
    const judgment = { action: "confirm", targetSlot: null, candidateName: null, discriminatingFeature: "四角" };
    const before = { graph, judgments: [{ turnIndex: 1, judgment, generationGuard: { fallback }, jevTurn: { decision: { target: { kind: "multiple", figureIds: targets } } } }] };
    const operations = recordAiClaims({ graph, turn: 3, publicTurns,
      priorAct: { ...judgment, turn: 2, targetCandidates: targets, publishedFallback: fallback } }).operations;
    assert.equal(operations.length, fallback ? 0 : 1);
    if (!fallback) { assert.deepEqual(operations[0].targets, targets); assert.equal(operations[0].aspect, "part"); }
    const after = { graph: applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn: 3, operations }, { publicTurns, generationSucceeded: true }), judgments: [{ judgment: { reference: null } }] };
    const record: any = { status: "committed", localStatus: "ok", aiClaims: operations, claims: [], verification: { accepted: operations.map(c => c.id) } };
    const input = { before, after, publicTurns, record, segments: [], verdicts: [] };
    const audit = auditJevLocalTurn(input);
    assert.equal(audit.pipelineOk, true); assert.equal(audit.unverified, 0); assert.deepEqual(audit.verified, operations);
    if (!fallback) {
      before.judgments[0].jevTurn.decision.target.figureIds = [targets[0]];
      const forged = auditJevLocalTurn(input); assert.equal(forged.pipelineOk, false); assert.equal(forged.unverified, 1);
    }
  }
});

test("all failed cases remain in the gate; selecting successful cases cannot pass", () => {
  const good = trial(), bad = trial(); bad.caseId = "failed"; bad.completed = false;
  const result = evaluateRunGate([good, bad], [good.caseId, bad.caseId]);
  assert.equal(result.passed, false); assert.deepEqual(result.caseIds, [good.caseId, bad.caseId]);
  assert.equal(result.cases.length, 2); assert.ok(result.cases[0].passed); assert.ok(!result.cases[1].passed);
  assert.ok(evaluateRunGate([good], [good.caseId, bad.caseId]).unmet.includes("catalog_incomplete"));
  assert.equal(evaluateRunGate([], []).passed, false);
  const missing = trial(); missing.turns[2].repairHistory = [];
  assert.ok(evaluateRunGate([missing], [missing.caseId]).unmet.includes("repair_stagnation_missing"));
  bad.failureCode = "invalid_decision";
  assert.equal(evaluateRunGate([good, bad], [good.caseId, bad.caseId]).counts.invalidDecisions, 1);
});

test("input omission is reported per decision and run without treating it as failure", () => {
  const good = trial(); good.turns[0].decisions[0].evidence.inputBudget!.omitted.claims = 7;
  good.turns[0].decisions[0].evidence.stages![0].inputBudget!.omitted.claims = 7;
  const result = evaluateRunGate([good], [good.caseId]);
  assert.equal(result.passed, true); assert.equal(result.inputBudget.omittingCalls, 1);
  assert.equal(result.inputBudget.omitted.claims, 7); assert.equal(result.inputBudget.calls, 5);
  delete good.turns[0].decisions[0].evidence.inputBudget;
  assert.ok(evaluateTrialGate(good).unmet.includes("input_budget_unreported"));
});

test("anonymous scripts contain only current human speech with no action elicitation", () => {
  assert.equal(SYNTHETIC_CASES.length, 3);
  assert.equal(new Set(SYNTHETIC_CASES.map(c => c.id)).size, 3);
  for (const c of SYNTHETIC_CASES) for (const step of c.steps) {
    assert.deepEqual(Object.keys(step).filter(k => !["text", "expect", "check"].includes(k)), []);
    assert.doesNotMatch(step.text, /説明して|提案して|選んで|撤回して|取り消して|act|ER1|a11|s-[0-9a-f]{4}/u);
  }
});

test("negative feature assertion satisfies the corrected script without being promoted to a responsive denial", () => {
  const step = SYNTHETIC_CASES.find(c => c.id === "repair-information")!.steps.find(s => s.text === "棒の方には四角がない。")!;
  const receipt = trial(), graph = createReferenceGraph({ slots: receipt.anchors.map(a => a.id) });
  const publicTurns = [{ turn: 1, speaker: "human" as const, text: step.text }];
  const segment = { segmentId: "s1", quote: step.text, targets: [receipt.anchors[0].id], aspect: "part" as const,
    proposition: "棒の方には四角がない", name: null, linkedIssueId: null, respondsToTurn: null };
  const input = { graph, turn: 1, publicTurns, segments: [segment] };
  const accepted = verifyLocalUpdate({ ...input, verdicts: [{ segmentId: "s1", act: "assert", respondsToClaimId: null, rawScore: null }] });
  assert.equal(accepted.operations.length, 1); assert.equal(accepted.operations[0].respondsTo, null);
  const after = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn: 1, operations: accepted.operations }, { publicTurns, generationSucceeded: true });
  assert.equal(deriveLocalIssues(after)[0].state, "unconfirmed");
  receipt.turns[0].step = structuredClone(step); receipt.turns[0].local.verified = accepted.operations;
  assert.equal(evaluateTrialGate(receipt).passed, true);
  const rejected = verifyLocalUpdate({ ...input, verdicts: [{ segmentId: "s1", act: "deny", respondsToClaimId: null, rawScore: null }] });
  assert.equal(rejected.operations.length, 0); assert.equal(rejected.rejected[0].reason, "missing_claim_response");
  receipt.turns[0].local.verified = rejected.operations;
  assert.ok(evaluateTrialGate(receipt).unmet.includes("script_mismatch"));
});

test("manual CLI rejects missing paths, unsupported modes, duplicate flags and bad budgets", () => {
  assert.throws(() => parseEvaluationArguments([]), /output_directory_required/);
  assert.deepEqual(parseEvaluationArguments(["--out", "/tmp/synthetic", "--case", "animal-construal", "--local-timeout-ms", "60000"]),
    { outputDir: "/tmp/synthetic", seed: 1701, caseId: "animal-construal", localTimeoutMs: 60000 });
  for (const args of [["--out", "x", "--strategy", "repair-first"], ["--out", "x", "--out", "y"], ["--out", "x", "--case"],
    ["--out", "x", "--local-timeout-ms", "0"], ["--out", "x", "--local-timeout-ms", "60001"], ["--out", "x", "--seed", "NaN"]]) {
    try { parseEvaluationArguments(args); assert.fail("invalid args accepted"); }
    catch (error) { assert.equal(evaluationErrorCode(error), "invalid_arguments"); }
  }
  assert.equal(evaluationErrorCode(Object.assign(new Error("Bearer SYNTHETIC_PRIVATE_ERROR"), { code: "cost_cap", response: "raw" })), "evaluation_unavailable");
});

test("repository and symlink destinations fail before components or clients are invoked", async () => {
  let calls = 0;
  const deps: EvaluationDependencies = { execution: "mock", expectedModel: "worker-fixed", client: { async complete() { calls++; throw new Error("unexpected"); } },
    createComponents() { calls++; throw new Error("unexpected"); } };
  await assert.rejects(runJevEvaluation({ outputDir: process.cwd(), seed: 1701 }, deps), /repository_output_forbidden/);
  const directory = await mkdtemp(join(tmpdir(), "jev-eval-path-"));
  try {
    await symlink(process.cwd(), join(directory, "repo"));
    await assert.rejects(runJevEvaluation({ outputDir: join(directory, "repo", "nested"), seed: 1701 }, deps), /repository_output_forbidden/);
    await assert.rejects(runJevEvaluation({ outputDir: directory, seed: 1701, caseId: "absent" }, deps), /case_not_found/);
    assert.deepEqual(await readdir(directory), ["repo"]); assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const script: SyntheticCase = { id: "mock-information-cycle", steps: [
  { text: "馬にも牛にも見える形がある。", check: "construal_without_conflict" },
  { text: "四角があるね。", expect: [{ act: "agree", aspect: "part" }] },
  { text: "四角があるね。", expect: [{ act: "agree", aspect: "part" }] },
  { text: "四角があるのは合ってるけど、細い部分は二つじゃない。", check: "partial_agreement", expect: [{ act: "agree" }, { act: "deny" }] },
  { text: "鳥に見えるのは二つあって、どちらか分からない。", check: "multiple_candidates" },
  { text: "細い方を『つばめ』と呼ぼう。", expect: [{ act: "name_propose", aspect: "name" }] },
  { text: "次は鍵みたいな形の話をしよう。" },
] };
type MockFault = { phase?: string; phaseAt?: number; publicText?: string; model?: string; decisionModel?: string; cost?: number; classificationUnknown?: boolean;
  firstAction?: "defer" | "move_on" | "revisit" | "confirm" | "repair"; bareReply?: "agree" | "deny"; postObservationConfirm?: boolean; firstTarget?: "none" | "multiple"; decisionChoices?: Record<string, string>; detailFault?: "network" | "partial" | "model" };
function e2eDependencies(fault: MockFault = {}): EvaluationDependencies & { calls: any[]; http: any[]; created: { count: number } } {
  const calls: any[] = [], http: any[] = [], created = { count: 0 };
  const phaseCounts: Record<string, number> = {};
  let faultUsed = false;
  const client = { async complete(messages: any[], options: any) {
    calls.push({ messages: structuredClone(messages), phase: options.phase, timeoutMs: options.timeoutMs });
    phaseCounts[options.phase] = (phaseCounts[options.phase] ?? 0) + 1;
    if (!faultUsed && fault.phase === options.phase && phaseCounts[options.phase] === (fault.phaseAt ?? 1)) {
      faultUsed = true;
      if (fault.model) return { text: "なるほど。", model: fault.model };
      throw Object.assign(new Error("Bearer PRIVATE_PROVIDER_ERROR"), { code: "PRIVATE_CODE", response: "PRIVATE_RAW_RESPONSE" });
    }
    const context = messages.filter(m => m.role === "user" && typeof m.content === "string").map(m => m.content).find(s => s.startsWith("{"));
    const state = context ? JSON.parse(context) : null;
    let text = "なるほど、そう見えるんですね。";
    if (options.phase === "observation_initial") text = JSON.stringify({ figures: state.ownAnchors.map((a: any) => ({ id: a.id,
      holistic: [{ construal: "牛", basis: ["二つの出っ張り"], status: "hypothesis" }],
      analytic: { shapes: ["四角", "細い部分が二つ"], composition: "四角と細い部分", relations: ["角でつながる"] }, unknowns: [] })) });
    else if (options.phase === "observation_targeted") text = JSON.stringify({ figures: state.figureIds.map((figureId: string) => ({ figureId,
      supports: ["四角が一つある"], contradicts: [], unknown: [] })) });
    else if (options.phase === "local_extraction") {
      const turn = state.turn, quote = state.publicTurns.at(-1).text, slots = state.ownSlots;
      const segment = (id: string, aspect: string, proposition: string, targets = [slots[0]], name: string | null = null) =>
        ({ segmentId: id, quote, targets, aspect, proposition, name, linkedIssueId: null, respondsToTurn: null });
      text = JSON.stringify(turn === 3 && fault.bareReply ? [segment("s1", "part", fault.bareReply === "agree" ? "四角がある" : "四角がない", [])] : turn === 1 ? [segment("s1", "construal", "馬にも牛にも見える")] :
        [3, 5].includes(turn) ? [segment("s1", "part", "四角がある")] : turn === 7 ?
          [segment("s1", "part", "四角がある"), segment("s2", "part", "細い部分が二つではない")] : turn === 9 ?
            [segment("s1", "referent", "鳥に見える候補が二つ", slots.slice(1, 3))] : turn === 11 ?
              [segment("s1", "name", "つばめという名前を提案", [slots[1]], "つばめ")] : [segment("s1", "construal", "鍵に見える", [slots[2]])]);
    } else if (options.phase === "generation") {
      if (fault.publicText) text = fault.publicText === "prompt" ? messages.find(m => m.role === "system").content.split("\n").find((s: string) => s.length >= 24) : fault.publicText;
      else {
        const act = JSON.parse(messages.find(m => typeof m.content === "string" && m.content.startsWith("Jevが選んだ行動だけ")).content.split("\n").at(-1));
        text = ["confirm", "repair"].includes(act.action) ? `${act.discriminatingFeature}がある形のことですか？` : act.action === "agree" ? "「つばめ」でいいですね。" :
          act.action === "defer" ? "その形の話はあとで戻ろう。" : act.action === "move_on" ? "別の形の話に進もう。" : text;
      }
    } else assert.fail("unexpected Luna phase " + options.phase);
    return { text, model: "worker-fixed" };
  } };
  function response(payload: any, choices: Record<string, string>, model = "typesafe/jev-1.14-20261014") {
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, q]: [string, any]) => {
      const choice = choices[key] ?? "none";
      assert.ok(Object.hasOwn(q.criteria, choice), "mock selected unavailable choice " + key + ":" + choice);
      return [key, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(label => [label, label === choice ? 1 : 0])) }];
    }));
    return Response.json({ model, id: "gen-synthetic-" + http.length, answers, usage: { input_tokens: 10, output_tokens: 0, cost: fault.cost ?? 0.00001 } });
  }
  return { client, expectedModel: "worker-fixed", execution: "mock", cases: [script], calls, http, created,
    createComponents(shared, componentOptions = {}) {
      created.count++;
      const readKey = async () => "sk-or-SYNTHETIC-MOCK-ONLY-1234567890";
      return { observer: createLunaObserver(shared, { now: () => new Date("2026-10-20T00:00:00.000Z"),
        ...(componentOptions.observationTimeoutMs === undefined ? {} : { timeoutMs: componentOptions.observationTimeoutMs }) }),
        jevDecision: createJevDecisionClient({ enabled: true, readKey, fetchImpl: async (_url, request) => {
          const payload = JSON.parse(request.body as string), state = JSON.parse(payload.state);
          http.push({ kind: "decision", payload });
          const choices: Record<string, string> = {};
          if (payload.questions.action) {
            const observe = state.turn === 9 && state.reobservationAllowed;
            const action = state.turn === 1 && fault.firstAction ? fault.firstAction : [1, 3, 5].includes(state.turn) ? "confirm" : observe ? "request_observation" : state.turn === 9 && fault.postObservationConfirm ? "confirm" : state.turn === 11 ? "agree" : "accept";
            Object.assign(choices, { action, target: state.turn === 1 && fault.firstTarget ? fault.firstTarget :
              state.turn === 9 ? "multiple" : state.turn === 11 ? "figure_1" : "figure_0" });
            for (let i = 0; i < 6; i++) choices[`candidate_${i}`] = (state.turn === 9 ? [1, 2].includes(i) : true) ? "include" : "exclude";
            Object.assign(choices, fault.decisionChoices);
          } else {
            if (fault.detailFault === "network") throw new Error("PRIVATE_DETAIL_ERROR");
            if (fault.detailFault === "partial") return Response.json({ model: "typesafe/jev-1.14", answers: {}, usage: { cost: 0.00001 } });
            for (const [key, question] of Object.entries(payload.questions) as Array<[string, any]>) {
              choices[key] = Object.keys(question.criteria).find(label => {
                if (key === "observe_aspect") return label === "part";
                const candidate = JSON.parse(question.criteria[label]);
                return key === "observe_targets" ? candidate.length === 1 && candidate[0] === state.selected.target.figureIds[0] :
                  candidate.value === (key === "name" ? "つばめ" : state.turn === 5 ? "細い部分が二つ" : "四角");
              })!;
            }
          }
          return response(payload, choices, fault.detailFault === "model" && !payload.questions.action ? "typesafe/jev-1.14-other" : fault.decisionModel);
        } })!,
        classifier: createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl: async (_url, request) => {
          const payload = JSON.parse(request.body as string), state = JSON.parse(payload.state); http.push({ kind: "classification", payload });
          const choices: Record<string, string> = {};
          state.segments.forEach((segment: any, i: number) => {
            const act = fault.classificationUnknown ? "unknown" : state.turn === 3 && fault.bareReply ? fault.bareReply : state.turn === 1 || state.turn === 13 ? "construe" : state.turn === 11 ? "name_propose" : state.turn === 9 ? "assert" : i === 1 ? "deny" : "agree";
            const prior = ["agree", "deny"].includes(act) ? state.priorClaims.findLastIndex((c: any) => c.speaker === "ai" && c.aspect === "part" &&
              c.proposition.includes(act === "deny" && !fault.bareReply ? "細い部分が二つ" : "四角")) : -1;
            choices[`segment_${i}_act`] = act; choices[`segment_${i}_antecedent`] = prior >= 0 ? "claim_" + prior : "none";
          });
          return response(payload, choices);
        } })! };
    } };
}
async function temporary(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "jev-decision-eval-"));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("actual pipeline with mock Luna and mock Jev HTTP observes once, preserves partial issues and settles publication", async () => temporary(async outputDir => {
  const deps = e2eDependencies(), result = await runJevEvaluation({ outputDir, seed: 1701, localTimeoutMs: 45000 }, deps);
  assert.equal(result.status, "passed", JSON.stringify(result.gate));
  assert.equal(deps.created.count, 1);
  const document = JSON.parse(await readFile(join(result.directory, script.id + ".private.json"), "utf8"));
  const receipt = document.receipt;
  assert.equal(receipt.turns.length, script.steps.length);
  assert.ok(receipt.turns.every((t: any) => t.committed && t.local.unverified === 0));
  assert.equal(receipt.observations.filter((r: any) => r.kind === "initial").length, 1);
  assert.equal(receipt.observations.filter((r: any) => r.kind === "targeted").length, 1);
  assert.ok(receipt.turns.at(-1).repairHistory.some((r: any) => r.progress === "changed"));
  assert.ok(receipt.turns.at(-1).repairHistory.some((r: any) => r.progress === "unchanged"));
  assert.ok(deps.calls.filter(c => c.phase === "local_extraction").every(c => c.timeoutMs === 45000 && !JSON.stringify(c.messages).includes("image_url")));
  assert.ok(deps.calls.every(c => !/judg/.test(c.phase)));
  const first = deps.http.find(c => c.kind === "decision").payload.state;
  assert.ok(!first.includes(script.steps[4].text) && !first.includes("check") && !first.includes("expect"));
  assert.ok(!first.includes("strategy") && !first.includes("currentAction"));
  const files = await readdir(result.directory);
  const attempts = (await readFile(join(result.directory, "attempts.private.jsonl"), "utf8")).trim().split("\n")
    .flatMap(line => JSON.parse(line).decisionAttempts ?? []);
  assert.ok(attempts.length > 0 && attempts.every(a => Object.keys(a.choices).length === 8 && a.rejectionCode === null && a.stages.length >= 1));
  const sent = deps.http.filter(c => c.kind === "decision");
  assert.equal(result.gate.inputBudget.calls, sent.length);
  const stages = attempts.flatMap(a => a.stages);
  assert.equal(stages.length, sent.length);
  stages.forEach((stage, i) => {
    assert.deepEqual(Object.keys(stage.choices), Object.keys(sent[i].payload.questions));
    for (const [key, label] of Object.entries(stage.choices)) assert.ok(Object.hasOwn(sent[i].payload.questions[key].criteria, label as string));
    assert.equal(stage.status, "ok"); assert.equal(stage.error, null); assert.equal(stage.inputBudget.maxChars, 20000);
  });
  assert.ok(!files.some(f => /blind|mapping|argon|comparison/u.test(f)));
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  for (const file of files) {
    assert.equal((await stat(join(result.directory, file))).mode & 0o777, 0o600);
    const text = await readFile(join(result.directory, file), "utf8");
    for (const canary of ["sk-or-", "data:image/", "PRIVATE_PROVIDER_ERROR", "公開発話の生成"] ) assert.ok(!text.includes(canary));
  }
}));

test("multiple confirm/repair and the next bare reply keep all candidates in independent audit", async () => {
  for (const firstAction of ["confirm", "repair"] as const) for (const bareReply of ["agree", "deny"] as const) await temporary(async outputDir => {
    const deps = e2eDependencies({ firstAction, firstTarget: "multiple", bareReply });
    const c: SyntheticCase = { id: "multiple-reply", steps: [script.steps[0], { text: bareReply === "agree" ? "そうだね。" : "それは違う。", expect: [{ act: bareReply, aspect: "part" }] }] };
    deps.cases = [c];
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    const document = JSON.parse(await readFile(join(result.directory, c.id + ".private.json"), "utf8"));
    assert.equal(document.receipt.completed, true);
    const [first, next] = document.receipt.turns;
    const candidates = document.receipt.anchors.map((a: any) => a.id);
    assert.deepEqual(first.decisions[0].target, { kind: "multiple", figureIds: candidates });
    assert.deepEqual(first.decisions[0].detailFigureIds, candidates);
    assert.equal(first.finalAct.targetSlot, null);
    assert.ok(next.local.pipelineOk && next.local.unverified === 0 && next.traceMatches);
    const ai = next.local.verified.filter((claim: any) => claim.speaker === "ai");
    assert.equal(ai.length, 1); assert.equal(ai[0].aspect, "part"); assert.deepEqual(ai[0].targets, candidates);
    const reply = next.local.verified.find((claim: any) => claim.speaker === "human");
    assert.equal(reply.act, bareReply); assert.equal(reply.respondsTo, ai[0].id); assert.deepEqual(reply.targets, candidates);
    assert.ok(Object.values(first.ledger).every((entry: any) => entry.status === "unassigned"));
    assert.ok(Object.values(next.ledger).every((entry: any) => entry.status !== "agreed"));
  });
});

test("reobservation can have two two-stage judgments while all four stage budgets are counted", async () => temporary(async outputDir => {
  const deps = e2eDependencies({ postObservationConfirm: true });
  const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
  assert.equal(result.status, "passed", JSON.stringify(result.gate));
  const calls = deps.http.filter(call => call.kind === "decision" && JSON.parse(call.payload.state).turn === 9);
  assert.deepEqual(calls.map(call => Object.keys(call.payload.questions)), [
    ["action", "target", "candidate_0", "candidate_1", "candidate_2", "candidate_3", "candidate_4", "candidate_5"],
    ["observe_targets", "observe_aspect"],
    ["action", "target", "candidate_0", "candidate_1", "candidate_2", "candidate_3", "candidate_4", "candidate_5"], ["feature"]]);
  const document = JSON.parse(await readFile(join(result.directory, script.id + ".private.json"), "utf8"));
  const turn = document.receipt.turns.find((turn: any) => turn.turn === 9);
  assert.equal(turn.decisions.length, 2); assert.ok(turn.decisions.every((d: any) => d.evidence.stages.length === 2));
  assert.equal(document.receipt.observations.filter((o: any) => o.turn === 9).length, 1);
  assert.equal(result.gate.inputBudget.calls, deps.http.filter(call => call.kind === "decision").length);
}));

test("provider/model failure keeps every case, previous checkpoints and typed failures, and cannot pass", async () => {
  for (const fault of [{ phase: "generation" }, { phase: "generation", phaseAt: 3 }, { phase: "generation", model: "wrong-worker-model" },
    { decisionModel: "typesafe/jev-1.14-unauthorized" }, { cost: 1 }]) await temporary(async outputDir => {
    const deps = e2eDependencies(fault), next = structuredClone(script); next.id = "second-case"; deps.cases = [script, next];
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    assert.equal(result.status, "gate_failed"); assert.equal(result.gate.cases.length, 2);
    assert.ok((await readdir(result.directory)).includes("failures.private.jsonl"));
    const journal = await readFile(join(result.directory, "attempts.private.jsonl"), "utf8");
    assert.ok(journal.includes('"stage":"initial"'));
    assert.ok(!journal.includes("PRIVATE_PROVIDER_ERROR") && !journal.includes("PRIVATE_RAW_RESPONSE") && !journal.includes("PRIVATE_CODE"));
    if (fault.phaseAt) assert.ok(journal.includes('"stage":"turn"'));
    if (fault.cost) assert.ok(journal.includes('"error":"cost_cap"'));
    if (fault.decisionModel) assert.ok(journal.includes('"error":"model_mismatch"'));
    assert.ok(result.gate.inputBudget.calls > 0); assert.equal(result.gate.inputBudget.missingCalls, 0);
    const failures = await readFile(join(result.directory, "failures.private.jsonl"), "utf8");
    assert.ok(failures.includes(fault.model ? "model_changed" : fault.phase ? "generation_failed" : "decision_failed"));
    if (fault.phase) assert.ok(result.gate.cases[1].passed, JSON.stringify(result.gate));
  });
});

test("rejected local updates remain in the journal and cannot be counted as verified functionality", async () => temporary(async outputDir => {
  const deps = e2eDependencies({ classificationUnknown: true });
  const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
  assert.equal(result.status, "gate_failed");
  const text = await readFile(join(result.directory, "attempts.private.jsonl"), "utf8");
  assert.ok(text.includes("unknown_act"));
  const document = JSON.parse(await readFile(join(result.directory, script.id + ".private.json"), "utf8"));
  assert.ok(document.receipt.turns.every((t: any) => !t.local.verified.some((c: any) => c.speaker === "human")));
  assert.equal(result.gate.counts.unverified, 0);
  assert.ok(result.gate.unmet.includes("script_mismatch"));
}));

test("unsafe public generations fail closed without persisting prompts, images or credentials", async () => {
  for (const publicText of ["data:image/png;base64,QUJD", "Bearer SYNTHETIC_PRIVATE_TOKEN", "sk-or-SYNTHETIC-PRIVATE-12345678", "prompt"]) await temporary(async outputDir => {
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, e2eDependencies({ publicText }));
    assert.equal(result.status, "gate_failed");
    const failure = await readFile(join(result.directory, "failures.private.jsonl"), "utf8");
    assert.ok(failure.includes("unsafe_generation"));
    const document = JSON.parse(await readFile(join(result.directory, script.id + ".private.json"), "utf8"));
    assert.equal(document.publicTurns.filter((t: any) => t.speaker === "ai").length, 0);
    for (const file of await readdir(result.directory)) {
      const text = await readFile(join(result.directory, file), "utf8");
      for (const canary of ["data:image/", "SYNTHETIC_PRIVATE_TOKEN", "sk-or-", "公開発話の生成"]) assert.ok(!text.includes(canary));
    }
  });
});

test("private observation echoes are redacted, stop before another model call, and retain the failed case", async () => temporary(async outputDir => {
  const deps = e2eDependencies(), original = deps.client.complete;
  deps.secrets = ["SYNTHETIC_KNOWN_PRIVATE_CANARY"];
  deps.client.complete = async (messages, options) => {
    const reply = await original(messages, options);
    if (options.phase === "observation_initial") {
      const parsed = JSON.parse(reply.text); parsed.figures[0].unknowns = [deps.secrets![0]];
      return { ...reply, text: JSON.stringify(parsed) };
    }
    return reply;
  };
  const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
  assert.equal(result.status, "gate_failed"); assert.equal(deps.calls.length, 1); assert.equal(deps.http.length, 0);
  const failures = await readFile(join(result.directory, "failures.private.jsonl"), "utf8");
  assert.ok(failures.includes("privacy_rejected"));
  const journal = await readFile(join(result.directory, "attempts.private.jsonl"), "utf8");
  assert.ok(journal.includes('"redacted":true'));
  for (const file of await readdir(result.directory)) assert.ok(!(await readFile(join(result.directory, file), "utf8")).includes(deps.secrets[0]));
}));

test("outbound image inspection blocks a wrong image and an image outside observation before transport", async () => {
  for (const fault of ["wrong_image", "wrong_phase", "embedded_image"]) await temporary(async outputDir => {
    const deps = e2eDependencies(), create = deps.createComponents;
    deps.createComponents = (shared, componentOptions) => {
      const components = create(shared, componentOptions), observer = components.observer;
      return { ...components, observer: { ...observer, async observeAll(input, options) {
        const url = fault === "wrong_image" ? "data:image/png;base64,U1lOVEhFVElDX09OTFk=" : `data:${input.ownImage.mimeType};base64,${input.ownImage.base64}`;
        await shared.complete([{ role: "user", content: fault === "embedded_image" ? url : [{ type: "image_url", image_url: { url } }] }],
        { phase: fault === "wrong_image" ? "observation_initial" : "local_extraction" });
        return observer.observeAll(input, options);
      } } };
    };
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    assert.equal(result.status, "gate_failed"); assert.equal(deps.calls.length, 0);
    const failure = await readFile(join(result.directory, "failures.private.jsonl"), "utf8");
    assert.ok(failure.includes(fault === "wrong_image" ? "wrong_own_material" : "non_observation_image"));
  });
});

test("ambiguous defer/move_on preserve the candidate set and ledger; ambiguous revisit reports invalid_decision", async () => {
  for (const firstAction of ["defer", "move_on", "revisit"] as const) for (const firstTarget of ["none", "multiple"] as const) await temporary(async outputDir => {
    const deps = e2eDependencies({ firstAction, firstTarget });
    const c: SyntheticCase = { id: "ambiguous-action", steps: [script.steps[0]] }; deps.cases = [c];
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    const document = JSON.parse(await readFile(join(result.directory, c.id + ".private.json"), "utf8"));
    const turn = document.receipt.turns[0];
    if (firstAction === "revisit") {
      assert.equal(result.gate.counts.invalidDecisions, 1);
      assert.equal(document.receipt.failureCode, "invalid_decision");
      assert.equal(document.publicTurns.filter((t: any) => t.speaker === "ai").length, 0);
    } else {
      assert.equal(result.gate.counts.invalidDecisions, 0); assert.ok(document.receipt.completed);
      assert.ok(turn.committed && turn.traceMatches); assert.equal(turn.finalAct.action, firstAction);
      assert.equal(turn.finalAct.targetSlot, null);
      assert.ok(Object.values(turn.ledger).every((entry: any) => entry.status === "unassigned" && entry.name === null));
      assert.equal(turn.decisions[0].target.kind, firstTarget);
      if (firstTarget === "multiple") assert.equal(turn.decisions[0].target.figureIds.length, 6);
    }
  });
});

test("observation budget validates CLI/direct callers and preserves the omitted factory default", async () => {
  assert.equal(Object.hasOwn(parseEvaluationArguments(["--out", "/tmp/eval"]), "observationTimeoutMs"), false);
  for (const value of [1, 20000, 60000]) assert.equal(parseEvaluationArguments(["--out", "/tmp/eval", "--observation-timeout-ms", String(value)]).observationTimeoutMs, value);
  for (const value of ["0", "-1", "0.5", "60001", "NaN", "Infinity", "invalid", " "]) {
    assert.throws(() => parseEvaluationArguments(["--out", "/tmp/eval", "--observation-timeout-ms", value]), /invalid_arguments/);
  }
  for (const args of [["--out", "/tmp/eval", "--observation-timeout-ms"],
    ["--out", "/tmp/eval", "--observation-timeout-ms", "30000", "--observation-timeout-ms", "60000"]]) {
    assert.throws(() => parseEvaluationArguments(args), /invalid_arguments/);
  }
  await temporary(async outputDir => {
    const deps = e2eDependencies();
    for (const observationTimeoutMs of [0, -1, 0.5, 60001, NaN, Infinity, "60000", null]) {
      await assert.rejects(runJevEvaluation({ outputDir, seed: 1701, observationTimeoutMs } as any, deps), /invalid_arguments/);
    }
    assert.equal(deps.created.count, 0); assert.equal(deps.calls.length, 0); assert.deepEqual(await readdir(outputDir), []);
  });
});

test("observation factory budget reaches initial and targeted calls and is recorded separately from local processing", async () => {
  for (const observationTimeoutMs of [undefined, 60000]) await temporary(async outputDir => {
    const deps = e2eDependencies(), result = await runJevEvaluation({ outputDir, seed: 1701, localTimeoutMs: 45000,
      ...(observationTimeoutMs === undefined ? {} : { observationTimeoutMs }) }, deps);
    assert.equal(result.status, "passed");
    const observations = deps.calls.filter(c => ["observation_initial", "observation_targeted"].includes(c.phase));
    assert.equal(observations.length, 2);
    assert.ok(observations.every(c => c.timeoutMs === (observationTimeoutMs ?? 20000)));
    assert.ok(deps.calls.filter(c => c.phase === "local_extraction").every(c => c.timeoutMs === 45000));
    const manifest = JSON.parse(await readFile(join(result.directory, "run.private.json"), "utf8"));
    assert.equal(manifest.observationTimeoutMs, observationTimeoutMs); assert.equal(manifest.localTimeoutMs, 45000);
    assert.equal(Object.hasOwn(manifest, "observationTimeoutMs"), observationTimeoutMs !== undefined);
  });
});

test("initial and targeted observation failures retain only closed diagnostic fields in failure and trial records", async () => {
  for (const phase of ["initial", "targeted"] as const) for (const kind of ["timeout", "invalid_json", "unknown", "modified"] as const) await temporary(async outputDir => {
    const deps = e2eDependencies(), create = deps.createComponents;
    deps.createComponents = (shared, componentOptions) => {
      const components = create(shared, componentOptions);
      const failure = async (): Promise<never> => {
        const error = kind === "unknown" ? new Error("PRIVATE_OBSERVATION_MESSAGE") : new ObservationError(kind === "invalid_json" ? "invalid_json" : "timeout");
        Object.assign(error, { message: "PRIVATE_OBSERVATION_MESSAGE", response: "PRIVATE_OBSERVATION_RESPONSE", observationPhase: "PRIVATE_PHASE" });
        if (kind === "unknown" || kind === "modified") Object.assign(error, { code: kind === "unknown" ? "timeout" : "PRIVATE_OBSERVATION_CODE" });
        throw error;
      };
      return { ...components, observer: { ...components.observer, ...(phase === "initial" ? { observeAll: failure } : { reobserve: failure }) } };
    };
    const result = await runJevEvaluation({ outputDir, seed: 1701, observationTimeoutMs: 60000 }, deps);
    assert.equal(result.status, "gate_failed");
    const failures = (await readFile(join(result.directory, "failures.private.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(failures.length, 1);
    const expected = { caseId: script.id, turn: phase === "initial" ? null : 9, code: "observation_failed",
      observationErrorCode: ["unknown", "modified"].includes(kind) ? "unavailable" : kind, observationPhase: phase };
    assert.deepEqual(failures[0], expected);
    const trial = JSON.parse(await readFile(join(result.directory, script.id + ".private.json"), "utf8"));
    assert.deepEqual(trial.failure, expected);
    const gate = JSON.parse(await readFile(join(result.directory, "gate.private.json"), "utf8"));
    assert.deepEqual(gate.failures[0], expected);
    for (const file of await readdir(result.directory)) {
      const text = await readFile(join(result.directory, file), "utf8");
      for (const secret of ["PRIVATE_OBSERVATION_MESSAGE", "PRIVATE_OBSERVATION_RESPONSE", "PRIVATE_OBSERVATION_CODE", "PRIVATE_PHASE"]) assert.ok(!text.includes(secret));
    }
  });
});

test("harness ignores spoofed diagnostics and renormalizes modified typed fields without saving arbitrary strings", async () => {
  const { JevTurnError } = await import("../dialogue-model/runtime/v2/jev-turn.ts");
  for (const typed of [false, true]) await temporary(async outputDir => {
    const deps = e2eDependencies();
    deps.createComponents = () => {
      const error = typed ? new JevTurnError("observation_failed") : new Error("PRIVATE_DIAGNOSTIC_MESSAGE");
      Object.assign(error, { observationErrorCode: typed ? "PRIVATE_DIAGNOSTIC_CODE" : "timeout", observationPhase: "PRIVATE_DIAGNOSTIC_PHASE" });
      throw error;
    };
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    assert.equal(result.status, "gate_failed"); assert.equal(deps.calls.length, 0);
    const failure = JSON.parse((await readFile(join(result.directory, "failures.private.jsonl"), "utf8")).trim());
    assert.deepEqual(failure, { caseId: script.id, turn: null, code: typed ? "observation_failed" : "evaluation_unavailable",
      ...(typed ? { observationErrorCode: "unavailable" } : {}) });
    for (const file of await readdir(result.directory)) assert.ok(!(await readFile(join(result.directory, file), "utf8")).includes("PRIVATE_DIAGNOSTIC_"));
  });
});

test("two-stage rejected action/target labels retain fixed rules without a detail call or alternative", async () => {
  const cases: Array<{ choices: Record<string, string>; rejectionCode: string; error: string }> = [
    { choices: { action: "propose_name", target: "multiple" }, rejectionCode: "name_requires_single_target", error: "invalid_decision" },
    { choices: { action: "agree", target: "none" }, rejectionCode: "name_requires_single_target", error: "invalid_decision" },
    { choices: { target: "none" }, rejectionCode: "detail_target_required", error: "invalid_decision" },
    { choices: { target: "multiple", candidate_1: "exclude", candidate_2: "exclude", candidate_3: "exclude", candidate_4: "exclude", candidate_5: "exclude" },
      rejectionCode: "multiple_requires_candidates", error: "inconsistent_decision" },
  ];
  for (const c of cases) await temporary(async outputDir => {
    const deps = e2eDependencies({ decisionChoices: c.choices });
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    assert.equal(result.status, "gate_failed");
    const attempts = (await readFile(join(result.directory, "attempts.private.jsonl"), "utf8")).trim().split("\n")
      .flatMap(line => JSON.parse(line).decisionAttempts ?? []);
    assert.equal(attempts.length, 1);
    const attempt = attempts[0], questions = deps.http.find(call => call.kind === "decision").payload.questions;
    assert.equal(attempt.succeeded, false); assert.equal(attempt.error, c.error);
    assert.equal(attempt.rejectionCode, c.rejectionCode);
    assert.deepEqual(Object.keys(attempt.choices).sort(), Object.keys(questions).sort());
    assert.equal(attempt.stages.length, 1); assert.equal(attempt.stages[0].stage, "action_target");
    assert.deepEqual(attempt.stages[0].choices, attempt.choices);
    assert.equal(attempt.stages[0].rejectionCode, c.rejectionCode);
    assert.equal(deps.http.filter(call => call.kind === "decision").length, 1);
    for (const [key, label] of Object.entries(c.choices)) assert.equal(attempt.choices[key], label);
    const document = JSON.parse(await readFile(join(result.directory, script.id + ".private.json"), "utf8"));
    assert.equal(document.receipt.completed, false);
    assert.equal(document.receipt.failureCode, c.error === "invalid_decision" ? "invalid_decision" : "decision_failed");
    assert.equal(document.publicTurns.filter((t: any) => t.speaker === "ai").length, 0);
  });
});

test("detail failure keeps both stages and closed first-stage labels without raw errors", async () => {
  for (const detailFault of ["network", "partial", "model"] as const) await temporary(async outputDir => {
    const deps = e2eDependencies({ detailFault });
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    assert.equal(result.status, "gate_failed");
    const attempts = (await readFile(join(result.directory, "attempts.private.jsonl"), "utf8")).trim().split("\n")
      .flatMap(line => JSON.parse(line).decisionAttempts ?? []);
    const attempt = attempts[0]; assert.equal(attempts.length, 1);
    assert.equal(attempt.stages.length, 2); assert.equal(attempt.stages[0].status, "ok");
    assert.equal(attempt.stages[1].status, "error"); assert.deepEqual(attempt.stages[0].choices, attempt.choices);
    assert.deepEqual(attempt.stages[1].choices, {});
    assert.equal(attempt.stages[1].error, detailFault === "network" ? "network_error" : detailFault === "model" ? "model_mismatch" : "invalid_response");
    assert.ok(attempt.stages.every((stage: any) => stage.inputBudget.maxChars === 20000));
    assert.equal(result.gate.inputBudget.calls, 2); assert.equal(result.gate.inputBudget.missingCalls, 0);
    for (const file of await readdir(result.directory)) assert.ok(!(await readFile(join(result.directory, file), "utf8")).includes("PRIVATE_DETAIL_ERROR"));
  });
});

test("private decision attempts discard nonclosed labels, partial answers and unknown rejection text in either stage", async () => {
  for (const stageIndex of [0, 1]) for (const fault of ["label", "partial", "extra_key"]) await temporary(async outputDir => {
    const deps = e2eDependencies({ detailFault: "network" }), create = deps.createComponents;
    deps.createComponents = (shared, options) => {
      const components = create(shared, options), adapter = components.jevDecision as NonNullable<ReturnType<typeof createJevDecisionClient>>;
      let evidence: any = null;
      return { ...components, jevDecision: {
        get lastEvidence() { return structuredClone(evidence); },
        async decide(input, callOptions) {
          try { return await adapter.decide(input, callOptions); }
          finally {
            evidence = adapter.lastEvidence;
            const corrupt = (choices: Record<string, string>) => {
              if (fault === "label") choices[stageIndex ? "feature" : "target"] = "PRIVATE_CHOICE_CANARY";
              else if (fault === "partial") delete choices[stageIndex ? "feature" : "candidate_5"];
              else choices.PRIVATE_CHOICE_KEY = "none";
            };
            if (stageIndex === 0) corrupt(evidence.choices);
            corrupt(evidence.stages[stageIndex].choices);
            evidence.rejectionCode = evidence.stages[stageIndex].rejectionCode = "PRIVATE_REJECTION_CANARY";
          }
        },
      } };
    };
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    assert.equal(result.status, "gate_failed");
    const attempts = (await readFile(join(result.directory, "attempts.private.jsonl"), "utf8")).trim().split("\n")
      .flatMap(line => JSON.parse(line).decisionAttempts ?? []);
    assert.equal(attempts.length, 1); assert.deepEqual(attempts[0].stages[stageIndex].choices, {});
    assert.equal(attempts[0].rejectionCode, null);
    if (stageIndex === 0) assert.deepEqual(attempts[0].choices, {});
    else assert.equal(Object.keys(attempts[0].choices).length, 8);
    for (const file of await readdir(result.directory)) {
      const text = await readFile(join(result.directory, file), "utf8");
      for (const secret of ["PRIVATE_CHOICE_CANARY", "PRIVATE_CHOICE_KEY", "PRIVATE_REJECTION_CANARY"]) assert.ok(!text.includes(secret));
    }
  });
});


test("private stage budgets keep only numeric allowed fields, and malformed omission values are reported", async () => {
  for (const malformed of [false, true]) await temporary(async outputDir => {
    const deps = e2eDependencies({ detailFault: "network" }), create = deps.createComponents;
    deps.createComponents = (shared, options) => {
      const components = create(shared, options), adapter = components.jevDecision as NonNullable<ReturnType<typeof createJevDecisionClient>>;
      let evidence: any = null;
      return { ...components, jevDecision: {
        get lastEvidence() { return structuredClone(evidence); },
        async decide(input, callOptions) {
          try { return await adapter.decide(input, callOptions); }
          finally {
            evidence = adapter.lastEvidence;
            evidence.stages[1].inputBudget.PRIVATE_BUDGET_KEY = "PRIVATE_BUDGET_CANARY";
            evidence.stages[1].inputBudget.omitted.PRIVATE_OMISSION_KEY = "PRIVATE_BUDGET_CANARY";
            if (malformed) evidence.stages[1].inputBudget.omitted.claims = "PRIVATE_BUDGET_CANARY";
          }
        },
      } };
    };
    const result = await runJevEvaluation({ outputDir, seed: 1701 }, deps);
    assert.equal(result.gate.inputBudget.calls, 2); assert.equal(result.gate.inputBudget.missingCalls, malformed ? 1 : 0);
    for (const file of await readdir(result.directory)) {
      const text = await readFile(join(result.directory, file), "utf8");
      for (const secret of ["PRIVATE_BUDGET_KEY", "PRIVATE_BUDGET_CANARY", "PRIVATE_OMISSION_KEY"]) assert.ok(!text.includes(secret));
    }
  });
});
