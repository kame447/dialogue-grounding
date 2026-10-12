import { useMemo, useRef, useState } from 'react';
import { MAX_NAME_LENGTH, validateNames } from '../domain/names';
import type { Stimulus } from '../domain/types';
import { StimulusSvg } from '../stimuli/StimulusSvg';
import { Modal } from '../ui/Modal';

/**
 * Independent final naming. No hints about the partner's answers or the
 * scoring ids are shown; validation only checks emptiness and duplicates.
 */
export function NamingScreen(props: { round: 1 | 2; stimuli: Stimulus[]; initialNames: string[]; onLock: (namesBySlot: string[]) => void }) {
  const [names, setNames] = useState<string[]>(() => props.stimuli.map((_, i) => props.initialNames[i] ?? ''));
  const [showErrors, setShowErrors] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [locking, setLocking] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const validation = useMemo(() => validateNames(names), [names]);

  const tryConfirm = () => {
    setShowErrors(true);
    if (!validation.ok) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setConfirming(true);
  };

  const errorCount = Object.keys(validation.errors).length;

  return (
    <section aria-labelledby="naming-title">
      <div className="panel">
        <h1 id="naming-title">ラウンド {props.round} / 2：図形の名前を提出</h1>
        <p>
          会話をふまえて、6個の図形それぞれに名前を入力してください。相手も同時に、あなたとは独立して名前を提出します。
          <strong>6個すべて異なる名前</strong>にしてください。確定後は変更できません。
        </p>
        {showErrors && !validation.ok ? (
          <div className="alert" role="alert" tabIndex={-1} ref={summaryRef}>
            {errorCount}か所に問題があります。未入力や重複している名前を直してください。
          </div>
        ) : null}
      </div>
      <form
        className="panel"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          tryConfirm();
        }}
      >
        <ul className="naming-grid">
          {props.stimuli.map((stimulus, slot) => {
            const err = showErrors ? validation.errors[slot] : undefined;
            return (
              <li key={slot} className="naming-item">
                <div className="figure-view">
                  <StimulusSvg stimulus={stimulus} label={`図形${slot + 1}`} />
                </div>
                <label htmlFor={`name-${slot}`}>図形{slot + 1}の名前</label>
                <input
                  id={`name-${slot}`}
                  type="text"
                  autoComplete="off"
                  maxLength={MAX_NAME_LENGTH + 10}
                  value={names[slot]}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `name-err-${slot}` : undefined}
                  onChange={(e) => setNames((prev) => prev.map((n, i) => (i === slot ? e.target.value : n)))}
                />
                {err ? (
                  <p className="field-error" id={`name-err-${slot}`}>
                    {err}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="actions">
          <button type="submit" className="btn btn-primary">
            名前を確定する
          </button>
        </div>
      </form>
      <Modal open={confirming} onClose={() => setConfirming(false)} labelledBy="lock-title">
        <h2 id="lock-title">この6個の名前で確定しますか？</h2>
        <ul className="plain">
          {names.map((n, i) => (
            <li key={i}>
              図形{i + 1}：{n.trim()}
            </li>
          ))}
        </ul>
        <p className="muted small">確定後は変更できません。</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setConfirming(false)} autoFocus>
            修正する
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={locking}
            onClick={() => {
              setLocking(true);
              props.onLock(names);
            }}
          >
            確定する
          </button>
        </div>
      </Modal>
    </section>
  );
}
