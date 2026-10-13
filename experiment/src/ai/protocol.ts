/**
 * Human + AI co-naming DEMO protocol (shared by the browser UI, the Cloudflare Worker / Durable
 * Object and the headless agent stub).
 *
 * A room has exactly two seats: one human participant (browser) and one AI partner. The AI seat is
 * filled either by the server-side mock AI (mode 'mock') or by an external headless agent that
 * connects with its own token from another machine (mode 'external'). No real model is connected.
 *
 * Leak rules enforced by the server (see docs/agent-protocol.md):
 * - Figures are addressed by opaque per-room, per-seat slot keys; never stimulus IDs. They are never
 *   numbered or named on screen: each seat sees the same six silhouettes scattered at its own
 *   irregular positions and orientations (`placement`, see src/stimuli/scene.ts).
 * - The human never receives the AI token, the AI's figure order, the AI's names before results,
 *   or any condition / scoring field.
 * - The AI never receives the human's survey answers or the human's names before results.
 */

export const PROTOCOL_VERSION = 2;

export const LIMITS = {
  /** Provisional maximum room lifetime: 30 days. The Durable Object alarm deletes all data then. */
  roomTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxMessageChars: 300,
  maxMessagesPerRoom: 400,
  maxFrameBytes: 8192,
  maxCommentChars: 500,
  maxNameChars: 40,
  maxAgentLabelChars: 64,
  /** Chat messages per seat within rateWindowMs. */
  rateMessages: 8,
  rateWindowMs: 10_000,
  /** Room creations per client IP per minute (best effort, per isolate). */
  createPerMinute: 10,
} as const;

export type RoomMode = 'mock' | 'external';
export type Seat = 'human' | 'ai';

/**
 * Human progress. Ordered; the server never moves a seat backwards.
 * waiting_ai: external mode, the agent has not connected yet (human may switch to the mock AI).
 * waiting_ai_names: human finished names + survey, AI has not submitted its names yet.
 */
export type HumanPhase = 'waiting_ai' | 'chat' | 'naming' | 'survey' | 'waiting_ai_names' | 'results';
export const HUMAN_PHASE_ORDER: readonly HumanPhase[] = ['waiting_ai', 'chat', 'naming', 'survey', 'waiting_ai_names', 'results'];

/** AI progress. waiting_human: human has not opened the room yet. done: names submitted. */
export type AgentPhase = 'waiting_human' | 'chat' | 'naming' | 'done';

export type Point = [number, number];

/**
 * A seat's post-conversation answer for one figure: the name it believes was shared in the
 * conversation, or null = "not agreed / don't know". Naming itself happens in the conversation;
 * this answer is an independent report, not proof that an agreement occurred.
 */
export type NameAnswer = string | null;
export type NameAnswers = Record<string, NameAnswer>;

/** Where a figure sits in this seat's scene (SCENE units, clockwise degrees). See src/stimuli/scene.ts. */
export interface FigurePlacement {
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

export interface Figure {
  /** Opaque, random per room and seat. Not a stimulus ID and not shared with the other seat. */
  slot: string;
  /** Canonical silhouette polygons in a 0..100 square (unrotated). */
  polygons: Point[][];
  /** Seat-specific position/orientation, fixed for the room (server-generated from its seed). */
  placement: FigurePlacement;
}

export interface ChatMessage {
  id: string;
  /** Relative to the receiving seat. */
  from: 'self' | 'partner';
  text: string;
  /** Server receive time (ms since epoch). */
  at: number;
}

export interface Survey {
  /** 1..9 — project's own provisional item, not a validated scale. */
  effort: number;
  /** 1..7 */
  fluency: number;
  /** 1..7 */
  annoyance: number;
  comment: string;
}

export interface ResultRow {
  /** The human's own figure slot (to draw it as it appeared in the human's scene). */
  slot: string;
  /** null = the human answered "not agreed / don't know". */
  selfName: NameAnswer;
  /** null = the AI answered "not agreed", or (when results.scored is false) not shown at all. */
  aiName: NameAnswer;
  /** Both answered the same name. "Not agreed" never matches, not even with another "not agreed". null when unscored. */
  match: boolean | null;
}

export interface HumanSnapshot {
  protocol: typeof PROTOCOL_VERSION;
  seat: 'human';
  mode: RoomMode;
  phase: HumanPhase;
  expiresAt: number;
  ai: {
    /** 'mock' = server-side simulated AI (not a model). 'external' = headless agent over the agent port. */
    kind: RoomMode;
    connected: boolean;
    /** The agent has connected at least once (always true in mock mode). */
    everConnected: boolean;
    /** True while the AI is composing a reply (mock delay or agent typing). */
    typing: boolean;
  };
  /** In this participant's own order. */
  figures: Figure[];
  messages: ChatMessage[];
  chatClosedBy: 'self' | 'partner' | null;
  myNames: NameAnswers | null;
  mySurvey: Survey | null;
  /**
   * Only set when phase === 'results'. Rows in the human's own figure order.
   * scored is false for the mock AI: it does not see the figures, so no agreement is computed.
   */
  results: { scored: boolean; rows: ResultRow[]; matched: number | null; total: number } | null;
}

export interface AgentSnapshot {
  protocol: typeof PROTOCOL_VERSION;
  seat: 'ai';
  phase: AgentPhase;
  expiresAt: number;
  human: { connected: boolean; joined: boolean; /** Coarse only. */ stage: 'not_joined' | 'chat' | 'after_chat' };
  /** In the AI seat's own order (differs from the human order). */
  figures: Figure[];
  messages: ChatMessage[];
  chatClosedBy: 'self' | 'partner' | null;
  myNames: NameAnswers | null;
}

export type HumanClientMessage =
  | { type: 'hello'; protocol: number; token: string }
  | { type: 'chat'; clientId: string; text: string }
  | { type: 'typing'; active: boolean }
  | { type: 'end_chat' }
  | { type: 'submit_names'; names: NameAnswers }
  | { type: 'submit_survey'; survey: Survey }
  /** External mode only, before any agent has connected: replace the AI seat by the mock AI. */
  | { type: 'use_mock' }
  /** Deletes the whole room immediately (all seats are disconnected). */
  | { type: 'delete_room' }
  | { type: 'ping' };

export type AgentClientMessage =
  | { type: 'hello'; protocol: number; token: string; agent?: string }
  | { type: 'chat'; clientId: string; text: string }
  | { type: 'typing'; active: boolean }
  | { type: 'end_chat' }
  | { type: 'submit_names'; names: NameAnswers }
  | { type: 'ping' };

export type ErrorCode =
  | 'bad_request'
  | 'bad_token'
  | 'not_found'
  | 'expired'
  | 'invalid_phase'
  | 'chat_closed'
  | 'too_long'
  | 'room_full'
  | 'rate_limited'
  | 'invalid_names'
  | 'invalid_survey';

export type ServerMessage<S = HumanSnapshot | AgentSnapshot> =
  | { type: 'snapshot'; state: S }
  /** clientId is echoed only to the sender, as the delivery acknowledgement. */
  | { type: 'chat'; message: ChatMessage; clientId?: string }
  | { type: 'partner_typing'; active: boolean }
  | { type: 'error'; code: ErrorCode; message: string; clientId?: string }
  /** Sent to an older socket of the same seat right before it is closed (another tab took over). */
  | { type: 'replaced' }
  /** The room was deleted (by the human or by expiry); the socket closes next. */
  | { type: 'deleted' }
  | { type: 'pong' };

export type HumanServerMessage = ServerMessage<HumanSnapshot>;
export type AgentServerMessage = ServerMessage<AgentSnapshot>;

/** WebSocket close codes used by the server. */
export const CLOSE = { replaced: 4001, badToken: 4003, expired: 4004, protocol: 4005, deleted: 4006 } as const;

/** POST /api/rooms body. */
export interface CreateRoomRequest { mode: RoomMode }
/**
 * POST /api/rooms response. Tokens are returned only here, only to the creator.
 * agentToken is present only for mode 'external' (researcher console); the participant start
 * button creates 'mock' rooms and therefore never receives an agent token.
 */
export interface CreateRoomResponse {
  roomId: string;
  mode: RoomMode;
  expiresAt: number;
  humanToken: string;
  agentToken?: string;
}

/** Endpoints. Human: browser, same-origin only. Agent: headless, rejects cross-site browser Origins. */
export const humanSocketPath = (roomId: string) => `/api/rooms/${roomId}/ws`;
export const agentSocketPath = (roomId: string) => `/api/agent/rooms/${roomId}/ws`;

const ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f]{48}$/;
export const isRoomId = (value: unknown): value is string => typeof value === 'string' && ID_RE.test(value);
export const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_RE.test(value);

/** Participant path (hash route, so the token never reaches server logs or Referer headers). */
export const roomPath = (roomId: string, humanToken: string) => `#/r/${roomId}/${humanToken}`;

export function parseRoomHash(hash: string): { roomId: string; token: string } | null {
  const m = /^#\/r\/([0-9a-f]{32})\/([0-9a-f]{48})$/.exec(hash);
  return m ? { roomId: m[1], token: m[2] } : null;
}

const isInt = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export function validateSurvey(raw: unknown): Survey | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isInt(s.effort, 1, 9) || !isInt(s.fluency, 1, 7) || !isInt(s.annoyance, 1, 7)) return null;
  const comment = s.comment ?? '';
  if (typeof comment !== 'string' || comment.length > LIMITS.maxCommentChars) return null;
  return { effort: s.effort as number, fluency: s.fluency as number, annoyance: s.annoyance as number, comment };
}

function parseFrame(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string' || data.length > LIMITS.maxFrameBytes) return null;
  try {
    const raw: unknown = JSON.parse(data);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseNames(names: unknown): NameAnswers | null {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  const entries = Object.entries(names as Record<string, unknown>);
  if (entries.length > 12 || entries.some(([k, v]) => k.length > 64 || (v !== null && (typeof v !== 'string' || v.length > LIMITS.maxNameChars * 2)))) return null;
  return Object.fromEntries(entries) as NameAnswers;
}

/**
 * Semantic check of one seat's answers: every figure answered (a name or null = not agreed),
 * names non-empty, within the length limit and distinct from each other. Several nulls are fine.
 */
export function answersError(answers: NameAnswers, slots: readonly string[], normalize: (s: string) => string): string | null {
  if (Object.keys(answers).length !== slots.length || !slots.every((slot) => Object.hasOwn(answers, slot))) return 'missing';
  const seen = new Set<string>();
  for (const slot of slots) {
    const value = answers[slot];
    if (value === null) continue;
    const n = normalize(value);
    if (!n) return 'empty';
    if (value.trim().length > LIMITS.maxNameChars) return 'too_long';
    if (seen.has(n)) return 'duplicate';
    seen.add(n);
  }
  return null;
}

/** Messages both seats share. Returns undefined when the type is not a shared one. */
function parseShared(m: Record<string, unknown>): HumanClientMessage | null | undefined {
  switch (m.type) {
    case 'hello':
      return typeof m.protocol === 'number' && isToken(m.token) ? { type: 'hello', protocol: m.protocol, token: m.token } : null;
    case 'chat':
      return typeof m.clientId === 'string' && m.clientId.length > 0 && m.clientId.length <= 64 && typeof m.text === 'string' ? { type: 'chat', clientId: m.clientId, text: m.text } : null;
    case 'typing':
      return typeof m.active === 'boolean' ? { type: 'typing', active: m.active } : null;
    case 'end_chat':
      return { type: 'end_chat' };
    case 'submit_names': {
      const names = parseNames(m.names);
      return names ? { type: 'submit_names', names } : null;
    }
    case 'ping':
      return { type: 'ping' };
    default:
      return undefined;
  }
}

/** Structural validation of a human frame. Phase/semantic checks happen in the room logic. */
export function parseHumanMessage(data: unknown): HumanClientMessage | null {
  const m = parseFrame(data);
  if (!m) return null;
  const shared = parseShared(m);
  if (shared !== undefined) return shared;
  switch (m.type) {
    case 'submit_survey': {
      const survey = validateSurvey(m.survey);
      return survey ? { type: 'submit_survey', survey } : null;
    }
    case 'use_mock':
      return { type: 'use_mock' };
    case 'delete_room':
      return { type: 'delete_room' };
    default:
      return null;
  }
}

/** Structural validation of an agent frame. Agents cannot submit surveys, switch modes or delete rooms. */
export function parseAgentMessage(data: unknown): AgentClientMessage | null {
  const m = parseFrame(data);
  if (!m) return null;
  const shared = parseShared(m);
  if (shared === undefined || shared === null) return null;
  if (shared.type === 'hello') {
    const agent = m.agent;
    if (agent !== undefined && (typeof agent !== 'string' || agent.length > LIMITS.maxAgentLabelChars)) return null;
    return agent === undefined ? shared : { ...shared, agent };
  }
  return shared as AgentClientMessage;
}
