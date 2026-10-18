#!/usr/bin/env node
// RESEARCHER ONLY. Entry point for the rotation discrimination diagnostics.
//   offline                  geometry tables, no network
//   plan  [--bench ...]      dry-run request count, no network
//   live  --bench ... --out <dir outside the repository>
// Live runs go only through the research Worker (createChatClient(loadConfig())).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createChatClient } from "../../client.mjs";
import { loadConfig } from "../../config.mjs";
import { binomialTail, wilson } from "./bench-common.ts";
import type { ChatClient } from "./bench-common.ts";
import { FIGURE_IDS, pairwiseInvariant, rankPairs, seedAnalysis } from "./shape-similarity.ts";
import { planVerbal, runVerbalItem } from "./verbal-bench.ts";
import type { VerbalItem, VerbalResult } from "./verbal-bench.ts";
import { planVision, runVisionItem } from "./vision-bench.ts";
import type { VisionItem, VisionResult } from "./vision-bench.ts";

export const BENCHES = Object.freeze(["vision", "verbal"] as const);
export const CALL_BUDGET = 300;
export const OFFLINE_SEEDS = Object.freeze([40, 44, 137, ...Array.from({ length: 20 }, (_, i) => 1001 + i)]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** True only for paths that leave the repository ("..cache" stays inside). */
export function isOutsideRepository(path: string, root = REPO_ROOT): boolean {
  const rel = relative(root, resolve(path));
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

type Item = VisionItem | VerbalItem;
type Result = VisionResult | VerbalResult;

export function planAll(benches: readonly string[]): Item[] {
  return [...(benches.includes("vision") ? planVision() : []), ...(benches.includes("verbal") ? planVerbal() : [])];
}

export function offlineReport(seeds: readonly number[] = OFFLINE_SEEDS) {
  const pairs = rankPairs(pairwiseInvariant());
  const perSeed = seeds.map((seed) => seedAnalysis(seed));
  return { figures: FIGURE_IDS, pairs, perSeed };
}

/** Group results by named keys; rows carry chance level and Wilson 95% CI. */
export function summarize(results: readonly Result[], keyOf: (r: Result) => string, chance: (r: Result) => number) {
  const groups = new Map<string, Result[]>();
  for (const r of results) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => {
    const k = rows.filter((r) => r.correct).length, n = rows.length, p = chance(rows[0]);
    const [lo, hi] = wilson(k, n);
    return { key, correct: k, total: n, rate: n ? k / n : 0, ci95: [lo, hi], chance: p, pAboveChance: binomialTail(k, n, p),
      errors: rows.filter((r) => r.error).length };
  });
}

export function summarizeAll(results: readonly Result[]) {
  const chance = (r: Result) => (r.kind === "same_different" ? 0.5 : 1 / 6);
  const sd = results.filter((r) => r.kind === "same_different") as VisionResult[];
  const id = results.filter((r) => r.kind === "identify") as VisionResult[];
  const vb = results.filter((r) => r.kind === "verbal") as VerbalResult[];
  const it = (r: Result) => r.item as never as Record<string, unknown>;
  return {
    sameDifferent: {
      byPairTypeDelta: summarize(sd, (r) => `${it(r).pairType}@${it(r).delta}`, chance),
      byPairType: summarize(sd, (r) => String(it(r).pairType), chance),
      byDelta: summarize(sd, (r) => String(it(r).delta), chance),
    },
    identify: {
      byDelta: summarize(id, (r) => String(it(r).delta), chance),
      byTarget: summarize(id, (r) => String(it(r).target), chance),
      confusion: confusion(id.map((r) => ({ target: String(it(r).target), chosen: chosenFigure(r) }))),
    },
    verbal: {
      byViewStyle: summarize(vb, (r) => `${it(r).view}|${it(r).style}`, chance),
      byView: summarize(vb, (r) => String(it(r).view), chance),
      byTargetView: summarize(vb, (r) => `${it(r).target}|${it(r).view}`, chance),
      confusionRotated: confusion(vb.filter((r) => r.item.view === "rotated").map((r) => ({ target: r.item.target, chosen: chosenFigure(r) }))),
      confusionAligned: confusion(vb.filter((r) => r.item.view === "aligned").map((r) => ({ target: r.item.target, chosen: chosenFigure(r) }))),
    },
  };
}

function chosenFigure(r: Result): string {
  const board = (r.item as { board?: Array<{ figureId: string }> }).board;
  const slots = ["上段左", "上段中", "上段右", "下段左", "下段中", "下段右"];
  const index = slots.indexOf(String(r.answer));
  return board && index >= 0 ? board[index].figureId : "none";
}

/** Target (row) x chosen figure (column) counts. */
export function confusion(rows: ReadonlyArray<{ target: string; chosen: string }>) {
  const columns = [...FIGURE_IDS, "none"];
  return Object.fromEntries(FIGURE_IDS.map((t) => [t, Object.fromEntries(columns.map((c) => [c, rows.filter((r) => r.target === t && r.chosen === c).length]))]));
}

async function runAll(client: ChatClient, items: readonly Item[], concurrency: number, onResult: (r: Result) => void): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++, item = items[index];
      results[index] = item.kind === "verbal" ? await runVerbalItem(client, item) : await runVisionItem(client, item);
      onResult(results[index]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command = "plan", ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    bench: { type: "string", default: BENCHES.join(",") },
    out: { type: "string" },
    concurrency: { type: "string", default: "3" },
    seeds: { type: "string" },
  } });
  const benches = values.bench!.split(",");
  if (!benches.every((b) => (BENCHES as readonly string[]).includes(b))) throw new Error("Unknown bench");
  if (command === "offline") {
    const seeds = values.seeds ? values.seeds.split(",").map(Number) : OFFLINE_SEEDS;
    if (!seeds.every(Number.isSafeInteger)) throw new Error("--seeds must be integers");
    console.log(JSON.stringify(offlineReport(seeds), null, 1));
    return;
  }
  const items = planAll(benches);
  const counts = Object.fromEntries(["same_different", "identify", "verbal"].map((k) => [k, items.filter((i) => i.kind === k).length]));
  if (command === "plan") {
    console.log(JSON.stringify({ dryRun: true, requests: items.length, budget: CALL_BUDGET, counts }));
    return;
  }
  if (command !== "live") throw new Error("Command must be offline, plan or live");
  if (items.length > CALL_BUDGET) throw new Error("Planned requests exceed the call budget");
  if (!values.out) throw new Error("--out is required for live runs");
  const out = resolve(values.out);
  if (!isOutsideRepository(out)) throw new Error("--out must be outside the repository");
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("--concurrency must be 1-4");
  const config = loadConfig(env);
  if (config.provider !== "cloudflare") throw new Error("Live runs must use the research Worker (RESEARCH_AI_PROVIDER=cloudflare)");
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let done = 0;
  const results = await runAll(createChatClient(config) as ChatClient, items, concurrency, () => {
    if (++done % 12 === 0) console.error(`progress ${done}/${items.length}`);
  });
  const summary = summarizeAll(results);
  writeFileSync(resolve(out, `results-${benches.join("+")}-${stamp}.json`), JSON.stringify({ requests: items.length, counts, results, summary }, null, 1));
  console.log(JSON.stringify({ requests: items.length, errors: results.filter((r) => r.error).length, summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || "Unexpected error");
    process.exitCode = 1;
  });
}
