// S4 and the generation cleanup (v25, #273 / #275). The records come from the real runtime and the offline replay (buildRecords): no key, network or study data.
//   1. S4 passes a v25 record (the tidied instructions; the ON source extraction rules), with and without the pre-made rotation memory, both strategies.
//   2. A text that v25 changed, said one character differently, or said the way v24 said it, makes only the replay check disagree; a v24 record that says the v25 text does too.
//   3. The table of S4 copies the runtime's v25 texts, and the sources fingerprint of the registered row is the current one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import * as table from '../dialogue-model/runtime/diagnostics/parity-verify/turned-view-records.ts';
import * as guidance from '../dialogue-model/runtime/decision/rotation-memory-guidance.ts';
import { AI_EXTRACTION_SOURCE_RULES_V25 } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import { GENERATION_INSTRUCTIONS_V24, GENERATION_INSTRUCTIONS_V25 } from '../dialogue-model/runtime/v2/generation-prompt-v23.ts';
import { rotationInitialMemo } from '../dialogue-model/runtime/observation/rotation-memo.ts';
import { projectOwnRotationMemory } from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import { buildRecords, OWN, type Label } from './support/s4-v3-records.ts';
import { retargetToMode, type RotationMode } from './support/s4-rotation-records.ts';
import { changeOneChar, holds, mutateRecord, positionsOf, requestHashesConsistent } from './support/s4-rotation-mutation.ts';

const options = (version: 'jev_generation_retry_v24' | 'jev_generation_retry_v25') => ({
  dialoguePolicy: 'holistic_v5', interventionVersion: 'bypass_acceptance_v3', judgmentMaterialVersion: 'jev_repair_quality_v1',
  technicalTrial: { version: 'adaptive_repair_v3' }, generationRetryVersion: version, agreeNameScopeVersion: 'jev_naming_v3',
}) as const;
const choose = (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined;
const INTERVENTION = /^intervention\.trial\.0\.attempt\.0\./u;
const statuses = (records: unknown): string[] => interventionChecks(records as never).filter(c => INTERVENTION.test(c.id)).map(c => c.id.split('.').pop() + ':' + c.status);
const ALL_PASS = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:pass'];
const REPLAY_ONLY = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:mismatch'];
const MODES: RotationMode[] = ['relative_pm90', 'relative_0', 'relative_90_180_270'];

// The texts v25 changed, written out here (before and after), not read from the runtime.
const UPTAKE_V24_Q = '質問するときも問いだけで終えず、自分の見え方や今の理解を一言添えてください。';
const UPTAKE_V25_Q = '図形についての質問は、問いだけで終えず、自分の見え方や今の理解を一言添えてください。';
const CONFIRM_V24 = '選んだ論点について聞かれたことには、自分の観察で答えられる点を先に述べてください。確認がまだ必要なら、答えを得ていない一点だけを形の参照枠に沿って尋ねてください。観察メモにない特徴、対象の一致、名前の合意は断定しないでください。';
const CONFIRM_V25 = '選んだ論点について確認がまだ必要なら、答えを得ていない一点だけを形の参照枠に沿って尋ねてください。観察メモにない特徴、対象の一致、名前の合意は断定しないでください。';
const VISUAL_V23 = '対象と論点の範囲で観察メモから確認・修復に使う特徴を選んでください。具体的な特徴への質問は先に扱い、肯否・訂正済みの点と未解決の点を区別してください。候補の区別や説明の対応に役立つ点を優先し、観察メモに記載がないことを特徴がない証拠にしないでください。根拠が不足する場合はその不確かさを示し、必要な情報を尋ねてください。';
const VISUAL_V25 = '対象と論点の範囲で観察メモから確認・修復に使う特徴を選んでください。肯否・訂正済みの点と未解決の点を区別してください。候補の区別や説明の対応に役立つ点を優先し、観察メモに記載がないことを特徴がない証拠にしないでください。根拠が不足する場合はその不確かさを示してください。';
const CONTINUE_V24 = '【未確定のまま答える】相手の説明・選択・命名・進行の依頼に、今の論点の範囲で直接答えてください。自分の観察で答えられる内容とその根拠を先に述べ、決められない部分があれば何が未確定かを短く明示してください。相手から訂正や依頼の言い直しがあれば反映してください。名前を新しく提案・採用・撤回したり、未確定の対象を一つに決めたりしないでください。';
const CONTINUE_V25 = '【未確定のまま答える】答えは今の論点の範囲にとどめ、名前を新しく提案・採用・撤回したり、未確定の対象を一つに決めたりしないでください。';
// What follows it: a confirming continuation asks the one unanswered point (v24 said "具体的な一点" too), an accepting one adds no new question.
const CONFIRM_CONTINUING_V25 = '次の返答に相手の情報が必要なときだけ、未回答の具体的な一点を尋ねてください。何を確かめるかを相手に委ねないでください。';
const CONFIRM_CONTINUING_V24 = 'それでも次の返答に相手の情報が必要なときだけ、未回答の具体的な一点を尋ねてください。何を確かめるかを相手に委ねないでください。';
const ACCEPT_CONTINUING_V25 = '新たな質問は加えないでください。';
const UPTAKE_V25 = GENERATION_INSTRUCTIONS_V25.split('\n').find(line => line.startsWith('【相手への返答】'))!;
const UPTAKE_V24 = GENERATION_INSTRUCTIONS_V24.split('\n').find(line => line.startsWith('【相手への返答】'))!;

// ---- Records ----
const projectionOf = ([key, rotation]: readonly [string, number]) => projectOwnRotationMemory({ figureKey: key, rotation })!;
const VIEWS: readonly [string, number][] = [['F6', 0], ['F9', 90], ['F1', 270]];
const rotationMemo = () => {
  const anchors = OWN.ownAnchors.slice(0, 3);
  return rotationInitialMemo(anchors, new Map(anchors.map((anchor: { id: string }, i: number) => [anchor.id, projectionOf(VIEWS[i])] as const)), '2026-01-01T00:00:00.000Z');
};
type Check = 'off' | 'on';
type Scene = 'confirm' | 'confirm_regenerated' | 'accept' | 'continued_ask' | 'continued_acknowledge' | 'propose_name' | 'request_observation';
const draft = (text: string, check: Check, plain = false) => check === 'on' ? JSON.stringify({ text, observationFeatures: [] }) : plain ? text : JSON.stringify({ text });
const bad = 'この図形をいったん置いて、次のを見よう。';
const turn = (scene: Scene, check: Check, anchorId: string) => {
  const base = { referent: 'figure_0', choose, postGenerationCheck: check, aiExtraction: check === 'on' ? JSON.stringify({ segments: [], visualFeatures: { sources: [] } }) : '[]' };
  const human = '鳥のような形に見えます。';
  return {
    confirm: { human: '細い部分はどうつながっていますか？', plan: { ...base, action: 'confirm', target: 'figure_0', speech: draft('もう一つ特徴を確かめさせてください。', check) } },
    confirm_regenerated: { human: '細い部分はどうつながっていますか？', plan: { ...base, action: 'confirm', target: 'figure_0',
      drafts: [draft(bad, check), draft('もう一つ特徴を確かめさせてください。', check)],
      choose: (key: string, _criteria: unknown, { generationCalls }: { generationCalls: number }) => key === 'draft_topic_shift' ? generationCalls === 1 ? 'unsupported_shift' : 'within_plan' : choose(key) } },
    accept: { human: '図形を見分ける特徴を教えてください。', plan: { ...base, action: 'accept', target: 'none', speech: draft('細い部分が端でつながっています。', check, true) } },
    // ON only: four drafts that move on, so the check stops asking for a new one and the answer continues without settling (the CONTINUE text). The continuation asks the one
    // point still unanswered (a confirm in the end) or only acknowledges it (an accept in the end).
    continued_ask: { human: '図形を見分ける特徴を教えてください。', plan: { ...base, action: 'accept', target: 'none',
      drafts: [bad, bad, bad, bad, draft('細い部分が端でつながっています。', check)],
      choose: (key: string, _criteria: unknown, { generationCalls }: { generationCalls: number }) => key === 'draft_topic_shift' ? generationCalls < 5 ? 'unsupported_shift' : 'within_plan'
        : key === 'publication_continuation' ? 'ask_unresolved' : choose(key) } },
    continued_acknowledge: { human: '図形を見分ける特徴を教えてください。', plan: { ...base, action: 'accept', target: 'none',
      drafts: [bad, bad, bad, bad, draft('細い部分が端でつながっています。', check)],
      choose: (key: string, _criteria: unknown, { generationCalls }: { generationCalls: number }) => key === 'draft_topic_shift' ? generationCalls < 5 ? 'unsupported_shift' : 'within_plan'
        : key === 'publication_continuation' ? 'acknowledge_unresolved' : choose(key) } },
    // The decision looks again at the figure (one self-side re-observation) before the final action: the re-observation request is the same bytes as v24's.
    request_observation: { human: 'もう少し詳しく見てください。', plan: { ...base, action: 'confirm', target: 'figure_0', reobserve: true, speech: draft('見てから確かめます。', check),
      choose: (key: string) => key === 'observe_aspect' ? 'construal' : choose(key) } },
    propose_name: { human, plan: { ...base, action: 'propose_name', target: 'figure_0', name: '鳥', speech: 'では、「鳥」にしませんか？', aiExtraction: '[]', act: 'construe',
      extraction: JSON.stringify([{ segmentId: 'shape', quote: human, targets: [anchorId], aspect: 'construal', proposition: human, name: null, linkedIssueId: null, respondsToTurn: null }]),
      choose: (key: string) => key === 'draft_naming' ? 'propose_chosen' : choose(key) } },
  }[scene];
};
const cache = new Map<string, Promise<any>>();
/** The record of one final turn, built once. `memo`: the memo carries the pre-made rotation memory. */
function record(scene: Scene, check: Check, { version = 'jev_generation_retry_v25' as 'jev_generation_retry_v24' | 'jev_generation_retry_v25', label = 'repair-first' as Label, memo = false } = {}): Promise<any> {
  const key = [scene, check, version, label, memo].join('/');
  if (!cache.has(key)) cache.set(key, buildRecords({ ...options(version), label, figureCount: 3, ...(memo ? { memo: rotationMemo() as never } : {}), turns: [turn(scene, check, OWN.ownAnchors[0].id)] }));
  return cache.get(key)!;
}

// ---- 1. S4 passes a v25 record ----
const SCENES: [Scene, Check][] = [['confirm', 'off'], ['confirm', 'on'], ['confirm_regenerated', 'on'], ['accept', 'off'], ['continued_ask', 'on'], ['continued_acknowledge', 'on'], ['propose_name', 'off'], ['propose_name', 'on'], ['request_observation', 'off'], ['request_observation', 'on']];
for (const [scene, check] of SCENES) for (const label of ['repair-first', 'bypass-enabled'] as Label[]) {
  test(`v25 ${scene} (${check}, ${label}): S4 verifies the record without the rotation memory`, async () => {
    assert.deepEqual(statuses(await record(scene, check, { label })), ALL_PASS);
  });
  test(`v25 ${scene} (${check}, ${label}): S4 verifies the record that carries the rotation memory in all three rotation modes`, async () => {
    const records = await record(scene, check, { label, memo: true });
    for (const mode of MODES) assert.deepEqual(statuses(mode === 'relative_pm90' ? records : retargetToMode(records, mode)), ALL_PASS, mode);
  });
}
test('the v25 records carry what v25 says: the tidied lines, the noun-unit sentence and the extraction rules where they belong, and none of the v24 lines', async () => {
  const off = await record('confirm', 'off', { memo: true }), on = await record('confirm', 'on', { memo: true }), asked = await record('continued_ask', 'on'), acknowledged = await record('continued_acknowledge', 'on');
  for (const records of [off, on]) {
    assert.equal(holds(records, UPTAKE_V25), true); assert.equal(holds(records, UPTAKE_V24), false);
    assert.equal(holds(records, CONFIRM_V25), true); assert.equal(holds(records, CONFIRM_V24), false);
    assert.equal(holds(records, VISUAL_V25), true); assert.equal(holds(records, VISUAL_V23), false);
  }
  assert.equal(holds(off, table.ROTATION_NOUN_UNIT_V25), false, 'OFF asks for no observation sources');
  assert.equal(holds(off, AI_EXTRACTION_SOURCE_RULES_V25), false, 'the extraction that reads no sources keeps the earlier bytes');
  assert.equal(holds(on, table.ROTATION_NOUN_UNIT_V25), true); assert.equal(holds(on, AI_EXTRACTION_SOURCE_RULES_V25), true);
  for (const continued of [asked, acknowledged]) { assert.equal(holds(continued, CONTINUE_V25), true); assert.equal(holds(continued, CONTINUE_V24), false); }
  assert.equal(holds(asked, CONFIRM_CONTINUING_V25), true); assert.equal(holds(asked, CONFIRM_CONTINUING_V24), false);
  assert.equal(holds(acknowledged, ACCEPT_CONTINUING_V25), true);
  assert.equal(holds(asked, ACCEPT_CONTINUING_V25), false, 'a continuation that asks adds no sentence that forbids a question');
  assert.equal(holds(await record('confirm', 'on'), table.ROTATION_NOUN_UNIT_V25), false, 'a memo without the rotation memory asks for no rotation source');
  assert.equal(holds(await record('confirm', 'on'), AI_EXTRACTION_SOURCE_RULES_V25), true, 'the extraction rules do not depend on the rotation memory');
});

// ---- 2. A changed text ----
const TEXTS: [string, string, Scene, Check, boolean][] = [
  ['the question line of the tidied common instructions', UPTAKE_V25_Q, 'confirm', 'off', false],
  ['the whole tidied common line', UPTAKE_V25, 'accept', 'off', false],
  ['the tidied confirm text', CONFIRM_V25, 'confirm', 'off', false],
  ['the tidied feature selection', VISUAL_V25, 'confirm', 'on', false],
  ['the tidied continuation text', CONTINUE_V25, 'continued_ask', 'on', false],
  ['the one point a confirming continuation asks about', CONFIRM_CONTINUING_V25, 'continued_ask', 'on', false],
  ['the sentence that adds no new question to an accepting continuation', ACCEPT_CONTINUING_V25, 'continued_acknowledge', 'on', false],
  ['the noun-unit sentence', table.ROTATION_NOUN_UNIT_V25, 'confirm', 'on', true],
  ['the ON extraction rules', table.AI_EXTRACTION_SOURCE_RULES_V25, 'confirm', 'on', false],
  ['the ON extraction rules (with the rotation memory)', table.AI_EXTRACTION_SOURCE_RULES_V25, 'confirm', 'on', true],
];
for (const [name, text, scene, check, memo] of TEXTS) {
  test(`one character of ${name} changes: only the replay check disagrees`, async () => {
    const records = await record(scene, check, { memo });
    assert.equal(holds(records, text), true, `the record carries ${name}`);
    for (const at of positionsOf(text)) {
      const { records: changed, changed: count } = mutateRecord(records, { from: text, to: changeOneChar(text, at) });
      assert.ok(count > 0);
      assert.equal(requestHashesConsistent(changed), true, 'every request still carries its own hash');
      assert.deepEqual(statuses(changed), REPLAY_ONLY, `${name} at ${at}`);
    }
  });
}
const OLD_FOR_NEW: [string, string, string, Scene, Check, boolean][] = [
  ['the v24 question line', UPTAKE_V25_Q, UPTAKE_V24_Q, 'confirm', 'off', false],
  ['the v24 confirm text', CONFIRM_V25, CONFIRM_V24, 'confirm', 'off', false],
  ['the v23 feature selection', VISUAL_V25, VISUAL_V23, 'confirm', 'on', false],
  ['the v24 continuation text', CONTINUE_V25, CONTINUE_V24, 'continued_ask', 'on', false],
  ['the v24 continuation question text', CONFIRM_CONTINUING_V25, CONFIRM_CONTINUING_V24, 'continued_ask', 'on', false],
  ['the confirm text without "一点だけ" (the range of the question that v25 must keep)', CONFIRM_V25, CONFIRM_V25.replace('一点だけを', '点を'), 'confirm', 'off', false],
  ['the continuation question text without "一点" (the range of the question that v25 must keep)', CONFIRM_CONTINUING_V25, CONFIRM_CONTINUING_V25.replace('具体的な一点を', '具体的な点を'), 'continued_ask', 'on', false],
  ['the v24 sources line (no noun-unit sentence)', table.ROTATION_FEATURE_SOURCES_V25, table.ROTATION_FEATURE_SOURCES, 'confirm', 'on', true],
];
for (const [name, v25, old, scene, check, memo] of OLD_FOR_NEW) {
  test(`a v25 record that says ${name} is a replay mismatch`, async () => {
    const records = await record(scene, check, { memo });
    const { records: changed, changed: count } = mutateRecord(records, { from: v25, to: old });
    assert.ok(count > 0);
    assert.equal(requestHashesConsistent(changed), true);
    assert.deepEqual(statuses(changed), REPLAY_ONLY, name);
  });
}
test('a v25 record without the extraction rules is a replay mismatch', async () => {
  const records = await record('confirm', 'on', { memo: true });
  const { records: changed, changed: count } = mutateRecord(records, { from: '\n' + table.AI_EXTRACTION_SOURCE_RULES_V25, to: '' });
  assert.ok(count > 0);
  assert.deepEqual(statuses(changed), REPLAY_ONLY);
});
test('a v24 record that says the v25 text is a replay mismatch, and the v24 record itself still passes', async () => {
  for (const [scene, check, from, to] of [['confirm', 'off', UPTAKE_V24_Q, UPTAKE_V25_Q], ['confirm', 'off', CONFIRM_V24, CONFIRM_V25], ['confirm', 'on', VISUAL_V23, VISUAL_V25]] as const) {
    const records = await record(scene, check, { version: 'jev_generation_retry_v24' });
    assert.deepEqual(statuses(records), ALL_PASS, 'the v24 record passes');
    const { records: changed, changed: count } = mutateRecord(records, { from, to });
    assert.ok(count > 0, from.slice(0, 20));
    assert.deepEqual(statuses(changed), REPLAY_ONLY, to.slice(0, 20));
  }
});
test('a v24 record with the rotation memory keeps its v24 sources line, and the noun-unit sentence in it is a replay mismatch', async () => {
  const records = await record('confirm', 'on', { version: 'jev_generation_retry_v24', memo: true });
  assert.deepEqual(statuses(records), ALL_PASS);
  assert.equal(holds(records, table.ROTATION_NOUN_UNIT_V25), false);
  const { records: changed, changed: count } = mutateRecord(records, { from: table.ROTATION_FEATURE_SOURCES, to: table.ROTATION_FEATURE_SOURCES_V25 });
  assert.ok(count > 0);
  assert.deepEqual(statuses(changed), REPLAY_ONLY);
});

// ---- 3. The table and the runtime ----
test('the v25 texts of the table are those of the runtime, and the registered row carries them', () => {
  assert.equal(table.ROTATION_NOUN_UNIT_V25, guidance.ROTATION_SOURCE_NOUN_UNIT_V25);
  assert.equal(table.ROTATION_FEATURE_SOURCES_V25, guidance.ROTATION_FEATURE_SOURCES_V25);
  assert.equal(table.ROTATION_FEATURE_SOURCES_V25, guidance.ROTATION_FEATURE_SOURCES + guidance.ROTATION_SOURCE_NOUN_UNIT_V25);
  assert.equal(table.AI_EXTRACTION_SOURCE_RULES_V25, AI_EXTRACTION_SOURCE_RULES_V25);
  assert.equal(table.rotationVersion('p5_pilot012_generation_cleanup_v25'), true);
  assert.equal(table.rotationVersion('p5_pilot012_rotation_memory_v1'), true, 'the production main\'s row stays registered');
});
test('the v25 instructions are the v24 instructions with the question line changed, and nothing else', () => {
  assert.equal(UPTAKE_V25, UPTAKE_V24.replace(UPTAKE_V24_Q, UPTAKE_V25_Q));
  assert.equal(GENERATION_INSTRUCTIONS_V25, GENERATION_INSTRUCTIONS_V24.replace(UPTAKE_V24, UPTAKE_V25));
  assert.notEqual(UPTAKE_V25, UPTAKE_V24);
});
