// Opt-in concise style: one function per turn removes the followUp from the
// judged act itself, before ledger, memory and generation. Local mocks only.
import test from "node:test";
import assert from "node:assert/strict";
import { createDialogueV2, LUNA_CONCISE_INSTRUCTIONS_V2, UTTERANCE_STYLES } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createHumanMessageQueue } from "../dialogue-model/runtime/web/human-message-queue.mjs";
import { SAFE_JUDGMENT, applyJudgment } from "../dialogue-model/runtime/judgment/schema.mjs";
import { DECISION_ACTIONS } from "../workers/research-ai-proxy/src/decisions.mjs";
import { aiTurnsFromRecord, auditTurn, summarize } from "../dialogue-model/runtime/v2/utterance-metrics.ts";

type Message = { role: string; content: unknown };
const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const events = [{ id: "e-1", seq: 1, speaker: "human", text: "鳥みたいですね。" }];
const followUp = { action: "propose_name", targetSlot: ids[1], candidateName: "猫", discriminatingFeature: null };
const agreeWithFollowUp = { ...SAFE_JUDGMENT, action: "agree", targetSlot: ids[0], candidateName: "鳥", discriminatingFeature: null, followUp };

function setup({ utteranceStyle, strategy = "repair-first", raw = agreeWithFollowUp, referenceMemory = false, active = false }:
  { utteranceStyle?: string; strategy?: string; raw?: object; referenceMemory?: boolean; active?: boolean } = {}) {
  const calls: Message[][] = [];
  const dialogue = createDialogueV2({ strategy, image, anchors, referenceMemory, ...(utteranceStyle === undefined ? {} : { utteranceStyle }),
    judge: { async judge(): Promise<any> { return structuredClone(raw); } }, // raw, validated by the session
    client: { async complete(messages: Message[]) { calls.push(structuredClone(messages));
      // Publish the followUp proposal only when the generator was actually given one (default style keeps it, concise drops it).
      const planned = messages.some((m) => typeof m.content === "string" && m.content.startsWith("この発話の判断（非公開）") && /"followUp":\{/.test(m.content));
      return { text: "では「鳥」で決まりですね。" + (planned ? "次は「猫」はどうでしょう？" : "") }; } },
    activeDecision: active ? { purpose: "decision_luna", client: { async chooseAction() {
      return { action: "agree", probabilities: Object.fromEntries(DECISION_ACTIONS.map((a: string) => [a, Number(a === "agree")])) }; } } } : null,
  });
  const state = dialogue.initialPrivateState();
  state.ledger[ids[0]] = { status: "tentative", name: "鳥" };
  return { dialogue, calls, state, run: () => dialogue.runAiTurn({ events, lastEventId: "e-1", privateState: state, signal: new AbortController().signal }) };
}

test("style option is validated; default is unchanged whether omitted or explicit", async () => {
  assert.deepEqual([...UTTERANCE_STYLES], ["default", "concise"]);
  assert.throws(() => setup({ utteranceStyle: "short" }), /Invalid utterance style/);
  const omitted = setup(), explicit = setup({ utteranceStyle: "default" });
  const a = await omitted.run(), b = await explicit.run();
  assert.deepEqual(a, b); assert.deepEqual(omitted.calls, explicit.calls);
  assert.ok(!JSON.stringify(omitted.calls).includes(LUNA_CONCISE_INSTRUCTIONS_V2.slice(0, 12)));
  assert.equal(a.privateState.ledger[ids[1]].name, "猫", "default keeps compound acts");
  assert.ok(!Object.hasOwn(a.privateState.judgments[0], "utteranceStyle"));
});

test("concise removes followUp before the ledger and generation, and records it privately", async () => {
  const s = setup({ utteranceStyle: "concise" }); const before = structuredClone(s.state); const r = await s.run();
  const committed = r.privateState.judgments[0];
  assert.equal(committed.judgment.followUp, null);
  assert.deepEqual(committed.utteranceStyle, { style: "concise", droppedFollowUp: followUp });
  assert.deepEqual(r.privateState.ledger, applyJudgment(before.ledger, { ...agreeWithFollowUp, followUp: null }));
  assert.deepEqual(r.privateState.ledger[ids[1]], { status: "unassigned", name: null });
  assert.equal(r.privateState.ledger[ids[0]].status, "agreed");
  const generation = JSON.stringify(s.calls[0]);
  assert.ok(generation.includes(LUNA_CONCISE_INSTRUCTIONS_V2.slice(0, 12)));
  assert.doesNotMatch(generation, /猫|followUpで言えること/u);
  assert.deepEqual(s.state, before, "input state stays detached");
});

test("concise without followUp changes only the generation instruction", async () => {
  const raw = { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: ids[0], candidateName: "鳥", discriminatingFeature: null };
  const d = setup({ raw }), c = setup({ raw, utteranceStyle: "concise" });
  const dr = await d.run(), cr = await c.run();
  assert.deepEqual(cr.privateState.ledger, dr.privateState.ledger);
  assert.deepEqual(cr.privateState.judgments[0].utteranceStyle, { style: "concise", droppedFollowUp: null });
  assert.equal(c.calls[0].length, d.calls[0].length + 1);
  assert.deepEqual(c.calls[0].filter((m) => m.content !== LUNA_CONCISE_INSTRUCTIONS_V2), d.calls[0]);
});

test("concise keeps agreeEvidence and the conservative active gate", async () => {
  const unassigned = { ...SAFE_JUDGMENT, action: "agree", targetSlot: ids[2], candidateName: "犬", discriminatingFeature: null };
  for (const utteranceStyle of ["default", "concise"]) {
    await assert.rejects(setup({ raw: unassigned, utteranceStyle }).run(), /agree_requires_shared_identification/);
  }
  const accept = { ...SAFE_JUDGMENT, action: "accept", targetSlot: ids[0], candidateName: null, discriminatingFeature: null };
  const r = await setup({ raw: accept, utteranceStyle: "concise", active: true }).run();
  assert.notEqual(r.privateState.judgments[0].judgment.action, "agree");
  assert.equal(r.privateState.ledger[ids[0]].status, "tentative");
});

test("concise with reference memory and active decision still drops followUp once", async () => {
  const s = setup({ utteranceStyle: "concise", referenceMemory: true, active: true }); const r = await s.run();
  const committed = r.privateState.judgments[0];
  assert.equal(committed.judgment.action, "agree"); assert.equal(committed.judgment.followUp, null);
  assert.equal(committed.activeJudge.droppedFollowUp, false, "the style removed it before the active judge");
  assert.deepEqual(committed.utteranceStyle.droppedFollowUp, followUp);
  assert.deepEqual(r.privateState.ledger[ids[1]], { status: "unassigned", name: null });
});

test("both strategies are identical under concise", async () => {
  const a = setup({ utteranceStyle: "concise", strategy: "repair-first" }), b = setup({ utteranceStyle: "concise", strategy: "bypass-enabled" });
  assert.deepEqual(await a.run(), await b.run()); assert.deepEqual(a.calls, b.calls);
});

// Mock E2E: a generator that voices every act it is given. Under default the
// followUp is spoken (two functions); under concise the act is gone from both
// the text and the ledger, so neither path has a ledger/public mismatch.
test("mock E2E across strategies: concise yields one function per turn without ledger/public mismatch", async () => {
  const script = [
    { ...SAFE_JUDGMENT, action: "accept", targetSlot: ids[0], candidateName: "鳥", discriminatingFeature: null },
    { ...SAFE_JUDGMENT, action: "agree", targetSlot: ids[0], candidateName: null, discriminatingFeature: null,
      followUp: { action: "propose_name", targetSlot: ids[1], candidateName: "猫", discriminatingFeature: null } },
    { ...SAFE_JUDGMENT, action: "confirm", targetSlot: ids[1], candidateName: null, discriminatingFeature: "尖り" },
  ];
  const voice = (messages: Message[]) => {
    const act = JSON.parse(String(messages.find((m) => String(m.content).startsWith("この発話の判断"))!.content).split("\n")[2]);
    const main = { accept: "鳥みたいですね。", agree: "では「鳥」と呼びましょう。", confirm: "尖りがある形のことですか？" }[act.action as "accept"];
    return { text: main + (act.followUp ? "次は「猫」と呼ぶのはどうでしょう？" : "") };
  };
  const results: Record<string, ReturnType<typeof summarize>> = {};
  for (const strategy of ["repair-first", "bypass-enabled"]) for (const utteranceStyle of ["default", "concise"]) {
    let turn = 0;
    const dialogue = createDialogueV2({ strategy, image, anchors, utteranceStyle, judge: { async judge(): Promise<any> { return structuredClone(script[turn++]); } },
      client: { async complete(messages: Message[]) { return voice(messages); } } });
    const queue = createHumanMessageQueue({ runAiTurn: dialogue.runAiTurn, initialPrivateState: dialogue.initialPrivateState() });
    for (const [i, text] of ["鳥っぽいのある？", "それそれ。", "猫っぽいのも"].entries()) { queue.enqueue({ clientId: `turn-${i}`, text }); await queue.whenIdle(); }
    const snapshot = queue.getSnapshot(), state = queue.getPrivateState();
    assert.doesNotMatch(JSON.stringify(snapshot), /utteranceStyle|droppedFollowUp/);
    const record = { events: snapshot.events, judgments: state.judgments };
    results[`${strategy}/${utteranceStyle}`] = summarize(aiTurnsFromRecord(record).map(auditTurn));
    // Ledger names that were never said publicly would be a mismatch.
    const spoken = snapshot.events.filter((e: { speaker: string }) => e.speaker === "ai").map((e: { text: string }) => e.text).join("");
    for (const slot of ids) { const name = state.ledger[slot].name; if (name) assert.ok(spoken.includes(name), `${strategy}/${utteranceStyle}: ${name}`); }
    assert.equal(state.ledger[ids[1]].name, utteranceStyle === "default" ? "猫" : null);
  }
  assert.deepEqual(results["repair-first/default"], results["bypass-enabled/default"]);
  assert.deepEqual(results["repair-first/concise"], results["bypass-enabled/concise"]);
  assert.equal(results["repair-first/default"].multiFunctionShare, 0.333);
  assert.equal(results["repair-first/concise"].multiFunctionShare, 0);
  assert.equal(results["repair-first/concise"].publicOnlyAgreement, 0);
});
