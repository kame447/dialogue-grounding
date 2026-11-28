// Audit 13 item 4: the stimulus mode the task was created (or restored) with reaches the v5 judgment request. Synthetic clients only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createMockJevDecisionClient } from '../dialogue-model/runtime/decision/mocks.ts';
import { buildJevDecisionPayload, ROTATION_V5, ROTATION_V5_90_180_270 } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';

const seed = 909;
const timeouts = { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 };
const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: 1000 }, timeouts, 'two_stage_v3');
const limits = { lunaCalls: 100, lunaPosts: 100, lunaTokens: 100000, jevPosts: 100, jevUsd: 10 };
const strategies = ['repair-first', 'bypass-enabled'] as const;
const modes = ['relative_0', 'relative_pm90', 'relative_90_180_270'] as const;

function setup(rotationMode: string | undefined, strategy: string, extra: any = {}) {
  const trial = createTrialV2({ seed, ...(rotationMode ? { rotationMode } : {}) }), own = modelView(trial);
  const memo = { observedAt: '2026-10-20T00:00:00.000Z', figures: own.anchors.map((a: any) => ({ id: a.id, region: a.bbox,
    holistic: [], analytic: { shapes: ['三角'], composition: '二つの部分が接する', relations: [] }, unknowns: [], reobservations: [] })) };
  const seen: (string | undefined)[] = [];
  const inputs: any[] = [];
  let saved: any;
  const client = { async complete(_m: any, o: any = {}) {
    return { text: o.phase === 'local_extraction' || o.phase === 'ai_extraction' ? '[]' : 'なるほど。', model: 'synthetic-luna' }; } };
  const jevResearch = { profile, technicalTrial: { version: 'adaptive_repair_v3' },
    observer: { async observeAll() { return structuredClone(memo); }, async reobserve() { throw Error('unused'); } },
    jevDecision: createMockJevDecisionClient((input: any) => { seen.push(input.rotationMode); inputs.push(input);
      return { action: 'accept', target: { kind: 'none' }, name: null, feature: null, observe: null }; }),
    localGrounding: { classifier: { async classify() { return []; } }, timeoutMs: profile.timeouts.localMs, aiPublicClaims: true },
    ledger: new RunBudget(limits) };
  const options = { client, strategy, seed, referenceMemory: true, runDir: null, createTrial: () => trial,
    judge: { async judge() { return { action: 'accept', targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }; } },
    jevResearch, onPersist: async (r: any) => { saved = structuredClone(r); }, ...(rotationMode ? { rotationMode } : {}), ...extra };
  return { options, seen, inputs, record: () => saved };
}

for (const strategy of strategies) for (const mode of modes) {
  test(`${strategy} ${mode}: a new task and its restore give the judgment the stimulus mode`, async () => {
    const h = setup(mode, strategy);
    const task = await createNamingTaskV2(h.options);
    task.message('この形を確認します', 'one'); await task.whenIdle();
    assert.ok(h.seen.length > 0);
    assert.ok(h.seen.every(m => m === mode), JSON.stringify(h.seen));
    const saved = h.record();
    assert.equal(saved.options.rotationMode, mode);
    const r = setup(mode, strategy);
    const restored = await createNamingTaskV2({ ...r.options, rotationMode: undefined, restore: saved });
    restored.message('もう一度確認します', 'two'); await restored.whenIdle();
    assert.ok(r.seen.length > 0);
    assert.ok(r.seen.every(m => m === mode), JSON.stringify(r.seen));
  });
}

// #269: the sentence the judgment is given follows the task's mode, after a cold restore too.
for (const strategy of strategies) {
  test(`${strategy} relative_90_180_270: the judgment requests of a new task and of its cold restore carry the new sentence and not the ±90 one`, async () => {
    const sentences = (inputs: any[]) => inputs.flatMap(input => Object.values<any>(buildJevDecisionPayload(input,
      { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' }).questions).map(q => q.instructions as string));
    const count = (text: string, part: string) => text.split(part).length - 1;
    const h = setup('relative_90_180_270', strategy);
    const task = await createNamingTaskV2(h.options);
    task.message('この形を確認します', 'one'); await task.whenIdle();
    const r = setup('relative_90_180_270', strategy);
    const restored = await createNamingTaskV2({ ...r.options, rotationMode: undefined, restore: h.record() });
    restored.message('もう一度確認します', 'two'); await restored.whenIdle();
    for (const [label, inputs] of [['new', h.inputs], ['restored', r.inputs]] as const) {
      const texts = sentences(inputs);
      assert.ok(texts.length > 0, label);
      for (const text of texts) {
        assert.equal(count(text, ROTATION_V5_90_180_270), 1, label);
        assert.equal(count(text, ROTATION_V5), 0, label);
      }
    }
  });
}

test('the default mode stays relative_pm90 and a mismatching restore is still refused', async () => {
  const h = setup(undefined, 'repair-first');
  const task = await createNamingTaskV2(h.options);
  task.message('この形を確認します', 'one'); await task.whenIdle();
  assert.ok(h.seen.every(m => m === 'relative_pm90'));
  const saved = h.record();
  const other = setup('relative_0', 'repair-first');
  await assert.rejects(createNamingTaskV2({ ...other.options, restore: saved }), { code: 'invalid_options' });
});
