import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionForStrategy, isOpenIssueRerankRecord } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { buildJevDecisionDetailPayload, createJevDecisionClient, JEV_DECISION_MODEL } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevAction, JevDecisionInput, RepairHistoryEntry } from '../dialogue-model/runtime/decision/contract.ts';
import type { LocalAct, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';
import { createJevTurnRuntime, validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { anchors, ids, image, memo } from './support/s4-integration/harness.ts';

const V3 = { questionLayout: 'two_stage_v3' } as const;
const UNRELATED_NAME = '灯台';
const NEW_NAME = '風車';
const single = (index: number) => ({ kind: 'single' as const, figureId: ids[index] });
type Segment = Omit<LocalSegmentProposal, 'segmentId' | 'linkedIssueId' | 'respondsToTurn'> & { act: LocalAct };
type Plan = {
  action: JevAction;
  target?: number;
  name?: string;
  drafts: string[];
  segments?: Segment[];
  prospect?: 'uncertain' | 'no_open_issue';
};

function fixture(strategy: 'bypass-enabled' | 'repair-first' = 'bypass-enabled') {
  const intervention = interventionForStrategy(strategy);
  const inputs: JevDecisionInput[] = [];
  const wire: JevDecisionPayload[] = [];
  const events: Parameters<ReturnType<typeof createJevTurnRuntime>['runAiTurn']>[0]['events'] = [];
  let plan: Plan;
  let drafts: string[];
  const native = createJevDecisionClient({ ...V3, enabled: true, readKey: async () => 'sk-or-SYNTHETIC-rootcause-regression-key',
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init.body)) as JevDecisionPayload;
      wire.push(request);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        const labels = Object.keys(question.criteria);
        const choice = key === 'action' ? plan.action
          : key === 'target' ? (plan.target === undefined ? 'none' : `figure_${plan.target}`)
          : key === 'repair_issue' ? (plan.prospect ? 'issue_0' : 'none')
          : key === 'prospect' ? plan.prospect ?? 'uncertain'
          : key === 'human_referent' ? (plan.target === undefined ? 'none' : `figure_${plan.target}`)
          : key === 'name' && plan.name ? labels.find(label => JSON.parse(question.criteria[label]).value === plan.name)
          : labels[0];
        assert.ok(choice && labels.includes(choice), `scripted answer is unavailable for ${key}`);
        const probabilities = Object.fromEntries(labels.map(label => [label,
          label === choice ? 1 : key === 'action' && label === 'confirm' ? 0.8 : 0]));
        return [key, { type: 'choice', choice, probabilities }];
      }));
      return Response.json({ model: JEV_DECISION_MODEL, id: `gen-rootcause-${wire.length}`, usage: { cost: 0 }, answers });
    },
  })!;
  const runtime = createJevTurnRuntime({
    ...V3, intervention, decisionTimeoutMs: 3000,
    ...(strategy === 'repair-first' ? { technicalTrial: { version: 'adaptive_repair_v3' as const } } : {}),
    ownAnchors: anchors, ownImage: { ...image, mimeType: 'image/png' }, maxReobservations: 0,
    observer: { async observeAll() { return validateObservationMemo(memo()); }, async reobserve() { throw Error('no reobservation expected'); } },
    jevDecision: {
      async decide(input, options) { inputs.push(structuredClone(input)); return native.decide(input, options); },
      estimateReferent: native.estimateReferent, estimateRepairProspect: native.estimateRepairProspect, completeDetail: native.completeDetail,
    },
    localGrounding: { classifier: {
      async classify({ segments, priorClaims }) {
        return segments.map(({ segmentId }, index) => {
          const act = plan.segments![index].act;
          const antecedentAct = act === 'deny' ? 'name_accept' : act === 'name_accept' ? 'name_propose' : null;
          const antecedent = antecedentAct && priorClaims.find(c => c.speaker === 'ai' && c.act === antecedentAct);
          return { segmentId, act, respondsToClaimId: antecedent?.id ?? null, rawScore: null };
        });
      },
    } },
    client: {
      async complete(_messages, { phase }) {
        if (phase === 'local_extraction') return { text: JSON.stringify((plan.segments ?? []).map(({ act, ...segment }, index) => ({
          ...segment, segmentId: `segment-${index}`, linkedIssueId: null,
          respondsToTurn: act === 'deny' || act === 'name_accept' ? events.at(-2)!.seq : null,
        }))) };
        assert.equal(phase, 'generation');
        const text = drafts.shift();
        assert.notEqual(text, undefined, 'unexpected additional generation');
        return { text: text! };
      },
    },
    generation: { task: '共同命名', instructions: '公開の返答を書いてください。', actionScope: {}, final: '', timeoutMs: 3000 },
  });
  let state = runtime.initialPrivateState();
  async function exchange(text: string, next: Plan) {
    plan = next;
    drafts = [...plan.drafts];
    const seq = events.length + 1, id = `human-${seq}`, start = wire.length;
    events.push({ id, seq, text, speaker: 'human' });
    const result = await runtime.runAiTurn({ events, privateState: state, lastEventId: id, requestSeq: seq });
    state = result.privateState;
    events.push({ id: `ai-${seq + 1}`, seq: seq + 1, text: result.text, speaker: 'ai' });
    return { input: inputs.at(-1)!, requests: wire.slice(start), text: result.text, state,
      trace: runtime.getAttempts().at(-1)!, saved: state.judgments.at(-1)!.jevTurn };
  }
  return { exchange, state: () => state, attempt: () => runtime.getAttempts().at(-1), intervention };
}

function naming(quote: string, name: string, targets: string[] = [], act: LocalAct = 'name_propose'): Segment {
  return { quote, name, targets, act, aspect: 'name', proposition: quote };
}
const agreeSpeech = (name: string) => `はい、この形は「${name}」と呼びましょう。`;
async function agreedFixture() {
  const f = fixture();
  const quote = `この形を「${UNRELATED_NAME}」と呼びましょう。`;
  await f.exchange(quote, { action: 'agree', target: 0, drafts: [agreeSpeech(UNRELATED_NAME)], segments: [naming(quote, UNRELATED_NAME, [ids[0]])] });
  return f;
}

test('v3 stages and publication bind an unbound polite naming proposal to an unagreed figure', async () => {
  const f = await agreedFixture();
  const quote = `では、この形を「${NEW_NAME}」と呼んでもいいですか？`;
  const next = await f.exchange(quote, { action: 'agree', target: 3, drafts: [agreeSpeech(NEW_NAME)], segments: [naming(quote, NEW_NAME)] });
  assert.equal(next.input.priorClaims.find(c => c.name === NEW_NAME)?.act, 'name_propose');
  assert.ok(next.input.publicNames.some(c => c.name === UNRELATED_NAME), 'old public evidence is retained');
  assert.deepEqual(next.input.agreeNames, ids.slice(1).map(figureId => ({ name: NEW_NAME, figureId, sourceTurn: 3 })));
  assert.deepEqual(Object.keys(next.requests.find(r => r.questions.target)!.questions.target.criteria), ['figure_1', 'figure_2', 'figure_3', 'figure_4', 'figure_5']);
  assert.deepEqual(next.saved.executed?.target, single(3));
  assert.equal(next.text, agreeSpeech(NEW_NAME));
  assert.deepEqual(next.state.ledger[ids[3]], { status: 'agreed', name: NEW_NAME });
  assert.deepEqual(next.state.ledger[ids[0]], { status: 'agreed', name: UNRELATED_NAME });
  assert.deepEqual(validateJevPrivateStateV2(next.state, ids, f.intervention, V3.questionLayout), next.state);
  const changed = structuredClone(next.state);
  changed.judgments.at(-1)!.jevTurn.agreeNames!.find(n => n.figureId === ids[3])!.name = UNRELATED_NAME;
  assert.throws(() => validateJevPrivateStateV2(changed, ids, f.intervention, V3.questionLayout), { code: 'invalid_state' });
  const moreTargets = structuredClone(next.state);
  moreTargets.judgments.at(-1)!.jevTurn.decision.evidence.stages![1].scores.target.figure_0 = 0;
  assert.throws(() => validateJevPrivateStateV2(moreTargets, ids, f.intervention, V3.questionLayout), { code: 'invalid_state' });
});

test('v3 respects ledger naming constraints across agreed and deferred slots', async () => {
  const f = await agreedFixture();
  const sameName = `この形も「${UNRELATED_NAME}」でいいですか？`;
  const same = await f.exchange(sameName, { action: 'accept', drafts: ['似た印象なんですね。'],
    segments: [naming(sameName, UNRELATED_NAME)] });
  assert.deepEqual(same.input.agreeNames, []);

  await f.exchange('この形の呼び名を見直しましょう。', { action: 'defer', target: 0, drafts: ['この名前はあとで考えましょう。'] });
  const differentName = `こちらの形は「${NEW_NAME}」でどうですか？`;
  const changed = await f.exchange(differentName, { action: 'accept', drafts: ['そう見えますね。'],
    segments: [naming(differentName, NEW_NAME, [ids[0]])] });
  assert.deepEqual(changed.input.agreeNames, []);

  const original = `やはり「${UNRELATED_NAME}」でどうですか？`;
  const resumed = await f.exchange(original, { action: 'accept', drafts: ['元の呼び名の話ですね。'], segments: [naming(original, UNRELATED_NAME)] });
  assert.deepEqual(resumed.input.agreeNames, [{ name: UNRELATED_NAME, figureId: ids[0], sourceTurn: resumed.input.turn }]);
});

test('v3 a move_on boundary retires the old bound proposal even when its ledger entry is tentative', async () => {
  const f = fixture();
  const old = `この形は「${UNRELATED_NAME}」でどうですか？`;
  await f.exchange(old, { action: 'propose_name', target: 0, name: UNRELATED_NAME, drafts: [`「${UNRELATED_NAME}」という呼び名はどうですか？`],
    segments: [naming(old, UNRELATED_NAME, [ids[0]])] });
  await f.exchange('次の形を見ましょう。', { action: 'move_on', target: 3, drafts: ['細長い形を見ましょう。'] });
  const proposal = `こちらの形は「${NEW_NAME}」でどうですか？`;
  const current = await f.exchange(proposal, { action: 'agree', target: 3, drafts: [agreeSpeech(NEW_NAME)], segments: [naming(proposal, NEW_NAME)] });
  assert.ok(current.input.priorClaims.some(c => c.name === UNRELATED_NAME && c.targets.includes(ids[0])));
  assert.deepEqual(current.input.agreeNames, ids.map(figureId => ({ figureId, name: NEW_NAME, sourceTurn: current.input.turn })));
  assert.deepEqual(current.state.ledger[ids[0]], { status: 'tentative', name: UNRELATED_NAME });
  assert.deepEqual(current.state.ledger[ids[3]], { status: 'agreed', name: NEW_NAME });
});

for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  for (const target of [3, undefined]) test(`v3 ${strategy} replaces older naming evidence after accept(${target ?? 'none'})`, async () => {
    const f = fixture(strategy);
    const old = `この形を「${NEW_NAME}」と呼びましょうか？`;
    await f.exchange(old, { action: 'propose_name', target: 2, name: NEW_NAME, drafts: [old],
      segments: [naming(old, NEW_NAME, [ids[2]])] });

    const confirmation = `はい、「${NEW_NAME}」でいきましょう。`;
    const question = '次の細長い形はどうですか？';
    const moved = await f.exchange(confirmation + question, { action: 'accept', target, drafts: ['細長い形の話ですね。'],
      segments: [naming(confirmation, NEW_NAME, [ids[2]], 'name_accept'),
        { quote: question, targets: [ids[3]], aspect: 'question', proposition: question, name: null, act: 'ask' }] });
    assert.ok(moved.input.priorClaims.some(c => c.sourceTurn === 3 && c.act === 'name_accept' && c.name === NEW_NAME));
    assert.deepEqual(moved.saved.executed?.target, target === undefined ? { kind: 'none' } : single(target));

    const name = '時計';
    const proposal = `この形を「${name}」と呼んでもいいですか？`;
    const next = await f.exchange(proposal, { action: 'agree', target: 3, drafts: [agreeSpeech(name)], segments: [naming(proposal, name)] });
    assert.deepEqual(next.input.agreeNames, ids.map(figureId => ({ name, figureId, sourceTurn: 5 })));
    assert.equal(next.saved.executed?.name, name);
    assert.deepEqual(next.state.ledger[ids[2]], { status: 'tentative', name: NEW_NAME });
  });
}

test('v3 moving focus with accept expires a bound proposal before another name is proposed', async () => {
  const f = fixture();
  const proposal = `この形を「${NEW_NAME}」と呼びましょうか？`;
  await f.exchange(proposal, { action: 'accept', target: 3, drafts: ['細長い形から見ますね。'],
    segments: [naming(proposal, NEW_NAME, [ids[2]])] });
  const next = await f.exchange('この形はどう見えますか？', { action: 'accept', target: 3, drafts: ['丸みがある形ですね。'] });
  assert.ok(next.input.priorClaims.some(c => c.name === NEW_NAME));
  assert.deepEqual(next.input.agreeNames, []);
});

for (const target of [2, undefined]) test(`v3 keeps a bound proposal after accept(${target ?? 'none'}) without a competing name`, async () => {
  const f = fixture();
  const proposal = `この形を「${NEW_NAME}」と呼びましょうか？`;
  await f.exchange(proposal, { action: 'accept', target, drafts: ['その形ですね。'], segments: [naming(proposal, NEW_NAME, [ids[2]])] });
  const next = await f.exchange('はい、それにしましょう。', { action: 'agree', target: 2, drafts: [agreeSpeech(NEW_NAME)] });
  assert.deepEqual(next.input.agreeNames, [{ name: NEW_NAME, figureId: ids[2], sourceTurn: 1 }]);
  assert.deepEqual(next.state.ledger[ids[2]], { status: 'agreed', name: NEW_NAME });
});

test('v3 preserves both names proposed in the same turn until one is chosen', async () => {
  const f = fixture();
  const first = `「${NEW_NAME}」と呼びましょうか？`, second = 'あるいは「水車」でもよさそうです。';
  await f.exchange(first + second, { action: 'accept', target: 2, drafts: ['二つの呼び方が出ましたね。'],
    segments: [naming(first, NEW_NAME, [ids[2]]), naming(second, '水車', [ids[2]])] });
  const next = await f.exchange('先ほどの案でいきましょう。', { action: 'agree', target: 2, name: NEW_NAME, drafts: [agreeSpeech(NEW_NAME)] });
  assert.deepEqual(next.input.agreeNames?.map(n => n.name), [NEW_NAME, '水車']);
});

test('v3 an agreed slot never offers its prior alias or a new bound rename', async () => {
  const f = fixture();
  const first = `この形は「${UNRELATED_NAME}」でどうですか？`;
  await f.exchange(first, { action: 'accept', drafts: ['そう見えますね。'], segments: [naming(first, UNRELATED_NAME, [ids[0]])] });
  const chosen = `この形は「${NEW_NAME}」でどうですか？`;
  await f.exchange(chosen, { action: 'agree', target: 0, name: NEW_NAME, drafts: [agreeSpeech(NEW_NAME)],
    segments: [naming(chosen, NEW_NAME, [ids[0]])] });
  const rename = 'この形を「水車」と呼びましょうか？';
  const next = await f.exchange(rename, { action: 'accept', drafts: ['同じ形の話ですね。'], segments: [naming(rename, '水車', [ids[0]])] });
  assert.ok(next.input.priorClaims.some(c => c.name === UNRELATED_NAME && c.targets.includes(ids[0])));
  assert.deepEqual(next.input.agreeNames, []);
  assert.equal(Object.hasOwn(next.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'), false);
  assert.deepEqual(next.state.ledger[ids[0]], { status: 'agreed', name: NEW_NAME });
});

test('v3 asking whether a name is in use offers no agree action', async () => {
  const f = fixture();
  const question = `「${UNRELATED_NAME}」という名前はもう使っていますか？`;
  const result = await f.exchange(question, { action: 'accept', drafts: ['まだ使っていません。'],
    segments: [naming(question, UNRELATED_NAME, [], 'ask')] });
  assert.equal(result.input.priorClaims.find(c => c.name === UNRELATED_NAME)?.act, 'ask');
  assert.deepEqual(result.input.agreeNames, []);
  assert.equal(Object.hasOwn(result.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'), false);
});

test('v3 keeps an unbound proposal through a confirmation, and drops it once the topic moves on', async () => {
  const quote = `この形を「${NEW_NAME}」で決めてもいいですか？`;
  const proposal = [naming(quote, NEW_NAME)];
  const f = await agreedFixture();
  await f.exchange(quote, { action: 'confirm', target: 2, drafts: ['二つの部分がつながっていますか？'], segments: proposal });
  const agreed = await f.exchange('はい、その形です。', { action: 'agree', target: 2, drafts: [agreeSpeech(NEW_NAME)] });
  assert.equal(agreed.saved.executed?.name, NEW_NAME);
  assert.equal(agreed.input.agreeNames?.find(n => n.figureId === ids[2])?.sourceTurn, 3);

  const moved = await agreedFixture();
  await moved.exchange(quote, { action: 'move_on', target: 4, drafts: ['別の形を見ましょう。'], segments: proposal });
  const next = await moved.exchange('もう一つの形について話しましょう。', { action: 'accept', drafts: ['そう見えるのですね。'] });
  assert.deepEqual(next.input.agreeNames, []);
  assert.ok(!Object.hasOwn(next.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'));
});

test('v3 rewrites a mismatched agree and rejects two mismatched drafts without a ledger commit', async () => {
  const f = await agreedFixture();
  const quote = `この形は「${NEW_NAME}」でいいですか？`;
  const plan = { action: 'agree', target: 3, segments: [naming(quote, NEW_NAME)] } satisfies Omit<Plan, 'drafts'>;
  const result = await f.exchange(quote, { ...plan, drafts: [agreeSpeech(UNRELATED_NAME), agreeSpeech(NEW_NAME)] });
  assert.equal(result.text, agreeSpeech(NEW_NAME));
  assert.deepEqual(result.trace.generationGuard, { violations: ['name_not_shown'], regenerated: true, fallback: false });

  const denied = await agreedFixture();
  const previous = structuredClone(denied.state());
  await assert.rejects(denied.exchange(quote, { ...plan, drafts: [agreeSpeech(UNRELATED_NAME), 'はい、それで決まりです。'] }), { code: 'unsafe_generation' });
  assert.deepEqual(denied.state(), previous);
  assert.equal(denied.attempt()?.publicSpeech, null);
});

test('v3 mentioning the chosen name while adopting another triggers regeneration', async () => {
  const quote = `この形は「${UNRELATED_NAME}」でいいですか？`;
  const plan = { action: 'agree', target: 3, segments: [naming(quote, UNRELATED_NAME)] } satisfies Omit<Plan, 'drafts'>;
  const mention = `前の形が「${UNRELATED_NAME}」でしたね。`;
  const mismatch = mention + `この形は「${NEW_NAME}」と呼びましょう。`;

  for (const draft of [mismatch, mention + `この形の名前は「${NEW_NAME}」に決めました。`, mention + `この形の名前は「${NEW_NAME}」です。`]) {
    const corrected = await fixture().exchange(quote, { ...plan, drafts: [draft, agreeSpeech(UNRELATED_NAME)] });
    assert.deepEqual(corrected.trace.generationGuard, { violations: ['name_mismatch'], regenerated: true, fallback: false }, draft);
    assert.equal(corrected.text, agreeSpeech(UNRELATED_NAME));
    assert.deepEqual(corrected.state.ledger[ids[3]], { status: 'agreed', name: UNRELATED_NAME });
  }

  const denied = fixture();
  const previous = structuredClone(denied.state());
  await assert.rejects(denied.exchange(quote, { ...plan, drafts: [mismatch, mismatch] }), { code: 'unsafe_generation' });
  assert.deepEqual(denied.state(), previous);
  assert.equal(denied.attempt()?.publicSpeech, null);
  assert.deepEqual(denied.attempt()?.generationGuard.violations, ['name_mismatch']);
});

test('v3 a public denial plus an unbound replacement reaches an agree on the new figure', async () => {
  const f = await agreedFixture();
  const denial = `その形には「${UNRELATED_NAME}」は違います。`;
  const replacement = `この形は「${NEW_NAME}」でいいですか？`;
  const result = await f.exchange(denial + replacement, { action: 'agree', target: 4, drafts: [agreeSpeech(NEW_NAME)],
    segments: [naming(denial, UNRELATED_NAME, [ids[0]], 'deny'), naming(replacement, NEW_NAME)] });
  assert.ok(result.input.priorClaims.some(c => c.act === 'deny' && c.name === UNRELATED_NAME));
  assert.ok(result.input.agreeNames!.every(n => n.name === NEW_NAME && n.figureId !== ids[0]));
  assert.equal(result.trace.publicSpeech, agreeSpeech(NEW_NAME));
  assert.deepEqual(result.state.ledger[ids[4]], { status: 'agreed', name: NEW_NAME });
});

async function vetoedMove(prospect: Plan['prospect']) {
  const f = fixture('repair-first');
  await f.exchange('尖っている部分はどこですか？', { action: 'confirm', target: 0, drafts: ['小さい部分のほうですか？'] });
  const result = await f.exchange('次は細長い形を見てください。', { action: 'move_on', target: 3, prospect,
    drafts: ['二つの部分がつながった形ですか？'] });
  return { ...result, intervention: f.intervention };
}

test('v3 no_open_issue ignores a stale issue pick and keeps the original veto target', async () => {
  const result = await vetoedMove('no_open_issue');
  assert.equal(result.saved.repairProspect?.issue?.choice, 'issue');
  assert.equal(result.saved.repairProspect?.prospect, 'no_open_issue');
  assert.match(result.requests.find(r => r.questions.repair_issue)!.questions.repair_issue.instructions, /no_open_issue.*none/);
  assert.equal(result.saved.intervention?.rerank?.policyId, 'saved_action_scores_v1');
  assert.deepEqual(result.saved.executed?.target, single(3));
  assert.deepEqual(validateJevPrivateStateV2(result.state, ids, result.intervention, V3.questionLayout), result.state);
});

test('v3 restores legacy no_open_issue reranks and verifies their recorded issue provenance', async () => {
  const control = await vetoedMove('uncertain');
  assert.equal(control.saved.intervention?.rerank?.policyId, 'saved_action_scores_open_issue_v1');
  assert.deepEqual(control.saved.executed?.target, single(0));
  const legacy = structuredClone(control.state);
  const saved = legacy.judgments.at(-1)!.jevTurn;
  assert.ok(saved.repairProspect?.status === 'ok' && saved.repairProspect.issue.choice === 'issue');
  saved.repairProspect.prospect = 'no_open_issue';
  saved.repairProspect.scores.prospect = { progressing: 0, stalled: 0, uncertain: 0, no_open_issue: 1 };
  assert.equal(isOpenIssueRerankRecord(saved.intervention, saved.decision, saved.executed, ids, control.input.previousAction,
    saved.agreeNames, V3.questionLayout, saved.repairProspect), true);
  assert.deepEqual(validateJevPrivateStateV2(legacy, ids, control.intervention, V3.questionLayout), legacy);
  for (const issue of [{ choice: 'none' }, { ...saved.repairProspect.issue, issueId: '1:forged' }] as const) {
    const forged = structuredClone(legacy);
    const evidence = forged.judgments.at(-1)!.jevTurn;
    assert.ok(evidence.repairProspect?.status === 'ok');
    evidence.repairProspect.issue = issue;
    assert.equal(isOpenIssueRerankRecord(evidence.intervention, evidence.decision, evidence.executed, ids, control.input.previousAction,
      evidence.agreeNames, V3.questionLayout, evidence.repairProspect), false);
    assert.throws(() => validateJevPrivateStateV2(forged, ids, control.intervention, V3.questionLayout), { code: 'invalid_state' });
  }
});

test('v3 confirm offers a different feature when the previous and answered recent features are available', async () => {
  const f = fixture();
  await f.exchange('細長い形のことです。', { action: 'confirm', target: 2, drafts: ['小さい部分がありますか？'] });
  const confirm = await f.exchange('そちらの形ですか？', { action: 'confirm', target: 2, drafts: ['二つの部分がつながっていますか？'] });
  assert.equal(confirm.saved.executed?.feature, 'control composition');
  const input = structuredClone(confirm.input);
  const ask = { action: 'confirm', target: single(2) } as const;
  const features = () => Object.values(buildJevDecisionDetailPayload(input, ask, V3)!.questions.feature.criteria).map(s => JSON.parse(s).value);
  input.observations.figures[2].analytic.composition = '';
  assert.deepEqual(features(), ['control-feature'], 'keep the sole feature available');

  input.observations.figures[2].analytic.shapes.push('answered-feature', 'another-feature');
  input.publicTurns = [{ turn: 1, speaker: 'human', text: 'これはどう見えますか？' }, { turn: 2, speaker: 'ai', text: 'この特徴ですか？' },
    ...input.publicTurns.map(turn => ({ ...turn, turn: turn.turn + 2 }))];
  input.turn += 2;
  input.previousAction!.turn += 2;
  const currentHistory = input.repairHistory.map(entry => ({ ...entry, turn: entry.turn + 2 }));
  const answered: RepairHistoryEntry = { ...currentHistory[0], turn: 1, question: 'answered-feature',
    partnerClaims: [{ id: '3:synthetic', act: 'agree', proposition: '同じ特徴です。', targets: [ids[2]] }] };
  input.repairHistory = [answered, ...currentHistory];
  assert.deepEqual(features(), ['another-feature']);
  input.previousAction!.target = single(4);
  assert.deepEqual(features(), ['control-feature', 'answered-feature', 'another-feature'], 'questions about another target do not limit this one');
});
