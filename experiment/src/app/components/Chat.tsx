import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { LIMITS, type ChatMessage } from '../../ai/protocol';
import type { PendingChat } from '../useRoom';

const time = (at: number) => new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

export function Thread(props: { messages: ChatMessage[]; pending?: PendingChat[]; aiTyping?: boolean; onRetry?: (clientId: string) => void; empty?: ReactNode; label?: string }) {
  const { messages, pending = [], aiTyping = false } = props;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const count = messages.length + pending.length + (aiTyping ? 1 : 0);
  // Follow new messages only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  const isEmpty = messages.length === 0 && pending.length === 0 && !aiTyping;
  return (
    <div className="thread" ref={ref} role="log" aria-label={props.label ?? '会話'} aria-live="polite" tabIndex={0}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      {isEmpty ? props.empty : (
        <ol>
          {messages.map((m) => (
            <li key={m.id} className={`msg ${m.from === 'self' ? 'msg-self' : 'msg-ai'}`}>
              <span className="msg-who">{m.from === 'self' ? 'あなた' : 'AI'}・{time(m.at)}</span>
              <div className="bubble">{m.text}</div>
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.clientId} className={`msg msg-self msg-pending ${p.failed ? 'msg-failed' : ''}`}>
              <span className="msg-who">あなた</span>
              <div className="bubble">{p.text}</div>
              <span className="msg-meta">
                {p.failed ? <>送信できませんでした<button type="button" className="btn btn-quiet btn-sm" onClick={() => props.onRetry?.(p.clientId)}>再送信</button></> : '送信中…'}
              </span>
            </li>
          ))}
          {aiTyping && (
            <li className="msg msg-ai">
              <span className="typing" role="status"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>AIが入力中</span>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

export function Composer(props: { value: string; disabled: boolean; onChange: (v: string) => void; onSend: () => void; hint?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 140)}px`;
  }, [props.value]);
  const canSend = !props.disabled && props.value.trim().length > 0;
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); if (canSend) props.onSend(); }}>
      <div className="composer-row">
        <textarea
          ref={ref}
          rows={1}
          aria-label="メッセージ"
          placeholder={props.disabled ? '' : 'メッセージを入力'}
          maxLength={LIMITS.maxMessageChars}
          value={props.value}
          disabled={props.disabled}
          enterKeyHint="send"
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              if (canSend) props.onSend();
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={!canSend}>送信</button>
      </div>
      <div className="composer-foot">
        <span>{props.hint ?? 'Enterで送信・Shift+Enterで改行'}</span>
        <span>{props.value.length}/{LIMITS.maxMessageChars}</span>
      </div>
    </form>
  );
}
