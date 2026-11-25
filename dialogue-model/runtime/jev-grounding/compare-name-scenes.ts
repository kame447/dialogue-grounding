#!/usr/bin/env node
// Researcher-only, offline, no model calls. Compares reader name-state scenes
// with label-only proxies and prints counts only (no text).
//
// node dialogue-model/runtime/jev-grounding/compare-name-scenes.ts \
//   --historical <utterances.jsonl> --scenes <name-scenes.json>
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Split } from "./evalcase.ts";
import type { HistoricalRow } from "./labels.ts";
import { labelRows } from "./labels.ts";
import type { NameScene } from "./name-scenes.ts";
import { compareScenes, validateScene } from "./name-scenes.ts";
import { assignSplits } from "./split.ts";

export async function run(historicalPath: string, scenesPath: string) {
  const rows = (await readFile(historicalPath, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as HistoricalRow);
  const scenes = JSON.parse(await readFile(scenesPath, "utf8")) as NameScene[];
  const bad = scenes.flatMap((s, i) => validateScene(s).map((e) => `scene[${i}].${e}`));
  if (bad.length) throw new Error(`invalid scenes: ${bad.slice(0, 5).join(", ")}`);
  const labeled = labelRows(rows);
  const splits = assignSplits([...labeled.keys()]);
  const split = (key: string): Split => splits.get(key) ?? "train";
  return {
    splits: Object.fromEntries(splits),
    all: compareScenes(scenes, labeled, split),
    highNonBorderline: compareScenes(scenes, labeled, split, { minConfidence: "high", excludeBorderline: true }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { historical: { type: "string" }, scenes: { type: "string" } } });
  if (!values.historical || !values.scenes) {
    process.stderr.write("compare-name-scenes: --historical and --scenes are required\n");
    process.exitCode = 1;
  } else {
    run(values.historical, values.scenes).then((result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
      .catch((error: unknown) => {
        process.stderr.write(`compare-name-scenes: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
