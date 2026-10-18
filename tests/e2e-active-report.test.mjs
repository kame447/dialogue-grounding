import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSession } from "../dialogue-model/runtime/diagnostics/e2e-active-report.mjs";

const empty = (ids) => Object.fromEntries(ids.map((id) => [id, { status: "unassigned", name: null }]));
const AI = ["a1", "a2", "a3", "a4", "a5", "a6"], HUMAN = ["h1", "h2", "h3", "h4", "h5", "h6"];
const key = { human: Object.fromEntries(HUMAN.map((id, i) => [id, "F" + (i + 1)])), ai: Object.fromEntries(AI.map((id, i) => [id, "F" + (i + 1)])) };

function record() {
  const before = empty(AI);
  const named = { ...before, a1: { status: "agreed", name: "船" } };
  return {
    version: 2, status: "completed", seed: 99, strategy: "repair-first", options: { activeDecision: "decision_jev" },
    events: [{ speaker: "human" }, { speaker: "ai" }, { speaker: "human" }, { speaker: "ai" }, { speaker: "human" }, { speaker: "ai" }],
    humanSubmission: { h1: "船", h2: "鳥", h3: null, h4: "犬", h5: null, h6: null },
    judgments: [
      { status: "committed", turnIndex: 1, ownLedgerBefore: { ...before, a1: { status: "tentative", name: "船" } },
        judgment: { action: "agree", targetSlot: "a1", candidateName: "船", followUp: { action: "propose_name", targetSlot: "a2", candidateName: "鳥" } },
        activeJudge: { lunaAction: "agree", decisionAction: "agree", finalAction: "agree", resolution: "decision", latencyMs: 400, costUsd: 0.00004 } },
      // Agreed "犬" on a3 (F3) while the human's 犬 is F4: a wrong in-dialogue agreement.
      { status: "committed", turnIndex: 3, ownLedgerBefore: { ...named, a3: { status: "tentative", name: "犬" } },
        judgment: { action: "agree", targetSlot: "a3", candidateName: null },
        activeJudge: { lunaAction: "confirm", decisionAction: "agree", finalAction: "agree", resolution: "decision", latencyMs: 600, costUsd: 0.00004 } },
      // Repair released a1 whose name matched the human's figure: a wrong repair.
      { status: "committed", turnIndex: 5, ownLedgerBefore: named,
        judgment: { action: "repair", targetSlot: "a1", candidateName: null },
        activeJudge: { lunaAction: "confirm", decisionAction: "agree", finalAction: "repair", resolution: "rerank", latencyMs: 500, costUsd: 0.00005 } },
      { status: "superseded", turnIndex: 6, judgment: { action: "agree", targetSlot: "a2" } },
    ],
    attempts: [{ status: "committed" }, { status: "generation_error" }],
    requests: [{ status: "ok", latencyMs: 3000 }, { status: "error", latencyMs: 100 }],
    scoring: { key, result: { matchedCount: 1, total: 6, figures: [
      { figureId: "F1", human: { rawName: "船" }, ai: { rawName: "船" }, matched: true },
      { figureId: "F4", human: { rawName: "犬" }, ai: { rawName: null }, matched: false }] } },
  };
}

test("summarises a completed active-judge session against the key, after submission only", () => {
  const s = summarizeSession(record());
  assert.equal(s.matched, 1);
  assert.equal(s.humanMessages, 3);
  assert.equal(s.aiTurns, 3, "superseded judgments are not counted as turns");
  assert.deepEqual(s.agreements, { total: 2, correct: 1, wrong: 1 });
  assert.deepEqual(s.repairs, { total: 1, wrong: 1 });
  assert.deepEqual(s.finalActions, { agree: 2, propose_name: 1, repair: 1 });
  assert.equal(s.activeJudge.turns, 3);
  assert.deepEqual(s.activeJudge.resolutions, { decision: 2, rerank: 1 });
  assert.equal(s.activeJudge.decisionDiffersFromLuna, 2);
  assert.equal(s.activeJudge.latencyMs.median, 500);
  assert.ok(Math.abs(s.activeJudge.costUsd - 0.00013) < 1e-12);
  assert.equal(s.lunaRequests.errors, 1);
  assert.equal(s.supersededAttempts, 1);
  assert.deepEqual(s.finalMismatches, [{ figure: "F4", human: "犬", ai: null }]);
});

test("refuses unfinished trials so it cannot be used mid-session", () => {
  assert.throws(() => summarizeSession({ ...record(), status: "dialogue" }), /completed v2 record/);
  assert.throws(() => summarizeSession({ ...record(), scoring: null }), /completed v2 record/);
});
