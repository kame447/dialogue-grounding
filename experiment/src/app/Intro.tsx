import { useState } from 'react';
import { roomPath, type CreateRoomResponse } from '../ai/protocol';
import { AiChip, TopBar } from './components/Frame';

export async function createRoom(mode: 'mock' | 'external'): Promise<CreateRoomResponse> {
  const response = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  if (response.status === 429) throw new Error('短時間に何度も作成されたため、少し待ってからお試しください。');
  if (!response.ok) throw new Error(`開始できませんでした（${response.status}）。時間をおいてお試しください。`);
  return (await response.json()) as CreateRoomResponse;
}

export function Intro() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const room = await createRoom('mock');
      location.hash = roomPath(room.roomId, room.humanToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : '通信に失敗しました。');
      setBusy(false);
    }
  };
  return (
    <div className="frame">
      <TopBar end={<AiChip mode="mock" connected />} />
      <main className="intro">
        <h1>6つの図形の名前を、AIと決めてください</h1>
        <button className="btn btn-primary btn-lg" onClick={() => void start()} disabled={busy}>{busy ? '準備しています…' : 'デモを始める'}</button>
        {error && <p className="alert" role="alert">{error}</p>}
        <p className="intro-fine">DEMO：相手は模擬AIで、実際のAIモデルには接続していません。データは30日後に自動削除されます。</p>
      </main>
      <footer className="site-foot">
        <span>DEMO・本番の実験ではありません</span>
        <a href="#/researcher">研究者向け: 外部AIの接続</a>
      </footer>
    </div>
  );
}
