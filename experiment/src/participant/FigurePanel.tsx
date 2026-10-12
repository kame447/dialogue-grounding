import { useState } from 'react';
import type { Stimulus } from '../domain/types';
import { StimulusSvg } from '../stimuli/StimulusSvg';
import { Modal } from '../ui/Modal';

/**
 * The participant's own six figures. Slot numbers are local to this screen;
 * nothing here (ids, notes, partner layout) leaks researcher-only data.
 */
export function FigurePanel(props: {
  stimuli: Stimulus[];
  memos: string[];
  onMemo: (slot: number, text: string) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <section aria-labelledby="figs-title">
      <h2 id="figs-title" className="visually-hidden">
        あなたの図形
      </h2>
      <ul className="figure-grid">
        {props.stimuli.map((stimulus, slot) => (
          <li key={slot} className="figure-card" data-selected={selected === slot}>
            <button
              type="button"
              className="figure-select"
              aria-pressed={selected === slot}
              aria-label={`図形${slot + 1}を選択して強調`}
              onClick={() => setSelected(selected === slot ? null : slot)}
            >
              <StimulusSvg stimulus={stimulus} label={`図形${slot + 1}`} />
            </button>
            <div className="figure-meta">
              <span className="figure-label">図形{slot + 1}</span>
              <button type="button" className="btn btn-small" onClick={() => setZoom(slot)} aria-label={`図形${slot + 1}を拡大`}>
                拡大
              </button>
            </div>
            <div className="figure-memo">
              <label className="visually-hidden" htmlFor={`memo-${slot}`}>
                図形{slot + 1}のメモ（相手には送られません）
              </label>
              <input
                id={`memo-${slot}`}
                type="text"
                placeholder="メモ"
                maxLength={200}
                value={props.memos[slot] ?? ''}
                onChange={(e) => props.onMemo(slot, e.target.value)}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="slot-note">番号とメモはあなたの画面だけのものです。相手の画面では並び順が異なります。</p>
      <Modal open={zoom !== null} onClose={() => setZoom(null)} labelledBy="zoom-title" className="zoom">
        {zoom !== null ? (
          <>
            <h2 id="zoom-title">図形{zoom + 1}（拡大）</h2>
            <div className="zoom-figure">
              <StimulusSvg stimulus={props.stimuli[zoom]} label={`図形${zoom + 1}の拡大表示`} />
            </div>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setZoom(null)} autoFocus>
                閉じる
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </section>
  );
}
