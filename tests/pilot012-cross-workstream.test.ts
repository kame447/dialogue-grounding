import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMockJevDecisionClient } from '../dialogue-model/runtime/decision/mocks.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { scoreTrial } from '../dialogue-model/runtime/scoring.mjs';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { ParticipantUsageLedger } from '../dialogue-model/runtime/web/participant-usage.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../dialogue-model/runtime/web/participant-usage-policy.ts';
import type { LocalOwnAnchor } from '../dialogue-model/runtime/local-grounding/contract.ts';
import type { ObservationMemo } from '../dialogue-model/runtime/observation/contract.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import type { ParticipantUsageSnapshot, ParticipantUsageStore } from '../dialogue-model/runtime/web/participant-usage.ts';
import { initialState, normal, OWN, runTurn } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const seed = 12012;
const trial = createTrialV2({ seed });
const ownAnchors: readonly LocalOwnAnchor[] = modelView(trial).anchors;
const { lunaRequest, timeouts } = normal.run.manifest;
const legacyProfile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5', 'bypass_acceptance_v2');
const legacyGeneration = 'jev_generation_retry_v16';
const integratedGeneration = 'jev_generation_retry_v17';
const technicalTrial = { version: 'adaptive_repair_v3' } as const;
const limits = { lunaCalls: 50, lunaPosts: 50, lunaTokens: 100_000, jevPosts: 50, jevUsd: 5 };
const at = '2000-01-01T00:00:00.000Z';
const reply = 'こちらでは、丸い部分が細い台につながって見えます。';
const memo: ObservationMemo = { observedAt: at, figures: ownAnchors.map(anchor => ({
  id: anchor.id, region: anchor.bbox, holistic: [],
  analytic: { shapes: ['丸い部分'], composition: '丸い部分と細い台が接している', relations: [] },
  unknowns: [], reobservations: [],
})) };
const aiNames = Object.fromEntries(ownAnchors.map((anchor, index) => [anchor.id, index === 0 ? 'ホイッスル' : null]));
const namedFigure = trial.key.ai[ownAnchors[0].id];
const humanNames = Object.fromEntries(Object.entries(trial.key.human).map(([slot, figure]) =>
  [slot, figure === namedFigure ? 'ほいっする' : null]));

type ScoreInput = { key: typeof trial.key; humanSubmission: Record<string, string>; aiSubmission: Record<string, string> };
type ScoreRecord = { key: ScoreInput['key']; result: ReturnType<typeof scoreTrial> };
type SavedTrial = {
  options: { generationRetryVersion: string; interventionPolicy: typeof legacyProfile.interventionPolicy; participantRuntimeProfile?: string };
  events: { text: string; origin?: string }[];
  queueState: { pendingHumanEventIds: string[]; errorCode: string | null };
  jevTraces: JevTurnTrace[];
  scoring: ScoreRecord | null;
  jevLedger: unknown;
};

function legacyOptions(strategy: Label, { rejectGeneration = false } = {}) {
  const phases: string[] = [];
  let scores = 0;
  let saved: SavedTrial | undefined;
  const client = { async complete(_messages: unknown, { phase }: { phase: string }) {
    phases.push(phase);
    if (phase === 'generation' && rejectGeneration) throw new Error('synthetic provider failure');
    const text = phase === 'final_submission' ? JSON.stringify(aiNames) : phase.endsWith('extraction') ? '[]' : reply;
    return { text, model: 'synthetic-luna-model', usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const options = {
    seed, strategy, client, runDir: null, now: () => Date.parse(at), createTrial: () => trial,
    jevResearch: {
      profile: legacyProfile, technicalTrial, generationRetryVersion: legacyGeneration,
      observer: {
        async observeAll() { return structuredClone(memo); },
        async reobserve() { assert.fail('this fixture never requests a new observation'); },
      },
      jevDecision: createMockJevDecisionClient(() => ({ action: 'accept', target: { kind: 'none' }, name: null, feature: null, observe: null })),
      localGrounding: { classifier: { async classify() { return []; } }, timeoutMs: legacyProfile.timeouts.localMs, aiPublicClaims: true },
      ledger: new RunBudget(limits),
    },
    scoreTrial(input: ScoreInput) {
      scores++;
      assert.deepEqual(input.key, trial.key);
      return scoreTrial(input);
    },
    onPersist(record: SavedTrial) { saved = structuredClone(record); },
  } satisfies Parameters<typeof createNamingTaskV2>[0];
  return { options, phases, scoreCalls: () => scores, record() { assert.ok(saved); return saved; } };
}

test('frozen v16 trial restores before submission and preserves its completed score on a second restore', async () => {
  const started = legacyOptions('bypass-enabled');
  const task = await createNamingTaskV2(started.options);
  task.message('どんな形が見えますか？', 'pilot012-old');
  await task.whenIdle();
  const before = task.getState();
  const saved = started.record();
  assert.equal(saved.options.generationRetryVersion, legacyGeneration);
  assert.equal(saved.options.interventionPolicy.version, 'bypass_acceptance_v2');
  assert.equal(saved.jevTraces.at(-1)?.status, 'committed');
  const continued = legacyOptions('bypass-enabled');
  const restored = await createNamingTaskV2({ ...continued.options, restore: saved });
  assert.deepEqual(restored.getState().events, before.events);
  assert.deepEqual(continued.phases, []);
  await restored.submitHuman({ names: humanNames });
  await restored.submitAI();
  assert.equal(continued.scoreCalls(), 1);
  const completed = continued.record();
  assert.equal(completed.scoring?.result.matchedCount, 1);
  assert.equal(completed.scoring?.result.total, 6);
  assert.equal(completed.scoring?.result.success, false);

  const readOnly = legacyOptions('bypass-enabled');
  const recovered = await createNamingTaskV2({ ...readOnly.options, restore: completed });
  assert.deepEqual(readOnly.record().scoring, completed.scoring);
  assert.deepEqual(recovered.getState().result, restored.getState().result);
  assert.equal(readOnly.scoreCalls(), 0);
  assert.deepEqual(readOnly.phases, []);
});

test('frozen S4 records remain readable with their recorded intervention and replay', () => {
  const report = verifyRecords(structuredClone(normal));
  const checks = report.checks.filter(check => check.id === 'identity.intervention_policy' ||
    check.id.startsWith('intervention.trial.0.attempt.0.'));
  assert.equal(checks.length, 5);
  for (const check of checks) assert.equal(check.status, 'pass', check.id);
});

test('generation transport failure preserves the queued event and private state through restore and retry', async () => {
  const started = legacyOptions('repair-first', { rejectGeneration: true });
  const task = await createNamingTaskV2(started.options);
  const privateBefore = task.researcherView().privateState;
  const { eventId } = task.message('丸い部分について教えてください。', 'pilot012-retry');
  await task.whenIdle();
  const failed = task.getState();
  const saved = started.record();
  assert.equal(failed.aiStatus, 'error');
  assert.equal(failed.dialogueRecovery, 'retry');
  assert.equal(failed.events.at(-1)?.id, eventId);
  assert.deepEqual(saved.queueState.pendingHumanEventIds, [eventId]);
  assert.deepEqual(task.researcherView().privateState, privateBefore);
  assert.equal(saved.jevTraces.at(-1)?.status, 'error');
  assert.equal(saved.jevTraces.at(-1)?.publicSpeech, null);

  const resumed = legacyOptions('repair-first');
  const restored = await createNamingTaskV2({ ...resumed.options, restore: saved });
  assert.deepEqual(restored.getState().events, failed.events);
  assert.equal(restored.getState().aiStatus, 'error');
  assert.deepEqual(resumed.phases, []);
  await restored.retry();
  const completed = restored.getState();
  assert.deepEqual(completed.events.slice(0, -1), failed.events);
  assert.equal(completed.events.at(-1)?.text, reply);
  assert.equal(completed.aiStatus, 'idle');
  assert.deepEqual(resumed.record().queueState.pendingHumanEventIds, []);
  assert.deepEqual(resumed.record().jevTraces.map(trace => [trace.lastEventId, trace.status]),
    [[eventId, 'error'], [eventId, 'committed']]);
});

test('v17 restores the failed opening, publishes only the retried Terra output, and restores it without another generation', async () => {
  const pin = validateParticipantModelPin({ schemaVersion: 'participant_model_pin_v3',
    terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261014' });
  const assignment = 'pilot012-synthetic-opening';
  let attachedUsage: ParticipantUsageSnapshot | undefined;
  const store: ParticipantUsageStore = {
    async read() { return structuredClone(attachedUsage); },
    async update(write) { attachedUsage = write(structuredClone(attachedUsage)); return structuredClone(attachedUsage); },
  };
  const opening = 'どの形が気になりますか。そこから話しましょう。';
  let calls = 0;
  let observations = 0;
  const client = { async complete(_messages: unknown, { phase }: { phase: string }) {
    assert.equal(phase, 'generation');
    if (++calls === 1) throw new Error('synthetic provider failure before the opening');
    return { text: opening, model: pin.terraModelId };
  } };

  async function open(restore?: SavedTrial) {
    const fixture = legacyOptions('repair-first');
    const { generationRetryVersion: _legacy, ...research } = fixture.options.jevResearch;
    const ledger = await ParticipantUsageLedger.open(store, assignment, pin, restore?.jevLedger);
    const task = await createNamingTaskV2({ ...fixture.options, client, restore,
      onPersist(record: SavedTrial) {
        fixture.options.onPersist({ ...record, options: { ...record.options, participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE } });
      },
      jevResearch: { ...research, ledger, newTrialAgreeNameScopeVersion: 'jev_naming_v1',
        pinnedVersions: { generationRetryVersion: integratedGeneration, namingRestoreVersion: 'ai_name_acceptances_v1' },
        observer: { ...research.observer, async observeAll() { observations++; return structuredClone(memo); } },
      },
    });
    return { task, record: fixture.record };
  }

  const started = await open();
  assert.equal(started.task.getState().dialogueRecovery, 'retry');
  assert.deepEqual(started.task.getState().events, []);
  assert.equal(started.record().queueState.errorCode, 'ai_unavailable');
  assert.deepEqual(started.record().jevTraces, []);
  const resumed = await open(started.record());
  assert.equal(calls, 1);
  assert.equal(observations, 1);
  await resumed.task.retry();
  const events = resumed.task.getState().events;
  assert.deepEqual(events.map(({ speaker, text }) => ({ speaker, text })), [{ speaker: 'ai', text: opening }]);
  assert.equal(resumed.record().events[0]?.origin, 'generated_opening');
  assert.equal(resumed.record().options.generationRetryVersion, integratedGeneration);
  assert.equal(resumed.record().scoring, null);

  const restored = await open(resumed.record());
  assert.deepEqual(restored.task.getState().events, events);
  assert.equal(restored.task.getState().aiStatus, 'idle');
  assert.equal(calls, 2);
  assert.equal(observations, 1);
});

test('v17 stages targeted reobservation, then preserves the two strategies on identical move-on inputs', async () => {
  const feature = 'control-feature';
  const focusedResult = 'その図形には浅いくぼみがありますか？';
  const continued = 'では別の図形について話しましょう。';
  const repair = 'くぼみと細い部分のつながり方を確かめたいです。';
  const labels = ['repair-first', 'bypass-enabled'] as const;
  const attempts = [];
  for (const label of labels) {
    const state = initialState({ profile: legacyProfile, generationRetryVersion: integratedGeneration, agreeNameScopeVersion: 'jev_naming_v1' });
    const opened = await runTurn(legacyProfile, label, state, [{ seq: 1, speaker: 'human', text: 'くぼみのある方の図形を確かめたいです。' }], {
      action: 'confirm', target: 'figure_0', reobserve: true,
      speech: JSON.stringify({ checkedFeature: feature, text: focusedResult }),
      choose: (question, criteria) => question === 'feature' ? Object.keys(criteria).find(key => JSON.parse(criteria[key]).value === feature) : undefined,
    }, technicalTrial, integratedGeneration);
    assert.deepEqual(opened.trace.decisions.map(decision => decision.action), ['request_observation', 'confirm']);
    assert.deepEqual(opened.reobservations[0]?.figures.map(({ figureId }: { figureId: string }) => figureId), [OWN.ownAnchors[0].id]);
    assert.equal(opened.luna.filter(call => call.phase === 'observation_targeted').length, 1);
    assert.equal(opened.trace.executed.feature, feature);
    assert.equal(opened.speech, focusedResult);

    const branches = [];
    for (const humanLed of [true, false]) {
      const text = humanLed ? 'この話はいったん置いて別の図形に進みましょう。' : 'まだどの形を指すか確信がありません。';
      const turn = await runTurn(legacyProfile, label, opened.state, [...opened.publication.publicEvents, { seq: 3, speaker: 'human', text }], {
        action: 'move_on', target: 'none', issue: 'issue_0', prospect: 'stalled',
        actionScores: { move_on: 1, repair: 0.8, confirm: 0.2 },
        speech: humanLed || label === 'bypass-enabled' ? continued : repair,
        choose: question => question === 'human_move_on_source' ? humanLed ? 'human_request' : 'other' : undefined,
      }, technicalTrial, integratedGeneration);
      const intervention = turn.trace.intervention;
      assert.ok(intervention && typeof intervention === 'object');
      assert.equal(turn.trace.decisions.at(-1)?.action, 'move_on');
      assert.deepEqual(turn.state.ledger, opened.state.ledger);
      assert.equal(turn.trace.generationGuard.fallback, false);
      assert.equal(turn.speech, humanLed || label === 'bypass-enabled' ? continued : repair);
      if (humanLed) {
        assert.equal(intervention.reasonCode, 'human_led_move_on');
        assert.equal(turn.trace.executed.action, 'move_on');
        assert.deepEqual(intervention.humanMoveOn, { source: 'human', publicTurn: 3, openRepairTurns: [1] });
      } else {
        assert.equal(intervention.reasonCode, label === 'repair-first' ? 'vetoed_bypass_action' : 'no_intervention');
        assert.equal(turn.trace.executed.action, label === 'repair-first' ? 'repair' : 'move_on');
      }
      branches.push(turn.httpBodies.slice(0, turn.boundary.luna + turn.boundary.jev));
    }
    attempts.push(branches);
  }
  assert.deepEqual(attempts[0], attempts[1], 'before intervention both strategies send the same requests');
});

test('v17 publishes a generated repair and the human-led transition together without confirming a conflicting name', async () => {
  const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5',
    'bypass_acceptance_v2', 'jev_repair_quality_v1');
  const figure = OWN.ownAnchors[0].id;
  const priorName = '砂時計';
  const newName = '砂入れ';
  const original = `その形を「${priorName}」と呼びましょう。`;
  const proposal = `呼び名は「${newName}」にしたいです。`;
  const move = 'この名前の話はいったん置いて、別の図形に進みましょう。';
  const recovery = '呼び名はまだ揃っていないですね。';
  const transition = 'では、もう一つの図形の話に移りましょう。';
  const segment = (quote: string, name: string) => JSON.stringify([{ segmentId: 's1', quote, proposition: quote, name,
    targets: [figure], aspect: 'name', linkedIssueId: null, respondsToTurn: null }]);
  function grounding(criteria: Readonly<Record<string, string>>, candidate: string) {
    const answer = Object.keys(criteria).find(key => key.startsWith('grounded_name_') && JSON.parse(criteria[key]).name === candidate);
    assert.ok(answer, 'Jev is offered the public naming candidate');
    return answer;
  }

  for (const label of ['repair-first', 'bypass-enabled'] as const) {
    const starting = initialState({ profile, generationRetryVersion: integratedGeneration, agreeNameScopeVersion: 'jev_naming_v1' });
    const named = await runTurn(profile, label, starting, [{ seq: 1, speaker: 'human', text: original }], {
      action: 'agree', target: 'figure_0', name: priorName, referent: 'figure_0',
      speech: `ええ、「${priorName}」にしましょう。`, act: 'name_propose', extraction: segment(original, priorName),
      choose: (question, criteria) => question === 'naming_grounding' ? grounding(criteria, priorName)
        : question === 'naming_evidence' ? 'turn_1' : question === 'human_move_on_source' ? 'other' : undefined,
    }, technicalTrial, integratedGeneration);
    assert.deepEqual(named.state.ledger[figure], { status: 'agreed', name: priorName });

    let actionCalls = 0;
    const final = await runTurn(profile, label, named.state, [...named.publication.publicEvents,
      { seq: 3, speaker: 'human', text: `${proposal}${move}` }], {
      action: 'agree', target: 'figure_0', name: newName, referent: 'figure_0',
      act: 'name_propose', extraction: segment(proposal, newName),
      speech: JSON.stringify({ text: recovery, moveOn: transition }),
      choose(question, criteria) {
        if (question === 'action') return actionCalls++ === 0 ? 'agree' : 'repair';
        if (question === 'human_move_on_source') return 'human_request';
        if (question === 'naming_grounding') return grounding(criteria, newName);
        if (question === 'naming_evidence') return 'turn_3';
        if (question === 'draft_naming') return 'none';
        if (question === 'draft_human_move_on') return 'honors_request';
        if (question === 'naming_withdrawal') return 'retain';
      },
    }, technicalTrial, integratedGeneration);
    assert.equal(actionCalls, 2);
    assert.equal(final.trace.decisions.at(-1)?.action, 'agree');
    assert.equal(final.trace.executed.action, 'agree');
    assert.equal(final.trace.generatedPublication?.recovery?.reason, 'naming_conflict');
    assert.equal(final.trace.generatedPublication?.recovery?.executed.action, 'repair');
    assert.equal(final.trace.finalAction?.action, 'repair');
    assert.equal(final.trace.generatedPublication?.transition?.sourceTurn, 3);
    assert.equal(final.trace.generatedPublication?.withdrawal, null);
    assert.equal(final.trace.generationGuard.fallback, false);
    assert.equal(final.speech, `${recovery}\n${transition}`);
    assert.equal(final.trace.generatedPublication?.textSha256, createHash('sha256').update(final.speech!).digest('hex'));
    assert.deepEqual(final.state.ledger, named.state.ledger);
  }
});
