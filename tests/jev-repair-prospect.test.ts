// PLAN-ADAPTIVE-r1 B1: synthetic private material only, no live transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepairProspectPayload, buildJevDecisionPayload, buildJevDecisionDetailPayload,
  createJevDecisionClient, validateRepairProspectEstimate, unknownRepairProspect, JEV_DECISION_MODEL } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { REPAIR_PROSPECTS, REPAIR_PROSPECT_BASES } from '../dialogue-model/runtime/decision/contract.ts';
import type { JevDecisionInput, RepairHistoryEntry, RepairProspectMaterial, JevDecisionClient } from '../dialogue-model/runtime/decision/contract.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createDialogueV2, ACTION_SCOPE_V2, GENERATOR_INSTRUCTIONS_V2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { interventionForStrategy } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';

const technicalTrial = { version: 'adaptive_repair_v1' } as const;
const slots = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = slots.map((id, x) => ({ id, bbox: { x, y: 0, w: 1, h: 1 }, centroid: { x, y: 0 } }));
const memo = { observedAt: '2026-10-20T00:00:00.000Z', figures: anchors.map(a => ({ id: a.id, region: a.bbox,
  holistic: [], analytic: { shapes: ['三角'], composition: '二つの部分が接する', relations: [] }, unknowns: [], reobservations: [] })) };
const history = (n = 1): RepairHistoryEntry[] => Array.from({ length: n }, (_, i) => ({ turn: i * 2 + 1, issueId: `local-${i}`,
  action: 'repair', question: '尖った部分はありますか', partnerClaims: [], candidatesBefore: slots.slice(0, 2), candidatesAfter: slots.slice(0, 2),
  addedClaimIds: [], removedClaimIds: [], progress: 'unchanged' }));
function input(n = 1): JevDecisionInput {
  return { turn: 21, ownSlots: slots, publicTurns: [{ turn: 21, speaker: 'human', text: 'まだよく分かりません' }],
    observations: structuredClone(memo), issueSummary: '', priorClaims: [], repairHistory: history(n), previousAction: null, publicNames: [] };
}
function answer(p: JevDecisionPayload, selected: Record<string, string> = {}) {
  return { model: JEV_DECISION_MODEL, id: 'gen-prospect', usage: { cost: 0.0001 }, answers: Object.fromEntries(Object.entries(p.questions).map(([key, q]) => {
    const labels = Object.keys(q.criteria), choice = selected[key] ?? labels[0];
    return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map((label, i) => [label, (i + 1) / (labels.length + 1)])) }];
  })) };
}
function material(v = input(), prospect: typeof REPAIR_PROSPECTS[number] = 'progressing', basis: typeof REPAIR_PROSPECT_BASES[number] = 'new_information'): RepairProspectMaterial {
  const p = buildRepairProspectPayload(v), a = answer(p, { prospect, basis });
  const issue = v.repairHistory.at(-Math.min(8, v.repairHistory.length))!;
  return { status: 'ok', issue: { choice: 'issue', turn: issue.turn, issueId: issue.issueId }, prospect, basis,
    scores: Object.fromEntries(Object.entries(a.answers).map(([key, value]) => [key, value.probabilities])) as Extract<RepairProspectMaterial, { status: 'ok' }>['scores'] };
}

test('prospect asks three independent closed questions over exactly the latest eight repairs', () => {
  const v = input(9), p = buildRepairProspectPayload(v);
  assert.deepEqual(Object.keys(p.questions), ['repair_issue', 'prospect', 'basis']);
  assert.deepEqual(Object.keys(p.questions.repair_issue.criteria), [...Array.from({ length: 8 }, (_, i) => `issue_${i}`), 'none', 'unknown']);
  assert.deepEqual(Object.keys(p.questions.prospect.criteria), [...REPAIR_PROSPECTS]);
  assert.deepEqual(Object.keys(p.questions.basis.criteria), [...REPAIR_PROSPECT_BASES]);
  assert.deepEqual(JSON.parse(p.questions.repair_issue.criteria.issue_0), { turn: 3, action: 'repair', question: '尖った部分はありますか', candidatesAfter: slots.slice(0, 2) });
  for (const q of Object.values(p.questions)) {
    assert.equal(q.type, 'choice');
    assert.ok(q.instructions.includes('同じリクエストの他の答えは見えません'));
  }
  const poisoned = { ...v, repairProspect: material(v) };
  assert.equal(JSON.stringify(buildRepairProspectPayload(poisoned)), JSON.stringify(p));
});

test('native estimator retains unnormalized scores and explicit none/unknown/no_open_issue', async () => {
  for (const choice of ['issue_0', 'none', 'unknown']) {
    const requests: JevDecisionPayload[] = [];
    const client = createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-prospect-key-000000',
      fetchImpl: async (_url, init) => { const p = JSON.parse(String(init?.body)); requests.push(p); return Response.json(answer(p, { repair_issue: choice, prospect: 'no_open_issue', basis: 'none' })); } })!;
    const result = await client.estimateRepairProspect(input());
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw Error();
    assert.deepEqual(result.issue, choice === 'issue_0' ? { choice: 'issue', turn: 1, issueId: 'local-0' } : { choice });
    assert.equal(result.prospect, 'no_open_issue');
    assert.equal(result.scores.prospect.progressing, 0.2);
    assert.equal(result.scores.prospect.no_open_issue, 0.8);
    assert.equal(requests.length, 1);
    assert.deepEqual(validateRepairProspectEstimate(result, input()), result);
  }
});

test('transport and malformed estimator results become unknown without leaking raw errors', async () => {
  for (const mode of ['network', 'missing_label', 'out_of_range', 'free_text', 'wrong_model', 'cost_missing']) {
    const client = createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-prospect-key-000000', fetchImpl: async (_url, init) => {
      if (mode === 'network') throw Error('PRIVATE-RAW-ERROR');
      const a: any = answer(JSON.parse(String(init?.body)));
      if (mode === 'missing_label') delete a.answers.prospect.probabilities.uncertain;
      if (mode === 'out_of_range') a.answers.prospect.probabilities.uncertain = 2;
      if (mode === 'free_text') a.answers.basis.choice = 'PRIVATE-RAW-ERROR';
      if (mode === 'wrong_model') a.model = 'other-model';
      if (mode === 'cost_missing') delete a.usage.cost;
      return Response.json(a);
    } })!;
    assert.deepEqual(await client.estimateRepairProspect(input()), unknownRepairProspect());
  }
  const valid: any = material();
  for (const bad of [{ ...valid, status: 'unknown' }, { ...valid, extra: 'private' }, { ...valid, issue: { choice: 'issue', turn: 2, issueId: 'foreign' } }]) {
    assert.throws(() => validateRepairProspectEstimate(bad, input()), { code: 'invalid_response' });
  }
});

test('prospect guidance is added only to stage one when material is present; detail retains the same material', () => {
  const v = input(), on = { ...v, repairProspect: material(v) };
  assert.ok(!JSON.stringify(buildJevDecisionPayload(v)).includes('repairProspect'));
  assert.deepEqual(JSON.parse(buildJevDecisionPayload(on).state).repairProspect, on.repairProspect);
  assert.ok(buildJevDecisionPayload(on).questions.action.instructions.includes('repairProspectは未校正の見込みと根拠の材料です。正解や閾値ではありません。'));
  const p = buildJevDecisionDetailPayload(on, { action: 'repair', target: { kind: 'single', figureId: slots[0] } })!;
  assert.deepEqual(JSON.parse(p.state).repairProspect, on.repairProspect);
  assert.ok(!p.questions.feature.instructions.includes('repairProspectは未校正'));
});

const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: 1000 },
  { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 });
function harness({ enabled = false, estimator = true, fail = false, malformed = false, n = 1, strategy = 'repair-first', action = 'accept', progress = 'unchanged', prospect = 'progressing', basis = 'new_information', speech = 'なるほど。' }: any = {}) {
  const inputs: JevDecisionInput[] = [], order: string[] = [], messages: any[] = [];
  const jevDecision: JevDecisionClient = {
    async decide(v) { order.push('decide'); inputs.push(structuredClone(v)); return { action, target: action === 'repair' ? { kind: 'single', figureId: slots[0] } : { kind: 'none' },
      name: null, feature: action === 'repair' ? '三角' : null, observe: null, calibrated: false, decisionKind: 'mock', evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: 0 } }; },
    ...(estimator ? { async estimateRepairProspect(v: JevDecisionInput) { order.push('prospect');
      assert.ok(v.humanReferent); assert.ok(!v.repairProspect);
      if (fail) throw Error('PRIVATE-RAW-ERROR');
      if (malformed) return { status: 'ok', scores: null } as any;
      return material(v, prospect, basis);
    } } : {}),
  };
  const dialogue = createDialogueV2({ client: { async complete(m: any[], o: any) { messages.push({ messages: structuredClone(m), phase: o.phase }); return { text: o.phase === 'local_extraction' ? '[]' : speech }; } },
    image: { mimeType: 'image/png', base64: 'U1lOVEhFVElDX09XTl9JTUFHRQ==' }, anchors, referenceMemory: true, strategy, decisionMode: 'jev', jevDecision,
    observer: { async observeAll() { return structuredClone(memo); }, async reobserve() { throw Error('unused'); } }, localGrounding: { classifier: { async classify() { return []; } } },
    ...(enabled ? { technicalTrial } : {}) });
  const state = dialogue.initialPrivateState(); state.repairHistory = history(n).map(r => ({ ...r, progress }));
  const run = () => dialogue.runAiTurn({ events: [{ id: 'e21', seq: 21, speaker: 'human', text: 'まだよく分かりません' }], privateState: state, lastEventId: 'e21' });
  return { dialogue, state, inputs, order, messages, run };
}

test('OFF ignores estimator and preserves payload, generation, trace and saved state bytes', async t => {
  t.mock.method(performance, 'now', () => 1000);
  const a = harness({ estimator: false }), b = harness();
  const ar = await a.run(), br = await b.run();
  assert.equal(JSON.stringify(a.inputs), JSON.stringify(b.inputs));
  assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages));
  assert.equal(JSON.stringify(a.dialogue.getAttempts()), JSON.stringify(b.dialogue.getAttempts()));
  assert.equal(JSON.stringify(ar), JSON.stringify(br));
  assert.deepEqual(b.order, ['decide']);
  assert.ok(!JSON.stringify(br).includes('repairProspect'));
});

test('ON calls prospect after referent material, saves it privately and validates saved turns', async () => {
  const h = harness({ enabled: true }), r = await h.run();
  assert.deepEqual(h.order, ['prospect', 'decide']);
  const p = h.inputs[0].repairProspect;
  assert.deepEqual(h.dialogue.getAttempts()[0].repairProspect, p);
  assert.deepEqual(r.privateState.judgments[0].jevTurn.repairProspect, p);
  // Exercise the V2 persisted boundary with an adopted projection. B2 owns the
  // integration input whitelist; this B1 fixture does not require its new rerank.
  const saved: any = { ...structuredClone(r.privateState), schemaVersion: 'jev_private_state_v2', interventionPolicy: profile.interventionPolicy };
  const z = saved.judgments[0].jevTurn;
  z.executed = { action: z.decision.action, target: z.decision.target, name: null, feature: null, observe: null };
  z.intervention = { schemaVersion: 'jev_intervention_v1', policy: 'bypass_acceptance_v1:veto', disposition: 'adopted', reasonCode: 'not_in_veto_set',
    original: z.executed, rerank: null, alternative: null, detailEvidence: null, failure: null };
  assert.deepEqual(validateJevPrivateStateV2(saved, slots, interventionForStrategy('repair-first')), saved);
  assert.ok(!JSON.stringify(h.messages).includes('repairProspect'));
  assert.ok(!r.text.includes('repairProspect'));
  const bad = structuredClone(saved); (bad.judgments[0].jevTurn.repairProspect as any).issue.turn = 20;
  assert.throws(() => validateJevPrivateStateV2(bad, slots, interventionForStrategy('repair-first')), { code: 'invalid_state' });
  const off = harness(); assert.throws(() => off.dialogue.snapshotGraph(r.privateState), { code: 'invalid_state' });
});

test('empty history and absent optional method skip estimation; failures pass explicit unknown material', async () => {
  for (const extra of [{ n: 0 }, { estimator: false }]) {
    const h = harness({ enabled: true, ...extra }), r = await h.run();
    assert.deepEqual(h.order, ['decide']);
    assert.ok(!Object.hasOwn(h.inputs[0], 'repairProspect'));
    assert.ok(!Object.hasOwn(r.privateState.judgments[0].jevTurn, 'repairProspect'));
  }
  for (const extra of [{ fail: true }, { malformed: true }]) {
    const h = harness({ enabled: true, ...extra }), r = await h.run();
    assert.deepEqual(h.inputs[0].repairProspect, unknownRepairProspect());
    assert.deepEqual(r.privateState.judgments[0].jevTurn.repairProspect, unknownRepairProspect());
    assert.ok(!JSON.stringify(h.dialogue.getAttempts()).includes('PRIVATE-RAW-ERROR'));
  }
});

test('PLAN §3.1–3 mock checks only that changed, repeated and uncertain materials reach action selection', async () => {
  for (const scenario of [{ progress: 'changed', prospect: 'progressing', basis: 'new_information' },
    { progress: 'unchanged', prospect: 'stalled', basis: 'repetition' }, { progress: 'unknown', prospect: 'uncertain', basis: 'partner_uncertain' }]) {
    const a = harness({ enabled: true, ...scenario }), b = harness({ enabled: true, strategy: 'bypass-enabled', ...scenario });
    await a.run(); await b.run();
    assert.deepEqual(a.inputs, b.inputs);
    assert.equal(a.inputs[0].repairHistory[0].progress, scenario.progress);
    assert.equal(a.inputs[0].repairProspect?.prospect, scenario.prospect);
    assert.equal(a.inputs[0].repairProspect?.basis, scenario.basis);
  }
});

test('repair generation scope switches only ON, identically for both conditions', async () => {
  for (const strategy of ['repair-first', 'bypass-enabled']) for (const enabled of [false, true]) {
    const h = harness({ enabled, strategy, action: 'repair' }); await h.run();
    const generation = JSON.stringify(h.messages.filter(m => m.phase === 'generation'));
    const expected = '公開上の食い違いを局所的に確かめ直す・直す。自分の取り違えや決めた名前の訂正だと言うのは、公開の発話でそれが示されたときだけにする';
    assert.ok(generation.includes(enabled ? expected : ACTION_SCOPE_V2.repair));
    // #141 b: ON also replaces the shared self-correction sentence; OFF keeps it.
    const selfCorrection = 'repairでは自己訂正を明示し、repair以外では取り違えや取り消しを表明しないでください。';
    const grounded = '取り違えや取り消しは、repairで公開の発話にその根拠があるときだけ表明してください。';
    assert.equal(generation.includes(selfCorrection), !enabled);
    assert.equal(generation.includes(grounded), enabled);
    assert.ok(GENERATOR_INSTRUCTIONS_V2.includes(selfCorrection));
    assert.ok(!generation.includes(strategy));
  }
});

test('ON generation cannot publish the private prospect field or wire issue label', async () => {
  for (const speech of ['repairProspect', 'issue_0']) {
    const h = harness({ enabled: true, speech });
    await assert.rejects(h.run(), { code: 'unsafe_generation' });
  }
});


test('executed detail accepts and preserves the same repairProspect material', async () => {
  const v = { ...input(), repairProspect: material() }, requests: JevDecisionPayload[] = [];
  const client = createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-prospect-key-000000',
    fetchImpl: async (_url, init) => { const p = JSON.parse(String(init?.body)); requests.push(p); return Response.json(answer(p)); } })!;
  const result = await client.completeDetail(v, { action: 'repair', target: { kind: 'single', figureId: slots[0] } });
  assert.equal(result.executed.action, 'repair');
  assert.deepEqual(JSON.parse(requests[0].state).repairProspect, v.repairProspect);
});

test('prospect timeout is unknown, caller abort stays abort, and neither changes decision evidence', async () => {
  const client = createJevDecisionClient({ enabled: true, timeoutMs: 10, readKey: () => new Promise<string>(() => {}), fetchImpl: async () => { throw Error('unreachable'); } })!;
  assert.deepEqual(await client.estimateRepairProspect(input()), unknownRepairProspect());
  assert.equal(client.lastEvidence, null);
  assert.equal(client.lastReferentEvidence, null);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.estimateRepairProspect(input(), { signal: abort.signal }), { code: 'aborted' });
  assert.equal(client.callCount, 0);
  assert.equal(client.referentCallCount, 0);
});
