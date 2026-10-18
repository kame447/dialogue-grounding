import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnLedger, validateJudgment, applyJudgment, SAFE_JUDGMENT } from '../dialogue-model/runtime/judgment/schema.mjs';

const slots = ['s-0001', 's-0002', 's-0003', 's-0004', 's-0005', 's-0006'];
const [slot, other] = slots;
const act = (extra = {}) => ({ ...SAFE_JUDGMENT, action: 'agree', targetSlot: slot, candidateName: '帆', ...extra });
const ledgerWith = (status, name = status === 'unassigned' ? null : '帆') => ({ ...createOwnLedger(slots), [slot]: { status, name } });

for (const status of ['unassigned', 'deferred']) {
  test(`opt-in primary agree requires identification for ${status} and permits an identifying feature`, () => {
    const ownLedger = ledgerWith(status), before = structuredClone(ownLedger);
    assert.throws(() => validateJudgment(act(), { ownLedger, agreeEvidence: true }), { code: 'agree_requires_identification' });
    assert.deepEqual(validateJudgment(act({ discriminatingFeature: 'くぼみが二つ' }), { ownLedger, agreeEvidence: true }), act({ discriminatingFeature: 'くぼみが二つ' }));
    assert.deepEqual(ownLedger, before);
  });
}

for (const status of ['tentative', 'agreed']) {
  test(`opt-in primary agree keeps ${status} names valid without an identifying feature`, () => {
    assert.deepEqual(validateJudgment(act(), { ownLedger: ledgerWith(status), agreeEvidence: true }), act());
  });
}

test('default/explicit false preserves primary agrees and applyJudgment without evidence', () => {
  for (const status of ['unassigned', 'deferred', 'tentative', 'agreed']) {
    const ownLedger = ledgerWith(status);
    const implicit = validateJudgment(act(), { ownLedger });
    assert.deepEqual(implicit, validateJudgment(act(), { ownLedger, agreeEvidence: false }));
    assert.deepEqual(implicit, act());
    assert.deepEqual(applyJudgment(ownLedger, act())[slot], { status: 'agreed', name: '帆' });
  }
});

test('opt-in agrees preserve tentative renaming, repair/duplicate guards, followUp and reference validation', () => {
  const ownLedger = ledgerWith('tentative');
  const renamed = act({ candidateName: '扇', reference: null, followUp: null });
  assert.deepEqual(validateJudgment(renamed, { ownLedger, agreeEvidence: true }), renamed);
  assert.throws(() => validateJudgment(act({ candidateName: '扇' }), { ownLedger: ledgerWith('agreed'), agreeEvidence: true }), { code: 'reassignment_requires_repair' });
  const duplicated = { ...ownLedger, [other]: { status: 'tentative', name: '扇' } };
  assert.throws(() => validateJudgment(act({ candidateName: '扇' }), { ownLedger: duplicated, agreeEvidence: true }), { code: 'duplicate_name_requires_repair' });
  assert.throws(() => validateJudgment(act({ reference: {} }), { ownLedger, agreeEvidence: true }), { code: 'invalid_reference' });
  assert.deepEqual(validateJudgment(act({ action: 'repair', candidateName: null }), { ownLedger, agreeEvidence: true }), act({ action: 'repair', candidateName: null }));
});

test('followUp agree remains forbidden regardless of evidence option or prior slot status', () => {
  const { note, ...followUp } = act({ discriminatingFeature: 'くぼみが二つ' });
  for (const agreeEvidence of [false, true]) for (const status of ['unassigned', 'deferred', 'tentative', 'agreed']) {
    const ownLedger = ledgerWith(status);
    const value = { ...SAFE_JUDGMENT, followUp };
    assert.throws(() => validateJudgment(value, { ownLedger, agreeEvidence }), { code: 'invalid_follow_up' });
    assert.throws(() => applyJudgment(ownLedger, value), { code: 'invalid_follow_up' });
  }
});
