import { useEffect, useMemo, useState } from 'react';
import { LIMITS, type HumanSnapshot } from '../../ai/protocol';
import { normalizeName } from '../../domain/names';
import { Thread } from '../components/Chat';
import { Dialog } from '../components/Dialog';
import { FigureArt } from '../components/Figure';
import type { RoomApi } from '../useRoom';

const storageKey = (roomId: string) => `dg-ai-names:${roomId}`;

/** Per-field state: duplicates are shown immediately, empty fields turn into errors after a confirm attempt. */
function fieldIssues(names: string[]) {
  const norm = names.map(normalizeName);
  return norm.map((n, i) => {
    if (!n) return { kind: 'empty' as const };
    const dup = norm.findIndex((m, j) => j !== i && m === n);
    if (dup >= 0) return { kind: 'dup' as const, other: dup };
    if (names[i].trim().length > LIMITS.maxNameChars) return { kind: 'long' as const };
    return null;
  });
}

export function NamingStage({ room, snapshot }: { room: RoomApi; snapshot: HumanSnapshot }) {
  const roomKey = snapshot.figures.map((f) => f.slot).join('');
  const [names, setNames] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(roomKey)) ?? 'null') as unknown;
      if (Array.isArray(saved) && saved.length === 6 && saved.every((v) => typeof v === 'string')) return saved as string[];
    } catch { /* ignore */ }
    return Array(6).fill('');
  });
  const [attempted, setAttempted] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [review, setReview] = useState(false);
  useEffect(() => { try { sessionStorage.setItem(storageKey(roomKey), JSON.stringify(names)); } catch { /* ignore */ } }, [roomKey, names]);
  const issues = useMemo(() => fieldIssues(names), [names]);
  const filled = names.filter((n) => normalizeName(n)).length;
  const ok = issues.every((x) => x === null);
  const dupCount = issues.filter((x) => x?.kind === 'dup').length;

  const tryConfirm = () => {
    setAttempted(true);
    if (ok) setConfirm(true);
    else document.getElementById(`name-${issues.findIndex((x) => x !== null)}`)?.focus();
  };

  return (
    <>
      <main className="page">
        <div className="page-head">
          <div>
            <h1>図形の名前を決める</h1>
            <p>会話で決めた呼び方を、6つの図形それぞれに入力してください。入力内容はAIには見えません。</p>
          </div>
          <button className="btn btn-quiet" onClick={() => setReview(true)}>会話を見返す</button>
        </div>
        <div className="name-grid">
          {snapshot.figures.map((figure, i) => {
            const issue = issues[i];
            const error = issue?.kind === 'dup' || issue?.kind === 'long' || (attempted && issue?.kind === 'empty');
            const msg = issue?.kind === 'dup' ? `同じ名前があります（図形${issue.other + 1}）` : issue?.kind === 'long' ? `${LIMITS.maxNameChars}文字以内で入力してください` : issue?.kind === 'empty' ? '未入力' : '';
            return (
              <div className="name-card" key={figure.slot}>
                <FigureArt polygons={figure.polygons} />
                <label htmlFor={`name-${i}`}>図形{i + 1}の名前</label>
                <input
                  id={`name-${i}`}
                  className="field-input"
                  autoComplete="off"
                  maxLength={LIMITS.maxNameChars + 10}
                  value={names[i]}
                  aria-invalid={error || undefined}
                  aria-describedby={`name-msg-${i}`}
                  onChange={(e) => setNames((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))}
                />
                <span id={`name-msg-${i}`} className={`field-msg ${error ? 'field-msg-error' : ''}`}>{msg}</span>
              </div>
            );
          })}
        </div>
      </main>
      <div className="sticky-actions">
        <div className="sticky-inner">
          <p role="status">入力済み {filled}/6{dupCount > 0 ? '・重複あり' : ''}</p>
          <button className="btn btn-primary" onClick={tryConfirm} disabled={room.busy}>名前を確認する</button>
        </div>
      </div>
      <Dialog open={confirm} title="この名前で確定しますか？" onClose={() => setConfirm(false)}>
        <p>確定すると変更できません。</p>
        <ul className="confirm-list">
          {snapshot.figures.map((figure, i) => (
            <li key={figure.slot}><FigureArt polygons={figure.polygons} /><span>図形{i + 1}：{names[i].trim()}</span></li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirm(false)}>修正する</button>
          <button className="btn btn-primary" disabled={room.busy} onClick={() => {
            room.submitNames(Object.fromEntries(snapshot.figures.map((f, i) => [f.slot, names[i].trim()])));
            setConfirm(false);
          }}>確定する</button>
        </div>
      </Dialog>
      <Dialog open={review} title="会話の記録" onClose={() => setReview(false)}>
        <div className="review-log"><Thread messages={snapshot.messages} label="会話の記録" /></div>
        <div className="modal-actions"><button className="btn" onClick={() => setReview(false)}>閉じる</button></div>
      </Dialog>
    </>
  );
}
