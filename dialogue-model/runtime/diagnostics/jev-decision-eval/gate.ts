// This audits wiring and declared synthetic expectations, not task accuracy.
import { isDeepStrictEqual } from "node:util";
import { isGroundingModel } from "../../../../workers/research-ai-proxy/src/grounding.ts";
import { findGuardViolations } from "../../v2/generation-guard.ts";
import type { JevDecision, RepairHistoryEntry, DecisionInputBudget } from "../../decision/contract.ts";
import type { ObservationMemo, ObservationIssue, ReobservationResult } from "../../observation/contract.ts";
import type { LocalOwnAnchor, LocalIssueView } from "../../local-grounding/contract.ts";
import type { AuditReceipt } from "../local-grounding-eval/gate.ts";
import { recordAiClaims, verifyLocalUpdate } from "../../local-grounding/verify.ts";
import { previewReferenceUpdate, snapshotReferenceGraph, validateReferenceUpdate } from "../../memory/reference-graph.mjs";
import { prepareMemory } from "../../judgment/memory.mjs";
import type { HumanStep } from "./cases.ts";

export type ObservationReceipt = { turn: number | null; kind: "initial" | "targeted";
  order: number; figureIds: string[]; issue?: ObservationIssue; memo?: ObservationMemo; result?: ReobservationResult; succeeded: boolean };
export type WireReceipt = { turn: number | null; phase: string; imageCount: number; succeeded: boolean };
export type PublishedAct = { action: string; targetSlot: string | null; candidateName: string | null; discriminatingFeature: string | null };
export type TurnReceipt = { turn: number; committed: boolean; traceMatches: boolean; decisions: JevDecision[]; finalAct: PublishedAct | null;
  decisionOrder: number[];
  intervention: string | null; publicText: string | null; local: AuditReceipt; issues: LocalIssueView[];
  ledger: Record<string, { status: string; name: string | null }>; repairHistory: RepairHistoryEntry[]; step: HumanStep };
export type TrialReceipt = { caseId: string; completed: boolean; expectedTurns: number;
  failureCode?: string;
  anchors: LocalOwnAnchor[]; observations: ObservationReceipt[]; wire: WireReceipt[]; turns: TurnReceipt[];
  failedDecisionInputs?: Array<{ turn: number; inputBudget: DecisionInputBudget | null }> };

/** Reproduce Jev's installed operations independently, including ambiguous
 * feature targets. The legacy Luna-judgment auditor keeps its original input. */
export function auditJevLocalTurn(input: Parameters<typeof import("../local-grounding-eval/gate.ts").auditLocalTurn>[0]): AuditReceipt {
  const turn = input.publicTurns.at(-1)!.turn, record = input.record;
  let verified: AuditReceipt["verified"] = [], unverified = 0;
  let pipelineOk = record?.status === "committed" && record.localStatus === "ok";
  try {
    snapshotReferenceGraph(input.before.graph); snapshotReferenceGraph(input.after.graph);
    const previous = input.before.judgments.at(-1);
    const priorAi = previous && input.publicTurns.find(t => t.speaker === "ai" && t.turn > previous.turnIndex && t.turn < turn);
    const target = previous?.jevTurn?.decision?.target;
    const ai = priorAi ? recordAiClaims({ graph: input.before.graph, turn, publicTurns: input.publicTurns,
      priorAct: { ...previous.judgment, turn: priorAi.turn, publishedFallback: previous.generationGuard?.fallback === true,
        ...(target?.kind === "multiple" ? { targetCandidates: [...target.figureIds] } : {}) } }).operations : [];
    let update = prepareMemory(input.before.graph, turn, input.after.judgments.at(-1)?.judgment.reference ?? null, input.publicTurns).update;
    for (const operation of ai) {
      try { update = validateReferenceUpdate(input.before.graph, { ...update, operations: [...update.operations, operation] }, { publicTurns: input.publicTurns }); }
      catch { /* Apply the runtime's graph budget checks before previewing. */ }
    }
    const staged = previewReferenceUpdate(input.before.graph, update, { publicTurns: input.publicTurns });
    const human = verifyLocalUpdate({ graph: staged, turn, publicTurns: input.publicTurns,
      segments: input.segments, verdicts: input.verdicts }).operations;
    const candidates = [...ai, ...human], priorIds = new Set(input.before.graph.records.map((r: any) => r.id));
    for (const installed of input.after.graph.records.filter((r: any) => r.kind === "claim" && !priorIds.has(r.id))) {
      const { turn: insertionTurn, ...operation } = installed;
      if (insertionTurn !== turn || !candidates.some(c => c.id === operation.id && isDeepStrictEqual(c, operation))) unverified++;
      else verified.push(operation);
    }
    const recorded = [...(record?.aiClaims ?? []), ...(record?.claims ?? [])];
    if (!isDeepStrictEqual(recorded, verified) ||
        !isDeepStrictEqual([...(record?.verification.accepted ?? [])].sort(), verified.map(c => c.id).sort())) pipelineOk = false;
  } catch { pipelineOk = false; unverified++; verified = []; }
  const classifier = record?.classifier;
  return { turn, verified, unverified, pipelineOk,
    classifierOk: classifier?.kind === "jev_local_test" && classifier.status === "ok" &&
      Number.isSafeInteger(classifier.callIndex) && classifier.callIndex! > 0 && isGroundingModel(classifier.model, "typesafe/jev-1.14"),
    model: classifier?.model ?? null, ...(input.expected ? { expected: input.expected } : {}) };
}

export const GATE_ITEMS = ["trial_incomplete", "memo_mismatch", "initial_observation_count", "reobservation_mismatch",
  "non_observation_image", "observation_wire_mismatch", "luna_judgment_called", "jev_evidence_invalid", "action_changed",
  "publication_out_of_scope", "unverified_updates", "local_pipeline_incomplete", "script_mismatch", "repair_history_invalid",
  "construal_missing", "partial_agreement_missing", "multiple_candidates_missing", "denial_missing", "repair_progress_missing",
  "repair_stagnation_missing", "reobservation_missing", "catalog_incomplete", "input_budget_unreported", "trace_mismatch"] as const;
export type GateItem = typeof GATE_ITEMS[number];
type InputBudgetReport = { calls: number; omittingCalls: number; missingCalls: number; omitted: DecisionInputBudget["omitted"] };
const emptyBudget = (): InputBudgetReport => ({ calls: 0, omittingCalls: 0, missingCalls: 0, omitted: { publicTurns: 0, claims: 0,
  publicNames: 0, repairHistory: 0, reobservations: 0, observationDetails: 0, observationChars: 0, issueSummaryChars: 0 } });
export type GateResult = { passed: boolean; unmet: GateItem[]; returnedModels: string[]; inputBudget: InputBudgetReport;
  counts: { turns: number; initial: number; targeted: number; requests: number; unverified: number; invalidDecisions: number;
    construal: number; partial: number; multiple: number; denial: number; progress: number; stagnation: number } };

export function projectDecision(decision: JevDecision): PublishedAct {
  return { action: decision.action, targetSlot: decision.target.kind === "single" ? decision.target.figureId : null,
    candidateName: decision.name, discriminatingFeature: decision.feature };
}

const hasExpectedClaims = (turn: TurnReceipt) => (turn.step.expect ?? []).every(e => turn.local.verified.some(c =>
  c.speaker === "human" && c.act === e.act && (e.aspect === undefined || c.aspect === e.aspect) && c.targets.length > 0));
const sameSet = (a: readonly string[], b: readonly string[]) => new Set(a).size === a.length &&
  new Set(b).size === b.length && isDeepStrictEqual([...a].sort(), [...b].sort());

function memoMatches(memo: ObservationMemo | undefined, anchors: readonly LocalOwnAnchor[]): boolean {
  return !!memo && anchors.length === 6 && sameSet(memo.figures.map(f => f.id), anchors.map(a => a.id)) &&
    memo.figures.every(f => isDeepStrictEqual(f.region, anchors.find(a => a.id === f.id)!.bbox) &&
      f.holistic.every(h => h.status === "hypothesis"));
}

/** Every requested case participates, including failures and rejected attempts.
 * A case may exercise a subset of functions; missing functions fail the run. */
export function evaluateTrialGate(trial: TrialReceipt): GateResult {
  const unmet = new Set<GateItem>();
  const initial = trial.observations.filter(o => o.kind === "initial");
  const targeted = trial.observations.filter(o => o.kind === "targeted");
  const decisions = trial.turns.flatMap(t => t.decisions);
  const requests = decisions.filter(d => d.action === "request_observation");
  const counts = { turns: trial.turns.length, initial: initial.length, targeted: targeted.length, requests: requests.length,
    unverified: 0, invalidDecisions: trial.failureCode === "invalid_decision" ? 1 : 0,
    construal: 0, partial: 0, multiple: 0, denial: 0, progress: 0, stagnation: 0 };
  if (!trial.completed || !trial.expectedTurns || trial.turns.length !== trial.expectedTurns || trial.turns.some(t => !t.committed)) unmet.add("trial_incomplete");
  if (initial.length !== 1 || !initial[0]?.succeeded) unmet.add("initial_observation_count");
  if (!memoMatches(initial[0]?.memo, trial.anchors) || !sameSet(initial[0]?.figureIds ?? [], trial.anchors.map(a => a.id))) unmet.add("memo_mismatch");
  const imageCalls = trial.wire.filter(w => w.imageCount > 0);
  if (imageCalls.some(w => !["observation_initial", "observation_targeted"].includes(w.phase))) unmet.add("non_observation_image");
  for (const [kind, phase] of [["initial", "observation_initial"], ["targeted", "observation_targeted"]] as const) {
    const calls = trial.wire.filter(w => w.phase === phase), observations = trial.observations.filter(o => o.kind === kind);
    if (calls.length !== observations.length || calls.some(w => w.imageCount !== 1 || !w.succeeded)) unmet.add("observation_wire_mismatch");
  }
  if (trial.wire.some(w => /judg|decision_luna/iu.test(w.phase))) unmet.add("luna_judgment_called");
  if (requests.length !== targeted.length || targeted.some(o => !o.succeeded)) unmet.add("reobservation_mismatch");
  const models = new Set<string>();
  const inputBudget = emptyBudget();
  const countBudget = (budget: DecisionInputBudget | null | undefined) => {
    inputBudget.calls++;
    if (!budget || budget.maxChars !== 20000 || !Number.isSafeInteger(budget.stateChars) || budget.stateChars < 1 || budget.stateChars > budget.maxChars ||
        !budget.omitted || Object.keys(inputBudget.omitted).some(key => !Number.isSafeInteger(budget.omitted[key as keyof typeof budget.omitted]) || budget.omitted[key as keyof typeof budget.omitted] < 0)) {
      inputBudget.missingCalls++; unmet.add("input_budget_unreported");
    } else {
      if (Object.values(budget.omitted).some(n => n > 0)) inputBudget.omittingCalls++;
      for (const key of Object.keys(inputBudget.omitted) as Array<keyof typeof budget.omitted>) inputBudget.omitted[key] += budget.omitted[key];
    }
  };
  for (const failure of trial.failedDecisionInputs ?? []) countBudget(failure.inputBudget);
  for (const turn of trial.turns) {
    if (!turn.traceMatches) unmet.add("trace_mismatch");
    const reobservations = targeted.filter(o => o.turn === turn.turn);
    const turnRequests = turn.decisions.filter(d => d.action === "request_observation");
    if (reobservations.length > 1 || turn.decisions.length !== reobservations.length + 1 ||
        turnRequests.length !== reobservations.length || turn.decisions.at(-1)?.action === "request_observation") unmet.add("reobservation_mismatch");
    if (turn.decisionOrder.length !== turn.decisions.length || turn.decisionOrder.some((n, i) => !Number.isSafeInteger(n) ||
        n <= (i ? turn.decisionOrder[i - 1] : initial[0]?.order ?? Infinity))) unmet.add("reobservation_mismatch");
    for (let i = 0; i < turnRequests.length; i++) {
      const request = turnRequests[i].observe, observed = reobservations[i];
      if (!request || !observed || !sameSet(request.figureIds, observed.figureIds) || !isDeepStrictEqual(observed.issue,
        { aspect: request.aspect, question: request.question, partnerConstrual: request.partnerConstrual }) ||
        !isDeepStrictEqual(observed.result?.issue, observed.issue) ||
        !sameSet(observed.result?.figures.map(f => f.figureId) ?? [], request.figureIds) ||
        request.figureIds.some(id => !trial.anchors.some(a => a.id === id)) ||
        !(observed.order > turn.decisionOrder[i] && observed.order < turn.decisionOrder[i + 1])) unmet.add("reobservation_mismatch");
    }
    for (const decision of turn.decisions) {
      const evidence = decision.evidence;
      if (typeof evidence?.model === "string") models.add(evidence.model);
      const expectedStages = ["propose_name", "agree", "confirm", "repair", "request_observation"].includes(decision.action) ? 2 : 1;
      const stages = evidence?.stages;
      if (!Array.isArray(stages) || stages.length !== expectedStages) unmet.add("jev_evidence_invalid");
      if (!stages?.length) countBudget(undefined);
      for (const [i, stage] of (stages ?? []).entries()) {
        countBudget(stage.inputBudget);
        if (typeof stage.model === "string") models.add(stage.model);
        if (stage.stage !== (i === 0 ? "action_target" : "detail") || !isGroundingModel(stage.model, "typesafe/jev-1.14") ||
            typeof stage.responseId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(stage.responseId)) unmet.add("jev_evidence_invalid");
      }
      if (!isDeepStrictEqual(evidence?.inputBudget, stages?.[0]?.inputBudget)) unmet.add("input_budget_unreported");
      if (decision.decisionKind !== "jev_local_test" || decision.calibrated !== false ||
          !isGroundingModel(evidence?.model, "typesafe/jev-1.14") ||
          typeof evidence.responseId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(evidence.responseId)) unmet.add("jev_evidence_invalid");
    }
    const selected = turn.decisions.at(-1);
    if (!selected || !isDeepStrictEqual(projectDecision(selected), turn.finalAct) ||
        turn.intervention !== "none_pending_researcher_decision") unmet.add("action_changed");
    if (!turn.publicText || !turn.finalAct || turn.finalAct.action === "request_observation" ||
        findGuardViolations(turn.publicText, turn.finalAct.action as Parameters<typeof findGuardViolations>[1]).length) unmet.add("publication_out_of_scope");
    counts.unverified += turn.local.unverified;
    if (!turn.local.pipelineOk || !turn.local.classifierOk) unmet.add("local_pipeline_incomplete");
    if (!hasExpectedClaims(turn)) unmet.add("script_mismatch");
    const claims = turn.local.verified.filter(c => c.speaker === "human");
    counts.denial += claims.filter(c => c.act === "deny").length;
    const agreedNames = turn.issues.filter(i => i.aspect === "name" && i.nameState === "agreed");
    if (turn.step.check === "construal_without_conflict") {
      const ok = claims.some(c => c.aspect === "construal" && c.act === "construe") &&
        !claims.some(c => ["deny", "name_reject"].includes(c.act)) && turn.finalAct?.action !== "repair" && !agreedNames.length;
      if (ok) counts.construal++; else unmet.add("script_mismatch");
    }
    if (turn.step.check === "multiple_candidates") {
      const candidates = claims.filter(c => c.targets.length > 1).flatMap(c => c.targets);
      const ok = candidates.length > 1 && candidates.every(id => turn.ledger[id]?.status !== "agreed") && !agreedNames.length;
      if (ok) counts.multiple++; else unmet.add("script_mismatch");
    }
    if (turn.step.check === "partial_agreement") {
      const positive = turn.issues.filter(i => i.aspect !== "name" && i.state === "supported" &&
        claims.some(c => c.act === "agree" && i.claimIds.includes(c.id)));
      const negative = turn.issues.filter(i => i.aspect !== "name" && ["denied", "contested"].includes(i.state) &&
        claims.some(c => c.act === "deny" && i.claimIds.includes(c.id)));
      const involved = claims.filter(c => ["agree", "deny"].includes(c.act)).flatMap(c => c.targets);
      const ok = positive.some(p => negative.some(n => p.issueId !== n.issueId)) && !agreedNames.length &&
        involved.every(id => turn.ledger[id]?.status !== "agreed");
      if (ok) counts.partial++; else unmet.add("script_mismatch");
    }
  }
  if (counts.unverified) unmet.add("unverified_updates");
  // Count the final snapshot once; accumulating snapshots repeats prior entries.
  const verifiedClaims = trial.turns.flatMap(t => t.local.verified);
  const ownIds = new Set(trial.anchors.map(a => a.id));
  for (const repair of trial.turns.at(-1)?.repairHistory ?? []) {
    if ([...repair.candidatesBefore, ...repair.candidatesAfter].some(id => !ownIds.has(id)) ||
        !sameSet(repair.candidatesBefore, [...new Set(repair.candidatesBefore)]) ||
        !sameSet(repair.candidatesAfter, [...new Set(repair.candidatesAfter)]) ||
        [...repair.addedClaimIds, ...repair.removedClaimIds].some(id => !verifiedClaims.some(c => c.id === id)) ||
        repair.partnerClaims.some(c => !verifiedClaims.some(v => v.speaker === "human" && c.id === v.id && c.act === v.act &&
          c.proposition === v.proposition && sameSet(c.targets, v.targets)))) unmet.add("repair_history_invalid");
    const information = (c: AuditReceipt["verified"][number]) => c.speaker === "human" && c.targets.length > 0 &&
      ["assert", "agree", "deny", "construe", "name_propose", "name_accept", "name_reject"].includes(c.act) &&
      !["question", "progress"].includes(c.aspect);
    const content = (c: AuditReceipt["verified"][number]) => JSON.stringify([c.aspect, c.act, c.proposition, c.name]);
    const novel = repair.partnerClaims.flatMap(reply => {
      const index = verifiedClaims.findIndex(c => c.id === reply.id);
      const claim = verifiedClaims[index];
      return claim && information(claim) && !verifiedClaims.slice(0, index).some(prior => information(prior) &&
        content(prior) === content(claim) && prior.targets.some(id => claim.targets.includes(id))) ? [claim.id] : [];
    });
    if (!sameSet(repair.addedClaimIds, novel)) unmet.add("repair_history_invalid");
    const narrowed = repair.candidatesAfter.length > 0 && repair.candidatesAfter.length < repair.candidatesBefore.length &&
      repair.candidatesAfter.every(id => repair.candidatesBefore.includes(id));
    const changed = novel.length > 0 || narrowed;
    if ((repair.progress === "changed" && !changed) || (repair.progress === "unchanged" && changed)) unmet.add("repair_history_invalid");
    if (repair.progress === "changed" && changed) counts.progress++;
    if (repair.progress === "unchanged" && !changed) counts.stagnation++;
  }
  return { passed: !unmet.size, unmet: [...unmet], returnedModels: [...models], counts, inputBudget };
}

export function evaluateRunGate(trials: readonly TrialReceipt[], expectedCaseIds: readonly string[]): GateResult & {
  cases: Array<{ caseId: string } & GateResult>; caseIds: string[];
} {
  const cases = trials.map(t => ({ caseId: t.caseId, ...evaluateTrialGate(t) }));
  const unmet = new Set<GateItem>(cases.flatMap(c => c.unmet));
  if (!expectedCaseIds.length || !sameSet(trials.map(t => t.caseId), expectedCaseIds)) unmet.add("catalog_incomplete");
  const counts = { turns: 0, initial: 0, targeted: 0, requests: 0, unverified: 0, invalidDecisions: 0, construal: 0, partial: 0, multiple: 0,
    denial: 0, progress: 0, stagnation: 0 };
  const inputBudget = emptyBudget();
  for (const c of cases) for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += c.counts[key];
  for (const c of cases) {
    inputBudget.calls += c.inputBudget.calls; inputBudget.omittingCalls += c.inputBudget.omittingCalls; inputBudget.missingCalls += c.inputBudget.missingCalls;
    for (const key of Object.keys(inputBudget.omitted) as Array<keyof typeof inputBudget.omitted>) inputBudget.omitted[key] += c.inputBudget.omitted[key];
  }
  for (const [key, code] of [["construal", "construal_missing"], ["partial", "partial_agreement_missing"], ["multiple", "multiple_candidates_missing"],
    ["denial", "denial_missing"], ["progress", "repair_progress_missing"], ["stagnation", "repair_stagnation_missing"],
    ["targeted", "reobservation_missing"]] as const) if (!counts[key]) unmet.add(code);
  return { passed: !unmet.size, unmet: [...unmet], returnedModels: [...new Set(cases.flatMap(c => c.returnedModels))], counts, inputBudget,
    cases, caseIds: trials.map(t => t.caseId) };
}
