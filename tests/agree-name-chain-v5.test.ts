import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgreeNamesV3, chainedNameSource } from '../dialogue-model/runtime/v2/jev-turn.ts';

// Synthetic wording only. The candidate list does not depend on the strategy (repair-first / bypass-enabled differ only in the later intervention), so one list serves both.
const SLOTS = ['a', 'b'];
const NAME = 'ゆう';
const claim = (o: Record<string, unknown>) => ({ speaker: 'human', act: 'name_propose', aspect: 'name', name: NAME, targets: ['a'], respondsTo: null, turn: 0, quote: '', ...o }) as any;
const turns = (extra: Record<number, string> = {}) => [
  { turn: 2, speaker: 'human', text: `それ「${NAME}」でいい？` }, { turn: 3, speaker: 'ai', text: 'あなたの案ですね。' },
  { turn: 4, speaker: 'human', text: 'だからそれでいい？' }, { turn: 5, speaker: 'ai', text: '案として受け取りました。' },
  { turn: 6, speaker: 'human', text: '名前としてどうかって聞いてるの' }, { turn: 7, speaker: 'ai', text: 'そうでしたね。' },
  { turn: 8, speaker: 'human', text: 'いいかどうか教えて' }].map(t => (extra[t.turn] === undefined ? t : { ...t, text: extra[t.turn] })) as any;
const confirmed = (turnIndex: number, figureId = 'a') => ({ turnIndex, judgment: { action: 'confirm' }, jevTurn: { executed: { action: 'confirm', target: { kind: 'single', figureId } }, humanReferent: null } });
// The AI's focus moved to another figure once (turn 5) and came back (turn 7): the earlier requests are superseded, the newest one stands.
const JUDGMENTS = [confirmed(3), confirmed(5, 'b'), confirmed(7)];
const state = (over: Record<string, unknown> = {}) => ({
  ledger: Object.fromEntries(SLOTS.map(id => [id, { status: 'unassigned', name: null }])), judgments: JUDGMENTS, ...over }) as any;
const chain = [claim({ id: 'c2', sourceTurn: 2 }), claim({ id: 'c4', sourceTurn: 4, respondsTo: 'c2' }), claim({ id: 'c6', sourceTurn: 6, respondsTo: 'c4' }),
  claim({ id: 'c8', sourceTurn: 8, respondsTo: 'c6' }), claim({ id: 'ai3', speaker: 'ai', act: 'assert', aspect: 'contour', name: null, sourceTurn: 3 })];
const names = (claims: any[], turn: number, publicTurns: any[], v5: boolean, st = state()) =>
  buildAgreeNamesV3(claims.filter(c => c.sourceTurn <= turn), publicTurns.filter(t => t.turn <= turn), turn, SLOTS, { ...st, judgments: st.judgments.filter((j: any) => j.turnIndex < turn) }, null, true, new Set(), true, v5);

test('holistic_v5: the second and third name-less approval request still offer the name from its public source turn', () => {
  for (const turn of [4, 6, 8]) {
    const expected = [{ name: NAME, figureId: 'a', sourceTurn: 2 }];
    assert.deepEqual(names(chain, turn, turns(), true), expected, `turn ${turn}`);
  }
});

test('before holistic_v5 the candidate list is unchanged: only one respondsTo step is followed', () => {
  assert.deepEqual(names(chain, 4, turns(), false), [{ name: NAME, figureId: 'a', sourceTurn: 2 }]);
  for (const turn of [6, 8]) assert.deepEqual(names(chain, turn, turns(), false), [], `turn ${turn}`);
});

test('no agree candidate without a public name, without a bound target, or after a rejection', () => {
  // the name never appears in a public turn
  assert.deepEqual(names(chain, 8, turns({ 2: 'それでいい？' }), true), []);
  // the approval requests bind no figure and the AI shared none
  const unbound = chain.map(c => c.speaker === 'human' ? { ...c, targets: [] } : { ...c, targets: [] });
  assert.deepEqual(names(unbound, 8, turns(), true), []);
  // the partner rejects the name
  const rejected = [...chain.filter(c => c.sourceTurn < 8), claim({ id: 'r8', act: 'name_reject', sourceTurn: 8, respondsTo: 'c6', targets: ['a'] })];
  assert.deepEqual(names(rejected, 8, turns(), true), []);
  // another figure already holds the name
  const taken = state({ ledger: { a: { status: 'unassigned', name: null }, b: { status: 'agreed', name: NAME } } });
  assert.deepEqual(names(chain, 8, turns(), true, taken), []);
});

test('the source chain stops at a different name, a missing link and a cycle', () => {
  const pt = turns();
  const c4 = claim({ id: 'c4', sourceTurn: 4, respondsTo: 'c2' });
  assert.equal(chainedNameSource(c4, [claim({ id: 'c2', sourceTurn: 2, name: 'べつ' })], pt, NAME), undefined);
  assert.equal(chainedNameSource(c4, [], pt, NAME), undefined);
  const a = claim({ id: 'x', sourceTurn: 4, respondsTo: 'y' }), b = claim({ id: 'y', sourceTurn: 6, respondsTo: 'x' });
  assert.equal(chainedNameSource(a, [a, b], pt, NAME), undefined);
  assert.equal(chainedNameSource(claim({ id: 'c6', sourceTurn: 6, respondsTo: 'c4' }), [claim({ id: 'c2', sourceTurn: 2 }), c4], pt, NAME)?.turn, 2);
});
