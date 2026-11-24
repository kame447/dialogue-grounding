import assert from 'node:assert/strict';
import test from 'node:test';
import { interventionForStrategy, isOpenIssueRerankRecord } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { buildJevDecisionDetailPayload, buildJevDecisionPayload, buildJevTargetPayload, createJevDecisionClient, JEV_ACTION_CRITERIA, JEV_DECISION_MODEL } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevAction, JevDecisionInput, RepairHistoryEntry } from '../dialogue-model/runtime/decision/contract.ts';
import { s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import type { LocalAct, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { validateObservationMemo } from '../dialogue-model/runtime/observation/observe.ts';
import { createJevTurnRuntime, validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { anchors, ids, image, memo } from './support/s4-integration/harness.ts';

const V3 = { questionLayout: 'two_stage_v3' } as const;
const UNRELATED_NAME = '灯台';
const NEW_NAME = '風車';
const single = (index: number) => ({ kind: 'single' as const, figureId: ids[index] });
type Segment = Omit<LocalSegmentProposal, 'segmentId' | 'linkedIssueId' | 'respondsToTurn'> & { act: LocalAct; respondsTo?: number };
type Plan = {
  action: JevAction;
  target?: number;
  name?: string;
  drafts: string[];
  segments?: Segment[];
  aiSegments?: LocalSegmentProposal[];
  actionScores?: Partial<Record<JevAction, number>>;
  prospect?: 'uncertain' | 'no_open_issue';
  /** holistic fixture only: the scripted answers of the draft-naming question, in order; 'fail' makes that POST fail. */
  draftActs?: string[];
};

function fixture(strategy: 'bypass-enabled' | 'repair-first' = 'bypass-enabled',
  { aiPublic = false, observations = memo(), historicalNameScope = false, holistic = false }:
  { aiPublic?: boolean; observations?: ReturnType<typeof memo>; historicalNameScope?: boolean; holistic?: boolean } = {}) {
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
      if (Object.hasOwn(request.questions, 'draft_naming') && plan.draftActs?.[0] === 'fail') { plan.draftActs.shift(); throw new Error('scripted question failure'); }
      const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        const labels = Object.keys(question.criteria);
        const choice = key === 'action' ? plan.action
          : key === 'target' ? (plan.target === undefined ? 'none' : `figure_${plan.target}`)
          : key === 'repair_issue' ? (plan.prospect ? 'issue_0' : 'none')
          : key === 'prospect' ? plan.prospect ?? 'uncertain'
          : key === 'draft_naming' ? plan.draftActs!.shift()
          : key === 'human_referent' ? (plan.target === undefined ? 'none' : `figure_${plan.target}`)
          : key === 'name' && plan.name ? labels.find(label => JSON.parse(question.criteria[label]).value === plan.name)
          : labels[0];
        assert.ok(choice && labels.includes(choice), `scripted answer is unavailable for ${key}`);
        const probabilities = Object.fromEntries(labels.map(label => [label,
          label === choice ? 1 : key === 'action' ? plan.actionScores?.[label as JevAction] ?? (label === 'confirm' ? 0.8 : 0) : 0]));
        return [key, { type: 'choice', choice, probabilities }];
      }));
      return Response.json({ model: JEV_DECISION_MODEL, id: `gen-rootcause-${wire.length}`, usage: { cost: 0 }, answers });
    },
  })!;
  const runtime = createJevTurnRuntime({
    ...V3, intervention, decisionTimeoutMs: 3000, ...(holistic ? { dialoguePolicy: 'holistic_v1' as const } : {}),
    ...(strategy === 'repair-first' ? { technicalTrial: { version: 'adaptive_repair_v3' as const } } : {}),
    ownAnchors: anchors, ownImage: { ...image, mimeType: 'image/png' }, maxReobservations: 0,
    observer: { async observeAll() { return validateObservationMemo(observations); }, async reobserve() { throw Error('no reobservation expected'); } },
    jevDecision: {
      async decide(input, options) { inputs.push(structuredClone(input)); return native.decide(input, options); },
      estimateReferent: native.estimateReferent, estimateRepairProspect: native.estimateRepairProspect, completeDetail: native.completeDetail,
      ...(holistic ? { classifyDraftAct: native.classifyDraftAct } : {}),
    },
    localGrounding: { ...(aiPublic ? { aiPublicClaims: true, aiPublicTransport: {
      readKey: async () => 'sk-or-SYNTHETIC-ai-public-rootcause-key',
      fetchImpl: async (_url, init) => {
        const { questions } = JSON.parse(String(init.body)) as JevDecisionPayload;
        const answers = Object.fromEntries(Object.entries(questions).map(([key, q]) => {
          const choice = key.endsWith('_act') ? 'assert' : key.endsWith('_antecedent') ? 'none' : 'expressed';
          assert.ok(Object.hasOwn(q.criteria, choice));
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(label => [label, Number(label === choice)])) }];
        }));
        return Response.json({ model: JEV_DECISION_MODEL, id: 'gen-rootcause-ai-public', usage: { cost: 0 }, answers });
      },
    } } : {}), classifier: {
      async classify({ segments, priorClaims }) {
        return segments.map(({ segmentId }, index) => {
          const act = plan.segments![index].act;
          const antecedentAct = act === 'deny' ? 'name_accept' : act === 'name_accept' ? 'name_propose' : null;
          // A referent denial answers the AI's latest public claim about the figure.
          const referentDenial = (act === 'deny' || act === 'agree') && plan.segments![index].aspect === 'referent';
          const antecedent = referentDenial ? priorClaims.filter(c => c.speaker === 'ai').at(-1)
            : antecedentAct && priorClaims.find(c => c.speaker === 'ai' && c.act === antecedentAct);
          return { segmentId, act, respondsToClaimId: antecedent?.id ?? null, rawScore: null };
        });
      },
    } },
    client: {
      async complete(_messages, { phase }) {
        if (phase === 'ai_extraction') return { text: JSON.stringify(plan.aiSegments ?? []) };
        if (phase === 'local_extraction') return { text: JSON.stringify((plan.segments ?? []).map(({ act, respondsTo, ...segment }, index) => ({
          ...segment, segmentId: `segment-${index}`, linkedIssueId: null,
          respondsToTurn: respondsTo ?? (act === 'deny' || act === 'name_accept' || act === 'agree' ? events.at(-2)!.seq : null),
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
  if (historicalNameScope) delete state.agreeNameScopeVersion;
  async function exchange(text: string, next: Plan) {
    plan = next;
    drafts = [...plan.drafts];
    const seq = events.length + 1, id = `human-${seq}`, start = wire.length;
    events.push({ id, seq, text, speaker: 'human' });
    const result = await runtime.runAiTurn({ events, privateState: state, lastEventId: id, requestSeq: seq });
    state = result.privateState;
    events.push({ id: `ai-${seq + 1}`, seq: seq + 1, text: result.text, speaker: 'ai' });
    return { input: inputs.at(-1)!, requests: wire.slice(start), text: result.text, state, events: events.slice(0, -1),
      trace: runtime.getAttempts().at(-1)!, saved: state.judgments.at(-1)!.jevTurn };
  }
  return { exchange, state: () => state, attempt: () => runtime.getAttempts().at(-1), intervention };
}

function naming(quote: string, name: string, targets: string[] = [], act: LocalAct = 'name_propose'): Segment {
  return { quote, name, targets, act, aspect: 'name', proposition: quote };
}
const agreeSpeech = (name: string) => `はい、この形は「${name}」と呼びましょう。`;
// An unbound partner proposal can be agreed only for a figure the AI already shared in public (a public AI claim) and executed on.
const SHARE_SPEECH = '細い部分が二つつながっていますか？';
async function share(f: ReturnType<typeof fixture>, target: number, human = 'その形について教えてください。') {
  const aiSegment: LocalSegmentProposal = { segmentId: 'shape', quote: SHARE_SPEECH, targets: [ids[target]],
    aspect: 'part', proposition: '細い部分が二つつながる', name: null, linkedIssueId: null, respondsToTurn: null };
  return f.exchange(human, { action: 'confirm', target, drafts: [SHARE_SPEECH], aiSegments: [aiSegment] });
}
async function groundedFixture(target: number, strategy: 'bypass-enabled' | 'repair-first' = 'bypass-enabled') {
  const f = fixture(strategy, { aiPublic: true });
  await share(f, target);
  return f;
}
async function agreedFixture() {
  const f = fixture('bypass-enabled', { aiPublic: true });
  await share(f, 0);
  const quote = `この形を「${UNRELATED_NAME}」と呼びましょう。`;
  await f.exchange(quote, { action: 'agree', target: 0, drafts: [agreeSpeech(UNRELATED_NAME)], segments: [naming(quote, UNRELATED_NAME, [ids[0]])] });
  return f;
}

test('v3 stages and publication bind an unbound polite naming proposal to an unagreed figure', async () => {
  const f = await agreedFixture();
  // Only a figure the AI already shared in public (and executed on) can be agreed from an unbound proposal; the other unagreed figures cannot.
  await share(f, 3);
  const quote = `では、この形を「${NEW_NAME}」と呼んでもいいですか？`;
  const next = await f.exchange(quote, { action: 'agree', target: 3, drafts: [agreeSpeech(NEW_NAME)], segments: [naming(quote, NEW_NAME)] });
  assert.equal(next.input.priorClaims.find(c => c.name === NEW_NAME)?.act, 'name_propose');
  assert.ok(next.input.publicNames.some(c => c.name === UNRELATED_NAME), 'old public evidence is retained');
  assert.deepEqual(next.input.agreeNames, [{ name: NEW_NAME, figureId: ids[3], sourceTurn: next.input.turn }]);
  assert.deepEqual(Object.keys(next.requests.find(r => r.questions.target)!.questions.target.criteria), ['figure_3']);
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

  await share(f, 0, 'その形にもう一度戻って教えてください。');
  const original = `やはり「${UNRELATED_NAME}」でどうですか？`;
  const resumed = await f.exchange(original, { action: 'accept', drafts: ['元の呼び名の話ですね。'], segments: [naming(original, UNRELATED_NAME)] });
  assert.deepEqual(resumed.input.agreeNames, [{ name: UNRELATED_NAME, figureId: ids[0], sourceTurn: resumed.input.turn }]);
});

test('v3 a move_on boundary retires the old bound proposal even when its ledger entry is tentative', async () => {
  const f = fixture('bypass-enabled', { aiPublic: true });
  // The partner only mentions the word; the AI itself proposes it.
  const old = `この形には「${UNRELATED_NAME}」という見方もありますね。`;
  await f.exchange(old, { action: 'propose_name', target: 0, name: UNRELATED_NAME, drafts: [`「${UNRELATED_NAME}」という呼び名はどうですか？`],
    segments: [naming(old, UNRELATED_NAME, [ids[0]], 'assert')] });
  await f.exchange('次の形を見ましょう。', { action: 'move_on', target: 3, drafts: ['細長い形を見ましょう。'] });
  await share(f, 3);
  const proposal = `こちらの形は「${NEW_NAME}」でどうですか？`;
  const current = await f.exchange(proposal, { action: 'agree', target: 3, drafts: [agreeSpeech(NEW_NAME)], segments: [naming(proposal, NEW_NAME)] });
  assert.ok(current.input.priorClaims.some(c => c.name === UNRELATED_NAME && c.targets.includes(ids[0])));
  assert.deepEqual(current.input.agreeNames, [{ figureId: ids[3], name: NEW_NAME, sourceTurn: current.input.turn }]);
  assert.deepEqual(current.state.ledger[ids[0]], { status: 'tentative', name: UNRELATED_NAME });
  assert.deepEqual(current.state.ledger[ids[3]], { status: 'agreed', name: NEW_NAME });
});

for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  for (const target of [3, undefined]) test(`v3 ${strategy} replaces older naming evidence after accept(${target ?? 'none'})`, async () => {
    const f = fixture(strategy, { aiPublic: true });
    const proposed = `この形を「${NEW_NAME}」と呼びましょうか？`;
    // The partner only mentions the word; a partner name_propose would be answered, never re-proposed as the AI's own.
    const old = `この形には「${NEW_NAME}」という見方もありますね。`;
    await f.exchange(old, { action: 'propose_name', target: 2, name: NEW_NAME, drafts: [proposed],
      segments: [naming(old, NEW_NAME, [ids[2]], 'assert')] });

    const confirmation = `はい、「${NEW_NAME}」でいきましょう。`;
    const question = '次の細長い形はどうですか？';
    const moved = await f.exchange(confirmation + question, { action: 'accept', target, drafts: ['細長い形の話ですね。'],
      segments: [naming(confirmation, NEW_NAME, [ids[2]], 'name_accept'),
        { quote: question, targets: [ids[3]], aspect: 'question', proposition: question, name: null, act: 'ask' }] });
    assert.ok(moved.input.priorClaims.some(c => c.sourceTurn === 3 && c.act === 'name_accept' && c.name === NEW_NAME));
    assert.deepEqual(moved.saved.executed?.target, target === undefined ? { kind: 'none' } : single(target));

    const name = '時計';
    await share(f, 3);
    const proposal = `この形を「${name}」と呼んでもいいですか？`;
    const next = await f.exchange(proposal, { action: 'agree', target: 3, drafts: [agreeSpeech(name)], segments: [naming(proposal, name)] });
    assert.deepEqual(next.input.agreeNames, [{ name, figureId: ids[3], sourceTurn: next.input.turn }]);
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

for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test('v3 scopes prior naming evidence to the proposed figure (' + strategy + ')', async () => {
    for (const historicalNameScope of [false, true]) {
      const f = fixture(strategy, { historicalNameScope });
      const first = 'この形の名前は台座がよさそうです。';
      const second = '別の形の呼び名には歯車がよさそうです。';
      await f.exchange(first, { action: 'accept', drafts: ['呼び名の候補ですね。'],
        segments: [naming(first, '台座', [ids[2]])] });
      await f.exchange(second, { action: 'accept', drafts: ['別の候補も出ましたね。'],
        segments: [naming(second, '歯車', [ids[3]])] });
      const before = structuredClone(f.state());
      const checked = await f.exchange('先ほどの候補についてどう思いますか？',
        { action: 'accept', drafts: ['呼び名を考えています。'] });
      const firstCandidate = { name: '台座', figureId: ids[2], sourceTurn: 1 };
      const secondCandidate = { name: '歯車', figureId: ids[3], sourceTurn: 3 };
      assert.deepEqual(checked.input.agreeNames, historicalNameScope ? [secondCandidate] : [firstCandidate, secondCandidate]);
      assert.equal(checked.state.agreeNameScopeVersion, historicalNameScope ? undefined : 'scoped_v1');
      const key = JSON.stringify([checked.trace.turnIndex, checked.trace.lastEventId, checked.trace.attemptNumber]);
      const trial = { profile: { id: 'research_trial_profile_v3', ...V3 }, turns: [{ turn: checked.trace.turnIndex, state: checked.state }] };
      const material = { state: before, events: checked.events };
      try {
        assert.notEqual(s4Probe.agreeSource(trial, checked.trace, key, material), 'invalid');
        const changed = structuredClone(material);
        if (historicalNameScope) changed.state.agreeNameScopeVersion = 'scoped_v1';
        else delete changed.state.agreeNameScopeVersion;
        assert.equal(s4Probe.agreeSource(trial, checked.trace, key, changed), 'invalid');
        const forged = structuredClone(trial);
        forged.turns[0].state.judgments.at(-1)!.jevTurn.agreeNames = historicalNameScope ? [firstCandidate, secondCandidate] : [secondCandidate];
        assert.equal(s4Probe.agreeSource(forged, checked.trace, key, material), 'invalid');
      } finally { s4Probe.setContext({}); }
      if (!historicalNameScope) {
        const agreed = await f.exchange('では、最初の名前でどうでしょうか？',
          { action: 'agree', target: 2, name: '台座', drafts: [agreeSpeech('台座')] });
        assert.deepEqual(agreed.state.ledger[ids[2]], { status: 'agreed', name: '台座' });
        assert.equal(agreed.state.ledger[ids[3]].status, 'unassigned');
      }
    }
  });
}

test('v3 retires the old proposal after an explicit rename or assignment of the same name elsewhere', async () => {
  for (const { slot, name } of [{ slot: 2, name: '歯車' }, { slot: 3, name: '台座' }]) {
    const f = fixture();
    const first = 'この図形の呼び名は台座がよさそうです。';
    const second = name + 'にする案を出します。';
    await f.exchange(first, { action: 'accept', drafts: ['候補ですね。'], segments: [naming(first, '台座', [ids[2]])] });
    const updated = await f.exchange(second, { action: 'accept', drafts: ['呼び名の話ですね。'],
      segments: [naming(second, name, [ids[slot]])] });
    assert.deepEqual(updated.input.agreeNames, [{ name, figureId: ids[slot], sourceTurn: 3 }]);
  }
});

test('v3 preserves a grounded unbound proposal across a later bound proposal for another figure', async () => {
  const f = await groundedFixture(2);
  const first = '呼び名の案は台座です。';
  const second = '別の図形に歯車という呼び名を提案します。';
  await f.exchange(first, { action: 'accept', drafts: ['呼び名の候補ですね。'], segments: [naming(first, '台座')] });
  const next = await f.exchange(second, { action: 'accept', drafts: ['別の候補も出ましたね。'],
    segments: [naming(second, '歯車', [ids[3]])] });
  assert.deepEqual(next.input.agreeNames, [
    { name: '台座', figureId: ids[2], sourceTurn: 3 }, { name: '歯車', figureId: ids[3], sourceTurn: 5 },
  ]);
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
  const asked = '二つの部分がつながっていますか？';
  const confirmed = await f.exchange(quote, { action: 'confirm', target: 2, drafts: [asked], segments: proposal,
    aiSegments: [{ segmentId: 'shape', quote: asked, targets: [ids[2]], aspect: 'part', proposition: '二つの部分がつながる', name: null, linkedIssueId: null, respondsToTurn: null }] });
  const agreed = await f.exchange('はい、その形です。', { action: 'agree', target: 2, drafts: [agreeSpeech(NEW_NAME)] });
  assert.equal(agreed.saved.executed?.name, NEW_NAME);
  assert.equal(agreed.input.agreeNames?.find(n => n.figureId === ids[2])?.sourceTurn, confirmed.input.turn);

  const moved = await agreedFixture();
  await moved.exchange(quote, { action: 'move_on', target: 4, drafts: ['別の形を見ましょう。'], segments: proposal });
  const next = await moved.exchange('もう一つの形について話しましょう。', { action: 'accept', drafts: ['そう見えるのですね。'] });
  assert.deepEqual(next.input.agreeNames, []);
  assert.ok(!Object.hasOwn(next.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'));
});

test('v3 rewrites a mismatched agree and rejects two mismatched drafts without a ledger commit', async () => {
  const f = await agreedFixture();
  await share(f, 3);
  const quote = `この形は「${NEW_NAME}」でいいですか？`;
  const plan = { action: 'agree', target: 3, segments: [naming(quote, NEW_NAME)] } satisfies Omit<Plan, 'drafts'>;
  const result = await f.exchange(quote, { ...plan, drafts: [agreeSpeech(UNRELATED_NAME), agreeSpeech(NEW_NAME)] });
  assert.equal(result.text, agreeSpeech(NEW_NAME));
  assert.deepEqual(result.trace.generationGuard, { violations: ['name_not_shown'], regenerated: true, fallback: false });

  const denied = await agreedFixture();
  await share(denied, 3);
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
    const corrected = await (await groundedFixture(3)).exchange(quote, { ...plan, drafts: [draft, agreeSpeech(UNRELATED_NAME)] });
    assert.deepEqual(corrected.trace.generationGuard, { violations: ['name_mismatch'], regenerated: true, fallback: false }, draft);
    assert.equal(corrected.text, agreeSpeech(UNRELATED_NAME));
    assert.deepEqual(corrected.state.ledger[ids[3]], { status: 'agreed', name: UNRELATED_NAME });
  }

  const denied = await groundedFixture(3);
  const previous = structuredClone(denied.state());
  await assert.rejects(denied.exchange(quote, { ...plan, drafts: [mismatch, mismatch] }), { code: 'unsafe_generation' });
  assert.deepEqual(denied.state(), previous);
  assert.equal(denied.attempt()?.publicSpeech, null);
  assert.deepEqual(denied.attempt()?.generationGuard.violations, ['name_mismatch']);
});

test('v3 a public denial plus an unbound replacement reaches an agree on the new figure', async () => {
  const f = await agreedFixture();
  const agreedTurn = f.state().judgments.at(-1)!.turnIndex + 1; // the AI turn that agreed; the next AI turn only shares figure 4
  await share(f, 4);
  const denial = `その形には「${UNRELATED_NAME}」は違います。`;
  const replacement = `この形は「${NEW_NAME}」でいいですか？`;
  const result = await f.exchange(denial + replacement, { action: 'agree', target: 4, drafts: [agreeSpeech(NEW_NAME)],
    segments: [{ ...naming(denial, UNRELATED_NAME, [ids[0]], 'deny'), respondsTo: agreedTurn }, naming(replacement, NEW_NAME)] });
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
  answered.partnerClaims[0].act = 'deny';
  assert.deepEqual(features(), ['another-feature'], 'a denied feature still counts as asked');
  input.previousAction!.target = single(4);
  assert.deepEqual(features(), ['control-feature', 'answered-feature', 'another-feature'], 'questions about another target do not limit this one');
});

const values = (criteria: Record<string, string>) => Object.values(criteria).map(value => JSON.parse(value).value);
type Exchange = Awaited<ReturnType<ReturnType<typeof fixture>['exchange']>>;

function checkS4AgreeSource(previous: Exchange['state'], result: Exchange) {
  const { state, trace, events, input } = result;
  const profile = { id: 'research_trial_profile_v3', ...V3, localGrounding: { aiPublicClaims: !!previous.aiPublic } };
  const turnIndex = trace.turnIndex;
  const trial = { profile, turns: [{ turn: turnIndex, state }] };
  const key = JSON.stringify([turnIndex, trace.lastEventId, trace.attemptNumber]);
  assert.deepEqual(s4Probe.agreeSource(trial, trace, key, { state: previous, events }), { known: true, names: input.agreeNames });
}

function proposalMemo() {
  const observations = memo();
  const names = [[UNRELATED_NAME, '水車'], ['ツ バ メ', '別名'], ['かめ', NEW_NAME], ['かめ'], ['時計'], []];
  observations.figures.forEach((figure, index) => {
    figure.holistic = names[index].map(construal => ({ construal, basis: ['合成の観察'], status: 'hypothesis' }));
  });
  return observations;
}

for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test(`v3 ${strategy} offers only ledger-legal proposal names, targets and actions`, async () => {
    const f = fixture(strategy, { observations: proposalMemo() });
    Object.assign(f.state().ledger, {
      [ids[0]]: { status: 'agreed', name: UNRELATED_NAME },
      [ids[1]]: { status: 'deferred', name: 'つばめ' },
      [ids[2]]: { status: 'tentative', name: '四角' },
      [ids[5]]: { status: 'tentative', name: 'カメ' },
    });
    const proposal = { action: 'propose_name' } as const;
    const next = await f.exchange('この形の呼び名はどうしますか？', { ...proposal, target: 2, name: NEW_NAME, drafts: [`「${NEW_NAME}」はどうですか？`] });
    const nameDetails = (index: number) => buildJevDecisionDetailPayload(next.input, { ...proposal, target: single(index) }, V3)!.questions.name.criteria;
    assert.deepEqual(Object.keys(next.requests.find(r => r.questions.target)!.questions.target.criteria), ['figure_1', 'figure_2', 'figure_4']);
    for (const index of [0, 3, 5]) assert.throws(() => nameDetails(index), { rule: 'action_target_not_allowed' });
    assert.deepEqual(values(nameDetails(1)), ['ツ バ メ']);
    assert.deepEqual(values(nameDetails(2)), [NEW_NAME]);
    assert.deepEqual(values(nameDetails(4)), ['時計']);
    assert.equal(next.state.ledger[ids[2]].name, NEW_NAME);
    assert.deepEqual(next.input.nameLedger?.[ids[2]], { status: 'tentative', name: '四角' });
    assert.ok(next.requests.every(r => !Object.hasOwn(JSON.parse(r.state), 'nameLedger')));

    const allAgreed = structuredClone(next.input);
    allAgreed.nameLedger = Object.fromEntries(ids.map((id, i) => [id, { status: 'agreed', name: `合成名${i}` }]));
    assert.ok(!Object.hasOwn(buildJevDecisionPayload(allAgreed, V3).questions.action.criteria, 'propose_name'));
    assert.throws(() => buildJevTargetPayload(allAgreed, 'propose_name'), { code: 'invalid_decision' });
    const wrongSlots = structuredClone(next.input);
    wrongSlots.nameLedger!['s-abcd'] = wrongSlots.nameLedger![ids[0]];
    delete wrongSlots.nameLedger![ids[0]];
    assert.throws(() => buildJevDecisionPayload(wrongSlots, V3), { code: 'invalid_input' });
    for (const questionLayout of ['two_stage_v1', 'two_stage_v2'] as const) {
      const old = buildJevDecisionDetailPayload(next.input, { ...proposal, target: single(0) }, { questionLayout });
      assert.deepEqual(values(old!.questions.name.criteria), [UNRELATED_NAME, '水車']);
    }
  });

  test(`v3 ${strategy} uses a new feature across confirm and repair until the scope exhausts its list`, async () => {
    const observations = memo();
    const features = ['小さい角が二つ', '四角が一つ', 'くぼみが一つ'];
    observations.figures[1].analytic = { shapes: features.slice(0, 2), composition: features[2], relations: [] };
    const f = fixture(strategy, { observations });
    const turns = [
      ['confirm', 'この形はどんな形ですか？', '小さい角が二つありますか？'],
      ['repair', '角は一つに見えます。', '四角い部分が一つありますか？'],
      ['confirm', '四角い部分も見えません。', 'くぼみが一つありますか？'],
      ['repair', 'そこも平らに見えます。', '小さい角が二つありますか？'],
    ] as const;
    const catalogs = [features, features.slice(1), features.slice(2), features];
    for (const [index, [action, human, draft]] of turns.entries()) {
      const result = await f.exchange(human, { action, target: 1, drafts: [draft] });
      assert.equal(result.saved.executed?.feature, features[index % features.length]);
      assert.deepEqual(values(result.requests.find(r => r.questions.feature)!.questions.feature.criteria), catalogs[index]);
    }
  });

  test(`v3 ${strategy} does not agree to a current proposal that jumps to an unseen figure`, async () => {
    const proposal = 'この形を「時計」と呼んでもいいですか？';
    const segments = [naming(proposal, '時計', [ids[3]])];
    const f = fixture(strategy);
    await f.exchange('尖った形のことです。', { action: 'confirm', target: 1, drafts: ['細い部分がつながっていますか？'] });
    const previous = f.state();
    const jumped = await f.exchange(proposal, { action: 'accept', drafts: ['呼び名の話ですね。'], segments });
    assert.ok(jumped.input.priorClaims.some(c => c.act === 'name_propose' && c.targets.includes(ids[3])));
    assert.deepEqual(jumped.input.agreeNames, []);
    assert.ok(!Object.hasOwn(jumped.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'));
    checkS4AgreeSource(previous, jumped);

    const focused = fixture(strategy);
    await focused.exchange('丸みのある形のことです。', { action: 'accept', target: 3, drafts: ['丸みがある形ですね。'] });
    await focused.exchange('もう一つは尖っています。', { action: 'confirm', target: 1, drafts: ['細い部分がつながっていますか？'] });
    const agreed = await focused.exchange(proposal, { action: 'agree', target: 3, drafts: [agreeSpeech('時計')], segments });
    assert.deepEqual(agreed.saved.executed?.target, single(3));
  });

  test(`v3 ${strategy} requires public evidence and execution focus to support immediate agreement`, async () => {
    const speech = '細い部分が二つつながっていますか？';
    const proposal = `この形は「${NEW_NAME}」と呼びましょうか？`;
    const aiSegment = (target: number): LocalSegmentProposal => ({ segmentId: 'shape', quote: speech, targets: [ids[target]],
      aspect: 'part', proposition: '細い部分が二つつながる', name: null, linkedIssueId: null, respondsToTurn: null });
    const confirm = async (target: number) => {
      const f = fixture(strategy, { aiPublic: true });
      const prior = await f.exchange('二つの部分がある形のことです。', { action: 'confirm', target: 1, drafts: [speech], aiSegments: [aiSegment(target)] });
      assert.deepEqual(prior.saved.executed?.target, single(1));
      return f;
    };
    for (const humanTargets of [[ids[3]], [], [ids[1], ids[3]]]) {
      const f = await confirm(3);
      const previous = f.state();
      const result = await f.exchange(proposal, { action: 'accept', drafts: ['少し確かめましょう。'],
        segments: [naming(proposal, NEW_NAME, humanTargets)] });
      const publicEvidence = result.input.priorClaims.filter(c => c.speaker === 'ai' && c.sourceTurn === 2);
      assert.deepEqual(publicEvidence.map(c => c.targets), [[ids[3]]]);
      assert.deepEqual(result.input.priorClaims.find(c => c.speaker === 'human' && c.act === 'name_propose')?.targets, humanTargets);
      assert.deepEqual(result.input.agreeNames, []);
      assert.ok(!Object.hasOwn(result.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'));
      checkS4AgreeSource(previous, result);
    }

    const matched = await confirm(1);
    const beforeAgreement = matched.state();
    const agreement = await matched.exchange(proposal, { action: 'agree', target: 1, drafts: [agreeSpeech(NEW_NAME)], segments: [naming(proposal, NEW_NAME)] });
    assert.deepEqual(agreement.input.agreeNames?.map(n => n.figureId), [ids[1]]);
    assert.deepEqual(agreement.saved.executed?.target, single(1));
    checkS4AgreeSource(beforeAgreement, agreement);
    const newProposal = '次の形は「水車」でどうですか？';
    const afterAgreement = matched.state();
    const next = await matched.exchange(newProposal, { action: 'agree', target: 4, drafts: [agreeSpeech('水車')], segments: [naming(newProposal, '水車', [ids[4]])] });
    assert.deepEqual(next.saved.executed?.target, single(4));
    checkS4AgreeSource(afterAgreement, next);
  });

  test(`v3 ${strategy} regenerates a public draft that leaks its orientation`, async () => {
    const f = fixture(strategy);
    const revision = '尖った部分が二つありますか？';
    const result = await f.exchange('形をもう少し確かめたいです。', { action: 'confirm', target: 1,
      drafts: ['上端が尖っていますか？', revision] });
    assert.equal(result.text, revision);
    assert.deepEqual(result.trace.generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: false });
  });

  test(`v3 ${strategy} does not turn an orientation retry with a naming violation into a fallback`, async () => {
    const f = fixture(strategy);
    const before = structuredClone(f.state());
    await assert.rejects(f.exchange('この形につける名前を相談できますか？', { action: 'confirm', target: 1,
      drafts: ['上端が尖っていますか？', 'その形を「風車」と呼びましょう。'] }), { code: 'unsafe_generation' });
    assert.equal(f.attempt()?.generationRetryVersion, 'jev_generation_retry_v2');
    assert.deepEqual(f.attempt()?.generationGuard, { violations: ['orientation_leak', 'naming_decision'], regenerated: true, fallback: false });
    assert.equal(f.attempt()?.publicSpeech, null);
    assert.deepEqual(f.state(), before);
  });

  test(`v3 ${strategy} recovers safely from repeated orientation_leak without publishing orientation words or marking the feature asked`, async () => {
    const f = fixture(strategy, { aiPublic: true });
    const result = await f.exchange('形をもう少し確かめたいです。', { action: 'confirm', target: 1,
      drafts: ['上端が尖っていますか？', '右側に張り出しがありますか？'] });
    assert.equal(result.text, 'その形の特徴について、もう少し詳しく教えてもらえますか？');
    assert.deepEqual(result.trace.generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
    assert.equal(result.trace.aiPublic?.pending?.status, 'skipped_fallback');
    assert.equal(result.state.repairHistory.at(-1)?.question, '');
    assert.equal(s4Probe.traceShape(result.trace, V3.questionLayout), true);
    // Subsequent turn: after fallback confirm(1) with skipped_fallback, an unbound human proposal must NOT allow immediate agree on unseen figure 3.
    const previous = f.state();
    const proposal = `この形は「${NEW_NAME}」と呼びましょうか？`;
    const next = await f.exchange(proposal, { action: 'accept', drafts: ['もう少し特徴を確かめましょう。'],
      segments: [naming(proposal, NEW_NAME, [])] });
    assert.deepEqual(next.input.agreeNames, []);
    assert.ok(!Object.hasOwn(next.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'));
    assert.equal(next.state.ledger[ids[3]].status, 'unassigned');
    assert.equal(next.state.ledger[ids[1]].status, 'unassigned');
    checkS4AgreeSource(previous, next);
  });

  test(`v3 ${strategy} allows quoted orientation-word names in agree fallback and fails closed on internal/mixed violations`, async () => {
    const f = fixture(strategy);
    await assert.rejects(f.exchange('形をもう少し確かめたいです。', { action: 'confirm', target: 1,
      drafts: ['上端が尖っていて s-1111 のことですか？', '右側が尖っていますか？'] }), { code: 'unsafe_generation' });
    const g = fixture(strategy, { aiPublic: true });
    const quotedProposal = 'これを「右向きの鳥」と呼びましょう。';
    const agreed = await g.exchange(quotedProposal, { action: 'agree', target: 1,
      drafts: ['上端の「右向きの鳥」で決まりです。', '右側の「右向きの鳥」にしましょう。'],
      segments: [naming(quotedProposal, '右向きの鳥', [ids[1]])] });
    assert.equal(agreed.text, '「右向きの鳥」にしましょう。');
    assert.deepEqual(agreed.trace.generationGuard, { violations: ['orientation_leak'], regenerated: true, fallback: true });
    assert.equal(agreed.trace.aiPublic?.pending?.status, 'skipped_fallback');
    assert.equal(s4Probe.traceShape(agreed.trace, V3.questionLayout), true);
    const h = fixture(strategy);
    const badNameProposal = 'これを「s-1111」と呼びましょう。';
    await assert.rejects(h.exchange(badNameProposal, { action: 'agree', target: 1,
      drafts: ['上端の「s-1111」で決まりです。', '右側の「s-1111」にしましょう。'],
      segments: [naming(badNameProposal, 's-1111', [ids[1]])] }), { code: 'unsafe_generation' });
  });
}

test('v3 veto rerank excludes an agreed slot and completes legal proposal detail on an unassigned slot', async () => {
  for (const target of [0, 4]) {
    const f = fixture('repair-first', { observations: proposalMemo() });
    f.state().ledger[ids[0]] = { status: 'agreed', name: UNRELATED_NAME };
    const result = await f.exchange('別の形も見てみましょうか？', { action: 'move_on', target, actionScores: { propose_name: 0.9 },
      name: '時計', drafts: [target === 0 ? '細い部分がつながっていますか？' : '「時計」はどうですか？'] });
    const { saved, state, trace } = result;
    assert.equal(saved.executed?.action, target === 0 ? 'confirm' : 'propose_name');
    assert.equal(saved.intervention?.rerank?.ranking.some(r => r.action === 'propose_name'), target === 4);
    assert.deepEqual(validateJevPrivateStateV2(state, ids, f.intervention, V3.questionLayout), state);
    assert.equal(s4Probe.relation(trace, 'repair-first', ids, V3.questionLayout), true);
    s4Probe.setContext({ v3: true, ledger: result.input.nameLedger, agree: [], facts: Array.isArray(trace.repairFacts) });
    try {
      const actionRequest = result.requests.find(r => r.questions.action)!;
      const actionState = JSON.parse(actionRequest.state);
      assert.equal(s4Probe.originalQuestions(actionRequest, actionState, V3.questionLayout), true);
      assert.equal(s4Probe.originalQuestions(actionRequest, { ...actionState, nameLedger: result.input.nameLedger }, V3.questionLayout), false);
      assert.equal(s4Probe.rankProof(saved.intervention, saved.decision, actionState), true);
    } finally { s4Probe.setContext({}); }
  }
});

test('v3 records a closed schema rejection on judgment validation without publishing', async () => {
  const f = fixture();
  // Older states can restore two entries with an equivalent name; revisit reads the stored name.
  f.state().ledger[ids[0]] = { status: 'deferred', name: 'ツ バ メ' };
  f.state().ledger[ids[1]] = { status: 'tentative', name: 'つばめ' };
  const previous = structuredClone(f.state());
  const code = 'duplicate_name_requires_repair';
  await assert.rejects(f.exchange('保留していた呼び名に戻りましょう。', { action: 'revisit', target: 0, drafts: [] }),
    { name: 'JevTurnError', message: 'invalid_decision', code: 'invalid_decision', decisionRejectionCode: code });
  assert.deepEqual(f.state(), previous);
  const trace = f.attempt()!;
  assert.equal(trace.errorCode, 'invalid_decision');
  assert.equal(trace.decisionRejectionCode, code);
  assert.equal(trace.publicSpeech, null);
  assert.equal(trace.finalAction, null);
  assert.equal(trace.decisionFailure, undefined);
  assert.equal(s4Probe.traceShape(trace, V3.questionLayout), true);
  assert.equal(s4Probe.traceShape({ ...trace, decisionRejectionCode: 'synthetic arbitrary message' }, V3.questionLayout), false);
});

// Synthetic paraphrase of a partner-proposed name whose approval request stays unanswered for several turns (no private log text).
for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test(`v3 ${strategy} keeps an unanswered approval request for the partner's own name across turns, then agrees explicitly`, async () => {
    const f = fixture(strategy);
    const name = '鍵';
    const proposal = `この階段みたいな形は「${name}」とかどうかな？`;
    const first = await f.exchange(proposal, { action: 'accept', target: 2, drafts: ['階段みたいな形ですね。'], segments: [naming(proposal, name, [ids[2]])] });
    assert.deepEqual(first.input.agreeNames, [{ name, figureId: ids[2], sourceTurn: 1 }]);
    const claimedBy = first.input.priorClaims.find(c => c.name === name)!;
    assert.equal(claimedBy.speaker, 'human');
    assert.equal(claimedBy.act, 'name_propose');

    const reminder = 'その名前は自分が出した案だよ。';
    const second = await f.exchange(reminder, { action: 'accept', target: 2, drafts: ['出してくれた案でしたね。'] });
    assert.deepEqual(second.input.agreeNames, [{ name, figureId: ids[2], sourceTurn: 1 }]);
    assert.notEqual(second.state.ledger[ids[2]].status, 'agreed');

    const ask = 'だから、その名前でいいかどうか聞いているんだ。';
    const third = await f.exchange(ask, { action: 'agree', target: 2, drafts: [agreeSpeech(name)],
      segments: [{ quote: ask, name: null, targets: [], aspect: 'question', proposition: '呼び名でよいかの確認', act: 'ask' }] });
    assert.deepEqual(third.input.agreeNames, [{ name, figureId: ids[2], sourceTurn: 1 }]);
    assert.equal(third.saved.executed?.action, 'agree');
    assert.equal(third.saved.executed?.name, name);
    assert.equal(third.text, agreeSpeech(name));
    assert.deepEqual(third.state.ledger[ids[2]], { status: 'agreed', name });
    for (const other of ids.filter(id => id !== ids[2])) assert.notEqual(third.state.ledger[other].name, name);
    const nameCatalogs = third.requests.flatMap(r => Object.entries(r.questions).filter(([k]) => k === 'name'));
    for (const [, q] of nameCatalogs) assert.ok(Object.values(q.criteria).some(c => JSON.parse(c).value === name));
  });

  test(`v3 ${strategy} does not agree when the partner's approval request targets a figure the AI never grounded`, async () => {
    const f = fixture(strategy);
    const name = '鍵';
    const proposal = `これは「${name}」でどうかな？`;
    const first = await f.exchange(proposal, { action: 'accept', drafts: ['どの形のことか分かるように話しますね。'],
      segments: [naming(proposal, name)] });
    assert.equal(first.input.priorClaims.find(c => c.name === name)?.targets.length, 0);
    assert.ok(first.saved.executed?.action !== 'agree');
    assert.notEqual(first.state.ledger[ids[2]].status, 'agreed');
  });
}

// B1: an unbound partner proposal is never agreed for a figure the AI has not shared in public; sharing one makes exactly that figure agreeable.
for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test(`v3 ${strategy} confirms the referent instead of agreeing an unbound proposal on an unshared figure, then agrees once it is shared`, async () => {
    const f = fixture(strategy, { aiPublic: true });
    const name = '鍵';
    const proposal = `これは「${name}」とかどうかな？`;
    await f.exchange(proposal, { action: 'accept', drafts: ['どの形のことか確かめますね。'], segments: [naming(proposal, name)] });
    const ask = 'その名前でいいか聞いているんだ。';
    const open = await f.exchange(ask, { action: 'confirm', target: 2, drafts: [SHARE_SPEECH],
      segments: [{ quote: ask, name: null, targets: [], aspect: 'question', proposition: '呼び名でよいかの確認', act: 'ask' }],
      aiSegments: [{ segmentId: 'shape', quote: SHARE_SPEECH, targets: [ids[2]], aspect: 'part', proposition: '細い部分が二つつながる', name: null, linkedIssueId: null, respondsToTurn: null }] });
    assert.deepEqual(open.input.agreeNames, [], 'nothing was publicly shared before this turn');
    assert.equal(Object.hasOwn(open.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'), false);
    assert.notEqual(open.state.ledger[ids[2]].status, 'agreed');

    const again = 'はい、その形です。それでいいですか？';
    const shared = await f.exchange(again, { action: 'agree', target: 2, drafts: [agreeSpeech(name)],
      segments: [{ quote: again, name: null, targets: [ids[2]], aspect: 'question', proposition: '呼び名でよいかの確認', act: 'ask' }] });
    assert.deepEqual(shared.input.agreeNames, [{ name, figureId: ids[2], sourceTurn: 1 }]);
    assert.deepEqual(shared.state.ledger[ids[2]], { status: 'agreed', name });
    for (const other of ids.filter(id => id !== ids[2])) assert.notEqual(shared.state.ledger[other].name, name);
  });
}

// A partner who explicitly denies the figure as the referent blocks agreement on it (the proposed name is not what is objected to);
// re-affirming the figure reopens it. S4 rebuilds the same candidates from the saved record for every one of these turns.
for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test(`v3 ${strategy} does not agree on a figure the partner denied as the referent, adopts the same proposal once it is affirmed, and S4 agrees`, async () => {
    const f = fixture(strategy, { aiPublic: true });
    const name = '鍵';
    const proposal = `これは「${name}」とかどうかな？`;
    let before = structuredClone(f.state());
    const first = await f.exchange(proposal, { action: 'accept', drafts: ['どの形のことか確かめますね。'], segments: [naming(proposal, name)] });
    checkS4AgreeSource(before, first);

    // Not shared yet: the request for approval is answered without agreeing (a genuine record that S4 must also accept).
    const ask = 'その名前でいいか聞いているんだ。';
    const askSegment = { quote: ask, name: null, targets: [], aspect: 'question' as const, proposition: '呼び名でよいかの確認', act: 'ask' as const };
    before = structuredClone(f.state());
    const unshared = await f.exchange(ask, { action: 'accept', drafts: ['まだ、どの形か確かめられていません。'], segments: [askSegment] });
    assert.deepEqual(unshared.input.agreeNames, []);
    checkS4AgreeSource(before, unshared);

    before = structuredClone(f.state());
    // The AI says in public which figure it means (a referent claim), so the partner can answer it, including with a denial.
    const mean = '細い部分が二つつながった形のことですか？';
    const shared = await f.exchange('形を教えてください。', { action: 'confirm', target: 0, drafts: [mean],
      aiSegments: [{ segmentId: 'shape', quote: mean, targets: [ids[0]], aspect: 'referent', proposition: 'この形を指す', name: null, linkedIssueId: null, respondsToTurn: null }] });
    assert.deepEqual(shared.input.agreeNames, []);
    checkS4AgreeSource(before, shared);

    const denial = 'いいえ、その形ではありません。';
    const denySegment = { quote: denial, name: null, targets: [ids[0]], aspect: 'referent' as const, proposition: 'その形ではない', act: 'deny' as const };
    before = structuredClone(f.state());
    const denied = await f.exchange(denial + ask, { action: 'confirm', target: 1, drafts: ['別の形を確かめますね。'], segments: [denySegment, { ...askSegment, quote: ask }] });
    assert.deepEqual(denied.input.agreeNames, [], 'a denied referent is no candidate for the partner proposal');
    assert.equal(Object.hasOwn(denied.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'), false);
    assert.notEqual(denied.state.ledger[ids[0]].status, 'agreed');
    checkS4AgreeSource(before, denied);

    // Asking about the referent is not an answer: the denial stands for the candidates, the request and the ledger.
    const reask = '今も、さっきの形のことを尋ねていますか？';
    before = structuredClone(f.state());
    const requeried = await f.exchange(reask + ask, { action: 'confirm', target: 1, drafts: ['別の形を確かめますね。'],
      segments: [{ quote: reask, name: null, targets: [ids[0]], aspect: 'referent' as const, proposition: '同じ形か', act: 'ask' as const }, { ...askSegment, quote: ask }] });
    assert.deepEqual(requeried.input.agreeNames, [], 'a question about the referent does not lift the denial');
    assert.equal(Object.hasOwn(requeried.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'), false);
    assert.notEqual(requeried.state.ledger[ids[0]].status, 'agreed');
    checkS4AgreeSource(before, requeried);

    // Keeping the figure as one candidate, or narrowing to a set, is not choosing it: the denial stays (the estimate of that exchange also says none).
    for (const [text, targets, proposition] of [['その形も候補の一つです。', [ids[0]], '候補の一つ'], ['探しているのはその二つのどちらかです。', [ids[0], ids[1]], '二つのどちらか']] as const) {
      before = structuredClone(f.state());
      const candidate = await f.exchange(text + ask, { action: 'confirm', target: 1, drafts: ['どちらなのか確かめますね。'],
        segments: [{ quote: text, name: null, targets: [...targets], aspect: 'referent' as const, proposition, act: 'assert' as const }, { ...askSegment, quote: ask }] });
      assert.deepEqual(candidate.input.agreeNames, [], proposition);
      assert.equal(Object.hasOwn(candidate.requests.find(r => r.questions.action)!.questions.action.criteria, 'agree'), false);
      assert.notEqual(candidate.state.ledger[ids[0]].status, 'agreed');
      checkS4AgreeSource(before, candidate);
    }

    // Forged evidence is refused: an extra candidate the generation rules never produce.
    const forged = structuredClone(denied);
    forged.state.judgments.at(-1)!.jevTurn.agreeNames = [{ name, figureId: ids[0], sourceTurn: 1 }];
    assert.throws(() => checkS4AgreeSource(before, forged));

    const affirm = 'やっぱりその形です。';
    const affirmSegment = { quote: affirm, name: null, targets: [ids[0]], aspect: 'referent' as const, proposition: 'その形である', act: 'agree' as const, respondsTo: shared.input.turn + 1 /* the AI turn that said which figure it meant */ };
    before = structuredClone(f.state());
    const affirmed = await f.exchange(affirm + ask, { action: 'agree', target: 0, drafts: [agreeSpeech(name)], segments: [affirmSegment, { ...askSegment, quote: ask }] });
    assert.deepEqual(affirmed.input.agreeNames, [{ name, figureId: ids[0], sourceTurn: 1 }]);
    assert.deepEqual(affirmed.state.ledger[ids[0]], { status: 'agreed', name });
    checkS4AgreeSource(before, affirmed);
    // S4 rebuilds the local-issue summary of the generation request with the graph's own values (lastTurn survives the trace's repeated claims).
    const summary = JSON.parse(s4Probe.issueSummary(affirmed.state.graph, affirmed.trace)) as { issues: { lastTurn?: unknown }[] };
    assert.ok(summary.issues.length > 0);
    for (const issue of summary.issues) assert.equal(typeof issue.lastTurn, 'number');
  });
}

// S4 ties the accepted agree-candidate rule to the Jev criteria version of the very same record: the current text accepts only the grounded,
// undenied candidates; the older texts (up to the prompt-style version) accept only the earlier all-slot rule. No other pairing is genuine.
for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test(`v3 ${strategy} S4 binds the agree-candidate rule to the criteria version of the record`, async () => {
    const f = fixture(strategy, { aiPublic: true, historicalNameScope: true });
    const name = '鍵';
    const proposal = `これは「${name}」とかどうかな？`;
    await f.exchange(proposal, { action: 'accept', drafts: ['どの形のことか確かめますね。'], segments: [naming(proposal, name)] });
    const ask = 'その名前でいいか聞いているんだ。';
    const previous = structuredClone(f.state());
    const result = await f.exchange(ask, { action: 'accept', drafts: ['まだ、どの形か確かめられていません。'],
      segments: [{ quote: ask, name: null, targets: [], aspect: 'question', proposition: '呼び名でよいかの確認', act: 'ask' }] });
    assert.deepEqual(result.input.agreeNames, []);
    const { state, trace, events } = result;
    const profile = { id: 'research_trial_profile_v3', ...V3, localGrounding: { aiPublicClaims: true } };
    const key = JSON.stringify([trace.turnIndex, trace.lastEventId, trace.attemptNumber]);
    const request = result.requests.find(r => r.questions.action)!;
    const sent = JSON.parse(request.state);
    // The same request body as an older version would have recorded it: the three texts of the current version removed.
    const older = structuredClone(request);
    const c = older.questions.action.criteria as Record<string, string>;
    c.accept = c.accept.replace(/相手の発話が相槌だけ.*$/u, '');
    c.propose_name = c.propose_name.replace('相手が先に公開した呼び名はAIの新しい提案として出し直さない。', '');
    c.agree = JEV_ACTION_CRITERIA.agree;
    // ...and without the holistic-first sentences (a record of the loop text has none of them).
    c.confirm = c.confirm.replace(/全体の見立てだけで対象が共有され命名に進めるとき、すでに肯定された特徴.*$/u, '');
    c.defer = c.defer.replace(/残りの数だけで保留を一律に.*$/u, '');
    c.revisit = c.revisit.replace(/十分に共有できていて命名に進める場面で.*$/u, '');
    const verdict = (savedNames: unknown[], body: typeof request) => {
      const tampered = structuredClone(state);
      tampered.judgments.at(-1)!.jevTurn.agreeNames = savedNames as never;
      const trial = { profile, turns: [{ turn: trace.turnIndex, state: tampered }] };
      s4Probe.setContext({ v3: true, ledger: result.input.nameLedger, agree: savedNames as never[], facts: Array.isArray(trace.repairFacts) });
      try {
        if (s4Probe.agreeSource(trial, trace, key, { state: previous, events }) === 'invalid') return 'invalid';
        return s4Probe.originalQuestions(body, sent, V3.questionLayout);
      } finally { s4Probe.setContext({}); }
    };
    const allSlots = ids.map(figureId => ({ name, figureId, sourceTurn: 1 }));
    assert.equal(verdict([], request), true, 'a current record with the grounded rule (no candidate yet) is genuine');
    assert.equal(verdict(allSlots, request), false, 'a current record carrying every slot is the B1 error and is refused');
    assert.equal(verdict(allSlots, older), true, 'an older record keeps the earlier all-slot rule');
    assert.equal(verdict([], older), false, 'an older record cannot carry the current grounded list');
    assert.equal(verdict([{ name, figureId: ids[0], sourceTurn: 1 }], request), 'invalid', 'an unsupported single candidate matches no rule');
  });
}

const NOTE = 'そう見えるんですね。same? Need Japanese natural, ask confirm. Avoid confusing target.';
for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test(`v3 ${strategy}: a working note in the draft is regenerated; a note that stays is not published and nothing is saved`, async () => {
    const f = fixture(strategy);
    const regenerated = await f.exchange('丸い形のことです。', { action: 'accept', target: 3, drafts: [NOTE, 'そう見えるんですね。'] });
    assert.equal(regenerated.text, 'そう見えるんですね。');
    assert.deepEqual(regenerated.trace.generationGuard, { violations: ['working_note'], regenerated: true, fallback: false });

    const stuck = fixture(strategy), previous = structuredClone(stuck.state());
    await assert.rejects(stuck.exchange('丸い形のことです。', { action: 'accept', target: 3, drafts: [NOTE, NOTE] }), { code: 'unsafe_generation' });
    assert.deepEqual(stuck.state(), previous);
    assert.equal(stuck.attempt()?.publicSpeech, null);

    // A mixed violation is never passed through the orientation-only fallback sentence.
    const mixed = fixture(strategy), before = structuredClone(mixed.state());
    const both = '右側に出ています。Need Japanese natural, ask confirm.';
    await assert.rejects(mixed.exchange('丸い形のことです。', { action: 'accept', target: 3, drafts: [both, both] }), { code: 'unsafe_generation' });
    assert.deepEqual(mixed.state(), before);
    assert.deepEqual(mixed.attempt()?.generationGuard.violations.sort(), ['orientation_leak', 'working_note']);
  });
}

test('an English name the partner used in public is allowed however long ago it was said', async () => {
  const f = fixture('bypass-enabled');
  await f.exchange('これは Golden Gate Bridge みたいな形ですか？', { action: 'accept', target: 3, drafts: ['そうですね。'] });
  for (let i = 0; i < 20; i++) await f.exchange('うん、続けてください。', { action: 'accept', target: 3, drafts: ['はい。'] });
  const r = await f.exchange('その形はどうですか？', { action: 'accept', target: 3, drafts: ['Golden Gate Bridge のような形ですね。'] });
  assert.deepEqual(r.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
  assert.equal(r.text, 'Golden Gate Bridge のような形ですね。');
});

for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
  test(`holistic_v1 (${strategy}): a naming-act draft under accept is asked; an adopting label regenerates, a non-adopting one publishes`, async () => {
    const f = fixture(strategy, { holistic: true });
    const r = await f.exchange('丸い形のことです。', { action: 'accept', target: 3, draftActs: ['adopt_chosen'], drafts: ['この形は「時計」で呼びましょう。', 'そう見えるんですね。'] });
    assert.deepEqual(r.trace.generationGuard, { violations: ['draft_act_mismatch'], regenerated: true, fallback: false });
    assert.equal(r.text, 'そう見えるんですね。');
    assert.deepEqual(r.trace.draftActs!.map(a => [a.draft, a.status, a.choice]), [['initial', 'ok', 'adopt_chosen']]);
    const g = fixture(strategy, { holistic: true });
    const published = await g.exchange('丸い形のことです。', { action: 'accept', target: 3, draftActs: ['recount_only'], drafts: ['この形は「時計」で呼びましょう。'] });
    assert.deepEqual(published.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(published.text, 'この形は「時計」で呼びましょう。');
  });
  test(`holistic_v1 (${strategy}): a failed or repeatedly unconfirmed question is regenerated, then unsafe_generation; non-target drafts are never asked`, async () => {
    const f = fixture(strategy, { holistic: true });
    const r = await f.exchange('丸い形のことです。', { action: 'accept', target: 3, draftActs: ['fail'], drafts: ['この形は「時計」で決めましょう。', 'そう見えるんですね。'] });
    assert.deepEqual(r.trace.generationGuard, { violations: ['draft_act_unconfirmed'], regenerated: true, fallback: false });
    assert.equal(r.trace.draftActs![0].status, 'error');
    const g = fixture(strategy, { holistic: true });
    await assert.rejects(g.exchange('丸い形のことです。', { action: 'accept', target: 3, draftActs: ['fail', 'fail'], drafts: ['この形は「時計」で決めましょう。', 'この形は「時計」で決めましょう。'] }), { code: 'unsafe_generation' });
    assert.deepEqual(g.attempt()?.generationGuard.violations, ['draft_act_unconfirmed']);
    const h = fixture(strategy, { holistic: true });
    const plain = await h.exchange('丸い形のことです。', { action: 'accept', target: 3, drafts: ['そう見えるんですね。'] });
    assert.equal(plain.trace.draftActs, undefined);
    assert.equal(plain.requests.some(q => Object.hasOwn(q.questions, 'draft_naming')), false);
  });
}

test('holistic_v1: an agree draft is always asked and publishes only an adopting label; the older version is never asked', async () => {
  const f = fixture('bypass-enabled', { aiPublic: true, holistic: true });
  await share(f, 3);
  const proposal = `こちらの形は「${NEW_NAME}」でどうですか？`;
  const r = await f.exchange(proposal, { action: 'agree', target: 3, draftActs: ['recount_only', 'adopt_chosen'], segments: [naming(proposal, NEW_NAME)],
    drafts: [agreeSpeech(NEW_NAME), agreeSpeech(NEW_NAME)] });
  assert.deepEqual(r.trace.generationGuard, { violations: ['draft_act_mismatch'], regenerated: true, fallback: false });
  assert.deepEqual(r.trace.draftActs!.map(a => [a.draft, a.choice]), [['initial', 'recount_only'], ['retry', 'adopt_chosen']]);
  assert.equal(r.state.ledger[ids[3]].name, NEW_NAME);
  const old = fixture('bypass-enabled');
  const o = await old.exchange('丸い形のことです。', { action: 'accept', target: 3, drafts: ['この形は「時計」と呼びましょう。', 'そう見えるんですね。'] });
  assert.deepEqual(o.trace.generationGuard, { violations: ['naming_decision'], regenerated: true, fallback: false });
  assert.equal(o.trace.draftActs, undefined);
});

test('S4 rebuilds the propose_name targets without the name the partner proposed (current text version), the same as the request builder', async () => {
  for (const strategy of ['bypass-enabled', 'repair-first'] as const) {
    const f = fixture(strategy, { observations: proposalMemo() });
    // figure 4 has the single observed construal '時計'; the partner proposes exactly that name for it, so propose_name there is no longer offered.
    const quote = 'この形は「時計」とかどう？';
    const r = await f.exchange(quote, { action: 'accept', target: 4, drafts: ['そう見えますね。'], segments: [naming(quote, '時計', [ids[4]])] });
    const built = Object.keys(buildJevTargetPayload(r.input, 'propose_name').questions.target.criteria);
    assert.equal(built.includes('figure_4'), false, 'the request builder offers no propose_name for the partner-named figure');
    const sent = JSON.parse(r.requests.find(req => req.questions.action)!.state);
    s4Probe.setContext({ v3: true, style: 'holistic', ledger: r.input.nameLedger, agree: r.input.agreeNames, facts: Array.isArray(r.trace.repairFacts) });
    try { assert.deepEqual(s4Probe.targetQuestion(sent, 'propose_name').options.map((o: { label: string }) => o.label), built); }
    finally { s4Probe.setContext({}); }
  }
});
