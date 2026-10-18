#!/usr/bin/env node
// Researcher-only, offline, post-submission. Reads one completed v2 trial record
// (outside the repository) and summarises the end-to-end session: matches, in-dialogue
// agreements/repairs judged against the answer key, action frequencies, active-judge
// resolutions, latency and cost. Run only after both sides have submitted; the human
// role must not see this during a session. No model calls.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeName } from "../scoring.mjs";

const acts = (entry) => [entry.judgment, entry.judgment?.followUp].filter((act) => act?.action);
const count = (values) => values.reduce((out, value) => ({ ...out, [value]: (out[value] ?? 0) + 1 }), {});
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
};

/**
 * In-dialogue agreement/repair checks use the human's final submission as the human's
 * intended figure for each name: an agreement on AI slot S with name N is "wrong" when the
 * human submitted N for a different figure than S. Names the human did not submit are "unknown".
 */
export function summarizeSession(record) {
  if (record?.version !== 2 || record.status !== "completed" || !record.scoring?.key) throw new Error("A completed v2 record is required");
  const { key } = record.scoring;
  const humanFigureByName = new Map(Object.entries(record.humanSubmission ?? {})
    .filter(([, name]) => name).map(([slot, name]) => [normalizeName(name), key.human[slot]]));
  const committed = (record.judgments ?? []).filter((entry) => entry.status === "committed");
  const allActs = committed.flatMap(acts);
  const judgeAgainstKey = (slot, name) => {
    const intended = name ? humanFigureByName.get(normalizeName(name)) : undefined;
    return intended === undefined ? "unknown" : intended === key.ai[slot] ? "correct" : "wrong";
  };
  const agreements = allActs.filter((act) => act.action === "agree").map((act) => {
    const entry = committed.find((e) => acts(e).includes(act));
    const name = act.candidateName ?? entry?.ownLedgerBefore?.[act.targetSlot]?.name ?? null;
    return { turn: entry?.turnIndex ?? null, verdict: judgeAgainstKey(act.targetSlot, name) };
  });
  // A repair is "wrong" when it released or renamed a slot whose prior name the human used for that same figure.
  const repairs = committed.filter((entry) => acts(entry).some((act) => act.action === "repair")).map((entry) => {
    const act = acts(entry).find((a) => a.action === "repair");
    const before = entry.ownLedgerBefore?.[act.targetSlot]?.name ?? null;
    return { turn: entry.turnIndex, verdict: before ? (judgeAgainstKey(act.targetSlot, before) === "correct" ? "wrong" : "justified_or_unknown") : "no_prior_name" };
  });
  const active = committed.map((entry) => entry.activeJudge).filter(Boolean);
  const attempts = record.attempts ?? [];
  const finalMismatches = (record.scoring.result?.figures ?? []).filter((figure) => !figure.matched)
    .map((figure) => ({ figure: figure.figureId, human: figure.human?.rawName ?? null, ai: figure.ai?.rawName ?? null }));
  return {
    seed: record.seed, strategy: record.strategy, activeDecision: record.options?.activeDecision ?? null,
    humanMessages: (record.events ?? []).filter((event) => event.speaker === "human").length,
    aiTurns: committed.length,
    matched: record.scoring.result?.matchedCount ?? null, total: record.scoring.result?.total ?? null,
    finalActions: count(allActs.map((act) => act.action)),
    agreements: { total: agreements.length, ...count(agreements.map((a) => a.verdict)) },
    repairs: { total: repairs.length, ...count(repairs.map((r) => r.verdict)) },
    activeJudge: active.length ? {
      turns: active.length,
      resolutions: count(active.map((r) => r.resolution)),
      decisionActions: count(active.map((r) => r.decisionAction).filter(Boolean)),
      lunaActions: count(active.map((r) => r.lunaAction).filter(Boolean)),
      decisionDiffersFromLuna: active.filter((r) => r.decisionAction && r.decisionAction !== r.lunaAction).length,
      latencyMs: { median: quantile(active.map((r) => r.latencyMs).filter(Number.isFinite), 0.5), p90: quantile(active.map((r) => r.latencyMs).filter(Number.isFinite), 0.9) },
      costUsd: active.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0),
    } : null,
    lunaRequests: { total: (record.requests ?? []).length, errors: (record.requests ?? []).filter((r) => r.status === "error").length,
      latencyMs: { median: quantile((record.requests ?? []).map((r) => r.latencyMs).filter(Number.isFinite), 0.5) } },
    supersededAttempts: attempts.filter((a) => a.status !== "staged" && a.status !== "committed").length,
    finalMismatches,
  };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("usage: e2e-active-report.mjs <completed v2 record.json>");
  let record;
  try { record = JSON.parse(await readFile(resolve(path), "utf8")); } catch { throw new Error("invalid_record"); }
  console.log(JSON.stringify(summarizeSession(record), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error("e2e-active-report: " + (error?.message ?? "failed")); process.exitCode = 1; });
}
