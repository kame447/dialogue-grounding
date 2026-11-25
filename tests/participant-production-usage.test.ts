import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantUsageLedger, type ParticipantUsageSnapshot } from '../dialogue-model/runtime/web/participant-usage.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';

const pin = validateParticipantModelPin({
  schemaVersion: 'participant_model_pin_v1', terraModelId: 'gpt-6.1-terra-2026-11-01',
  lunaModelId: 'gpt-6-luna-2026-10-01', jevModelId: 'typesafe/jev-1.14-20261014',
});
function memory() {
  let saved: ParticipantUsageSnapshot | undefined;
  return {
    async read() { return structuredClone(saved); },
    async update(write: (saved: unknown) => ParticipantUsageSnapshot) {
      saved = structuredClone(write(saved));
      return structuredClone(saved);
    },
  };
}

test('production meters more than the old trial send ceiling for every provider', async () => {
  const store = memory();
  const ledger = await ParticipantUsageLedger.open(store, 'synthetic-assignment', pin);
  const prior = ledger.snapshot();
  const answer = async (_: unknown, model: string) => ({ status: 200, data: {
    model, usage: { cost: 0.1, prompt_tokens: 50_000, completion_tokens: 10 },
  } });
  for (let i = 0; i < 72; i++) {
    await ledger.logical('luna', 'generation', () => ledger.dispatch('luna', answer, {}));
    await ledger.logical('terra', 'reobservation', () => ledger.dispatch('terra', answer, {}));
    await ledger.dispatch('jev', answer, { questions: { action: {} } });
  }
  const restored = await ParticipantUsageLedger.open(store, 'synthetic-assignment', pin, prior);
  for (const meter of [restored.snapshot().phases.jev.action_target, restored.snapshot().phases.luna.generation,
    restored.snapshot().phases.terra.reobservation]) {
    assert.equal(meter.calls, 72);
    assert.equal(meter.posts, 72);
    assert.equal(meter.missingCostPosts, 0);
    assert.equal(meter.unknownPosts, 0);
    assert.ok(meter.knownUsd > 7);
    assert.equal(meter.inputTokens, 3_600_000);
  }
  assert.equal(restored.halted, false);
});

test('missing cost is distinct from failed POST and an already-aborted call sends nothing', async () => {
  const store = memory();
  const ledger = await ParticipantUsageLedger.open(store, 'synthetic-assignment', pin);
  const body = { questions: { action: {} } };
  let posts = 0;
  const mock = async (_: unknown, model: string) => {
    posts++;
    return posts === 1 ? { status: 429, data: { error: 'upstream_error' } }
      : { status: 200, data: { model, usage: { cost: null, prompt_tokens: 14, completion_tokens: 3 } } };
  };
  const aborted = AbortSignal.abort();
  await assert.rejects(ledger.runTurn('event-2', aborted, () => ledger.dispatch('jev', mock, body)), { name: 'AbortError' });
  assert.equal(posts, 0);
  assert.equal(ledger.needsExplicitRetry('event-2'), false);
  assert.equal((await ledger.dispatch('jev', mock, body)).status, 429);
  assert.equal((await ledger.dispatch('jev', mock, body)).status, 200);
  const view = ledger.snapshot();
  assert.deepEqual(view.latest.jev, { post: 2, phase: 'action_target', status: 'ok', model: pin.jevModelId,
    costUsd: null, inputTokens: 14, outputTokens: 3 });
  assert.equal(view.phases.jev.action_target.missingCostPosts, 2);
  assert.equal(view.phases.jev.action_target.unknownPosts, 1);
  assert.equal(view.phases.jev.action_target.knownUsd, 0);
  assert.equal(view.halted, false);
});

test('402, 429 and timeout remain unobserved while a verified rejected reply settles once', async () => {
  const store = memory();
  const ledger = await ParticipantUsageLedger.open(store, 'synthetic-assignment', pin);
  const body = { questions: { action: {} } };
  const verifiedUsage = { model: pin.jevModelId, costUsd: 0.012, inputTokens: 18, outputTokens: 5 };
  for (const status of [402, 429, 504, 502]) {
    const result = await ledger.dispatch('jev', async () => ({
      status, data: { error: 'upstream_error', usage: { cost: 99 } },
      ...(status === 502 ? { verifiedUsage: { ...verifiedUsage, model: pin.lunaModelId } } : { verifiedUsage }),
    }), body);
    assert.equal(result.status, status);
  }
  const unobserved = ledger.snapshot().phases.jev.action_target;
  assert.deepEqual([unobserved.posts, unobserved.unknownPosts, unobserved.missingCostPosts, unobserved.knownUsd], [4, 4, 4, 0]);

  await ledger.dispatch('jev', async () => ({ status: 502, data: { error: 'invalid_upstream_response' }, verifiedUsage }), body);
  const saved = ledger.snapshot();
  const restored = await ParticipantUsageLedger.open(store, 'synthetic-assignment', pin, saved);
  const measured = restored.snapshot().phases.jev.action_target;
  assert.deepEqual([measured.posts, measured.unknownPosts, measured.missingCostPosts, measured.knownUsd,
    measured.inputTokens, measured.outputTokens], [5, 4, 4, 0.012, 18, 5]);
  assert.equal(restored.snapshot().latest.jev?.model, pin.jevModelId);
  assert.equal(restored.halted, false);
});
