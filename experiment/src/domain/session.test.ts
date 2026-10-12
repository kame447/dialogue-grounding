import { describe, expect, it } from 'vitest';
import { SEQUENCES, SEQUENCE_IDS, isValidAssignment, sequenceForIndex } from './assignment';
import { validateNames } from './names';
import { scoreBlock } from './scoring';
import { createSession, reduce, type Action, type Clock } from './session';
import { exportSession, importSession } from './storage';
import type { BlockSurvey, SessionState } from './types';

function fakeClock(): Clock {
  let t = 0;
  return { now: () => ({ at: new Date(Date.UTC(2026, 9, 13, 0, 0, 0, t)).toISOString(), mono: (t += 10) }) };
}

const survey: BlockSurvey = { effort: 5, fluency: 4, annoyance: 2, naturalness: null, satisfaction: null, comment: '' };
const names = ['ねこ', 'ふね', 'とり', 'いえ', 'ひと', 'き'];

function run(state: SessionState, clock: Clock, ...actions: Action[]) {
  return actions.reduce((s, a) => reduce(s, a, clock), state);
}

function partnerNames(s: SessionState, bi: 0 | 1) {
  return Object.fromEntries(s.blocks[bi].layout.partner.map((id, i) => [id, `相手${i}`]));
}

function complete(sequenceId: 'S1' | 'S2' | 'S3' | 'S4' = 'S1') {
  const clock = fakeClock();
  let s = createSession({ sessionId: 't', sequenceId, seed: 42, clock });
  s = run(s, clock, { type: 'ADVANCE_FROM_WELCOME' }, { type: 'ACK_CONSENT' }, { type: 'BEGIN_BLOCK' });
  for (const bi of [0, 1] as const) {
    if (bi === 1) s = run(s, clock, { type: 'BEGIN_BLOCK' });
    s = run(
      s,
      clock,
      { type: 'COMPOSING', active: true },
      { type: 'SEND_MESSAGE', id: `m${bi}`, text: 'こんにちは' },
      { type: 'PARTNER_REPLY', id: `p${bi}`, text: 'はい', diagnostics: { mock: true }, waitMs: 5 },
      { type: 'END_NAMING' },
      { type: 'PARTNER_NAMES', blockIndex: bi, names: partnerNames(s, bi), diagnostics: { mock: true } },
      { type: 'LOCK_NAMES', namesBySlot: names },
      { type: 'SUBMIT_SURVEY', survey },
    );
  }
  s = run(s, clock, { type: 'SUBMIT_COMPARISON', comparison: { lessEffort: 'round1', easier: null, lessAnnoying: 'same', comment: '' } }, { type: 'FINISH' });
  return s;
}

describe('counterbalancing', () => {
  it('has four sequences crossing AB/BA with alpha/beta order, never reusing a set', () => {
    const combos = new Set(SEQUENCE_IDS.map((id) => SEQUENCES[id].blocks.map((b) => b.condition + b.stimulusSet).join('|')));
    expect(combos.size).toBe(4);
    for (const id of SEQUENCE_IDS) expect(isValidAssignment(SEQUENCES[id])).toBe(true);
    const orders = SEQUENCE_IDS.map((id) => SEQUENCES[id].blocks.map((b) => b.condition).join(''));
    expect(orders.filter((o) => o === 'AB')).toHaveLength(2);
    expect(orders.filter((o) => o === 'BA')).toHaveLength(2);
    const firstSets = SEQUENCE_IDS.map((id) => SEQUENCES[id].blocks[0].stimulusSet);
    expect(firstSets.filter((x) => x === 'alpha')).toHaveLength(2);
  });

  it('assigns round-robin and balances any multiple of four', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 40; i++) counts[sequenceForIndex(i)] = (counts[sequenceForIndex(i)] ?? 0) + 1;
    expect(Object.values(counts)).toEqual([10, 10, 10, 10]);
  });

  it('builds blocks from the assigned sets with differing human/partner layouts', () => {
    const s = createSession({ sessionId: 'x', sequenceId: 'S4', seed: 7, clock: fakeClock() });
    expect(s.blocks.map((b) => b.plan.stimulusSet)).toEqual(['beta', 'alpha']);
    for (const b of s.blocks) {
      expect(new Set(b.layout.human).size).toBe(6);
      expect([...b.layout.partner].sort()).toEqual([...b.layout.human].sort());
      b.layout.human.forEach((id, i) => expect(b.layout.partner[i]).not.toBe(id));
      expect(b.layout.human.every((id) => id.startsWith(b.plan.stimulusSet))).toBe(true);
    }
  });
});

describe('state machine', () => {
  it('cannot leave chat without END_NAMING and rejects out-of-order actions', () => {
    const clock = fakeClock();
    let s = createSession({ sessionId: 't', sequenceId: 'S1', seed: 1, clock });
    s = run(s, clock, { type: 'BEGIN_BLOCK' });
    expect(s.phase).toBe('welcome');
    s = run(s, clock, { type: 'ADVANCE_FROM_WELCOME' }, { type: 'ACK_CONSENT' }, { type: 'BEGIN_BLOCK' });
    expect(s.phase).toBe('chat');
    s = run(s, clock, { type: 'LOCK_NAMES', namesBySlot: names }, { type: 'SUBMIT_SURVEY', survey });
    expect(s.phase).toBe('chat');
    expect(s.events.filter((e) => e.type === 'transition_rejected')).toHaveLength(3);
  });

  it('blocks duplicate sends and ending while the partner is replying', () => {
    const clock = fakeClock();
    let s = createSession({ sessionId: 't', sequenceId: 'S1', seed: 1, clock });
    s = run(s, clock, { type: 'ADVANCE_FROM_WELCOME' }, { type: 'ACK_CONSENT' }, { type: 'BEGIN_BLOCK' });
    s = run(s, clock, { type: 'SEND_MESSAGE', id: 'a', text: 'x' }, { type: 'SEND_MESSAGE', id: 'b', text: 'y' }, { type: 'END_NAMING' });
    expect(s.blocks[0].messages).toHaveLength(1);
    expect(s.phase).toBe('chat');
    s = run(s, clock, { type: 'PARTNER_FAILED', error: 'boom', waitMs: 1 }, { type: 'RETRY_PARTNER' });
    expect(s.awaitingPartner).toBe(true);
    s = run(s, clock, { type: 'PARTNER_REPLY', id: 'p', text: 'ok', diagnostics: { mock: true }, waitMs: 1 }, { type: 'SEND_MESSAGE', id: 'a', text: 'again' });
    expect(s.blocks[0].messages.map((m) => m.id)).toEqual(['a', 'p']);
  });

  it('rejects empty or duplicate names before locking and freezes them afterwards', () => {
    const clock = fakeClock();
    let s = createSession({ sessionId: 't', sequenceId: 'S1', seed: 1, clock });
    s = run(s, clock, { type: 'ADVANCE_FROM_WELCOME' }, { type: 'ACK_CONSENT' }, { type: 'BEGIN_BLOCK' }, { type: 'END_NAMING' });
    s = run(s, clock, { type: 'LOCK_NAMES', namesBySlot: ['a', 'b', '', 'd', 'e', 'f'] }, { type: 'LOCK_NAMES', namesBySlot: ['ねこ', ' ねこ ', 'c', 'd', 'e', 'f'] });
    expect(s.phase).toBe('naming');
    s = run(s, clock, { type: 'LOCK_NAMES', namesBySlot: names });
    expect(s.phase).toBe('survey');
    const locked = s.blocks[0].humanNames;
    s = run(s, clock, { type: 'LOCK_NAMES', namesBySlot: ['1', '2', '3', '4', '5', '6'] });
    expect(s.blocks[0].humanNames).toEqual(locked);
  });

  it('validates names with NFKC/space/case normalisation', () => {
    expect(validateNames(['ＡＢ', 'ab', 'c', 'd', 'e', 'f']).ok).toBe(false);
    expect(validateNames(['a b', 'a  b', 'c', 'd', 'e', 'f']).ok).toBe(false);
    expect(validateNames(names).ok).toBe(true);
  });

  it('rejects out-of-range survey values but records missing optional ones', () => {
    const clock = fakeClock();
    let s = createSession({ sessionId: 't', sequenceId: 'S1', seed: 1, clock });
    s = run(s, clock, { type: 'ADVANCE_FROM_WELCOME' }, { type: 'ACK_CONSENT' }, { type: 'BEGIN_BLOCK' }, { type: 'END_NAMING' }, { type: 'LOCK_NAMES', namesBySlot: names });
    s = run(s, clock, { type: 'SUBMIT_SURVEY', survey: { ...survey, effort: 10 } }, { type: 'SUBMIT_SURVEY', survey: { ...survey, fluency: 0 } }, { type: 'SUBMIT_SURVEY', survey: { ...survey, annoyance: 8 } });
    expect(s.phase).toBe('survey');
    s = run(s, clock, { type: 'SUBMIT_SURVEY', survey: { ...survey, effort: 9, fluency: 7, annoyance: 1 } });
    expect(s.phase).toBe('interblock');
    const ev = s.events.find((e) => e.type === 'survey_submitted')!;
    expect(ev.payload.missing).toEqual(['naturalness', 'satisfaction']);
  });

  it('records the full ordered event stream: surveys before results, comparison after both surveys', () => {
    const s = complete('S2');
    expect(s.phase).toBe('done');
    const types = s.events.map((e) => e.type);
    expect(types).not.toContain('transition_rejected');
    const idx = (t: string, n = 0) => types.reduce<number[]>((acc, x, i) => (x === t ? [...acc, i] : acc), [])[n];
    const order = [
      idx('session_started'), idx('consent_acknowledged'), idx('block_started', 0), idx('composing_started', 0), idx('message_sent', 0), idx('partner_request_started', 0),
      idx('partner_request_finished', 0), idx('message_received', 0), idx('naming_end_requested', 0), idx('names_locked', 0), idx('survey_submitted', 0),
      idx('block_started', 1), idx('names_locked', 1), idx('survey_submitted', 1), idx('comparison_submitted'), idx('results_viewed'),
    ];
    expect(order.every((v) => v !== undefined)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    s.events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
      expect(typeof e.mono).toBe('number');
    });
    // Condition is attached to block events for analysis only.
    expect(s.events.filter((e) => e.type === 'names_locked').map((e) => e.condition)).toEqual(['B', 'A']);
    expect(s.events.find((e) => e.type === 'comparison_submitted')!.payload.missing).toEqual(['easier']);
  });

  it('turns an in-flight partner request into a retryable failure after reload', () => {
    const clock = fakeClock();
    let s = createSession({ sessionId: 't', sequenceId: 'S1', seed: 1, clock });
    s = run(s, clock, { type: 'ADVANCE_FROM_WELCOME' }, { type: 'ACK_CONSENT' }, { type: 'BEGIN_BLOCK' }, { type: 'SEND_MESSAGE', id: 'a', text: 'x' });
    const restored = reduce(importSession(exportSession(s)), { type: 'RESTORED' }, clock);
    expect(restored.awaitingPartner).toBe(false);
    expect(restored.events.at(-1)!.type).toBe('partner_request_failed');
  });
});

describe('scoring', () => {
  it('compares the two independent submissions per stimulus id', () => {
    const s = complete();
    const block = { ...s.blocks[0], partnerNames: { ...s.blocks[0].humanNames! } };
    expect(scoreBlock(block).matched).toBe(6);
    expect(scoreBlock(s.blocks[0]).matched).toBe(0);
    expect(scoreBlock({ ...s.blocks[0], partnerNames: null }).complete).toBe(false);
  });
});

describe('storage', () => {
  it('rejects foreign JSON', () => {
    expect(() => importSession('{"a":1}')).toThrow();
    expect(() => importSession('nope')).toThrow();
  });
});
