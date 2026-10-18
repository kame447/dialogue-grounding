import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { createNamingTask, SLOTS } from '../dialogue-model/runtime/naming-task.mjs';
import { createDialogueSession } from '../dialogue-model/runtime/session.mjs';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { createOwnImageRotationSheet } from '../dialogue-model/runtime/visual/own-image-rotation.mjs';
import { createReferenceGraph, validateReferenceUpdate } from '../dialogue-model/runtime/memory/reference-graph.mjs';
import { JUDGE_POLICIES } from '../dialogue-model/runtime/judgment/instructions.mjs';
import { createLunaJudge } from '../dialogue-model/runtime/judgment/luna.mjs';
import { createOwnLedger } from '../dialogue-model/runtime/judgment/schema.mjs';

// All boards, names and canaries below are synthetic. No API/network dependency
// except the participant HTTP server bound to an ephemeral loopback port.
const CANARY = 'SYNTHETIC_PRIVATE_CANARY';
const PUBLIC = 'この図形について相談しましょう';
const REPLY = '形の特徴から一緒に考えましょう。';
const names = (prefix) => Object.fromEntries(SLOTS.map((slot, i) => [slot, prefix + i]));
const CHOICE = names('SYNTHETIC_AI_CHOICE_');
const HUMAN = names('SYNTHETIC_HUMAN_CHOICE_');
const judgment = { action: 'propose_name', targetSlot: SLOTS[0], candidateName: '候補の名前',
  discriminatingFeature: null, note: 'SYNTHETIC_PRIVATE_JUDGE_NOTE' };

// Independent PNG fixture writer; production crop/render helpers do not create
// the expected pixels. Each own cell has distinct asymmetric grayscale pixels.
function chunk(type, data = Buffer.alloc(0)) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); payload.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
function board(offset = 0, metadata = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1200); header.writeUInt32BE(800, 4); header[8] = 8;
  const raw = Buffer.alloc(1201 * 800);
  for (let y = 0; y < 800; y++) for (let x = 0; x < 1200; x++) {
    raw[y * 1201 + x + 1] = ownPixel(x, y, offset);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(metadata ? [chunk('tEXt', Buffer.from('researcher_only\0' + CANARY))] : []),
    chunk('IDAT', deflateSync(raw)), chunk('IEND')]);
}
function ownPixel(x, y, offset = 0) {
  return (x * 13 + y * 19 + Math.floor(x / 400) * 37 + Math.floor(y / 400) * 67 + offset) & 255;
}
const OWN_PNG = board(), OTHER_PNG = board(101);
const image = { mimeType: 'image/png', base64: OWN_PNG.toString('base64') };
function trial({ seed }) {
  return { trialId: 'synthetic-trial', seed, ai: { png: OWN_PNG, mimeType: 'image/png', researcherOnly: CANARY },
    human: { png: OTHER_PNG, mimeType: 'image/png' },
    key: { human: names(CANARY + '_human_'), ai: names(CANARY + '_ai_') },
    researcherOnly: { futureHistory: CANARY, goldAnnotation: CANARY, scoring: CANARY } };
}
function phase(messages) {
  if (messages.some((m) => typeof m.content === 'string' && m.content.includes('【非公開の対話判断】'))) return 'judgment';
  if (messages.at(-1).content.includes('最終提出要求')) return 'final_submission';
  return 'generation';
}
function fakeClient(respond) {
  const calls = [];
  return { calls, async complete(messages) {
    const entry = { phase: phase(messages), messages: structuredClone(messages) };
    calls.push(entry);
    const text = respond ? await respond(entry, calls) : entry.phase === 'judgment' ? JSON.stringify(judgment) :
      entry.phase === 'final_submission' ? JSON.stringify(CHOICE) : REPLY;
    return { text, model: 'synthetic-fixed-model' };
  } };
}
function options(client, extra = {}) {
  return { client, strategy: 'repair-first', seed: 17, createTrial: trial,
    scoreTrial: () => ({ provisional: true, matchedCount: 0 }), runDir: '', ...extra };
}
const imageURLs = (messages) => messages.flatMap((m) => Array.isArray(m.content) ?
  m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : []);
// Do not dump model messages or image bodies when a privacy assertion fails.
const same = (actual, expected, message) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), message);
function assertModelPrivacy(calls) {
  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes(CANARY), 'researcher-only canary must not reach any model request');
  assert.ok(!serialized.includes(OTHER_PNG.toString('base64')), 'other participant PNG must not reach any model request');
  assert.ok(!/SYNTHETIC_HUMAN_CHOICE_|visualAid|referenceMemory|repair-first|bypass-enabled/.test(serialized),
    'model request must omit participant answers and experiment condition labels');
}
function assertParticipantPrivacy(state) {
  const allowed = ['trialId', 'seed', 'strategy', 'slots', 'status', 'busy', 'publicHistory',
    'humanSubmitted', 'aiSubmitted', 'humanSubmission', 'aiSubmission', 'result'];
  assert.ok(Object.keys(state).every((key) => allowed.includes(key)), 'participant state fields are an explicit allowlist');
  const serialized = JSON.stringify(state);
  assert.ok(!/visualAid|referenceMemory|ownReferences|referenceGraph|ownLedger|judgments|memoryOps|SYNTHETIC_PRIVATE/.test(serialized),
    'participant state must omit private runtime data');
  if (state.status !== 'completed') {
    assert.ok(!Object.hasOwn(state, 'aiSubmission'));
    assert.ok(!Object.hasOwn(state, 'result'));
    assert.ok(!serialized.includes('SYNTHETIC_AI_CHOICE_'));
  }
}
async function run(extra = {}) {
  const client = fakeClient();
  const task = await createNamingTask(options(client, extra));
  assertParticipantPrivacy(task.getState());
  assertParticipantPrivacy(await task.turn(PUBLIC));
  assertParticipantPrivacy(await task.turn('続けて相談しましょう'));
  assertParticipantPrivacy(await task.submitAI());
  assertModelPrivacy(client.calls);
  return { task, client };
}

test('default and explicit OFF have identical model payloads and hide all private working state', async () => {
  const implicit = await run(), explicit = await run({ visualAid: false, referenceMemory: false });
  same(implicit.client.calls, explicit.client.calls, 'omitted options must produce exactly the explicit OFF requests');
  assert.deepEqual(implicit.client.calls.map((c) => c.phase), ['judgment', 'generation', 'judgment', 'generation', 'final_submission']);
  for (const { messages } of implicit.client.calls) {
    same(imageURLs(messages), ['data:image/png;base64,' + image.base64], 'OFF must send exactly one own image');
    assert.ok(!/ownReferences|memoryOps|currentTurn|referenceGraph/.test(JSON.stringify(messages)), 'OFF must add no memory inputs');
  }
});

test('privacy oracle catches a deliberately injected nested private field and swapped participant image', async () => {
  const { client, task } = await run();
  const injected = structuredClone(client.calls);
  injected[0].messages.push({ role: 'system', content: JSON.stringify({ answerKey: { nested: CANARY } }) });
  assert.throws(() => assertModelPrivacy(injected), /researcher-only canary/);
  const swapped = structuredClone(client.calls);
  swapped[1].messages.push({ role: 'user', content: [{ type: 'image_url',
    image_url: { url: 'data:image/png;base64,' + OTHER_PNG.toString('base64') } }] });
  assert.throws(() => assertModelPrivacy(swapped), /other participant PNG/);
  assert.throws(() => assertParticipantPrivacy({ ...task.getState(), ownLedger: {} }), /explicit allowlist/);
});

test('own rotation sheet discards injected PNG metadata and every view is derived only from its own cell', () => {
  const clean = createOwnImageRotationSheet(OWN_PNG, { enabled: true });
  const tainted = createOwnImageRotationSheet(board(0, true), { enabled: true });
  assert.deepEqual(tainted, clean);
  assert.ok(!tainted.png.includes(Buffer.from(CANARY)));
  let width, compressed = [];
  for (let at = 8; at < clean.png.length;) {
    const length = clean.png.readUInt32BE(at), type = clean.png.toString('ascii', at + 4, at + 8);
    assert.ok(['IHDR', 'IDAT', 'IEND'].includes(type));
    const data = clean.png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') width = data.readUInt32BE(0);
    if (type === 'IDAT') compressed.push(data);
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  for (let y = 0; y < clean.height; y++) assert.equal(raw[y * (width + 1)], 0);
  clean.slots.forEach(({ views }, slot) => views.forEach(({ rect, degreesCW }) => {
    let mismatch = false;
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      const [sx, sy] = degreesCW === 0 ? [x, y] : degreesCW === 90 ? [y, 399 - x] :
        degreesCW === 180 ? [399 - x, 399 - y] : [399 - y, x];
      const expected = ownPixel(slot % 3 * 400 + sx, Math.floor(slot / 3) * 400 + sy);
      if (raw[(rect.y + y) * (width + 1) + rect.x + x + 1] !== expected) mismatch = true;
    }
    assert.equal(mismatch, false, 'all pixels must come from the specified own cell and rotation');
  }));
});

test('caller image metadata and public-history metadata do not become model-visible private inputs', async () => {
  const client = fakeClient();
  const session = createDialogueSession({ client, strategy: 'repair-first', image: {
    ...image, answerKey: CANARY, humanImage: OTHER_PNG.toString('base64'), futureHistory: CANARY,
  } });
  await session.turn(PUBLIC);
  await session.finalRequest('【非公開最終提出要求】JSONで提出してください');
  await createLunaJudge(client).judge({ image, strategy: 'repair-first', ownLedger: createOwnLedger(),
    publicHistory: [{ role: 'user', content: PUBLIC, answerKey: CANARY, futureHistory: CANARY }] });
  assertModelPrivacy(client.calls);
});

test('an extra private field in judgment JSON is rejected, retried once and never echoed to generator or participant', async () => {
  const client = fakeClient(({ phase }) => phase === 'judgment' ? JSON.stringify({ ...judgment,
    answerKey: CANARY, humanImage: OTHER_PNG.toString('base64') }) : REPLY);
  const task = await createNamingTask(options(client));
  const state = await task.turn(PUBLIC);
  assert.deepEqual(client.calls.map((c) => c.phase), ['judgment', 'judgment', 'generation']);
  assertModelPrivacy(client.calls);
  assertParticipantPrivacy(state);
  const selected = client.calls.at(-1).messages.find((m) => typeof m.content === 'string' && m.content.startsWith('この発話の判断'));
  assert.match(selected.content, /"action":"accept"/);
  assert.doesNotMatch(selected.content, /候補の名前|SYNTHETIC_PRIVATE/);
});

for (const first of ['ai', 'human']) test(`scorer receives the key only after both submissions (${first} first)`, async () => {
  const client = fakeClient(), scored = [];
  const task = await createNamingTask(options(client, { scoreTrial: (input) => {
    scored.push(input); return { provisional: true, matchedCount: 0 };
  } }));
  await task.turn(PUBLIC);
  assert.equal(scored.length, 0);
  const pending = first === 'ai' ? await task.submitAI() : await task.submitHuman(HUMAN);
  assert.equal(scored.length, 0); assertParticipantPrivacy(pending);
  const done = first === 'ai' ? await task.submitHuman(HUMAN) : await task.submitAI();
  assert.equal(scored.length, 1);
  assert.deepEqual(scored[0], { key: trial({ seed: 17 }).key, humanSubmission: HUMAN, aiSubmission: CHOICE });
  assert.equal(done.status, 'completed'); assertModelPrivacy(client.calls);
});

test('invalid final choices consume exactly one format retry, never score, and cannot be reopened', async () => {
  const client = fakeClient(() => JSON.stringify({ ...CHOICE, answerKey: CANARY }));
  const task = await createNamingTask(options(client, { scoreTrial() { assert.fail('invalid choice must not score'); } }));
  await task.submitHuman(HUMAN);
  await assert.rejects(task.submitAI(), { code: 'invalid_ai_submission' });
  assert.equal(client.calls.length, 2);
  same(client.calls[0].messages.slice(0, -1), client.calls[1].messages.slice(0, -1), 'final format retry may only change its instruction');
  assertParticipantPrivacy(task.getState()); assertModelPrivacy(client.calls);
  await assert.rejects(task.submitAI(), { code: 'already_submitted' });
  await assert.rejects(task.turn(PUBLIC), { code: 'dialogue_closed' });
  assert.equal(client.calls.length, 2);
});

test('reference memory rejects researcher-only graph fields and unobserved/future evidence transactionally', () => {
  const graph = createReferenceGraph();
  assert.throws(() => createReferenceGraph({ ownObservations: [], answerKey: CANARY }), { code: 'invalid_observations' });
  const mention = { kind: 'mention', id: '1:m', sourceTurn: 1, speaker: 'human', quote: CANARY,
    slots: [SLOTS[0]], confidence: 0.8, epistemic: 'grounded', intent: 'refer', antecedent: null };
  const update = { expectedRevision: 0, turn: 1, operations: [mention] };
  assert.throws(() => validateReferenceUpdate(graph, update, {
    publicTurns: [{ turn: 1, speaker: 'human', text: PUBLIC }],
  }), { code: 'nonpublic_evidence' });
  assert.throws(() => validateReferenceUpdate(graph, { ...update, operations: [{ ...mention, sourceTurn: 2 }] }),
    { code: 'invalid_mention' });
  assert.deepEqual(graph.records, []); assert.equal(graph.revision, 0);
});

for (const visualAid of [false, true]) for (const referenceMemory of [false, true]) {
  test(`ablation visual=${visualAid}, memory=${referenceMemory} preserves per-phase privacy and strategy parity`, async () => {
    const left = await run({ visualAid, referenceMemory, strategy: 'repair-first' });
    const right = await run({ visualAid, referenceMemory, strategy: 'bypass-enabled' });
    const expectedImages = ['data:image/png;base64,' + image.base64,
      ...(visualAid ? ['data:image/png;base64,' + createOwnImageRotationSheet(OWN_PNG, { enabled: true }).png.toString('base64')] : [])];
    for (let i = 0; i < left.client.calls.length; i++) {
      const a = left.client.calls[i], b = right.client.calls[i];
      same(imageURLs(a.messages), expectedImages, 'every phase must send exactly the own board and enabled own rotation sheet');
      const policy = (message) => message.role === 'system' && Object.values(JUDGE_POLICIES).includes(message.content);
      assert.equal(a.messages.filter(policy).length, a.phase === 'judgment' ? 1 : 0);
      same(a.messages.filter((m) => !policy(m)), b.messages.filter((m) => !policy(m)), 'strategies may differ only in declared judge policy');
      const payload = JSON.stringify(a.messages);
      if (a.phase === 'judgment' && referenceMemory) assert.ok(payload.includes('ownReferences'), 'enabled judge must receive memory summary');
      else assert.ok(!/ownReferences|referenceGraph|memoryOps|private_own_slots_not_ground_truth/.test(payload), 'graph must stay out of generator and final requests');
      if (visualAid) {
        const at = a.messages.findIndex((m) => imageURLs([m]).includes(expectedImages[0]));
        same(imageURLs([a.messages[at + 1]]), [expectedImages[1]], 'derived image must immediately follow own image');
      }
    }
  });
}

test('invalid runtime toggles fail before trial construction and any model request', async () => {
  for (const key of ['visualAid', 'referenceMemory']) for (const value of [null, 'true', 0, 1, [], {}]) {
    const client = fakeClient();
    let trials = 0;
    await assert.rejects(createNamingTask(options(client, { [key]: value, createTrial(input) {
      trials++; return trial(input);
    } })), { code: 'invalid_options' });
    assert.equal(trials, 0); assert.equal(client.calls.length, 0);
  }
});

test('enabled visual aid rejects unsupported own PNG before any model request', async () => {
  const client = fakeClient();
  await assert.rejects(createNamingTask(options(client, { visualAid: true, createTrial(input) {
    const value = trial(input); value.ai.png = Buffer.from('synthetic-invalid-png'); return value;
  } })), { code: 'invalid_trial' });
  assert.equal(client.calls.length, 0);
});

const mention = (quote = '鳥にしましょう') => ({ kind: 'mention', id: '1:m', sourceTurn: 1, speaker: 'human', quote,
  slots: [SLOTS[0]], confidence: 0.8, epistemic: 'grounded', intent: 'name_proposal', antecedent: null });
const referenceOps = () => [mention(), { kind: 'name', id: '1:n', slot: SLOTS[0], name: '鳥', agreement: 'none',
  mentionIds: ['1:m'], replaces: null }];
const memoryInput = (call) => {
  const message = call.messages.find((m) => typeof m.content === 'string' && m.content.includes('"ownReferences":'));
  assert.ok(message, 'judge must receive structured own reference summary');
  return JSON.parse(message.content.slice(message.content.indexOf('{'))).ownReferences;
};

test('valid memory operations commit with generation, survive to the next judge, and stay out of generator/final', async () => {
  let failGeneration = true, judgeCalls = 0;
  const client = fakeClient(({ phase }) => {
    if (phase === 'judgment') return JSON.stringify({ ...judgment, memoryOps: ++judgeCalls <= 2 ? referenceOps() : [] });
    if (phase === 'generation' && failGeneration) { failGeneration = false; throw new Error(CANARY); }
    return phase === 'final_submission' ? JSON.stringify(CHOICE) : REPLY;
  });
  const session = createDialogueSession({ client, image, strategy: 'repair-first', referenceMemory: true });
  const initialGraph = session.getReferenceGraph(), initialLedger = session.getOwnLedger();
  await assert.rejects(session.turn('鳥にしましょう'));
  assert.deepEqual(session.getHistory(), []);
  assert.deepEqual(session.getOwnLedger(), initialLedger);
  assert.deepEqual(session.getReferenceGraph(), initialGraph);
  assert.equal(session.getJudgmentHistory()[0].memory.opsApplied, 0);
  await session.turn('鳥にしましょう');
  assert.equal(session.getReferenceGraph().revision, 1);
  assert.equal(session.getReferenceGraph().ownSlots[SLOTS[0]].candidate.name, '鳥');
  assert.equal(session.getJudgmentHistory().at(-1).memory.opsApplied, 2);
  await session.turn('続けて相談しましょう');
  const judges = client.calls.filter((c) => c.phase === 'judgment');
  assert.equal(memoryInput(judges[0]).revision, 0);
  assert.deepEqual(memoryInput(judges[0]), memoryInput(judges[1]));
  assert.equal(memoryInput(judges[2]).ownSlots[SLOTS[0]].candidate.name, '鳥');
  await session.finalRequest('【非公開最終提出要求】JSONで提出してください');
  for (const call of client.calls.filter((c) => c.phase !== 'judgment')) {
    assert.ok(!/ownReferences|memoryOps|private_own_slots_not_ground_truth/.test(JSON.stringify(call.messages)),
      'non-judge model input must omit graph and operations');
  }
  assertModelPrivacy(client.calls);
});

test('nonpublic memory evidence is retried once then dropped while retaining a valid core judgment', async () => {
  const client = fakeClient(({ phase }) => phase === 'judgment' ?
    JSON.stringify({ ...judgment, memoryOps: [mention(CANARY)] }) : REPLY);
  const session = createDialogueSession({ client, image, strategy: 'repair-first', referenceMemory: true });
  await session.turn(PUBLIC);
  assert.deepEqual(client.calls.map((c) => c.phase), ['judgment', 'judgment', 'generation']);
  assertModelPrivacy(client.calls);
  assert.deepEqual(session.getReferenceGraph().mentions, []);
  assert.equal(session.getJudgmentHistory().at(-1).memory.opsApplied, 0);
  const selected = client.calls.at(-1).messages.find((m) => typeof m.content === 'string' && m.content.startsWith('この発話の判断'));
  assert.match(selected.content, /"action":"propose_name"/);
  assert.doesNotMatch(selected.content, /memoryOps|SYNTHETIC_PRIVATE/);
});

test('Web ON state and pending AI choices stay private; malformed toggles cannot replace the live trial', async (t) => {
  const client = fakeClient();
  let trials = 0;
  const server = await startNamingServer({ port: 0, ...options(client), hideStrategy: true,
    createTrial(input) { trials++; return trial(input); } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const request = (path, body) => fetch(base + path, { headers: { cookie,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const start = { strategy: 'repair-first', seed: 17, visualAid: true, referenceMemory: true };
  assert.equal((await request('/api/start', start)).status, 200);
  for (const [path, body] of [['/api/state'], ['/api/turn', { utterance: PUBLIC }], ['/api/ai-submit', {}]]) {
    const response = await request(path, body);
    assert.equal(response.status, 200);
    const { trial: state } = await response.json();
    assertParticipantPrivacy(state); assert.ok(!Object.hasOwn(state, 'strategy'));
  }
  const before = await (await request('/api/state')).json();
  for (const key of ['visualAid', 'referenceMemory']) for (const value of [null, 'false', 0, [], {}]) {
    const response = await request('/api/start', { ...start, [key]: value });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid_request' });
    assert.deepEqual(await (await request('/api/state')).json(), before);
  }
  assert.equal(trials, 1);
  assertModelPrivacy(client.calls);
  assert.ok(client.calls.every((c) => imageURLs(c.messages).length === 2));
  assert.deepEqual(Buffer.from(await (await request('/api/image')).arrayBuffer()), OTHER_PNG);
});
