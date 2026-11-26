// Independent acceptance of the Jev requests that actually reach the transport.
// The complete dialogue, observations and service responses are synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DialoguePolicy, JevAction } from '../dialogue-model/runtime/decision/contract.ts';
import { createJevDecisionClient } from '../dialogue-model/runtime/decision/jev-decision.ts';
import type { JevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { createProfileDialogue } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { ReplayTape } from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import type { LocalAct, LocalClaimView, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { priorClaimViews } from '../dialogue-model/runtime/local-grounding/derive.ts';
import { createJevLocalTestClassifier } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import type { JevTurnTrace } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { normal, OLD, OWN } from './support/s4-v3-records.ts';
import type { Label } from './support/s4-v3-records.ts';

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
};

const slots = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id) as string[];
const [first, second] = slots;
const agreedName = '糸巻き';
const alternative = '巻き貝';
const firstFeature = '細い枝が二本ある';
const secondFeature = '中央に四角い切れ目がある';
const renameFeature = '丸みのある縁が二つつながる';
const approvalFeature = '丸みの境に小さなくぼみがある';
const nameProposal = 'この丸みのある形は「' + agreedName + '」と呼びませんか？';
const renameProposal = '最初に命名した丸みのある形に戻って、「' + alternative + '」ではどうですか？';
const shortApproval = 'その呼び名でいい？';
const laterResponse = '丸みのある縁が二つつながった形でしょうか？';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function syntheticCheckpoint(): Checkpoint {
  const state = structuredClone(OLD.state) as ReplayTape['state'];
  state.observationMemo!.figures[0].analytic.shapes = [renameFeature, approvalFeature];
  state.observationMemo!.figures[1].analytic.shapes = [firstFeature, secondFeature];
  return { state, events: [] };
}

function session(profile: Profile, strategy: Label, start: Checkpoint) {
  let current: Turn;
  let segments: Segment[];
  let sends: Request[] = [];
  let mockError: unknown;
  let trace: JevTurnTrace | undefined;
  let responseNo = 0;
  let { state, events } = structuredClone(start);
  const memo = start.state.observationMemo;
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
        const phase = questions.human_referent ? 'referent' : questions.action ? 'action'
          : questions.target ? 'target' : questions.feature || questions.name ? 'detail' : null;
        if (phase) sends.push({ phase, body, raw });
        const answers = Object.fromEntries(Object.entries(questions).map(([key, { criteria }]) => {
          const labels = Object.keys(criteria);
          let choice: string | undefined;
          switch (key) {
            case 'human_referent':
            case 'target': choice = 'figure_' + current.target; break;
            case 'action': choice = current.action; break;
            case 'repair_issue':
            case 'basis': choice = 'none'; break;
            case 'prospect': choice = 'no_open_issue'; break;
            case 'feature': choice = labels.find(label => JSON.parse(criteria[label]).value === current.feature); break;
            case 'name': {
              const name = segments.find(segment => segment.name !== undefined)?.name;
              choice = labels.find(label => JSON.parse(criteria[label]).value === name);
              break;
            }
            case 'draft_naming': choice = current.action === 'agree' ? 'adopt_chosen' : 'none'; break;
            default: {
              const match = /^segment_(\d+)_(act|antecedent|answer)$/u.exec(key);
              const segment = match && segments[Number(match[1])];
              assert.ok(segment && match, 'each question must refer to an extracted clause');
              if (match[2] === 'act') { choice = segment.act; break; }
              if (match[2] === 'answer') { choice = 'unknown'; break; }
              const antecedent = segment.antecedent;
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
        let text: string;
        if (phase === 'local_extraction') {
          text = JSON.stringify(segments.map((segment, index): LocalSegmentProposal => ({
            segmentId: String(index + 1), quote: segment.quote ?? current.human, proposition: segment.proposition,
            targets: segment.targets, aspect: segment.aspect, name: segment.name ?? null,
            linkedIssueId: null, respondsToTurn: segment.respondsToTurn ?? null,
          })));
        } else if (phase === 'ai_extraction') text = '[]';
        else {
          assert.equal(phase, 'generation');
          text = current.speech;
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
  if (profile.dialoguePolicy === 'holistic_v5' && events.length === 0) {
    state = { ...runtime.initialPrivateState(), observationMemo: memo };
  }
  return {
    checkpoint: () => structuredClone({ state, events }),
    async say(turn: Turn) {
      current = turn;
      segments = Array.isArray(turn.local) ? turn.local : turn.local ? [turn.local] : [];
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
      assert.equal(executed?.action, turn.action);
      assert.deepEqual(executed?.target, { kind: 'single', figureId: slots[turn.target] });
      assert.equal(result.text, turn.speech);
      state = result.privateState as ReplayTape['state'];
      events = [...events, { id: 'synthetic-ai-' + (seq + 1), seq: seq + 1, speaker: 'ai', text: result.text }];
      return { sends, publicAtSend, state, trace: captured };
    },
  };
}

const accept = (human: string, speech: string, target: number): Turn => ({ human, speech, action: 'accept', target });
const localName = (name: string): Segment => ({
  act: 'name_propose', aspect: 'name', targets: [first], name, proposition: name + 'を呼称にする案',
});
const initialAgreement: Turn = {
  human: nameProposal, speech: 'では、この形を「' + agreedName + '」と呼びましょう。',
  action: 'agree', target: 0, local: localName(agreedName),
};
const defer: Turn = {
  human: '枝のある形は似たものが残っているので、あとで確かめたいです。',
  speech: '枝のある形はあとで確かめましょう。', action: 'defer', target: 1,
};
const revisit: Turn = {
  human: '先ほど保留にした枝のある形に戻りませんか？',
  speech: 'では、枝のある形に戻りましょう。', action: 'revisit', target: 1,
};
const firstQuestion: Turn = {
  human: '枝の本数で見分けられそうです。', speech: '細い枝が二本ある形ですか？',
  action: 'confirm', target: 1, feature: firstFeature,
};
const firstAnswer: Turn = {
  ...accept('はい、細い枝が二本に分かれています。', '枝の本数が分かりました。', 1),
  local: { act: 'assert', aspect: 'part', targets: [second], proposition: '二本の細い枝がある' },
};
const secondQuestion: Turn = {
  human: '枝のある形には、もう一つ目印があります。', speech: '中央に四角い切れ目がある形ですか？',
  action: 'confirm', target: 1, feature: secondFeature,
};
const secondAnswer: Turn = {
  ...accept('ええ、中央の切れ目は四角です。', '切れ目の形も分かりました。', 1),
  local: { act: 'assert', aspect: 'part', targets: [second], proposition: '中央の切れ目が四角形' },
};
const rename: Turn = {
  human: renameProposal, speech: laterResponse, action: 'confirm', target: 0,
  feature: renameFeature, local: localName(alternative),
};
const lateRevisit: Turn = {
  human: '話を戻して、最初に決めた「' + agreedName + '」の形をもう一度見ませんか？',
  speech: '最初に名前を決めた形に戻りましょう。', action: 'revisit', target: 0,
};

async function makeHistory(profile: Profile) {
  // The shared checkpoint holds an actual executed defer. Repairs and bypass use
  // the same saved history for the comparison; the repair strategy still vetoes new defers.
  const trial = session(profile, 'bypass-enabled', syntheticCheckpoint());
  const identification = '私が指しているのは、丸みのある縁が二つつながった方です。';
  const agreement: Turn = profile.dialoguePolicy === 'holistic_v5'
    ? { ...initialAgreement, human: identification + nameProposal, local: [
      { act: 'assert', aspect: 'referent', targets: [first], quote: identification, proposition: identification },
      { ...localName(agreedName), quote: nameProposal },
    ] }
    : initialAgreement;
  const earlier = [
    agreement, defer,
    accept('見分けやすい輪の方を見てみます。', '輪のある形ですね。', 2),
    revisit, firstQuestion, firstAnswer,
    accept('輪の方は輪郭がなめらかです。', 'なめらかな輪郭なんですね。', 2),
    secondQuestion, secondAnswer,
  ];
  for (const turn of earlier) await trial.say(turn);
  // Give the serializer newer claims from a different topic as well.
  for (const [human, speech, proposition] of [
    ['輪のある形には楕円の穴があります。', '穴は楕円なんですね。', '穴が楕円形'],
    ['その輪の縁には浅い切れ込みがあります。', '浅い切れ込みがあるのですね。', '輪の縁に浅い切れ込み'],
    ['輪から短い棒が一本伸びています。', '短い棒は一本ですね。', '輪に一本の短い棒が接している'],
  ] as const) {
    await trial.say({ ...accept(human, speech, 2), local: { act: 'assert', aspect: 'part', targets: [slots[2]], proposition } });
  }
  // Keep each utterance short and distinct so the fixture exercises the 32-event limit,
  // independently of the much larger character budget.
  const hints = ['輪郭の滑らかさ', '輪の厚み', '穴の丸さ', '穴の広さ', '縁の細さ', '縁の丸み',
    '輪の太さ', 'ふくらみ', '切れ込み', '短い辺', '曲がり方', 'つなぎ目', '端の形', '角の丸み', '外縁の曲線', '形全体'];
  for (const hint of hints) {
    await trial.say(accept('輪のある形については' + hint + 'も手掛かりですね。', hint + 'を手掛かりにしましょう。', 2));
  }
  return trial.checkpoint();
}

const checkpoints = new Map<DialoguePolicy, Promise<Checkpoint>>();
function history(policy: DialoguePolicy) {
  let value = checkpoints.get(policy);
  if (!value) {
    value = makeHistory(makeProfile(policy));
    checkpoints.set(policy, value);
  }
  return value;
}

type Outcome = Awaited<ReturnType<ReturnType<typeof session>['say']>>;
type LateRuns = { renameTurn: Outcome; revisitTurn: Outcome; approvalTurn: Outcome; checkpoint: Checkpoint };
const lateRuns = new Map<Label, Promise<LateRuns>>();
function inspectLate(strategy: Label) {
  let value = lateRuns.get(strategy);
  if (!value) {
    value = (async () => {
      const profile = makeProfile('holistic_v5');
      const checkpoint = await history('holistic_v5');
      const reopen = session(profile, strategy, checkpoint);
      const renameTurn = await reopen.say(rename);
      const proposal = findClaim(renameTurn, rename.human);
      const approvalTurn = await reopen.say({
        ...rename, human: shortApproval, feature: approvalFeature, speech: '丸みの境に小さなくぼみがある形ですか？',
        local: {
          act: 'name_propose', aspect: 'name', targets: [], proposition: '先の呼称案の採用を尋ねる',
          respondsToTurn: renameTurn.publicAtSend.at(-1)!.seq + 1, antecedent: proposal.id,
        },
      });
      const revisitTurn = await session(profile, strategy, checkpoint).say(lateRevisit);
      return { renameTurn, revisitTurn, approvalTurn, checkpoint };
    })();
    lateRuns.set(strategy, value);
  }
  return value;
}

function verifiedClaims(turn: Outcome) {
  return priorClaimViews(turn.state.graph, { limit: 160 });
}
function findClaim(turn: Outcome, quote: string) {
  const claim = verifiedClaims(turn).find(claim => claim.quote === quote && claim.speaker === 'human');
  assert.ok(claim, 'the synthetic utterance must have produced a verified claim');
  return claim;
}

type Row = { key: string | null; cells: unknown[] };
function* rows(value: unknown, key: string | null = null): Generator<Row> {
  if (!value || typeof value !== 'object') return;
  const children = Object.entries(value);
  yield { key, cells: children.map(([, child]) => child) };
  for (const [childKey, child] of children) {
    yield* rows(child, Array.isArray(value) ? null : childKey);
  }
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) yield* strings(child);
  }
}

function publicLines(state: unknown) {
  const lines: Array<Pick<Event, 'seq' | 'speaker' | 'text'>> = [];
  for (const value of strings(state)) {
    for (const line of value.split('\n')) {
      const match = /^\s*(?:U|#)?(\d+)\s+(h|human|user|人間|a|ai|assistant)\s*[:：]\s?(.*)$/iu.exec(line);
      if (!match) continue;
      const speaker = ['h', 'human', 'user', '人間'].includes(match[2].toLowerCase()) ? 'human' : 'ai';
      lines.push({ seq: Number(match[1]), speaker, text: match[3] });
    }
  }
  return lines;
}

function hasFigure(row: Row, index: number) {
  const names = [slots[index], 'f' + index, 'figure_' + index];
  const isFigure = (value: unknown) => typeof value === 'string' && names.includes(value);
  return [row.key, ...row.cells].some(cell => {
    if (isFigure(cell)) return true;
    if (Array.isArray(cell)) return cell.length === 1 && isFigure(cell[0]);
    return Boolean(cell && typeof cell === 'object' && Object.values(cell).some(isFigure));
  });
}

function refersToTurn(cells: unknown[], seq: number): boolean {
  return cells.some(cell => cell === seq || cell === String(seq) || cell === 'U' + seq || cell === '#' + seq);
}

function factForFigure(state: unknown, index: number, accepts: (row: Row) => boolean): boolean {
  for (const row of rows(state)) {
    if (!hasFigure(row, index)) continue;
    if (accepts(row)) return true;
    // A figure may head its own ledger entry and each action may be a nested row.
    for (const child of row.cells) {
      for (const nested of rows(child)) {
        if (accepts(nested)) return true;
      }
    }
  }
  return false;
}

function claimRow(state: unknown, claim: LocalClaimView): Row | undefined {
  return Array.from(rows(state)).find(row =>
    (row.key === claim.id || row.cells.includes(claim.id)) &&
    row.cells.includes(claim.act) && row.cells.includes(claim.aspect),
  );
}

function judgmentRequests(turn: Outcome) {
  assert.deepEqual(turn.sends.map(send => send.phase), ['referent', 'action', 'target', 'detail']);
  return turn.sends;
}

for (const strategy of strategies) {
  test(strategy + ' sends every public event once in order as a numbered speaker line', async () => {
    const { renameTurn, approvalTurn } = await inspectLate(strategy);
    for (const turn of [renameTurn, approvalTurn]) {
      assert.ok(turn.publicAtSend.length > 32);
      const expected = turn.publicAtSend.map(({ seq, speaker, text }) => ({ seq, speaker, text }));
      for (const { phase, body } of judgmentRequests(turn)) {
        const lines = publicLines(JSON.parse(body.state));
        assert.equal(lines.length, expected.length, phase + ' must include one numbered line per public event');
        assert.deepEqual(lines, expected, phase + ' must preserve the exact text, speaker and ordering');
      }
    }
  });

  test(strategy + ' carries early agreement, defer, revisit and the change of focus into the late sends', async () => {
    const { renameTurn, checkpoint } = await inspectLate(strategy);
    assert.deepEqual(checkpoint.state.ledger[first], { status: 'agreed', name: agreedName });
    const earlier = checkpoint.state.judgments;
    assert.equal(earlier[1].jevTurn.executed?.action, 'defer');
    assert.equal(earlier[3].jevTurn.executed?.action, 'revisit');
    const previousTurn = earlier.at(-1)!.turnIndex;
    for (const { phase, body } of judgmentRequests(renameTurn)) {
      const state: unknown = JSON.parse(body.state);
      assert.ok(factForFigure(state, 0, row => row.cells.includes('agreed') && row.cells.includes(agreedName)),
        phase + ' must expose the agreed figure–name pair as a typed fact');
      for (const [index, action, turnIndex] of [
        [0, 'agree', earlier[0].turnIndex], [1, 'defer', earlier[1].turnIndex], [1, 'revisit', earlier[3].turnIndex],
        [2, 'accept', previousTurn],
      ] as const) {
        assert.ok(factForFigure(state, index, row => row.cells.includes(action) &&
          (refersToTurn(row.cells, turnIndex) || refersToTurn(row.cells, turnIndex + 1))),
        phase + ' must retain ' + action + ' on its own figure at the source turn');
      }
      assert.ok(publicLines(state).some(line => line.seq === previousTurn + 2 && line.text === renameProposal),
        phase + ' must carry the current return to the earlier named figure');
    }
  });

  test(strategy + ' keeps verified naming claims with resolvable public source numbers', async () => {
    const { renameTurn, approvalTurn } = await inspectLate(strategy);
    for (const turn of [renameTurn, approvalTurn]) {
      const oldNameClaims = verifiedClaims(turn).filter(claim => claim.name === agreedName && claim.targets.includes(first));
      const newProposal = findClaim(turn, renameProposal);
      assert.ok(oldNameClaims.some(claim => claim.quote === nameProposal));
      assert.ok(verifiedClaims(turn).some(claim => claim.targets.includes(slots[2])), 'the fixture has claims on the intervening topic');
      for (const { phase, body } of judgmentRequests(turn)) {
        const state: unknown = JSON.parse(body.state);
        const lines = publicLines(state);
        assert.ok(oldNameClaims.some(claim => claimRow(state, claim)), phase + ' must retain evidence for the old agreement');
        assert.ok(claimRow(state, newProposal), phase + ' must retain the current proposal');
        // Every selected claim must point to its own source in this same send.
        for (const claim of verifiedClaims(turn)) {
          const row = claimRow(state, claim);
          if (!row) continue;
          assert.ok(refersToTurn(row.cells, claim.sourceTurn), phase + ' must carry the actual claim source number');
          assert.ok(lines.some(line => line.seq === claim.sourceTurn && line.speaker === claim.speaker &&
            line.text.includes(claim.quote)), phase + ' must include the referenced utterance with the correct speaker');
          if (claim.proposition !== claim.quote) {
            assert.ok(!row.cells.includes(claim.quote),
              phase + ' must refer to the public quote by number without copying it into the claim');
          }
        }
      }
    }
  });

  test(strategy + ' sends both earlier confirmed features with the corresponding partner answers', async () => {
    const { renameTurn, checkpoint } = await inspectLate(strategy);
    const facts = [
      { question: firstFeature, answer: findClaim(renameTurn, firstAnswer.human) },
      { question: secondFeature, answer: findClaim(renameTurn, secondAnswer.human) },
    ];
    for (const { question, answer } of facts) {
      assert.ok(renameTurn.publicAtSend.at(-1)!.seq - answer.sourceTurn >= 32, 'the answer must predate the old window');
      assert.ok(checkpoint.state.repairHistory.some(item =>
        item.question === question && item.partnerClaims.some(reply => reply.id === answer.id)));
    }
    for (const { phase, body } of judgmentRequests(renameTurn)) {
      const state: unknown = JSON.parse(body.state);
      for (const { question, answer } of facts) {
        assert.ok(factForFigure(state, 1, row => row.cells.includes(question) &&
          row.cells.some(cell => cell === answer.id || Array.isArray(cell) && cell.includes(answer.id))),
        phase + ' must link a past confirmation on the correct figure to its actual answer');
        assert.ok(claimRow(state, answer), phase + ' must include the referenced answer claim');
      }
    }
  });

  test(strategy + ' leaves the agreed figure selectable for a revisit or to clarify a proposed rename', async () => {
    const { renameTurn, revisitTurn, checkpoint } = await inspectLate(strategy);
    for (const turn of [renameTurn, revisitTurn]) {
      const referent = turn.sends.find(send => send.phase === 'referent');
      const target = turn.sends.find(send => send.phase === 'target');
      assert.ok(referent && target);
      assert.ok(Object.hasOwn(referent.body.questions.human_referent.criteria, 'figure_0'));
      assert.ok(Object.hasOwn(target.body.questions.target.criteria, 'figure_0'));
      assert.deepEqual(turn.trace?.executed?.target, { kind: 'single', figureId: first });
      assert.deepEqual(turn.state.ledger[first], checkpoint.state.ledger[first], 'a revisit or clarification cannot overwrite a name');
    }
  });

  test(strategy + ' sends the short approval linked to the human’s recent naming proposal', async () => {
    const { approvalTurn } = await inspectLate(strategy);
    const proposal = findClaim(approvalTurn, renameProposal);
    const approval = findClaim(approvalTurn, shortApproval);
    assert.equal(approval.respondsTo, proposal.id);
    assert.equal(approval.name, alternative);
    for (const { phase, body } of judgmentRequests(approvalTurn)) {
      const state: unknown = JSON.parse(body.state);
      const row = claimRow(state, approval);
      assert.ok(row, phase + ' must carry the approval question as a verified naming claim');
      assert.ok(row.cells.includes(proposal.id), phase + ' must point to the human’s proposal');
      const source = claimRow(state, proposal);
      assert.ok(source && source.cells.includes(alternative), phase + ' must resolve the proposal to the proposed name');
    }
  });
}

test('the two strategies receive identical decision requests from the same checkpoint', async () => {
  const [repair, bypass] = await Promise.all(strategies.map(inspectLate));
  for (const kind of ['renameTurn', 'revisitTurn', 'approvalTurn'] as const) {
    assert.deepEqual(repair[kind].sends.map(send => send.raw), bypass[kind].sends.map(send => send.raw));
  }
});

// Fingerprints of actual early and late HTTP bodies at 9c0d7ba. The fixture
// runs the normal transport in each version without Git history at test time.
const historical = {
  holistic_v1: '08f0e5de68df2e9e1051b2934ce26afa6e6727bbe1805a56dee4118b976d8f1c',
  holistic_v2: '8135f07ed5e374fd4eaa071f7c99975b5b8fcf5062ebfc3c3bc27c449c70eb0f',
  holistic_v3: 'f41207e6cad4a0a447e3dc30aae07642684ea13554d5df615143c4f66e2f8882',
  holistic_v4: 'e10b939074570b06cc8720e8628aeeecaf20566238c2b0e3bcf1312a9fd59a0a',
} as const;
for (const policy of Object.keys(historical) as Array<keyof typeof historical>) {
  test(policy + ' preserves the bytes of early and late decision requests', async () => {
    const checkpoint = await history(policy);
    const profile = makeProfile(policy);
    const requests = await Promise.all(strategies.map(async strategy => {
      const early = await session(profile, strategy, syntheticCheckpoint()).say(initialAgreement);
      const late = await session(profile, strategy, checkpoint).say(rename);
      return [early, late].map(turn => judgmentRequests(turn).map(({ phase, raw }) => [phase, sha256(raw)]));
    }));
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(sha256(JSON.stringify(requests)), historical[policy]);
  });
}
