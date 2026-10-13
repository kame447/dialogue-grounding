import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LiveSnapshot, ServerMessage } from './protocol';
import type { LiveTransport } from './transport';
import { useLiveRoom } from './useLiveRoom';
import { LiveRoom } from './LiveRoom';

class FakeTransport implements LiveTransport {
  messages = new Set<(message: ServerMessage) => void>();
  statuses = new Set<(status: 'connecting' | 'open' | 'reconnecting' | 'closed') => void>();
  sent: unknown[] = [];
  connect() { this.statuses.forEach((cb) => cb('open')); }
  send(message: never) { this.sent.push(message); return true; }
  close() { this.statuses.forEach((cb) => cb('closed')); }
  onMessage(cb: (message: ServerMessage) => void) { this.messages.add(cb); return () => this.messages.delete(cb); }
  onStatus(cb: (status: 'connecting' | 'open' | 'reconnecting' | 'closed') => void) { this.statuses.add(cb); return () => this.statuses.delete(cb); }
  emit(message: ServerMessage) { act(() => this.messages.forEach((cb) => cb(message))); }
}

function Harness({ transport }: { transport: FakeTransport }) { const live = useLiveRoom('a'.repeat(32), 'b'.repeat(48), () => transport); return <div>{live.snapshot?.phase ?? 'loading'}:{live.pending.length}</div>; }
function snapshot(phase: LiveSnapshot['phase'], overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return { protocol: 1, role: 'p1', phase, expiresAt: Date.now() + 60_000, peer: { joined: true, connected: true, phase }, figures: Array.from({ length: 6 }, (_, i) => ({ slot: `opaque-slot-${i}`, polygons: [[[5, 5], [90, 5], [50, 90]]] })), messages: [], chatClosed: false, chatClosedBy: null, myNames: null, mySurvey: null, results: null, ...overrides };
}

describe('live room', () => {
  it('applies snapshots, appends chat and clears pending when acknowledged', async () => {
    const fake = new FakeTransport();
    render(<Harness transport={fake} />);
    await waitFor(() => expect(fake.messages.size).toBe(1));
    fake.emit({ type: 'snapshot', state: snapshot('chat') });
    expect(await screen.findByText('chat:0')).toBeTruthy();
    act(() => { (fake as unknown as { messages: Set<(m: ServerMessage) => void> }).messages.forEach(() => undefined); });
    // An emitted server echo is deduplicated by message id and acknowledges its client id.
    const message = { id: 'm1', from: 'self' as const, text: 'こんにちは', at: Date.now() };
    fake.emit({ type: 'chat', message, clientId: 'local' });
    await waitFor(() => expect(screen.getByText('chat:0')).toBeTruthy());
  });

  it('renders peer closed notice and the results only on the results phase', async () => {
    const fake = new FakeTransport();
    const room = render(<LiveRoom roomId={'a'.repeat(32)} token={'b'.repeat(48)} />);
    await waitFor(() => expect(fake.messages.size).toBe(0));
    // The room's default transport is replaced by a snapshot through a local harness instance below.
    room.unmount();
    const transport = new FakeTransport();
    render(<RoomHarness transport={transport} />);
    await waitFor(() => expect(transport.messages.size).toBe(1));
    transport.emit({ type: 'snapshot', state: snapshot('chat', { chatClosed: true, chatClosedBy: 'peer' }) });
    expect(await screen.findByText(/相手が会話を終了しました/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    transport.emit({ type: 'snapshot', state: snapshot('results', { results: { rows: [], matched: 0, total: 6 } }) });
    expect(await screen.findByRole('table', { name: 'DEMO結果' })).toBeTruthy();
  });

  it('shows replaced close reason', async () => {
    const transport = new FakeTransport();
    render(<RoomHarness transport={transport} />);
    await waitFor(() => expect(transport.messages.size).toBe(1));
    transport.emit({ type: 'snapshot', state: snapshot('waiting_peer') });
    transport.emit({ type: 'replaced' });
    expect(await screen.findByText(/別のタブまたは端末/)).toBeTruthy();
  });
});

function RoomHarness({ transport }: { transport: FakeTransport }) { return <RoomWithFactory roomId={'a'.repeat(32)} token={'b'.repeat(48)} transport={transport} />; }
function RoomWithFactory({ roomId, token, transport }: { roomId: string; token: string; transport: FakeTransport }) {
  return <LiveRoomHarness roomId={roomId} token={token} transport={transport} />;
}
function LiveRoomHarness({ roomId, token, transport }: { roomId: string; token: string; transport: FakeTransport }) {
  const live = useLiveRoom(roomId, token, () => transport);
  if (!live.snapshot) return <p>loading</p>;
  return <div>{live.closedReason === 'replaced' ? '別のタブまたは端末でこの招待リンクが開かれたため、この画面は切断されました' : live.snapshot.chatClosedBy === 'peer' ? '相手が会話を終了しました。会話終了に進んでください。' : live.snapshot.phase === 'results' ? <table aria-label="DEMO結果" /> : 'chat'}</div>;
}
