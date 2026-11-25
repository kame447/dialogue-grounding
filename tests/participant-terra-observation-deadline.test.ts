// The first Terra observation of a participant start may take longer than the 20 s research-harness default. Synthetic only; no model call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createWorkerParticipantRuntime } from '../workers/tangram-experiment/src/participant-runtime.ts';
import { ParticipantUsageLedger } from '../dialogue-model/runtime/web/participant-usage.ts';
import { RESEARCH_MAX_LUNA_ATTEMPT_MS } from '../dialogue-model/runtime/v2/research-timeouts.ts';

const pin = { schemaVersion: 'participant_model_pin_v1', terraModelId: 'gpt-6.1-terra', lunaModelId: 'gpt-6-luna', jevModelId: 'typesafe/jev-1.14-20261014' } as const;

test('the participant observation deadline does not undercut the proxy upstream deadline', async () => {
  const model = modelView(createTrialV2({ seed: 909 }));
  let stored: any;
  const store = { async read() { return stored; }, async update(write: any) { stored = structuredClone(write(stored)); return structuredClone(stored); } };
  const usage = await ParticipantUsageLedger.open(store as any, 'aid-1', pin as any);
  const unused = async () => ({ status: 500, data: {} });
  const proxy: any = { participantPolicy: async () => pin, participantChat: unused, participantChoices: unused, participantUsagePolicy: async () => pin,
    participantUsageChat: unused, participantUsageChoices: unused };
  const runtime: any = createWorkerParticipantRuntime({ pin: pin as any, usage, own: { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors },
    proxy, cache: { read: async () => undefined, putIfAbsent: async (_key: string, entry: unknown) => entry } });
  // The research proxy aborts its upstream call at 85 s (RESEARCH_MAX_LUNA_ATTEMPT_MS); a 20 s client deadline failed the start while Terra was still answering.
  assert.ok(runtime.jevResearch.profile.timeouts.observationMs >= RESEARCH_MAX_LUNA_ATTEMPT_MS, String(runtime.jevResearch.profile.timeouts.observationMs));
});

test('the participant local-grounding deadline is the E2E-validated 45 s, and the decision and generation deadlines are unchanged', async () => {
  const model = modelView(createTrialV2({ seed: 909 }));
  let stored: any;
  const store = { async read() { return stored; }, async update(write: any) { stored = structuredClone(write(stored)); return structuredClone(stored); } };
  const usage = await ParticipantUsageLedger.open(store as any, 'aid-2', pin as any);
  const unused = async () => ({ status: 500, data: {} });
  const proxy: any = { participantPolicy: async () => pin, participantChat: unused, participantChoices: unused, participantUsagePolicy: async () => pin,
    participantUsageChat: unused, participantUsageChoices: unused };
  const runtime: any = createWorkerParticipantRuntime({ pin: pin as any, usage, own: { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors },
    proxy, cache: { read: async () => undefined, putIfAbsent: async (_key: string, entry: unknown) => entry } });
  const timeouts = runtime.jevResearch.profile.timeouts;
  assert.equal(timeouts.localMs, 45000);
  assert.equal(runtime.jevResearch.localGrounding.timeoutMs, 45000);
  assert.deepEqual([timeouts.decisionMs, timeouts.generationMs], [15000, 40000]);
});
