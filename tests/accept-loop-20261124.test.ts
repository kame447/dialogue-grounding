// Synthetic payload-level regressions for the partner-proposed name and the accept loop (two_stage_v3 only); no private data, no live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { buildJevDecisionPayload, buildJevDecisionDetailPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { LocalClaimView } from '../dialogue-model/runtime/local-grounding/contract.ts';

const V3 = { questionLayout: 'two_stage_v3' } as const;
const base = (): JevDecisionInput => JSON.parse(readFileSync(new URL('./fixtures/bypass-acceptance/MINIMAL-INPUT.json', import.meta.url), 'utf8'));
const claim = (patch: Partial<LocalClaimView>): LocalClaimView => ({ id: '1:h1', turn: 1, sourceTurn: 1, issueId: '1:i', targets: ['own-0'],
  aspect: 'name', act: 'name_propose', proposition: '蝶と呼ぶ', name: '蝶', speaker: 'human', quote: 'これは蝶とかどう？', respondsTo: null,
  source: 'partner_statement', ...patch });
function withPartnerName(patch: Partial<LocalClaimView> = {}): JevDecisionInput {
  const v = base();
  v.publicTurns = [{ turn: 1, speaker: 'human', text: 'これは蝶とかどう？' }];
  const c = claim(patch);
  v.priorClaims = [c];
  v.publicNames = [{ name: '蝶', figureId: c.targets.length === 1 ? c.targets[0] : null, sourceTurn: 1 }];
  v.agreeNames = c.targets.length === 1 ? [{ name: '蝶', figureId: c.targets[0], sourceTurn: 1 }] : [];
  return v;
}
const names = (v: JevDecisionInput, action: 'agree' | 'propose_name', figureId = 'own-0', layout: object = V3) =>
  Object.values(buildJevDecisionDetailPayload(v, { action, target: { kind: 'single', figureId } }, layout)!.questions.name.criteria).map(s => JSON.parse(s).value);
const actions = (v: JevDecisionInput, layout: object = V3) => buildJevDecisionPayload(v, layout).questions.action.criteria;

test('a name the partner proposed is offered to agree and not to propose_name (v3)', () => {
  const v = withPartnerName();
  assert.deepEqual(names(v, 'agree'), ['蝶']);
  assert.equal(names(v, 'propose_name').includes('蝶'), false);
  assert.ok(names(v, 'propose_name').length > 0, 'the AI own construal stays available');
});

test('a paraphrased proposal with another name is unaffected, and an unbound proposal covers every figure', () => {
  const v = withPartnerName({ targets: [] });
  for (const id of ['own-0', 'own-3']) assert.equal(names(v, 'propose_name', id).includes('蝶'), false);
  const other = withPartnerName({ name: '蜻蛉', quote: 'これは蜻蛉でどう？' });
  other.publicTurns = [{ turn: 1, speaker: 'human', text: 'これは蜻蛉でどう？蝶もあるね' }];
  other.publicNames = [{ name: '蝶', figureId: 'own-0', sourceTurn: 1 }];
  assert.equal(names(other, 'propose_name').includes('蝶'), true);
});

test('an AI-origin or non-proposal mention of the same word is still a legal propose_name candidate', () => {
  for (const patch of [{ speaker: 'ai' as const }, { act: 'assert' as const }]) {
    assert.equal(names(withPartnerName(patch), 'propose_name').includes('蝶'), true);
  }
});

test('v1/v2 catalogs keep the partner name for propose_name byte for byte', () => {
  const v = withPartnerName();
  for (const layout of ['two_stage_v1', 'two_stage_v2'] as const) assert.equal(names(v, 'propose_name', 'own-0', { questionLayout: layout }).includes('蝶'), true);
});

test('v3 action criteria separate answering a partner name from proposing, and forbid a repeated bare accept', () => {
  const c = actions(withPartnerName());
  assert.match(c.propose_name, /相手が先に公開した呼び名はAIの新しい提案として出し直さない/);
  assert.match(c.agree, /相手が公開上で提案した呼び名に異議や未解決点がなければ/);
  assert.match(c.accept, /直前のAI行動もacceptだった場合は、同じ受け止めを繰り返さない/);
  assert.match(c.accept, /相槌は名称採用や対象同定の根拠にならない/);
  assert.doesNotMatch(c.accept, /\d+回|[0-9]+ターン/, 'no fixed count');
});

test('v1/v2 action criteria are unchanged by the accept-loop text', () => {
  const v = withPartnerName();
  for (const layout of ['two_stage_v1', 'two_stage_v2'] as const) {
    const c = actions(v, { questionLayout: layout });
    assert.doesNotMatch(JSON.stringify(c), /同じ受け止めを繰り返さない|出し直さない/);
  }
});

test('the casual naming question is a name_propose criterion in two_stage_v3 classification requests only', async () => {
  const { LOCAL_FUNCTION_CRITERIA, LOCAL_FUNCTION_CRITERIA_V3, LOCAL_CLASSIFICATION_INSTRUCTIONS } = await import('../dialogue-model/runtime/local-grounding/classify.ts');
  const { buildJevLocalTestPayload } = await import('../dialogue-model/runtime/local-grounding/jev-local-test.ts');
  assert.match(LOCAL_FUNCTION_CRITERIA_V3.name_propose, /〜とかどう？/);
  assert.match(LOCAL_FUNCTION_CRITERIA_V3.name_propose, /見立てだけは含めない/);
  assert.match(LOCAL_FUNCTION_CRITERIA_V3.ask, /呼び名を提案する疑問形はname_propose/);
  assert.equal(LOCAL_FUNCTION_CRITERIA.name_propose.includes('とかどう'), false);
  assert.equal(LOCAL_CLASSIFICATION_INSTRUCTIONS.includes('とかどう'), false, 'the shared classifier instruction keeps its older bytes');
  const input = { turn: 2, publicTurns: [{ turn: 1, speaker: 'ai' as const, text: '丸い部分があります' }, { turn: 2, speaker: 'human' as const, text: 'これは蝶とかどう？' }],
    segments: [{ segmentId: 's1', quote: 'これは蝶とかどう？', targets: ['own-a'], aspect: 'name' as const, proposition: '蝶と呼ぶ', name: '蝶', linkedIssueId: null, respondsToTurn: null }],
    priorClaims: [] };
  const criteria = (layout?: 'two_stage_v1' | 'two_stage_v2' | 'two_stage_v3') => buildJevLocalTestPayload(input, layout).questions.segment_0_act.criteria;
  assert.deepEqual(criteria(), LOCAL_FUNCTION_CRITERIA);
  assert.deepEqual(criteria('two_stage_v2'), LOCAL_FUNCTION_CRITERIA);
  assert.deepEqual(criteria('two_stage_v3'), LOCAL_FUNCTION_CRITERIA_V3);
  assert.deepEqual(Object.keys(criteria('two_stage_v3')), Object.keys(LOCAL_FUNCTION_CRITERIA));
});

test('v3 agree criterion keeps the partner approval request open until answered, with reasons when not agreeing', () => {
  const c = actions(withPartnerName());
  assert.match(c.agree, /相手が自分の出した呼び名でよいかを尋ねている間は、その問いは答えるまで未回答/);
  assert.match(c.agree, /異議や不確実性があるときは、その理由を具体的に確かめるconfirmかrepair/);
});

test('the partner-name exclusion reads the claims that are actually sent: a proposal whose source turn was dropped leaves no exclusion', () => {
  const build = (keepSource: boolean): JevDecisionInput => {
    const v = withPartnerName();
    v.observations.figures[0].holistic.push({ ...v.observations.figures[0].holistic[0], construal: '蝶' }); // the AI's own observation happens to use the same word
    v.turn = 3;
    v.publicTurns = [...(keepSource ? [{ turn: 1, speaker: 'human' as const, text: 'これは蝶とかどう？' }] : []),
      { turn: 3, speaker: 'human', text: '続けましょう。' }];
    if (!keepSource) { v.publicNames = []; v.agreeNames = []; }
    return v;
  };
  const sent = (v: JevDecisionInput) => JSON.parse(buildJevDecisionPayload(v, V3).state).priorClaims.length;
  assert.equal(sent(build(true)), 1);
  assert.equal(sent(build(false)), 0, 'the claim without a retained source turn is not sent');
  assert.equal(names(build(true), 'propose_name').includes('蝶'), false);
  assert.equal(names(build(false), 'propose_name').includes('蝶'), true, 'catalog follows the sent list, so a replay from the request agrees');
});
