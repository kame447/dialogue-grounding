// Synthetic E2E utterances and local mocks only; no live-model semantic claim.
import test from "node:test";
import assert from "node:assert/strict";
import { findAgreementClaims, fallbackUtterance } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { createDialogueV2, ACTION_SCOPE_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createHumanMessageQueue } from "../dialogue-model/runtime/web/human-message-queue.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { SAFE_JUDGMENT, applyJudgment } from "../dialogue-model/runtime/judgment/schema.mjs";
import { DECISION_ACTIONS } from "../workers/research-ai-proxy/src/decisions.mjs";

type Action = "accept" | "propose_name" | "confirm" | "agree" | "repair" | "defer" | "revisit" | "move_on" | "close";
type Strategy = "repair-first" | "bypass-enabled";
type Message = { role: string; content: unknown };
type Reply = { text?: unknown } | Error;
const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, i) => ({ id, bbox: { x: i, y: 0, w: 1, h: 1 }, centroid: { x: i, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const events = [{ id: "e-1", seq: 1, speaker: "human", text: "鳥みたいですね。" }];
const violating = "はい、「鳥」と呼びましょう。";
const fixtures: { text: string; finalAction: string }[] = [
  {
    "text": "よろしくお願いします。たしかに、家みたいに見える形がありますね。",
    "finalAction": "accept"
  },
  {
    "text": "屋根のような尖りと、その下に四角い本体が続く形のことですか？",
    "finalAction": "confirm"
  },
  {
    "text": "はい、煙突みたいな四角い部分がある形を「家」と呼びましょう。",
    "finalAction": "accept"
  },
  {
    "text": "いいですね。私の画像にも、鳥の頭みたいに見える形があります。",
    "finalAction": "accept"
  },
  {
    "text": "「鳥の頭」ですね。くちばしのように細く尖った部分がある形のことですか？",
    "finalAction": "accept"
  },
  {
    "text": "はい、くちばしのように尖った部分がある形ですね。「鳥の頭」と呼びましょう。",
    "finalAction": "accept"
  },
  {
    "text": "ありますね。Zみたいに見える形を「Z」と呼ぶのはどうでしょう？",
    "finalAction": "propose_name"
  },
  {
    "text": "片端が大きな三角形状に広がっている形ですね。おっしゃっている「Z」はそれのことですか？",
    "finalAction": "confirm"
  },
  {
    "text": "はい、「稲妻」と呼びましょう。",
    "finalAction": "propose_name"
  },
  {
    "text": "帽子みたいなのですね。私の画像にも、帽子っぽく見える形があります。",
    "finalAction": "move_on"
  },
  {
    "text": "はい、「帽子」と呼びましょう。",
    "finalAction": "accept"
  },
  {
    "text": "滑り台みたいな斜めの形ですね。こちらにもそう見える形があります。では、最後の一つも見てみましょう。",
    "finalAction": "move_on"
  },
  {
    "text": "はい、「滑り台」と呼びましょう。",
    "finalAction": "accept"
  },
  {
    "text": "はい、最後の形は「猫」と呼びましょう。",
    "finalAction": "accept"
  },
  {
    "text": "よろしくお願いします。たしかに、家みたいに見える形がありますね。",
    "finalAction": "accept"
  },
  {
    "text": "屋根のような三角形の突起が、大きな塊についている形のことですか？",
    "finalAction": "confirm"
  },
  {
    "text": "なるほど、屋根の上に四角い煙突がある形ですね。私の画像では、四角い突起と斜めの屋根がつながった形のことですか？",
    "finalAction": "confirm"
  },
  {
    "text": "はい、それを「家」と呼びましょう。煙突のある家みたいな形ですね。",
    "finalAction": "agree"
  },
  {
    "text": "はい、鳥の頭みたいな形ですね。",
    "finalAction": "accept"
  },
  {
    "text": "「鳥の頭」はいいですね。くちばしのように尖った部分がある形のことですか？",
    "finalAction": "accept"
  },
  {
    "text": "はい、くちばしのように尖った部分がある形を「鳥の頭」と呼びましょう。",
    "finalAction": "accept"
  },
  {
    "text": "ありますね。両端の短い部分を長い斜めの部分がつないでいる、ジグザグした形のことでしょうか？",
    "finalAction": "confirm"
  },
  {
    "text": "なるほど、片方に大きな三角形の突起があり、反対側は短く平らな突起の形ですね。私が見ているZもその形のことですか？",
    "finalAction": "confirm"
  },
  {
    "text": "大きな三角形の先端の反対側に、小さく尖った突起がある形ですね。それを「稲妻」と呼ぶのでよさそうですか？",
    "finalAction": "confirm"
  },
  {
    "text": "はい、稲妻ですね。帽子みたいな形もありますね。",
    "finalAction": "accept"
  },
  {
    "text": "はい、それは「帽子」と呼びましょう。",
    "finalAction": "accept"
  },
  {
    "text": "細長い斜めの部分が角張った塊につながっている形のことですね？",
    "finalAction": "confirm"
  },
  {
    "text": "はい、それは「滑り台」と呼びましょう。",
    "finalAction": "agree"
  },
  {
    "text": "はい、座っている猫みたいな形は「猫」でいいですね。",
    "finalAction": "accept"
  }
];

test("all 29 synthetic real-session labels distinguish decisions from impressions and questions", () => {
  const violationIndices = new Set([2, 5, 8, 10, 12, 13, 20, 25, 28]);
  assert.equal(fixtures.length, 29);
  fixtures.forEach(({ text, finalAction }, index) => {
    if (finalAction !== "agree") assert.equal(findAgreementClaims(text).length > 0, violationIndices.has(index), text);
  });
});

test("declarative decisions are detected clause by clause, across Unicode/whitespace forms", () => {
  for (const text of ["「鳥」と呼びましょう。", "「鳥」にしましょう", "「鳥」でいきましょう！", "「鳥」で決まり。", "「鳥」でいいですね。", "「鳥」と呼ぶことにしましょう。", "合意しました。", "「鳥」で決まり、次はどれですか？", "「鳥」と呼びましょう。いいですか？", "「鳥」と 呼びましょう．", "「鳥」でいいですね\n次はどれですか？", "「鳥」でいきましょう、よいですか？"]) {
    assert.ok(findAgreementClaims(text).length, text);
  }
  assert.deepEqual(findAgreementClaims("鳥で決まり。猫で決まり。"), ["name_settled"]);
});

test("proposals, actual questions and plain impression approval stay clear", () => {
  for (const text of ["「鳥」と呼ぶのはどうでしょう？", "「鳥」と呼びませんか？", "「鳥」と呼びましょうか？", "「鳥」でよさそうですか？", "いいですね。", "「鳥」でいいですね？", "「鳥」で決まりですか？", "「鳥」にしましょうか。", "「鳥」でいきましょうか", "まだ合意していません。", "合意ではありません。", "その印象はいいですね。鳥のようです。"]) assert.deepEqual(findAgreementClaims(text), [], text);
});

test("short declarative predicate inflections cannot bypass the guard", () => {
  for (const suffix of ["でいい", "でいいです", "でいいですよ", "でいいですね", "でいいよ", "に決まり", "で決まりです", "と呼ぼう", "と呼びましょう", "と呼ぶことにしよう", "と呼ぶことにしましょう", "にしよう", "にしましょう", "でいこう", "でいきましょう", "で決定", "で合意しましょう", "で合意です"]) {
    assert.ok(findAgreementClaims(`「猫」${suffix}。`).length, suffix);
    assert.ok(findAgreementClaims(`「猫」${suffix}、次はどれですか？`).length, suffix);
  }
});

test("same-predicate interrogatives are exempt without hiding separate declarative clauses", () => {
  for (const text of ["この名前で合意できますか？", "猫で合意しませんか？", "猫で合意しましょうか？", "猫で合意しますか？", "猫で合意でしょうか？", "猫でいいですか？", "猫でいいでしょうか？", "猫でいいですね？", "猫と呼ぼうか？", "猫でいこうか？", "猫にしようか？", "猫と呼ぶことにしようか？", "少し後にしましょう。", "あとにしましょう。", "後日にしましょう。", "いいですね。", "いいですよ。"]) {
    assert.deepEqual(findAgreementClaims(text), [], text);
  }
  assert.ok(findAgreementClaims("猫で合意しました、次も合意できますか？").length);
  assert.ok(findAgreementClaims("「後」にしましょう。").length);
});

test("fallbacks preserve validated names/features only in safe short spans, and never decide", () => {
  assert.equal(fallbackUtterance({ action: "accept" }), "なるほど、そう見えるんですね。");
  assert.equal(fallbackUtterance({ action: "propose_name", candidateName: "鳥" }), "「鳥」と呼ぶのはどうでしょう？");
  assert.equal(fallbackUtterance({ action: "confirm", discriminatingFeature: "尖り" }), "尖りがある形のことですか？");
  for (const action of Object.keys(ACTION_SCOPE_V2) as Action[]) {
    for (const field of [null, "鳥", '鳥」と呼びましょう。「鳥', "尖り。猫で決まり。", "x\n鳥", "a".repeat(41), "鳥でいいですね", '鳥"', "鳥？", "鳥．猫", "鳥\u2028猫"]) {
      const text = fallbackUtterance({ action, candidateName: field, discriminatingFeature: field });
      assert.equal(findAgreementClaims(text).length, 0, `${action}: ${text}`);
      if (field && field !== "鳥") assert.ok(!text.includes(field));
    }
  }
});

function setup({ action = "accept", strategy = "repair-first", active = false, replies = [{ text: violating }, { text: "なるほど、鳥のようですね。" }], controller = new AbortController(), hook = (_call: number) => {}, referenceMemory = false, followUp = null, name = "鳥", feature = "尖り" }: {
  action?: Action; strategy?: Strategy; active?: boolean; replies?: Reply[]; controller?: AbortController;
  hook?: (call: number) => void; referenceMemory?: boolean; followUp?: unknown; name?: string; feature?: string;
} = {}) {
  const calls: { messages: Message[]; options: unknown }[] = [];
  const raw = { ...SAFE_JUDGMENT, action, targetSlot: ids[0], candidateName: ["accept", "close", "move_on"].includes(action) ? null : name,
    discriminatingFeature: action === "confirm" ? feature : null, ...(followUp ? { followUp } : {}) };
  const dialogue = createDialogueV2({ strategy, image, anchors, referenceMemory,
    // Deliberately unvalidated raw output (followUp may be malformed); the session validates it.
    judge: { async judge(): Promise<any> { return raw; } },
    client: { async complete(messages: Message[], options: unknown) {
      calls.push(structuredClone({ messages, options })); hook(calls.length);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return reply;
    } },
    activeDecision: active ? { purpose: "decision_jev", client: { async chooseAction() { return { action: "accept", probabilities: Object.fromEntries(DECISION_ACTIONS.map((a: string) => [a, Number(a === "accept")])) }; } } } : null,
  });
  const state = dialogue.initialPrivateState();
  state.ledger[ids[0]] = { status: "tentative", name };
  return { dialogue, state, calls, controller, raw, run: () => dialogue.runAiTurn({ events, lastEventId: "e-1", privateState: state, signal: controller.signal }) };
}

test("one violation regenerates once; successful rewrite alone is published and state uses original judgment", async () => {
  const s = setup({ referenceMemory: true });
  const before = structuredClone(s.state), result = await s.run();
  assert.equal(result.text, "なるほど、鳥のようですね。"); assert.equal(s.calls.length, 2);
  assert.deepEqual(s.state, before, "input private state is detached");
  assert.deepEqual(result.privateState.ledger, applyJudgment(before.ledger, s.raw));
  assert.equal(result.privateState.judgments.length, 1);
  assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: ["naming_decision"], regenerated: true, fallback: false });
  assert.deepEqual(result.privateState.judgments[0].judgment, s.raw);
  assert.equal(s.calls[1].messages.length, s.calls[0].messages.length + 1);
  assert.deepEqual(s.calls[1].messages.slice(0, -1), s.calls[0].messages);
  const retry = s.calls[1].messages.at(-1)!;
  assert.equal(retry.role, "system"); assert.match(String(retry.content), /actionはaccept/);
  assert.ok(String(retry.content).includes(ACTION_SCOPE_V2.accept));
  assert.doesNotMatch(String(retry.content), /Luna|Jev|probabilities|s-000|鳥|呼びましょう/);
  assert.equal(result.privateState.judgments[0].memory.opsApplied, 0);
});

test("two violations use fixed fallback with distinct codes; no third call or state reinterpretation", async () => {
  const s = setup({ replies: [{ text: violating }, { text: "鳥で決まり。" }] });
  const result = await s.run(); assert.equal(s.calls.length, 2);
  assert.equal(result.text, fallbackUtterance(s.raw));
  assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: ["naming_decision", "name_settled"], regenerated: true, fallback: true });
  assert.equal(result.privateState.ledger[ids[0]].status, "tentative");
});

test("failed, empty and malformed regeneration all fall back without retaining raw errors", async () => {
  for (const reply of [new Error("PRIVATE-ERROR-BODY"), { text: " " }, { text: null }, {}]) {
    const s = setup({ replies: [{ text: violating }, reply] }); const result = await s.run();
    assert.equal(s.calls.length, 2); assert.equal(result.text, fallbackUtterance(s.raw));
    assert.equal(result.privateState.judgments[0].generationGuard.fallback, true);
    assert.doesNotMatch(JSON.stringify(s.dialogue.getAttempts()), /PRIVATE-ERROR-BODY/);
  }
});

test("initial generation errors preserve existing failure behavior; no fallback pretends it succeeded", async () => {
  const s = setup({ replies: [new Error("unavailable")] });
  await assert.rejects(s.run(), /unavailable/); assert.equal(s.calls.length, 1);
  assert.equal(s.state.judgments.length, 0);
});

test("agree skips inspection and extra calls; valid non-agree output is unchanged", async () => {
  for (const [action, text] of [["agree", violating], ["propose_name", "「鳥」と呼ぶのはどうでしょう？"], ["accept", "いいですね。"]] as [Action, string][]) {
    const s = setup({ action, replies: [{ text }] }); const result = await s.run();
    assert.equal(result.text, text); assert.equal(s.calls.length, 1);
    assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(result.privateState.ledger[ids[0]].status, action === "agree" ? "agreed" : "tentative");
  }
});

test("abort between attempts makes no second call, even when the first result violates", async () => {
  const controller = new AbortController(); const s = setup({ controller, hook() { controller.abort(); } });
  await assert.rejects(s.run(), { name: "AbortError" }); assert.equal(s.calls.length, 1);
  assert.equal(s.state.judgments.length, 0); assert.equal(s.dialogue.getAttempts()[0].status, "generation_error");
});

test("abort during regeneration escapes retry catch, including rejected transports", async () => {
  for (const reply of [{ text: "なるほど。" }, new Error("abort transport")]) {
    const controller = new AbortController(); const s = setup({ controller, replies: [{ text: violating }, reply], hook(call) { if (call === 2) controller.abort(); } });
    await assert.rejects(s.run(), { name: "AbortError" }); assert.equal(s.calls.length, 2);
    assert.equal(s.state.judgments.length, 0);
  }
});

test("both strategies have identical generation/retry/fallback and final ledger", async () => {
  const a = setup({ strategy: "repair-first", replies: [{ text: violating }] });
  const b = setup({ strategy: "bypass-enabled", replies: [{ text: violating }] });
  const ar = await a.run(), br = await b.run();
  assert.deepEqual(a.calls, b.calls); assert.deepEqual(ar, br);
});

test("active override uses the final action; hostile validated fields cannot inject fallback decisions", async () => {
  const active = setup({ action: "agree", active: true, replies: [{ text: violating }] });
  const result = await active.run(); assert.equal(result.privateState.judgments[0].judgment.action, "accept");
  assert.equal(result.privateState.ledger[ids[0]].status, "tentative"); assert.equal(findAgreementClaims(result.text).length, 0);
  for (const action of ["propose_name", "confirm"] as Action[]) {
    const s = setup({ action, name: '鳥」と呼びましょう。「鳥', feature: "尖り。猫で決まり。", replies: [{ text: violating }] });
    const r = await s.run(); assert.equal(findAgreementClaims(r.text).length, 0);
    assert.equal(r.privateState.judgments[0].generationGuard.fallback, true);
  }
});

test("followUp and graph are applied once after a successful guarded generation", async () => {
  const followUp = { action: "propose_name", targetSlot: ids[1], candidateName: "猫", discriminatingFeature: null };
  const s = setup({ referenceMemory: true, followUp, replies: [{ text: violating }] }); const r = await s.run();
  assert.deepEqual(r.privateState.ledger, applyJudgment(s.state.ledger, s.raw));
  assert.deepEqual(r.privateState.judgments[0].judgment.followUp, followUp);
  assert.equal(r.privateState.ledger[ids[1]].name, "猫");
  assert.equal(r.privateState.judgments.length, 1);
});

test("mock v2 sessions publish no decision wording unless agree, normal and active", async () => {
  const actions: Action[] = ["accept", "propose_name", "confirm", "agree", "repair", "defer", "revisit", "move_on", "close"];
  for (const active of [false, true]) {
    let turn = 0;
    const dialogue = createDialogueV2({ image, anchors, strategy: "repair-first", referenceMemory: true,
      judge: { async judge() { const action = actions[turn++]; return { ...SAFE_JUDGMENT, action, targetSlot: ids[0], candidateName: ["accept", "move_on", "close"].includes(action) ? null : "鳥", discriminatingFeature: action === "confirm" ? "尖り" : null }; } },
      client: { async complete() { return { text: violating }; } },
      activeDecision: active ? { purpose: "decision_jev", client: { async chooseAction() { const action = actions[turn - 1] === "agree" ? "accept" : actions[turn - 1]; return { action, probabilities: Object.fromEntries(DECISION_ACTIONS.map((a: string) => [a, Number(a === action)])) }; } } } : null,
    });
    const queue = createHumanMessageQueue({ runAiTurn: dialogue.runAiTurn, initialPrivateState: dialogue.initialPrivateState() });
    for (let i = 0; i < actions.length; i++) {
      queue.enqueue({ clientId: `turn-${i}`, text: "鳥の形についてです。" }); await queue.whenIdle();
      const snapshot = queue.getSnapshot(), state = queue.getPrivateState();
      assert.equal(snapshot.status, "idle"); const action = state.judgments.at(-1)!.judgment.action;
      if (action !== "agree") assert.equal(findAgreementClaims(snapshot.events.at(-1)!.text).length, 0);
      assert.doesNotMatch(JSON.stringify(snapshot), /generationGuard|violations|ownLedger|activeJudge|judgment/);
    }
    assert.equal(queue.getPrivateState().judgments.length, actions.length);
  }
});

test("participant task state never exposes guard diagnostics", async () => {
  const task = await createNamingTaskV2({ seed: 137, strategy: "bypass-enabled", runDir: "",
    judge: { async judge() { return SAFE_JUDGMENT; } },
    client: { async complete(_messages: Message[], options: { phase: string }) {
      return { text: options.phase === "judgment" ? JSON.stringify(SAFE_JUDGMENT) : violating };
    } },
  });
  task.message("鳥みたいですね。"); await task.whenIdle();
  assert.equal(task.getState().events.at(-1).text, "なるほど、そう見えるんですね。");
  assert.doesNotMatch(JSON.stringify(task.getState()), /generationGuard|violations|regenerated|fallback/);
  assert.equal(task.researcherView().privateState.judgments.at(-1).generationGuard.fallback, true);
});
