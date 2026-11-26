// Independent Gate 1 contrasts through the real runtime, with synthetic dialogue and transports.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { JevAction, JevTarget } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { ReplayTape } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5');
const [first, second] = OWN.ownAnchors.map((anchor: {id: string}) => anchor.id) as string[];
const single = { kind: 'single', figureId: first } satisfies JevTarget;
const pair = { kind: 'multiple', figureIds: [first, second] } satisfies JevTarget;
const hole = '細長い穴が中央に一つある';
const seam = '縁に浅いくぼみがある';
const stem = '小さな棒が輪につながっている';
const alias = '糸の窓';
const adoption = 'では、この形を「' + alias + '」と呼びましょう。';

type Clause = Pick<LocalSegmentProposal, 'quote' | 'aspect' | 'targets'> & {
  act: LocalAct;
  name?: string;
  antecedent?: (claim: LocalClaimView) => boolean;
};
type Turn = {
  human: string;
  action: JevAction;
  target: string;
  drafts: string[];
  feature?: string;
  local?: Clause[];
  ai?: Clause[];
  referent?: string;
  tryAgree?: boolean;
  openIssue?: boolean;
};

const proposal = (quote: string): Clause => ({ quote, act: 'name_propose', aspect: 'name', targets: [first], name: alias });
const described = (quote: string, targets: string[], aspect: Clause['aspect'] = 'part'): Clause =>
  ({ quote, act: 'assert', aspect, targets });
const ask = (quote: string, targets: string[]): Clause => ({ quote, act: 'ask', aspect: 'question', targets });

function trial(strategy: Label, savedVersion?: 'jev_generation_retry_v5' | 'jev_generation_retry_v6') {
  const events: ReplayTape['events'] = [];
  const memo = structuredClone((OLD.state as ReplayTape['state']).observationMemo)!;
  for (const figure of memo.figures.slice(0, 2)) figure.analytic.shapes = [hole, seam, stem];
  let turn: Turn;
  let action: JevAction;
  let trace: JevTurnTrace | undefined;
  let drafts: string[] = [];
  let menu: Record<string, string>;
  let mockError: unknown;
  let responseId = 0;
  const transport = {
    enabled: true, questionLayout: profile.questionLayout, timeoutMs: profile.timeouts.decisionMs,
    readKey: async () => 'sk-or-synthetic-gate-one-00000000', researchLimits: { maxDeadlineMs: 600000 },
    async fetchImpl(_url: string, options: RequestInit) {
      try {
        const body = JSON.parse(String(options.body)) as JevDecisionPayload;
        const state = JSON.parse(body.state) as { aiSeq?: number; priorClaims?: LocalClaimView[] };
        const answers = Object.fromEntries(Object.entries(body.questions).map(([key, { criteria }]) => {
          const labels = Object.keys(criteria);
          let choice: string | undefined;
          if (key === 'human_referent') choice = turn.referent ?? 'figure_0';
          if (key === 'repair_issue') choice = turn.openIssue ? labels.find(label => label.startsWith('issue_')) : 'none';
          if (key === 'prospect') choice = turn.openIssue ? 'uncertain' : 'no_open_issue';
          if (key === 'basis') choice = turn.openIssue ? 'partner_uncertain' : 'none';
          if (key === 'action') {
            menu = criteria;
            action = turn.tryAgree && labels.includes('agree') ? 'agree' : turn.action;
            choice = action;
          }
          if (key === 'target') choice = action === 'agree' ? 'figure_0' : turn.target;
          if (key === 'feature') choice = labels.find(label => JSON.parse(criteria[label]).value === turn.feature);
          if (key === 'name') choice = labels.find(label => JSON.parse(criteria[label]).value === alias);
          if (key === 'draft_naming') choice = action === 'agree' ? 'adopt_chosen' : 'none';
          const match = /^segment_(\d+)_(act|antecedent|support|answer)$/u.exec(key);
          if (match) {
            const ai = state.aiSeq !== undefined || match[2] === 'support';
            const clause = (ai ? turn.ai : turn.local)?.[Number(match[1])];
            assert.ok(clause, key + ' has an extracted public clause');
            if (match[2] === 'act') choice = clause.act;
            if (match[2] === 'answer') choice = 'unknown';
            if (match[2] === 'support') choice = 'expressed';
            if (match[2] === 'antecedent') {
              const index = clause.antecedent ? state.priorClaims?.findIndex(clause.antecedent) ?? -1 : -1;
              if (clause.antecedent) assert.notEqual(index, -1);
              choice = index < 0 ? 'none' : 'claim_' + index;
            }
          }
          assert.ok(choice && labels.includes(choice), key + ' did not offer the scripted choice ' + choice);
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label =>
            [label, label === choice ? 1 : key === 'action' && turn.openIssue && label === 'confirm' ? 0.6 : 0])) }];
        }));
        return Response.json({ model: body.model, id: 'gen-gate-one-' + ++responseId, usage: { cost: 0 }, answers });
      } catch (error) {
        mockError = error;
        throw error;
      }
    },
  };
  const runtime = createProfileDialogue(profile, {
    strategy, image: OWN.ownImage, anchors: [...OWN.ownAnchors],
    technicalTrial: { version: 'adaptive_repair_v3' },
    ...(savedVersion ? { generationRetryVersion: savedVersion } : {}),
    observer: {
      async observeAll() { return structuredClone(memo); },
      async reobserve(): Promise<never> { throw new Error('no reobservation in this dialogue'); },
    },
    client: {
      async complete(_messages: unknown, { phase }: { phase: string }) {
        let text: string;
        if (phase === 'local_extraction' || phase === 'ai_extraction') {
          const clauses = phase === 'local_extraction' ? turn.local : turn.ai;
          text = JSON.stringify((clauses ?? []).map((clause, index): LocalSegmentProposal => ({
            segmentId: String(index + 1), quote: clause.quote, proposition: clause.quote,
            aspect: clause.aspect, targets: clause.targets, name: clause.name ?? null, linkedIssueId: null, respondsToTurn: null,
          })));
        } else {
          assert.equal(phase, 'generation');
          const draft = turn.tryAgree && action === 'agree' ? adoption : turn.drafts[drafts.length];
          assert.ok(draft, 'the generation send must have an offline reply');
          drafts.push(draft);
          text = draft;
        }
        return { text, model: 'synthetic-gate-one-luna', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
    jevDecision: createJevDecisionClient(transport)!,
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy })!,
      aiPublicTransport: transport,
    },
    onJevTurnTrace(value: JevTurnTrace) { trace = structuredClone(value); },
  });
  let state = runtime.initialPrivateState() as ReplayTape['state'];
  return async function say(next: Turn) {
    turn = next;
    trace = undefined;
    drafts = [];
    menu = {};
    mockError = undefined;
    const seq = events.length + 1;
    const human = { id: 'synthetic-human-' + seq, seq, speaker: 'human' as const, text: turn.human };
    events.push(human);
    const before = structuredClone(state);
    const outcome = await runtime.runAiTurn({ events: [...events], privateState: state, lastEventId: human.id, requestSeq: seq })
      .then(result => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
    if (mockError) throw mockError;
    assert.deepEqual(state, before, 'the caller-owned state is immutable');
    const savedTrace = trace as JevTurnTrace | undefined;
    assert.ok(savedTrace, 'the runtime records the attempt');
    const text = (outcome.result?.text ?? null) as string | null;
    if (outcome.result) {
      assert.equal(text, savedTrace.publicSpeech);
      state = outcome.result.privateState as ReplayTape['state'];
      events.push({ id: 'synthetic-ai-' + (seq + 1), seq: seq + 1, speaker: 'ai', text: text! });
    }
    return { ...outcome, trace: savedTrace, menu, drafts, before, state, text };
  };
}

async function namingCheck(say: ReturnType<typeof trial>, questionTargets: string[], target = 'figure_0') {
  const human = 'この形に「' + alias + '」という呼び名はどうですか？';
  const description = hole + '形が見えます。';
  const question = target === 'figure_0' ? '同じ図形を見ていますか？' : 'その二つのどちらを見ていますか？';
  const checked = await say({
    human, local: [proposal(human)], action: 'confirm', target, feature: hole,
    referent: target === 'figure_0' ? 'figure_0' : 'multiple',
    drafts: [description + question], ai: [described(description, [first]), ask(question, questionTargets)],
  });
  assert.ifError(checked.error);
  assert.deepEqual(checked.trace.executed?.target, target === 'figure_0' ? single : pair);
  assert.equal(checked.state.ledger[first].status, 'unassigned');
  const candidates = checked.trace.aiPublic?.pending?.candidates;
  assert.deepEqual(candidates?.map(({ act, targets }) => ({ act, targets })), [
    { act: 'assert', targets: [first] }, { act: 'ask', targets: questionTargets },
  ], 'the public description and the question have separately verified claims');
  return checked;
}

async function considerName(say: ReturnType<typeof trial>, answer?: Clause) {
  const approval = 'さっきの呼び名でどうでしょう？';
  const local: Clause[] = [{
    quote: approval, act: 'name_propose', aspect: 'name', targets: [],
    antecedent: claim => claim.speaker === 'human' && claim.act === 'name_propose' && claim.name === alias,
  }];
  if (answer) local.unshift(answer);
  const result = await say({
    human: (answer?.quote ?? '') + approval, local, action: 'confirm', target: 'figure_0', feature: seam,
    tryAgree: true, drafts: [seam + '図形でしょうか？'],
  });
  assert.ifError(result.error);
  assert.ok(result.trace.namingRequest);
  assert.equal(result.trace.aiPublic?.application?.status, 'applied');
  return result;
}

for (const strategy of strategies) {
  for (const targets of [[], [first]]) {
    test(`B1 ${strategy} keeps a name pending while the public figure question is unanswered (${targets.length ? 'explicit target' : 'empty target'})`, async () => {
      const say = trial(strategy);
      await namingCheck(say, targets);
      const result = await considerName(say);
      assert.deepEqual({
        offered: Object.hasOwn(result.menu, 'agree'), action: result.trace.executed?.action,
        publicSpeech: result.text, ledger: result.state.ledger,
      }, { offered: false, action: 'confirm', publicSpeech: seam + '図形でしょうか？', ledger: result.before.ledger });
    });
  }

  for (const answer of [
    described('私が指しているのは、細長い穴が中央にある方です。', [first], 'referent'),
    described('ええ、中央に細長い穴が一つあります。', [first]),
  ]) {
    test(`B1 ${strategy} can agree after a participant answers the public check (${answer.aspect})`, async () => {
      const say = trial(strategy);
      await namingCheck(say, []);
      const result = await considerName(say, answer);
      assert.ok(Object.hasOwn(result.menu, 'agree'));
      assert.equal(result.trace.executed?.action, 'agree');
      assert.deepEqual(result.trace.executed?.target, single);
      assert.equal(result.text, adoption);
      assert.deepEqual(result.state.ledger, { ...result.before.ledger, [first]: { status: 'agreed', name: alias } });
    });
  }

  test(`B1 ${strategy} keeps the name pending when a two-figure check is unanswered`, async () => {
    const say = trial(strategy);
    await namingCheck(say, [], 'figures_0_1');
    const result = await considerName(say);
    assert.ok(!Object.hasOwn(result.menu, 'agree'));
    assert.equal(result.trace.executed?.action, 'confirm');
    assert.equal(result.text, seam + '図形でしょうか？');
    assert.deepEqual(result.state.ledger, result.before.ledger);
  });

  test(`B1 ${strategy} can resolve a two-figure check that has an empty question target`, async () => {
    const say = trial(strategy);
    await namingCheck(say, [], 'figures_0_1');
    const result = await considerName(say, described('二つのうち、中央に細長い穴がある方です。', [first], 'referent'));
    assert.equal(result.trace.executed?.action, 'agree');
    assert.deepEqual(result.trace.executed?.target, single);
    assert.equal(result.text, adoption);
    assert.deepEqual(result.state.ledger, { ...result.before.ledger, [first]: { status: 'agreed', name: alias } });
  });

  test(`B1 ${strategy} preserves the recorded v5 treatment of an empty question target`, async () => {
    const say = trial(strategy, 'jev_generation_retry_v5');
    await namingCheck(say, []);
    const result = await considerName(say);
    assert.equal(result.trace.generationRetryVersion, 'jev_generation_retry_v5');
    assert.equal(result.trace.executed?.action, 'agree');
    assert.equal(result.text, adoption);
    assert.deepEqual(result.state.ledger[first], { status: 'agreed', name: alias });
  });
}

const moving = 'では、次の図形に進みましょう。';
const continuing = '先ほどの二つを見比べると、' + stem + 'のはどちらですか？';

async function ambiguousPair(say: ReturnType<typeof trial>) {
  const human = '似た輪が二つあって、どちらかはまだ分かりません。';
  const checked = await say({
    human, local: [described(human, [first, second], 'referent')], referent: 'multiple',
    action: 'confirm', target: 'figures_0_1', feature: hole,
    drafts: ['中央に細長い穴が一つあるのはどちらですか？'],
  });
  assert.ifError(checked.error);
  assert.deepEqual(checked.trace.executed?.target, pair);
}

function moveOn(drafts: string[]): Turn {
  const uncertainty = 'まだ区別できません。';
  return {
    human: uncertainty + '今の二つは置いて、別の図形に進んでもいいですか？',
    local: [described(uncertainty, [first, second], 'referent')], referent: 'multiple',
    action: 'move_on', target: 'figure_2', openIssue: true, feature: stem, drafts,
  };
}

function intervention(trace: JevTurnTrace) {
  assert.ok(trace.intervention && typeof trace.intervention === 'object');
  return trace.intervention;
}

for (const strategy of strategies) {
  test(`B2 ${strategy} publishes only the move or confirmation that the strategy executed`, async () => {
    const say = trial(strategy);
    await ambiguousPair(say);
    const result = await say(moveOn([moving, continuing]));
    assert.ifError(result.error);
    const decision = intervention(result.trace);
    assert.equal(decision.original.action, 'move_on');
    if (strategy === 'repair-first') {
      assert.equal(decision.reasonCode, 'vetoed_bypass_action');
      assert.equal(decision.rerank?.policyId, 'saved_action_scores_open_issue_v1');
      assert.equal(result.trace.executed?.action, 'confirm');
      assert.deepEqual(result.trace.executed?.target, pair);
      assert.equal(result.trace.executed?.feature, stem);
      assert.deepEqual(result.drafts, [moving, continuing]);
      assert.equal(result.text, continuing);
      assert.equal(result.trace.generationGuard.regenerated, true);
      assert.ok(result.trace.generationGuard.violations.length > 0);
      assert.equal(result.trace.generationGuard.fallback, false);
    } else {
      assert.equal(decision.disposition, 'adopted');
      assert.equal(result.trace.executed?.action, 'move_on');
      assert.deepEqual(result.drafts, [moving]);
      assert.equal(result.text, moving);
      assert.equal(result.trace.generationGuard.regenerated, false);
    }
  });

  test(`B2 ${strategy} rewrites an unselected move during an ordinary confirmation`, async () => {
    const say = trial(strategy);
    await ambiguousPair(say);
    const result = await say({
      ...moveOn([moving, continuing]), action: 'confirm', target: 'figures_0_1', openIssue: false,
    });
    assert.ifError(result.error);
    assert.equal(intervention(result.trace).disposition, 'adopted');
    assert.equal(result.trace.executed?.action, 'confirm');
    assert.deepEqual(result.trace.executed?.target, pair);
    assert.equal(result.trace.executed?.feature, stem);
    assert.deepEqual(result.drafts, [moving, continuing]);
    assert.equal(result.text, continuing);
    assert.equal(result.trace.generationGuard.fallback, false);
  });

  test(`B2 ${strategy} may narrow the current candidates without triggering a rewrite`, async () => {
    const say = trial(strategy);
    await ambiguousPair(say);
    const narrowed = '先ほどの二つのうち、' + seam + '図形を見ていますか？';
    const result = await say({
      human: '二つを見比べています。', referent: 'multiple',
      action: 'confirm', target: 'figure_0', feature: seam, drafts: [narrowed],
    });
    assert.ifError(result.error);
    assert.equal(result.trace.executed?.action, 'confirm');
    assert.deepEqual(result.trace.executed?.target, single);
    assert.deepEqual(result.drafts, [narrowed]);
    assert.equal(result.text, narrowed);
  });

  test(`B2 ${strategy} may continue to a new figure after a completed agreement`, async () => {
    const say = trial(strategy);
    const identified = '私が指しているのは、中央に細長い穴がある方です。';
    const named = '「' + alias + '」と呼びませんか？';
    const agreed = await say({
      human: identified + named, local: [described(identified, [first], 'referent'), proposal(named)],
      action: 'agree', target: 'figure_0', drafts: [adoption],
    });
    assert.ifError(agreed.error);
    assert.deepEqual(agreed.state.ledger[first], { status: 'agreed', name: alias });
    const next = await say({ human: '呼び名が決まりましたね。別の図形も見ませんか？', referent: 'none',
      action: 'accept', target: 'none', drafts: [moving] });
    assert.ifError(next.error);
    assert.equal(next.trace.executed?.action, 'accept');
    assert.deepEqual(next.drafts, [moving]);
    assert.equal(next.text, moving);
    assert.deepEqual(next.state.ledger, agreed.state.ledger);
  });
}

for (const action of ['move_on', 'defer'] as const) {
  test(`B2 repair-first stops with the existing recovery error after a ${action} veto and two drafts that move on`, async () => {
    const say = trial('repair-first');
    await ambiguousPair(say);
    const result = await say({ ...moveOn([moving, moving]), action, target: action === 'defer' ? 'figures_0_1' : 'figure_2' });
    assert.equal(intervention(result.trace).original.action, action);
    assert.equal(intervention(result.trace).reasonCode, 'vetoed_bypass_action');
    assert.equal(result.trace.executed?.action, 'confirm');
    assert.deepEqual(result.drafts, [moving, moving]);
    assert.equal(result.text, null);
    assert.equal(result.trace.publicSpeech, null);
    assert.equal(result.trace.status, 'error');
    assert.equal(result.trace.errorCode, 'unsafe_generation');
    assert.equal(result.trace.generationGuard.fallback, false);
    assert.deepEqual(result.state, result.before);
  });
}

test('B2 preserves the recorded v5 handling of a post-veto draft', async () => {
  const say = trial('repair-first', 'jev_generation_retry_v5');
  await ambiguousPair(say);
  const result = await say(moveOn([moving, continuing]));
  assert.ifError(result.error);
  assert.equal(result.trace.generationRetryVersion, 'jev_generation_retry_v5');
  assert.equal(intervention(result.trace).reasonCode, 'vetoed_bypass_action');
  assert.equal(result.trace.executed?.action, 'confirm');
  assert.deepEqual(result.drafts, [moving]);
  assert.equal(result.text, moving);
});

const moves = ['うん、次いこう。', 'じゃあ、次の図形を見てみよう。'] as const;
for (const [index, draft] of moves.entries()) {
  for (const strategy of strategies) {
    test(`Audit 16 B2 ${strategy} handles short move wording ${index + 1} according to the executed action`, async () => {
      const say = trial(strategy);
      await ambiguousPair(say);
      const result = await say(moveOn([draft, continuing]));
      assert.ifError(result.error);
      assert.equal(intervention(result.trace).original.action, 'move_on');
      if (strategy === 'repair-first') {
        assert.equal(intervention(result.trace).reasonCode, 'vetoed_bypass_action');
        assert.equal(result.trace.executed?.action, 'confirm');
        assert.deepEqual(result.trace.executed?.target, pair);
        assert.equal(result.trace.executed?.feature, stem);
        assert.deepEqual(result.drafts, [draft, continuing]);
        assert.equal(result.text, continuing);
        assert.equal(result.trace.generationGuard.regenerated, true);
        assert.equal(result.trace.generationGuard.fallback, false);
      } else {
        assert.equal(intervention(result.trace).disposition, 'adopted');
        assert.equal(result.trace.executed?.action, 'move_on');
        assert.deepEqual(result.drafts, [draft]);
        assert.equal(result.text, draft);
        assert.deepEqual(result.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
      }
    });
  }

  test(`Audit 16 B2 retains v6 handling of short move wording ${index + 1} on a recorded trial`, async () => {
    const say = trial('repair-first', 'jev_generation_retry_v6');
    await ambiguousPair(say);
    const result = await say(moveOn([draft, continuing]));
    assert.ifError(result.error);
    assert.equal(result.trace.generationRetryVersion, 'jev_generation_retry_v6');
    assert.equal(intervention(result.trace).reasonCode, 'vetoed_bypass_action');
    assert.equal(result.trace.executed?.action, 'confirm');
    assert.deepEqual(result.drafts, [draft]);
    assert.equal(result.text, draft);
  });
}

for (const strategy of strategies) {
  for (const [label, draft] of [
    ['a negated move', '次には進まず、先ほどの二つで' + stem + 'のはどちらか教えてください。'],
    ['a preface to a check', '次に、先ほどの二つで' + stem + 'のはどちらか確認させてください。'],
  ] as const) {
    test(`Audit 16 B2 ${strategy} publishes ${label} when the draft continues the current check`, async () => {
      const say = trial(strategy);
      await ambiguousPair(say);
      const result = await say({
        ...moveOn([draft]), action: strategy === 'repair-first' ? 'move_on' : 'confirm',
        target: strategy === 'repair-first' ? 'figure_2' : 'figures_0_1',
        openIssue: strategy === 'repair-first',
      });
      assert.ifError(result.error);
      assert.equal(intervention(result.trace).reasonCode, strategy === 'repair-first' ? 'vetoed_bypass_action' : 'no_intervention');
      assert.equal(result.trace.executed?.action, 'confirm');
      assert.deepEqual(result.trace.executed?.target, pair);
      assert.equal(result.trace.executed?.feature, stem);
      assert.deepEqual(result.drafts, [draft]);
      assert.equal(result.text, draft);
      assert.deepEqual(result.trace.generationGuard, { violations: [], regenerated: false, fallback: false });
    });
  }
}

test('Audit 16 B2 repair-first leaves the prior state intact when both short move drafts are rejected', async () => {
  const say = trial('repair-first');
  await ambiguousPair(say);
  const result = await say(moveOn([...moves]));
  assert.equal(intervention(result.trace).reasonCode, 'vetoed_bypass_action');
  assert.equal(result.trace.executed?.action, 'confirm');
  assert.deepEqual(result.drafts, [...moves]);
  assert.equal(result.text, null);
  assert.equal(result.trace.publicSpeech, null);
  assert.equal(result.trace.status, 'error');
  assert.equal(result.trace.errorCode, 'unsafe_generation');
  assert.equal(result.trace.generationGuard.fallback, false);
  assert.deepEqual(result.state, result.before);
});
