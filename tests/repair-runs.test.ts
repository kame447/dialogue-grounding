// Offline only: synthetic Jev records, no model or network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateRepairRuns, conditionKey, main, repairRunSummary } from "../dialogue-model/runtime/diagnostics/repair-runs.ts";

type Step = { turn: number; action: string; original?: string; disposition?: string; prospect?: [string, string, number]; feature?: string };
type Entry = { turn: number; issueId: string | null; action: string; before: string[]; after: string[]; progress: string; missing?: string[] | null;
  reply?: { act: string; targets: string[] }[] };

const SECRET_TEXT = "合成の秘密の発話";
function record(steps: Step[], history: Entry[], extra: Record<string, unknown> = {}) {
  const repairHistory = history.map(h => ({ turn: h.turn, issueId: h.issueId, action: h.action, question: SECRET_TEXT,
    partnerClaims: (h.reply ?? [{ act: "assert", targets: ["s-aaaa"] }]).map((c, i) => ({ id: `x:local${i + 1}`, proposition: SECRET_TEXT, ...c })),
    candidatesBefore: h.before, candidatesAfter: h.after, addedClaimIds: [], removedClaimIds: [], progress: h.progress,
    ...(h.missing === undefined ? {} : { missingReasons: h.missing }) }));
  return {
    strategy: "bypass-enabled", options: { rotationMode: "relative_pm90", technicalTrial: { version: "adaptive_repair_v2" } },
    events: [{ speaker: "human", text: SECRET_TEXT, seq: 2 }],
    jevTraces: steps.map(s => ({
      turnIndex: s.turn,
      executed: { action: s.action, target: { kind: "single", figureId: "s-aaaa" }, feature: s.feature ?? null },
      intervention: { disposition: s.disposition ?? "adopted", reasonCode: "no_intervention", original: { action: s.original ?? s.action } },
      repairProspect: s.prospect ? { status: "ok", issue: { choice: "issue", turn: s.prospect[2], issueId: "4:local3" }, prospect: s.prospect[0], basis: s.prospect[1], scores: {} } : null,
      publicSpeech: SECRET_TEXT,
      // Only the final trace's history is authoritative: later turns settle earlier entries.
      repairHistory,
    })),
    ...extra,
  };
}

// Shape of the 10/30 S trial: one confirm, then three repairs of one issue, then accept.
const sLike = () => record([
  { turn: 2, action: "confirm" },
  { turn: 4, action: "repair", prospect: ["progressing", "new_information", 2] },
  { turn: 6, action: "repair", prospect: ["progressing", "repetition", 4] },
  { turn: 8, action: "repair", prospect: ["progressing", "candidate_widened", 6] },
  { turn: 10, action: "accept", prospect: ["progressing", "repetition", 8] },
], [
  { turn: 2, issueId: "2:local2", action: "confirm", before: ["s-a", "s-b", "s-c"], after: ["s-a", "s-c", "s-b"], progress: "changed", missing: [] },
  { turn: 4, issueId: "4:local3", action: "repair", before: ["s-a", "s-b", "s-c"], after: ["s-a", "s-c", "s-b"], progress: "changed", missing: [] },
  { turn: 6, issueId: "4:local3", action: "repair", before: ["s-a"], after: ["s-a", "s-c", "s-b"], progress: "changed", missing: [] },
  { turn: 8, issueId: "4:local3", action: "repair", before: ["s-a"], after: ["s-a", "s-c", "s-b"], progress: "changed", missing: [] },
]);

test("a run of repairs on one issue is a same-issue run, not separate local repairs", () => {
  const s = repairRunSummary(sLike())!;
  assert.equal(s.clarificationSteps, 4);
  assert.deepEqual(s.runs.lengths, { "1": 1, "2": 0, "3+": 1 });
  assert.equal(s.runs.longest, 3);
  assert.equal(s.runs.issueSwitches, 1);
});

test("progress labels are split by what happened to the candidate set", () => {
  const s = repairRunSummary(sLike())!;
  assert.deepEqual(s.progress, { changed_narrowed: 0, changed_same_candidates: 2, changed_widened_or_shifted: 2,
    unchanged: 0, unknown_missing: 0, unknown: 0 });
  const narrowed = repairRunSummary(record([{ turn: 2, action: "confirm" }, { turn: 4, action: "accept" }],
    [{ turn: 2, issueId: "2:local1", action: "confirm", before: ["s-a", "s-b"], after: ["s-b"], progress: "changed", missing: [] }]))!;
  assert.equal(narrowed.progress.changed_narrowed, 1);
  const missing = repairRunSummary(record([{ turn: 2, action: "repair" }, { turn: 4, action: "accept" }],
    [{ turn: 2, issueId: "2:local1", action: "repair", before: ["s-a"], after: ["s-a"], progress: "unknown", missing: ["human_local_missing"] }]))!;
  assert.equal(missing.progress.unknown_missing, 1);
  const pending = repairRunSummary(record([{ turn: 2, action: "repair" }],
    [{ turn: 2, issueId: "2:local1", action: "repair", before: ["s-a"], after: ["s-a"], progress: "unknown", missing: null }]))!;
  assert.equal(pending.progress.unknown, 1);
});

test("Jev prospect is cross-tabulated with its basis and the program's progress label", () => {
  const s = repairRunSummary(sLike())!;
  assert.deepEqual(s.prospect, { "progressing|new_information": 1, "progressing|repetition": 2, "progressing|candidate_widened": 1 });
  // README: repetition or partner difficulty is stagnation; new information or narrowing is progress.
  assert.equal(s.prospectDiscordant, 2);
  assert.deepEqual(s.programVsProspect, { "changed|progressing": 4 });
});

test("strategy divergence is read from Jev's original action and the intervention disposition", () => {
  const r = record([{ turn: 2, action: "repair", original: "move_on", disposition: "rejected" }, { turn: 4, action: "accept" }], []);
  r.strategy = "repair-first";
  const s = repairRunSummary(r)!;
  assert.deepEqual(s.originalActions, { move_on: 1, accept: 1 });
  assert.deepEqual(s.dispositions, { rejected: 1, adopted: 1 });
});

test("each reply is compared with the previous reply in a clarification sequence, across issue ids", () => {
  const s = repairRunSummary(sLike())!;
  assert.deepEqual(s.sequences, { lengths: { "1": 0, "2": 0, "3+": 1 }, longest: 4 });
  // The 10/30 S shape: every reply fits the same figures, yet each is labelled changed.
  assert.deepEqual(s.replyVsPrevious, { same: 3 });
  assert.deepEqual(s.progressVsReply, { "changed|same": 3 });
  assert.deepEqual(s.afterSameReply, { repair: 2, accept: 1 });
  assert.equal(s.repeatedAsk, 0);

  const ab = ["s-a", "s-b"], info = (targets: string[]) => [{ act: "assert", targets }];
  const mixed = repairRunSummary(record([
    { turn: 2, action: "confirm", feature: "f1" },
    { turn: 4, action: "repair", feature: "f1" },
    { turn: 6, action: "repair", feature: "f2" },
    { turn: 8, action: "confirm", feature: "f2" },
    { turn: 10, action: "move_on", original: "move_on" },
    { turn: 12, action: "repair", feature: "f2" },
  ], [
    { turn: 2, issueId: "2:local1", action: "confirm", before: ab, after: ab, progress: "changed", reply: info(ab) },
    { turn: 4, issueId: "4:local1", action: "repair", before: ab, after: ["s-a"], progress: "changed", reply: info(["s-a"]) },
    { turn: 6, issueId: "6:local1", action: "repair", before: ["s-a"], after: ab, progress: "changed", reply: info(ab) },
    { turn: 8, issueId: "8:local1", action: "confirm", before: ab, after: ab, progress: "unchanged", reply: [{ act: "acknowledge", targets: [] }] },
    { turn: 12, issueId: "12:local1", action: "repair", before: ["s-a"], after: ["s-a"], progress: "unknown", reply: info(["s-a"]) },
  ]))!;
  // Four issue ids, one sequence; the post-move_on repair starts a new one with nothing to compare.
  assert.deepEqual(mixed.sequences, { lengths: { "1": 1, "2": 0, "3+": 1 }, longest: 4 });
  assert.equal(mixed.runs.longest, 1);
  assert.deepEqual(mixed.replyVsPrevious, { narrowed: 1, widened_or_shifted: 1, no_reply: 1 });
  assert.deepEqual(mixed.progressVsReply, { "changed|narrowed": 1, "changed|widened_or_shifted": 1, "unchanged|no_reply": 1 });
  // Verbatim re-asks of the catalog feature: 4 after 2, 8 after 6; 12 follows a break.
  assert.equal(mixed.repeatedAsk, 2);
  assert.deepEqual(mixed.afterSameReply, {});
});

test("records without Jev traces are skipped, and groups keep rotation mode and trial version apart", () => {
  assert.equal(repairRunSummary({ strategy: "repair-first", judgments: [] }), null);
  assert.equal(repairRunSummary({ strategy: "other", jevTraces: [] }), null);
  const zero = sLike(); zero.options.rotationMode = "relative_0";
  const old = sLike(); delete (old.options as Record<string, unknown>).rotationMode; delete (old.options as Record<string, unknown>).technicalTrial;
  assert.equal(conditionKey(sLike()), "bypass-enabled|rotation=relative_pm90|trial=adaptive_repair_v2");
  assert.equal(conditionKey(zero), "bypass-enabled|rotation=relative_0|trial=adaptive_repair_v2");
  assert.equal(conditionKey(old), "bypass-enabled|rotation=unrecorded|trial=none");
  const result = aggregateRepairRuns([sLike(), sLike(), zero, old, { strategy: "repair-first" }]);
  assert.equal(result.skipped, 1);
  const pm90 = result.groups["bypass-enabled|rotation=relative_pm90|trial=adaptive_repair_v2"];
  assert.equal(pm90.records, 2);
  assert.deepEqual(pm90.runs.lengths, { "1": 2, "2": 0, "3+": 2 });
  assert.equal(pm90.runs.longest, 3);
  assert.equal(pm90.prospectDiscordant, 4);
  assert.deepEqual(pm90.replyVsPrevious, { same: 6 });
  assert.deepEqual(pm90.afterSameReply, { repair: 4, accept: 2 });
  assert.equal(pm90.sequences.longest, 4);
  assert.equal(Object.keys(result.groups).length, 3);
});

test("the CLI prints aggregates only: no utterances, claim texts, issue or slot ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-runs-"));
  try {
    writeFileSync(join(dir, "record.private.json"), JSON.stringify(sLike()));
    writeFileSync(join(dir, "notes.json"), JSON.stringify({ text: SECRET_TEXT }));
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => { logs.push(line); };
    try { await main(["--scan", dir]); } finally { console.log = original; }
    const out = logs.join("\n");
    assert.equal(JSON.parse(out).records, 1);
    assert.doesNotMatch(out, new RegExp(SECRET_TEXT, "u"));
    assert.doesNotMatch(out, /local\d|\bs-[a-z0-9]+\b|:pub\d/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
