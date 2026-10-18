// Independent prompt-boundary regression. A mock cannot establish model behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { SAFE_JUDGMENT } from '../dialogue-model/runtime/judgment/schema.mjs';

test('holistic audit: actual generator requests do not restore the old internal-candidate trigger', async () => {
  const requests = [];
  const anchors = Array.from({ length: 6 }, (_, i) => ({ id: `s-000${i + 1}`,
    bbox: { x: i * 10, y: 0, w: 5, h: 5 }, centroid: { x: i * 10 + 2, y: 2 } }));
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    const dialogue = createDialogueV2({ strategy, anchors,
      image: { mimeType: 'image/png', base64: 'c3ludGhldGljLW93bi1pbWFnZQ==' },
      judge: { async judge() { return { ...SAFE_JUDGMENT, action: 'propose_name',
        targetSlot: anchors[0].id, candidateName: '鳥' }; } },
      client: { async complete(messages, options) {
        assert.equal(options.phase, 'generation'); requests.push(structuredClone(messages));
        return { text: '私にも鳥のように見えます。' };
      } } });
    const result = await dialogue.runAiTurn({ events: [{ id: 'event-1', seq: 1, speaker: 'human', text: '鳥っぽい形があるよ。' }],
      lastEventId: 'event-1', privateState: dialogue.initialPrivateState(), signal: new AbortController().signal });
    assert.equal(result.privateState.ledger[anchors[0].id].status, 'tentative');
    const instruction = requests.at(-1)[1].content;
    assert.match(instruction, /判断に discriminatingFeature があるとき/);
    assert.match(instruction, /特徴は1つ/);
    assert.match(instruction, /判断にない.*形の数や特徴を作って補わない/);
    assert.doesNotMatch(instruction, /複数候補が残る|説明に合う候補が2つ以上ある/,
      'the generator must not present mere candidate plurality as an analysis trigger');
  }
  assert.deepEqual(requests[0], requests[1]);
});
