// Issue #180 slice 2: protocol/plan v3, assignment binding, research-log recording, restore and review. Local only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { approveReception, createReception, validateReceptionProtocolV3, canonicalReceptionProtocolV3, receptionProtocolSha256,
  validateReceptionPlan, effectiveFigureSelection, effectiveRotationMode, effectiveBetweenTrials } from '../dialogue-model/runtime/v2/reception.ts';
import { validateBoundBaseRecord, assignmentFigureSelection } from '../dialogue-model/runtime/v2/base-assignment.ts';
import { readAssignment, canonicalBaseAssignmentConfig } from '../dialogue-model/runtime/v2/base-assignment-data.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { participantReview } from '../dialogue-model/runtime/v2/participant-records.ts';
import { createTrialV2, participantView, trialStimulusV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { SAFE_JUDGMENT } from '../dialogue-model/runtime/judgment/schema.mjs';
import { FIGURE_SETS, resolveFigureSelection } from '../dialogue-model/runtime/stimuli/figure-bank.ts';

const protocolId = randomUUID(), now = '2026-11-24T00:00:00.000Z';
const protocol = (over: Record<string, unknown> = {}) => ({ schemaVersion: 'reception_protocol_v3', protocolId, revision: 1,
  allowedOrders: [['repair-first', 'bypass-enabled'], ['bypass-enabled', 'repair-first']], seedPolicy: 'shared', referenceMemory: true,
  betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
  figureSelection: { mode: 'preset', setId: 'bank-set-a' }, figureSetPolicy: 'shared', ...over });
const seq = (...values: number[]) => { const queue = [...values]; return { draws: () => queue.length, next: () => { const v = queue.shift(); if (v === undefined) throw new Error('exhausted'); return v; } }; };
const reception = () => createReception({ receptionId: randomUUID(), objectId: 'a'.repeat(64), createdAt: now, number: null });
async function approve(p: unknown, randoms: number[], order = 0) {
  const canonical = canonicalReceptionProtocolV3(p), s = seq(...randoms);
  const r = await approveReception(reception(), { expectedRevision: 0, order, protocol: p,
    expected: { protocolId, revision: 1, sha256: receptionProtocolSha256(canonical) }, approvedAt: now, randomSeed: s.next });
  return { plan: r.plan as any, left: s.draws() };
}

test('protocol v3 requires explicit figureSelection and figureSetPolicy and rejects unknown values', () => {
  assert.equal(validateReceptionProtocolV3(protocol()).schemaVersion, 'reception_protocol_v3');
  for (const bad of [{ figureSelection: undefined }, { figureSetPolicy: undefined }, { figureSetPolicy: 'sometimes' }, { figureSelection: { mode: 'preset', setId: 'nope' } },
    { figureSelection: { mode: 'preset', setId: 'bank-set-a', extra: 1 } }, { figureSelection: { mode: 'seeded_random' } }, { figureSelection: { mode: 'seeded_random', selectionSeed: 1.5 } },
    { figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5'] } }, { figureSelection: { mode: 'custom', figureIds: ['F1', 'F1', 'F3', 'F4', 'F5', 'F6'] } },
    { figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F99'] } }, { figureSelection: { mode: 'mystery' } },
    { figureSelection: { mode: 'preset', setId: 'bank-set-a' }, figureSetPolicy: 'per_trial' },
    { figureSelection: { mode: 'custom', figureIds: [...FIGURE_SETS['bank-set-b']] }, figureSetPolicy: 'per_trial' }]) {
    assert.throws(() => validateReceptionProtocolV3(protocol(bad)), (e: any) => e.name === 'ReceptionError', JSON.stringify(bad));
  }
  const nulls = validateReceptionProtocolV3(protocol({ figureSelection: { mode: 'seeded_random', selectionSeed: null }, figureSetPolicy: 'per_trial' }));
  assert.equal((nulls.figureSelection as any).selectionSeed, null);
});

test('shared policy freezes one identical selection for both trials; a null seed is drawn exactly once', async () => {
  const preset = await approve(protocol(), [11, 22]);
  assert.equal(preset.plan.schemaVersion, 'reception_plan_v3');
  assert.deepEqual(preset.plan.trials[0].figureSelection, preset.plan.trials[1].figureSelection);
  assert.deepEqual(preset.plan.trials[0].figureSelection.figureIds, [...FIGURE_SETS['bank-set-a']]);
  assert.deepEqual(preset.plan.trials.map((t: any) => t.seed), [11, 11].slice(0, 1).concat(11), 'shared seedPolicy: one trial seed');
  const random = await approve(protocol({ figureSelection: { mode: 'seeded_random', selectionSeed: null } }), [5, 777]);
  assert.equal(random.left, 0);
  assert.equal(random.plan.trials[0].figureSelection.selectionSeed, 777);
  assert.deepEqual(random.plan.trials[0].figureSelection, random.plan.trials[1].figureSelection);
  assert.deepEqual(random.plan.trials[0].figureSelection, resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 777 }));
  const fixed = await approve(protocol({ figureSelection: { mode: 'seeded_random', selectionSeed: 31 } }), [5]);
  assert.equal(fixed.plan.trials[1].figureSelection.selectionSeed, 31);
  const ids = [...FIGURE_SETS['bank-set-c']];
  const custom = await approve(protocol({ figureSelection: { mode: 'custom', figureIds: ids } }), [5]);
  assert.deepEqual(custom.plan.trials[1].figureSelection.figureIds, ids);
});

test('per_trial policy gives each trial its own seeded selection and never repeats a seed', async () => {
  const p = (selectionSeed: number | null) => protocol({ seedPolicy: 'per_trial', figureSetPolicy: 'per_trial', figureSelection: { mode: 'seeded_random', selectionSeed } });
  const drawn = await approve(p(null), [1, 2, 100, 100, 100, 250]);
  assert.deepEqual(drawn.plan.trials.map((t: any) => t.figureSelection.selectionSeed), [100, 250]);
  assert.notDeepEqual(drawn.plan.trials[0].figureSelection.figureIds, drawn.plan.trials[1].figureSelection.figureIds);
  const fixed = await approve(p(40), [1, 2]);
  assert.deepEqual(fixed.plan.trials.map((t: any) => t.figureSelection.selectionSeed), [40, 41]);
  await assert.rejects(approve(p(Number.MAX_SAFE_INTEGER), [1, 2]), (e: any) => e.name === 'ReceptionError');
});

test('per_trial redraws when different seeds yield the same six figures', async () => {
  const first = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 37658 });
  const collision = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 37659 });
  assert.deepEqual([...first.figureIds].sort(), [...collision.figureIds].sort());
  for (const [selectionSeed, draws] of [[37658, [5]], [null, [5, 37658, 37659, 37660]]] as const) {
    const p = protocol({ figureSetPolicy: 'per_trial', figureSelection: { mode: 'seeded_random', selectionSeed } });
    const { plan } = await approve(p, [...draws]);
    assert.equal(plan.trials[0].figureSelection.selectionSeed, 37658);
    assert.equal(plan.trials[1].figureSelection.selectionSeed, 37660);
    assert.notDeepEqual([...plan.trials[0].figureSelection.figureIds].sort(), [...plan.trials[1].figureSelection.figureIds].sort());
  }
});

test('plan v3 validates strictly and effective accessors keep v1/v2 on the legacy set', async () => {
  const { plan } = await approve(protocol(), [3, 4]);
  assert.deepEqual(validateReceptionPlan(structuredClone(plan)), plan);
  assert.equal(effectiveRotationMode(plan, 0), 'relative_pm90'); assert.equal(effectiveBetweenTrials(plan), 'none');
  assert.equal(effectiveFigureSelection(plan, 1).setId, 'bank-set-a');
  const bad = structuredClone(plan); bad.trials[0].figureSelection.figureIds[0] = 'F1';
  assert.throws(() => validateReceptionPlan(bad));
  const extra = structuredClone(plan); extra.trials[0].figureSelection.note = 'x';
  assert.throws(() => validateReceptionPlan(extra));
  const v1 = { schemaVersion: 'reception_plan_v1', protocolId, protocolRevision: 1, protocolSha256: 'b'.repeat(64), order: ['repair-first'],
    trials: [{ index: 0, strategy: 'repair-first', seed: 1, referenceMemory: true }], approvedAt: now };
  assert.equal(effectiveFigureSelection(validateReceptionPlan(v1), 0).setId, 'legacy-v1');
  assert.throws(() => effectiveFigureSelection(plan, 2));
});

function assignmentFor(plan: any, trialIndex = 0) {
  const t = plan.trials[trialIndex];
  return readAssignment({ schemaVersion: 'base_assignment_v1', assignmentId: randomUUID(), strategy: t.strategy, seed: t.seed, referenceMemory: t.referenceMemory,
    createdAt: now, source: { kind: 'reception_plan_v3', adapter: 'worker_binding', receptionId: randomUUID(), protocolId: plan.protocolId,
      protocolRevision: plan.protocolRevision, protocolSha256: plan.protocolSha256, trialIndex, plan } });
}
function recordFor(a: any, selection?: any) {
  const trial = createTrialV2({ seed: a.seed, rotationMode: 'relative_pm90', figureSelection: assignmentFigureSelection(a) });
  const stimulus = trialStimulusV2(trial);
  return { recordId: randomUUID(), version: 2, seed: a.seed, strategy: a.strategy, status: 'dialogue',
    options: { referenceMemory: a.referenceMemory, rotationMode: 'relative_pm90', ...(selection === null ? {} : { figureSelection: selection ?? assignmentFigureSelection(a) }) },
    stimulus, queueState: { pendingHumanEventIds: [], errorCode: null }, assignment: a };
}

test('a bound reception_plan_v3 record must carry the plan\'s figure selection and matching stimulus metadata', async () => {
  const { plan } = await approve(protocol({ figureSelection: { mode: 'seeded_random', selectionSeed: 9 } }), [3]);
  const a = assignmentFor(plan);
  assert.equal(assignmentFigureSelection(a).selectionSeed, 9);
  validateBoundBaseRecord(recordFor(a), a);
  assert.throws(() => validateBoundBaseRecord(recordFor(a, null), a), (e: any) => e.name === 'BaseAssignmentError');
  assert.throws(() => validateBoundBaseRecord(recordFor(a, resolveFigureSelection(undefined)), a));
  assert.throws(() => validateBoundBaseRecord(recordFor(a, resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 10 })), a));
  const tampered = recordFor(a); (tampered.stimulus as any).figureIds[0] = 'F1';
  assert.throws(() => validateBoundBaseRecord(tampered, a));
  const legacyShape = recordFor(a); delete (legacyShape.options as any).figureSelection;
  assert.throws(() => validateBoundBaseRecord(legacyShape, a));
  // v3 legacy-v1 bound records must reject injected bank metadata in stimulus.
  const { plan: legacyPlan } = await approve(protocol({ figureSelection: { mode: 'preset', setId: 'legacy-v1' } }), [5]);
  const la = assignmentFor(legacyPlan);
  validateBoundBaseRecord(recordFor(la), la);
  const legacyInjected = recordFor(la);
  (legacyInjected.stimulus as any).figureIds = ['F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
  (legacyInjected.stimulus as any).bankVersion = 'tangram-bank-v1';
  assert.throws(() => validateBoundBaseRecord(legacyInjected, la));
  // Pre-rotation v1/server_config_v1 records without rotationMode/stimulus must reject injected options.figureSelection.
  const cfgId = randomUUID();
  const cfgSha = createHash('sha256').update(canonicalBaseAssignmentConfig({ schemaVersion: 'base_assignment_config_v1', configId: cfgId, revision: 1, strategy: 'repair-first', seed: 201, referenceMemory: true })).digest('hex');
  const serverA = readAssignment({ schemaVersion: 'base_assignment_v1', assignmentId: randomUUID(), strategy: 'repair-first', seed: 201, referenceMemory: true, createdAt: now,
    source: { kind: 'server_config_v1', adapter: 'worker_binding', configId: cfgId, revision: 1, configSha256: cfgSha } });
  const v1Base = { recordId: randomUUID(), version: 2, seed: 201, strategy: 'repair-first', status: 'dialogue',
    options: { referenceMemory: true }, queueState: { pendingHumanEventIds: [], errorCode: null } };
  validateBoundBaseRecord({ ...structuredClone(v1Base), assignment: serverA }, serverA);
  assert.throws(() => validateBoundBaseRecord({ ...structuredClone(v1Base), options: { referenceMemory: true, figureSelection: resolveFigureSelection({ mode: 'preset', setId: 'bank-set-a' }) }, assignment: serverA }, serverA), (e: any) => e.name === 'BaseAssignmentError');
  const v1Plan: any = validateReceptionPlan({ schemaVersion: 'reception_plan_v1', protocolId: randomUUID(), protocolRevision: 1, protocolSha256: 'b'.repeat(64), order: ['repair-first'],
    trials: [{ index: 0, strategy: 'repair-first', seed: 201, referenceMemory: true }], approvedAt: now });
  const v1PlanA = readAssignment({ schemaVersion: 'base_assignment_v1', assignmentId: randomUUID(), strategy: 'repair-first', seed: 201, referenceMemory: true, createdAt: now,
    source: { kind: 'reception_plan_v1', adapter: 'worker_binding', receptionId: randomUUID(), protocolId: v1Plan.protocolId, protocolRevision: 1, protocolSha256: v1Plan.protocolSha256, trialIndex: 0, plan: v1Plan } });
  validateBoundBaseRecord({ ...structuredClone(v1Base), assignment: v1PlanA }, v1PlanA);
  assert.throws(() => validateBoundBaseRecord({ ...structuredClone(v1Base), options: { referenceMemory: true, figureSelection: resolveFigureSelection({ mode: 'preset', setId: 'bank-set-a' }) }, assignment: v1PlanA }, v1PlanA), (e: any) => e.name === 'BaseAssignmentError');
});

const judge = { async judge() { return SAFE_JUDGMENT; } };
const client = { async complete() { return { text: '合成の返答' }; } };
async function task(extra: Record<string, unknown> = {}) {
  const records: any[] = [];
  const t = await createNamingTaskV2({ seed: 77, strategy: 'repair-first', runDir: '', judge, client, onPersist: async (r: any) => { records.push(structuredClone(r)); }, ...extra });
  await t.persistNow();
  return { t, records, last: () => records.at(-1) };
}

test('naming task: no selection keeps the earlier record shape; a selection is recorded with the stimulus metadata and restores from the record', async () => {
  const plain = await task();
  assert.ok(!Object.hasOwn(plain.last().options, 'figureSelection'));
  assert.ok(!Object.hasOwn(plain.last().stimulus, 'figureIds'));
  const selection = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12 });
  const chosen = await task({ figureSelection: selection });
  const record = chosen.last();
  assert.deepEqual(record.options.figureSelection, selection);
  assert.deepEqual(record.stimulus.figureIds, [...selection.figureIds]);
  assert.equal(record.stimulus.selectionMode, 'seeded_random'); assert.equal(record.stimulus.selectionSeed, 12);
  const explicitLegacy = await task({ figureSelection: resolveFigureSelection(undefined) });
  assert.deepEqual(explicitLegacy.last().options.figureSelection, resolveFigureSelection(undefined));
  // A restore uses the recorded selection and ignores the caller's.
  const other = resolveFigureSelection({ mode: 'preset', setId: 'bank-set-d' });
  const restored = await task({ restore: record, figureSelection: other });
  assert.deepEqual(restored.last().options.figureSelection, selection);
  assert.equal(restored.last().trialId, record.trialId);
  // The participant state never exposes the figure bank metadata.
  const state = JSON.stringify(chosen.t.getState());
  for (const hidden of ['figureSelection', 'figureIds', 'figureSetId', 'bankVersion', 'selectionSeed', 'selectionMode', selection.setId as string]) assert.ok(!state.includes(hidden), hidden);
});

test('naming task restore fails closed on inconsistent figure metadata', async () => {
  const selection = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12 });
  const record = (await task({ figureSelection: selection })).last();
  const legacy = (await task()).last();
  const bad = (mutate: (r: any) => void, source = record) => { const r = structuredClone(source); mutate(r); return task({ restore: r }); };
  await assert.rejects(bad(r => { r.options.figureSelection.figureIds[0] = 'F1'; }), (e: any) => e.code === 'invalid_options');
  await assert.rejects(bad(r => { r.stimulus.figureIds = [...r.stimulus.figureIds].reverse(); }), (e: any) => e.code === 'invalid_options');
  await assert.rejects(bad(r => { r.trialId = 'tangram-prototype-v2-0000000000000000'; }), (e: any) => e.code === 'invalid_options');
  await assert.rejects(bad(r => { r.stimulus.figureIds = [...selection.figureIds]; }, legacy), (e: any) => e.code === 'invalid_options');
  await assert.rejects(bad(r => { delete r.options.figureSelection; }), (e: any) => e.code === 'invalid_options');
  await assert.rejects(task({ figureSelection: { mode: 'preset', setId: 'unknown' } }), (e: any) => e.code === 'invalid_options');
  // A legacy record still restores unchanged and gains no selection.
  const again = await task({ restore: legacy, figureSelection: selection });
  assert.ok(!Object.hasOwn(again.last().options, 'figureSelection'));
});

test('participant review replays the recorded selection without exposing figure metadata', async () => {
  const selection = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12 });
  const base = (await task({ figureSelection: selection })).last();
  const completed = { ...structuredClone(base), status: 'completed', humanSubmission: {},
    scoring: { result: { provisional: true, normalization: 'x', success: false, matchedCount: 0, total: 6, figures: [], duplicateNames: { human: [], ai: [] }, unnamed: { human: [], ai: [] } } } };
  const review = participantReview(completed);
  assert.deepEqual(review.scene, participantView(createTrialV2({ seed: base.seed, rotationMode: base.options.rotationMode, figureSelection: selection })));
  const text = JSON.stringify(review);
  for (const hidden of ['figureSelection', 'figureIds', 'figureSetId', 'bankVersion', 'selectionSeed']) assert.ok(!text.includes(hidden), hidden);
  const legacy = { ...completed, options: { ...completed.options } }; delete (legacy.options as any).figureSelection;
  assert.notDeepEqual(participantReview(legacy).scene, review.scene, 'without a selection the legacy figures are shown');
  assert.throws(() => participantReview({ ...completed, options: { ...completed.options, figureSelection: { ...selection, figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] } } }));
});


for (const count of [3, 4]) test(`${count}-figure seeded approval freezes the selected count for both strategies and keeps legacy omissions at six`, async () => {
  for (const policy of ['shared', 'per_trial']) {
    const p = protocol({ figureSetPolicy: policy, figureSelection: { mode: 'seeded_random', selectionSeed: 41, figureCount: count } });
    const { plan } = await approve(p, [77]);
    assert.deepEqual(plan.trials.map((t: any) => t.figureSelection.figureIds.length), [count, count]);
    assert.deepEqual(validateReceptionPlan(structuredClone(plan)), plan);
    assert.deepEqual(plan.trials.map((t: any) => t.strategy), ['repair-first', 'bypass-enabled']);
    if (policy === 'shared') assert.deepEqual(plan.trials[0].figureSelection, plan.trials[1].figureSelection);
    else assert.notDeepEqual([...plan.trials[0].figureSelection.figureIds].sort(), [...plan.trials[1].figureSelection.figureIds].sort());
  }
  const old = await approve(protocol({ figureSelection: { mode: 'seeded_random', selectionSeed: 41 } }), [77]);
  assert.deepEqual(old.plan.trials.map((t: any) => t.figureSelection.figureIds.length), [6, 6]);
  for (const figureCount of [0, 2, 5, 7, '4', null, undefined]) {
    assert.throws(() => validateReceptionProtocolV3(protocol({ figureSelection: { mode: 'seeded_random', selectionSeed: 41, figureCount } })));
  }
});

test('four-figure tasks restore, accept exactly four names, finish at 4/4 and replay their own board in both conditions', async () => {
  const selection = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 41, figureCount: 4 });
  const material = createTrialV2({ seed: 77, figureSelection: selection });
  const namesByFigure = Object.fromEntries(selection.figureIds.map((id, i) => [id, `名称${i + 1}`]));
  const namesFor = (side: 'human' | 'ai') => Object.fromEntries(Object.entries(material.key[side]).map(([slot, id]) => [slot, namesByFigure[id as string]]));
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    const submittedPrompts: string[] = [];
    const model = { async complete(messages: any[], options: any = {}) {
      if (options.phase === 'final_submission') {
        submittedPrompts.push(messages.at(-1).content);
        return { text: JSON.stringify(namesFor('ai')) };
      }
      return { text: 'こんにちは。' };
    } };
    const original = await task({ strategy, figureSelection: selection, client: model });
    assert.equal(original.t.getState().scene.shapes.length, 4);
    original.t.message('こんにちは。', 'synthetic-four-hello');
    await original.t.whenIdle();
    const snapshot = original.last();
    const restored = await task({ strategy, restore: snapshot, figureSelection: resolveFigureSelection(undefined), client: model });
    assert.equal(restored.last().trialId, snapshot.trialId);
    assert.deepEqual(restored.t.getState().scene, original.t.getState().scene);
    assert.equal(Object.keys(restored.t.researcherView().privateState.ledger).length, 4);
    await assert.rejects(restored.t.submitHuman({ names: { ...namesFor('human'), 's-ffff': '余分' } }), (e: any) => e.code === 'invalid_submission');
    await restored.t.submitHuman({ names: namesFor('human') });
    await restored.t.submitAI();
    const state = restored.t.getState();
    assert.equal(state.status, 'completed');
    assert.equal(state.result.total, 4); assert.equal(state.result.matchedCount, 4); assert.equal(state.result.success, true);
    assert.match(submittedPrompts[0], /4図形/u); assert.doesNotMatch(submittedPrompts[0], /6図形|6つ/u);
    const review = participantReview(restored.last());
    assert.deepEqual(review.scene, state.scene);
    assert.equal(review.scene.shapes.length, 4);
    for (const secret of ['figureSelection', 'figureIds', 'bankVersion', 'selectionSeed']) assert.ok(!JSON.stringify(state).includes(secret));
  }
});
