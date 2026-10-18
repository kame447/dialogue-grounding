// RESEARCHER ONLY, no network. Tabulates judged actions by strategy across
// private run records, read-only, and prints aggregate counts only (never
// texts, names, ids or rows). Paths are arguments; --out must be outside Git.
// node tabulate.ts --scan <private-runs dir> [--record <file>] [--out <dir outside repo>]
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "../../decisions-eval/cases.mjs";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";
import { classifyHumanTurn } from "./turn-type.ts";
import type { TurnType } from "./turn-type.ts";

export const STRATEGIES = Object.freeze(["repair-first", "bypass-enabled"]);
export const DEFER_LIKE = Object.freeze(["defer", "move_on", "revisit"]);
type Counts = Record<string, number>;
const bump = (counts: Counts, key: string | null | undefined, by = 1) => { if (key) counts[key] = (counts[key] ?? 0) + by; };
/** Private directory names never appear in output; only a short stable hash. */
export const familyKey = (family: string) => "family-" + createHash("sha256").update(family).digest("hex").slice(0, 8);
const isPlain = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export type Kind = "dialogue" | "pilot" | "decisions_rows" | "replay_rows";
/** Shape detection only; unknown shapes are skipped and counted. */
export function detect(value: unknown, file: string): Kind | null {
  if (Array.isArray(value)) {
    if (value.length && value.every((r) => isPlain(r) && typeof r.caseId === "string" && typeof r.purpose === "string")) return "decisions_rows";
    if (value.length && value.every((r) => isPlain(r) && typeof r.id === "string" && isPlain(r.judgment) && isPlain(r.diagnostics))) return "replay_rows";
    if (value.length && strategyFromName(file) && value.every((r) => isPlain(r) && (typeof r.action === "string" || typeof r.t1 === "string"))) return "pilot";
    return null;
  }
  if (!isPlain(value) || !STRATEGIES.includes(value.strategy)) return null;
  if (Array.isArray(value.judgments)) return "dialogue";
  if (Array.isArray(value.turns) && value.turns.every((t: any) => Array.isArray(t?.acts))) return "pilot";
  return null;
}
const strategyFromName = (file: string) => STRATEGIES.find((s) => basename(file).includes(s)) ?? null;

/** Human texts answered by each judgment, from public events (v2) or history (v1). */
export function humanTextsPerJudgment(record: any): string[][] {
  if (Array.isArray(record.events)) {
    return record.judgments.map((j: any, k: number) => {
      const after = k ? record.judgments[k - 1].turnIndex : 0;
      return record.events.filter((e: any) => e?.speaker === "human" && e.seq > after && e.seq <= j.turnIndex).map((e: any) => String(e.text ?? ""));
    });
  }
  const users = (record.publicHistory ?? []).filter((m: any) => m?.role === "user").map((m: any) => String(m.content ?? ""));
  return record.judgments.map((j: any) => users[j.turnIndex - 1] === undefined ? [] : [users[j.turnIndex - 1]]);
}

// Functional proxies: labels can understate bypassing (a switch can be a
// propose_name on a new target; a return can be a confirm on a deferred one).
type Functional = { switchAwayUnresolved: number; switchAfterHumanShift: number; returnToDeferred: number; returnLabelledRevisit: number };
type StrategyTable = { records: number; turns: number; luna: Counts; final: Counts; followUp: Counts; deferredLedgerTurns: number; functional: Functional;
  byTurnType: Record<string, { n: number; luna: Counts; final: Counts }>; families: Record<string, Counts> };
const emptyTable = (): StrategyTable => ({ records: 0, turns: 0, luna: {}, final: {}, followUp: {}, deferredLedgerTurns: 0,
  functional: { switchAwayUnresolved: 0, switchAfterHumanShift: 0, returnToDeferred: 0, returnLabelledRevisit: 0 }, byTurnType: {}, families: {} });

export function createTabulation() {
  const dialogue: Record<string, StrategyTable> = Object.fromEntries(STRATEGIES.map((s) => [s, emptyTable()]));
  const pilot: Record<string, Counts> = Object.fromEntries(STRATEGIES.map((s) => [s, {}]));
  const decisions: Record<string, { n: number; actions: Counts; deferLikeMass: number; byStratum: Record<string, Counts> }> = {};
  const replay: Record<string, { n: number; actions: Counts; byStratum: Record<string, Counts> }> = {};
  const skipped: Counts = {};
  const sources: Counts = {};

  function addDialogue(record: any, family: string) {
    const table = dialogue[record.strategy];
    table.records++;
    const texts = humanTextsPerJudgment(record);
    let previousTarget: string | null = null;
    record.judgments.forEach((j: any, k: number) => {
      const final = j?.judgment?.action;
      if (typeof final !== "string") return;
      const luna = typeof j.activeJudge?.lunaAction === "string" ? j.activeJudge.lunaAction : final;
      const type: TurnType = classifyHumanTurn(texts[k] ?? []);
      table.turns++; bump(table.luna, luna); bump(table.final, final); bump(table.followUp, j.judgment.followUp?.action);
      if (Object.values(j.ownLedgerBefore ?? {}).some((e: any) => e?.status === "deferred")) table.deferredLedgerTurns++;
      const target = typeof j.judgment.targetSlot === "string" ? j.judgment.targetSlot : null;
      const before = j.ownLedgerBefore ?? {};
      if (target && previousTarget && target !== previousTarget && before[previousTarget]?.status !== "agreed") {
        table.functional.switchAwayUnresolved++;
        if (type === "topic_shift") table.functional.switchAfterHumanShift++;
      }
      if (target && before[target]?.status === "deferred") {
        table.functional.returnToDeferred++;
        if (final === "revisit") table.functional.returnLabelledRevisit++;
      }
      if (target) previousTarget = target;
      const t = (table.byTurnType[type] ??= { n: 0, luna: {}, final: {} });
      t.n++; bump(t.luna, luna); bump(t.final, final);
      bump((table.families[familyKey(family)] ??= {}), final);
    });
  }
  function addPilot(value: any, file: string) {
    const strategy = isPlain(value) ? value.strategy : strategyFromName(file)!;
    const rows = isPlain(value) ? value.turns.flatMap((t: any) => t.acts.map((a: any) => a?.action)) :
      value.flatMap((r: any) => typeof r.action === "string" ? [r.action] : [r.t1, r.t2]);
    for (const action of rows) if (typeof action === "string") bump(pilot[strategy], action);
  }
  function caseOf(id: string) { return CASES.find((c: any) => c.id === id) ?? null; }
  function addDecisions(rows: any[]) {
    for (const row of rows) {
      const c = caseOf(row.caseId);
      if (!c || typeof row.action !== "string") { bump(skipped, "decisions_row_unmatched"); continue; }
      const key = `${row.purpose} ${c.strategy}`;
      const d = (decisions[key] ??= { n: 0, actions: {}, deferLikeMass: 0, byStratum: {} });
      d.n++; bump(d.actions, row.action); bump((d.byStratum[c.stratum] ??= {}), row.action);
      d.deferLikeMass += DEFER_LIKE.reduce((sum, a) => sum + (Number.isFinite(row.probabilities?.[a]) ? row.probabilities[a] : 0), 0);
    }
  }
  function addReplay(rows: any[]) {
    for (const row of rows) {
      const parts = row.id.split(":");
      const synthetic = parts[0].startsWith("synthetic-");
      const strategy = synthetic ? parts[1] : parts[2], cond = synthetic ? parts[2] : parts[3];
      if (!STRATEGIES.includes(strategy)) { bump(skipped, "replay_row_unmatched"); continue; }
      const key = `${synthetic ? "synthetic" : "recorded-prefix"} ${strategy} ${cond}`;
      const r = (replay[key] ??= { n: 0, actions: {}, byStratum: {} });
      r.n++; bump(r.actions, row.judgment.action);
      if (synthetic) bump((r.byStratum[caseOf(`${parts[0]}:${parts[1]}`)?.stratum ?? "unknown"] ??= {}), row.judgment.action);
    }
  }
  function add(value: unknown, file: string, family: string) {
    // Canned-response mock runs are not model behaviour.
    if (/mock/i.test(basename(file))) { bump(skipped, "mock"); return; }
    const kind = detect(value, file);
    if (!kind) { bump(skipped, "unrecognized"); return; }
    bump(sources, kind);
    if (kind === "dialogue") addDialogue(value, family);
    else if (kind === "pilot") addPilot(value, file);
    else if (kind === "decisions_rows") addDecisions(value as any[]);
    else addReplay(value as any[]);
  }
  function summary() {
    return { notice: "研究者専用の集計。実験結果・方略効果の証拠ではない。", sources, skipped, dialogue, pilot, decisions, replay };
  }
  return { add, summary };
}

function files(root: string): string[] {
  return statSync(root).isDirectory() ? readdirSync(root).sort().flatMap((name) => files(join(root, name))) : /\.jsonl?$/.test(root) ? [root] : [];
}
function load(file: string): unknown {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return JSON.parse(text);
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const scans: string[] = [], records: string[] = [];
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value || value.startsWith("--")) throw new Error("invalid_arguments");
    if (flag === "--scan") scans.push(value); else if (flag === "--record") records.push(value);
    else if (flag === "--out") out = value; else throw new Error("invalid_arguments");
  }
  const outDir = out === null ? null : await outsideRepositoryDirectory(out);
  const tab = createTabulation();
  for (const root of scans) for (const file of files(root)) {
    try { tab.add(load(file), file, relative(root, dirname(file)).split("/")[0] || "."); } catch { tab.add(undefined, file, ""); }
  }
  for (const file of records) {
    try { tab.add(load(file), file, basename(dirname(file))); } catch { tab.add(undefined, file, ""); }
  }
  const summary = tab.summary();
  if (outDir) writeFileSync(join(outDir, "strategy-difference-summary.json"), JSON.stringify(summary, null, 1));
  log(JSON.stringify(summary, null, 1));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; });
