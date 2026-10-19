// Markdown reports for a shadow run. Both contain counts, ids and seq numbers
// only, never utterance text. The sanitized one also drops per-turn rows and is
// what may go into a PR.
import type { ShadowRun } from "./run.ts";

type InputCounts = { casesRead: number; casesInvalid: number; failuresRead: number; failuresInvalid: number };
const j = (value: unknown) => "`" + JSON.stringify(value) + "`";
type Block = ShadowRun["cases"]["bySplit"][string]["headline"];
const brief = (b: Block) => ({ cases: b.cases, errors: b.errors, targetScored: b.target.scored, targetAgreement: b.target.agreement,
  nameScored: b.name.scored, nameAgreement: b.name.agreement, nameRecall: b.name.recall, namePrecision: b.name.precision, riskFlagFalsePositiveRate: b.riskFlagFalsePositiveRate,
  riskFlagRecall: b.riskFlagRecall, verdictUnknownRate: b.verdictUnknownRate });

const CAVEATS = [
  "Thresholds and flag rules are fixed heuristics and **uncalibrated**. Jev scores are relative/action scores, not the probability that a target is correct.",
  "The old judge's action probabilities/confidence are not used as P(correct target).",
  "Gold for historical cases comes from annotation labels: a blank label is not \"no misalignment\", a11 agreement does not confirm the same referent, and ER1 is not independent correctness.",
  "\"Flags outside the known-failure list\" are not confirmed false positives, because the list is not exhaustive.",
  "The shadow is default OFF and research-only. It never changes a dialogue, a strategy, scoring or a participant view.",
];

function header(run: ShadowRun, input: InputCounts) {
  const m = run.meta;
  const live = m.client !== "mock";
  return [
    `- Client: **${m.client}**${live ? "" : " (in-process lexical stand-in, not a model, so verdicts carry no evidential weight)"}`,
    `- Models used: ${m.models.length ? m.models.join(", ") : "none"}; criteria versions ${j(m.criteriaVersions)}; gold versions ${j(run.cases.goldVersions)}`,
    `- Calls: ${m.calls.total}${m.maxCalls !== null ? ` of budget ${m.maxCalls}` : ""} (ok ${m.calls.ok}, failed ${m.calls.failed}) ${j(m.calls.failureCodes)}${m.stopped ? `; stopped early: ${m.stopped}` : ""}`,
    `- Latency ms: ${j(m.calls.latencyMs)}; tokens in/out ${m.calls.inputTokens}/${m.calls.outputTokens}; cost USD ${m.calls.costUsd ?? "not reported by every call"}`,
    `- Session: strategy ${m.strategy ?? "?"}, task outcome ${j(m.taskOutcome)}`,
    `- Inputs: cases read ${input.casesRead} (invalid ${input.casesInvalid}), known failures read ${input.failuresRead} (invalid ${input.failuresInvalid})`,
  ];
}

function replay(run: ShadowRun) {
  const t = run.turns, k = t.knownFailures, ra = run.recordAudit;
  if (!ra) return ["## AI-session replay", "- Not run (live runs use synthetic cases only).", ""];
  return [
    "## AI-session replay",
    `- AI replies replayed: ${t.aiTurns}; judged ${t.judged}; errors ${j(t.errors)}`,
    `- Verdicts: target ${j(t.verdictDistribution.target)}; name ${j(t.verdictDistribution.name)}`,
    `- Old actions: ${j(t.oldActions)}`,
    `- Old reply behaviours: ${j(t.behaviourCounts)}`,
    `- Shadow flags: ${j(t.flagCounts)} on ${t.flaggedTurns} turns`,
    `- Reviewed turns: ${k.reviewed}; with a public-text failure tag: ${k.total}; judged ${k.judged}; detected (any flag) ${k.detectedAnyFlag}; detected (matching tag) ${k.detectedTagMatch}; rate (any) ${k.detectionRateAnyFlag ?? "n/a"}${k.missingFromReplay.length ? `; not in the replay: ${j(k.missingFromReplay)}` : ""}`,
    `- Detected known-failure seqs: ${j(k.perFailure.filter((d) => d.anyFlag).map((d) => d.aiSeq))}; missed: ${j(k.perFailure.filter((d) => !d.anyFlag).map((d) => d.aiSeq))}`,
    `- Per tag: ${j(k.perTag)}`,
    `- Flag rules fed the reviewer's gold axes (rule ceiling, no judge): ${j(t.goldVerdictCeiling)}`,
    `- Offline-only tags (not in the denominator): ${j(k.otherTags.map((o) => ({ seq: o.aiSeq, tags: o.otherTags, flagged: o.flags.length > 0 })))}`,
    `- Flags on reviewed turns with no failure tag (provisional false positives): ${j(t.flagsOnReviewedNegatives)}`,
    `- Flags outside the reviewed list: ${t.flagsOutsideKnownList.turns} turns`,
    `- Agree turns vs offline key: ${j(t.agreeTurnsOffline)}`,
    "",
    "## Record audit",
    `- Record: events ${ra.events}, seq gaps ${j(ra.seqGaps)}, duplicate seqs ${j(ra.duplicateSeqs)}, replies without judgment ${j(ra.repliesWithoutJudgment)}, unpaired judgments ${ra.unpairedJudgments}`,
    `- Judge-input leakage: future turns ${j(ra.futureTurnLeaks)}, answer-key ids ${j(ra.answerKeyLeaks)}`,
    "",
  ];
}

function common(run: ShadowRun) {
  const ca = run.caseAudit;
  return [
    ...replay(run),
    "## Case audit",
    `- Cases: ${ca.cases}; duplicate ids ${ca.duplicateCaseIds}; groups in several splits ${ca.groupsInSeveralSplits}; focal out of range ${ca.focalOutOfRange}; turns after focal ${ca.turnsAfterFocal}; historical marked sendable ${ca.historicalMarkedSendable}; sendable ${ca.sendable}`,
    `- Case sources ${j(ca.bySource)}, splits ${j(ca.bySplit)}, label quality ${j(ca.byLabelQuality)}, correctness known ${ca.correctnessKnown}`,
    `- Gold distribution: target ${j(ca.goldTarget)}; name ${j(ca.goldName)}; label basis ${j(ca.labelBasis)}`,
    "",
    "## Labelled cases (agreement with provisional gold)",
    "Headline rows exclude weak gold per axis (`axisQuality`, else `labelQuality`); per-quality rows (also per axis) follow. A case's target and name can fall under different qualities. Risk-flag rates use the target axis.",
    ...Object.entries(run.cases.bySplit).flatMap(([split, s]) => [
      `- ${split} (headline, non-weak): ${j(brief(s.headline))}`,
      ...Object.entries(s.byQuality).map(([q, b]) => `  - ${q}: ${j(brief(b))}`)]),
    ...Object.entries(run.cases.allSplits).map(([q, b]) => `- all splits, ${q}: ${j(brief(b))}`),
    `- Name-axis errors involving no_name (gold or verdict): ${j(run.cases.noNameErrors.map((e) => [e.caseId, e.split, e.gold, e.verdict]))}`,
    `- Probe replies (synthetic, gold by construction): ${j(run.cases.probes)}`,
    `- Repeat stability (identical input, both axes equal): ${j(run.cases.repeatStability)}`,
    "",
    "## Caveats",
    ...CAVEATS.map((c) => "- " + c),
  ];
}

export function privateMarkdown(run: ShadowRun, input: InputCounts): string {
  const rows = run.turnResults.map((r) =>
    `| ${r.aiSeq} | ${r.oldAction ?? ""} | ${r.behaviours.join(" ")} | ${r.verdict ? r.verdict.target + "/" + r.verdict.name : r.error} | ${r.flags.join(" ")} | ${r.agreedSlotMatched ?? ""} |`);
  return ["# Jev 2-axis shadow run (private)", "", ...header(run, input), "", ...common(run), "",
    "## Per-turn (no text)", "", "| seq | old action | behaviours | verdict | flags | agreed slot matched |", "|---|---|---|---|---|---|", ...rows,
    "", "## Behaviour × verdict", "", "```json", JSON.stringify(run.turns.behaviourUnderVerdict, null, 2), "```",
    "", "## Case confusion matrices", "", "```json", JSON.stringify(run.cases.bySplit, null, 2), "```", ""].join("\n");
}

export function sanitizedMarkdown(run: ShadowRun, input: InputCounts): string {
  return ["# Jev 2-axis shadow run: sanitized summary", "", "Aggregates only. No utterance text, no answer key, no case content.", "",
    ...header(run, input), "", ...common(run), ""].join("\n");
}
