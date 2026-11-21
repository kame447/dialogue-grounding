// Researcher-only ja-turn-eval diagnostics: synthetic cases, mock clients, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { CASES, NOTES, SEED, AXES, modelInput } from "../dialogue-model/runtime/diagnostics/ja-turn-eval/cases.mjs";
import { jobs, runJob, labelTarget, privateStateFor } from "../dialogue-model/runtime/diagnostics/ja-turn-eval/run.ts";
import { buildPrompt, verifiedModel, parseReply, labelOrder, SITUATIONS } from "../dialogue-model/runtime/diagnostics/ja-turn-eval/argon.ts";
import { createTrialV2 } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";
import { JUDGE_POLICIES } from "../dialogue-model/runtime/judgment/instructions.mjs";

const trial = createTrialV2({ seed: SEED });

test("case ids and intended referents are the seed board's own AI ids", () => {
  const own = trial.ai.anchors.map((a: any) => a.id);
  for (const c of CASES) {
    assert.deepEqual(Object.keys(c.ledger), own);
    const intended = NOTES[c.id].intended;
    if (intended !== null) assert.ok(own.includes(intended));
    assert.equal(c.events.at(-1)!.speaker, "human");
    assert.ok(SITUATIONS[c.id]);
    for (const p of c.prior) assert.ok(p.targetSlot === null || own.includes(p.targetSlot));
  }
  assert.equal(jobs().length, CASES.length * 2);
  assert.deepEqual(AXES.length, 10);
});

test("model input carries only public events, own ledger and own prior acts", () => {
  for (const c of CASES) {
    const input = modelInput(c);
    assert.deepEqual(Object.keys(input).sort(), ["events", "ownLedger", "prior"]);
    const text = JSON.stringify(input);
    for (const example of [...NOTES[c.id].good, ...NOTES[c.id].bad, SITUATIONS[c.id]]) assert.ok(!text.includes(example));
    assert.ok(!/F[1-6]|s-3cde|s-80b0|s-4643|s-5c45|s-cf10|s-6e63/.test(text), "no figure labels or human-side ids");
    const state = privateStateFor(input);
    assert.equal(state.judgments.length, c.prior.length);
  }
});

function mockClient(calls: any[]) {
  return { async complete(messages: any[], options: any) {
    calls.push({ messages, options });
    if (options?.phase === "judgment") return { text: JSON.stringify({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: "" }), model: "mock-model" };
    return { text: "そうですね。", model: "mock-model" };
  } };
}

// runJob also rejects an invalid case ledger (invalid_ledger) for every case.
test("both strategies send the same requests except the judge policy; no researcher notes or key reach the model", async () => {
  for (const c of CASES) {
    const byStrategy: Record<string, any[]> = {};
    for (const strategy of ["repair-first", "bypass-enabled"]) {
      const calls: any[] = [];
      const row = await runJob({ id: c.id + ":" + strategy, caseId: c.id, strategy }, mockClient(calls));
      assert.deepEqual(row.models, calls.map(() => "mock-model"));
      byStrategy[strategy] = calls;
    }
    const strip = (calls: any[], policy: string) => JSON.stringify(calls.map((call) => call.messages)).split(JSON.stringify(policy).slice(1, -1)).join("<policy>");
    assert.equal(strip(byStrategy["repair-first"], JUDGE_POLICIES["repair-first"]), strip(byStrategy["bypass-enabled"], JUDGE_POLICIES["bypass-enabled"]));
    const sent = JSON.stringify(byStrategy["repair-first"]);
    for (const secret of [...NOTES[c.id].good, ...NOTES[c.id].bad, SITUATIONS[c.id], JSON.stringify(trial.key)]) assert.ok(!sent.includes(secret));
    for (const humanId of Object.keys(trial.key.human)) assert.ok(!sent.includes(humanId));
  }
});

test("target label counts a repair followUp that re-attaches the name to the intended figure", () => {
  const intended = "s-9181";
  assert.equal(labelTarget({ targetSlot: "s-f05c", followUp: { targetSlot: intended } }, intended), "intended");
  assert.equal(labelTarget({ targetSlot: "s-f05c", followUp: null }, intended), "other_figure");
  assert.equal(labelTarget({ targetSlot: null }, intended), "unbound");
  assert.equal(labelTarget({ targetSlot: null }, null), "unbound");
  assert.equal(labelTarget({ targetSlot: "s-f05c" }, null), "bound_in_ambiguous_case");
});

test("judge prompt is blind: no strategy names, internal ids, acts or researcher examples", () => {
  for (const c of CASES) {
    const prompt = buildPrompt(c.id, { "repair-first": "発話いち", "bypass-enabled": "発話に" });
    assert.ok(!/repair-first|bypass-enabled|s-[0-9a-f]{4}|propose_name|targetSlot|"action"/.test(prompt));
    for (const example of [...NOTES[c.id].good, ...NOTES[c.id].bad]) assert.ok(!prompt.includes(example));
    const [x] = labelOrder(c.id);
    assert.ok(prompt.indexOf("X: " + (x === "repair-first" ? "発話いち" : "発話に")) > 0);
    assert.deepEqual(labelOrder(c.id), labelOrder(c.id));
  }
});

test("the judge model counts only when the agy log shows that exact model reached the backend", () => {
  const line = (label: string) => `model_config_manager.go:340] Propagating selected model override to backend: label="${label}"\n`;
  assert.equal(verifiedModel(line("Gemini 4 Argon (Medium)").repeat(3), "gemini-4-argon-medium"), "gemini-4-argon-medium");
  assert.equal(verifiedModel(line("Gemini 4 Argon (Medium)") + line("Gemini 3.8 Flash (Medium)"), "gemini-4-argon-medium"), null);
  assert.equal(verifiedModel("Model resolved via default\n", "gemini-4-argon-medium"), null);
  assert.equal(verifiedModel(line("Gemini 4 Argon (High)"), "gemini-3.8-flash-medium"), null);
});

test("judge replies are validated before use", () => {
  const one = { scores: Object.fromEntries(AXES.map((a: string) => [a, null])), overall: 3, verdict: "acceptable", confidence: "high", reason: "r" };
  const ok = JSON.stringify({ status: "SUCCESS", response: "```json\n" + JSON.stringify({ X: one, Y: one }) + "\n```" });
  assert.equal(parseReply(ok).reply.X.verdict, "acceptable");
  assert.throws(() => parseReply(JSON.stringify({ status: "ERROR", response: "" })), /judge_failed/);
  const bad = { ...one, scores: { ...one.scores, naturalness: 9 } };
  assert.throws(() => parseReply(JSON.stringify({ status: "SUCCESS", response: JSON.stringify({ X: bad, Y: one }) })), /invalid_judge_reply/);
});
