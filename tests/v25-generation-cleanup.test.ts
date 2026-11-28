// The generation cleanup (v25, #273 / #275): jev_generation_retry_v25 is v24's procedure with
//   #273  one statement per theme in the generation request ("answer what was asked first", "ask one question", "state what is known and unknown", "reflect corrections"),
//         and the AI's own view added to a question only when the question is about the figure (so a consult no longer contradicts the common instructions);
//   #275  (postGenerationCheck on only) the noun-unit of a source in the generation's examples, and two rules on what a source is in the independent extraction.
// v24 and every earlier version keep every byte: the digests below were taken from the production main (20b5366) with the same matrix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationActionPromptV23, GENERATION_INSTRUCTIONS_V23, GENERATION_INSTRUCTIONS_V24, GENERATION_INSTRUCTIONS_V25,
  CONCISE_GENERATION_V23, MULTIPLE_CANDIDATES_V23, PRIVATE_NAMING_STATE_V23, PUBLIC_QUESTIONS_V23, generationTaskV23 } from '../dialogue-model/runtime/v2/generation-prompt-v23.ts';
import { AI_EXTRACTION_SOURCE_RULES_V25, MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS, memoAiExtractionPrompt } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import * as guidance from '../dialogue-model/runtime/decision/rotation-memory-guidance.ts';
import { GENERATION_RETRY_V22, GENERATION_RETRY_V23, GENERATION_RETRY_V24, GENERATION_RETRY_V25, isGenerationV24, isGenerationV25, usesV22GenerationRules,
  usesV24GenerationRules, isIssueHandlingGeneration, isDeferredAiExtractionGeneration } from '../dialogue-model/runtime/v2/deferred-ai-extraction.ts';
import { validAgreeNameScope, validGenerationRetryVersion, hasVersionedViewpoint } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { SHAPE_TERMINOLOGY_GENERATION } from '../dialogue-model/runtime/shape-terminology.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { rotationInitialMemo } from '../dialogue-model/runtime/observation/rotation-memo.ts';
import { projectOwnRotationMemory } from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import { digestOf, promptMatrix } from './support/generation-prompt-matrix.ts';
import { initialState, normal, OLD, OWN, runTurn, type Label, type Plan } from './support/s4-v3-records.ts';

// ---- 1. v24 and the earlier versions keep every byte ----
test('v23 and v24 generation requests keep every byte of the production main (390 plans, the instructions and the task)', () => {
  assert.equal(digestOf(promptMatrix(generationActionPromptV23)), 'ba2173dd75a1a530bbd51e2538c6d0653fdff80d4dbe8ef4dc685e18ef7779a9');
  assert.equal(digestOf([GENERATION_INSTRUCTIONS_V23, GENERATION_INSTRUCTIONS_V24, CONCISE_GENERATION_V23, MULTIPLE_CANDIDATES_V23, PRIVATE_NAMING_STATE_V23, PUBLIC_QUESTIONS_V23]),
    'e1c19add4cf973109d60e94600461ce32d7d89232847b0f673fe889cc898db7f');
  assert.equal(digestOf([2, 3, 4, 6].map(n => generationTaskV23(n))), 'd03bf70c37f8c1af9601ee64a9f1aa62235c270b7009cbb485563b6db089669f');
});
test('the extraction prompts and the rotation texts of v24 keep every byte (the new flag changes nothing without it, and nothing when no source is read)', () => {
  const matrix = (sourceRules?: boolean) => {
    const out: string[] = [];
    for (const terminology of [undefined, SHAPE_TERMINOLOGY_GENERATION]) for (const visual of [false, true]) for (const parts of [false, true]) for (const rotation of [false, true]) {
      out.push(sourceRules === undefined ? memoAiExtractionPrompt(terminology, visual, parts, rotation) : memoAiExtractionPrompt(terminology, visual, parts, rotation, sourceRules));
    }
    return out;
  };
  assert.equal(digestOf(matrix()), 'cb919e9d7c7f0fdfe24598e6786194fa5f852f3586f2e46fdfed74674cdd091b');
  assert.equal(digestOf(matrix(false)), 'cb919e9d7c7f0fdfe24598e6786194fa5f852f3586f2e46fdfed74674cdd091b');
  const rotation = [guidance.ROTATION_FEATURE_SOURCES, guidance.ROTATION_SOURCE_EXAMPLES, ...guidance.ROTATION_PRIVATE_TEXTS, guidance.GENERATION_ROTATION_EDITS,
    guidance.EXTRACTION_ROTATION_USE, guidance.AI_EXTRACTION_ROTATION_USE, guidance.ROTATION_LEGENDS];
  assert.equal(digestOf([JSON.stringify(rotation)]), '2020220c394d84a533fd8b59a17dd4b5d0b2f6428e9137f876589a5e18760800');
  // With the rules on, the extraction that reads no source (the memory-only extraction of the default OFF) is still the earlier text.
  for (const terminology of [undefined, SHAPE_TERMINOLOGY_GENERATION]) for (const parts of [false, true]) for (const rotationMemo of [false, true]) {
    assert.equal(memoAiExtractionPrompt(terminology, false, parts, rotationMemo, true), memoAiExtractionPrompt(terminology, false, parts, rotationMemo));
  }
});

// ---- 2. What v25 changes ----
const UPTAKE_V24_Q = '質問するときも問いだけで終えず、自分の見え方や今の理解を一言添えてください。';
const UPTAKE_V25_Q = '図形についての質問は、問いだけで終えず、自分の見え方や今の理解を一言添えてください。';
const uptake = (instructions: string) => instructions.split('\n').find(line => line.startsWith('【相手への返答】'))!;
const sentences = (text: string) => text.split(/(?<=。)/u).map(sentence => sentence.trim()).filter(Boolean);

test('the v25 common instructions are the v24 ones with the question sentence limited to questions about the figure, and nothing else', () => {
  assert.equal(uptake(GENERATION_INSTRUCTIONS_V24).includes(UPTAKE_V24_Q), true);
  assert.equal(uptake(GENERATION_INSTRUCTIONS_V25).includes(UPTAKE_V25_Q), true);
  assert.equal(GENERATION_INSTRUCTIONS_V25, GENERATION_INSTRUCTIONS_V24.replace(UPTAKE_V24_Q, UPTAKE_V25_Q));
  assert.equal(GENERATION_INSTRUCTIONS_V25.split('\n').length, GENERATION_INSTRUCTIONS_V24.split('\n').length);
  assert.notEqual(GENERATION_INSTRUCTIONS_V25, GENERATION_INSTRUCTIONS_V23);
});

const target = { kind: 'single', figureId: 'f0' } as const;
const issue = { kind: 'resolve_issue', issueId: 'q', claimId: '3:local1', sourceTurn: 3 } as const;
const base = { publicQuestions: [], visualDetail: false, humanLedTransition: false, closing: null, reconsidered: false, continuing: false,
  namingRequest: false, namingConflict: null, withdrawnName: null, respondToRequest: true, omitVisualSources: true };
type Case = [name: string, input: Record<string, unknown>];
const CASES: Case[] = [
  ['accept', { items: [{ action: 'accept', target }] }],
  ['accept (continuing)', { items: [{ action: 'accept', target }], continuing: true }],
  ['confirm (visual detail)', { items: [{ action: 'confirm', target, visualPurpose: { kind: 'clarify_reference' } }], visualDetail: true }],
  ['confirm', { items: [{ action: 'confirm', target, issue }] }],
  ['confirm (continuing)', { items: [{ action: 'confirm', target, issue }], continuing: true }],
  ['confirm (continuing, visual detail)', { items: [{ action: 'confirm', target, visualPurpose: { kind: 'clarify_reference' } }], continuing: true, visualDetail: true }],
  ['repair (visual detail)', { items: [{ action: 'repair', target, visualPurpose: { kind: 'resolve_mismatch' } }], visualDetail: true }],
  ['propose_name', { items: [{ action: 'propose_name', target, name: '鳥' }] }],
  ['agree', { items: [{ action: 'agree', target, name: '鳥' }] }],
  ['hold_open', { items: [{ action: 'hold_open', target, issue }] }],
  ['carry_over', { items: [{ action: 'carry_over', target, destination: { kind: 'partner_choice' } }] }],
  ['consult', { items: [{ action: 'consult', target, issue }] }],
  ['revisit', { items: [{ action: 'revisit', target }] }],
  ['close', { items: [{ action: 'close', target: { kind: 'none' } }], closing: { initiator: 'ai', unresolved: true } }],
  ['confirm + repair', { items: [{ action: 'confirm', target, issue }, { action: 'repair', target, visualPurpose: { kind: 'resolve_mismatch' } }], visualDetail: true }],
];
/** The whole request text a model reads before the plan's JSON: the common instructions and the action message. */
const requestText = (version: 'v24' | 'v25', input: Record<string, unknown>) =>
  (version === 'v25' ? GENERATION_INSTRUCTIONS_V25 : GENERATION_INSTRUCTIONS_V24) + '\n' +
  generationActionPromptV23({ ...base, ...input, ...(version === 'v25' ? { tidied: true } : {}) }).split('\n').slice(0, -2).join('\n');

// The four themes v24 said more than once. A sentence counts for a theme by the words that carry it; a sentence about the public questions (hold_open, carry_over answer the
// questions already asked in public before they move on) is a different statement and is not counted.
const THEMES: [string, (sentence: string) => boolean][] = [
  ['answer what was asked first', s => /先に[^。]*(答え|述べ|扱い)/u.test(s) && !s.includes('publicQuestions')],
  ['ask one question', s => /一つに絞|一点/u.test(s)],
  ['state the known and the unknown', s => /未確定の点を短く|何が未確定か|答えられる内容と限界/u.test(s)],
  ['reflect a correction or a restated request', s => /訂正した点や依頼を言い直した|訂正や依頼の言い直し/u.test(s)],
];
const countTheme = (text: string, matches: (sentence: string) => boolean) => sentences(text).filter(matches).length;

test('v25 says each theme once in every request, where v24 said some of them two or three times', () => {
  const repeated = new Map<string, number>();
  for (const [name, input] of CASES) for (const [theme, matches] of THEMES) {
    assert.equal(countTheme(requestText('v25', input), matches), 1, `v25 / ${name} / ${theme}`);
    const before = countTheme(requestText('v24', input), matches);
    assert.ok(before >= 1, `v24 / ${name} / ${theme}`);
    if (before > 1) repeated.set(`${name} / ${theme}`, before);
  }
  // What the cleanup removed (v24 said these two or three times): each of the four actions' answer, the one-question and the known/unknown statements.
  for (const expected of ['confirm (visual detail) / answer what was asked first', 'confirm / answer what was asked first', 'confirm (continuing) / answer what was asked first',
    'repair (visual detail) / answer what was asked first', 'accept (continuing) / answer what was asked first', 'confirm / ask one question',
    'confirm (continuing) / ask one question', 'accept (continuing) / state the known and the unknown', 'confirm (continuing) / reflect a correction or a restated request']) {
    assert.ok(repeated.has(expected), `v24 repeated: ${expected}`);
  }
  assert.equal(repeated.get('confirm (visual detail) / answer what was asked first'), 3);
});

test('the actions v25 did not touch say exactly what v24 said (the action message), and only the three texts that restated a theme differ', () => {
  const changed = new Set<string>();
  for (const [name, input] of CASES) {
    const v24 = generationActionPromptV23({ ...base, ...input }), v25 = generationActionPromptV23({ ...base, ...input, tidied: true });
    if (v24 !== v25) changed.add(name);
  }
  assert.deepEqual([...changed].sort(), ['accept (continuing)', 'confirm', 'confirm (continuing)', 'confirm (continuing, visual detail)', 'confirm (visual detail)',
    'confirm + repair', 'repair (visual detail)'].sort());
  // consult, hold_open, carry_over, revisit, close, propose_name, agree and a plain accept keep the action message of v24, with or without the flag.
  for (const [name, input] of CASES) if (!changed.has(name)) {
    assert.equal(generationActionPromptV23({ ...base, ...input, tidied: true }), generationActionPromptV23({ ...base, ...input }), name);
  }
});

test('consult: v24 asked for the AI\'s own view with every question and for no observation feature in a consult; v25 asks for it with a question about the figure only', () => {
  const consult = CASES.find(([name]) => name === 'consult')![1];
  const own = (text: string) => sentences(text).filter(sentence => sentence.includes('一言添え'));
  const v24 = requestText('v24', consult), v25 = requestText('v25', consult);
  const ban = '解決や放棄を表明せず、自分側の観察の特徴は述べないでください。';
  assert.equal(v24.split(ban).length, 2);
  assert.equal(v25.split(ban).length, 2, 'the consult keeps its own sentence: handing the choice over must not steer it with a new observation feature');
  assert.deepEqual(own(v24).map(sentence => sentence.includes('質問するときも')), [true], 'v24: any question carries the AI\'s own view');
  assert.deepEqual(own(v25).map(sentence => sentence.startsWith('図形についての質問は、')), [true], 'v25: only a question about the figure does');
  assert.equal(v25.includes('質問するときも'), false);
  // The consult text itself is the one of v24 (the cleanup chose the strategy's meaning over the common sentence).
  assert.equal(generationActionPromptV23({ ...base, ...consult, tidied: true }), generationActionPromptV23({ ...base, ...consult }));
  // The questions that ask how to go on (consult, carry_over, close) name their own content; none of them is "a question about the figure".
  for (const name of ['consult', 'carry_over', 'close']) {
    const text = generationActionPromptV23({ ...base, ...CASES.find(([n]) => n === name)![1], tidied: true });
    assert.equal(text.includes('図形についての質問'), false, name);
  }
});

test('the three texts v25 shortened keep what is the action\'s own and drop only what the common instructions say', () => {
  const confirm = generationActionPromptV23({ ...base, ...CASES.find(([name]) => name === 'confirm (visual detail)')![1], tidied: true });
  assert.ok(confirm.includes('選んだ論点について確認がまだ必要なら、答えを得ていない点を形の参照枠に沿って尋ねてください。観察メモにない特徴、対象の一致、名前の合意は断定しないでください。'));
  assert.ok(confirm.includes('肯否・訂正済みの点と未解決の点を区別してください。'));
  assert.ok(confirm.includes('根拠が不足する場合はその不確かさを示してください。'));
  for (const gone of ['聞かれたことには、自分の観察で答えられる点を先に述べてください', '具体的な特徴への質問は先に扱い', '必要な情報を尋ねてください', '一点だけ']) assert.equal(confirm.includes(gone), false, gone);
  const continuing = generationActionPromptV23({ ...base, ...CASES.find(([name]) => name === 'confirm (continuing)')![1], tidied: true });
  assert.ok(continuing.includes('【未確定のまま答える】答えは今の論点の範囲にとどめ、名前を新しく提案・採用・撤回したり、未確定の対象を一つに決めたりしないでください。'));
  assert.ok(continuing.includes('次の返答に相手の情報が必要なときだけ、未回答の具体的な点を尋ねてください。何を確かめるかを相手に委ねないでください。'));
  const accepted = generationActionPromptV23({ ...base, ...CASES.find(([name]) => name === 'accept (continuing)')![1], tidied: true });
  assert.ok(accepted.includes('未確定の対象を一つに決めたりしないでください。新たな質問は加えないでください。'));
  for (const text of [continuing, accepted]) for (const gone of ['直接答えてください', '何が未確定かを短く明示', '答えられる内容と限界', '訂正や依頼の言い直しがあれば反映してください']) assert.equal(text.includes(gone), false, gone);
});

// ---- 3. postGenerationCheck on only (#275) ----
const sources = (extra: Record<string, unknown>) => generationActionPromptV23({ ...base, items: [{ action: 'confirm', target, visualPurpose: { kind: 'clarify_reference' } }], visualDetail: true, ...extra });
test('the noun-unit sentence follows the rotation sources line of a v25 request that asks for sources, and is in no other request', () => {
  const unit = guidance.ROTATION_SOURCE_NOUN_UNIT_V25;
  assert.equal(guidance.ROTATION_FEATURE_SOURCES_V25, guidance.ROTATION_FEATURE_SOURCES + unit);
  assert.match(unit, /見立ての名詞/u); assert.match(unit, /whole/u); assert.match(unit, /parts/u);
  const on = sources({ omitVisualSources: false, rotationSources: true, tidied: true });
  assert.equal(on.split('\n').includes(guidance.ROTATION_FEATURE_SOURCES_V25), true);
  assert.equal(on.split(unit).length, 2);
  for (const [name, text] of [
    ['v24 with the rotation memory', sources({ omitVisualSources: false, rotationSources: true })],
    ['v25 without the rotation memory', sources({ omitVisualSources: false, rotationSources: false, tidied: true })],
    ['v25 OFF (no sources asked)', sources({ omitVisualSources: true, rotationSources: true, tidied: true })],
  ] as const) assert.equal(text.includes(unit), false, name);
});
test('the independent extraction of ON ends with two sentences on what a source is; the extraction of OFF and the one of v24 do not have them', () => {
  const rules = AI_EXTRACTION_SOURCE_RULES_V25;
  assert.equal(sentences(rules).length, 2, 'one to two sentences');
  assert.match(rules, /観察として述べた特徴だけを出所に/u); assert.match(rules, /つなぎの語/u); assert.match(rules, /留保の語/u); assert.match(rules, /同じ向きの出所は1件にまとめて/u);
  for (const rotation of [false, true]) for (const parts of [false, true]) {
    const on = memoAiExtractionPrompt(SHAPE_TERMINOLOGY_GENERATION, true, parts, rotation, true), v24 = memoAiExtractionPrompt(SHAPE_TERMINOLOGY_GENERATION, true, parts, rotation);
    assert.equal(on.endsWith('\n' + rules), true);
    assert.equal(on.split(rules).length, 2);
    assert.equal(v24.includes(rules), false);
    assert.equal(on.split('\n').includes(guidance.ROTATION_FEATURE_SOURCES_V25), rotation, 'the noun-unit line only with the rotation memory');
    assert.equal(on.includes(guidance.ROTATION_SOURCE_NOUN_UNIT_V25), rotation);
    assert.equal(memoAiExtractionPrompt(SHAPE_TERMINOLOGY_GENERATION, false, parts, rotation, true).includes(rules), false, 'no source is read: no rules');
  }
  assert.equal(MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS.includes(rules), false);
});
test('the private texts a v25 turn guards against echoing include the noun-unit sentence; the list of the earlier versions is unchanged', () => {
  assert.deepEqual(guidance.ROTATION_PRIVATE_TEXTS_V25, [...guidance.ROTATION_PRIVATE_TEXTS, guidance.ROTATION_SOURCE_NOUN_UNIT_V25]);
  assert.equal(guidance.ROTATION_PRIVATE_TEXTS.includes(guidance.ROTATION_SOURCE_NOUN_UNIT_V25), false);
});

// ---- 4. Banned words, versions ----
test('no v25 text uses a screen-position word the v2 requests ban', () => {
  const banned = /上段|下段|左上|右上|左下|右下/u;
  for (const text of [GENERATION_INSTRUCTIONS_V25, guidance.ROTATION_SOURCE_NOUN_UNIT_V25, AI_EXTRACTION_SOURCE_RULES_V25, ...CASES.map(([name, input]) => requestText('v25', input))]) assert.doesNotMatch(text, banned);
});
test('v25 is a v24-or-later and a v22-or-later generation, and every version-gated check that accepts v24 accepts it', () => {
  assert.equal(GENERATION_RETRY_V25, 'jev_generation_retry_v25');
  assert.equal(isGenerationV25(GENERATION_RETRY_V25), true); assert.equal(isGenerationV24(GENERATION_RETRY_V25), false);
  for (const version of [GENERATION_RETRY_V24, GENERATION_RETRY_V25]) {
    assert.equal(usesV24GenerationRules(version), true, version); assert.equal(usesV22GenerationRules(version), true, version);
    assert.equal(isIssueHandlingGeneration(version), true, version); assert.equal(isDeferredAiExtractionGeneration(version), true, version);
    assert.equal(validGenerationRetryVersion(version, 'two_stage_v3', 'holistic_v5'), true, version);
    assert.equal(hasVersionedViewpoint(version), true, version);
    assert.equal(validAgreeNameScope('jev_naming_v3', version), true, version);
  }
  for (const version of [GENERATION_RETRY_V22, GENERATION_RETRY_V23, 'jev_generation_retry_v21', undefined]) assert.equal(usesV24GenerationRules(version), false, String(version));
  assert.equal(validGenerationRetryVersion('jev_generation_retry_v26', 'two_stage_v3', 'holistic_v5'), false);
});

// ---- 5. The pipeline (offline, both strategies) ----
const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5', 'bypass_acceptance_v3', 'jev_repair_quality_v1');
const technical = { version: 'adaptive_repair_v3' } as const;
const figure = OWN.ownAnchors[0].id;
const choose = (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined;
const labels: Label[] = ['repair-first', 'bypass-enabled'];
const anchors = OWN.ownAnchors.slice(0, 3);
const rotationMemo = () => rotationInitialMemo(anchors, new Map(anchors.map((anchor: { id: string }, i: number) => [anchor.id,
  projectOwnRotationMemory({ figureKey: (['F6', 'F9', 'F1'] as const)[i], rotation: ([0, 90, 270] as const)[i] })!] as const)), '2026-01-01T00:00:00.000Z');

type Version = typeof GENERATION_RETRY_V24 | typeof GENERATION_RETRY_V25;
async function scene(version: Version, label: Label, check: 'off' | 'on', kind: 'confirm' | 'accept' | 'consult', withMemo = false) {
  const memo = withMemo ? structuredClone(rotationMemo()) : structuredClone(OLD.state.observationMemo);
  const own = withMemo ? { ...OWN, ownAnchors: anchors } : OWN;
  const state = initialState({ profile, generationRetryVersion: version, agreeNameScopeVersion: 'jev_naming_v3', memo: memo as never });
  if (withMemo) { state.ledger = Object.fromEntries(anchors.map((a: { id: string }) => [a.id, { status: 'unassigned', name: null }])); state.graph.slots = anchors.map((a: { id: string }) => a.id); }
  const requests: { provider: string; body: string }[] = [];
  const text = 'もう一つ特徴を確かめさせてください。';
  const speech = kind === 'confirm' ? (check === 'on' ? JSON.stringify({ text, observationFeatures: [] }) : JSON.stringify({ text })) : kind === 'accept' ? (check === 'on' ? undefined : text) : text;
  const plan: Plan = { postGenerationCheck: check, action: kind, target: kind === 'consult' ? 'none' : 'figure_0', referent: 'figure_0',
    ...(speech === undefined ? { drafts: [JSON.stringify({ text, observationFeatures: [] })] } : { speech }),
    choose: kind === 'consult' ? (key, criteria, context) => key === 'handled_issue' ? 'unknown' : choose(key) : choose,
    aiExtraction: check === 'on' && kind === 'confirm' ? JSON.stringify({ segments: [], visualFeatures: { sources: [] } }) : '[]',
    captureRequest(provider, body) { requests.push({ provider, body }); } };
  const result = await runTurn(profile, label, state, [{ seq: 1, speaker: 'human', text: '細い部分はどうつながっていますか？' }], plan, technical, version, own as never);
  return { requests, result };
}
const generation = (requests: { provider: string; body: string }[]) => requests.filter(request => request.provider === 'luna').map(request => JSON.parse(request.body))
  .find(body => body.messages?.[0]?.content?.startsWith('あなたは二者によるタングラム'));

for (const [kind, check, memo] of [['confirm', 'off', false], ['confirm', 'off', true], ['confirm', 'on', true], ['accept', 'off', false], ['consult', 'off', false], ['consult', 'off', true]] as const) {
  test(`v25 ${kind} (${check}${memo ? ', rotation memory' : ''}): both strategies get the same requests; against v24 only the generation request differs, by the cleanup's texts`, async () => {
    const [repair, bypass] = await Promise.all(labels.map(label => scene(GENERATION_RETRY_V25, label, check, kind, memo)));
    assert.deepEqual(repair.requests, bypass.requests, 'the same plan gets the same requests under both strategies');
    const v24 = await scene(GENERATION_RETRY_V24, 'repair-first', check, kind, memo);
    assert.equal(v24.requests.length, repair.requests.length);
    const different = repair.requests.flatMap((request, i) => request.body === v24.requests[i].body ? [] : [i]);
    // Only the generation request (and, with the sources asked, the independent extraction) differs; every Jev request and every other Luna request is the same bytes.
    for (const i of different) {
      const body = JSON.parse(repair.requests[i].body), first = String(body.messages?.[0]?.content ?? '');
      const generationRequest = first.startsWith('あなたは二者によるタングラム'), extraction = first.startsWith('1. 公開済みの対話の後に') && check === 'on';
      assert.ok(repair.requests[i].provider === 'luna' && (generationRequest || extraction), `request ${i} differs but is neither the generation nor the ON source extraction`);
    }
    assert.ok(different.length >= 1);
    const [g25, g24] = [generation(repair.requests), generation(v24.requests)];
    assert.ok(g25.messages[1].content.includes(UPTAKE_V25_Q) && !g25.messages[1].content.includes(UPTAKE_V24_Q));
    assert.ok(g24.messages[1].content.includes(UPTAKE_V24_Q));
    // Undo the cleanup's texts in the v25 generation request and it is the v24 request: nothing else moved.
    const undone = JSON.stringify(g25).split(JSON.stringify(UPTAKE_V25_Q).slice(1, -1)).join(JSON.stringify(UPTAKE_V24_Q).slice(1, -1));
    const rest = (value: string) => value;
    const plain = rest(undone);
    if (kind === 'confirm') assert.notEqual(plain, JSON.stringify(g24), 'a confirm also changed its action message');
    else assert.equal(plain, JSON.stringify(g24), `the ${kind} request differs from v24's only by the common question sentence`);
    if (check === 'off') assert.equal(different.length, 1, 'OFF: one request differs');
  });
}
