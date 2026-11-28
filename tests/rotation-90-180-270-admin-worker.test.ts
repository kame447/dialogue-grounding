// #269 管理画面: 既定が保存・承認・開始まで効くこと、移行の後の承認、承認済みの受付と開始済みの試行の不変。
// 実際の Worker → 受付の DO → AdminIndex を通す（support/admin-worker-harness.ts）。モデルは呼ばない。合成の値で研究条件を決めない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedValues, submittedFrom } from './support/settings-form.ts';
import { approvalFormOf, approved, approveWith, harness, reception, relativeTurns, savePreviousProtocol, start, waitingBrowser } from './support/admin-worker-harness.ts';

const NEW = 'relative_90_180_270';

test('the default is effective end to end: the page\'s preselected rotation is saved, approved and started, and the AI side turns 90, 180 or 270 degrees', async () => {
  const h = harness(); await h.restartAsCurrent();
  const page = await (await h.admin('/admin/reception-settings')).text();
  const chosen = checkedValues(page, 'rotationMode');
  assert.equal(chosen.length, 1, 'one rotation is preselected on the first visit');
  const form = submittedFrom(page);
  for (const [name, value] of [['orders', 'rf-be'], ['seedPolicy', 'shared'], ['referenceMemory', 'off'], ['betweenTrials', 'none'], ['receptionNumberFormat', 'daily_seq3'],
    ['figureMode', 'seeded_random'], ['figureSetPolicy', 'shared']]) form.set(name, value);
  assert.equal((await h.admin('/admin/reception-settings/protocol', form)).status, 303);

  const cookie = await waitingBrowser(h);
  await approved(h, cookie, await approvalFormOf(h, cookie));
  assert.deepEqual(reception(h, cookie).plan.trials.map((t: any) => t.rotationMode), [chosen[0], chosen[0]]);
  assert.equal((await start(h, cookie)).status, 200);
  const input = h.inputs.find(i => !i.restore);
  assert.equal(input.rotationMode, chosen[0]);
  const turns = relativeTurns(input);
  assert.equal(turns.length, 3);
  assert.ok(turns.every(turn => [90, 180, 270].includes(turn)), JSON.stringify(turns));
  await h.done();
});

test('after the startup switch a new approval carries the new revision and mode, and an approved reception keeps its frozen plan and started trial', async () => {
  const h = harness();
  await savePreviousProtocol(h);
  const a = await waitingBrowser(h), b = await waitingBrowser(h);
  const staleForB = await approvalFormOf(h, b);
  assert.equal(staleForB.get('protocolRevision'), '1');
  await approved(h, a, await approvalFormOf(h, a));
  const startedA = await start(h, a);
  assert.equal(startedA.status, 200);
  const recordA: string = (await startedA.json()).trial.sessionId;
  const settledA = h.snapshot(a);
  const oldSha = (await h.index.readReceptionSettings()).protocol.sha256;

  await h.restartAsCurrent();
  const saved = (await h.index.readReceptionSettings()).protocol;
  assert.deepEqual([saved.revision, saved.protocol.rotationMode], [2, NEW]);
  assert.notEqual(saved.sha256, oldSha);
  const settings = await (await h.admin('/admin/reception-settings')).text();
  assert.deepEqual(checkedValues(settings, 'rotationMode'), [NEW]);
  assert.ok(settings.includes('revision 2') && settings.includes(oldSha) && settings.includes(saved.sha256), 'the history keeps the old revision and its sha256');
  assert.doesNotMatch(settings, /設定が変わりました/u);

  // The approved reception and its started trial are untouched, and the trial still restores with the mode it was made with.
  assert.deepEqual(h.snapshot(a), settledA);
  assert.deepEqual([reception(h, a).plan.protocolRevision, reception(h, a).plan.trials.map((t: any) => t.rotationMode)], [1, ['relative_pm90', 'relative_pm90']]);
  h.evict(); h.inputs.length = 0;
  assert.equal((await (await h.get('/api/state', a)).json()).trial.sessionId, recordA);
  assert.equal(h.inputs.find(i => i.restore).restore.options.rotationMode, 'relative_pm90');

  // The form shown before the switch is refused; the form shown after it passes against the new revision.
  const refused = await approveWith(h, b, staleForB);
  assert.equal(refused.status, 409); assert.equal((await refused.json()).error, 'protocol_changed');
  assert.equal(reception(h, b).status, 'pending');
  const fresh = await approvalFormOf(h, b);
  assert.deepEqual([fresh.get('protocolRevision'), fresh.get('protocolSha256')], ['2', saved.sha256]);
  await approved(h, b, fresh);
  assert.deepEqual([reception(h, b).plan.protocolRevision, reception(h, b).plan.protocolSha256], [2, saved.sha256]);
  assert.deepEqual(reception(h, b).plan.trials.map((t: any) => t.rotationMode), [NEW, NEW]);

  h.inputs.length = 0;
  assert.equal((await start(h, b)).status, 200);
  const input = h.inputs.find(i => !i.restore);
  assert.equal(input.rotationMode, NEW);
  assert.ok(relativeTurns(input).every(turn => [90, 180, 270].includes(turn)));

  const list = await (await h.admin('/admin/receptions')).text();
  const shown = [a, b].map(cookie => list.match(new RegExp(`data-id="${reception(h, cookie).receptionId}"[\\s\\S]*?data-label="回転">([^<]*)</td>`, 'u'))?.[1]);
  assert.deepEqual(shown, ['±90°', '90°・180°・270°']);
  await h.done();
});
