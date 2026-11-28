// Rotation memory in the prompts (C): the legend is defined once and carried once per call, the old single-view instructions that sent a different construal to re-observation are replaced
// only for a request whose memo carries a rotation memory, and every request without one keeps its bytes (the older byte-pinned suites cover those). Real bundle data (B1's projection), no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JEV_VISUAL_PURPOSE_VERSION } from '../dialogue-model/runtime/decision/contract.ts';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { ROTATION_V5, ROTATION_V5_90_180_270, buildHumanReferentPayload, buildJevDecisionPayload, buildJevTargetPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { ISSUE_HANDLING_VERSION } from '../dialogue-model/runtime/decision/issue-handling.ts';
import { JEV_REPAIR_QUALITY_VERSION } from '../dialogue-model/runtime/decision/repair-quality.ts';
import { SHAPE_TERMINOLOGY_GENERATION } from '../dialogue-model/runtime/shape-terminology.ts';
import { ROTATION_MEMORY_ENTRIES } from '../dialogue-model/runtime/stimuli/rotation-memory-data.ts';
import { projectOwnRotationMemory } from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import { AI_EXTRACTION_ROTATION_USE, COMMON_DIFFERENT_CONSTRUAL, EXTRACTION_ROTATION_USE, GENERATION_ROTATION_EDITS, REOBSERVATION_ROTATION_USE, ROTATION_ACCEPT_ANSWER,
  ROTATION_CONFIRM, ROTATION_LAYER_OF_CALL, ROTATION_LEGENDS, ROTATION_MATCH_USE, ROTATION_PROPOSE_NAME, applyGenerationRotationEdits, figureRotation, hasRotationMemory,
  rotationMemoryLayer, withRotationLayer } from '../dialogue-model/runtime/decision/rotation-memory-guidance.ts';
import { GENERATION_INSTRUCTIONS_V23, GENERATION_INSTRUCTIONS_V24 } from '../dialogue-model/runtime/v2/generation-prompt-v23.ts';
import { memoExtractionPrompt } from '../dialogue-model/runtime/local-grounding/extract.ts';
import { memoAiExtractionPrompt } from '../dialogue-model/runtime/local-grounding/extract-ai.ts';
import { OBSERVATION_TARGETED_INSTRUCTIONS, buildReobservationMessages } from '../dialogue-model/runtime/observation/observe.ts';
import { OWN, initialState, normal, runTurn } from './support/s4-v3-records.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';

const base = JSON.parse(readFileSync(new URL('./fixtures/bypass-acceptance/MINIMAL-INPUT.json', import.meta.url), 'utf8')) as JevDecisionInput;
const context = { questionLayout: 'two_stage_v3' as const, dialoguePolicy: 'holistic_v5' as const };
const COMPOSITION = '形・位置・接続は rotation を参照。';
// The figures the audits use (F6@0 has no whole construal now, F9@90 none at all in that view, F1@270 and F15@270 have both); the figure order is the own-anchor order.
const KEYS: [string, number][] = [['F6', 0], ['F9', 90], ['F1', 270], ['F15', 270], ['F19', 0], ['F23', 180]];
const rotationOf = (i: number) => projectOwnRotationMemory({ figureKey: KEYS[i][0], rotation: KEYS[i][1] })!;
const rotated = (figure: Record<string, unknown>, i: number) => ({ ...figure, holistic: [], analytic: { shapes: [], composition: COMPOSITION, relations: [] }, rotation: rotationOf(i) });

function input(count: number, withRotation: boolean, extra: Partial<JevDecisionInput> = {}): JevDecisionInput {
  const copy = structuredClone(base);
  const slots = ['s-000a', 's-000b', 's-000c', 's-000d', 's-000e', 's-000f'].slice(0, count);
  const figures = copy.observations.figures.slice(0, count).map((figure, i) => ({ ...figure, id: slots[i] }));
  return { ...copy, turn: 40, ownSlots: slots, observations: { ...copy.observations, figures: withRotation ? figures.map(rotated) as never : figures },
    publicTurns: [{ turn: 40, speaker: 'human', text: '図形を一つずつ教えてください。何かに見えますか？' }], priorClaims: [], repairHistory: [], previousAction: null, judgmentLedger: [],
    publicNames: [], visualPurposeVersion: JEV_VISUAL_PURPOSE_VERSION, p5Enabled: true, judgmentMaterialVersion: JEV_REPAIR_QUALITY_VERSION,
    issueHandlingVersion: ISSUE_HANDLING_VERSION, shapeTerminologyVersion: SHAPE_TERMINOLOGY_GENERATION, reobservationAllowed: true, ...extra };
}
const count = (text: string, part: string) => text.split(part).length - 1;

test('the legends define the data from the AI own side only, once per layer, with the confidence mark explained once', () => {
  for (const layer of ['nouns', 'roles', 'full'] as const) {
    const legend = ROTATION_LEGENDS[layer];
    assert.doesNotMatch(legend.replace('rel度', ''), /相手|盤面|relative|±|回転方式|[0-9]+度/u, layer);
    assert.equal(count(legend, '無ければ低'), 1, layer);
    assert.match(legend, /すべて仮説/u);
  }
  assert.ok(ROTATION_LEGENDS.nouns.length < ROTATION_LEGENDS.roles.length && ROTATION_LEGENDS.roles.length < ROTATION_LEGENDS.full.length);
});

test('a request without a rotation memory keeps the older instructions; one with it replaces them and states the legend once, in the state', () => {
  for (const n of [3, 4, 6]) {
    const old = buildJevDecisionPayload(input(n, false), context), next = buildJevDecisionPayload(input(n, true), context);
    const oldAction = old.questions.action, nextAction = next.questions.action;
    assert.equal(Object.hasOwn(JSON.parse(old.state), 'rotationLegend'), false);
    assert.ok(oldAction.instructions.includes(COMMON_DIFFERENT_CONSTRUAL) && oldAction.criteria.request_observation.includes('初期観察メモの向き'));
    const state = JSON.parse(next.state);
    assert.equal(state.rotationLegend, ROTATION_LEGENDS[ROTATION_LAYER_OF_CALL.decision]);
    assert.equal(count(JSON.stringify(next), ROTATION_LEGENDS.nouns), 1, 'the legend appears once in the whole request, never in a question');
    assert.ok(!nextAction.instructions.includes(COMMON_DIFFERENT_CONSTRUAL) && !nextAction.instructions.includes('画像の再観察を選べます。'.slice(0, 0) + '必要なら画像の再観察'));
    // The older chained accept criterion is one statement now, and the repair-quality paragraph is not appended a second time.
    assert.ok(nextAction.criteria.accept.includes(ROTATION_ACCEPT_ANSWER));
    assert.ok(!nextAction.criteria.accept.includes('図形全体や見た目を初めて尋ねられたとき') && !nextAction.criteria.accept.includes('相槌だけに同じ相槌を重ねるより'));
    assert.ok(nextAction.criteria.request_observation.startsWith('回転別メモ（rotation）にない') && nextAction.criteria.request_observation.includes('Terra'));
    assert.ok(!/初期観察メモ|回転下|別の見立て・/u.test(nextAction.criteria.request_observation));
    assert.equal(nextAction.criteria.confirm, ROTATION_CONFIRM);
    assert.equal(nextAction.criteria.propose_name, ROTATION_PROPOSE_NAME);
    // Every figure carries its nouns layer: one line per view; a view without a whole construal says so.
    const rotation = state.observations[0].rotation;
    assert.deepEqual(Object.keys(rotation), ['regions', 'current', 'turned', 'wholeAnywhere']);
    assert.match(rotation.current, /^全体: /u);
    assert.deepEqual(rotation.turned.map((t: { rel: number }) => t.rel), [90, 180, 270]);
    assert.ok(state.observations.every((o: { rotation?: unknown }) => typeof (o.rotation as { current?: unknown })?.current === 'string'));
  }
});

test('the target and referent questions carry the matching sentence once, and only with a rotation memory', () => {
  const withMemo = input(4, true), without = input(4, false);
  assert.equal(count(buildJevTargetPayload(withMemo, 'accept').questions.target.instructions, ROTATION_MATCH_USE), 1);
  assert.equal(count(buildHumanReferentPayload(withMemo).questions.human_referent.instructions, ROTATION_MATCH_USE), 1);
  assert.equal(buildJevTargetPayload(without, 'accept').questions.target.instructions.includes(ROTATION_MATCH_USE), false);
  assert.equal(buildHumanReferentPayload(without).questions.human_referent.instructions.includes(ROTATION_MATCH_USE), false);
});

test('the rotation memory feeds the name catalog: a figure with no whole construal in its current view can still be named from another view', () => {
  const i = input(4, true);
  // Figure 0 is F6@0 and figure 1 is F9@90; names come from every view of the figure (current first).
  const names = Object.keys(buildJevTargetPayload(i, 'propose_name').questions.target.criteria);
  assert.ok(rotationOf(0).wholeAnywhere && names.includes('figure_0'));
  const plain = input(4, false), figure = plain.observations.figures[0] as unknown as { holistic: unknown[] };
  figure.holistic = [];
  assert.equal(Object.keys(buildJevTargetPayload(plain, 'propose_name').questions.target.criteria).includes('figure_0'), false);
});

test('the three rotation modes differ only in their own task-condition sentence; the memo part is byte-identical', () => {
  const parts = ['relative_pm90', 'relative_0', 'relative_90_180_270'].map(mode => {
    const payload = buildJevDecisionPayload(input(4, true, { rotationMode: mode as never }), context);
    const action = payload.questions.action, state = JSON.parse(payload.state);
    const { rotationMode, ...rest } = state;
    return { mode, rotationMode, rest, instructions: action.instructions.replace('\n' + ROTATION_V5_90_180_270, '').replace('\n' + ROTATION_V5, ''),
      premise: action.instructions.includes(ROTATION_V5_90_180_270) ? '90_180_270' : action.instructions.includes(ROTATION_V5) ? 'pm90' : 'none', criteria: action.criteria };
  });
  assert.deepEqual(parts.map(p => p.premise), ['pm90', 'none', '90_180_270']);
  for (const p of parts.slice(1)) {
    assert.deepEqual(p.rest, parts[0].rest);
    assert.equal(p.instructions, parts[0].instructions);
    assert.deepEqual(p.criteria, parts[0].criteria);
  }
});

test('the nouns block is bounded: the worst six figures plus a long history still build a request, keep every figure memo and the latest human turn', () => {
  const sizes = ROTATION_MEMORY_ENTRIES.map(entry => ({ key: entry.figureKey, size: Math.max(...[0, 90, 180, 270].map(r =>
    JSON.stringify(rotationMemoryLayer(projectOwnRotationMemory({ figureKey: entry.figureKey, rotation: r })!, 'nouns')).length)) })).sort((a, b) => b.size - a.size);
  const worst = sizes.slice(0, 6);
  assert.ok(worst.reduce((sum, f) => sum + f.size, 0) <= 2400, JSON.stringify(worst));
  const copy = structuredClone(base), slots = ['s-000a', 's-000b', 's-000c', 's-000d', 's-000e', 's-000f'];
  const figures = copy.observations.figures.slice(0, 6).map((figure, i) => {
    const key = worst[i].key;
    const rotation = [0, 90, 180, 270].map(r => ({ r, p: projectOwnRotationMemory({ figureKey: key, rotation: r })! })).sort((a, b) =>
      JSON.stringify(rotationMemoryLayer(b.p, 'nouns')).length - JSON.stringify(rotationMemoryLayer(a.p, 'nouns')).length)[0].p;
    return { ...figure, id: slots[i], holistic: [], analytic: { shapes: [], composition: COMPOSITION, relations: [] }, rotation };
  });
  const lines = Array.from({ length: 120 }, (_, k) => ({ turn: k + 1, speaker: k % 2 === 0 ? 'human' : 'ai', text: '図形の形について、つながり方や大きさの違いを順に確かめています。'.repeat(6) }));
  const longInput = { ...input(6, true), turn: 121, observations: { ...copy.observations, figures: figures as never }, publicTurns: [...lines, { turn: 121, speaker: 'human', text: '最新の発話です。' }] } as JevDecisionInput;
  const payload = buildJevDecisionPayload(longInput, context), state = JSON.parse(payload.state);
  assert.ok(payload.state.length <= 20000);
  assert.ok(state.inputBudget.omitted.publicTurns > 0, 'the history, not the memo, gives way');
  assert.ok(state.observations.every((o: { rotation?: { current?: string } }) => typeof o.rotation?.current === 'string'));
  assert.ok(state.publicTurns.some((line: string) => line.endsWith('最新の発話です。')));
});

test('a malformed rotation memory is treated as absent: the request is the older one and nothing fails', () => {
  const broken = input(3, true);
  (broken.observations.figures[0] as unknown as { rotation: unknown }).rotation = { regions: [] };
  const mixed = buildJevDecisionPayload(broken, context), state = JSON.parse(mixed.state);
  assert.equal('rotation' in state.observations[0], false);
  assert.ok('rotation' in state.observations[1]);
  const allBroken = input(3, false);
  allBroken.observations.figures.forEach(figure => { (figure as unknown as { rotation: unknown }).rotation = { nope: 1 }; });
  assert.deepEqual(buildJevDecisionPayload(allBroken, context), buildJevDecisionPayload(input(3, false), context));
  assert.equal(hasRotationMemory(allBroken.observations), false);
});

test('generation instructions: the contradicting lines are replaced for v23 and v24 only when a rotation memory is present, and the older constants are untouched', () => {
  for (const text of [GENERATION_INSTRUCTIONS_V23, GENERATION_INSTRUCTIONS_V24]) {
    const next = applyGenerationRotationEdits(text);
    assert.ok(text.includes('自然な見立てがなければ全体の形でかまいません。') && !text.includes('見る角度によっては'));
    assert.ok(!next.includes('自然な見立てがなければ全体の形でかまいません。') && next.includes('見る角度によっては') && next.includes('自分側の想像の見立て'));
    assert.ok(next.includes('領域のid（P1など）'));
    assert.ok(!/[0-9]+度/u.test(GENERATION_ROTATION_EDITS.map(([, to]) => to).join('')));
  }
  assert.throws(() => applyGenerationRotationEdits('別の文面'), /out_of_sync/u);
});

test('extraction and re-observation texts are added only for a rotation memory; otherwise the bytes are the older ones', () => {
  assert.equal(memoExtractionPrompt(true, true, undefined, false, false), memoExtractionPrompt(true, true));
  assert.equal(memoExtractionPrompt(true, true, undefined, false, true), memoExtractionPrompt(true, true) + '\n' + EXTRACTION_ROTATION_USE);
  assert.equal(memoAiExtractionPrompt(undefined, false, false, true), memoAiExtractionPrompt() + '\n' + AI_EXTRACTION_ROTATION_USE);
  const anchors = ['s-000a', 's-000b', 's-000c'].map((id, i) => ({ id, bbox: { x: i * 10, y: 0, w: 9, h: 9 }, centroid: { x: i * 10 + 4.5, y: 4.5 } }));
  const memo = (withRotation: boolean) => ({ observedAt: '2026-01-01T00:00:00.000Z', figures: anchors.map((a, i) => ({ id: a.id, region: { ...a.bbox }, reobservations: [],
    ...(withRotation ? { holistic: [], analytic: { shapes: [], composition: COMPOSITION, relations: [] }, unknowns: [], rotation: rotationOf(i) }
      : { holistic: [], analytic: { shapes: [], composition: COMPOSITION, relations: [] }, unknowns: [] }) })) });
  const request = (withRotation: boolean) => buildReobservationMessages({ ownImage: OWN.ownImage as never, ownAnchors: anchors, memo: memo(withRotation) as never, figureIds: ['s-000a'],
    issue: { aspect: 'part', question: 'くちばしはありますか？', partnerConstrual: null } });
  const plain = request(false), withMemo = request(true);
  assert.equal(plain[0].content, OBSERVATION_TARGETED_INSTRUCTIONS);
  assert.equal(withMemo[0].content, OBSERVATION_TARGETED_INSTRUCTIONS + '\n' + REOBSERVATION_ROTATION_USE);
  const context = JSON.parse(String(withMemo[1].content));
  assert.equal(context.rotationLegend, ROTATION_LEGENDS.nouns);
  assert.equal(context.figures.length, 1);
  assert.equal(typeof context.figures[0].rotation.current, 'string');
  assert.equal(Object.hasOwn(JSON.parse(String(plain[1].content)), 'rotationLegend'), false);
});

test('the layers keep every noun, confidence mark and wholeAnywhere; a view without a whole construal is written as none', () => {
  for (const [key, rotation] of [['F6', 0], ['F9', 90], ['F1', 270], ['F15', 270]] as const) {
    const own = projectOwnRotationMemory({ figureKey: key, rotation })!;
    const views = [own.current, ...own.turned];
    for (const layer of ['nouns', 'roles', 'full'] as const) {
      const text = JSON.stringify(rotationMemoryLayer(own, layer));
      for (const view of views) {
        for (const w of view.whole) assert.ok(text.includes(w.noun), `${key} ${layer} ${w.noun}`);
        for (const list of Object.values(view.parts)) for (const c of list) assert.ok(text.includes(c.noun), `${key} ${layer} ${c.noun}`);
      }
      assert.ok(text.includes(`"wholeAnywhere":${own.wholeAnywhere}`));
    }
    const lines = JSON.stringify(rotationMemoryLayer(own, 'nouns'));
    assert.equal(count(lines, '全体: なし') > 0, views.some(v => v.whole.length === 0));
    assert.ok(!/posture|direction|roles|owner/u.test(lines));
    assert.ok(!/"owner"/u.test(JSON.stringify(rotationMemoryLayer(own, 'full'))));
  }
  // F15 at 270: the old template's construal ("翼や尖った突起") and, in the current view, the part noun 翼 are not offered (the other views of F15 keep 翼 as adopted).
  const f15 = projectOwnRotationMemory({ figureKey: 'F15', rotation: 270 })!;
  assert.ok(!JSON.stringify(f15.current.parts.P3 ?? []).includes('翼'));
  assert.ok(!JSON.stringify(withRotationLayer({ figures: [{ rotation: f15 }] }, 'full')).includes('翼や尖った突起'));
  assert.ok(figureRotation({ rotation: f15 }) !== null && figureRotation({}) === null && figureRotation({ rotation: { regions: [] } }) === null);
});

test('end to end (offline, both strategies): the decision, local extraction, AI extraction and generation each carry the rotation memory in their own layer, once', async () => {
  const manifest = normal.run.manifest;
  const profile = JSON.parse(JSON.stringify(researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, 'two_stage_v3', 'holistic_v5', 'bypass_acceptance_v3', 'jev_repair_quality_v1')));
  const anchors = OWN.ownAnchors.slice(0, 3), slots = anchors.map((a: { id: string }) => a.id);
  const memo = { observedAt: '2026-01-01T00:00:00.000Z', figures: anchors.map((a: { id: string; bbox: object }, i: number) => ({ id: a.id, region: { ...a.bbox }, reobservations: [], unknowns: [],
    holistic: [], analytic: { shapes: [], composition: COMPOSITION, relations: [] }, rotation: rotationOf(i) })) };
  const state = initialState({ profile, memo: memo as never, generationRetryVersion: 'jev_generation_retry_v24', agreeNameScopeVersion: 'jev_naming_v3' });
  state.ledger = Object.fromEntries(slots.map((id: string) => [id, { status: 'unassigned', name: null }]));
  state.graph.slots = slots;
  state.observationMemo = structuredClone(memo);
  const own = { ...OWN, ownAnchors: anchors };
  const runs: Record<string, { provider: string; body: string }[]> = {};
  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    const captures: { provider: string; body: string }[] = [];
    await runTurn(profile, label, structuredClone(state), [{ id: 'event-1', seq: 1, speaker: 'human', text: '一つ目の図形は何かに見えますか？' }], {
      postGenerationCheck: 'off', action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '見る角度によっては、鳥のようにも見えます。', aiExtraction: '[]',
      choose: (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined,
      captureRequest: (provider: string, body: string) => captures.push({ provider, body }) } as never, { version: 'adaptive_repair_v3' }, 'jev_generation_retry_v24', own, label);
    runs[label] = captures;
  }
  assert.deepEqual(runs['repair-first'], runs['bypass-enabled'], 'both strategies are sent the same requests');
  const bodies = runs['repair-first'].map(c => ({ provider: c.provider, text: c.body, json: JSON.parse(c.body) }));
  const decision = bodies.find(b => b.provider === 'jev' && b.json.questions?.action);
  assert.ok(decision);
  assert.equal(Object.keys(JSON.parse(decision.json.state)).filter(key => key === 'rotationLegend').length, 1);
  assert.equal(JSON.parse(decision.json.state).rotationLegend, ROTATION_LEGENDS.nouns);
  const luna = bodies.filter(b => b.provider === 'luna');
  const memoMessages = luna.flatMap(b => (b.json.messages as { content: unknown }[]).map(m => String(m.content))).filter(text => text.includes('"rotationLegend"'));
  assert.ok(memoMessages.length >= 3, 'generation, local extraction and AI extraction carry the memo');
  for (const text of memoMessages) { assert.equal(count(text, '"rotationLegend"'), 1); assert.ok(text.includes(JSON.stringify(ROTATION_LEGENDS.roles).slice(1, -1))); }
  const generation = luna.find(b => (b.json.messages as { content: unknown }[]).some(m => String(m.content).includes('見る角度によっては〜')));
  assert.ok(generation, 'the generation instructions carry the rotation lines');
  // Nothing from the researcher side reaches any request: no bank figure key, no absolute rotation word, no mode name inside the memo part, no old template construal.
  for (const b of bodies) {
    assert.doesNotMatch(b.text, /"F\d{1,2}"|figureKey|angles|absolute/u);
    assert.ok(!b.text.includes('翼や尖った突起'));
  }
});
