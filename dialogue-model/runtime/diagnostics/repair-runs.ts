// RESEARCHER ONLY, no network, no answer key. Classifies Jev clarification
// turns in private run records, read-only, and prints aggregate counts only
// (never utterances, claim texts, issue ids, slot ids or names).
// node repair-runs.ts --scan <private-runs dir> | --record <file> [...]
// A run is consecutive executed repair/confirm/revisit turns on one recorded
// issue; it does not prove the same meaning or failure. Progress labels are the
// program's own (decision 0002); the split by candidate set and the Jev prospect
// cross-tab describe them, not ground truth. A changed label is kept even with
// missingReasons; unknown_missing is unknown progress with non-empty reasons.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const STRATEGIES = Object.freeze(["repair-first", "bypass-enabled"]);
const CLARIFY = new Set(["repair", "confirm", "revisit"]);
// Descriptive proxy, not a count of wrong decisions or SSOT violations: the
// prospect is a forward-looking expectation with one main basis, while README
// defines progress after the reply (new information or narrowing; repetition or
// difficulty is stagnation). Widening and "none" are left out, not deemed consistent.
const DISCORDANT = new Set(["progressing|repetition", "progressing|partner_uncertain", "stalled|new_information", "stalled|candidate_narrowed"]);

type Counts = Record<string, number>;
const bump = (counts: Counts, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const isPlain = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const emptyProgress = () => ({ changed_narrowed: 0, changed_same_candidates: 0, changed_widened_or_shifted: 0, unchanged: 0, unknown_missing: 0, unknown: 0 });

export type RepairRunSummary = {
  clarificationSteps: number;
  runs: { lengths: { "1": number; "2": number; "3+": number }; longest: number; issueSwitches: number };
  progress: ReturnType<typeof emptyProgress>;
  prospect: Counts; prospectDiscordant: number; programVsProspect: Counts;
  originalActions: Counts; dispositions: Counts;
};

export function conditionKey(record: any): string {
  const options = isPlain(record?.options) ? record.options : {};
  const rotation = options.rotationMode ?? record?.stimulus?.rotationMode ?? "unrecorded";
  const trial = isPlain(options.technicalTrial) && typeof options.technicalTrial.version === "string" ? options.technicalTrial.version : "none";
  return `${record.strategy}|rotation=${rotation}|trial=${trial}`;
}

function progressKind(entry: any): keyof ReturnType<typeof emptyProgress> {
  if (entry.progress === "unchanged") return "unchanged";
  if (entry.progress !== "changed") return Array.isArray(entry.missingReasons) && entry.missingReasons.length ? "unknown_missing" : "unknown";
  const before: string[] = entry.candidatesBefore ?? [], after: string[] = entry.candidatesAfter ?? [];
  if (after.length && after.every(id => before.includes(id))) return after.length < new Set(before).size ? "changed_narrowed" : "changed_same_candidates";
  return "changed_widened_or_shifted";
}

/** Null for anything that is not a Jev run record. */
export function repairRunSummary(record: unknown): RepairRunSummary | null {
  if (!isPlain(record) || !STRATEGIES.includes(record.strategy) || !Array.isArray(record.jevTraces) || !record.jevTraces.length) return null;
  const traces = record.jevTraces.filter(isPlain);
  // Later turns settle earlier entries, so the final trace's history is authoritative.
  const history: any[] = (traces.at(-1)?.repairHistory ?? []).filter(isPlain);
  const byTurn = new Map(history.map(entry => [entry.turn, entry]));
  const summary: RepairRunSummary = { clarificationSteps: 0, runs: { lengths: { "1": 0, "2": 0, "3+": 0 }, longest: 0, issueSwitches: 0 },
    progress: emptyProgress(), prospect: {}, prospectDiscordant: 0, programVsProspect: {}, originalActions: {}, dispositions: {} };
  const close = (length: number) => {
    if (!length) return;
    summary.runs.lengths[length >= 3 ? "3+" : String(length) as "1" | "2"]++;
    summary.runs.longest = Math.max(summary.runs.longest, length);
  };
  let run = 0, issue: string | null = null;
  for (const trace of traces) {
    const action = trace.executed?.action ?? trace.finalAction?.action;
    const entry = byTurn.get(trace.turnIndex);
    if (CLARIFY.has(action) && entry) {
      summary.clarificationSteps++;
      const next = typeof entry.issueId === "string" ? entry.issueId : null;
      if (run && next !== null && next === issue) run++;
      else { if (run && issue !== null && next !== null) summary.runs.issueSwitches++; close(run); run = 1; }
      issue = next;
    } else { close(run); run = 0; issue = null; }
    const prospect = trace.repairProspect;
    if (isPlain(prospect) && prospect.status === "ok") {
      const key = `${prospect.prospect}|${prospect.basis}`;
      bump(summary.prospect, key);
      if (DISCORDANT.has(key)) summary.prospectDiscordant++;
      const settled = prospect.issue?.choice === "issue" ? byTurn.get(prospect.issue.turn) : undefined;
      if (settled) bump(summary.programVsProspect, `${settled.progress}|${prospect.prospect}`);
    }
    const intervention = trace.intervention;
    if (isPlain(intervention)) {
      if (typeof intervention.original?.action === "string") bump(summary.originalActions, intervention.original.action);
      if (typeof intervention.disposition === "string") bump(summary.dispositions, intervention.disposition);
    }
  }
  close(run);
  for (const entry of history) summary.progress[progressKind(entry)]++;
  return summary;
}

const add = (into: Counts, from: Counts) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v; };

/** Sums per strategy × rotation mode × technical trial version. */
export function aggregateRepairRuns(records: readonly unknown[]) {
  const groups: Record<string, RepairRunSummary & { records: number }> = {};
  let skipped = 0;
  for (const record of records) {
    const s = repairRunSummary(record);
    if (!s) { skipped++; continue; }
    const key = conditionKey(record);
    const g = groups[key] ??= { records: 0, clarificationSteps: 0, runs: { lengths: { "1": 0, "2": 0, "3+": 0 }, longest: 0, issueSwitches: 0 },
      progress: emptyProgress(), prospect: {}, prospectDiscordant: 0, programVsProspect: {}, originalActions: {}, dispositions: {} };
    g.records++;
    g.clarificationSteps += s.clarificationSteps;
    add(g.runs.lengths, s.runs.lengths);
    g.runs.longest = Math.max(g.runs.longest, s.runs.longest);
    g.runs.issueSwitches += s.runs.issueSwitches;
    add(g.progress, s.progress);
    add(g.prospect, s.prospect);
    g.prospectDiscordant += s.prospectDiscordant;
    add(g.programVsProspect, s.programVsProspect);
    add(g.originalActions, s.originalActions);
    add(g.dispositions, s.dispositions);
  }
  return { records: records.length - skipped, skipped, groups: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) };
}

function recordFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return recordFiles(path);
    return basename(name).startsWith("record") && name.endsWith(".json") ? [path] : [];
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { scan: { type: "string", multiple: true }, record: { type: "string", multiple: true } } });
  const files = [...(values.scan ?? []).flatMap(dir => recordFiles(resolve(dir))), ...(values.record ?? []).map(file => resolve(file))];
  if (!files.length) throw new Error("--scan <dir> or --record <file> is required");
  const records = files.map(file => {
    // Unreadable files are skipped without echoing their content.
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  });
  console.log(JSON.stringify(aggregateRepairRuns(records), null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("repair-runs failed"); process.exitCode = 1; });
}
