// The record build once failed after a published reply: a second name proposal for an already-named figure made the graph prune the first proposal, and the state
// check then refused the first turn's naming marker. Synthetic only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionForStrategy } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { buildRecords, OWN } from './support/s4-v3-records.ts';
import type { Turn } from './support/s4-v3-records.ts';

const first = OWN.ownAnchors[0].id as string;
const slots = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const outline = '折れた棒に小さな輪がついています。';
const question = '指しているのはこの図形でしょうか？';
const segment = (id: string, quote: string, aspect: string, targets: string[], name: string | null = null, respondsToTurn: number | null = null) =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn });
const check: Turn = { human: '輪のついた形を見比べたいです。', plan: {
  action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: outline + question, aiActs: ['assert', 'ask'],
  aiExtraction: JSON.stringify([segment('s1', outline, 'part', [first]), segment('s2', question, 'question', [first])]),
} };
const answer = (human: string): Turn => ({ human, plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪のある形の話ですね。',
  act: 'agree', antecedent: 'claim_1', extraction: JSON.stringify([segment('s1', human, 'question', [first], null, 2)]) } });
// An unadopted name is only asked about (a request turn offers no accept), so each proposal turn confirms the figure.
const agreeTo = (name: string): Turn => ({ human: `この図形は「${name}」と呼んでもいいですか？`, plan: {
  action: 'agree', target: 'figure_0', referent: 'figure_0', name, act: 'name_propose', speech: `「${name}」と呼びましょう。`,
  extraction: JSON.stringify([segment('s1', `この図形は「${name}」と呼んでもいいですか？`, 'name', [first], name)]) } });
const propose = (name: string): Turn => ({ human: `この図形は「${name}」と呼んでもいいですか？`, plan: {
  action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: outline + question, aiActs: ['assert', 'ask'],
  aiExtraction: JSON.stringify([segment('s1', outline, 'part', [first]), segment('s2', question, 'question', [first])]),
  act: 'name_propose', extraction: JSON.stringify([segment('s1', `この図形は「${name}」と呼んでもいいですか？`, 'name', [first], name)]) } });

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  const common = { dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, generationRetryVersion: 'jev_generation_retry_v10' } as const;
  const state = async (turns: Turn[]) => {
    const built = await buildRecords({ ...common, label, turns: [check, answer('はい、その形です。'), ...turns] });
    return structuredClone(built.trials[0].lastCommittedState);
  };
  const valid = (value: unknown) => validateJevPrivateStateV2(value, slots, interventionForStrategy(label), 'two_stage_v3', 'holistic_v5', 'jev_generation_retry_v10');
  const proposals = (s: any) => s.graph.records.filter((r: any) => r.kind === 'claim' && r.act === 'name_propose').map((r: any) => r.name);

  test(`${label}: a later name for the same figure prunes the first proposal, and the earlier turn's marker still validates`, async () => {
    const later = await state([agreeTo('小さな鍵'), propose('折れ棒')]);
    assert.equal(proposals(later).length, 2, 'both proposals are still in the graph here: the first issue is unresolved');
    // What the graph does once a resolved issue's name is superseded (prune keeps only the newest name claim per figure): drop the first proposal's issue.
    const firstProposal = later.graph.records.find((r: any) => r.kind === 'claim' && r.act === 'name_propose');
    later.graph.records = later.graph.records.filter((r: any) => !(r.kind === 'claim' && (r.issueId === firstProposal.issueId || r.respondsTo === firstProposal.id)));
    assert.deepEqual(proposals(later), ['折れ棒'], 'the first proposal is gone');
    assert.ok(later.judgments.slice(-2).every((j: any) => Object.hasOwn(j.jevTurn, 'namingRequest')));
    valid(later);
  });

  test(`${label}: a marker on the newest turn with no proposal anywhere is still refused`, async () => {
    const plain = await state([propose('小さな鍵')]);
    valid(plain);
    const forged = structuredClone(plain);
    forged.graph.records = forged.graph.records.filter((r: any) => !(r.kind === 'claim' && r.act === 'name_propose'));
    assert.throws(() => valid(forged), { code: 'invalid_state' });
  });

  test(`${label}: a marker removed from a turn whose proposal the graph still holds is still refused`, async () => {
    const plain = await state([propose('小さな鍵')]);
    delete plain.judgments.at(-1).jevTurn.namingRequest;
    assert.throws(() => valid(plain), { code: 'invalid_state' });
  });
}
