// Independent acceptance of audit 13 findings 1 and 2.
// The complete dialogue, observations and service responses are synthetic.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import type { DialoguePolicy, JevAction, JevDecisionInput, JevTarget } from '../dialogue-model/runtime/decision/contract.ts';
import { buildHumanReferentPayload, buildJevDecisionDetailPayload, buildJevDecisionPayload, buildJevTargetPayload, createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { ReplayTape } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { priorClaimViews } from '../dialogue-model/runtime/local-grounding/derive.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { MODEL, normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { buildRecords, Label } from './support/s4-v3-records.ts';

const strategies = ['repair-first', 'bypass-enabled'] as const;
const manifest = normal.run.manifest;
const makeProfile = (policy: DialoguePolicy) =>
  researchTrialProfileV3(manifest.lunaRequest, manifest.timeouts, 'two_stage_v3', policy);
type Profile = ReturnType<typeof makeProfile>;
type Event = ReplayTape['events'][number];
type Checkpoint = { state: ReplayTape['state']; events: Event[] };
type Request = { phase: 'referent' | 'action' | 'target' | 'detail'; body: JevDecisionPayload; raw: string };
type Segment = Omit<LocalSegmentProposal, 'segmentId' | 'quote' | 'linkedIssueId' | 'name' | 'respondsToTurn'> & {
  act: LocalAct;
  name?: string;
  respondsToTurn?: number;
  antecedent?: string;
  quote?: string;
};
type Turn = {
  human: string;
  speech: string;
  action: JevAction;
  target: number;
  feature?: string;
  local?: Segment | Segment[];
  ai?: Segment;
  referent?: string;
  probe?: { name: string; chooseTarget: number };
};

const slots = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id) as string[];
const [first, second] = slots;
const own = { ...OWN, ownImage: { ...OWN.ownImage, mimeType: 'image/png' as const } };
const name = '渡り紐';
const known = '細いひもが二本ある';
const other = '輪の内側に刻み目がある';
const recoveryFeature = '輪に短い枝が接している';
const approval = 'さっきの呼び名で大丈夫ですか？';

function syntheticCheckpoint(): Checkpoint {
  const state = structuredClone(OLD.state) as ReplayTape['state'];
  state.observationMemo!.figures[0].analytic.shapes = [known, other, recoveryFeature];
  state.observationMemo!.figures[1].analytic.shapes = [known, other];
  return { state, events: [] };
}

function session(profile: Profile, strategy: Label) {
  let current: Turn;
  let action: JevAction;
  let target: number;
  let publicSpeech: string;
  let sends: Request[] = [];
  let mockError: unknown;
  let trace: JevTurnTrace | undefined;
  let responseNo = 0;
  let { state, events } = syntheticCheckpoint();
  const memo = state.observationMemo;
  assert.ok(memo, 'the synthetic trial has a cached observation');

  const transport = {
    enabled: true,
    readKey: async () => 'sk-or-synthetic-judgment-input-0000',
    questionLayout: profile.questionLayout,
    timeoutMs: profile.timeouts.decisionMs,
    researchLimits: { maxDeadlineMs: 600000 },
    async fetchImpl(_url: string, options: RequestInit) {
      try {
        const raw = String(options.body);
        const body = JSON.parse(raw) as JevDecisionPayload;
        const questions = body.questions;
        const aiPublic = Object.hasOwn(JSON.parse(body.state), 'aiSeq');
        const phase = questions.human_referent ? 'referent' : questions.action ? 'action'
          : questions.target ? 'target' : questions.feature || questions.name ? 'detail' : null;
        if (phase) sends.push({ phase, body, raw });
        const answers = Object.fromEntries(Object.entries(questions).map(([key, { criteria }]) => {
          const labels = Object.keys(criteria);
          let choice: string | undefined;
          switch (key) {
            case 'human_referent': choice = current.referent ?? 'figure_' + current.target; break;
            case 'target': {
              const asked = 'figure_' + target;
              if (action === 'agree' && current.probe && !labels.includes(asked)) {
                choice = labels.find(label => /^figure_\d+$/u.test(label));
                if (choice) target = Number(choice.slice('figure_'.length));
              } else choice = asked;
              break;
            }
            case 'action':
              if (current.probe && labels.includes('agree')) {
                action = 'agree';
                target = current.probe.chooseTarget;
              }
              choice = action;
              break;
            case 'repair_issue':
            case 'basis': choice = 'none'; break;
            case 'prospect': choice = 'no_open_issue'; break;
            case 'feature': choice = labels.find(label => JSON.parse(criteria[label]).value === current.feature); break;
            case 'name': {
              const expected = current.probe?.name ?? (Array.isArray(current.local) ? current.local[0]?.name : current.local?.name);
              choice = labels.find(label => JSON.parse(criteria[label]).value === expected);
              break;
            }
            case 'draft_naming': choice = action === 'agree' ? 'adopt_chosen' : 'none'; break;
            default: {
              const match = /^segment_(\d+)_(act|antecedent|support|answer)$/u.exec(key);
              assert.ok(match, 'unexpected native question ' + key);
              const segments = Array.isArray(current.local) ? current.local : current.local ? [current.local] : [];
              const segment = aiPublic || match[2] === 'support' ? current.ai : segments[Number(match[1])];
              assert.ok(segment, key + ' must refer to a scripted public clause');
              if (match[2] === 'support') { choice = 'expressed'; break; }
              if (match[2] === 'answer') { choice = 'unknown'; break; }
              if (match[2] === 'act') { choice = segment.act; break; }
              const antecedent = segment?.antecedent;
              if (!antecedent) {
                choice = 'none';
                break;
              }
              choice = labels.find(label => criteria[label].includes(JSON.stringify(antecedent)));
              assert.ok(choice, 'the classifier must be offered the actual human proposal');
              break;
            }
          }
          assert.ok(choice && labels.includes(choice), key + ' did not offer ' + choice);
          return [key, { type: 'choice', choice, probabilities: Object.fromEntries(
            labels.map(label => [label, Number(label === choice)]),
          ) }];
        }));
        return Response.json({ model: body.model, id: 'gen-judgment-input-' + ++responseNo, usage: { cost: 0 }, answers });
      } catch (error) {
        mockError = error;
        throw error;
      }
    },
  };
  const runtime = createProfileDialogue(profile, {
    strategy, technicalTrial: { version: 'adaptive_repair_v3' },
    image: OWN.ownImage, anchors: [...OWN.ownAnchors],
    observer: {
      async observeAll() { return structuredClone(memo); },
      async reobserve(): Promise<never> { throw new Error('unexpected reobservation'); },
    },
    client: {
      async complete(_messages: unknown, { phase }: { phase: string }) {
        const { local } = current;
        const segments = Array.isArray(local) ? local : local ? [local] : [];
        const extraction = (items: Segment[], utterance: string) => JSON.stringify(items.map((segment, index) => ({
          segmentId: String(index + 1), quote: segment.quote ?? utterance, proposition: segment.proposition,
          targets: segment.targets, aspect: segment.aspect, name: segment.name ?? null,
          linkedIssueId: null, respondsToTurn: segment.respondsToTurn ?? null,
        } satisfies LocalSegmentProposal)));
        let text: string;
        if (phase === 'local_extraction') text = extraction(segments, current.human);
        else if (phase === 'ai_extraction') text = extraction(current.ai ? [current.ai] : [], publicSpeech);
        else {
          assert.equal(phase, 'generation');
          text = action === 'agree' && current.probe ? adopt(current.probe.name) : current.speech;
          publicSpeech = text;
        }
        return { text, model: 'synthetic-judgment-luna', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
    jevDecision: createJevDecisionClient(transport)!,
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...transport, timeoutMs: profile.timeouts.localMs, dialoguePolicy: profile.dialoguePolicy })!,
      aiPublicTransport: transport,
    },
    onJevTurnTrace(record: JevTurnTrace) { trace = record; },
  });
  const { agreeNameScopeVersion } = runtime.initialPrivateState() as ReplayTape['state'];
  assert.ok(agreeNameScopeVersion, 'a new two-stage v3 trial has a naming scope version');
  state.agreeNameScopeVersion = agreeNameScopeVersion;
  return {
    checkpoint: () => structuredClone({ state, events }),
    async say(turn: Turn) {
      current = turn;
      action = turn.action;
      target = turn.target;
      sends = [];
      mockError = undefined;
      trace = undefined;
      const seq = events.length + 1;
      const human: Event = { id: 'synthetic-human-' + seq, seq, speaker: 'human', text: turn.human };
      events = [...events, human];
      const publicAtSend = structuredClone(events);
      const result = await runtime.runAiTurn({ events, privateState: state, lastEventId: human.id, requestSeq: seq })
        .catch((error: unknown) => { throw mockError ?? error; });
      if (mockError) throw mockError;
      const captured = trace as JevTurnTrace | undefined;
      assert.ok(captured);
      const executed = captured.executed;
      assert.equal(executed?.action, action);
      assert.deepEqual(executed?.target, { kind: 'single', figureId: slots[target] });
      assert.equal(result.text, action === 'agree' && turn.probe ? adopt(turn.probe.name) : turn.speech);
      assert.equal(captured.publicSpeech, result.text);
      state = result.privateState as ReplayTape['state'];
      events = [...events, { id: 'synthetic-ai-' + (seq + 1), seq: seq + 1, speaker: 'ai', text: result.text }];
      return { sends, publicAtSend, state, trace: captured, text: result.text };
    },
  };
}

const accept = (human: string, speech: string, target = 0): Turn => ({ human, speech, action: 'accept', target });
const confirm = (human: string, target = 0, feature = known): Turn => ({
  human, speech: feature + '形ですか？', action: 'confirm', target, feature,
});
const adopt = (label: string) => 'では、この形を「' + label + '」と呼びましょう。';
function proposal(index: number): Turn {
  return {
    ...confirm('この形は「' + name + '」と呼びませんか？', 0, other),
    local: { act: 'name_propose', aspect: 'name', targets: [slots[index]], name, proposition: name + 'という呼称案' },
  };
}
function reply(claim: LocalClaimView, target: number, referent: string): Turn {
  return {
    ...confirm(approval, 0, recoveryFeature),
    referent,
    probe: { name, chooseTarget: target },
    local: { act: 'name_propose', aspect: 'name', targets: [...claim.targets], antecedent: claim.id,
      proposition: '先に出した呼称案でよいか確かめる' },
  };
}
type Outcome = Awaited<ReturnType<ReturnType<typeof session>['say']>>;
function claimAt(outcome: Outcome, quote: string) {
  const claim = priorClaimViews(outcome.state.graph).find(item => item.quote === quote && item.speaker === 'human');
  assert.ok(claim, 'the public clause must produce a verified human claim');
  return claim;
}
function offers(outcome: Outcome, key: string) {
  const question = outcome.sends.find(send => send.body.questions[key])?.body.questions[key];
  assert.ok(question, 'missing native ' + key + ' request');
  return question.criteria;
}

for (const strategy of strategies) {
  test(strategy + ' does not adopt an earlier name for an extractor target that contradicts the public clarification', async () => {
    const trial = session(makeProfile('holistic_v5'), strategy);
    await trial.say(accept('よく似た形がもう一枚ありますね。', '似た輪郭の形がもう一枚あります。', 1));
    const question = await trial.say(confirm('ひもの本数で見分けたいです。'));
    assert.deepEqual(question.trace.executed?.target, { kind: 'single', figureId: first });
    const clarification = await trial.say({
      ...accept('はい、細いひもが二本見える方のことです。', '二本ある形についてですね。'),
      local: { act: 'assert', aspect: 'part', targets: [first], proposition: known },
      ai: { act: 'assert', aspect: 'part', targets: [first], proposition: known },
    });
    assert.deepEqual(claimAt(clarification, 'はい、細いひもが二本見える方のことです。').targets, [first]);
    const proposed = await trial.say(proposal(1));
    const outcome = await trial.say(reply(claimAt(proposed, proposal(1).human), 1, 'figure_0'));
    assert.equal(outcome.trace.humanReferent?.scores?.[first], 1);
    const wrongOffer = 'agree' in offers(outcome, 'action') && 'figure_1' in offers(outcome, 'target');
    assert.deepEqual({ wrongOffer, savedOnWrongFigure: outcome.state.ledger[second], executedOnWrongFigure:
      outcome.trace.executed?.action === 'agree' && outcome.trace.executed.target.kind === 'single' &&
        outcome.trace.executed.target.figureId === second },
      { wrongOffer: false, savedOnWrongFigure: { name: null, status: 'unassigned' }, executedOnWrongFigure: false });
    if (outcome.trace.executed?.action === 'agree') {
      assert.deepEqual(outcome.state.ledger[first], { status: 'agreed', name });
      assert.equal(outcome.text, adopt(name));
    } else {
      assert.equal(outcome.trace.executed?.action, 'confirm');
      assert.ok(!outcome.text.includes(name));
    }
  });

  test(strategy + ' does not treat a short approval and a single score as resolving two publicly remaining candidates', async () => {
    const trial = session(makeProfile('holistic_v5'), strategy);
    const ambiguous = '二枚に似た輪があり、どちらを指しているかまだ決まりません。';
    const firstTurn = await trial.say({
      ...confirm(ambiguous), referent: 'multiple',
      local: { aspect: 'referent', act: 'assert', targets: [first, second], proposition: 'どちらかにまだ絞れていない' },
    });
    assert.deepEqual(claimAt(firstTurn, ambiguous).targets, [first, second]);
    const initial = { ...proposal(0), referent: 'multiple' };
    const proposed = await trial.say(initial);
    const approvalTurn = reply(claimAt(proposed, initial.human), 0, 'figure_0');
    const outcome = await trial.say(approvalTurn);
    assert.equal(outcome.trace.humanReferent?.scores?.[first], 1);
    assert.deepEqual({
      agreeOffered: 'agree' in offers(outcome, 'action'),
      agreed: [first, second].map(id => outcome.state.ledger[id].status),
      action: outcome.trace.executed?.action, published: outcome.text,
    }, { agreeOffered: false, agreed: ['unassigned', 'unassigned'], action: 'confirm',
      published: approvalTurn.speech });
  });

  test(strategy + ' can adopt the earlier name after the participant explicitly distinguishes the figure', async () => {
    const trial = session(makeProfile('holistic_v5'), strategy);
    await trial.say({ ...confirm('似た輪が二枚あり、まだ分かりません。'), referent: 'multiple' });
    const proposed = await trial.say(proposal(0));
    const answer = 'ひもが二本ある方を指しています。';
    const clarified = await trial.say({
      ...accept(answer, 'ええ、ひもが二本ある方ですね。'),
      local: { act: 'assert', aspect: 'referent', targets: [first], proposition: 'ひもが二本ある方を指す' },
      ai: { act: 'assert', aspect: 'part', targets: [first], proposition: known },
    });
    assert.deepEqual(claimAt(clarified, answer).targets, [first]);
    const out = await trial.say(reply(claimAt(proposed, proposal(0).human), 0, 'figure_0'));
    assert.ok('agree' in offers(out, 'action'));
    assert.deepEqual(out.state.ledger[first], { name, status: 'agreed' });
    assert.deepEqual(out.state.ledger[second], { name: null, status: 'unassigned' });
    assert.equal(out.text, adopt(name));
  });

  test(strategy + ' can adopt the name after a description answers the single-figure check', async () => {
    const trial = session(makeProfile('holistic_v5'), strategy);
    const check = confirm('ひもの本数で似た形を見分けられますか？');
    const asked = await trial.say({
      ...check, ai: { aspect: 'part', act: 'ask', targets: [first], proposition: known },
    });
    assert.deepEqual(asked.trace.executed?.target, { kind: 'single', figureId: first });
    const description = '細いひもが二本ついていて、輪のところで合流しています。';
    const answered = await trial.say({
      ...accept(description, '二本のひもが輪につながっているんですね。'),
      local: { aspect: 'part', act: 'assert', targets: [first], proposition: '二本のひもが輪で合流する' },
    });
    // The AI's published claim is installed when the next human turn arrives.
    const publicQuestion = priorClaimViews(answered.state.graph).find(claim =>
      claim.speaker === 'ai' && claim.quote === check.speech && claim.act === 'ask');
    assert.ok(publicQuestion, 'the AI feature question is recorded as a public claim');
    assert.deepEqual(publicQuestion.targets, [first]);
    const answer = claimAt(answered, description);
    assert.deepEqual(answer.targets, [first]);
    assert.equal(answer.sourceTurn, publicQuestion.sourceTurn + 1);

    const naming = proposal(0);
    const proposed = await trial.say(naming);
    assert.deepEqual(proposed.state.ledger, answered.state.ledger);
    const outcome = await trial.say(reply(claimAt(proposed, naming.human), 0, 'figure_0'));
    assert.ok('agree' in offers(outcome, 'action'));
    assert.ok('figure_0' in offers(outcome, 'target'));
    assert.equal(outcome.trace.executed?.action, 'agree');
    assert.deepEqual(outcome.trace.executed?.target, { kind: 'single', figureId: first });
    assert.deepEqual(outcome.state.ledger, { ...proposed.state.ledger, [first]: { name, status: 'agreed' } });
    assert.equal(outcome.text, adopt(name));
  });
}

function featureOffer(outcome: Outcome) {
  return Object.values(offers(outcome, 'feature')).map(item => (JSON.parse(item) as { value: string }).value);
}

type Material = {
  claims: [string, number, string, string, string[], string | null, string | null, string, string][];
  repairHistory: [number, unknown, unknown, unknown, [string, string, string[], string][], ...unknown[]][];
  answerClaims?: [string, number | null, string, string[], string][];
  figures: Record<string, { actions: [JevAction, number, string?, string[]?][] }>;
  inputBudget: { omitted: { claims: number; repairHistory: number } };
};

function missingAnswers(material: Material, knownClaims: readonly LocalClaimView[]) {
  const phrases = new Map([
    ...material.claims.map(([id, , , , , , , proposition]) => [id, proposition] as const),
    ...material.repairHistory.flatMap(([, , , , replies]) =>
      replies.map(([id, , , proposition]) => [id, proposition] as const)),
  ]);
  const originals = new Map(knownClaims.map(claim => [claim.id, claim]));
  for (const [id, turn, act, targets, proposition] of material.answerClaims ?? []) {
    const original = originals.get(id);
    assert.ok(original, 'the supplemental answer row resolves to a verified claim');
    assert.equal(turn, original.sourceTurn);
    assert.equal(act, original.act);
    assert.deepEqual(targets, original.targets.map(target => 'f' + slots.indexOf(target)));
    assert.equal(proposition, original.proposition);
    phrases.set(id, proposition);
  }
  const references = Object.values(material.figures).flatMap(({ actions }) =>
    actions.flatMap(([, , , answers]) => answers ?? []));
  return [...new Set(references)].filter(id => !originals.has(id) || phrases.get(id) !== originals.get(id)?.proposition);
}

for (const strategy of strategies) {
  test(strategy + ' preserves two verified answers when a naming agreement closes their repair issue', async () => {
    const trial = session(makeProfile('holistic_v5'), strategy);
    const asked = await trial.say(confirm('この形のひもについて確かめたいです。'));
    const a = '細いひもが二本あります。';
    const b = '二本は輪のところでつながっています。';
    const answered = await trial.say({
      ...accept(a + b, '二本のひもと輪のつながりが分かりました。'),
      local: [
        { quote: a, act: 'assert', aspect: 'part', targets: [first], proposition: known },
        { quote: b, act: 'assert', aspect: 'part', targets: [first], proposition: '二本のひもが輪でつながる' },
      ],
    });
    const answers = [claimAt(answered, a), claimAt(answered, b)];
    const ids = answers.map(({ id }) => id);
    assert.notEqual(ids[0], ids[1]);
    const recorded = answered.state.repairHistory.find(row => row.turn === asked.trace.turnIndex);
    assert.ok(recorded && ids.every(id => recorded.partnerClaims.some(claim => claim.id === id)));

    const named = await trial.say({ ...proposal(0), action: 'agree', speech: adopt(name) });
    assert.deepEqual(named.state.ledger[first], { name, status: 'agreed' });
    const next = await trial.say(confirm('同じ形は、輪の模様でほかの形と見分けられますか？', 0, other));
    assert.equal(next.trace.executed?.feature, other);
    assert.ok(featureOffer(next).includes(other));
    const failures = [];
    for (const { phase, body } of next.sends) {
      const material = JSON.parse(body.state) as Material;
      const check = material.figures.f0.actions.find(([action, turn]) => action === 'confirm' && turn === asked.trace.turnIndex);
      assert.ok(check, phase + ' retains the recorded feature check');
      if (!ids.every(id => check[3]?.includes(id))) failures.push(phase + ' lost verified answer links');
      if (missingAnswers(material, priorClaimViews(next.state.graph)).length) failures.push(phase + ' sends dangling answer links');
    }
    if (featureOffer(next).includes(known)) failures.push('detail reoffers an answered feature');
    assert.deepEqual(failures, []);
    assert.deepEqual(next.state.ledger[first], named.state.ledger[first]);
  });
}

function compressionInput(count: number): JevDecisionInput {
  const { state } = syntheticCheckpoint();
  const publicTurns: JevDecisionInput['publicTurns'][number][] = [
    { turn: 1, speaker: 'human', text: '模様を比べて形を見分けたいです。' },
  ];
  const priorClaims: LocalClaimView[] = [];
  const repairHistory: JevDecisionInput['repairHistory'][number][] = [];
  const judgmentLedger: NonNullable<JevDecisionInput['judgmentLedger']>[number][] = [];
  const target = { kind: 'single', figureId: second } satisfies JevTarget;
  for (let i = 0; i < count; i++) {
    const turn = 2 * i + 2;
    const aspect = ['結び目', '留め具', '糸の束', '穴の縁'][i % 4];
    const feature = aspect + 'の模様を比べると違いがある';
    const quote = aspect + 'には二本の細い線があり、輪につながる前に太さの違いが見えます。';
    const reply = aspect + 'の先端には別の刻み目が三つあり、最後の一つだけ少し幅があります。';
    publicTurns.push(
      { turn, speaker: 'ai', text: 'この図形は' + aspect + 'の模様で見分けられますか？' },
      { turn: turn + 1, speaker: 'human', text: quote + reply },
    );
    const claims: LocalClaimView[] = [quote, reply].map((text, j) => ({
      id: (turn + 1) + ':local' + (j + 1), issueId: (turn + 1) + ':local' + (j + 1),
      turn: turn + 1, sourceTurn: turn + 1, speaker: 'human', source: 'partner_statement',
      targets: [second], aspect: 'part', act: 'assert', proposition: text, quote: text, name: null, respondsTo: null,
    }));
    priorClaims.push(...claims);
    const answers = claims.map(({ id, act, proposition, targets }) => ({ id, act, proposition, targets }));
    repairHistory.push({
      turn, action: 'confirm', question: feature, issueId: null, partnerClaims: answers,
      candidatesBefore: [second], candidatesAfter: [second], addedClaimIds: claims.map(({ id }) => id),
      removedClaimIds: [], progress: 'changed',
    });
    judgmentLedger.push({ turn, action: 'confirm', target, name: null, feature, answers });
  }
  const turn = count * 2 + 1;
  return {
    turn, publicTurns, ownSlots: slots, observations: state.observationMemo!, issueSummary: '{"issues":[]}',
    priorClaims, repairHistory, judgmentLedger, previousAction: judgmentLedger.at(-1)!, publicNames: [],
    nameLedger: state.ledger,
  };
}

test('A6 budget pressure never leaves answer claim IDs without their records in any decision stage', () => {
  const selected = { action: 'confirm', target: { kind: 'single', figureId: first } } as const;
  function material(input: JevDecisionInput) {
    const detail = buildJevDecisionDetailPayload(input, selected, { questionLayout: 'two_stage_v3' });
    assert.ok(detail);
    return [
      buildHumanReferentPayload(input),
      buildJevDecisionPayload(input, { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' }),
      buildJevTargetPayload(input, selected.action), detail,
    ].map(payload => JSON.parse(payload.state) as Material);
  }
  const control = compressionInput(2);
  for (const state of material(control)) {
    assert.equal(state.inputBudget.omitted.claims, 0);
    const early = state.figures.f1.actions[0];
    assert.deepEqual(early[3], ['3:local1', '3:local2']);
    assert.deepEqual(missingAnswers(state, control.priorClaims), []);
  }
  const pressure = compressionInput(48);
  const revised = material(pressure);
  assert.ok(revised.every(state => state.inputBudget.omitted.claims + state.inputBudget.omitted.repairHistory > 0));
  const latest = pressure.priorClaims.slice(-2).map(({ id }) => id);
  for (const state of revised) {
    assert.deepEqual(state.figures.f1.actions.at(-1)?.[3], latest, 'compaction retains the newest verified replies');
  }
  const unresolved = revised.map(state => missingAnswers(state, pressure.priorClaims).length);
  assert.deepEqual(unresolved, [0, 0, 0, 0], 'unresolved claim IDs in referent/action/target/detail');
});

for (const strategy of strategies) {
  test(strategy + ' can recheck a feature after the participant takes back the confirmed answer', async () => {
    const trial = session(makeProfile('holistic_v5'), strategy);
    await trial.say(confirm('この形のひもを比べてみたいです。'));
    const human = 'ひもは二本あります。';
    const answered = await trial.say({
      ...accept(human, '二本ある形のことですね。'),
      local: { aspect: 'part', act: 'assert', targets: [first], proposition: known },
    });
    const answer = claimAt(answered, human);
    await trial.say({ ...proposal(0), action: 'agree', speech: adopt(name) });
    const correction = '二本と答えましたが、見間違いかもしれません。';
    const reopened = await trial.say({
      ...confirm(correction),
      local: { aspect: 'part', act: 'withdraw', targets: [first], antecedent: answer.id, proposition: '本数についての回答を撤回する' },
    });
    assert.equal(claimAt(reopened, correction).respondsTo, answer.id);
    assert.ok(featureOffer(reopened).includes(known));
    assert.equal(reopened.trace.executed?.feature, known);
  });
}

const exec = promisify(execFile);
for (const [commit, policy] of [['9b5efd0', 'holistic_v4'], ['d4426a9', 'holistic_v5']] as const) {
  test(policy + ' reproduces unedited sends from the archived producer in both strategies', async t => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    try {
      await exec('git', ['cat-file', '-e', commit + '^{commit}'], { cwd });
    } catch {
      t.skip('the producer commit is unavailable in a shallow checkout');
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'audit13-replay-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const archive = join(directory, 'source.tar');
    const helper = 'tests/support/s4-v3-records.ts';
    await exec('git', ['archive', '--output=' + archive, commit, 'package.json', 'dialogue-model',
      helper, 'tests/support/s4-integration', 'workers'], { cwd });
    await exec('tar', ['-xf', archive, '-C', directory]);
    const producer = await import(pathToFileURL(join(directory, helper)).href) as { buildRecords: typeof buildRecords };
    for (const label of strategies) {
      const human = 'ひも付きの形をどのように見分けられますか？';
      const records = await producer.buildRecords({
        label, dialoguePolicy: policy, technicalTrial: { version: 'adaptive_repair_v3' },
        turns: [{ human, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: 'どの形か一緒に確かめましょう。' } }],
      });
      const snapshot = JSON.stringify(records);
      const trial = records.trials[0];
      assert.equal(trial.profile.dialoguePolicy, policy);
      assert.equal(trial.attempts[0].generationRetryVersion, undefined, 'the archived producer predates the explicit retry marker');
      const verdicts = interventionChecks(records);
      assert.deepEqual(['shape', 'binding', 'execution', 'replay'].map(stage =>
        verdicts.find(check => check.id === 'intervention.trial.0.attempt.0.' + stage)?.status),
      ['pass', 'pass', 'pass', 'pass']);
      const replay = await pairedInterventionReplay(trial.replay[0].tape, own, MODEL, trial.profile);
      assert.equal(replay.status, 'same_material_intervention_verified', replay.error ?? '');
      assert.equal(replay.recordedPayloadsReproduced, true);
      assert.equal(JSON.stringify(records), snapshot);
    }
  });
}
