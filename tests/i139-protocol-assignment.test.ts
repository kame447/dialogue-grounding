import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { optionalImport, need, clone, raw, assignment, harness } from './support/s5-base/support.ts';

// Synthetic plans and records exercise provenance checks only; no research value is adopted.
const reception = await optionalImport('dialogue-model/runtime/v2/reception.ts');
const data = await optionalImport('dialogue-model/runtime/v2/base-assignment-data.ts');
const session = await optionalImport('dialogue-model/runtime/v2/base-assignment-session.ts');
const now = '2000-01-01T00:00:00.000Z';
const protocolId = '22222222-2222-4222-8222-222222222222';
const v2 = (rotationMode: string) => ({ schemaVersion: 'reception_protocol_v2', protocolId, revision: 3, allowedOrders: [['bypass-enabled', 'repair-first']],
  seedPolicy: 'shared', referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode });
const v1 = () => ({ schemaVersion: 'reception_protocol_v1', protocolId, revision: 3, allowedOrders: [['bypass-enabled', 'repair-first']],
  seedPolicy: 'shared', referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3' });
const pending = () => ({ schemaVersion: 'reception_v1', receptionId: '11111111-1111-4111-8111-111111111111', objectId: 'a'.repeat(64),
  createdAt: now, number: null, status: 'pending', plan: null, revision: 0, trials: [] });
async function plan(protocol: any) {
  const p = need(reception, 'validateReceptionProtocolV2');
  const canonical = protocol.schemaVersion === 'reception_protocol_v2' ? need(reception, 'canonicalReceptionProtocolV2')(p(protocol)) : null;
  const expected = canonical ? { protocolId, revision: 3, sha256: createHash('sha256').update(canonical).digest('hex') } : undefined;
  return (await need(reception, 'approveReception')(pending(), { expectedRevision: 0, order: 0, protocol, ...(expected ? { expected } : {}),
    approvedAt: now, randomSeed: () => 17 })).plan;
}
const assignmentFor = (p: any, trialIndex = 0, kind = p.schemaVersion) => ({ schemaVersion: 'base_assignment_v1', assignmentId: '55555555-5555-4555-8555-555555555555',
  strategy: p.trials[trialIndex].strategy, seed: p.trials[trialIndex].seed, referenceMemory: p.trials[trialIndex].referenceMemory,
  source: { kind, adapter: 'worker_binding', receptionId: '11111111-1111-4111-8111-111111111111', protocolId: p.protocolId,
    protocolRevision: p.protocolRevision, protocolSha256: p.protocolSha256, trialIndex, plan: p }, createdAt: now });
const stimulus = (rotationMode: string) => ({ version: 'synthetic-stimulus-v1', rotationMode, angles: { human: { h1: 90, h2: 180 }, ai: { a1: 90, a2: 270 } } });
function record(a: any, rotationMode?: string, withStimulus = rotationMode !== undefined) {
  const r = clone(raw()); r.recordId = '33333333-3333-4333-8333-333333333333'; r.seed = a.seed; r.strategy = a.strategy;
  r.options.referenceMemory = a.referenceMemory;
  if (rotationMode !== undefined) r.options.rotationMode = rotationMode;
  if (withStimulus) r.stimulus = stimulus(rotationMode ?? 'relative_pm90');
  return { ...r, assignment: a };
}
const invalid = (e: any) => { assert.equal(e.name, 'BaseAssignmentError'); assert.equal(e.code, 'assignment_record_invalid'); return true; };

test('reception_plan_v2 provenance must match its embedded plan version and derive the rotation mode from the plan', async () => {
  const read = need(data, 'readAssignment'), mode = need(data, 'assignmentRotationMode');
  for (const rotationMode of ['relative_pm90', 'relative_0']) {
    const p = await plan(v2(rotationMode)), a = read(assignmentFor(p));
    assert.equal(a.source.kind, 'reception_plan_v2'); assert.equal(mode(a), rotationMode);
    assert.throws(() => read(assignmentFor(p, 0, 'reception_plan_v1')), invalid);
  }
  const old = await plan(v1());
  assert.equal(mode(read(assignmentFor(old))), 'relative_pm90');
  assert.throws(() => read(assignmentFor(old, 0, 'reception_plan_v2')), invalid);
  assert.equal(mode(read(assignment())), 'relative_pm90', 'server_config_v1 keeps the existing digest and the legacy mode');
  const tampered = assignment(); tampered.source.configSha256 = 'f'.repeat(64);
  assert.throws(() => read(tampered), invalid);
});

test('v2 records always need the matching mode and stimulus; only legacy sources may omit both', async () => {
  const bind = need(data, 'validateBoundBaseRecord');
  for (const rotationMode of ['relative_pm90', 'relative_0']) {
    const a = assignmentFor(await plan(v2(rotationMode))), other = rotationMode === 'relative_0' ? 'relative_pm90' : 'relative_0';
    bind(record(a, rotationMode), a);
    const broken = record(a, rotationMode); broken.stimulus.angles.ai = [] as any;
    const noVersion = record(a, rotationMode); delete (noVersion.stimulus as any).version;
    const badAngle = record(a, rotationMode); (badAngle.stimulus.angles.human as any).h1 = '90';
    for (const bad of [record(a), record(a, rotationMode, false), record(a, other), record(a, other, true), record(a, null as any),
      record(a, 'relative_90'), { ...record(a, rotationMode), stimulus: stimulus(other) }, broken, noVersion, badAngle,
      { ...record(a, rotationMode), stimulus: null }])
      assert.throws(() => bind(bad, a), invalid, JSON.stringify(bad.options) + JSON.stringify(bad.stimulus ?? null));
  }
  for (const legacy of [assignment(), assignmentFor(await plan(v1()))]) {
    bind(record(legacy), legacy);
    bind(record(legacy, 'relative_pm90'), legacy);
    for (const bad of [record(legacy, 'relative_0'), record(legacy, 'relative_pm90', false), record(legacy, undefined, true), record(legacy, null as any)])
      assert.throws(() => bind(bad, legacy), invalid);
  }
});

test('the coordinator passes the assignment mode to new tasks only, and never takes it from the caller on restore', async () => {
  const create = need(session, 'createBaseAssignmentSession');
  for (const rotationMode of ['relative_pm90', 'relative_0']) {
    const p = await plan(v2(rotationMode)), h = harness({ adapter: 'worker_binding' });
    const factory = h.options.makeTask;
    h.options.makeTask = async (input: any) => {
      const task = await factory({ ...input, onPersist: async (r: any) => {
        if (!input.restore) { r.options.rotationMode = input.rotationMode; r.stimulus = stimulus(input.rotationMode); }
        return input.onPersist(r);
      } });
      return task;
    };
    const s = create({ ...h.options, readPlan: async () => ({ receptionId: '11111111-1111-4111-8111-111111111111', plan: p, trialIndex: 0 }) });
    await s.start({ version: 2 });
    assert.equal(h.tasks[0].input.rotationMode, rotationMode);
    assert.equal(h.state.admissions.initial.record.options.rotationMode, rotationMode);
    const again = create({ ...h.options, readPlan: async () => { throw new Error('restore never reads a plan'); } });
    await again.restore();
    assert.equal(h.tasks.at(-1).input.restore.options.rotationMode, rotationMode);
    assert.equal(Object.hasOwn(h.tasks.at(-1).input, 'rotationMode'), false, 'restore carries no caller mode');
  }
  const legacy = harness();
  await create(legacy.options).start({ version: 2 });
  assert.equal(legacy.tasks[0].input.rotationMode, 'relative_pm90', 'server_config_v1 new trials are explicit legacy mode');
});

test('a reception port may explicitly decline a plan so that the configured legacy assignment is used', async () => {
  const create = need(session, 'createBaseAssignmentSession');
  const h = harness();
  const s = create({ ...h.options, readPlan: async () => null });
  await s.start({ version: 2 });
  assert.equal(h.state.admissions.initial.assignment.source.kind, 'server_config_v1');
  for (const value of [undefined, false, 0, {}]) {
    const other = harness();
    await assert.rejects(() => create({ ...other.options, readPlan: async () => value }).start({ version: 2 }));
    assert.equal(other.stats.factory, 0);
  }
});
