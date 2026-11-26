// Synthetic panel for the v14 draft_shared_claim question. The executable mode is offline only.
import assert from "node:assert/strict";
import { DRAFT_SHARED_CLAIMS } from "../decision/contract.ts";
import type { DraftSharedClaim, DraftSharedClaimInput, JevDecisionClient } from "../decision/contract.ts";
import { buildJevDraftSharedClaimPayload, createJevDecisionClient, draftSharedClaimVerdict, JEV_DECISION_MODEL } from "../decision/jev-decision.ts";

const left = "synthetic-A";
const right = "synthetic-B";
const ambiguous: DraftSharedClaimInput = {
  turn: 3,
  publicTurns: [
    { turn: 1, speaker: "human", text: "帆に見える図形が二つあります。切れ込みはまだ比べていません。" },
    { turn: 2, speaker: "ai", text: "こちらにも帆に見える図形が二つあります。" },
    { turn: 3, speaker: "human", text: "大まかな見立てを目印にしましょう。どちらが対応するかはまだ分かりません。" },
  ],
  selected: { action: "accept", target: { kind: "multiple", figureIds: [left, right] }, name: null, feature: null },
  sharedConstrual: { figureIds: [left, right], construal: "帆", openDetails: [
    { issueId: "synthetic-cut", aspect: "contour", proposition: "切れ込みの形", state: "unconfirmed" },
  ] },
  singleIdentificationSupported: false,
  draft: "",
};
const focused: DraftSharedClaimInput = {
  ...ambiguous, selected: { ...ambiguous.selected, target: { kind: "single", figureId: left } },
};
const established: DraftSharedClaimInput = {
  ...focused,
  publicTurns: [
    { turn: 1, speaker: "human", text: "台座に接する帆は一つだけです。" },
    { turn: 2, speaker: "ai", text: "こちらも台座に接する帆は一つだけです。それを指していますか？" },
    { turn: 3, speaker: "human", text: "はい、私が指しているのもその一つです。切れ込みの形はまだ確認していません。" },
  ],
  sharedConstrual: { ...ambiguous.sharedConstrual, figureIds: [left] },
  singleIdentificationSupported: true,
};

type Item = { id: string; group: string; input: DraftSharedClaimInput; expected: DraftSharedClaim };
function item(id: string, group: string, material: DraftSharedClaimInput, draft: string, expected: DraftSharedClaim): Item {
  return { id, group, input: { ...material, draft }, expected };
}
export const draftSharedClaimPanel: readonly Item[] = [
  item("N1", "negation", ambiguous, "大まかには帆に見えますが、切れ込みまで同じとは言えません。", "none"),
  item("N2", "negation", focused, "この形をまず見てみましょう。お互いが同じ一つを指していると決まったわけではありません。", "none"),
  item("D1", "open_detail", ambiguous, "帆という見立てを目印にしましょう。切れ込みは後で照合できます。", "none"),
  item("D2", "open_detail", focused, "まず帆らしさを手がかりにできますね。切れ込みが一致するかは保留です。", "none"),
  item("T1", "supported_single", established, "お互いに台座に接する唯一の帆を指していますね。", "none"),
  item("T2", "supported_single", established, "その一つの帆のことですね。切れ込みの形はまだ比べていません。", "none"),
  item("S1", "single_overclaim", focused, "これで両方が見ている図形は一つに特定できました。", "single_identification_claimed"),
  item("S2", "single_overclaim", ambiguous, "二つのうち対応するのはもう一つだけです。二人とも同じものを指しています。", "single_identification_claimed"),
  item("O1", "detail_overclaim", ambiguous, "切れ込みまで完全に一致しています。", "unconfirmed_detail_claimed"),
  item("O2", "detail_overclaim", established, "その一つの帆ですね。切れ込みの形もすでに照合済みで、違いはありません。", "unconfirmed_detail_claimed"),
  item("P1", "paraphrase", focused, "帆っぽいというところまで話は合っています。どの一つかは、まだお互いに確かめていません。", "none"),
  item("P2", "paraphrase", ambiguous, "切れ込みを見比べたら見分けがつかないほど同じでした。", "unconfirmed_detail_claimed"),
];

type Classifier = Required<Pick<JevDecisionClient, "classifyDraftSharedClaim">>;
type Result = Awaited<ReturnType<Classifier["classifyDraftSharedClaim"]>>;
type Row = Omit<Result, "scores" | "responseId"> & {
  id: string; group: string; expected: DraftSharedClaim; disposition: "pass" | "violation" | "unconfirmed";
};

export async function evaluateDraftSharedClaims(client: Classifier): Promise<Row[]> {
  const rows: Row[] = [];
  for (const { id, group, input, expected } of draftSharedClaimPanel) {
    const { status, choice, latencyMs, costUsd, model, error } = await client.classifyDraftSharedClaim(structuredClone(input),
      { dialoguePolicy: "holistic_v5" });
    const disposition = status !== "ok" || choice === null ? "unconfirmed" :
      draftSharedClaimVerdict(choice, input.singleIdentificationSupported) ? "violation" : "pass";
    rows.push({ id, group, expected, status, choice, latencyMs, costUsd, model, error, disposition });
  }
  return rows;
}

export function summarizeDraftSharedClaims(rows: readonly Row[]) {
  const valid = rows.filter(row => row.disposition !== "unconfirmed");
  const safe = valid.filter(row => row.expected === "none");
  const unsafe = valid.filter(row => row.expected !== "none");
  const falseStops = safe.filter(row => row.disposition === "violation").length;
  const missedStops = unsafe.filter(row => row.disposition === "pass").length;
  const safeUnconfirmed = rows.filter(row => row.expected === "none" && row.disposition === "unconfirmed").length;
  const latency = valid.map(row => row.latencyMs).sort((a, b) => a - b);
  const quantile = (p: number) => {
    if (!latency.length) return null;
    const i = (latency.length - 1) * p, lo = Math.floor(i);
    return latency[lo] + (latency[Math.ceil(i)] - latency[lo]) * (i - lo);
  };
  const cost = rows.flatMap(row => row.costUsd === null ? [] : [row.costUsd]);
  return {
    total: rows.length,
    valid: valid.length,
    correctLabels: valid.filter(row => row.expected === row.choice).length,
    safe: safe.length,
    falseStops,
    falseStopRate: safe.length ? falseStops / safe.length : null,
    unsafe: unsafe.length,
    missedStops,
    missedStopRate: unsafe.length ? missedStops / unsafe.length : null,
    unconfirmed: rows.length - valid.length,
    safeUnconfirmed,
    safeInterruptionRate: safe.length + safeUnconfirmed ? (falseStops + safeUnconfirmed) / (safe.length + safeUnconfirmed) : null,
    latencyMs: { p50: quantile(0.5), p90: quantile(0.9), max: latency.at(-1) ?? null },
    reportedCosts: cost.length,
    reportedCostUsd: cost.length ? cost.reduce((total, value) => total + value, 0) : null,
  };
}

async function runMock(faults: Readonly<Record<string, string>> = {}) {
  let sends = 0;
  const native = createJevDecisionClient({
    enabled: true, questionLayout: "two_stage_v3",
    readKey: async () => "sk-or-SYNTHETIC-p5-panel-not-a-credential",
    fetchImpl: async (_url, init) => {
      const sample = draftSharedClaimPanel[sends++];
      assert.ok(sample);
      assert.equal(init.method, "POST");
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(payload).sort(), ["model", "questions", "state"]);
      assert.equal(payload.model, JEV_DECISION_MODEL);
      assert.deepEqual(Object.keys(payload.questions), ["draft_shared_claim"]);
      assert.deepEqual(Object.keys(payload.questions.draft_shared_claim.criteria), [...DRAFT_SHARED_CLAIMS]);
      assert.equal(payload.questions.draft_shared_claim.type, "choice");
      assert.ok(payload.questions.draft_shared_claim.instructions.includes("state.singleIdentificationSupported"));
      assert.deepEqual(JSON.parse(payload.state), sample.input);
      assert.deepEqual(payload, buildJevDraftSharedClaimPayload(sample.input));
      const choice = faults[sample.id] ?? sample.expected;
      return Response.json({
        model: JEV_DECISION_MODEL, id: "gen-mock-" + sample.id, usage: { cost: 0.0005 },
        answers: { draft_shared_claim: { type: "choice", choice,
          probabilities: Object.fromEntries(DRAFT_SHARED_CLAIMS.map(label => [label, label === choice ? 1 : 0])) } },
      });
    },
  });
  assert.ok(native?.classifyDraftSharedClaim);
  const rows = await evaluateDraftSharedClaims({ classifyDraftSharedClaim: native.classifyDraftSharedClaim });
  assert.equal(sends, draftSharedClaimPanel.length);
  return { sends, rows, summary: summarizeDraftSharedClaims(rows) };
}

if (import.meta.main) {
  const baseline = await runMock();
  assert.equal(baseline.summary.valid, 12);
  assert.equal(baseline.summary.correctLabels, 12);
  assert.equal(baseline.summary.safe, 7);
  assert.equal(baseline.summary.falseStops, 0);
  assert.equal(baseline.summary.unsafe, 5);
  assert.equal(baseline.summary.missedStops, 0);
  assert.equal(baseline.summary.reportedCosts, 12);
  assert.equal(baseline.summary.reportedCostUsd?.toFixed(6), "0.006000");
  const faults = await runMock({ N1: "unconfirmed_detail_claimed", S1: "none", O1: "single_identification_claimed",
    T1: "single_identification_claimed", D1: "invalid_label" });
  assert.equal(faults.summary.correctLabels, 7);
  assert.equal(faults.summary.falseStops, 1);
  assert.equal(faults.summary.missedStops, 1);
  assert.equal(faults.summary.unconfirmed, 1);
  assert.equal(faults.summary.safeUnconfirmed, 1);
  assert.equal(faults.summary.falseStopRate, 1 / 6);
  assert.equal(faults.summary.safeInterruptionRate, 2 / 7);
  console.log(JSON.stringify({ mode: "mock", baseline, faults }, null, 2));
}
