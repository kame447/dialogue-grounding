// Synthetic only. 05d-7: holistic_v1 is recorded at creation for a technical-trial v3 only; a plain v3 keeps its original profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateParticipantJevConfig } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { researchHash } from '../dialogue-model/runtime/v2/research-profile.ts';

const base = { schemaVersion: 'participant_jev_config_v1', lunaRequest: { timeoutMs: null, maxCompletionTokens: 1000 },
  timeouts: { observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000 },
  cacheDirectory: '/synthetic/cache', modelId: 'synthetic-luna-20261020', memoSha256: 'a'.repeat(64), seed: 1,
  limits: { lunaCalls: 100, lunaTokens: 100000, lunaPosts: 100, jevPosts: 100, jevUsd: 0.05 }, questionLayout: 'two_stage_v3' };

test('a technical-trial v3 records holistic_v3; a plain v3 and v1/v2 layouts do not', () => {
  const trial = validateParticipantJevConfig({ ...base, technicalTrial: { version: 'adaptive_repair_v3' } }).profile as any;
  const plain = validateParticipantJevConfig(base).profile as any;
  assert.equal(trial.dialoguePolicy, 'holistic_v3');
  assert.equal(Object.hasOwn(plain, 'dialoguePolicy'), false);
  assert.notEqual(researchHash(trial), researchHash(plain));
  for (const layout of ['two_stage_v1', 'two_stage_v2']) assert.equal(Object.hasOwn(validateParticipantJevConfig({ ...base, questionLayout: layout }).profile, 'dialoguePolicy'), false);
});

import { jevChoiceAnswersValid, jevReportedCost, jevResponseId } from '../dialogue-model/runtime/decision/jev-choice-response.ts';
test('the shared response contract: confidence and probabilities in 0..1, exact keys, reported cost, gen- ids', () => {
  const labels = { q: ['a', 'b'] };
  const ok = (extra: object = {}, probs = { a: 1, b: 0 }) => ({ q: { type: 'choice', choice: 'a', probabilities: probs, ...extra } });
  assert.equal(jevChoiceAnswersValid(ok(), labels), true);
  assert.equal(jevChoiceAnswersValid(ok({ confidence: 0.5 }), labels), true);
  assert.equal(jevChoiceAnswersValid(ok({ confidence: null }), labels), true);
  assert.equal(jevChoiceAnswersValid(ok({ confidence: 2 }), labels), false);
  assert.equal(jevChoiceAnswersValid(ok({ extra: 1 }), labels), false);
  assert.equal(jevChoiceAnswersValid(ok({}, { a: 1, b: 1.5 }), labels), false);
  assert.equal(jevChoiceAnswersValid({ ...ok(), z: ok().q }, labels), false);
  assert.equal(jevChoiceAnswersValid({ q: { ...ok().q, choice: 'c' } }, labels), false);
  assert.equal(jevReportedCost({ usage: { cost: 0 } }), 0);
  assert.equal(jevReportedCost({ usage: { cost: -1 } }), null);
  assert.equal(jevReportedCost({}), null);
  assert.equal(jevResponseId({ id: 'gen-abc_1' }), 'gen-abc_1');
  assert.equal(jevResponseId({ id: 'other' }), null);
});

import { buildJevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
test('holistic_v1 (names): the memo readings are not propose_name candidates; public names are; an earlier input is unchanged', () => {
  const slots = Array.from({ length: 6 }, (_, i) => `s-000${i}`);
  const input = (extra: object = {}, publicNames: object[] = []) => ({ turn: 2, ownSlots: slots,
    publicTurns: [{ turn: 1, speaker: 'ai', text: 'どの図形から話しましょうか？' }, { turn: 2, speaker: 'human', text: '船という見方もありますね。' }],
    observations: { observedAt: '2026-10-20T00:00:00.000Z', figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
      holistic: [{ construal: `折れ曲がった帯という見立て${i}`, basis: ['丸み'], status: 'hypothesis' }], analytic: { shapes: ['三角'], composition: '構成', relations: [] }, unknowns: [], reobservations: [] })) },
    issueSummary: '', priorClaims: [], publicNames, repairHistory: [], previousAction: null, ...extra }) as never;
  const actions = (i: never) => Object.keys(buildJevDecisionPayload(i, { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v1' }).questions.action.criteria);
  assert.ok(actions(input()).includes('propose_name'), 'earlier input: the readings are candidates');
  assert.ok(!actions(input({ nameSource: 'public_only' })).includes('propose_name'));
  assert.ok(actions(input({ nameSource: 'public_only' }, [{ name: '船', figureId: slots[0], sourceTurn: 2 }])).includes('propose_name'));
});

import { s4Probe } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
test('05l: S4 judges the partner-name exclusion from the turn\'s full claims, not from the shortened claims of the request', () => {
  const slots = Array.from({ length: 6 }, (_, i) => `s-000${i}`);
  const ledger = Object.fromEntries(slots.map(id => [id, { status: 'unassigned', name: null }]));
  // The request as a runtime that dropped the partner-name exclusion at a shortened turn would send it: no priorClaims, the name among the public names.
  const input = { turn: 2, ownSlots: slots, nameSource: 'public_only', nameLedger: ledger,
    publicTurns: [{ turn: 1, speaker: 'ai', text: 'どの図形から話しましょうか？' }, { turn: 2, speaker: 'human', text: '帆という呼び名はどうですか。' }],
    observations: { observedAt: '2026-10-20T00:00:00.000Z', figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
      holistic: [{ construal: `折れ曲がった帯という見立て${i}`, basis: ['丸み'], status: 'hypothesis' }], analytic: { shapes: ['三角'], composition: '構成', relations: [] }, unknowns: [], reobservations: [] })) },
    issueSummary: '', priorClaims: [], publicNames: [{ name: '帆', figureId: null, sourceTurn: 2 }], repairHistory: [], previousAction: null, agreeNames: [], reobservationAllowed: true } as never;
  const body = buildJevDecisionPayload(input, { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v2' });
  assert.ok(Object.keys(body.questions.action.criteria).includes('propose_name'), 'the shortened request offers the partner name');
  const ctx = (humanNames: Set<string> | null) => s4Probe.setContext({ v3: true, trial: true, known: true, style: null, policy: 'holistic_v2', agree: [], facts: false, ledger, humanNames } as never);
  ctx(null);
  assert.equal(s4Probe.originalQuestions(body as never, JSON.parse(body.state), 'two_stage_v3'), true, 'by the request alone the record would be taken as it stands');
  ctx(new Set(['帆']));
  assert.equal(s4Probe.originalQuestions(body as never, JSON.parse(body.state), 'two_stage_v3'), false, 'the full claims show a partner proposal: refused');
});

import { nameBindsFigure, meaningfulEstimate } from '../dialogue-model/runtime/decision/referent-binding.ts';
import { buildJevLocalTestPayload } from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { LOCAL_FUNCTION_CRITERIA, LOCAL_FUNCTION_CRITERIA_V3, LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3 } from '../dialogue-model/runtime/local-grounding/classify.ts';
test('05q-A: the binding rule reads the newest meaningful estimate; none-first, all-zero, failed and missing estimates say nothing', () => {
  const ids = ['s3', 's4'];
  const est = (scores: Record<string, number>, status = 'ok') => ({ status, scores: { s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, none: 0, multiple: 0, ...scores } });
  assert.equal(nameBindsFigure('s3', []), false, 'no estimate: nothing binds');
  assert.equal(nameBindsFigure('s3', [est({ s3: 0.97, none: 0.03 })]), true);
  assert.equal(nameBindsFigure('s3', [est({ multiple: 1 })]), false);
  assert.equal(nameBindsFigure('s3', [est({ multiple: 1 }), est({ s3: 1 })]), true, 'a later estimate that singles it out binds');
  assert.equal(nameBindsFigure('s3', [est({ s3: 1 }), est({ multiple: 1 })]), false, 'a later contesting estimate unbinds');
  // none first (even with small positive scores elsewhere), all zero and failed estimates are skipped: they neither bind nor unbind.
  assert.equal(nameBindsFigure('s3', [est({ multiple: 1 }), est({ none: 0.91, s3: 0.09 })]), false, 'none=.91, s3=.09 after multiple=1 does not rebind');
  assert.equal(nameBindsFigure('s3', [est({ s3: 1 }), est({ none: 0.91, s4: 0.09 })]), true, 'none=.91, s4=.09 after s3=1 does not unbind');
  assert.equal(nameBindsFigure('s3', [est({ s3: 1 }), est({}), { status: 'unknown', scores: null }, null, undefined]), true);
  assert.equal(meaningfulEstimate(est({ none: 1 })), false);
  assert.equal(meaningfulEstimate(est({ s3: 0.5, none: 0.5 })), false, 'a tie with none points nowhere');
  assert.equal(meaningfulEstimate(est({ s3: 0.5 }, 'unknown')), false);
  void ids;
});

test('05q-B: only holistic_v3 carries the classification criteria that separate an approval request from a question about a name; every earlier set is byte for byte', () => {
  const input = { turn: 3, publicTurns: [{ turn: 1, speaker: 'human', text: 'これ、かかしとかどう？' }, { turn: 2, speaker: 'ai', text: 'どの形ですか？' }, { turn: 3, speaker: 'human', text: 'その呼び名でよいですか？' }],
    segments: [{ segmentId: 's1', quote: 'その呼び名でよいですか？', targets: [], aspect: 'name', proposition: 'p', name: null, linkedIssueId: null, respondsToTurn: null }], priorClaims: [], ownSlots: ['s-0000', 's-0001', 's-0002', 's-0003', 's-0004', 's-0005'] } as never;
  const criteria = (layout: 'two_stage_v1' | 'two_stage_v3', policy?: string) => buildJevLocalTestPayload(input, layout, policy).questions.segment_0_act.criteria;
  assert.deepEqual(criteria('two_stage_v1'), { ...LOCAL_FUNCTION_CRITERIA });
  assert.deepEqual(criteria('two_stage_v3'), { ...LOCAL_FUNCTION_CRITERIA_V3 });
  assert.deepEqual(criteria('two_stage_v3', 'holistic_v1'), { ...LOCAL_FUNCTION_CRITERIA_V3 });
  assert.deepEqual(criteria('two_stage_v3', 'holistic_v2'), { ...LOCAL_FUNCTION_CRITERIA_V3 });
  assert.deepEqual(criteria('two_stage_v3', 'holistic_v3'), { ...LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3 });
  assert.match(LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3.name_propose, /受け入れてよいか尋ねる質問/u);
  assert.match(LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3.ask, /名前の出所/u);
  assert.deepEqual(Object.keys(LOCAL_FUNCTION_CRITERIA_HOLISTIC_V3), Object.keys(LOCAL_FUNCTION_CRITERIA_V3), 'the closed set is the same set of labels');
});
