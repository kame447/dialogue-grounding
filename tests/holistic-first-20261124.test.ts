// Synthetic only. Holistic-first (whole reading first, parts only when needed), two_stage_v3 technical trial, identical for both strategies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { buildJevDecisionPayload, buildJevDraftActPayload, createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { findNamingActHints } from '../dialogue-model/runtime/v2/generation-guard.ts';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { BYPASS_ACCEPTANCE_V1_CANONICAL_JSON, BYPASS_ACCEPTANCE_V1_TABLE_SHA256 } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { LOCAL_FUNCTION_CRITERIA, LOCAL_FUNCTION_CRITERIA_V3 } from '../dialogue-model/runtime/local-grounding/classify.ts';
import { anchors as s4Anchors, image as s4Image, memo as s4Memo } from './support/s4-integration/harness.ts';

const slots = Array.from({ length: 6 }, (_, i) => `s-000${i}`);
const input = (): JevDecisionInput => ({ turn: 2, ownSlots: slots,
  publicTurns: [{ turn: 1, speaker: 'ai', text: 'まず、どの図形から話しましょうか？' }, { turn: 2, speaker: 'human', text: 'どんな図形がありますか？' }],
  observations: { observedAt: '2026-10-20T00:00:00.000Z', figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
    holistic: [{ construal: `見立て${i}`, basis: ['丸みのある部分'], status: 'hypothesis' }],
    analytic: { shapes: [`三角${i}`], composition: `構成${i}`, relations: [`関係${i}`] }, unknowns: [], reobservations: [] })) },
  issueSummary: '', priorClaims: [], publicNames: [], repairHistory: [], previousAction: null } as unknown as JevDecisionInput);
const criteria = (layout: 'two_stage_v1' | 'two_stage_v2' | 'two_stage_v3') => buildJevDecisionPayload(input(), { questionLayout: layout, ...(layout === 'two_stage_v3' ? { dialoguePolicy: 'holistic_v1' as const } : {}) }).questions.action.criteria;
const READINGS = /ペンギン|馬|犬|猫|鳥|風車|魚|拳|家|蝶/u;

test('Jev v3 criteria: whole reading first, parts only when needed, no stalling once shared; v1/v2 are unchanged', () => {
  const v3 = criteria('two_stage_v3');
  assert.match(v3.accept, /全体の見立てを先に/u);
  assert.match(v3.accept, /見立ては説明であり、名前の提案・採用ではない/u);
  assert.match(v3.confirm, /観察で答えられる細部の質問にはconfirmで聞き返さず、acceptで直接答える（分からない点は分からないと述べる）/u);
  assert.match(v3.confirm, /聞き返すのは、対象や論点に具体的な未解決点があり、相手から情報を得る必要があるとき/u);
  assert.doesNotMatch(v3.confirm, /細部を尋ねられたときに/u, 'a detail question that observation can answer is not a reason to ask back');
  assert.match(v3.confirm, /すでに肯定された特徴については選ばない/u);
  assert.match(v3.defer, /残りの数だけで保留を一律に禁止も許可もせず/u);
  assert.match(v3.revisit, /話を延ばすためだけには選ばない/u);
  for (const layout of ['two_stage_v1', 'two_stage_v2'] as const) assert.doesNotMatch(JSON.stringify(criteria(layout)), /全体の見立てを先に|一律に禁止も許可もせず/u);
  assert.doesNotMatch(JSON.stringify(v3), /ペンギン|風車|馬/u, 'no specific reading is named');
});

test('the intervention table and its SHA-256 are untouched', () => {
  assert.equal(BYPASS_ACCEPTANCE_V1_TABLE_SHA256, '376d569120ca36a3eceaf5ab95410f7eb83f25fbb681e7566a684b97c35165c8');
  assert.equal(createHash('sha256').update(BYPASS_ACCEPTANCE_V1_CANONICAL_JSON).digest('hex'), BYPASS_ACCEPTANCE_V1_TABLE_SHA256);
});

test('the v3 local classification keeps a reading ("looks like ...") apart from a naming proposal', () => {
  assert.match(LOCAL_FUNCTION_CRITERIA_V3.name_propose, /見立てだけは含めない/u);
  assert.match(LOCAL_FUNCTION_CRITERIA_V3.construe, /命名とは区別する/u);
  assert.equal(LOCAL_FUNCTION_CRITERIA.construe, LOCAL_FUNCTION_CRITERIA_V3.construe);
});

async function generation(strategy: 'repair-first' | 'bypass-enabled', human: string, reply: string) {
  const lunaPayloads: { role: string; content: string }[][] = [];
  const jevDecision = createJevDecisionClient({ enabled: true, questionLayout: 'two_stage_v3', readKey: async () => 'sk-or-SYNTHETIC-holistic-first-key',
    fetchImpl: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const answers: Record<string, { type: 'choice'; choice: string; probabilities: Record<string, number> }> = {};
      for (const [k, q] of Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>)) {
        const keys = Object.keys(q.criteria), choice = k === 'action' ? 'accept' : k === 'target' ? 'none' : keys[0];
        answers[k] = { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(c => [c, c === choice ? 1 : 0])) };
      }
      return new Response(JSON.stringify({ id: 'resp-1', model: body.model, answers, usage: { cost: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    } })!;
  const dialogue = createDialogueV2({
    client: { async complete(messages: { role: string; content: string }[], options?: { phase?: string }) {
      if (options?.phase === 'generation') { lunaPayloads.push(messages); return { text: reply }; }
      return { text: JSON.stringify({ segments: [] }) };
    } },
    strategy, image: s4Image, anchors: s4Anchors, referenceMemory: true, decisionMode: 'jev', questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v1',
    technicalTrial: { version: 'adaptive_repair_v3' }, interventionPolicy: { version: 'bypass_acceptance_v1', tableSha256: BYPASS_ACCEPTANCE_V1_TABLE_SHA256 },
    decisionTimeoutMs: 5000,
    observer: { async observeAll() { return s4Memo() as never; }, async reobserve() { throw new Error('unused'); } },
    jevDecision, localGrounding: { classifier: { async classify() { return []; } } },
  } as never);
  const result = await dialogue.runAiTurn({ events: [{ id: 'e1', seq: 1, speaker: 'ai', text: 'まず、どの図形から話しましょうか？', nonReferential: true },
    { id: 'e2', seq: 2, speaker: 'human', text: human }], privateState: await dialogue.initializePrivateState!(), lastEventId: 'e2', requestSeq: 1 });
  assert.equal(result.text, reply);
  return lunaPayloads[0];
}

test('the confirm scope only checks the feature the decision chose', async () => {
  const { HOLISTIC_V3_ACTION_SCOPE_V2: scope } = await import('../dialogue-model/runtime/v2/dialogue-v2.mjs') as unknown as { HOLISTIC_V3_ACTION_SCOPE_V2: Record<string, string> };
  assert.match(scope.confirm, /判断で選ばれた特徴だけを確かめ、ほかの部品の確認を足さない/u);
  assert.doesNotMatch(scope.confirm, /足りるときは部品の確認に進まない|相手が絞れない/u, 'whether to confirm is the decision\'s call, not the generator\'s');
});

test('the v3 trial generation text puts the whole reading first and answers several figures each, identically for both strategies', async () => {
  for (const [human, reply] of [['どんな図形がありますか？', '全体は丸みのある形です。'], ['先端に小さい四角ついてる？', 'うん、端に小さな四角がついてる。'],
    ['残りの三つはどんな形？', '一つ目は細長い形、二つ目は三角が重なった形、三つ目は角ばった形です。']] as const) {
    const [repair, bypass] = await Promise.all((['repair-first', 'bypass-enabled'] as const).map(s => generation(s, human, reply)));
    assert.deepEqual(repair, bypass, human);
    const system = repair.filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.match(system, /図形全体を尋ねられた最初の説明/u);
    assert.match(system, /形の分析（部分の形・つながり・配置）は、判断にdiscriminatingFeatureがあるときだけ/u);
    assert.match(system, /判断が求めていない部品の確認や、すでに肯定された特徴の再確認を自分から足さず/u);
    // When to analyse is Jev's call (HOLISTIC_CONFIRM_V3), not the generator's.
    assert.doesNotMatch(system, /相手が対象を絞れない|似た候補が残る|見立てが食い違う/u);
    assert.match(system, /最初から細部を尋ねられたときはその質問に直接答え、毎回先頭へ見立てを付けないでください/u);
    assert.match(system, /複数の図形をまとめて尋ねられたときは、求められた図形それぞれに短く答えてください/u);
    assert.match(system, /全体の見立てを述べることは、名前の提案や採用ではありません/u);
    assert.doesNotMatch(system, /共通教示の分析トリガー/u, 'the older trigger sentence is replaced, not contradicted');
    assert.doesNotMatch(system, /必要なら全体の印象/u);
    assert.doesNotMatch(system, READINGS, 'the instruction names no specific reading and gives no fixed sentence');
  }
});

test('a naming decision written as 「X」で呼びましょう / そう呼びます is not published under a non-agree act (two_stage_v3), questions are fine', async () => {
  const { findExtendedNamingDecisions, findGuardViolations } = await import('../dialogue-model/runtime/v2/generation-guard.ts');
  for (const text of ['はい、「名前」で呼びましょう。', 'じゃあそう呼びます。']) {
    assert.deepEqual(findGuardViolations(text, 'accept'), [], 'the shared guard keeps its narrower family (v1/v2 unchanged)');
    assert.deepEqual(findExtendedNamingDecisions(text), ['naming_decision'], text);
  }
  for (const text of ['「名前」で呼びましょうか？', '「名前」で呼ぶのはどうでしょう？', '全体は丸い形です。']) assert.deepEqual(findExtendedNamingDecisions(text), [], text);
});



const draftInput = (draft: string) => ({ turn: 2, publicTurns: input().publicTurns, reasons: ['naming_words'],
  selected: { action: 'accept' as const, target: { kind: 'single' as const, figureId: slots[0] }, name: null }, draft });
test('the draft-naming question is one closed question with six labels, no example sentence and no particular phrase as a condition', () => {
  const payload = buildJevDraftActPayload(draftInput('この形はそう見えます。'));
  assert.deepEqual(Object.keys(payload.questions), ['draft_naming']);
  assert.deepEqual(Object.keys(payload.questions.draft_naming.criteria), ['adopt_chosen', 'adopt_other', 'decline_or_hold', 'propose_question', 'recount_only', 'none']);
  const text = JSON.stringify(payload.questions);
  assert.doesNotMatch(text, /[「」『』]/u);
  assert.doesNotMatch(text, /(?:呼びましょう|決めましょう|でいい|おっけー|オッケー)/u);
  assert.ok(JSON.parse(payload.state).draft === 'この形はそう見えます。');
});
test('the draft-naming question reports a transport or response failure as status error, never as a pass, and an ok label with its evidence', async () => {
  const body = (choice: string) => ({ model: 'typesafe/jev-1.14', id: 'gen-draft-1', usage: { cost: 0 }, answers: { draft_naming: { type: 'choice', choice,
    probabilities: Object.fromEntries(['adopt_chosen', 'adopt_other', 'decline_or_hold', 'propose_question', 'recount_only', 'none'].map(k => [k, Number(k === choice)])) } } });
  const ok = createJevDecisionClient({ enabled: true, questionLayout: 'two_stage_v3', readKey: async () => 'sk-or-SYNTHETIC-draft-key', timeoutMs: 3000,
    fetchImpl: async () => Response.json(body('recount_only')) })!;
  const good = await ok.classifyDraftAct!(draftInput('提案は「X」でしたね。'), { dialoguePolicy: 'holistic_v1' });
  assert.equal(good.status, 'ok'); assert.equal(good.choice, 'recount_only'); assert.equal(good.responseId, 'gen-draft-1');
  for (const fetchImpl of [async () => { throw new Error('boom'); }, async () => Response.json({ model: 'typesafe/jev-1.14', id: 'x', usage: { cost: 0 }, answers: {} }),
    async () => new Response('x', { status: 500 })]) {
    const bad = createJevDecisionClient({ enabled: true, questionLayout: 'two_stage_v3', readKey: async () => 'sk-or-SYNTHETIC-draft-key', timeoutMs: 3000, fetchImpl: fetchImpl as any })!;
    const r = await bad.classifyDraftAct!(draftInput('提案は「X」でしたね。'), { dialoguePolicy: 'holistic_v1' });
    assert.equal(r.status, 'error'); assert.equal(r.choice, null); assert.equal(typeof r.error, 'string');
  }
});
test('naming-act wording is only a hint to ask: pre-holistic words, 「で呼…」「で決め…」, the 「呼び名は『X』です」 type, and quoted strings', () => {
  for (const text of ['それでいいですね、「X」にしましょう。', 'この形は「X」で呼びましょう。', 'この形は「X」で決めましょう。', 'この形の呼び名は『X』です。']) assert.equal(findNamingActHints(text).wording, true, text);
  for (const text of ['細い部分が二つつながっています。', '「X」で呼びますか？', 'そう見えるんですね。']) assert.equal(findNamingActHints(text).wording, false, text);
  assert.deepEqual(findNamingActHints('あなたの案は「風車」でしたね。').quoted, ['風車']);
});
