// D 監査（AquaGauss）: 回転別メモの pin の追加で、旧受付（承認済みの記録・計画）が基点 75c66cc とバイト同一であること（統括 D-C1: 旧 pin の受付の計画・記録が main と同一）。
// 期待値は基点から一度だけ生成した固定の fixture（作り直さない）。他の木の検査は AUDIT_REPO_ROOT=<worktree>（読み取りだけ）。
// 許す差は1つだけ: 新規受付（production の参加者設定で、#262 の preparedObservations を持たない）の plan に、3キーだけの `rotationMemory` の pin が付くこと。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';
import { approveAll, buildAuditCases } from './support/rotation-memory-audit-plans.ts';

const expected = JSON.parse(readFileSync(new URL('./fixtures/rotation-memory-audit/approved-receptions-75c66cc.json', import.meta.url), 'utf8')) as
  { baseCommit: string; receptions: Record<string, string> };
const root = auditRoot();

test('期待値は基点 75c66cc から作られ、v1/v2/v3 × 回転方式 × 図形構成 × 参加者の設定 × 受付の順を覆う', async () => {
  assert.equal(expected.baseCommit, '75c66cc');
  const cases = await buildAuditCases(root);
  assert.deepEqual(Object.keys(expected.receptions), cases.map(c => c.id));
  const accepted = Object.values(expected.receptions).filter(v => !v.startsWith('error:'));
  assert.ok(accepted.length >= 30);
  assert.ok(accepted.some(v => v.includes('"preparedObservations"')), '#262 の準備済みを持つ旧受付を含む');
  for (const mode of ['relative_pm90', 'relative_0', 'relative_90_180_270']) assert.ok(accepted.some(v => v.includes(mode)), mode);
});

test('保存済みの旧受付は、新しいコードで検証しても同じバイトのまま（旧記録が壊れない・足されない）', async () => {
  const reception: any = await import(pathToFileURL(root + 'dialogue-model/runtime/v2/reception.ts').href);
  for (const [id, text] of Object.entries(expected.receptions)) {
    if (text.startsWith('error:')) continue;
    assert.equal(JSON.stringify(reception.validateReception(JSON.parse(text))), text, id);
    assert.equal(JSON.stringify(reception.validateReceptionPlan(JSON.parse(text).plan)), JSON.stringify(JSON.parse(text).plan), id + ' plan');
  }
});

test('同じ入力の承認は同じバイト（拒否も同じ）。差は新規受付の rotationMemory の pin（3キーだけ）に限る', async () => {
  const cases = await buildAuditCases(root), actual = await approveAll(cases, root);
  for (const c of cases) {
    const before = expected.receptions[c.id], after = actual[c.id];
    if (before === after) continue;
    const mayGainPin = c.production && !('preparedObservations' in c.participant) && !before.startsWith('error:') && !after.startsWith('error:');
    assert.ok(mayGainPin, `${c.id}: 旧受付の承認結果が変わった（${before.startsWith('error:') ? before : '承認'} → ${after.slice(0, 120)}）`);
    const plan = JSON.parse(after);
    const pin = plan.plan.rotationMemory;
    assert.deepEqual(Object.keys(pin ?? {}).sort(), ['catalogRevision', 'dataSha256', 'version'], c.id + ' pin のキー');
    delete plan.plan.rotationMemory;
    assert.equal(JSON.stringify(plan), before, `${c.id}: pin 以外の差がある`);
  }
});
