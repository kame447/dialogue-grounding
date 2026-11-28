// #269 relative_90_180_270, holistic_v5: the Jev requests state the task's rotation condition per mode.
// relative_pm90 (also when the mode is omitted) keeps ROTATION_V5, relative_0 states nothing, and relative_90_180_270 has a sentence of its own.
// Synthetic material only. The earlier modes' requests are pinned to values computed from the base commit 620ef5c, before the new mode existed;
// like the stimulus pins, never regenerate them from the current implementation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { interventionForStrategy, BypassAcceptanceError, planBypassAcceptance } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import type { JevDecisionInput } from '../dialogue-model/runtime/decision/contract.ts';
import { ROTATION_V5, ROTATION_V5_90_180_270, buildHumanReferentPayload, buildJevDecisionDetailPayload, buildJevDecisionPayload,
  buildJevTargetPayload, buildRepairProspectPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { OLD, OWN } from './support/s4-v3-records.ts';

const slots: string[] = OWN.ownAnchors.map((a: { id: string }) => a.id);
const NAME = '糸巻き';
const lines = [
  { turn: 1, speaker: 'human', text: `この丸い形は「${NAME}」と呼びませんか？` }, { turn: 2, speaker: 'ai', text: 'では、その形を呼びましょう。' },
  { turn: 3, speaker: 'human', text: '枝のある形は\nあとで確かめたいです。' }, { turn: 4, speaker: 'ai', text: '細い枝が二本ある形ですか？' },
  { turn: 5, speaker: 'human', text: 'はい、二本です。' }, { turn: 6, speaker: 'ai', text: '二本と分かりました。' }, { turn: 7, speaker: 'human', text: 'もう一度確かめたい。' },
];
const claim = (id: string, sourceTurn: number, speaker: string, quote: string, over: Record<string, unknown> = {}) => ({ id, turn: sourceTurn, issueId: 'i-' + id, targets: [slots[0]],
  aspect: 'part', act: 'assert', proposition: '命題-' + id, name: null, speaker, sourceTurn, quote, respondsTo: null, source: speaker === 'human' ? 'partner_statement' : 'ai_hypothesis', ...over });
const input = (extra: Record<string, unknown> = {}) => ({
  turn: 7, publicTurns: lines, ownSlots: slots, observations: structuredClone(OLD.state.observationMemo), issueSummary: '',
  priorClaims: [claim('c1', 1, 'human', NAME, { aspect: 'name', act: 'name_propose', name: NAME }), claim('c5', 5, 'human', 'はい、二本です。', { targets: [slots[1]], respondsTo: 'c4' })],
  repairHistory: [{ turn: 3, issueId: null, action: 'confirm', question: '細い枝が二本ある', partnerClaims: [{ id: 'c5', act: 'assert', proposition: '命題-c5', targets: [slots[1]] }],
    candidatesBefore: [slots[1]], candidatesAfter: [slots[1]], addedClaimIds: ['c5'], removedClaimIds: [], progress: 'changed' }],
  previousAction: { turn: 6, action: 'accept', target: { kind: 'single', figureId: slots[1] }, name: null, feature: null }, publicNames: [], ...extra }) as any;
const ledger = [{ turn: 2, action: 'agree', target: { kind: 'single', figureId: slots[0] }, name: NAME, feature: null },
  { turn: 4, action: 'confirm', target: { kind: 'single', figureId: slots[1] }, name: null, feature: '細い枝が二本ある' }];
const nameLedger = Object.fromEntries(slots.map((id, i) => [id, i === 0 ? { status: 'agreed', name: NAME } : { status: 'unassigned', name: null }]));
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const V3 = { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' } as const;
const selected = { action: 'confirm', target: { kind: 'single', figureId: slots[1] } } as any;

const baseOf = (mode: unknown) => ({ ...input(mode === undefined ? {} : { rotationMode: mode }), nameLedger, judgmentLedger: ledger });
/** Every request builder that appends the holistic_v5 notation (and with it the rotation condition). */
const requestsOf = (mode: unknown) => {
  const base = baseOf(mode), notation = { ...base, notationV6: true };
  return {
    decision_v1: buildJevDecisionPayload(base, { questionLayout: 'two_stage_v1', dialoguePolicy: 'holistic_v5' }),
    decision_v2: buildJevDecisionPayload(base, { questionLayout: 'two_stage_v2', dialoguePolicy: 'holistic_v5' }),
    decision_v3: buildJevDecisionPayload(base, V3),
    decision_v3_notation: buildJevDecisionPayload(notation, V3),
    referent: buildHumanReferentPayload(base),
    prospect_notation: buildRepairProspectPayload(notation, { questionLayout: 'two_stage_v3' }),
    target: buildJevTargetPayload(base, 'confirm'),
    detail: buildJevDecisionDetailPayload(base, selected, { questionLayout: 'two_stage_v3' })!,
  };
};
const digestsOf = (mode: unknown) => Object.fromEntries(Object.entries(requestsOf(mode)).map(([kind, payload]) => [kind, sha(payload)]));

const BASE_REQUEST_SHA256 = {
  relative_pm90: {
    decision_v1: '30804cb9f32f90ef7b88973f241f6e93005255192b434067518af3052dc0064a',
    decision_v2: 'e7ebdbf1f12ac6aaba1f601046da6515ca11090bf4e23c222ac3c349f213c1cd',
    decision_v3: 'a887f0dbbc4b14c42555c4b9ad28deb76eb9c106699afda6544f199cb84f6a4c',
    decision_v3_notation: '312719c724897c55090d9de9d32dcd343083eceeae1bce74ca359cac4bfbb1ec',
    referent: '0d9eefb288b5724e38eae00a77eb5cb4981c30cb876e1d266190e138a612409d',
    prospect_notation: '948034fb8d53ee77a67f74e2eca175db1ce93dfc733e56092e9a774996856bbf',
    target: '38ec87b6f97981a76c1d7b78422e83d8875f603854dcf197084c2af6f03801b7',
    detail: 'c7567c15508ba8fa15ab76fbfe671ad41fbf397a23b1518d0e7ea97d35386e31',
  },
  relative_0: {
    decision_v1: 'f5c173f0c0a2716e0c24aed0a7ab5db13920b04615c4724343974dfaa6f2e731',
    decision_v2: 'e9adbd69607865e5e987997c0f598c763e506c45e0e0162b9a90ff684c62d65e',
    decision_v3: '3ade7e8a306b2d937d4a7e5245da54c47ddd8f204cf9801d27c7ae9bdbcee05e',
    decision_v3_notation: '4998eafa54a16bc97433e49232af5216ec45a2a0520f8feb61f163f1b990e551',
    referent: '10ef59513f02ee0e3652cb6f219d5c2e3189b3b06e47695e7728e94d99aa3681',
    prospect_notation: '12ea8be994efc83610a5d9b9b45bf550ead6e1605f0b517be038097d8512a1df',
    target: '8183e73ed568b3633e8da6246bc7eceac73cc921685be99894bac6b127e3f808',
    detail: '289acc8f58bd3b3f88851dfedb3ffe6c8477925df2cc2695e4b93c44b8e38deb',
  },
} as const;

test('the requests of relative_pm90 (also when the mode is omitted) and of relative_0 keep the bytes of the base commit', () => {
  assert.deepEqual(digestsOf(undefined), BASE_REQUEST_SHA256.relative_pm90);
  assert.deepEqual(digestsOf('relative_pm90'), BASE_REQUEST_SHA256.relative_pm90);
  assert.deepEqual(digestsOf('relative_0'), BASE_REQUEST_SHA256.relative_0);
});

const NEW_SENTENCE = '課題の条件として、相手の盤面は自分の盤面と同じ図形をそれぞれ90度・180度・270度のいずれかの角度で回転して提示しています（relative_90_180_270）。向きや方位を表す語（上・下・左・右・縦・横など）は、相手と自分で一致しない前提で扱い、向きに依存しない特徴で照合してください。';
const count = (text: string, part: string) => text.split(part).length - 1;
const instructionsOf = (payload: any) => Object.values<any>(payload.questions).map(q => q.instructions as string);

test('the new sentence is fixed, and its orientation sentence is the one relative_pm90 states', () => {
  assert.equal(ROTATION_V5_90_180_270, NEW_SENTENCE);
  const [turn, orientation, ...rest] = ROTATION_V5_90_180_270.split('。');
  assert.deepEqual([turn, orientation, rest], [NEW_SENTENCE.split('。')[0], ROTATION_V5.split('。')[1], ['']]);
  assert.notEqual(ROTATION_V5_90_180_270, ROTATION_V5);
  assert.ok(!ROTATION_V5_90_180_270.includes('±90'));
});

test('every request that carries the notation states the rotation of its mode exactly once: pm90 and omitted keep theirs, relative_0 none, the new mode its own', () => {
  const expected = new Map<unknown, [number, number]>([[undefined, [1, 0]], ['relative_pm90', [1, 0]], ['relative_0', [0, 0]], ['relative_90_180_270', [0, 1]]]);
  for (const [mode, [pm90, next]] of expected) {
    for (const [kind, payload] of Object.entries(requestsOf(mode))) {
      const texts = instructionsOf(payload);
      assert.ok(texts.length > 0, `${String(mode)} ${kind}`);
      for (const text of texts) {
        assert.equal(count(text, ROTATION_V5), pm90, `${String(mode)} ${kind}: ROTATION_V5`);
        assert.equal(count(text, ROTATION_V5_90_180_270), next, `${String(mode)} ${kind}: the new sentence`);
        // "±90度ほど" belongs to relative_pm90's sentence alone.
        assert.equal(count(text, '±90度ほど'), pm90, `${String(mode)} ${kind}: ±90度ほど`);
      }
    }
  }
  // Without the compact judgment material (no ledger) no mode states a rotation.
  for (const mode of ['relative_pm90', 'relative_0', 'relative_90_180_270']) {
    for (const text of instructionsOf(buildJevDecisionPayload({ ...input({ rotationMode: mode }), nameLedger }, V3))) {
      assert.doesNotMatch(text, /課題の条件として|relative_/u);
    }
  }
});

test('the state of a request names the mode it was written for', () => {
  const states = (mode: unknown) => ['decision_v3', 'decision_v3_notation', 'referent', 'prospect_notation', 'target', 'detail']
    .map(kind => JSON.parse((requestsOf(mode) as any)[kind].state).rotationMode);
  for (const mode of ['relative_pm90', 'relative_0', 'relative_90_180_270']) assert.deepEqual([...new Set(states(mode))], [mode], mode);
  assert.deepEqual([...new Set(states(undefined))], ['relative_pm90']);
});

test('the new mode is accepted and unknown modes are invalid_input in the request builders and in the bypass acceptance', () => {
  const unknown = ['relative_x', 'relative_90_180', 'relative_180', 'RELATIVE_90_180_270', 'relative_90_180_270 ', '', null, 0, [], {}, ['relative_90_180_270']];
  for (const mode of ['relative_pm90', 'relative_0', 'relative_90_180_270']) assert.doesNotThrow(() => requestsOf(mode), mode);
  for (const mode of unknown) {
    assert.throws(() => buildJevDecisionPayload({ ...baseOf(undefined), rotationMode: mode }, V3), /invalid_input/u, JSON.stringify(mode));
    assert.throws(() => buildHumanReferentPayload({ ...baseOf(undefined), rotationMode: mode }), /invalid_input/u, JSON.stringify(mode));
  }
  // The bypass acceptance only lists the key; the value is checked by the request builder it calls.
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/bypass-acceptance/${name}`, import.meta.url), 'utf8'));
  const withMode = (rotationMode: unknown) => ({ ...fixture('MINIMAL-INPUT.json'), rotationMode }) as JevDecisionInput;
  const config = interventionForStrategy('repair-first');
  for (const mode of ['relative_pm90', 'relative_0', 'relative_90_180_270']) {
    assert.doesNotThrow(() => planBypassAcceptance(withMode(mode), fixture('MINIMAL-ORIGINAL-NATIVE.json'), config), mode);
  }
  for (const mode of unknown) {
    assert.throws(() => planBypassAcceptance(withMode(mode), fixture('MINIMAL-ORIGINAL-NATIVE.json'), config),
      (error: unknown) => error instanceof BypassAcceptanceError && error.code === 'invalid_input', JSON.stringify(mode));
  }
});
