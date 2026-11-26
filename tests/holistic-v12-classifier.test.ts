import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJevLocalTestPayload, createJevLocalTestClassifier, ANSWERS_CHECKED_CRITERIA } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createReferenceGraph } from '../dialogue-model/runtime/memory/reference-graph.mjs';
import { applyVerifiedOperation } from '../dialogue-model/runtime/local-grounding/verify.ts';
import { RESEARCH_MAX_DEADLINE_MS } from '../dialogue-model/runtime/v2/research-timeouts.ts';

const input = {
  turn: 3,
  publicTurns: [{ turn: 2, speaker: 'ai' as const, text: '縁に切り込みがありますか？' }, { turn: 3, speaker: 'human' as const, text: 'ええ、あります。' }],
  segments: [{ segmentId: 'segment_1', quote: 'ええ、あります。', targets: [], aspect: 'question' as const, proposition: 'ええ、あります。', name: null, linkedIssueId: null, respondsToTurn: 2 }],
  priorClaims: [],
};
const policy = 'holistic_v5';

test('v12 payload: without the field the request is byte-identical to the earlier versions', () => {
  const plain = buildJevLocalTestPayload(input, 'two_stage_v3', policy);
  assert.deepEqual(Object.keys(plain.questions), ['segment_0_act', 'segment_0_antecedent']);
  assert.equal(JSON.stringify(buildJevLocalTestPayload(input, 'two_stage_v3', policy, false)), JSON.stringify(plain));
});

test('v12 payload: the field adds one closed question per segment and leaves the other questions unchanged', () => {
  const plain = buildJevLocalTestPayload(input, 'two_stage_v3', policy);
  const labelled = buildJevLocalTestPayload(input, 'two_stage_v3', policy, true);
  assert.deepEqual(Object.keys(labelled.questions), ['segment_0_act', 'segment_0_antecedent', 'segment_0_answer']);
  assert.equal(JSON.stringify(labelled.questions.segment_0_act), JSON.stringify(plain.questions.segment_0_act));
  assert.equal(JSON.stringify(labelled.questions.segment_0_antecedent), JSON.stringify(plain.questions.segment_0_antecedent));
  assert.deepEqual(Object.keys(labelled.questions.segment_0_answer.criteria), ['unknown', 'not_an_answer', 'answers_checked_point']);
  assert.equal(labelled.state, plain.state);
  assert.ok(Object.values(ANSWERS_CHECKED_CRITERIA).every(text => text.length < 400));
});

function classifier(answer: string | null) {
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(body.questions) as [string, { criteria: Record<string, string> }][]) {
      const labels = Object.keys(q.criteria);
      const choice = key.endsWith('_answer') ? answer! : key.endsWith('_antecedent') ? 'none' : 'agree';
      answers[key] = { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(l => [l, l === choice ? 1 : 0])) };
    }
    return Response.json({ model: 'typesafe/jev-1.14', id: 'gen-v12test', usage: { cost: 0 }, answers });
  };
  return createJevLocalTestClassifier({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-offline-key-000000', fetchImpl, costCapUsd: 0.05,
    researchLimits: { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS }, questionLayout: 'two_stage_v3', dialoguePolicy: policy })!;
}

for (const [label, expected] of [['answers_checked_point', 'yes'], ['not_an_answer', 'no'], ['unknown', 'unknown']] as const) {
  test('v12 classifier: ' + label + ' is returned as answersChecked ' + expected, async () => {
    const [verdict] = await classifier(label).classify(input, { answerField: true });
    assert.equal(verdict.act, 'agree');
    assert.equal(verdict.answersChecked, expected);
  });
}

test('v12 classifier: without the option no label is asked or returned', async () => {
  const [verdict] = await classifier(null).classify(input);
  assert.equal(verdict.act, 'agree');
  assert.ok(!Object.hasOwn(verdict, 'answersChecked'));
});

test('v12 classifier: an answer outside the closed set is an invalid response', async () => {
  await assert.rejects(classifier('answers_checked_point_maybe').classify(input, { answerField: true }), { code: 'invalid_response' });
});

test('partner_labelled_answer is a human-only claim source', () => {
  const claim = (speaker: 'human' | 'ai', source: string) => ({ kind: 'claim', id: '3:local1', issueId: '3:local1', targets: [], aspect: 'part', act: 'assert', proposition: 'ええ', name: null,
    speaker, sourceTurn: 3, quote: 'ええ', respondsTo: null, source });
  const graph = createReferenceGraph();
  const apply = (c: unknown) => applyVerifiedOperation(graph, { expectedRevision: graph.revision, turn: 3, operations: [] }, c, [{ turn: 3, speaker: 'human', text: 'ええ' }]);
  assert.equal(apply(claim('human', 'partner_statement')).applied, true);
  assert.equal(apply(claim('human', 'partner_labelled_answer')).applied, true);
  const forged = apply(claim('ai', 'partner_labelled_answer'));
  assert.deepEqual(forged, { applied: false, reason: 'memory_invalid_claim' });
});
