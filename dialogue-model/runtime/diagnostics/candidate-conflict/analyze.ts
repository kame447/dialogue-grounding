// RESEARCHER ONLY, no network. Aggregates replay rows against the held-out key
// and a private gold referent annotation (see ../candidate-conflict-score.ts).
// Prints aggregate counts only; never rows, texts or annotation contents.
// node analyze.ts --record S1=<run.json> --gold S1=<gold.json> --rows <replay.jsonl> --scores <scores.json>
import { fileURLToPath } from "node:url";
import { goldReferentsInAiSpace, scoreFeatureSplit } from "../candidate-conflict-score.ts";
import { normalizeName } from "../../scoring.mjs";
import { CASES } from "../../decisions-eval/cases.mjs";
import { parseArgs, labelled, readJson, readJsonl } from "./common.ts";

const frac = (a: number, b: number) => `${a}/${b}`;
const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

/** Rows of one condition from recorded runs (key + gold available). */
export function summarizeRecorded(rows: any[], records: Map<string, any>, golds: Map<string, any>, scores: Record<string, { fits: string[] }>) {
  const c = { n: 0, confirm: 0, retry: 0, fallback: 0, conflictErr: 0, nonDisc: 0, listed: 0, goldIn: 0, goldInN: 0, targetOk: 0, targetN: 0, agree: 0, agreeWrong: 0,
    scored: 0, fitSum: 0, all6: 0, fitsGold: 0, sep: 0, sepN: 0, splits: 0, splitsN: 0, claim: 0, claimN: 0, cand: 0, candOwn: 0, candAll: 0 };
  const actions: Record<string, number> = {}, conflictActions: Record<string, number> = {};
  for (const row of rows) {
    const [label, turnText] = row.id.split(":"); const turn = Number(turnText);
    const record = records.get(label), key = record.scoring.key, ids = Object.keys(key.ai);
    const gold = golds.get(label)?.get(turn) ?? null;
    const j = row.judgment, d = row.diagnostics, conflict = d.conflict ?? null;
    c.n++; bump(actions, j.action);
    if (j.action === "confirm") c.confirm++;
    if (d.attempts > 1) c.retry++;
    if (d.fallback) c.fallback++;
    if (d.conflictError || d.failures.some((f: string) => /conflict|discriminating/.test(f))) c.conflictErr++;
    if (d.nonDiscriminating) c.nonDisc++;
    if (j.targetSlot && gold?.aiId) { c.targetN++; if (j.targetSlot === gold.aiId) c.targetOk++; }
    if (j.action === "agree") {
      // Agreed name -> the partner's figure with that submitted name (key) vs the AI's figure.
      const before = record.judgments.find((entry: any) => entry.turnIndex === turn).ownLedgerBefore;
      const name = j.candidateName ?? before[j.targetSlot]?.name;
      const human = Object.entries(record.humanSubmission ?? {}).find(([, n]) => typeof n === "string" && name && normalizeName(n) === normalizeName(name));
      c.agree++;
      if (!human || key.human[human[0]] !== key.ai[j.targetSlot]) c.agreeWrong++;
    }
    if (conflict?.candidates.length) {
      c.listed++; bump(conflictActions, j.action);
      const listed = conflict.candidates.map((x: any) => x.id);
      if (gold?.aiId) { c.goldInN++; if (listed.includes(gold.aiId)) c.goldIn++; }
      for (const x of conflict.candidates) {
        const s = scores[x.feature]; if (!s) continue;
        c.cand++;
        const fit = listed.filter((id: string) => s.fits.includes(id));
        if (fit.length === 1 && fit[0] === x.id) c.candOwn++;
        if (fit.length === listed.length) c.candAll++;
      }
    }
    if (j.action === "confirm" && scores[j.discriminatingFeature]) {
      const s = scoreFeatureSplit({ scorerFits: scores[j.discriminatingFeature].fits, scoredIds: ids, targetSlot: j.targetSlot, gold, conflict });
      c.scored++; c.fitSum += s.fitCount;
      if (s.fitCount === ids.length) c.all6++;
      if (s.fitsGold) c.fitsGold++;
      if (s.separatesTargetFromGold !== null) { c.sepN++; if (s.separatesTargetFromGold) c.sep++; }
      if (s.splitsCandidates !== null) { c.splitsN++; if (s.splitsCandidates) c.splits++; }
      if (s.claimMatchesScorer !== null) { c.claimN++; if (s.claimMatchesScorer) c.claim++; }
    }
  }
  return { n: c.n, actions, confirm: frac(c.confirm, c.n), retry: frac(c.retry, c.n), fallback: frac(c.fallback, c.n),
    conflictBlockErrors: frac(c.conflictErr, c.n), nonDiscriminatingKept: frac(c.nonDisc, c.n), conflictsListed: c.listed, conflictActions,
    goldInCandidates: frac(c.goldIn, c.goldInN), targetMatchesGold: frac(c.targetOk, c.targetN), agreeWrongFigure: frac(c.agreeWrong, c.agree),
    confirmFeaturesScored: c.scored, meanFiguresFit: c.scored ? +(c.fitSum / c.scored).toFixed(2) : null, fitsAllFigures: frac(c.all6, c.scored),
    fitsGold: frac(c.fitsGold, c.scored), separatesTargetFromGold: frac(c.sep, c.sepN), splitsListedCandidates: frac(c.splits, c.splitsN),
    lunaFitClaimMatchesScorer: frac(c.claim, c.claimN), candidateFeatures: c.cand, candidateFeatureOnlyOwn: frac(c.candOwn, c.cand),
    candidateFeatureFitsAllListed: frac(c.candAll, c.cand) };
}

/** Synthetic rows have no gold referent: case labels only. */
export function summarizeSynthetic(rows: any[]) {
  const actions: Record<string, number> = {};
  let acceptable = 0, dangerous = 0, confirm = 0, listed = 0, retry = 0, fallback = 0;
  for (const row of rows) {
    const [base, strategy] = row.id.split(":");
    const c = CASES.find((entry: any) => entry.id === `${base}:${strategy}`);
    const a = row.judgment.action; bump(actions, a);
    if (c.acceptable.includes(a)) acceptable++;
    if (c.dangerous.includes(a)) dangerous++;
    if (a === "confirm") confirm++;
    if (row.diagnostics.conflict?.candidates.length) listed++;
    if (row.diagnostics.attempts > 1) retry++;
    if (row.diagnostics.fallback) fallback++;
  }
  return { n: rows.length, gold: "none", actions, acceptable: frac(acceptable, rows.length), dangerous: frac(dangerous, rows.length),
    confirm: frac(confirm, rows.length), conflictsListed: listed, retry: frac(retry, rows.length), fallback: frac(fallback, rows.length) };
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv, ["record", "gold", "rows", "scores"]);
  const records = new Map([...labelled(args, "record")].map(([label, path]) => [label, readJson(path)]));
  const golds = new Map([...labelled(args, "gold")].map(([label, path]) => [label, goldReferentsInAiSpace(readJson(path), records.get(label)?.scoring?.key)]));
  const scores = args.values.get("scores")?.[0] ? readJson(args.values.get("scores")![0]) : {};
  const rows = (args.values.get("rows") ?? []).flatMap((path) => readJsonl(path));
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const parts = row.id.split(":");
    const synthetic = !records.has(parts[0]);
    const name = synthetic ? `synthetic ${parts[1]} ${parts[2]}` : `${parts[0]} ${parts[2]} ${parts[3]}`;
    groups.set(name, [...(groups.get(name) ?? []), row]);
    if (!synthetic) { const all = `all-records ${parts[2]} ${parts[3]}`; groups.set(all, [...(groups.get(all) ?? []), row]); }
  }
  const summary = Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) =>
    [name, name.startsWith("synthetic") ? summarizeSynthetic(group) : summarizeRecorded(group, records, golds, scores)]));
  log(JSON.stringify(summary, null, 1));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
