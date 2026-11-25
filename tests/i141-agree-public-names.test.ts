// Synthetic wiring and catalog regressions only; no private trial data or live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { JevDecisionInput, PublicNameCandidate, AdaptiveRepairTrial } from '../dialogue-model/runtime/decision/contract.ts';
import { buildJevDecisionPayload, buildJevDecisionDetailPayload, createJevDecisionClient,
  JEV_DECISION_MODEL } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { applyBypassAcceptance, interventionForStrategy, planBypassAcceptance } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { createMockJevDecisionClient } from '../dialogue-model/runtime/decision/mocks.ts';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { applyReferenceUpdate, snapshotReferenceGraph } from '../dialogue-model/runtime/memory/reference-graph.mjs';
import type { LocalClaimView, LocalAct, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { ids, anchors as nativeAnchors, image, memo, profile } from './support/s4-integration/harness.ts';
import { isOpenIssueRerankRecord } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';

// The intersection lets RED exercise the new optional field before contract.ts changes.
type AgreeInput = JevDecisionInput & { agreeNames?: PublicNameCandidate[] };
function input(): AgreeInput {
  return JSON.parse(readFileSync(new URL('./fixtures/bypass-acceptance/MINIMAL-INPUT.json', import.meta.url), 'utf8'));
}
const target = { kind: 'single', figureId: 'own-0' } as const;
function names(v: AgreeInput, action: 'agree' | 'propose_name') {
  return Object.values(buildJevDecisionDetailPayload(v, { action, target })!.questions.name.criteria).map(s => JSON.parse(s).value);
}
function withPublicName(figureId = 'own-0'): AgreeInput {
  const v = input();
  v.publicTurns = [{ turn: 1, speaker: 'human', text: 'Let us call this shape Lantern.' }];
  v.publicNames = [{ name: 'Lantern', figureId, sourceTurn: 1 }];
  v.agreeNames = structuredClone([...v.publicNames]);
  return v;
}

test('(a) K shape: a private construal alone cannot offer stage-one agree', () => {
  const v = { ...input(), agreeNames: [] };
  assert.equal(Object.hasOwn(buildJevDecisionPayload(v).questions.action.criteria, 'agree'), false);
});

test('(b) M extraction-omission wiring fixture: literal name but no eligible claim cannot offer agree', () => {
  // This asserts missing claim wiring, not that the public sentence is not a proposal.
  const v = { ...withPublicName(), agreeNames: [] };
  assert.deepEqual(v.priorClaims, []);
  assert.equal(Object.hasOwn(buildJevDecisionPayload(v).questions.action.criteria, 'agree'), false);
});

test('(c) agree details contain only eligible names for the selected figure', () => {
  const v = withPublicName(), before = structuredClone(v);
  assert.equal(Object.hasOwn(buildJevDecisionPayload(v).questions.action.criteria, 'agree'), true);
  assert.deepEqual(names(v, 'agree'), ['Lantern']);
  assert.throws(() => buildJevDecisionDetailPayload(v, { action: 'agree', target: { kind: 'single', figureId: 'own-1' } }), { code: 'inconsistent_decision' });
  assert.equal(Object.hasOwn(JSON.parse(buildJevDecisionPayload(v).state), 'agreeNames'), false);
  assert.deepEqual(v, before);
});

test('(d) propose_name keeps the private construal and all existing public candidates', () => {
  const v = withPublicName();
  assert.deepEqual(names(v, 'propose_name'), ['name-0', 'Lantern']);
  assert.deepEqual(names({ ...v, agreeNames: [] }, 'propose_name'), ['name-0', 'Lantern']);
});

test('(e) omitted agreeNames preserves the pre-change serialized payload bytes', () => {
  const v = input();
  const payloads = [buildJevDecisionPayload(v), buildJevDecisionDetailPayload(v, { action: 'agree', target }),
    buildJevDecisionDetailPayload(v, { action: 'propose_name', target })];
  // Captured from main 5302bda before implementation; never regenerated in a test.
  assert.deepEqual(payloads.map(p => createHash('sha256').update(JSON.stringify(p)).digest('hex')), [
    '437787ed45d50fa2d58dbda28df9c13eca40287fd3c43121be9626200cac39bb',
    '84cf20b0f40aa5e87082a52bbd15ffcc0bd1d7bfddbe1de22e98ce802e032802',
    '21dabc57a648a179914536819ea5810cf4be1d36a0f93a21873b6672f4c356f9',
  ]);
});

type RuntimeScene = { claims: LocalClaimView[]; text: string; segment?: LocalSegmentProposal; act?: LocalAct; respondsTo?: string };
async function runtimeInput(version?: AdaptiveRepairTrial['version'], proposal = false, multiple = false, scene?: RuntimeScene) {
  const v = input(), captured: AgreeInput[] = [];
  v.ownSlots = v.ownSlots.map((_id, i) => `s-000${i + 1}`);
  v.observations.figures.forEach((f, i) => { f.id = v.ownSlots[i]; f.analytic.composition = '二つの部分が接する'; });
  const anchors = v.ownSlots.map((id, x) => ({ id, bbox: { x: x * 10, y: 0, w: 9, h: 9 }, centroid: { x: x * 10, y: 0 } }));
  const text = scene?.text ?? (proposal ? 'Lanternと呼ぼう' : '形を確認したい');
  const segments = scene ? (scene.segment ? [scene.segment] : []) : proposal ? [{ segmentId: 's1', quote: text,
    targets: multiple ? v.ownSlots.slice(0, 2) : [v.ownSlots[0]], aspect: 'name', proposition: 'Lanternと呼ぶ', name: 'Lantern', linkedIssueId: null, respondsToTurn: null }] : [];
  const dialogue = createDialogueV2({
    client: { async complete(_messages: unknown, options: { phase: string }) {
      return { text: options.phase === 'local_extraction' ? JSON.stringify(segments) : 'なるほど。' };
    } },
    image: { mimeType: 'image/png', base64: 'U1lOVEhFVElDX09XTl9JTUFHRQ==' }, anchors,
    strategy: 'repair-first', referenceMemory: true, decisionMode: 'jev',
    observer: { async observeAll() { return structuredClone(v.observations); }, async reobserve() { throw Error('unused'); } },
    jevDecision: createMockJevDecisionClient(ci => { captured.push(structuredClone(ci)); return { action: 'accept', target: { kind: 'none' }, name: null, feature: null, observe: null }; }),
    localGrounding: { classifier: { async classify(ci: { segments: readonly { segmentId: string }[] }) {
      return ci.segments.map(s => ({ segmentId: s.segmentId, act: scene?.act ?? 'name_propose', respondsToClaimId: scene?.respondsTo ?? null, rawScore: null }));
    } } },
    ...(version ? { technicalTrial: { version } } : {}),
  });
  const state = dialogue.initialPrivateState();
  const events: { id: string; seq: number; speaker: 'human' | 'ai'; text: string }[] = [];
  for (const c of scene?.claims ?? []) {
    events.push({ id: `e${c.sourceTurn}`, seq: c.sourceTurn, speaker: c.speaker, text: c.quote });
    const { turn, ...record } = c;
    state.graph = applyReferenceUpdate(state.graph, { expectedRevision: state.graph.revision, turn,
      operations: [{ kind: 'claim', ...record }] }, { publicTurns: events.map(e => ({ turn: e.seq, speaker: e.speaker, text: e.text })), generationSucceeded: true });
  }
  const turn = (events.at(-1)?.seq ?? 0) + 1;
  events.push({ id: `e${turn}`, seq: turn, speaker: 'human', text });
  await dialogue.runAiTurn({ events, privateState: state, lastEventId: `e${turn}` });
  assert.equal(captured.length, 1);
  return captured[0];
}

test('(f) jev-turn supplies agreeNames only for either technicalTrial version', async () => {
  for (const version of ['adaptive_repair_v1', 'adaptive_repair_v2'] as const) {
    const empty = await runtimeInput(version);
    assert.deepEqual(empty.agreeNames, []);
    const named = await runtimeInput(version, true);
    assert.equal(named.priorClaims[0].act, 'name_propose');
    assert.deepEqual(named.agreeNames, [{ name: 'Lantern', figureId: 's-0001', sourceTurn: 1 }]);
    const ambiguous = await runtimeInput(version, true, true);
    assert.equal(ambiguous.priorClaims[0].targets.length, 2);
    assert.deepEqual(ambiguous.agreeNames, []);
  }
  for (const proposal of [false, true]) assert.equal(Object.hasOwn(await runtimeInput(undefined, proposal), 'agreeNames'), false);
});

function proposalClaim(patch: Partial<LocalClaimView> = {}): LocalClaimView {
  return { id: '1:ai1', turn: 1, sourceTurn: 1, issueId: '1:proposal', targets: ['s-0001'],
    aspect: 'name', act: 'name_propose', proposition: 'Lanternと呼ぶ', name: 'Lantern', speaker: 'ai',
    quote: 'Lanternと呼ぼう', respondsTo: null, source: 'ai_hypothesis', ...patch };
}
function responseSegment(text: string): LocalSegmentProposal {
  return { segmentId: 's1', quote: text, targets: [], aspect: 'name', proposition: '先行の名前への応答',
    name: null, linkedIssueId: '1:proposal', respondsToTurn: 1 };
}
test('A: inherited human name_accept uses the earlier literal public proposal as source', async () => {
  for (const version of ['adaptive_repair_v1', 'adaptive_repair_v2'] as const) {
    const v = await runtimeInput(version, false, false, { claims: [proposalClaim()], text: 'それでいい',
      segment: responseSegment('それでいい'), act: 'name_accept', respondsTo: '1:ai1' });
    assert.equal(v.priorClaims.at(-1)!.act, 'name_accept');
    assert.equal(v.priorClaims.at(-1)!.name, 'Lantern');
    assert.equal(v.priorClaims.at(-1)!.sourceTurn, 2);
    assert.deepEqual(v.agreeNames, [{ name: 'Lantern', figureId: 's-0001', sourceTurn: 1 }]);
  }
});
test('A: name_accept by AI also remains eligible; the earliest literal source is retained', async () => {
  const first = proposalClaim({ speaker: 'human', source: 'partner_statement' });
  const second = proposalClaim({ id: '2:accepted', turn: 2, sourceTurn: 2, act: 'name_accept', quote: 'それでいい', respondsTo: first.id });
  const v = await runtimeInput('adaptive_repair_v2', false, false, { claims: [first, second], text: '続けよう' });
  assert.deepEqual(v.agreeNames, [1, 1].map(sourceTurn => ({ name: 'Lantern', figureId: 's-0001', sourceTurn })));
});
for (const scenario of ['ai_only', 'construal', 'name_reject', 'empty_targets', 'multiple_targets'] as const) {
  test(`A: ${scenario} cannot supply agree candidates`, async () => {
    const claims = scenario === 'construal' ? [proposalClaim({ aspect: 'construal', act: 'construe', name: null, speaker: 'human', source: 'partner_statement' })]
      : scenario === 'empty_targets' || scenario === 'multiple_targets' ? [proposalClaim({ speaker: 'human', source: 'partner_statement', targets: scenario === 'empty_targets' ? [] : ['s-0001', 's-0002'] })]
      : [proposalClaim()];
    const scene: RuntimeScene = { claims, text: '続けよう' };
    if (scenario === 'name_reject') Object.assign(scene, { text: 'その名前はやめよう', segment: responseSegment('その名前はやめよう'), act: 'name_reject', respondsTo: '1:ai1' });
    const v = await runtimeInput('adaptive_repair_v2', false, false, scene);
    assert.ok(v.priorClaims.length > 0);
    if (scenario === 'name_reject') assert.equal(v.priorClaims.at(-1)!.act, 'name_reject');
    assert.deepEqual(v.agreeNames, []);
  });
}

function nativeClient() {
  return createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-i141-local-only',
    fetchImpl: async (_url, init) => {
      const p = JSON.parse(String(init?.body)) as JevDecisionPayload;
      return Response.json({ model: JEV_DECISION_MODEL, id: 'gen-i141-synthetic', usage: { cost: 0 },
        answers: Object.fromEntries(Object.entries(p.questions).map(([key, q]) => {
          const labels = Object.keys(q.criteria);
          const choice = key === 'action' ? 'defer' : key === 'target' ? 'figure_0' : key.startsWith('candidate_') ? 'exclude' : labels[0];
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label,
            key === 'action' ? ({ defer: 1, agree: 0.9, propose_name: 0.8, accept: 0.1 }[label] ?? 0) : Number(label === choice)])) }];
        })) });
    } })!;
}

test('(g) veto rerank excludes agree without selected-figure candidates; bypass-enabled adopts unchanged', async () => {
  for (const v of [{ ...input(), agreeNames: [] }, withPublicName('own-1')]) {
    const c = nativeClient(), original = await c.decide(v);
    for (const rerank of ['saved_action_scores_v1', 'open_issue_v1'] as const) {
      const plan = planBypassAcceptance(v, original, interventionForStrategy('repair-first'), { rerank });
      assert.equal(plan.rerank!.ranking.some(r => r.action === 'agree'), false);
      assert.equal(plan.rerank!.selected!.action, 'propose_name');
      const result = await applyBypassAcceptance(v, original, interventionForStrategy('repair-first'), c.completeDetail, { rerank });
      assert.equal(result.executed.action, 'propose_name');
      assert.equal(result.executed.name, 'name-0');
      const adopted = await applyBypassAcceptance(v, original, interventionForStrategy('bypass-enabled'), c.completeDetail, { rerank });
      assert.equal(adopted.executed.action, 'defer');
      assert.equal(adopted.intervention.rerank, null);
    }
  }
});

test('executed agree details accept the optional input and use only its public name', async () => {
  const v = withPublicName(), c = nativeClient();
  const detail = await c.completeDetail(v, { action: 'agree', target });
  assert.equal(detail.executed.name, 'Lantern');
});

test('agreeNames receives the same source/span and size validation as publicNames', () => {
  const v = input();
  for (const agreeNames of [[{ name: 'unpublished', figureId: 'own-0', sourceTurn: 1 }],
    [{ name: 'shape', figureId: 'foreign', sourceTurn: 1 }],
    [{ name: 'shape', figureId: 'own-0', sourceTurn: 0 }], Array(4097).fill({ name: 'shape', figureId: 'own-0', sourceTurn: 1 }), null]) {
    assert.throws(() => buildJevDecisionPayload({ ...v, agreeNames } as AgreeInput), { code: 'invalid_input' });
  }
});

async function savedRuntime(version: AdaptiveRepairTrial['version'] | undefined, strategy: 'repair-first' | 'bypass-enabled',
  { openIssue = false, namedFigure }: { openIssue?: boolean; namedFigure?: string } = {}) {
  const inputs: AgreeInput[] = [], wire: JevDecisionPayload[] = [];
  const core = createJevDecisionClient({ enabled: true, readKey: async () => 'sk-or-SYNTHETIC-i141-restore-only',
    timeoutMs: 1000, researchLimits: { maxDeadlineMs: 600000 }, fetchImpl: async (_url, init) => {
      const p = JSON.parse(String(init?.body)) as JevDecisionPayload; wire.push(p);
      return Response.json({ model: JEV_DECISION_MODEL, id: `gen-i141-restore-${wire.length}`, usage: { cost: 0 },
        answers: Object.fromEntries(Object.entries(p.questions).map(([key, q]) => {
          const labels = Object.keys(q.criteria), choice = key === 'action' ? 'move_on' : key === 'target' ? 'figure_0'
            : key === 'repair_issue' ? 'issue_0' : key.startsWith('candidate_') ? 'exclude' : labels[0];
          const scores: Record<string, number> = { move_on: 1, propose_name: 0.8, confirm: 0.7, accept: 0.1 };
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, key === 'action' ? scores[label] ?? 0 : Number(label === choice)])) }];
        })) });
    } })!;
  const runtime = createProfileDialogue(profile(), { strategy, image, anchors: nativeAnchors, referenceMemory: true, decisionMode: 'jev',
    client: { async complete(_messages: unknown, options: { phase: string }) { return { text: ['local_extraction', 'ai_extraction'].includes(options.phase) ? '[]' : 'Control.' }; } },
    observer: { async observeAll() { return validateObservationMemo(memo()); }, async reobserve() { throw Error('unused'); } },
    jevDecision: { async decide(v, options) { inputs.push(structuredClone(v)); return core.decide(v, options); },
      completeDetail: core.completeDetail, ...(openIssue ? { estimateRepairProspect: core.estimateRepairProspect } : {}) },
    localGrounding: { classifier: { async classify() { return []; } } },
    ...(version ? { technicalTrial: { version } } : {}),
  });
  const state = runtime.initialPrivateState();
  const events = [{ id: 'e1', seq: 1, speaker: 'human', text: 'Control?' }];
  if (namedFigure) {
    events[0].text = 'Lanternと呼ぼう';
    const { turn, ...claim } = proposalClaim({ targets: [namedFigure], speaker: 'human', source: 'partner_statement' });
    state.graph = applyReferenceUpdate(state.graph, { expectedRevision: state.graph.revision, turn,
      operations: [{ kind: 'claim', ...claim }] }, { publicTurns: [{ turn: 1, speaker: 'human', text: events[0].text }], generationSucceeded: true });
  }
  if (openIssue || namedFigure) {
    events.push({ id: 'e2', seq: 2, speaker: 'ai', text: 'Which part do you mean?' }, { id: 'e3', seq: 3, speaker: 'human', text: 'Let us go on.' });
  }
  if (openIssue) state.repairHistory = [{ turn: 2, issueId: null, action: 'repair', question: 'control-feature', partnerClaims: [],
    candidatesBefore: [ids[2]], candidatesAfter: [ids[2]], addedClaimIds: [], removedClaimIds: [], progress: 'unchanged' }];
  const result = await runtime.runAiTurn({ events, privateState: state, lastEventId: events.at(-1)!.id, requestSeq: events.at(-1)!.seq });
  return { runtime, inputs, wire, saved: JSON.parse(JSON.stringify(result.privateState)) };
}

for (const version of ['adaptive_repair_v1', 'adaptive_repair_v2'] as const) {
  for (const strategy of ['repair-first', 'bypass-enabled'] as const) {
    test(`B: ${version}/${strategy} saves restricted native evidence and survives JSON/restore`, async () => {
      const { runtime, inputs, wire, saved } = await savedRuntime(version, strategy), z = saved.judgments[0].jevTurn;
      const actionWire = wire.find(p => p.questions.action)!;
      assert.equal(Object.hasOwn(actionWire.questions.action.criteria, 'agree'), false);
      assert.deepEqual(z.agreeNames, inputs.at(-1)!.agreeNames);
      assert.deepEqual(z.agreeNames, []);
      assert.equal(Object.hasOwn(z.decision.evidence.stages[0].scores.action, 'agree'), false);
      if (strategy === 'repair-first') {
        assert.equal(z.intervention.rerank.policyId, 'saved_action_scores_v1');
        assert.equal(z.intervention.rerank.ranking.some((r: { action: string }) => r.action === 'agree'), false);
        assert.equal(z.intervention.rerank.ranking.some((r: { action: string }) => r.action === 'propose_name'), true);
      }
      assert.deepEqual(validateJevPrivateStateV2(saved, ids, interventionForStrategy(strategy)), saved);
      assert.deepEqual(runtime.snapshotGraph(saved), snapshotReferenceGraph(saved.graph));
      for (const tamper of [(s: any) => { delete s.judgments[0].jevTurn.agreeNames; },
        (s: any) => { s.judgments[0].jevTurn.agreeNames = [{ name: 'Lantern', figureId: ids[0], sourceTurn: 1 }]; },
        (s: any) => { delete s.judgments[0].jevTurn.decision.evidence.stages[0].scores.action.confirm; delete s.judgments[0].jevTurn.decision.evidence.scores.action.confirm; }]) {
        const bad = structuredClone(saved); tamper(bad);
        assert.throws(() => validateJevPrivateStateV2(bad, ids, interventionForStrategy(strategy)), { code: 'invalid_state' });
        assert.throws(() => runtime.snapshotGraph(bad), { code: 'invalid_state' });
      }
    });
  }
}

test('B: a name on another figure preserves agree scores but permits a target-scoped rerank omission', async () => {
  const { saved, runtime } = await savedRuntime('adaptive_repair_v2', 'repair-first', { namedFigure: ids[1] }), z = saved.judgments[0].jevTurn;
  assert.deepEqual(z.agreeNames, [{ name: 'Lantern', figureId: ids[1], sourceTurn: 1 }]);
  assert.equal(Object.hasOwn(z.decision.evidence.stages[0].scores.action, 'agree'), true);
  assert.equal(z.intervention.rerank.ranking.some((r: { action: string }) => r.action === 'agree'), false);
  assert.equal(z.intervention.rerank.ranking.some((r: { action: string }) => r.action === 'propose_name'), true);
  assert.deepEqual(validateJevPrivateStateV2(saved, ids, interventionForStrategy('repair-first')), saved);
  assert.deepEqual(runtime.snapshotGraph(saved), snapshotReferenceGraph(saved.graph));
  for (const tamper of [(s: any) => { delete s.judgments[0].jevTurn.agreeNames; },
    (s: any) => { s.judgments[0].jevTurn.agreeNames[0].figureId = ids[0]; }]) {
    const bad = structuredClone(saved); tamper(bad);
    assert.throws(() => validateJevPrivateStateV2(bad, ids, interventionForStrategy('repair-first')), { code: 'invalid_state' });
  }
});

test('B: the real open-issue route accepts missing agree only with persisted eligibility evidence', async () => {
  const { saved, runtime } = await savedRuntime('adaptive_repair_v2', 'repair-first', { openIssue: true }), z = saved.judgments[0].jevTurn;
  assert.deepEqual(z.agreeNames, []);
  assert.equal(z.intervention.rerank.policyId, 'saved_action_scores_open_issue_v1');
  assert.equal(z.repairProspect.issue.choice, 'issue');
  assert.equal(z.executed.action, 'confirm');
  assert.deepEqual(z.executed.target, { kind: 'single', figureId: ids[2] });
  assert.deepEqual(validateJevPrivateStateV2(saved, ids, interventionForStrategy('repair-first')), saved);
  assert.deepEqual(runtime.snapshotGraph(saved), snapshotReferenceGraph(saved.graph));
  type Proof = typeof isOpenIssueRerankRecord & ((t: unknown, d: unknown, e: unknown, slots: readonly string[], previous: null, agreeNames: PublicNameCandidate[]) => boolean);
  const check = isOpenIssueRerankRecord as Proof;
  assert.equal(check(z.intervention, z.decision, z.executed, ids, null, []), true);
  assert.equal(check(z.intervention, z.decision, z.executed, ids, null), false);
  assert.equal(check(z.intervention, z.decision, z.executed, ids, null, [{ name: 'Lantern', figureId: ids[0], sourceTurn: 1 }]), false);
  const bad = structuredClone(saved); delete bad.judgments[0].jevTurn.agreeNames;
  assert.throws(() => validateJevPrivateStateV2(bad, ids, interventionForStrategy('repair-first')), { code: 'invalid_state' });
});

test('B: default native saved state has no eligibility field and retains the original score contract', async () => {
  const { saved, runtime } = await savedRuntime(undefined, 'repair-first'), z = saved.judgments[0].jevTurn;
  assert.equal(Object.hasOwn(z, 'agreeNames'), false);
  assert.equal(Object.hasOwn(z.decision.evidence.stages[0].scores.action, 'agree'), true);
  assert.deepEqual(validateJevPrivateStateV2(saved, ids, interventionForStrategy('repair-first')), saved);
  assert.deepEqual(runtime.snapshotGraph(saved), snapshotReferenceGraph(saved.graph));
});
