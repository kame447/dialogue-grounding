import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATOR_INSTRUCTIONS_V2, ACTION_SCOPE_V2, LUNA_GENERATOR_INSTRUCTIONS_V2, LUNA_ACTION_SCOPE_V2,
} from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { buildJevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { interventionForStrategy, BYPASS_ACCEPTANCE_V1_TABLE_SHA256 } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { findGuardViolations, findOrientationLeaks } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { findLocalPublicationViolations } from '../dialogue-model/runtime/v2/local-grounding-turn.ts';
import { anchors as s4Anchors, image as s4Image, memo as s4Memo } from './support/s4-integration/harness.ts';

const slots = Array.from({ length: 6 }, (_, i) => `s-000${i}`);
function input(): JevDecisionInput {
  return { turn: 2, ownSlots: slots,
    publicTurns: [{ turn: 1, speaker: 'ai', text: 'ちょっと変わった形です' }, { turn: 2, speaker: 'human', text: '先端に小さい四角ついてる？' }],
    observations: { observedAt: '2026-10-20T00:00:00.000Z', figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
      holistic: [{ construal: `見立て${i}`, basis: ['頭のような部分'], status: 'hypothesis' }],
      analytic: { shapes: [`三角${i}`, '四角が一つ'], composition: `構成${i}`, relations: [`関係${i}`] }, unknowns: ['向きは不明'], reobservations: [] })) },
    issueSummary: '', priorClaims: [], publicNames: [], repairHistory: [],
    previousAction: null } as unknown as JevDecisionInput;
}
const criteria = (layout: 'two_stage_v1' | 'two_stage_v2' | 'two_stage_v3') =>
  buildJevDecisionPayload(input(), { questionLayout: layout }).questions.action.criteria;

test('tone: fixed polite register is replaced, not contradicted', () => {
  for (const text of [GENERATOR_INSTRUCTIONS_V2, LUNA_GENERATOR_INSTRUCTIONS_V2]) {
    assert.doesNotMatch(text, /親しみやすい/);
    assert.match(text, /敬語には自然な敬語で、くだけた口調には自然なくだけた口調/);
    assert.match(text, /相槌や言い回しも合わせ/);
  }
});

test('feature questions: direct answer, three-way observation honesty, no naming jump, no testing questions', () => {
  for (const text of [GENERATOR_INSTRUCTIONS_V2, LUNA_GENERATOR_INSTRUCTIONS_V2]) {
    assert.match(text, /まずその問いに直接答えてください/);
    assert.match(text, /命名の依頼と取り違えず/);
    assert.match(text, /呼び名の提案や採用に進まないでください/);
    assert.match(text, /ある・ない・確かめられない/);
    assert.match(text, /「〜っぽい」のような曖昧な表現へ変えたりしないでください/);
    assert.match(text, /形式的な確認質問を付け足さない/);
    assert.match(text, /「これなら分かりますか？」/);
    assert.match(text, /未解決の曖昧さがあるときだけ、その点を具体的に尋ねてください/);
    assert.match(text, /形の分析の開始には当たりません/);
  }
});

test('accept no longer forbids answering; naming and joint identification stay forbidden', () => {
  assert.doesNotMatch(GENERATOR_INSTRUCTIONS_V2, /受け止めるだけ/);
  assert.doesNotMatch(GENERATOR_INSTRUCTIONS_V2, /相手が出した名前を候補として受けるだけ/);
  assert.match(GENERATOR_INSTRUCTIONS_V2, /判断に示された名前を「」で候補として示/);
  assert.doesNotMatch(ACTION_SCOPE_V2.propose_name, /どの図形と理解したかを示すか名前を出すだけ/);
  assert.match(ACTION_SCOPE_V2.propose_name, /判断の名前を「」で候補として示す/);
  for (const scope of [ACTION_SCOPE_V2, LUNA_ACTION_SCOPE_V2]) {
    assert.doesNotMatch(scope.accept, /受け止めるだけ/);
    assert.match(scope.accept, /直接答えてよい/);
    assert.match(scope.accept, /名前に決まった・対象を共同で特定できたとは言わない/);
    assert.match(scope.confirm, /決まった・それでいこうとは言わない/);
  }
});

test('strategy difference stays: defer/move_on handling is untouched and identical for both strategies', () => {
  assert.notDeepEqual(interventionForStrategy('repair-first'), interventionForStrategy('bypass-enabled'));
  for (const text of [GENERATOR_INSTRUCTIONS_V2, LUNA_GENERATOR_INSTRUCTIONS_V2]) assert.match(text, /defer\/revisitは保留・再訪であることが分かるように/);
  assert.match(ACTION_SCOPE_V2.defer, /後で戻る/);
  assert.match(ACTION_SCOPE_V2.move_on, /別の図形に進む/);
});

test('Jev two_stage_v3 criteria: accept answers feature questions, confirm only for unresolved points, propose_name after the target is shared', () => {
  const v3 = criteria('two_stage_v3');
  assert.match(v3.accept, /ある・ない・不明のいずれか.*confirmにせず、このacceptで直接答える/);
  assert.match(v3.accept, /理解成立や名称採用を宣言せず/);
  assert.match(v3.confirm, /特徴を尋ねられただけでは選ばず/);
  if (Object.hasOwn(v3, 'propose_name')) assert.match(v3.propose_name, /公開上で相手に伝わり/);
});

test('Jev two_stage_v1/v2 criteria stay byte-identical to the prior wording', () => {
  for (const layout of ['two_stage_v1', 'two_stage_v2'] as const) {
    const c = criteria(layout);
    assert.equal(c.accept, '通常の受け止め・応答。理解成立や名称採用を宣言せず、これだけをやり過ごしと数えない。');
    assert.doesNotMatch(JSON.stringify(c), /acceptで直接答える|特徴を尋ねられただけ/);
  }
});

test('runtime two_stage_v3: both strategies deliver identical prompts across 5 contrast scenarios and pass all guards on casual/polite answers', async () => {
  const scenarios = [
    { label: 'appearance_question', human: 'どんな見た目の図形がありますか？', reply: '細長い先に小さな四角がついた形がありますよ。' },
    { label: 'unknown_target', human: 'どの図形の話かまだ分からないです。', reply: 'すみません、細長い部分の端に小さな四角がついている形のことです。' },
    { label: 'feature_present_casual', human: '先端に正方形の小さい四角ついてる？', reply: 'うん、端に小さな正方形がついてる。' },
    { label: 'feature_absent_casual', human: '先端に丸い穴みたいなの開いてる？', reply: 'ううん、端に穴みたいなのは見えてないよ。' },
    { label: 'feature_unknown_polite', human: 'その角の角度はちょうど45度でしょうか？', reply: 'すみません、正確な角度まではこちらでは確かめられません。' },
  ];
  for (const s of scenarios) {
    const captures: Record<string, { jev: unknown[]; luna: unknown[] }> = {};
    for (const strategy of ['repair-first', 'bypass-enabled'] as const) {
      const jevPayloads: unknown[] = [];
      const lunaPayloads: unknown[] = [];
      const jevDecision = createJevDecisionClient({
        enabled: true, questionLayout: 'two_stage_v3', readKey: async () => 'sk-or-SYNTHETIC-prompt-style-regression-key',
        fetchImpl: async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          jevPayloads.push(body);
          const answers: Record<string, { type: 'choice'; choice: string; probabilities: Record<string, number> }> = {};
          for (const [k, q] of Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>)) {
            const keys = Object.keys(q.criteria);
            const choice = k === 'action' ? 'accept' : k === 'target' ? 'figure_0' : keys[0];
            answers[k] = { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(c => [c, c === choice ? 1 : 0])) };
          }
          return new Response(JSON.stringify({ id: 'resp-1', model: body.model, answers, usage: { cost: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      })!;
      const dialogue = createDialogueV2({
        client: {
          async complete(messages: unknown[], options?: { phase?: string }) {
            if (options?.phase === 'generation') { lunaPayloads.push(messages); return { text: s.reply }; }
            return { text: JSON.stringify({ segments: [] }) };
          },
        },
        strategy, image: s4Image, anchors: s4Anchors, referenceMemory: true, decisionMode: 'jev', questionLayout: 'two_stage_v3',
        technicalTrial: { version: 'adaptive_repair_v3' },
        interventionPolicy: { version: 'bypass_acceptance_v1', tableSha256: BYPASS_ACCEPTANCE_V1_TABLE_SHA256 },
        decisionTimeoutMs: 5000,
        observer: { async observeAll() { return s4Memo() as unknown as import('../dialogue-model/runtime/observation/contract.ts').ObservationMemo; }, async reobserve() { throw new Error('unused'); } },
        jevDecision,
        localGrounding: {
          classifier: { async classify() { return []; } },
        },
      } as unknown as Parameters<typeof createDialogueV2>[0]);
      const initial = await dialogue.initializePrivateState!();
      const result = await dialogue.runAiTurn({
        events: [
          { id: 'e1', seq: 1, speaker: 'ai', text: 'まず、どの図形から話しましょうか？', nonReferential: true },
          { id: 'e2', seq: 2, speaker: 'human', text: s.human },
        ],
        privateState: initial, lastEventId: 'e2', requestSeq: 1,
      });
      assert.equal(result.text, s.reply, s.label);
      assert.deepEqual(findGuardViolations(s.reply, 'accept'), [], s.label);
      assert.deepEqual(findOrientationLeaks(s.reply), [], s.label);
      assert.deepEqual(findLocalPublicationViolations(s.reply, lunaPayloads[0] as { role: string; content: string }[]), [], s.label);
      captures[strategy] = { jev: jevPayloads, luna: lunaPayloads };
    }
    assert.deepEqual(captures['repair-first'], captures['bypass-enabled'], `strategy parity for ${s.label}`);
    const systemText = (captures['repair-first'].luna[0] as { role: string; content: string }[]).filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.doesNotMatch(systemText, /親しみやすい|受け止めるだけ/);
    assert.match(systemText, /敬語には自然な敬語で、くだけた口調には自然なくだけた口調/);
    assert.match(systemText, /直接答えてよい/);
  }
});
