import { privateBaseOptions } from './support/s5-private-options.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHumanMessageQueue, createHumanMessageSequencer } from '../dialogue-model/runtime/web/human-message-queue.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { createDialogueV2, eventsToHistory, eventsToPublicTurns } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { createNamingTask } from '../dialogue-model/runtime/naming-task.mjs';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { groundReference } from '../dialogue-model/runtime/judgment/public-evidence.mjs';
import { createReferenceGraph, validateReferenceUpdate } from '../dialogue-model/runtime/memory/reference-graph.mjs';

// All fixtures are synthetic. Clients below are in-memory mocks; the only HTTP
// requests are to the real participant server on an ephemeral loopback port.
const OPENING = 'まず、どの図形から話しましょうか？';
const initialEvents = () => [{ speaker: 'ai', text: OPENING }];
const trial = createTrialV2({ seed: 707 });
const slot = trial.ai.anchors[0].id;
const judgment = { action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };
const gate = () => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  return { entered: entered.promise, signal: entered.resolve, wait: released.promise, release: released.resolve };
};
function clientFixture({ reference = null, generation = null } = {}) {
  const calls = [];
  return { calls, async complete(messages, options = {}) {
    calls.push({ phase: options.phase, messages: structuredClone(messages) });
    if (options.phase === 'judgment') return { text: JSON.stringify({ ...judgment, ...(reference ? { reference } : {}) }) };
    if (options.phase === 'final_submission') return { text: JSON.stringify(Object.fromEntries(trial.ai.anchors.map(({ id }) => [id, '']))) };
    return { text: generation ? await generation() : 'synthetic public reply' };
  } };
}
const makeTask = (client, extra = {}) => createNamingTaskV2({ client, strategy: 'repair-first', seed: 707,
  createTrial: () => trial, runDir: '', ...extra });
const hasCode = (code) => (error) => error.code === code;

test('initialEvents assigns AI events once without pending humans, spoofed metadata or changed cursor semantics', () => {
  const supplied = [{ speaker: 'ai', text: OPENING, id: 'spoofed', seq: 99, turn: 99, at: 'spoofed', clientId: 'spoofed', origin: 'private' },
    { speaker: 'ai', text: 'synthetic second scripted event' }];
  const clock = [20, 10, 30];
  const state = createHumanMessageSequencer({ initialEvents: supplied, now: () => clock.shift() });
  const before = state.getSnapshot();
  assert.equal(before.revision, 2);
  assert.equal(before.lastEventId, 'event-2');
  assert.equal(before.status, 'idle');
  assert.deepEqual(before.pendingHumanEventIds, []);
  assert.deepEqual(before.events.map(({ id, seq, turn, speaker, at }) => [id, seq, turn, speaker, at]),
    [[ 'event-1', 1, 1, 'ai', new Date(20).toISOString() ], [ 'event-2', 2, 2, 'ai', new Date(20).toISOString() ]]);
  assert.ok(before.events.every((event) => !Object.hasOwn(event, 'clientId') && !Object.hasOwn(event, 'origin')));
  assert.equal(state.beginRequest(), null, 'scripted AI events never create work to answer');
  supplied[0].text = 'mutation'; supplied.push({ speaker: 'ai', text: 'late mutation' });
  assert.deepEqual(state.getSnapshot(), before);
  assert.deepEqual(state.getSnapshot({ afterSeq: 1 }).events.map((event) => event.seq), [2]);
  assert.deepEqual(state.getSnapshot({ afterSeq: 2 }).events, []);
  assert.equal(state.acceptHuman({ text: 'synthetic human' }).event.seq, 3);
});

test('initialEvents rejects human events, malformed entries and invalid text; default queues stay empty', () => {
  for (const value of [null, {}, 'text', [null], [[]], [{}], [{ speaker: 'human', text: 'human' }],
    [{ speaker: 'ai', text: '' }], [{ speaker: 'ai', text: '  ' }], [{ speaker: 'ai', text: 1 }],
    [{ speaker: 'ai', text: 'x'.repeat(12001) }], new Array(1)]) {
    assert.throws(() => createHumanMessageSequencer({ initialEvents: value }), hasCode('invalid_options'));
  }
  assert.deepEqual(createHumanMessageSequencer().getSnapshot().events, []);
});

test('opening never calls the runner; first human is event 2 and generated AI reply is event 3', async () => {
  const requests = [];
  const queue = createHumanMessageQueue({ initialEvents: initialEvents(), now: () => 0,
    runAiTurn(request) { requests.push(request); return { text: 'synthetic reply' }; } });
  await queue.whenIdle(); await queue.retry();
  assert.equal(requests.length, 0);
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), [OPENING]);
  const receipt = queue.enqueue({ text: 'synthetic human', clientId: 'browser-message-1' });
  assert.equal(receipt.event.seq, 2);
  assert.equal(receipt.event.clientId, 'browser-message-1');
  assert.deepEqual(queue.enqueue({ text: 'synthetic human', clientId: 'browser-message-1' }), { ...receipt, duplicate: true });
  await queue.whenIdle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestSeq, 1);
  assert.equal(requests[0].revision, 2);
  assert.equal(requests[0].lastEventId, 'event-2');
  assert.equal(requests[0].events[0].nonReferential, true, 'script provenance is kept for the internal memory adapter');
  assert.equal(Object.hasOwn(requests[0].pendingHumanEvents[0], 'nonReferential'), false);
  assert.deepEqual(eventsToPublicTurns(requests[0].events), [
    { turn: 1, speaker: 'ai', text: OPENING, nonReferential: true },
    { turn: 2, speaker: 'human', text: 'synthetic human' },
  ]);
  assert.deepEqual(requests[0].pendingHumanEvents.map((event) => event.seq), [2]);
  const snapshot = queue.getSnapshot();
  assert.ok(snapshot.events.every((event) => !Object.hasOwn(event, 'nonReferential')), 'private script metadata is stripped from public copies');
  assert.deepEqual(snapshot.events.map(({ seq, turn, speaker }) => [seq, turn, speaker]), [[1, 1, 'ai'], [2, 2, 'human'], [3, 3, 'ai']]);
  assert.ok(snapshot.events.filter((event) => event.speaker === 'ai').every((event) => !Object.hasOwn(event, 'clientId')));
  assert.deepEqual(snapshot.pendingHumanEventIds, []);
});

test('optional human clientIds are copied only when supplied, preserve idempotency, and reject values outside the 80-character contract', () => {
  const queue = createHumanMessageSequencer();
  const first = queue.acceptHuman({ text: 'same unkeyed text' });
  const second = queue.acceptHuman({ text: 'same unkeyed text' });
  assert.notEqual(first.event.id, second.event.id);
  assert.equal(Object.hasOwn(first.event, 'clientId'), false);
  const keyed = queue.acceptHuman({ text: 'keyed text', clientId: 'a'.repeat(80) });
  assert.equal(keyed.event.clientId.length, 80);
  assert.equal(queue.acceptHuman({ text: 'keyed text', clientId: 'a'.repeat(80) }).duplicate, true);
  assert.throws(() => queue.acceptHuman({ text: 'different text', clientId: 'a'.repeat(80) }), hasCode('client_id_conflict'));
  for (const clientId of ['', 'a'.repeat(81), null, 5, 'contains spaces']) {
    assert.throws(() => queue.acceptHuman({ text: 'valid', clientId }), hasCode('invalid_message'));
  }
});

test('superseding a pending human preserves the single scripted opening and real sequence numbers', async (t) => {
  const hold = gate(), requests = [];
  t.after(() => hold.release());
  const queue = createHumanMessageQueue({ initialEvents: initialEvents(), now: () => 0, async runAiTurn(request) {
    requests.push(request);
    if (requests.length === 1) { hold.signal(); await hold.wait; return { text: 'stale' }; }
    return { text: 'current' };
  } });
  queue.enqueue({ text: 'synthetic first human' }); await hold.entered;
  queue.enqueue({ text: 'synthetic correction' }); hold.release(); await queue.whenIdle();
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), [OPENING, 'synthetic first human', 'synthetic correction', 'current']);
  assert.deepEqual(requests[1].pendingHumanEvents.map((event) => event.turn), [2, 3]);
  assert.equal(queue.getSnapshot().events.filter((event) => event.text === OPENING).length, 1);
});

for (const strategy of ['repair-first', 'bypass-enabled']) test(`${strategy}: first state has the exact opening once, no model call or private event metadata`, async () => {
  const client = clientFixture();
  const task = await makeTask(client, { strategy, referenceMemory: true });
  const first = task.getState();
  await task.whenIdle();
  assert.deepEqual(task.getState().events, first.events);
  assert.equal(client.calls.length, 0);
  assert.equal(first.aiStatus, 'idle'); assert.equal(first.busy, false);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].id, 'event-1');
  assert.equal(first.events[0].speaker, 'ai');
  assert.equal(first.events[0].text, OPENING);
  assert.deepEqual(Object.keys(first.events[0]).sort(), ['at', 'id', 'speaker', 'text']);
  const { privateState } = task.researcherView();
  assert.equal(privateState.judgments.length, 0);
  assert.ok(Object.values(privateState.ledger).every((entry) => entry.name === null));
  assert.equal(privateState.graph.records.length, 0);
});

test('leading AI event becomes assistant history; memory cites the first human at turn 2', async () => {
  const reference = { slots: [slot], epistemic: 'grounded', intent: 'feature_assertion',
    feature: { slot, feature: '細長い', polarity: 'confirmed' }, nameAcceptance: null, deferSlot: null, revisitSlot: null };
  const client = clientFixture({ reference });
  const task = await makeTask(client, { referenceMemory: true });
  task.message('細長い形があります', 'synthetic-first-human'); await task.whenIdle();
  assert.deepEqual(task.getState().events.map((event) => event.speaker), ['ai', 'human', 'ai']);
  const privateState = task.researcherView().privateState;
  assert.equal(privateState.judgments[0].turnIndex, 2);
  assert.deepEqual(privateState.judgments[0].humanEventIds, ['event-2']);
  const mentions = privateState.graph.records.filter((record) => record.kind === 'mention');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].sourceTurn, 2);
  assert.equal(mentions[0].speaker, 'human');
  assert.ok(!mentions.some((record) => record.sourceTurn === 1));
  for (const { messages } of client.calls) {
    const history = messages.filter((message) => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string');
    assert.deepEqual(history, [{ role: 'assistant', content: OPENING }, { role: 'user', content: '細長い形があります' }]);
    assert.ok(!JSON.stringify(messages).includes('scripted_opening'));
    assert.ok(!JSON.stringify(messages).includes('nonReferential'));
    assert.ok(!JSON.stringify(messages).includes('synthetic-first-human'));
  }
  const queue = createHumanMessageSequencer({ initialEvents: initialEvents(), now: () => 0 });
  queue.acceptHuman({ text: '細長い形があります' });
  assert.deepEqual(eventsToHistory(queue.getSnapshot().events), [{ role: 'assistant', content: OPENING }, { role: 'user', content: '細長い形があります' }]);
  assert.deepEqual(eventsToPublicTurns(queue.getSnapshot().events), [{ turn: 1, speaker: 'ai', text: OPENING }, { turn: 2, speaker: 'human', text: '細長い形があります' }]);
});

test('bare acknowledgment after the opening cannot invent a naming proposal, even from a literal noun in the script', async () => {
  for (const name of ['synthetic unspoken name', '図形']) {
    const reference = { slots: [slot], epistemic: 'grounded', intent: 'name_acceptance', feature: null,
      nameAcceptance: { slot, name }, deferSlot: null, revisitSlot: null };
    const task = await makeTask(clientFixture({ reference }), { referenceMemory: true });
    task.message('はい'); await task.whenIdle();
    const privateState = task.researcherView().privateState;
    assert.ok(privateState.graph.records.every((record) => record.kind !== 'name'));
    const mentions = privateState.graph.records.filter((record) => record.kind === 'mention');
    assert.equal(mentions.length, 1, 'the scripted question must not become a naming-proposal antecedent');
    assert.equal(mentions[0].sourceTurn, 2);
    assert.equal(mentions[0].speaker, 'human');
    assert.equal(mentions[0].epistemic, 'hypothesis');
    assert.equal(mentions[0].antecedent, null);
    assert.ok(privateState.judgments[0].memory.rejected.includes('bare_acknowledgment'));
  }
});

test('runAiTurn still rejects an opening-only history before any judge/model work', async () => {
  const client = clientFixture(), own = modelView(trial);
  const dialogue = createDialogueV2({ client, strategy: 'repair-first', image: { mimeType: own.mimeType, base64: own.png.toString('base64') }, anchors: own.anchors });
  const queue = createHumanMessageSequencer({ initialEvents: initialEvents() });
  await assert.rejects(dialogue.runAiTurn({ events: queue.getSnapshot().events, privateState: dialogue.initialPrivateState(), lastEventId: 'event-1' }), /No human message/);
  assert.equal(client.calls.length, 0);
});

test('non-referential opening does not prevent a later ordinary AI proposal from supporting acceptance', () => {
  const reference = { slots: [slot], epistemic: 'grounded', intent: 'name_acceptance', feature: null,
    nameAcceptance: { slot, name: '帆' }, deferSlot: null, revisitSlot: null };
  const evidence = groundReference({ turn: 4, interpretation: reference, publicTurns: [
    { turn: 1, speaker: 'ai', text: OPENING, nonReferential: true },
    { turn: 2, speaker: 'human', text: 'synthetic human' },
    { turn: 3, speaker: 'ai', text: '帆と呼びませんか' },
    { turn: 4, speaker: 'human', text: 'その呼び名でお願いします' },
  ] });
  assert.equal(evidence.antecedent.sourceTurn, 3);
  assert.equal(evidence.antecedent.intent, 'name_proposal');
  assert.equal(evidence.name.name, '帆');
  assert.equal(evidence.name.agreement, 'implicit');
});

test('reference turn schema allows only true nonReferential on AI and forbids scripted proof sources', () => {
  const graph = createReferenceGraph({ slots: trial.ai.anchors.map(({ id }) => id) });
  const ai = { turn: 1, speaker: 'ai', text: OPENING, nonReferential: true };
  const human = { turn: 2, speaker: 'human', text: 'はい' };
  const update = { expectedRevision: 0, turn: 2, operations: [] };
  assert.deepEqual(validateReferenceUpdate(graph, update, { publicTurns: [ai, human] }), update);
  for (const malformed of [
    { ...ai, nonReferential: false }, { ...ai, nonReferential: 1 }, { ...ai, nonReferential: undefined },
    { ...ai, extra: true }, { ...human, nonReferential: true },
  ]) {
    assert.throws(() => validateReferenceUpdate(graph, update, { publicTurns: [malformed] }), hasCode('invalid_public_turns'));
  }
  assert.throws(() => validateReferenceUpdate(graph, update, { publicTurns: [ai, ai, human] }), hasCode('invalid_public_turns'));
  const mention = { kind: 'mention', id: '2:opening', sourceTurn: 1, speaker: 'ai', quote: '図形',
    slots: [slot], confidence: 0.9, epistemic: 'grounded', intent: 'name_proposal', antecedent: null };
  assert.throws(() => validateReferenceUpdate(graph, { ...update, operations: [mention] }, { publicTurns: [ai, human] }), hasCode('nonpublic_evidence'));
  const { nonReferential, ...ordinaryAi } = ai;
  assert.equal(validateReferenceUpdate(graph, { ...update, operations: [mention] }, { publicTurns: [ordinaryAi, human] }).operations.length, 1,
    'the exclusion is explicit metadata, not a text heuristic that changes ordinary AI evidence');
  assert.equal(graph.revision, 0);
});

test('private record marks scripted origin once while public state and model history do not', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'v2-opening-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = clientFixture(), task = await makeTask(client, { runDir: directory });
  const readRecord = async () => {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
    assert.equal(files.length, 1);
    return JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
  };
  let record = await readRecord();
  assert.equal(record.events[0].origin, 'scripted_opening');
  assert.equal(record.events[0].seq, 1); assert.equal(record.events[0].turn, 1);
  assert.deepEqual(record.publicHistory, [{ role: 'assistant', content: OPENING }]);
  assert.deepEqual(record.requests, []);
  task.message('synthetic message'); await task.whenIdle();
  record = await readRecord();
  assert.equal(record.events.filter((event) => event.origin === 'scripted_opening').length, 1);
  assert.ok(record.events.slice(1).every((event) => !Object.hasOwn(event, 'origin')));
  assert.deepEqual(record.events.map((event) => event.seq), [1, 2, 3]);
  assert.ok(!JSON.stringify(task.getState()).includes('scripted_opening'));
  assert.ok(client.calls.every(({ messages }) => !JSON.stringify(messages).includes('scripted_opening')));
});

test('zero-human final submission remains supported and scores normally without turning the opening into naming', async () => {
  const client = clientFixture(), task = await makeTask(client);
  const names = Object.fromEntries(task.getState().scene.shapes.map(({ id }) => [id, null]));
  await task.submitHuman({ names }); await task.submitAI();
  assert.deepEqual(client.calls.map((call) => call.phase), ['final_submission']);
  assert.equal(task.getState().result.total, 6);
  assert.equal(task.getState().result.matchedCount, 0);
  assert.deepEqual(task.getState().events.map((event) => event.text), [OPENING]);
  assert.equal(task.researcherView().privateState.judgments.length, 0);
});

test('v1 naming sessions still start without public events or a model call', async () => {
  const client = clientFixture();
  const task = await createNamingTask({ client, strategy: 'repair-first', seed: 707, runDir: '' });
  assert.deepEqual(task.getState().publicHistory, []);
  assert.equal(client.calls.length, 0);
});

test('HTTP reload/polling keeps one opening and duplicate clientId POST returns one human eventId', async (t) => {
  const hold = gate(); t.after(() => hold.release());
  const client = clientFixture({ generation: async () => { hold.signal(); await hold.wait; return 'synthetic reply'; } });
  const server = await startNamingServer({ port: 0, client, ...(await privateBaseOptions(t,{seed:707})), createTaskV2: (options) => makeTask(options.client, options) });
  t.after(async () => { hold.release(); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base); const cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const request = (path, body) => fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const start = await request('/api/start', { version: 2 });
  assert.equal(start.status, 200);
  const startedTrial = (await start.json()).trial;
  const first = startedTrial.events;
  assert.equal(first.length, 1); assert.equal(first[0].text, OPENING);
  await (await request('/')).text();
  for (let i = 0; i < 3; i++) assert.deepEqual((await (await request('/api/state')).json()).trial.events, first);
  assert.equal(client.calls.length, 0);
  const post = async (body) => { const response = await request('/api/message', {...body,expectedRecordId:startedTrial.sessionId}); assert.equal(response.status, 202); return response.json(); };
  const accepted = await post({ text: 'synthetic HTTP human', clientId: 'browser-http-1' });
  await hold.entered;
  const repeated = await post({ text: 'synthetic HTTP human', clientId: 'browser-http-1' });
  assert.equal(repeated.eventId, accepted.eventId);
  const state = (await (await request('/api/state')).json()).trial;
  assert.deepEqual(state.events.map((event) => event.speaker), ['ai', 'human']);
  assert.equal(state.events[1].clientId, 'browser-http-1');
  assert.equal(Object.hasOwn(state.events[0], 'clientId'), false);
  assert.ok(state.events.every((event) => !Object.hasOwn(event, 'origin')));
  hold.release();
});
