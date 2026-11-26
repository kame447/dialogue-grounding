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

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(label + ': v12 a labelled feature answer is counted with its own provenance and keeps the ledger unchanged', async () => {
    const trial = verifiedTrial(await buildRecords(options(label, [genericCheck, affirmedV12], v12)));
    const claim = priorClaimViews(trial.lastCommittedState.graph).find(c => c.speaker === 'human' && c.sourceTurn === 3);
    assert.equal(claim?.act, 'agree');
    assert.equal(claim?.source, 'partner_labelled_answer');
    assert.deepEqual(trial.lastCommittedState.ledger, before(trial).ledger);
  });

  for (const [scenario, reply, answers] of [
    ['an understanding statement labelled not_an_answer', understanding, 'not_an_answer'],
    ['an understanding statement without a label (unknown)', understanding, 'unknown'],
    ['the feature answer labelled not_an_answer', affirmed, 'not_an_answer'],
    ['the feature answer labelled unknown', affirmed, 'unknown'],
    ['a backchannel (act is not agree) even when labelled', backchannel, 'answers_checked_point'],
    ['a follow-up question (act is not agree) even when labelled', followUp, 'answers_checked_point'],
    ['a denial (act is not agree) even when labelled', denial, 'answers_checked_point'],
    ['a reply on the other figure even when labelled', wrongFigure, 'answers_checked_point'],
    ['an agree that is itself a question even when labelled', withQuestion, 'answers_checked_point'],
  ] as const) {
    test(label + ': v12 ' + scenario + ' is not an answer and cannot ground a name', async () => {
      const trial = verifiedTrial(await buildRecords(options(label, [genericCheck, labelled(reply, answers), naming('confirm')], v12)));
      assert.equal(counted(trial), false);
      stillClarifying(trial);
    });
  }

  test(label + ': v11 neither asks for nor reads the label: the same labelled reply is not counted', async () => {
    const trial = verifiedTrial(await buildRecords(options(label, [genericCheck, affirmedV12, naming('confirm')])));
    assert.equal(counted(trial), false);
    for (const side of trial.replay[0].result.sides) assert.ok(side.requests.every(request => !Object.keys((request.payload as MenuPayload | undefined)?.questions ?? {}).some(key => /_answer$/u.test(key))));
    stillClarifying(trial);
  });

  test(label + ': v12 asks the label question only on local classification', async () => {
    const trial = verifiedTrial(await buildRecords(options(label, [genericCheck, affirmedV12], v12)));
    const keys = trial.replay[0].result.sides[0].requests.flatMap(request => Object.keys((request.payload as MenuPayload | undefined)?.questions ?? {})).filter(key => /_answer$/u.test(key));
    assert.ok(keys.length >= 1);
  });
}

test('a record that carries the labelled provenance cannot be relabelled as jev_generation_retry_v11', async () => {
  const records = await buildRecords(options('repair-first', [genericCheck, affirmedV12], v12));
  assert.deepEqual(verifyRecords(records).checks.filter(check => /^intervention\.trial\.0\.attempt\.0\./u.test(check.id)).map(check => check.status), ['pass', 'pass', 'pass', 'pass']);
  const text = JSON.stringify(records);
  assert.ok(text.includes('partner_labelled_answer'));
  const forged = JSON.parse(text.replaceAll('jev_generation_retry_v12', 'jev_generation_retry_v11'));
  const statuses = verifyRecords(forged).checks.filter(check => /^intervention\.trial\.0\.attempt\.0\./u.test(check.id)).map(check => check.status);
  assert.ok(statuses.some(status => status !== 'pass'), JSON.stringify(statuses));
});
