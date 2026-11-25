// #197: the kind of a naming turn's marker (request or reconfirm) and the partner-referent outcome are checked against the turn's own earlier state.
// Synthetic only.
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
const alias = '小さな鍵';
const askName = 'この図形は「小さな鍵」と呼んでもいいですか？';
const segment = (id: string, quote: string, aspect: string, targets: string[], name: string | null = null, respondsToTurn: number | null = null) =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn });
const check: Turn = { human: '輪のついた形を見比べたいです。', plan: {
  action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: outline + question, aiActs: ['assert', 'ask'],
  aiExtraction: JSON.stringify([segment('s1', outline, 'part', [first]), segment('s2', question, 'question', [first])]),
} };
const answer = (human: string): Turn => ({ human, plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪のある形の話ですね。',
  act: 'agree', antecedent: 'claim_1', extraction: JSON.stringify([segment('s1', human, 'question', [first], null, 2)]) } });
const naming = (action: 'agree' | 'accept', text = askName): Turn => ({ human: text, plan: {
  action, target: 'figure_0', referent: 'figure_0', ...(action === 'agree' ? { name: alias } : {}), act: 'name_propose',
  extraction: JSON.stringify([segment('s1', text, 'name', [first], alias)]),
  speech: action === 'agree' ? '「小さな鍵」と呼びましょう。' : '輪のある形ですね。',
} });
const policies = [
  { policy: 'holistic_v3', version: undefined, generation: undefined },
  { policy: 'holistic_v5', version: 'jev_generation_retry_v10', generation: 'jev_generation_retry_v10' },
] as const;

for (const { policy, generation } of policies) for (const label of ['repair-first', 'bypass-enabled'] as const) {
  const common = { dialoguePolicy: policy, technicalTrial: { version: 'adaptive_repair_v3' }, ...(generation ? { generationRetryVersion: generation } : {}) } as const;
  const state = async (turns: Turn[]) => {
    const built = await buildRecords({ ...common, label, turns: [check, answer('はい、その形です。'), ...turns] });
    return structuredClone(built.trials[0].lastCommittedState);
  };
  const valid = (value: unknown) => validateJevPrivateStateV2(value, slots, interventionForStrategy(label), 'two_stage_v3', policy, generation);
  const markerOf = (z: any) => Object.hasOwn(z, 'namingRequest') ? 'namingRequest' : Object.hasOwn(z, 'namingReconfirm') ? 'namingReconfirm' : null;
  const swap = (z: any, from: string, to: string) => { delete z[from]; z[to] = true; };

  test(`#197 ${policy} ${label}: the genuine first agreement (request) and a genuine later reconfirmation validate`, async () => {
    const agreed = await state([naming('agree')]);
    assert.equal(markerOf(agreed.judgments.at(-1).jevTurn), 'namingRequest');
    valid(agreed);
    const reconfirmed = await state([naming('agree'), naming('accept', 'さっきの「小さな鍵」でいい？')]);
    assert.equal(markerOf(reconfirmed.judgments.at(-1).jevTurn), 'namingReconfirm');
    valid(reconfirmed);
  });

  test(`#197 ${policy} ${label}: the first agreement turn's marker rewritten to a reconfirmation is refused by the state check`, async () => {
    const agreed = await state([naming('agree')]);
    swap(agreed.judgments.at(-1).jevTurn, 'namingRequest', 'namingReconfirm');
    assert.throws(() => valid(agreed), { code: 'invalid_state' });
  });

  test(`#197 ${policy} ${label}: a request turn that follows a real agreement of another figure's name keeps validating`, async () => {
    const agreed = await state([naming('agree', 'この図形は「小さな鍵」と呼んでもいいですか？')]);
    valid(agreed);
  });
}

// #197 item 2: a successful partner-referent estimate rewritten to unknown in every copy of the record is already an S4 mismatch (the replay check re-derives it from the tape).
// This pins that detection for both policies; no static check was added.
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
const interventionStatuses = (record: any) => verifyRecords(record).checks.filter((entry: any) => /^intervention\.trial\.0\.attempt\.0\./u.test(entry.id)).map((entry: any) => entry.status);
const rewriteReferent = (value: any, apply: (referent: any) => void) => {
  if (Array.isArray(value)) value.forEach(item => rewriteReferent(item, apply));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (key === 'humanReferent' && child && typeof child === 'object' && (child as any).status === 'ok') apply(child);
    else rewriteReferent(child, apply);
  }
};
for (const policy of ['holistic_v3', 'holistic_v5'] as const) for (const label of ['repair-first', 'bypass-enabled'] as const) {
  const build = () => buildRecords({ label, dialoguePolicy: policy, technicalTrial: { version: 'adaptive_repair_v3' },
    ...(policy === 'holistic_v5' ? { generationRetryVersion: 'jev_generation_retry_v10' as const } : {}),
    turns: [check, answer('はい、その形です。')] });
  test(`#197 ${policy} ${label}: a record whose partner-referent estimate succeeded on the tape passes S4 unchanged`, async () => {
    assert.deepEqual(interventionStatuses(await build()), ['pass', 'pass', 'pass', 'pass']);
  });
  test(`#197 ${policy} ${label}: rewriting every copy of a successful estimate to unknown is an S4 mismatch`, async () => {
    const record = JSON.parse(JSON.stringify(await build()));
    let rewritten = 0;
    rewriteReferent(record, referent => { rewritten++; Object.assign(referent, { status: 'unknown', scores: null, model: null, responseId: null, costUsd: null }); });
    assert.ok(rewritten > 0, 'the record holds successful estimates to rewrite');
    assert.ok(interventionStatuses(record).some(status => status !== 'pass'));
  });
}
