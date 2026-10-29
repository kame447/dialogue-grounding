// #141 (c): a technical-trial Jev turn that spends its one reobservation must stay savable and restorable.
// The second stage-one question omits request_observation (reobservationAllowed=false); the saved
// private state must accept exactly that omission and nothing wider. Synthetic Jev wire only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileDialogue} from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import {createJevDecisionClient} from '../dialogue-model/runtime/decision/jev-decision.ts';
import {interventionForStrategy} from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import {JEV_ACTIONS} from '../dialogue-model/runtime/decision/contract.ts';
import {validateJevPrivateStateV2} from '../dialogue-model/runtime/v2/jev-turn.ts';
import {ids, anchors, image, memo, profile} from './support/s4-integration/harness.ts';

const events = [{id: 'h1', seq: 1, speaker: 'human', text: 'Start with the upper right one.'}];

async function run(strategy: string, version: string, firstAction: 'request_observation' | 'repair' = 'request_observation') {
  let actions = 0;
  const wire: string[][] = [];
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(init.body); const answers: any = {};
    wire.push(Object.keys(body.questions).filter(k => !k.startsWith('candidate_')));
    if ('action' in body.questions) actions++;
    for (const [key, q] of Object.entries(body.questions) as any) {
      const labels = Object.keys(q.criteria);
      const choice = key === 'action' ? (actions === 1 ? firstAction : 'repair') : key === 'target' ? 'figure_0' :
        key.startsWith('candidate_') ? 'exclude' : labels.includes('none') ? 'none' : labels[0];
      assert.ok(labels.includes(choice), key);
      answers[key] = {type: 'choice', choice, probabilities: Object.fromEntries(labels.map(k => [k, k === choice ? 1 : 0]))};
    }
    return Response.json({model: 'typesafe/jev-1.14', id: 'gen-synthetic-' + wire.length, usage: {cost: 0}, answers});
  };
  const jevDecision = createJevDecisionClient({enabled: true, readKey: async () => 'sk-or-SYNTHETIC-0000000000000000', fetchImpl,
    timeoutMs: 1000, researchLimits: {maxDeadlineMs: 600000}})!;
  const traces: any[] = [];
  const runtime = createProfileDialogue(profile(), {strategy, image, anchors, jevDecision, referenceMemory: true, decisionMode: 'jev',
    client: {async complete(_m: any[], o: any) { return {text: ['local_extraction', 'ai_extraction'].includes(o.phase) ? '[]' : 'Control.'}; }},
    observer: {async observeAll() { return memo(); }, async reobserve(input: any) { return {observedAt: '2026-01-01T00:00:01.000Z', issue: input.issue,
      figures: input.figureIds.map((figureId: string) => ({figureId, supports: ['control-support'], contradicts: [], unknown: []}))}; }},
    localGrounding: {classifier: {async classify() { return []; }}, aiPublicTransport: {readKey: async () => { throw Error('unused'); }, fetchImpl: async () => { throw Error('unused'); }}},
    onJevTurnTrace: (t: any) => traces.push(t), technicalTrial: {version}} as any);
  const result = await runtime.runAiTurn({events, privateState: runtime.initialPrivateState(), lastEventId: 'h1', requestSeq: 1});
  return {runtime, wire, traces, saved: JSON.parse(JSON.stringify(result.privateState))};
}
const stageOneKeys = (s: any) => Object.keys(s.judgments[0].jevTurn.decision.evidence.stages[0].scores.action).sort();

for (const version of ['adaptive_repair_v1', 'adaptive_repair_v2']) for (const strategy of ['repair-first', 'bypass-enabled']) {
  test(`${version} ${strategy}: a turn that used its reobservation saves, validates and restores`, async () => {
    const {runtime, wire, traces, saved} = await run(strategy, version);
    assert.deepEqual(wire.filter(k => k.includes('action') || k.includes('observe_targets')),
      [['action', 'target'], ['observe_targets', 'observe_aspect'], ['action', 'target']]);
    assert.equal(traces.at(-1).reobservations.length, 1);
    assert.equal(saved.judgments[0].jevTurn.decision.action, 'repair');
    assert.ok(!stageOneKeys(saved).includes('request_observation'));
    assert.deepEqual(validateJevPrivateStateV2(saved, ids, interventionForStrategy(strategy)), saved);
    assert.doesNotThrow(() => runtime.snapshotGraph(saved));
  });
}

test('only the request_observation omission is accepted; other stage-one key changes still reject', async () => {
  const {saved} = await run('bypass-enabled', 'adaptive_repair_v1');
  const policy = interventionForStrategy('bypass-enabled');
  const scores = (s: any) => [s.judgments[0].jevTurn.decision.evidence.stages[0].scores, s.judgments[0].jevTurn.decision.evidence.scores];
  for (const tamper of [(s: any) => { for (const x of scores(s)) delete x.action.accept; },
    (s: any) => { for (const x of scores(s)) x.action.unknown_action = 0; }]) {
    const bad = structuredClone(saved); tamper(bad);
    assert.throws(() => validateJevPrivateStateV2(bad, ids, policy), {code: 'invalid_state'});
  }
});

test('a turn without reobservation keeps the full stage-one set, including request_observation', async () => {
  const {saved} = await run('repair-first', 'adaptive_repair_v1', 'repair');
  // No public name exists, so agree is absent (#150); every other action, request_observation included, is present.
  assert.deepEqual(stageOneKeys(saved), JEV_ACTIONS.filter(a => a !== 'agree').sort());
  assert.deepEqual(validateJevPrivateStateV2(saved, ids, interventionForStrategy('repair-first')), saved);
});
