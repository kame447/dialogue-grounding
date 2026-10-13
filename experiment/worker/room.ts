import { DurableObject } from "cloudflare:workers";
import {
  CLOSE,
  LIMITS,
  PROTOCOL_VERSION,
  isRoomId,
  isToken,
  parseAgentMessage,
  parseHumanMessage,
  type Seat,
  type ServerMessage,
} from "../src/ai/protocol";
import { sha256Hex } from "./tokens";
import {
  agentSnapshot,
  createRoomState,
  handle,
  humanSnapshot,
  isExpired,
  join,
  mockNames,
  mockOpening,
  mockReply,
  appendAiMessage,
  tokenMatches,
  type RoomState,
} from "./roomCore";

interface Env {
  MOCK_AI_DELAY_MS?: string;
}
type Attachment = { seat: Seat | null };
const KEY = "state";
export class TangramRoom extends DurableObject<Env> {
  private mockReplyTail: Promise<void> = Promise.resolve();
  private get sockets() {
    return this.ctx.getWebSockets();
  }
  private async read() {
    return this.ctx.storage.get<RoomState>(KEY);
  }
  private send(ws: WebSocket, m: ServerMessage) {
    try {
      ws.send(JSON.stringify(m));
    } catch {}
  }
  private seatSocket(seat: Seat, exclude?: WebSocket) {
    return this.sockets.find(
      (ws) =>
        ws !== exclude &&
        (ws.deserializeAttachment() as Attachment | null)?.seat === seat,
    );
  }
  private connected(exclude?: WebSocket) {
    return {
      human: !!this.seatSocket("human", exclude),
      ai: !!this.seatSocket("ai", exclude),
    };
  }
  private snapshot(s: RoomState, seat: Seat) {
    const ws = this.seatSocket(seat);
    if (ws)
      this.send(ws, {
        type: "snapshot",
        state:
          seat === "human"
            ? humanSnapshot(s, this.connected())
            : agentSnapshot(s, this.connected()),
      });
  }
  private async expire(_s: RoomState) {
    for (const ws of this.sockets) {
      this.send(ws, { type: "deleted" });
      try {
        ws.close(CLOSE.expired, "expired");
      } catch {}
    }
    await this.ctx.storage.deleteAll();
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") {
      if (await this.read()) return new Response("exists", { status: 409 });
      const b = (await request.json()) as {
        roomId: string;
        tokenHashes: { human: string; agent: string | null };
        mode: "mock" | "external";
        setId: "alpha" | "beta";
        seed: number;
        now: number;
      };
      if (
        !isRoomId(b.roomId) ||
        !b.tokenHashes?.human ||
        !["mock", "external"].includes(b.mode) ||
        !["alpha", "beta"].includes(b.setId) ||
        !Number.isInteger(b.seed)
      )
        return new Response("bad init", { status: 400 });
      const s = createRoomState({
        ...b,
        randomSlot: () => {
          const x = new Uint8Array(12);
          crypto.getRandomValues(x);
          return Array.from(x, (v) => v.toString(16).padStart(2, "0")).join("");
        },
      });
      await this.ctx.storage.put(KEY, s);
      await this.ctx.storage.setAlarm(s.expiresAt);
      return new Response("ok");
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("websocket required", { status: 426 });
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    this.ctx.acceptWebSocket(server);
    const expected =
      request.headers.get("x-tangram-seat") === "ai" ? "ai" : "human";
    server.serializeAttachment({ seat: null, expected } satisfies Attachment & {
      expected: Seat;
    });
    const s = await this.read();
    if (!s || s.deleted) {
      this.send(server, {
        type: "error",
        code: "not_found",
        message: "ルームが見つかりません。",
      });
      server.close(CLOSE.expired);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (isExpired(s, Date.now())) {
      await this.expire(s);
      server.close(CLOSE.expired);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as Attachment | null,
      s = await this.read();
    if (!s || s.deleted) {
      this.send(ws, {
        type: "error",
        code: "not_found",
        message: "ルームが見つかりません。",
      });
      ws.close(CLOSE.expired);
      return;
    }
    if (isExpired(s, Date.now())) {
      await this.expire(s);
      return;
    }
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    if (new TextEncoder().encode(text).byteLength > LIMITS.maxFrameBytes) {
      this.send(ws, {
        type: "error",
        code: "bad_request",
        message: "メッセージが大きすぎます。",
      });
      if (!a?.seat) ws.close(CLOSE.protocol);
      return;
    }
    if (!a?.seat) {
      const wanted =
        (
          ws.deserializeAttachment() as
            | (Attachment & { expected?: Seat })
            | null
        )?.expected ?? "human";
      const parsed =
        wanted === "ai" ? parseAgentMessage(text) : parseHumanMessage(text);
      const hello = parsed && parsed.type === "hello" ? parsed : null;
      if (
        !hello ||
        hello.protocol !== PROTOCOL_VERSION ||
        !isToken(hello.token)
      ) {
        this.send(ws, {
          type: "error",
          code: "bad_token",
          message: "接続情報を確認できません。",
        });
        ws.close(CLOSE.badToken);
        return;
      }
      const hash = await sha256Hex(hello.token);
      const current = await this.read();
      if (!current || current.deleted) {
        this.send(ws, {
          type: "error",
          code: "not_found",
          message: "ルームが見つかりません。",
        });
        ws.close(CLOSE.expired);
        return;
      }
      if (isExpired(current, Date.now())) {
        await this.expire(current);
        ws.close(CLOSE.expired);
        return;
      }
      if (!tokenMatches(current, wanted, hash)) {
        this.send(ws, {
          type: "error",
          code: "bad_token",
          message: "接続情報を確認できません。",
        });
        ws.close(CLOSE.badToken);
        return;
      }
      const old = this.seatSocket(wanted, ws);
      if (old) {
        this.send(old, { type: "replaced" });
        old.close(CLOSE.replaced, "replaced");
      }
      ws.serializeAttachment({
        seat: wanted,
        expected: wanted,
      } satisfies Attachment & { expected: Seat });
      join(current, wanted);
      let opening: string | null = null;
      if (
        current.mode === "mock" &&
        wanted === "human" &&
        !current.mockOpeningSent
      ) {
        opening = mockOpening(current);
        this.prepareMockReply(current);
      }
      await this.ctx.storage.put(KEY, current);
      this.snapshot(current, wanted);
      this.snapshot(current, wanted === "human" ? "ai" : "human");
      if (opening) {
        this.broadcastMockTyping(current);
        await this.enqueueMockReply(opening);
      }
      return;
    }
    const seat = a.seat,
      msg =
        seat === "human" ? parseHumanMessage(text) : parseAgentMessage(text);
    if (!msg || msg.type === "hello") {
      this.send(ws, {
        type: "error",
        code: "bad_request",
        message: "メッセージ形式を確認してください。",
      });
      return;
    }
    const result = handle(s, seat, msg, Date.now(), this.connected());
    if (result.deleteRoom) {
      await this.ctx.storage.deleteAlarm();
      for (const socket of this.sockets) {
        this.send(socket, { type: "deleted" });
        try {
          socket.close(CLOSE.deleted, "deleted");
        } catch {}
      }
      await this.ctx.storage.deleteAll();
      return;
    }
    let mockText: string | null = null;
    if (result.useMock && s.mode === "mock" && !s.mockOpeningSent) {
      mockText = mockOpening(s);
      this.prepareMockReply(s);
    } else if (
      msg.type === "chat" &&
      seat === "human" &&
      s.mode === "mock" &&
      !s.chatClosedBy
    ) {
      mockText = mockReply(s);
      this.prepareMockReply(s);
    }
    if (msg.type === "end_chat" && seat === "human" && s.mode === "mock") {
      s.names.ai = mockNames(s);
      s.phases.ai = "done";
    }
    await this.ctx.storage.put(KEY, s);
    for (const item of result.out) {
      const target = this.seatSocket(item.to);
      if (target) this.send(target, item.msg);
    }
    if (msg.type === "chat" || msg.type === "typing") {
      this.snapshot(s, "human");
      this.snapshot(s, "ai");
    }
    if (mockText) {
      this.broadcastMockTyping(s);
      await this.enqueueMockReply(mockText);
    }
    if (msg.type === "end_chat" && seat === "human" && s.mode === "mock") {
      this.snapshot(s, "human");
    }
  }
  private prepareMockReply(state: RoomState) {
    state.mockPendingReplies += 1;
    state.aiTyping = true;
  }
  private broadcastMockTyping(state: RoomState) {
    for (const ws of this.sockets) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.seat !== "human") continue;
      this.send(ws, { type: "partner_typing", active: true });
      this.send(ws, {
        type: "snapshot",
        state: humanSnapshot(state, this.connected()),
      });
    }
  }
  private enqueueMockReply(text: string): Promise<void> {
    const next = this.mockReplyTail.then(() => this.deliverMockReply(text));
    this.mockReplyTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async deliverMockReply(text: string) {
    const override = this.env.MOCK_AI_DELAY_MS,
      delay =
        override === undefined
          ? 600 + Math.floor(Math.random() * 601)
          : Math.max(0, Number(override) || 0);
    await new Promise((resolve) => setTimeout(resolve, delay));

    let state = await this.read();
    if (!state || state.deleted) return;
    if (isExpired(state, Date.now())) {
      await this.expire(state);
      return;
    }
    const pending = Math.max(0, state.mockPendingReplies - 1);
    if (state.chatClosedBy || state.phases.human !== "chat") {
      state.mockPendingReplies = pending;
      state.aiTyping = pending > 0;
      await this.ctx.storage.put(KEY, state);
      this.broadcastMockTyping(state);
      return;
    }

    state = appendAiMessage(state, text, Date.now());
    state.mockPendingReplies = pending;
    state.aiTyping = pending > 0;
    const message = state.messages[state.messages.length - 1];
    await this.ctx.storage.put(KEY, state);
    for (const ws of this.sockets) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.seat !== "human") continue;
      this.send(ws, {
        type: "partner_typing",
        active: state.aiTyping,
      });
      this.send(ws, {
        type: "chat",
        message: { ...message, from: "partner" },
      });
      this.send(ws, {
        type: "snapshot",
        state: humanSnapshot(state, this.connected()),
      });
    }
  }
  async webSocketClose(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a?.seat) return;
    const s = await this.read();
    if (s) this.snapshot(s, a.seat === "human" ? "ai" : "human");
    try {
      ws.close(1000, "closed");
    } catch {}
  }
  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    const s = await this.read();
    if (s) await this.expire(s);
  }
}
