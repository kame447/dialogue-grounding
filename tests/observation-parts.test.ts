import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLayoutsV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createPartGeometry } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import {
  buildObservationMessages, buildReobservationMessages, mergeReobservation, parseInitialObservation,
  parseReobservation, snapshotObservationInput, validateObservationMemo,
} from '../dialogue-model/runtime/observation/observe.ts';
import { PART_OBSERVATION_INSTRUCTIONS } from '../dialogue-model/runtime/observation/parts.ts';
import type { ObservationInput, ObservationMemo } from '../dialogue-model/runtime/observation/contract.ts';
import { createObservationCache, createObservationCacheKey, observationCacheFileName } from '../dialogue-model/runtime/observation/cache.ts';
import { createWorkerTerraObserver, workerTerraInitialKey } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import type { WorkerTerraCache } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from '../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { initialObservationFormatForMessages } from '../workers/research-ai-proxy/src/initial-observation-format.ts';

const time = '2026-11-28T00:00:00.000Z';
function ownInput(count = 4): ObservationInput {
  const { ai } = createLayoutsV2({ seed: 41,
    ...(count === 4 ? { figureSelection: { mode: 'preset', setId: 'pilot-four-v1' } } : {}),
  });
  return {
    ownImage: { mimeType: 'image/png', base64: Buffer.from('synthetic-own-parts-board').toString('base64') },
    ownAnchors: ai.map((a: any) => ({ id: a.id, bbox: a.bbox, centroid: a.centroid })),
    ownParts: ai.map((a: any) => ({ id: a.id, parts: createPartGeometry(a.polygons) })),
  };
}
function response(own: ObservationInput) {
  return { figures: own.ownAnchors.map(({ id }) => ({
    id, holistic: [], analytic: { shapes: [], composition: 'つながる部分を持つ図形', relations: [] }, unknowns: [],
  })) };
}
const rawMemo = (own: ObservationInput) => parseInitialObservation(JSON.stringify(response(own)), own, { observedAt: time });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pin = validateParticipantModelPin({
  schemaVersion: 'participant_model_pin_v1',
  terraModelId: 'gpt-6.1-terra-2026-11-01',
  lunaModelId: 'gpt-6-luna-2026-10-01',
  jevModelId: 'typesafe/jev-1.14-20261001',
});
function memory() {
  const entries = new Map<string, any>();
  const cache: WorkerTerraCache = {
    async read(key) { return structuredClone(entries.get(key)); },
    async putIfAbsent(key, value) {
      if (!entries.has(key)) entries.set(key, structuredClone(value));
      return structuredClone(entries.get(key));
    },
  };
  return { entries, cache };
}

test('all geometry-derived parts are program-owned, persisted and detached for four and six figures', () => {
  for (const count of [4, 6]) {
    const own = ownInput(count), memo = rawMemo(own);
    assert.equal(memo.figures.length, count);
    for (const row of own.ownParts!) {
      const figure = memo.figures.find(figure => figure.id === row.id)!;
      assert.deepEqual(figure.parts, row.parts);
      assert.equal(figure.parts!.parts.filter(part => part.members.length === 1).length, 7);
      assert.ok(figure.parts!.parts.some(part => part.members.length === 7));
    }
    assert.deepEqual(validateObservationMemo(JSON.parse(JSON.stringify(memo)), own), memo);
    memo.figures[0].parts!.parts[0].members[0] = 99;
    assert.notEqual(own.ownParts![0].parts.parts[0].members[0], 99);
  }
});

test('legacy first messages stay identical and strict structured-output schemas still accept parts context', () => {
  const own = ownInput(), { ownParts: _parts, ...legacy } = own;
  const messages = buildObservationMessages(own), previous = buildObservationMessages(legacy);
  assert.deepEqual(messages.slice(0, 2), previous.slice(0, 2));
  assert.ok(initialObservationFormatForMessages(messages));
  assert.equal(messages[2].content, PART_OBSERVATION_INSTRUCTIONS);
  const chunks = messages.slice(3).filter(message => typeof message.content === 'string');
  const context = chunks.map(message => String(message.content).replace(/^同じJSON文脈の続き[^\n]*\n/u, '')).join('');
  assert.deepEqual(JSON.parse(context), { ownParts: own.ownParts });
  assert.ok(messages.every(message => typeof message.content !== 'string' || message.content.length <= 20000));
  assert.doesNotMatch(JSON.stringify(messages), /figureId|answerKey|partnerImage/);
  assert.match(PART_OBSERVATION_INSTRUCTIONS, /五角形/);
  assert.match(PART_OBSERVATION_INSTRUCTIONS, /切り分けは仮説/);
  assert.ok(rawMemo(legacy).figures.every(figure => !Object.hasOwn(figure, 'parts')));
});

test('unknown fields, mismatched geometry, omissions and model-authored parts fail closed', () => {
  const own = ownInput(), original = rawMemo(own);
  const mutations: Array<(input: any) => void> = [
    input => { input.ownParts[0].key = 'ANSWER_CANARY'; },
    input => { input.ownParts[0].parts.partnerImage = 'PARTNER_CANARY'; },
    input => { input.ownParts[0].id = 'other-side-id'; },
    input => { input.ownParts[0].id = input.ownParts[1].id; },
    input => { input.ownParts.pop(); },
    input => { input.ownParts[0].parts.origin[0]++; },
    input => { input.ownParts[0].parts.parts.pop(); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(own); mutate(changed);
    assert.throws(() => snapshotObservationInput(changed), { code: 'invalid_input' });
  }
  const forged = response(own) as any; forged.figures[0].parts = own.ownParts![0].parts;
  assert.throws(() => parseInitialObservation(JSON.stringify(forged), own, { observedAt: time }), { code: 'invalid_response' });
  const omitted = structuredClone(original); delete omitted.figures[0].parts;
  assert.throws(() => validateObservationMemo(omitted), { code: 'invalid_input' });
  const allOmitted = structuredClone(original); allOmitted.figures.forEach(figure => { delete figure.parts; });
  assert.throws(() => validateObservationMemo(allOmitted, own), { code: 'invalid_input' });
  const { ownParts: _parts, ...legacy } = own;
  assert.throws(() => validateObservationMemo(original, { ...legacy, ownParts: undefined }), { code: 'invalid_input' });
});

test('targeted observation retains every requested candidate without leaking other figures and merge preserves geometry', () => {
  const own = ownInput(), memo = rawMemo(own), id = own.ownAnchors[0].id;
  const input = { ...own, memo, figureIds: [id],
    issue: { aspect: 'part' as const, question: '五角形に見える部分はどこか', partnerConstrual: '五角形' },
  };
  const messages = buildReobservationMessages(input);
  assert.equal(messages[1].content, PART_OBSERVATION_INSTRUCTIONS);
  const text = JSON.stringify(messages);
  for (const other of own.ownAnchors.slice(1)) assert.ok(!text.includes(other.id));
  assert.ok(text.includes('edgeVisibility'));
  const result = parseReobservation(JSON.stringify({ figures: [{ figureId: id,
    supports: ['中央のまとまりを五角形として捉える候補がある'], contradicts: [], unknown: ['相手の切り分けは未確認'],
  }] }), input, { observedAt: '2026-11-28T00:01:00.000Z' });
  const merged = mergeReobservation(memo, result);
  assert.deepEqual(merged.figures.map(figure => figure.parts), memo.figures.map(figure => figure.parts));
  assert.equal(merged.figures[0].reobservations.length, 1);
});

test('node cache separates legacy inputs, preserves full candidates on HIT and canonicalizes row order', async t => {
  const own = ownInput(), { ownParts: _parts, ...legacy } = own;
  const directory = await mkdtemp(join(tmpdir(), 'part-observation-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const modelId = 'synthetic-parts-observer';
  const cache = await createObservationCache({ directory, modelId, onMiss: 'observe', client: {
    async complete() { calls++; return { text: JSON.stringify(response(own)), model: modelId }; },
  } });
  const first = await cache.get(own), second = await cache.get(own);
  assert.equal(first.audit.status, 'MISS'); assert.equal(second.audit.status, 'HIT'); assert.equal(calls, 1);
  assert.deepEqual(first.memo, second.memo);
  const key = createObservationCacheKey(own, { modelId }), oldKey = createObservationCacheKey(legacy, { modelId });
  assert.notEqual(key.anchorsHash, oldKey.anchorsHash);
  assert.notEqual(key.instructionHash, oldKey.instructionHash);
  assert.deepEqual(createObservationCacheKey({ ...own, ownParts: [...own.ownParts!].reverse(), ownAnchors: [...own.ownAnchors].reverse() }, { modelId }), key);
  const stored = JSON.parse(await readFile(join(directory, observationCacheFileName(key)), 'utf8'));
  assert.deepEqual(stored.memo.figures.map((figure: any) => figure.parts), first.memo.figures.map(figure => figure.parts));
});

test('worker cache binds complete candidates and rejects a correctly rehashed entry that drops them', async () => {
  const own = ownInput(), { ownParts: _parts, ...legacy } = own, { cache, entries } = memory();
  let calls = 0;
  const observer = createWorkerTerraObserver({ modelPin: pin, own, cache, now: () => new Date(time),
    initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2,
    async visual(payload) {
      calls++;
      assert.ok(initialObservationFormatForMessages(payload.messages, INITIAL_OBSERVATION_STRUCTURED_V2));
      return { status: 200, data: { model: pin.terraModelId, initial_observation_generation: INITIAL_OBSERVATION_STRUCTURED_V2,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response(own)) } }] } };
    },
  });
  const first = await observer.observeAll(own), second = await observer.observeAll(own);
  assert.equal(calls, 1); assert.deepEqual(first, second);
  const key = await workerTerraInitialKey(pin, own, INITIAL_OBSERVATION_STRUCTURED_V2);
  assert.notEqual(key, await workerTerraInitialKey(pin, legacy, INITIAL_OBSERVATION_STRUCTURED_V2));
  assert.equal(key, await workerTerraInitialKey(pin, { ...own, ownParts: [...own.ownParts!].reverse() }, INITIAL_OBSERVATION_STRUCTURED_V2));
  const stored = entries.get(key);
  stored.memo.figures.forEach((figure: ObservationMemo['figures'][number]) => { delete figure.parts; });
  stored.memoSha256 = hash(stored.memo);
  await assert.rejects(observer.observeAll(own), { code: 'invalid_input' });
  await assert.rejects(observer.observeAll(legacy), { code: 'invalid_input' });
  assert.equal(calls, 1);
});
