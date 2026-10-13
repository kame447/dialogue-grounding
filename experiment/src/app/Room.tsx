import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HumanSnapshot } from '../ai/protocol';
import { Composer, Thread } from './components/Chat';
import { Dialog } from './components/Dialog';
import { FigureArt } from './components/Figure';
import { AiChip, StepBar, Stepper, TopBar, stepIndex } from './components/Frame';
import { NamingStage } from './stages/Naming';
import { ResultsStage } from './stages/Results';
import { SurveyStage } from './stages/Survey';
import { useRoom, type RoomApi } from './useRoom';
import type { CloseReason } from './transport';

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const on = () => setMatch(list.matches);
    on();
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Tracks the visual viewport so the composer stays above the on-screen keyboard. */
function useAppHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = () => document.documentElement.style.setProperty('--app-h', `${Math.round(vv?.height ?? window.innerHeight)}px`);
    apply();
    vv?.addEventListener('resize', apply);
    window.addEventListener('resize', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      window.removeEventListener('resize', apply);
      document.documentElement.style.removeProperty('--app-h');
    };
  }, []);
}

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
  const isChat = !room.closedReason && snapshot?.phase === 'chat';

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
    <div className={isChat ? 'room' : 'frame'}>
      <TopBar center={<Stepper current={current} />} end={<AiChip mode={snapshot.mode} connected={snapshot.ai.connected} />} />
      {offline && <div className="banner banner-warn" role="status">接続が切れました。再接続中です…</div>}
      {room.error && <div className="banner banner-warn" role="alert">{room.error}</div>}
      {isChat ? <ChatStage room={room} snapshot={snapshot} current={current} offline={offline} /> : <>
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
    case 'naming':
      return <NamingStage room={room} snapshot={snapshot} />;
    case 'survey':
      return <SurveyStage room={room} />;
    case 'waiting_ai_names':
      return (
        <CenterState title="AIの名前の提出を待っています" spinner>
          <p>回答を受け付けました。AIが名前を提出すると、結果が表示されます。この画面を開いたままお待ちください。</p>
        </CenterState>
      );
    case 'results':
      return <ResultsStage room={room} snapshot={snapshot} />;
    case 'chat':
      return null;
  }
}

function ChatStage({ room, snapshot, current, offline }: { room: RoomApi; snapshot: HumanSnapshot; current: number; offline: boolean }) {
  useAppHeight();
  const mobile = useMedia('(max-width: 760px)');
  const tabKey = `dg-ai-tab:${snapshot.figures[0]?.slot ?? ''}`;
  const [tab, setTabRaw] = useState<'figures' | 'chat'>(() => { try { return sessionStorage.getItem(tabKey) === 'chat' ? 'chat' : 'figures'; } catch { return 'figures'; } });
  const setTab = (next: 'figures' | 'chat') => { setTabRaw(next); try { sessionStorage.setItem(tabKey, next); } catch { /* ignore */ } };
  const [zoom, setZoom] = useState<number | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const aiCount = useMemo(() => snapshot.messages.filter((m) => m.from === 'partner').length, [snapshot.messages]);
  const seen = useRef(aiCount);
  const chatVisible = !mobile || tab === 'chat';
  useEffect(() => { if (chatVisible) seen.current = aiCount; }, [chatVisible, aiCount]);
  const unread = chatVisible ? 0 : Math.max(0, aiCount - seen.current);
  // The mock runs inside the room server, so it has no connection state of its own.
  const aiOnline = snapshot.mode === 'mock' || snapshot.ai.connected;
  const aiName = snapshot.mode === 'mock' ? '模擬AI・応答可能' : aiOnline ? '外部AIエージェント・接続中' : '外部AIエージェント・切断中';
  const endButton = (small: boolean) => (
    <button className={`btn ${small ? 'btn-sm' : ''}`} onClick={() => setConfirmEnd(true)} disabled={room.busy}>会話を終えて名前を決める</button>
  );

  return (
    <>
      <StepBar current={current} action={endButton(true)} />
      <div className="tabs" role="tablist" aria-label="表示切替">
        <button role="tab" id="tab-figures" className="tab" aria-selected={tab === 'figures'} aria-controls="panel-figures" onClick={() => setTab('figures')}>図形</button>
        <button role="tab" id="tab-chat" className="tab" aria-selected={tab === 'chat'} aria-controls="panel-chat" onClick={() => setTab('chat')}>
          会話{unread > 0 && <span className="badge">未読 {unread}</span>}
        </button>
      </div>
      <div className="workspace">
        <section id="panel-figures" className="panel" aria-labelledby="figures-title" hidden={mobile && tab !== 'figures'}>
          <div className="panel-head">
            <h2 id="figures-title">あなたの図形</h2>
            <span className="panel-sub">並び順はAIの画面と異なります</span>
          </div>
          <div className="figure-grid">
            {snapshot.figures.map((figure, i) => (
              <button key={figure.slot} type="button" className="figure-tile" aria-label={`図形${i + 1}を拡大`} onClick={() => setZoom(i)}>
                <span className="figure-label">図形{i + 1}</span>
                <FigureArt polygons={figure.polygons} />
              </button>
            ))}
          </div>
        </section>
        <section id="panel-chat" className="panel chat has-next" aria-labelledby="chat-title" hidden={mobile && tab !== 'chat'}>
          <div className="panel-head">
            <h2 id="chat-title">会話</h2>
            <span className="chat-status"><span className={`dot ${aiOnline ? 'dot-on' : ''}`} aria-hidden="true" />{aiName}</span>
          </div>
          <Thread
            messages={snapshot.messages}
            pending={room.pending}
            aiTyping={room.aiTyping}
            onRetry={room.retry}
            empty={<div className="empty"><strong>まだメッセージはありません</strong><p>形の特徴や見立てを伝えて、呼び方を相談しましょう。</p></div>}
          />
          <Composer
            value={room.draft}
            disabled={offline}
            onChange={(v) => { room.setDraft(v); room.setTyping(v.length > 0); }}
            onSend={() => room.sendChat(room.draft)}
            hint={offline ? '再接続後に送信できます' : undefined}
          />
          <div className="chat-next">
            <p>6つの呼び方を相談できたら</p>
            {endButton(false)}
          </div>
        </section>
      </div>
      <Dialog open={zoom !== null} title={zoom !== null ? `図形${zoom + 1}` : ''} onClose={() => setZoom(null)} className="modal-zoom">
        {zoom !== null && <div className="zoom-art"><FigureArt polygons={snapshot.figures[zoom]?.polygons ?? []} label={`図形${zoom + 1}の拡大表示`} /></div>}
        <div className="modal-actions"><button className="btn" onClick={() => setZoom(null)}>閉じる</button></div>
      </Dialog>
      <Dialog open={confirmEnd} title="会話を終えますか？" onClose={() => setConfirmEnd(false)}>
        <p>終えると会話には戻れません。次に、6つの図形の名前をAIに見せずに入力します。</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirmEnd(false)}>会話に戻る</button>
          <button className="btn btn-primary" onClick={() => { room.endChat(); setConfirmEnd(false); }}>名前の入力へ進む</button>
        </div>
      </Dialog>
    </>
  );
}
