import { LIVE_CLOSE, LIVE_PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from './protocol';

// Transport swap point: a future AI-side seat or alternate backend can implement this interface.
export interface LiveTransport {
  connect(): void;
  send(msg: ClientMessage): boolean;
  close(): void;
  onMessage(cb: (m: ServerMessage) => void): () => void;
  onStatus(cb: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void): () => void;
}

export class WebSocketTransport implements LiveTransport {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private messages = new Set<(m: ServerMessage) => void>();
  private statuses = new Set<(s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void>();

  constructor(private roomId: string, private token: string, private onCloseReason?: (reason: string | null) => void) {}

  onMessage(cb: (m: ServerMessage) => void) { this.messages.add(cb); return () => this.messages.delete(cb); }
  onStatus(cb: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void) { this.statuses.add(cb); return () => this.statuses.delete(cb); }
  private status(s: 'connecting' | 'open' | 'reconnecting' | 'closed') { this.statuses.forEach((cb) => cb(s)); }
  connect() { if (!this.closed && !this.socket) this.open(); }
  private open() {
    this.status(this.attempts ? 'reconnecting' : 'connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/rooms/${this.roomId}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed) return socket.close();
      this.attempts = 0;
      this.status('open');
      socket.send(JSON.stringify({ type: 'hello', protocol: LIVE_PROTOCOL_VERSION, token: this.token }));
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    socket.onmessage = (event) => {
      try { const msg = JSON.parse(String(event.data)) as ServerMessage; this.messages.forEach((cb) => cb(msg)); } catch { /* Ignore malformed server frames. */ }
    };
    socket.onclose = (event) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.socket = null;
      const reason = event.code === LIVE_CLOSE.replaced ? 'replaced' : event.code === LIVE_CLOSE.expired ? 'expired' : event.code === LIVE_CLOSE.badToken ? 'bad_token' : event.code === LIVE_CLOSE.protocol ? 'protocol' : null;
      if (reason || this.closed) {
        this.closed = true;
        this.onCloseReason?.(reason);
        this.status('closed');
      } else {
        this.attempts += 1;
        this.timer = setTimeout(() => this.open(), Math.min(500 * (2 ** (this.attempts - 1)), 8_000));
        this.status('reconnecting');
      }
    };
    socket.onerror = () => socket.close();
  }
  send(msg: ClientMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.timer = null;
    this.pingTimer = null;
    this.socket?.close();
    this.socket = null;
    this.status('closed');
  }
}
