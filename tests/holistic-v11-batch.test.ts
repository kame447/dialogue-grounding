// jev_generation_retry_v11 candidate (issues #202, #204, #198): reply rules for questions and approval requests, and the generation guard's direction check.
// Synthetic wording only; no model call. Each case runs in both strategies where it goes through the real run, S4 and replay.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { defaultGenerationRetryVersion, findOrientationLeaks, findTopicShiftClaimsV7, findTopicShiftClaimsV11, isGenerationV10, isGenerationV11 } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { buildRecords, OWN } from './support/s4-v3-records.ts';
import type { Turn } from './support/s4-v3-records.ts';

const v10 = 'jev_generation_retry_v10', v11 = 'jev_generation_retry_v11';
const first = OWN.ownAnchors[0].id as string;
const seg = (id: string, quote: string, aspect: string, targets: string[], name: string | null = null, respondsToTurn: number | null = null) =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, name, linkedIssueId: null, respondsToTurn });
const statuses = (records: any) => verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
const passed = ['pass', 'pass', 'pass', 'pass'];
const outline = '折れた棒に小さな輪がついています。', alias = '月枠', proposal = '「月枠」とかどう？';
const untargeted: Turn = { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose',
  extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]), speech: '輪が細い棒につながる形ですか？' } };

test('v11 is the default of a new v5 trial and contains v10', () => {
  assert.equal(defaultGenerationRetryVersion('two_stage_v3', 'holistic_v5'), v11);
  assert.deepEqual([v10, v11].map(isGenerationV10), [true, true]);
  assert.deepEqual([v10, v11].map(isGenerationV11), [false, true]);
});

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const names = async (version: string | undefined, turns: Turn[]) => {
    const record = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, ...(version ? { generationRetryVersion: version as any } : {}), turns });
    assert.deepEqual(statuses(record), passed);
    return record.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames;
  };

  // #202 item 4 (NB-19N-1): a question about "the same figure?" that answers an older question must not leave the earlier confirmation standing.
  const question = '指しているのはこの図形でしょうか？';
  const check: Turn = { human: '輪のついた形を見比べたいです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: outline + question, aiActs: ['assert', 'ask'],
    aiExtraction: JSON.stringify([seg('s1', outline, 'part', [first]), seg('s2', question, 'question', [first])]) } };
  const pointing: Turn = { human: 'それそれ', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪のある形の話ですね。', act: 'agree', antecedent: 'claim_1',
    extraction: JSON.stringify([seg('s1', 'それそれ', 'question', [], null, 2)]) } };
  const goOn: Turn = { human: 'はい、続けてください。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: 'では続けます。' } };
  const askAgain: Turn = { human: '本当に同じ図形ですか？', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: 'そうです。', act: 'ask', antecedent: 'claim_1',
    extraction: JSON.stringify([seg('s1', '本当に同じ図形ですか？', 'referent', [], null, 4)]) } };
  test(`${label}: a re-check that answers an older question withdraws the earlier confirmation in v11; a v10 record keeps its judgment`, async () => {
    assert.deepEqual(await names(undefined, [check, pointing, goOn, askAgain, untargeted]), []);
    assert.equal((await names(v10, [check, pointing, goOn, askAgain, untargeted])).length, 1);
    assert.equal((await names(undefined, [check, pointing, goOn, untargeted])).length, 1, 'without the re-check the pointing answer still stands');
  });

  // #202 item 5 (NB-19N-3): a denied figure stays denied when the "referent" denial is normalized to a "question" denial.
  const deny: Turn = { human: 'いえ、その図形ではありません。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪が台につながっています。', act: 'deny', antecedent: 'claim_1',
    aiActs: ['assert'], aiExtraction: JSON.stringify([seg('s1', '輪が台につながっています。', 'part', [first])]), extraction: JSON.stringify([seg('s1', 'いえ、その図形ではありません。', 'referent', [first], null, 2)]) } };
  const describe: Turn = { human: 'そうですか。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪が台につながっています。', aiActs: ['assert'],
    aiExtraction: JSON.stringify([seg('s1', '輪が台につながっています。', 'part', [first])]) } };
  test(`${label}: a denied figure is not agreed to by a later nameless proposal in v11; a v10 record keeps its judgment`, async () => {
    assert.deepEqual(await names(undefined, [check, deny, describe, untargeted]), []);
    assert.equal((await names(v10, [check, deny, describe, untargeted])).length, 1);
  });

  // #198: a short approval request that answers the AI's question about a name carries the partner's open proposal.
  const askAbout: Turn = { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose', extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]),
    speech: 'どの図形のことか確かめたいです。この形のことですか？', aiActs: ['ask'], aiExtraction: JSON.stringify([seg('s1', 'この形のことですか？', 'question', [first], null, 1)]) } };
  const approve: Turn = { human: 'それなら、いい？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'name_propose', antecedent: 'claim_1',
    extraction: JSON.stringify([seg('s1', 'それなら、いい？', 'name', [], null, 2)]), speech: '輪の形ですか？' } };
  test(`${label}: an approval request after the AI's question marks a naming request in v11; a v10 record keeps rejecting it`, async () => {
    const newer = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns: [askAbout, approve] });
    const a = newer.trials[0].attempts.at(-1);
    assert.deepEqual(a.local.verification.rejected, []);
    assert.equal(a.namingRequest, true);
    assert.equal(a.local.claims[0].name, alias);
    assert.deepEqual(statuses(newer), passed);
    const older = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, generationRetryVersion: v10 as any, turns: [askAbout, approve] });
    assert.deepEqual(older.trials[0].attempts.at(-1).local.verification.rejected.map((r: any) => r.reason), ['nonpublic_name']);
    assert.deepEqual(statuses(older), passed);
  });
}

// ---- #204: the generation guard's direction check. The participant's recent words are the one source of an excused direction word.
const said = ['こちらの図では、輪の切れ目から左下へ向かって、とがった左向きの先が見えます。'];
const leaks = (text: string, version: string, human: readonly string[] = said) => findOrientationLeaks(text, 'holistic_v5', version as any, human, human);

// Audit 24 (a): a bracketed word nobody said; (b) a corrected or negated word; (c) a paraphrase of what they said. NB-24N-3, NB-21N-2/4, the stop-diagnosis types.
const nowRejected: [string, string[]?][] = [
  ['そちらでいう「右上の突起」が、輪の切れ目についているんですね。'],
  ['そちらでいう輪の切れ目から右上に、小さな突起がありますね。', ['右上ではなく、輪の切れ目から左下にあります。']],
  ['こちらの上の突起は、そちらの上側にあるはずだね。'],
  ['こちらの上の突起が、そちらの上の突起ですよ。'],
  ['こちらの上の突起があって、そちらの右上に穴がありますよ。'],
];
const nowAccepted: [string, string[]?][] = [
  ['そちらでいう左向きの先に対応する可能性はありそう。', ['輪の先が左を向いています。']], // paraphrase of what they said
  ['そちらでいう「左向きの先」に対応する可能性はありそう。'], // a bracketed word they said
  ['そちらでいうとがっている左向きの先に対応する可能性はありそう。'], // NB-24N-3
  ['そちらでいうとがる左向きの先に対応する可能性はありそう。'],
  ['こちらの上の中央に突起があります。'], // NB-21N-4
  ['そちらの左向きの先端に穴がありますね。'], // the participant's own word, under the partner's side
  ['こちらでは丸く見えますが、90度回して見ると、そちらの左向きの先に対応しそうです。'], // a hedged mapping with their word
  ['そちらでいう「下向き」と言ったのは、こちらでの向きの話でした。', ['下向きに見えます。']], // a bracket quoting something said in public
  ['そちらの左向きの先端が、この突起に対応しますか？'], // a question about the partner side
  ['そちらの右上の先端が、この突起に対応しますか？'], // asking about a side they never described is only a question
  ['そちらの左向きの先端から、輪郭はつながっていますか？'], // "から、" means from, not because
  ['こちらでは三角形状の突起が見えるのですが、そちらでいう左向きの先に対応する可能性はありそう。'], // "のです" is not a premise
];
test('v11 rejects a direction word the participant did not say (also in brackets, negated, or only about something else) and takes the ones they did', () => {
  for (const [text, human] of nowRejected) assert.notDeepEqual(leaks(text, v11, human ?? said), [], 'v11: ' + text);
  for (const [text, human] of nowAccepted) assert.deepEqual(leaks(text, v11, human ?? said), [], 'v11: ' + text);
});
test('v10 and earlier judge those sentences as before (the history of the whole trial, no negation, no paraphrase)', () => {
  assert.deepEqual(leaks(nowRejected[0][0], v10), [], 'v10 still passes the bracketed word');
  assert.deepEqual(leaks(nowRejected[2][0], v10), [], 'v10 still lets "こちらの上の…" swallow the partner side');
  assert.notDeepEqual(leaks(nowAccepted[0][0], v10, nowAccepted[0][1]), [], 'v10 rejects the paraphrase');
});
test('v11 keeps rejecting an unmarked direction and an assertion about the partner view that the participant did not make', () => {
  for (const text of ['上の突起がとがっていますね。', '右上に丸い穴がありますね。', 'そちらでは、輪の先は右向きですね。', 'そちらでいうと、輪の先は右向きですね。', 'そちらの上の突起がとがっていますね。',
    'そちらでいう『3』は、左上にV字状のくぼみがありますね。', '相手のいうことは分かりました、上の突起がとがっていますね。', 'そちらでいう左向きの先は、こちらと同じ向きですね。',
    'こちらの画面で上に見える三角の突起が、そちらでは左向きのとがった先にあたりそうなんですね。', 'こちらの画面では左側に丸い穴があり、そちらの画面でも同じ左側にありますね。'])
    assert.notDeepEqual(leaks(text, v11), [], text);
  // Without any recent participant words nothing is excused.
  assert.notDeepEqual(leaks('そちらでいう左向きの先に対応する可能性はありそう。', v11, []), []);
  // The participant's words from an earlier exchange do not count: only what was said since the AI last spoke.
  assert.notDeepEqual(findOrientationLeaks('そちらでいう左向きの先に対応する可能性はありそう。', 'holistic_v5', v11 as any, said, ['はい、続けてください。']), []);
});

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const confirming = '二つの部分がつながった形ですか？';
  const turns = (human: string, drafts: string[]): Turn[] => [
    { human: '尖っている部分はどこですか？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '小さい部分のほうですか？' } },
    { human, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', drafts } },
  ];
  const build = (version: string | undefined, human: string, drafts: string[]) =>
    buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns: turns(human, drafts) });
  test(`${label}: a v11 trial publishes a paraphrased quotation of what the participant said on the first draft and rewrites a bracketed word they never said; S4 and replay agree`, async () => {
    const human = '輪の先が左を向いています。';
    const ok = await build(undefined, human, [nowAccepted[0][0], confirming]);
    const a = ok.trials[0].attempts[0];
    assert.equal(a.generationRetryVersion, v11);
    assert.deepEqual(a.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(a.publicSpeech, nowAccepted[0][0]);
    assert.deepEqual(statuses(ok), passed);
    const held = await build(undefined, human, [nowRejected[0][0], confirming]);
    const b = held.trials[0].attempts[0];
    assert.equal(b.generationGuard.regenerated, true);
    assert.equal(b.publicSpeech, confirming);
    assert.deepEqual(statuses(held), passed);
    assert.equal(held.trials[0].replay[0].result.recordedPayloadsReproduced, true);
    // The same input as a v10 record keeps the v10 judgment (the bracketed word is published).
    const old = await build(v10, human, [nowRejected[0][0], confirming]);
    assert.deepEqual(old.trials[0].attempts[0].generationGuard.violations, []);
    assert.deepEqual(statuses(old), passed);
  });
}

// ---- audit 25: the v11 rules stay with the same figure and the latest proposal.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const build = (version: string | undefined, turns: Turn[]) =>
    buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns });
  const ownWords = '輪の先が左向きです。';
  const sameFigureTurns = (figure: string, drafts: string[]): Turn[] => [
    { human: ownWords, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'assert', extraction: JSON.stringify([seg('s1', ownWords, 'part', [figure])]), speech: 'その先は輪の切れ目につながっていますか？' } },
    { human: 'はい、つながっています。そちらの図だとどうですか？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', drafts } },
  ];
  const quoting = ['こちらの画面では輪に切れ目があるので、そちらでいう左向きの先に対応するかもしれません。', '二つの部分がつながった形ですか？'];
  test(`${label}: v11 excuses a direction the participant said about this figure before the AI's question, and not one said about another figure`, async () => {
    const same = await build(undefined, sameFigureTurns(first, quoting));
    const a = same.trials[0].attempts.at(-1);
    assert.deepEqual(a.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(a.publicSpeech, quoting[0]);
    assert.deepEqual(statuses(same), passed);
    const other = await build(undefined, sameFigureTurns(OWN.ownAnchors[1].id as string, quoting));
    const b = other.trials[0].attempts.at(-1);
    assert.equal(b.generationGuard.regenerated, true);
    assert.equal(b.publicSpeech, quoting[1]);
    assert.deepEqual(statuses(other), passed);
  });

  // #198 after a correction: the approval request answers the latest proposal, so the replaced name does not come back.
  const star = '星窓', corrected = '「星窓」とかどう？';
  const correction: Turn = { human: corrected, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: star, act: 'name_propose', extraction: JSON.stringify([seg('s1', corrected, 'name', [first], star)]),
    speech: 'この形のことですか？', aiActs: ['ask'], aiExtraction: JSON.stringify([seg('s1', 'この形のことですか？', 'question', [first], null, 3)]) } };
  const approve: Turn = { human: 'それなら、いい？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'name_propose', antecedent: 'claim_2',
    extraction: JSON.stringify([seg('s1', 'それなら、いい？', 'name', [], null, 4)]), speech: '輪の形ですか？' } };
  const plain: Turn = { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose', extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]), speech: '輪が細い棒につながる形ですか？' } };
  test(`${label}: an approval request after a corrected proposal never carries the replaced name in v11`, async () => {
    const record = await build(undefined, [plain, correction, approve]);
    const last = record.trials[0].attempts.at(-1);
    const claim = last.local.claims.find((c: any) => c.act === 'name_propose');
    assert.equal(claim.name, star);
    assert.equal(last.namingRequest, true);
    assert.deepEqual(statuses(record), passed);
    const names = record.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames.map((n: any) => n.name ?? n.candidateName);
    assert.ok(!names.includes(alias), JSON.stringify(names));
  });

  // audit 26: the same question asked twice, and the classifier links the request to the first one: the corrected name is still the one carried.
  const askedTwice: Turn[] = [
    { ...plain, plan: { ...plain.plan, speech: 'そちらが見ているのもこの形ですか？', aiActs: ['ask'], aiExtraction: JSON.stringify([seg('s1', 'そちらが見ているのもこの形ですか？', 'question', [first], null, 1)]) } },
    { ...correction, plan: { ...correction.plan, speech: 'この形のことですか？' } },
    { ...approve, plan: { ...approve.plan, antecedent: 'claim_1' } },
  ];
  test(`${label}: an approval request linked to the earlier of two identical questions still carries the corrected name in v11`, async () => {
    const record = await build(undefined, askedTwice);
    const last = record.trials[0].attempts.at(-1);
    assert.equal(last.local.claims.find((c: any) => c.act === 'name_propose').name, star);
    assert.equal(last.namingRequest, true);
    assert.deepEqual(statuses(record), passed);
    const names = record.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames.map((n: any) => n.name ?? n.candidateName);
    assert.ok(!names.includes(alias), JSON.stringify(names));
    // a single nameless proposal answered through its own question still works
    const single = await build(undefined, [askedTwice[0], { ...approve, plan: { ...approve.plan, antecedent: 'claim_1', extraction: JSON.stringify([seg('s1', 'それなら、いい？', 'name', [], null, 2)]) } }]);
    const one = single.trials[0].attempts.at(-1);
    assert.equal(one.local.claims.find((c: any) => c.act === 'name_propose' && c.sourceTurn === 3).name, alias);
    assert.equal(one.namingRequest, true);
  });
}

// audit 25n (B-25N-1): the proposal an approval request carries comes from the current naming interval only.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const build = (version: string | undefined, turns: Turn[]) =>
    buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns });
  const second = OWN.ownAnchors[1].id as string;
  const outline2 = '折れた棒に小さな輪がついています。', question2 = '指しているのはこの図形でしょうか？';
  const check: Turn = { human: '輪のついた形を見比べたいです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: outline2 + question2, aiActs: ['assert', 'ask'],
    aiExtraction: JSON.stringify([seg('s1', outline2, 'part', [first]), seg('s2', question2, 'question', [first])]) } };
  const pointing: Turn = { human: 'それそれ', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪のある形の話ですね。', act: 'agree', antecedent: 'claim_1',
    extraction: JSON.stringify([seg('s1', 'それそれ', 'question', [], null, 2)]) } };
  const plain: Turn = { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose', extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]), speech: '輪が細い棒につながる形ですか？' } };
  const leave: Turn = { human: 'はい、それでお願いします。', plan: { action: 'agree', target: 'figure_0', referent: 'figure_0', name: alias, speech: 'いいですね。「月枠」にしましょう。' } };
  const next: Turn = { human: '別の図形のことです。', plan: { action: 'confirm', target: 'figure_1', referent: 'figure_1', speech: 'この形のことですか？', aiActs: ['ask'], aiExtraction: JSON.stringify([seg('s1', 'この形のことですか？', 'question', [second], null, 9)]) } };
  const approve: Turn = { human: 'それなら、いい？', plan: { action: 'confirm', target: 'figure_1', referent: 'figure_1', act: 'name_propose', antecedent: 'claim_4',
    extraction: JSON.stringify([seg('s1', 'それなら、いい？', 'name', [], null, 10)]), speech: '輪の形ですか？' } };
  test(`${label}: an approval request in the next naming interval does not carry a name from before the boundary in v11`, async () => {
    const record = await build(undefined, [check, pointing, plain, leave, next, approve]);
    const last = record.trials[0].attempts.at(-1);
    const boundary = record.trials[0].lastCommittedState.judgments.some((j: any) => ['agree', 'defer', 'move_on'].includes(j.judgment.action));
    assert.ok(boundary, 'a boundary judgment was executed');
    assert.deepEqual(last.local.claims.filter((c: any) => c.act === 'name_propose' && c.name === alias), []);
    assert.notEqual(last.namingRequest, true);
    assert.deepEqual(statuses(record), passed);
  });
}

// ---- final batch: #204 topic shift (negations, announcements, past mentions; the missed forms), #205 colloquial self markers and confirmations, the judgment legend.
test('v11 does not read a negated, announced or past move as a topic shift, and reads the missed forms as one; v7 judges as before', () => {
  const notShifts = ['次の図形に進まず、この二つのどちらか確かめましょう。', '次の図形に移る前に、中央の穴について確認してもいいですか？', '次の図形へ移りません。',
    'さっき別の図形に移ったときに話した特徴です。', '別の形に切り替えずに、今の形を確かめましょう。', '次に、中央の穴を確認させてください。'];
  const shifts = ['別の形にしよう。', '次の図形にしよう。', '次を見ましょう。', '次の図形に進みましょう。', '次の図形に移ります。', '別の形に切り替えましょう。', '次の図形へ進もう。', '次いこう。'];
  for (const t of notShifts) { assert.deepEqual(findTopicShiftClaimsV11(t), [], t); if (!t.startsWith('次に、')) assert.deepEqual(findTopicShiftClaimsV7(t), ['unsupported_topic_shift'], t); }
  for (const t of shifts) assert.deepEqual(findTopicShiftClaimsV11(t), ['unsupported_topic_shift'], t);
});
test('v11 takes the colloquial self markers and a confirmation of a direction the participant said; guesses and assertions stay rejected', () => {
  const said = ['こちらは右上に小さな突起があります。'];
  const l = (text: string, version: string) => findOrientationLeaks(text, 'holistic_v5', version as any, said, said, said);
  for (const t of ['僕の画面では、右上に突起があります。', '僕から見ると、左側に穴があります。', 'こっちの画面では右端がとがっています。']) { assert.deepEqual(l(t, v11), [], t); assert.deepEqual(l(t, v10), ['orientation_leak'], t); }
  for (const t of ['そちらは右上に突起があるんですね。', 'そちらは右上に突起があるのですね。']) assert.deepEqual(l(t, v11), [], t);
  for (const t of ['そちらは右上に突起がありますね。', 'そちらは右上に突起があるはずです。', 'そちらは左下に突起があるんですね。', 'そちらは右上に突起がありそうなんですね。'])
    assert.deepEqual(l(t, v11), ['shared_view_assumption'], t);
});
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`${label}: a v11 trial's judgment requests describe the answerClaims rows; a v10 trial's do not; S4 agrees`, async () => {
    const turns: Turn[] = [{ human: '輪の先が左向きです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '輪の形ですか？' } }];
    const build = (version?: string) => buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns });
    const newer = await build(), older = await build(v10);
    assert.ok(JSON.stringify(newer).includes('answerClaimsは'));
    assert.ok(!JSON.stringify(older).includes('answerClaimsは'));
    assert.deepEqual(statuses(newer), passed);
    assert.deepEqual(statuses(older), passed);
  });
}

// NB-26N-4/5: an utterance whose claims name no figure still counts for the figure the AI answered it on.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const build = (turns: Turn[]) => buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns });
  const ask = { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: 'その先は輪の切れ目につながっていますか？' };
  const ok = ['こちらの画面では輪に切れ目があるので、そちらでいう左向きの先に対応するかもしれません。', '二つの部分がつながった形ですか？'];
  test(`${label}: a direction said in an utterance without a target counts after one exchange (NB-26N-4)`, async () => {
    const said: Turn = { human: '輪の先が左向きです。', plan: { ...ask, act: 'assert', extraction: JSON.stringify([seg('s1', '輪の先が左向きです。', 'part', [])]) } };
    const record = await build([said, { human: 'はい、つながっています。そちらの図だとどうですか？', plan: { ...ask, drafts: ok } }]);
    const a = record.trials[0].attempts.at(-1);
    assert.deepEqual(a.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.deepEqual(statuses(record), passed);
  });
  test(`${label}: a correction without a target still takes the replaced word back (NB-26N-5)`, async () => {
    const said: Turn = { human: '輪の切れ目から右上に突起があります。', plan: { ...ask, act: 'assert', extraction: JSON.stringify([seg('s1', '輪の切れ目から右上に突起があります。', 'part', [first])]) } };
    const fix: Turn = { human: '右上ではなく、左下でした。', plan: { ...ask, act: 'assert', extraction: JSON.stringify([seg('s1', '右上ではなく、左下でした。', 'part', [])]) } };
    const draft = 'そちらでいう輪の切れ目から右上に、小さな突起がありますね。';
    const record = await build([said, fix, { human: 'はい、そうです。そちらはどうですか？', plan: { ...ask, drafts: [draft, ok[1]] } }]);
    const a = record.trials[0].attempts.at(-1);
    assert.equal(a.generationGuard.regenerated, true);
    assert.equal(a.publicSpeech, ok[1]);
    assert.deepEqual(statuses(record), passed);
  });
}

// ---- final batch E (audit 25 / 25n non-blockers)
test('v11 guard: a bracket quotes the participant only, a taken-back word is gone (also by paraphrase or a noun phrase), そちらの+noun+方位 and a following 同じ are assertions, ので/から boundaries', () => {
  const l = (text: string, human: string[], version = v11) => findOrientationLeaks(text, 'holistic_v5', version as any, human, human, [...human, 'こちらの画面では右上に突起があります。']);
  // NB-25N-1: a word only the AI said, in brackets
  assert.deepEqual(l('そちらでいう「右上の突起」が、輪の切れ目についているんですね。', ['左下に突起があります。']), ['shared_view_assumption']);
  assert.deepEqual(l('そちらでいう「左下の突起」が、輪の切れ目についているんですね。', ['左下に突起があります。']), []);
  // NB-25N-3
  assert.deepEqual(l('そちらでいう右向きの先に対応する可能性はありそう。', ['右を向いていません。']), ['shared_view_assumption']);
  assert.deepEqual(l('そちらでいう右上の突起に対応する可能性はありそう。', ['右上の突起ではなく、左下の突起です。']), ['shared_view_assumption']);
  // NB-25N-4
  assert.deepEqual(l('こちらの上の突起は、そちらの輪の右上にあるはずだね。', ['左下にあります。']), ['shared_view_assumption']);
  assert.deepEqual(l('そちらの左側にも同じ穴がありますね。', ['左側に穴があります。']), ['shared_view_assumption']);
  // NB-25N-5
  assert.deepEqual(l('そちらでは左向きに見えるのでしょうか？', ['左向きです。']), []);
  assert.deepEqual(l('そちらでは左向きに見えませんから、同じ形ですか？', ['左向きです。']), ['shared_view_assumption']);
  // v10 judges as before (its bracket check accepts any public word of the trial)
  assert.deepEqual(l('そちらでいう「右上の突起」が、輪の切れ目についているんですね。', ['左下に突起があります。'], v10), []);
});

// NB-25N-6: a denial of the figure that answers an ask about a feature (normalized to deny/part) also keeps the figure from being agreed.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const build = (version: string | undefined, turns: Turn[]) =>
    buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns });
  const featureQuestion = 'そちらの輪にも途中に切れ目がありますか？';
  const checkPart: Turn = { human: '輪のついた形を見比べたいです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: featureQuestion, aiActs: ['ask'],
    aiExtraction: JSON.stringify([seg('s1', featureQuestion, 'part', [first])]) } };
  const denyIt: Turn = { human: 'いえ、その図形ではありません。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪が台につながっています。', act: 'deny', antecedent: 'claim_0',
    aiActs: ['assert'], aiExtraction: JSON.stringify([seg('s1', '輪が台につながっています。', 'part', [first])]), extraction: JSON.stringify([seg('s1', 'いえ、その図形ではありません。', 'referent', [first], null, 2)]) } };
  const describeIt: Turn = { human: 'そうですか。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: '輪が台につながっています。', aiActs: ['assert'],
    aiExtraction: JSON.stringify([seg('s1', '輪が台につながっています。', 'part', [first])]) } };
  const nameless: Turn = { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose', extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]), speech: '輪が細い棒につながる形ですか？' } };
  test(`${label}: a denial answering an ask about a feature keeps the denied figure out of the agree candidates in v11; a v10 record keeps its judgment`, async () => {
    const names = async (version: string | undefined) => (await build(version, [checkPart, denyIt, describeIt, nameless])).trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames;
    assert.deepEqual(await names(undefined), []);
    assert.equal((await names(v10)).length, 1);
  });
}

// NB-26N-3: withdrawing a name proposal that named no figure withdraws it, so the old name does not stay open for an approval request.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const build = (version: string | undefined, turns: Turn[]) =>
    buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns });
  const first: Turn = { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose', extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]), speech: '輪の形ですか？' } };
  const drop: Turn = { human: 'やっぱり、その名前はやめます。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'withdraw', antecedent: 'claim_0', speech: '輪の形ですか？',
    extraction: JSON.stringify([seg('s1', 'やっぱり、その名前はやめます。', 'name', [], null, 1)]) } };
  test(`${label}: a withdrawn nameless proposal is withdrawn in v11 and was rejected before`, async () => {
    const newer = await build(undefined, [first, drop]);
    const a = newer.trials[0].attempts.at(-1);
    assert.deepEqual(a.local.verification.rejected, []);
    assert.deepEqual(a.local.claims.map((c: any) => c.act), ['withdraw']);
    assert.deepEqual(statuses(newer), passed);
    const older = await build(v10, [first, drop]);
    assert.deepEqual(older.trials[0].attempts.at(-1).local.verification.rejected.map((r: any) => r.reason), ['inconsistent_claim_response']);
    assert.deepEqual(statuses(older), passed);
  });
}

// NB-26N-2: a proposal for one figure is not carried to a question about another figure.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const second = OWN.ownAnchors[1].id as string;
  const build = (turns: Turn[]) => buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns });
  const star = '星窓', text = '「星窓」とかどう？';
  const proposeFirst: Turn = { human: text, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: star, act: 'name_propose', extraction: JSON.stringify([seg('s1', text, 'name', [first], star)]), speech: '輪の形ですか？' } };
  const other: Turn = { human: '別の図形のことです。', plan: { action: 'confirm', target: 'figure_1', referent: 'figure_1', speech: 'この形のことですか？', aiActs: ['ask'], aiExtraction: JSON.stringify([seg('s1', 'この形のことですか？', 'question', [second], null, 3)]) } };
  const approve: Turn = { human: 'それなら、いい？', plan: { action: 'confirm', target: 'figure_1', referent: 'figure_1', act: 'name_propose', antecedent: 'claim_1', speech: '輪の形ですか？',
    extraction: JSON.stringify([seg('s1', 'それなら、いい？', 'name', [], null, 4)]) } };
  test(`${label}: an approval request about another figure does not take over the first figure's name in v11`, async () => {
    const record = await build([proposeFirst, other, approve]);
    const a = record.trials[0].attempts.at(-1);
    assert.deepEqual(a.local.claims.filter((c: any) => c.act === 'name_propose' && c.sourceTurn === 5), []);
    assert.notEqual(a.namingRequest, true);
    assert.deepEqual(statuses(record), passed);
  });
}

// scoped_v6 keeps a confirm or repair that only states something as a check awaiting an answer (audit 28n, B-28N-1): its description is never public focus, so it cannot
// replace an earlier unanswered question, a human denial or a figure the partner never confirmed.
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const build = (version: string | undefined, speech: string, turns: Turn[] = []) => buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' },
    turns: [{ human: 'この形の特徴を教えてください。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech, aiActs: ['assert'], aiExtraction: JSON.stringify([seg('s1', speech, 'part', [first])]) } },
      { human: proposal, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose', extraction: JSON.stringify([seg('s1', proposal, 'name', [], alias)]), speech: '輪が細い棒につながる形ですか？' } }, ...turns] });
  const names = async (version: string | undefined, speech: string) => (await build(version, speech)).trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames;
  test(`${label}: a confirm that only states something never becomes public focus in v11 (scoped_v6), as in v10`, async () => {
    assert.equal((await names(undefined, '輪が台に接している形です。')).length, 0);
    assert.equal((await names(v10, '輪が台に接している形です。')).length, 0);
    assert.equal((await names(undefined, '輪が台に接している形ですか？')).length, 0);
  });
  // audit 28: a request ("…か教えてください") that extraction dropped may be the question, so the confirm still waits for the answer.
  test(`${label}: a confirm whose request sentence was not extracted still waits for the answer in v11 (audit 28)`, async () => {
    const speech = 'こちらの図では輪の縁に切れ目があります。そちらの輪にも切れ目があるか教えてください。';
    const turns: Turn[] = [{ human: '輪の形を見比べたいです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech, aiActs: ['assert'],
        aiExtraction: JSON.stringify([seg('s1', 'こちらの図では輪の縁に切れ目があります。', 'part', [first])]) } },
      { human: '切れ目のない方の輪は「月枠」と呼びませんか？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', name: alias, act: 'name_propose',
        extraction: JSON.stringify([seg('s1', '切れ目のない方の輪は「月枠」と呼びませんか？', 'name', [], alias)]), speech: '輪が細い棒につながる形ですか？' } }];
    const record = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns });
    assert.deepEqual(record.trials[0].lastCommittedState.judgments.at(-1).jevTurn.agreeNames, []);
    assert.deepEqual(statuses(record), passed);
  });
}
