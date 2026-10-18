// Local prompt-contract tests, not evidence that a live generator obeys the rule.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDialogueV2, GENERATION_TIMEOUT_MS, ACTION_SCOPE_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { DECISION_ACTIONS, DECISION_MODELS } from "../workers/research-ai-proxy/src/decisions.mjs";

type Action = "accept" | "propose_name" | "confirm" | "repair" | "defer" | "revisit" | "agree" | "move_on" | "close";
type Strategy = "repair-first" | "bypass-enabled";
type Message = { role: string; content: string | unknown[] };
type GenerationCall = { messages: Message[]; options: { phase?: string } };
type CaptureOptions = {
  lunaAction?: Action;
  selectedAction?: Action;
  weights?: Partial<Record<Action, number>>;
  feature?: string | null;
  strategy?: Strategy;
  active?: boolean;
  failDecision?: boolean;
};

const ids = Array.from({ length: 6 }, (_, index) => `s-000${index + 1}`);
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const anchors = ids.map((id, index) => ({ id, bbox: { x: index, y: 0, w: 1, h: 1 }, centroid: { x: index, y: 0 } }));
const events = [{ id: "event-1", seq: 1, turn: 1, speaker: "human", text: "鳥という名前でいいと思います。", at: "2026-01-01T00:00:00.000Z" }];
const prefix = "【この発話の表現範囲（非公開）】";
const directive = (call: GenerationCall): Message[] => call.messages.filter((message) => typeof message.content === "string" && message.content.startsWith(prefix));

async function capture(options: CaptureOptions = {}) {
  const { lunaAction = "agree", selectedAction = lunaAction, strategy = "repair-first", active = true, failDecision = false } = options;
  const calls: GenerationCall[] = [];
  const weights = options.weights ?? { [selectedAction]: 1 };
  const selected = { purpose: "decision_jev", model: DECISION_MODELS.decision_jev, action: selectedAction,
    probabilities: Object.fromEntries((DECISION_ACTIONS as readonly Action[]).map((action) => [action, weights[action] ?? 0])),
    latencyMs: 10, usage: { costUsd: 0.00001 }, rawBody: "PRIVATE-DECISION-BODY" };
  const session = createDialogueV2({ strategy, image, anchors,
    judge: { async judge() { return { ...SAFE_JUDGMENT, action: lunaAction, targetSlot: ids[0],
      candidateName: ["accept", "move_on", "close"].includes(lunaAction) ? null : "鳥",
      discriminatingFeature: options.feature ?? (lunaAction === "confirm" ? "細長い部分がある" : null), note: "PRIVATE-SOURCE-NOTE" }; } },
    // The local per-call deadline is never sent upstream; the pinned digest covers messages and phase.
    client: { async complete(messages: Message[], { timeoutMs, ...config }: { phase?: string; timeoutMs?: number }) {
      assert.equal(timeoutMs, GENERATION_TIMEOUT_MS);
      calls.push(structuredClone({ messages, options: config })); return { text: "公開応答" }; } },
    activeDecision: active ? { purpose: "decision_jev", client: { async chooseAction() {
      if (failDecision) throw Object.assign(new Error("PRIVATE-DECISION-ERROR"), { code: "payment_required" });
      return selected;
    } } } : null });
  const privateState = session.initialPrivateState();
  privateState.ledger[ids[0]] = { status: "tentative", name: "鳥" };
  const result = await session.runAiTurn({ events, lastEventId: "event-1", privateState, signal: new AbortController().signal });
  assert.equal(calls.length, 1);
  return { calls, result };
}

test("changed accept adds a private final-action directive before history, using the existing action scope", async () => {
  const { calls, result } = await capture({ selectedAction: "accept" });
  const [extra] = directive(calls[0]); assert.ok(extra); assert.equal(extra.role, "system");
  assert.equal(typeof extra.content, "string");
  const text = extra.content as string;
  assert.ok(text.includes(ACTION_SCOPE_V2.accept));
  assert.match(text, /この発話のactionはacceptです/);
  assert.match(text, /名称への合意・決定を表す表現/);
  assert.match(text, /呼びましょう／でいいですね／決まり/);
  assert.match(text, /受け止めや見立ての共有にとどめて/);
  assert.deepEqual(calls[0].messages.slice(-events.length), events.map((event) => ({ role: "user", content: event.text })));
  assert.equal(calls[0].messages.indexOf(extra), calls[0].messages.length - events.length - 1);
  assert.equal(result.privateState.judgments[0].activeJudge.finalAction, "accept");
  assert.equal(result.privateState.ledger[ids[0]].status, "tentative");
});

test("same final accept from different hidden Luna actions emits identical directives and generator requests", async () => {
  const fromAgree = await capture({ lunaAction: "agree", selectedAction: "accept" });
  const fromProposal = await capture({ lunaAction: "propose_name", selectedAction: "accept" });
  assert.deepEqual(directive(fromAgree.calls[0]), directive(fromProposal.calls[0]));
  assert.deepEqual(fromAgree.calls, fromProposal.calls);
  const extra = directive(fromAgree.calls[0])[0].content as string;
  assert.doesNotMatch(extra, /Luna|Jev|Decisions|lunaAction|decisionAction|probabilities|rerank|fallback|変更|agree|propose_name|s-000|PRIVATE-|repair-first|bypass-enabled|鳥/);
  assert.doesNotMatch(JSON.stringify(fromAgree.calls), /PRIVATE-SOURCE-NOTE|PRIVATE-DECISION-BODY|activeJudge|rejectedCandidates/);
});

test("changed-action directive and whole generator request are identical across strategies", async () => {
  const repairFirst = await capture({ selectedAction: "accept", strategy: "repair-first" });
  const bypass = await capture({ selectedAction: "accept", strategy: "bypass-enabled" });
  assert.deepEqual(repairFirst.calls, bypass.calls);
});

test("normal mode remains exactly the pre-fix byte sequence and same-action active/fallback add no directive", async () => {
  const normal = await capture({ active: false });
  assert.equal(directive(normal.calls[0]).length, 0);
  // Captured from the unmodified ed943ba/171ced7 assembly before this fix; re-pinned for the shared
  // joint-reference text (HUMANLIKE-REFERENCE-2026-10-19), which is the same in every mode.
  assert.equal(createHash("sha256").update(JSON.stringify(normal.calls)).digest("hex"), "ba9694a87d98f40d718cf01d3e5d3110048ee3dba8f2c0a2783f93a143b8f298");
  const unchanged = await capture(), fallback = await capture({ failDecision: true });
  assert.deepEqual(unchanged.calls, normal.calls); assert.deepEqual(fallback.calls, normal.calls);
  assert.equal(directive(unchanged.calls[0]).length, 0); assert.equal(directive(fallback.calls[0]).length, 0);
});

test("rerank and safe_accept directives describe final action only, never the selected or rejected action", async () => {
  const reranked = await capture({ lunaAction: "propose_name", selectedAction: "agree", weights: { agree: 0.6, accept: 0.4 } });
  const safe = await capture({ lunaAction: "propose_name", selectedAction: "agree" });
  assert.equal(reranked.result.privateState.judgments[0].activeJudge.resolution, "rerank");
  assert.equal(safe.result.privateState.judgments[0].activeJudge.resolution, "safe_accept");
  for (const value of [reranked, safe]) {
    const extra = directive(value.calls[0])[0].content as string;
    assert.match(extra, /actionはacceptです/);
    assert.doesNotMatch(extra, /agree|rerank|safe_accept|propose_name/);
  }
});

test("changed non-agree actions retain their own dialogue functions instead of being reduced to accept", async () => {
  const actions: Action[] = ["propose_name", "confirm", "repair", "defer", "revisit", "move_on", "close"];
  for (const action of actions) {
    const { calls, result } = await capture({ lunaAction: "agree", selectedAction: action, feature: "細長い部分がある" });
    const extra = directive(calls[0])[0].content as string;
    assert.ok(extra.includes(`actionは${action}です`)); assert.ok(extra.includes(ACTION_SCOPE_V2[action]));
    assert.doesNotMatch(extra, /受け止めや見立ての共有にとどめて/);
    assert.match(extra, /内部の判断・処理・ラベルを相手に説明せず/);
    assert.equal(result.privateState.judgments[0].judgment.action, action);
  }
});

test("unchanged accept and same final judgment in normal mode contain no hidden override provenance", async () => {
  const changed = await capture({ lunaAction: "agree", selectedAction: "accept" });
  const normalAccept = await capture({ lunaAction: "accept", active: false });
  const sameAccept = await capture({ lunaAction: "accept" });
  assert.deepEqual(normalAccept.calls, sameAccept.calls);
  const withoutExtra = changed.calls.map((call) => ({ ...call, messages: call.messages.filter((message) => !directive(call).includes(message)) }));
  assert.deepEqual(withoutExtra, normalAccept.calls, "only the final-action directive is added; no hidden intent enters any existing message");
});
