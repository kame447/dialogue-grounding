// Synthetic wording only (no recorded text). jev_generation_retry_v9 widens which wordings the orientation check accepts as a stated viewpoint
// ("こちらの画面で", "こちらの上の…") and as the partner's own words ("そちらでいう…"); everything else is judged as in v8.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { findOrientationLeaks, validAgreeNameScope } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { buildRecords } from './support/s4-v3-records.ts';
import type { Turn } from './support/s4-v3-records.ts';

const v8 = 'jev_generation_retry_v8', v9 = 'jev_generation_retry_v9';
const leaks = (text: string, version: string) => findOrientationLeaks(text, 'holistic_v5', version as any);

// Accepted from v9, still a violation in v8.
const acceptedInV9: [string, string[]][] = [
  ['こちらの画面で上部にある突起は、そちらでは左向きの先に当たる形ですか？', ['orientation_leak']],
  ['こちらの上の三角の突起が、そちらでは右向きの先に当たる形ですか？', ['orientation_leak']],
  ['こちらの図形で右端に丸い穴があって、つながり方は同じですか？', ['orientation_leak']],
  ['こちらの画面では輪が見えるので、そちらでいう右端の部分に対応する可能性はありそう。', ['shared_view_assumption']],
  ['こちらの画面では三角形状の突起が見えるので、そちらでいう左向きの先に対応する可能性はありそう。', ['shared_view_assumption']],
];
// The same violation in both versions: no viewpoint, an unmarked partner side, an assertion about the partner's view, and the forms v9 leaves alone.
const stillRejected: [string, string[]][] = [
  ['上の突起がとがっていますね。', ['orientation_leak']],
  ['右上に丸い穴がありますね。', ['orientation_leak']],
  ['そちらの上の突起がとがっていますね。', ['orientation_leak']],
  ['そちらでは上の突起がとがっていますね。', ['shared_view_assumption']],
  ['そちらの右向きの先端が、この突起に対応しますか？', ['orientation_leak']],
  ['こちらの三角の突起がそちらの左向きの先にあたりそうだね。', ['orientation_leak']],
  ['こちらの画面で上に見える三角の突起が、そちらでは左向きのとがった先にあたりそうなんですね。', ['shared_view_assumption']],
  // Audit 21n: the partner's own words do not excuse a comparison of the two screens, and a negated "こちらの画面で" states no viewpoint.
  ['そちらでいう左向きの先は、こちらと同じ向きですね。', ['shared_view_assumption']],
  ['こちらの画面でなく、上端に穴があります。', ['orientation_leak']],
  // Audit 22: "そちらでいうと…" opens a topic or condition; it does not quote the partner, so a direction asserted after it is an assertion about the partner's view.
  ['そちらでは、輪の先は右向きですね。', ['shared_view_assumption']],
  ['そちらでいうと、輪の先は右向きですね。', ['shared_view_assumption']],
  ['そちらでいえば、輪の先は右向きですね。', ['shared_view_assumption']],
  ['そちらでいうなら、輪の先は右向きですね。', ['orientation_leak']],
  ['こちらの画面でないところの上端に穴があります。', ['orientation_leak']],
];
// Clean in both versions.
const cleanInBoth = ['そちらでいう左向きの先端を含む形も、この輪郭のつながり方に対応していますか？', 'そちらでいう左向きの先は、こちらの三角の突起に対応しますか？', 'そちらでいう下向きの先は、この突起に対応していますか？', '二つの部分がつながった形ですか？', 'こちらの画面では上部に丸い穴があります。'];

test('v9 accepts the wider stated-viewpoint and quoted wordings; v8 rejects them as before', () => {
  for (const [text, before] of acceptedInV9) { assert.deepEqual(leaks(text, v8), before, 'v8: ' + text); assert.deepEqual(leaks(text, v9), [], 'v9: ' + text); }
});
test('v9 still rejects an unmarked direction, the partner side without a stated view and an assertion about the partner view, exactly as v8 does', () => {
  for (const [text, codes] of stillRejected) { assert.deepEqual(leaks(text, v8), codes, 'v8: ' + text); assert.deepEqual(leaks(text, v9), codes, 'v9: ' + text); }
  for (const text of cleanInBoth) { assert.deepEqual(leaks(text, v8), [], 'v8: ' + text); assert.deepEqual(leaks(text, v9), [], 'v9: ' + text); }
});
// Audit 22n (NB-22N-2): the quotation excuses only the phrase quoted right after "そちらでいう"; what follows it is checked as usual.
const afterTheQuotedPhrase = [
  'そちらでいう『3』は、左上にV字状のくぼみがありますね。',
  'そちらでいう『星』は、そちらの上端に切れ目がありますよ。',
  '相手のいうことは分かりました、上の突起がとがっていますね。',
  'そちらでいう左向きの先は、こちらと同じ向きですね。',
  'そちらでいう左向きの先は、右上に丸い穴がありますね。',
  'そちらでいう左向きの先は、そちらの上の突起とつながっていますね。',
];
test('v9 rejects an unmarked direction or an assertion about the partner view that follows a quoted phrase, as v8 does', () => {
  for (const text of afterTheQuotedPhrase) { assert.notDeepEqual(leaks(text, v8), [], 'v8: ' + text); assert.notDeepEqual(leaks(text, v9), [], 'v9: ' + text); }
});
test('the v9 agreement scope is the v8 scope', () => {
  assert.equal(validAgreeNameScope('scoped_v5', v9), true);
  assert.equal(validAgreeNameScope('scoped_v4', v9), false);
  assert.equal(validAgreeNameScope('scoped_v5', v8), true);
});

const confirming = '二つの部分がつながった形ですか？';
const turns = (drafts: string[]): Turn[] => [
  { human: '尖っている部分はどこですか？', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', speech: '小さい部分のほうですか？' } },
  { human: 'こちらでは90度違って見えます。', plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', drafts } },
];
const statuses = (records: any) => verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
const build = (label: 'bypass-enabled' | 'repair-first', version: string | undefined, drafts: string[]) =>
  buildRecords({ label, dialoguePolicy: 'holistic_v5', ...(version ? { generationRetryVersion: version as any } : {}), technicalTrial: { version: 'adaptive_repair_v3' }, turns: turns(drafts) });

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  for (const [form] of acceptedInV9) {
    test(`${label}: a new v9 trial publishes "${form.slice(0, 16)}…" on the first draft, S4 and replay agree; the same input as a v8 record rewrites it`, async () => {
      const fresh = await build(label, undefined, [form, confirming]);
      const a = fresh.trials[0].attempts[0];
      assert.equal(a.generationRetryVersion, v9, 'the default of a new trial');
      assert.equal(a.publicSpeech, form);
      assert.deepEqual(a.generationGuard, { violations: [], regenerated: false, fallback: false });
      assert.deepEqual(statuses(fresh), ['pass', 'pass', 'pass', 'pass']);
      assert.equal(fresh.trials[0].replay[0].result.recordedPayloadsReproduced, true);
      const old = await build(label, v8, [form, confirming]);
      const b = old.trials[0].attempts[0];
      assert.equal(b.generationRetryVersion, v8);
      assert.equal(b.generationGuard.regenerated, true, 'a v8 record keeps the judgment it was recorded with');
      assert.equal(b.publicSpeech, confirming);
      assert.deepEqual(statuses(old), ['pass', 'pass', 'pass', 'pass']);
    });
  }
  test(`${label}: an unmarked direction and an assertion about the partner's view are still held back under v9`, async () => {
    for (const bad of ['上の突起がとがっていますね。', 'そちらでは上の突起がとがっていますね。']) {
      const held = await build(label, undefined, [bad, confirming]);
      const a = held.trials[0].attempts[0];
      assert.equal(a.generationGuard.regenerated, true, bad);
      assert.equal(a.publicSpeech, confirming);
      assert.deepEqual(statuses(held), ['pass', 'pass', 'pass', 'pass']);
    }
  });
}
