// audit/03 F2: through the profile entry the verified profile sets the question layout. two_stage_v2 runs only on the
// integrated v3 profile; caller overrides, older profiles and contradicting clients are refused before any request.
// The participant entry is covered in jev-decision-failure-record.test.ts (B2/C2-4). Synthetic transports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { researchTrialProfile, researchTrialProfileV2, researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { createJevTurnRuntime } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { ids, anchors, image, memo, deadlines } from './support/s4-integration/harness.ts';

const events = [{ id: 'human-1', seq: 1, speaker: 'human', text: 'Control?' }];
/** A native client of the given layout answering defer / multiple / figures_1_3; it counts every POST. */
function native(questionLayout: 'two_stage_v1' | 'two_stage_v2') {
  const posts: any[] = [];
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(init.body); posts.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]: any) => {
      const labels = Object.keys(q.criteria);
      const choice = key === 'action' ? 'defer' : key === 'target' ? 'multiple' : key === 'candidate_set' ? 'figures_1_3' : key.startsWith('candidate_') ? (['candidate_1', 'candidate_3'].includes(key) ? 'include' : 'exclude') : labels[0];
      return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(l => [l, l === choice ? 1 : 0])) }];
    }));
    return Response.json({ model: 'typesafe/jev-1.14', id: 'gen-layout-' + posts.length, usage: { cost: 0 }, answers });
  };
  const client = createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-0000000000000000', fetchImpl, timeoutMs: 1000,
    researchLimits: { maxDeadlineMs: 600000 }, questionLayout })!;
  return { client, posts };
}
const options = (jevDecision: any, extra: Record<string, unknown> = {}) => ({ strategy: 'repair-first',
  client: { async complete(_m: any, o: any) { return { text: ['local_extraction', 'ai_extraction'].includes(o.phase) ? '[]' : 'Control.' }; } },
  image, anchors, observer: { async observeAll() { return memo(); }, async reobserve() { throw Error('unused'); } }, jevDecision,
  localGrounding: { classifier: { async classify() { return []; } }, aiPublicTransport: { readKey: async () => { throw Error('unused'); }, fetchImpl: async () => { throw Error('unused'); } } },
  referenceMemory: true, decisionMode: 'jev', ...extra } as any);
const v3 = (layout: 'two_stage_v1' | 'two_stage_v2') => researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, deadlines(), layout);

test('F2: a v3 / two_stage_v2 profile runs a v2 turn through createProfileDialogue with a v2 native client', async () => {
  const { client, posts } = native('two_stage_v2');
  const runtime = createProfileDialogue(v3('two_stage_v2'), options(client));
  const result: any = await runtime.runAiTurn({ events, privateState: runtime.initialPrivateState(), lastEventId: 'human-1', requestSeq: 1 });
  const turn = result.privateState.judgments[0].jevTurn;
  assert.deepEqual(turn.decision.evidence.stages.map((s: any) => s.stage), ['action_target', 'multiple_candidates']);
  assert.deepEqual(turn.decision.target, { kind: 'multiple', figureIds: [ids[1], ids[3]] });
  // repair-first vetoes defer: the alternative keeps the original candidate set.
  assert.equal(turn.intervention.disposition, 'rejected'); assert.deepEqual(turn.executed.target, turn.decision.target);
  assert.deepEqual(posts.map(b => Object.keys(b.questions)).filter(k => !k.includes('human_referent')).slice(0, 2), [['action', 'target'], ['candidate_set']]);
  // The saved state validates under the same profile again (graph snapshot and restore path).
  assert.doesNotThrow(() => runtime.snapshotGraph(result.privateState));
  assert.throws(() => createProfileDialogue(v3('two_stage_v1'), options(native('two_stage_v1').client)).snapshotGraph(result.privateState), { code: 'invalid_state' });
});

test('F2: overrides, older profiles and contradicting clients are refused before any request', () => {
  const older = () => researchTrialProfileV2({ timeoutMs: null, maxCompletionTokens: null }, deadlines());
  const cases: Array<[string, 'two_stage_v1' | 'two_stage_v2', (client: any) => unknown, RegExp | object]> = [
    ['caller override on v3/v2', 'two_stage_v2', c => createProfileDialogue(v3('two_stage_v2'), options(c, { questionLayout: 'two_stage_v1' })), /set by the profile/],
    ['caller v2 on the older v2 profile', 'two_stage_v1', c => createProfileDialogue(older() as any, options(c, { questionLayout: 'two_stage_v2' })), /set by the profile/],
    ['older v2 profile naming two_stage_v2', 'two_stage_v1', c => createProfileDialogue({ ...older(), questionLayout: 'two_stage_v2' } as any, options(c)), { code: 'model_profile_invalid' }],
    ['v1 profile naming two_stage_v2', 'two_stage_v1', c => createProfileDialogue({ ...researchTrialProfile({ timeoutMs: null, maxCompletionTokens: null }), questionLayout: 'two_stage_v2' } as any,
      options(c)), /Invalid Jev question layout for this profile/],
    ['v2 client under a v1 profile', 'two_stage_v2', c => createProfileDialogue(v3('two_stage_v1'), options(c)), /layout mismatch/],
    ['v1 client under a v2 profile', 'two_stage_v1', c => createProfileDialogue(v3('two_stage_v2'), options(c)), /layout mismatch/],
    ['createDialogueV2 without the integrated profile', 'two_stage_v2', c => createDialogueV2(options(c, { questionLayout: 'two_stage_v2' })), /requires the integrated Jev profile/],
    ['createJevTurnRuntime without the integrated profile', 'two_stage_v2', c => createJevTurnRuntime({ ...options(c), questionLayout: 'two_stage_v2',
      ownImage: image, ownAnchors: anchors, generation: {} } as any), /requires the integrated Jev profile/],
  ];
  for (const [name, layout, make, expected] of cases) {
    const n = native(layout);
    assert.throws(() => make(n.client), expected as any, name);
    assert.equal(n.posts.length, 0, name + ': no request');
  }
  // two_stage_v1 stays accepted everywhere it was before.
  assert.doesNotThrow(() => createDialogueV2(options(native('two_stage_v1').client, { questionLayout: 'two_stage_v1' })));
  assert.doesNotThrow(() => createProfileDialogue(v3('two_stage_v1'), options(native('two_stage_v1').client)));
});
