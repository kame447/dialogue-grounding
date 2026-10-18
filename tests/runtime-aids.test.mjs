import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNamingTask, SLOTS } from '../dialogue-model/runtime/naming-task.mjs';
import { createChatClient } from '../dialogue-model/runtime/client.mjs';
import { createTrial } from '../dialogue-model/runtime/stimuli/board.mjs';
import { createOwnImageRotationSheet } from '../dialogue-model/runtime/visual/own-image-rotation.mjs';
import { SAFE_JUDGMENT } from '../dialogue-model/runtime/judgment/schema.mjs';

const ownTrial = createTrial({ seed: 31 });
const sheet = createOwnImageRotationSheet(ownTrial.ai.png, { enabled: true });
const finalNames = Object.fromEntries(SLOTS.map((slot, i) => [slot, '最終名' + i]));
const utterance = '試しの呼び名にします';
const reference = (extra = {}) => ({ slots: [SLOTS[0]], epistemic: 'grounded', intent: 'name_acceptance',
  feature: null, nameAcceptance: { slot: SLOTS[0], name: '試しの呼び名' }, deferSlot: null, revisitSlot: null, ...extra });
const phase = (messages) => messages.some(m => m.role === 'system' && m.content.includes('【非公開の対話判断】')) ? 'judge' :
  messages.at(-1).content.includes('最終提出要求') ? 'final' : 'generation';
const images = (body) => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);
const textOnly = (value) => JSON.stringify(value.messages.map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.filter(p => p.type !== 'image_url') : m.content })));

async function setup(t, options = {}, respond = () => ({})) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const kind = phase(body.messages), response = respond(kind, body);
    res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(response.raw ?? JSON.stringify({ model: 'mock-only', choices: [{ message: { content: response.text ??
      (kind === 'judge' ? JSON.stringify(SAFE_JUDGMENT) : kind === 'final' ? JSON.stringify(finalNames) : '公開返答') } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = await mkdtemp(join(tmpdir(), 'runtime-aids-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = createChatClient({ provider: 'cloudflare', purpose: 'dialogue_turn', apiKey: 'TEST-PRIVATE-TOKEN',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' });
  const task = await createNamingTask({ client, strategy: 'repair-first', seed: 31, runDir: directory,
    createTrial: () => ({ ...ownTrial, trialId: 'PRIVATE-TRIAL-ID', key: { human: 'PRIVATE-HUMAN-KEY', ai: 'PRIVATE-AI-KEY' } }),
    scoreTrial: () => ({ provisional: true, success: false }), ...options });
  const record = async () => { const [file] = await readdir(directory); return JSON.parse(await readFile(join(directory, file), 'utf8')); };
  return { task, requests, record };
}
function privateState(task) {
  const state = task.getState();
  for (const key of ['visualAid', 'referenceMemory', 'options', 'referenceGraph', 'judgments']) assert.equal(Object.hasOwn(state, key), false);
  return state;
}

test('default OFF and explicit OFF send identical old one-image judge/generator/final payloads', async (t) => {
  const implicit = await setup(t), explicit = await setup(t, { visualAid: false, referenceMemory: false });
  for (const app of [implicit, explicit]) { await app.task.turn(utterance); await app.task.submitAI(); privateState(app.task); }
  assert.deepEqual(implicit.requests, explicit.requests);
  assert.deepEqual(explicit.requests.map(r => phase(r.messages)), ['judge', 'generation', 'final']);
  for (const body of explicit.requests) {
    assert.equal(images(body).length, 1);
    assert.doesNotMatch(textOnly(body), /ownReferences|memoryOps|R1C1|currentTurn|publicTurns|visualAid|referenceMemory/);
  }
  const record = await implicit.record();
  assert.deepEqual(record.options, { visualAid: false, referenceMemory: false });
  assert.equal(Object.hasOwn(record, 'referenceGraph'), false);
  assert.equal(Object.hasOwn(record.judgments[0], 'memory'), false);
});

test('visual aid uses only own pixels in all three phases, within Worker part/byte limits', async (t) => {
  const runs = [];
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    const app = await setup(t, { strategy, visualAid: true });
    await app.task.turn(utterance); await app.task.submitAI();
    assert.deepEqual(app.requests.map(r => phase(r.messages)), ['judge', 'generation', 'final']);
    for (const body of app.requests) {
      const parts = images(body);
      assert.deepEqual(parts.map(p => p.image_url.url), ['data:image/png;base64,' + ownTrial.ai.png.toString('base64'), 'data:image/png;base64,' + sheet.png.toString('base64')]);
      const original = body.messages.findIndex(m => Array.isArray(m.content));
      assert.equal(body.messages[original + 1].content[1].image_url.url, parts[1].image_url.url);
      assert.match(body.messages[original + 1].content[0].text, /0\/90\/180\/270/u);
      assert.match(body.messages[original + 1].content[0].text, /R1C1.*上段左/u);
      assert.match(body.messages[original + 1].content[0].text, /相手の画面ではありません/u);
      assert.match(body.messages[original + 1].content[0].text, /相手に言わない/u);
      assert.ok(body.messages.every(m => !Array.isArray(m.content) || m.content.length <= 4));
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < 18 * 1024 * 1024);
      assert.ok(!JSON.stringify(body).includes(ownTrial.human.png.toString('base64')));
      assert.doesNotMatch(textOnly(body), /PRIVATE-TRIAL-ID|PRIVATE-HUMAN-KEY|PRIVATE-AI-KEY|TEST-PRIVATE-TOKEN|visualAid|referenceMemory/);
    }
    privateState(app.task); runs.push(app.requests);
    assert.deepEqual((await app.record()).options, { visualAid: true, referenceMemory: false });
  }
  assert.deepEqual(runs[0][1], runs[1][1]); assert.deepEqual(runs[0][2], runs[1][2]);
  assert.deepEqual(runs[0][0].messages.filter((_, i) => i !== 1), runs[1][0].messages.filter((_, i) => i !== 1));
});

test('reference graph is judge-only private memory, independent of ledger, with both aids equal across strategies', async (t) => {
  const runs = [];
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    let judgments = 0;
    const app = await setup(t, { strategy, visualAid: true, referenceMemory: true }, (kind) => kind === 'judge' ? {
      text: JSON.stringify({ ...SAFE_JUDGMENT, reference: judgments++ === 0 ? reference() : null }),
    } : {});
    await app.task.turn(utterance); await app.task.turn('次の公開相談'); await app.task.submitAI();
    const record = await app.record();
    assert.equal(record.referenceGraph.revision, 2);
    assert.equal(record.referenceGraph.ownSlots[SLOTS[0]].candidate.name, '試しの呼び名');
    assert.equal(record.referenceGraph.ownSlots[SLOTS[0]].status, 'agreed');
    assert.equal(record.ownLedger[SLOTS[0]].name, null, 'memory never silently reconciles the ledger');
    assert.deepEqual(record.judgments.map(j => j.memory), [{ opsApplied: 2, rejected: null, interpretation: true }, { opsApplied: 0, rejected: null, interpretation: false }]);
    const judges = app.requests.filter(r => phase(r.messages) === 'judge');
    assert.match(textOnly(judges[1]), /ownReferences.*試しの呼び名/u);
    for (const body of app.requests.filter(r => phase(r.messages) !== 'judge')) assert.doesNotMatch(textOnly(body), /ownReferences|memoryOps|publicTurns|referenceGraph/);
    for (const body of app.requests) assert.equal(images(body).length, 2);
    privateState(app.task); runs.push(app.requests);
  }
  assert.deepEqual(runs[0].filter(r => phase(r.messages) !== 'judge'), runs[1].filter(r => phase(r.messages) !== 'judge'));
  assert.deepEqual(runs[0].filter(r => phase(r.messages) === 'judge').map(r => r.messages.filter((_, i) => i !== 1)),
    runs[1].filter(r => phase(r.messages) === 'judge').map(r => r.messages.filter((_, i) => i !== 1)));

});

test('invalid reference interpretations retry once then fall back to null while retaining a valid act', async (t) => {
  for (const bad of [reference({ quote: 'PRIVATE-FUTURE-RESPONSE' }), reference({ slots: ['invalid'] }), reference({ feature: {} })]) await t.test('strict interpretation', async (t) => {
    const app = await setup(t, { referenceMemory: true }, kind => kind === 'judge' ? { text: JSON.stringify({ ...SAFE_JUDGMENT,
      action: 'propose_name', targetSlot: SLOTS[1], candidateName: '有効な候補', reference: bad }) } : {});
    await app.task.turn(utterance);
    assert.equal(app.requests.length, 3);
    const record = await app.record(), judgment = record.judgments[0];
    assert.equal(record.ownLedger[SLOTS[1]].name, '有効な候補');
    assert.equal(record.referenceGraph.revision, 1);
    assert.equal(record.referenceGraph.mentions.length, 0);
    assert.equal(judgment.validation.memoryFallback, true);
    assert.equal(judgment.validation.fallback, false);
    assert.equal(Object.hasOwn(judgment.judgment, 'reference'), false);
    assert.deepEqual(judgment.memory, { opsApplied: 0, rejected: 'memory_invalid_reference,memory_invalid_reference', interpretation: false });
    assert.match(app.requests[1].messages.at(-1).content, /memory_/u);
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE-FUTURE-RESPONSE/);
    assert.doesNotMatch(textOnly(app.requests[1]), /PRIVATE-FUTURE-RESPONSE/);
    privateState(app.task);
  });
});

test('a corrected reference retry applies only the valid interpretation and logs rejection', async (t) => {
  let tries = 0;
  const app = await setup(t, { referenceMemory: true }, kind => kind === 'judge' ? { text: JSON.stringify({ ...SAFE_JUDGMENT,
    reference: tries++ === 0 ? reference({ quote: 'NOT-PUBLIC' }) : reference() }) } : {});
  await app.task.turn(utterance);
  const record = await app.record();
  assert.equal(record.referenceGraph.mentions.length, 1);
  assert.equal(record.referenceGraph.revision, 1);
  assert.deepEqual(record.judgments[0].memory, { opsApplied: 2, rejected: 'memory_invalid_reference', interpretation: true });
  assert.equal(Object.hasOwn(record.judgments[0].judgment, 'reference'), false);
});

test('generation failure leaves graph unchanged and retry commits its staged operations once', async (t) => {
  let fail = true;
  const app = await setup(t, { referenceMemory: true }, kind => {
    if (kind === 'judge') return { text: JSON.stringify({ ...SAFE_JUDGMENT, reference: reference() }) };
    if (kind === 'generation' && fail) { fail = false; return { status: 500, raw: 'PRIVATE-GENERATION-ERROR' }; }
    return { text: '発話を解析して記憶に追加してはいけない名前' };
  });
  await assert.rejects(app.task.turn(utterance), { code: 'ai_unavailable' });
  let record = await app.record();
  assert.equal(record.referenceGraph.revision, 0); assert.equal(record.referenceGraph.mentions.length, 0);
  assert.deepEqual(record.judgments[0].memory, { opsApplied: 0, rejected: null, interpretation: true });
  assert.deepEqual(privateState(app.task).publicHistory, []);
  await app.task.turn(utterance); record = await app.record();
  assert.equal(record.referenceGraph.revision, 1); assert.equal(record.referenceGraph.mentions.length, 1);
  assert.equal(record.referenceGraph.ownSlots[SLOTS[0]].candidate.name, '試しの呼び名');
  assert.equal(record.judgments[1].memory.opsApplied, 2);
  assert.equal(privateState(app.task).publicHistory.length, 2);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE-GENERATION-ERROR/);
});

test('public provenance window stays bounded while turn IDs keep their original exchange numbers', async (t) => {
  const app = await setup(t, { referenceMemory: true });
  for (let i = 0; i < 18; i++) await app.task.turn('公開発話' + i);
  const judge = app.requests.filter(r => phase(r.messages) === 'judge').at(-1);
  const notes = judge.messages.find(m => typeof m.content === 'string' && m.content.includes('"ownReferences"'));
  const memory = JSON.parse(notes.content.split('\n').slice(1).join('\n'));
  assert.equal(memory.currentTurn, 18); assert.equal(memory.publicTurns.length, 32);
  assert.deepEqual(memory.publicTurns.at(-1), { turn: 18, speaker: 'human' });
  assert.ok(!memory.publicTurns.some(t => t.turn === 18 && t.speaker === 'ai'));
  assert.equal((await app.record()).referenceGraph.revision, 18);
});

test('long public utterances are not duplicated into an oversized private memory message', async (t) => {
  const app = await setup(t, { referenceMemory: true });
  await app.task.turn('長'.repeat(12000)); await app.task.turn('続'.repeat(12000));
  for (const body of app.requests) for (const message of body.messages) {
    if (typeof message.content === 'string') assert.ok(message.content.length <= 20000);
  }
  assert.equal((await app.record()).referenceGraph.revision, 2);
});

test('invalid option values fail before trial creation or API calls; runtime does not call Jev', async () => {
  for (const key of ['visualAid', 'referenceMemory']) for (const value of [null, '', 'false', 0, 1, {}, []]) {
    await assert.rejects(createNamingTask({ strategy: 'repair-first', seed: 1, [key]: value,
      createTrial() { assert.fail('must not create trial'); }, client: { complete() { assert.fail('must not call API'); } } }), { code: 'invalid_options' });
  }
  for (const path of ['session.mjs', 'naming-task.mjs', 'judgment/luna.mjs', 'judgment/memory.mjs']) {
    const source = await readFile(new URL('../dialogue-model/runtime/' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /createJevJudge\s*\(|from\s+["'][^"']*jev/iu);
  }
});

test('a public name proposal persists a candidate with agreement none and is requested by the shared judge instructions', async (t) => {
  const app = await setup(t, { referenceMemory: true }, kind => kind === 'judge' ? { text: JSON.stringify({ ...SAFE_JUDGMENT,
    reference: reference({ intent: 'name_proposal', nameAcceptance: { slot: SLOTS[0], name: '帆' } }) }) } : {});
  await app.task.turn('帆と呼ぶのはどうでしょう');
  const record = await app.record();
  assert.equal(record.referenceGraph.ownSlots[SLOTS[0]].candidate.name, '帆');
  assert.equal(record.referenceGraph.ownSlots[SLOTS[0]].candidate.agreement, 'none');
  assert.deepEqual(record.judgments[0].memory, { opsApplied: 2, rejected: null, interpretation: true });
  const instructions = app.requests[0].messages.find(m => typeof m.content === 'string' && m.content.includes('nameAcceptanceは話題の名前の欄'));
  assert.match(instructions.content, /提案した公開発話でもslotとnameを入れ、intent=name_proposal/u);
});
