import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJevDecisionDetailPayload, buildJevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { createOwnLedger } from '../dialogue-model/runtime/judgment/schema.mjs';
import type { LocalClaimView, PublicTurn } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { priorClaimViews } from '../dialogue-model/runtime/local-grounding/derive.ts';
import { buildReferenceEvidence } from '../dialogue-model/runtime/local-grounding/reference-evidence.ts';
import type { ReferenceEvidence } from '../dialogue-model/runtime/local-grounding/reference-evidence.ts';
import { applyReferenceUpdate, createReferenceGraph } from '../dialogue-model/runtime/memory/reference-graph.mjs';

const slots = ['s-1000', 's-1001', 's-1002', 's-1003', 's-1004', 's-1005'];
const options = { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' } as const;
const name = '呼び鈴';
const firstQuote = `丸いつまみの形を「${name}」と呼びたいです。`;
const checked = '丸いつまみがある';
const distinguishing = '細い台にしずく形が接する';
const roundQuestion = 'その形には丸いつまみがありますか？';
const otherQuestion = '細長い方には小さな穴もありますか？';
const correction = 'いま見ているのはそれとは別の図形です。';
const askTurn = 54;

function claim(turn: number, segment: string, quote: string, fields: Partial<LocalClaimView>): LocalClaimView {
  const id = `${turn}:${segment}`;
  return { id, issueId: id, turn, sourceTurn: turn, quote, proposition: quote, targets: [slots[0]],
    speaker: 'human', source: 'partner_statement', act: 'ask', aspect: 'part', name: null, respondsTo: null, ...fields };
}

function material() {
  const publicTurns: PublicTurn[] = [
    { turn: 1, speaker: 'human', text: firstQuote },
    ...Array.from({ length: 49 }, (_, index): PublicTurn => ({ turn: index + 2, speaker: index % 2 ? 'human' : 'ai',
      text: `別の論点 ${index + 2}。` + 'この説明は記憶の送信上限を確かめる架空の履歴です。'.repeat(27) })),
    { turn: 51, speaker: 'ai', text: '丸いつまみの形ですか？' },
    { turn: 52, speaker: 'human', text: 'そうなんですね。' },
    { turn: 53, speaker: 'human', text: 'なるほど。' },
    { turn: askTurn, speaker: 'human', text: `${roundQuestion}${otherQuestion}${correction}` },
  ];
  const proposed = claim(1, 'name', firstQuote, { act: 'name_propose', aspect: 'name', name });
  const acks = [claim(52, 'ack', publicTurns[51].text, { act: 'acknowledge', aspect: 'progress', targets: [] }),
    claim(53, 'ack', publicTurns[52].text, { act: 'acknowledge', aspect: 'progress', targets: [] })];
  const asks = [claim(askTurn, 'round', roundQuestion, {}), claim(askTurn, 'opening', otherQuestion, { targets: [slots[1]] })];
  let graph = createReferenceGraph({ slots, memoryPruneVersion: 'claim_prune_v3' });
  for (const claims of [[proposed], [acks[0]], [acks[1]], asks]) {
    const turn = claims[0].turn;
    const sources = publicTurns.filter(event => event.turn === turn);
    graph = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn,
      operations: claims.map(({ turn: _turn, ...row }) => ({ kind: 'claim', ...row })) },
    { publicTurns: sources, generationSucceeded: true });
  }
  const referenceEvidence = buildReferenceEvidence(graph, publicTurns, askTurn, {
    extractor: { segments: [{ segmentId: 'correction', quote: correction, targets: [slots[1]],
      aspect: 'referent', proposition: correction, name: null, linkedIssueId: null, respondsToTurn: null }] },
    classifier: { status: 'ok', verdicts: [{ segmentId: 'correction', act: 'deny' }] },
    verification: { rejected: [{ segmentId: 'correction', reason: 'missing_claim_response' }] },
  });
  const input: JevDecisionInput = {
    ownSlots: slots, turn: askTurn, publicTurns, priorClaims: priorClaimViews(graph, { limit: 16 }),
    observations: { observedAt: '2000-01-01T00:00:00Z', figures: slots.map((id, index) => ({
      id, region: { x: index * 10, y: 0, w: 9, h: 9 },
      holistic: index === 1 ? [{ construal: '砂時計', basis: [distinguishing], status: 'hypothesis' }] : [],
      analytic: { shapes: index === 0 ? [checked, distinguishing] : [checked], composition: '', relations: [] },
      unknowns: [], reobservations: [],
    })) },
    issueSummary: '', previousAction: null, judgmentLedger: [], p5Enabled: true, nameSource: 'public_only',
    agreeNames: [{ name, figureId: slots[0], sourceTurn: 1 }], nameLedger: createOwnLedger(slots), publicNames: [],
    repairHistory: [{ turn: 50, action: 'confirm', issueId: null, question: checked,
      candidatesBefore: [slots[0]], candidatesAfter: [slots[0]], progress: 'unchanged',
      partnerClaims: acks.map(({ id, act, proposition, targets }) => ({ id, act, proposition, targets })),
      addedClaimIds: [], removedClaimIds: [] }],
  };
  return { input, referenceEvidence, proposed, acks, asks };
}

type WireState = {
  referenceEvidence?: ReferenceEvidence;
  publicTurns: string[];
  namingEvidence?: { names: JevDecisionInput['agreeNames'] };
  repairQuality?: { questions: string[]; acknowledgements: string[];
    checks: { turn: number; support: string[]; objections: string[]; progress: string }[] };
  inputBudget: { omitted: { publicTurns: number } };
};

test('compact v17 judgment preserves a public name, separate questions and a rejected correction without forcing an action', () => {
  const { input, referenceEvidence, proposed, acks, asks } = material();
  const old = buildJevDecisionPayload(input, options);
  const oldState: WireState = JSON.parse(old.state);
  assert.ok(oldState.inputBudget.omitted.publicTurns > 0);
  assert.equal(oldState.referenceEvidence, undefined);
  assert.equal(oldState.repairQuality, undefined);
  assert.equal(Object.hasOwn(old.questions.action.criteria, 'agree'), false);

  const unboundNames = [{ name, figureId: null, sourceTurn: 1 }];
  const next = { ...input, judgmentMaterialVersion: 'jev_repair_quality_v1', referenceEvidence,
    agreeNames: unboundNames, jevNaming: { localRejections: [] } } satisfies JevDecisionInput;
  const action = buildJevDecisionPayload(next, options);
  const state: WireState = JSON.parse(action.state);
  assert.ok(state.inputBudget.omitted.publicTurns > 0);
  assert.ok(action.state.length <= 20_000);
  assert.equal(state.publicTurns.some(line => line.startsWith('U1 ')), false);
  assert.deepEqual(state.namingEvidence?.names, unboundNames);
  assert.ok(Object.hasOwn(action.questions.action.criteria, 'accept'));
  assert.ok(Object.hasOwn(action.questions.action.criteria, 'agree'));
  assert.ok(Object.hasOwn(action.questions.action.criteria, 'propose_name'));
  assert.ok(state.referenceEvidence?.history.some(row => row.claimId === proposed.id && row.quote === firstQuote && row.sourceTurn === 1));
  assert.deepEqual(state.referenceEvidence?.localAlternatives, [{ sourceTurn: askTurn, quote: correction,
    targets: [slots[1]], act: 'deny', aspect: 'referent', reason: 'missing_claim_response' }]);
  assert.deepEqual(state.repairQuality?.questions, asks.map(row => row.id));
  assert.deepEqual(state.repairQuality?.acknowledgements, acks.map(row => row.id));
  assert.deepEqual(state.repairQuality?.checks, [{ turn: 50, support: [], objections: [], progress: 'unchanged' }]);

  for (const action of ['confirm', 'repair'] as const) {
    const detail = buildJevDecisionDetailPayload(next, { action, target: { kind: 'single', figureId: slots[0] } }, options);
    assert.ok(detail);
    const candidates = Object.values(detail.questions.feature.criteria).map(value => JSON.parse(value).value);
    assert.ok(candidates.includes(checked));
    assert.ok(candidates.includes(distinguishing));
  }
  const agree = buildJevDecisionDetailPayload(next, { action: 'agree', target: { kind: 'single', figureId: slots[0] } }, options);
  assert.ok(agree);
  assert.deepEqual(Object.values(agree.questions.name.criteria).map(value => JSON.parse(value).value), [name]);
});
