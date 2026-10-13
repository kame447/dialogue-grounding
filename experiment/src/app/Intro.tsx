import { useState } from 'react';
import { roomPath, type CreateRoomResponse } from '../ai/protocol';
import { AiChip, TopBar } from './components/Frame';

export async function createRoom(mode: 'mock' | 'external'): Promise<CreateRoomResponse> {
  const response = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  if (response.status === 429) throw new Error('短時間に何度も作成されたため、少し待ってからお試しください。');
  if (!response.ok) throw new Error(`開始できませんでした（${response.status}）。時間をおいてお試しください。`);
  return (await response.json()) as CreateRoomResponse;
}

const FLOW = [
  ['会話', 'AIとチャットで、図形の呼び方を相談します。'],
  ['名前', '各図形の名前を、AIに見せずに入力します。'],
  ['アンケート', 'やりとりの負担について3問に答えます。'],
  ['結果', 'あなたとAIの名前の一致を確認します。'],
] as const;

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
        <div>
          <p className="intro-kicker">対話による共通基盤形成の研究デモ</p>
          <h1>図形の命名対話</h1>
          <p className="intro-lead">6つの図形をAIと話し合い、区別できる名前をつけます</p>
          <div className="intro-actions">
            <button className="btn btn-primary btn-lg" onClick={() => void start()} disabled={busy}>{busy ? '準備しています…' : 'デモを始める'}</button>
          </div>
          {error && <p className="alert" role="alert" style={{ marginTop: 16 }}>{error}</p>}
          <p className="intro-fine">相手は動作確認用の模擬AIで、AIモデルには接続していません。図形を見て判断することもありません。入力内容は研究データとして扱わず、30日後に自動で削除されます。</p>
        </div>
        <ol className="intro-flow" aria-label="デモの流れ">
          {FLOW.map(([title, text], i) => (
            <li key={title}>
              <span className="step-num" aria-hidden="true">{i + 1}</span>
              <div><strong>{title}</strong><span>{text}</span></div>
            </li>
          ))}
        </ol>
      </main>
      <footer className="site-foot">
        <span>DEMO・本番の実験ではありません</span>
        <a href="#/researcher">研究者向け: 外部AIの接続</a>
      </footer>
    </div>
  );
}
