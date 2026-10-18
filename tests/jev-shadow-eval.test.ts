// Jev 2-axis shadow comparison runner: synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayItems, classifyReply, agreedSlotOutcome } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/replay.ts";
import type { SessionRecordLike } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/replay.ts";
import { auditRecord, auditCases, inputLeaks, answerKeyTokens, toJudgeInput } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/audit.ts";
import { shadowFlags } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/metrics.ts";
import { mockVerdict, createMockJevAxesClient } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/mock-client.ts";
import { runShadow, budgeted, groundingAxesClient, parseCase, parseKnownFailure, main, liveAllowed } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/run.ts";
import { buildGroundingEvidence } from "../dialogue-model/runtime/grounding/evidence.ts";
import { createMockGroundingJudge } from "../dialogue-model/runtime/grounding/client.ts";
import type { EvalCaseLike, JevAxesClient, JevAxesInput } from "../dialogue-model/runtime/diagnostics/jev-shadow-eval/types.ts";

const SECRET_TEXT = "合成テキスト固有語ZQX";
const judgment = (turnIndex: number, action: string, targetSlot: string | null = null, candidateName: string | null = null) =>
  ({ turnIndex, status: "committed", judgment: { action, targetSlot, candidateName, discriminatingFeature: null } });

function syntheticRecord(): SessionRecordLike {
  const texts: [string, string][] = [
    ["ai", "どれから話しましょうか？"],
    ["human", "三角が二つある形ない？"],
    ["ai", "はい、わかります。" + SECRET_TEXT],
    ["human", "それそれ"],
    ["ai", "では「家」と呼ぶのはどうでしょう？"],
    ["human", "いいよ"],
    ["ai", "では「家」でいきましょう。"],
    ["human", "次は細長いやつ"],
    ["ai", "鳥みたいに見える形を「鳥」と呼びましょう。"],
    ["human", "違うと思う"],
    ["ai", "はい、「鳥」で決まりですね。"],
  ];
  return {
    recordId: "synthetic-0001", strategy: "repair-first",
    events: texts.map(([speaker, text], i) => ({ seq: i + 1, speaker, text, ...(i === 0 ? { origin: "scripted_opening" } : {}) })),
    judgments: [judgment(2, "accept"), judgment(4, "propose_name", "s-own1", "家"), judgment(6, "agree", "s-own1", "家"),
      judgment(8, "propose_name", "s-own2", "鳥"), judgment(10, "agree", "s-own2", "鳥")],
    scoring: { key: { ai: { "s-own1": "F1", "s-own2": "F2" }, human: { "s-hum1": "F1", "s-hum2": "F2" } },
      result: { success: false, matchedCount: 1, total: 2, figures: [{ figureId: "F1", matched: true }, { figureId: "F2", matched: false }] } },
  };
}

const syntheticCase = (over: Partial<EvalCaseLike> = {}): EvalCaseLike => ({
  caseId: "syn-1", source: "synthetic", groupId: "SYN-g1", split: "dev", externalModelAllowed: true,
  history: [{ speaker: "self", text: "尖った形のことですか？" }, { speaker: "partner", text: "そうそう" }],
  judgedTurnIndex: 1, expected: { target: "supported", name: null }, labelQuality: "derived", ...over,
});

test("replay: one item per AI reply, history is the public prefix before it, hypothesis from its judgment", () => {
  const record = syntheticRecord();
  const items = replayItems(record);
  assert.deepEqual(items.map((i) => i.aiSeq), [3, 5, 7, 9, 11]);
  assert.equal(items[0].history.length, 2);
  assert.ok(items.every((i) => i.history.length === i.aiSeq - 1));
  assert.ok(!items[0].history.some((t) => t.text.includes(SECRET_TEXT)), "reply text must not be in its own history");
  assert.deepEqual(items[1].history.map((t) => t.speaker), ["self", "partner", "self", "partner"]);
  assert.equal(items[2].oldAction, "agree");
  assert.equal(items[2].hypothesis?.targetSlot, "s-own1");
  assert.equal(agreedSlotOutcome(record, "s-own1"), true);
  assert.equal(agreedSlotOutcome(record, "s-own2"), false);
  assert.equal(agreedSlotOutcome(record, null), null);
  assert.throws(() => replayItems({ events: [{ seq: 1, speaker: "x", text: "" }] }));
});

test("audit: no future or answer-key leakage in judge inputs; gaps and unpaired turns are counted", () => {
  const record = syntheticRecord();
  const audit = auditRecord(record, replayItems(record));
  assert.deepEqual(audit.futureTurnLeaks, []);
  assert.deepEqual(audit.answerKeyLeaks, []);
  assert.deepEqual(audit.seqGaps, []);
  assert.deepEqual(answerKeyTokens(record).sort(), ["F1", "F2", "s-hum1", "s-hum2"]);
  const leaky = toJudgeInput({ ...replayItems(record)[0], hypothesis: { action: "confirm", targetSlot: "s-hum1", candidateName: null, discriminatingFeature: null } });
  assert.equal(inputLeaks(leaky, answerKeyTokens(record)), true);
  assert.equal(inputLeaks({ history: [], gold: 1 } as unknown as JevAxesInput, []), true, "unexpected fields count as leakage");
  const gapped = { ...record, events: record.events!.filter((e) => e.seq !== 6) };
  assert.deepEqual(auditRecord(gapped, replayItems(gapped)).seqGaps, [6]);
});

test("runShadow refuses to judge when an input would leak", async () => {
  const record = syntheticRecord();
  record.judgments![1].judgment!.targetSlot = "s-hum2";
  await assert.rejects(runShadow({ record, client: createMockJevAxesClient() }), /leakage/);
});

test("reply behaviours from recorded action and public wording", () => {
  assert.deepEqual(classifyReply("はい、わかります。", "accept"), ["claims_understanding"]);
  assert.ok(classifyReply("「家」と呼ぶのはどうでしょう？", "propose_name").includes("naming"));
  assert.ok(classifyReply("では「家」でいきましょう。", "agree").includes("agreement"));
  assert.ok(classifyReply("鳥みたいに見えます。", "accept").includes("impression_sharing"));
  assert.ok(classifyReply("この形はあとで戻りましょう。", "defer").includes("hold_or_revisit"));
  assert.ok(classifyReply("尖った形のことですか？", "confirm").includes("confirmation"));
  assert.ok(classifyReply("はい、左に尖った角がある形です。", "confirm").includes("claims_understanding"), "affirmative answer asserts the referent");
  assert.ok(!classifyReply("あります。左に尖った角がある形ですか？", "confirm").includes("claims_understanding"), "hedged by a verification question");
  assert.ok(!classifyReply("はい、「家」でいきましょう。", "agree").includes("claims_understanding"));
  assert.ok(classifyReply("尖った形のことを、山と言っていますか？", "confirm").includes("naming"));
});

test("flag rules: unknown abstains; agreement against evidence is contradictory", () => {
  assert.deepEqual(shadowFlags(["claims_understanding"], { target: "insufficient", name: "unclear" }), ["unfounded_wakarimasu"]);
  assert.deepEqual(shadowFlags(["claims_understanding"], { target: "unknown", name: "unknown" }), []);
  assert.deepEqual(shadowFlags(["claims_understanding"], null), []);
  assert.deepEqual(shadowFlags(["naming"], { target: "contradicted", name: "unclear" }), ["early_naming"]);
  assert.deepEqual(shadowFlags(["naming"], { target: "supported", name: "unclear" }), []);
  assert.deepEqual(shadowFlags(["naming", "agreement"], { target: "insufficient", name: "unclear" }), ["early_naming", "contradictory_agreement"]);
  assert.deepEqual(shadowFlags(["agreement"], { target: "supported", name: "not_agreed" }), ["contradictory_agreement"]);
  assert.deepEqual(shadowFlags(["agreement"], { target: "supported", name: "agreed" }), []);
  assert.deepEqual(shadowFlags(["confirmation"], { target: "supported", name: "agreed" }), ["over_confirmation"]);
});

test("mock dry run over a synthetic session: detection and outside-list accounting", async () => {
  const run = await runShadow({ record: syntheticRecord(), client: createMockJevAxesClient(),
    knownFailures: [{ aiSeq: 3, tags: ["unfounded_wakarimasu"], otherTags: [], basis: "synthetic" }, { aiSeq: 11, tags: ["contradictory_agreement"], otherTags: [], basis: "synthetic" },
      { aiSeq: 99, tags: ["early_naming"], otherTags: [], basis: "synthetic" }, { aiSeq: 5, tags: [], otherTags: [], basis: "synthetic" },
      { aiSeq: 7, tags: [], otherTags: ["wrong_target_agreement"], basis: "synthetic" }] });
  assert.equal(run.meta.client, "mock");
  assert.equal(run.turns.aiTurns, 5);
  assert.equal(run.turns.knownFailures.detectedTagMatch, 2);
  assert.deepEqual(run.turns.knownFailures.missingFromReplay, [99]);
  assert.equal(run.turns.knownFailures.total, 3, "untagged and offline-only rows are not in the detection denominator");
  assert.equal(run.turns.flagsOnReviewedNegatives.turns, 2);
  assert.deepEqual(run.turns.knownFailures.otherTags.map((o) => o.aiSeq), [7]);
  // seq 9 announces a decision ("呼びましょう") under propose_name, so it counts as an agreement turn.
  assert.deepEqual(run.turns.agreeTurnsOffline, { total: 3, endedMatched: 1, flaggedAndEndedMismatched: 2, flaggedAndEndedMatched: 0 });
  assert.ok(!JSON.stringify(run).includes(SECRET_TEXT), "results carry no utterance text");
  assert.deepEqual(mockVerdict({ history: [] }), { target: "unknown", name: "unknown" });
});

test("live runs: never the session replay, never non-synthetic or unsendable cases, budget enforced", async () => {
  const sent: JevAxesInput[] = [];
  const fake: JevAxesClient = { kind: "live", async judgeAxes(input) { sent.push(input); return { target: "supported", name: "unclear", model: "m", latencyMs: 12, usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } }; } };
  await assert.rejects(runShadow({ record: syntheticRecord(), client: fake, maxCalls: 5 }), /mock only/);
  const cases = [syntheticCase({ caseId: "a" }), syntheticCase({ caseId: "b", source: "historical" }), syntheticCase({ caseId: "c", externalModelAllowed: false }),
    syntheticCase({ caseId: "d", source: "ai_session" }), syntheticCase({ caseId: "e" }), syntheticCase({ caseId: "f" })];
  const run = await runShadow({ cases, client: fake, maxCalls: 2 });
  assert.equal(sent.length, 2);
  assert.equal(run.meta.calls.total, 2, "a call refused by the budget is not a call");
  assert.deepEqual(run.meta.calls.failureCodes, {});
  assert.equal(run.meta.stopped, "budget_exhausted");
  assert.equal(run.meta.calls.costUsd, 0.002);
  assert.deepEqual(run.meta.models, ["m"]);
  const again = await runShadow({ cases: [syntheticCase({ caseId: "a" }), syntheticCase({ caseId: "a#r2" })], client: fake, maxCalls: 2 });
  assert.deepEqual(again.cases.repeatStability, { pairs: 1, identical: 1 });
  const mixed = await runShadow({ cases: [syntheticCase({ caseId: "w", labelQuality: "weak" }), syntheticCase({ caseId: "d" })], client: createMockJevAxesClient() });
  assert.equal(mixed.cases.bySplit.dev.headline.cases, 1, "weak labels are excluded from headline numbers");
  const perAxis = await runShadow({ cases: [syntheticCase({ caseId: "e", labelQuality: "weak", expected: { target: "supported", name: "agreed" },
    axisQuality: { target: "weak", name: "derived" } })], client: createMockJevAxesClient() });
  assert.equal(perAxis.cases.bySplit.dev.headline.target.goldPresent, 0, "weak target gold is dropped");
  assert.equal(perAxis.cases.bySplit.dev.headline.name.goldPresent, 1, "derived name gold on the same case stays");
  assert.equal(perAxis.cases.bySplit.dev.byQuality.weak.target.goldPresent, 1);
  assert.equal(perAxis.cases.bySplit.dev.byQuality.weak.name.goldPresent, 0, "per-quality rows are per axis too");
  assert.equal(perAxis.cases.bySplit.dev.byQuality.derived.name.goldPresent, 1);
  assert.deepEqual(Object.keys(mixed.cases.bySplit.dev.byQuality), ["derived", "weak"]);
  assert.equal(liveAllowed(cases[1]), false);
  assert.equal(liveAllowed(cases[3]), false);
  assert.equal(liveAllowed(syntheticCase({ externalModelAllowed: undefined })), false, "unmarked is not sendable");
  assert.equal(liveAllowed({ ...syntheticCase(), sendable: true, externalModelAllowed: undefined } as EvalCaseLike), false, "no alias: only externalModelAllowed counts");
});

test("live runs stop on a missing route and report it", async () => {
  let calls = 0;
  const notFound: JevAxesClient = { kind: "live", async judgeAxes() { calls += 1; throw Object.assign(new Error("x"), { code: "not_found" }); } };
  const run = await runShadow({ cases: [syntheticCase({ caseId: "a" }), syntheticCase({ caseId: "b" })], client: notFound, maxCalls: 10 });
  assert.equal(calls, 1);
  assert.equal(run.meta.stopped, "not_found");
  assert.deepEqual(run.meta.calls.failureCodes, { not_found: 1 });
});

test("budget wrapper rejects invalid verdicts and invalid budgets", async () => {
  assert.throws(() => budgeted(createMockJevAxesClient(), -1));
  const bad: JevAxesClient = { kind: "live", async judgeAxes() { return { target: "maybe", name: "agreed", model: null, latencyMs: 0 } as never; } };
  const wrapped = budgeted(bad, 1);
  await assert.rejects(wrapped.judgeAxes({ history: [] }));
  assert.equal(wrapped.log[0].code, "invalid_response");
});

test("grounding adapter maps speakers, judges as of the last public turn and passes nothing else", async () => {
  let built: unknown = null;
  const client = groundingAxesClient({
    buildState(input) { built = input; return { state: "STATE" }; },
    async judge(request) {
      assert.deepEqual(request, { purpose: "grounding_jev", state: "STATE" });
      return { model: "jev-x", identification: { level: "insufficient", scores: { insufficient: 0.6 } }, nameAgreement: { level: "unclear" }, usage: null, latencyMs: 5 };
    },
  });
  const v = await client.judgeAxes({ history: [{ speaker: "self", text: "a" }, { speaker: "partner", text: "b" }] });
  assert.deepEqual(built, { events: [{ seq: 1, speaker: "ai", text: "a" }, { seq: 2, speaker: "human", text: "b" }], asOfSeq: 2, aiHypothesis: null });
  assert.equal(v.target, "insufficient");
  assert.equal(client.kind, "live");
});

test("adapter runs end to end on the real grounding evidence builder with its mock judge", async () => {
  const states: string[] = [];
  const judge = createMockGroundingJudge((state) => { states.push(state);
    return { identification: state.includes("そうそう") ? "supported" : "insufficient", nameAgreement: "unclear" }; });
  const client = groundingAxesClient({ buildState: buildGroundingEvidence, judge: (request) => judge.judge(request) });
  const run = await runShadow({ cases: [syntheticCase()], client, maxCalls: 1 });
  assert.deepEqual(run.meta.calls.failureCodes, {});
  assert.equal(run.cases.bySplit.dev.headline.target.agreement, 1);
  assert.equal(states.length, 1);
  assert.ok(!states[0].includes("supported\"") && !states[0].includes("derived"), "no gold or quality in the judge state");
});

test("case audit: split leakage by group, historical marked sendable, label distribution", () => {
  const audit = auditCases([syntheticCase({ caseId: "a", groupId: "g1", split: "dev" }), syntheticCase({ caseId: "b", groupId: "g1", split: "holdout" }),
    syntheticCase({ caseId: "b", source: "historical", groupId: "g2", expected: { target: null, name: "agreed" } }),
    syntheticCase({ caseId: "c", judgedTurnIndex: 0 })]);
  assert.equal(audit.groupsInSeveralSplits, 1);
  assert.equal(audit.duplicateCaseIds, 1);
  assert.equal(audit.historicalMarkedSendable, 1);
  assert.equal(audit.turnsAfterFocal, 1);
  assert.deepEqual(audit.goldTarget, { supported: 3, no_gold: 1 });
  assert.equal(parseCase({ ...syntheticCase(), expected: { target: "yes", name: null } }), null);
  assert.equal(parseCase({ ...syntheticCase(), history: [{ speaker: "A", text: "x" }] }), null);
  assert.ok(parseCase(syntheticCase()));
  assert.deepEqual(parseKnownFailure({ aiTurnSeq: 3, tags: ["early_naming", "state_mismatch"], basis: ["a", "b"] }),
    { aiSeq: 3, tags: ["early_naming"], otherTags: ["state_mismatch"], basis: "a,b", expected: null });
  assert.equal(parseKnownFailure({ tags: [] }), null);
  assert.equal(auditCases([syntheticCase({ judgedTurnIndex: 2 })]).focalOutOfRange, 0, "history.length means the reply to come");
});

test("CLI: mock by default, private output outside the repo with 0600 files, live needs a budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-shadow-"));
  const recordPath = join(dir, "record.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(recordPath, JSON.stringify(syntheticRecord()));
  writeFileSync(join(dir, "cases.jsonl"), JSON.stringify(syntheticCase()) + "\n{\"bad\":1}\n");
  const out = join(dir, "out");
  const lines: string[] = [];
  await main(["--record", recordPath, "--cases", join(dir, "cases.jsonl"), "--out", out], (l) => lines.push(l));
  assert.deepEqual(readdirSync(out).sort(), ["shadow-report.private.md", "shadow-run.json", "shadow-summary.sanitized.md"]);
  for (const f of readdirSync(out)) assert.equal(statSync(join(out, f)).mode & 0o777, 0o600);
  const summary = readFileSync(join(out, "shadow-summary.sanitized.md"), "utf8");
  assert.ok(!summary.includes(SECRET_TEXT) && !summary.includes("尖った形"));
  assert.match(summary, /uncalibrated/);
  const saved = JSON.parse(readFileSync(join(out, "shadow-run.json"), "utf8"));
  assert.equal(saved.caseResults.length, 1, "per-case verdicts are kept for offline re-scoring");
  assert.ok(!JSON.stringify(saved).includes("尖った形"), "the private run file holds no case text either");
  assert.match(lines[0], /"casesInvalid":1/);
  await assert.rejects(main(["--record", recordPath, "--out", "dialogue-model/tmp-out"]), /repository_output_forbidden/);
  await assert.rejects(main(["--cases", join(dir, "cases.jsonl"), "--out", out, "--client", "live"]), /max-calls/);
  await assert.rejects(main(["--cases", join(dir, "cases.jsonl"), "--out", out, "--client", "live", "--max-calls", "51"]), /max-calls/);
  await assert.rejects(main(["--record", recordPath, "--cases", join(dir, "cases.jsonl"), "--out", out, "--client", "live", "--max-calls", "5"]), /mock only/);
});
