import test from 'node:test';
import assert from 'node:assert/strict';
import { createHumanMessageQueue, createHumanMessageSequencer } from '../dialogue-model/runtime/web/human-message-queue.mjs';
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
  assert.equal(first.getState().events.length, 3);
  const restored = await createNamingTaskV2({ client, judge, strategy: 'repair-first', seed: 35, runDir: null, onPersist: save, restore: latest });
  assert.deepEqual(restored.getState().events, first.getState().events);
  assert.deepEqual(restored.researcherView().privateState, first.researcherView().privateState);
  assert.equal(restored.getState().sessionId, first.getState().sessionId);
  restored.message('次の名前は？', 'trial-message-2');
  await restored.whenIdle();
  assert.equal(restored.getState().events.length, 5);
  assert.equal(latest.queueState.pendingHumanEventIds.length, 0);
});

const OPENING = 'まず、どの図形から話しましょうか？';
const scriptedOpening = () => [{ speaker: 'ai', text: OPENING }];
const invalidOptions = (error) => error.code === 'invalid_options';

test('opening, private provenance and human clientId survive durable round-trip without replaying initialization', async () => {
  const requests = [];
  const runner = async (request) => { requests.push(request); return { text: 'synthetic reply' }; };
  const first = createHumanMessageQueue({ runAiTurn: runner, initialEvents: scriptedOpening(), now: () => 1000 });
  const receipt = first.enqueue({ text: 'synthetic human', clientId: 'browser-first' });
  await first.whenIdle();
  const saved = first.getDurableState();
  assert.equal(saved.events[0].nonReferential, true, 'durable copies must retain the private scripted flag');
  assert.equal(saved.events[1].clientId, 'browser-first');
  assert.equal(Object.hasOwn(first.getSnapshot().events[0], 'nonReferential'), false);
  const restored = createHumanMessageQueue({ runAiTurn: runner, initialEvents: scriptedOpening(), initialState: saved, now: () => 500 });
  await restored.whenIdle();
  assert.equal(requests.length, 1, 'idle restore cannot trigger a new model request');
  assert.deepEqual(restored.getSnapshot(), first.getSnapshot());
  assert.equal(restored.getSnapshot().events.filter((event) => event.text === OPENING).length, 1);
  assert.equal(restored.enqueue({ text: 'synthetic human', clientId: 'browser-first' }).event.id, receipt.event.id);
  assert.equal(requests.length, 1, 'retrying the same clientId cannot run the model again');
  const next = restored.enqueue({ text: 'synthetic next human', clientId: 'browser-next' });
  assert.equal(next.event.seq, 4);
  await restored.whenIdle();
  assert.deepEqual(restored.getSnapshot().events.map(({ seq, turn }) => [seq, turn]), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  assert.equal(requests[1].events[0].nonReferential, true, 'restored memory input keeps the scripted exclusion');
  assert.equal(requests[1].requestSeq, 2);
  assert.equal(restored.getDurableState().events[0].nonReferential, true);
  saved.events[0].text = 'caller mutation';
  assert.equal(restored.getSnapshot().events[0].text, OPENING);
});

test('a restored empty transcript is authoritative over fresh initialEvents', () => {
  const empty = createHumanMessageSequencer().getDurableState();
  const restored = createHumanMessageSequencer({ initialState: empty, initialEvents: scriptedOpening(),
    now() { assert.fail('restoring must not generate a new timestamp or scripted event'); } });
  assert.deepEqual(restored.getSnapshot().events, []);
  assert.equal(restored.getSnapshot().revision, 0);
  assert.equal(restored.getSnapshot().lastEventId, null);
});

test('pending durable restore keeps the scripted flag and resumes the accepted human at seq 2 exactly once', async () => {
  const first = createHumanMessageSequencer({ initialEvents: scriptedOpening(), now: () => 1000 });
  const receipt = first.acceptHuman({ text: 'synthetic pending human', clientId: 'pending-browser' });
  first.beginRequest();
  const requests = [];
  const restored = createHumanMessageQueue({ initialState: first.getDurableState(), initialEvents: scriptedOpening(),
    now: () => 2000, runAiTurn(request) { requests.push(request); return { text: 'synthetic recovered reply' }; } });
  await restored.whenIdle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestSeq, 2, 'recovery continues the transport request sequence');
  assert.deepEqual(requests[0].pendingHumanEvents.map((event) => event.id), ['event-2']);
  assert.equal(requests[0].events[0].nonReferential, true);
  assert.deepEqual(restored.getSnapshot().events.map((event) => event.text), [OPENING, 'synthetic pending human', 'synthetic recovered reply']);
  const duplicate = restored.enqueue({ text: 'synthetic pending human', clientId: 'pending-browser' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, receipt.event.id);
  assert.deepEqual(restored.getSnapshot().pendingHumanEventIds, []);
});

test('restore rejects extra event fields and mismatched clientId/nonReferential shapes', () => {
  const first = createHumanMessageSequencer({ initialEvents: scriptedOpening(), now: () => 1000 });
  first.acceptHuman({ text: 'synthetic human', clientId: 'browser-id' });
  const valid = first.getDurableState();
  assert.deepEqual(createHumanMessageSequencer({ initialState: valid }).getDurableState(), valid);
  const invalid = [
    [0, { clientId: 'ai-cannot-have-this' }],
    [0, { nonReferential: false }], [0, { nonReferential: 'true' }], [0, { nonReferential: undefined }],
    [1, { nonReferential: true }], [1, { clientId: undefined }], [1, { clientId: null }],
    [1, { clientId: 'a'.repeat(81) }], [1, { clientId: 'contains spaces' }],
    [0, { origin: 'scripted_opening' }], [1, { apiKey: 'SYNTHETIC_PRIVATE_CANARY' }],
  ];
  for (const [index, fields] of invalid) {
    const state = structuredClone(valid);
    Object.assign(state.events[index], fields);
    assert.throws(() => createHumanMessageSequencer({ initialState: state }), invalidOptions);
  }
  for (const clients of [[], [['different-id', 'event-2']], [['browser-id', 'event-1']],
    [['browser-id', 'event-2'], ['browser-id', 'event-2']], [['a'.repeat(81), 'event-2']]]) {
    assert.throws(() => createHumanMessageSequencer({ initialState: { ...valid, clients } }), invalidOptions);
  }
});

test('task restore preserves one private opening origin, deduplication and non-referential memory at continuous seq', async () => {
  let latest, generations = 0;
  const save = async (record) => { latest = structuredClone(record); };
  const client = { async complete() { generations++; return { text: 'synthetic reply', model: 'synthetic-only' }; } };
  const judge = { async judge({ ownLedger, publicHistory }) {
    const slot = Object.keys(ownLedger)[0];
    const reference = publicHistory.at(-1).content === 'はい' ? { slots: [slot], epistemic: 'grounded', intent: 'name_acceptance',
      feature: null, nameAcceptance: { slot, name: '図形' }, deferSlot: null, revisitSlot: null } : null;
    return { action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null, reference };
  } };
  const options = { client, judge, strategy: 'repair-first', seed: 83, referenceMemory: true, runDir: '', onPersist: save };
  const first = await createNamingTaskV2(options);
  assert.equal(generations, 0);
  const receipt = first.message('synthetic first message', 'stable-browser-id');
  await first.whenIdle();
  assert.equal(latest.events[0].origin, 'scripted_opening');
  assert.equal(latest.queueState.events[0].nonReferential, true);
  assert.equal(latest.queueState.events[1].clientId, 'stable-browser-id');
  const saved = structuredClone(latest);
  const restored = await createNamingTaskV2({ ...options, restore: saved });
  await restored.whenIdle();
  assert.equal(restored.getState().sessionId, first.getState().sessionId);
  assert.deepEqual(restored.getState().events, first.getState().events);
  assert.equal(latest.events[0].origin, 'scripted_opening');
  assert.equal(latest.events.filter((event) => event.origin === 'scripted_opening').length, 1);
  const duplicate = restored.message('synthetic first message', 'stable-browser-id');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.eventId, receipt.eventId);
  await restored.whenIdle();
  assert.equal(generations, 1);
  restored.message('はい', 'next-browser-id'); await restored.whenIdle();
  assert.deepEqual(latest.queueState.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.equal(latest.events.filter((event) => event.text === OPENING).length, 1);
  const { privateState } = restored.researcherView();
  assert.equal(privateState.judgments.at(-1).turnIndex, 4);
  assert.ok(privateState.graph.records.every((record) => record.sourceTurn !== 1 && record.kind !== 'name'),
    'restoration must not turn the script into naming evidence');
  const publicState = restored.getState();
  assert.ok(publicState.events.every((event) => !Object.hasOwn(event, 'origin') && !Object.hasOwn(event, 'nonReferential')));
  assert.equal(publicState.events[1].clientId, 'stable-browser-id');
});
