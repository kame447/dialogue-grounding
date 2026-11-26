// Synthetic only. A generation working note that leaks into the public utterance is a publication violation (two_stage_v3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findWorkingNoteLeaks, rewriteReasons } from '../dialogue-model/runtime/v2/generation-guard.ts';

test('an English working note or an alternative reply mixed into the utterance is a violation', () => {
  for (const text of [
    'そう見えるんですね。same? Need Japanese natural, ask "ここですか" But ask cross confirm. 2 sentences. Avoid confusing target.',
    'こちらは細長いです。Could state the shape directly. Good.',
  ]) assert.deepEqual(findWorkingNoteLeaks(text), ['working_note'], text);
});

test('short names and symbols, quoted words, and English words the partner used in public are not violations', () => {
  for (const text of ['Y字の形ですか？', 'V字とL字のどちらですか？', 'OKです。', '「same need natural」と呼ぶのはどうでしょう？', 'Tower Bridgeみたいですね。', 'そうですね。']) {
    assert.deepEqual(findWorkingNoteLeaks(text), [], text);
  }
  assert.deepEqual(findWorkingNoteLeaks('その Golden Gate Bridge のような形ですね。', ['Golden Gate Bridge みたいなやつです']), []);
  assert.deepEqual(findWorkingNoteLeaks('その Golden Gate Bridge のような形ですね。'), ['working_note'], 'a three-word English phrase nobody used in public');
});

test('the retry instruction names the violation only when it occurred', () => {
  assert.match(rewriteReasons(['working_note']), /英語の作業メモや複数の返答案/u);
  assert.equal(rewriteReasons(['orientation_leak']).includes('作業メモや複数の返答案'), false);
  assert.equal(rewriteReasons([]), '');
});

test('a list of alternative replies is a violation, an ordinary sentence with a number is not', () => {
  assert.deepEqual(findWorkingNoteLeaks('案1：輪に切れ目がある形ですか？\n案2：切れ目のある輪がついていますか？'), ['working_note']);
  assert.deepEqual(findWorkingNoteLeaks('「輪に切れ目がある形ですか？」\n「切れ目のある輪がついていますか？」'), ['working_note'], 'quoted whole replies, one per line');
  // Features listed for one question or explanation are one reply.
  for (const text of ['見えている特徴は二つです。\n・輪に小さな切れ目がある\n・輪に細い棒がついている\nこの二つがそろう形ですか？', '1. 輪がある\n2. 棒がある\nどちらも合っていますか？',
    '案が二つあります。', '1つ目の形に切れ目がありますか？', '案1の形でしょうか？']) assert.deepEqual(findWorkingNoteLeaks(text), [], text);
});
