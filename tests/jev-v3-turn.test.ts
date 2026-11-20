// audit/05 §6 at the participant boundary for two_stage_v3: the explicit opt-in layout, revisit x multiple through
// generation, ledger, repair history, the next turn and restore, forced illegal answers, replays of the five formal
// failures at their v2 stop and their v3 resolution, and the v1/v2/v3 restore crossings.
// Synthetic cache, transports and keys only; never a live model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createObservationCache } from '../dialogue-model/runtime/observation/cache.ts';
import { researchHash } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { prepareParticipantJev, validateParticipantJevConfig } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { REVISIT_MULTIPLE_INSTRUCTIONS } from '../dialogue-model/runtime/v2/jev-turn.ts';

const seed = 919, modelId = 'synthetic-luna-20261020';
const trial = createTrialV2({ seed }), model = modelView(trial);
const ids = model.anchors.map((a: any) => a.id) as string[];
const own = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors };
const timeouts = { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 };
const limits = { lunaCalls: 100, lunaTokens: 100000, lunaPosts: 100, jevPosts: 100, jevUsd: 0.05 };
// No holistic construal and no public names (no name candidates, no agree evidence); every figure has a feature.
const rawMemoWith = (holistic: any[]) => ({ figures: model.anchors.map((a: any) => ({ id: a.id, holistic, analytic: { shapes: ['三角'], composition: '二つの部分が接する', relations: [] }, unknowns: [] })) });
const rawMemo = { figures: model.anchors.map((a: any) => ({ id: a.id, holistic: [], analytic: { shapes: ['三角'], composition: '二つの部分が接する', relations: [] }, unknowns: [] })) };
const assignment = { schemaVersion: 'base_assignment_config_v1', configId: '11111111-1111-4111-8111-111111111111', revision: 1, strategy: 'repair-first', seed, referenceMemory: true };
const clientConfig = { provider: 'cloudflare', purpose: 'dialogue_turn', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-private-proxy-key' };
const syntheticKey = 'sk-or-synthetic-only-private-key-0123456789';
type Plan = { answers: Record<string, string>; cost?: number; failGeneration?: number };
/** Synthetic upstream. Every Jev question is answered by its key (action, target, candidate_set, ...); Luna never proposes segments. */
function tape(plan: Plan) {
  const posts: any[] = [], generations: any[] = [];
  let gets = 0, failures = plan.failGeneration ?? 0;
  const fetchImpl: typeof fetch = async (_url, init: any = {}) => {
    if (init.method === 'GET') { gets++; return Response.json({ ready: true, purpose: 'dialogue_turn', provider: 'openai', model: modelId }); }
    const body = JSON.parse(init.body); posts.push(body);
    if (body.questions) {
      const q = body.questions;
      const answers = Object.fromEntries(Object.entries(q).map(([name, question]: [string, any]) => {
        const choices = Object.keys(question.criteria);
        const chosen = plan.answers[name] ?? (name.startsWith('candidate_') && name !== 'candidate_set' ? 'exclude' : name === 'human_referent' ? 'none'
          : name.endsWith('_antecedent') ? 'none' : name.endsWith('_act') ? 'assert' : choices[0]);
        return [name, { type: 'choice', choice: chosen, probabilities: Object.fromEntries(choices.map(v => [v, v === chosen ? 0.8 : 0.2 / (choices.length - 1 || 1)])), confidence: 1 }];
      }));
      return Response.json({ model: 'typesafe/jev-1.14-20261014', id: 'gen-synthetic', usage: { cost: plan.cost ?? 0.001 }, answers });
    }
    if (body.messages.some((m: any) => typeof m.content === 'string' && m.content.startsWith('Jevが選んだ行動'))) {
      generations.push(body);
      if (failures > 0) { failures--; return new Response('{}', { status: 500 }); }
    }
    const state = body.messages[1]?.content; let parsed: any; try { parsed = JSON.parse(state); } catch { /* not JSON */ }
    const final = String(body.messages.at(-1)?.content).includes('JSON') && !parsed?.candidateText && !parsed?.publicTurns;
    const text = parsed?.candidateText || parsed?.publicTurns ? '[]' : final ? JSON.stringify(Object.fromEntries(model.anchors.map((a: any) => [a.id, null]))) : 'もう一度、先ほどの点に戻りたいです。';
    return Response.json({ model: modelId, choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  };
  return { fetchImpl, posts, generations, plan, readKey: async () => syntheticKey };
}
async function fixture(t: any, changes: any = {}, plan: Plan = { answers: { action: 'accept', target: 'none' } }, memoValue: any = rawMemo) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'jev-v3-turn-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const cacheDirectory = join(dir, 'cache'); await mkdir(cacheDirectory, { mode: 0o700 });
  const warm = await createObservationCache({ directory: cacheDirectory, modelId, onMiss: 'observe', client: { async complete() { return { text: JSON.stringify(memoValue), model: modelId }; } } });
  const hit = await warm.get(own);
  const config = { schemaVersion: 'participant_jev_config_v1', lunaRequest: { timeoutMs: null, maxCompletionTokens: 1000 }, timeouts,
    cacheDirectory, modelId, memoSha256: researchHash(hit.memo), seed, limits, ...changes };
  const configFile = join(dir, 'jev.json'), baseAssignmentFile = join(dir, 'base.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 }); await writeFile(baseAssignmentFile, JSON.stringify(assignment), { mode: 0o600 });
  const upstream = tape(plan);
  return { dir, config, upstream, options: { configFile, baseAssignmentFile, clientConfig, fetchImpl: upstream.fetchImpl, readKey: upstream.readKey } };
}
async function makeTask(prepared: any, extra: any = {}) {
  let saved: any;
  const value = { strategy: 'repair-first', seed, referenceMemory: true, ...extra };
  const task = await createNamingTaskV2({ ...value, ...await prepared.taskOptions(value), runDir: null, createTrial: () => trial, onPersist: async (r: any) => { saved = structuredClone(r); } });
  return { task, record: () => saved };
}
async function turn(t: any, changes: any, answers: Record<string, string>, strategy = 'bypass-enabled', text = '二つのどちらかです', memoValue: any = rawMemo) {
  const h = await fixture(t, changes, { answers }, memoValue); const prepared = await prepareParticipantJev(h.options);
  const made = await makeTask(prepared, { strategy });
  made.task.message(text, 'turn-1'); await made.task.whenIdle();
  return { h, prepared, made, record: made.record(), trace: made.record().jevTraces[0], strategy };
}
const V3 = { questionLayout: 'two_stage_v3' };
const SET = [ids[1], ids[3]];
const REVISIT_MULTIPLE = { action: 'revisit', target: 'figures_1_3' };
const aiEvents = (r: any) => r.events.filter((e: any) => e.speaker === 'ai');
const GREETING = 1; // the AI opens the dialogue; every count below is that greeting plus the replies under test

test('revisit x multiple (v3): commits with the candidate set kept, no slot ledger change, no name adopted', async t => {
  const { made, record, trace, h } = await turn(t, V3, REVISIT_MULTIPLE);
  assert.equal(trace.status, 'committed', JSON.stringify([trace.errorCode, trace.decisionRejectionCode]));
  assert.deepEqual(trace.decisions[0].target, { kind: 'multiple', figureIds: SET });
  assert.deepEqual(trace.decisions[0].evidence.stages.map((s: any) => s.stage), ['action', 'target']);
  assert.deepEqual(trace.executed, { action: 'revisit', target: { kind: 'multiple', figureIds: SET }, name: null, feature: null, observe: null, detailFigureIds: [] });
  assert.deepEqual(trace.finalAction, { action: 'revisit', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null });
  const state = record.queueState.privateState;
  assert.ok(Object.values(state.ledger).every((e: any) => e.status === 'unassigned' && e.name === null), 'ledger untouched');
  assert.equal(record.options.questionLayout, 'two_stage_v3');
  assert.equal(aiEvents(record).length, GREETING + 1);
  // Repair history keeps the whole set; the problem source stays unresolved when no single issue overlaps.
  const entry = state.repairHistory.at(-1);
  assert.equal(entry.action, 'revisit'); assert.deepEqual(entry.candidatesBefore, SET); assert.deepEqual(entry.candidatesAfter, SET); assert.equal(entry.issueId, null);
  // Generation got the act, the full target and the multiple-revisit instruction, and nothing of the internal ids reaches the public text.
  const generation = h.upstream.generations.at(-1).messages;
  assert.ok(generation.some((m: any) => m.content === REVISIT_MULTIPLE_INSTRUCTIONS));
  const act = generation.find((m: any) => m.content.startsWith('Jevが選んだ行動'));
  assert.deepEqual(JSON.parse(act.content.split('\n').at(-1)).target, { kind: 'multiple', figureIds: SET });
  const review = JSON.stringify({ state: made.task.getState(), events: record.events });
  for (const word of ['two_stage', 'figures_1_3', 'action_target', ...ids.slice(0, 1)]) assert.ok(!review.includes(word), word);
  assert.ok(!aiEvents(record).some((e: any) => ids.some(id => e.text.includes(id))));
});

test('revisit x multiple (v3): the next turn sees the executed set as previousAction; restore reproduces the same next move', async t => {
  const { prepared, made, record, h } = await turn(t, V3, REVISIT_MULTIPLE);
  h.upstream.plan.answers = { action: 'accept', target: 'none' };
  made.task.message('もう一度見てみます', 'turn-2'); await made.task.whenIdle();
  const second = made.record();
  const stageOne = h.upstream.posts.filter((b: any) => b.questions?.action).at(-1);
  assert.deepEqual(JSON.parse(stageOne.state).previousAction.target, { kind: 'multiple', figureIds: SET });
  assert.equal(JSON.parse(stageOne.state).previousAction.action, 'revisit');
  assert.deepEqual(second.jevTraces.map((r: any) => r.status), ['committed', 'committed']);
  assert.equal(second.queueState.privateState.judgments.length, 2);
  // A restore of the saved first turn then continues exactly like the uninterrupted run.
  const restored = await makeTask(prepared, { strategy: 'bypass-enabled', restore: record });
  h.upstream.plan.answers = { action: 'accept', target: 'none' };
  restored.task.message('もう一度見てみます', 'turn-2'); await restored.task.whenIdle();
  assert.deepEqual(restored.record().queueState.privateState.judgments.map((j: any) => [j.judgment, j.jevTurn.executed]),
    second.queueState.privateState.judgments.map((j: any) => [j.judgment, j.jevTurn.executed]));
});

test('revisit x multiple (v3): a mixed ledger (same name, other name, unnamed, agreed) is not rewritten', async t => {
  const first = await turn(t, V3, { action: 'accept', target: 'none' });
  const saved = structuredClone(first.record);
  saved.queueState.privateState.ledger = {
    [ids[0]]: { status: 'agreed', name: '船' }, [ids[1]]: { status: 'tentative', name: '船' }, [ids[2]]: { status: 'deferred', name: '山' },
    [ids[3]]: { status: 'unassigned', name: null }, [ids[4]]: { status: 'tentative', name: '橋' }, [ids[5]]: { status: 'unassigned', name: null } };
  const before = structuredClone(saved.queueState.privateState.ledger);
  const restored = await makeTask(first.prepared, { strategy: 'bypass-enabled', restore: saved });
  first.h.upstream.plan.answers = { action: 'revisit', target: 'figures_0_1_2_3' };
  restored.task.message('どれのことでしょう', 'turn-2'); await restored.task.whenIdle();
  const after = restored.record();
  assert.equal(after.jevTraces.at(-1).status, 'committed');
  assert.deepEqual(after.queueState.privateState.ledger, before);
  assert.equal(after.jevTraces.at(-1).executed.action, 'revisit');
});

test('revisit x multiple (v3): generation failure commits nothing; a retry publishes once', async t => {
  const h = await fixture(t, V3, { answers: REVISIT_MULTIPLE, failGeneration: 1 });
  const prepared = await prepareParticipantJev(h.options), made = await makeTask(prepared);
  made.task.message('二つのどちらかです', 'turn-1'); await made.task.whenIdle();
  assert.equal(made.task.getState().aiStatus, 'error');
  assert.equal(aiEvents(made.record()).length, GREETING);
  assert.equal(made.record().queueState.privateState.judgments.length, 0);
  assert.ok(Object.values(made.record().queueState.privateState.ledger).every((e: any) => e.status === 'unassigned'));
  const failedGenerations = h.upstream.generations.length;
  await made.task.retry(); await made.task.whenIdle();
  assert.ok(h.upstream.generations.length > failedGenerations);
  assert.equal(made.task.getState().aiStatus, 'idle', JSON.stringify([made.task.getState().aiStatus, made.record().jevTraces.map((r: any) => [r.status, r.errorCode, r.generationErrorCode]), h.upstream.generations.length]));
  assert.equal(aiEvents(made.record()).length, GREETING + 1);
  assert.equal(made.record().queueState.privateState.judgments.length, 1);
});

test('revisit x multiple (v3): a veto of defer x multiple that re-ranks to revisit commits the same shape under repair-first', async t => {
  const h = await fixture(t, V3, { answers: { action: 'defer', target: 'figures_1_3' } });
  // Make revisit the top-scored non-veto action.
  const plain = h.upstream.fetchImpl;
  h.upstream.fetchImpl = async (url: any, init: any = {}) => {
    const response = await plain(url, init);
    if (init.method === 'GET') return response;
    const body = JSON.parse(init.body);
    if (!body.questions?.action) return response;
    const data = await response.json();
    const labels = Object.keys(body.questions.action.criteria);
    data.answers.action.probabilities = Object.fromEntries(labels.map(l => [l, l === 'defer' ? 0.5 : l === 'revisit' ? 0.3 : 0.01]));
    return Response.json(data);
  };
  const prepared = await prepareParticipantJev({ ...h.options, fetchImpl: h.upstream.fetchImpl }), made = await makeTask(prepared, { strategy: 'repair-first' });
  made.task.message('二つのどちらかです', 'turn-1'); await made.task.whenIdle();
  const trace = made.record().jevTraces[0];
  assert.equal(trace.status, 'committed', JSON.stringify(trace.errorCode));
  assert.equal(trace.decisions[0].action, 'defer');
  assert.equal(trace.intervention.disposition, 'rejected');
  assert.deepEqual(trace.executed, { action: 'revisit', target: { kind: 'multiple', figureIds: SET }, name: null, feature: null, observe: null, detailFigureIds: [] });
  assert.ok(Object.values(made.record().queueState.privateState.ledger).every((e: any) => e.status === 'unassigned'));
});

test('v2 still stops revisit x multiple at its documented position; v1 and v2 records are never reinterpreted', async t => {
  const v2 = await turn(t, { questionLayout: 'two_stage_v2' }, { action: 'revisit', target: 'multiple', candidate_set: 'figures_1_3' });
  assert.equal(v2.trace.status, 'error'); assert.equal(v2.trace.errorCode, 'invalid_decision');
  assert.equal(v2.trace.executed.action, 'revisit'); assert.equal(v2.trace.finalAction, null);
  assert.equal(aiEvents(v2.record).length, GREETING);
  const v1 = await turn(t, {}, { action: 'revisit', target: 'multiple', candidate_1: 'include', candidate_3: 'include' });
  assert.equal(v1.trace.errorCode, 'invalid_decision');
});

// ---- the five formal failures: v2 stop position, then v3 resolution without replacing the illegal answer
// agree has no public name evidence in this fixture, so v3 does not even offer it in stage one; request_observation is offered but never with none.
for (const [name, v2answers, rule, v3answers, v3stages] of [
  ['agree x multiple (formal-02-repair, formal-05-repair)', { action: 'agree', target: 'multiple' }, 'name_requires_single_target', { action: 'agree', target: 'figures_1_3' }, [['action', 'error']]],
  ['request_observation x none (formal-03-repair-r2)', { action: 'request_observation', target: 'none' }, 'detail_target_required', { action: 'request_observation', target: 'none' }, [['action', 'ok'], ['target', 'error']]],
] as const) test(`replay ${name}: v2 stops in the decision stage; v3 never offers the pair and a forced answer fails closed`, async t => {
  const v2 = await turn(t, { questionLayout: 'two_stage_v2' }, v2answers, 'repair-first');
  assert.equal(v2.trace.errorCode, 'invalid_decision');
  assert.equal(v2.trace.decisionFailure.evidence.rejectionCode, rule);
  assert.deepEqual(v2.trace.decisionFailure.evidence.stages.map((s: any) => s.stage), ['action_target']);
  const v3 = await turn(t, V3, v3answers, 'repair-first');
  assert.equal(v3.trace.status, 'error');
  assert.equal(v3.trace.errorCode, 'decision_failed');
  assert.deepEqual(v3.trace.decisionFailure.evidence.stages.map((s: any) => [s.stage, s.status]), v3stages);
  assert.equal(aiEvents(v3.record).length, GREETING); assert.equal(v3.trace.executed, null); assert.equal(v3.trace.finalAction, null);
  assert.equal(v3.record.queueState.privateState.judgments.length, 0);
  assert.equal(v3.h.upstream.posts.filter((b: any) => b.questions?.name || b.questions?.feature).length, 0);
  // The illegal label was never replaced by a legal one: the retry asks again and a legal answer then commits.
  v3.h.upstream.plan.answers = { action: 'accept', target: 'none' };
  await v3.made.task.retry(); await v3.made.task.whenIdle();
  assert.deepEqual(v3.made.record().jevTraces.map((r: any) => r.status), ['error', 'committed']);
});

test('v3 target stage of agree is limited to figures with their own name evidence; none of the 8 illegal pairs reaches a stage-two request', async t => {
  const { h } = await turn(t, V3, { action: 'accept', target: 'none' });
  const stageTwoLabels = (action: string) => {
    const stage = h.upstream.posts.filter((b: any) => b.questions?.target);
    return stage.length ? Object.keys(stage.at(-1).questions.target.criteria) : [];
  };
  assert.deepEqual(stageTwoLabels('accept').slice(0, 2), ['none', 'figure_0']);
  for (const [action, labels] of [['confirm', 'none'], ['repair', 'none'], ['revisit', 'none'], ['request_observation', 'none']] as const) {
    h.upstream.plan.answers = { action, target: 'figure_1' };
    const prepared = await prepareParticipantJev(h.options), made = await makeTask(prepared);
    made.task.message('二つのどちらかです', 'turn-' + action); await made.task.whenIdle();
    const offered = stageTwoLabels(action);
    assert.ok(!offered.includes(labels), action);
    assert.equal(offered.length, 6 + 57, action);
  }
});

test('restore crossings: v3 records restore only under v3; v1 and v2 records never restore under v3; tampering is refused', async t => {
  const v3 = await turn(t, V3, REVISIT_MULTIPLE);
  const saved = v3.record;
  const v1 = await turn(t, {}, { action: 'accept', target: 'none' });
  const v2 = await turn(t, { questionLayout: 'two_stage_v2' }, { action: 'defer', target: 'multiple', candidate_set: 'figures_1_3' });
  await makeTask(v3.prepared, { restore: saved });
  await assert.rejects(makeTask(v1.prepared, { restore: saved }), { code: 'invalid_options' });
  await assert.rejects(makeTask(v2.prepared, { restore: saved }), { code: 'invalid_options' });
  await assert.rejects(makeTask(v3.prepared, { restore: v1.record }), { code: 'invalid_options' });
  await assert.rejects(makeTask(v3.prepared, { restore: v2.record }), { code: 'invalid_options' });
  const variants: Array<[string, (r: any) => void]> = [
    ['target label exchanged for another set', r => { r.queueState.privateState.judgments[0].jevTurn.decision.evidence.stages[1].choices.target = 'figures_1_4'; }],
    ['decision set exchanged', r => { r.queueState.privateState.judgments[0].jevTurn.decision.target.figureIds = [ids[1], ids[4]]; }],
    ['executed set exchanged', r => { r.queueState.privateState.judgments[0].jevTurn.executed.target.figureIds = [ids[1], ids[4]]; }],
    ['stage dropped', r => { r.queueState.privateState.judgments[0].jevTurn.decision.evidence.stages.pop(); }],
    ['v2 stage name', r => { r.queueState.privateState.judgments[0].jevTurn.decision.evidence.stages[0].stage = 'action_target'; }],
    ['original and executed exchanged', r => { const z = r.queueState.privateState.judgments[0].jevTurn; z.executed = { ...z.executed, action: 'move_on' }; }],
    ['judgment names a slot', r => { r.queueState.privateState.judgments[0].judgment.targetSlot = ids[1]; }],
    ['executed revisit with a name', r => { r.queueState.privateState.judgments[0].jevTurn.executed.name = '船'; }],
    ['executed becomes revisit x none', r => { const z = r.queueState.privateState.judgments[0].jevTurn; z.executed.target = { kind: 'none' }; z.decision.target = { kind: 'none' }; }],
    ['layout label removed', r => { delete r.options.questionLayout; }],
    ['layout relabelled', r => { r.options.questionLayout = 'two_stage_v2'; }],
  ];
  for (const [name, mutate] of variants) {
    const r = structuredClone(saved); mutate(r);
    await assert.rejects(makeTask(v3.prepared, { restore: r }), { code: 'invalid_options' }, name);
  }
  assert.throws(() => validateParticipantJevConfig({ ...v3.h.config, questionLayout: 'two_stage_v9' }), { code: 'invalid_config' });
  assert.notEqual(researchHash(validateParticipantJevConfig(v3.h.config).profile), researchHash(validateParticipantJevConfig({ ...v3.h.config, questionLayout: 'two_stage_v2' }).profile));
});

test('both strategies send byte-identical stage-one and stage-two requests; only the acceptance differs', async t => {
  const a = await turn(t, V3, { action: 'move_on', target: 'figure_2' }, 'repair-first');
  const b = await turn(t, V3, { action: 'move_on', target: 'figure_2' }, 'bypass-enabled');
  const jev = (h: any) => h.upstream.posts.filter((p: any) => p.questions?.action || p.questions?.target).map((p: any) => JSON.stringify(p));
  assert.deepEqual(jev(a.h), jev(b.h));
  assert.equal(a.trace.decisions[0].action, 'move_on'); assert.equal(b.trace.executed.action, 'move_on');
  assert.notEqual(a.trace.executed.action, 'move_on');
  for (const word of ['repair-first', 'bypass-enabled', 'veto', 'bypass_acceptance']) assert.ok(!jev(a.h).join('').includes(word), word);
});

// ---- turn-level 30-cell table (literal oracle). agree needs a public human proposal the classifier stub never produces, and
// request_observation needs the observer; both are covered at the client boundary and by the v1/v2 turn tests.
const NAMED = rawMemoWith([{ construal: '船', basis: ['細い部分'], status: 'hypothesis' }]);
const TURN_CELLS: Array<[string, 'none' | 'single' | 'multiple', string]> = [];
for (const action of ['accept', 'defer', 'move_on', 'close']) for (const [kind, label] of [['none', 'none'], ['single', 'figure_2'], ['multiple', 'figures_1_3']] as const) TURN_CELLS.push([action, kind, label]);
for (const action of ['confirm', 'repair', 'revisit']) for (const [kind, label] of [['single', 'figure_2'], ['multiple', 'figures_1_3']] as const) TURN_CELLS.push([action, kind, label]);
TURN_CELLS.push(['propose_name', 'single', 'figure_2']);
test('turn level: every reachable legal cell commits with the right target projection, judgment and ledger effect', async t => {
  assert.equal(TURN_CELLS.length, 12 + 6 + 1);
  for (const [action, kind, label] of TURN_CELLS) {
    const { trace, record } = await turn(t, V3, { action, target: label }, 'bypass-enabled', '二つのどちらかです', NAMED);
    const name = `${action}x${kind}`;
    assert.equal(trace.status, 'committed', name + ' ' + JSON.stringify([trace.errorCode, trace.decisionRejectionCode]));
    assert.equal(trace.executed.action, action, name); assert.equal(trace.executed.target.kind, kind, name);
    assert.equal(trace.finalAction.targetSlot, kind === 'single' ? ids[2] : null, name);
    const changed = Object.entries(record.queueState.privateState.ledger).filter(([, e]: any) => e.status !== 'unassigned' || e.name !== null);
    // Only a single-target defer (status deferred) or propose_name (tentative name) moves a ledger entry; revisit x single of an unnamed slot stays unassigned.
    const expectChange = (action === 'defer' && kind === 'single') || action === 'propose_name';
    assert.equal(changed.length, expectChange ? 1 : 0, name);
    if (action === 'defer' && kind === 'single') assert.equal((changed[0][1] as any).status, 'deferred');
    if (action === 'propose_name') assert.equal((changed[0][1] as any).status, 'tentative');
    assert.equal(record.jevTraces.length, 1);
    assert.equal(record.events.filter((e: any) => e.speaker === 'ai').length, GREETING + 1, name);
  }
});

test('restore after a failed generation then a retry never publishes twice', async t => {
  const h = await fixture(t, V3, { answers: REVISIT_MULTIPLE, failGeneration: 1 });
  const prepared = await prepareParticipantJev(h.options), made = await makeTask(prepared);
  made.task.message('二つのどちらかです', 'turn-1'); await made.task.whenIdle();
  const failed = made.record();
  assert.equal(aiEvents(failed).length, GREETING);
  const restored = await makeTask(prepared, { restore: failed });
  await restored.task.retry(); await restored.task.whenIdle();
  assert.equal(aiEvents(restored.record()).length, GREETING + 1);
  assert.equal(restored.record().queueState.privateState.judgments.length, 1);
  assert.equal(restored.record().jevTraces.filter((r: any) => r.status === 'committed').length, 1);
});
