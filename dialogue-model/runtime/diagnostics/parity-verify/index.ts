import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertion, canonical, check, combine, equal, missing, row, rows } from "./core.ts";
import type { Check, Records, Row } from "./core.ts";
import { cacheChecks, fairness, publicPrivacy, wireValidation } from "./fairness.ts";
import { coverage, gates } from "./coverage.ts";
import { ledger } from "./ledger.ts";
import { packetChecks } from "./packets.ts";

export { canonical, hash, sha256, profileHash, META_KEYS } from "./core.ts";
export type { Check, Records, Row, Status } from "./core.ts";

function journal(records: Records): Check[] {
  const out: Check[] = [], entries = records.billing;
  if (!entries?.length) return [missing("billing.journal")];
  const latest = new Map<unknown, Row>(), versions = new Map<unknown, Row[]>();
  let stopped = false;
  for (const [i, event] of entries.entries()) {
    const e = row(event.entry);
    if (Object.keys(e).length) {
      const prior = latest.get(e.id);
      out.push(assertion(`billing.journal.${i}`, prior ? prior.provider === e.provider && prior.logicalCallId === e.logicalCallId &&
        (prior.costUsd === null || prior.costUsd === e.costUsd) : e.status === "in_flight" && !stopped, "reservation_transition_and_sticky_cost"));
      latest.set(e.id, e); versions.set(e.id, [...(versions.get(e.id) ?? []), e]);
    } else if (!event.refused) out.push(assertion(`billing.journal.${i}`, false, "recognized_billing_event"));
    if (rows(event.stops).length) stopped = true;
  }
  rows(row(records.summary?.budget).sends).forEach((s, i) => out.push(assertion(`billing.snapshot.${i}`, (versions.get(s.id) ?? []).some(v => equal(v, s)), "snapshot_send_has_journal_version")));
  return out;
}

/** Input is JSON record data only. No harness/runtime/model/transport imports. */
export function verifyRecords(records: Records) {
  const checks: Check[] = [];
  try {
    canonical(records);
    if (!Array.isArray(records.trials)) throw new TypeError("trials_required");
    checks.push(records.run ? check("records.run", "pass", "present") : missing("records.run"),
      records.summary ? check("records.summary", "pass", "present") : missing("records.summary"));
    if (records.run && records.summary) checks.push(assertion("records.run_id", typeof records.run.runId === "string" && records.run.runId === records.summary.runId, "run_summary_identity"));
    if (records.evidence) checks.push(assertion("records.evidence", records.evidence.version === 1 && records.evidence.runId === records.run?.runId, "evidence_version_run_identity"));
    if (records.trials.length === 0) checks.push(missing("records.trials"));
    const orders = records.trials.map(t => t.order);
    checks.push(assertion("records.trial_orders", orders.every(v => Number.isSafeInteger(v) && Number(v) >= 0) && new Set(orders).size === orders.length, "unique_trial_orders"));
    if (orders.some(v => !Number.isSafeInteger(v) || Number(v) < 0) || records.trials.some(t => rows(t.turns).some(turn => !Number.isSafeInteger(turn.turn))))
      throw new TypeError("invalid_trial_or_turn_identity");
    records.trials.forEach((t, i) => checks.push(assertion(`records.trial_shape.${i}`, Array.isArray(t.calls) && Array.isArray(t.http) && Array.isArray(t.turns) &&
      Array.isArray(t.replay) && ["repair-first", "bypass-enabled"].includes(String(t.label)) && ["smoke", "main"].includes(String(t.stage)), "required_trial_arrays_and_labels")));
    checks.push(...packetChecks(records));
    const accounting = ledger(records), technical = coverage(records);
    checks.push(...fairness(records), ...wireValidation(records), ...cacheChecks(records), ...accounting.checks, ...journal(records), publicPrivacy(records));
    checks.push(...gates(records, checks));
    checks.push(...technical.checks);
    const report = combine("overall", checks, "independent_record_evidence_only");
    return { version: 1, status: report.status, counts: statusCounts(checks), checks, totals: accounting.totals,
      inFlightAtStops: accounting.inFlightAtStops, coverage: technical.cells,
      limitations: ["no_semantic_scoring", "no_intervention_effect_claim", "unrecorded_activity_cannot_be_verified", "mock_paths_are_not_live_demonstrations",
        "leak_checks_are_lexical_and_use_recorded_prompt_lines_only", "canonical_http_json_identity_is_not_raw_body_byte_identity",
        "projected_image_original_bytes_are_not_independently_reconstructed"] };
  } catch {
    checks.push(check("records.schema", "mismatch", "invalid_or_non_json_record_shape"));
    return { version: 1, status: "mismatch" as const, counts: statusCounts(checks), checks, totals: {}, inFlightAtStops: [], coverage: [],
      limitations: ["malformed_input_no_full_verification"] };
  }
}
function statusCounts(checks: Check[]) {
  return Object.fromEntries(["pass", "mismatch", "not_comparable", "not_reached"].map(status => [status, checks.filter(c => c.status === status).length]));
}

const acceptedName = /^(?:run\.private\.json|summary\.private\.json|warmup\.private\.json|trial-\d+\.private\.json|public-\d+-\d+\.packet\.json|billing\.private\.jsonl|verifier-evidence\.private\.json)$/u;
async function insideRepository(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    try { await lstat(join(current, ".git")); return true; }
    catch (error) { if (row(error).code !== "ENOENT") throw new Error("repository_boundary_unreadable"); }
    if (dirname(current) === current) return false;
  }
}
/** Read the fixed run-file vocabulary only. No following paths found inside records. */
export async function loadRecords(directory: string): Promise<Records> {
  const dirInfo = await lstat(directory);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error("invalid_record_directory");
  const dir = await realpath(directory), inRepository = await insideRepository(dir);
  const names = (await readdir(dir)).filter(n => acceptedName.test(n)).sort();
  if (!names.length || names.length > 2048) throw new Error("invalid_record_file_count");
  const result: Records = { trials: [], packets: [], storage: [] };
  for (const name of names) {
    const file = join(dir, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("unsafe_or_oversized_record_file");
    result.storage!.push({ name, mode: info.mode & 0o777, external: !inRepository && (dirInfo.mode & 0o777) === 0o700, regular: info.nlink === 1 });
    const raw = await readFile(file, "utf8");
    if (name === "billing.private.jsonl") {
      const lines = raw.trim() ? raw.trim().split(/\r?\n/u) : [];
      result.billing = lines.map(line => parsedObject(line)); continue;
    }
    const value = parsedObject(raw);
    if (name === "run.private.json") result.run = value;
    else if (name === "summary.private.json") result.summary = value;
    else if (name === "warmup.private.json") result.warmup = value;
    else if (name === "verifier-evidence.private.json") result.evidence = value;
    else if (name.startsWith("trial-")) {
      if (value.order !== Number(name.match(/^trial-(\d+)/u)![1])) throw new Error("trial_filename_order_mismatch");
      result.trials.push(value);
    } else result.packets!.push({ name, value });
  }
  result.trials.sort((a, b) => Number(a.order) - Number(b.order));
  return result;
}
function parsedObject(raw: string): Row {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record_object_required");
  return value as Row;
}
export async function verifyDirectory(directory: string) { return verifyRecords(await loadRecords(directory)); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    process.stderr.write("Usage: node dialogue-model/runtime/diagnostics/parity-verify/index.ts RUN_DIRECTORY\n"); process.exitCode = 2;
  } else {
    try {
      const report = await verifyDirectory(process.argv[2]);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = report.status === "mismatch" ? 2 : report.status === "pass" ? 0 : 3;
    } catch {
      process.stderr.write("parity_verify: invalid_or_unreadable_records\n"); process.exitCode = 2;
    }
  }
}
