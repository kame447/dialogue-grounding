import type { ReactNode } from 'react';
import type { HumanPhase, RoomMode } from '../../ai/protocol';

export const STEPS = ['会話', '名前', 'アンケート', '結果'] as const;

export function stepIndex(phase: HumanPhase): number {
  switch (phase) {
    case 'waiting_ai':
    case 'chat':
      return 0;
    case 'naming':
      return 1;
    case 'survey':
    case 'waiting_ai_names':
      return 2;
    case 'results':
      return 3;
  }
}

export function Stepper({ current }: { current: number }) {
  return (
    <ol className="steps" aria-label="進行状況">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i === current ? 'step' : undefined} data-state={i < current ? 'done' : i === current ? 'current' : 'todo'}>
          <span className="step-num" aria-hidden="true">{i + 1}</span>
          <span className="step-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function AiChip({ mode, connected }: { mode: RoomMode; connected: boolean }) {
  if (mode === 'mock') {
    return <span className="chip" title="サーバー上の規則ベースの模擬応答です。AIモデルには接続していません。"><span className="dot" aria-hidden="true" /><span>模擬AI<span className="chip-long">（実モデル未接続）</span><span className="chip-short">・未接続</span></span></span>;
  }
  return (
    <span className="chip" title="別の端末から接続する外部AIエージェントです。">
      <span className={`dot ${connected ? 'dot-on' : ''}`} aria-hidden="true" />
      <span><span className="chip-ai-text">外部AIエージェント・</span>{connected ? '接続中' : '未接続'}</span>
    </span>
  );
}

export function TopBar({ center, end }: { center?: ReactNode; end?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="wordmark" href="#/">
        <span className="wordmark-text">図形の命名対話</span>
        <span className="chip chip-demo">DEMO</span>
      </a>
      <div className="topbar-center">{center}</div>
      <div className="topbar-end">{end}</div>
    </header>
  );
}

/** Mobile-only compact progress line ("1/4 会話"), with an optional action on the right. */
export function StepBar({ current, action }: { current: number; action?: ReactNode }) {
  return (
    <div className="stepbar">
      <span aria-hidden="true"><strong>{current + 1}/{STEPS.length}</strong>　{STEPS[current]}</span>
      {action}
    </div>
  );
}
