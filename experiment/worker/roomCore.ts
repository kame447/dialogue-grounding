import { MOCK_OPENING, mockPlaceholderNames, mockReplyText } from "./partners/mockRules";
import {
  LIMITS,
  PROTOCOL_VERSION,
  type ErrorCode,
  type AgentSnapshot,
  type HumanSnapshot,
  type RoomMode,
  type Seat,
  type HumanClientMessage,
  type AgentClientMessage,
  type ChatMessage,
  type Figure,
  type Survey,
  type ServerMessage,
} from "../src/ai/protocol";
import { normalizeName, validateNames } from "../src/domain/names";
import { STIMULUS_SETS } from "../src/stimuli/sets";
import { createLayout, createRng } from "../src/stimuli/layout";
import { placeFigures } from "../src/stimuli/scene";

export interface RoomState {
  roomId: string;
  tokenHashes: { human: string; agent: string | null };
  mode: RoomMode;
  setId: "alpha" | "beta";
  seed: number;
  expiresAt: number;
  orders: Record<Seat, string[]>;
  slots: Record<Seat, Record<string, string>>;
  phases: { human: HumanSnapshot["phase"]; ai: AgentSnapshot["phase"] };
  joined: { human: boolean; ai: boolean };
  names: Record<Seat, Record<string, string> | null>;
  survey: Survey | null;
  messages: Array<ChatMessage & { seat: Seat }>;
  chatClosedBy: Seat | null;
  rateTimes: Record<Seat, number[]>;
  clientMessages: Record<Seat, Record<string, ChatMessage>>;
  nextMessageId: number;
  /** Legacy field of rooms created before 2026-10-13 (number-parsing mock); no longer read. */
  mockRecorded?: Record<number, string>;
  mockPromptIndex: number;
  mockOpeningSent: boolean;
  mockPendingReplies: number;
  aiTyping: boolean;
  deleted: boolean;
}
export const other = (s: Seat): Seat => (s === "human" ? "ai" : "human");
const polygons = (id: string) =>
  STIMULUS_SETS[id.startsWith("alpha-") ? "alpha" : "beta"].stimuli
    .find((x) => x.id === id)!
    .polygons.map((p) => p.map(([x, y]) => [x, y] as [number, number]));
export function createRoomState(i: {
  roomId: string;
  tokenHashes: { human: string; agent: string | null };
  mode: RoomMode;
  setId: "alpha" | "beta";
  seed: number;
  now: number;
  randomSlot: () => string;
}): RoomState {
  const set = STIMULUS_SETS[i.setId],
    layout = createLayout(set, createRng(i.seed)),
    orders = { human: layout.human, ai: layout.partner };
  const slots = {
    human: {} as Record<string, string>,
    ai: {} as Record<string, string>,
  };
  for (const seat of ["human", "ai"] as const)
    for (const id of orders[seat]) slots[seat][i.randomSlot()] = id;
  return {
    roomId: i.roomId,
    tokenHashes: i.tokenHashes,
    mode: i.mode,
    setId: i.setId,
    seed: i.seed >>> 0,
    expiresAt: i.now + LIMITS.roomTtlMs,
    orders,
    slots,
    phases: {
      human: i.mode === "mock" ? "chat" : "waiting_ai",
      ai: i.mode === "mock" ? "chat" : "waiting_human",
    },
    joined: { human: false, ai: false },
    names: { human: null, ai: null },
    survey: null,
    messages: [],
    chatClosedBy: null,
    rateTimes: { human: [], ai: [] },
    clientMessages: { human: {}, ai: {} },
    nextMessageId: 1,
    mockPromptIndex: 0,
    mockOpeningSent: false,
    mockPendingReplies: 0,
    aiTyping: false,
    deleted: false,
  };
}
export const isExpired = (s: RoomState, n: number) => n >= s.expiresAt;
export function tokenMatches(s: RoomState, seat: Seat, hash: string): boolean {
  const expected = seat === "human" ? s.tokenHashes.human : s.tokenHashes.agent;
  if (expected === null) return false;
  let mismatch = expected.length ^ hash.length;
  for (let i = 0; i < Math.max(expected.length, hash.length); i++)
    mismatch |= (expected.charCodeAt(i) || 0) ^ (hash.charCodeAt(i) || 0);
  return mismatch === 0;
}
export function join(s: RoomState, seat: Seat): RoomState {
  s.joined[seat] = true;
  if (s.mode === "mock" && seat === "human") {
    s.phases.human = "chat";
    s.phases.ai = "chat";
  } else if (s.mode === "external" && seat === "ai") {
    s.phases.ai = s.joined.human ? "chat" : "waiting_human";
    if (s.joined.human) s.phases.human = "chat";
  } else if (s.mode === "external" && seat === "human") {
    s.phases.human = s.joined.ai ? "chat" : "waiting_ai";
    if (s.joined.ai) s.phases.ai = "chat";
  }
  return s;
}
/** Placements depend only on (set, seed, seat); cache them per isolate. */
const placementCache = new Map<string, ReturnType<typeof placeFigures>>();
function placementsFor(s: RoomState, seat: Seat) {
  // Placement follows the canonical stimulus order of the set, so it is independent of slot order.
  const ids = STIMULUS_SETS[s.setId].stimuli.map((x) => x.id);
  const key = `${s.setId}:${s.seed}:${seat}`;
  let placements = placementCache.get(key);
  if (!placements) {
    placements = placeFigures(ids.map(polygons), s.seed, seat);
    if (placementCache.size > 500) placementCache.clear();
    placementCache.set(key, placements);
  }
  const found = placements;
  return (id: string) => found[ids.indexOf(id)];
}
const slotOf = (s: RoomState, seat: Seat, id: string) =>
  Object.keys(s.slots[seat]).find((k) => s.slots[seat][k] === id)!;
const fig = (s: RoomState, seat: Seat): Figure[] => {
  const place = placementsFor(s, seat);
  return s.orders[seat].map((id) => ({
    slot: slotOf(s, seat, id),
    polygons: polygons(id),
    placement: place(id),
  }));
};
export function humanSnapshot(
  s: RoomState,
  c: { human: boolean; ai: boolean },
  typing = false,
): HumanSnapshot {
  const phase = s.phases.human,
    result = phase === "results";
  // The mock AI never identifies figures, so its placeholder answers are not scored or shown.
  const scored = s.mode === "external";
  const rows = result
    ? s.orders.human.map((id) => {
        const slot = slotOf(s, "human", id),
          selfName = s.names.human?.[slot] ?? "",
          aiName = scored ? (s.names.ai?.[slotOf(s, "ai", id)] ?? "") : null;
        return {
          slot,
          selfName,
          aiName,
          match: aiName === null ? null : normalizeName(selfName) === normalizeName(aiName),
        };
      })
    : null;
  return {
    protocol: PROTOCOL_VERSION,
    seat: "human",
    mode: s.mode,
    phase,
    expiresAt: s.expiresAt,
    ai: {
      kind: s.mode,
      connected: s.mode === "mock" || c.ai,
      everConnected: s.mode === "mock" || s.joined.ai,
      typing: typing || s.aiTyping,
    },
    figures: fig(s, "human"),
    messages: s.messages.map(({ seat, ...m }) => ({
      ...m,
      from: seat === "human" ? "self" : "partner",
    })),
    chatClosedBy:
      s.chatClosedBy === null
        ? null
        : s.chatClosedBy === "human"
          ? "self"
          : "partner",
    myNames: s.names.human,
    mySurvey: s.survey,
    results: rows
      ? {
          scored,
          rows,
          matched: scored ? rows.filter((r) => r.match).length : null,
          total: rows.length,
        }
      : null,
  };
}
export function agentSnapshot(
  s: RoomState,
  c: { human: boolean; ai: boolean },
): AgentSnapshot {
  const stage: AgentSnapshot["human"]["stage"] = !s.joined.human
    ? "not_joined"
    : s.phases.human === "chat"
      ? "chat"
      : "after_chat";
  return {
    protocol: PROTOCOL_VERSION,
    seat: "ai",
    phase: s.phases.ai,
    expiresAt: s.expiresAt,
    human: { connected: c.human, joined: s.joined.human, stage },
    figures: fig(s, "ai"),
    messages: s.messages.map(({ seat, ...m }) => ({
      ...m,
      from: seat === "ai" ? "self" : "partner",
    })),
    chatClosedBy:
      s.chatClosedBy === null
        ? null
        : s.chatClosedBy === "ai"
          ? "self"
          : "partner",
    myNames: s.names.ai,
  };
}
type Out = { to: Seat; msg: ServerMessage };
const sameKeys = (a: Record<string, string>, slots: Record<string, string>) =>
  Object.keys(a).length === 6 &&
  Object.keys(slots).every((k) => Object.hasOwn(a, k));
export function handle(
  s: RoomState,
  seat: Seat,
  msg: HumanClientMessage | AgentClientMessage,
  now: number,
  c: { human: boolean; ai: boolean },
): { state: RoomState; out: Out[]; deleteRoom?: boolean; useMock?: boolean } {
  const peer = other(seat),
    out: Out[] = [];
  const err = (code: ErrorCode, message: string, clientId?: string) =>
    out.push({
      to: seat,
      msg: { type: "error", code, message, ...(clientId ? { clientId } : {}) },
    });
  if (s.deleted) {
    err("not_found", "ルームが見つかりません。");
    return { state: s, out };
  }
  if (msg.type === "ping")
    return { state: s, out: [{ to: seat, msg: { type: "pong" } }] };
  const snap = () => {
    for (const target of ["human", "ai"] as const)
      out.push({
        to: target,
        msg: {
          type: "snapshot",
          state: target === "human" ? humanSnapshot(s, c) : agentSnapshot(s, c),
        },
      });
  };
  if (msg.type === "delete_room" && seat === "human") {
    s.deleted = true;
    out.push(
      { to: "human", msg: { type: "deleted" } },
      { to: "ai", msg: { type: "deleted" } },
    );
    return { state: s, out, deleteRoom: true };
  }
  if (msg.type === "use_mock" && seat === "human") {
    if (s.mode !== "external" || s.joined.ai || s.phases.human !== "waiting_ai")
      err("invalid_phase", "模擬AIへ切り替えできません。");
    else {
      s.mode = "mock";
      s.tokenHashes.agent = null;
      s.phases.human = "chat";
      s.phases.ai = "chat";
      snap();
      return { state: s, out, useMock: true };
    }
    return { state: s, out };
  }
  if (msg.type === "chat") {
    if (s.chatClosedBy) {
      err("chat_closed", "チャットは終了しました。", msg.clientId);
      return { state: s, out };
    }
    if (s.phases[seat] !== "chat") {
      err("invalid_phase", "チャットできる状態ではありません。", msg.clientId);
      return { state: s, out };
    }
    const prior = s.clientMessages[seat][msg.clientId];
    if (prior) {
      out.push({
        to: seat,
        msg: {
          type: "chat",
          message: { ...prior, from: "self" },
          clientId: msg.clientId,
        },
      });
      return { state: s, out };
    }
    const text = msg.text.trim(),
      since = s.rateTimes[seat].filter((at) => now - at < LIMITS.rateWindowMs);
    if (!text)
      err("bad_request", "メッセージを入力してください。", msg.clientId);
    else if (text.length > LIMITS.maxMessageChars)
      err(
        "too_long",
        `${LIMITS.maxMessageChars}文字以内で入力してください。`,
        msg.clientId,
      );
    else if (s.messages.length >= LIMITS.maxMessagesPerRoom)
      err("room_full", "メッセージ上限です。", msg.clientId);
    else if (since.length >= LIMITS.rateMessages)
      err("rate_limited", "少し待ってから送信してください。", msg.clientId);
    else {
      s.rateTimes[seat] = [...since, now];
      const m: ChatMessage = {
        id: String(s.nextMessageId++),
        from: "self",
        text,
        at: now,
      };
      s.messages.push({ ...m, seat });
      s.clientMessages[seat][msg.clientId] = m;
      out.push(
        { to: seat, msg: { type: "chat", message: m, clientId: msg.clientId } },
        { to: peer, msg: { type: "chat", message: { ...m, from: "partner" } } },
      );
    }
  } else if (msg.type === "typing") {
    if (s.phases[seat] === "chat" && !s.chatClosedBy) {
      if (seat === "ai") s.aiTyping = msg.active;
      out.push({
        to: peer,
        msg: { type: "partner_typing", active: msg.active },
      });
      if (seat === "ai")
        out.push({
          to: "human",
          msg: { type: "snapshot", state: humanSnapshot(s, c) },
        });
    }
  } else if (msg.type === "end_chat") {
    if ((seat === "human" ? s.phases.human : s.phases.ai) !== "chat")
      err("invalid_phase", "チャットを終了できる状態ではありません。");
    else {
      s.chatClosedBy ??= seat;
      s.phases.human = "naming";
      s.phases.ai = "naming";
      snap();
    }
  } else if (msg.type === "submit_names") {
    if ((seat === "human" ? s.phases.human : s.phases.ai) !== "naming")
      err("invalid_phase", "名前を提出できる状態ではありません。");
    else if (!sameKeys(msg.names, s.slots[seat]))
      err("invalid_names", "6つの図形に別々の名前を入力してください。");
    else {
      const vals = s.orders[seat].map(
        (id) =>
          msg.names[
            Object.keys(s.slots[seat]).find((k) => s.slots[seat][k] === id)!
          ],
      );
      const v = validateNames(vals);
      // Generic text: the per-field messages of validateNames refer to figure numbers.
      if (!v.ok) err("invalid_names", "6つの図形に、それぞれ別の名前を入力してください。");
      else {
        s.names[seat] = { ...msg.names };
        if (seat === "human") s.phases.human = "survey";
        else s.phases.ai = "done";
        if (seat === "ai" && s.phases.human === "waiting_ai_names")
          s.phases.human = "results";
        snap();
      }
    }
  } else if (msg.type === "submit_survey" && seat === "human") {
    if (s.phases.human !== "survey")
      err("invalid_phase", "アンケートを提出できる状態ではありません。");
    else {
      s.survey = msg.survey;
      s.phases.human = s.phases.ai === "done" ? "results" : "waiting_ai_names";
      snap();
    }
  }
  return { state: s, out };
}
export function mockOpening(s: RoomState): string {
  s.mockOpeningSent = true;
  return MOCK_OPENING;
}
/** The mock never parses figure references; it only gives neutral, short prompts in turn. */
export function mockReply(s: RoomState): string {
  return mockReplyText(s.mockPromptIndex++);
}

export function appendAiMessage(
  state: RoomState,
  text: string,
  now: number,
): RoomState {
  const message: ChatMessage = {
    id: String(state.nextMessageId),
    from: "self",
    text,
    at: now,
  };
  return {
    ...state,
    messages: [...state.messages, { ...message, seat: "ai" }],
    nextMessageId: state.nextMessageId + 1,
  };
}

/**
 * The mock AI's submission: distinct placeholders per AI slot, chosen without looking at the
 * conversation or the human's figures. Needed only because the room requires six names; they
 * are never scored or shown (see humanSnapshot).
 */
export function mockNames(s: RoomState): Record<string, string> {
  return mockPlaceholderNames(s.orders.ai.map((id) => slotOf(s, "ai", id)));
}
