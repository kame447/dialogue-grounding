import { allCalls, allHttp, amount, assertion, check, count, equal, list, missing, row, rows } from "./core.ts";
import type { Check, Records, Row } from "./core.ts";

const close = (a: unknown, b: number): boolean => amount(a) && Math.abs(a - b) < 1e-10;
const LIMITS = { jevPosts: 208, lunaCalls: 131, lunaPosts: 393, jevUsd: 2, lunaTokens: 1500000 };
const sum = (items: Row[], field: string) => items.reduce((n, x) => n + (amount(x[field]) ? x[field] as number : 0), 0);
const unknown = (items: Row[], field: string) => items.filter(x => !amount(x[field])).length;
export type Accounting = { checks: Check[]; totals: Row; inFlightAtStops: Array<{ seq: number | null; sendIds: unknown[]; calls?: Row[] }> };

export function ledger(records: Records): Accounting {
  const checks: Check[] = [], budget = row(records.summary?.budget), sends = rows(budget.sends);
  const configured = row(row(records.run?.manifest).caps);
  const effective = Object.fromEntries(Object.entries(LIMITS).map(([k, maximum]) => [k, amount(configured[k]) && (configured[k] as number) > 0 ? Math.min(configured[k] as number, maximum) : maximum])) as typeof LIMITS;
  const jev = sends.filter(s => s.provider === "jev"), luna = sends.filter(s => s.provider === "luna");
  const calls = allCalls(records), http = allHttp(records), posts = http.filter(h => h.kind === "completion_post");
  const lunaCalls = calls.filter(c => c.provider === "luna");
  const totals: Row = { jevPosts: jev.length, lunaPosts: luna.length, lunaComplete: lunaCalls.length,
    policyGets: http.filter(h => h.kind === "policy_get").length,
    knownJevUsd: sum(jev, "costUsd"), unknownJevCosts: unknown(jev, "costUsd"),
    knownInputTokens: sum(luna, "inputTokens"), knownOutputTokens: sum(luna, "outputTokens"),
    unknownInputTokens: unknown(luna, "inputTokens"), unknownOutputTokens: unknown(luna, "outputTokens"),
    lunaCostUsd: null, totalUsd: null, tokenScope: "known_lower_bound_plus_unknown_fields" };
  if (!records.summary?.budget) checks.push(missing("ledger.snapshot"));
  else {
    checks.push(assertion("ledger.ids", sends.every(s => count(s.id) && s.id > 0) && new Set(sends.map(s => s.id)).size === sends.length &&
      sends.every(s => ["luna", "jev"].includes(String(s.provider))), "unique_send_ids_and_providers"));
    const values: Array<[string, number]> = [["jevPosts", jev.length], ["lunaPosts", luna.length], ["observedJevUsd", sum(jev, "costUsd")],
      ["observedInputTokens", sum(luna, "inputTokens")], ["observedOutputTokens", sum(luna, "outputTokens")],
      ["observedLunaTokens", sum(luna, "inputTokens") + sum(luna, "outputTokens")],
      ["missingInputTokens", unknown(luna, "inputTokens")], ["missingOutputTokens", unknown(luna, "outputTokens")], ["lunaCalls", lunaCalls.length]];
    values.forEach(([key, expected]) => checks.push(assertion(`ledger.total.${key}`, close(budget[key], expected), "recomputed_snapshot_total", { expected })));
    checks.push(assertion("ledger.unknown_cost", budget.lunaCostUsd === null && budget.totalUsd === null &&
      (unknown(jev, "costUsd") === 0 || budget.jevUnknown === true && budget.halted === true), "unknown_never_reported_as_zero"));
    checks.push(assertion("ledger.unresolved", equal(list(budget.unresolvedJevSends).slice().sort(), jev.filter(s => !amount(s.costUsd)).map(s => s.id).sort()), "unresolved_jev_ids"));
    checks.push(assertion("ledger.in_flight", equal(list(budget.inFlight).slice().sort(), sends.filter(s => s.status === "in_flight").map(s => s.id).sort()), "snapshot_in_flight_ids"));
    checks.push(assertion("ledger.field_types", sends.every(s => ["in_flight", "sent_result_unknown", "observed_response"].includes(String(s.status)) &&
      (s.provider === "jev" ? s.costUsd === null || amount(s.costUsd) : [s.inputTokens, s.outputTokens].every(v => v === null || count(v)))), "nonnegative_billing_or_explicit_unknown"));
    checks.push(assertion("ledger.limits", jev.length <= LIMITS.jevPosts && luna.length <= LIMITS.lunaPosts && lunaCalls.length <= LIMITS.lunaCalls, "approved_count_hard_caps"));
    const cap = row(records.run?.manifest).caps;
    checks.push(cap ? assertion("ledger.configured_caps", Object.entries(LIMITS).every(([k, v]) => amount(row(cap)[k]) && (row(cap)[k] as number) > 0 && (row(cap)[k] as number) <= v) &&
      equal(budget.limits, cap), "manifest_does_not_raise_approved_caps_and_matches_ledger") : missing("ledger.configured_caps"));
  }
  const measured = records.run?.execution === "live" || posts.length > 0;
  checks.push(measured ? assertion("ledger.reserved_actual", luna.length >= posts.length && jev.length >= calls.filter(c => c.provider === "jev").reduce((n, c) => n + list(c.sendIds).length, 0), "reserved_counts_cover_http_attempts")
    : missing("ledger.reserved_actual", "mock_http_not_measured"));
  checks.push(measured ? assertion("ledger.complete_post", lunaCalls.length <= posts.length && posts.length <= lunaCalls.length * 3, "complete_entries_separate_from_post_retries")
    : missing("ledger.complete_post", "http_post_evidence_missing"));
  const owned = new Set<unknown>();
  calls.forEach((c, i) => {
    const ids = list(c.sendIds), valid = ids.every(id => {
      const match = sends.find(s => s.id === id);
      return !owned.has(id) && !!match && match.provider === c.provider && match.logicalCallId === c.id && match.phase === c.phase;
    });
    ids.forEach(id => owned.add(id));
    checks.push(assertion(`ledger.call.${i}`, valid && new Set(ids).size === ids.length && (c.provider !== "luna" || ids.length <= 3), "call_send_ownership_and_retry_limit"));
    if (c.provider === "jev" && ids.length) checks.push(assertion(`ledger.call_cost.${i}`, ids.every(id => amount(sends.find(s => s.id === id)?.costUsd)) ?
      close(c.costUsd, sum(sends.filter(s => ids.includes(s.id)), "costUsd")) : c.costUsd === null, "logical_jev_cost_matches_send_costs"));
  });
  if (measured) checks.push(assertion("ledger.send_ownership", sends.every(s => owned.has(s.id)), "each_reserved_send_has_logical_call"));
  const events = rows(records.evidence?.events);
  if (!events.length) {
    checks.push(missing("ledger.events", "ordered_reserve_send_response_events_missing"), missing("ledger.instance_cap", "jev_instance_identity_missing"),
      missing("ledger.stop_discipline", "stop_send_order_missing"));
    return { checks, totals, inFlightAtStops: rows(budget.stops).map(s => ({ seq: null, sendIds: rows(s.inFlight).map(x => x.id) })) };
  }
  let priorSeq = -1, priorTime = -Infinity, ordered = true, globalStop = false;
  let knownJev = 0, knownTokens = 0, completeCount = 0;
  const reserved = new Map<unknown, Row>(), sent = new Map<unknown, Row>(), responses = new Map<unknown, Row>();
  const stoppedInstances = new Set<unknown>(), stoppedTrials = new Set<unknown>();
  const flight = new Set<unknown>(), inFlightAtStops: Accounting["inFlightAtStops"] = [];
  const instanceCosts = new Map<unknown, Map<unknown, number>>();
  const instanceOwners = new Map<unknown, string>();
  let instanceEvidence = true;
  const eventFailure = (i: number, ok: boolean, reason: string) => checks.push(assertion(`ledger.event.${i}.${reason}`, ok, reason));
  for (const [i, e] of events.entries()) {
    const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
    ordered &&= count(e.seq) && e.seq > priorSeq && Number.isFinite(at) && at >= priorTime;
    if (count(e.seq)) priorSeq = e.seq;
    if (Number.isFinite(at)) priorTime = at;
    const stopped = globalStop || stoppedInstances.has(e.instanceId) || stoppedTrials.has(e.trialOrder);
    if (e.type === "complete") {
      eventFailure(i, e.provider === "luna" && !stopped && completeCount < effective.lunaCalls, "complete_entry"); completeCount++;
    } else if (e.type === "reserve") {
      eventFailure(i, count(e.sendId) && !reserved.has(e.sendId) && !stopped, "reservation");
      reserved.set(e.sendId, e);
    } else if (e.type === "send") {
      const reservation = reserved.get(e.sendId);
      eventFailure(i, !!reservation && !sent.has(e.sendId) && ["luna", "jev"].includes(String(e.provider)) &&
        ["provider", "instanceId", "trialOrder", "label", "callId", "phase"].every(k => reservation[k] === e[k]), "reserved_before_send");
      eventFailure(i, !stopped && knownJev < effective.jevUsd && knownTokens < effective.lunaTokens, "no_send_after_stop_or_threshold");
      eventFailure(i, [...sent.values()].filter(s => s.provider === e.provider).length < (e.provider === "luna" ? effective.lunaPosts : effective.jevPosts), "send_count_cap");
      if (typeof e.instanceId !== "string" || !e.instanceId.length) instanceEvidence = false;
      else {
        const owner = `${e.trialOrder}:${e.label}:${e.provider}`;
        eventFailure(i, !instanceOwners.has(e.instanceId) || instanceOwners.get(e.instanceId) === owner, "instance_not_reused_across_trials");
        instanceOwners.set(e.instanceId, owner);
      }
      if (e.provider === "jev" && typeof e.instanceId === "string") {
        const costs = [...(instanceCosts.get(e.instanceId)?.values() ?? [])];
        const spent = costs.reduce((n, x) => n + x, 0), max = Math.max(0, ...costs);
        eventFailure(i, spent < 0.05 && spent + max <= 0.05, "jev_instance_point05_rule");
      }
      sent.set(e.sendId, e); flight.add(e.sendId);
    } else if (e.type === "response") {
      const request = sent.get(e.sendId), prior = responses.get(e.sendId);
      eventFailure(i, !!request && ["provider", "instanceId", "trialOrder", "callId", "phase"].every(k => request[k] === e[k]), "response_ownership");
      if (!request) continue;
      eventFailure(i, ["ok", "error", "unknown"].includes(String(e.status)), "response_status");
      if (e.provider === "jev") {
        eventFailure(i, e.costUsd === null || amount(e.costUsd), "jev_cost_known_or_null");
        eventFailure(i, !prior || !amount(prior.costUsd) || e.costUsd === prior.costUsd, "known_cost_not_rewritten");
        if (amount(e.costUsd)) {
          if (!instanceCosts.has(e.instanceId)) instanceCosts.set(e.instanceId, new Map());
          instanceCosts.get(e.instanceId)!.set(e.sendId, e.costUsd);
          knownJev += e.costUsd - (amount(prior?.costUsd) ? prior!.costUsd as number : 0);
        } else globalStop = true;
      } else {
        for (const field of ["inputTokens", "outputTokens"]) {
          eventFailure(i, e[field] === null || count(e[field]), `${field}_known_or_null`);
          eventFailure(i, !prior || !count(prior[field]) || e[field] === prior[field], `${field}_not_rewritten`);
          knownTokens += (count(e[field]) ? e[field] as number : 0) - (count(prior?.[field]) ? prior![field] as number : 0);
        }
      }
      responses.set(e.sendId, e);
      if (e.status !== "unknown") flight.delete(e.sendId);
    } else if (e.type === "stop") {
      const scope = e.scope ?? "run";
      eventFailure(i, ["run", "trial", "instance"].includes(String(scope)), "stop_scope");
      const ids = [...flight].filter(id => scope === "run" || scope === "trial" && sent.get(id)?.trialOrder === e.trialOrder ||
        scope === "instance" && sent.get(id)?.instanceId === e.instanceId);
      eventFailure(i, Array.isArray(e.inFlight) && equal([...list(e.inFlight)].sort(), ids.sort()), "all_in_flight_at_stop_listed");
      inFlightAtStops.push({ seq: count(e.seq) ? e.seq : null, sendIds: [...ids], calls: ids.map(id => {
        const request = sent.get(id)!, usage = responses.get(id);
        return { sendId: id, provider: request.provider === "jev" ? "jev" : "luna", knownCostUsdAtStop: amount(usage?.costUsd) ? usage!.costUsd : null,
          knownInputTokensAtStop: count(usage?.inputTokens) ? usage!.inputTokens : null, knownOutputTokensAtStop: count(usage?.outputTokens) ? usage!.outputTokens : null };
      }) });
      if (scope === "run") globalStop = true;
      else if (scope === "trial") stoppedTrials.add(e.trialOrder);
      else stoppedInstances.add(e.instanceId);
    } else if (e.type === "commit") eventFailure(i, !stopped, "no_commit_after_stop");
    else if (e.type === "policy_get") eventFailure(i, e.provider === "luna" && !presentSendId(e) && !stopped, "policy_get_separate_and_not_after_stop");
    else if (e.type !== "refused") eventFailure(i, false, "recognized_event_type");
  }
  checks.push(assertion("ledger.event_order", ordered, "strict_seq_nondecreasing_timestamp"));
  checks.push(instanceEvidence ? assertion("ledger.instance_cap", true, "per_instance_checks_in_event_report") : missing("ledger.instance_cap", "instance_id_missing"));
  const eventSends = [...sent.values()];
  checks.push(assertion("ledger.event_reconciliation", eventSends.length === posts.length + jev.length &&
    sends.every(s => reserved.has(s.id)) && eventSends.every(s => sends.some(r => r.id === s.sendId && r.provider === s.provider)) && completeCount === lunaCalls.length,
    "events_reconcile_native_http_and_complete_records"));
  sends.forEach((s, i) => {
    const response = responses.get(s.id), fields = s.provider === "jev" ? ["costUsd"] : ["inputTokens", "outputTokens"];
    if (response) checks.push(assertion(`ledger.response_snapshot.${i}`, fields.every(field => s[field] === null || s[field] === response[field]),
      "known_snapshot_billing_matches_ordered_response"));
  });
  totals.orderedEvents = events.length;
  totals.latestKnownJevUsd = knownJev;
  totals.latestKnownLunaTokens = knownTokens;
  totals.reservations = reserved.size;
  totals.actualSends = sent.size;
  for (const stop of inFlightAtStops) for (const call of stop.calls ?? []) {
    const latest = responses.get(call.sendId);
    call.latestKnownCostUsd = amount(latest?.costUsd) ? latest!.costUsd : null;
    call.latestKnownInputTokens = count(latest?.inputTokens) ? latest!.inputTokens : null;
    call.latestKnownOutputTokens = count(latest?.outputTokens) ? latest!.outputTokens : null;
  }
  checks.push(assertion("ledger.stop_discipline", !checks.some(c => c.id.startsWith("ledger.event.") && c.status === "mismatch"), "ordered_event_constraints"));
  return { checks, totals, inFlightAtStops };
}
function presentSendId(event: Row) { return event.sendId !== undefined && event.sendId !== null; }
