import { assertion, check, combine, equal, list, missing, omit, profileHash, row, rows } from "./core.ts";
import type { Check, Records, Row } from "./core.ts";
import { cacheChecks, publicPrivacy } from "./fairness.ts";
import { ledger } from "./ledger.ts";

export type CoverageClass = "live_demonstrated" | "partial_demonstrated" | "conservative_reject" | "not_observed" | "not_reached" | "wiring_failed";
export type Coverage = { trialOrder: unknown; turn: unknown; path: string; classification: CoverageClass; reason: string;
  qualification: "live" | "mock_only"; acceptedCandidates?: number };
export const committedTrace = (turn: Row): Row => rows(turn.trace).find(t => t.status === "committed") ?? {};
function stageError(trace: Row): boolean {
  return ["error", "aborted"].includes(String(trace.status)) || row(row(trace.aiPublic).pending).status === "failed" ||
    Object.values(row(row(trace.aiPublic).stages)).some(s => ["error", "timeout"].includes(String(row(s).status)));
}
export function primaryFailure(trial: Row): boolean {
  return !!trial.failure || rows(trial.calls).some(c => c.status === "error") || rows(trial.attempts).some(stageError) ||
    rows(trial.turns).some(t => rows(t.trace).some(stageError));
}

export function coverage(records: Records): { cells: Coverage[]; checks: Check[] } {
  const cells: Coverage[] = [], checks: Check[] = [];
  for (const trial of records.trials) {
    const turns = rows(trial.turns), qual = records.run?.execution === "live" ? "live" : "mock_only";
    const add = (turn: unknown, path: string, classification: CoverageClass, reason: string, acceptedCandidates?: number) => {
      cells.push({ trialOrder: trial.order, turn, path, classification, reason, qualification: qual,
        ...(acceptedCandidates === undefined ? {} : { acceptedCandidates }) });
    };
    for (const [i, turn] of turns.entries()) {
      const trace = committedTrace(turn), pending = row(row(trace.aiPublic).pending), stages = row(row(trace.aiPublic).stages);
      const next = turns[i + 1], nextTrace = next ? committedTrace(next) : {}, app = row(row(nextTrace.aiPublic).application);
      const candidates = rows(pending.candidates), primary = stageError(trace);
      if (primary) add(turn.turn, "aiPublic", "wiring_failed", "primary_stage_error_even_with_failed_pending");
      else if (!Object.keys(pending).length) add(turn.turn, "aiPublic", "not_reached", "pending_record_missing");
      else if (!candidates.length) add(turn.turn, "aiPublic", "not_observed", pending.status === "skipped_fallback" ? "fallback_not_extracted" : "no_validated_candidates");
      else if (!next) add(turn.turn, "aiPublic", "not_reached", "final_pending_unapplied");
      else {
        const accepted = rows(app.claims).filter(c => candidates.some(p => p.candidateKey === c.candidateKey) &&
          rows(row(row(next.state).graph).records).some(r => r.id === c.id && r.speaker === "ai" && r.sourceTurn === pending.aiSeq));
        const allStages = ["ai_extraction", "ai_function", "ai_support"].every(name => row(stages[name]).status === "ok" &&
          rows(trial.calls).some(c => c.turn === turn.turn && c.phase === name && c.status === "ok" && list(c.sendIds).length > 0 && c.model === c.requestedModel));
        if (allStages && accepted.length && trace.status === "committed" && app.aiSeq === pending.aiSeq) {
          add(turn.turn, "aiPublic", accepted.length < candidates.length || pending.status === "partial" || app.status === "partial" ? "partial_demonstrated" : "live_demonstrated",
            "committed_candidates_present_in_next_graph", accepted.length);
        } else if (!Object.keys(app).length || app.aiSeq !== pending.aiSeq) add(turn.turn, "aiPublic", "wiring_failed", "next_turn_application_contract_missing");
        else if (["not_applied", "partial"].includes(String(app.status)) && list(app.reasons).length) {
          const originTape = row(rows(trial.replay).find(r => row(list(row(r.tape).events).at(-1)).seq === turn.turn)?.tape);
          const nextTape = row(rows(trial.replay).find(r => row(list(row(r.tape).events).at(-1)).seq === next.turn)?.tape);
          const oldGraph = rows(row(row(originTape.state).graph).records), nextGraph = rows(row(row(nextTape.state).graph).records);
          const window = rows(nextTape.events).slice(-32);
          const soundCandidate = candidates.every(c => typeof c.quote === "string" && typeof trace.publicSpeech === "string" &&
            trace.publicSpeech.includes(c.quote) && c.sourceTurn === pending.aiSeq);
          const pruned = list(app.reasons).includes("prior_pruned") && candidates.some(c => c.respondsTo &&
            oldGraph.some(r => r.id === c.respondsTo && r.kind === "claim") && !nextGraph.some(r => r.id === c.respondsTo));
          const outOfWindow = list(app.reasons).includes("source_out_of_window") && Array.isArray(nextTape.events) &&
            !window.some(e => e.seq === pending.aiSeq && e.speaker === "ai");
          const proven = allStages && soundCandidate && (pruned || outOfWindow);
          add(turn.turn, "aiPublic", proven ? "conservative_reject" : "not_reached",
            proven ? "independent_prior_pruning_or_public_window_contract" : "conservative_rejection_contract_proof_missing");
        } else add(turn.turn, "aiPublic", "wiring_failed", "candidate_application_contract_mismatch");
      }

      const graph = rows(row(row(turn.state).graph).records), current = graph.filter(r => r.kind === "claim" && r.speaker === "human" && r.turn === turn.turn && r.respondsTo);
      const local = row(trace.local);
      if (local.localStatus === "error" || local.status === "error" && trace.status !== "committed") add(turn.turn, "humanResponseLinks", "wiring_failed", "human_local_primary_error");
      else if (current.length && current.every(c => graph.some(r => r.kind === "claim" && r.speaker === "ai" && r.id === c.respondsTo && Number(r.sourceTurn ?? r.turn) < Number(turn.turn))))
        add(turn.turn, "humanResponseLinks", "live_demonstrated", "accepted_existing_prior_ai_claim_wiring_only");
      else if (current.length) add(turn.turn, "humanResponseLinks", "wiring_failed", "accepted_response_target_contract_missing");
      else add(turn.turn, "humanResponseLinks", "not_observed", graph.some(r => r.kind === "claim" && r.speaker === "ai") ? "no_accepted_response_act" : "antecedent_claim_missing");

      const action = row(trace.finalAction).action;
      if (!["repair", "confirm", "revisit"].includes(String(action))) add(turn.turn, "repair", "not_observed", "repair_action_unselected");
      else if (!next) add(turn.turn, "repair", "not_reached", "next_human_turn_not_reached");
      else {
        const before = rows(row(turn.state).repairHistory).find(r => r.turn === turn.turn), after = rows(row(next.state).repairHistory).find(r => r.turn === turn.turn);
        const updated = before && after && ["progress", "partnerClaims", "candidatesAfter", "addedClaimIds", "removedClaimIds", "missingReasons", "humanRejections"]
          .some(key => Object.hasOwn(after, key) && (!Object.hasOwn(before, key) || !equal(before[key], after[key]))) &&
          ["changed", "unchanged", "unknown"].includes(String(after.progress));
        const explicit = rows(records.evidence?.repairProgress).some(e => e.trialOrder === trial.order && e.chosenAt === turn.turn &&
          e.evaluatedAt === next.turn && e.result === after?.progress);
        add(turn.turn, "repair", updated || before && after && explicit ? "live_demonstrated" : "not_reached",
          updated || explicit ? "actual_next_turn_progress_recorded" : "initial_unknown_is_not_evaluation_evidence");
      }

      const decisions = rows(trace.decisions), requested = decisions.some(d => d.action === "request_observation");
      const observationCalls = rows(trial.calls).filter(c => c.turn === turn.turn && c.phase === "observation_targeted");
      if (observationCalls.some(c => c.status === "error" || c.model !== c.requestedModel)) add(turn.turn, "reobservation", "wiring_failed", "observation_primary_error_or_model_mismatch");
      else if (!requested) add(turn.turn, "reobservation", "not_observed", "observation_unselected");
      else {
        const results = rows(trace.reobservations).map(r => row(r.result));
        const merged = results.length > 0 && results.every(r => rows(r.figures).length > 0 && rows(r.figures).every(f =>
          rows(row(row(turn.state).observationMemo).figures).some(m => m.id === f.figureId && rows(m.reobservations).some(entry =>
            equal(omit(entry, ["observedAt", "issue"]), f) && equal(entry.issue, r.issue) && entry.observedAt === r.observedAt))));
        const followup = decisions.some((d, j) => j > 0 && decisions[j - 1].action === "request_observation" && d.action !== "request_observation");
        add(turn.turn, "reobservation", merged && followup && observationCalls.length > 0 && observationCalls.every(c => c.status === "ok") ? "live_demonstrated" : "not_reached",
          merged && followup ? "validated_merged_and_redecided" : "observation_merge_or_followup_unproven");
      }
      // Neither ledger.agreed nor keywords prove public proposal/acceptance semantics.
      add(turn.turn, "naming", "not_reached", "public_agreement_requires_independent_blind_review");
    }
    // Keep failed, uncommitted attempts visible rather than losing them with turns[].
    for (const attempt of rows(trial.attempts).filter(stageError)) {
      if (!turns.some(t => t.turn === attempt.turnIndex && rows(t.trace).some(stageError))) add(attempt.turnIndex, "attempt", "wiring_failed", "uncommitted_primary_failure");
    }
  }
  cells.forEach((c, i) => checks.push(check(`coverage.${i}`, c.classification === "wiring_failed" ? "mismatch" :
    ["not_observed", "not_reached"].includes(c.classification) ? "not_reached" : "pass", c.reason,
    { classification: c.classification, qualification: c.qualification, trialOrder: c.trialOrder, turn: c.turn, path: c.path })));
  return { cells, checks };
}

export function gates(records: Records, independent: Check[]): Check[] {
  const smoke = records.trials.filter(t => t.stage === "smoke"), output: Check[] = [];
  if (!smoke.length) return [missing("gate.G1"), missing("gate.G2"), missing("gate.G3"), missing("gate.G4")];
  for (const trial of smoke) {
    const suffix = smoke.length === 1 ? "" : `.${trial.order}`;
    const scoped: Records = { ...records, trials: [trial], summary: { ...records.summary, budget: trial.budget },
      packets: (records.packets ?? []).filter(p => p.name.startsWith(`public-${trial.order}-`)),
      ...(records.evidence ? { evidence: { ...records.evidence, cache: rows(records.evidence.cache).filter(r => r.trialOrder === null || r.trialOrder === trial.order) } } : {}) };
    const g1 = combine(`gate.G1${suffix}`, cacheChecks(scoped), "warmup_trial_cache_evidence");
    const imageCheck = assertion("smoke.images", rows(trial.calls).every(c => c.imageCount === 0 || c.phase === "observation_targeted"), "smoke_images_only_observation");
    const turns = rows(trial.turns);
    const success = turns.some(turn => {
      const trace = committedTrace(turn), calls = rows(trial.calls).filter(c => c.turn === turn.turn);
      const good = (phase: string) => calls.some(c => c.phase === phase) && calls.filter(c => c.phase === phase).every(c => c.status === "ok" &&
        typeof c.model === "string" && c.model === c.requestedModel && list(c.sendIds).length > 0);
      const hr = row(trace.humanReferent), decisions = rows(trace.decisions);
      return trace.status === "committed" && typeof trace.publicSpeech === "string" && trace.publicSpeech === turn.publicText &&
        good("human_referent") && good("decision") && ["ok", "unknown"].includes(String(hr.status)) &&
        hr.model === calls.find(c => c.phase === "human_referent")?.requestedModel &&
        decisions.length > 0 && decisions.every(d => d.decisionKind === "jev_local_test" && rows(row(d.evidence).stages).length > 0);
    });
    let g2 = primaryFailure(trial) ? check(`gate.G2${suffix}`, "mismatch", "stage_one_primary_error_blocks_transition") :
      imageCheck.status === "mismatch" ? check(`gate.G2${suffix}`, "mismatch", "image_boundary_failed") :
      !turns.length ? missing(`gate.G2${suffix}`, "smoke_turns_not_reached") : assertion(`gate.G2${suffix}`, success, "one_turn_both_jev_stages_response_model_validation_public_commit");
    const rawValidation = independent.filter(c => c.id.startsWith(`validation.jev.${trial.order}.`));
    g2 = combine(g2.id, [g2, ...(rawValidation.length ? rawValidation : [missing("gate.raw_validation")])], g2.reason);
    const required = ["run.private.json", "summary.private.json", "warmup.private.json", `trial-${trial.order}.private.json`];
    const storage = records.storage;
    const storageCheck = !storage ? missing("storage.permissions", "filesystem_metadata_not_supplied") : assertion("storage.permissions",
      required.every(name => storage.some(s => s.name === name && s.external && s.regular && s.mode === 0o600)) &&
      storage.every(s => s.external && s.regular && s.mode === 0o600), "external_private_regular_record_files");
    const packets = records.packets;
    const packetCheck = !packets ? missing("storage.packets") : assertion("storage.packets", turns.length > 0 && turns.every(t =>
      [t.turn, Number(t.turn) + 1].every(seq => packets.some(p => p.name === `public-${trial.order}-${seq}.packet.json` &&
        Array.isArray(p.value.prefix) && p.value.sha256 !== undefined))), "public_packets_present");
    const stageModels = assertion("smoke.models", [...rows(records.warmup?.calls), ...rows(trial.calls)].every(c => c.status !== "ok" ||
      typeof c.model === "string" && c.model === c.requestedModel), "smoke_requested_returned_models");
    const stageProfile = trial.profile ? assertion("smoke.profile", profileHash(row(trial.profile)) === trial.profileSha256 &&
      trial.profileSha256 === records.run?.profileSha256, "effective_smoke_profile_hash") : missing("smoke.profile");
    const stageLedger = trial.budget ? ledger(scoped).checks.filter(c => c.id.startsWith("ledger.total.") || c.id === "ledger.field_types") : [missing("smoke.budget", "stage_one_budget_snapshot_missing")];
    const g3 = combine(`gate.G3${suffix}`, [storageCheck, packetCheck, stageModels, stageProfile, ...stageLedger,
      independent.find(c => c.id === "identity.manifest") ?? missing("identity.manifest")], "persisted_manifest_profile_models_billing_and_permissions");
    const privacy = publicPrivacy(scoped);
    const jevUnknown = rows(row(trial.budget).sends).some(s => s.provider === "jev" && s.costUsd === null);
    const g4 = combine(`gate.G4${suffix}`, [privacy, trial.budget ? assertion("gate.jev_known", !jevUnknown, "no_unknown_jev_billing_at_stage_one_snapshot") :
      missing("gate.jev_known", "stage_one_budget_snapshot_missing")], "public_leakage_and_known_jev_cost");
    const computed = [g1, g2, g3, g4]; output.push(...computed);
    for (const [i, g] of computed.entries()) {
      const claim = row(row(trial.gates)[`G${i + 1}`]).passed;
      if (typeof claim !== "boolean") output.push(missing(`gate.claim.G${i + 1}${suffix}`));
      else if (["not_reached", "not_comparable"].includes(g.status)) output.push(check(`gate.claim.G${i + 1}${suffix}`, g.status, "claimed_gate_not_independently_established"));
      else output.push(assertion(`gate.claim.G${i + 1}${suffix}`, claim === (g.status === "pass"), "claimed_gate_matches_recomputation"));
    }
    const progressed = records.trials.some(t => t.stage === "main");
    output.push(!progressed ? missing("gate.progression", "stage_two_not_entered") : combine("gate.progression", computed, "all_smoke_gates_required_before_main"));
  }
  return output;
}
