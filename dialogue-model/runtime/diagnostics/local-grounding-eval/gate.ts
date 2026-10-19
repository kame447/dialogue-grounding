// Structural validity, not a measurement of interpretation accuracy or task success.
import { isDeepStrictEqual } from "node:util";
import { isGroundingModel } from "../../../../workers/research-ai-proxy/src/grounding.ts";
import { recordAiClaims, verifyLocalUpdate } from "../../local-grounding/verify.ts";
import { previewReferenceUpdate, snapshotReferenceGraph, validateReferenceUpdate } from "../../memory/reference-graph.mjs";
import { prepareMemory } from "../../judgment/memory.mjs";
import type { LocalSegmentProposal, LocalFunctionVerdict, PublicTurn } from "../../local-grounding/contract.ts";
import type { LocalGroundingResearchRecord } from "../../v2/local-grounding-turn.ts";
import type { RequiredAct } from "./live-cases.ts";

type Claim = ReturnType<typeof recordAiClaims>["operations"][number];
export type AuditReceipt = { turn: number; verified: Claim[]; unverified: number; classifierOk: boolean;
  pipelineOk: boolean; model: string | null; expected?: RequiredAct };
export const GATE_ITEMS = ["ai_claims_missing", "targeted_claims_missing", "agree_missing", "deny_missing", "name_accept_missing",
  "script_mismatch", "unverified_updates", "classifier_evidence_invalid", "local_pipeline_incomplete"] as const;
export type GateItem = typeof GATE_ITEMS[number];
export type GateResult = { passed: boolean; unmet: GateItem[]; counts: { aiClaims: number; targetedClaims: number;
  agree: number; deny: number; name_accept: number; unverified: number }; returnedModels: string[] };

/** Independently reproduce the program's accepted local operations. A staged
 * callback alone cannot prove installation, and a graph record alone cannot
 * prove it passed the verifier in this attempt. */
export function auditLocalTurn(input: {
  before: any; after: any; publicTurns: PublicTurn[]; record?: LocalGroundingResearchRecord;
  segments: LocalSegmentProposal[]; verdicts: LocalFunctionVerdict[]; expected?: RequiredAct;
}): AuditReceipt {
  const turn = input.publicTurns.at(-1)!.turn, record = input.record;
  let verified: Claim[] = [], unverified = 0;
  let pipelineOk = record?.status === "committed" && record.localStatus === "ok";
  try {
    snapshotReferenceGraph(input.before.graph); snapshotReferenceGraph(input.after.graph);
    const previous = input.before.judgments.at(-1);
    const priorAi = previous && input.publicTurns.find(t => t.speaker === "ai" && t.turn > previous.turnIndex && t.turn < turn);
    const ai = priorAi ? recordAiClaims({ graph: input.before.graph, turn, publicTurns: input.publicTurns,
      priorAct: { ...previous.judgment, turn: priorAi.turn, publishedFallback: previous.generationGuard?.fallback === true } }).operations : [];
    let update = prepareMemory(input.before.graph, turn, input.after.judgments.at(-1)?.judgment.reference ?? null, input.publicTurns).update;
    for (const operation of ai) {
      try { update = validateReferenceUpdate(input.before.graph, { ...update, operations: [...update.operations, operation] }, { publicTurns: input.publicTurns }); }
      catch { /* The runtime also rejects operations beyond graph budgets. */ }
    }
    const staged = previewReferenceUpdate(input.before.graph, update, { publicTurns: input.publicTurns });
    const human = verifyLocalUpdate({ graph: staged, turn, publicTurns: input.publicTurns,
      segments: input.segments, verdicts: input.verdicts }).operations;
    const candidates = [...ai, ...human];
    const priorIds = new Set(input.before.graph.records.map((r: any) => r.id));
    const added = input.after.graph.records.filter((r: any) => r.kind === "claim" && !priorIds.has(r.id));
    for (const installed of added) {
      const { turn: _turn, ...operation } = installed;
      const candidate = candidates.find(c => c.id === operation.id);
      if (_turn !== turn || !candidate || !isDeepStrictEqual(candidate, operation)) unverified++;
      else verified.push(candidate);
    }
    // Research callbacks are checked against the graph as well as settled IDs.
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

export function evaluateValidityGate(receipts: readonly AuditReceipt[]): GateResult {
  const claims = receipts.flatMap(r => r.verified);
  const count = (act: string) => claims.filter(c => c.speaker === "human" && c.act === act && c.targets.length > 0 && c.respondsTo !== null).length;
  const counts = { aiClaims: claims.filter(c => c.speaker === "ai").length, targetedClaims: claims.filter(c => c.targets.length > 0).length,
    agree: count("agree"), deny: count("deny"), name_accept: count("name_accept"), unverified: receipts.reduce((n, r) => n + r.unverified, 0) };
  const unmet: GateItem[] = [];
  if (!counts.aiClaims) unmet.push("ai_claims_missing");
  if (!counts.targetedClaims) unmet.push("targeted_claims_missing");
  for (const act of ["agree", "deny", "name_accept"] as const) if (!counts[act]) unmet.push(`${act}_missing`);
  if (receipts.some(r => r.expected && !r.verified.some(c => c.speaker === "human" && c.act === r.expected && c.targets.length > 0 &&
      (!["agree", "deny", "name_accept"].includes(r.expected!) || c.respondsTo !== null)))) unmet.push("script_mismatch");
  if (counts.unverified) unmet.push("unverified_updates");
  if (!receipts.length || receipts.some(r => !r.classifierOk)) unmet.push("classifier_evidence_invalid");
  if (!receipts.length || receipts.some(r => !r.pipelineOk)) unmet.push("local_pipeline_incomplete");
  return { passed: unmet.length === 0, unmet, counts, returnedModels: [...new Set(receipts.map(r => r.model).filter((m): m is string => m !== null))] };
}
