// Jev grounding eval-set tooling on synthetic fixtures only (no real dialogue, no answer key).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoricalRow } from "../dialogue-model/runtime/jev-grounding/labels.ts";
import { distribution, labelRows, parseALabels, parseAH, parseEpisodeMarks, parseER, parseM, parseP } from "../dialogue-model/runtime/jev-grounding/labels.ts";
import { buildHistoricalCases, deriveEpisodeEnd, deriveLocal, normalizeText } from "../dialogue-model/runtime/jev-grounding/derive.ts";
import type { GroundingEvalCase } from "../dialogue-model/runtime/jev-grounding/evalcase.ts";
import { assertSendable, toJudgeInput, validateEvalCase } from "../dialogue-model/runtime/jev-grounding/evalcase.ts";
import { assignSplits, findLeakage, leaveOneDialogueOut } from "../dialogue-model/runtime/jev-grounding/split.ts";
import { axisReport, detection, evaluate } from "../dialogue-model/runtime/jev-grounding/metrics.ts";
import { renderSkeleton } from "../dialogue-model/runtime/jev-grounding/skeleton.ts";
import type { SessionRecord, TurnAnnotation } from "../dialogue-model/runtime/jev-grounding/ai-session.ts";
import { affirmationCandidate, aiTurns, buildAiTurnCases, offlineCorrect, validateAnnotation } from "../dialogue-model/runtime/jev-grounding/ai-session.ts";
import { buildAll } from "../dialogue-model/runtime/jev-grounding/build-evalset.ts";
import { outsideRepositoryDirectory } from "../dialogue-model/runtime/naming-task.mjs";

function row(dialogue: number, no: number, speaker: string, text: string, labels: Partial<HistoricalRow> = {}): HistoricalRow {
  return { dialogue, utteranceNo: String(no), speaker, text, ...labels };
}

// Invented dialogue: episode 0 resolved and named, episode 1 left open and closed with ER0.
function fixture(dialogue = 1): HistoricalRow[] {
  return [
    row(dialogue, 1, "A", "鳥みたいなのある？", { episode: "E0 start", misalignmentState: "M0 ずれなし", speechFunctions: "a8（短い質問）", AHLabel: "Holistic" }),
    row(dialogue, 2, "B", "うーん、どれだろう。", { speechFunctions: "a15（思考）", misalignmentState: "M1 ずれ可能性" }),
    row(dialogue, 3, "A", "三角が上にあるやつ。", { speechFunctions: "a7（話題転換促進）", AHLabel: "Analytic", misalignmentState: "M3 再調整中", adjustmentProcess: "P1 明示的早期修復" }),
    row(dialogue, 4, "B", "はい。", { speechFunctions: "a11（同意）" }),
    row(dialogue, 5, "B", "あ、それです。", { speechFunctions: "a5（気づき）; a11（同意）", misalignmentState: "M4 ずれ解消・共有成立" }),
    row(dialogue, 6, "A", "じゃあ鳥で。", { episode: "E0 end", speechFunctions: "a11（同意）", episodeResult: "ER1 共通基盤形成あり" }),
    row(dialogue, 7, "B", "次、船みたいなの。", { episode: "E1 start", speechFunctions: "a7（話題転換促進）", misalignmentState: "M0 ずれなし" }),
    row(dialogue, 8, "A", "それは違うと思う<o>うん</o>。", { speechFunctions: "a12（非同意）", misalignmentState: "M2 ずれ顕在化", AHLabel: "Deny holistic" }),
    row(dialogue, 9, "B", "はい<la>", { speechFunctions: "a4（応答）" }),
    row(dialogue, 10, "A", "まあいいか。", { episode: "E1 end", speechFunctions: "", adjustmentProcess: "P4 進行優先型やり過ごし", episodeResult: "ER0 共通基盤形成なし" }),
  ];
}

test("label parsers accept the annotation cell formats and never guess", () => {
  assert.equal(parseM("M4 ずれ解消・共有成立"), "M4");
  assert.equal(parseM(""), null);
  assert.equal(parseM(undefined), null);
  assert.equal(parseP("P5 次善的合意"), "P5");
  assert.equal(parseER("ER0 共通基盤形成なし"), "ER0");
  assert.equal(parseER("ER2"), null);
  assert.deepEqual(parseALabels("a5（驚き）; a11（同意）；a11（同意）"), { labels: ["a5", "a11"], unparsed: [] });
  assert.deepEqual(parseALabels("同意"), { labels: [], unparsed: ["同意"] });
  assert.deepEqual(parseALabels("a31（なし）").labels, []);
  assert.deepEqual(parseAH("Holistic,Ack holistic; Grounded"), ["Holistic", "Ack holistic", "Grounded"]);
  assert.deepEqual(parseEpisodeMarks("E3 end"), [{ episode: 3, edge: "end" }]);
});

test("blank M continues the last explicit M inside an episode and is unknown before it", () => {
  const rows = labelRows([
    row(1, 1, "A", "x", { episode: "E0 start" }),
    row(1, 2, "B", "y", { misalignmentState: "M1 ずれ可能性" }),
    row(1, 3, "A", "z", { episode: "E0 end" }),
    row(1, 4, "B", "w"),
  ]).get("H1") ?? [];
  assert.deepEqual(rows.map((r) => r.activeM), [null, "M1", "M1", null]);
  assert.deepEqual(rows.map((r) => r.episode), [0, 0, 0, null]);
  const d = distribution(rows);
  assert.equal(d.blank.m, 3);
  assert.equal(d.m.M0, undefined, "blank is never counted as M0");
  assert.equal(d.rowsOutsideEpisodes, 1);
  assert.equal(d.episodeEndsWithoutER, 1);
  assert.equal(d.episodesWithoutStartM, 1);
});

test("episode-end gold: ER gives the name axis; the target axis needs M4 and stays null under P5", () => {
  const rows = labelRows(fixture()).get("H1") ?? [];
  const e0 = rows.filter((r) => r.episode === 0);
  const e1 = rows.filter((r) => r.episode === 1);
  assert.deepEqual([deriveEpisodeEnd(e0).target, deriveEpisodeEnd(e0).name], ["supported", "agreed"]);
  assert.deepEqual(deriveEpisodeEnd(e0).axisQuality, { target: "weak", name: "derived" });
  assert.equal(deriveEpisodeEnd(e0).quality, "weak");
  assert.deepEqual([deriveEpisodeEnd(e1).target, deriveEpisodeEnd(e1).name], ["insufficient", "not_agreed"]);
  const p5 = labelRows([...fixture().slice(0, 5), row(1, 6, "A", "まあ鳥で", { episode: "E0 end", adjustmentProcess: "P5 次善的合意", episodeResult: "ER1" })]).get("H1") ?? [];
  const derived = deriveEpisodeEnd(p5);
  assert.equal(derived.name, "agreed");
  assert.equal(derived.target, null);
  assert.ok(derived.basis.includes("rule:T-ER1-P5-null"));
});

test("local gold: agreement is not a shared referent; open trouble, denial and M4 are read conservatively", () => {
  const rows = labelRows(fixture()).get("H1") ?? [];
  // Row 4: a11 while M3 is open → insufficient, even though it is an agreement.
  assert.equal(deriveLocal(rows[3], rows.slice(0, 3)).target, "insufficient");
  // Row 5: a11 with M4 → supported, weak: M4's dimension is not recorded.
  const r5 = deriveLocal(rows[4], rows.slice(0, 4));
  assert.equal(r5.target, "supported");
  assert.equal(r5.quality, "weak");
  // Row 9: a4 right after an open M2 without a denial → insufficient, not contradicted.
  const r9 = deriveLocal(rows[8], rows.slice(6, 8));
  assert.equal(r9.target, "insufficient");
  assert.ok(r9.basis.includes("rule:T-open-M2-nodeny"));
  // A denial on an open M2 → contradicted, still weak.
  const deny = { ...rows[8], aLabels: ["a12"] };
  assert.deepEqual([deriveLocal(deny, rows.slice(6, 8)).target, deriveLocal(deny, rows.slice(6, 8)).quality], ["contradicted", "weak"]);
  // Every target value derived from M is weak.
  for (let i = 0; i < rows.length; i++) {
    const d = deriveLocal(rows[i], rows.slice(0, i));
    if (d.target !== null) assert.equal(d.axisQuality.target, "weak");
  }
  // A blank M after M4 is not "no misalignment": no gold.
  const after = labelRows([...fixture().slice(0, 5), row(1, 6, "B", "はい", { speechFunctions: "a11（同意）" })]).get("H1") ?? [];
  assert.equal(deriveLocal(after[5], after.slice(0, 5)).target, null);
  // Local windows never carry name gold.
  assert.equal(r5.name, null);
});

test("historical cases: no future turns, judged turn last, never sendable, correctness unknown", () => {
  const rows = labelRows(fixture()).get("H1") ?? [];
  const cases = buildHistoricalCases("H1", rows, { split: () => "train" });
  assert.ok(cases.length >= 4);
  for (const c of cases) {
    assert.deepEqual(validateEvalCase(c), []);
    assert.equal(c.externalModelAllowed, false);
    assert.equal(c.correctnessKnown, false);
    assert.equal(c.judgedTurnIndex, c.history.length - 1);
    assert.throws(() => assertSendable(c));
  }
  const end = cases.find((c) => c.unit === "episode_end" && c.groupId === "H1-E1");
  assert.ok(end);
  assert.equal(end.history.at(-1)?.speaker, "self");
  assert.ok(!end.history.some((t) => t.text.includes("鳥で")), "an episode case only holds its own episode");
  const local = cases.find((c) => c.caseId === "H1-E0-u4");
  assert.ok(local);
  assert.equal(local.history.length, 4);
  assert.equal(cases.filter((c) => c.groupId === "H1-E0" && c.unit === "episode_end").length, 1);
  assert.equal(buildHistoricalCases("H1", rows, { split: () => "train", procedural: ["H1:E0"] }).some((c) => c.groupId === "H1-E0"), false);
  assert.equal(normalizeText("それは違う<o>うん</o>と思う<la>"), "それは違うと思う（笑）");
});

test("toJudgeInput exposes only public history", () => {
  const rows = labelRows(fixture()).get("H1") ?? [];
  const [c] = buildHistoricalCases("H1", rows, { split: () => "dev" });
  const input = toJudgeInput({ ...c, failureTags: ["early_naming"], offlineCorrect: false, aiAction: "agree" });
  assert.deepEqual(Object.keys(input).sort(), ["history", "judgedTurnIndex"]);
  assert.doesNotMatch(JSON.stringify(input), /expected|labelBasis|offlineCorrect|early_naming|agree/);
});

test("validator rejects historical cases marked sendable or correct, and bad levels", () => {
  const rows = labelRows(fixture()).get("H1") ?? [];
  const [c] = buildHistoricalCases("H1", rows, { split: () => "dev" });
  assert.ok(validateEvalCase({ ...c, externalModelAllowed: true }).some((e) => e.includes("externalModelAllowed")));
  assert.ok(validateEvalCase({ ...c, correctnessKnown: true }).length > 0);
  assert.ok(validateEvalCase({ ...c, expected: { target: "probably", name: null } }).includes("expected.target"));
  assert.ok(validateEvalCase({ ...c, judgedTurnIndex: 99 }).includes("judgedTurnIndex out of range"));
  assert.ok(validateEvalCase({ ...c, failureTags: ["bad"] }).includes("failureTags"));
  assert.deepEqual(validateEvalCase(null), ["case is not an object"]);
});

test("splits are per dialogue, seeded, leakage-checked", () => {
  const keys = ["H1", "H2", "H3", "H4", "H5"];
  const a = assignSplits(keys), b = assignSplits([...keys].reverse());
  assert.deepEqual([...a].sort(), [...b].sort(), "order-independent");
  const counts = [...a.values()].reduce<Record<string, number>>((s, v) => ({ ...s, [v]: (s[v] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { holdout: 1, dev: 1, train: 3 });
  assert.throws(() => assignSplits(["H1", "H2"], { seed: "s", holdout: 1, dev: 1 }));
  assert.equal(leaveOneDialogueOut(keys).length, 5);
  const rows = labelRows(fixture()).get("H1") ?? [];
  const cases = buildHistoricalCases("H1", rows, { split: () => "train" });
  assert.deepEqual(findLeakage(cases), []);
  const leaked = [...cases, { ...cases[0], caseId: "x", split: "holdout" as const }];
  assert.ok(findLeakage(leaked).some((p) => p.startsWith("dialogue H1")));
  assert.ok(findLeakage([...cases, cases[0]]).some((p) => p.startsWith("duplicate")));
});

test("metrics: confusion, macro-F1, abstention and missing predictions", () => {
  const r = axisReport(["supported", "insufficient", "contradicted", "unknown"] as const, [
    { gold: "supported", predicted: "supported" }, { gold: "insufficient", predicted: "supported" },
    { gold: "insufficient", predicted: "unknown" }, { gold: "contradicted", predicted: null },
  ]);
  assert.equal(r.n, 4);
  assert.equal(r.missingPrediction, 1);
  assert.equal(r.accuracy, 1 / 3);
  assert.equal(r.unknownRate, 1 / 3);
  assert.equal(r.confusion.insufficient.supported, 1);
  assert.equal(r.perLevel.supported.precision, 0.5);
  assert.equal(r.perLevel.insufficient.recall, 0);
  assert.ok(r.macroF1 !== null && Math.abs(r.macroF1 - (2 / 3 + 0) / 2) < 1e-9);
  const rows = labelRows(fixture()).get("H1") ?? [];
  const cases = buildHistoricalCases("H1", rows, { split: () => "train" });
  const report = evaluate(cases, cases.map((c) => ({ caseId: c.caseId, target: c.expected.target ?? "unknown", name: c.expected.name ?? "unknown" })), ["explicit", "derived", "weak"]);
  assert.equal(report.target.accuracy, 1);
  assert.equal(report.name.accuracy, 1);
  assert.equal(report.name.n, cases.filter((c) => c.expected.name !== null).length);
  // Headline without weak gold: target (all M-derived, weak) drops out, ER-derived names stay.
  const headline = evaluate(cases, []);
  assert.equal(headline.target.n, 0);
  assert.equal(headline.name.n, report.name.n);
});

// Invented AI-session record; slot ids and figures are fictional.
function session(): SessionRecord {
  return {
    events: [
      { id: "e1", seq: 1, speaker: "ai", text: "どれから話しましょう？" },
      { id: "e2", seq: 2, speaker: "human", text: "家みたいなのある？" },
      { id: "e3", seq: 3, speaker: "ai", text: "はい、わかります。" },
      { id: "e4", seq: 4, speaker: "human", text: "じゃあ家で。" },
      { id: "e5", seq: 5, speaker: "ai", text: "家でいきましょう。" },
    ],
    judgments: [
      { lastEventId: "e2", status: "committed", judgment: { action: "accept", targetSlot: "a-1" } },
      { lastEventId: "e4", status: "committed", judgment: { action: "agree", targetSlot: "a-1", candidateName: "家" } },
      { lastEventId: "e4", status: "discarded", judgment: { action: "agree" } },
    ],
    scoring: { key: { ai: { "a-1": "F1" }, human: { "h-1": "F2", "h-2": "F1" } } },
  };
}

test("AI turns: history stops before the reply; the answer key is used offline only", () => {
  const record = session();
  const turns = aiTurns(record);
  assert.deepEqual(turns.map((t) => [t.seq, t.history.length, t.history.at(-1)?.speaker]), [[3, 2, "partner"], [5, 4, "partner"]]);
  assert.equal(offlineCorrect(record, "a-1", "h-1"), false);
  assert.equal(offlineCorrect(record, "a-1", "h-2"), true);
  assert.equal(offlineCorrect(record, null, "h-1"), null);
  const notes: TurnAnnotation[] = [
    { seq: 3, target: "insufficient", name: "unclear", tags: ["unfounded_wakarimasu"], basis: ["synthetic"], quality: "weak", episode: "E1", partnerSlot: "h-1" },
  ];
  assert.deepEqual(validateAnnotation(notes[0]), []);
  assert.ok(validateAnnotation({ ...notes[0], tags: ["nope"] }).includes("tags"));
  const cases = buildAiTurnCases(record, notes, { dialogueKey: "SYN-AI", split: "dev", externalModelAllowed: false });
  assert.equal(cases.length, 2);
  for (const c of cases) assert.deepEqual(validateEvalCase(c), []);
  assert.equal(cases[0].offlineCorrect, false);
  assert.equal(cases[0].correctnessKnown, true);
  assert.equal(cases[1].offlineCorrect, null);
  assert.deepEqual(cases[1].labelBasis, ["unannotated"]);
  const input = JSON.stringify(toJudgeInput(cases[0]));
  assert.doesNotMatch(input, /F1|F2|h-1|a-1|はい、わかります/);
  const report = detection(cases, [{ caseId: cases[0].caseId, target: "insufficient", name: "unclear" }, { caseId: cases[1].caseId, target: "supported", name: "agreed" }]);
  assert.equal(report.perTag.unfounded_wakarimasu.rate, 1);
  assert.equal(report.untagged, 1);
  assert.equal(report.falseAlarmRate, 0);
  assert.equal(affirmationCandidate("はい、わかります。"), true);
  assert.equal(affirmationCandidate("どれのことですか？"), false);
});

test("skeleton text uses none of the source characters and stays local-only in buildAll", () => {
  const rows = labelRows(fixture()).get("H1") ?? [];
  for (const r of rows) {
    const text = renderSkeleton(r);
    assert.ok(text.length > 0);
    assert.ok(!text.includes(r.text), "source utterance is not copied");
  }
  assert.match(renderSkeleton(rows[7]), /違う/);
  const all = buildAll([...fixture(1), ...fixture(2), ...fixture(3)], {});
  assert.ok(all.skeleton.length > 0);
  assert.ok(all.skeleton.every((c) => c.source === "synthetic" && c.externalModelAllowed === false && c.split !== "holdout"));
  assert.ok(all.historical.every((c) => c.externalModelAllowed === false));
  assert.deepEqual(findLeakage(all.historical), []);
  assert.equal(all.distributions.all.rows, 30);
});

test("the builder's output guard rejects the repository, any .git checkout and symlinks into it", async () => {
  await assert.rejects(outsideRepositoryDirectory("dialogue-model/x"));
  const dir = await mkdtemp(join(tmpdir(), "jev-evalset-"));
  try {
    assert.ok(await outsideRepositoryDirectory(join(dir, "out")));
    await symlink(process.cwd(), join(dir, "link"));
    await assert.rejects(outsideRepositoryDirectory(join(dir, "link", "out")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
