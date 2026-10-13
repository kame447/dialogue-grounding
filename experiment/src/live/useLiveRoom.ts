import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, LiveSnapshot, LiveSurvey, ServerMessage } from './protocol';
import { WebSocketTransport, type LiveTransport } from './transport';

export interface PendingChat { clientId: string; text: string; failed: boolean }
type Status = 'connecting' | 'open' | 'reconnecting' | 'closed';
type TransportFactory = (roomId: string, token: string, onClose: (reason: string | null) => void) => LiveTransport;
const defaultFactory: TransportFactory = (roomId, token, onClose) => new WebSocketTransport(roomId, token, onClose);

export function useLiveRoom(roomId: string, token: string, transportFactory: TransportFactory = defaultFactory) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [closedReason, setClosedReasonRaw] = useState<string | null>(null);
  // The first reason wins: an error frame (not_found/bad_token) arrives before the generic close code.
  const setClosedReason = useCallback((reason: string | null) => setClosedReasonRaw((prev) => prev ?? reason), []);
  const [peerTyping, setPeerTyping] = useState(false);
  const [pending, setPending] = useState<PendingChat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const transportRef = useRef<LiveTransport | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(`live-draft:${roomId}`) ?? ''; } catch { return ''; } });

  useEffect(() => {
    try { sessionStorage.setItem(`live-draft:${roomId}`, draft); } catch { /* Storage can be unavailable. */ }
  }, [roomId, draft]);

  useEffect(() => {
    const transport = transportFactory(roomId, token, setClosedReason);
    transportRef.current = transport;
    const offMessage = transport.onMessage((msg: ServerMessage) => {
      if (msg.type === 'snapshot') setSnapshot(msg.state);
      else if (msg.type === 'chat' && msg.message.from === 'peer') {
        setPeerTyping(false);
        setSnapshot((prev) => prev ? { ...prev, messages: prev.messages.some((m) => m.id === msg.message.id) ? prev.messages : [...prev.messages, msg.message] } : prev);
      }
      else if (msg.type === 'chat') {
        setSnapshot((prev) => prev ? { ...prev, messages: prev.messages.some((m) => m.id === msg.message.id) ? prev.messages : [...prev.messages, msg.message] } : prev);
        if (msg.clientId) {
          const timer = timers.current.get(msg.clientId);
          if (timer) clearTimeout(timer);
          timers.current.delete(msg.clientId);
          setPending((prev) => prev.filter((p) => p.clientId !== msg.clientId));
        }
      } else if (msg.type === 'peer_typing') setPeerTyping(msg.active);
      else if (msg.type === 'error') {
        if (msg.code === 'not_found' || msg.code === 'expired' || msg.code === 'bad_token') { setClosedReason(msg.code); return; }
        setError(msg.code === 'invalid_names' ? '名前を確認してください。' : msg.message);
        if (msg.clientId) setPending((prev) => prev.map((p) => p.clientId === msg.clientId ? { ...p, failed: true } : p));
      } else if (msg.type === 'replaced') setClosedReason('replaced');
    });
    const offStatus = transport.onStatus(setStatus);
    transport.connect();
    return () => { offMessage(); offStatus(); transport.close(); timers.current.forEach(clearTimeout); timers.current.clear(); };
  }, [roomId, token, transportFactory, setClosedReason]);

  const send = useCallback((msg: ClientMessage) => transportRef.current?.send(msg) ?? false, []);
  const sendChat = useCallback((text: string) => {
    if (!text.trim()) return;
    const clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setPending((prev) => [...prev, { clientId, text, failed: false }]);
    if (!send({ type: 'chat', clientId, text })) setPending((prev) => prev.map((p) => p.clientId === clientId ? { ...p, failed: true } : p));
    const timer = setTimeout(() => setPending((prev) => prev.map((p) => p.clientId === clientId ? { ...p, failed: true } : p)), 8_000);
    timers.current.set(clientId, timer);
    send({ type: 'typing', active: false });
    setDraft(''); setError(null);
  }, [send]);
  const retry = useCallback((clientId: string) => {
    const item = pending.find((p) => p.clientId === clientId);
    if (!item) return;
    setPending((prev) => prev.map((p) => p.clientId === clientId ? { ...p, failed: false } : p));
    send({ type: 'chat', clientId, text: item.text });
    timers.current.set(clientId, setTimeout(() => setPending((prev) => prev.map((p) => p.clientId === clientId ? { ...p, failed: true } : p)), 8_000));
  }, [pending, send]);
  return {
    snapshot, status, closedReason, peerTyping, pending, error, draft, setDraft, sendChat, retry,
    setTyping: (active: boolean) => send({ type: 'typing', active }),
    endChat: () => send({ type: 'end_chat' }),
    submitNames: (names: Record<string, string>) => send({ type: 'submit_names', names }),
    submitSurvey: (survey: LiveSurvey) => send({ type: 'submit_survey', survey }),
  };
}
