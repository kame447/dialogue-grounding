// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LIMITS, type HumanClientMessage, type Seat } from "../src/ai/protocol";
import { validateNames } from "../src/domain/names";
import { MockAi } from "./partners/mockAi";
import {
  agentSnapshot,
  appendAiMessage,
  createRoomState,
  handle,
  humanSnapshot,
  isExpired,
  join,
  mockNames,
  mockOpening,
  mockReply,
  tokenMatches,
  type RoomState,
} from "./roomCore";

const room = (
  mode: "mock" | "external" = "external",
  now = 1_000,
): RoomState => {
  let slotNumber = 0;
  return createRoomState({
    roomId: "a".repeat(32),
    tokenHashes: {
      human: "human-hash",
      agent: mode === "external" ? "agent-hash" : null,
    },
    mode,
    setId: "alpha",
    seed: 123,
    now,
    randomSlot: () => `slot-${++slotNumber}`,
  });
};

const connected = { human: true, ai: true };
const survey = { effort: 5, fluency: 4, annoyance: 2, comment: "" };

function act(
  state: RoomState,
  seat: Seat,
  message: HumanClientMessage,
  now = 2_000,
) {
  return handle(state, seat, message, now, connected);
}

function namesFor(
  state: RoomState,
  seat: Seat,
  labels?: string[],
): Record<string, string> {
  const defaultLabels = ["鳥", "猫", "犬", "魚", "木", "月"];
  return Object.fromEntries(
    state.orders[seat].map((id, index) => [
      Object.keys(state.slots[seat]).find(
        (key) => state.slots[seat][key] === id,
      )!,
      labels?.[index] ?? defaultLabels[index],
    ]),
  );
}

function startExternal(state: RoomState) {
  join(state, "human");
  join(state, "ai");
}

describe("human + AI room core", () => {
  it("uses the 30-day expiry and checks the exact expiry boundary", () => {
    const state = room("external", 1_000);
    expect(LIMITS.roomTtlMs).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(state.expiresAt).toBe(1_000 + LIMITS.roomTtlMs);
    expect(isExpired(state, state.expiresAt - 1)).toBe(false);
    expect(isExpired(state, state.expiresAt)).toBe(true);
  });

  it("starts mock chat and emits the opening only once after join", () => {
    const state = room("mock");
    join(state, "human");
    expect(state.phases).toEqual({ human: "chat", ai: "chat" });
    expect(state.mockOpeningSent).toBe(false);
    const opening = mockOpening(state);
    expect(opening).toContain("動作確認用の模擬AI");
    expect(opening).toContain("図形は見ていません");
    expect(state.mockOpeningSent).toBe(true);
    if (!state.mockOpeningSent) mockOpening(state);
    expect(state.mockOpeningSent).toBe(true);
  });

  it("reports the server-side mock partner as connected", () => {
    const state = room("mock");
    const snapshot = humanSnapshot(state, { human: true, ai: false });
    expect(snapshot.ai.connected).toBe(true);
    expect(snapshot.ai.everConnected).toBe(true);
  });

  it("appends delayed AI replies to the newest stored state", () => {
    let latest = room("mock");
    join(latest, "human");
    latest.messages = [0, 1, 2].map((index) => ({
      id: String(index + 1),
      from: "self" as const,
      text: `human-${index + 1}`,
      at: index,
      seat: "human" as const,
    }));
    latest.nextMessageId = 4;

    latest = appendAiMessage(latest, "reply-1", 10);
    latest = appendAiMessage(latest, "reply-2", 20);
    latest = appendAiMessage(latest, "reply-3", 30);

    expect(latest.messages.map(({ text }) => text)).toEqual([
      "human-1",
      "human-2",
      "human-3",
      "reply-1",
      "reply-2",
      "reply-3",
    ]);
    expect(latest.nextMessageId).toBe(7);
  });

  it("extracts multiple names and full-width figure numbers and maps the oracle result", () => {
    const state = room("mock");
    join(state, "human");
    mockReply(state, "図形２は鳥、図形1は猫、図形３は犬、図形4は魚");
    expect(state.mockRecorded).toEqual({ 1: "猫", 2: "鳥", 3: "犬", 4: "魚" });
    mockReply(state, "図形5は木、図形６は月");
    expect(Object.keys(state.mockRecorded)).toHaveLength(6);

    const oracleNames = mockNames(state);
    const humanNames = namesFor(state, "human", [
      "猫",
      "鳥",
      "犬",
      "魚",
      "木",
      "月",
    ]);
    state.names.human = humanNames;
    state.names.ai = oracleNames;
    state.phases.human = "results";
    const rows = humanSnapshot(state, connected).results!.rows;
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.match)).toBe(true);
  });

  it("uses distinct valid placeholders for unrecorded figures", () => {
    const state = room("mock");
    join(state, "human");
    mockReply(state, "図形１は鳥");
    const names = mockNames(state);
    const values = state.orders.ai.map((id) => {
      const slot = Object.keys(state.slots.ai).find(
        (key) => state.slots.ai[key] === id,
      )!;
      return names[slot];
    });
    expect(new Set(values).size).toBe(6);
    expect(values).toContain("未記録2");
    expect(validateNames(values).ok).toBe(true);
  });

  it("keeps mock oracle names stable across adapter instances and recreated state", async () => {
    const state = room("mock");
    mockReply(state, "図形２は鳥、図形1は猫");
    const recreated = JSON.parse(JSON.stringify(state)) as RoomState;
    const input = {
      figures: humanSnapshot(state, connected).figures,
      history: [
        { from: "human" as const, text: "図形２は鳥、図形1は猫", at: 1 },
      ],
      publicCues: { humanStage: "chat" as const, chatClosed: false },
    };
    const first = await new MockAi().proposeNames(input, state);
    const second = await new MockAi().proposeNames(input, recreated);
    expect(second).toEqual(first);
    expect(Object.values(second)).toContain("鳥");
  });

  it("moves from external waiting_ai to chat after both seats join", () => {
    const state = room("external");
    join(state, "human");
    expect(state.phases.human).toBe("waiting_ai");
    expect(state.phases.ai).toBe("waiting_human");
    join(state, "ai");
    expect(state.phases).toEqual({ human: "chat", ai: "chat" });
  });

  it("allows use_mock only before an external agent has joined", () => {
    const eligible = room("external");
    join(eligible, "human");
    const switched = act(eligible, "human", { type: "use_mock" });
    expect(switched.useMock).toBe(true);
    expect(eligible.mode).toBe("mock");
    expect(eligible.tokenHashes.agent).toBeNull();

    const connectedAgent = room("external");
    startExternal(connectedAgent);
    expect(
      act(connectedAgent, "human", { type: "use_mock" }).out[0].msg,
    ).toMatchObject({
      type: "error",
      code: "invalid_phase",
    });
    const mockRoom = room("mock");
    expect(
      act(mockRoom, "human", { type: "use_mock" }).out[0].msg,
    ).toMatchObject({
      type: "error",
      code: "invalid_phase",
    });
  });

  it("rejects each seat token hash on the other seat", () => {
    const state = room("external");
    expect(tokenMatches(state, "human", "human-hash")).toBe(true);
    expect(tokenMatches(state, "ai", "agent-hash")).toBe(true);
    expect(tokenMatches(state, "human", "agent-hash")).toBe(false);
    expect(tokenMatches(state, "ai", "human-hash")).toBe(false);
    expect(tokenMatches(room("mock"), "ai", "anything")).toBe(false);
  });

  it("acks a duplicate clientId without storing the message twice", () => {
    const state = room("external");
    startExternal(state);
    const original = act(state, "human", {
      type: "chat",
      clientId: "once",
      text: " hello ",
    });
    expect(original.out[0].msg).toMatchObject({
      type: "chat",
      clientId: "once",
    });
    const duplicate = act(state, "human", {
      type: "chat",
      clientId: "once",
      text: "ignored",
    });
    expect(duplicate.out).toHaveLength(1);
    expect(duplicate.out[0].msg).toMatchObject({
      type: "chat",
      clientId: "once",
      message: { text: "hello" },
    });
    expect(state.messages).toHaveLength(1);
  });

  it("rejects too-long messages and enforces the per-seat rate limit", () => {
    const state = room("external");
    startExternal(state);
    expect(
      act(state, "human", {
        type: "chat",
        clientId: "long",
        text: "x".repeat(LIMITS.maxMessageChars + 1),
      }).out[0].msg,
    ).toMatchObject({ type: "error", code: "too_long" });
    for (let index = 0; index < LIMITS.rateMessages; index += 1) {
      act(state, "human", {
        type: "chat",
        clientId: `chat-${index}`,
        text: "ok",
      });
    }
    expect(
      act(state, "human", { type: "chat", clientId: "limited", text: "ok" })
        .out[0].msg,
    ).toMatchObject({
      type: "error",
      code: "rate_limited",
    });
  });

  it("rejects names outside naming phase and lets the agent end chat", () => {
    const state = room("external");
    startExternal(state);
    expect(
      act(state, "human", {
        type: "submit_names",
        names: namesFor(state, "human"),
      }).out[0].msg,
    ).toMatchObject({ type: "error", code: "invalid_phase" });
    const ended = act(state, "ai", { type: "end_chat" });
    expect(state.chatClosedBy).toBe("ai");
    expect(state.phases).toEqual({ human: "naming", ai: "naming" });
    expect(ended.out.some((entry) => entry.msg.type === "snapshot")).toBe(true);
    expect(
      act(state, "human", { type: "submit_survey", survey }).out[0].msg,
    ).toMatchObject({ type: "error", code: "invalid_phase" });
  });

  it("validates names, gates results on survey and AI names, then reveals ordered results", () => {
    const state = room("external");
    startExternal(state);
    act(state, "human", { type: "end_chat" });
    const duplicateNames = namesFor(state, "human");
    duplicateNames[Object.keys(duplicateNames)[1]] =
      duplicateNames[Object.keys(duplicateNames)[0]];
    expect(
      act(state, "human", { type: "submit_names", names: duplicateNames })
        .out[0].msg,
    ).toMatchObject({
      type: "error",
      code: "invalid_names",
    });

    act(state, "human", {
      type: "submit_names",
      names: namesFor(state, "human"),
    });
    expect(state.phases.human).toBe("survey");
    act(state, "human", { type: "submit_survey", survey });
    expect(state.phases.human).toBe("waiting_ai_names");
    expect(humanSnapshot(state, connected).results).toBeNull();

    act(state, "ai", { type: "submit_names", names: namesFor(state, "ai") });
    expect(state.phases.human).toBe("results");
    expect(humanSnapshot(state, connected).results?.total).toBe(6);
  });

  it("withholds private fields from both snapshots before results", () => {
    const state = room("external");
    startExternal(state);
    state.names.ai = namesFor(state, "ai", [
      "SecretA",
      "SecretB",
      "SecretC",
      "SecretD",
      "SecretE",
      "SecretF",
    ]);
    const humanJson = JSON.stringify(humanSnapshot(state, connected));
    expect(humanJson).not.toMatch(
      /alpha-|beta-|setId|seed|agent-hash|human-hash|SecretA|SecretB/,
    );

    state.names.human = namesFor(state, "human", [
      "HumanA",
      "HumanB",
      "HumanC",
      "HumanD",
      "HumanE",
      "HumanF",
    ]);
    state.survey = survey;
    const agentJson = JSON.stringify(agentSnapshot(state, connected));
    expect(agentJson).not.toMatch(
      /effort|fluency|annoyance|survey|HumanA|HumanB/,
    );
  });

  it("deletes the room from any human phase", () => {
    const state = room("external");
    startExternal(state);
    act(state, "human", { type: "end_chat" });
    const result = act(state, "human", { type: "delete_room" });
    expect(result.deleteRoom).toBe(true);
    expect(result.out.map((entry) => entry.msg.type)).toEqual([
      "deleted",
      "deleted",
    ]);
    expect(state.deleted).toBe(true);
  });
});
