import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { createSession } from '../domain/session';
import type { SessionState } from '../domain/types';
import { ResearcherDemo } from './ResearcherDemo';

function makeSession(): SessionState {
  return createSession({ sessionId: 'test-demo', sequenceId: 'S2', seed: 1, clock: { now: () => ({ at: '2026-10-13T00:00:00.000Z', mono: 12.4 }) } });
}

describe('ResearcherDemo', () => {
  afterEach(() => cleanup());
  it('renders the empty state and new session form', () => {
    render(<ResearcherDemo session={null} onReplace={vi.fn()} />);
    expect(screen.getByText('セッションがありません')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'この系列で新規デモセッション' })).toBeTruthy();
  });

  it('renders sequence table, conditions and a created session', () => {
    render(<ResearcherDemo session={makeSession()} onReplace={vi.fn()} />);
    for (const id of ['S1','S2','S3','S4']) expect(screen.getAllByText(id, { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/A|B/).length).toBeGreaterThan(0);
    expect(screen.getByText(/現在のフェーズ/)).toBeTruthy();
  });

  it('shows an alert for invalid pasted JSON', () => {
    render(<ResearcherDemo session={makeSession()} onReplace={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'インポートJSON' }), { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: '貼り付けたJSONを読み込む' }));
    expect(screen.getByRole('alert').textContent).toContain('JSON');
  });

  it('requires two clicks to reset', () => {
    const onReplace = vi.fn();
    render(<ResearcherDemo session={makeSession()} onReplace={onReplace} />);
    fireEvent.click(screen.getByRole('button', { name: 'セッションを消去' }));
    expect(onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '本当に消去する' }));
    expect(onReplace).toHaveBeenCalledWith(null);
  });

  it('creates a session using the selected sequence', () => {
    const onReplace = vi.fn();
    render(<ResearcherDemo session={null} onReplace={onReplace} />);
    fireEvent.change(screen.getByLabelText('新規セッションの系列'), { target: { value: 'S4' } });
    fireEvent.click(screen.getByRole('button', { name: 'この系列で新規デモセッション' }));
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace.mock.calls[0][0].assignment.sequenceId).toBe('S4');
  });
});
