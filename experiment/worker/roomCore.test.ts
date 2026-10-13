// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LIVE_LIMITS, isRoomId, isToken, type ClientMessage, type LiveRole } from '../src/live/protocol';
import { createRoomState, handle, isExpired, join, snapshotFor, type RoomState } from './roomCore';

function room(seed = 123): RoomState { let slot = 0; return createRoomState({ roomId: 'a'.repeat(32), tokenHashes: { p1: 'hash-one', p2: 'hash-two' }, setId: 'alpha', seed, now: 1000, randomSlot: () => `slot-${++slot}` }); }
const connected = { p1: true, p2: true };
function act(s: RoomState, seat: LiveRole, msg: ClientMessage, now = 2000) { return handle(s, seat, msg, now, connected); }
function helloBoth(s: RoomState) { join(s, 'p1'); join(s, 'p2'); }
function namesFor(s: RoomState, seat: LiveRole, vals = ['Bird', 'Cat', 'Dog', 'Fish', 'Tree', 'Moon']) { return Object.fromEntries(Object.keys(s.slots[seat]).map((k, i) => [k, vals[i]])); }
function progressToSurvey(s: RoomState, seat: LiveRole) { act(s, seat, { type: 'end_chat' }); act(s, seat, { type: 'submit_names', names: namesFor(s, seat) }); }
const survey = { effort: 5, fluency: 4, annoyance: 2, comment: '' };

describe('room core', () => {
  it('gives seats different orders of the same six polygons and keeps private identifiers out of snapshots', () => {
    const s = room();
    expect(s.orders.p1).not.toEqual(s.orders.p2);
    expect([...s.orders.p1].sort()).toEqual([...s.orders.p2].sort());
    for (const seat of ['p1', 'p2'] as const) {
      const json = JSON.stringify(snapshotFor(s, seat, { p1: false, p2: false }));
      expect(json).not.toMatch(/alpha-|beta-|hash-one|hash-two|Cat|Bird/);
      expect(json).not.toContain(s.orders[seat][0]);
    }
  });
  it('joins both seats into chat and delivers chat with an ack only to sender', () => {
    const s = room(); helloBoth(s);
    expect(s.phases.p1).toBe('chat'); expect(s.phases.p2).toBe('chat');
    const out = act(s, 'p1', { type: 'chat', clientId: 'c1', text: ' hi ' }).out;
    expect(out).toEqual([{ to: 'p1', msg: expect.objectContaining({ type: 'chat', clientId: 'c1' }) }, { to: 'p2', msg: expect.objectContaining({ type: 'chat', message: expect.objectContaining({ from: 'peer', text: 'hi' }) }) }]);
  });
  it('rejects empty, long, rate limited and room full chat', () => {
    const s = room(); helloBoth(s);
    expect(act(s, 'p1', { type: 'chat', clientId: 'e', text: '  ' }).out[0].msg).toMatchObject({ code: 'bad_request' });
    expect(act(s, 'p1', { type: 'chat', clientId: 'l', text: 'x'.repeat(LIVE_LIMITS.maxMessageChars + 1) }).out[0].msg).toMatchObject({ code: 'too_long' });
    for (let i = 0; i < LIVE_LIMITS.rateMessages; i++) act(s, 'p1', { type: 'chat', clientId: String(i), text: 'ok' }, 2000);
    expect(act(s, 'p1', { type: 'chat', clientId: 'rate', text: 'ok' }, 2001).out[0].msg).toMatchObject({ code: 'rate_limited' });
    const full = room(); helloBoth(full); full.messages = Array.from({ length: LIVE_LIMITS.maxMessagesPerRoom }, (_, i) => ({ id: String(i), from: 'self', text: 'x', at: 0, seat: 'p1' as const }));
    expect(act(full, 'p2', { type: 'chat', clientId: 'full', text: 'ok' }).out[0].msg).toMatchObject({ code: 'room_full' });
  });
  it('closes chat for both seats and never moves phases backwards', () => {
    const s = room(); helloBoth(s);
    expect(act(s, 'p1', { type: 'submit_names', names: namesFor(s, 'p1') }).out[0].msg).toMatchObject({ code: 'invalid_phase' });
    act(s, 'p1', { type: 'end_chat' });
    expect(act(s, 'p1', { type: 'chat', clientId: 'x', text: 'after' }).out[0].msg).toMatchObject({ code: 'chat_closed' });
    expect(act(s, 'p2', { type: 'chat', clientId: 'y', text: 'after' }).out[0].msg).toMatchObject({ code: 'chat_closed' });
    act(s, 'p1', { type: 'submit_names', names: namesFor(s, 'p1') });
    expect(s.phases.p1).toBe('survey');
    expect(act(s, 'p1', { type: 'submit_names', names: namesFor(s, 'p1') }).out[0].msg).toMatchObject({ code: 'invalid_phase' });
    expect(act(s, 'p1', { type: 'submit_survey', survey }).state.phases.p1).toBe('waiting_results');
  });
  it('rejects duplicate, empty, and foreign-slot names', () => {
    const s = room(); helloBoth(s); act(s, 'p1', { type: 'end_chat' });
    const duplicate = namesFor(s, 'p1'); duplicate[Object.keys(duplicate)[1]] = duplicate[Object.keys(duplicate)[0]];
    expect(act(s, 'p1', { type: 'submit_names', names: duplicate }).out[0].msg).toMatchObject({ code: 'invalid_names' });
    const empty = namesFor(s, 'p1'); empty[Object.keys(empty)[0]] = '';
    expect(act(s, 'p1', { type: 'submit_names', names: empty }).out[0].msg).toMatchObject({ code: 'invalid_names' });
    const foreign = { ...namesFor(s, 'p1'), foreign: 'Other' }; delete foreign[Object.keys(foreign)[0]];
    expect(act(s, 'p1', { type: 'submit_names', names: foreign }).out[0].msg).toMatchObject({ code: 'invalid_names' });
  });
  it('withholds results until both surveys and scores normalized matching names', () => {
    const s = room(); helloBoth(s); progressToSurvey(s, 'p1'); progressToSurvey(s, 'p2');
    act(s, 'p1', { type: 'submit_survey', survey });
    expect(s.phases.p1).toBe('waiting_results'); expect(snapshotFor(s, 'p1', connected).results).toBeNull();
    const p2Names = Object.fromEntries(Object.keys(s.slots.p2).map((slot) => [slot, s.slots.p2[slot] === s.orders.p1[0] ? 'Ｂｉｒｄ ' : `Other${s.orders.p2.indexOf(s.slots.p2[slot])}`]));
    s.names.p2 = p2Names;
    act(s, 'p2', { type: 'submit_survey', survey });
    expect(s.phases.p1).toBe('results'); expect(snapshotFor(s, 'p1', connected).results?.matched).toBe(1);
    expect(snapshotFor(s, 'p1', connected).results?.total).toBe(6);
  });
  it('expires only at or after expiresAt and generated ids follow protocol format', () => {
    const s = room(); expect(isExpired(s, s.expiresAt - 1)).toBe(false); expect(isExpired(s, s.expiresAt)).toBe(true);
    expect(isRoomId(s.roomId)).toBe(true); expect(isToken('a'.repeat(48))).toBe(true);
  });
});
