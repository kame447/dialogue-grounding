import { useEffect, useMemo, useState } from 'react';
import { LIMITS, type Figure, type HumanSnapshot, type NameAnswer } from '../../ai/protocol';
import { normalizeName } from '../../domain/names';
import { Thread } from '../components/Chat';
import { Dialog } from '../components/Dialog';
import { FigureArt } from '../components/Figure';
import { Scene, answerLabel } from '../components/Scene';
import { useAppHeight } from '../useAppHeight';
import type { RoomApi } from '../useRoom';

const storageKey = (roomKey: string) => `dg-ai-answers:${roomKey}`;

/** slot → answer; a missing key means "not answered yet" (distinct from null = not agreed). */
type Answers = Record<string, NameAnswer>;

/** Slots whose name collides with another figure's name. "Not agreed" never collides. */
function duplicates(answers: Answers): Set<string> {
  const named = Object.entries(answers).flatMap(([slot, a]) => (a === null ? [] : [[slot, normalizeName(a)] as const]));
  return new Set(named.filter(([slot, n]) => named.some(([other, m]) => other !== slot && m === n)).map(([slot]) => slot));
}

/**
 * Post-conversation answer form. Naming happens in the conversation; here the participant reports,
 * per silhouette, the name they believe was shared — or that none was agreed. It never asks them
 * to invent names, and it keeps the same scattered scene and the conversation log in view.
 */
export function NamingStage({ room, snapshot }: { room: RoomApi; snapshot: HumanSnapshot }) {
  useAppHeight();
  const roomKey = snapshot.figures.map((f) => f.slot).join('');
  const slots = snapshot.figures.map((f) => f.slot);
  const [answers, setAnswers] = useState<Answers>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(roomKey)) ?? 'null') as Record<string, unknown> | null;
      if (saved && typeof saved === 'object') {
        return Object.fromEntries(slots.flatMap((slot) => (saved[slot] === null || typeof saved[slot] === 'string' ? [[slot, saved[slot] as NameAnswer]] : [])));
      }
    } catch { /* ignore */ }
    return {};
  });
  const [editing, setEditing] = useState<Figure | null>(null);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { try { sessionStorage.setItem(storageKey(roomKey), JSON.stringify(answers)); } catch { /* ignore */ } }, [roomKey, answers]);

  const dup = useMemo(() => duplicates(answers), [answers]);
  const answered = slots.filter((slot) => Object.hasOwn(answers, slot)).length;
  const missing = slots.length - answered;
  const ready = missing === 0 && dup.size === 0;
  const labels = Object.fromEntries(slots.map((slot) => [slot, answerLabel(Object.hasOwn(answers, slot) ? answers[slot] : undefined, dup.has(slot))]));

  const open = (figure: Figure) => { setEditing(figure); setDraft(answers[figure.slot] ?? ''); setDraftError(''); };
  const set = (slot: string, value: NameAnswer | undefined) => setAnswers((prev) => {
    const next = { ...prev };
    if (value === undefined) delete next[slot];
    else next[slot] = value;
    return next;
  });
  const saveName = () => {
    if (!editing) return;
    const value = draft.trim();
    const n = normalizeName(value);
    if (!n) return setDraftError('名前を入力するか、「未合意・わからない」を選んでください');
    if (value.length > LIMITS.maxNameChars) return setDraftError(`${LIMITS.maxNameChars}文字以内で入力してください`);
    if (slots.some((slot) => slot !== editing.slot && typeof answers[slot] === 'string' && normalizeName(answers[slot] as string) === n)) return setDraftError('ほかの図形と同じ名前です');
    set(editing.slot, value);
    setEditing(null);
  };

  return (
    <>
      <div className="workspace">
        <section className="panel scene-panel" aria-label="あなたの図形">
          <Scene
            figures={snapshot.figures}
            labels={labels}
            onPick={open}
            figureLabel={(f) => {
              const a = answers[f.slot];
              return !Object.hasOwn(answers, f.slot) ? '未回答の図形' : a === null ? '未合意と回答した図形' : `「${a}」と回答した図形`;
            }}
          />
        </section>
        <section className="panel chat" aria-labelledby="answer-title">
          <div className="panel-head">
            <div className="head-text">
              <h2 id="answer-title">会話で共有した名前を回答</h2>
              <p className="panel-sub">会話で共有できたと思う名前を、各図形に入力してください。</p>
            </div>
            <span className="panel-count" role="status">{answered}/{slots.length}</span>
          </div>
          <Thread messages={snapshot.messages} label="会話の記録" aiLabel={snapshot.mode === 'mock' ? '模擬AI' : 'AI'} />
          <div className="panel-foot">
            {attempted && !ready && <p className="field-msg field-msg-error" role="alert">{missing > 0 ? `未回答の図形があります（残り${missing}）` : '同じ名前の図形があります'}</p>}
            <button className="btn btn-primary" onClick={() => { setAttempted(true); if (ready) setConfirm(true); }} disabled={room.busy}>回答を提出する</button>
          </div>
        </section>
      </div>
      <Dialog open={editing !== null} title="回答を入力" onClose={() => setEditing(null)} className="modal-name">
        {editing && (
          <form className="name-form" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
            <div className="name-art"><FigureArt polygons={editing.polygons} rotation={editing.placement.rotation} /></div>
            <input
              className="field-input"
              aria-label="会話で共有した名前"
              autoComplete="off"
              autoFocus
              enterKeyHint="done"
              maxLength={LIMITS.maxNameChars + 10}
              value={draft}
              aria-invalid={draftError ? true : undefined}
              aria-describedby="name-error"
              onChange={(e) => { setDraft(e.target.value); setDraftError(''); }}
            />
            <span id="name-error" className="field-msg field-msg-error">{draftError}</span>
            <div className="modal-actions modal-actions-split">
              <button type="button" className="btn" aria-pressed={answers[editing.slot] === null} onClick={() => { set(editing.slot, null); setEditing(null); }}>未合意・わからない</button>
              <span className="modal-actions-end">
                <button type="button" className="btn btn-quiet" onClick={() => setEditing(null)}>キャンセル</button>
                <button type="submit" className="btn btn-primary">決定</button>
              </span>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog open={confirm} title="回答を提出しますか？" onClose={() => setConfirm(false)} className="modal-wide">
        <p>提出すると変更できません。</p>
        <div className="confirm-scene"><Scene figures={snapshot.figures} labels={labels} /></div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirm(false)}>修正する</button>
          <button className="btn btn-primary" disabled={room.busy} onClick={() => {
            room.submitNames(Object.fromEntries(slots.map((slot) => [slot, answers[slot] ?? null])));
            setConfirm(false);
          }}>提出する</button>
        </div>
      </Dialog>
    </>
  );
}
