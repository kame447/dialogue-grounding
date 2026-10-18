// Shadow comparison metrics. Flag rules are fixed, uncalibrated heuristics that
// say where the 2-axis verdict and the old reply disagree; an "unknown" or
// failed verdict abstains. Nothing here says a reply was correct.
import { classifyReply } from "./replay.ts";
import { NAME_LEVELS, TARGET_LEVELS } from "./types.ts";
import type { Behaviour, EvalCaseLike, FailureTag, JevAxesVerdict, KnownFailure, NameLevel, ReplayItem, TargetLevel } from "./types.ts";

export type ShadowFlag = Exclude<FailureTag, "wrong_target_agreement">;

/** Disagreements between the verdict (evidence before the reply) and the reply. */
export function shadowFlags(behaviours: readonly Behaviour[], verdict: Pick<JevAxesVerdict, "target" | "name"> | null): ShadowFlag[] {
  if (!verdict) return [];
  const flags: ShadowFlag[] = [];
  const has = (b: Behaviour) => behaviours.includes(b);
  const targetKnown = verdict.target !== "unknown";
  if (targetKnown && verdict.target !== "supported" && has("claims_understanding")) flags.push("unfounded_wakarimasu");
  // A unilateral naming decision ("…と呼びましょう") is both naming and an agreement claim.
  if (targetKnown && verdict.target !== "supported" && has("naming")) flags.push("early_naming");
  if (has("agreement") && (verdict.name === "not_agreed" || verdict.target === "contradicted" ||
      (verdict.name === "unclear" && targetKnown && verdict.target !== "supported"))) flags.push("contradictory_agreement");
  if (verdict.target === "supported" && verdict.name === "agreed" && has("confirmation") && !has("agreement")) flags.push("over_confirmation");
  return flags;
}

export type TurnResult = {
  aiSeq: number;
  oldAction: string | null;
  behaviours: Behaviour[];
  verdict: { target: TargetLevel; name: NameLevel } | null;
  error: string | null;
  flags: ShadowFlag[];
  /** Offline (scoring key) outcome of the slot an agree turn named; null otherwise. */
  agreedSlotMatched: boolean | null;
};

export function turnResult(item: ReplayItem, outcome: { verdict: JevAxesVerdict } | { error: string }, agreedSlotMatched: boolean | null): TurnResult {
  const behaviours = classifyReply(item.replyText, item.oldAction);
  const verdict = "verdict" in outcome ? { target: outcome.verdict.target, name: outcome.verdict.name } : null;
  return {
    aiSeq: item.aiSeq, oldAction: item.oldAction, behaviours, verdict,
    error: "error" in outcome ? outcome.error : null,
    flags: shadowFlags(behaviours, verdict),
    agreedSlotMatched: behaviours.includes("agreement") ? agreedSlotMatched : null,
  };
}

const countBy = <T extends string>(values: readonly T[]) => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};
const rate = (n: number, d: number) => d ? Math.round((n / d) * 1000) / 1000 : null;

export function summarizeTurns(results: readonly TurnResult[], known: readonly KnownFailure[]) {
  const judged = results.filter((r) => r.verdict);
  const bySeq = new Map(results.map((r) => [r.aiSeq, r]));
  const behaviourCounts = countBy(results.flatMap((r) => r.behaviours));
  const flagCounts = countBy(results.flatMap((r) => r.flags));
  const knownSeqs = new Set(known.map((k) => k.aiSeq));

  const tagged = known.filter((k) => k.tags.length);
  const detection = tagged.map((k) => {
    const r = bySeq.get(k.aiSeq);
    const anyFlag = !!r && r.flags.length > 0;
    const tagMatch = !!r && k.tags.some((t) => (r.flags as string[]).includes(t));
    return { aiSeq: k.aiSeq, tags: k.tags, basis: k.basis, judged: !!r?.verdict, anyFlag, tagMatch, flags: r?.flags ?? [] };
  });
  const missingKnown = known.filter((k) => !bySeq.has(k.aiSeq)).map((k) => k.aiSeq);
  // Reviewed turns without a public-text failure tag are provisional negatives.
  const untagged = known.filter((k) => !k.tags.length && bySeq.get(k.aiSeq)?.verdict);
  const untaggedFlagged = untagged.filter((k) => bySeq.get(k.aiSeq)!.flags.length);
  const otherTags = known.filter((k) => k.otherTags.length).map((k) => ({ aiSeq: k.aiSeq, otherTags: k.otherTags, flags: bySeq.get(k.aiSeq)?.flags ?? [] }));
  const outside = results.filter((r) => r.flags.length && !knownSeqs.has(r.aiSeq));
  const goldCeiling = ceiling(known.filter((k) => k.expected?.target && k.expected?.name && bySeq.has(k.aiSeq)).map((k) => ({
    tags: k.tags as string[], flags: shadowFlags(bySeq.get(k.aiSeq)!.behaviours, k.expected as { target: TargetLevel; name: NameLevel }) })));
  const perTag = Object.fromEntries(PUBLIC_FLAGS.map((t) => {
    const pos = detection.filter((d) => d.judged && (d.tags as string[]).includes(t));
    return [t, { expected: pos.length, detected: pos.filter((d) => (d.flags as string[]).includes(t)).length,
      flaggedElsewhere: results.filter((r) => (r.flags as string[]).includes(t) && !pos.some((d) => d.aiSeq === r.aiSeq)).length }];
  }));

  // How each old behaviour would be re-read under the verdict.
  const behaviourUnderVerdict: Record<string, Record<string, number>> = {};
  for (const r of judged) for (const b of r.behaviours) {
    const key = r.verdict!.target + "/" + r.verdict!.name;
    (behaviourUnderVerdict[b] ??= {})[key] = (behaviourUnderVerdict[b][key] ?? 0) + 1;
  }
  const agreeTurns = results.filter((r) => r.agreedSlotMatched !== null);
  return {
    aiTurns: results.length,
    judged: judged.length,
    errors: countBy(results.filter((r) => r.error).map((r) => r.error!)),
    verdictDistribution: {
      target: Object.fromEntries(TARGET_LEVELS.map((l) => [l, judged.filter((r) => r.verdict!.target === l).length])),
      name: Object.fromEntries(NAME_LEVELS.map((l) => [l, judged.filter((r) => r.verdict!.name === l).length])),
    },
    oldActions: countBy(results.map((r) => r.oldAction ?? "none")),
    behaviourCounts,
    behaviourUnderVerdict,
    flagCounts,
    flaggedTurns: results.filter((r) => r.flags.length).length,
    knownFailures: {
      reviewed: known.length,
      total: tagged.length,
      judged: detection.filter((d) => d.judged).length,
      detectedAnyFlag: detection.filter((d) => d.anyFlag).length,
      detectedTagMatch: detection.filter((d) => d.tagMatch).length,
      detectionRateAnyFlag: rate(detection.filter((d) => d.anyFlag).length, detection.filter((d) => d.judged).length),
      missingFromReplay: missingKnown,
      perTag,
      perFailure: detection,
      /** Offline-only tags (e.g. wrong_target_agreement, state_mismatch): not in the detection denominator. */
      otherTags,
    },
    /** The same flag rules fed the reviewer's gold axes: the rules' ceiling, independent of any judge. */
    goldVerdictCeiling: goldCeiling,
    /** Flags on reviewed turns with no public-text failure tag (provisional false positives). */
    flagsOnReviewedNegatives: { turns: untagged.length, flagged: untaggedFlagged.length, rate: rate(untaggedFlagged.length, untagged.length), seqs: untaggedFlagged.map((k) => k.aiSeq) },
    /** Turns not in the reviewed list at all; unlabelled is not "no failure". */
    flagsOutsideKnownList: { turns: outside.length, seqs: outside.map((r) => r.aiSeq) },
    agreeTurnsOffline: {
      total: agreeTurns.length,
      endedMatched: agreeTurns.filter((r) => r.agreedSlotMatched).length,
      flaggedAndEndedMismatched: agreeTurns.filter((r) => !r.agreedSlotMatched && r.flags.length).length,
      flaggedAndEndedMatched: agreeTurns.filter((r) => r.agreedSlotMatched && r.flags.length).length,
    },
  };
}

export type CaseResult = {
  caseId: string; split: string; source: string; labelQuality: string;
  axisQuality?: { target: string; name: string };
  expected: EvalCaseLike["expected"]; verdict: { target: TargetLevel; name: NameLevel } | null; error: string | null;
  /** Flags on the case's probe reply, if any, and the tags it should raise. */
  probe: { expectedTags: string[]; flags: ShadowFlag[] } | null;
};

export function caseProbe(c: EvalCaseLike, verdict: { target: TargetLevel; name: NameLevel } | null): CaseResult["probe"] {
  if (!c.probeReply) return null;
  return { expectedTags: (c.failureTags ?? []).filter((t) => t !== "wrong_target_agreement"),
    flags: verdict ? shadowFlags(classifyReply(c.probeReply.text, c.probeReply.action), verdict) : [] };
}

const PUBLIC_FLAGS = ["unfounded_wakarimasu", "early_naming", "contradictory_agreement", "over_confirmation"] as const;

/** Per-tag detection and false flags for rows of expected tags vs raised flags. */
export function ceiling(rows: readonly { tags: readonly string[]; flags: readonly string[] }[]) {
  const perTag = Object.fromEntries(PUBLIC_FLAGS.map((t) => {
    const pos = rows.filter((r) => r.tags.includes(t)), neg = rows.filter((r) => !r.tags.includes(t));
    return [t, { expected: pos.length, detected: pos.filter((r) => r.flags.includes(t)).length, falseFlags: neg.filter((r) => r.flags.includes(t)).length, negatives: neg.length }];
  }));
  const clean = rows.filter((r) => !r.tags.length);
  return { rows: rows.length, perTag, cleanControls: clean.length, cleanControlsFlagged: clean.filter((r) => r.flags.length).length };
}

/** Per-tag detection and false flags on probe replies (judged cases only). */
export function summarizeProbes(results: readonly CaseResult[], cases: readonly EvalCaseLike[] = []) {
  const judged = ceiling(results.filter((r) => r.probe && r.verdict).map((r) => ({ tags: r.probe!.expectedTags, flags: r.probe!.flags })));
  const gold = ceiling(cases.filter((c) => c.probeReply && c.expected.target && c.expected.name).map((c) => ({
    tags: (c.failureTags ?? []).filter((t) => t !== "wrong_target_agreement"),
    flags: shadowFlags(classifyReply(c.probeReply!.text, c.probeReply!.action), c.expected as { target: TargetLevel; name: NameLevel }) })));
  return { judged, goldVerdictCeiling: gold };
}

function axisConfusion<L extends string>(rows: readonly { gold: L | null; pred: L | null }[], levels: readonly L[]) {
  const scored = rows.filter((r) => r.gold !== null && r.pred !== null);
  const matrix: Record<string, Record<string, number>> = {};
  for (const g of levels) matrix[g] = Object.fromEntries(levels.map((p) => [p, 0]));
  for (const r of scored) matrix[r.gold!][r.pred!] += 1;
  const recall = Object.fromEntries(levels.map((l) => {
    const n = scored.filter((r) => r.gold === l).length;
    return [l, rate(matrix[l][l], n)];
  }));
  return {
    goldPresent: rows.filter((r) => r.gold !== null).length,
    noGold: rows.filter((r) => r.gold === null).length,
    scored: scored.length,
    agreement: rate(scored.filter((r) => r.gold === r.pred).length, scored.length),
    recall, matrix,
  };
}

/** Agreement with provisional gold per axis and split. Gold is derived from
 * annotation labels and is not correctness; see the evalset's label rules. */
const axisQ = (r: CaseResult, axis: "target" | "name") => r.axisQuality?.[axis] ?? r.labelQuality;

/** Rows are kept per axis: `qualities` lists the gold qualities included for each axis. */
function caseBlock(rows: readonly CaseResult[], qualities: readonly string[] | null = null) {
  const keep = (r: CaseResult, axis: "target" | "name") => !qualities || qualities.includes(axisQ(r, axis));
  const target = axisConfusion(rows.filter((r) => keep(r, "target")).map((r) => ({ gold: r.expected.target, pred: r.verdict?.target ?? null })), TARGET_LEVELS);
  const name = axisConfusion(rows.filter((r) => keep(r, "name")).map((r) => ({ gold: r.expected.name, pred: r.verdict?.name ?? null })), NAME_LEVELS);
  rows = rows.filter((r) => keep(r, "target"));
  // "Risk" view (target axis): the verdict withholds support where gold says supported.
  const goldSupported = rows.filter((r) => r.expected.target === "supported" && r.verdict);
  const goldUnsupported = rows.filter((r) => (r.expected.target === "insufficient" || r.expected.target === "contradicted") && r.verdict);
  const risky = (r: CaseResult) => r.verdict!.target === "insufficient" || r.verdict!.target === "contradicted";
  return {
    cases: rows.length, errors: rows.filter((r) => r.error).length, target, name,
    riskFlagFalsePositiveRate: rate(goldSupported.filter(risky).length, goldSupported.length),
    riskFlagRecall: rate(goldUnsupported.filter(risky).length, goldUnsupported.length),
    verdictUnknownRate: rate(rows.filter((r) => r.verdict && (r.verdict.target === "unknown" || r.verdict.name === "unknown")).length, rows.filter((r) => r.verdict).length),
  };
}

const HEADLINE_QUALITIES = ["explicit", "derived"];

/** Agreement with provisional gold. Gold is derived from annotation labels and
 * is not correctness. Headline numbers keep explicit and derived gold per axis;
 * every split is also broken down by per-axis gold quality. */
export function summarizeCases(results: readonly CaseResult[], cases: readonly EvalCaseLike[] = []) {
  const bySplit: Record<string, { headline: ReturnType<typeof caseBlock>; byQuality: Record<string, ReturnType<typeof caseBlock>> }> = {};
  for (const split of [...new Set(results.map((r) => r.split))].sort()) {
    const rows = results.filter((r) => r.split === split);
    bySplit[split] = {
      headline: caseBlock(rows, HEADLINE_QUALITIES),
      // Grouped per axis quality, so the headline equals the explicit + derived rows.
      byQuality: Object.fromEntries([...new Set(rows.flatMap((r) => [axisQ(r, "target"), axisQ(r, "name")]))].sort().map((q) => [q, caseBlock(rows, [q])])),
    };
  }
  // Repeated calls on identical input: caseId "X#r2" repeats "X".
  const repeats = results.filter((r) => /#r\d+$/u.test(r.caseId) && r.verdict).map((r) => {
    const first = results.find((o) => o.caseId === r.caseId.replace(/#r\d+$/u, "") && o.verdict);
    return first ? first.verdict!.target === r.verdict!.target && first.verdict!.name === r.verdict!.name : null;
  }).filter((x): x is boolean => x !== null);
  return { cases: results.length, bySource: countBy(results.map((r) => r.source)), byLabelQuality: countBy(results.map((r) => r.labelQuality)), bySplit,
    repeatStability: { pairs: repeats.length, identical: repeats.filter(Boolean).length },
    probes: summarizeProbes(results, cases) };
}
