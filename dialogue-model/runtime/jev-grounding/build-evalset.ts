#!/usr/bin/env node
// Researcher-only, offline, no model calls. Builds the grounding eval set from
// private inputs and writes it to a private directory outside the repository
// (directory 0700, files 0600). Prints counts only, never utterance text.
//
// node dialogue-model/runtime/jev-grounding/build-evalset.ts \
//   --historical <utterances.jsonl> [--record <trial.json> --ai-annotations <annotations.json>] \
//   --out <private dir> [--procedural H1:E0 ...]
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { GroundingEvalCase, Split } from "./evalcase.ts";
import { validateEvalCase } from "./evalcase.ts";
import type { HistoricalRow } from "./labels.ts";
import { distribution, labelRows } from "./labels.ts";
import { buildHistoricalCases, DERIVE_RULESET } from "./derive.ts";
import { renderSkeleton, SKELETON_VERSION } from "./skeleton.ts";
import { assignSplits, findLeakage, leaveOneDialogueOut, SPLIT_VERSION } from "./split.ts";
import { goldCounts } from "./metrics.ts";
import type { SessionRecord, TurnAnnotation } from "./ai-session.ts";
import { buildAiTurnCases, validateAnnotation } from "./ai-session.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function insideRepo(path: string, root: string = REPO_ROOT): boolean {
  const rel = relative(root, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

function jsonl(items: readonly unknown[]): string {
  return items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : "");
}

export interface BuildResult {
  historical: GroundingEvalCase[];
  skeleton: GroundingEvalCase[];
  aiTurns: GroundingEvalCase[];
  splits: Record<string, Split>;
  distributions: Record<string, ReturnType<typeof distribution>>;
}

export function buildAll(rows: readonly HistoricalRow[], options: {
  procedural?: readonly string[]; record?: SessionRecord; annotations?: readonly TurnAnnotation[]; aiSplit?: Split;
}): BuildResult {
  const labeled = labelRows(rows);
  const splitMap = assignSplits([...labeled.keys()]);
  const split = (key: string): Split => splitMap.get(key) as Split;
  const historical: GroundingEvalCase[] = [];
  const skeleton: GroundingEvalCase[] = [];
  const distributions: BuildResult["distributions"] = {};
  for (const [key, dialogueRows] of labeled) {
    distributions[key] = distribution(dialogueRows);
    historical.push(...buildHistoricalCases(key, dialogueRows, { split, procedural: options.procedural }));
    // Skeletons: invented text only, never from the locked holdout. They are still
    // derived from historical label sequences, so they stay local (not sendable).
    if (split(key) !== "holdout") {
      skeleton.push(...buildHistoricalCases(key, dialogueRows, {
        split, procedural: options.procedural, render: renderSkeleton, source: "synthetic", externalModelAllowed: false,
      }).map((c) => ({ ...c, caseId: `SKEL-${c.caseId}`, labelBasis: [...c.labelBasis, `skeleton:${SKELETON_VERSION}`] })));
    }
  }
  distributions.all = distribution([...labeled.values()].flat());
  const aiTurns = options.record
    ? buildAiTurnCases(options.record, options.annotations ?? [], {
      // The researcher allows no dc72 session text to external models for now.
      dialogueKey: "AI1", split: options.aiSplit ?? "dev", externalModelAllowed: false,
    })
    : [];
  return { historical, skeleton, aiTurns, splits: Object.fromEntries(splitMap), distributions };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      historical: { type: "string" }, record: { type: "string" }, "ai-annotations": { type: "string" },
      out: { type: "string" }, procedural: { type: "string", multiple: true },
    },
  });
  if (!values.historical || !values.out) throw new Error("--historical and --out are required");
  if (insideRepo(values.out)) throw new Error("--out must be outside the repository");
  const historicalText = await readFile(values.historical, "utf8");
  const rows = historicalText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as HistoricalRow);
  let record: SessionRecord | undefined;
  let annotations: TurnAnnotation[] = [];
  const inputs: Record<string, string> = { historical: sha256(historicalText) };
  if (values.record) {
    const text = await readFile(values.record, "utf8");
    record = JSON.parse(text) as SessionRecord;
    inputs.record = sha256(text);
  }
  if (values["ai-annotations"]) {
    const text = await readFile(values["ai-annotations"], "utf8");
    annotations = JSON.parse(text) as TurnAnnotation[];
    inputs.aiAnnotations = sha256(text);
    const bad = annotations.flatMap((a, i) => validateAnnotation(a).map((e) => `annotation[${i}].${e}`));
    if (bad.length) throw new Error(`invalid annotations: ${bad.join(", ")}`);
  }
  const result = buildAll(rows, { procedural: values.procedural, record, annotations });
  const all = [...result.historical, ...result.skeleton, ...result.aiTurns];
  const invalid = all.flatMap((c) => validateEvalCase(c).map((e) => `${c.caseId}: ${e}`));
  if (invalid.length) throw new Error(`invalid cases: ${invalid.slice(0, 5).join("; ")}`);
  const leakage = findLeakage([...result.historical, ...result.aiTurns]);
  if (leakage.length) throw new Error(`leakage: ${leakage.join("; ")}`);

  await mkdir(values.out, { recursive: true, mode: 0o700 });
  await chmod(values.out, 0o700);
  const out = (name: string) => resolve(values.out as string, name);
  await writePrivate(out("historical-cases.private.jsonl"), jsonl(result.historical));
  await writePrivate(out("skeleton-cases.LOCAL-ONLY.jsonl"), jsonl(result.skeleton));
  await writePrivate(out("ai-turn-cases.private.jsonl"), jsonl(result.aiTurns));
  await writePrivate(out("ai-session-failures.jsonl"), jsonl(result.aiTurns.map((c) => ({
    aiTurnSeq: c.aiTurnSeq, caseId: c.caseId, aiAction: c.aiAction ?? null, tags: c.failureTags ?? [],
    basis: c.labelBasis, expected: c.expected, labelQuality: c.labelQuality, offlineCorrect: c.offlineCorrect ?? null,
  }))));
  const counts = goldCounts(all);
  const manifest = {
    builtAt: new Date().toISOString(),
    versions: { derive: DERIVE_RULESET, skeleton: SKELETON_VERSION, split: SPLIT_VERSION },
    inputs, procedural: values.procedural ?? [], splits: result.splits,
    leaveOneDialogueOut: leaveOneDialogueOut(Object.keys(result.splits)),
    caseCounts: { historical: result.historical.length, skeleton: result.skeleton.length, aiTurns: result.aiTurns.length },
  };
  await writePrivate(out("distributions.json"), JSON.stringify({ labels: result.distributions, gold: counts }, null, 2));
  await writePrivate(out("manifest.json"), JSON.stringify(manifest, null, 2));
  process.stdout.write(JSON.stringify({ splits: result.splits, caseCounts: manifest.caseCounts, gold: counts }, null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`build-evalset: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
