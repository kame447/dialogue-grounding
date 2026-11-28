// #268 through the real Worker → participant DO → AdminIndex (support/admin-worker-harness.ts): a four-figure current setting cannot approve
// a new reception, choosing three figures restores approval with every other field kept, and receptions approved earlier are untouched.
// Synthetic values only; the model is never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedValues, submittedFrom } from './support/settings-form.ts';
import { approvalFormOf, approved, approveWith, harness, reception, relativeTurns, savePreviousProtocol, start, waitingBrowser } from './support/admin-worker-harness.ts';
import type { H } from './support/admin-worker-harness.ts';

const FOUR = { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4'] };
const SETTINGS = '/admin/reception-settings';
const displayed = async (h: H) => { const { protocol } = await h.index.readReceptionSettings(); return { protocolId: protocol.protocol.protocolId, revision: protocol.revision, sha256: protocol.sha256 }; };
/** The approval form an open tab (or a crafted request) can still send: it carries the setting's own displayed identity. */
const craftedApproval = async (h: H, cookie: string) => {
  const shown = await displayed(h), { revision, number } = reception(h, cookie);
  return new URLSearchParams({ expectedRevision: String(revision), confirm: number, order: '0', protocolId: shown.protocolId, protocolRevision: String(shown.revision), protocolSha256: shown.sha256 });
};
/** Choose a three-figure preset on the settings page; everything else is what the page shows from the saved setting. */
async function chooseThreeFigures(h: H, presetValue: string) {
  const form = submittedFrom(await (await h.admin(SETTINGS)).text());
  form.set('figureMode', 'preset'); form.set('figureSetId', presetValue);
  assert.equal((await h.admin(SETTINGS + '/protocol', form)).status, 303);
}

test('a four-figure setting cannot approve a new reception; choosing three figures keeps every other field, restores approval and starts a three-figure trial', async () => {
  const h = harness();
  await savePreviousProtocol(h, { figureSelection: FOUR });
  await h.restartAsCurrent();
  const cookie = await waitingBrowser(h);
  const legacy = (await h.index.readReceptionSettings()).protocol;
  assert.equal(legacy.protocol.figureSelection.figureIds.length, 4);

  // The list gives no way to approve, and a form from an open tab or a crafted request is refused by the server before the owner is called.
  const list = await (await h.admin('/admin/receptions')).text();
  assert.doesNotMatch(list, /\/approve"/u); assert.match(list, /現在の設定は3図形ではないため、許可できません/u);
  const settled = h.snapshot(cookie);
  const refused = await approveWith(h, cookie, await craftedApproval(h, cookie));
  assert.equal(refused.status, 409); assert.deepEqual(await refused.json(), { error: 'protocol_legacy_figures' });
  assert.deepEqual(h.snapshot(cookie), settled, 'the reception is untouched');
  assert.equal(reception(h, cookie).plan, null); assert.equal(h.inputs.length, 0);

  // The settings page says so, preselects no figure source, and offers only three-figure choices.
  const page = await (await h.admin(SETTINGS)).text();
  assert.match(page, /現在の設定は4図形のため、新しい受付を許可できません。図形セットで3図形を選んで保存してください。/u);
  assert.deepEqual(checkedValues(page, 'figureMode'), []); assert.deepEqual(checkedValues(page, 'figureIds'), []);
  assert.doesNotMatch(page, /<option value="[46]"/u);

  await chooseThreeFigures(h, 'trio-02-v1:1');
  const migrated = (await h.index.readReceptionSettings()).protocol;
  assert.equal(migrated.revision, legacy.revision + 1);
  assert.deepEqual(migrated.protocol.figureSelection, { mode: 'custom', figureIds: ['F4', 'F5', 'F6'] });
  const { figureSelection: _now, revision: _a, ...kept } = migrated.protocol, { figureSelection: _was, revision: _b, ...before } = legacy.protocol;
  assert.deepEqual(kept, before, 'orders, policies, rotation and the rest are unchanged');
  assert.doesNotMatch(await (await h.admin(SETTINGS)).text(), /新しい受付を許可できません/u);

  await approved(h, cookie, await approvalFormOf(h, cookie));
  const plan = reception(h, cookie).plan;
  assert.deepEqual(plan.trials.map((trial: any) => trial.figureSelection.figureIds), [['F4', 'F5', 'F6'], ['F4', 'F5', 'F6']]);
  assert.equal(plan.protocolRevision, migrated.revision);
  assert.equal((await start(h, cookie)).status, 200);
  const input = h.inputs.find(i => !i.restore);
  assert.deepEqual(input.figureSelection.figureIds, ['F4', 'F5', 'F6']);
  assert.ok(relativeTurns(input).every(turn => [90, 180, 270].includes(turn)));
  await h.done();
});

test('a reception approved from a four-figure setting before this release keeps its plan, its figures and its restore, whatever the setting becomes', async () => {
  const h = harness();
  await savePreviousProtocol(h, { figureSelection: FOUR });
  const cookie = await waitingBrowser(h);
  // The earlier release approved it (a direct call to the owner stands in for that release's approval).
  await h.object(cookie).adminApproveReception({ expectedRevision: 0, order: 0, protocol: await displayed(h) });
  const frozen = structuredClone(reception(h, cookie).plan);
  assert.deepEqual(frozen.trials.map((trial: any) => trial.figureSelection.figureIds.length), [4, 4]);

  await h.restartAsCurrent();
  await chooseThreeFigures(h, 'trio-01-v1:1');
  assert.deepEqual(reception(h, cookie).plan, frozen, 'the frozen plan does not move with the setting');
  const list = await (await h.admin('/admin/receptions')).text();
  assert.match(list, /許可済み/u); assert.match(list, new RegExp(`action="/admin/reception/${reception(h, cookie).receptionId}/cancel"`, 'u'));

  const started = await start(h, cookie);
  assert.equal(started.status, 200);
  const recordId: string = (await started.json()).trial.sessionId;
  const input = h.inputs.find(i => !i.restore);
  assert.deepEqual(input.figureSelection.figureIds, frozen.trials[0].figureSelection.figureIds);
  assert.equal(input.rotationMode, 'relative_pm90', 'the plan was frozen before the rotation switch');
  h.evict(); h.inputs.length = 0;
  assert.equal((await (await h.get('/api/state', cookie)).json()).trial.sessionId, recordId);
  assert.equal(h.inputs.find(i => i.restore).restore.options.figureSelection.figureIds.length, 4);
  await h.done();
});
