import { useState } from 'react';
import './live.css';
import { invitePath, type CreateRoomResponse } from './protocol';

export function LiveLobby() {
  const [room, setRoom] = useState<CreateRoomResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const link = (role: 'p1' | 'p2') => room ? `${location.origin}${location.pathname}${invitePath(room.roomId, room.tokens[role])}` : '';
  const copy = async (role: 'p1' | 'p2', input: HTMLInputElement) => {
    try { await navigator.clipboard.writeText(link(role)); }
    catch { input.select(); document.execCommand('copy'); }
  };
  return <section className="live-panel" aria-labelledby="live-title">
    <DemoRibbon />
    <h1 id="live-title">2台で試す</h1>
    <p>2人で6つの図形に同じ名前を付ける通信デモです。</p><p>図形の並び順は端末ごとに異なります。</p><p>最後に名前の一致を確認できます。</p>
    <p className="callout">招待リンクを知っている人はその席に参加できます。意図した相手にだけ送ってください。</p>
    {error && <div role="alert" className="alert">{error}</div>}
    {!room ? <button className="btn btn-primary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { const response = await fetch('/api/rooms', { method: 'POST' }); if (!response.ok) { if (response.status === 429) throw new Error('作成回数が上限に達しました。時間をおいてお試しください。'); throw new Error(`ルームを作成できませんでした（${response.status}）。`); } setRoom(await response.json() as CreateRoomResponse); }
      catch (e) { setError(e instanceof Error ? e.message : '通信に失敗しました。'); } finally { setBusy(false); }
    }}>ルームを作成</button> : <div className="panel">
      {(['p1', 'p2'] as const).map((role, i) => <div className="invite-row" key={role}><label htmlFor={`invite-${role}`}>{i ? '参加者2（もう1台に送る）' : '参加者1（この端末用）'}</label><div><input id={`invite-${role}`} aria-label={`参加者${i + 1}の招待リンク`} readOnly value={link(role)} /><button className="btn btn-small" onClick={(e) => void copy(role, e.currentTarget.previousElementSibling as HTMLInputElement)}>コピー</button></div></div>)}
      <p>有効期限: {new Date(room.expiresAt).toLocaleString('ja-JP')}</p>
      <button className="btn btn-primary" onClick={() => { location.hash = invitePath(room.roomId, room.tokens.p1); }}>参加者1としてこの端末で入る</button>
    </div>}
  </section>;
}

export function DemoRibbon() { return <div className="live-ribbon"><strong>DEMO</strong>（人間同士の通信確認用・研究データとして扱いません）</div>; }
