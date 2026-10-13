import { useState } from 'react';
import type { HumanSnapshot } from '../../ai/protocol';
import { Dialog } from '../components/Dialog';
import { FigureArt } from '../components/Figure';
import { Scene } from '../components/Scene';
import type { RoomApi } from '../useRoom';

export function ResultsStage({ room, snapshot }: { room: RoomApi; snapshot: HumanSnapshot }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const results = snapshot.results;
  if (!results) return null;
  const figureBySlot = new Map(snapshot.figures.map((f) => [f.slot, f]));
  const myNames = Object.fromEntries(results.rows.map((row) => [row.slot, row.selfName]));
  return (
    <main className="page">
      <div className="page-head">
        <h1>結果</h1>
      </div>
      {results.scored ? (
        <>
          <p className="result-score">一致 {results.matched} / {results.total}</p>
          <table className="result-table">
            <caption>名前の対応</caption>
            <colgroup><col className="col-figure" /><col /><col /><col className="col-match" /></colgroup>
            <thead><tr><th scope="col"><span className="sr-only">図形</span></th><th scope="col">あなた</th><th scope="col">AI</th><th scope="col">一致</th></tr></thead>
            <tbody>
              {results.rows.map((row) => {
                const figure = figureBySlot.get(row.slot);
                return (
                  <tr key={row.slot}>
                    <td>{figure && <FigureArt polygons={figure.polygons} rotation={figure.placement.rotation} />}</td>
                    <td>{row.selfName}</td>
                    <td>{row.aiName}</td>
                    <td className={row.match ? 'match-yes' : 'match-no'}>{row.match ? '一致' : '不一致'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="disclaimer">動作確認用のDEMOです。外部AIエージェントの提出をそのまま照合しており、研究結果としては扱いません。</p>
        </>
      ) : (
        <>
          <p className="disclaimer">模擬AIは図形を見ていないため、一致は判定しません。このDEMOは命名操作と質問紙の確認用です。</p>
          <section className="result-scene" aria-label="あなたがつけた名前">
            <Scene figures={snapshot.figures} names={myNames} />
          </section>
        </>
      )}
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
