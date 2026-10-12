import { scoreBlock } from '../domain/scoring';
import type { SessionState } from '../domain/types';
import { getStimulus } from '../stimuli/sets';
import { StimulusSvg } from '../stimuli/StimulusSvg';

/**
 * Shown only after both block surveys and the comparison. Pairs are listed in
 * the participant's own slot order; stimulus ids are not rendered.
 */
export function ResultsScreen(props: { session: SessionState; onFinish: () => void }) {
  return (
    <section className="narrow" aria-labelledby="res-title">
      <div className="panel">
        <h1 id="res-title">結果（DEMO）</h1>
        <p className="callout">
          相手は画像を理解しない簡易モックです。ここでの一致・不一致は動作確認用の表示であり、研究上の成績ではありません。
        </p>
      </div>
      {props.session.blocks.map((block, bi) => {
        const score = scoreBlock(block);
        return (
          <div className="panel" key={bi}>
            <h2>ラウンド{bi + 1}</h2>
            {!score.complete ? (
              <p className="muted">相手の提出がまだ記録されていません。</p>
            ) : (
              <div className="table-wrap">
                <table className="plain">
                  <thead>
                    <tr>
                      <th scope="col">図形</th>
                      <th scope="col">あなたの名前</th>
                      <th scope="col">相手（モック）の名前</th>
                      <th scope="col">一致</th>
                    </tr>
                  </thead>
                  <tbody>
                    {score.pairs.map((p) => (
                      <tr key={p.humanSlot}>
                        <td>
                          <div className="mini-figure">
                            <StimulusSvg stimulus={getStimulus(p.stimulusId)} label={`図形${p.humanSlot + 1}`} size={44} />
                          </div>
                        </td>
                        <td>{p.humanName}</td>
                        <td>{p.partnerName}</td>
                        <td>{p.match ? '一致' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={props.onFinish}>
          終了する
        </button>
      </div>
    </section>
  );
}
