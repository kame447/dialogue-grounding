// jev_generation_retry_v10 (candidate): the quotation after "そちらでいう" excuses only a direction word the participant used in public, and the
// ai_bound_target provenance is refused in records older than v9. Synthetic wording only; no model call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { interventionForStrategy } from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import { defaultGenerationRetryVersion, findOrientationLeaks, isGenerationV9, isGenerationV10 } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { validateJevPrivateStateV2 } from '../dialogue-model/runtime/v2/jev-turn.ts';
import { buildRecords, OWN } from './support/s4-v3-records.ts';
import type { Turn } from './support/s4-v3-records.ts';

const v8 = 'jev_generation_retry_v8', v9 = 'jev_generation_retry_v9', v10 = 'jev_generation_retry_v10';
const said = ['こちらの図では、輪の切れ目から左下へ向かって、とがった左向きの先が見えます。'];
const leaks = (text: string, version: string, human: readonly string[] = said) => findOrientationLeaks(text, 'holistic_v5', version as any, human);

test('v10 contains v9 (v11 is now the default of a new v5 trial)', () => {
  assert.equal(defaultGenerationRetryVersion('two_stage_v3', 'holistic_v5'), 'jev_generation_retry_v11');
  assert.deepEqual([v8, v9, v10].map(isGenerationV9), [false, true, true]);
  assert.deepEqual([v8, v9, v10].map(isGenerationV10), [false, false, true]);
});

// The quoted phrase is excused only for a direction word the participant said. v9 judges them as before.
const notSaid = [
  'そちらでいう輪の切れ目から右上に、小さな突起がありますね。', // audit 23: the participant said 左下, not 右上
  'そちらでいう『3』は、左上にV字状のくぼみがありますね。', // NB-22N-2
  'そちらでいう『星』は、そちらの上端に切れ目がありますよ。',
  '相手のいうことは分かりました、上の突起がとがっていますね。',
  'そちらでは、輪の先は右向きですね。', // audit 22
  'そちらでいうと、輪の先は右向きですね。',
];
const quotesWhatWasSaid = [
  'そちらでいう左向きの先端を含む形も、この輪郭のつながり方に対応していますか？',
  'こちらの画面では三角形状の突起が見えるので、そちらでいう左向きの先に対応する可能性はありそう。',
  'そちらでいうとがった左向きの先は、こちらの三角の突起に対応しますか？', // audit 23 non-blocker
  'そちらでいうとがった左向きの先に対応する可能性はありそう。', // audit 23 non-blocker, as an assertion: "いうとがった" is not the conditional "いうと"
  'そちらでいう輪の切れ目から左下の部分は、こちらの突起につながりますか？',
];
test('v10 rejects what v9 let through when the quoted direction word was never said by the participant, and still passes what they did say', () => {
  assert.deepEqual(leaks(notSaid[0], v9), [], 'v9 lets the audit 23 sentence through');
  for (const text of notSaid) assert.notDeepEqual(leaks(text, v10), [], 'v10: ' + text);
  for (const text of quotesWhatWasSaid) { assert.deepEqual(leaks(text, v10), [], 'v10: ' + text); if (!text.includes('いうとがった')) assert.deepEqual(leaks(text, v9, []), [], 'v9 needs no history: ' + text); }
});
test('v10 without any participant history excuses no assertion; v9 and v8 do not read the history', () => {
  // A question about the partner side needs no excuse; an assertion that quotes a word nobody said does.
  assert.deepEqual(leaks(quotesWhatWasSaid[1], v10), []);
  assert.notDeepEqual(leaks(quotesWhatWasSaid[1], v10, []), []);
  for (const version of [v8, v9]) for (const text of [...notSaid, ...quotesWhatWasSaid]) assert.deepEqual(leaks(text, version, said), leaks(text, version, []), version + ' ' + text);
});

// Through the real run, S4 and replay, both strategies.
const confirming = '二つの部分がつながった形ですか？';
const turns = (human: string, drafts: string[]): Turn[] => [
  { human: '尖っている部分はどこですか？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '小さい部分のほうですか？' } },
  { human, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', drafts } },
];
const statuses = (records: any) => verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  const build = (version: string | undefined, human: string, drafts: string[]) =>
    buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns: turns(human, drafts) });
  const human = said[0];
  test(`${label}: a v10 trial publishes the quotation of a word the participant said on the first draft, and rewrites one they never said; S4 and replay agree`, async () => {
    const ok = await build(v10, human, [quotesWhatWasSaid[2], confirming]);
    const a = ok.trials[0].attempts[0];
    assert.equal(a.generationRetryVersion, v10);
    assert.deepEqual(a.generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.equal(a.publicSpeech, quotesWhatWasSaid[2]);
    assert.deepEqual(statuses(ok), ['pass', 'pass', 'pass', 'pass']);
    const held = await build(v10, human, [notSaid[0], confirming]);
    const b = held.trials[0].attempts[0];
    assert.equal(b.generationGuard.regenerated, true);
    assert.equal(b.publicSpeech, confirming);
    assert.deepEqual(statuses(held), ['pass', 'pass', 'pass', 'pass']);
    assert.equal(held.trials[0].replay[0].result.recordedPayloadsReproduced, true);
  });
  test(`${label}: the same input as a v9 record keeps the v9 judgment (the audit 23 sentence is published)`, async () => {
    const old = await build(v9, human, [notSaid[0], confirming]);
    assert.deepEqual(old.trials[0].attempts[0].generationGuard, { violations: [], regenerated: false, fallback: false });
    assert.deepEqual(statuses(old), ['pass', 'pass', 'pass', 'pass']);
  });
}

// The ai_bound_target provenance exists only in v9 and later.
const first = OWN.ownAnchors[0].id as string;
const seg = (id: string, quote: string, aspect: string, targets: string[]) => ({ segmentId: id, quote, proposition: quote, aspect, targets, name: null, linkedIssueId: null, respondsToTurn: null });
const askTurn: Turn = { human: '輪のついた形を見比べたいです。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '折れた棒に小さな輪がついています。そちらの輪にも切れ目がありますか？', aiActs: ['assert', 'ask'],
  aiExtraction: JSON.stringify([seg('s1', '折れた棒に小さな輪がついています。', 'part', [first]), seg('s2', 'そちらの輪にも切れ目がありますか？', 'part', [])]) } };
for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`${label}: a bound question target carries ai_bound_target from v9; restore refuses it in a v8 state; S4 refuses a v8 record that holds it`, async () => {
    const claimOf = (record: any) => record.trials[0].lastCommittedState.graph.records.find((r: any) => r.kind === 'claim' && r.speaker === 'ai' && r.act === 'ask');
    const fresh = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, turns: [askTurn, { human: '輪の話ですね。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: 'はい。' } }] });
    assert.equal(claimOf(fresh).source, 'ai_bound_target');
    const ids = OWN.ownAnchors.map((a: any) => a.id);
    const intervention = interventionForStrategy(label);
    const state = structuredClone(fresh.trials[0].lastCommittedState);
    const asV10 = structuredClone(state); asV10.agreeNameScopeVersion = 'scoped_v5'; // the naming scope of a v8-v10 state (v11 has scoped_v6)
    assert.ok(validateJevPrivateStateV2(structuredClone(asV10), ids, intervention, 'two_stage_v3', 'holistic_v5', v10 as any));
    assert.ok(validateJevPrivateStateV2(structuredClone(asV10), ids, intervention, 'two_stage_v3', 'holistic_v5', v9 as any));
    assert.throws(() => validateJevPrivateStateV2(structuredClone(asV10), ids, intervention, 'two_stage_v3', 'holistic_v5', v8 as any), { code: 'invalid_state' });
    // A genuine v8 record never holds it; writing it into one is caught by the single-record verifier.
    const old = await buildRecords({ label, dialoguePolicy: 'holistic_v5', generationRetryVersion: v8 as any, technicalTrial: { version: 'adaptive_repair_v3' }, turns: [askTurn, { human: '輪の話ですね。', plan: { action: 'accept', target: 'figure_0', referent: 'figure_0', speech: 'はい。' } }] });
    assert.notEqual(claimOf(old).source, 'ai_bound_target');
    assert.deepEqual(statuses(old), ['pass', 'pass', 'pass', 'pass']);
    const forged = structuredClone(old);
    const walk = (o: any, f: (x: any) => void) => { if (o && typeof o === 'object') { f(o); for (const v of Object.values(o)) walk(v, f); } };
    let forgedClaims = 0;
    walk(forged, x => { if (x?.kind === 'claim' && x.speaker === 'ai' && x.act === 'ask' && x.source === 'ai_hypothesis') { x.source = 'ai_bound_target'; forgedClaims++; } });
    assert.ok(forgedClaims > 0);
    assert.ok(statuses(forged).includes('mismatch'), 'S4 refuses a v8 record that holds ai_bound_target: ' + statuses(forged));
    assert.throws(() => validateJevPrivateStateV2(structuredClone(forged.trials[0].lastCommittedState), ids, intervention, 'two_stage_v3', 'holistic_v5', v8 as any), { code: 'invalid_state' });
    assert.deepEqual(statuses(fresh), ['pass', 'pass', 'pass', 'pass']);
  });
}
