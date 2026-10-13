import { useState } from 'react';
import { validateNames, MAX_NAME_LENGTH } from '../domain/names';
import { Modal } from '../ui/Modal';
import { LIVE_LIMITS, type LiveSurvey } from './protocol';
import { DemoRibbon } from './LiveLobby';
import { LiveFigure } from './LiveFigure';
import { useLiveRoom } from './useLiveRoom';

const reasonText: Record<string, string> = { replaced: '別のタブまたは端末でこの招待リンクが開かれたため、この画面は切断されました', expired: 'このルームは期限切れです', not_found: '招待リンクが無効です', bad_token: '招待リンクが無効です', protocol: 'この画面は利用できません' };
export function LiveRoom({ roomId, token }: { roomId: string; token: string }) {
  const live = useLiveRoom(roomId, token);
  const [zoom, setZoom] = useState<number | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [names, setNames] = useState<string[]>(Array(6).fill(''));
  const [confirmNames, setConfirmNames] = useState(false);
  const [survey, setSurvey] = useState<LiveSurvey>({ effort: 0, fluency: 0, annoyance: 0, comment: '' });
  const [invalidNames, setInvalidNames] = useState(false);
  const [surveyError, setSurveyError] = useState(false);
  const snapshot = live.snapshot;
  const phase = snapshot?.phase ?? 'waiting_peer';
  const canChat = phase === 'chat' && !snapshot?.chatClosed;
  const validateAndConfirm = () => { setInvalidNames(false); if (validateNames(names).ok) setConfirmNames(true); else setInvalidNames(true); };
  const submitSurvey = () => { if (!survey.effort || !survey.fluency || !survey.annoyance) { setSurveyError(true); return; } setSurveyError(false); live.submitSurvey(survey); };
  return <main className="live-main">
    <DemoRibbon />
    <div className="live-head"><h1>2台で試す</h1><p>有効期限: {snapshot ? new Date(snapshot.expiresAt).toLocaleString('ja-JP') : '接続中…'}</p></div>
    {!live.closedReason && (live.status === 'reconnecting' || live.status === 'closed') && <div role="status" className="live-connection">接続が切れました。再接続しています…</div>}
    {live.error && <div className="alert" role="alert">{live.error}</div>}
    {live.closedReason ? <section className="panel"><h2>この画面は使用できません</h2><p>{reasonText[live.closedReason] ?? '接続を終了しました'}。</p><p><a href="#/live">新しいルームを作成する</a></p></section> : !snapshot ? <section className="panel"><h2>接続しています</h2><p role="status">サーバーからルームの状態を取得しています。</p></section> : <>
      {phase === 'waiting_peer' && <section className="panel"><h2>相手の参加を待っています</h2><p>参加者2の招待リンクを相手に送ってください。</p></section>}
      {phase === 'chat' && <>
        <p className="panel">2人で話し合い、6つの図形それぞれに2人で同じ名前を付けることを目指してください。相手の画面では並び順が違います。消去法も使えます。名前の共有は会話でのみ行ってください。</p>
        <div className="live-task">
          <section aria-label="あなたの図形" className="live-figures">{snapshot.figures.map((figure, i) => <button key={figure.slot} className="live-figure-card" onClick={() => setZoom(i)} aria-label={`図形${i + 1}を拡大`}><LiveFigure polygons={figure.polygons} label={`図形${i + 1}`} /><span>図形{i + 1}</span></button>)}</section>
          <section className="live-chat"><h2>会話</h2>
            {snapshot.chatClosedBy === 'peer' && <div className="callout">相手が会話を終了しました。会話終了に進んでください。</div>}
            <div role="log" aria-label="会話ログ" className="live-log-frame"><ol className="live-log">{snapshot.messages.map((m) => <li key={m.id} className={`live-msg ${m.from === 'self' ? 'self' : 'peer'}`}><strong>{m.from === 'self' ? 'あなた' : '相手'}</strong><div>{m.text}</div></li>)}{live.pending.map((m) => <li key={m.clientId} className="live-msg self pending"><strong>あなた</strong><div>{m.text}</div>{m.failed && <button className="btn btn-small" onClick={() => live.retry(m.clientId)}>再送信</button>}</li>)}</ol></div>
            {snapshot.peer.connected ? <p className="muted small">相手は接続中です</p> : <p className="muted small">相手は切断中です</p>}{live.peerTyping && <p role="status">相手が入力しています…</p>}
            <form className="live-compose" onSubmit={(e) => { e.preventDefault(); live.sendChat(live.draft); }}><textarea aria-label="メッセージ" maxLength={LIVE_LIMITS.maxMessageChars} value={live.draft} disabled={!canChat} onChange={(e) => { live.setDraft(e.target.value); live.setTyping(e.target.value.length > 0); }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); live.sendChat(live.draft); } }} /><div className="live-compose-footer"><span>{live.draft.length}/{LIVE_LIMITS.maxMessageChars}</span><button className="btn btn-primary" disabled={!canChat || !live.draft.trim()}>送信</button></div></form>
          </section>
        </div>
        <div className="actions"><button className="btn btn-primary" onClick={() => setConfirmEnd(true)}>会話を終了する</button></div>
      </>}
      {phase === 'naming' && <section className="panel"><h2>図形の名前</h2><p>6つの図形に名前を付けてください。確定後は変更できません。</p><details className="live-log-review"><summary>会話ログを見る（読み取りのみ）</summary><ol className="live-log" aria-label="会話ログ（読み取りのみ）">{snapshot.messages.map((m) => <li key={m.id} className={`live-msg ${m.from === 'self' ? 'self' : 'peer'}`}><strong>{m.from === 'self' ? 'あなた' : '相手'}</strong><div>{m.text}</div></li>)}</ol></details>{invalidNames && <div role="alert" className="alert">名前を確認してください。6つすべて異なる名前が必要です。</div>}<div className="live-names">{snapshot.figures.map((f, i) => <label key={f.slot}><LiveFigure polygons={f.polygons} label={`図形${i + 1}`} /><span>図形{i + 1}の名前</span><input aria-label={`図形${i + 1}の名前`} maxLength={MAX_NAME_LENGTH + 10} value={names[i]} onChange={(e) => setNames((prev) => prev.map((n, j) => j === i ? e.target.value : n))} /></label>)}</div><div className="actions"><button className="btn btn-primary" onClick={validateAndConfirm}>名前を確定する</button></div></section>}
      {phase === 'survey' && <section className="panel"><h2>会話についての質問</h2><p>独自の暫定質問です（検証済み尺度ではありません）</p>{surveyError && <div role="alert" className="alert">3つの項目すべてに回答してください。</div>}<Scale legend="精神的な努力" prompt="この課題にどれくらい精神的な努力が必要でしたか" low="非常に少ない" high="非常に多い" count={9} value={survey.effort} onChange={(v) => setSurvey({ ...survey, effort: v })} /><Scale legend="進めやすさ" prompt="やりとりはどれくらい進めやすかったですか" low="とても難しい" high="とても簡単" count={7} value={survey.fluency} onChange={(v) => setSurvey({ ...survey, fluency: v })} /><Scale legend="煩わしさ" prompt="やりとりはどれくらい煩わしかったですか" low="まったくない" high="非常に多い" count={7} value={survey.annoyance} onChange={(v) => setSurvey({ ...survey, annoyance: v })} /><label className="live-comment">コメント（任意）<textarea maxLength={LIVE_LIMITS.maxCommentChars} value={survey.comment} onChange={(e) => setSurvey({ ...survey, comment: e.target.value })} /></label><div className="actions"><button className="btn btn-primary" onClick={submitSurvey}>回答を送信</button></div></section>}
      {phase === 'waiting_results' && <section className="panel"><h2>相手の回答を待っています</h2><p>相手の進捗: {snapshot.peer.phase === 'waiting_results' ? '回答済み' : '回答中'}</p></section>}
      {phase === 'results' && snapshot.results && <section className="panel"><div className="table-wrap"><table className="plain"><caption>DEMO結果</caption><thead><tr><th>図形</th><th>あなたの名前</th><th>相手の名前</th><th>一致</th></tr></thead><tbody>{snapshot.results.rows.map((row, i) => <tr key={i}><td><LiveFigure polygons={row.polygons} label={`図形${i + 1}`} size={52} /></td><td>{row.selfName}</td><td>{row.peerName}</td><td>{row.match ? '✓' : '–'}</td></tr>)}</tbody></table></div><h2>一致 {snapshot.results.matched} / 6（DEMO・研究結果ではありません）</h2></section>}
    </>}
    <Modal open={zoom !== null} onClose={() => setZoom(null)} labelledBy="live-zoom-title" className="zoom">{zoom !== null && <><h2 id="live-zoom-title">図形{zoom + 1}</h2><div className="live-zoom"><LiveFigure polygons={snapshot?.figures[zoom]?.polygons ?? []} label={`図形${zoom + 1}の拡大`} size={360} /></div><button className="btn" onClick={() => setZoom(null)}>閉じる</button></>}</Modal>
    <Modal open={confirmEnd} onClose={() => setConfirmEnd(false)} labelledBy="live-end-title"><h2 id="live-end-title">会話を終了しますか？</h2><p>終了すると、2人とも会話に戻れません。</p><div className="actions"><button className="btn" onClick={() => setConfirmEnd(false)}>続ける</button><button className="btn btn-primary" onClick={() => { live.endChat(); setConfirmEnd(false); }}>終了する</button></div></Modal>
    <Modal open={confirmNames} onClose={() => setConfirmNames(false)} labelledBy="live-names-title"><h2 id="live-names-title">名前を確定しますか？</h2><p>確定後は変更できません。</p><div className="actions"><button className="btn" onClick={() => setConfirmNames(false)}>修正する</button><button className="btn btn-primary" onClick={() => { live.submitNames(Object.fromEntries(snapshot?.figures.map((f, i) => [f.slot, names[i].trim()]) ?? [])); setConfirmNames(false); }}>確定する</button></div></Modal>
  </main>;
}

function Scale({ legend, prompt, low, high, count, value, onChange }: { legend: string; prompt: string; low: string; high: string; count: number; value: number; onChange: (value: number) => void }) {
  return <fieldset className="scale"><legend>{legend}</legend><p>{prompt}</p><div className="scale-options" style={{ ['--n' as string]: count }}>{Array.from({ length: count }, (_, i) => i + 1).map((n) => <label className="scale-option" key={n}><input type="radio" name={legend} checked={value === n} onChange={() => onChange(n)} /><span>{n}</span></label>)}</div><div className="scale-anchors"><span>{low}</span><span>{high}</span></div></fieldset>;
}
