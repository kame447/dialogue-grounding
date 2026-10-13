import { useEffect, useMemo, useState } from 'react';
import { LIMITS, type Figure, type HumanSnapshot } from '../../ai/protocol';
import { normalizeName } from '../../domain/names';
import { Thread } from '../components/Chat';
import { Dialog } from '../components/Dialog';
import { FigureArt } from '../components/Figure';
import { Scene } from '../components/Scene';
import { useAppHeight } from '../useAppHeight';
import type { RoomApi } from '../useRoom';

const storageKey = (roomKey: string) => `dg-ai-names2:${roomKey}`;

/** Slots whose name collides with another figure's name (after normalisation). */
function duplicates(names: Record<string, string>): Set<string> {
  const bySlot = Object.entries(names).map(([slot, name]) => [slot, normalizeName(name)] as const).filter(([, n]) => n);
  return new Set(bySlot.filter(([slot, n]) => bySlot.some(([other, m]) => other !== slot && m === n)).map(([slot]) => slot));
}

/**
 * Names are given on the same scattered scene the conversation used: the participant picks a
 * silhouette and types its name, which then appears on the silhouette. No numbers, no list.
 */
export function NamingStage({ room, snapshot }: { room: RoomApi; snapshot: HumanSnapshot }) {
  useAppHeight();
  const roomKey = snapshot.figures.map((f) => f.slot).join('');
  const slots = snapshot.figures.map((f) => f.slot);
  const [names, setNames] = useState<Record<string, string>>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(roomKey)) ?? 'null') as unknown;
      if (saved && typeof saved === 'object') {
        return Object.fromEntries(slots.map((slot) => [slot, typeof (saved as Record<string, unknown>)[slot] === 'string' ? (saved as Record<string, string>)[slot] : '']));
      }
    } catch { /* ignore */ }
    return Object.fromEntries(slots.map((slot) => [slot, '']));
  });
  const [editing, setEditing] = useState<Figure | null>(null);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { try { sessionStorage.setItem(storageKey(roomKey), JSON.stringify(names)); } catch { /* ignore */ } }, [roomKey, names]);

  const dup = useMemo(() => duplicates(names), [names]);
  const filled = slots.filter((slot) => normalizeName(names[slot] ?? '')).length;
  const ready = filled === slots.length && dup.size === 0;

  const open = (figure: Figure) => { setEditing(figure); setDraft(names[figure.slot] ?? ''); setDraftError(''); };
  const save = () => {
    if (!editing) return;
    const value = draft.trim();
    const n = normalizeName(value);
    if (value.length > LIMITS.maxNameChars) return setDraftError(`${LIMITS.maxNameChars}文字以内で入力してください`);
    if (n && slots.some((slot) => slot !== editing.slot && normalizeName(names[slot] ?? '') === n)) return setDraftError('ほかの図形と同じ名前です。別の名前にしてください');
    setNames((prev) => ({ ...prev, [editing.slot]: value }));
    setEditing(null);
  };
  const tryConfirm = () => {
    setAttempted(true);
    if (ready) setConfirm(true);
  };
  const missing = slots.length - filled;

  return (
    <>
      <div className="workspace">
        <section className="panel scene-panel" aria-label="あなたの図形">
          <Scene
            figures={snapshot.figures}
            names={names}
            markEmpty
            invalid={dup}
            onPick={open}
            figureLabel={(f) => (names[f.slot]?.trim() ? `「${names[f.slot].trim()}」と名付けた図形` : '名前が未入力の図形')}
          />
        </section>
        <section className="panel chat" aria-labelledby="naming-title">
          <div className="panel-head">
            <div className="head-text">
              <h2 id="naming-title">名前をつける</h2>
              <p className="panel-sub">図形を押して入力・AIには見えません</p>
            </div>
            <span className="panel-count" role="status">{filled}/{slots.length}</span>
          </div>
          <Thread messages={snapshot.messages} label="会話の記録" aiLabel={snapshot.mode === 'mock' ? '模擬AI' : 'AI'} />
          <div className="panel-foot">
            {attempted && !ready && <p className="field-msg field-msg-error" role="alert">{missing > 0 ? `名前が未入力の図形があります（残り${missing}）` : '同じ名前の図形があります'}</p>}
            <button className="btn btn-primary" onClick={tryConfirm} disabled={room.busy}>名前を確定する</button>
          </div>
        </section>
      </div>
      <Dialog open={editing !== null} title="名前をつける" onClose={() => setEditing(null)} className="modal-name">
        {editing && (
          <form className="name-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <div className="name-art"><FigureArt polygons={editing.polygons} rotation={editing.placement.rotation} /></div>
            <input
              className="field-input"
              aria-label="名前"
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
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>キャンセル</button>
              <button type="submit" className="btn btn-primary">決定</button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog open={confirm} title="この名前で確定しますか？" onClose={() => setConfirm(false)} className="modal-wide">
        <p>確定すると変更できません。</p>
        <div className="confirm-scene"><Scene figures={snapshot.figures} names={names} /></div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirm(false)}>修正する</button>
          <button className="btn btn-primary" disabled={room.busy} onClick={() => {
            room.submitNames(Object.fromEntries(slots.map((slot) => [slot, names[slot].trim()])));
            setConfirm(false);
          }}>確定する</button>
        </div>
      </Dialog>
    </>
  );
}
