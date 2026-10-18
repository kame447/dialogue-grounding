// RESEARCHER ONLY. Judge-only prefix replay: default vs candidateConflict opt-in,
// same inputs. Model input = own image + own anchors + public prefix + own notes.
// The key, gold and the partner's board are never read here.
// Dry run (default): node replay.ts --record S1=<run.json> [--strategies S1=repair-first,bypass-enabled]
//   [--synthetic synthetic-011,synthetic-012 --seed 137]
// Live: add --live --cap <maxLunaCalls> --out <dir outside repo>; rerunning resumes by row id.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLunaJudge } from "../../judgment/luna.mjs";
import { createTrialV2, modelView } from "../../stimuli/scatter-v2.mjs";
import { eventsToHistory } from "../../v2/dialogue-v2.mjs";
import { CASES, OWN_IDS } from "../../decisions-eval/cases.mjs";
import { loadConfig } from "../../config.mjs";
import { createChatClient } from "../../client.mjs";
import { parseArgs, outputDirectory, labelled, readJson, readJsonl, appendJsonl, cappedClient, publicPrefix, ownHistoryBefore } from "./common.ts";
import type { PublicEvent } from "./common.ts";

// Recorded values are untyped JSON; the judge validates them at run time.
export type ReplayJob = { id: string; events: PublicEvent[]; ownLedger: any; ownJudgmentHistory: any[]; strategy: any;
  candidateConflict: boolean; seed: number; idMap: string[] | null };
export const OUTPUT_FILE = "replay.jsonl";

export function recordJobs(label: string, record: any, strategies: string[]): ReplayJob[] {
  return record.judgments.flatMap((j: any, k: number) => strategies.flatMap((strategy) => [false, true].map((candidateConflict) => ({
    id: `${label}:${j.turnIndex}:${strategy}:${candidateConflict ? "opt" : "def"}`, events: publicPrefix(record, j.turnIndex),
    ownLedger: j.ownLedgerBefore, ownJudgmentHistory: ownHistoryBefore(record, k), strategy, candidateConflict, seed: record.seed, idMap: null }))));
}

/** Synthetic cases get the seed's own board; case ids replace anchor ids in board order. */
export function syntheticJobs(baseIds: string[], seed: number): ReplayJob[] {
  return CASES.filter((c: any) => baseIds.includes(c.baseId)).flatMap((c: any) => [false, true].map((candidateConflict) => ({
    id: `${c.id}:${candidateConflict ? "opt" : "def"}`, events: c.events.map((e: any, i: number) => ({ seq: i + 1, speaker: e.speaker, text: e.text })),
    ownLedger: c.ownLedger, ownJudgmentHistory: [], strategy: c.strategy, candidateConflict, seed, idMap: [...OWN_IDS] })));
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv, ["record", "strategies", "synthetic", "seed"]);
  const out = await outputDirectory(args);
  const strategies = labelled(args, "strategies");
  const jobs: ReplayJob[] = [];
  for (const [label, path] of labelled(args, "record")) {
    jobs.push(...recordJobs(label, readJson(path), (strategies.get(label) ?? "repair-first").split(",")));
  }
  const synthetic = args.values.get("synthetic")?.join(",").split(",").filter(Boolean) ?? [];
  if (synthetic.length) {
    const seed = Number(args.values.get("seed")?.[0]);
    if (!Number.isSafeInteger(seed)) throw new Error("seed_required");
    jobs.push(...syntheticJobs(synthetic, seed));
  }
  const done = new Set(out ? readJsonl(join(out, OUTPUT_FILE)).map((row) => row.id) : []);
  const todo = jobs.filter((job) => !done.has(job.id));
  log(JSON.stringify({ mode: args.live ? "live" : "dry-run", jobs: jobs.length, todo: todo.length, maxLunaCalls: todo.length * 2, cap: args.cap }));
  if (!args.live || !out) return { jobs, todo };
  if (args.cap < 1) throw new Error("cap_required");
  const { client, usage } = cappedClient(createChatClient(loadConfig(process.env)), args.cap);
  const views = new Map<number, any>();
  const viewOf = (seed: number) => views.get(seed) ?? views.set(seed, modelView(createTrialV2({ seed }))).get(seed);
  const queue = [...todo];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const job = queue.shift()!;
      const view = viewOf(job.seed);
      const anchors = view.anchors.map((a: any, i: number) => job.idMap ? { ...a, id: job.idMap[i] } : a);
      const judge = createLunaJudge(client, job.candidateConflict ? { candidateConflict: true } : undefined);
      try {
        // JudgeInput's JSDoc predates the v2 fields (version, ownAnchors).
        const judgment = await judge.judge({ version: 2, image: { mimeType: view.mimeType, base64: view.png.toString("base64") }, ownAnchors: anchors,
          publicHistory: eventsToHistory(job.events), strategy: job.strategy, ownLedger: structuredClone(job.ownLedger), ownJudgmentHistory: job.ownJudgmentHistory } as any);
        appendJsonl(out, OUTPUT_FILE, { id: job.id, judgment, diagnostics: judge.getDiagnostics().at(-1) });
      } catch (error: any) {
        log(JSON.stringify({ id: job.id, error: error?.code ?? (error?.message === "call_cap_reached" ? "call_cap_reached" : "error") }));
        if (error?.message === "call_cap_reached") queue.length = 0;
      }
    }
  }));
  log(JSON.stringify(usage));
  return { jobs, todo, usage };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; });
