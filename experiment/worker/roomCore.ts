import { LIVE_LIMITS, LIVE_PHASE_ORDER, LIVE_PROTOCOL_VERSION, type ClientMessage, type LiveChatMessage, type LivePhase, type LiveRole, type LiveSnapshot, type LiveSurvey, type ServerMessage } from '../src/live/protocol';
import { normalizeName, validateNames } from '../src/domain/names';
import { STIMULUS_SETS } from '../src/stimuli/sets';
import { createLayout, createRng } from '../src/stimuli/layout';

export interface RoomState {
  roomId: string;
  tokenHashes: Record<LiveRole, string>;
  setId: 'alpha' | 'beta';
  seed: number;
  expiresAt: number;
  orders: Record<LiveRole, string[]>;
  slots: Record<LiveRole, Record<string, string>>;
  phases: Record<LiveRole, LivePhase>;
  joined: Record<LiveRole, boolean>;
  names: Record<LiveRole, Record<string, string> | null>;
  surveys: Record<LiveRole, LiveSurvey | null>;
  messages: Array<LiveChatMessage & { seat: LiveRole }>;
  chatClosedBy: LiveRole | null;
  rateTimes: Record<LiveRole, number[]>;
  nextMessageId: number;
}

const roles: LiveRole[] = ['p1', 'p2'];
const other = (seat: LiveRole): LiveRole => seat === 'p1' ? 'p2' : 'p1';
const progress = (phase: LivePhase) => LIVE_PHASE_ORDER.indexOf(phase);
const copyPolygons = (polygons: readonly (readonly (readonly [number, number])[])[]) => polygons.map((polygon) => polygon.map(([x, y]) => [x, y] as [number, number]));

export function createRoomState(input: { roomId: string; tokenHashes: Record<LiveRole, string>; setId: 'alpha' | 'beta'; seed: number; now: number; randomSlot: () => string }): RoomState {
  const set = STIMULUS_SETS[input.setId];
  const layout = createLayout(set, createRng(input.seed));
  const orders = { p1: layout.human, p2: layout.partner };
  const slots = { p1: {} as Record<string, string>, p2: {} as Record<string, string> };
  for (const seat of roles) for (const id of orders[seat]) slots[seat][input.randomSlot()] = id;
  return { roomId: input.roomId, tokenHashes: input.tokenHashes, setId: input.setId, seed: input.seed >>> 0, expiresAt: input.now + LIVE_LIMITS.roomTtlMs, orders, slots, phases: { p1: 'waiting_peer', p2: 'waiting_peer' }, joined: { p1: false, p2: false }, names: { p1: null, p2: null }, surveys: { p1: null, p2: null }, messages: [], chatClosedBy: null, rateTimes: { p1: [], p2: [] }, nextMessageId: 1 };
}

export function isExpired(state: RoomState, now: number): boolean { return now >= state.expiresAt; }

export function join(state: RoomState, seat: LiveRole): RoomState {
  state.joined[seat] = true;
  if (state.joined.p1 && state.joined.p2) for (const role of roles) if (progress(state.phases[role]) < progress('chat')) state.phases[role] = 'chat';
  return state;
}

export function snapshotFor(state: RoomState, seat: LiveRole, connected: Record<LiveRole, boolean>): LiveSnapshot {
  const peer = other(seat);
  const slotForId = (role: LiveRole) => Object.fromEntries(Object.entries(state.slots[role]).map(([slot, id]) => [id, slot]));
  let results: LiveSnapshot['results'] = null;
  if (state.phases[seat] === 'results') {
    const mine = state.names[seat] ?? {};
    const theirs = state.names[peer] ?? {};
    const ownSlots = slotForId(seat);
    const rows = state.orders[seat].map((id) => ({ polygons: copyPolygons(STIMULUS_SETS[state.setId].stimuli.find((s) => s.id === id)!.polygons), selfName: mine[ownSlots[id]] ?? '', peerName: theirs[slotForId(peer)[id]] ?? '', match: normalizeName(mine[ownSlots[id]] ?? '') === normalizeName(theirs[slotForId(peer)[id]] ?? '') }));
    results = { rows, matched: rows.filter((row) => row.match).length, total: rows.length };
  }
  const phase = state.phases[seat];
  return {
    protocol: LIVE_PROTOCOL_VERSION, role: seat, phase, expiresAt: state.expiresAt,
    peer: { joined: state.joined[peer], connected: connected[peer], phase: state.phases[peer] },
    figures: state.orders[seat].map((id) => ({ slot: slotForId(seat)[id], polygons: copyPolygons(STIMULUS_SETS[state.setId].stimuli.find((s) => s.id === id)!.polygons) })),
    messages: state.messages.map(({ seat: fromSeat, ...message }) => ({ ...message, from: fromSeat === seat ? 'self' : 'peer' })),
    chatClosed: state.chatClosedBy !== null, chatClosedBy: state.chatClosedBy === null ? null : state.chatClosedBy === seat ? 'self' : 'peer',
    myNames: state.names[seat], mySurvey: state.surveys[seat], results,
  };
}

export function handle(state: RoomState, seat: LiveRole, msg: ClientMessage, now: number, connected: Record<LiveRole, boolean>): { state: RoomState; out: Array<{ to: LiveRole; msg: ServerMessage }> } {
  const peer = other(seat);
  const out: Array<{ to: LiveRole; msg: ServerMessage }> = [];
  const error = (code: 'bad_request' | 'invalid_phase' | 'chat_closed' | 'too_long' | 'room_full' | 'rate_limited' | 'invalid_names' | 'invalid_survey', message: string, clientId?: string) => out.push({ to: seat, msg: { type: 'error', code, message, ...(clientId ? { clientId } : {}) } });
  if (msg.type === 'ping') return { state, out: [{ to: seat, msg: { type: 'pong' } }] };
  if (msg.type === 'chat') {
    if (state.chatClosedBy) error('chat_closed', 'チャットは終了しました。', msg.clientId);
    else if (state.phases[seat] !== 'chat') error('invalid_phase', 'チャットできる状態ではありません。', msg.clientId);
    else {
      const text = msg.text.trim();
      const since = state.rateTimes[seat].filter((at) => now - at < LIVE_LIMITS.rateWindowMs);
      if (!text) error('bad_request', 'メッセージを入力してください。', msg.clientId);
      else if (text.length > LIVE_LIMITS.maxMessageChars) error('too_long', `${LIVE_LIMITS.maxMessageChars}文字以内で入力してください。`, msg.clientId);
      else if (state.messages.length >= LIVE_LIMITS.maxMessagesPerRoom) error('room_full', 'このルームのメッセージ上限に達しました。', msg.clientId);
      else if (since.length >= LIVE_LIMITS.rateMessages) error('rate_limited', '少し待ってから送信してください。', msg.clientId);
      else {
        state.rateTimes[seat] = [...since, now];
        const message: LiveChatMessage = { id: String(state.nextMessageId++), from: 'self', text, at: now };
        state.messages.push({ ...message, seat });
        out.push({ to: seat, msg: { type: 'chat', message, clientId: msg.clientId } }, { to: peer, msg: { type: 'chat', message: { ...message, from: 'peer' } } });
      }
    }
  } else if (msg.type === 'typing') {
    if (state.phases[seat] === 'chat' && !state.chatClosedBy) out.push({ to: peer, msg: { type: 'peer_typing', active: msg.active } });
  } else if (msg.type === 'end_chat') {
    if (state.phases[seat] !== 'chat') error('invalid_phase', 'チャットを終了できる状態ではありません。');
    else { state.chatClosedBy ??= seat; if (progress(state.phases[seat]) < progress('naming')) state.phases[seat] = 'naming'; for (const role of roles) out.push({ to: role, msg: { type: 'snapshot', state: snapshotFor(state, role, connected) } }); }
  } else if (msg.type === 'submit_names') {
    if (state.phases[seat] !== 'naming') error('invalid_phase', '名前を提出できる状態ではありません。');
    else {
      const keys = Object.keys(state.slots[seat]);
      const exact = Object.keys(msg.names).length === keys.length && keys.every((key) => Object.hasOwn(msg.names, key));
      const validation = exact ? validateNames(state.orders[seat].map((id) => msg.names[Object.keys(state.slots[seat]).find((slot) => state.slots[seat][slot] === id)!])) : { ok: false, errors: { 0: '図形の名前を確認してください。' } };
      if (!validation.ok) error('invalid_names', Object.values(validation.errors).join(' '));
      else { state.names[seat] = { ...msg.names }; state.phases[seat] = 'survey'; for (const role of roles) out.push({ to: role, msg: { type: 'snapshot', state: snapshotFor(state, role, connected) } }); }
    }
  } else if (msg.type === 'submit_survey') {
    if (state.phases[seat] !== 'survey') error('invalid_phase', 'アンケートを提出できる状態ではありません。');
    else { state.surveys[seat] = msg.survey; state.phases[seat] = 'waiting_results'; if (state.surveys.p1 && state.surveys.p2) for (const role of roles) state.phases[role] = 'results'; for (const role of roles) out.push({ to: role, msg: { type: 'snapshot', state: snapshotFor(state, role, connected) } }); }
  }
  return { state, out };
}
