import { useEffect, useState, type ReactNode } from 'react';
import type { Figure, HumanSnapshot } from '../ai/protocol';
import { Composer, Thread } from './components/Chat';
import { Dialog } from './components/Dialog';
import { FigureArt } from './components/Figure';
import { Scene } from './components/Scene';
import { AiChip, StepBar, Stepper, TopBar, stepIndex } from './components/Frame';
import { NamingStage } from './stages/Naming';
import { ResultsStage } from './stages/Results';
import { SurveyStage } from './stages/Survey';
import { useAppHeight } from './useAppHeight';
import { useRoom, type RoomApi } from './useRoom';
import type { CloseReason } from './transport';

const CLOSED: Record<CloseReason, { title: string; text: string }> = {
  deleted: { title: 'データを削除しました', text: 'このデモの会話・名前・回答はサーバーから削除されました。' },
  expired: { title: 'このデモは期限切れです', text: 'デモのデータは開始から30日で自動的に削除されます。' },
  not_found: { title: 'このリンクは無効です', text: 'デモが見つかりません。削除されたか、リンクが正しくない可能性があります。' },
  bad_token: { title: 'このリンクは無効です', text: 'リンクが正しくない可能性があります。' },
  replaced: { title: '別のタブで開かれました', text: 'このデモは別のタブまたは端末で開かれたため、この画面の接続を終了しました。' },
  protocol: { title: 'この画面は利用できません', text: 'ページを再読み込みしてください。' },
};

function CenterState({ title, children, spinner }: { title: string; children?: ReactNode; spinner?: boolean }) {
  return (
    <main className="center-state">
      {spinner && <div className="spinner" aria-hidden="true" />}
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function Room({ roomId, token }: { roomId: string; token: string }) {
  const room = useRoom(roomId, token);
  const snapshot = room.snapshot;
  const phase = snapshot?.phase;
  // Each step starts at the top of the page (the survey would otherwise leave the results scrolled down).
  useEffect(() => { window.scrollTo?.(0, 0); }, [phase]);
  // Chat and naming share one fixed-height workspace: figures and conversation on the same screen.
  const isWorkspace = !room.closedReason && (snapshot?.phase === 'chat' || snapshot?.phase === 'naming');

  if (room.closedReason) {
    const info = CLOSED[room.closedReason];
    return (
      <div className="frame">
        <TopBar />
        <CenterState title={info.title}>
          <p>{info.text}</p>
          <div className="actions"><a className="btn btn-primary" href="#/">新しいデモを始める</a></div>
        </CenterState>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="frame">
        <TopBar />
        <CenterState title="接続しています" spinner><p role="status">デモの状態を読み込んでいます。</p></CenterState>
      </div>
    );
  }
  const current = stepIndex(snapshot.phase);
  const offline = room.status === 'reconnecting' || room.status === 'connecting' || room.status === 'closed';
  return (
    <div className={isWorkspace ? 'room' : 'frame'}>
      <TopBar center={<Stepper current={current} />} end={<AiChip mode={snapshot.mode} connected={snapshot.ai.connected} />} />
      {offline && <div className="banner banner-warn" role="status">接続が切れました。再接続中です…</div>}
      {room.error && <div className="banner banner-warn" role="alert">{room.error}</div>}
      {snapshot.phase === 'chat' ? <ChatStage room={room} snapshot={snapshot} offline={offline} />
        : snapshot.phase === 'naming' ? <NamingStage room={room} snapshot={snapshot} /> : <>
        <StepBar current={current} />
        <Stage room={room} snapshot={snapshot} />
      </>}
    </div>
  );
}

function Stage({ room, snapshot }: { room: RoomApi; snapshot: HumanSnapshot }) {
  switch (snapshot.phase) {
    case 'waiting_ai':
      return (
        <CenterState title="AI接続待機中" spinner>
          <p>外部AIエージェントの接続を待っています。研究者が別の端末でエージェントを起動すると、自動で会話が始まります。</p>
          <div className="actions"><button className="btn" onClick={room.useMock} disabled={room.busy}>模擬AIで始める</button></div>
          <p className="note">模擬AIは動作確認用の規則ベースの応答で、AIモデルではありません。</p>
        </CenterState>
      );
    case 'survey':
      return <SurveyStage room={room} />;
    case 'waiting_ai_names':
      return (
        <CenterState title="AIの回答を待っています" spinner>
          <p>AIが回答を提出すると結果が表示されます。この画面を開いたままお待ちください。</p>
        </CenterState>
      );
    case 'results':
      return <ResultsStage room={room} snapshot={snapshot} />;
    case 'chat':
    case 'naming':
      return null;
  }
}

function ChatStage({ room, snapshot, offline }: { room: RoomApi; snapshot: HumanSnapshot; offline: boolean }) {
  useAppHeight();
  const [zoom, setZoom] = useState<Figure | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const mock = snapshot.mode === 'mock';
  return (
    <>
      <div className="workspace">
        <section className="panel scene-panel" aria-label="あなたの図形">
          <Scene figures={snapshot.figures} onPick={setZoom} />
        </section>
        <section className="panel chat" aria-labelledby="chat-title">
          <div className="panel-head">
            <div className="head-text">
              <h2 id="chat-title">会話</h2>
              {mock && <p className="panel-sub">相手は模擬AIです（図形は見ていません）</p>}
            </div>
            {!mock && <span className="chat-status"><span className={`dot ${snapshot.ai.connected ? 'dot-on' : ''}`} aria-hidden="true" />{snapshot.ai.connected ? '接続中' : '切断中'}</span>}
            <button className="btn btn-sm head-action" onClick={() => setConfirmEnd(true)} disabled={room.busy}>会話を終了する</button>
          </div>
          <Thread
            messages={snapshot.messages}
            pending={room.pending}
            aiTyping={room.aiTyping}
            aiLabel={mock ? '模擬AI' : 'AI'}
            onRetry={room.retry}
          />
          <Composer
            value={room.draft}
            disabled={offline}
            onChange={(v) => { room.setDraft(v); room.setTyping(v.length > 0); }}
            onSend={() => room.sendChat(room.draft)}
            hint={offline ? '再接続後に送信できます' : undefined}
          />
        </section>
      </div>
      <Dialog open={zoom !== null} title="拡大表示" hideTitle onClose={() => setZoom(null)} className="modal-zoom">
        {zoom && <div className="zoom-art"><FigureArt polygons={zoom.polygons} rotation={zoom.placement.rotation} label="拡大した図形" /></div>}
        <div className="modal-actions"><button className="btn" onClick={() => setZoom(null)}>閉じる</button></div>
      </Dialog>
      <Dialog open={confirmEnd} title="話し合いを終了しますか？" onClose={() => setConfirmEnd(false)}>
        <p>終了後、会話で共有できたと思う名前を回答します。</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirmEnd(false)}>会話に戻る</button>
          <button className="btn btn-primary" onClick={() => { room.endChat(); setConfirmEnd(false); }}>終了して回答へ</button>
        </div>
      </Dialog>
    </>
  );
}
