import { useState } from 'react';
import type { HumanSnapshot } from '../../ai/protocol';
import { Dialog } from '../components/Dialog';
import { FigureArt } from '../components/Figure';
import type { RoomApi } from '../useRoom';

export function ResultsStage({ room, snapshot }: { room: RoomApi; snapshot: HumanSnapshot }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const results = snapshot.results;
  if (!results) return null;
  const ai = snapshot.mode === 'mock' ? '模擬AI' : 'AI';
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h2 style={{ fontSize: 'var(--text-xl)' }}>結果</h2>
          <p>同じ図形にあなたと{ai}が同じ名前をつけていれば一致です。</p>
        </div>
      </div>
      <div className="result-summary">
        <span className="result-score">一致 {results.matched} / {results.total}</span>
      </div>
      <table className="result-table">
        <caption>名前の対応</caption>
        <colgroup><col className="col-figure" /><col /><col /><col className="col-match" /></colgroup>
        <thead><tr><th scope="col">図形</th><th scope="col">あなた</th><th scope="col">{ai}</th><th scope="col">一致</th></tr></thead>
        <tbody>
          {results.rows.map((row, i) => (
            <tr key={i}>
              <td><FigureArt polygons={row.polygons} label={`図形${i + 1}`} /></td>
              <td>{row.selfName}</td>
              <td>{row.aiName}</td>
              <td className={row.match ? 'match-yes' : 'match-no'}>{row.match ? '一致' : '不一致'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="disclaimer">
        これは動作確認用のDEMOです。{snapshot.mode === 'mock'
          ? '模擬AIは図形を見ておらず、会話中の「図形N は…」という記述をサーバー側の対応表で写して提出しただけです。AIが形を認識したり、あなたと共通の理解を作ったりした結果ではありません。'
          : '外部AIエージェントの提出内容をそのまま照合しています。研究結果としては扱いません。'}
      </p>
      <div className="after-actions">
        <a className="btn btn-primary" href="#/">新しいデモを始める</a>
        <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>このデモのデータを削除</button>
      </div>
      <p className="note" style={{ marginTop: 12 }}>削除しない場合も、データは開始から30日で自動的に削除されます。</p>
      <Dialog open={confirmDelete} title="このデモのデータを削除しますか？" onClose={() => setConfirmDelete(false)}>
        <p>会話・名前・回答をサーバーから削除します。元に戻せません。</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirmDelete(false)}>キャンセル</button>
          <button className="btn btn-solid-danger" disabled={room.busy} onClick={() => { room.deleteRoom(); setConfirmDelete(false); }}>削除する</button>
        </div>
      </Dialog>
    </main>
  );
}
