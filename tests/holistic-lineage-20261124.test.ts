// Synthetic only. Version identification (holistic-first, B5): the dialogue policy is a stored value, never a global switch.
//  - static verdict: S4 verifies each earlier lineage's recorded request text against that lineage, and refuses to identify the holistic text without the policy;
//  - dynamic reproduction: the current runtime without the policy reproduces only the latest earlier lineage (loop); style and legacy are never reproduced.
// The fixture holds one-turn requests produced by the real runtime of each lineage commit (legacy 58a9511, style 07116ae, loop 6a25ed7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { BYPASS_ACCEPTANCE_V1_TABLE_SHA256 } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { anchors, image, memo } from './support/s4-integration/harness.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/parity-verify/lineage-requests-20261124.json', import.meta.url), 'utf8')) as
  { lineages: Record<'legacy' | 'style' | 'loop', { actionQuestions: string; generation: string; actionBody: string; body: any; genMessages: any }> };
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function currentTurn(dialoguePolicy: 'holistic_v1' | undefined) {
  const wire: any[] = [], luna: any[] = [];
  const jevDecision = createJevDecisionClient({ enabled: true, questionLayout: 'two_stage_v3', readKey: async () => 'sk-or-SYNTHETIC-lineage-key', fetchImpl: async (_u: string, init: any) => {
    const body = JSON.parse(String(init.body)); wire.push(body); const answers: any = {};
    for (const [k, q] of Object.entries<any>(body.questions)) { const keys = Object.keys(q.criteria), choice = k === 'action' ? 'accept' : k === 'target' ? 'none' : keys[0];
      answers[k] = { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(c => [c, c === choice ? 1 : 0])) }; }
    return new Response(JSON.stringify({ id: 'resp-1', model: body.model, answers, usage: { cost: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } })!;
  const dialogue = createDialogueV2({ client: { async complete(messages: any[], o: any) { if (o?.phase === 'generation') { luna.push(messages); return { text: 'そう見えるんですね。' }; } return { text: JSON.stringify({ segments: [] }) }; } },
    strategy: 'repair-first', image, anchors, referenceMemory: true, decisionMode: 'jev', questionLayout: 'two_stage_v3', ...(dialoguePolicy ? { dialoguePolicy } : {}),
    technicalTrial: { version: 'adaptive_repair_v3' }, interventionPolicy: { version: 'bypass_acceptance_v1', tableSha256: BYPASS_ACCEPTANCE_V1_TABLE_SHA256 }, decisionTimeoutMs: 5000,
    observer: { async observeAll() { return memo() as never; }, async reobserve() { throw new Error('unused'); } }, jevDecision, localGrounding: { classifier: { async classify() { return []; } } } } as never);
  await dialogue.runAiTurn({ events: [{ id: 'e1', seq: 1, speaker: 'ai', text: 'まず、どの図形から話しましょうか？', nonReferential: true }, { id: 'e2', seq: 2, speaker: 'human', text: 'どんな図形がありますか？' }],
    privateState: await dialogue.initializePrivateState!(), lastEventId: 'e2', requestSeq: 1 });
  const action = wire.find(w => w.questions.action);
  return { action, generation: luna[0] };
}
const ledger = Object.fromEntries(anchors.map(a => [a.id, { status: 'unassigned', name: null }]));
// The context an adaptive v3 tape (repair-first, with repair facts and no saved agree names) gives the verifier.
const ctx = (policy: 'holistic_v1' | null) => s4Probe.setContext({ v3: true, trial: true, known: true, style: null, policy, agree: [], facts: true, ledger } as never);
const verdict = (body: any) => s4Probe.originalQuestions(body, JSON.parse(body.state), 'two_stage_v3');

test('dynamic reproduction: without the policy the current runtime reproduces exactly the latest earlier lineage (loop) and never style or legacy', async () => {
  const now = await currentTurn(undefined);
  const { loop, style, legacy } = fixture.lineages;
  assert.equal(sha(now.action), loop.actionBody);
  assert.equal(sha(now.generation), loop.generation);
  assert.notEqual(sha(now.action.questions), style.actionQuestions, 'the style request text is not reproduced');
  assert.notEqual(sha(now.action.questions), legacy.actionQuestions, 'the legacy request text is not reproduced');
  assert.notEqual(sha(now.generation), legacy.generation, 'the legacy generation text is not reproduced');
  assert.equal(style.generation, loop.generation, 'style and loop differ in the decision text only');
});

test('dynamic reproduction: the stored holistic policy reproduces neither earlier lineage', async () => {
  const now = await currentTurn('holistic_v1');
  for (const lineage of Object.values(fixture.lineages)) {
    assert.notEqual(sha(now.action.questions), lineage.actionQuestions);
    assert.notEqual(sha(now.generation), lineage.generation);
  }
});

test('static verdict: S4 verifies each earlier lineage against its own text, and only without the policy', () => {
  for (const [name, lineage] of Object.entries(fixture.lineages)) {
    ctx(null);
    assert.equal(verdict(lineage.body), true, name + ' (policy absent)');
    ctx('holistic_v1');
    assert.equal(verdict(lineage.body), false, name + ' (policy stored)');
  }
});

test('static verdict: the holistic text without the stored policy is "identification impossible" (null), never a pass; with the policy it passes', async () => {
  const holistic = (await currentTurn('holistic_v1')).action;
  ctx(null);
  assert.equal(verdict(holistic), null);
  ctx('holistic_v1');
  assert.equal(verdict(holistic), true);
});
