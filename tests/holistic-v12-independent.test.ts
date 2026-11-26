// Independent acceptance for #203 and #202 item 7 (batch G).
// Only synthesized dialogue. The scripted providers answer the actual closed questions.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import type { InterventionReplaySide } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { priorClaimViews } from '../dialogue-model/runtime/local-grounding/derive.ts';
import type { LocalAspect, LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { buildRecords, MODEL, OLD, OWN } from './support/s4-v3-records.ts';
import type { Label, Turn } from './support/s4-v3-records.ts';

const [first, second, third] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id as string);
const otherCandidates = [first, second, third];
const notch = '縁に半円の切り込みが一つある';
const branch = '細い枝が太い胴につながっている';
const name = '木の実台';
const description = '太い胴に細い枝がついた形が見えます。';
const question = 'そちらの形にも、縁に半円の切り込みが一つありますか？';
const answer = 'ええ、こちらで見ても、縁に半円の切り込みが一つあります。';
const acceptance = 'ええ、「木の実台」と呼びましょう。';
const memo = structuredClone(OLD.state.observationMemo);
memo.figures[0].analytic.shapes = [notch, branch];

function segment(segmentId: string, quote: string, aspect: LocalAspect, targets: string[], respondsToTurn: number | null = null, candidate: string | null = null): LocalSegmentProposal {
  return { segmentId, quote, proposition: quote, aspect, targets, name: candidate, linkedIssueId: null, respondsToTurn };
}

const genericCheck: Turn = {
  human: '枝のついた形を見比べたいです。',
  plan: {
    action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: description + question, aiActs: ['assert', 'ask'],
    aiExtraction: JSON.stringify([
      segment('outline', description, 'part', [first]),
      segment('question', question, 'question', []),
    ]),
  },
};

function answerTurn(human: string, act: string, aspect: LocalAspect, targets: string[], referent = 'figure_0'): Turn {
  return {
    human,
    plan: {
      action: 'accept', target: referent === 'figure_1' ? 'figure_1' : 'figure_0',
      referent, speech: '切り込みについて話していますね。', act, antecedent: 'claim_1',
      extraction: JSON.stringify([segment('reply', human, aspect, targets, 2)]),
    },
  };
}

// A substantive answer to the question, without a bare pointing expression.
const affirmed = answerTurn(answer, 'agree', 'contour', [first]);
// v12: the classifier also labels the part as the answer to the point the AI checked.
const v12 = 'jev_generation_retry_v12' as const;
const labelled = (turn: Turn, answers: 'answers_checked_point' | 'not_an_answer' | 'unknown'): Turn => ({ ...turn, plan: { ...turn.plan, answers } });
const affirmedV12 = labelled(affirmed, 'answers_checked_point');


function options(label: Label, turns: Turn[], generationRetryVersion: 'jev_generation_retry_v11' | 'jev_generation_retry_v12' = 'jev_generation_retry_v11') {
  return { label, dialoguePolicy: 'holistic_v5', generationRetryVersion,
    technicalTrial: { version: 'adaptive_repair_v3' }, turns, memo } as const;
}
// ---- jev_generation_retry_v12 (D1 / #203 G.1): the classifier's closed "answers the checked point" label ----
function naming(action: 'agree' | 'confirm'): Turn {
  const human = 'この形を「木の実台」と呼びませんか？';
  return {
    human,
    plan: {
      action, target: 'figure_0', referent: 'figure_0', act: 'name_propose',
      extraction: JSON.stringify([segment('proposal', human, 'name', [], null, name)]),
      ...(action === 'agree' ? { name, speech: acceptance } : { speech: 'どの形か、もう少し教えてください。' }),
    },
  };
}

function verifiedTrial(records: Awaited<ReturnType<typeof buildRecords>>) {
  const checks = verifyRecords(records).checks.filter(check => /^intervention\.trial\.0\.attempt\.0\./u.test(check.id));
  assert.deepEqual(checks.map(check => check.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(checks));
  const trial = records.trials[0];
  assert.equal(trial.replay[0].result.status, 'same_material_intervention_verified');
  assert.equal(trial.replay[0].result.recordedPayloadsReproduced, true);
  return trial;
}

type MenuPayload = { questions?: Record<string, { criteria?: Record<string, string> } | undefined> };

function menu(side: InterventionReplaySide, key: 'action' | 'feature'): Record<string, string> {
  const payloads = side.requests.map(request => request.payload as MenuPayload | undefined);
  const offered = payloads.find(payload => payload?.questions?.[key])?.questions?.[key]?.criteria;
  assert.ok(offered, 'the real Jev request must contain the ' + key + ' menu');
  return offered;
}

type Trial = ReturnType<typeof verifiedTrial>;
const lastTrace = (trial: Trial) => trial.attempts.at(-1);
const candidates = (trial: Trial) => trial.lastCommittedState.judgments.at(-1).jevTurn.agreeNames;
const before = (trial: Trial) => trial.replay[0].tape.state;

function checkAnswer(trial: Trial) {
  const trace = lastTrace(trial);
  const claims = priorClaimViews(trial.lastCommittedState.graph);
  const asked = claims.find(claim => claim.speaker === 'ai' && claim.sourceTurn === 2 && claim.quote === question);
  assert.equal(asked?.act, 'ask', 'the previous public question must be represented in the graph');
  const answered = claims.find(claim => claim.speaker === 'human' && claim.sourceTurn === 3 && claim.quote === answer);
  assert.ok(answered, JSON.stringify(trace.local?.verification.rejected));
  assert.equal(answered.act, 'agree');
  assert.equal(answered.respondsTo, asked.id);
  assert.deepEqual(answered.targets, [first]);
  assert.equal(answered.name, null);
  assert.ok(trace.repairHistory.find((entry: { turn: number }) => entry.turn === 1)
    ?.partnerClaims.some((claim: { id: string }) => claim.id === answered.id));
  assert.deepEqual(trial.lastCommittedState.ledger, before(trial).ledger, 'a feature answer does not itself agree a name');
}

function agreed(trial: Trial, sourceTurn: number) {
  assert.deepEqual(candidates(trial), [{ name, figureId: first, sourceTurn }]);
  assert.equal(lastTrace(trial).executed.action, 'agree');
  assert.deepEqual(lastTrace(trial).executed.target, { kind: 'single', figureId: first });
  assert.equal(trial.turns[0].publicText, acceptance);
  assert.deepEqual(trial.lastCommittedState.ledger, { ...before(trial).ledger, [first]: { status: 'agreed', name } });
}

function stillClarifying(trial: Trial) {
  assert.equal(lastTrace(trial).namingRequest, true);
  for (const side of trial.replay[0].result.sides) {
    assert.ok(Object.hasOwn(menu(side, 'action'), 'confirm'));
    assert.ok(!Object.hasOwn(menu(side, 'action'), 'agree'));
    assert.ok(!Object.hasOwn(menu(side, 'action'), 'accept'));
  }
  assert.deepEqual(candidates(trial), []);
  assert.equal(lastTrace(trial).executed.action, 'confirm');
  assert.equal(trial.turns[0].publicText, naming('confirm').plan.speech);
  assert.deepEqual(trial.lastCommittedState.ledger, before(trial).ledger);
}


const understanding = answerTurn('ええ、分かりました。', 'agree', 'question', []);
const backchannel = answerTurn('ええ。', 'acknowledge', 'question', [], 'none');
const followUp = answerTurn('半円の切り込みは、いくつありますか？', 'ask', 'question', [first]);
const wrongFigure = answerTurn('ええ、隣の形には半円の切り込みがあります。', 'agree', 'contour', [second], 'figure_1');
const denial = answerTurn('いいえ、切り込みがあるのは別の形です。', 'deny', 'referent', [first]);
const withQuestion = answerTurn('ええ、切り込みが一つありますか？', 'agree', 'contour', [first]);

function counted(trial: Trial): boolean {
  return priorClaimViews(trial.lastCommittedState.graph).some(claim => claim.speaker === 'human' && claim.sourceTurn === 3 && claim.act === 'agree' && claim.respondsTo !== null);
}

// ---- independent acceptance attacks on jev_generation_retry_v12 (HardyWatt) ----
const understandingPart = answerTurn('質問の意味は分かりました。', 'agree', 'part', []);   // the audit 19 shape: agree/part, no target
const untargetedProposal: Turn = { human: '「月枠」とかどう？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'name_propose', name: '月枠',
  extraction: JSON.stringify([segment('proposal', '「月枠」とかどう？', 'name', [], null, '月枠')]), speech: 'どの形か、もう少し教えてください。' } };
const untargetedAgree: Turn = { ...untargetedProposal, plan: { ...untargetedProposal.plan, action: 'agree', speech: 'はい、「月枠」と呼びましょう。' } };
const statusesOf = (records: any) => verifyRecords(records).checks.filter((c: any) => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map((c: any) => c.status);
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(label + ' [attack] v12: an understanding statement (agree/part, no target) labelled not_an_answer or unknown is not counted and never grounds an untargeted name', async () => {
    for (const answers of ['not_an_answer', 'unknown'] as const) {
      const trial = verifiedTrial(await buildRecords(options(label, [genericCheck, labelled(understandingPart, answers), untargetedProposal], v12)));
      assert.equal(counted(trial), false, answers);
      stillClarifying(trial);
    }
  });
  test(label + ' [attack] v12 RESIDUAL: the same understanding statement wrongly labelled answers_checked_point (a classifier error) is counted', async () => {
    const trial = verifiedTrial(await buildRecords(options(label, [genericCheck, labelled(understandingPart, 'answers_checked_point'), untargetedProposal], v12)));
    // Documented residual (audit 19 shape): the label is the classifier's alone. The agree act, a name-free quote, the question's only figure and no opposing words are still required,
    // but a classifier that errs on 'agree/part, no target' makes the claim count. The real-model probe saw 0/24 understanding statements labelled so.
    assert.equal(counted(trial), true);
    assert.deepEqual(candidates(trial), [{ name: '月枠', figureId: first, sourceTurn: 5 }]);
  });
  test(label + ' [attack] v12 G.1 goal: a labelled feature answer lets an untargeted name proposal be agreed in a later turn', async () => {
    const trial = verifiedTrial(await buildRecords(options(label, [genericCheck, affirmedV12, untargetedAgree], v12)));
    assert.equal(lastTrace(trial).executed.action, 'agree');
    assert.deepEqual(candidates(trial), [{ name: '月枠', figureId: first, sourceTurn: 5 }]);
  });
  test(label + ' [attack] v12: flipping the stored label or the provenance of a counted answer is detected by S4', async () => {
    const records = await buildRecords(options(label, [genericCheck, affirmedV12], v12));
    assert.deepEqual(statusesOf(records), ['pass', 'pass', 'pass', 'pass']);
    const text = JSON.stringify(records);
    assert.ok((text.match(/"answersChecked":"yes"/g) ?? []).length > 0 && text.includes('partner_labelled_answer'));
    const flipLabel = JSON.parse(text.replaceAll('"answersChecked":"yes"', '"answersChecked":"no"'));
    const flipSource = JSON.parse(text.replaceAll('partner_labelled_answer', 'partner_statement'));
    assert.ok(statusesOf(flipLabel).some((s: string) => s !== 'pass'), 'a flipped stored label must be detected');
    assert.ok(statusesOf(flipSource).some((s: string) => s !== 'pass'), 'a flipped provenance must be detected');
  });
}

// #14 T11: a lexical resemblance about an extracted singleton is not an
// answer to the previous check unless it links to its verified public claim.
const frame = '月枠';
const proposalText = '輪の形を「月枠」と呼びませんか？';
const checkedReading = 'こちらの形は曲がった輪にも見えます。';
const construalCheck: Turn = {
  human: proposalText,
  plan: {
    ...genericCheck.plan,
    speech: checkedReading + 'そちらにも輪のつながりがありますか？',
    act: 'name_propose',
    extraction: JSON.stringify([segment('proposal', proposalText, 'name', [first], null, frame)]),
    aiActs: ['construe'],
    aiExtraction: JSON.stringify([segment('outline', checkedReading, 'construal', [first])]),
  },
};
function construalReply(action: 'agree' | 'confirm', direct: boolean): Turn {
  const human = 'こちらでは月のように見えます。';
  const turn = answerTurn(human, 'construe', 'construal', [first]);
  return {
    human,
    plan: {
      ...turn.plan,
      action,
      ...(direct ? {} : { antecedent: 'none', extraction: JSON.stringify([segment('reply', human, 'construal', [first])]) }),
      ...(action === 'agree' ? { name: frame, speech: 'はい、「月枠」と呼びましょう。' } : { speech: '輪のつながりをもう少し確認しましょう。' }),
    },
  };
}

for (const label of ['repair-first', 'bypass-enabled'] as const) {
  test(`#14 ${label}: scoped_v7 requires a direct construal answer and scoped_v6 keeps the original replay`, async () => {
    for (const [scope, direct, action] of [
      ['scoped_v6', false, 'agree'],
      ['scoped_v7', false, 'confirm'],
      ['scoped_v7', true, 'agree'],
    ] as const) {
      const records = await buildRecords({
        ...options(label, [construalCheck, construalReply(action, direct)], v12),
        agreeNameScopeVersion: scope,
      });
      const trial = verifiedTrial(records);
      assert.equal(before(trial).agreeNameScopeVersion, scope);
      assert.equal(trial.lastCommittedState.agreeNameScopeVersion, scope);
      const reply = priorClaimViews(trial.lastCommittedState.graph).find(c => c.sourceTurn === 3 && c.act === 'construe');
      assert.ok(reply, 'the construal must reach the graph under both scopes');
      assert.deepEqual(reply.targets, [first]);
      assert.equal(reply.respondsTo, direct ? '3:pub1' : null);
      assert.equal(lastTrace(trial).executed.action, action);
      for (const side of trial.replay[0].result.sides) assert.equal(Object.hasOwn(menu(side, 'action'), 'agree'), action === 'agree');
      if (action === 'agree') {
        assert.deepEqual(candidates(trial), [{ name: frame, figureId: first, sourceTurn: 1 }]);
        assert.deepEqual(trial.lastCommittedState.ledger[first], { status: 'agreed', name: frame });
      } else {
        assert.deepEqual(candidates(trial), []);
        assert.deepEqual(trial.lastCommittedState.ledger, before(trial).ledger);
      }
    }
  });
}
