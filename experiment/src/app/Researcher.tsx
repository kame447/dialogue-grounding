import { useState } from 'react';
import { agentSocketPath, roomPath, type CreateRoomResponse } from '../ai/protocol';
import { TopBar } from './components/Frame';
import { createRoom } from './Intro';

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); }
    catch { (document.getElementById(id) as HTMLInputElement | null)?.select(); }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="copy-field">
      <label htmlFor={id}>{label}</label>
      <div className="copy-row">
        <input id={id} className="field-input" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn" type="button" onClick={() => void copy()}>{copied ? 'コピーしました' : 'コピー'}</button>
      </div>
    </div>
  );
}

/** Researcher-facing: creates an external-agent room and shows the agent credentials once. */
export function Researcher() {
  const [room, setRoom] = useState<CreateRoomResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const origin = location.origin;
  const participantUrl = room ? `${origin}${location.pathname}${roomPath(room.roomId, room.humanToken)}` : '';
  const command = room ? `cd experiment\nDG_AGENT_TOKEN=${room.agentToken} \\\n  node agent/stub-agent.mjs --base ${origin} --room ${room.roomId} --once` : '';
  return (
    <div className="frame">
      <TopBar end={<a className="btn btn-quiet btn-sm" href="#/">参加者画面へ</a>} />
      <main className="console">
        <div>
          <h1>外部AIエージェントの接続</h1>
          <p className="note" style={{ marginTop: 4 }}>研究者向けの画面です。参加者には見せないでください。</p>
        </div>
        <section aria-labelledby="how-title">
          <h2 id="how-title">2台構成の手順</h2>
          <ol>
            <li>このページで「外部AI用ルームを作成」を押します。</li>
            <li>PC1（参加者）で「参加者用URL」を開きます。AIが接続するまで「AI接続待機中」と表示されます。</li>
            <li>PC2でAIトークンを使ってエージェントを起動します。現在は動作確認用のスタブのみで、AIモデルには接続していません。</li>
          </ol>
        </section>
        <section aria-labelledby="create-title">
          <h2 id="create-title">ルーム</h2>
          {!room ? (
            <div>
              <button className="btn btn-primary" disabled={busy} onClick={async () => {
                setBusy(true);
                setError('');
                try { setRoom(await createRoom('external')); } catch (e) { setError(e instanceof Error ? e.message : '作成できませんでした。'); } finally { setBusy(false); }
              }}>外部AI用ルームを作成</button>
              {error && <p className="alert" role="alert" style={{ marginTop: 12 }}>{error}</p>}
            </div>
          ) : (
            <>
              <CopyField id="participant-url" label="参加者用URL" value={participantUrl} />
              <CopyField id="room-id" label="ルームID" value={room.roomId} />
              <CopyField id="agent-token" label="AIトークン" value={room.agentToken ?? ''} />
              <p className="warn-line">AIトークンはこの画面でのみ表示され、再表示できません。参加者の端末やURLには含めないでください。</p>
              <div className="copy-field">
                <span style={{ fontWeight: 600 }}>PC2でのスタブ起動（Node.js 22以上）</span>
                <pre className="code" aria-label="スタブ起動コマンド">{command}</pre>
              </div>
              <p>エージェントの接続先: <code>{origin}{agentSocketPath(room.roomId)}</code>（WebSocket、最初に hello でトークンを送信）。仕様は <code>experiment/docs/agent-protocol.md</code> を参照してください。</p>
              <p className="note">有効期限: {new Date(room.expiresAt).toLocaleDateString('ja-JP')}（30日）。期限後はデータを自動削除します。</p>
              <div><button className="btn" onClick={() => setRoom(null)}>別のルームを作成</button></div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
