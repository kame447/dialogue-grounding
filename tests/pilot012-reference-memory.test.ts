import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionForStrategy } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { createMockJevDecisionClient } from '../dialogue-model/runtime/decision/mocks.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { LocalClaimFields, LocalFunctionVerdict, LocalSegmentProposal, PublicTurn } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { buildReferenceEvidence, validReferenceEvidence } from '../dialogue-model/runtime/local-grounding/reference-evidence.ts';
import { verifyLocalUpdate } from '../dialogue-model/runtime/local-grounding/verify.ts';
import { applyReferenceUpdate, CLAIM_PRUNE_V2, CLAIM_PRUNE_V3, createReferenceGraph, REFERENCE_LIMITS } from '../dialogue-model/runtime/memory/reference-graph.mjs';
import type { MemoryPruneVersion } from '../dialogue-model/runtime/memory/reference-graph.mjs';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { initialState, normal, OWN } from './support/s4-v3-records.ts';

const slots: string[] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const [questionSlot, otherSlot] = slots;
type Graph = ReturnType<typeof createReferenceGraph>;
type Claim = LocalClaimFields & { kind: 'claim'; id: string };

function claim(turn: number, key: string, fields: Partial<LocalClaimFields> = {}): Claim {
  const id = `${turn}:${key}`;
  return { kind: 'claim', id, issueId: id, targets: [otherSlot], aspect: 'part', act: 'assert', proposition: '切れ込みがある',
    name: null, speaker: 'human', sourceTurn: turn, quote: '切れ込みがあります。', respondsTo: null, source: 'partner_statement', ...fields };
}

function apply(graph: Graph, turn: number, claims: Claim[]) {
  const texts = new Map<string, PublicTurn>();
  for (const row of claims) {
    const key = `${row.sourceTurn}:${row.speaker}`;
    const prior = texts.get(key)?.text;
    texts.set(key, { turn: row.sourceTurn, speaker: row.speaker, text: prior ? `${prior}\n${row.quote}` : row.quote });
  }
  return applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations: claims },
    { publicTurns: [...texts.values()], generationSucceeded: true });
}

test('bounded graph keeps an older naming source and unanswered question under claim pressure', () => {
  const question = claim(1, 'question', { act: 'ask', targets: [questionSlot], quote: '丸い穴はどこにありますか？' });
  const proposal = claim(2, 'proposal', { act: 'name_propose', targets: [questionSlot], aspect: 'name', name: '木靴', quote: '木靴と呼びましょう。' });
  function fill(memoryPruneVersion: MemoryPruneVersion) {
    let graph = createReferenceGraph({ slots, memoryPruneVersion });
    graph = apply(graph, 1, [question]);
    graph = apply(graph, 2, [proposal]);
    for (let i = 0; i < 11; i++) {
      const turn = graph.lastTurn + 1;
      graph = apply(graph, turn, Array.from({ length: 16 }, (_, j) => claim(turn, `fill${j}`)));
    }
    return graph;
  }
  const old = fill(CLAIM_PRUNE_V2);
  const graph = fill(CLAIM_PRUNE_V3);
  assert.equal(old.records.some(row => row.id === question.id), false);
  assert.ok(graph.records.length <= REFERENCE_LIMITS.records);
  assert.ok(graph.records.some(row => row.id === question.id));
  const turns = [question, proposal].map(row => ({ turn: row.sourceTurn, speaker: row.speaker, text: row.quote }));
  const evidence = buildReferenceEvidence(JSON.parse(JSON.stringify(graph)), turns, graph.lastTurn, null);
  assert.deepEqual(evidence.history.map(row => row.sourceTurn).sort(), [1, 2]);
  assert.equal(validReferenceEvidence(evidence, slots, graph.lastTurn, turns), true);
  assert.equal(validReferenceEvidence(evidence, slots, graph.lastTurn, turns.slice(1)), false);
});

test('a rejected target correction retains the candidate supplied by the human for the next turn', () => {
  const question = claim(1, 'ask', { speaker: 'ai', source: 'ai_hypothesis', act: 'ask', targets: [questionSlot], quote: 'この形は丸い穴がありますか？' });
  const quote = '違います。別の形について話しています。';
  const turns: PublicTurn[] = [{ turn: 1, speaker: 'ai', text: question.quote }, { turn: 2, speaker: 'human', text: quote }];
  const segments: LocalSegmentProposal[] = [{ segmentId: 's1', quote, targets: [otherSlot], aspect: 'part', proposition: quote,
    name: null, linkedIssueId: null, respondsToTurn: 1 }];
  const verdicts: LocalFunctionVerdict[] = [{ segmentId: 's1', act: 'deny', respondsToClaimId: question.id, rawScore: null }];
  function verify(memoryPruneVersion: MemoryPruneVersion) {
    const graph = apply(createReferenceGraph({ slots, memoryPruneVersion }), 1, [question]);
    return { graph, result: verifyLocalUpdate({ graph, turn: 2, publicTurns: turns, segments, verdicts, bindDirectQuestionReplies: true }) };
  }
  assert.deepEqual(verify(CLAIM_PRUNE_V2).result.operations[0].targets, [questionSlot]);
  const { graph, result } = verify(CLAIM_PRUNE_V3);
  assert.deepEqual(result.operations, []);
  const local = { extractor: { segments }, classifier: { status: 'ok', verdicts }, verification: { rejected: result.rejected } };
  const evidence = buildReferenceEvidence(graph, turns, 2, local);
  assert.deepEqual(evidence.localAlternatives, [{ sourceTurn: 2, quote, targets: [otherSlot], aspect: 'part', act: 'deny', reason: 'inconsistent_claim_response' }]);
  assert.equal(validReferenceEvidence(evidence, slots, 2, turns), true);
  assert.deepEqual(buildReferenceEvidence(graph, turns, 10, null, evidence.localAlternatives).localAlternatives, evidence.localAlternatives);
});

test('a restored v15 turn with new memory keeps a genuine unresolved source and rejects an altered quote', async () => {
  const version = 'jev_generation_retry_v15';
  const profile = researchTrialProfileV3(normal.run.manifest.lunaRequest, normal.run.manifest.timeouts, 'two_stage_v3', 'holistic_v5');
  const state = initialState({ profile, agreeNameScopeVersion: 'jev_naming_v1', generationRetryVersion: version });
  state.graph = createReferenceGraph({ slots, memoryPruneVersion: CLAIM_PRUNE_V3 });
  const quote = '木靴に決めます。';
  const response = '呼び名の案は受け取りました。';
  const extraction = JSON.stringify([{ segmentId: 's1', quote, targets: [otherSlot], aspect: 'name', proposition: quote, name: '木靴',
    linkedIssueId: null, respondsToTurn: null }]);
  const runtime = createProfileDialogue(profile, {
    client: { async complete(_messages: unknown, { phase }: { phase: string }) {
      return { text: phase === 'local_extraction' ? extraction : phase === 'ai_extraction' ? '[]' : response, model: 'synthetic-luna-model' };
    } },
    image: OWN.ownImage, anchors: OWN.ownAnchors, strategy: 'repair-first', memoryPruneVersion: CLAIM_PRUNE_V3,
    generationRetryVersion: version, newTrialAgreeNameScopeVersion: 'jev_naming_v1',
    observer: { async observeAll() { return structuredClone(state.observationMemo); }, async reobserve() { assert.fail(); } },
    jevDecision: createMockJevDecisionClient(() => ({ action: 'accept', target: { kind: 'single', figureId: otherSlot }, name: null, feature: null, observe: null })),
    localGrounding: { classifier: { async classify(): Promise<LocalFunctionVerdict[]> {
      return [{ segmentId: 's1', act: 'name_accept', respondsToClaimId: null, rawScore: null }];
    } } },
  } as Parameters<typeof createProfileDialogue>[1]);
  const event = { id: 'event-1', seq: 1, speaker: 'human' as const, text: quote };
  const published = await runtime.runAiTurn({ events: [event], privateState: state, lastEventId: event.id, requestSeq: 1 });
  const saved = structuredClone(published.privateState);
  const restore = (input: unknown) => validateJevPrivateStateV2(input, slots, interventionForStrategy('repair-first'),
    'two_stage_v3', 'holistic_v5', version, undefined, [event]);
  assert.deepEqual(saved.ledger, state.ledger);
  assert.equal(restore(saved).referenceAlternatives?.[0]?.quote, quote);
  saved.referenceAlternatives[0].quote = '実際の発話にはなかった引用';
  assert.throws(() => restore(saved), { code: 'invalid_state' });
});
