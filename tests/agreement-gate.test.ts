// adaptive_repair_v2: a repair issue whose figure was later jointly adopted is closed for inference only.
// Synthetic data shaped after the private live run I (agree at turn 6, stale turn-2 issue chosen at turn 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import {agreementGate, inferenceHistory, checkRepairGate} from '../dialogue-model/runtime/v2/agreement-gate.ts';
import type {RepairHistoryEntry} from '../dialogue-model/runtime/decision/contract.ts';

const entry = (turn: number, candidates: string[], issueId: string | null = `${turn}:local1`): RepairHistoryEntry => ({turn, issueId, action: 'confirm',
  question: 'feature', partnerClaims: [], candidatesBefore: candidates, candidatesAfter: candidates, addedClaimIds: [], removedClaimIds: [], progress: 'unchanged'});
const judged = (turnIndex: number, action: string, targetSlot: string | null) => ({turnIndex, judgment: {action, targetSlot}});
const claim = (sourceTurn: number, act: string, targets: string[], speaker = 'human') => ({sourceTurn, act, targets, speaker});
// Run I: confirm at 2, accept at 4, agree at 6 on the same figure; the human then asks for the next figure (turn 8).
const runI = {history: [entry(2, ['X'])], judgments: [judged(2, 'confirm', 'X'), judged(4, 'accept', 'X'), judged(6, 'agree', 'X')]};

test('run I: an issue closed by a later agree is excluded and leaves nothing to estimate', () => {
  const gate = agreementGate(runI.history, runI.judgments, [], 8, {X: {status: 'agreed'}});
  assert.deepEqual(gate, {version: 'agreement_gate_v1', closed: [{turn: 2, issueId: '2:local1', agreeTurn: 6}]});
  assert.deepEqual(inferenceHistory(runI.history, gate), []);
  assert.equal(checkRepairGate(gate, runI.history, runI.judgments, 8), true);
});

test('repair history alone never means a repair is required: without agree the issue stays open', () => {
  for (const judgments of [[judged(2, 'confirm', 'X'), judged(4, 'accept', 'X')], [judged(2, 'confirm', 'X'), judged(4, 'propose_name', 'X')]]) {
    const gate = agreementGate(runI.history, judgments, [], 8);
    assert.deepEqual(gate.closed, []);
    assert.deepEqual(inferenceHistory(runI.history, gate), runI.history);
  }
});

test('an agree on another figure, or before the issue, does not close it', () => {
  assert.deepEqual(agreementGate(runI.history, [judged(6, 'agree', 'Y')], [], 8).closed, []);
  assert.deepEqual(agreementGate([entry(6, ['X'])], [judged(4, 'agree', 'X')], [], 8).closed, []);
  // An agree in the current turn has not been committed yet and cannot close anything.
  assert.deepEqual(agreementGate(runI.history, [judged(8, 'agree', 'X')], [], 8).closed, []);
});

test('other figures keep their open issues', () => {
  const history = [entry(2, ['X']), entry(4, ['Y'])];
  const gate = agreementGate(history, runI.judgments, [], 8);
  assert.deepEqual(inferenceHistory(history, gate), [entry(4, ['Y'])]);
});

test('an explicit human denial or name rejection after the agree reopens the issue', () => {
  for (const act of ['deny', 'name_reject']) {
    assert.deepEqual(agreementGate(runI.history, runI.judgments, [claim(7, act, ['X'])], 8).closed, []);
    assert.deepEqual(agreementGate(runI.history, runI.judgments, [claim(8, act, ['X'])], 8).closed, []);
  }
  // Acknowledgements, AI speech, other figures and claims before the agree do not reopen it.
  for (const c of [claim(7, 'agree', ['X']), claim(7, 'deny', ['X'], 'ai'), claim(7, 'deny', ['Y']), claim(5, 'deny', ['X'])]) {
    assert.equal(agreementGate(runI.history, runI.judgments, [c], 8).closed.length, 1);
  }
});

test('the figure must still be agreed: a later demoting act or a non-agreed ledger reopens the issue', () => {
  for (const later of [judged(7, 'repair', 'X'), judged(7, 'defer', 'X'), {turnIndex: 7, judgment: {action: 'confirm', targetSlot: 'X', candidateName: 'other name'}}]) {
    const judgments = [...runI.judgments, later];
    assert.deepEqual(agreementGate(runI.history, judgments, [], 8).closed, [], later.judgment.action);
    // Restore never accepts that closure either, whatever the final ledger says.
    assert.equal(checkRepairGate({version: 'agreement_gate_v1', closed: [{turn: 2, issueId: '2:local1', agreeTurn: 6}]}, runI.history, judgments, 8), false);
  }
  for (const status of ['tentative', 'unassigned', 'deferred']) assert.deepEqual(agreementGate(runI.history, runI.judgments, [], 8, {X: {status}}).closed, []);
  // Acts that keep an agreed figure agreed in the ledger do not reopen it; a re-agreement closes it again.
  for (const later of [judged(7, 'accept', 'X'), judged(7, 'revisit', 'X'), judged(7, 'confirm', 'X')]) {
    assert.equal(agreementGate(runI.history, [...runI.judgments, later], [], 8, {X: {status: 'agreed'}}).closed.length, 1);
  }
  const again = [...runI.judgments, judged(7, 'repair', 'X'), judged(9, 'agree', 'X')];
  assert.deepEqual(agreementGate(runI.history, again, [], 10, {X: {status: 'agreed'}}).closed, [{turn: 2, issueId: '2:local1', agreeTurn: 9}]);
});

test('multiple candidates close only when every candidate was later agreed', () => {
  const history = [entry(2, ['X', 'Y'])];
  assert.deepEqual(agreementGate(history, runI.judgments, [], 8).closed, []);
  const both = [...runI.judgments, judged(7, 'agree', 'Y')];
  assert.deepEqual(agreementGate(history, both, [], 9).closed, [{turn: 2, issueId: '2:local1', agreeTurn: 7}]);
  assert.deepEqual(agreementGate([entry(2, [])], runI.judgments, [], 8).closed, []);
});

test('restore accepts only closures justified by committed agrees before that turn', () => {
  const ok = agreementGate(runI.history, runI.judgments, [], 8);
  assert.equal(checkRepairGate(ok, runI.history, runI.judgments, 8), true);
  assert.equal(checkRepairGate({version: 'agreement_gate_v1', closed: []}, runI.history, runI.judgments, 8), true, 'a recorded reopening is kept as recorded');
  for (const bad of [
    {version: 'agreement_gate_v1', closed: [{turn: 2, issueId: '2:local1', agreeTurn: 4}]},
    {version: 'agreement_gate_v1', closed: [{turn: 2, issueId: 'other', agreeTurn: 6}]},
    {version: 'agreement_gate_v1', closed: [{turn: 2, issueId: '2:local1', agreeTurn: 8}]},
    {version: 'agreement_gate_v1', closed: [{turn: 2, issueId: '2:local1', agreeTurn: 6}, {turn: 2, issueId: '2:local1', agreeTurn: 6}]},
    {version: 'agreement_gate_v2', closed: []},
    {version: 'agreement_gate_v1', closed: [], extra: true},
  ]) assert.equal(checkRepairGate(bad, runI.history, runI.judgments, 8), false, JSON.stringify(bad));
  assert.equal(checkRepairGate(ok, runI.history, [judged(2, 'confirm', 'X')], 8), false, 'no agree in the saved judgments');
});
