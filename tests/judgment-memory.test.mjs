import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMemory, validateReferenceInterpretation } from '../dialogue-model/runtime/judgment/memory.mjs';
import { SAFE_JUDGMENT, validateJudgment } from '../dialogue-model/runtime/judgment/schema.mjs';
import { SLOTS } from '../dialogue-model/runtime/stimuli/board.mjs';
import { createReferenceGraph, applyReferenceUpdate, snapshotReferenceGraph } from '../dialogue-model/runtime/memory/reference-graph.mjs';

const slot = SLOTS[0];
const reference = (extra = {}) => ({ slots: [slot], epistemic: 'grounded', intent: 'name_acceptance',
  feature: null, nameAcceptance: { slot, name: '帆' }, deferSlot: null, revisitSlot: null, ...extra });
const publicTurn = (text, turn = 1) => [{ turn, speaker: 'human', text }];
const commit = (graph, turn, interpretation, publicTurns) => {
  const staged = prepareMemory(graph, turn, interpretation, publicTurns);
  return { ...staged, graph: applyReferenceUpdate(graph, staged.update, { publicTurns, generationSucceeded: true }) };
};

test('reference schema requires exactly seven typed interpretation fields and accepts no source data or old operations', () => {
  assert.deepEqual(validateReferenceInterpretation(reference()), reference());
  assert.equal(validateReferenceInterpretation(null), null);
  for (const key of Object.keys(reference())) {
    const missing = reference(); delete missing[key];
    assert.throws(() => validateReferenceInterpretation(missing), { code: 'invalid_reference' });
  }
  for (const value of [[], 1, 'x', reference({ quote: 'private' }), reference({ slots: [slot, slot] }),
    reference({ slots: [] }), reference({ epistemic: 'hypothesis', slots: [] }), reference({ epistemic: 'unresolved' }),
    reference({ intent: 'accept' }), reference({ feature: { slot, feature: '尖り', polarity: 'maybe' } }),
    reference({ nameAcceptance: { slot, name: 'x'.repeat(81) } }), reference({ deferSlot: 'R1C1' })]) {
    assert.throws(() => validateReferenceInterpretation(value), { code: 'invalid_reference' });
  }
  assert.throws(() => validateJudgment({ ...SAFE_JUDGMENT, memoryOps: [] }));
});

test('adapter supplies deterministic IDs and current human quote; replaces is the latest name operation', () => {
  let graph = createReferenceGraph();
  for (const [index, name] of ['帆', '扇'].entries()) {
    const turn = index + 1, text = name + 'にしましょう', publicTurns = publicTurn(text, turn);
    const result = commit(graph, turn, reference({ nameAcceptance: { slot, name } }), publicTurns);
    assert.equal(result.rejected, null);
    assert.equal(result.update.operations.length, 2);
    const [mention, naming] = result.update.operations;
    assert.equal(mention.id, `${turn}:human`);
    assert.equal(mention.sourceTurn, turn); assert.equal(mention.speaker, 'human');
    assert.equal(mention.quote, text); assert.ok(text.includes(mention.quote));
    assert.equal(naming.agreement, 'explicit');
    assert.equal(naming.replaces, index === 0 ? null : '1:name');
    graph = result.graph;
  }
  assert.equal(snapshotReferenceGraph(graph).ownSlots[slot].candidate.name, '扇');
});

test('unsupported name, feature or revisit drops only that operation and retains its human mention', () => {
  const fixtures = [
    [reference({ nameAcceptance: { slot, name: 'not present' } }), 'unsupported name'],
    [reference({ intent: 'feature_assertion', nameAcceptance: null, feature: { slot, feature: 'not present', polarity: 'confirmed' } }), 'unsupported feature'],
    [reference({ intent: 'refer', nameAcceptance: null, revisitSlot: slot }), 'not previously deferred'],
  ];
  for (const [interpretation, label] of fixtures) {
    const result = prepareMemory(createReferenceGraph(), 1, interpretation, publicTurn('この図形を相談しましょう'));
    assert.equal(result.update.operations.length, 1, label);
    assert.equal(result.update.operations[0].kind, 'mention');
    assert.match(result.rejected, /^memory_/, label);
  }
});

test('literal human features and defer/revisit form validated typed updates without inferred ledger changes', () => {
  const first = commit(createReferenceGraph(), 1, reference({ intent: 'feature_assertion', nameAcceptance: null,
    feature: { slot, feature: '尖りが二つ', polarity: 'confirmed' }, deferSlot: slot }), publicTurn('尖りが二つの形は保留しましょう'));
  assert.equal(first.rejected, null);
  assert.deepEqual(first.update.operations.map(op => op.kind), ['mention', 'feature', 'focus']);
  const second = commit(first.graph, 2, reference({ intent: 'refer', nameAcceptance: null, revisitSlot: slot }), publicTurn('保留した形に戻りましょう', 2));
  assert.equal(second.rejected, null);
  assert.equal(second.update.operations.at(-1).mode, 'revisit');
});

test('hypothetical name interpretation cannot create explicit agreement; unsupported intent keeps mention only', () => {
  const hypothesis = prepareMemory(createReferenceGraph(), 1, reference({ epistemic: 'hypothesis' }), publicTurn('帆でいいです'));
  assert.equal(hypothesis.update.operations[1].agreement, 'none');
  const featureAcceptance = prepareMemory(createReferenceGraph(), 1, reference({ intent: 'feature_acceptance' }), publicTurn('帆でいいです'));
  assert.deepEqual(featureAcceptance.update.operations.map(op => op.kind), ['mention']);
  assert.match(featureAcceptance.rejected, /unsupported_name/);
});

test('quote stays an original public substring at <=160 chars, including supported normalized literal spans', () => {
  const text = '前置き'.repeat(80) + 'トリでよいです';
  const result = prepareMemory(createReferenceGraph(), 1, reference({ nameAcceptance: { slot, name: 'とり' } }), publicTurn(text));
  const [mention, name] = result.update.operations;
  assert.ok(mention.quote.length <= 160); assert.ok(text.includes(mention.quote));
  assert.ok(mention.quote.includes('トリ')); assert.equal(name.name, 'トリ');
  assert.equal(result.rejected, null);
});

test('bare acknowledgments remain hypotheses and never commit a name even after a public AI proposal', () => {
  for (const text of ['はい', 'それ', 'じゃあそれで', 'ええ、そうです。']) {
    const publicTurns = [{ turn: 1, speaker: 'ai', text: '帆と呼びませんか' }, ...publicTurn(text, 2)];
    const staged = prepareMemory(createReferenceGraph(), 2, reference(), publicTurns);
    const human = staged.update.operations.find(op => op.kind === 'mention' && op.speaker === 'human');
    assert.equal(human.epistemic, 'hypothesis', text);
    assert.equal(staged.update.operations.some(op => op.kind === 'name'), false, text);
    assert.match(staged.rejected, /bare_acknowledgment/);
    assert.ok(publicTurns.some(t => t.turn === human.sourceTurn && t.speaker === human.speaker && t.text.includes(human.quote)));
  }
});

test('a non-bare public acceptance may cite a preceding public AI literal with implicit agreement only', () => {
  const publicTurns = [{ turn: 1, speaker: 'ai', text: 'この形は帆と呼びませんか' }, ...publicTurn('その呼び名でお願いします', 2)];
  const staged = prepareMemory(createReferenceGraph(), 2, reference(), publicTurns);
  assert.deepEqual(staged.update.operations.map(op => op.kind), ['mention', 'mention', 'name']);
  assert.equal(staged.update.operations[1].antecedent, '2:antecedent');
  assert.equal(staged.update.operations.at(-1).agreement, 'implicit');
  for (const mention of staged.update.operations.filter(op => op.kind === 'mention')) {
    assert.ok(publicTurns.some(t => t.turn === mention.sourceTurn && t.speaker === mention.speaker && t.text.includes(mention.quote)));
  }
  assert.equal(staged.rejected, null);
});
