import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { optionalImport, need } from './support/s5-base/support.ts';

// Synthetic protocols exercise the v2 mechanism; they never adopt research conditions.
const mod = await optionalImport('dialogue-model/runtime/v2/reception.ts');
const id = '11111111-1111-4111-8111-111111111111';
const protocolId = '22222222-2222-4222-8222-222222222222';
const now = '2000-01-01T00:00:00.000Z';
// Independent canonical fixtures; never computed with the production serializer.
const canonicalV2 = '{"schemaVersion":"reception_protocol_v2","protocolId":"22222222-2222-4222-8222-222222222222","revision":3,"allowedOrders":[["bypass-enabled","repair-first"],["repair-first"]],"seedPolicy":"per_trial","referenceMemory":false,"betweenTrials":"questionnaire_required","receptionNumberFormat":"daily_seq3","rotationMode":"relative_0"}';
const canonicalV1 = '{"schemaVersion":"reception_protocol_v1","protocolId":"22222222-2222-4222-8222-222222222222","revision":3,"allowedOrders":[["bypass-enabled","repair-first"],["repair-first"]],"seedPolicy":"shared","referenceMemory":false,"betweenTrials":"none","receptionNumberFormat":"daily_seq3"}';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const v2 = (patch: Record<string, unknown> = {}) => ({ schemaVersion: 'reception_protocol_v2', protocolId, revision: 3,
  allowedOrders: [['bypass-enabled', 'repair-first'], ['repair-first']], seedPolicy: 'per_trial', referenceMemory: false,
  betweenTrials: 'questionnaire_required', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0', ...patch });
const v1 = () => JSON.parse(canonicalV1);
const expected = (patch: Record<string, unknown> = {}) => ({ protocolId, revision: 3, sha256: sha(canonicalV2), ...patch });
const pending = () => ({ schemaVersion: 'reception_v1', receptionId: id, objectId: 'a'.repeat(64),
  createdAt: now, number: null, status: 'pending', plan: null, revision: 0, trials: [] });
const rejects = (code: string) => (error: any) => { assert.equal(error.code, code); assert.equal(error.message, code); return true; };

test('v2 protocol is strict, has no defaults and fails closed on every missing or unknown value', () => {
  const validate = need(mod, 'validateReceptionProtocolV2'), canonical = need(mod, 'canonicalReceptionProtocolV2');
  const input = v2(), result = validate(input);
  assert.deepEqual(result, v2()); input.allowedOrders[0].push('x'); assert.deepEqual(result, v2(), 'detached from caller mutations');
  assert.equal(canonical(v2()), canonicalV2);
  assert.equal(canonical(Object.fromEntries(Object.entries(v2()).reverse())), canonicalV2, 'input key order is irrelevant');
  for (const [key, value] of [['rotationMode', 'relative_pm90'], ['betweenTrials', 'none'], ['seedPolicy', 'shared'], ['referenceMemory', true]] as const)
    assert.notEqual(canonical(v2({ [key]: value })), canonicalV2, key + ' affects canonical bytes');
  const missing = (key: string) => { const p: any = v2(); delete p[key]; return p; };
  const accessor = v2(); Object.defineProperty(accessor, 'rotationMode', { get: () => 'relative_0', enumerable: true });
  for (const bad of [null, undefined, {}, v1(), v2({ schemaVersion: 'reception_protocol_v3' }), missing('rotationMode'), missing('betweenTrials'),
    v2({ rotationMode: null }), v2({ rotationMode: 'relative_90' }), v2({ rotationMode: 0 }), v2({ betweenTrials: null }), v2({ betweenTrials: 'rest' }),
    v2({ receptionNumberFormat: 'daily_seq4' }), v2({ allowedOrders: [] }), v2({ allowedOrders: [['repair-first', 'repair-first']] }),
    v2({ allowedOrders: [['repair-first'], ['repair-first']] }), v2({ allowedOrders: [['unknown']] }), v2({ seedPolicy: 'fixed' }),
    v2({ referenceMemory: 'false' }), v2({ revision: 0 }), v2({ protocolId: 'not-a-uuid' }), v2({ extra: true }), accessor]) {
    assert.throws(() => validate(bad), rejects('protocol_unconfigured'));
  }
});

test('v1 validator, canonical bytes and v1 approval stay unchanged and never accept v2', async () => {
  const validate = need(mod, 'validateReceptionProtocol'), canonical = need(mod, 'canonicalReceptionProtocol'), approve = need(mod, 'approveReception');
  assert.equal(canonical(v1()), canonicalV1);
  assert.deepEqual(Object.keys(validate(v1())), Object.keys(v1()), 'no new field injected into v1 results');
  assert.throws(() => validate(v2()), rejects('protocol_unconfigured'));
  const result = await approve(pending(), { expectedRevision: 0, order: 0, protocol: v1(), approvedAt: now, randomSeed: () => 7 });
  assert.deepEqual(result.plan, { schemaVersion: 'reception_plan_v1', protocolId, protocolRevision: 3, protocolSha256: sha(canonicalV1),
    order: ['bypass-enabled', 'repair-first'], trials: [{ index: 0, strategy: 'bypass-enabled', seed: 7, referenceMemory: false },
      { index: 1, strategy: 'repair-first', seed: 7, referenceMemory: false }], approvedAt: now });
});

test('v2 approval checks the displayed version against the same snapshot and freezes rotation and between-trial values', async () => {
  const approve = need(mod, 'approveReception');
  for (const rotationMode of ['relative_pm90', 'relative_0']) for (const betweenTrials of ['none', 'questionnaire_required']) {
    const p = v2({ rotationMode, betweenTrials }), canon = canonicalV2.replace('"relative_0"', JSON.stringify(rotationMode))
      .replace('"questionnaire_required"', JSON.stringify(betweenTrials));
    const seeds = [11, 12]; let draws = 0;
    const result = await approve(pending(), { expectedRevision: 0, order: 0, protocol: p, expected: expected({ sha256: sha(canon) }),
      approvedAt: now, randomSeed: () => seeds[draws++] });
    assert.deepEqual(result.plan, { schemaVersion: 'reception_plan_v2', protocolId, protocolRevision: 3, protocolSha256: sha(canon),
      order: ['bypass-enabled', 'repair-first'], betweenTrials, approvedAt: now,
      trials: [{ index: 0, strategy: 'bypass-enabled', seed: 11, referenceMemory: false, rotationMode },
        { index: 1, strategy: 'repair-first', seed: 12, referenceMemory: false, rotationMode }] });
    const saved = structuredClone(result.plan); p.rotationMode = 'x'; assert.deepEqual(result.plan, saved);
  }
  // A stale displayed version is a 409 before the order is interpreted against the new protocol.
  for (const patch of [{ protocolId: '33333333-3333-4333-8333-333333333333' }, { revision: 2 }, { sha256: 'f'.repeat(64) }]) {
    let draws = 0;
    await assert.rejects(() => approve(pending(), { expectedRevision: 0, order: 9, protocol: v2(), expected: expected(patch), approvedAt: now,
      randomSeed: () => { draws++; return 1; } }), rejects('protocol_changed'));
    assert.equal(draws, 0);
  }
  for (const bad of [undefined, null, { ...expected(), extra: 1 }, { protocolId, revision: 3 }])
    await assert.rejects(() => approve(pending(), { expectedRevision: 0, order: 0, protocol: v2(), expected: bad, approvedAt: now, randomSeed: () => 1 }),
      rejects('protocol_changed'));
  await assert.rejects(() => approve(pending(), { expectedRevision: 0, order: 2, protocol: v2(), expected: expected(), approvedAt: now, randomSeed: () => 1 }),
    rejects('invalid_order'));
});

test('plan v2 is strictly validated per version and effective values keep v1 meaning', async () => {
  const validate = need(mod, 'validateReceptionPlan'), approve = need(mod, 'approveReception');
  const rotation = need(mod, 'effectiveRotationMode'), between = need(mod, 'effectiveBetweenTrials');
  const { plan } = await approve(pending(), { expectedRevision: 0, order: 0, protocol: v2(), expected: expected(), approvedAt: now, randomSeed: () => 5 });
  assert.deepEqual(validate(plan), plan);
  assert.equal(rotation(plan, 0), 'relative_0'); assert.equal(rotation(plan, 1), 'relative_0'); assert.equal(between(plan), 'questionnaire_required');
  const old = (await approve(pending(), { expectedRevision: 0, order: 0, protocol: v1(), approvedAt: now, randomSeed: () => 5 })).plan;
  assert.equal(rotation(old, 0), 'relative_pm90'); assert.equal(between(old), 'none');
  assert.throws(() => rotation(plan, 2)); assert.throws(() => rotation(old, -1));
  const trial = (patch: Record<string, unknown>) => ({ ...plan, trials: [{ ...plan.trials[0], ...patch }, plan.trials[1]] });
  const without = (key: string) => { const p: any = structuredClone(plan); delete p[key]; return p; };
  const noTrialMode = structuredClone(plan); delete (noTrialMode.trials[0] as any).rotationMode;
  for (const bad of [without('betweenTrials'), { ...plan, betweenTrials: null }, { ...plan, betweenTrials: 'rest' }, noTrialMode,
    trial({ rotationMode: null }), trial({ rotationMode: 'relative_90' }), { ...plan, schemaVersion: 'reception_plan_v1' },
    { ...old, schemaVersion: 'reception_plan_v2' }, { ...old, betweenTrials: 'none' }, { ...plan, extra: 1 }])
    assert.throws(() => validate(bad), rejects('reception_unavailable'));
  const validateReception = need(mod, 'validateReception');
  const approved = { ...pending(), status: 'approved', plan, revision: 1 };
  assert.deepEqual(validateReception(approved).plan, plan);
});

test('participant projection adds only the questionnaire status and keeps exactly three public fields', async () => {
  const project = need(mod, 'participantReception'), approve = need(mod, 'approveReception');
  const approved = await approve(pending(), { expectedRevision: 0, order: 0, protocol: v2(), expected: expected(), approvedAt: now, randomSeed: () => 5 });
  const running = { ...approved, status: 'in_progress', revision: 3, trials: [{ index: 0, recordId: '44444444-4444-4444-8444-444444444444' }] };
  assert.deepEqual(project(running), { number: null, status: 'in_progress', revision: 3 });
  assert.deepEqual(project(running, { awaitingQuestionnaire: true }), { number: null, status: 'questionnaire', revision: 3 });
  assert.deepEqual(project(approved, { awaitingQuestionnaire: true }), { number: null, status: 'ready', revision: 1 }, 'only an in-progress reception waits for a questionnaire');
});
