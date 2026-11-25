// Luna public-act consistency, final-audit condition: an AI name offer is checked against ALL public
// events, not the 32-turn reference window. Real createNamingTaskV2 → dialogue-v2 → createLunaJudge wiring
// with a scripted upstream client; judge intents are injected, so this checks source mechanics only.
import test from "node:test";
import assert from "node:assert/strict";
import { createScriptedTrial, A, act, ref, type Step } from "./helpers/memory-harness.ts";
import { REFERENCE_LIMITS } from "../dialogue-model/runtime/memory/reference-graph.mjs";

type Rec = Record<string, any>;
const FILLERS = 27; // enough neutral turns to push the offer's AI event outside the reference window
const offer: Step = { human: "尖りが二つある形から", act: act("propose_name", A, "帆"), reference: ref([A], "grounded", "refer"),
  reply: "この形は「帆」と呼ぶのはどうでしょう？" };
const accepted: Step = { human: "はい。", act: act("accept"), reference: ref([A], "hypothesis", "name_acceptance"), reply: "よかったです。" };
const denial: Step = { human: "帆ではないです。", act: act("accept"),
  reference: ref([A], "grounded", "denial", { nameAcceptance: { slot: A, name: "帆" } }), reply: "そうなんですね。" };
const filler = (i: number): Step => ({ human: `次の形の話です${i}。`, act: act("accept"), reference: ref([], "unresolved", "refer"), reply: "はい。" });
// The partner never repeats the name here, so only the AI offer (source A) can support the agree.
const agree: Step = { human: "では、さっきの形はそれで。", act: act("agree", A, "帆"), reference: ref([A], "hypothesis", "refer"),
  reply: "はい、「帆」にしましょう。" };
const reoffer: Step = { ...offer, human: "もう一度考えましょう。", reply: "では「帆」でもう一度どうでしょう？" };
const fillers = Array.from({ length: FILLERS }, (_, i) => filler(i));

async function play(steps: Step[], strategy: string, { cut = null }: { cut?: number | null } = {}) {
  let trial = await createScriptedTrial({ steps, referenceMemory: true, strategy });
  for (let i = 0; i < steps.length; i++) {
    if (i === cut) {
      // Persisted records travel as JSON; resume through the task's real restore entry.
      const restore = JSON.parse(JSON.stringify(trial.records.at(-1)!));
      trial = await createScriptedTrial({ steps, referenceMemory: true, strategy, restore });
    }
    await trial.say(i);
  }
  return trial.records.at(-1)! as Rec;
}
const offerOutsideWindow = (record: Rec, agreeSeq: number) => {
  const offerSeq = record.events.find((e: Rec) => e.speaker === "ai" && e.text === offer.reply).seq;
  assert.ok(agreeSeq - offerSeq >= REFERENCE_LIMITS.publicTurns, "the offer's AI event is outside the reference window at the agree");
};

for (const strategy of ["repair-first", "bypass-enabled"]) {
  for (const cut of [null, 2 + FILLERS]) {
    const label = `${strategy}${cut === null ? "" : ", restored before the agree"}`;

    test(`window (${label}): a shown, accepted, unrevoked AI offer still supports agree after it leaves the reference window`, async () => {
      const steps = [offer, accepted, ...fillers, agree];
      const record = await play(steps, strategy, { cut });
      const last = record.judgments.at(-1);
      offerOutsideWindow(record, last.turnIndex);
      assert.equal(last.judgment.action, "agree"); assert.equal(last.validation.fallback, false);
      assert.deepEqual(record.ownLedger[A], { status: "agreed", name: "帆" });
      assert.equal(last.publication.primary, "applied");
    });

    test(`window control (${label}): a named denial lapses the old offer; a fresh offer and acceptance then agree`, async () => {
      const steps = [offer, accepted, denial, ...fillers.slice(0, FILLERS - 1), agree];
      const rejected = await play(steps, strategy, { cut: cut === null ? null : 2 + FILLERS });
      const last = rejected.judgments.at(-1);
      offerOutsideWindow(rejected, last.turnIndex);
      assert.notEqual(last.judgment.action, "agree"); assert.equal(last.validation.fallback, true);
      assert.deepEqual(last.validation.failures, ["agree_requires_public_name", "agree_requires_public_name"]);
      assert.deepEqual(rejected.ownLedger[A], { status: "tentative", name: "帆" });
      const renewed = await play([...steps.slice(0, -1), reoffer, accepted, agree], strategy, { cut });
      assert.equal(renewed.judgments.at(-1).judgment.action, "agree");
      assert.deepEqual(renewed.ownLedger[A], { status: "agreed", name: "帆" });
    });
  }
}

test("window: the restored record keeps humanNaming and publication exactly as saved", async () => {
  const steps = [offer, accepted, denial, ...fillers];
  let trial = await createScriptedTrial({ steps, referenceMemory: true });
  for (let i = 0; i < steps.length; i++) await trial.say(i);
  const saved = JSON.parse(JSON.stringify(trial.records.at(-1)!));
  const restored = await createScriptedTrial({ steps, referenceMemory: true, restore: saved });
  const pick = (judgments: Rec[]) => judgments.map((j) => ({ humanNaming: j.humanNaming, publication: j.publication }));
  assert.deepEqual(pick(restored.task.researcherView().privateState.judgments), pick(saved.queueState.privateState.judgments));
  assert.ok(saved.queueState.privateState.judgments.some((j: Rec) => j.humanNaming.intent === "denial" && j.humanNaming.name === "帆"));
});
