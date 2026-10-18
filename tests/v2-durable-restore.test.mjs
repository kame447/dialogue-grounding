import test from 'node:test';
import assert from 'node:assert/strict';
import { createHumanMessageQueue } from '../dialogue-model/runtime/web/human-message-queue.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';

test('queue rehydrates public events, private state, pending IDs, and idempotency', async () => {
  let calls = 0;
  const runner = async ({ events, privateState }) => ({ text: `answer-${++calls}`, privateState: { count: privateState.count + 1 } });
  const first = createHumanMessageQueue({ runAiTurn: runner, initialPrivateState: { count: 0 } });
  first.enqueue({ clientId: 'm-1', text: '図形について' });
  await first.whenIdle();
  const original = first.getDurableState();
  const second = createHumanMessageQueue({ runAiTurn: runner, initialState: original });
  assert.deepEqual(second.getSnapshot().events, first.getSnapshot().events);
  assert.deepEqual(second.getPrivateState(), { count: 1 });
  assert.equal(second.enqueue({ clientId: 'm-1', text: '図形について' }).duplicate, true);
  second.enqueue({ clientId: 'm-2', text: '次の図形' });
  await second.whenIdle();
  assert.equal(second.getSnapshot().events.length, 4);
  assert.deepEqual(second.getPrivateState(), { count: 2 });
  assert.equal(calls, 2);
});

test('restored pending queue finishes once, without losing an accepted message', async () => {
  const state = {
    events: [{ id: 'event-1', seq: 1, turn: 1, speaker: 'human', text: '候補の説明', at: new Date(1000).toISOString() }],
    pendingHumanEventIds: ['event-1'], clients: [['client-1', 'event-1']],
    privateState: { status: 'unassigned' }, closed: false, errorCode: null, requestSeq: 0, lastMillis: 1000,
  };
  const restored = createHumanMessageQueue({ initialState: state, runAiTurn: async ({ privateState }) => ({
    text: 'もう少し聞かせてください', privateState: { ...privateState, status: 'active' },
  }) });
  await restored.whenIdle();
  assert.deepEqual(restored.getSnapshot().pendingHumanEventIds, []);
  assert.equal(restored.getSnapshot().events.length, 2);
  assert.equal(restored.enqueue({ clientId: 'client-1', text: '候補の説明' }).duplicate, true);
});

test('v2 naming task restores a trial and its AI judgment history from persisted storage', async () => {
  let latest;
  const client = { async complete(messages) {
    if (messages.some((m) => typeof m.content === 'string' && m.content.includes('判断JSON'))) {
      return { text: JSON.stringify({ action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }), model: 'fake' };
    }
    return { text: 'わかりました。', model: 'fake' };
  }};
  // An injected judge avoids coupling this recovery test to prompt text.
  const judge = { judge: async () => ({ action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }) };
  const save = async (record) => { latest = structuredClone(record); };
  const first = await createNamingTaskV2({ client, judge, strategy: 'repair-first', seed: 35, runDir: null, onPersist: save });
  first.message('鳥に見える', 'trial-message-1');
  await first.whenIdle();
  assert.equal(first.getState().events.length, 2);
  const restored = await createNamingTaskV2({ client, judge, strategy: 'repair-first', seed: 35, runDir: null, onPersist: save, restore: latest });
  assert.deepEqual(restored.getState().events, first.getState().events);
  assert.deepEqual(restored.researcherView().privateState, first.researcherView().privateState);
  assert.equal(restored.getState().sessionId, first.getState().sessionId);
  restored.message('次の名前は？', 'trial-message-2');
  await restored.whenIdle();
  assert.equal(restored.getState().events.length, 4);
  assert.equal(latest.queueState.pendingHumanEventIds.length, 0);
});
