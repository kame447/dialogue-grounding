// Data audit for the shadow comparison: missing turns, future-turn and
// answer-key leakage into judge inputs, split leakage, and label quality.
// Reports counts and ids only, never utterance text.
import { sortedEvents } from "./replay.ts";
import type { SessionRecordLike } from "./replay.ts";
import type { EvalCaseLike, JevAxesInput, ReplayItem } from "./types.ts";

export function auditRecord(record: SessionRecordLike, items: readonly ReplayItem[]) {
  const events = sortedEvents(record);
  const seqs = events.map((e) => e.seq);
  const gaps: number[] = [];
  for (let s = seqs[0] ?? 1; s <= (seqs.at(-1) ?? 0); s++) if (!seqs.includes(s)) gaps.push(s);
  const duplicateSeqs = seqs.filter((s, i) => seqs.indexOf(s) !== i);
  const aiReplies = events.filter((e, i) => e.speaker === "ai" && i > 0 && e.origin !== "scripted_opening").length;
  const withoutHypothesis = items.filter((i) => !i.hypothesis).map((i) => i.aiSeq);
  const judgments = record.judgments ?? [];
  const unpairedJudgments = judgments.filter((j) => !events.some((e) => e.speaker === "ai" && e.seq > j.turnIndex)).length;

  // Leakage: a judge input must equal the public prefix before the reply.
  const futureLeaks: number[] = [];
  for (const item of items) {
    const prefix = events.filter((e) => e.seq < item.aiSeq);
    if (item.history.length !== prefix.length || item.history.some((t, k) => t.text !== prefix[k].text)) futureLeaks.push(item.aiSeq);
  }
  const keyTokens = answerKeyTokens(record);
  const keyLeaks = items.filter((i) => inputLeaks(toJudgeInput(i), keyTokens)).map((i) => i.aiSeq);
  return {
    events: events.length, aiReplies, replayItems: items.length,
    seqGaps: gaps, duplicateSeqs, repliesWithoutJudgment: withoutHypothesis, unpairedJudgments,
    futureTurnLeaks: futureLeaks, answerKeyLeaks: keyLeaks,
  };
}

/** Identifiers that exist only on the partner/scorer side of a record. */
export function answerKeyTokens(record: SessionRecordLike): string[] {
  const key = record.scoring?.key;
  const own = new Set(Object.keys(key?.ai ?? {}));
  const partnerSlots = Object.keys(key?.human ?? {}).filter((s) => !own.has(s));
  const figures = [...new Set([...Object.values(key?.ai ?? {}), ...Object.values(key?.human ?? {})])];
  return [...partnerSlots, ...figures].filter((t) => t.length >= 2);
}

export function inputLeaks(input: JevAxesInput, tokens: readonly string[]): boolean {
  const json = JSON.stringify(input);
  const allowed = new Set(["history", "aiHypothesis", "speaker", "text", "action", "targetSlot", "candidateName", "discriminatingFeature"]);
  const keysOk = (value: unknown): boolean => Array.isArray(value) ? value.every(keysOk) :
    value && typeof value === "object" ? Object.entries(value).every(([k, v]) => allowed.has(k) && keysOk(v)) : true;
  return !keysOk(input) || tokens.some((t) => new RegExp("(?<![A-Za-z0-9-])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9-])").test(json));
}

export function toJudgeInput(item: ReplayItem): JevAxesInput {
  return { history: item.history.map((t) => ({ speaker: t.speaker, text: t.text })), aiHypothesis: item.hypothesis };
}

export function auditCases(cases: readonly EvalCaseLike[]) {
  const ids = cases.map((c) => c.caseId);
  const splitsByGroup = new Map<string, Set<string>>();
  for (const c of cases) (splitsByGroup.get(c.groupId) ?? splitsByGroup.set(c.groupId, new Set()).get(c.groupId)!).add(c.split);
  const count = (f: (c: EvalCaseLike) => string) => {
    const out: Record<string, number> = {};
    for (const c of cases) out[f(c)] = (out[f(c)] ?? 0) + 1;
    return out;
  };
  return {
    cases: cases.length,
    duplicateCaseIds: ids.filter((id, i) => ids.indexOf(id) !== i).length,
    groupsInSeveralSplits: [...splitsByGroup.values()].filter((s) => s.size > 1).length,
    // judgedTurnIndex is either the last history turn or history.length (the reply to come).
    focalOutOfRange: cases.filter((c) => !Number.isSafeInteger(c.judgedTurnIndex) || c.judgedTurnIndex < 0 || c.judgedTurnIndex > c.history.length).length,
    turnsAfterFocal: cases.filter((c) => c.history.length - 1 > c.judgedTurnIndex).length,
    historicalMarkedSendable: cases.filter((c) => c.source === "historical" && (c.externalModelAllowed === true || c.sendable === true)).length,
    sendable: cases.filter((c) => isSendable(c)).length,
    bySource: count((c) => c.source),
    bySplit: count((c) => c.split),
    byLabelQuality: count((c) => c.labelQuality ?? "unspecified"),
    goldTarget: count((c) => c.expected.target ?? "no_gold"),
    goldName: count((c) => c.expected.name ?? "no_gold"),
    correctnessKnown: cases.filter((c) => c.correctnessKnown === true).length,
    withProbeReply: cases.filter((c) => c.probeReply).length,
    failureTags: count((c) => (c.failureTags ?? []).slice().sort().join("+") || "none"),
    labelBasis: count((c) => (c.labelBasis ?? []).map((b) => b.split(/[:-]/u)[0]).sort().join("+") || "none"),
  };
}

/** Only synthetic or AI-session cases explicitly marked sendable may reach an external model. */
export function isSendable(c: EvalCaseLike): boolean {
  const marked = c.externalModelAllowed === true || c.sendable === true;
  return marked && c.externalModelAllowed !== false && c.sendable !== false && c.source !== "historical";
}
