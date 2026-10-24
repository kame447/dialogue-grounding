import { privateBaseOptions } from './support/s5-private-options.mjs';
// Independent engineering-only adversarial checks. No real API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { createNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { resolveActiveJudgment } from '../dialogue-model/runtime/v2/active-judge.mjs';
import { createOwnLedger, validateJudgment, applyJudgment, SAFE_JUDGMENT } from '../dialogue-model/runtime/judgment/schema.mjs';
import { DECISION_ACTIONS } from '../workers/research-ai-proxy/src/decisions.mjs';

const slots = ['s-0001', 's-0002', 's-0003', 's-0004', 's-0005', 's-0006'];
const slot = slots[0];
const ledger = (status = 'tentative') => ({ ...createOwnLedger(slots), [slot]: { status, name: status === 'unassigned' ? null : '鳥' } });
const luna = (extra = {}) => ({ ...SAFE_JUDGMENT, action: 'confirm', targetSlot: slot, candidateName: '鳥', discriminatingFeature: '尖りが二つある', ...extra });
const probabilities = action => Object.fromEntries(DECISION_ACTIONS.map(key => [key, key === action ? 1 : 0]));
const decision = (action, extra = {}) => ({ purpose: 'decision_jev', model: 'typesafe/jev-1.14-20261014', provider: 'TypeSafe', id: 'gen-active-audit',
  action, probabilities: probabilities(action), confidence: 1, usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.0001 }, latencyMs: 3, ...extra });
const resolve = (lunaJudgment, value, ownLedger = ledger(), strategy = 'repair-first') => resolveActiveJudgment({ lunaJudgment, decision: value, ownLedger, strategy });

test('active audit: agree spam cannot upgrade a Luna confirmation to agreement even on a tentative target', () => {
  for (const strategy of ['repair-first', 'bypass-enabled']) for (const status of ['unassigned', 'tentative', 'agreed', 'deferred']) {
    const ownLedger = ledger(status), before = structuredClone(ownLedger), interpretation = luna();
    const result = resolve(interpretation, decision('agree'), ownLedger, strategy);
    assert.equal(result.judgment.action, 'accept', `${strategy}/${status}`);
    assert.equal(result.judgment.targetSlot, null); assert.equal(result.judgment.candidateName, null);
    assert.deepEqual(applyJudgment(ownLedger, result.judgment), before);
    assert.match(JSON.stringify(result.record), /agree_ineligible/);
    assert.deepEqual(ownLedger, before);
  }
});

test('active audit: validated Luna agreement can be withheld by a supported confirmation in both strategies', () => {
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    const ownLedger = ledger(), interpretation = luna({ action: 'agree' });
    const result = resolve(interpretation, decision('confirm'), ownLedger, strategy);
    assert.equal(result.judgment.action, 'confirm'); assert.equal(result.judgment.targetSlot, slot);
    assert.equal(applyJudgment(ownLedger, result.judgment)[slot].status, 'tentative');
  }
});

test('active audit: invalid or unsupported probability distributions fall back to the validated Luna judgment', () => {
  const interpretation = luna({ followUp: { action: 'propose_name', targetSlot: slots[1], candidateName: '舟', discriminatingFeature: null } });
  const invalid = [null, [], {}, { agree: 1 }, Object.fromEntries(DECISION_ACTIONS.map(key => [key, 0])),
    { ...probabilities('agree'), accept: NaN }, { ...probabilities('agree'), accept: Infinity },
    { ...probabilities('agree'), accept: -0.01 }, { ...probabilities('agree'), accept: 0.5 }];
  for (const values of invalid) {
    const result = resolve(interpretation, decision('agree', { probabilities: values }));
    assert.deepEqual(result.judgment, validateJudgment(interpretation, { ownLedger: ledger(), agreeEvidence: true }));
    assert.match(JSON.stringify(result.record), /fallback/);
  }
});

test('active audit: rounded Jev probability mass is accepted while a zero-support choice is a malformed fallback', () => {
  const interpretation = luna();
  const rounded = { ...probabilities('confirm'), confirm: 0.99 };
  assert.equal(resolve(interpretation, decision('confirm', { probabilities: rounded })).record.resolution, 'decision');
  const zeroChosen = resolve(interpretation, decision('close', { probabilities: probabilities('accept') }));
  assert.deepEqual(zeroChosen.judgment, validateJudgment(interpretation, { ownLedger: ledger(), agreeEvidence: true }));
  assert.equal(zeroChosen.record.resolution, 'fallback');
});

test('active audit: hostile extra target/name/followUp/reference/notes never override the Luna interpretation or enter diagnostics', () => {
  const ref = { slots: [slot], epistemic: 'grounded', intent: 'name_proposal', feature: null,
    nameAcceptance: { slot, name: '鳥' }, deferSlot: null, revisitSlot: null };
  const interpretation = luna({ reference: ref, followUp: { action: 'propose_name', targetSlot: slots[1], candidateName: '舟', discriminatingFeature: null } });
  const poison = 'PRIVATE-HOSTILE-PAYLOAD-CANARY';
  const result = resolve(interpretation, decision('move_on', { targetSlot: slots[4], candidateName: poison, note: poison,
    followUp: { action: 'agree', targetSlot: slots[4], candidateName: poison, discriminatingFeature: null },
    reference: { injected: poison }, privatePayload: poison, probabilities: { ...probabilities('move_on'), extra: poison } }));
  assert.equal(result.judgment.action, 'move_on'); assert.equal(result.judgment.targetSlot, slot); assert.equal(result.judgment.candidateName, null);
  assert.equal(Object.hasOwn(result.judgment, 'followUp'), false); assert.deepEqual(result.judgment.reference, ref);
  assert.equal(result.record.droppedFollowUp, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-HOSTILE/);
  assert.deepEqual(Object.keys(result.record.probabilities).sort(), [...DECISION_ACTIONS].sort());
});

test('active audit: safe_accept removes a Luna followUp, unchanged supported actions retain it, and error fallback preserves validated Luna', () => {
  const interpretation = { ...SAFE_JUDGMENT, followUp: { action: 'propose_name', targetSlot: slots[1], candidateName: '舟', discriminatingFeature: null } };
  const safe = resolve(interpretation, decision('agree'));
  assert.equal(safe.record.resolution, 'safe_accept'); assert.equal(Object.hasOwn(safe.judgment, 'followUp'), false);
  assert.deepEqual(applyJudgment(ledger(), safe.judgment), ledger());
  const same = resolve(interpretation, decision('accept'));
  assert.deepEqual(same.judgment.followUp, interpretation.followUp);
  const failure = resolve(interpretation, Object.assign(new Error('PRIVATE-CONNECTION-ERROR'), { code: 'payment_required' }));
  assert.equal(failure.record.resolution, 'fallback'); assert.equal(failure.record.error, 'payment_required');
  assert.deepEqual(failure.judgment.followUp, interpretation.followUp); assert.doesNotMatch(JSON.stringify(failure), /PRIVATE-CONNECTION/);
});

test('active audit: rerank uses only positive support and has deterministic Worker-order ties across strategies', () => {
  const distribution = { ...probabilities('agree'), agree: 0.6, accept: 0.2, confirm: 0.2 };
  const records = [];
  for (const strategy of ['repair-first', 'bypass-enabled']) {
    const result = resolve(luna(), decision('agree', { probabilities: distribution }), ledger(), strategy);
    assert.equal(result.record.resolution, 'rerank'); assert.equal(result.judgment.action, 'accept');
    assert.equal(result.judgment.candidateName, null); records.push(result);
  }
  assert.deepEqual(records[0], records[1]);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (seq, text, speaker = 'human') => ({ seq, turn: seq, id: `event-${seq}`, text, speaker, at: '2026-10-18T00:00:00.000Z' });
const anchors = slots.map((id, i) => ({ id, bbox: { x: i * 10, y: 0, w: 5, h: 5 }, centroid: { x: i * 10 + 2, y: 2 } }));
const image = { mimeType: 'image/png', base64: 'c3ludGhldGljLW93bi1pbWFnZQ==' };
function makeRunner({ chooseAction, judge = { async judge() { return SAFE_JUDGMENT; } }, generate = async () => ({ text: '公開の返答' }), referenceMemory = false } = {}) {
  const calls = [];
  const dialogue = createDialogueV2({ strategy: 'repair-first', image, anchors, judge, referenceMemory,
    client: { async complete(messages, options) { calls.push({ messages: structuredClone(messages), options }); return generate(messages, options); } },
    activeDecision: { client: { chooseAction }, purpose: 'decision_jev' } });
  return { dialogue, calls, run: (events, signal = new AbortController().signal, privateState = dialogue.initialPrivateState()) =>
    dialogue.runAiTurn({ events, lastEventId: events.at(-1).id, signal, privateState }) };
}

test('active audit: abort while waiting for Decisions escapes fallback and starts no stale generation', async () => {
  const started = deferred(), release = deferred(), controller = new AbortController();
  const app = makeRunner({ async chooseAction() { started.resolve(); await release.promise; throw new Error('PRIVATE-ABORT-ERROR'); } });
  const pending = app.run([event(1, '最初の発話')], controller.signal);
  await started.promise; controller.abort(); release.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(app.calls.length, 0);
  assert.deepEqual(app.dialogue.initialPrivateState().ledger, createOwnLedger(slots));
  assert.doesNotMatch(JSON.stringify(app.dialogue.getAttempts()), /PRIVATE-ABORT/);
});

test('active audit: a newer human message supersedes the waiting decision and only the current queue snapshot commits', async () => {
  const started = deferred(), release = deferred(), evidence = [], generations = [];
  let decisions = 0;
  const task = await createNamingTaskV2({ seed: 64, strategy: 'repair-first', runDir: '', judge: { async judge() { return SAFE_JUDGMENT; } },
    client: { async complete(messages, { phase }) {
      assert.equal(phase, 'generation'); generations.push(messages); return { text: '二つの発話への公開返答' };
    } }, activeDecision: { purpose: 'decision_jev', client: { async chooseAction(args) {
      evidence.push(args.state); if (decisions++ === 0) { started.resolve(); await release.promise; } return decision('accept');
    } } } });
  task.message('最初の合成発話', 'first'); await started.promise;
  task.message('新しい訂正の合成発話', 'second');
  assert.equal(task.getState().events.filter(e => e.speaker === 'human').length, 2);
  release.resolve(); await task.whenIdle();
  assert.equal(decisions, 2); assert.equal(generations.length, 1);
  assert.deepEqual(generations[0].filter(m => m.role === 'user' && typeof m.content === 'string').map(m => m.content), ['最初の合成発話', '新しい訂正の合成発話']);
  assert.ok(!evidence[0].includes('新しい訂正')); assert.ok(evidence[1].includes('新しい訂正'));
  const researcher = task.researcherView();
  assert.equal(researcher.privateState.judgments.length, 1); assert.equal(researcher.privateState.judgments[0].turnIndex, 3);
  assert.equal(researcher.attempts.length, 2);
  assert.equal(task.getState().events.filter(e => e.speaker === 'ai').length, 2);
  const opening = task.getState().events[0];
  assert.deepEqual([opening.id, opening.speaker, opening.text], ['event-1', 'ai', 'まず、どの図形から話しましょうか？']);
  assert.doesNotMatch(JSON.stringify(task.getState()), /activeDecision|activeJudge|decision_jev|probabilities|lunaAction|rejectedCandidates/);
});

test('active audit: reference is applied once after successful generation, never on failed generation, even when the action changes', async () => {
  let fail = true;
  const reference = { slots: [slot], epistemic: 'grounded', intent: 'name_proposal', feature: null,
    nameAcceptance: { slot, name: '鳥' }, deferSlot: null, revisitSlot: null };
  const app = makeRunner({ referenceMemory: true, judge: { async judge() { return luna({ reference }); } },
    async chooseAction() { return decision('move_on'); }, async generate() { if (fail) { fail = false; throw new Error('PRIVATE-GENERATION'); } return { text: '次の相談へ進みます' }; } });
  const initial = app.dialogue.initialPrivateState(), events = [event(1, '鳥と呼ぶのはどうでしょう')];
  await assert.rejects(app.run(events, undefined, initial));
  assert.equal(initial.graph.records.length, 0); assert.equal(initial.judgments.length, 0);
  const result = await app.run(events, undefined, initial);
  assert.equal(result.privateState.graph.records.length, 2);
  assert.equal(result.privateState.judgments[0].memory.opsApplied, 2);
  assert.equal(result.privateState.ledger[slot].status, 'unassigned');
  assert.doesNotMatch(JSON.stringify(app.dialogue.getAttempts()), /PRIVATE-GENERATION/);
});

test('active audit: participant start payload cannot choose the judge mode; server startup option is private and v2-only', async t => {
  for (const configured of [null, { purpose: 'decision_jev', client: { async chooseAction() { throw new Error('not called during initial construction'); } } }]) {
    const calls = [];
    const server = createNamingServer({client:{},...(await privateBaseOptions(t,{seed:64})),activeDecision:configured,
      createTask:async()=>{throw new Error('v1 must not construct')},
      createTaskV2:async options=>{calls.push(options);return createNamingTaskV2(options)}});
    server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>server.close(done)));
    const origin='http://127.0.0.1:'+server.address().port,page=await fetch(origin+'/'),cookie=page.headers.get('set-cookie').split(';')[0];
    assert.doesNotMatch(await page.text(),/activeDecision|active-decision-judge|decision_jev|decision_luna/);
    const start=body=>fetch(origin+'/api/start',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
    for(const version of [2,1]){
      const response=await start({version,seed:64,strategy:'repair-first',activeDecision:{purpose:'decision_luna'},activeDecisionJudge:'decision_luna',activeJudge:'decision_luna'});
      assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'invalid_request'});assert.equal(calls.length,0);
    }
    const clean=await start({version:2});assert.equal(clean.status,200);assert.doesNotMatch(await clean.text(),/activeDecision|activeJudge|decision_luna|decision_jev/);
    assert.equal(calls.length,1);assert.equal(calls[0].activeDecision,configured);
    const state=await fetch(origin+'/api/state',{headers:{Cookie:cookie}});assert.doesNotMatch(await state.text(),/activeDecision|activeJudge|decision_luna|decision_jev/);
  }
});
