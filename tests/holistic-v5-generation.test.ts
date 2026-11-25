import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGenerationOutcome, findOrientationLeaks } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { buildJevDraftActPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { hash, verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { buildRecords, normal, OLD, OWN, runTurn } from './support/s4-v3-records.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';

test('holistic_v5 distinguishes local observations, attributed reports and questions from asserted shared orientation', () => {
  for (const text of [
    'こちらの画面では右端に切れ目があります。そちらにも切れ目がある形ですか？',
    'そちらの画面では右向きに見えると言っていましたね。',
    'そちらの画面では右向きに見えますか？',
    'そちらも同じ向きではないですね。',
    'そちらでは「右端に切れ目がある」と説明していましたね。',
    '切れ目と尖った部分がつながった形ですか？',
  ]) assert.deepEqual(findOrientationLeaks(text, 'holistic_v5'), [], text);
  for (const text of [
    'そちらの画面では右端に切れ目があります。',
    'こちらの画面では右端に切れ目があり、そちらも同じ位置にあります。',
  ]) {
    assert.deepEqual(findOrientationLeaks(text, 'holistic_v4'), [], text);
    const codes = findOrientationLeaks(text, 'holistic_v5');
    assert.deepEqual(codes, ['shared_view_assumption'], text);
    assert.equal(deriveGenerationOutcome(codes, codes, '切れ目のある形ですか？', true).kind, 'stop');
  }
  assert.deepEqual(findOrientationLeaks('右端に切れ目がある形ですか？', 'holistic_v5'), ['orientation_leak']);
  assert.deepEqual(findOrientationLeaks('こちらでは右端に切れ目が見えますが、左側に突起があります。', 'holistic_v5'), ['orientation_leak']);
});

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`holistic_v5 ${label}: the retry restates confirmation and S4 binds the exact framing and naming criteria`, async () => {
    const slot = OWN.ownAnchors[0].id, ledger = structuredClone(OLD.state.ledger);
    ledger[slot] = { status: 'agreed', name: '小舟' };
    const name = '帆', human = `この形を「${name}」と呼びませんか？`;
    const drafts = ['そちらの画面では右端に切れ目があります。', '切れ目が一つある形ですか？'];
    const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, ledger,
      turns: [{ human, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'name_propose', drafts,
        extraction: JSON.stringify([{ segmentId: 's1', quote: name, proposition: name, name, targets: [slot], aspect: 'name',
          linkedIssueId: null, respondsToTurn: null }]) } }] });
    const trial = records.trials[0], trace = trial.attempts[0], { tape, result } = trial.replay[0];
    const statuses = (r: any) => verifyRecords(r).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./.test(c.id)).map(c => c.status);
    assert.deepEqual(statuses(records), ['pass', 'pass', 'pass', 'pass']);
    assert.equal(result.status, 'same_material_intervention_verified');
    assert.equal(trace.namingRequest, true);
    assert.equal(trace.executed.action, 'confirm');
    assert.equal(trace.executed.name, null);
    assert.deepEqual(trace.generationGuard, { violations: ['shared_view_assumption'], regenerated: true, fallback: false });
    assert.equal(trace.publicSpeech, drafts[1]);
    assert.deepEqual(trial.lastCommittedState.ledger, ledger);
    assert.deepEqual(tape.state.ledger, ledger);
    const side = result.sides.find((s: any) => s.label === label);
    const gens = side.requests.filter((r: any) => r.phase === 'generation');
    assert.equal(gens.length, 2);
    const act = gens[0].payload.messages[2].content;
    assert.match(act, /その特徴だけを確かめてください.*採用・再提案せず.*相手の提案だと分かる形で引用/u);
    assert.ok(gens[1].payload.messages.at(-1).content.includes(act));
    assert.match(gens[1].payload.messages.at(-1).content, /参照枠を明確/u);
    const classify = side.requests.find((r: any) => r.phase === 'draft_naming');
    assert.match(classify.payload.questions.draft_naming.criteria.adopt_chosen, /nullでなく/u);
    assert.match(classify.payload.questions.draft_naming.criteria.adopt_other, /nullのとき/u);

    const corrupted = structuredClone(records);
    const verdict = corrupted.trials[0].replay[0].result;
    const opposite = verdict.sides.findIndex((s: any) => s.label !== label);
    const comparison = verdict.sides[opposite];
    const retry = comparison.requests.filter((r: any) => r.phase === 'generation')[1];
    retry.payload.messages.at(-1).content += '。';
    retry.completeMessagesSha256 = hash(retry.payload.messages);
    retry.payloadSha256 = retry.preProjectionPayloadSha256 = hash(retry.payload);
    corrupted.evidence.pairedReplay[0][opposite === 0 ? 'left' : 'right'] = structuredClone(comparison);
    assert.ok(statuses(corrupted).includes('mismatch'));
  });
}

test('v5 draft-act criteria preserve the closed labels and the null selected-name input', () => {
  const input = { turn: 1, publicTurns: [], reasons: ['typed_context'], selected: { action: 'confirm' as const,
    target: { kind: 'single' as const, figureId: OWN.ownAnchors[0].id }, name: null }, draft: '切れ目がありますか？' };
  const old = buildJevDraftActPayload(input, 'holistic_v4');
  const revised = buildJevDraftActPayload(input, 'holistic_v5');
  assert.equal(revised.state, old.state);
  assert.deepEqual(Object.keys(revised.questions.draft_naming.criteria), Object.keys(old.questions.draft_naming.criteria));
  assert.notEqual(revised.questions.draft_naming.instructions, old.questions.draft_naming.instructions);
  assert.equal(JSON.parse(revised.state).selected.name, null);
});

test('v5 stops a repeated name adoption under confirm in both conditions', async () => {
  const { lunaRequest, timeouts } = normal.run.manifest;
  const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5');
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    const state = structuredClone(OLD.state), before = structuredClone(state.ledger);
    const adoption = 'この形は「帆」にしましょう。';
    await assert.rejects(runTurn(profile, label, state, [{ id: 'human-1', seq: 1, speaker: 'human', text: '切れ目がありますか？' }],
      { action: 'confirm', target: 'figure_0', drafts: [adoption, adoption], draftAct: 'adopt_other' }, { version: 'adaptive_repair_v3' }),
      (err: any) => {
        assert.equal(err.code, 'unsafe_generation');
        assert.equal(err.traces.at(-1).publicSpeech, null);
        assert.equal(err.traces.at(-1).executed.action, 'confirm');
        assert.deepEqual(err.traces.at(-1).generationGuard, { violations: ['draft_act_mismatch'], regenerated: true, fallback: false });
        return true;
      });
    assert.deepEqual(state.ledger, before);
  }
});
