import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BYPASS_ACCEPTANCE_V1_CANONICAL_JSON, BYPASS_ACCEPTANCE_V1_TABLE_SHA256 } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { BYPASS_ACCEPTANCE_V2_CANONICAL_JSON, BYPASS_ACCEPTANCE_V2_TABLE_SHA256, MOVE_ON_SOURCE_QUESTION } from '../dialogue-model/runtime/decision/human-led-move-on.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { buildRecords, initialState, normal, runTurn } from './support/s4-v3-records.ts';
import type { Label, Plan, Turn } from './support/s4-v3-records.ts';

const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const generationRetryVersion = 'jev_generation_retry_v15';
const agreeNameScopeVersion = 'scoped_v11';
const interventionVersion = 'bypass_acceptance_v2';
const dialoguePolicy = 'holistic_v5';
const opts = { dialoguePolicy, generationRetryVersion, agreeNameScopeVersion, technicalTrial, interventionVersion } as const;
const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', dialoguePolicy, interventionVersion);
const legacy = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', dialoguePolicy);
const first: Turn = {
  human: '似た形がいくつかあって迷っています。',
  plan: { action: 'confirm', target: 'figure_0', speech: 'その形に、輪につながる部分はありますか？' },
};
const options = { ...opts, turns: [first] };
const move = (source: 'human_request' | 'unclear' | 'other'): Plan => ({
  action: 'move_on',
  target: 'none',
  issue: 'issue_0',
  prospect: 'stalled',
  actionScores: { move_on: 1, confirm: 0.8, repair: 0.2 },
  speechByLabel: { 'repair-first': 'その形の特徴をもう少し教えてください。', 'bypass-enabled': 'では、別の形について話しましょう。' },
  choose: key => key === MOVE_ON_SOURCE_QUESTION ? source : undefined,
});
function intervention({ intervention }: Pick<JevTurnTrace, 'intervention'>) {
  assert.ok(intervention && typeof intervention === 'object');
  return intervention;
}

test('human-led move-on preserves the existing table and gives the addition its own digest', () => {
  const sha = (json: string) => createHash('sha256').update(json).digest('hex');
  assert.equal(sha(BYPASS_ACCEPTANCE_V1_CANONICAL_JSON), BYPASS_ACCEPTANCE_V1_TABLE_SHA256);
  assert.equal(sha(BYPASS_ACCEPTANCE_V2_CANONICAL_JSON), BYPASS_ACCEPTANCE_V2_TABLE_SHA256);
  assert.notEqual(legacy.interventionPolicy.tableSha256, profile.interventionPolicy.tableSha256);
});

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  test(label + ' accepts a human-led move and preserves the open repair; S4 binds the source', async () => {
    let last: Awaited<ReturnType<typeof runTurn>> | undefined;
    const transition: Turn = { human: 'いったん別の形を見たいです。', plan: {
      ...move('human_request'), speechByLabel: undefined, speech: 'では、別の形について話しましょう。',
    } };
    const records = await buildRecords({ ...options, label, turns: [first, transition],
      onTurn: (condition: Label, result) => { if (condition === label) last = result; } });
    assert.ok(last);
    const tape = records.trials[0].replay[0].tape;
    assert.equal(last.trace.executed.action, 'move_on');
    assert.equal(last.trace.finalAction?.action, 'move_on');
    assert.equal(intervention(last.trace).reasonCode, 'human_led_move_on');
    assert.equal(last.speech, transition.plan.speech);
    assert.deepEqual(intervention(last.trace).humanMoveOn, { source: 'human', publicTurn: 3, openRepairTurns: [1] });
    assert.deepEqual(last.state.ledger, tape.state.ledger);
    assert.equal(last.state.repairHistory[0].turn, tape.state.repairHistory[0].turn);
    assert.equal(last.state.repairHistory[0].issueId, tape.state.repairHistory[0].issueId);
    assert.equal(last.jev.filter(response => Object.hasOwn(response.answers, MOVE_ON_SOURCE_QUESTION)).length, 1);
    assert.equal(last.jev.filter(response => Object.hasOwn(response.answers, 'action')).length, 1);
    const checks = verifyRecords(records).checks.filter(c => c.id.startsWith('intervention.trial.0.attempt.0.'));
    assert.deepEqual(checks.map(c => [c.id.split('.').at(-1), c.status]),
      [['shape', 'pass'], ['binding', 'pass'], ['execution', 'pass'], ['replay', 'pass']]);
    const damaged = structuredClone(records);
    damaged.trials[0].attempts[0].intervention.humanMoveOn.publicTurn = 1;
    assert.ok(verifyRecords(damaged).checks.some(c => c.id === 'intervention.trial.0.attempt.0.execution' && c.status === 'mismatch'));
  });
}

test('repair-first still vetoes AI-initiated moves, unclear remarks, backchannels, assent to AI and defer', async () => {
  const state = initialState({ profile, generationRetryVersion, agreeNameScopeVersion });
  const opened = await runTurn(profile, 'repair-first', state, [{ seq: 1, speaker: 'human', text: first.human }],
    first.plan, technicalTrial, generationRetryVersion);
  const examples: { text: string; source: Parameters<typeof move>[0]; action?: string }[] = [
    { text: '長い線が少し曲がっています。', source: 'other' },
    { text: '別の形かもしれません。', source: 'unclear' },
    { text: 'なるほど。', source: 'other' },
    { text: '別の形を話してみたいです。', source: 'human_request', action: 'defer' },
  ];
  for (const { text, source, action = 'move_on' } of examples) {
    const run = await runTurn(profile, 'repair-first', opened.state, [...opened.publication.publicEvents, { seq: 3, speaker: 'human', text }],
      { ...move(source), action }, technicalTrial, generationRetryVersion);
    assert.equal(intervention(run.trace).reasonCode, 'vetoed_bypass_action');
    assert.equal(intervention(run.trace).humanMoveOn, undefined);
    assert.equal(intervention(run.trace).rerank?.policyId, 'saved_action_scores_open_issue_v1');
    assert.equal(run.trace.executed.action, 'confirm');
  }
  const invited = await runTurn(profile, 'repair-first', state, [
    { seq: 1, speaker: 'ai', text: '別の形について話しませんか？', nonReferential: true },
    { seq: 2, speaker: 'human', text: 'はい、そうしましょう。' },
  ], move('other'), technicalTrial, generationRetryVersion);
  assert.equal(intervention(invited.trace).reasonCode, 'vetoed_bypass_action');
  assert.equal(intervention(invited.trace).humanMoveOn, undefined);
});

test('the old profile has no source question and keeps its veto', async () => {
  const state = initialState({ profile: legacy, generationRetryVersion, agreeNameScopeVersion });
  const opened = await runTurn(legacy, 'repair-first', state, [{ seq: 1, speaker: 'human', text: first.human }],
    first.plan, technicalTrial, generationRetryVersion);
  const events = [...opened.publication.publicEvents, { seq: 3, speaker: 'human', text: '別の話を先にしませんか？' }];
  const run = await runTurn(legacy, 'repair-first', opened.state, events, move('human_request'), technicalTrial, generationRetryVersion);
  assert.equal(intervention(run.trace).policy, 'bypass_acceptance_v1:veto');
  assert.equal(intervention(run.trace).reasonCode, 'vetoed_bypass_action');
  assert.equal(run.trace.executed.action, 'confirm');
  assert.ok(run.jev.every(response => !Object.hasOwn(response.answers, MOVE_ON_SOURCE_QUESTION)));
});
