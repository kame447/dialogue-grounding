// D 監査（AquaGauss）: 回転別メモの追加で、旧 pin・旧 #262 の受付の観察キャッシュ鍵が基点 75c66cc とバイト同一であること。
// 期待値は基点から一度だけ生成した固定の fixture（作り直さない）。失敗は「ownParts などが旧受付の鍵の入力に混ざった」ことを意味する。
// 他の担当の木を検査するときは AUDIT_REPO_ROOT=<worktree> を指定する（読み取りだけ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditRoot, computeOldPathKeys, ROTATION_MODES_UNDER_AUDIT, SELECTIONS_UNDER_AUDIT, SEEDS_UNDER_AUDIT } from './support/rotation-memory-audit-keys.ts';

const expected = JSON.parse(readFileSync(new URL('./fixtures/rotation-memory-audit/old-path-keys-75c66cc.json', import.meta.url), 'utf8')) as
  { baseCommit: string; keys: Record<string, Record<string, unknown>> };

test('期待値は基点 75c66cc から作られ、3 回転方式 × 3 図形構成 × 4 seed を覆う', () => {
  assert.equal(expected.baseCommit, '75c66cc');
  const ids = Object.keys(expected.keys);
  assert.equal(ids.length, ROTATION_MODES_UNDER_AUDIT.length * Object.keys(SELECTIONS_UNDER_AUDIT).length * SEEDS_UNDER_AUDIT.length);
  for (const id of ids) assert.deepEqual(Object.keys(expected.keys[id]), ['workerKeyV2', 'workerKeyV1', 'workerKeyNone', 'localKey'], id);
});

test('旧受付の観察キャッシュ鍵（Worker 3 種・ローカル）は基点のバイトのまま', async () => {
  const actual = await computeOldPathKeys(auditRoot());
  assert.deepEqual(Object.keys(actual), Object.keys(expected.keys));
  for (const [id, keys] of Object.entries(expected.keys)) assert.deepEqual(actual[id], keys, id);
});
