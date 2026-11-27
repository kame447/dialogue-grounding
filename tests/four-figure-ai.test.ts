import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObservationMessages, observationInitialInstructions, OBSERVATION_INITIAL_INSTRUCTIONS,
  parseInitialObservation, validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';
import { createWorkerTerraObserver, type WorkerTerraCache } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V1 } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { buildJevDecisionPayload, buildJevCandidateSetPayload, buildJevTargetPayload, createJevDecisionClient,
  JEV_DECISION_MODEL, projectDecisionFailureEvidence, checkDecisionFailureEvidence,
  type JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { PARTICIPANT_TARGET_MENU_VERSION, type JevDecisionInput, type JevQuestionLayout } from '../dialogue-model/runtime/decision/contract.ts';
import { taskInstructionsV2, TASK_INSTRUCTIONS_V2, RESEARCH_TASK_INSTRUCTIONS_V2 } from '../dialogue-model/runtime/judgment/instructions.mjs';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { initialObservationFormatForMessages, INITIAL_OBSERVATION_FORMAT } from '../workers/research-ai-proxy/src/initial-observation-format.ts';
import { handleRequest } from '../workers/research-ai-proxy/src/index.mjs';
import { judgmentV5Legend, JUDGMENT_V5_LEGEND } from '../dialogue-model/runtime/decision/judgment-material-v5.ts';

const observedAt = '2026-11-20T00:00:00.000Z';
function own(count = 4) {
  return { ownImage: { mimeType: 'image/png' as const, base64: Buffer.from('synthetic AI board').toString('base64') },
    ownAnchors: Array.from({ length: count }, (_, i) => ({ id: `s-000${i}`,
      bbox: { x: i * 20, y: 0, w: 10, h: 10 }, centroid: { x: i * 20 + 5, y: 5 } })) };
}
function initial(count = 4) {
  return { figures: own(count).ownAnchors.map(({ id }) => ({ id,
    holistic: [{ construal: '船', basis: ['細い部分'], status: 'hypothesis' as const }],
    analytic: { shapes: ['三角'], composition: '辺でつながる', relations: [] }, unknowns: [] })) };
}
function input(count = 4): JevDecisionInput {
  return { turn: 4, ownSlots: own(count).ownAnchors.map(a => a.id),
    observations: parseInitialObservation(JSON.stringify(initial(count)), own(count), { observedAt }),
    issueSummary: '対象が未特定', priorClaims: [], repairHistory: [], previousAction: null,
    publicTurns: [{ turn: 1, speaker: 'ai', text: 'どの図形から話しましょうか' },
      { turn: 2, speaker: 'human', text: '細長い形を船と呼びたいです' },
      { turn: 3, speaker: 'ai', text: 'この形を船と呼ぶのはどうですか' },
      { turn: 4, speaker: 'human', text: 'どれのことか分からないです' }],
    publicNames: [{ name: '船', figureId: 's-0000', sourceTurn: 3 }],
    agreeNames: [{ name: '船', figureId: 's-0000', sourceTurn: 3 }], reobservationAllowed: true };
}
function answer(payload: JevDecisionPayload, preferences: Record<string, string> = {}) {
  return { model: JEV_DECISION_MODEL, id: 'gen-four-figure',
    answers: Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => {
      const labels = Object.keys(q.criteria), selected = preferences[key] ?? labels[0];
      assert.ok(labels.includes(selected), `${key}: ${selected} must exist`);
      return [key, { type: 'choice', choice: selected,
        probabilities: Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0])) }];
    })), usage: { input_tokens: 10, output_tokens: 0, cost: 0.0001 } };
}
const readKey = async () => 'sk-or-SYNTHETIC-four-figure-key-000000';

// This list is the independent oracle for all nonsingleton subsets of four figures.
const fourSets = ['figures_0_1', 'figures_0_2', 'figures_0_3', 'figures_1_2', 'figures_1_3', 'figures_2_3',
  'figures_0_1_2', 'figures_0_1_3', 'figures_0_2_3', 'figures_1_2_3', 'figures_0_1_2_3'];
test('four observations match exactly their own anchors; both cross-count restores fail', () => {
  const four = input().observations, six = input(6).observations;
  assert.equal(four.figures.length, 4);
  assert.deepEqual(validateObservationMemo(four, { ownAnchors: own().ownAnchors }), four);
  assert.throws(() => validateObservationMemo(four, { ownAnchors: own(6).ownAnchors }), { code: 'invalid_input' });
  assert.throws(() => validateObservationMemo(six, { ownAnchors: own().ownAnchors }), { code: 'invalid_input' });
  assert.throws(() => parseInitialObservation(JSON.stringify(initial(6)), own(), { observedAt }));
  assert.throws(() => parseInitialObservation(JSON.stringify(initial()), own(6), { observedAt }));
  assert.throws(() => buildJevDecisionPayload({ ...input(), observations: six }));
  assert.throws(() => buildJevDecisionPayload({ ...input(6), observations: four }));
  for (const count of [3, 5, 7]) assert.throws(() => buildObservationMessages(own(count)));
});

test('four candidate questions offer exactly 11 subsets and 16 general targets without nonexistent figures', () => {
  const candidates = Object.keys(buildJevCandidateSetPayload(input(), 'confirm').questions.candidate_set.criteria);
  assert.deepEqual(candidates, fourSets);
  const labels = Object.keys(buildJevTargetPayload(input(), 'accept').questions.target.criteria);
  assert.deepEqual(labels, ['none', 'figure_0', 'figure_1', 'figure_2', 'figure_3', ...fourSets]);
  const stageOne = buildJevDecisionPayload(input());
  assert.deepEqual(Object.keys(stageOne.questions), ['action', 'target', 'candidate_0', 'candidate_1', 'candidate_2', 'candidate_3']);
  assert.equal(Object.keys(buildJevCandidateSetPayload(input(6), 'confirm').questions.candidate_set.criteria).length, 57);
  assert.equal(Object.keys(buildJevTargetPayload(input(6), 'accept').questions.target.criteria).length, 64);
});

test('participant menu uses 16 general, 4 revisit and 15 observation targets and restores only one figure count', async () => {
  const requests: JevDecisionPayload[] = [];
  let raw: unknown;
  const client = createJevDecisionClient({ enabled: true, readKey, participantTargetMenu: true,
    async fetchImpl(_url, init) {
      const payload = JSON.parse(String(init.body)) as JevDecisionPayload;
      requests.push(payload);
      return requests.length === 1 ? Response.json(answer(payload, { action: 'confirm', feature_target: 'figure_0' }))
        : Response.json({}, { status: 503 });
    } })!;
  await assert.rejects(client.decide(input(), { onFailureEvidence: value => { raw = value; } }));
  const q = requests[0].questions;
  assert.equal(Object.keys(q.general_target.criteria).length, 16);
  assert.equal(Object.keys(q.revisit_target.criteria).length, 4);
  assert.equal(Object.keys(q.observation_target.criteria).length, 15);
  for (const [key, question] of Object.entries(q)) if (key !== 'action') {
    assert.ok(Object.keys(question.criteria).every(label => label === 'none' || /^figure_[0-3]$/.test(label) || /^subset_/.test(label) && Number(label.slice(7)) < 16));
    assert.equal(JSON.stringify(question.criteria).includes('s-0004'), false);
    assert.equal(JSON.stringify(question.criteria).includes('s-0005'), false);
  }
  const record = projectDecisionFailureEvidence(raw, 'two_stage_v1', { figureCount: 4, decisionMenuVersion: PARTICIPANT_TARGET_MENU_VERSION });
  assert.ok(record, JSON.stringify(raw));
  assert.deepEqual(checkDecisionFailureEvidence(record, { figureCount: 4 }), record);
  assert.equal(checkDecisionFailureEvidence(record), null);
  const mixed = structuredClone(record);
  mixed.stages[0].scores.revisit_target.figure_4 = 0;
  mixed.stages[0].scores.revisit_target.figure_5 = 0;
  assert.equal(checkDecisionFailureEvidence(mixed, { figureCount: 4 }), null);
  assert.equal(checkDecisionFailureEvidence(mixed), null);
});

for (const layout of ['two_stage_v2', 'two_stage_v3'] as JevQuestionLayout[]) {
  test(`${layout} completes four-figure selection and rejects nonexistent IDs in failed evidence`, async () => {
    const requests: JevDecisionPayload[] = [];
    const client = createJevDecisionClient({ enabled: true, readKey, questionLayout: layout,
      async fetchImpl(_url, init) {
        const payload = JSON.parse(String(init.body)) as JevDecisionPayload;
        requests.push(payload);
        return Response.json(answer(payload, { action: 'confirm', target: layout === 'two_stage_v2' ? 'multiple' : 'figures_0_1',
          candidate_set: 'figures_0_1' }));
      } })!;
    const decision = await client.decide(input());
    assert.deepEqual(decision.target, { kind: 'multiple', figureIds: ['s-0000', 's-0001'] });
    assert.equal(requests.length, 3);
    let raw: unknown;
    const failing = createJevDecisionClient({ enabled: true, readKey, questionLayout: layout,
      async fetchImpl(_url, init) {
        const payload = JSON.parse(String(init.body)) as JevDecisionPayload;
        if ('feature' in payload.questions) return Response.json({}, { status: 503 });
        return Response.json(answer(payload, { action: 'confirm', target: layout === 'two_stage_v2' ? 'multiple' : 'figures_0_1',
          candidate_set: 'figures_0_1' }));
      } })!;
    await assert.rejects(failing.decide(input(), { onFailureEvidence: value => { raw = value; } }));
    const record = projectDecisionFailureEvidence(raw, layout, { figureCount: 4 });
    assert.ok(record, JSON.stringify(raw));
    assert.deepEqual(checkDecisionFailureEvidence(record, { figureCount: 4 }), record);
    const tampered = structuredClone(record);
    const stage = tampered.stages.find(s => s.stage === (layout === 'two_stage_v2' ? 'multiple_candidates' : 'target'))!;
    stage.scores[layout === 'two_stage_v2' ? 'candidate_set' : 'target'].figures_0_4 = 0;
    assert.equal(checkDecisionFailureEvidence(tampered, { figureCount: 4 }), null);
  });
}

test('proxy derives exact structured count from the matching trusted instruction and anchor envelope', () => {
  const four = buildObservationMessages(own()), six = buildObservationMessages(own(6));
  const format = initialObservationFormatForMessages(four)!;
  const figures = format.json_schema.schema.properties.figures as { minItems: number; maxItems: number };
  assert.deepEqual([figures.minItems, figures.maxItems], [4, 4]);
  assert.strictEqual(initialObservationFormatForMessages(six), INITIAL_OBSERVATION_FORMAT);
  assert.equal(observationInitialInstructions(6), OBSERVATION_INITIAL_INSTRUCTIONS);
  assert.match(String(four[0].content), /全4図形/);
  assert.equal(initialObservationFormatForMessages([six[0], ...four.slice(1)]), null);
  assert.equal(initialObservationFormatForMessages([four[0], ...six.slice(1)]), null);
  const duplicate = own(); duplicate.ownAnchors[3] = duplicate.ownAnchors[0];
  assert.equal(initialObservationFormatForMessages([four[0], { role: 'user', content: JSON.stringify({ ownAnchors: duplicate.ownAnchors }) }]), null);
});

test('structured four-figure Terra observes through the proxy, caches separately and reobserves', async () => {
  const pin = validateParticipantModelPin({ schemaVersion: 'participant_model_pin_v1',
    terraModelId: 'gpt-6.1-terra-2026-11-01', lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261001' });
  const env = { RESEARCH_PROXY_TOKEN: 'synthetic-only-proxy-token-for-tests-184',
    UPSTREAM_API_KEY: 'synthetic-only-upstream-key', DIALOGUE_MODEL: pin.lunaModelId, VISION_MODEL: pin.terraModelId };
  const entries = new Map<string, unknown>(), calls: any[] = [];
  const cache: WorkerTerraCache = {
    async read(key) { return structuredClone(entries.get(key)); },
    async putIfAbsent(key, value) {
      if (!entries.has(key)) entries.set(key, structuredClone(value));
      return structuredClone(entries.get(key));
    },
  };
  function observer(count: number) {
    return createWorkerTerraObserver({ own: own(count), modelPin: pin, cache,
      now: () => new Date(observedAt), initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V1,
      async visual(payload) {
        const targeted = Object.hasOwn(JSON.parse(String(payload.messages[1].content)), 'figureIds');
        const request = new Request('https://mock.invalid/v1/chat/completions', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEARCH_PROXY_TOKEN}` },
          body: JSON.stringify({ ...payload, response_format: { type: 'json_object' }, schema: 'client-schema-ignored' }) });
        const response = await handleRequest(request, env, async (_url, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return Response.json({ model: pin.terraModelId,
            choices: [{ message: { content: JSON.stringify(targeted ? { figures: [{ figureId: 's-0000',
              supports: ['小さい三角'], contradicts: [], unknown: [] }] } : initial(count)) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3 } });
        }, pin.terraModelId);
        return { status: response.status, data: await response.json() };
      } });
  }
  const four = observer(4), six = observer(6);
  const memo = await four.observeAll(own());
  await six.observeAll(own(6));
  assert.deepEqual(await observer(4).observeAll(own()), memo);
  assert.equal(entries.size, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.response_format.json_schema.schema.properties.figures.maxItems), [4, 6]);
  const result = await four.reobserve({ ...own(), memo, figureIds: ['s-0000'],
    issue: { aspect: 'part', question: '確認', partnerConstrual: null } });
  assert.equal(result.figures[0].figureId, 's-0000');
  assert.equal(Object.hasOwn(calls[2], 'response_format'), false);
});

test('both strategies teach four figures for generation and final submission while six constants stay unchanged', async () => {
  assert.equal(taskInstructionsV2(6), TASK_INSTRUCTIONS_V2);
  assert.equal(taskInstructionsV2(6, true), RESEARCH_TASK_INSTRUCTIONS_V2);
  assert.match(taskInstructionsV2(4), /タングラム4図形/);
  assert.match(taskInstructionsV2(4, true), /タングラム4図形/);
  const sent: any[][] = [];
  for (const strategy of ['bypass-enabled', 'repair-first']) {
    const dialogue = createDialogueV2({ strategy, image: own().ownImage, anchors: own().ownAnchors,
      client: { async complete(messages: any[]) { sent.push(messages); return { text: '{}' }; } } });
    await dialogue.finalRequest({ events: [], privateState: dialogue.initialPrivateState() }, true);
    assert.match(sent.at(-1)![0].content, /タングラム4図形/);
    assert.match(sent.at(-1)!.at(-1).content, /自分の4図形/);
    assert.match(sent.at(-1)!.at(-1).content, /内部参照ID4個/);
    assert.equal(JSON.stringify(sent.at(-1)).includes('自分の6図形'), false);
  }
  assert.deepEqual(sent[0], sent[1]);
});


test('compact judgment legend teaches only f0 through f3 for four figures and preserves the six-figure constant', () => {
  assert.equal(judgmentV5Legend(6), JUDGMENT_V5_LEGEND);
  assert.match(judgmentV5Legend(4), /f0〜f3はownSlots/);
  assert.doesNotMatch(judgmentV5Legend(4), /f0〜f5/);
  for (const count of [4, 6]) {
    const payload = buildJevDecisionPayload({ ...input(count), judgmentLedger: [] });
    const state = JSON.parse(payload.state);
    assert.deepEqual(Object.keys(state.figures), Array.from({ length: count }, (_, i) => `f${i}`));
    for (const question of Object.values(payload.questions)) {
      assert.ok(question.instructions.includes(judgmentV5Legend(count)));
      if (count === 4) assert.doesNotMatch(question.instructions, /f0〜f5/);
    }
  }
});
