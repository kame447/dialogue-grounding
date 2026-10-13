import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, HumanClientMessage, HumanServerMessage, HumanSnapshot, NameAnswers, Survey } from '../ai/protocol';
import { WebSocketTransport, type CloseReason, type RoomTransport, type TransportStatus } from './transport';

export interface PendingChat { clientId: string; text: string; failed: boolean }
export type TransportFactory = (roomId: string, token: string, onClose: (reason: CloseReason) => void) => RoomTransport;

const defaultFactory: TransportFactory = (roomId, token, onClose) => new WebSocketTransport(roomId, token, onClose);
const ACK_TIMEOUT_MS = 8_000;
const draftKey = (roomId: string) => `dg-ai-draft:${roomId}`;

function appendMessage(prev: HumanSnapshot | null, message: ChatMessage): HumanSnapshot | null {
  if (!prev || prev.messages.some((m) => m.id === message.id)) return prev;
  return { ...prev, messages: [...prev.messages, message] };
}

export function useRoom(roomId: string, token: string, transportFactory: TransportFactory = defaultFactory) {
  const [snapshot, setSnapshot] = useState<HumanSnapshot | null>(null);
  const [status, setStatus] = useState<TransportStatus>('connecting');
  const [closedReason, setClosedReasonRaw] = useState<CloseReason | null>(null);
  // The first reason wins: an error frame (not_found/bad_token) arrives before the generic close code.
  const setClosedReason = useCallback((reason: CloseReason) => setClosedReasonRaw((prev) => prev ?? reason), []);
  const [aiTyping, setAiTyping] = useState(false);
  const [pending, setPending] = useState<PendingChat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const transportRef = useRef<RoomTransport | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(draftKey(roomId)) ?? ''; } catch { return ''; } });

  useEffect(() => {
    try { sessionStorage.setItem(draftKey(roomId), draft); } catch { /* Storage can be unavailable. */ }
  }, [roomId, draft]);

  const markFailed = useCallback((clientId: string) => setPending((prev) => prev.map((p) => (p.clientId === clientId ? { ...p, failed: true } : p))), []);
  const armTimeout = useCallback((clientId: string) => {
    const old = timers.current.get(clientId);
    if (old) clearTimeout(old);
    timers.current.set(clientId, setTimeout(() => markFailed(clientId), ACK_TIMEOUT_MS));
  }, [markFailed]);

  useEffect(() => {
    const transport = transportFactory(roomId, token, setClosedReason);
    transportRef.current = transport;
    const pendingTimers = timers.current;
    const offMessage = transport.onMessage((msg: HumanServerMessage) => {
      switch (msg.type) {
        case 'snapshot':
          setSnapshot(msg.state);
          setAiTyping(msg.state.ai.typing);
          setBusy(false);
          break;
        case 'chat':
          setSnapshot((prev) => appendMessage(prev, msg.message));
          if (msg.message.from === 'partner') setAiTyping(false);
          if (msg.clientId) {
            const timer = pendingTimers.get(msg.clientId);
            if (timer) clearTimeout(timer);
            pendingTimers.delete(msg.clientId);
            setPending((prev) => prev.filter((p) => p.clientId !== msg.clientId));
          }
          break;
        case 'partner_typing':
          setAiTyping(msg.active);
          break;
        case 'error':
          setBusy(false);
          if (msg.code === 'not_found' || msg.code === 'expired' || msg.code === 'bad_token') { setClosedReason(msg.code); return; }
          setError(msg.code === 'invalid_names' ? '回答を確認してください。' : msg.message);
          if (msg.clientId) markFailed(msg.clientId);
          break;
        case 'replaced':
          setClosedReason('replaced');
          break;
        case 'deleted':
          setClosedReason('deleted');
          break;
        case 'pong':
          break;
      }
    });
    const offStatus = transport.onStatus(setStatus);
    transport.connect();
    return () => {
      offMessage();
      offStatus();
      transport.close();
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
    };
  }, [roomId, token, transportFactory, setClosedReason, markFailed]);

  const send = useCallback((msg: HumanClientMessage) => transportRef.current?.send(msg) ?? false, []);

  const sendChat = useCallback((text: string) => {
    if (!text.trim()) return;
    const clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setPending((prev) => [...prev, { clientId, text: text.trim(), failed: false }]);
    if (!send({ type: 'chat', clientId, text })) markFailed(clientId);
    else armTimeout(clientId);
    send({ type: 'typing', active: false });
    setDraft('');
    setError(null);
  }, [send, markFailed, armTimeout]);

  const retry = useCallback((clientId: string) => {
    const item = pending.find((p) => p.clientId === clientId);
    if (!item) return;
    setPending((prev) => prev.map((p) => (p.clientId === clientId ? { ...p, failed: false } : p)));
    // Same clientId: the server stores a message at most once per clientId.
    if (!send({ type: 'chat', clientId, text: item.text })) markFailed(clientId);
    else armTimeout(clientId);
  }, [pending, send, markFailed, armTimeout]);

  /** Phase actions. `busy` blocks double submission until the next snapshot or error. */
  const act = useCallback((msg: HumanClientMessage) => {
    setError(null);
    if (send(msg)) setBusy(true);
    else setError('接続が切れています。再接続後にもう一度お試しください。');
  }, [send]);

  return {
    snapshot, status, closedReason, aiTyping, pending, error, busy, draft, setDraft, sendChat, retry,
    clearError: () => setError(null),
    setTyping: (active: boolean) => send({ type: 'typing', active }),
    endChat: () => act({ type: 'end_chat' }),
    submitNames: (names: NameAnswers) => act({ type: 'submit_names', names }),
    submitSurvey: (survey: Survey) => act({ type: 'submit_survey', survey }),
    useMock: () => act({ type: 'use_mock' }),
    deleteRoom: () => act({ type: 'delete_room' }),
  };
}

export type RoomApi = ReturnType<typeof useRoom>;
