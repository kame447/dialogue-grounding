import { useEffect, useRef, useState } from 'react';
import type { BlockState, Stimulus } from '../domain/types';
import { randomId } from '../domain/ids';
import { Modal } from '../ui/Modal';
import { FigurePanel } from './FigurePanel';

export interface ChatScreenProps {
  round: 1 | 2;
  block: BlockState;
  stimuli: Stimulus[]; // participant slot order
  awaitingPartner: boolean;
  partnerError: string | null;
  onSend: (id: string, text: string) => void;
  onComposing: (active: boolean) => void;
  onRetry: () => void;
  onMemo: (slot: number, text: string) => void;
  onEnd: () => void;
}

export function ChatScreen(props: ChatScreenProps) {
  const [draft, setDraft] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const composing = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.block.messages.length, props.awaitingPartner]);

  const setComposing = (active: boolean) => {
    if (composing.current === active) return;
    composing.current = active;
    props.onComposing(active);
  };

  const canSend = draft.trim().length > 0 && !props.awaitingPartner;

  const send = () => {
    if (!canSend) return;
    props.onSend(randomId('m'), draft);
    setDraft('');
    setComposing(false);
    inputRef.current?.focus();
  };

  return (
    <div>
      <h1 className="visually-hidden">ラウンド {props.round} / 2：会話</h1>
      <div className="task-layout">
        <FigurePanel stimuli={props.stimuli} memos={props.block.memos} onMemo={props.onMemo} />
        <section className="chat" aria-labelledby="chat-title">
          <div className="chat-head">
            <h2 id="chat-title">ラウンド {props.round} / 2 ・ 相手との会話</h2>
            <span className="muted small">相手：モック（DEMO）</span>
          </div>
          <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="会話" tabIndex={0}>
            {props.block.messages.length === 0 ? (
              <p className="chat-empty">まだメッセージはありません。図形の特徴を伝えるところから始めてみてください。</p>
            ) : (
              props.block.messages.map((m) => (
                <div key={m.id} className={`msg msg-${m.speaker}`}>
                  <span className="msg-who">{m.speaker === 'human' ? 'あなた' : '相手'}</span>
                  <div className="msg-bubble">{m.text}</div>
                </div>
              ))
            )}
            {props.awaitingPartner ? (
              <p className="typing" role="status">
                相手が入力しています
              </p>
            ) : null}
          </div>
          {props.partnerError ? (
            <div className="alert" role="alert">
              <span>相手からの返答を受け取れませんでした。</span>
              <button type="button" className="btn btn-small" onClick={props.onRetry}>
                再送信
              </button>
            </div>
          ) : null}
          <form
            className="chat-compose"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor="chat-input" className="visually-hidden">
              メッセージ
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              rows={2}
              value={draft}
              maxLength={500}
              aria-describedby="compose-hint"
              onChange={(e) => {
                setDraft(e.target.value);
                setComposing(e.target.value.length > 0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={!canSend}>
              送信
            </button>
          </form>
          <p id="compose-hint" className="compose-hint">
            Enterで送信、Shift+Enterで改行。{props.awaitingPartner ? '相手の返答を待っています。' : ''}
          </p>
        </section>
      </div>
      <div className="end-row">
        <span className="muted small">6個すべてに名前をつけられそうなら、会話を終えてください。</span>
        <button type="button" className="btn" disabled={props.awaitingPartner} onClick={() => setConfirmEnd(true)}>
          会話を終えて名前の入力へ
        </button>
      </div>
      <Modal open={confirmEnd} onClose={() => setConfirmEnd(false)} labelledBy="end-title">
        <h2 id="end-title">会話を終了しますか？</h2>
        <p>終了すると、このラウンドの会話には戻れません。次の画面で、6個の図形の名前を一人で入力します。</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setConfirmEnd(false)} autoFocus>
            会話に戻る
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setConfirmEnd(false);
              setComposing(false);
              props.onEnd();
            }}
          >
            終了して名前入力へ
          </button>
        </div>
      </Modal>
    </div>
  );
}
