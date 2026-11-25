// jev_generation_retry_v11 candidate (issues #202, #204, #198): reply rules for questions and approval requests, and the generation guard's direction check.
// Synthetic wording only; no model call. Each case runs in both strategies where it goes through the real run, S4 and replay.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { defaultGenerationRetryVersion, findOrientationLeaks, isGenerationV10, isGenerationV11 } from '../dialogue-model/runtime/v2/generation-guard.ts';
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
