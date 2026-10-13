/**
 * Live two-device DEMO protocol (shared by the browser UI and the Cloudflare Worker / Durable Object).
 *
 * A room has two seats, p1 and p2. Today both seats are humans on separate devices. The room logic
 * only sees seat messages, so a future server-side AI partner can occupy a seat by speaking this same
 * protocol (perception/decision in one VLM, wording in a separate generator) without changing the UI.
 *
 * Nothing in this protocol carries stimulus IDs, the peer's layout or the peer's names before both
 * participants have finished. Figures are addressed by opaque per-room, per-seat slot keys.
 */

export const LIVE_PROTOCOL_VERSION = 1;

export const LIVE_LIMITS = {
  roomTtlMs: 24 * 60 * 60 * 1000,
  maxMessageChars: 300,
  maxMessagesPerRoom: 400,
  maxFrameBytes: 4096,
  maxCommentChars: 500,
  maxNameChars: 40,
  /** Chat messages per seat within rateWindowMs. */
  rateMessages: 8,
  rateWindowMs: 10_000,
  /** Room creations per client IP per minute (best effort, per isolate). */
  createPerMinute: 10,
} as const;

export type LiveRole = 'p1' | 'p2';

/** Per-seat progress. Ordered; the server never moves a seat backwards. */
export type LivePhase = 'waiting_peer' | 'chat' | 'naming' | 'survey' | 'waiting_results' | 'results';
export const LIVE_PHASE_ORDER: readonly LivePhase[] = ['waiting_peer', 'chat', 'naming', 'survey', 'waiting_results', 'results'];

export type Point = [number, number];

export interface LiveFigure {
  /** Opaque, random per room and seat. Not a stimulus ID and not shared with the peer. */
  slot: string;
  polygons: Point[][];
}

export interface LiveChatMessage {
  id: string;
  from: 'self' | 'peer';
  text: string;
  /** Server receive time (ms since epoch). */
  at: number;
}

export interface LiveSurvey {
  /** 1..9 — project's own provisional item, not a validated scale. */
  effort: number;
  /** 1..7 */
  fluency: number;
  /** 1..7 */
  annoyance: number;
  comment: string;
}

export interface LiveResultRow {
  polygons: Point[][];
  selfName: string;
  peerName: string;
  match: boolean;
}

export interface LivePeerStatus {
  joined: boolean;
  connected: boolean;
  /** Coarse progress only; never names or answers. */
  phase: LivePhase;
}

export interface LiveSnapshot {
  protocol: typeof LIVE_PROTOCOL_VERSION;
  role: LiveRole;
  phase: LivePhase;
  expiresAt: number;
  peer: LivePeerStatus;
  /** In this participant's own order. */
  figures: LiveFigure[];
  messages: LiveChatMessage[];
  chatClosed: boolean;
  chatClosedBy: 'self' | 'peer' | null;
  myNames: Record<string, string> | null;
  mySurvey: LiveSurvey | null;
  /** Only set when phase === 'results' (both seats finished names and survey). Rows in own figure order. */
  results: { rows: LiveResultRow[]; matched: number; total: number } | null;
}

export type ClientMessage =
  | { type: 'hello'; protocol: number; token: string }
  | { type: 'chat'; clientId: string; text: string }
  | { type: 'typing'; active: boolean }
  | { type: 'end_chat' }
  | { type: 'submit_names'; names: Record<string, string> }
  | { type: 'submit_survey'; survey: LiveSurvey }
  | { type: 'ping' };

export type LiveErrorCode =
  | 'bad_request'
  | 'bad_token'
  | 'not_found'
  | 'expired'
  | 'not_ready'
  | 'invalid_phase'
  | 'chat_closed'
  | 'too_long'
  | 'room_full'
  | 'rate_limited'
  | 'invalid_names'
  | 'invalid_survey';

export type ServerMessage =
  | { type: 'snapshot'; state: LiveSnapshot }
  /** clientId is echoed only to the sender, as the delivery acknowledgement. */
  | { type: 'chat'; message: LiveChatMessage; clientId?: string }
  | { type: 'peer_typing'; active: boolean }
  | { type: 'error'; code: LiveErrorCode; message: string; clientId?: string }
  /** Sent to an older socket of the same seat right before it is closed (another tab took over). */
  | { type: 'replaced' }
  | { type: 'pong' };

/** WebSocket close codes used by the server. */
export const LIVE_CLOSE = { replaced: 4001, badToken: 4003, expired: 4004, protocol: 4005 } as const;

/** POST /api/rooms response. Tokens are only ever returned here and only to the creator. */
export interface CreateRoomResponse {
  roomId: string;
  expiresAt: number;
  tokens: Record<LiveRole, string>;
}

const ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f]{48}$/;
export const isRoomId = (value: unknown): value is string => typeof value === 'string' && ID_RE.test(value);
export const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_RE.test(value);

/** Participant-facing invite path (hash route, so the token never reaches server logs or Referer headers). */
export const invitePath = (roomId: string, token: string) => `#/live/${roomId}/${token}`;

export function parseInviteHash(hash: string): { roomId: string; token: string } | null {
  const m = /^#\/live\/([0-9a-f]{32})\/([0-9a-f]{48})$/.exec(hash);
  return m ? { roomId: m[1], token: m[2] } : null;
}

const isInt = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export function validateSurvey(raw: unknown): LiveSurvey | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isInt(s.effort, 1, 9) || !isInt(s.fluency, 1, 7) || !isInt(s.annoyance, 1, 7)) return null;
  const comment = s.comment ?? '';
  if (typeof comment !== 'string' || comment.length > LIVE_LIMITS.maxCommentChars) return null;
  return { effort: s.effort as number, fluency: s.fluency as number, annoyance: s.annoyance as number, comment };
}

/** Structural validation of an incoming frame. Phase/semantic checks happen in the room logic. */
export function parseClientMessage(data: unknown): ClientMessage | null {
  if (typeof data !== 'string' || data.length > LIVE_LIMITS.maxFrameBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      return typeof m.protocol === 'number' && isToken(m.token) ? { type: 'hello', protocol: m.protocol, token: m.token } : null;
    case 'chat':
      return typeof m.clientId === 'string' && m.clientId.length <= 64 && typeof m.text === 'string' ? { type: 'chat', clientId: m.clientId, text: m.text } : null;
    case 'typing':
      return typeof m.active === 'boolean' ? { type: 'typing', active: m.active } : null;
    case 'end_chat':
      return { type: 'end_chat' };
    case 'submit_names': {
      const names = m.names;
      if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
      const entries = Object.entries(names as Record<string, unknown>);
      if (entries.length > 12 || entries.some(([k, v]) => k.length > 64 || typeof v !== 'string')) return null;
      return { type: 'submit_names', names: Object.fromEntries(entries) as Record<string, string> };
    }
    case 'submit_survey': {
      const survey = validateSurvey(m.survey);
      return survey ? { type: 'submit_survey', survey } : null;
    }
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}
