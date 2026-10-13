import { DurableObject } from 'cloudflare:workers';
import { LIVE_CLOSE, LIVE_LIMITS, LIVE_PROTOCOL_VERSION, isRoomId, isToken, parseClientMessage, type LiveRole, type ServerMessage } from '../src/live/protocol';
import { constantTimeEqual, sha256Hex } from './tokens';
import { createRoomState, handle, isExpired, join, snapshotFor, type RoomState } from './roomCore';

interface Env {}
type Attachment = { seat: LiveRole | null };
const KEY = 'state';
export class LiveRoom extends DurableObject<Env> {
  private get sockets(): WebSocket[] { return this.ctx.getWebSockets(); }
  private async read(): Promise<RoomState | undefined> { return this.ctx.storage.get<RoomState>(KEY); }
  private async write(state: RoomState): Promise<void> { await this.ctx.storage.put(KEY, state); }
  private send(socket: WebSocket, message: ServerMessage): void { try { socket.send(JSON.stringify(message)); } catch { /* socket is closing */ } }
  // `gone` is a socket that is closing but may still be listed by getWebSockets().
  private seatSocket(seat: LiveRole, gone?: WebSocket): WebSocket | undefined { return this.sockets.find((s) => s !== gone && (s.deserializeAttachment() as Attachment | null)?.seat === seat); }
  private connected(gone?: WebSocket): Record<LiveRole, boolean> { return { p1: !!this.seatSocket('p1', gone), p2: !!this.seatSocket('p2', gone) }; }
  private snapshot(state: RoomState, seat: LiveRole, gone?: WebSocket): void { const socket = this.seatSocket(seat, gone); if (socket) this.send(socket, { type: 'snapshot', state: snapshotFor(state, seat, this.connected(gone)) }); }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/init' && request.method === 'POST') {
      if (await this.read()) return new Response('exists', { status: 409 });
      const body = await request.json() as { roomId: string; tokenHashes: Record<LiveRole, string>; setId: 'alpha' | 'beta'; seed: number; now: number };
      if (!isRoomId(body.roomId) || !body.tokenHashes?.p1 || !body.tokenHashes?.p2 || !['alpha', 'beta'].includes(body.setId) || !Number.isInteger(body.seed)) return new Response('bad init', { status: 400 });
      const state = createRoomState({ ...body, randomSlot: () => { const b = new Uint8Array(12); crypto.getRandomValues(b); return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(''); } });
      await this.write(state); await this.ctx.storage.setAlarm(state.expiresAt); return new Response('ok');
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
    this.ctx.acceptWebSocket(server); server.serializeAttachment({ seat: null } satisfies Attachment);
    const state = await this.read();
    if (!state) { this.send(server, { type: 'error', code: 'not_found', message: 'ルームが見つかりません。' }); server.close(LIVE_CLOSE.expired); return new Response(null, { status: 101, webSocket: client }); }
    if (isExpired(state, Date.now())) { this.send(server, { type: 'error', code: 'expired', message: 'ルームの有効期限が切れました。' }); server.close(LIVE_CLOSE.expired); return new Response(null, { status: 101, webSocket: client }); }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    const state = await this.read();
    if (!state || isExpired(state, Date.now())) { this.send(socket, { type: 'error', code: state ? 'expired' : 'not_found', message: state ? 'ルームの有効期限が切れました。' : 'ルームが見つかりません。' }); socket.close(LIVE_CLOSE.expired); return; }
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    if (text.length > LIVE_LIMITS.maxFrameBytes) { this.send(socket, { type: 'error', code: 'bad_request', message: 'メッセージが大きすぎます。' }); if (!attachment?.seat) socket.close(LIVE_CLOSE.protocol); return; }
    if (!attachment?.seat) {
      let hello: unknown; try { hello = JSON.parse(text); } catch { hello = null; }
      const value = hello as { type?: string; protocol?: number; token?: string } | null;
      if (!value || value.type !== 'hello' || value.protocol !== LIVE_PROTOCOL_VERSION || !isToken(value.token)) { this.send(socket, { type: 'error', code: 'bad_token', message: '接続情報を確認できません。' }); socket.close(LIVE_CLOSE.badToken); return; }
      const hash = await sha256Hex(value.token);
      const seat: LiveRole | null = constantTimeEqual(hash, state.tokenHashes.p1) ? 'p1' : constantTimeEqual(hash, state.tokenHashes.p2) ? 'p2' : null;
      if (!seat) { this.send(socket, { type: 'error', code: 'bad_token', message: '接続情報を確認できません。' }); socket.close(LIVE_CLOSE.badToken); return; }
      const old = this.seatSocket(seat, socket); if (old) { old.serializeAttachment({ seat: null } satisfies Attachment); this.send(old, { type: 'replaced' }); old.close(LIVE_CLOSE.replaced, 'replaced'); }
      socket.serializeAttachment({ seat } satisfies Attachment);
      join(state, seat); await this.write(state);
      this.snapshot(state, seat); this.snapshot(state, seat === 'p1' ? 'p2' : 'p1');
      return;
    }
    const msg = parseClientMessage(text);
    if (!msg || msg.type === 'hello') { this.send(socket, { type: 'error', code: 'bad_request', message: 'メッセージ形式を確認してください。' }); return; }
    const result = handle(state, attachment.seat, msg, Date.now(), this.connected());
    if (msg.type !== 'typing' && msg.type !== 'ping') await this.write(result.state);
    for (const item of result.out) { const target = this.seatSocket(item.to); if (target) this.send(target, item.msg); }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment?.seat) return;
    const state = await this.read(); if (!state) return;
    const peer = attachment.seat === 'p1' ? 'p2' : 'p1'; this.snapshot(state, peer, socket);
    try { socket.close(1000, 'closed'); } catch { /* already closed */ }
  }
  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket); }
  async alarm(): Promise<void> { for (const socket of this.sockets) { try { socket.close(LIVE_CLOSE.expired, 'expired'); } catch { /* already closed */ } } await this.ctx.storage.deleteAll(); }
}
