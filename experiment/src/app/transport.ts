import { CLOSE, PROTOCOL_VERSION, humanSocketPath, type HumanClientMessage, type HumanServerMessage } from '../ai/protocol';

const PING_MS = 15_000;

export type TransportStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
/** Terminal reasons; the transport stops reconnecting once one is reported. */
export type CloseReason = 'replaced' | 'expired' | 'bad_token' | 'not_found' | 'deleted' | 'protocol';

/** Swap point for tests and alternative backends. */
export interface RoomTransport {
  connect(): void;
  send(msg: HumanClientMessage): boolean;
  close(): void;
  onMessage(cb: (m: HumanServerMessage) => void): () => void;
  onStatus(cb: (s: TransportStatus) => void): () => void;
}

const reasonForCode: Record<number, CloseReason> = {
  [CLOSE.replaced]: 'replaced',
  [CLOSE.expired]: 'expired',
  [CLOSE.badToken]: 'bad_token',
  [CLOSE.protocol]: 'protocol',
  [CLOSE.deleted]: 'deleted',
};

export class WebSocketTransport implements RoomTransport {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private messages = new Set<(m: HumanServerMessage) => void>();
  private statuses = new Set<(s: TransportStatus) => void>();
  private readonly onOnline = () => {
    // Skip the remaining backoff when the browser reports the network is back.
    if (this.closed || this.socket || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.open();
  };

  /** The browser knows the network is gone before the socket times out: drop it and reconnect on 'online'. */
  private readonly onOffline = () => { if (this.socket) this.drop(this.socket); };

  constructor(private roomId: string, private token: string, private onCloseReason?: (reason: CloseReason) => void) {}

  onMessage(cb: (m: HumanServerMessage) => void) { this.messages.add(cb); return () => { this.messages.delete(cb); }; }
  onStatus(cb: (s: TransportStatus) => void) { this.statuses.add(cb); return () => { this.statuses.delete(cb); }; }
  private status(s: TransportStatus) { this.statuses.forEach((cb) => cb(s)); }

  connect() {
    if (this.closed || this.socket) return;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.open();
  }

  private stopListening() {
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
  }

  private open() {
    this.status(this.attempts ? 'reconnecting' : 'connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}${humanSocketPath(this.roomId)}`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed) return socket.close();
      this.attempts = 0;
      this.status('open');
      socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: this.token }));
      this.lastSeen = Date.now();
      // Heartbeat: a socket that has not answered for two intervals is treated as dead.
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > PING_MS * 2 + 2_000) this.drop(socket);
        else this.send({ type: 'ping' });
      }, PING_MS);
    };
    socket.onmessage = (event) => {
      this.lastSeen = Date.now();
      try {
        const msg = JSON.parse(String(event.data)) as HumanServerMessage;
        this.messages.forEach((cb) => cb(msg));
      } catch { /* Ignore malformed server frames. */ }
    };
    socket.onclose = (event) => {
      const reason = reasonForCode[event.code];
      if (reason || this.closed) {
        this.detach(socket);
        this.closed = true;
        this.stopListening();
        if (reason) this.onCloseReason?.(reason);
        this.status('closed');
        return;
      }
      this.lost(socket);
    };
    socket.onerror = () => socket.close();
  }

  private detach(socket: WebSocket) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.socket === socket) this.socket = null;
  }

  /** Unexpected loss: back off and reconnect (the server replays state in a fresh snapshot). */
  private lost(socket: WebSocket) {
    this.detach(socket);
    if (this.closed || this.timer) return;
    this.attempts += 1;
    this.status('reconnecting');
    this.timer = setTimeout(() => { this.timer = null; this.open(); }, Math.min(500 * 2 ** (this.attempts - 1), 8_000));
  }

  /** Abandon a socket that is known dead without waiting for its close handshake. */
  private drop(socket: WebSocket) {
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* already closed */ }
    this.lost(socket);
  }

  send(msg: HumanClientMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  close() {
    this.closed = true;
    this.stopListening();
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.timer = null;
    this.pingTimer = null;
    this.socket?.close();
    this.socket = null;
    this.status('closed');
  }
}
