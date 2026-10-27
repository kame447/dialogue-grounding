import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { optionalImport, need } from './support/s5-base/support.ts';

// Synthetic protocols exercise configuration, never adopt research conditions.
const mod = await optionalImport('dialogue-model/runtime/v2/reception.ts');
const id = '11111111-1111-4111-8111-111111111111';
const protocolId = '22222222-2222-4222-8222-222222222222';
const now = '2000-01-01T00:00:00.000Z';
// Independent canonical fixture; never computed with the production serializer.
const canonicalShared = '{"schemaVersion":"reception_protocol_v1","protocolId":"22222222-2222-4222-8222-222222222222","revision":3,"allowedOrders":[["bypass-enabled","repair-first"],["repair-first"]],"seedPolicy":"shared","referenceMemory":false,"betweenTrials":"none","receptionNumberFormat":"daily_seq3"}';
const protocol = (patch: Record<string, unknown> = {}) => ({ schemaVersion: 'reception_protocol_v1',
  protocolId, revision: 3, allowedOrders: [['bypass-enabled', 'repair-first'], ['repair-first']],
  seedPolicy: 'shared', referenceMemory: false, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', ...patch });
const pending = () => ({ schemaVersion: 'reception_v1', receptionId: id, objectId: 'a'.repeat(64),
  createdAt: now, number: null, status: 'pending', plan: null, revision: 0, trials: [] });
const rejects = (code: string) => (error: any) => { assert.equal(error.code, code); assert.equal(error.message, code); return true; };

test('protocol is explicit, strict, versioned and detached from caller mutations', () => {
  const validate = need(mod, 'validateReceptionProtocol');
  const input = protocol(), result = validate(input);
  assert.deepEqual(result, input);
  (input.allowedOrders as string[][])[0][0] = 'repair-first';
  assert.equal(result.allowedOrders[0][0], 'bypass-enabled');
  for (const input of [null, undefined, {}, protocol({ revision: 0 }), protocol({ revision: 1.5 }),
    protocol({ protocolId: 'not-a-uuid' }), protocol({ schemaVersion: 'reception_protocol_v2' }),
    protocol({ allowedOrders: [] }), protocol({ allowedOrders: [['repair-first', 'repair-first']] }),
    protocol({ allowedOrders: [['repair-first', 'bypass-enabled', 'repair-first']] }),
    protocol({ allowedOrders: [['unknown']] }), protocol({ seedPolicy: 'fixed' }),
    protocol({ referenceMemory: 'false' }), protocol({ betweenTrials: 'questionnaire' }),
    protocol({ receptionNumberFormat: 'unknown' }), protocol({ rotation: true })]) {
    assert.throws(() => validate(input), rejects('protocol_unconfigured'));
  }
});

test('approval freezes selected order, digest and injected seeds according to each synthetic policy', async () => {
  const approve = need(mod, 'approveReception'), canonical = need(mod, 'canonicalReceptionProtocol');
  for (const seedPolicy of ['shared', 'per_trial']) {
    const values = [1007, 4009]; let draws = 0;
    const p = protocol({ seedPolicy }), before = pending();
    const result = await approve(before, { expectedRevision: 0, order: 0, protocol: p, approvedAt: now, randomSeed: () => values[draws++] });
    assert.deepEqual(before, pending(), 'pure transition does not mutate its input');
    assert.equal(result.status, 'approved'); assert.equal(result.revision, 1);
    assert.equal(result.plan.schemaVersion, 'reception_plan_v1');
    assert.equal(result.plan.protocolId, protocolId); assert.equal(result.plan.protocolRevision, 3);
    const expectedCanonical = canonicalShared.replace('"seedPolicy":"shared"', '"seedPolicy":"' + seedPolicy + '"');
    assert.equal(canonical(p), expectedCanonical);
    assert.equal(canonical(Object.fromEntries(Object.entries(p).reverse())), expectedCanonical, 'input key order is irrelevant');
    assert.equal(result.plan.protocolSha256, createHash('sha256').update(expectedCanonical).digest('hex'));
    assert.notEqual(canonical(protocol({ ...p, referenceMemory: true })), expectedCanonical, 'meaningful changes affect canonical bytes');
    assert.deepEqual(result.plan.order, ['bypass-enabled', 'repair-first']);
    assert.deepEqual(result.plan.trials, [
      { index: 0, strategy: 'bypass-enabled', seed: 1007, referenceMemory: false },
      { index: 1, strategy: 'repair-first', seed: seedPolicy === 'shared' ? 1007 : 4009, referenceMemory: false },
    ]);
    assert.equal(draws, seedPolicy === 'shared' ? 1 : 2);
    const saved = structuredClone(result.plan); p.referenceMemory = true;
    assert.deepEqual(result.plan, saved);
    await assert.rejects(() => approve(result, { expectedRevision: 1, order: 1, protocol: protocol(), approvedAt: now, randomSeed: () => 99 }), rejects('reception_conflict'));
  }
  const one = await approve(pending(), { expectedRevision: 0, order: 1, protocol: protocol({ referenceMemory: true }), approvedAt: now, randomSeed: () => 81 });
  assert.equal(one.plan.trials.length, 1); assert.equal(one.plan.trials[0].referenceMemory, true);
});

test('persisted plan strictly validates version, unknown fields and trial/order consistency', async () => {
  const validate = need(mod, 'validateReceptionPlan'), approve = need(mod, 'approveReception');
  const { plan } = await approve(pending(), { expectedRevision: 0, order: 0, protocol: protocol(), approvedAt: now, randomSeed: () => 17 });
  assert.deepEqual(validate(plan), plan);
  for (const invalid of [
    { ...plan, schemaVersion: 'reception_plan_v2' }, { ...plan, rotation: true },
    { ...plan, protocolId: 'not-uuid' }, { ...plan, protocolSha256: 'bad-digest' }, { ...plan, protocolRevision: 0 },
    { ...plan, trials: [{ ...plan.trials[0], rotation: true }, plan.trials[1]] },
    { ...plan, trials: [{ ...plan.trials[0], index: 1 }, plan.trials[1]] },
    { ...plan, trials: [{ ...plan.trials[0], strategy: 'repair-first' }, plan.trials[1]] },
    { ...plan, trials: [{ ...plan.trials[0], seed: NaN }, plan.trials[1]] },
    { ...plan, trials: [{ ...plan.trials[0], referenceMemory: 'false' }, plan.trials[1]] },
    { ...plan, trials: [plan.trials[0]] },
  ]) assert.throws(() => validate(invalid));
});

test('approval is closed on absent protocol, invalid selection, stale revision and invalid random seed', async () => {
  const approve = need(mod, 'approveReception');
  const options = { expectedRevision: 0, order: 0, protocol: protocol(), approvedAt: now, randomSeed: () => 17 };
  for (const patch of [{ protocol: null }, { protocol: protocol({ rotation: true }) }])
    await assert.rejects(() => approve(pending(), { ...options, ...patch }), rejects('protocol_unconfigured'));
  for (const patch of [{ expectedRevision: 1 }, { order: -1 }, { order: 2 }, { order: 0.5 }, { randomSeed: () => NaN }])
    await assert.rejects(() => approve(pending(), { ...options, ...patch }));
});

test('cancel cannot reverse approval or delete a started trial; projection only exposes number, status and revision', async () => {
  const cancel = need(mod, 'cancelReception'), project = need(mod, 'participantReception');
  const approve = need(mod, 'approveReception');
  const approved = await approve(pending(), { expectedRevision: 0, order: 0, protocol: protocol(), approvedAt: now, randomSeed: () => 17 });
  assert.deepEqual(project(pending()), { number: null, status: 'waiting', revision: 0 });
  assert.deepEqual(project({ ...approved, number: '007' }), { number: '007', status: 'ready', revision: 1 });
  const cancelled = cancel(approved, 1);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.revision, 2);
  assert.deepEqual(cancelled.plan, approved.plan);
  assert.equal(project(cancelled).status, 'unavailable');
  assert.throws(() => cancel(pending(), 1), rejects('reception_conflict'));
  assert.throws(() => cancel({ ...approved, status: 'in_progress', trials: [{ index: 0, recordId: protocolId }] }, 1), rejects('reception_conflict'));
});

test('daily_seq3 formatting and internal day key follow explicitly specified JST boundary; overflow remains unassigned', () => {
  const format = need(mod, 'formatReceptionNumber'), day = need(mod, 'receptionNumberDay');
  assert.equal(day('daily_seq3', Date.parse('2000-01-01T14:59:59.999Z')), '2000-01-01');
  assert.equal(day('daily_seq3', Date.parse('2000-01-01T15:00:00.000Z')), '2000-01-02');
  assert.equal(format('daily_seq3', 1), '001'); assert.equal(format('daily_seq3', 7), '007');
  assert.equal(format('daily_seq3', 999), '999'); assert.equal(format('daily_seq3', 1000), null);
  assert.throws(() => format('unknown', 1));
});
