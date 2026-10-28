import test from "node:test";
import assert from "node:assert/strict";
import { createDialogueV2, ACTION_SCOPE_V2, LUNA_ACTION_SCOPE_V2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { ACTIONS } from "../dialogue-model/runtime/judgment/schema.mjs";

const anchors = ["s-0a01", "s-0a02", "s-0a03", "s-0a04", "s-0a05", "s-0a06"].map((id, i) => ({ id, bbox: { x: i * 100, y: 0, w: 90, h: 90 }, centroid: { x: i * 100 + 45, y: 45 } }));
const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };

test("every action has a public scope, and only agree may announce a decided name", () => {
  assert.deepEqual(Object.keys(ACTION_SCOPE_V2).sort(), [...ACTIONS].sort());
  for (const action of ["accept", "propose_name", "confirm", "defer", "revisit", "move_on"]) assert.match(ACTION_SCOPE_V2[action], /とは言わない/u, action);
  assert.match(ACTION_SCOPE_V2.agree, /決まった/u);
});

for (const strategy of ["repair-first", "bypass-enabled"]) test(`generator is told a confirm turn cannot announce agreement (${strategy})`, async () => {
  let generation;
  const client = { async complete(messages, options) { if (options?.phase === "generation") generation = messages; return { text: "その形のことですか？" }; } };
  const judge = { async judge() { return { action: "confirm", targetSlot: "s-0a01", candidateName: "階段", discriminatingFeature: "段差が三つ", note: null,
    followUp: { action: "propose_name", targetSlot: "s-0a02", candidateName: "船", discriminatingFeature: "大きい三角" } }; } };
  const dialogue = createDialogueV2({ client, strategy, image, anchors, judge });
  await dialogue.runAiTurn({ events: [{ id: "e1", seq: 1, speaker: "human", text: "それを階段で" }], privateState: dialogue.initialPrivateState(), lastEventId: "e1" });
  const decision = generation.find((m) => typeof m.content === "string" && m.content.startsWith("この発話の判断"));
  assert.ok(decision.content.includes("主actionで言えること: " + LUNA_ACTION_SCOPE_V2.confirm));
  assert.ok(decision.content.includes("followUpで言えること: " + LUNA_ACTION_SCOPE_V2.propose_name));
});
