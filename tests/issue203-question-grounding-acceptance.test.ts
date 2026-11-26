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

const publicFocus: Turn = {
  human: '切り込みのある形を見比べたいです。',
  plan: {
    action: 'accept', target: 'figure_0', referent: 'figure_0', speech: description, aiActs: ['assert'],
    aiExtraction: JSON.stringify([segment('description', description, 'part', [first])]),
  },
};

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

const anotherClue: Turn = {
  human: '見分けるために、もう一つ手がかりを教えてください。',
  plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '形の特徴をもう少し確かめてもいいですか？' },
};

function options(label: Label, turns: Turn[], generationRetryVersion: 'jev_generation_retry_v11' | 'jev_generation_retry_v12' = 'jev_generation_retry_v11') {
  return { label, dialoguePolicy: 'holistic_v5', generationRetryVersion,
    technicalTrial: { version: 'adaptive_repair_v3' }, turns, memo } as const;
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

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(label + ': #203 retains the typed feature answer to a generic AI question and permits adoption', async () => {
    checkAnswer(verifiedTrial(await buildRecords(options(label, [genericCheck, affirmedV12], v12))));

    // Probe the native menu before scripting an agree. On the old path this
    // identifies the unavailable agreement without injecting an illegal choice.
    const probe = verifiedTrial(await buildRecords(options(label, [genericCheck, affirmedV12, naming('confirm')], v12)));
    for (const side of probe.replay[0].result.sides) assert.ok(Object.hasOwn(menu(side, 'action'), 'agree'));
    assert.deepEqual(candidates(probe), [{ name, figureId: first, sourceTurn: 5 }]);

    agreed(verifiedTrial(await buildRecords(options(label, [genericCheck, affirmedV12, naming('agree')], v12))), 5);
  });

  const backchannel = answerTurn('ええ。', 'acknowledge', 'question', [], 'none');
  const followUp = answerTurn('半円の切り込みは、いくつありますか？', 'ask', 'question', [first]);
  const wrongFigure = answerTurn('ええ、隣の形には半円の切り込みがあります。', 'agree', 'contour', [second], 'figure_1');
  const denial = answerTurn('いいえ、切り込みがあるのは別の形です。', 'deny', 'referent', [first]);

  for (const [scenario, reply] of [
    ['a bare backchannel', backchannel],
    ['a follow-up question', followUp],
    ['a feature on the other figure', wrongFigure],
    ['a denial of the checked figure', denial],
  ] as const) {
    test(label + ': #203 ' + scenario + ' cannot ground a name', async () => {
      stillClarifying(verifiedTrial(await buildRecords(options(label, [genericCheck, reply, naming('confirm')]))));
    });
  }

  for (const [scenario, reply, remainsOffered] of [
    ['an explicit feature answer', affirmedV12, false],
    ['only a backchannel', backchannel, true],
    ['only a follow-up question', followUp, true],
  ] as const) {
    test(label + ': #203 feature menu after accepting ' + scenario, async () => {
      // The interim accept exercises the historical feature menu, independently of adjacent confirms.
      const turns = [genericCheck, reply, anotherClue];
      for (const scope of ['scoped_v7', 'scoped_v8'] as const) {
        const trial = verifiedTrial(await buildRecords({ ...options(label, turns, v12), agreeNameScopeVersion: scope }));
        const state = before(trial);
        assert.equal(state.agreeNameScopeVersion, scope);
        assert.equal(state.judgments[0].jevTurn.executed.feature, notch);
        const replyAct = reply === backchannel ? 'acknowledge' : reply === followUp ? 'ask' : 'agree';
        assert.ok(state.repairHistory.find((entry: { turn: number }) => entry.turn === 1)
          ?.partnerClaims.some((claim: { act: string }) => claim.act === replyAct), 'the earlier check retains the typed reply');
        if (reply === followUp) {
          assert.ok(priorClaimViews(state.graph).some(claim =>
            claim.speaker === 'human' && claim.sourceTurn === 3 && claim.act === 'ask' && claim.quote === reply.human));
        }
        const hasNotch = scope === 'scoped_v8' && remainsOffered;
        for (const side of trial.replay[0].result.sides) {
          const features = Object.values(menu(side, 'feature')).map(value => (JSON.parse(value) as { value: string }).value);
          assert.ok(features.includes(branch), 'a different valid distinguishing feature remains available');
          assert.equal(features.includes(notch), hasNotch);
        }
        if (!hasNotch) assert.notEqual(lastTrace(trial).executed.feature, notch);
      }
    });
  }

  test(label + ': #203 a declarative comparison does not leave an unanswered question', { todo: 'G.2: a statement-only confirm is not public focus in scoped_v6 (audit 28n, B-28N-1); needs the researcher decision with G.1' }, async () => {
    const declaration = 'その形は、丸い切り込みが一つありますね。';
    const compare: Turn = {
      human: '丸い切り込みも見えています。',
      plan: {
        action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: declaration, aiActs: ['assert'],
        aiExtraction: JSON.stringify([segment('description', declaration, 'contour', [first])]),
      },
    };
    const turns = [publicFocus, compare, naming('confirm')];
    const probe = verifiedTrial(await buildRecords(options(label, turns)));
    const published = priorClaimViews(probe.lastCommittedState.graph).filter(claim => claim.speaker === 'ai' && claim.sourceTurn === 4);
    assert.deepEqual(published.map(claim => [claim.quote, claim.act]), [[declaration, 'assert']]);
    assert.deepEqual(candidates(probe), [{ name, figureId: first, sourceTurn: 5 }]);
    agreed(verifiedTrial(await buildRecords(options(label, [publicFocus, compare, naming('agree')]))), 5);
  });

  const threeWayQuestion = '三つのうち、半円の切り込みが一つだけあるのはどれですか？';
  const threeWay: Turn = {
    human: '縁の切り込みでも見比べられますか？',
    plan: {
      action: 'confirm', target: 'figures_0_1_2', referent: 'multiple',
      speech: '切り込みがある形が三つ見えます。' + threeWayQuestion, aiActs: ['assert', 'ask'],
      aiExtraction: JSON.stringify([
        segment('candidates', '切り込みがある形が三つ見えます。', 'contour', otherCandidates),
        segment('question', threeWayQuestion, 'question', []),
      ]),
    },
  };
  const wrongExtraction: Turn = {
    human: '枝のない形は、縁の溝で見分けられますか？',
    plan: {
      action: 'confirm', target: 'figure_1', referent: 'figure_1', speech: '縁に浅い溝がある形ですか？', aiActs: ['ask'],
      // The extractor attached the new public question to the older figure.
      aiExtraction: JSON.stringify([segment('question', '縁に浅い溝がある形ですか？', 'question', [first])]),
    },
  };
  const missingExtraction: Turn = {
    human: '太い胴の形を、縁でも見分けたいです。',
    plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0',
      speech: '縁の切り込みは半円になっていますか？', aiExtraction: '[]' },
  };

  for (const [scenario, laterCheck, executed] of [
    ['three candidates without an answer', threeWay, { kind: 'multiple', figureIds: otherCandidates }],
    ['a later question extracted against the wrong figure', wrongExtraction, { kind: 'single', figureId: second }],
    ['a later question missing from extraction', missingExtraction, { kind: 'single', figureId: first }],
  ] as const) {
    test(label + ': #202-7 ' + scenario + ' cannot reuse the previous public focus', scenario === 'three candidates without an answer' ? {} : { todo: 'D2 (#202 item 7): contradicts the accepted "agree stays available after two name-less approval requests"; the researcher decides' }, async () => {
      const trial = verifiedTrial(await buildRecords(options(label, [publicFocus, laterCheck, naming('confirm')])));
      assert.deepEqual(before(trial).judgments.at(-1).jevTurn.executed.target, executed);
      stillClarifying(trial);
    });
  }

  test(label + ': #202-7 explicit human narrowing after three candidates permits naming', async () => {
    const human = '三つの中で、枝と胴がつながっている形を指しています。';
    const distinguish: Turn = {
      human,
      plan: {
        action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '枝と胴のつながりが目印ですね。',
        act: 'assert', extraction: JSON.stringify([segment('selection', human, 'referent', [first])]),
      },
    };
    const probe = verifiedTrial(await buildRecords(options(label, [publicFocus, threeWay, distinguish, naming('confirm')])));
    assert.deepEqual(candidates(probe), [{ name, figureId: first, sourceTurn: 7 }]);
    agreed(verifiedTrial(await buildRecords(options(label, [publicFocus, threeWay, distinguish, naming('agree')]))), 7);
  });
}

const git = promisify(execFile);
const baseline = '65cf7f3';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const older = ['jev_generation_retry_v9', 'jev_generation_retry_v10'] as const;
const labels: Label[] = ['bypass-enabled', 'repair-first'];

test('v9 and v10 retain the old typed-answer result in both strategies', async () => {
  for (const label of labels) {
    for (const generationRetryVersion of older) {
      const trial = verifiedTrial(await buildRecords({ ...options(label, [genericCheck, affirmed]), generationRetryVersion }));
      const trace = lastTrace(trial);
      assert.equal(trace.generationRetryVersion, generationRetryVersion);
      assert.deepEqual(trace.local.verification.rejected.map(({ reason }: { reason: string }) => reason), ['inconsistent_claim_response']);
      assert.ok(!trace.local.claims.some((claim: { quote: string }) => claim.quote === answer));
      assert.deepEqual(trial.lastCommittedState.ledger, before(trial).ledger);
    }
  }
});

test('recorded v9 and v10 requests from the baseline replay unchanged in both strategies', async t => {
  try {
    await git('git', ['cat-file', '-e', baseline + '^{commit}'], { cwd });
  } catch (error) {
    if ((error as { code?: number | string }).code === 128) {
      t.skip('the shallow checkout has no baseline object; the pinned-version test still runs');
      return;
    }
    throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), 'issue203-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'baseline.tar');
  await git('git', ['archive', '--output=' + archive, baseline, 'package.json', 'dialogue-model/runtime',
    'workers/research-ai-proxy/src', 'tests/support/s4-v3-records.ts', 'tests/support/s4-integration/harness.ts', 'tests/support/s4-integration/NORMAL-RECORDS.json'], { cwd });
  await git('tar', ['-xf', archive, '-C', directory]);
  const { buildRecords: buildBaseline }: { buildRecords: typeof buildRecords } =
    await import(pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href);
  for (const label of labels) {
    for (const generationRetryVersion of older) {
      const record = await buildBaseline({ ...options(label, [genericCheck, affirmed]), generationRetryVersion });
      const trial = verifiedTrial(record);
      const { tape } = trial.replay[0];
      const saved = JSON.stringify(tape);
      assert.equal(tape.generationRetryVersion, generationRetryVersion);
      const replay = await pairedInterventionReplay(tape, OWN as Parameters<typeof pairedInterventionReplay>[1], MODEL, trial.profile);
      const reason = label + ' ' + generationRetryVersion;
      assert.equal(replay.status, 'same_material_intervention_verified', reason);
      assert.equal(replay.recordedPayloadsReproduced, true, reason);
      assert.equal(JSON.stringify(tape), saved, reason);
    }
  }
});
