import { amount, assertion, count, equal, list, missing, missingTrialOrders, row, rows, shaLike } from "./core.ts";
import type { Check, Records, Row } from "./core.ts";

// Fixed from REQUEST-16R/16R2 and Mail 8102/8105, before producer fixtures.
const object = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: unknown, required: string[], optional: string[] = []): boolean => object(v) &&
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const oneOf = (v: unknown, allowed: readonly string[]): v is string => typeof v === "string" && allowed.includes(v);
const nullable = (v: unknown, predicate: (v: unknown) => boolean) => v === null || predicate(v);
const positive = (v: unknown) => count(v) && v > 0;
const safeCode = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_:.\-]{1,160}$/u.test(v);
const callKeys = ["id", "sendIds", "phase", "turn", "provider", "requestSha256", "instructionSha256", "requestedModel", "model",
  "status", "error", "costUsd", "inputTokens", "outputTokens", "imageCount", "latencyMs"];
function callSchema(v: unknown): boolean {
  if (!keys(v, callKeys, ["expectedHttpRequestSha256", "httpRequestSha256"])) return false;
  const c = row(v);
  return positive(c.id) && Array.isArray(c.sendIds) && c.sendIds.every(positive) && text(c.phase) && nullable(c.turn, count) &&
    oneOf(c.provider, ["luna", "jev"]) && shaLike(c.requestSha256) && nullable(c.instructionSha256, shaLike) &&
    text(c.requestedModel) && nullable(c.model, text) && oneOf(c.status, ["started", "ok", "error"]) && nullable(c.error, safeCode) &&
    nullable(c.costUsd, amount) && nullable(c.inputTokens, count) && nullable(c.outputTokens, count) && count(c.imageCount) && nullable(c.latencyMs, amount) &&
    ["expectedHttpRequestSha256", "httpRequestSha256"].every(k => !Object.hasOwn(c, k) || nullable(c[k], shaLike));
}
function httpSchema(v: unknown): boolean {
  if (!keys(v, ["method", "kind", "phase", "callId", "sendId", "hashScheme", "requestSha256", "status", "outcome"])) return false;
  const h = row(v), get = h.kind === "policy_get" && h.method === "GET", post = h.kind === "completion_post" && h.method === "POST";
  return oneOf(h.kind, ["policy_get", "completion_post"]) && oneOf(h.method, ["GET", "POST"]) &&
    (get || post) && h.hashScheme === "canonical_json_sha256" && oneOf(h.outcome, ["returned", "unknown"]) &&
    nullable(h.status, v => count(v) && v >= 100 && v <= 599) && (get ? h.phase === null && h.callId === null && h.sendId === null && h.requestSha256 === null :
      text(h.phase) && positive(h.callId) && positive(h.sendId) && shaLike(h.requestSha256));
}
function cacheSchema(v: unknown): boolean {
  if (v === null) return true;
  if (!keys(v, ["status", "reason", "key", "source", "observation", "elapsedMs"])) return false;
  const c = row(v), k = row(c.key), s = row(c.source);
  return oneOf(c.status, ["HIT", "MISS"]) && oneOf(c.reason, ["match", "not_found", "invalid_json", "invalid_entry", "content_hash_mismatch",
    "image_mismatch", "anchors_mismatch", "model_mismatch", "instructions_mismatch", "format_mismatch", "invalid_memo",
    "unsafe_path", "unsafe_permissions", "io_error"]) &&
    keys(k, ["id", "image", "anchors", "model", "instructions", "formatVersion"]) &&
    ["id", "image", "anchors", "model", "instructions"].every(name => text(k[name])) && positive(k.formatVersion) &&
    (c.source === null || keys(s, ["createdAt", "modelId", "instructionHash", "formatVersion", "durationMs"]) &&
      text(s.createdAt) && Number.isFinite(Date.parse(s.createdAt)) && text(s.modelId) && shaLike(s.instructionHash) && positive(s.formatVersion) && amount(s.durationMs)) &&
    oneOf(c.observation, ["reused", "created", "none"]) && amount(c.elapsedMs);
}
export function failureKind(f: Row): "legacy_v0" | "warmup" | "after_warmup" | "invalid" {
  if (!object(f)) return "invalid";
  if (!Object.hasOwn(f, "schemaVersion")) return keys(f, ["code", "calls", "cache"]) && safeCode(f.code) &&
    Array.isArray(f.calls) && f.calls.every(callSchema) && cacheSchema(f.cache) ? "legacy_v0" : "invalid";
  if (f.schemaVersion !== "parity_live_failure_v1" || !safeCode(f.code)) return "invalid";
  if (f.scope === "after_warmup") return keys(f, ["schemaVersion", "scope", "code", "stage"]) &&
    oneOf(f.stage, ["trial_loop", "unknown"]) ? "after_warmup" : "invalid";
  if (f.scope !== "warmup" || !keys(f, ["schemaVersion", "scope", "code", "stage", "calls", "cache", "observationCallStarted", "policy", "http", "deadlines"]) ||
    !oneOf(f.stage, ["client_setup", "policy_get", "cache_get", "post_cache", "unknown"]) || !Array.isArray(f.calls) ||
    !f.calls.every(callSchema) || !cacheSchema(f.cache) || typeof f.observationCallStarted !== "boolean" ||
    f.observationCallStarted !== (f.calls.filter(c => row(c).provider === "luna" && row(c).phase === "observation_initial").length > 0)) return "invalid";
  const p = row(f.policy), h = row(f.http), d = row(f.deadlines), configured = row(d.configured), applied = row(d.applied);
  if (!keys(p, ["status", "value"]) || !oneOf(p.status, ["not_requested", "failed", "obtained"]) ||
    (p.status === "obtained" ? !keys(p.value, ["purpose", "ready", "model", "provider"]) || !text(row(p.value).purpose) ||
      typeof row(p.value).ready !== "boolean" || !text(row(p.value).model) || !text(row(p.value).provider) : p.value !== null) ||
    !keys(h, ["measured", "records"]) || typeof h.measured !== "boolean" || !Array.isArray(h.records) || !h.records.every(httpSchema) ||
    h.measured === false && h.records.length !== 0 || !keys(d, ["configured", "applied"]) ||
    !keys(configured, ["observationMs", "lunaClientTimeoutMs"]) || !positive(configured.observationMs) || !nullable(configured.lunaClientTimeoutMs, positive) ||
    !keys(applied, ["observationOuterMs", "completeCalls"]) || !nullable(applied.observationOuterMs, positive) || !Array.isArray(applied.completeCalls) ||
    !applied.completeCalls.every(c => keys(c, ["callId", "callOptionTimeoutMs"]) && positive(row(c).callId) && nullable(row(c).callOptionTimeoutMs, positive))) return "invalid";
  if (oneOf(f.stage, ["client_setup", "policy_get"]) && applied.observationOuterMs !== null ||
    oneOf(f.stage, ["cache_get", "post_cache"]) && applied.observationOuterMs === null ||
    applied.completeCalls.length > 0 && applied.observationOuterMs === null) return "invalid";
  const targets = f.calls.filter(c => row(c).provider === "luna").map(c => row(c).id), actual = applied.completeCalls.map(c => row(c).callId);
  return new Set(actual).size === actual.length && equal([...actual].sort(), [...targets].sort()) ? "warmup" : "invalid";
}

export function failureChecks(records: Records): Check[] {
  const out: Check[] = [], f = Object.hasOwn(records, "failure") ? row(records.failure) : undefined;
  if (f) {
    const kind = failureKind(f);
    out.push(assertion("failure.schema", kind !== "invalid", kind === "invalid" ? "schema_violation" : "closed_failure_schema"));
    if (kind === "legacy_v0") for (const part of ["http", "policy", "deadlines"])
      out.push(missing(`failure.${part}`, "legacy_unrecorded"));
    if (kind === "warmup" || kind === "after_warmup") out.push(assertion("failure.scope",
      kind === "warmup" ? !records.warmup : !!records.warmup, "scope_contradiction"));
    if (kind === "warmup") {
      const policy = row(f.policy), value = row(policy.value), completeCalls = rows(f.calls).filter(c => c.provider === "luna");
      const policyRequired = oneOf(f.stage, ["cache_get", "post_cache"]) || f.observationCallStarted === true || completeCalls.length > 0;
      if (policy.status === "obtained") {
        // Independently enforce the approved success-policy boundary (POSTAUDIT-23); no research model is pinned.
        const valid = value.purpose === "dialogue_turn" && value.ready === true && oneOf(value.provider, ["openai", "gemini"]) &&
          typeof value.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value.model) &&
          completeCalls.every(c => c.requestedModel === value.model);
        out.push(assertion("failure.policy", valid, "obtained_policy_matches_contract_and_requested_model"));
      } else out.push(policyRequired ? assertion("failure.policy", false, "policy_required_before_observation") :
        missing("failure.policy", "policy_not_obtained"));
      const d = row(f.deadlines), configured = row(d.configured), applied = row(d.applied);
      const observation = row(row(records.run?.profile).timeouts).observationMs, client = row(row(records.run?.manifest).lunaRequest).timeoutMs;
      out.push(observation === undefined || client === undefined ? missing("failure.deadlines", "output_missing") :
        assertion("failure.deadlines", configured.observationMs === observation && configured.lunaClientTimeoutMs === client &&
          (applied.observationOuterMs === null || applied.observationOuterMs === configured.observationMs), "configured_and_applied_deadlines"));
      if (row(f.http).measured === false) out.push(missing("failure.http", "output_missing"));
      rows(row(f.http).records).filter(h => h.kind === "completion_post").forEach((h, i) => {
        const c = rows(f.calls).find(c => c.id === h.callId), hashes = [c?.expectedHttpRequestSha256, c?.httpRequestSha256].filter(shaLike);
        const coherent = !!c && c.phase === h.phase && list(c.sendIds).includes(h.sendId) && hashes.every(digest => digest === h.requestSha256);
        out.push(!coherent ? assertion(`failure.http_binding.${i}`, false, "full_http_hash_and_call_send_binding") : hashes.length < 2 ?
          missing(`failure.http_binding.${i}`, "output_missing") : assertion(`failure.http_binding.${i}`, true, "full_http_hash_and_call_send_binding"));
      });
      // Preserve an actual cache wiring violation even when no warmup file survived.
      if (f.cache !== null) out.push(assertion("failure.cache", row(f.cache).status === "MISS", "warmup_cache_must_miss"));
    }
  }
  // Calls and POST receipts are two views in ONE file, not two owners.
  const owners: Array<{ calls: Row[]; http: Row[] }> = [
    { calls: rows(f?.calls), http: rows(row(f?.http).records) },
    { calls: rows(records.warmup?.calls), http: rows(records.warmup?.http) },
    ...records.trials.map(t => ({ calls: rows(t.calls), http: rows(t.http) }))];
  const callOwners = new Map<unknown, number>(), sendOwners = new Map<unknown, number>();
  let unique = true;
  owners.forEach((source, owner) => {
    const seenCalls = new Set<unknown>();
    for (const c of source.calls) {
      if (seenCalls.has(c.id) || callOwners.has(c.id) && callOwners.get(c.id) !== owner) unique = false;
      seenCalls.add(c.id); callOwners.set(c.id, owner);
    }
    for (const h of source.http.filter(h => h.kind === "completion_post")) {
      if (callOwners.has(h.callId) && callOwners.get(h.callId) !== owner) unique = false;
      callOwners.set(h.callId, owner);
    }
    for (const id of new Set([...source.calls.flatMap(c => list(c.sendIds)), ...source.http.filter(h => h.kind === "completion_post").map(h => h.sendId)])) {
      if (sendOwners.has(id) && sendOwners.get(id) !== owner) unique = false;
      sendOwners.set(id, owner);
    }
  });
  out.push(assertion("records.ownership", unique, unique ? "unique_record_ownership" : "duplicate_ownership"));
  for (const order of missingTrialOrders(records)) out.push(missing(`records.trial_file.${order}`, "output_missing"));
  if (!records.warmup && !f) out.push(missing("records.warmup", "output_missing"));
  return out;
}

export function plannedMapping(records: Records): Check[] {
  const id = "records.planned_mapping", run = records.run;
  if (!run) return [missing(id, "output_missing")];
  const hasPlan = Array.isArray(row(run.manifest).trials), plan = list(row(run.manifest).trials), entries = [...records.trials, ...rows(records.summary?.skipped)];
  const obvious = hasPlan && (records.trials.length > plan.length || list(records.summary?.runOrder).length > plan.length);
  const contradiction = entries.some(e => Object.hasOwn(e, "plannedIndex"));
  if (!Object.hasOwn(run, "plannedMappingVersion")) return [obvious ? assertion(id, false, "planned_mapping") :
    contradiction ? assertion(id, false, "version_contradiction") : missing(id, "legacy_unrecorded")];
  if (run.plannedMappingVersion !== 1) return [assertion(id, false, "unknown_version")];
  const ids = entries.map(e => e.plannedIndex);
  const valid = !obvious && ids.every(i => count(i) && (!hasPlan || i < plan.length)) && new Set(ids).size === ids.length && entries.every(e => {
    if (!hasPlan) return true;
    const p = row(plan[Number(e.plannedIndex)]);
    return ["scriptId", "label", "stage"].every(k => !Object.hasOwn(e, k) || e[k] === p[k]);
  });
  if (!valid) return [assertion(id, false, "planned_mapping")];
  if (!records.summary || !Array.isArray(records.summary.runOrder) || !Array.isArray(records.summary.skipped) || !hasPlan || missingTrialOrders(records).length)
    return [missing(id, "output_missing")];
  return [assertion(id, ids.length === plan.length, "planned_mapping")];
}
