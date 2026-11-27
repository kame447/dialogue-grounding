import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockJevDecisionClient } from '../dialogue-model/runtime/decision/mocks.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { scoreTrial } from '../dialogue-model/runtime/scoring.mjs';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { LocalOwnAnchor } from '../dialogue-model/runtime/local-grounding/contract.ts';
import type { ObservationMemo } from '../dialogue-model/runtime/observation/contract.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { normal } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const seed = 12012;
const trial = createTrialV2({ seed });
const ownAnchors: readonly LocalOwnAnchor[] = modelView(trial).anchors;
const { lunaRequest, timeouts } = normal.run.manifest;
const legacyProfile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5', 'bypass_acceptance_v2');
const legacyGeneration = 'jev_generation_retry_v16';
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
  options: { generationRetryVersion: string; interventionPolicy: typeof legacyProfile.interventionPolicy };
  queueState: { pendingHumanEventIds: string[]; errorCode: string | null };
  jevTraces: JevTurnTrace[];
  scoring: ScoreRecord | null;
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
