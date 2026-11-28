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
  assert.equal(rows[3].entries.find(e => e.label === "外部要求")?.value.model, "SECOND");
  assert.ok(rows[2].entries.every(e => e.value.model !== "SECOND"));
  assert.equal(rows[3].entries.find(e => e.label === "API送信記録")?.value.model, "JEV");
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
  assert.match(html, /popovertarget="turn-detail-3"/);
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

test("separates human interpretation from actual AI action and attaches later classification to the AI utterance", () => {
  const traces = structuredClone(record.jevTraces) as any[];
  Object.assign(traces[1], {
    publicSpeech: "応答",
    humanReferent: { scores: { f1: .8 }, status: "ok", model: "jev-exact", latencyMs: 312 },
    local: { localStatus: "ok", extractor: { segments: [{ segmentId: "s1", quote: "補足", aspect: "shape" }] },
      classifier: { kind: "jev_local_test", model: "jev-exact", status: "ok", verdicts: [{ segmentId: "s1", act: "deny" }] },
      verification: { accepted: ["s1"], rejected: [] } },
    aiPublic: { pending: { aiSeq: 4, status: "ready", candidates: [{ quote: "応答", act: "ask", aspect: "shape" }] },
      stages: { ai_function: { status: "ok", calls: 1, model: "jev-exact", choices: [{ segmentId: "a1", act: "ask" }] } } },
  });
  traces[1].decisions[0].evidence = { stages: [{ stage: "action", model: "jev-exact", latencyMs: 432 }] };
  // A later uncommitted attempt cannot claim that it applied the preceding AI memory.
  traces[2].aiPublic = { application: { aiSeq: 4, status: "applied" } };
  const source = { ...record, jevTraces: traces, requests: [
    { requestSeq: 8, kind: "local_extraction", model: "terra-human", status: "ok", latencyMs: 12 },
    { requestSeq: 8, kind: "generation", model: "terra-ai", status: "ok", latencyMs: 34 },
    { requestSeq: 8, kind: "ai_extraction", model: "terra-post", status: "ok", latencyMs: 56 },
  ], deferredAiExtractionTimings: [{ eventId: "a1", requestSeq: 8, status: "complete", startedAtMs: 10, finishedAtMs: 30 }],
  aiPublicSettlement: { status: "ok", records: [{ turnIndex: 3, lastEventId: "h2", attemptNumber: 8, aiSeq: 4, status: "published_unapplied", sourceStatus: "ready" }] } };
  const html = render(source);
  const row = (n: number) => html.match(new RegExp('<tr id="utterance-' + n + '">([\\s\\S]*?)</tr>'))![1];
  const human = row(3), ai = row(4);
  assert.match(human, /人間の参照先/); assert.match(human, /補足 \/ deny \/ shape/); assert.match(human, /terra-human/);
  assert.doesNotMatch(human, /vetoed_bypass_action|terra-ai|terra-post|Jev・action/);
  assert.match(ai, /方略介入/); assert.match(ai, /実行：<\/span>repair/);
  assert.match(ai, /Jev・action \/ jev-exact \/ 432 ms/); assert.match(ai, /terra-ai/); assert.match(ai, /terra-post/);
  assert.match(ai, /公開発話の論点/); assert.match(ai, /分類時間：<\/span>20 ms/); assert.match(ai, /published_unapplied/);
  assert.doesNotMatch(ai, /人間の参照先|terra-human|前のAI発話のメモリ反映試行/);
  assert.match(row(5), /前のAI発話のメモリ反映試行（未確定）/);
  assert.equal(buildTurnSheet(source, summarizeLatency(source)).unmatched.length, 0);
});

test("shows the deferred classification as unfinished during an ongoing experiment, then on the same AI row when it settles", () => {
  const traces = structuredClone(record.jevTraces) as any[];
  traces[1].aiPublic = { pending: null, stages: { ai_function: { status: "not_called", calls: 0 } } };
  const running = { ...record, status: "dialogue", jevTraces: traces, deferredAiExtractionTimings: [
    { eventId: "a1", requestSeq: 8, status: "running", startedAtMs: 10, finishedAtMs: null },
  ] };
  assert.match(render(running).match(/<tr id="utterance-4">([\s\S]*?)<\/tr>/)![1], /発話後の分類：<\/span>running/);
  traces[1].aiPublic = { pending: { aiSeq: 4, status: "ready", candidates: [] }, stages: { ai_function: { status: "ok", calls: 1, model: "jev" } } };
  const complete = { ...running, deferredAiExtractionTimings: [{ eventId: "a1", requestSeq: 8, status: "complete", startedAtMs: 10, finishedAtMs: 20 }] };
  const ai = render(complete).match(/<tr id="utterance-4">([\s\S]*?)<\/tr>/)![1];
  assert.match(ai, /発話後の分類：<\/span>complete/);
  assert.match(ai, /Jev・ai_function/);
});

test("does not associate a contradictory publication with an unrelated AI utterance", () => {
  const traces = structuredClone(record.jevTraces) as any[];
  traces[1].publicSpeech = "別の発話";
  const r = { ...record, jevTraces: traces };
  const { rows } = buildTurnSheet(r, summarizeLatency(r));
  assert.equal(rows[3].responseTo, null);
  assert.ok(!rows[3].entries.length);
  assert.ok(rows[2].entries.some(e => e.label === "AI応答試行（未公開・対応未確定）"));
});
