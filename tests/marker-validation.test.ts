// The naming marker of a judgment is checked against what the turn decided on, not against the graph as it stands now (audit 30: B-30A-1, B-30A-2).
// Synthetic wording only; no model call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionForStrategy } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { claimsLiveAsOf, reconfirmationPossible, traceMarkerInvalid, turnNameProposals } from '../dialogue-model/runtime/decision/naming-request.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { buildRecords, OWN } from './support/s4-v3-records.ts';
import type { Turn } from './support/s4-v3-records.ts';

const first = OWN.ownAnchors[0].id as string;
const slots = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const seg = (id: string, quote: string, aspect: string, targets: string[], name: string | null = null, respondsToTurn: number | null = null) =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn });
const outline = '折れた棒に小さな輪がついています。', question = '指しているのはこの図形でしょうか？';
const alias = '月枠', proposal = '「月枠」とかどう？';
const nameless: Turn = { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose',
  extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]), speech: '輪の形ですか？' } };
const drop: Turn = { human: 'やっぱり、その名前はやめます。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'withdraw', antecedent: 'claim_0', speech: '輪の形ですか？',
  extraction: JSON.stringify([seg('s1', 'やっぱり、その名前はやめます。', 'name', [], null, 1)]) } };
const feature = (n: number): Turn => ({ human: `輪の${n}番目の細かい特徴は、棒の側に寄っています。`, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: outline + question,
  aiActs: ['assert', 'ask'], aiExtraction: JSON.stringify([seg('s1', outline, 'part', [first]), seg('s2', question, 'question', [first])]),
  act: 'assert', extraction: JSON.stringify([seg('s1', `輪の${n}番目の細かい特徴は、棒の側に寄っています。`, 'part', [first])]) } });
const check: Turn = { human: '輪のついた形を見比べたいです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: outline + question, aiActs: ['assert', 'ask'],
  aiExtraction: JSON.stringify([seg('s1', outline, 'part', [first]), seg('s2', question, 'question', [first])]) } };
const answer = (human: string): Turn => ({ human, plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪のある形の話ですね。',
  act: 'agree', antecedent: 'claim_1', extraction: JSON.stringify([seg('s1', human, 'question', [first], null, 2)]) } });
const again = (name: string): Turn => ({ human: `この図形は「${name}」でしたよね？`, plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', name, act: 'name_propose',
  speech: `はい、「${name}」でしたね。`, extraction: JSON.stringify([seg('s1', `この図形は「${name}」でしたよね？`, 'name', [first], name)]) } });
const agreeTo = (name: string): Turn => ({ human: `この図形は「${name}」と呼んでもいいですか？`, plan: {
  action: 'agree', target: 'figure_0', referent: 'figure_0', name, act: 'name_propose', speech: `「${name}」と呼びましょう。`,
  extraction: JSON.stringify([seg('s1', `この図形は「${name}」と呼んでもいいですか？`, 'name', [first], name)]) } });

test('claimsLiveAsOf: a later withdrawal does not change what an earlier turn saw', () => {
  const records = [
    { kind: 'claim', id: 'a', turn: 2, sourceTurn: 2, act: 'name_propose', respondsTo: null },
    { kind: 'claim', id: 'b', turn: 4, sourceTurn: 4, act: 'withdraw', respondsTo: 'a' },
    { kind: 'claim', id: 'c', turn: 6, sourceTurn: 6, act: 'name_propose', respondsTo: 'a' },
  ];
  assert.deepEqual(claimsLiveAsOf(records, 2).map((c: any) => c.id), ['a']);
  assert.deepEqual(claimsLiveAsOf(records, 4).map((c: any) => c.id), ['b']);
  assert.deepEqual(claimsLiveAsOf(records, 6).map((c: any) => c.id), ['b']);
});

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  const common = { dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, generationRetryVersion: 'jev_generation_retry_v11' } as const;
  const valid = (value: unknown) => validateJevPrivateStateV2(value, slots, interventionForStrategy(label), 'two_stage_v3', 'holistic_v5', 'jev_generation_retry_v11');

  test(`${label}: B-30A-1 a withdrawn nameless proposal pruned away with its withdrawal by later feature turns still validates, with no other name added`, async () => {
    const built = await buildRecords({ ...common, label, turns: [nameless, drop, ...Array.from({ length: 12 }, (_, n) => feature(n))] });
    const state = structuredClone(built.trials[0].lastCommittedState);
    assert.ok(state.judgments[0].jevTurn.namingRequest, 'the proposal turn was a naming request');
    assert.equal(state.graph.records.some((r: any) => r.kind === 'claim' && r.act === 'name_propose'), false, 'the real prune dropped the proposal');
    assert.equal(state.graph.records.some((r: any) => r.kind === 'claim' && r.aspect === 'name'), false, 'and no other name claim exists');
    valid(state);
    assert.deepEqual(state.judgments.at(-1).jevTurn.agreeNames.map((n: any) => n.name), [], 'the withdrawn name is not an agree candidate');
    const bad = verifyRecords(built).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id) && c.status !== 'pass').map(c => `${c.id}:${c.status}`);
    assert.deepEqual(bad, []);
  });

  test(`${label}: a withdrawn proposal still in the graph does not turn its turn's marker into a mismatch`, async () => {
    const built = await buildRecords({ ...common, label, turns: [nameless, drop, feature(0)] });
    valid(structuredClone(built.trials[0].lastCommittedState));
  });

  test(`${label}: the newest turn's marker is exact; a removed marker whose proposal the graph holds is refused`, async () => {
    const built = await buildRecords({ ...common, label, turns: [check, answer('はい、その形です。'), agreeTo('小さな鍵')] });
    const state = structuredClone(built.trials[0].lastCommittedState);
    valid(state);
    const removed = structuredClone(state);
    delete removed.judgments.at(-1).jevTurn.namingRequest;
    assert.throws(() => valid(removed), { code: 'invalid_state' });
    const forged = structuredClone(state);
    forged.graph.records = forged.graph.records.filter((r: any) => !(r.kind === 'claim' && r.act === 'name_propose'));
    assert.throws(() => valid(forged), { code: 'invalid_state' });
  });

  test(`${label}: B-30A-2 the first agreement of a name is never a reconfirmation, from the state or from the trace's own claims`, async () => {
    const built = await buildRecords({ ...common, label, turns: [check, answer('はい、その形です。'), agreeTo('小さな鍵'), again('小さな鍵')] });
    const trial = built.trials[0];
    const state = structuredClone(trial.lastCommittedState);
    valid(state);
    const firstTurn = state.judgments.find((j: any) => j.jevTurn.executed.action === 'agree'), secondTurn = state.judgments.at(-1);
    assert.ok(secondTurn.jevTurn.namingReconfirm, 'the later proposal of the agreed name is a reconfirmation');
    // The saved trace's local.claims hold the turn's claims in full; here the graph still holds them, which is the same list.
    const claimsOf = (_turn: number) => state.graph.records.filter((r: any) => r.kind === 'claim');
    // The honest history: the first turn agreed the name; a later proposal of the same name may be a reconfirmation.
    assert.equal(reconfirmationPossible(turnNameProposals(claimsOf(firstTurn.turnIndex), firstTurn.turnIndex), firstTurn.turnIndex, state.judgments, state.ledger), false);
    assert.equal(reconfirmationPossible(turnNameProposals(claimsOf(secondTurn.turnIndex), secondTurn.turnIndex), secondTurn.turnIndex, state.judgments, state.ledger), true);
    // Rewriting the first turn's marker to a reconfirmation is refused by the state check while its proposal is in the graph.
    const rewritten = structuredClone(state);
    const target = rewritten.judgments.find((j: any) => j.turnIndex === firstTurn.turnIndex);
    delete target.jevTurn.namingRequest;
    target.jevTurn.namingReconfirm = true;
    assert.throws(() => valid(rewritten), { code: 'invalid_state' });
  });
}

// Audit 31. The restore reads the claims a saved trace holds, in the view the run decided on.
const gates = { markerAllowed: true, unmarkedChecked: true };
const claim = (id: string, act: string, sourceTurn: number, respondsTo: string | null, name: string | null = null) =>
  ({ kind: 'claim', id, act, sourceTurn, respondsTo, name, speaker: 'human', aspect: 'name', targets: [] as string[] });
const judged = (turnIndex: number, action: string, targetSlot: string | null, name: string | null) =>
  ({ turnIndex, judgment: { action, targetSlot, candidateName: name, discriminatingFeature: null }, jevTurn: { executed: { action, name } } });

test('B-31A-1: a name approval that the same utterance withdraws is no proposal for the restore, with or without the withdrawn one in the trace', () => {
  // Turn 4 asks "is that name all right?" (it carries the proposal of turn 2) and withdraws that proposal in the same utterance.
  const trace = { turnIndex: 4, status: 'committed', local: { claims: [claim('4:local1', 'name_propose', 4, '2:local1', '月枠'), claim('4:local2', 'withdraw', 4, '2:local1')] } };
  assert.equal(traceMarkerInvalid(trace, [], {}, gates), false, 'no marker is right: the run saw no live proposal');
  assert.equal(traceMarkerInvalid({ ...trace, namingRequest: true }, [], {}, gates), true, 'a marker would contradict the run\'s own view');
  // Without the withdrawal the same approval is a proposal, so the marker is required (the unchanged rule).
  const asked = { turnIndex: 4, status: 'committed', local: { claims: [claim('4:local1', 'name_propose', 4, '2:local1', '月枠')] } };
  assert.equal(traceMarkerInvalid(asked, [], {}, gates), true);
  assert.equal(traceMarkerInvalid({ ...asked, namingRequest: true }, [], {}, gates), false);
  // A withdrawal followed by an independent new name stays a proposal.
  const renamed = { turnIndex: 4, status: 'committed', local: { claims: [claim('4:local2', 'withdraw', 4, '2:local1'), claim('4:local3', 'name_propose', 4, null, '月輪')] } };
  assert.equal(traceMarkerInvalid(renamed, [], {}, gates), true);
  assert.equal(traceMarkerInvalid({ ...renamed, namingRequest: true }, [], {}, gates), false);
});

test('B-31A-2: a name agreed and then deferred is not agreed when it is proposed again, so that turn is a request and never a reconfirmation', () => {
  const proposal = [claim('8:local1', 'name_propose', 8, null, '星窓')];
  const deferred = [judged(4, 'agree', 'figure_0', '星窓'), judged(6, 'defer', 'figure_0', null)];
  const ledger = { figure_0: { status: 'deferred', name: '星窓' } };
  assert.equal(reconfirmationPossible(proposal, 8, deferred, ledger), false);
  const asReconfirm = { turnIndex: 8, status: 'committed', namingReconfirm: true, local: { claims: proposal } };
  assert.equal(traceMarkerInvalid(asReconfirm, deferred, ledger, gates), true);
  assert.equal(traceMarkerInvalid({ turnIndex: 8, status: 'committed', namingRequest: true, local: { claims: proposal } }, deferred, ledger, gates), false);
  // While the agreement stands, the same proposal may be a reconfirmation; so after a feature-only repair, which leaves the ledger alone.
  const kept = [judged(4, 'agree', 'figure_0', '星窓'), { turnIndex: 6, judgment: { action: 'repair', targetSlot: 'figure_0', candidateName: null, discriminatingFeature: '細い棒' }, jevTurn: { executed: { action: 'repair', name: null } } }];
  assert.equal(reconfirmationPossible(proposal, 8, kept, { figure_0: { status: 'agreed', name: '星窓' } }), true);
  // A name agreed, deferred and agreed again is agreed.
  assert.equal(reconfirmationPossible(proposal, 10, [...deferred, judged(8, 'agree', 'figure_0', '星窓')], { figure_0: { status: 'agreed', name: '星窓' } }), true);
  // A rename of the agreed name releases the old one.
  assert.equal(reconfirmationPossible(proposal, 10, [judged(4, 'agree', 'figure_0', '星窓'), judged(6, 'repair', 'figure_0', '月窓')], { figure_0: { status: 'tentative', name: '月窓' } }), false);
});
