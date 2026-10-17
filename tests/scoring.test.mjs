import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, scoreTrial } from '../dialogue-model/runtime/scoring.mjs';
import { SLOTS } from '../dialogue-model/runtime/stimuli/board.mjs';

const ids = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
const key = {
  human: Object.fromEntries(SLOTS.map((slot, i) => [slot, ids[i]])),
  ai: Object.fromEntries(SLOTS.map((slot, i) => [slot, ids[(i + 2) % 6]])),
};
const names = ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'];
function submissions() {
  return Object.fromEntries(['human', 'ai'].map(side => [side + 'Submission', Object.fromEntries(SLOTS.map(slot => [slot, names[ids.indexOf(key[side][slot])]]))]));
}

test('scores final names by figure rather than displayed position', () => {
  const result = scoreTrial({ key, ...submissions() });
  assert.equal(result.provisional, true);
  assert.equal(result.success, true);
  assert.equal(result.matchedCount, 6);
  assert.equal(result.total, 6);
  assert.deepEqual(result.duplicateNames, { human: [], ai: [] });
  assert.deepEqual(result.unnamed, { human: [], ai: [] });
  assert.ok(result.figures.every(f => f.matched && f.human.slot !== f.ai.slot));
});

test('reports partial agreement, including misplaced final names', () => {
  const submitted = submissions();
  [submitted.aiSubmission[SLOTS[0]], submitted.aiSubmission[SLOTS[1]]] = [submitted.aiSubmission[SLOTS[1]], submitted.aiSubmission[SLOTS[0]]];
  const result = scoreTrial({ key, ...submitted });
  assert.equal(result.success, false);
  assert.equal(result.matchedCount, 4);
  assert.deepEqual(result.figures.filter(f => !f.matched).map(f => f.figureId), ['F3', 'F4']);
});

test('matching duplicate names do not constitute task success', () => {
  const submitted = submissions();
  for (const side of ['human', 'ai']) for (const slot of SLOTS) submitted[side + 'Submission'][slot] = '同じ';
  const result = scoreTrial({ key, ...submitted });
  assert.equal(result.matchedCount, 6);
  assert.equal(result.success, false);
  for (const side of ['human', 'ai']) {
    assert.equal(result.duplicateNames[side].length, 1);
    assert.equal(result.duplicateNames[side][0].name, '同じ');
    assert.equal(result.duplicateNames[side][0].figureIds.length, 6);
  }
});

test('one-sided duplicate names are reported after normalization', () => {
  const submitted = submissions();
  submitted.aiSubmission[SLOTS[0]] = ' ア ';
  const result = scoreTrial({ key, ...submitted });
  assert.equal(result.success, false);
  assert.equal(result.matchedCount, 5);
  assert.equal(result.duplicateNames.ai[0].name, 'あ');
  assert.deepEqual(result.duplicateNames.human, []);
});

test('missing, empty and whitespace-only names remain unnamed even on both sides', () => {
  const submitted = submissions();
  delete submitted.humanSubmission[SLOTS[0]];
  submitted.aiSubmission[SLOTS[4]] = '　 \t'; // F1
  submitted.humanSubmission[SLOTS[1]] = '';
  const result = scoreTrial({ key, ...submitted });
  assert.equal(result.matchedCount, 4);
  assert.equal(result.success, false);
  assert.equal(result.unnamed.human.length, 2);
  assert.equal(result.unnamed.ai.length, 1);
  assert.equal(scoreTrial({ key, humanSubmission: {}, aiSubmission: {} }).matchedCount, 0);
});

test('provisional normalization covers width, whitespace and kana without semantic matching', () => {
  assert.equal(normalizeName('　ﾍﾟﾝ ギン\n'), 'ぺんぎん');
  assert.equal(normalizeName(' ｶﾞ　Ａ １\t'), 'がA1');
  assert.equal(normalizeName('ヴァイオリン'), 'ゔぁいおりん');
  assert.notEqual(normalizeName('鳥'), normalizeName('とり'));
  assert.notEqual(normalizeName('ABC'), normalizeName('abc'));
  const submitted = submissions();
  submitted.humanSubmission[SLOTS[0]] = ' ﾍﾟﾝ ギン ';
  submitted.aiSubmission[SLOTS[4]] = 'ぺんぎん';
  assert.equal(scoreTrial({ key, ...submitted }).success, true);
});

test('rejects malformed keys and submissions', () => {
  assert.throws(() => normalizeName(null), TypeError);
  const submitted = submissions();
  assert.throws(() => scoreTrial({ key: { ...key, ai: {} }, ...submitted }), TypeError);
  assert.throws(() => scoreTrial({ key: { ...key, ai: { ...key.ai, [SLOTS[0]]: 'F6' } }, ...submitted }), TypeError);
  assert.throws(() => scoreTrial({ key: { ...key, ai: { ...key.ai, [SLOTS[0]]: 'other' } }, ...submitted }), TypeError);
  assert.throws(() => scoreTrial({ key, ...submitted, humanSubmission: { ...submitted.humanSubmission, x: '秘密' } }), TypeError);
  assert.throws(() => scoreTrial({ key, ...submitted, aiSubmission: { [SLOTS[0]]: 1 } }), TypeError);
  const before = structuredClone({ key, ...submitted });
  scoreTrial({ key, ...submitted });
  assert.deepEqual({ key, ...submitted }, before);
});
