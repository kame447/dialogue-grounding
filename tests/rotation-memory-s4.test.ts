// S4 and the pre-made rotation memory: a record whose requests carry a `rotation` memory is verified against the independent table in
// diagnostics/parity-verify/turned-view-records.ts (the legends, the layers, the sentences each call adds, the name candidates), never against the runtime.
// The records come from the real runtime and the offline replay (buildRecords); no key, network or study data.
//   1. S4 passes them: four scenes, both strategies, the three stimulus rotation modes, 3/4/6 figures, a memo that lacks one figure's memory.
//   2. A text or a layer line that says one character differently makes only the replay check disagree (mutateRecord rewrites it everywhere it is recorded and carries every hash through).
//   3. The table does not drift from the runtime it copies: every text, the six generation replacements and the layers of all 120 (figure, current rotation) projections.
//   4. The name candidates rule, and a record of an earlier version that carries the memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import * as table from '../dialogue-model/runtime/diagnostics/parity-verify/turned-view-records.ts';
import * as guidance from '../dialogue-model/runtime/decision/rotation-memory-guidance.ts';
import { GENERATION_INSTRUCTIONS_V23, GENERATION_INSTRUCTIONS_V24 } from '../dialogue-model/runtime/v2/generation-prompt-v23.ts';
import { rotationInitialMemo } from '../dialogue-model/runtime/observation/rotation-memo.ts';
import { projectOwnRotationMemory, rotationNameCandidates } from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import { ROTATION_MEMORY_ENTRIES } from '../dialogue-model/runtime/stimuli/rotation-memory-data.ts';
import { buildRecords, OWN, type Label } from './support/s4-v3-records.ts';
import { retargetToMode, type RotationMode } from './support/s4-rotation-records.ts';
import { changeOneChar, editRequests, holds, mutateRecord, positionsOf, requestHashesConsistent } from './support/s4-rotation-mutation.ts';

// The v24 settings of the new version (the same as tests/v24-three-figure-s4.test.ts).
const options = {
  dialoguePolicy: 'holistic_v5', interventionVersion: 'bypass_acceptance_v3', judgmentMaterialVersion: 'jev_repair_quality_v1',
  technicalTrial: { version: 'adaptive_repair_v3' }, generationRetryVersion: 'jev_generation_retry_v24', agreeNameScopeVersion: 'jev_naming_v3',
} as const;
const choose = (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined;
const INTERVENTION = /^intervention\.trial\.0\.attempt\.0\./u;
const statuses = (records: unknown): string[] => interventionChecks(records as never).filter(c => INTERVENTION.test(c.id)).map(c => c.id.split('.').pop() + ':' + c.status);
const ALL_PASS = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:pass'];
const REPLAY_ONLY = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:mismatch'];
const MODES: RotationMode[] = ['relative_pm90', 'relative_0', 'relative_90_180_270'];

// ---- Records ----
type Check = 'off' | 'on';
type Scene = 'accept' | 'confirm' | 'confirm_regenerated' | 'propose_name' | 'request_observation';
/** Bank figure key and the rotation now shown on the AI's screen, per own figure. The first one has a whole noun in its current view that no turned view has (F1 at 270). */
const VIEWS: readonly [string, number][] = [['F1', 270], ['F9', 90], ['F6', 0], ['F11', 180], ['F14', 90], ['F20', 0]];
const projectionOf = ([key, rotation]: readonly [string, number]) => projectOwnRotationMemory({ figureKey: key, rotation })!;
/** `lacking`: the index of an own figure the bundle does not know (it keeps the plain entry without a rotation memory). */
const memoOf = (count: number, lacking?: number) => {
  const anchors = OWN.ownAnchors.slice(0, count);
  return rotationInitialMemo(anchors, new Map(anchors.flatMap((anchor: { id: string }, i: number) => i === lacking ? [] : [[anchor.id, projectionOf(VIEWS[i])] as const])), '2026-01-01T00:00:00.000Z');
};
const firstName = rotationNameCandidates(projectionOf(VIEWS[0]))[0];
// An off draft answers with {"text"} for a confirmation and plain text otherwise; an on draft always names its observation sources.
const draft = (text: string, check: Check, plain = false) => check === 'on' ? JSON.stringify({ text, observationFeatures: [] }) : plain ? text : JSON.stringify({ text });
const finalTurn = (scene: Scene, check: Check, anchorId: string) => {
  const base = { referent: 'figure_0', choose, postGenerationCheck: check, aiExtraction: check === 'on' ? JSON.stringify({ segments: [], visualFeatures: { sources: [] } }) : '[]' };
  const human = `${firstName}のような形に見えます。`;
  const firstNameDraft = () => `では、「${firstName}」にしませんか？`;
  return {
    accept: { human: 'もう一度さっきの図形に戻って特徴を教えてください。', plan: { ...base, action: 'accept', target: 'figure_0', speech: draft('さっきの図形ですね。', check, true) } },
    confirm: { human: 'もう一度さっきの図形に戻って特徴を教えてください。', plan: { ...base, action: 'confirm', target: 'figure_0', speech: draft('もう一つ特徴を確かめさせてください。', check) } },
    // A name proposal is not a visual answer: its draft is plain text and the AI's own claims are an array even when the checks are on.
    // The first draft moves the topic, so the draft is regenerated: the retry message restates the whole action message (the observation sources line included).
    confirm_regenerated: { human: '細い部分はどうつながっていますか？', plan: { ...base, action: 'confirm', target: 'figure_0',
      drafts: [draft('この図形をいったん置いて、次のを見よう。', check), draft('もう一つ特徴を確かめさせてください。', check)],
      choose: (key: string, _criteria: unknown, { generationCalls }: { generationCalls: number }) => key === 'draft_topic_shift' ? generationCalls === 1 ? 'unsupported_shift' : 'within_plan' : choose(key) } },
    propose_name: { human, plan: { ...base, action: 'propose_name', target: 'figure_0', name: firstName, speech: firstNameDraft(), aiExtraction: '[]', act: 'construe',
      extraction: JSON.stringify([{ segmentId: 'shape', quote: human, targets: [anchorId], aspect: 'construal', proposition: human, name: null, linkedIssueId: null, respondsToTurn: null }]),
      choose: (key: string) => key === 'draft_naming' ? 'propose_chosen' : choose(key) } },
    request_observation: { human: 'もう少し詳しく見てください。', plan: { ...base, action: 'confirm', target: 'figure_0', reobserve: true, speech: draft('見てから確かめます。', check),
      choose: (key: string) => key === 'observe_aspect' ? 'construal' : choose(key) } },
  }[scene];
};
const cache = new Map<string, Promise<any>>();
/** The record of one final turn, built once. `lacking` leaves one own figure without a memory. */
function record(scene: Scene, check: Check, { label = 'repair-first' as Label, figures = 3 as 3 | 4 | 6, lacking }: { label?: Label; figures?: 3 | 4 | 6; lacking?: number } = {}): Promise<any> {
  const key = [scene, check, label, figures, lacking].join('/');
  if (!cache.has(key)) cache.set(key, buildRecords({ ...options, label, figureCount: figures, memo: memoOf(figures, lacking) as never,
    turns: [finalTurn(scene, check, OWN.ownAnchors[0].id)] }));
  return cache.get(key)!;
}

// ---- 1. S4 passes a record that carries the memory ----
const SCENES: [Scene, Check][] = [['accept', 'off'], ['confirm', 'on'], ['confirm', 'off'], ['confirm_regenerated', 'on'], ['confirm_regenerated', 'off'], ['propose_name', 'on'], ['propose_name', 'off'],
  ['request_observation', 'off'], ['request_observation', 'on']];
for (const [scene, check] of SCENES) for (const label of ['repair-first', 'bypass-enabled'] as Label[]) {
  test(`${scene} (${check}, ${label}): S4 verifies a record whose requests carry the rotation memory, in all three rotation modes`, async () => {
    const records = await record(scene, check, { label });
    for (const mode of MODES) assert.deepEqual(statuses(mode === 'relative_pm90' ? records : retargetToMode(records, mode)), ALL_PASS, mode);
  });
}
for (const [scene, check, figures] of [['confirm', 'on', 4], ['propose_name', 'off', 4], ['confirm', 'off', 6], ['request_observation', 'on', 6], ['propose_name', 'on', 6]] as const) {
  test(`${scene} (${check}) with ${figures} figures: S4 verifies the record`, async () => {
    assert.deepEqual(statuses(await record(scene, check, { figures })), ALL_PASS);
  });
}
test('a memo that lacks one own figure (the bundle does not know it) keeps that figure without a memory and S4 still verifies the record', async () => {
  const records = await record('confirm', 'on', { lacking: 1 });
  const memo = records.trials[0].attempts[0].observationMemo;
  assert.deepEqual(memo.figures.map((f: { rotation?: unknown }) => f.rotation !== undefined), [true, false, true]);
  assert.deepEqual(statuses(records), ALL_PASS);
});

// ---- 2. One character of what the memory adds ----
/** The texts of the table, with the scenes whose requests carry them (a text can be tried in any record that holds it). */
const TEXTS: [string, string][] = [
  ['nouns legend', table.ROTATION_LEGEND_NOUNS], ['roles legend', table.ROTATION_LEGEND_ROLES], ['common sentence', table.COMMON_DIFFERENT_CONSTRUAL_ROTATION],
  ['match use', table.ROTATION_MATCH_USE], ['accept answer', table.ROTATION_ACCEPT_ANSWER], ['accept backchannel', table.ROTATION_ACCEPT_BACKCHANNEL],
  ['confirm criterion', table.ROTATION_CONFIRM], ['propose_name criterion', table.ROTATION_PROPOSE_NAME],
  ['request_observation criterion', table.ROTATION_REQUEST_OBSERVATION.replace('Lunaへ', 'Terraへ')], ['observation sources', table.ROTATION_FEATURE_SOURCES],
  ['local extraction use', table.EXTRACTION_ROTATION_USE], ['AI extraction use', table.AI_EXTRACTION_ROTATION_USE], ['re-observation use', table.REOBSERVATION_ROTATION_USE],
  ...table.GENERATION_ROTATION_EDITS.map(([, to], i): [string, string] => [`generation replacement ${i + 1}`, to]),
];
const MUTATION_RECORDS: [Scene, Check][] = [['accept', 'off'], ['confirm', 'on'], ['confirm_regenerated', 'on'], ['propose_name', 'on'], ['request_observation', 'off']];
async function recordsHolding(text: string): Promise<any[]> {
  const found: any[] = [];
  for (const [scene, check] of MUTATION_RECORDS) { const records = await record(scene, check); if (holds(records, text)) found.push(records); }
  return found;
}
for (const [name, text] of TEXTS) {
  test(`one character of the ${name} changes: only the replay check disagrees`, async () => {
    const holding = await recordsHolding(text);
    assert.ok(holding.length > 0, `no record carries the ${name}`);
    // Every position is tried in the first record that holds the text; the others get the middle one.
    for (const [i, records] of holding.entries()) for (const at of i === 0 ? positionsOf(text) : [Math.floor(text.length / 2)]) {
      const { records: changed, changed: count } = mutateRecord(records, { from: text, to: changeOneChar(text, at) });
      assert.ok(count > 0);
      assert.equal(requestHashesConsistent(changed), true, 'every request still carries its own hash');
      assert.deepEqual(statuses(changed), REPLAY_ONLY, `${name} at ${at}`);
    }
  });
}
test('a regenerated draft: its retry message restates the action message (the observation sources line included); the restated line changed alone is a replay mismatch', async () => {
  const records = await record('confirm_regenerated', 'on');
  assert.deepEqual(statuses(records), ALL_PASS);
  const line = table.ROTATION_FEATURE_SOURCES;
  const retried = (request: any) => request.provider === 'luna' && request.phase === 'generation' && String(request.payload.messages.at(-1).content).startsWith('公開発話を書き直してください。');
  const only = editRequests(records, retried, payload => {
    const last = payload.messages.at(-1);
    assert.equal(last.content.split(line).length, 2, 'the retry message restates the line once');
    last.content = last.content.replace(line, changeOneChar(line, 20));
  });
  assert.ok(only.changed > 0);
  assert.equal(requestHashesConsistent(only.records), true);
  assert.deepEqual(statuses(only.records), REPLAY_ONLY);
});
test('one character of a re-observation topic changes (every aspect): the decision that asked for it no longer matches', () => {
  const human = '右に突き出た部分はありますか？';
  for (const [aspect, topic] of Object.entries(table.ROTATION_OBSERVE_TOPICS)) {
    const decisions = (question: string) => [{ observe: { aspect, question } }];
    const turn = { carried: true, memo: {} };
    assert.equal(table.rotationObserveMatches(turn, decisions(topic + '\n今回の公開人間発話（引用）: ' + human), human), true, aspect);
    for (const at of positionsOf(topic)) assert.equal(table.rotationObserveMatches(turn, decisions(changeOneChar(topic, at) + '\n今回の公開人間発話（引用）: ' + human), human), false, `${aspect} at ${at}`);
    assert.equal(table.rotationObserveMatches(turn, decisions(topic + '\n今回の公開人間発話（引用）: ' + human.slice(0, -1)), human), false, aspect + ' quote');
  }
  assert.equal(table.rotationObserveMatches({ carried: false, memo: {} }, [{ observe: { aspect: 'part', question: '何でも' } }], human), true, 'a request without the memory keeps the earlier text');
});

/** Every line of the nouns and roles layers one figure's memory is shown as, read from what the runtime sends for it. */
function layerLines(rotation: unknown, layer: 'nouns' | 'roles'): string[] {
  const lines = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { if (value.length > 3) lines.add(value); } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(guidance.rotationMemoryLayer(rotation as never, layer));
  return [...lines];
}
for (const layer of ['nouns', 'roles'] as const) {
  test(`one character of a line of the ${layer} layer changes: only the replay check disagrees`, async () => {
    const records = await record('confirm', 'on');
    const lines = layerLines(projectionOf(VIEWS[0]), layer);
    assert.ok(lines.length >= 8, `the ${layer} layer has few lines: ${lines.length}`);
    for (const [i, line] of lines.entries()) for (const at of i < 3 ? positionsOf(line) : [Math.floor(line.length / 2)]) {
      const { records: changed, changed: count } = mutateRecord(records, { from: line, to: changeOneChar(line, at) });
      assert.ok(count > 0, `the ${layer} line is not in the record: ${line}`);
      assert.equal(requestHashesConsistent(changed), true, 'every request still carries its own hash');
      assert.deepEqual(statuses(changed), REPLAY_ONLY, `${layer} line ${i} at ${at}: ${line}`);
    }
  });
}

// ---- 3. The table copies the runtime ----
test('every text of the table is the text of the runtime', () => {
  const same: [string, string, string][] = [
    ['nouns legend', table.ROTATION_LEGEND_NOUNS, guidance.ROTATION_LEGENDS.nouns], ['roles legend', table.ROTATION_LEGEND_ROLES, guidance.ROTATION_LEGENDS.roles],
    ['earlier common sentence', table.COMMON_DIFFERENT_CONSTRUAL, guidance.COMMON_DIFFERENT_CONSTRUAL], ['common sentence', table.COMMON_DIFFERENT_CONSTRUAL_ROTATION, guidance.COMMON_DIFFERENT_CONSTRUAL_ROTATION],
    ['match use', table.ROTATION_MATCH_USE, guidance.ROTATION_MATCH_USE], ['accept answer', table.ROTATION_ACCEPT_ANSWER, guidance.ROTATION_ACCEPT_ANSWER],
    ['accept backchannel', table.ROTATION_ACCEPT_BACKCHANNEL, guidance.ROTATION_ACCEPT_BACKCHANNEL], ['confirm criterion', table.ROTATION_CONFIRM, guidance.ROTATION_CONFIRM],
    ['propose_name criterion', table.ROTATION_PROPOSE_NAME, guidance.ROTATION_PROPOSE_NAME], ['request_observation criterion', table.ROTATION_REQUEST_OBSERVATION, guidance.ROTATION_REQUEST_OBSERVATION],
    ['observation sources', table.ROTATION_FEATURE_SOURCES, guidance.ROTATION_FEATURE_SOURCES], ['local extraction use', table.EXTRACTION_ROTATION_USE, guidance.EXTRACTION_ROTATION_USE],
    ['AI extraction use', table.AI_EXTRACTION_ROTATION_USE, guidance.AI_EXTRACTION_ROTATION_USE], ['re-observation use', table.REOBSERVATION_ROTATION_USE, guidance.REOBSERVATION_ROTATION_USE],
  ];
  for (const [name, mine, theirs] of same) assert.equal(mine, theirs, name);
  assert.deepEqual(table.ROTATION_OBSERVE_TOPICS, guidance.ROTATION_OBSERVE_TOPICS);
});
test('the six generation replacements of the table give exactly the instructions the runtime gives, in v23 and v24', () => {
  for (const base of [GENERATION_INSTRUCTIONS_V23, GENERATION_INSTRUCTIONS_V24]) {
    let text = base;
    for (const [from, to] of table.GENERATION_ROTATION_EDITS) {
      assert.equal(text.split(from).length, 2, 'the sentence is in the instructions once: ' + from.slice(0, 30));
      text = text.replace(from, () => to);
      assert.equal(text.split(to).length, 2);
    }
    assert.equal(text, guidance.applyGenerationRotationEdits(base));
  }
});
test('the layers, the name nouns and the shape check of the table are those of the runtime for all 120 (figure, current rotation) projections', () => {
  const figures = ROTATION_MEMORY_ENTRIES.map(entry => entry.figureKey);
  assert.equal(figures.length, 30);
  let count = 0;
  for (const key of figures) for (const rotation of [0, 90, 180, 270]) {
    const projection = projectOwnRotationMemory({ figureKey: key, rotation })!;
    const note = `${key}@${rotation}`;
    assert.equal(table.wellFormedRotation(projection), true, note);
    assert.deepEqual(table.nounsLayer(projection), guidance.rotationMemoryLayer(projection, 'nouns'), note + ' nouns');
    assert.deepEqual(table.rolesLayer(projection), guidance.rotationMemoryLayer(projection, 'roles'), note + ' roles');
    assert.deepEqual(table.nameNouns(projection), rotationNameCandidates(projection), note + ' names');
    assert.equal(JSON.stringify(table.nounsLayer(projection)), JSON.stringify(guidance.rotationMemoryLayer(projection, 'nouns')), note + ' key order');
    count++;
  }
  assert.equal(count, 120);
  const memo = memoOf(3) as { figures: unknown[] };
  assert.deepEqual(table.memoInLayer(memo as never, 'nouns'), guidance.withRotationLayer(memo, 'nouns'));
  assert.deepEqual(table.memoInLayer(memo as never, 'roles'), guidance.withRotationLayer(memo, 'roles'));
});
test('a memory that is not well formed is not a memory (like in the run): no figure of the memo carries one', () => {
  const projection: any = structuredClone(projectionOf(VIEWS[0]));
  assert.equal(table.carriesRotation({ figures: [{ id: 'a', rotation: projection }] }), true);
  for (const broken of [{ ...projection, extra: 1 }, { ...projection, turned: projection.turned.slice(1) }, { ...projection, wholeAnywhere: !projection.wholeAnywhere }, { ...projection, regions: [] }, 'rotation', null]) {
    assert.equal(table.carriesRotation({ figures: [{ id: 'a', rotation: broken }] }), false);
  }
  assert.equal(table.carriesRotation({ figures: [{ id: 'a' }] }), false);
  assert.equal(table.carriesRotation(undefined), false);
});

// ---- 4. The name candidates, and the version that may carry the memory ----
test('the name candidates: the holistic construals, then the memory\'s whole nouns (current view first), then the public names; only a shown reason leaves a noun out', async () => {
  const records = await record('propose_name', 'on');
  const entry = records.trials[0].replay[0], side = entry.result.sides[0];
  const turn = table.rotationTurn(entry.tape.state.observationMemo, records.trials[0].attempts[0].observationMemo)!;
  const request = side.requests.find((r: any) => r.provider === 'jev' && r.payload.questions?.name);
  assert.ok(turn.carried && request, 'the record asks for a name');
  const state = JSON.parse(request.payload.state), criteria: Record<string, string> = request.payload.questions.name.criteria;
  const values = Object.values(criteria).map(entry => JSON.parse(entry) as { value: string; figureIds: string[] });
  assert.deepEqual(values.map(v => v.value), rotationNameCandidates(projectionOf(VIEWS[0])), 'the request offers the memory\'s names in its order');
  assert.ok(values.length >= 3);
  const as = (list: { value: string; figureIds: string[] }[]) => Object.fromEntries(list.map((v, i) => ['name_' + i, JSON.stringify(v)]));
  assert.equal(table.nameCandidatesOk(turn, state, criteria), true);
  assert.equal(table.nameCandidatesOk(turn, state, as([...values].reverse())), false, 'the turned views first');
  assert.equal(table.nameCandidatesOk(turn, state, as([values[1], values[0], ...values.slice(2)])), false, 'two names swapped');
  assert.equal(table.nameCandidatesOk(turn, state, as([...values, { value: 'どこにもない名前', figureIds: values[0].figureIds }])), false, 'a name nobody offered');
  assert.equal(table.nameCandidatesOk(turn, state, as(values.slice(1))), false, 'the first noun left out without a reason');
  // A noun another figure already carries as its name is left out by the run (the ledger holds it in the figures' rows).
  const taken = structuredClone(state);
  taken.figures.f1 = { ...taken.figures.f1, name: values[0].value.replace(/[ァ-ヶ]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)) };
  assert.equal(table.nameCandidatesOk(turn, taken, as(values.slice(1))), true, 'a noun another figure carries (read as hiragana) may be left out');
  assert.equal(table.nameCandidatesOk(turn, taken, as(values)), true, 'and a record that still offers it is not refused here');
  const settled = structuredClone(state);
  settled.figures.f0 = { ...settled.figures.f0, status: 'agreed' };
  assert.equal(table.nameCandidatesOk(turn, settled, {}), true, 'a settled figure offers nothing');
});
test('a record of an earlier version cannot carry the rotation memory: only the registered rotation-memory version may', async () => {
  const records = await record('confirm', 'off');
  assert.deepEqual(statuses(records), ALL_PASS);
  const sources = JSON.parse(await readFile(new URL('./fixtures/parity-verify/failure-path-v24-8c92b12/producer-records.json', import.meta.url), 'utf8')).observation_timeout.run.promptSources;
  const earlier = structuredClone(records); earlier.run.promptSources = structuredClone(sources);
  for (const trial of earlier.trials) trial.identity.prompts = hash(sources);
  assert.deepEqual(statuses(earlier), REPLAY_ONLY);
  assert.equal(table.rotationVersion('p5_pilot012_rotation_memory_v1'), true);
  for (const id of ['p5_pilot012_rotation_90_180_270_v24', 'p5_pilot012_precheck_reduction_v24', '', undefined, null]) assert.equal(table.rotationVersion(id), false);
});
