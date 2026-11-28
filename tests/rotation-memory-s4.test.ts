// S4 and the pre-made rotation memory: a request that carries a `rotation` memory is verified against the independent table in
// diagnostics/parity-verify/rotation-memory-records.ts (the legends, the layers, the sentences each call adds, the name candidates).
// The records come from the real runtime and the offline replay (buildRecords). A record whose requests change one character of what the memory
// adds is rebuilt with every hash carried through (mutate), so the only thing that can disagree afterwards is the relation between the memory
// and what the request says of it, which is what S4 has to judge.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { rotationInitialMemo } from '../dialogue-model/runtime/observation/rotation-memo.ts';
import { projectOwnRotationMemory, rotationNameCandidates } from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import { buildRecords, OWN, type Label } from './support/s4-v3-records.ts';
import { retargetToMode, type RotationMode } from './support/s4-rotation-records.ts';

const options = {
  dialoguePolicy: 'holistic_v5', interventionVersion: 'bypass_acceptance_v3', judgmentMaterialVersion: 'jev_repair_quality_v1',
  technicalTrial: { version: 'adaptive_repair_v3' }, generationRetryVersion: 'jev_generation_retry_v24', agreeNameScopeVersion: 'jev_naming_v3',
} as const;
const choose = (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined;
const INTERVENTION = /^intervention\.trial\.0\.attempt\.0\./u;
const statuses = (records: unknown) => interventionChecks(records as never).filter(c => INTERVENTION.test(c.id)).map(c => c.id.split('.').pop() + ':' + c.status);
const replayStatus = (records: unknown) => interventionChecks(records as never).find(c => INTERVENTION.test(c.id) && c.id.endsWith('.replay'))?.status;
const ALL_PASS = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:pass'];

// Figures with real prepared data at different current rotations (bank figure key, rotation now on the AI's screen).
const FIGURES: readonly [string, number][] = [['F6', 0], ['F9', 90], ['F1', 270], ['F11', 180], ['F14', 90], ['F20', 0]];
const memoOf = (count: 3 | 4 | 6) => {
  const anchors = OWN.ownAnchors.slice(0, count);
  return rotationInitialMemo(anchors, new Map(anchors.map((anchor: { id: string }, i: number) =>
    [anchor.id, projectOwnRotationMemory({ figureKey: FIGURES[i][0], rotation: FIGURES[i][1] })!])), '2026-01-01T00:00:00.000Z');
};
const firstName = rotationNameCandidates(projectOwnRotationMemory({ figureKey: FIGURES[0][0], rotation: FIGURES[0][1] })!)[0];
const draft = (text: string, check: 'off' | 'on') => check === 'on' ? JSON.stringify({ text, observationFeatures: [] }) : text;
const extraction = (check: 'off' | 'on') => check === 'on' ? JSON.stringify({ segments: [], visualFeatures: { sources: [] } }) : '[]';

type Scene = { human: string; plan: any };
// The four scenes of a first reception: an answer, a check with a visual purpose, a name proposal, and a request for one more look.
const SCENES: Record<string, (check: 'off' | 'on') => Scene> = {
  accept: check => ({ human: 'この図形はどんな形ですか？', plan: { postGenerationCheck: check, action: 'accept', target: 'none', choose,
    speech: draft('こちらでは全体が鳥のように見えます。', check), aiExtraction: extraction(check) } }),
  confirm: check => ({ human: '細い部分はどうつながっていますか？', plan: { postGenerationCheck: check, action: 'confirm', target: 'figure_0', referent: 'figure_0', choose,
    speech: JSON.stringify({ text: '細い部分は端でつながっています。', ...(check === 'on' ? { observationFeatures: [] } : {}) }), aiExtraction: extraction(check) } }),
  propose_name: check => ({ human: '何かに見えますか？', plan: { postGenerationCheck: check, action: 'propose_name', target: 'figure_0', referent: 'figure_0', name: firstName, act: 'construe',
    speech: draft(`では、「${firstName}」にしませんか？`, check), aiExtraction: extraction(check),
    choose: (key: string) => key === 'draft_naming' ? 'propose_chosen' : choose(key) } }),
  reobserve: check => ({ human: '右に突き出た部分はありますか？', plan: { postGenerationCheck: check, reobserve: true, action: 'accept', target: 'none', choose,
    speech: draft('もう一度見ると、右に細い部分があります。', check), aiExtraction: extraction(check) } }),
};
const build = (scene: keyof typeof SCENES, check: 'off' | 'on', { label = 'repair-first' as Label, figures = 3 as 3 | 4 | 6 } = {}) =>
  buildRecords({ ...options, label, figureCount: figures, memo: memoOf(figures), turns: [SCENES[scene](check)] });

const records: Record<string, any> = {};
const SCENE_CHECKS: [keyof typeof SCENES, 'off' | 'on'][] = [['accept', 'off'], ['confirm', 'on'], ['propose_name', 'on'], ['reobserve', 'off']];
for (const [scene, check] of SCENE_CHECKS) for (const label of ['repair-first', 'bypass-enabled'] as Label[]) {
  test(`${scene} (${check}, ${label}): S4 verifies the record of a reception that carries the rotation memory`, async () => {
    const built = await build(scene, check, { label });
    records[`${scene}:${label}`] = built;
    assert.deepEqual(statuses(built), ALL_PASS);
  });
}
