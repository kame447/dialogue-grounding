// Side-by-side comparison of two shadow runs over the same case set (e.g. the
// 4-level grounding-criteria/v1 run and the 5-level v2 run). Ids and labels
// only, no text. Runs judged under different criteria or scored against
// different gold versions are compared, never pooled.
//
//   node dialogue-model/runtime/diagnostics/jev-shadow-eval/compare.ts \
//     --old <shadow-run.json> --new <shadow-run.json> --out <private dir>
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";

type Verdict = { target: string; name: string } | null;
type CaseRow = { caseId: string; split: string; expected: { target: string | null; name: string | null }; verdict: Verdict; goldVersion?: string | null };
type Block = { target: { agreement: number | null; scored: number }; name: { agreement: number | null; scored: number } };
export type RunLike = {
  meta?: { models?: string[]; criteriaVersions?: string[]; calls?: { total?: number; costUsd?: number | null } };
  cases?: { allSplits?: Record<string, Block>; bySplit?: Record<string, { byQuality?: Record<string, Block> }>; goldVersions?: Record<string, number> };
  caseResults?: CaseRow[];
};

const rate = (n: number, d: number) => d ? Math.round((n / d) * 1000) / 1000 : null;

function splitAgreement(run: RunLike) {
  const out: Record<string, { target: number | null; targetScored: number; name: number | null; nameScored: number }> = {};
  for (const [split, s] of Object.entries(run.cases?.bySplit ?? {})) {
    // Pool the quality rows: each case falls in exactly one quality per axis.
    let tN = 0, tS = 0, nN = 0, nS = 0;
    for (const b of Object.values(s.byQuality ?? {})) {
      tS += b.target.scored; tN += Math.round((b.target.agreement ?? 0) * b.target.scored);
      nS += b.name.scored; nN += Math.round((b.name.agreement ?? 0) * b.name.scored);
    }
    out[split] = { target: rate(tN, tS), targetScored: tS, name: rate(nN, nS), nameScored: nS };
  }
  return out;
}

export function compareRuns(oldRun: RunLike, newRun: RunLike) {
  const limits = [
    "The criteria differ: under v1, 'no name yet' counted as not_agreed (4 levels); v2 adds no_name (5 levels). Name agreement across runs measures the criterion change as much as the judge.",
    "The gold versions differ when the runs are scored against different gold; agreement is with each run's own gold.",
    "Split-level agreement pools every label quality (weak and derived): the v1 run was scored against weak synthetic gold v1, the v2 run against synthetic gold v3.",
    "Small synthetic set, author-made gold; rates are provisional.",
  ];
  const perCase: { caseId: string; split: string; old: Verdict; new: Verdict; gold: CaseRow["expected"] }[] = [];
  if (oldRun.caseResults && newRun.caseResults) {
    const byId = new Map(oldRun.caseResults.map((r) => [r.caseId, r]));
    for (const r of newRun.caseResults) {
      const o = byId.get(r.caseId);
      if (o) perCase.push({ caseId: r.caseId, split: r.split, old: o.verdict, new: r.verdict, gold: r.expected });
    }
  } else {
    limits.push("The old run did not keep per-case verdicts, so only split-level agreement can be compared, not individual cases.");
  }
  return {
    old: { models: oldRun.meta?.models ?? [], criteriaVersions: oldRun.meta?.criteriaVersions ?? ["unversioned (v1)"], goldVersions: oldRun.cases?.goldVersions ?? { unversioned: 0 },
      calls: oldRun.meta?.calls?.total ?? null, costUsd: oldRun.meta?.calls?.costUsd ?? null, bySplit: splitAgreement(oldRun) },
    new: { models: newRun.meta?.models ?? [], criteriaVersions: newRun.meta?.criteriaVersions ?? [], goldVersions: newRun.cases?.goldVersions ?? {},
      calls: newRun.meta?.calls?.total ?? null, costUsd: newRun.meta?.calls?.costUsd ?? null, bySplit: splitAgreement(newRun) },
    perCase: {
      compared: perCase.length,
      targetChanged: perCase.filter((c) => c.old && c.new && c.old.target !== c.new.target).map((c) => c.caseId),
      nameChanged: perCase.filter((c) => c.old && c.new && c.old.name !== c.new.name).map((c) => ({ caseId: c.caseId, old: c.old!.name, new: c.new!.name, gold: c.gold.name })),
    },
    limits,
  };
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error("usage: --old <run.json> --new <run.json> --out <dir>");
    a[argv[i].slice(2)] = argv[i + 1];
  }
  if (!a.old || !a.new || !a.out) throw new Error("--old, --new and --out are required");
  const out: string = await outsideRepositoryDirectory(resolve(a.out));
  const result = compareRuns(JSON.parse(readFileSync(resolve(a.old), "utf8")), JSON.parse(readFileSync(resolve(a.new), "utf8")));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = resolve(out, "shadow-compare.json");
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  log(JSON.stringify({ out: file, compared: result.perCase.compared }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error("jev-shadow-compare: " + (error instanceof Error ? error.message : "failed")); process.exitCode = 1; });
}
