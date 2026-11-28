import assert from 'node:assert/strict';
import test from 'node:test';
import { FIGURE_BANK } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { createPartGeometry } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import type { PartGeometry, PartPoint } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import type { CompactPartGeometry } from '../dialogue-model/runtime/observation/part-consumers.ts';
import { compactPartGeometry, describePart, expandCompactPartGeometry, hasPartGeometry,
  PART_INDEX_INSTRUCTIONS, PART_REFERENCE_INSTRUCTIONS, withPartDescriptions } from '../dialogue-model/runtime/observation/part-consumers.ts';
import { buildHumanReferentPayload, buildJevDecisionPayload, JevDecisionError } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { readVisualFeatureDraft, readVisualFeatureEvidence } from '../dialogue-model/runtime/v2/visual-feature-evidence.ts';
import { buildMemoAiExtractionMessages, memoAiExtractionPrompt } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import { buildMemoExtractionMessages, memoExtractionPrompt } from '../dialogue-model/runtime/local-grounding/extract.ts';

const geometry = (bankIndex: number, dx = 400, dy = 400) => createPartGeometry(FIGURE_BANK[bankIndex].pieces.map(piece =>
  piece.points.map(([x, y]) => [x * 48 + dx, y * 48 + dy] as PartPoint)));
const all = FIGURE_BANK.map((_figure, index) => geometry(index));
const largest = [...all].sort((a, b) => JSON.stringify(compactPartGeometry(b)).length - JSON.stringify(compactPartGeometry(a)).length);
function fixture(count: 4 | 6): JevDecisionInput {
  const figures = largest.slice(0, count).map((parts, index) => ({ id: 'own-' + index,
    region: { x: parts.origin[0], y: parts.origin[1], w: parts.size[0], h: parts.size[1] },
    holistic: [], analytic: { shapes: ['三角の部分'], composition: '複数の部分がつながった形', relations: [] },
    unknowns: [], reobservations: [], parts }));
  return { turn: 1, ownSlots: figures.map(figure => figure.id), observations: { observedAt: '2026-11-28T00:00:00.000Z', figures },
    publicTurns: [{ turn: 1, speaker: 'human', text: '五角形の部分が含まれていますか？' }],
    issueSummary: '', priorClaims: [], publicNames: [], repairHistory: [], previousAction: null };
}

test('all original pieces and all connected candidates survive the compact representation exactly', () => {
  for (const parts of all) {
    const compact = compactPartGeometry(parts);
    assert.equal(compact.pieces.length, 7);
    assert.equal(compact.rows.length, parts.parts.length);
    assert.deepEqual(compact.rows.map(row => row[0]), parts.parts.map(part => part.members.join('')));
    assert.deepEqual(expandCompactPartGeometry(compact), parts);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(parts).length);
  }
});

test('the complete candidate index reaches human referent estimation and Jev action selection within the transport budget', () => {
  for (const count of [4, 6] as const) {
    const input = fixture(count);
    input.turn = 41;
    input.publicTurns = Array.from({ length: 41 }, (_, index) => ({ turn: index + 1,
      speaker: index % 2 ? 'ai' as const : 'human' as const,
      text: index === 40 ? '五角形の部分はどの位置ですか？' : 'つながった部分の形について確認しています。'.repeat(8) }));
    const before = structuredClone(input);
    for (const payload of [buildHumanReferentPayload(input), buildJevDecisionPayload(input, { questionLayout: 'two_stage_v3' })]) {
      assert.ok(payload.state.length <= 20000, String(payload.state.length));
      const state = JSON.parse(payload.state);
      assert.equal(state.observations.length, count);
      for (let index = 0; index < count; index++) {
        const parts = (input.observations.figures[index] as typeof input.observations.figures[number] & { parts: PartGeometry }).parts;
        assert.deepEqual(expandCompactPartGeometry(state.observations[index].parts), parts);
      }
      for (const question of Object.values(payload.questions)) assert.ok(question.instructions.includes(PART_INDEX_INSTRUCTIONS));
      assert.ok(state.publicTurns.some((entry: { text: string }) => entry.text === '五角形の部分はどの位置ですか？'));
    }
    assert.deepEqual(input, before);
  }
});

test('descriptions refer to composite pentagons and distinguish inferred cuts from a shared visible boundary', () => {
  const input = fixture(4);
  const projection = withPartDescriptions(input.observations);
  for (let figureIndex = 0; figureIndex < input.observations.figures.length; figureIndex++) {
    const saved = input.observations.figures[figureIndex] as typeof input.observations.figures[number] & { parts: PartGeometry };
    const projected = projection.figures[figureIndex] as unknown as { parts: CompactPartGeometry & { descriptions: string[] } };
    assert.equal(projected.parts.descriptions.length, saved.parts.parts.length);
    assert.equal(Object.hasOwn(saved.parts, 'descriptions'), false);
    const { descriptions: _descriptions, ...compact } = projected.parts;
    assert.deepEqual(expandCompactPartGeometry(compact), saved.parts);
    assert.ok(JSON.stringify(projected.parts).length < JSON.stringify(saved.parts).length);
    const pentagon = saved.parts.parts.findIndex(part => part.shape === 'pentagon' && part.members.length > 1);
    if (pentagon < 0) continue;
    const description = describePart(saved.parts, pentagon)!;
    assert.match(description, /五角形の候補/);
    assert.match(description, /仮に区切る/);
    assert.equal(projected.parts.descriptions[pentagon], description);
  }
  assert.ok(all.some(parts => parts.parts.some(part => part.shape === 'pentagon')));
});

test('part source pointers resolve only on the selected figure and reject absent, invalid or tampered catalog entries', () => {
  const input = fixture(4), memo = input.observations;
  const figure = memo.figures[0] as typeof memo.figures[number] & { parts: PartGeometry };
  const part = figure.parts.parts.findIndex(candidate => candidate.shape === 'pentagon');
  assert.ok(part >= 0);
  const source = { figureId: figure.id, path: ['parts', 'descriptions', part] };
  const text = '五角形として見る部分の候補があります。';
  const draft = JSON.stringify({ text, observationFeatures: [source] });
  assert.deepEqual(readVisualFeatureDraft(draft, memo, [figure.id], false)?.sources, [source]);
  assert.ok(readVisualFeatureEvidence({ sources: [{ source, quote: '五角形として見る部分' }] }, memo, [figure.id], text));
  assert.equal(readVisualFeatureDraft(draft, memo, [memo.figures[1].id], false), null);
  for (const path of [['parts', 'descriptions', -1], ['parts', 'descriptions', 999], ['parts', 'descriptions', part, 'extra'],
    ['parts', 'parts', part, 'shape'], ['parts', '__proto__', part]]) {
    assert.equal(readVisualFeatureDraft(JSON.stringify({ text, observationFeatures: [{ ...source, path }] }), memo, [figure.id], false), null);
  }
  const altered = structuredClone(memo);
  (altered.figures[0] as typeof figure).parts.parts[part].shape = 'triangle';
  assert.equal(readVisualFeatureDraft(draft, altered, [figure.id], false), null);
  assert.throws(() => buildHumanReferentPayload({ ...input, observations: altered }), error => error instanceof JevDecisionError && error.code === 'invalid_input');
});

test('legacy memos preserve their shape, object identity and prompt text when the optional feature is absent', () => {
  const input = fixture(4);
  for (const figure of input.observations.figures) delete (figure as typeof figure & { parts?: PartGeometry }).parts;
  assert.equal(hasPartGeometry(input.observations), false);
  assert.strictEqual(withPartDescriptions(input.observations), input.observations);
  assert.equal(memoAiExtractionPrompt(undefined, true), memoAiExtractionPrompt(undefined, true, false));
  assert.equal(memoExtractionPrompt(true, true), memoExtractionPrompt(true, true, undefined, false));
  assert.match(memoAiExtractionPrompt(undefined, true, true), /parts.*descriptions/);
  assert.ok(memoExtractionPrompt(true, true, undefined, true).includes(PART_REFERENCE_INSTRUCTIONS));
  for (const question of Object.values(buildHumanReferentPayload(input).questions)) assert.equal(question.instructions.includes(PART_INDEX_INSTRUCTIONS), false);
});


test('both public extraction consumers receive every candidate and its derived description through chunked messages', () => {
  for (const count of [4, 6] as const) {
    const input = fixture(count), memo = input.observations;
    const before = structuredClone(memo);
    const ownAnchors = memo.figures.map(figure => ({ id: figure.id, bbox: figure.region,
      centroid: { x: figure.region.x + figure.region.w / 2, y: figure.region.y + figure.region.h / 2 } }));
    const context = { turn: input.turn, publicTurns: input.publicTurns, ownSlots: input.ownSlots, ownAnchors, issueSummary: '' };
    const messages = [
      buildMemoExtractionMessages({ ...context, ownImage: { mimeType: 'image/png', base64: 'AA==' } }, memo),
      buildMemoAiExtractionMessages({ ...context, aiSeq: 2, candidateText: '五角形の部分が見える候補です。', observations: memo }, undefined, true),
    ];
    for (const stream of messages) {
      assert.ok(stream[0].content.includes(PART_REFERENCE_INSTRUCTIONS));
      const body = stream.slice(1).map(message => message.content);
      assert.ok(body.every(content => content.length <= 20000));
      const state = JSON.parse(body.map(content => content.startsWith('同じJSON文脈の続き') ? content.slice(content.indexOf('\n') + 1) : content).join(''));
      assert.equal(state.observations.figures.length, count);
      for (let index = 0; index < count; index++) {
        const { descriptions, ...compact } = state.observations.figures[index].parts;
        assert.deepEqual(expandCompactPartGeometry(compact), memo.figures[index].parts);
        assert.equal(descriptions.length, memo.figures[index].parts!.parts.length);
        assert.deepEqual(descriptions, memo.figures[index].parts!.parts.map((_part, partIndex) => describePart(memo.figures[index].parts, partIndex)));
      }
    }
    assert.deepEqual(memo, before);
  }
});
