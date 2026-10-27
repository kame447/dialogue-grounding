// Shared joint-reference text (HUMANLIKE-REFERENCE-2026-10-19): one inserted
// element in TASK_INSTRUCTIONS_V2 and one in GENERATOR_INSTRUCTIONS_V2, identical
// across strategies; v1 and every other v2 element stay byte-identical. Also the
// offline early-naming heuristics. Local mocks only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TASK_INSTRUCTIONS, TASK_INSTRUCTIONS_V2, JUDGE_POLICIES } from "../dialogue-model/runtime/judgment/instructions.mjs";
import { createDialogueV2, GENERATOR_INSTRUCTIONS_V2, CONCISE_INSTRUCTIONS_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createLunaJudge } from "../dialogue-model/runtime/judgment/luna.mjs";
import { SAFE_JUDGMENT, createOwnLedger } from "../dialogue-model/runtime/judgment/schema.mjs";
import { analyzeDialogue, checksJointReference, humanChecksPresence, humanRaisesNaming, raisesName, turnsFromRecord } from "../dialogue-model/runtime/diagnostics/joint-reference/early-naming.ts";
import type { Turn } from "../dialogue-model/runtime/diagnostics/joint-reference/early-naming.ts";

type Message = { role: string; content: unknown };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const lines = (text: string) => text.split("\n");
const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };

const TASK_ELEMENT = lines(TASK_INSTRUCTIONS_V2).find((l) => l.startsWith("人間同士の命名では"))!;
const GENERATOR_ELEMENT = lines(GENERATOR_INSTRUCTIONS_V2).find((l) => l.startsWith("accept・confirmでは、相手がまだ使っていない名前を"))!;

test("v1 task text and the concise text are byte-identical to origin/main 345706f", () => {
  assert.equal(sha(TASK_INSTRUCTIONS), "eab651c869324c43bb9332b0109f69fe7751a85753c800182fa49a997f271ae4");
  assert.equal(sha(CONCISE_INSTRUCTIONS_V2), "9f0f18e2d61142dda4dd86c5c36dfcff8f7cec3797c39a741c2737418cce1630");
});

test("v2 task and generator texts are the 345706f texts plus exactly one inserted element each", () => {
  assert.ok(TASK_ELEMENT && GENERATOR_ELEMENT);
  const task = lines(TASK_INSTRUCTIONS_V2), generator = lines(GENERATOR_INSTRUCTIONS_V2);
  assert.equal(sha(task.filter((l) => l !== TASK_ELEMENT).join("\n")), "aace4466dbc385f785fc80e5460b2426bee52937dc60375534f090cdb8aa2e56");
  assert.equal(sha(generator.filter((l) => l !== GENERATOR_ELEMENT).join("\n")), "39e8311cb4af7b13b8a7c92daea2c8424c27f56975d9ad6795a74d5c0cbc8e00");
  // Placed after the stage-separation element / the propose_name realisation rule.
  assert.match(task[task.indexOf(TASK_ELEMENT) - 1], /^見立ての共有、対象の同定、名称への合意は別の段階です/);
  assert.match(generator[generator.indexOf(GENERATOR_ELEMENT) - 1], /propose_nameでは相手が出した名前を候補として受けるだけにし/);
});

test("the new text pins the human-like sequence without fixed phrasings or strategy terms", () => {
  // tentative impression -> check the shared referent -> naming together; partner keeps the initiative.
  assert.match(TASK_ELEMENT, /同じ対象を指しているかを確かめ合ってから名前を相談します/);
  assert.match(TASK_ELEMENT, /相手が名前を出していないうちから名前を持ち出して先へ進めないでください/);
  assert.match(TASK_ELEMENT, /名前の提案は、相手が名前を求めたり提案したりしたとき、または同じ対象を指していると公開対話から言えるときに行えます/);
  assert.match(TASK_ELEMENT, /進め方は相手に任せてよく、相手の確認・異論・迷いに応じてください/);
  // The typed act and the public utterance stay aligned: propose_name/agree voice the name, accept/confirm do not raise one.
  assert.match(GENERATOR_ELEMENT, /accept・confirmでは、相手がまだ使っていない名前を自分から持ち出さず/);
  assert.doesNotMatch(GENERATOR_ELEMENT, /propose_name[^。]*名前を持ち出さず/);
  assert.match(GENERATOR_ELEMENT, /相手にもそう見えるものがあるかを尋ねられます/);
  for (const element of [TASK_ELEMENT, GENERATOR_ELEMENT]) {
    assert.doesNotMatch(element, /[「」『』]/u, "no quoted template utterances");
    assert.doesNotMatch(element, /repair-first|bypass-enabled|方略|保留|defer|move_on|確信度/u);
  }
  for (const policy of Object.values(JUDGE_POLICIES)) assert.ok(!policy.includes(TASK_ELEMENT.slice(0, 10)));
});

test("both strategies' judges receive the same shared element; only the policy message differs", async () => {
  const requests: Record<string, Message[]> = {};
  for (const strategy of ["repair-first", "bypass-enabled"] as const) {
    const judge = createLunaJudge({ async complete(messages: Message[]) { requests[strategy] = structuredClone(messages); return { text: JSON.stringify(SAFE_JUDGMENT) }; } });
    await judge.judge({ version: 2, image, ownAnchors: anchors, publicHistory: [{ role: "user", content: "鳥っぽいの、ありますか？" }], strategy, ownLedger: createOwnLedger(ids) });
  }
  const a = requests["repair-first"], b = requests["bypass-enabled"];
  assert.equal(a.length, b.length);
  const differing = a.map((m, i) => JSON.stringify(m) === JSON.stringify(b[i]) ? null : i).filter((i) => i !== null);
  assert.deepEqual(differing, [1]);
  assert.equal(a[1].content, JUDGE_POLICIES["repair-first"]);
  assert.equal(a[0].content, TASK_INSTRUCTIONS_V2);
  assert.ok((a[0].content as string).includes(TASK_ELEMENT));
});

test("generator requests carry both elements and are identical across strategies, default and concise", async () => {
  const raw = { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: ids[0], candidateName: "鳥", discriminatingFeature: null };
  for (const utteranceStyle of ["default", "concise"]) {
    const calls: Record<string, Message[]> = {};
    for (const strategy of ["repair-first", "bypass-enabled"]) {
      const dialogue = createDialogueV2({ strategy, image, anchors, utteranceStyle,
        judge: { async judge(): Promise<any> { return structuredClone(raw); } },
        client: { async complete(messages: Message[]) { calls[strategy] = structuredClone(messages); return { text: "こちらにも鳥っぽいのがあります。" }; } } });
      await dialogue.runAiTurn({ events: [{ id: "e-1", seq: 1, speaker: "human", text: "鳥っぽいの、ありますか？" }], lastEventId: "e-1",
        privateState: dialogue.initialPrivateState(), signal: new AbortController().signal });
    }
    assert.deepEqual(calls["repair-first"], calls["bypass-enabled"], utteranceStyle);
    const text = JSON.stringify(calls["repair-first"]);
    assert.ok(text.includes(JSON.stringify(TASK_ELEMENT).slice(1, -1)) && text.includes(JSON.stringify(GENERATOR_ELEMENT).slice(1, -1)), utteranceStyle);
  }
});

test("early-naming heuristics separate raising a name, agreeing, echoing and checking the referent", () => {
  assert.equal(raisesName("こっちにも船っぽい形があります。「船」と呼ぶのはどうでしょう？"), true);
  assert.equal(raisesName("「船」って呼ぶ形で合っていますか？"), true);
  assert.equal(raisesName("はい、「船」と呼びましょう。"), false, "a decision is agreement wording, not a raise");
  assert.equal(raisesName("はい、それで行きましょう。もう一つは「靴」と呼ぶのはどうでしょう？"), true, "sentence-local");
  assert.equal(raisesName("「船」という呼び方ですね。"), false, "echo of the partner's word");
  assert.equal(checksJointReference("帆みたいな大きい三角があるやつのことですか？"), true);
  assert.equal(checksJointReference("どれから話しましょうか？"), false);
  assert.equal(checksJointReference("「船」と呼ぶのはどうでしょう？"), false);
  assert.equal(humanRaisesNaming(["船って呼びません？"]), true);
  assert.equal(humanRaisesNaming(["じゃあそれは船で"]), true);
  assert.equal(humanRaisesNaming(["はい、船でお願いします。"]), true);
  assert.equal(humanRaisesNaming(["帆みたいな三角があって、端が細いです"]), false);
  assert.equal(humanChecksPresence(["船みたいなの、あります？"]), true);
});

test("analyzeDialogue counts unrequested early naming per figure mention, checks, agreements and correctness", () => {
  const act = (action: string, targetSlot: string | null = null) => ({ action, targetSlot, followUp: null });
  const turns: Turn[] = [
    { speaker: "ai", text: "どれから話しましょうか？" },
    { speaker: "human", text: "船みたいなの、あります？", goldFigure: "F1" },
    { speaker: "ai", text: "あります。「船」と呼ぶのはどうでしょう？", act: act("propose_name", ids[0]) },
    { speaker: "human", text: "帆みたいな三角があるやつです", goldFigure: "F1" },
    { speaker: "ai", text: "大きい三角があるやつのことですか？", act: act("confirm", ids[0]) },
    { speaker: "human", text: "船って呼びません？", goldFigure: "F1" },
    { speaker: "ai", text: "はい、「船」と呼びましょう。", act: act("agree", ids[0]) },
    { speaker: "human", text: "次、靴っぽいのは", goldFigure: "F2" },
    { speaker: "ai", text: "はい、「靴」でいきましょう。", act: act("agree", ids[1]) },
  ];
  const stats = analyzeDialogue(turns, { [ids[0]]: "F1", [ids[1]]: "F3" });
  assert.equal(stats.aiTurns, 4);
  assert.equal(stats.earlyNamingFirst, 1);
  assert.equal(stats.earlyNamingFirstOrSecond, 1);
  assert.equal(stats.presenceCheckAnsweredWithName, 1);
  assert.equal(stats.jointReferenceChecks, 1);
  assert.equal(stats.agrees, 2);
  assert.equal(stats.agreesUnrequested, 1);
  assert.equal(stats.agreesCorrect, 1);
  assert.equal(stats.firstAgreeHumanTurn, 3);
  assert.deepEqual(analyzeDialogue(turns).agreesCorrect, null, "no key, no correctness");
  assert.equal(stats.nameUnderOtherAct, 0);
  assert.equal(stats.proposeWithoutName, 0);
  const mismatched = analyzeDialogue([
    { speaker: "human", text: "船みたいなの、あります？" },
    { speaker: "ai", text: "「船」と呼ぶ形のことですか？", act: { action: "confirm", targetSlot: ids[0], candidateName: "船" } },
    { speaker: "human", text: "帆みたいな三角があるやつです" },
    { speaker: "ai", text: "こちらにもそう見えるのがあります。", act: { action: "propose_name", targetSlot: ids[0], candidateName: "船" } },
    { speaker: "human", text: "船って呼びません？" },
    { speaker: "ai", text: "船、いいですね。そう呼ぶのはどうでしょう？", act: { action: "propose_name", targetSlot: ids[0], candidateName: "船" } },
  ]);
  assert.equal(mismatched.nameUnderOtherAct, 1);
  assert.equal(mismatched.proposeWithoutName, 1, "the partner's name echoed as a proposal still voices it");
});

test("turnsFromRecord aligns committed judgments with AI events and skips other shapes", () => {
  const record = { events: [{ seq: 1, speaker: "ai", text: "開始" }, { seq: 2, speaker: "human", text: "船みたい" }, { seq: 3, speaker: "ai", text: "ありますね" }],
    judgments: [{ turnIndex: 2, judgment: { action: "accept", targetSlot: null } }] };
  const turns = turnsFromRecord(record)!;
  assert.equal(turns[0].act, null);
  assert.equal(turns[2].act!.action, "accept");
  assert.equal(turnsFromRecord({ publicHistory: [] }), null);
});
