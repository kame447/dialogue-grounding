import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnSheet, renderTurnSheet } from "../workers/tangram-experiment/src/admin/turn-sheet.ts";
import { escapeHtml } from "../workers/tangram-experiment/src/admin/render.ts";
import { summarizeLatency } from "../workers/tangram-experiment/src/admin/latency.ts";

const events = [
  { id: "opening", seq: 1, speaker: "ai", text: "開始", at: "2026-11-24T00:00:00Z", origin: "scripted_opening" },
  { id: "h1", seq: 2, speaker: "human", text: "一つ目", at: "2026-11-24T00:00:01Z" },
  { id: "h2", seq: 3, speaker: "human", text: "補足", at: "2026-11-24T00:00:02Z" },
  { id: "a1", seq: 4, speaker: "ai", text: "応答", at: "2026-11-24T00:00:04Z" },
  { id: "h3", seq: 5, speaker: "human", text: "次", at: "2026-11-24T00:00:05Z" },
];
const record = {
  events,
  turnTimings: [
    { requestSeq: 7, lastEventId: "h1", outcome: "superseded", pendingEventIds: ["h1"] },
    { requestSeq: 8, lastEventId: "h2", outcome: "returned", pendingEventIds: ["h1","h2"] },
    { requestSeq: 9, lastEventId: "h3", outcome: "error" },
  ],
  jevTraces: [
    { turnIndex: 2, lastEventId: "h1", attemptNumber: 7, status: "superseded", decisions: [] },
    { turnIndex: 3, lastEventId: "h2", attemptNumber: 8, status: "committed",
      humanReferent: { scores: { f1: 0.8, f2: 0.2 } }, decisions: [{ action: "defer", target: { kind: "single", figureId: "f1" } }],
      executed: { action: "repair", target: { kind: "single", figureId: "f2" }, name: null, feature: "特徴" },
      intervention: { disposition: "rejected", reasonCode: "vetoed_bypass_action" }, generationGuard: { violations: ["memory_unsupported_name"] },
      local: { localStatus: "ok", verification: { accepted: ["c1"], rejected: [] } } },
    { turnIndex: 5, lastEventId: "h3", attemptNumber: 9, status: "error", errorCode: "generation_failed" },
  ],
  requests: [
    { requestSeq: 7, kind: "generation", model: "FIRST", status: "ok", latencyMs: 100 },
    { requestSeq: 8, kind: "generation", model: "SECOND", status: "ok", latencyMs: 200 },
    { requestSeq: 9, kind: "generation", status: "error", errorCode: "timeout", latencyMs: 300 },
    { requestSeq: null, kind: "final_submission", status: "ok", latencyMs: 1 },
  ],
  jevLedger: { sends: [{ turn: 8, phase: "decision", model: "JEV", status: "observed_response" }] },
};
const summary = summarizeLatency(record);
const render = (r: Record<string,unknown>) => renderTurnSheet(r, summarizeLatency(r), { escape: escapeHtml, time: escapeHtml });

test("links requests, failed and superseded attempts to the exact input; links response only to the returned attempt", () => {
  const { rows, unmatched } = buildTurnSheet(record, summary);
  assert.equal(rows.length, events.length);
  assert.equal(rows[0].entries.length, 0);
  assert.equal(rows[1].entries.find(e => e.label === "外部要求")?.value.model, "FIRST");
  assert.equal(rows[2].entries.find(e => e.label === "外部要求")?.value.model, "SECOND");
  assert.equal(rows[2].entries.find(e => e.label === "API送信記録")?.value.model, "JEV");
  assert.equal(rows[3].responseTo, 3);
  assert.equal(rows[4].entries.find(e => e.label === "外部要求")?.value.errorCode, "timeout");
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].value.kind, "final_submission");
});

test("does not attach conflicting identities or assume request sequence equals utterance sequence", () => {
  const { rows, unmatched } = buildTurnSheet({ ...record,
    judgments: [{ turnIndex: 2, lastEventId: "h2", jevTurn: { attemptNumber: 8 } }],
    requests: [{ requestSeq: 8, model: "conflict" }, { requestSeq: 5, model: "unmapped" }],
  }, summary);
  assert.equal(rows[3].responseTo, null);
  assert.ok(rows.every(r => r.entries.every(e => e.label !== "外部要求")));
  assert.equal(unmatched.filter(e => e.label === "外部要求").length, 2);
  assert.equal(unmatched.filter(e => e.label === "確定判断").length, 1);
});

test("renders selected vs executed action, uncalibrated referent, guard failures, details and AI source link", () => {
  const html = render(record);
  assert.match(html, /選択：<\/span>defer/);
  assert.match(html, /実行：<\/span>repair/);
  assert.match(html, /vetoed_bypass_action/);
  assert.match(html, /人間の参照先（上位3・未校正）：<\/span>f1: 0.8/);
  assert.match(html, /入力発話：<\/span>2, 3/);
  assert.match(html, /memory_unsupported_name/);
  assert.match(html, /href="#utterance-3"/);
  assert.match(html, /popovertarget="turn-detail-2"/);
  assert.match(html, /popover="auto" id="turn-detail-2"/);
  assert.match(html, /発話に対応づけられない処理/);
});

test("legacy records preserve known memory rejection and unknown detail; hostile trace data stays escaped", () => {
  const html = render({events, judgments:[{turnIndex: 2, judgment:{action:"confirm",note:"<script>bad</script>"}}],
    attempts:[{turnIndex: 2, status:"staged", memory:{opsApplied: 0, rejected:"memory_not_literal_in_public_text"}}]});
  assert.match(html, /確定行動：<\/span>confirm/);
  assert.match(html, /memory_not_literal_in_public_text/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/i);
});
