import type { ReactNode } from 'react';
import type { Phase, SessionState } from '../domain/types';

const STEPS: { key: string; label: string }[] = [
  { key: 'intro', label: '説明' },
  { key: 'r1', label: 'ラウンド1' },
  { key: 'r2', label: 'ラウンド2' },
  { key: 'end', label: '比較・終了' },
];

function stepFor(phase: Phase, blockIndex: number): string {
  if (phase === 'welcome' || phase === 'consent' || phase === 'instructions') return 'intro';
  if (phase === 'interblock') return 'r2';
  if (phase === 'chat' || phase === 'naming' || phase === 'survey') return blockIndex === 0 ? 'r1' : 'r2';
  return 'end';
}

/** Participant-facing frame. Shows only round numbers; never condition labels. */
export function Shell(props: { session: SessionState | null; notice: string | null; children: ReactNode }) {
  const current = props.session ? stepFor(props.session.phase, props.session.blockIndex) : 'intro';
  return (
    <>
      <div className="demo-ribbon" role="note">
        <strong>DEMO</strong> 試作版です。AIには接続していません（相手は簡易モック）。実験本番には使用できません。
      </div>
      <header className="app-header">
        <div className="app-header-inner">
          <p className="app-title">図形の共同命名タスク</p>
          <nav aria-label="進行状況">
            <ol className="steps">
              {STEPS.map((s) => (
                <li key={s.key} aria-current={s.key === current ? 'step' : undefined}>
                  {s.label}
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </header>
      {props.notice ? (
        <div className="notice" role="status">
          {props.notice}
        </div>
      ) : null}
      <main className="app-main" id="main">
        {props.children}
      </main>
    </>
  );
}
