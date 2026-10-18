#!/usr/bin/env node
// Researcher-only, offline. Reads persisted trial records (outside the repository)
// and prints aggregated numbers only: never utterance text, names, slot keys or
// figure identities. No model calls.
//
// Two separate paths:
// - dialogueMetrics(record) never reads the answer key or scoring and can be used
//   on live or unfinished trials. Its counts describe what the AI's typed judgments
//   and the public exchange looked like; they are not evidence of shared understanding.
// - outcomeMetrics(record) reads only scoring.result, and only for completed trials.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const ACTIONS = Object.freeze(["accept", "propose_name", "confirm", "repair", "defer", "revisit", "agree", "move_on", "close"]);

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
}

function lengthStats(lengths) {
  return { count: lengths.length, median: quantile(lengths, 0.5), p75: quantile(lengths, 0.75), p90: quantile(lengths, 0.9) };
}

/** Typed judgments of committed turns, main action first then followUp. */
function committedActs(record) {
  return (record.judgments ?? [])
    .filter((entry) => entry?.status === "committed" && entry.judgment)
    .flatMap((entry) => [entry.judgment, entry.judgment.followUp].filter((act) => act && ACTIONS.includes(act.action))
      .map((act) => ({ turn: entry.turnIndex, action: act.action, slot: act.targetSlot ?? null })));
}

function speakerRuns(history) {
  let runs = 0, previous = null;
  for (const message of history) {
    if (message.role !== previous) runs++;
    previous = message.role;
  }
  return runs;
}

// Accepts either a raw graph ({ records }) or a persisted snapshot
// ({ mentions, questions, ownSlots }) from snapshotReferenceGraph.
function referenceAmbiguity(graph) {
  const all = Array.isArray(graph?.records) ? graph.records
    : [...(graph?.mentions ?? []), ...(graph?.questions ?? []).map((q) => ({ kind: "question", ...q }))];
  const mentions = all.filter((record) => record.kind === "mention" && record.speaker === "human");
  const slots = graph?.ownSlots ? Object.values(graph.ownSlots) : [];
  return {
    humanMentions: mentions.length,
    unresolved: mentions.filter((m) => m.epistemic === "unresolved").length,
    multiCandidate: mentions.filter((m) => m.epistemic === "hypothesis" && m.slots.length > 1).length,
    grounded: mentions.filter((m) => m.epistemic === "grounded").length,
    openQuestions: all.filter((record) => record.kind === "question" && record.status === "open").length,
    namedSlots: slots.filter((s) => s?.candidate).length,
    explicitlyAgreedSlots: slots.filter((s) => s?.candidate?.agreement === "explicit").length,
  };
}

/** No-gold path: safe for live or unfinished trials. */
export function dialogueMetrics(record) {
  const history = Array.isArray(record.publicHistory) ? record.publicHistory : [];
  const human = history.filter((m) => m.role === "user").map((m) => [...m.content].length);
  const ai = history.filter((m) => m.role === "assistant").map((m) => [...m.content].length);
  const acts = committedActs(record);
  const actionCounts = Object.fromEntries(ACTIONS.map((action) => [action, acts.filter((a) => a.action === action).length]));

  const targeted = acts.filter((a) => a.slot !== null);
  let contextSwitches = 0;
  for (let i = 1; i < targeted.length; i++) if (targeted[i].slot !== targeted[i - 1].slot) contextSwitches++;

  // A confirmation cycle is a run of consecutive confirm acts on the same own slot.
  let longestConfirmRun = 0, confirmCycles = 0, run = 0;
  for (let i = 0; i < acts.length; i++) {
    const continues = acts[i].action === "confirm" && i > 0 && acts[i - 1].action === "confirm" && acts[i - 1].slot === acts[i].slot;
    run = acts[i].action === "confirm" ? (continues ? run + 1 : 1) : 0;
    if (run === 2) confirmCycles++;
    longestConfirmRun = Math.max(longestConfirmRun, run);
  }

  // Revisits of a slot the AI itself had deferred earlier.
  const deferred = new Set();
  let revisitedAfterDefer = 0;
  for (const act of acts) {
    if (act.action === "defer" && act.slot) deferred.add(act.slot);
    else if (act.slot && deferred.has(act.slot) && ["revisit", "confirm", "agree", "propose_name"].includes(act.action)) {
      revisitedAfterDefer++;
      deferred.delete(act.slot);
    }
  }

  const judgments = record.judgments ?? [];
  const ledger = record.ownLedger ?? {};
  const submission = record.aiSubmission ?? null;
  const ledgerFinalMismatch = submission
    ? Object.keys(submission).filter((slot) => (ledger[slot]?.name ?? "") !== (submission[slot] ?? "")).length
    : null;

  return {
    utterances: { human: lengthStats(human), ai: lengthStats(ai), total: history.length,
      speakerRunPairs: speakerRuns(history) / 2 },
    actionCounts,
    contextSwitches,
    confirmCycles,
    longestConfirmRun,
    revisitedAfterDefer,
    unresolvedDeferAtEnd: deferred.size,
    judgeFallbacks: judgments.filter((entry) => entry?.validation?.fallback === true).length,
    judgeRetries: judgments.filter((entry) => (entry?.validation?.attempts ?? 1) > 1).length,
    failedTurns: judgments.filter((entry) => entry?.status && entry.status !== "committed").length,
    ledgerFinalMismatch,
    referenceAmbiguity: record.referenceGraph ? referenceAmbiguity(record.referenceGraph) : null,
  };
}

/** Reads scoring only after the trial completed. */
export function outcomeMetrics(record) {
  if (record.status !== "completed") return null;
  const result = record.scoring?.result;
  if (!result || typeof result.matchedCount !== "number") return null;
  return { matchedCount: result.matchedCount, total: result.total ?? 6, success: result.success === true };
}

export function conditionOf(record) {
  const options = record.options ?? {};
  return [record.strategy ?? "unknown", "visualAid=" + (options.visualAid === true), "referenceMemory=" + (options.referenceMemory === true)].join("|");
}

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** Aggregate by condition; every strategy present in the input is kept. */
export function aggregate(records) {
  const groups = new Map();
  for (const record of records) {
    const key = conditionOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return Object.fromEntries([...groups.entries()].sort().map(([key, rows]) => {
    const dialogue = rows.map(dialogueMetrics);
    const outcomes = rows.map(outcomeMetrics).filter(Boolean);
    const pick = (fn) => dialogue.map(fn).filter((v) => typeof v === "number");
    return [key, {
      trials: rows.length,
      completed: outcomes.length,
      seeds: [...new Set(rows.map((r) => r.seed))].sort((a, b) => a - b),
      humanUtterances: { mean: mean(pick((d) => d.utterances.human.count)) },
      aiUtterances: { mean: mean(pick((d) => d.utterances.ai.count)) },
      humanCharsMedian: { mean: mean(pick((d) => d.utterances.human.median)) },
      aiCharsMedian: { mean: mean(pick((d) => d.utterances.ai.median)) },
      speakerRunPairs: { mean: mean(pick((d) => d.utterances.speakerRunPairs)) },
      actions: Object.fromEntries(ACTIONS.map((action) => [action, pick((d) => d.actionCounts[action]).reduce((a, b) => a + b, 0)])),
      contextSwitches: { mean: mean(pick((d) => d.contextSwitches)) },
      confirmCycles: pick((d) => d.confirmCycles).reduce((a, b) => a + b, 0),
      revisitedAfterDefer: pick((d) => d.revisitedAfterDefer).reduce((a, b) => a + b, 0),
      ledgerFinalMismatch: pick((d) => d.ledgerFinalMismatch).reduce((a, b) => a + b, 0),
      matchedCount: { mean: mean(outcomes.map((o) => o.matchedCount)), perTrial: outcomes.map((o) => o.matchedCount) },
      successes: outcomes.filter((o) => o.success).length,
    }];
  }));
}

export async function loadRecords(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const records = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (record && Array.isArray(record.publicHistory) && typeof record.strategy === "string") records.push(record);
    } catch {
      // Skip unreadable or non-trial files without echoing their content.
    }
  }
  return records;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { dir: { type: "string", multiple: true } } });
  if (!values.dir?.length) throw new Error("--dir <research run directory> is required");
  const records = (await Promise.all(values.dir.map((dir) => loadRecords(resolve(dir))))).flat();
  console.log(JSON.stringify({ records: records.length, conditions: aggregate(records) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || "Unexpected error");
    process.exitCode = 1;
  });
}
