// D 監査（AquaGauss）: postGenerationCheck 'on' の観察の出所（QuietHubble の指摘1）の独立試験。
// モデルに見せる層（生成＝roles、独立の抽出＝nouns）の文字列の path を、そのまま出所として引用できること（検査が受け付けること）、
// 生成が宣言する path と抽出が返す path が同じ向きの単位なら一致し、別の向きなら一致しないこと。120の現在方向 × 全ての文字列の葉で見る。
// （層ごとに文字列の粒度が違う: roles は「見立て: P1 役割 / …」の行、nouns は向きの1行。どちらを引用しても同じ向きの単位として扱われること。）
// 木: AUDIT_REPO_ROOT。コードが無い木では skip（統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';

const root = auditRoot();
const files = ['dialogue-model/runtime/stimuli/rotation-memory.ts', 'dialogue-model/runtime/decision/rotation-memory-guidance.ts', 'dialogue-model/runtime/v2/visual-feature-evidence.ts'];
const missing = files.filter(file => !existsSync(root + file));
const skip = missing.length > 0 && process.env.AUDIT_REQUIRE_ROTATION_MEMORY !== '1' ? '次のファイルが無い木: ' + missing.join(', ') : false;
const load = (path: string): Promise<any> => import(pathToFileURL(root + path).href);
const FIGURES = Array.from({ length: 30 }, (_, i) => 'F' + (i + 1));
type Path = (string | number)[];

/** 層の中の文字列の葉の path（モデルが見る文字列そのもの）。数値・真偽値（rel・wholeAnywhere）は引用できる文字列ではないので除く。 */
function stringLeaves(value: unknown, prefix: Path = []): { path: Path; text: string }[] {
  if (typeof value === 'string') return [{ path: prefix, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => stringLeaves(item, [...prefix, i]));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, [...prefix, key]));
  return [];
}
/** 向きの単位: current か turned[i]、領域の行は regions[i]（層に依らない）。 */
const unitOf = (path: Path): string => path[0] === 'regions' ? `regions/${path[1]}` : path[0] === 'turned' ? `turned/${path[1]}` : String(path[0]);

test('必須指定のとき、B1・C・B2 のファイルがそろっている', { skip: process.env.AUDIT_REQUIRE_ROTATION_MEMORY === '1' ? false : '統合ブランチだけ' }, () => assert.deepEqual(missing, []));

test('モデルに見せる層（roles・nouns）の文字列の path は、出所として引用できる（120の現在方向）', { skip }, async () => {
  const memory = await load(files[0]), guide = await load(files[1]), evidence = await load(files[2]);
  let accepted = 0;
  for (const figureKey of FIGURES) for (const rotation of [0, 90, 180, 270]) {
    const projection = memory.projectOwnRotationMemory({ figureKey, rotation });
    const figureId = 's-0000', memo = { observedAt: '2026-01-01T00:00:00.000Z', figures: [{ id: figureId, region: { x: 0, y: 0, w: 1, h: 1 }, holistic: [],
      analytic: { shapes: [], composition: 'x', relations: [] }, unknowns: [], reobservations: [], rotation: projection }] };
    for (const layer of ['roles', 'nouns'] as const) for (const { path, text } of stringLeaves(guide.rotationMemoryLayer(projection, layer))) {
      const sources = evidence.readVisualFeatureSources([{ figureId, path: ['rotation', ...path] }], memo, [figureId]);
      assert.ok(sources !== null, `${figureKey}@${rotation} ${layer}: 見せている path ${JSON.stringify(['rotation', ...path])}（「${text.slice(0, 24)}…」）が出所として拒否される`);
      accepted++;
    }
  }
  assert.ok(accepted > 1500, '検査した path の数 ' + accepted);
});

test('生成の宣言（roles）と独立の抽出（nouns）が同じ向きの単位を指せば一致し、別の単位なら一致しない（実際の読み取りの経路: 宣言＝readVisualFeatureSources、抽出＝readVisualFeatureEvidence）', { skip }, async () => {
  const memory = await load(files[0]), guide = await load(files[1]), evidence = await load(files[2]);
  let compared = 0;
  for (const figureKey of FIGURES) for (const rotation of [0, 90, 180, 270]) {
    const projection = memory.projectOwnRotationMemory({ figureKey, rotation }), figureId = 's-0000';
    const memo = { observedAt: '2026-01-01T00:00:00.000Z', figures: [{ id: figureId, region: { x: 0, y: 0, w: 1, h: 1 }, holistic: [],
      analytic: { shapes: [], composition: 'x', relations: [] }, unknowns: [], reobservations: [], rotation: projection }] };
    const byUnit = (layer: 'roles' | 'nouns') => {
      const units = new Map<string, Path[]>();
      for (const { path } of stringLeaves(guide.rotationMemoryLayer(projection, layer))) units.set(unitOf(path), [...(units.get(unitOf(path)) ?? []), path]);
      return units;
    };
    const generated = byUnit('roles'), extracted = byUnit('nouns');
    for (const [unit, paths] of generated) for (const pathG of paths) {
      const declared = evidence.readVisualFeatureSources([{ figureId, path: ['rotation', ...pathG] }], memo, [figureId]);
      assert.ok(declared, `${figureKey}@${rotation}: 生成の path ${JSON.stringify(pathG)} が読めない`);
      for (const [otherUnit, others] of extracted) for (const pathE of others) {
        const verified = evidence.readVisualFeatureEvidence({ sources: [{ source: { figureId, path: ['rotation', ...pathE] }, quote: 'q' }] }, memo, [figureId], 'q');
        assert.ok(verified, `${figureKey}@${rotation}: 抽出の path ${JSON.stringify(pathE)} が読めない`);
        const same = evidence.sameVisualFeatureSources(declared, verified);
        assert.equal(same, unit === otherUnit, `${figureKey}@${rotation}: 生成 ${JSON.stringify(pathG)} と抽出 ${JSON.stringify(pathE)} は${unit === otherUnit ? '同じ' : '別の'}単位（${unit} / ${otherUnit}）なのに ${same ? '一致' : '不一致'}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 5000, '比べた組の数 ' + compared);
});
