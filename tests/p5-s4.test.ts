import assert from 'node:assert/strict';
import test from 'node:test';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { buildRecords, initialState, normal, OWN, runTurn, type Turn } from './support/s4-v3-records.ts';

const version = 'jev_generation_retry_v13';
const policy = 'holistic_v5';
const slot = OWN.ownAnchors[0].id;
const bird = '鳥のような形です。';
const agreement = '私にも鳥のように見えます。';
const segment = (quote: string, respondsToTurn: number | null) => ({
  segmentId: 'bird', quote, proposition: '鳥', name: null, targets: [slot], aspect: 'construal',
  linkedIssueId: null, respondsToTurn,
});
const opening: Turn = {
  human: 'どのような形に見えますか？',
  plan: { action: 'accept', target: 'figure_0', speech: bird, aiExtraction: JSON.stringify([segment(bird, null)]) },
};
const support: Turn = {
  human: agreement,
  plan: { action: 'defer', target: 'figure_0', speech: 'なるほど。', sharedConstrual: 'use_0',
    actionScores: { defer: 1, accept: 0.8 }, act: 'agree', antecedent: 'claim_0', extraction: JSON.stringify([segment(agreement, 2)]) },
};
const checksFor = (records: any) => verifyRecords(records).checks.filter(c => c.id.startsWith('intervention.trial.0.attempt.0.'));
const build = (label: 'repair-first' | 'bypass-enabled', choice = 'use_0') => buildRecords({
  label, generationRetryVersion: version, dialoguePolicy: policy, agreeNameScopeVersion: 'scoped_v7',
  turns: [opening, { ...support, plan: { ...support.plan, sharedConstrual: choice } }],
});

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  for (const choice of ['none', 'use_0']) {
    test('v13 S4 ' + label + ' checks both sides independently with ' + choice, async () => {
      const records = await build(label, choice);
      const checks = checksFor(records);
      assert.deepEqual(checks.map(c => c.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(checks));
      const trial = records.trials[0];
      assert.equal(trial.attempts[0].sharedConstruals.length, 1);
      assert.equal(trial.attempts[0].sharedConstruals[0].construal, '鳥');
      const [repair, bypass] = trial.replay[0].result.sides;
      const shared = (side: any) => side.requests.filter((r: any) => r.payload.questions?.shared_construal);
      assert.equal(shared(repair).length, 1);
      assert.equal(shared(repair)[0].role, 'alternative_detail');
      assert.equal(shared(bypass).length, 0);
      assert.equal(repair.intervention.detailEvidence.choices.shared_construal, choice);
      const generationUsesShared = (side: any) => side.requests.some((request: any) => request.role === 'generation' &&
        request.payload.messages.some((message: any) => message.content.includes('大まかな共同参照の目印')));
      assert.equal(generationUsesShared(repair), choice === 'use_0');
      assert.equal(generationUsesShared(bypass), false);
      assert.equal(trial.attempts[0].publicSpeech, 'なるほど。');
    });
  }
}

test('v13 S4 detects missing and fabricated candidates in mutually consistent saved copies', async () => {
  // The saved bypass side has no selection or detail stage to give the forgery away.
  // The verifier has to recover the missing or changed candidate from the graph itself.
  const records = await build('bypass-enabled');
  assert.ok(checksFor(records).every(c => c.status === 'pass'));
  for (const damage of [
    (owner: any) => { delete owner.sharedConstruals; },
    (owner: any) => { owner.sharedConstruals[0].construal = '水車'; },
  ]) {
    const tampered = structuredClone(records), trial = tampered.trials[0], turn = trial.turns[0];
    for (const owner of [trial.attempts[0], turn.trace[0], turn.state.judgments.at(-1).jevTurn,
      trial.lastCommittedState.judgments.at(-1).jevTurn]) damage(owner);
    const checks = checksFor(tampered);
    assert.deepEqual(checks.map(c => c.status), ['pass', 'pass', 'pass', 'mismatch'], JSON.stringify(checks));
  }
});

test('v13 accepts its own failed accept detail shape and v12 rejects that extra stage', async () => {
  const profile = { ...normal.trials[0].profile, questionLayout: 'two_stage_v3', dialoguePolicy: policy };
  const initial = initialState({ profile, generationRetryVersion: version, agreeNameScopeVersion: 'scoped_v7' });
  const events = [{ id: 'human-1', seq: 1, speaker: 'human', text: opening.human }];
  const first = await runTurn(profile, 'bypass-enabled', initial, events, opening.plan, undefined, version);
  const history = [...events, { id: 'ai-2', seq: 2, speaker: 'ai', text: bird }, { id: 'human-3', seq: 3, speaker: 'human', text: agreement }];
  const acceptPlan = { ...support.plan, action: 'accept' };
  const accepted = await runTurn(profile, 'bypass-enabled', first.state, history, acceptPlan, undefined, version);
  await assert.rejects(runTurn(profile, 'bypass-enabled', first.state, history, {
    ...acceptPlan, failSharedDetail: true,
  }, undefined, version), (error: any) => {
    assert.equal(error.code, 'decision_failed');
    const trace = error.traces.at(-1);
    assert.deepEqual(trace.decisionFailure.evidence.stages.map((s: any) => s.stage), ['action', 'target', 'detail']);
    assert.ok(s4Probe.traceShape(trace, 'two_stage_v3', policy));
    const legacy = structuredClone(trace);
    // Early v12 failures did not carry a generation marker. Isolate the
    // stage rule by making the other clues to v13 absent.
    delete legacy.generationRetryVersion;
    delete legacy.sharedConstruals;
    assert.equal(s4Probe.traceShape(legacy, 'two_stage_v3', policy), false);
    const evidence = legacy.decisionFailure.evidence;
    evidence.stages.pop();
    const last = evidence.stages.at(-1);
    Object.assign(evidence, { model: last.model, responseId: last.responseId,
      costUsd: evidence.stages.reduce((sum: number, stage: any) => sum + stage.costUsd, 0) });
    assert.ok(s4Probe.traceShape(legacy, 'two_stage_v3', policy));
    // A deadline may expire after the provider answers the detail stage. In
    // that case the failure records the closed menu and its answered choice.
    const answered = structuredClone(trace), answer = accepted.trace.decisions[0].evidence;
    Object.assign(answered.decisionFailure.evidence, {
      error: 'timeout', model: answer.model, responseId: answer.responseId, costUsd: answer.costUsd,
      inputBudget: answer.inputBudget, stages: answer.stages!.map((stage: any) => ({
        ...stage, status: 'ok', error: null, rejectionCode: null,
      })),
    });
    assert.ok(s4Probe.traceShape(answered, 'two_stage_v3', policy));
    const answeredLegacy = structuredClone(answered);
    delete answeredLegacy.sharedConstruals;
    delete answeredLegacy.generationRetryVersion;
    assert.equal(s4Probe.traceShape(answeredLegacy, 'two_stage_v3', policy), false);
    const detail = answered.decisionFailure.evidence.stages[2];
    detail.choices.shared_construal = 'use_2';
    detail.scores.shared_construal = { none: 0, use_2: 1 };
    assert.equal(s4Probe.traceShape(answered, 'two_stage_v3', policy), false);
    return true;
  });
});

test('v13 S4 verifies original accept detail and refuses a saved copy without its detail', async () => {
  const records = await buildRecords({
    label: 'bypass-enabled', generationRetryVersion: version, dialoguePolicy: policy,
    turns: [opening, { ...support, plan: { ...support.plan, action: 'accept', actionScores: { accept: 1 } } }],
  });
  assert.ok(checksFor(records).every(c => c.status === 'pass'));
  const trial = records.trials[0], turn = trial.turns[0], attempt = trial.attempts[0];
  assert.equal(attempt.decisions[0].evidence.stages[2].choices.shared_construal, 'use_0');
  const copies = [attempt.decisions[0], turn.trace[0].decisions[0],
    turn.state.judgments.at(-1).jevTurn.decision, trial.lastCommittedState.judgments.at(-1).jevTurn.decision];
  copies.forEach(decision => decision.evidence.stages.pop());
  assert.equal(checksFor(records)[0].status, 'mismatch');
});

test('v13 S4 verifies shared construal alongside one feature in a strict naming request', async () => {
  const ask = 'この形を「トビ」と呼ぶのはどうでしょうか？';
  const records = await buildRecords({
    label: 'repair-first', generationRetryVersion: version, dialoguePolicy: policy, agreeNameScopeVersion: 'scoped_v7',
    turns: [
      opening,
      { ...support, plan: { ...support.plan, action: 'accept', actionScores: { accept: 1 }, sharedConstrual: 'none' } },
      { human: ask, plan: { action: 'confirm', target: 'figure_0', sharedConstrual: 'use_0', referent: 'figure_0',
        act: 'name_propose', extraction: JSON.stringify([{ ...segment(ask, null), name: 'トビ', aspect: 'name', proposition: ask }]),
        speech: 'その特徴を確かめてもよいですか？' } },
    ],
  });
  const checks = checksFor(records), trial = records.trials[0];
  assert.deepEqual(checks.map(c => c.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(checks));
  assert.equal(trial.attempts[0].namingRequest, true);
  assert.deepEqual(Object.keys(trial.attempts[0].decisions[0].evidence.stages[2].choices), ['feature', 'shared_construal']);
  assert.deepEqual(trial.lastCommittedState.ledger, trial.replay[0].tape.state.ledger);
});

test('v13 S4 rejects a changed generation prompt on the comparison side despite consistent hashes', async () => {
  const records = await build('bypass-enabled');
  assert.ok(checksFor(records).every(c => c.status === 'pass'));
  const trial = records.trials[0], repair = trial.replay[0].result.sides[0];
  const request = repair.requests.find((entry: any) => entry.role === 'generation');
  const message = request.payload.messages.find((entry: any) => entry.content.includes('大まかな共同参照の目印'));
  assert.ok(message);
  request.payload.messages = request.payload.messages.filter((entry: any) => entry !== message);
  request.completeMessagesSha256 = hash(request.payload.messages);
  request.payloadSha256 = hash(request.payload);
  request.preProjectionPayloadSha256 = request.payloadSha256;
  records.evidence.pairedReplay[0].left = structuredClone(repair);
  const checks = checksFor(records);
  assert.deepEqual(checks.map(c => c.status), ['pass', 'pass', 'pass', 'mismatch'], JSON.stringify(checks));
});
