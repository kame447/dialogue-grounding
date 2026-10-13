import { useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { SEQUENCES, SEQUENCE_IDS } from '../domain/assignment';
import { randomId, randomSeed } from '../domain/ids';
import { createSession } from '../domain/session';
import { scoreBlock } from '../domain/scoring';
import { exportSession, importSession } from '../domain/storage';
import type { EventType, SequenceId, SessionState } from '../domain/types';
import { getStimulus } from '../stimuli/sets';
import { StimulusSvg } from '../stimuli/StimulusSvg';
import './researcher.css';

const SAMPLE_NOTICE = 'DEMO自作サンプル（原論文刺激ではない・妥当性要確認）';
const EVENT_TYPES: EventType[] = ['session_started','consent_acknowledged','phase_entered','block_started','composing_started','composing_stopped','message_sent','partner_request_started','partner_request_finished','partner_request_failed','message_received','naming_end_requested','names_locked','partner_names_submitted','survey_submitted','comparison_submitted','results_viewed','mock_diagnostic','transition_rejected'];
const PHASE_LABELS: Record<string, string> = { welcome:'開始', consent:'同意', instructions:'説明', chat:'会話', naming:'命名', survey:'アンケート', interblock:'ブロック間', comparison:'比較', results:'結果', done:'完了' };

export function ResearcherDemo(props: { session: SessionState | null; onReplace: (next: SessionState | null) => void }): ReactElement {
  const [sequence, setSequence] = useState<SequenceId>('S1');
  const [filter, setFilter] = useState('');
  const [exportText, setExportText] = useState('');
  const [importText, setImportText] = useState('');
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const { session, onReplace } = props;
  const filteredEvents = useMemo(() => session?.events.filter((event) => !filter || event.type === filter) ?? [], [session, filter]);

  function newSession(event: FormEvent) {
    event.preventDefault();
    onReplace(createSession({ sessionId: randomId('demo'), sequenceId: sequence, seed: randomSeed() }));
  }
  function loadJson(json: string) {
    try { onReplace(importSession(json)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function download() {
    if (!session) return;
    const json = exportSession(session);
    setExportText(json);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `dg-demo-${session.sessionId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  function renderNewSessionForm() {
    return <form className="rd-new-session" onSubmit={newSession}><label>系列 <select aria-label="新規セッションの系列" value={sequence} onChange={(event) => setSequence(event.target.value as SequenceId)}>{SEQUENCE_IDS.map((id) => <option key={id} value={id}>{id}</option>)}</select></label><button type="submit">この系列で新規デモセッション</button></form>;
  }

  return <main className="rd-page">
    <section className="rd-banner" role="note"><p>研究者向けデモ画面 — 実験本番には使用禁止。本番ではサーバー側の認証・権限制御が必要です。データはこのタブのsessionStorageのみに保存され、外部送信しません。</p><a href="#/legacy">参加者画面へ</a></section>
    <section><h2>条件割付（4系列）</h2><div className="rd-table-wrap"><table><thead><tr><th>系列</th><th>Round1 条件 + セット</th><th>Round2 条件 + セット</th></tr></thead><tbody>{SEQUENCE_IDS.map((id) => <tr key={id} className={session?.assignment.sequenceId === id ? 'rd-current' : undefined}><th>{id}{session?.assignment.sequenceId === id ? '（現在）' : ''}</th>{SEQUENCES[id].blocks.map((block) => <td key={block.round}>{block.condition} / {block.stimulusSet}</td>)}</tr>)}</tbody></table></div>{renderNewSessionForm()}</section>
    {!session ? <p className="rd-empty">セッションがありません</p> : <>
      <section><h2>使用図形セットと配置</h2><p className="rd-sample">{SAMPLE_NOTICE}</p>{session.blocks.map((block, blockIndex) => <div className="rd-block" key={blockIndex}><h3>Round {block.plan.round}・条件 {block.plan.condition}・セット {block.plan.stimulusSet}</h3>{(['human','partner'] as const).map((side) => <div className="rd-layout-row" key={side}><h4>{side === 'human' ? '人間側配置' : '相手側配置'}</h4><div className="rd-stimuli">{block.layout[side].map((id) => <div className="rd-stimulus" key={id}><StimulusSvg stimulus={getStimulus(id)} size={76} label={`${id} ${SAMPLE_NOTICE}`} /><code>{id}</code></div>)}</div></div>)}</div>)}</section>
      <section><h2>進捗イベント</h2><p>現在のフェーズ: {PHASE_LABELS[session.phase] ?? session.phase} ・ ブロック: {session.blockIndex + 1}</p><label>イベント種別 <select aria-label="イベント種別で絞り込み" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">すべて</option>{EVENT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label><div className="rd-table-wrap"><table><thead><tr><th>seq</th><th>時刻</th><th>mono ms</th><th>type</th><th>block</th><th>condition</th><th>payload</th></tr></thead><tbody>{filteredEvents.map((e) => <tr key={e.seq}><td>{e.seq}</td><td>{new Date(e.at).toLocaleTimeString()}</td><td>{Math.round(e.mono)}</td><td>{e.type}</td><td>{e.blockIndex === null ? '—' : e.blockIndex + 1}</td><td>{e.condition ?? '—'}</td><td><code>{JSON.stringify(e.payload)}</code></td></tr>)}</tbody></table></div></section>
      <section><h2>モックAI応答</h2><p className="rd-muted">モック（画像理解なし・研究結果ではない）</p><ul>{session.events.filter((e) => e.type === 'message_received' || e.type === 'mock_diagnostic').map((e) => <li key={e.seq}><strong>{e.type}</strong> · block {e.blockIndex === null ? '—' : e.blockIndex + 1} · <code>{JSON.stringify(e.payload)}</code></li>)}</ul></section>
      <section><h2>提出記録</h2>{session.blocks.map((block, i) => <div key={i}><h3>Round {block.plan.round}</h3><div className="rd-table-wrap"><table><thead><tr><th>stimulus id</th><th>人間の名前</th><th>モック相手の名前</th></tr></thead><tbody>{block.layout.human.map((id) => <tr key={id}><th>{id}</th><td>{block.humanNames?.[id] ?? '未提出'}</td><td>{block.partnerNames?.[id] ?? '未提出'}</td></tr>)}</tbody></table></div></div>)}</section>
      <section><h2>評価プレビュー</h2>{session.blocks.map((block, i) => { const score = scoreBlock(block); return <div key={i}><h3>Round {block.plan.round}</h3>{score.complete ? <><div className="rd-table-wrap"><table><thead><tr><th>stimulus id</th><th>人間の名前</th><th>モック相手の名前</th><th>match</th></tr></thead><tbody>{score.pairs.map((pair) => <tr key={pair.stimulusId}><th>{pair.stimulusId}</th><td>{pair.humanName}</td><td>{pair.partnerName}</td><td>{pair.match ? '✓' : '–'}</td></tr>)}</tbody></table></div><p>一致 {score.matched} / 6（DEMO・モック相手との照合。実測データではない）</p></> : <p>未完了</p>}</div>; })}</section>
      <section><h2>アンケート</h2>{session.blocks.map((block, i) => <div key={i}><h3>Round {block.plan.round}</h3>{block.survey ? <dl className="rd-survey">{([['effort','effort'],['fluency','fluency'],['annoyance','annoyance'],['naturalness','naturalness'],['satisfaction','satisfaction']] as const).map(([key,label]) => <div key={key}><dt>{label}</dt><dd>{block.survey?.[key] ?? '欠損'}</dd></div>)}<div><dt>comment</dt><dd>{block.survey.comment || '欠損'}</dd></div></dl> : <p>未回答（欠損）</p>}</div>)}<h3>比較アンケート</h3>{session.comparison ? <dl className="rd-survey">{([['lessEffort','必要努力が少ない'],['easier','進めやすい'],['lessAnnoying','煩わしさが少ない']] as const).map(([key,label]) => <div key={key}><dt>{label}</dt><dd>{session.comparison?.[key] ?? '欠損'}</dd></div>)}<div><dt>comment</dt><dd>{session.comparison.comment || '欠損'}</dd></div></dl> : <p>未回答（欠損）</p>}</section>
      <section><h2>JSON</h2><button type="button" onClick={download}>JSONをダウンロード</button><label className="rd-field">エクスポートJSON<textarea aria-label="エクスポートJSON" readOnly value={exportText || (session ? exportSession(session) : '')} /></label><label className="rd-field">JSONファイルを読み込む<input type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(loadJson).catch((cause: unknown) => setError(String(cause))); }} /></label><label className="rd-field">インポートJSON<textarea aria-label="インポートJSON" value={importText} onChange={(event) => setImportText(event.target.value)} /></label><button type="button" onClick={() => loadJson(importText)}>貼り付けたJSONを読み込む</button>{error && <p role="alert">{error}</p>}</section>
      <section><h2>リセット</h2>{confirmReset ? <div><p>このセッションを消去しますか？</p><button type="button" onClick={() => { onReplace(null); setConfirmReset(false); }}>本当に消去する</button><button type="button" onClick={() => setConfirmReset(false)}>キャンセル</button></div> : <button type="button" onClick={() => setConfirmReset(true)}>セッションを消去</button>}</section>
    </>}
  </main>;
}
