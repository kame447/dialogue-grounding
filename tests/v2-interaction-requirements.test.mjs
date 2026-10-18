import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNamingTask } from '../dialogue-model/runtime/naming-task.mjs';
import { createTrial, SLOTS } from '../dialogue-model/runtime/stimuli/board.mjs';
import { scoreTrial } from '../dialogue-model/runtime/scoring.mjs';
import { JUDGE_POLICIES, publicMessages, TASK_INSTRUCTIONS_V2 } from '../dialogue-model/runtime/judgment/instructions.mjs';
import { createLayoutsV2, createTrialV2, participantView, modelView,
  BOARD_WIDTH, BOARD_HEIGHT } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createHumanMessageQueue } from '../dialogue-model/runtime/web/human-message-queue.mjs';
import { createLunaJudge } from '../dialogue-model/runtime/judgment/luna.mjs';
import { createOwnLedger } from '../dialogue-model/runtime/judgment/schema.mjs';

// Independent acceptance oracles. All messages/names/images are synthetic;
// no provider client, credentials, model calls, browser dependency or disk logs.
// Pending v2 cases really execute against production modules. TODO is explicit
// until the parent wires v2; V2_ACCEPTANCE_STRICT=1 makes those failures fatal.
// A TODO run is NOT evidence that the five v2 requirements have been satisfied.
const strict = process.env.V2_ACCEPTANCE_STRICT === '1';
function requirement(name, pending, run) {
  test(name, { timeout: 5000, ...(pending && !strict ? { todo: pending } : {}) }, run);
}
const ownImage = { mimeType: 'image/png', base64: Buffer.from('synthetic-own-image').toString('base64') };
const PUBLIC = ['synthetic public message alpha', 'synthetic public message beta'];
const REPLY = ['synthetic stale reply', 'synthetic current reply'];
const NAME = ['synthetic obsolete name', 'synthetic current name'];
const PRIVATE = 'SYNTHETIC_RESEARCHER_ONLY_CANARY';
const act = (candidateName) => ({ action: 'propose_name', targetSlot: SLOTS[0], candidateName,
  discriminatingFeature: null, note: PRIVATE });
const gate = () => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  return { entered: entered.promise, signal: entered.resolve,
    wait: released.promise, release: released.resolve };
};

test('v2 scatter: six independent centers cover both board axes, remain separate, and reproduce by seed', () => {
  const signatures = new Set();
  // Deliberately use different seeds from the layout author's fixtures.
  for (const seed of [5, 23, 61, 271, 8191, -37, 104729]) {
    const layout = createLayoutsV2({ seed });
    assert.deepEqual(createLayoutsV2({ seed }), layout);
    for (const side of ['human', 'ai']) {
      const entries = layout[side];
      assert.equal(entries.length, 6);
      assert.equal(new Set(entries.map((p) => p.id)).size, 6);
      for (const [axis, dimension] of [['x', BOARD_WIDTH], ['y', BOARD_HEIGHT]]) {
        const values = entries.map((p) => p.center[axis]);
        assert.equal(new Set(values).size, 6, 'all centers must differ on each axis; reject fixed 2x3 grids');
        assert.ok(Math.max(...values) - Math.min(...values) > dimension * 0.45,
          'figures must occupy the board rather than a small central cluster');
      }
      for (let i = 0; i < entries.length; i++) {
        const a = entries[i].bbox;
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= BOARD_WIDTH && a.y + a.h <= BOARD_HEIGHT);
        for (let j = i + 1; j < entries.length; j++) {
          const b = entries[j].bbox;
          assert.ok(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y,
            'silhouettes need unambiguous, nonoverlapping hit regions');
        }
      }
      signatures.add(JSON.stringify(entries.map(({ center }) => center)));
    }
  }
  assert.equal(signatures.size, 14, 'seed and participant must both affect scatter coordinates');
});

test('v2 click map: own exterior geometry and local IDs only, with no partner or gold fields', () => {
  const trial = createTrialV2({ seed: 271 });
  trial.key = { human: PRIVATE, ai: PRIVATE };
  trial.human.scene.gold = PRIVATE;
  trial.human.scene.shapes.forEach((shape) => {
    shape.figureId = PRIVATE; shape.partner = PRIVATE; shape.centroid.gold = PRIVATE;
  });
  trial.ai.anchors.forEach((anchor) => { anchor.partner = PRIVATE; anchor.bbox.gold = PRIVATE; });
  const scene = participantView(trial), model = modelView(trial);
  assert.deepEqual(Object.keys(scene).sort(), ['height', 'shapes', 'width']);
  assert.equal(scene.shapes.length, 6);
  for (const shape of scene.shapes) {
    assert.deepEqual(Object.keys(shape).sort(), ['centroid', 'id', 'path']);
    assert.deepEqual(Object.keys(shape.centroid).sort(), ['x', 'y']);
    assert.ok(!model.anchors.some((anchor) => anchor.id === shape.id), 'partner must use distinct local IDs');
    assert.ok(/^(?:M[-\d.,L]+Z)+$/u.test(shape.path), 'click path is geometry, without labels or embedded markup');
    assert.ok(!SLOTS.includes(shape.id), 'local IDs cannot encode the old row/column labels');
  }
  assert.ok(!JSON.stringify(scene).includes(PRIVATE));
  assert.ok(!JSON.stringify(model.anchors).includes(PRIVATE));
  const again = participantView(trial);
  scene.shapes[0].centroid.x = -1;
  assert.deepEqual(participantView(trial), again, 'projected click geometry must not mutate the private trial');
});

test('v1 compatibility: shuffled figure correspondence and private final submissions survive', async () => {
  const rendered = createTrial({ seed: 191 });
  const trial = { ...rendered, researcherOnly: PRIVATE, key: Object.fromEntries(
    ['human', 'ai'].map((side) => [side, Object.fromEntries(SLOTS.map((slot) =>
      [slot, PRIVATE + rendered.key[side][slot]]))])) };
  const ids = Object.values(trial.key.human).sort();
  const names = Object.fromEntries(ids.map((id, index) => [id, 'synthetic name ' + index]));
  const submission = (side) => Object.fromEntries(SLOTS.map((slot) => [slot, names[trial.key[side][slot]]]));
  const scored = [], calls = [];
  const task = await createNamingTask({ strategy: 'repair-first', seed: 191, runDir: '',
    createTrial: () => trial,
    scoreTrial(input) { scored.push(structuredClone(input)); return scoreTrial(input); },
    client: { async complete(messages) {
      calls.push(structuredClone(messages));
      return { text: JSON.stringify(submission('ai')), model: 'synthetic-only' };
    } },
  });
  const pending = await task.submitAI();
  assert.equal(pending.aiSubmitted, true);
  assert.equal(scored.length, 0, 'the scorer must wait for both private commitments');
  assert.equal(Object.hasOwn(pending, 'aiSubmission'), false);
  assert.equal(Object.hasOwn(pending, 'result'), false);
  assert.ok(!JSON.stringify(pending).includes('synthetic name '), 'AI names must remain private before human commitment');
  const done = await task.submitHuman(submission('human'));
  assert.equal(scored.length, 1);
  assert.equal(done.result.matchedCount, 6);
  assert.equal(done.result.success, true);
  assert.ok(done.result.figures.every((row) => row.human.slot !== row.ai.slot));
  assert.deepEqual(done.publicHistory, [], 'private submissions must not be published as chat');
  assert.ok(!JSON.stringify(calls).includes(PRIVATE), 'gold correspondence must never reach the model');
  assert.ok(!JSON.stringify(calls).includes(trial.human.png.toString('base64')), 'partner image must never reach the model');
  assert.equal(Object.hasOwn(done, 'key'), false);
});

test('public history transport preserves consecutive human messages and strips attached metadata', () => {
  assert.deepEqual(publicMessages([
    { role: 'user', content: PUBLIC[0], gold: PRIVATE },
    { role: 'user', content: PUBLIC[1], futureUtterance: PRIVATE },
    { role: 'assistant', content: REPLY[1], ledger: PRIVATE },
  ]), [
    { role: 'user', content: PUBLIC[0] }, { role: 'user', content: PUBLIC[1] },
    { role: 'assistant', content: REPLY[1] },
  ]);
});

test('v2 queue: rapid human messages invalidate stale reply and staged private ledger without overlapping requests', { timeout: 5000 }, async (t) => {
    const held = gate(), calls = [];
    t.after(() => held.release());
    let active = 0, maximum = 0;
    const initialPrivateState = { ownLedger: { local: { name: null } }, judgmentHistory: [] };
    const queue = createHumanMessageQueue({ now: () => 0, initialPrivateState,
      async runAiTurn(request) {
        active++; maximum = Math.max(maximum, active); calls.push(request);
        const index = calls.length - 1;
        request.privateState.ownLedger.local.name = NAME[index];
        request.privateState.judgmentHistory.push({ name: NAME[index] });
        try {
          // Deliberately ignore AbortSignal: stale checks must protect commits.
          if (index === 0) { held.signal(); await held.wait; }
          return { text: REPLY[index], privateState: request.privateState };
        } finally { active--; }
      },
    });
    const first = queue.enqueue({ clientId: 'first', text: PUBLIC[0] });
    await held.entered;
    const second = queue.enqueue({ clientId: 'second', text: PUBLIC[1] });
    try {
      assert.notEqual(first.event.id, second.event.id);
      assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), PUBLIC,
        'both human messages must be public while generation is pending');
      assert.deepEqual(queue.getSnapshot().events.map((event) => event.speaker), ['human', 'human']);
      assert.deepEqual(queue.getPrivateState(), initialPrivateState, 'staged edits must not leak before commit');
      assert.equal(calls[0].signal.aborted, true);
      assert.equal(calls.length, 1, 'replacement transport waits for the stale request to settle');
    } finally { held.release(); }
    await queue.whenIdle();
    assert.equal(maximum, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].events.map((event) => event.text), PUBLIC);
    assert.deepEqual(calls[1].events.map((event) => event.turn), [1, 2], 'actual events, not paired dialogue rounds, own citation numbers');
    assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), [...PUBLIC, REPLY[1]]);
    assert.deepEqual(queue.getSnapshot().events.map((event) => event.speaker), ['human', 'human', 'ai']);
    assert.deepEqual(queue.getPrivateState(), { ownLedger: { local: { name: NAME[1] } }, judgmentHistory: [{ name: NAME[1] }] });
    assert.ok(!JSON.stringify(queue.getSnapshot()).includes(NAME[1]), 'participant event state cannot expose private names');
  });

test('v2 queue: errors retain accepted events, explicit retry commits once and client retry does not duplicate', async () => {
  let count = 0;
  const queue = createHumanMessageQueue({ now: () => 0, initialPrivateState: { revision: 0 },
    async runAiTurn(request) {
      count++;
      if (count === 1) { request.privateState.revision = 900; throw new Error(PRIVATE); }
      return { text: REPLY[1], privateState: { revision: 1 } };
    },
  });
  const input = { clientId: 'stable-retry-id', text: PUBLIC[0] };
  const receipt = queue.enqueue(input);
  await queue.whenIdle();
  assert.equal(queue.getSnapshot().status, 'error');
  assert.equal(queue.getSnapshot().errorCode, 'ai_unavailable');
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), [PUBLIC[0]]);
  assert.deepEqual(queue.getPrivateState(), { revision: 0 });
  assert.ok(!JSON.stringify(queue.getSnapshot()).includes(PRIVATE), 'raw failures cannot reach public state');
  assert.deepEqual(queue.enqueue(input), { ...receipt, duplicate: true });
  assert.equal(count, 1, 'duplicate admission must not implicitly replay failed AI work');
  await queue.retry();
  await queue.retry();
  assert.equal(count, 2, 'retrying an idle queue must not create another AI reply');
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), [PUBLIC[0], REPLY[1]]);
  assert.deepEqual(queue.getPrivateState(), { revision: 1 });
});

function assertHolisticContract(messages, label) {
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  // Boolean assertions avoid dumping complete prompts or image bodies on error.
  assert.ok(instructions.includes(TASK_INSTRUCTIONS_V2), label + ': the shared v2 base must reach the actual request');
  assert.ok(/(?:全体|見立て).*(?:先|まず|優先)|(?:先|まず).*(?:全体|見立て)/u.test(instructions), label + ': lead with a whole-shape interpretation');
  assert.ok(/(?:身近|たとえ|比喩|見立て|アナロジー)/u.test(instructions), label + ': everyday analogy is available');
  assert.ok(/(?:挨拶|開始|初手|最初|冒頭|初回).*(?:分析|幾何|詳細)|(?:分析|幾何|詳細).*(?:初手|最初|冒頭|初回)/u.test(instructions),
    label + ': explicitly prevent unsolicited analytical opening');
  assert.ok(/(?:迷う|詳細|確認|2つ以上|不明確|複数).*(?:限って|必要|場合|とき)/u.test(instructions), label + ': features are conditional on ambiguity');
  assert.ok(/(?:特徴|形状).*(?:1つ|一つ)|(?:1つ|一つ).*(?:特徴|形状)/u.test(instructions), label + ': use one discriminating feature');
}

test('v2 judge: holistic-first shared base preserves the sole strategy policy difference', async () => {
    const executions = [];
    for (const strategy of ['repair-first', 'bypass-enabled']) {
      const calls = [];
      const judge = createLunaJudge({ async complete(messages) {
          calls.push(structuredClone(messages));
          return { text: JSON.stringify(act(NAME[1])) };
        },
      });
      await judge.judge({ version: 2, strategy, image: ownImage, ownLedger: createOwnLedger(),
        publicHistory: [{ role: 'user', content: PUBLIC[0] }] });
      assert.equal(calls.length, 1, 'one valid typed judgment must not incur a format retry');
      assertHolisticContract(calls[0], 'judge');
      assert.ok(!JSON.stringify(calls).includes(PRIVATE), 'judge notes never reach public generation');
      executions.push(calls[0]);
    }
    assert.notEqual(JUDGE_POLICIES['repair-first'], JUDGE_POLICIES['bypass-enabled']);
    assert.ok(/確認|修復/u.test(JUDGE_POLICIES['repair-first']));
    assert.ok(/保留/u.test(JUDGE_POLICIES['bypass-enabled']));
    assert.ok(/移行|別対象/u.test(JUDGE_POLICIES['bypass-enabled']));
    const removePolicy = (messages) => messages.filter((m) =>
      !Object.values(JUDGE_POLICIES).includes(m.content));
    assert.ok(JSON.stringify(removePolicy(executions[0])) === JSON.stringify(removePolicy(executions[1])),
      'strategy policy must be the only judge-request difference');
  });

const runtimeRoot = process.env.V2_RUNTIME_ROOT ?? new URL('../dialogue-model/runtime/', import.meta.url).pathname;
async function optionalRuntimeModule(file) {
  const url = pathToFileURL(resolve(runtimeRoot, file));
  try { return await import(url.href); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === url.href) return null;
    throw error; // A broken dependency is a failure, never an unavailable-contract TODO.
  }
}
const dialogueV2 = await optionalRuntimeModule('v2/dialogue-v2.mjs');
const dialoguePending = !dialogueV2 && 'Integrate runtime/v2/dialogue-v2.mjs, or set V2_RUNTIME_ROOT to the parent runtime directory.';
const namingV2 = await optionalRuntimeModule('v2/naming-task-v2.mjs');
const namingPending = !namingV2 && 'Integrate runtime/v2/naming-task-v2.mjs and enable its final privacy/submission cases.';

async function taskFixture(extra = {}) {
  assert.ok(namingV2, 'v2 naming task is not yet integrated');
  const trial = createTrialV2({ seed: 104729 }), calls = [], scored = [];
  const ids = Object.values(trial.key.human).sort();
  const names = Object.fromEntries(ids.map((id, index) => [id, 'synthetic final name ' + index]));
  const submission = (side) => Object.fromEntries(Object.entries(trial.key[side]).map(([slot, id]) => [slot, names[id]]));
  const task = await namingV2.createNamingTaskV2({ strategy: 'repair-first', seed: trial.seed, runDir: '',
    createTrial: () => trial,
    scoreTrial(input) {
      scored.push(structuredClone(input));
      return { success: true, matchedCount: 6, total: 6, provisional: true,
        figures: Object.entries(input.key.human).map(([slot, id]) => {
          const aiSlot = Object.keys(input.key.ai).find((key) => input.key.ai[key] === id);
          return { figureId: id, human: { slot, rawName: input.humanSubmission[slot] },
            ai: { slot: aiSlot, rawName: input.aiSubmission[aiSlot] }, matched: true };
        }) };
    },
    client: { async complete(messages, options) {
      calls.push({ phase: options.phase, messages: structuredClone(messages) });
      return { text: options.phase === 'judgment' ? JSON.stringify({ ...act(NAME[1]), targetSlot: trial.ai.anchors[0].id }) :
        options.phase === 'final_submission' ? JSON.stringify(submission('ai')) : REPLY[1], model: 'synthetic-only' };
    } }, ...extra,
  });
  return { task, trial, calls, scored, submission };
}

requirement('v2 participant state: no seed or researcher mapping can reconstruct the deterministic partner board', namingPending, async () => {
  const { task, trial } = await taskFixture();
  const state = task.getState();
  assert.equal(Object.hasOwn(state, 'seed'), false, 'public seed permits createTrialV2({seed}) to reconstruct partner image and gold key');
  assert.equal(Object.hasOwn(state, 'key'), false);
  assert.equal(Object.hasOwn(state, 'privateState'), false);
  assert.equal(Object.hasOwn(state, 'aiSubmission'), false);
  assert.equal(Object.hasOwn(state, 'result'), false);
  const serialized = JSON.stringify(state);
  assert.ok(!trial.ai.anchors.some((anchor) => serialized.includes(anchor.id)), 'partner local IDs must be private');
  assert.ok(!serialized.includes(trial.ai.png.toString('base64')), 'partner image must be private');
});

for (const first of ['human', 'ai']) requirement(`v2 final names: withheld until both commitments, scored once (${first} first)`, namingPending, async () => {
  const { task, calls, scored, submission, trial } = await taskFixture();
  const publicBefore = task.getState().events;
  if (first === 'human') await task.submitHuman({ names: submission('human') });
  else await task.submitAI();
  const pending = task.getState();
  assert.equal(scored.length, 0);
  assert.equal(Object.hasOwn(pending, 'result'), false);
  assert.equal(Object.hasOwn(pending, 'aiSubmission'), false);
  assert.ok(!JSON.stringify(pending).includes('synthetic final name '), 'private names cannot be published before both commitments');
  if (first === 'human') await task.submitAI();
  else await task.submitHuman({ names: submission('human') });
  const complete = task.getState();
  assert.equal(scored.length, 1, 'either submission order must trigger scoring exactly once');
  assert.equal(complete.result.matchedCount, 6);
  assert.deepEqual(complete.events, publicBefore, 'private final requests and names are not public events');
  assert.ok(complete.result.figures.every((row) => Object.keys(row.ai).every((key) => key === 'rawName')),
    'final participant display may show AI names without partner IDs/geometry');
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.messages).includes(trial.human.png.toString('base64')), 'private human image never reaches final model request');
    assert.ok(!JSON.stringify(call.messages).includes('"key"'), 'gold mapping never reaches final model request');
  }
});

requirement('v2 task retry: accepted human message survives generation failure without replay or raw error leakage', namingPending, async () => {
  let attempts = 0;
  const { task } = await taskFixture({ client: { async complete(_messages, options) {
    if (options.phase === 'judgment') return { text: JSON.stringify({ action: 'accept', targetSlot: null,
      candidateName: null, discriminatingFeature: null, note: null }) };
    if (attempts++ === 0) throw new Error(PRIVATE);
    return { text: REPLY[1] };
  } } });
  const opening = task.getState().events.map((event) => event.text);
  const receipt = task.message(PUBLIC[0], 'task-stable-client-id');
  assert.ok(receipt.eventId);
  await task.whenIdle();
  const failed = task.getState();
  assert.equal(failed.aiStatus, 'error');
  assert.deepEqual(failed.events.map((event) => event.text), [...opening, PUBLIC[0]]);
  assert.ok(!JSON.stringify(failed).includes(PRIVATE));
  await task.retry();
  const done = task.getState();
  assert.equal(done.aiStatus, 'idle');
  assert.deepEqual(done.events.map((event) => event.text), [...opening, PUBLIC[0], REPLY[1]]);
  assert.equal(attempts, 2, 'explicit retry resumes AI work without requiring another human event');
});

requirement('v2 invalid final response: one bounded format retry, no scoring and no public pseudo-turn', namingPending, async () => {
  const phases = [];
  const { task, scored, submission } = await taskFixture({ client: { async complete(_messages, options) {
    phases.push(options.phase);
    return { text: JSON.stringify({ researcherOnly: PRIVATE }) };
  } } });
  const publicBefore = task.getState().events;
  await task.submitHuman({ names: submission('human') });
  await assert.rejects(task.submitAI());
  assert.deepEqual(phases, ['final_submission', 'final_submission'], 'invalid format receives exactly one retry');
  assert.equal(scored.length, 0);
  const state = task.getState();
  assert.equal(Object.hasOwn(state, 'result'), false);
  assert.deepEqual(state.events, publicBefore);
  assert.ok(!JSON.stringify(state).includes(PRIVATE), 'raw invalid final response stays private');
});

requirement('v2 actual dialogue adapter: shared holistic generator, own image only and policy-only condition difference', dialoguePending, async () => {
  assert.ok(dialogueV2, 'v2 dialogue adapter is not yet integrated');
  const own = modelView(createTrialV2({ seed: 8191 }));
  const executions = [];
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    const calls = [];
    const adapter = dialogueV2.createDialogueV2({ strategy, image: { mimeType: own.mimeType, base64: own.png.toString('base64') },
      anchors: own.anchors, client: { async complete(messages, options) {
        calls.push({ phase: options.phase, messages: structuredClone(messages) });
        return { text: options.phase === 'judgment' ? JSON.stringify({ ...act(NAME[1]), targetSlot: own.anchors[0].id }) : REPLY[1] };
      } },
    });
    const initial = adapter.initialPrivateState();
    const events = PUBLIC.map((text, index) => ({ id: 'synthetic-event-' + index, seq: index + 1, turn: index + 1, speaker: 'human', text, gold: PRIVATE }));
    const result = await adapter.runAiTurn({ events, privateState: initial, lastEventId: events.at(-1).id,
      signal: new AbortController().signal });
    assert.deepEqual(calls.map((call) => call.phase), ['judgment', 'generation']);
    for (const call of calls) {
      assertHolisticContract(call.messages, call.phase);
      assert.ok(!JSON.stringify(call.messages).includes(PRIVATE), 'private event metadata and judgment notes must be stripped');
      const visible = call.messages.filter((message) => message.role === 'user' && typeof message.content === 'string');
      assert.deepEqual(visible, PUBLIC.map((content) => ({ role: 'user', content })), 'all consecutive human messages reach both stages');
      const images = call.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
      assert.equal(images.length, 1);
      assert.ok(images[0].image_url.url === 'data:image/png;base64,' + own.png.toString('base64'), 'only own board reaches both model stages');
    }
    assert.ok(Object.values(initial.ledger).every((entry) => entry.name === null), 'adapter cannot mutate its initial private state');
    assert.equal(result.privateState.ledger[own.anchors[0].id].name, NAME[1]);
    assert.equal(result.privateState.judgments[0].turnIndex, 2, 'actual event sequence must own judgment provenance');
    executions.push(calls);
  }
  assert.ok(JSON.stringify(executions[0][1]) === JSON.stringify(executions[1][1]), 'generator inputs remain identical between strategies');
  const withoutPolicy = (call) => call.messages.filter((message) => !Object.values(JUDGE_POLICIES).includes(message.content));
  assert.ok(JSON.stringify(withoutPolicy(executions[0][0])) === JSON.stringify(withoutPolicy(executions[1][0])), 'only judge policy differs');
});

requirement('v2 real adapter plus queue: superseded generation cannot commit actual ledger or judgment history', dialoguePending, async (t) => {
  assert.ok(dialogueV2, 'v2 dialogue adapter is not yet integrated');
  const held = gate(); t.after(() => held.release());
  const own = modelView(createTrialV2({ seed: 23 }));
  let generations = 0;
  const adapter = dialogueV2.createDialogueV2({ strategy: 'bypass-enabled', referenceMemory: true,
    image: { mimeType: own.mimeType, base64: own.png.toString('base64') }, anchors: own.anchors,
    client: { async complete(_messages, options) {
      if (options.phase === 'judgment') return { text: JSON.stringify({ ...act(generations ? NAME[1] : NAME[0]), targetSlot: own.anchors[0].id }) };
      if (generations++ === 0) { held.signal(); await held.wait; return { text: REPLY[0] }; }
      return { text: REPLY[1] };
    } },
  });
  const initial = adapter.initialPrivateState();
  const queue = createHumanMessageQueue({ runAiTurn: adapter.runAiTurn, initialPrivateState: initial, now: () => 0 });
  queue.enqueue({ clientId: 'real-first', text: PUBLIC[0] }); await held.entered;
  queue.enqueue({ clientId: 'real-second', text: PUBLIC[1] });
  try {
    assert.deepEqual(queue.getPrivateState(), initial);
    assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), PUBLIC);
  } finally { held.release(); }
  await queue.whenIdle();
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), [...PUBLIC, REPLY[1]]);
  const committed = queue.getPrivateState();
  assert.equal(committed.ledger[own.anchors[0].id].name, NAME[1]);
  assert.equal(committed.judgments.length, 1);
  assert.equal(committed.judgments[0].turnIndex, 2);
  assert.ok(!JSON.stringify(committed).includes(NAME[0]), 'superseded real judgment cannot pollute ledger, graph, or committed diagnostics');
  assert.ok(!JSON.stringify(queue.getSnapshot()).includes(NAME[1]), 'private agreement memory cannot leak into participant polling');
});

// Optional read-only override lets the UI owner run these same acceptance cases
// before the parent's merge. It never copies or changes production files.
const webRoot = process.env.V2_WEB_ROOT ?? new URL('../dialogue-model/runtime/web/', import.meta.url).pathname;
const [html, script, css] = await Promise.all(['index.html', 'app.js', 'style.css'].map((file) =>
  readFile(resolve(webRoot, file), 'utf8')));
const uiPending = !/<dialog\b[^>]*id="name-dialog"/u.test(html) &&
  'Integrate CreamBoltzmann v2 web assets, or set V2_WEB_ROOT to their web directory for isolated UI verification.';

// This harness only implements DOM plumbing. The shipped app owns all scene,
// selection, naming, validation, event queue and request serialization behavior.
// It is not a browser layout engine; visual/browser QA remains a separate check.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map();
    this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this._text = '';
    this.scrollTop = 0; this.clientHeight = 400;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = [...nodes]; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  querySelectorAll(selector) {
    const matches = (node) => selector.split(',').some((part) => {
      const match = part.trim().match(/^([\w-]+)(?:\[([\w-]+)=["']?([^\]"']+)["']?\])?$/u);
      return match && node.tagName === match[1] && (!match[2] || (node.getAttribute(match[2]) ?? node[match[2]]) === match[3]);
    });
    return this.children.flatMap((node) => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  fire(type, fields = {}) {
    const event = { target: this, preventDefault() {}, ...fields };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  requestSubmit() { if (!this.disabled) this.fire('submit'); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollTo({ top }) { this.scrollTop = top; }
  get scrollHeight() { return this.children.length * 120; }
  getBBox() {
    const coords = [...(this.getAttribute('d') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(([value]) => Number(value));
    const x = coords.filter((_, i) => i % 2 === 0), y = coords.filter((_, i) => i % 2 === 1);
    return { x: Math.min(...x), y: Math.min(...y), width: Math.max(...x) - Math.min(...x), height: Math.max(...y) - Math.min(...y) };
  }
  get elements() { return Object.fromEntries(this.querySelectorAll('input').map((node) => [node.name, node])); }
}

function uiFixture() {
  const scene = participantView(createTrialV2({ seed: 61 }));
  return { trial: { version: 2, trialId: 'synthetic-ui-trial', scene, status: 'dialogue',
    events: [], aiStatus: 'thinking', submitted: false, humanSubmitted: false, aiSubmitted: false }, busy: true };
}

async function mountUI(t, state = uiFixture(), respond) {
  assert.ok(!uiPending, 'v2 naming dialog/scene wiring is unavailable');
  const elements = Object.fromEntries([...html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/gu)]
    .map(([, tag, id]) => [id, new Element(tag)]));
  elements.chat.append(elements.utterance, elements['send-message']);
  elements.submission.append(elements['review-names']);
  elements['name-form'].append(elements['figure-name'], elements['name-unknown'], elements['name-cancel']);
  const nameSave = new Element('button'); nameSave.type = 'submit'; elements['name-form'].append(nameSave);
  const calls = [], timers = new Map();
  let timerId = 0;
  t.after(() => timers.clear());
  runInNewContext(script, {
    document: { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag),
      createElementNS: (_namespace, tag) => new Element(tag),
      createTextNode: (text) => { const node = new Element('text'); node.textContent = text; return node; },
      querySelectorAll: (selector) => Object.values(elements).flatMap((node) => node.querySelectorAll(selector)),
    },
    FormData: class { constructor(form) { this.pairs = form.querySelectorAll('input').map((node) => [node.name, node.value]); }
      get(name) { return this.pairs.find(([key]) => key === name)?.[1]; }
      [Symbol.iterator]() { return this.pairs[Symbol.iterator](); }
    },
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      const value = respond ? await respond(path, body, state) : state;
      return { ok: true, status: 200, json: async () => structuredClone(value) };
    },
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setImmediate(done)); };
  await settle();
  return { elements, calls, settle, state };
}

requirement('v2 UI: correct silhouette opens local naming; unanswered differs from unknown; final names stay off chat', uiPending, async (t) => {
  // Final submission waits for the AI to answer every message, so this starts idle.
  const idle = uiFixture(); idle.trial.aiStatus = 'idle'; idle.busy = false;
  const app = await mountUI(t, idle), e = app.elements;
  const paths = e.board.querySelectorAll('path');
  assert.equal(paths.length, 6);
  assert.equal(e.board.querySelectorAll('text').map((node) => node.textContent).join(''), '', 'initial silhouettes carry no visible labels');
  for (const path of paths) {
    assert.equal(path.getAttribute('role'), 'button');
    assert.equal(path.getAttribute('aria-haspopup'), 'dialog');
    assert.ok(!app.state.trial.scene.shapes.some((shape) => path.getAttribute('aria-label').includes(shape.id)),
      'opaque local IDs cannot become spoken/visible figure labels');
    assert.ok(!/上段|下段|第[一二三四五六1-6]|図形\s*[1-6]|[①②③④⑤⑥]/u.test(path.getAttribute('aria-label')));
  }
  e.submission.fire('submit');
  assert.equal(e['confirm-dialog'].open, false, 'unanswered figures require an explicit choice');
  const expected = {};
  for (const index of [4, 1, 5, 0, 3, 2]) {
    paths[index].fire('click');
    assert.equal(e['name-dialog'].open, true);
    assert.equal(e['figure-preview'].querySelectorAll('path')[0].getAttribute('d'), app.state.trial.scene.shapes[index].path,
      'preview must show exactly the clicked local silhouette');
    const id = app.state.trial.scene.shapes[index].id;
    if (index === 1) { e['name-unknown'].fire('click'); expected[id] = null; }
    else {
      e['figure-name'].value = 'synthetic private answer ' + index;
      expected[id] = e['figure-name'].value;
      e['name-form'].fire('submit');
    }
    assert.equal(e['name-dialog'].open, false);
  }
  assert.equal(app.calls.length, 1, 'clicks, unknown selection and local naming perform no network request');
  assert.ok(!e.history.textContent.includes('synthetic private answer '));
  e.submission.fire('submit');
  assert.equal(e['confirm-dialog'].open, true);
  e['confirm-cancel'].fire('click');
  assert.equal(e['confirm-dialog'].open, false);
  e.submission.fire('submit'); e['confirm-submit'].fire('click'); await app.settle();
  const sent = app.calls.filter((call) => call.path === '/api/names');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { names: expected, confirm: true });
  assert.equal(app.calls.filter((call) => call.path === '/api/message' || call.path === '/api/turn').length, 0,
    'private final naming must not generate a public chat message');
});

requirement('v2 UI: human may compose and submit another message while AI generation is pending', uiPending, async (t) => {
  const held = gate(); t.after(() => held.release());
  const app = await mountUI(t, uiFixture(), async (path, body, state) => {
    if (path === '/api/message') {
      if (body.text === PUBLIC[0]) { held.signal(); await held.wait; }
      return { eventId: body.text === PUBLIC[0] ? 'accepted-alpha' : 'accepted-beta' };
    }
    return state;
  });
  const e = app.elements;
  assert.equal(e.utterance.disabled, false, 'AI thinking must not disable human input');
  assert.equal(e['send-message'].disabled, false);
  e.utterance.value = PUBLIC[0]; e.chat.fire('submit'); await held.entered;
  e.utterance.value = PUBLIC[1]; e.chat.fire('submit');
  try {
    assert.equal(e.utterance.value, '', 'second human message must be admitted immediately');
    assert.equal(e.utterance.disabled, false);
    assert.ok(PUBLIC.every((text) => e.history.textContent.includes(text)), 'both human messages are immediately visible');
  } finally { held.release(); }
  await app.settle();
  assert.deepEqual(app.calls.filter((call) => call.path === '/api/message').map((call) => call.body.text), PUBLIC);
});

requirement('v2 HTML/CSS: transcript has its own scrolling space and enlarged desktop/mobile dialogue panels', uiPending, () => {
  assert.ok(/<ol\b[^>]*id="history"[^>]*role="log"/u.test(html), 'transcript must remain an accessible log');
  const desktop = css.split('@media')[0];
  const declarations = (selector, source) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) => selectors.split(',').map((entry) => entry.trim()).includes(selector))
    .map(([, , rules]) => rules).join(';');
  // The conversation sidebar stretches to the full workspace row height.
  const transcript = declarations('#history', desktop), panel = declarations('.workspace', desktop);
  assert.ok(/overflow-y\s*:\s*auto/u.test(transcript), 'long dialogue must scroll within the transcript');
  assert.ok(/flex\s*:\s*1\b/u.test(transcript), 'transcript must use remaining panel height');
  assert.ok(/height\s*:\s*calc\(100dvh - (?:\d\d|1[0-5]\d)px\)/u.test(panel), 'desktop dialogue gets nearly the full viewport height');
  assert.ok(/min-height\s*:\s*(?:5\d\d|[6-9]\d\d)px/u.test(panel), 'desktop dialogue must exceed the previous compact panel');
  assert.ok(/@media\s*\(max-width\s*:\s*\d{3}px\)\s*\{[^@]*\.workspace\{[^}]*grid-template-columns:1fr/u.test(css), 'small screens stack into one column');
  assert.ok(!/max-height\s*:\s*(?:170|430)px/u.test(transcript), 'old compact transcript cap cannot return');
});
