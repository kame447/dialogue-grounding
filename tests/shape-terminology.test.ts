import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SHAPE_TERMINOLOGY, SHAPE_TERMINOLOGY_GENERATION } from "../dialogue-model/runtime/shape-terminology.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import type { InterventionReplayResult, InterventionReplaySide } from "../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";
import type { Plan } from "./support/s4-v3-records.ts";

const human = "この形のことです。輪郭は三角の形ですか。";
const speech = "この形の輪郭には四角い部分もあります。";
const target = OWN.ownAnchors[0].id;
const plan: Plan = {
  action: "accept", target: "figure_0", referent: "figure_0",
  choose: key => key === "human_move_on_source" ? "other" : undefined,
  extraction: JSON.stringify([
    { segmentId: "a", quote: "この形のことです", proposition: "この形を指す", targets: [target], aspect: "referent", name: null, linkedIssueId: null, respondsToTurn: null },
    { segmentId: "b", quote: "輪郭は三角の形ですか", proposition: "輪郭が三角形か確認する", targets: [target], aspect: "contour", name: null, linkedIssueId: null, respondsToTurn: null },
  ]),
  speech,
};

function capture(generationRetryVersion: "jev_generation_retry_v17" | typeof SHAPE_TERMINOLOGY_GENERATION) {
  return buildRecords({ dialoguePolicy: "holistic_v5", technicalTrial: { version: "adaptive_repair_v3" },
    interventionVersion: "bypass_acceptance_v2", agreeNameScopeVersion: "jev_naming_v1",
    judgmentMaterialVersion: "jev_repair_quality_v1", generationRetryVersion, turns: [{ human, plan }] });
}

type Request = InterventionReplaySide["requests"][number];
type Message = { role: string; content: string };
const messages = (request: Request) => (request.payload as { messages: Message[] }).messages;
const resultOf = (records: Awaited<ReturnType<typeof buildRecords>>): InterventionReplayResult => records.trials[0].replay[0].result;
const withTerminology = await capture(SHAPE_TERMINOLOGY_GENERATION);

test("v18 gives the models the whole-figure and contour usages in context", () => {
  const wire = resultOf(withTerminology).sides[0].requests;
  for (const [phase, promptIndex] of [["local_extraction", 0], ["ai_extraction", 0], ["generation", 1]] as const) {
    const call = wire.find(request => request.phase === phase);
    assert.ok(call, phase);
    assert.equal(messages(call)[promptIndex].role, "system");
    assert.ok(messages(call)[promptIndex].content.endsWith("\n" + SHAPE_TERMINOLOGY), phase);
    assert.ok(messages(call).some(message => message.role === "user" && message.content.includes(human)), phase);
  }
  const extraction = wire.find(request => request.phase === "ai_extraction")!;
  const prompt = withTerminology.trials[0].attempts[0].aiPublic.prompts.extraction;
  assert.deepEqual(prompt, { version: 2, sha256: createHash("sha256").update(messages(extraction)[0].content).digest("hex") });
  for (const phase of ["human_referent", "decision"]) {
    const calls = wire.filter(request => request.phase === phase);
    assert.ok(calls.length, phase);
    for (const request of calls) {
      const payload = request.payload as { state: string; questions: Record<string, { instructions: string }> };
      assert.ok(payload.state.includes(human), phase);
      assert.ok(Object.values(payload.questions).every(question => question.instructions.endsWith("\n" + SHAPE_TERMINOLOGY)), phase);
    }
  }
});

test("v18 uses the same clarification in both strategies and replays in S4", () => {
  const result = resultOf(withTerminology);
  assert.equal(result.commonEqual, true);
  assert.deepEqual(result.sides.map(side => side.label), ["repair-first", "bypass-enabled"]);
  const [repair, bypass] = result.sides.map(side => side.requests.map(({ phase, preProjectionPayloadSha256 }) =>
    [phase, preProjectionPayloadSha256]));
  assert.deepEqual(repair, bypass);
  const checks = verifyRecords(withTerminology).checks.filter(check => check.id.startsWith("intervention.trial.0.attempt.0."));
  assert.equal(checks.length, 4);
  for (const check of checks) assert.equal(check.status, "pass", check.id);
});

test("v17 requests retain their original bytes", async () => {
  const legacy = await capture("jev_generation_retry_v17");
  const rows = resultOf(legacy).sides.map(side => [side.label, side.requests.map(({ provider, phase, preProjectionPayloadSha256 }) =>
    [provider, phase, preProjectionPayloadSha256])]);
  // Measured on the unmodified 8b44104 source with this synthetic turn.
  assert.equal(createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    "2661db7077e68492bd3985bb8405dd406c192aac354c7b95d5af27122d19e036");
  assert.equal(legacy.trials[0].attempts[0].aiPublic.prompts.extraction.version, 1);
});
