// Technical observations only. No inference of public agreement or meaning.
import type { Trial, SaveAudit } from "./live.ts";
import type { CallReceipt } from "./audit.ts";
import type { HttpReceipt } from "./luna-wire.ts";
import type { ObservationCacheAudit } from "../../observation/cache.ts";
import type { ObservationInput } from "../../observation/contract.ts";
import { parseAiExtraction } from "../../local-grounding/extract-ai.ts";
import { buildJevAiFunctionPayload, parseJevAiFunctions, buildJevAiSupportPayload, parseJevAiSupport } from "../../local-grounding/jev-ai-public.ts";
import { verifyAiPublicUpdate } from "../../local-grounding/verify-ai.ts";
import { priorClaimViews } from "../../local-grounding/derive.ts";
import { REFERENCE_LIMITS } from "../../memory/reference-graph.mjs";
import { researchHash } from "../../v2/research-profile.ts";
export function stageGates(trial: Trial, context: { warmAudit: ObservationCacheAudit | null; warmCalls: CallReceipt[]; warmHttp: HttpReceipt[];
  measuredHttp: boolean; cacheStable: boolean; privacyRejected: boolean; jevUnknown: boolean;
  saving: SaveAudit;
  execution: "mock" | "live" }) {
  const posts = context.warmHttp.filter(c => c.kind === "completion_post").length;
  const perTurn = [...new Set([...trial.turns.map(t => t.turn), ...trial.calls.flatMap(c => c.turn === null ? [] : [c.turn])])].sort((a, b) => a - b).map(turn => {
    const t = trial.turns.find(t => t.turn === turn), trace = t?.trace.find(r => r.status === "committed") ?? trial.attempts.find(r => r.turnIndex === turn);
    const calls = trial.calls.filter(c => c.turn === turn);
    const referent = calls.filter(c => c.phase === "human_referent"), decisions = calls.filter(c => c.phase === "decision");
    return { turn, referent: { sent: referent.length === 1, response: referent.every(c => c.status === "ok"),
      modelMatch: referent.every(c => c.model !== null), validation: trace?.humanReferent?.status === "ok" },
      decision: { sent: decisions.length >= 1, response: decisions.every(c => c.status === "ok"), modelMatch: decisions.every(c => c.model !== null),
        validation: !!trace?.decisions.length && trace.decisions.every(d => d.decisionKind === "jev_local_test" && !!d.evidence.stages?.length) },
      committed: trace?.status === "committed"&&(trial.profile.id!=='research_trial_profile_v3'||trace.schemaVersion==='jev_turn_trace_v2'&&!!trace.executed&&!!trace.intervention&&typeof trace.intervention==='object'&&trace.finalAction?.action===trace.executed.action), imagesOnlyInObservation: calls.every(c => c.imageCount === 0 || c.phase === "observation_targeted") };
  });
  const G1 = { passed: context.warmAudit?.status === "MISS" && context.warmCalls.length === 1 &&
      (context.execution === "mock" && !context.measuredHttp || posts >= 1 && posts <= 3) && trial.cache?.status === "HIT" &&
      !trial.calls.some(c => c.phase === "observation_initial") && !!trial.identity.memo && context.cacheStable,
    warmup: context.warmAudit, completeCount: context.warmCalls.length, actualPosts: context.measuredHttp ? posts : null,
    trialInitialPosts: trial.http.filter(h => h.phase === "observation_initial").length, cacheStable: context.cacheStable };
  const G2 = { passed: perTurn.some(t => t.committed && t.imagesOnlyInObservation && Object.values(t.referent).every(Boolean) && Object.values(t.decision).every(Boolean)), perTurn };
  const G3 = { passed: (trial.profile.id!=='research_trial_profile_v3'||trial.replay.length>0&&trial.replay.every(r=>r.result.status==='same_material_intervention_verified'))&&!!trial.profileSha256 && trial.cache !== null && context.saving.status === "auditable" && context.saving.requiredWritesComplete,
    evidencePresent: context.saving.evidencePresent, saving: structuredClone(context.saving), judgment: "trial_end_before_next_trial",
    storage: "repo_external_directory_0700_records_0600", profileSha256: trial.profileSha256 };
  const G4 = { passed: !context.privacyRejected && !context.jevUnknown, privacyRejected: context.privacyRejected, unknownJevBilling: context.jevUnknown };
  return { G1, G2, G3, G4, passed: G1.passed && G2.passed && G3.passed && G4.passed && !trial.failure,
    conditionalPaths: "unselected_is_not_observed; primary_error_blocks_stage_transition" };
}
export function wiringCoverage(trial: Trial, execution: "mock" | "live", own: ObservationInput) {
  const state = trial.turns.at(-1)?.state;
  return {
    qualification: execution === "live" ? "technical_paths_only_independent_semantic_review_required" : "mock_only_no_live_demonstration",
    aiPublic: trial.turns.map(turn => {
      const trace = turn.trace.find(t => t.status === "committed"), p = trace?.aiPublic?.pending;
      const log = state?.aiPublic?.log.find(l => l.aiSeq === p?.aiSeq);
      const next = trial.turns.find(t => t.turn > turn.turn), application = next?.trace.find(t => t.status === "committed")?.aiPublic?.application;
      const primaryError = Object.values(trace?.aiPublic?.stages ?? {}).some(s => s.status === "error");
      const savedTape = trial.replay.find(r => r.tape.events.at(-1)?.seq === turn.turn)?.tape;
      const tape=savedTape&&'schemaVersion' in savedTape?{...savedTape,luna:[...savedTape.common.luna,...(savedTape.tails[savedTape.recorded.label]?.luna??[])],jev:[...savedTape.common.jev,...(savedTape.tails[savedTape.recorded.label]?.jev??[])],expectedRequests:savedTape.recorded.expectedRequests}:savedTape;
      let candidateValidation: unknown = { status: primaryError ? "stage_failed" : "not_reached" };
      // Reproduce the already approved deterministic verifier, without another
      // semantic model or fabricated attribution of source-level reasons.
      if (tape && p && ["ready", "partial", "empty"].includes(p.status)) try {
        const publicTurns = tape.events.map(e => ({ turn: e.seq, speaker: e.speaker, text: e.text })).slice(-REFERENCE_LIMITS.publicTurns);
        const input = { turn: turn.turn, aiSeq: p.aiSeq, candidateText: trace!.publicSpeech!, publicTurns,
          ownSlots: own.ownAnchors.map(a => a.id), ownAnchors: own.ownAnchors, observations: turn.state.observationMemo!, issueSummary: "" };
        const raw = tape.luna.find(r => r.phase === "ai_extraction")?.response.text;
        const diagnostics: Parameters<typeof parseAiExtraction>[2] = { rejected: [] };
        const segments = parseAiExtraction(raw, input, diagnostics), material = { ...input, segments, priorClaims: priorClaimViews(turn.state.graph, { limit: REFERENCE_LIMITS.records }) };
        const phases = tape.expectedRequests.filter(r => r.provider === "jev").map(r => r.phase);
        const verdicts = segments.length ? parseJevAiFunctions(tape.jev[phases.indexOf("ai_function")]?.answers, buildJevAiFunctionPayload(material)) : [];
        const checked = segments.filter(s => verdicts.some(v => v.segmentId === s.segmentId && !["acknowledge", "unknown"].includes(v.act)));
        const supports = checked.length ? parseJevAiSupport(tape.jev[phases.indexOf("ai_support")]?.answers,
          buildJevAiSupportPayload({ ...material, segments: checked, verdicts })) : [];
        const verified = verifyAiPublicUpdate({ graph: turn.state.graph, aiSeq: p.aiSeq, candidateText: input.candidateText, publicTurns, segments, verdicts, supports });
        candidateValidation = { status: "reproduced", matchesRecordedCandidates: researchHash(verified.candidates) === researchHash(p.candidates),
          extractionDiagnostics: diagnostics, acceptedKeys: verified.candidates.map(c => c.candidateKey),
          rejected: verified.rejected.map(r => ({ ...r, candidateKey: `${p.aiSeq}#${Number(r.segmentId.split("_")[1])}` })) };
      } catch { candidateValidation = { status: "verification_reproduction_failed" }; }
      return { aiSeq: p?.aiSeq ?? null, publicOpportunity: "independent_review_pending", pendingStatus: p?.status ?? "not_reached",
        stages: trace?.aiPublic?.stages ?? null, committed: !!trace, nextTurn: next ? "executed" : "not_reached",
        status: primaryError ? "primary_stage_error" : log?.status ?? (p?.candidates.length ? "final_pending_unapplied" : "no_validated_candidates"),
        reasons: log?.reasons ?? p?.reasons ?? [], candidateValidation,
        // Runtime source-level rejection reasons are not fabricated into a more
        // specific per-candidate causal explanation.
        candidates: (p?.candidates ?? []).map(c => { const id = application?.claims.find(a => a.candidateKey === c.candidateKey)?.id ?? null;
          return { candidateKey: c.candidateKey, graphId: id, applied: id !== null && !!next?.state.graph.records.some((r: { id: string }) => r.id === id),
            sourceReasons: log?.reasons ?? [], reasonAttribution: "source_level_only" }; }),
        application: application ?? null, possibleContractRejectionReasons: (log?.reasons ?? []).filter(r => ["op_limit_pre", "prior_pruned", "source_out_of_window", "structural_rejection"].includes(r)),
        rejectionQualification: "contract_rejection_recorded_not_automatic_proof_of_correct_implementation" };
    }),
    humanResponseLinks: trial.turns.map(t => ({ turn: t.turn, committed: true,
      accepted: t.state.graph.records.filter((r: any) => r.kind === "claim" && r.speaker === "human" && r.turn === t.turn && r.respondsTo)
        .map((r: any) => ({ id: r.id, respondsTo: r.respondsTo })),
      unobservedReason: "if_empty_no_accepted_response_link; no_semantic_inference", verification: t.trace[0]?.local?.verification ?? null })),
    repair: trial.turns.flatMap(t => t.trace.filter(r => r.finalAction && ["repair", "confirm", "revisit"].includes(r.finalAction.action)).map(r => {
      const next = trial.turns.find(x => x.turn > t.turn), entry = next?.state.repairHistory.find(x => x.turn === t.turn);
      return { chosenAt: t.turn, action: r.finalAction!.action, historyEntry: t.state.repairHistory.find(x => x.turn === t.turn) ?? null,
        progressAt: next?.turn ?? null, progress: next ? entry?.progress ?? "output_missing" : "not_reached", missingReasons: (entry as { missingReasons?: string[] } | undefined)?.missingReasons ?? [] };
    })),
    reobservation: trial.turns.map(t => ({ turn: t.turn, requested: t.trace.flatMap(r => r.decisions).some(d => d.action === "request_observation"),
      wire: trial.calls.filter(c => c.turn === t.turn && c.phase === "observation_targeted"),
      validatedResults: t.trace.flatMap(r => r.reobservations), followupDecisions: t.trace.flatMap(r => r.decisions).slice(1) })),
    naming: { publicProposalAndAcceptance: "independent_blind_review_required", ledger: state?.ledger ?? null },
  };
}
