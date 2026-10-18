// Synthetic engineering evaluation only. Default invocation performs ZERO calls.
import { mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, EVAL_NOTICE, buildCaseState } from "../decisions-eval/cases.mjs";
import { PURPOSES, scoreResults, scoreBaselines } from "../decisions-eval/score.mjs";
import { DECISION_ACTIONS } from "../../../workers/research-ai-proxy/src/decisions.mjs";
import { createDecisionComparisonClient } from "../decisions-client.mjs";
import { loadConfig } from "../config.mjs";
import { outsideRepositoryDirectory } from "../naming-task.mjs";

export const MAX_CALLS = 200;
export const MAX_CONCURRENCY = 4;
const ERROR_CODES = new Set(["invalid_config", "invalid_request", "rate_limited", "payment_required", "upstream_error", "invalid_response", "timeout", "network_error",
  "invalid_cases", "call_cap_exceeded", "invalid_concurrency", "invalid_client", "invalid_arguments", "output_required", "invalid_output_directory", "repository_output_forbidden", "record_write_failed"]);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const safeCode = (error) => ERROR_CODES.has(error?.code) ? error.code : "decision_unavailable";
const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null;

/** Cap cannot be raised by CLI/config/caller. Planning validates every state before calls start. */
export function planEvaluation(cases = CASES, { concurrency = MAX_CONCURRENCY } = {}) {
  if (!Array.isArray(cases)) fail("invalid_cases");
  const plannedCalls = cases.length * PURPOSES.length;
  if (plannedCalls > MAX_CALLS) fail("call_cap_exceeded");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) fail("invalid_concurrency");
  try { scoreResults(cases, []); cases.forEach(buildCaseState); }
  catch { fail("invalid_cases"); }
  return { cases: cases.length, bases: new Set(cases.map((value) => value.baseId)).size,
    plannedCalls, callCap: MAX_CALLS, concurrency, purposes: [...PURPOSES] };
}

/** No labels, case IDs, strata or rationale are provided to the injected client. No retries. */
export async function runEvaluation({ cases = CASES, client, concurrency = MAX_CONCURRENCY, outDir = null, log = console.log } = {}) {
  const plan = planEvaluation(cases, { concurrency });
  if (!client || typeof client.chooseAction !== "function") fail("invalid_client");
  // Cache one exact string per case, shared by BOTH model requests.
  const jobs = cases.flatMap((value) => {
    const state = buildCaseState(value);
    return PURPOSES.map((purpose) => ({ caseId: value.id, purpose, state }));
  });
  let file = null, writing = Promise.resolve(), writeFailed = false;
  if (outDir !== null) {
    const directory = await outsideRepositoryDirectory(outDir);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await outsideRepositoryDirectory(directory) !== directory) fail("record_write_failed");
      file = await open(join(directory, "decisions-eval-" + randomUUID() + ".jsonl"), "wx", 0o600);
    } catch { fail("record_write_failed"); }
  }
  let cursor = 0;
  const rows = new Array(jobs.length);
  async function worker() {
    while (cursor < jobs.length && !writeFailed) {
      const index = cursor++, job = jobs[index], started = performance.now();
      let row;
      try {
        const result = await client.chooseAction({ purpose: job.purpose, state: job.state });
        if (!result || !DECISION_ACTIONS.includes(result.action) ||
            (result.purpose !== undefined && result.purpose !== job.purpose) ||
            !DECISION_ACTIONS.every((action) => Number.isFinite(result.probabilities?.[action]) && result.probabilities[action] >= 0 && result.probabilities[action] <= 1)) fail("invalid_response");
        row = { caseId: job.caseId, purpose: job.purpose, action: result.action, error: null, status: null,
          probabilities: Object.fromEntries(DECISION_ACTIONS.map((action) => [action, result.probabilities[action]])),
          latencyMs: nonnegative(result.latencyMs) ?? Math.round(performance.now() - started), costUsd: nonnegative(result.usage?.costUsd) };
      } catch (error) {
        row = { caseId: job.caseId, purpose: job.purpose, action: null, error: safeCode(error),
          status: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
          probabilities: null, latencyMs: Math.round(performance.now() - started), costUsd: null };
      }
      rows[index] = row;
      if (file) {
        writing = writing.then(() => file.write(JSON.stringify(row) + "\n"));
        try { await writing; }
        catch { writeFailed = true; }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    if (writeFailed) fail("record_write_failed");
  } finally { if (file) await file.close().catch(() => {}); }
  const summary = scoreResults(cases, rows), baselines = scoreBaselines(cases);
  // Aggregate-only allowlist. Never print rows, states, labels or error objects.
  log(JSON.stringify({ notice: EVAL_NOTICE, plan, summary, baselines }));
  return { plan, rows, summary, baselines };
}

export function createMockClient() {
  return Object.freeze({ async chooseAction({ purpose }) {
    return { purpose, action: "accept", probabilities: Object.fromEntries(DECISION_ACTIONS.map((action) => [action, action === "accept" ? 1 : 0])),
      latencyMs: 0, usage: { costUsd: 0 } };
  } });
}

export async function main(argv = process.argv.slice(2), { cases = CASES, log = console.log,
  createLiveClient = () => createDecisionComparisonClient(loadConfig()) } = {}) {
  let mode = "dry-run", selected = false, outDir = null, concurrency = MAX_CONCURRENCY;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--mock" || arg === "--live") {
      if (selected) fail("invalid_arguments");
      mode = arg.slice(2); selected = true;
    } else if (arg === "--out") {
      if (outDir !== null || !argv[index + 1] || argv[index + 1].startsWith("--")) fail("invalid_arguments");
      outDir = argv[++index];
    } else if (arg === "--concurrency") {
      if (!/^[1-4]$/.test(argv[index + 1] ?? "")) fail("invalid_concurrency");
      concurrency = Number(argv[++index]);
    } else fail("invalid_arguments");
  }
  const plan = planEvaluation(cases, { concurrency });
  if (outDir !== null) await outsideRepositoryDirectory(outDir);
  if (mode === "dry-run") { log(JSON.stringify({ notice: EVAL_NOTICE, mode, plan })); return { mode, plan }; }
  if (mode === "live" && outDir === null) fail("output_required");
  const client = mode === "mock" ? createMockClient() : createLiveClient();
  return { mode, ...await runEvaluation({ cases, client, concurrency, outDir, log }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: safeCode(error) }));
    process.exitCode = 1;
  });
}
