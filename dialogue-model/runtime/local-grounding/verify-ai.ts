// Slice A: AI-only verifier and deterministic deferred insertion. Human rules stay unchanged.
import { LOCAL_ASPECTS } from "./contract.ts";
import type { AiPublicCandidate, AiPublicPending, AiPublicState, AiPublicApplication, LocalClaimView,
  LocalSegmentProposal, LocalFunctionVerdict, AiSupport, PublicTurn, AiPublicLog } from "./contract.ts";
import { AiPublicError, aiExact, aiText, aiIndex, aiHash } from "./extract-ai.ts";
import { AI_RESPONSE_ACTS, AI_FUNCTION_CRITERIA } from "./jev-ai-public.ts";
import { literalSpan } from "../judgment/public-evidence.mjs";
import { priorClaimViews } from "./derive.ts";
import { recordAiClaims } from "./verify.ts";
import type { LocalGraph, LocalPriorAct } from "./verify.ts";
import { REFERENCE_LIMITS, validateReferenceUpdate, snapshotReferenceGraph } from "../memory/reference-graph.mjs";

const ref = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d*:[a-zA-Z0-9_-]{1,32}$/u.test(v);
const reasonCodes = new Set(["name_by_literal_path", "nonpublic_quote", "empty_extraction", "skipped_fallback", "invalid_segment",
  "invalid_verdict", "unknown_act", "ai_acknowledge_not_recorded", "unsupported_expression", "missing_claim_response", "nonpublic_claim_response",
  "inconsistent_claim_speaker", "inconsistent_claim_response", "not_deferred", "act_aspect_mismatch", "antecedent_ignored_independent",
  "duplicate_seq", "event_missing", "not_ai", "non_referential", "hash_mismatch", "source_out_of_window", "op_limit_pre", "prior_pruned", "structural_rejection",
  ...["ai_extraction", "ai_function", "ai_support"].flatMap(stage => ["invalid_input", "invalid_state", "invalid_json", "invalid_response", "invalid_quote",
    "duplicate_segment", "timeout", "aborted", "unavailable", "invalid_options", "invalid_request", "model_mismatch", "key_unavailable", "key_leak",
    "unauthorized", "payment_required", "not_found", "rate_limited", "upstream_error", "network_error", "cost_cap", "cost_unreported", "busy"].map(code => stage + "_" + code))]);
const reason = (v: unknown): v is string => typeof v === "string" && reasonCodes.has(v);
const independent = new Set(["assert", "construe", "ask"]);
const overlap = (a: readonly string[], b: readonly string[]) => a.some(id => b.includes(id));
export function verifyAiPublicUpdate({ graph, aiSeq, candidateText, publicTurns, segments, verdicts, supports }: {
  graph: LocalGraph; aiSeq: number; candidateText: string; publicTurns: readonly PublicTurn[];
  segments: readonly LocalSegmentProposal[]; verdicts: readonly LocalFunctionVerdict[];
  supports: readonly { segmentId: string; support: AiSupport }[];
}) {
  snapshotReferenceGraph(graph);
  const active = priorClaimViews(graph, { limit: REFERENCE_LIMITS.records });
  const candidates: AiPublicCandidate[] = [], rejected: Array<{ segmentId: string; reason: string }> = [], diagnostics: string[] = [];
  segments.forEach((s, index) => {
    const reject = (reason: string) => rejected.push({ segmentId: `segment_${index + 1}`, reason });
    if (!aiIndex(aiSeq) || !s || !aiText(s.segmentId, 64) || segments.filter(x => x.segmentId === s.segmentId).length !== 1 ||
        !aiText(s.proposition) || !aiText(s.quote) || !Array.isArray(s.targets) || new Set(s.targets).size !== s.targets.length ||
        s.targets.some(id => !graph.slots?.includes(id)) || !LOCAL_ASPECTS.includes(s.aspect) || s.name !== null) { reject("invalid_segment"); return; }
    if (s.aspect === "name") { reject("name_by_literal_path"); return; }
    const matches = verdicts.filter(v => v.segmentId === s.segmentId), v = matches[0];
    if (matches.length !== 1 || !Object.hasOwn(AI_FUNCTION_CRITERIA, v.act)) { reject("invalid_verdict"); return; }
    if (v.act === "unknown") { reject("unknown_act"); return; }
    if (v.act === "acknowledge") { reject("ai_acknowledge_not_recorded"); return; }
    const quote = literalSpan(candidateText, s.quote)?.text;
    if (!quote || quote.length > 160) { reject("nonpublic_quote"); return; }
    const support = supports.filter(x => x.segmentId === s.segmentId);
    const response = AI_RESPONSE_ACTS.has(v.act);
    if (support.length !== 1 || support[0].support !== (response ? "expressed_responds" : "expressed")) { reject("unsupported_expression"); return; }
    let targets = [...s.targets];
    let aspect: LocalSegmentProposal["aspect"] = s.aspect;
    let prior: LocalClaimView | null = null;
    if (response) {
      prior = active.find(c => c.id === v.respondsToClaimId) ?? null;
      if (!prior) { reject("missing_claim_response"); return; }
      if (!publicTurns.some(t => t.turn === prior!.sourceTurn && t.speaker === prior!.speaker && !(t as PublicTurn & { nonReferential?: boolean }).nonReferential && literalSpan(t.text, prior!.quote))) {
        reject("nonpublic_claim_response"); return;
      }
      if ((v.act === "agree" || v.act === "deny") && prior.speaker !== "human" || v.act === "withdraw" && prior.speaker !== "ai") {
        reject("inconsistent_claim_speaker"); return;
      }
      if (targets.length === 0) targets = [...prior.targets];
      if (aspect === "progress" && ["defer", "revisit"].includes(v.act)) aspect = prior.aspect;
      if (aspect === "name" || prior.sourceTurn >= aiSeq || prior.aspect !== aspect || !overlap(prior.targets, targets) ||
          s.respondsToTurn !== null && s.respondsToTurn !== prior.sourceTurn) { reject("inconsistent_claim_response"); return; }
      if (v.act === "revisit" && active.filter(c => c.issueId === prior!.issueId && ["defer", "revisit"].includes(c.act)).at(-1)?.act !== "defer") {
        reject("not_deferred"); return;
      }
    } else if (!independent.has(v.act)) { reject("invalid_verdict"); return; }
    else if (v.respondsToClaimId !== null) diagnostics.push("antecedent_ignored_independent");
    if (v.act === "construe" && aspect !== "construal") { reject("act_aspect_mismatch"); return; }
    candidates.push({ candidateKey: `${aiSeq}#${index + 1}`, ordinal: index + 1, segmentId: `segment_${index + 1}`, targets,
      aspect: aspect as AiPublicCandidate["aspect"], act: v.act as AiPublicCandidate["act"], proposition: s.proposition,
      name: null, quote, speaker: "ai", source: "ai_hypothesis", sourceTurn: aiSeq,
      issueId: prior?.issueId ?? null, respondsTo: prior?.id ?? null });
  });
  return { candidates, rejected, diagnostics: [...new Set(diagnostics)] };
}
export function initialAiPublicState(): AiPublicState { return { schema: 1, pending: null, log: [], omitted: 0 }; }
function invalid(): never { throw new AiPublicError("invalid_state"); }
export function validateAiPublicState(value: unknown, slots: readonly string[], maxSeq = Number.MAX_SAFE_INTEGER, graph?: LocalGraph): AiPublicState {
  if (!aiExact(value, ["schema", "pending", "log", "omitted"]) || value.schema !== 1 || !Array.isArray(value.log) || value.log.length > 64 ||
      !Number.isSafeInteger(value.omitted) || (value.omitted as number) < 0) invalid();
  const sources = new Set<number>();
  for (const log of value.log as unknown[]) {
    if (!aiExact(log, ["aiSeq", "status", "reasons", "appliedAtTurn", "ids"]) || !aiIndex(log.aiSeq) || log.aiSeq > maxSeq ||
        sources.has(log.aiSeq) || !["applied", "partial", "not_applied", "failed", "empty", "skipped_fallback"].includes(log.status as string) ||
        !Array.isArray(log.reasons) || !log.reasons.every(reason) || new Set(log.reasons).size !== log.reasons.length || !aiIndex(log.appliedAtTurn) || log.appliedAtTurn <= log.aiSeq ||
        !Array.isArray(log.ids) || log.ids.length > REFERENCE_LIMITS.operations || !log.ids.every(ref) || new Set(log.ids).size !== log.ids.length) invalid();
    sources.add(log.aiSeq);
  }
  const pending = value.pending;
  if (pending !== null) {
    if (!aiExact(pending, ["aiSeq", "textSha256", "candidates", "status", "reasons"]) || !aiIndex(pending.aiSeq) || pending.aiSeq < 2 || pending.aiSeq > maxSeq || sources.has(pending.aiSeq) ||
        typeof pending.textSha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.textSha256) ||
        !["ready", "partial", "empty", "failed", "skipped_fallback"].includes(pending.status as string) || !Array.isArray(pending.reasons) ||
        !pending.reasons.every(reason) || new Set(pending.reasons).size !== pending.reasons.length || !Array.isArray(pending.candidates) || pending.candidates.length > 32 ||
        (!["ready", "partial"].includes(pending.status as string) && pending.candidates.length !== 0) ||
        (["ready", "partial"].includes(pending.status as string) && pending.candidates.length === 0)) invalid();
    const keys = new Set<string>();
    for (const c of pending.candidates as unknown[]) {
      if (!aiExact(c, ["candidateKey", "ordinal", "segmentId", "targets", "aspect", "act", "proposition", "name", "quote", "speaker", "source", "sourceTurn", "issueId", "respondsTo"]) ||
          !aiIndex(c.ordinal) || c.ordinal > 32 || c.candidateKey !== `${pending.aiSeq}#${c.ordinal}` || keys.has(c.candidateKey as string) ||
          c.segmentId !== `segment_${c.ordinal}` || (c.act === "construe" && c.aspect !== "construal") || !Array.isArray(c.targets) || !c.targets.every(id => slots.includes(id)) || new Set(c.targets).size !== c.targets.length ||
          !LOCAL_ASPECTS.includes(c.aspect as never) || c.aspect === "name" || !Object.hasOwn(AI_FUNCTION_CRITERIA, c.act as string) ||
          ["unknown", "acknowledge"].includes(c.act as string) || !aiText(c.proposition) || !aiText(c.quote) || c.name !== null ||
          c.speaker !== "ai" || c.source !== "ai_hypothesis" || c.sourceTurn !== pending.aiSeq ||
          !(c.issueId === null || ref(c.issueId)) || !(c.respondsTo === null || ref(c.respondsTo)) ||
          (independent.has(c.act as string) ? c.issueId !== null || c.respondsTo !== null : c.issueId === null || c.respondsTo === null)) invalid();
      keys.add(c.candidateKey as string);
    }
  }
  if (graph && pending !== null) {
    const source = pending as AiPublicPending;
    const claims = graph.records.filter(r => (r as { kind?: string }).kind === "claim") as LocalClaimView[];
    if (claims.some(c => c.speaker === "ai" && c.sourceTurn === source.aiSeq && /^[1-9]\d*:pub[1-9]\d*$/.test(c.id))) invalid();
    for (const c of source.candidates) {
      const prior = claims.find(p => p.id === c.respondsTo);
      if (prior && ((["agree", "deny"].includes(c.act) && prior.speaker !== "human") || c.act === "withdraw" && prior.speaker !== "ai")) invalid();
    }
  }
  return structuredClone(value) as AiPublicState;
}
type Update = { expectedRevision: number; turn: number; operations: Array<{ kind: string; id: string }> };
type Event = { seq: number; speaker: string; text: string; nonReferential?: boolean };
export async function prependAiPublic({ graph, update, state, events, publicTurns, priorAct }: {
  graph: LocalGraph; update: Update; state: AiPublicState; events: readonly Event[]; publicTurns: readonly PublicTurn[]; priorAct?: LocalPriorAct;
}): Promise<{ update: Update; state: AiPublicState; application: AiPublicApplication }> {
  const next = structuredClone(state), pending = next.pending;
  const application: AiPublicApplication = { aiSeq: pending?.aiSeq ?? null, status: "none", reasons: [], claims: [], nameIds: [], nameRejections: [] };
  const names = priorAct ? recordAiClaims({ graph, turn: update.turn, publicTurns, priorAct, featureSource: "none" }) : { operations: [], rejected: [] };
  let current = update;
  if (pending) {
    const reject = (code: string) => { application.status = "not_applied"; application.reasons = [code]; };
    const matching = events.filter(e => e.seq === pending.aiSeq);
    if (matching.length > 1) reject("duplicate_seq");
    else if (!matching.length) reject("event_missing");
    else if (matching[0].speaker !== "ai") reject("not_ai");
    else if (matching[0].nonReferential) reject("non_referential");
    else if (await aiHash(matching[0].text) !== pending.textSha256) reject("hash_mismatch");
    else if (!publicTurns.some(t => t.turn === pending.aiSeq && t.speaker === "ai")) reject("source_out_of_window");
    else if (!["ready", "partial"].includes(pending.status)) {
      application.status = pending.status as AiPublicLog["status"]; application.reasons = [...pending.reasons];
    } else if (current.operations.length + pending.candidates.length + names.operations.length > REFERENCE_LIMITS.operations) reject("op_limit_pre");
    else {
      const active = priorClaimViews(graph, { limit: REFERENCE_LIMITS.records });
      const operations = pending.candidates.map(c => {
        const { candidateKey: _key, ordinal, segmentId: _segment, ...fields } = c, id = `${update.turn}:pub${ordinal}`;
        return { kind: "claim", id, ...fields, issueId: fields.issueId ?? id };
      });
      let proposed = current;
      for (const [index, op] of operations.entries()) {
        const source = pending.candidates[index];
        const prior = source.respondsTo ? active.find(c => c.id === source.respondsTo) : null;
        if (source.respondsTo && !prior) { reject("prior_pruned"); break; }
        if (prior && !publicTurns.some(t => t.turn === prior.sourceTurn && t.speaker === prior.speaker && !(t as PublicTurn & { nonReferential?: boolean }).nonReferential && t.text.includes(prior.quote))) { reject("source_out_of_window"); break; }
        if (prior && ((["agree", "deny"].includes(source.act) && prior.speaker !== "human") || source.act === "withdraw" && prior.speaker !== "ai")) { reject("inconsistent_claim_speaker"); break; }
        if (source.act === "revisit" && active.filter(c => c.issueId === source.issueId && ["defer", "revisit"].includes(c.act)).at(-1)?.act !== "defer") { reject("not_deferred"); break; }
        try { proposed = validateReferenceUpdate(graph, { ...proposed, operations: [...proposed.operations, op] }, { publicTurns }); }
        catch { reject("structural_rejection"); break; }
      }
      if (application.status !== "not_applied") {
        current = proposed; application.status = pending.status === "partial" ? "partial" : "applied";
        application.reasons = [...pending.reasons];
        application.claims = pending.candidates.map(c => ({ id: `${update.turn}:pub${c.ordinal}`, candidateKey: c.candidateKey, sourceTurn: c.sourceTurn }));
      }
    }
    next.log.push({ aiSeq: pending.aiSeq, status: application.status as AiPublicLog["status"], reasons: [...application.reasons],
      appliedAtTurn: update.turn, ids: application.claims.map(c => c.id) });
    if (next.log.length > 64) { next.omitted += next.log.length - 64; if (!Number.isSafeInteger(next.omitted)) invalid(); next.log = next.log.slice(-64); }
    next.pending = null;
  }
  application.nameRejections = structuredClone(names.rejected);
  for (const name of names.operations) {
    try { current = validateReferenceUpdate(graph, { ...current, operations: [...current.operations, name] }, { publicTurns }); application.nameIds.push(name.id); }
    catch { application.nameRejections.push({ segmentId: name.id, reason: "memory_invalid_update" }); }
  }
  return { update: current, state: next, application };
}
