// D 監査（AquaGauss）: 新 pin の初回メモとそのモデル向けの層に、4e09b62 の旧テンプレートの見立て（initial.holistic・construal.candidates）が入らないこと（統括の必須要件 mail 23465）。
// 実データで試す方向: F6@0（最終合議は全体の見立てなし。旧テンプレートには全体候補がある）と F15@270#P3（部分は未合意。旧テンプレートの「翼や尖った突起」）。
// 自側に F6@0 と F15@270 を持つ試行を作り、B2 の実際の開始時の経路（projectOwnFigures → rotationInitialMemo）でメモを組み、C の各層（nouns・roles・full）まで見る。
// 「旧テンプレートにだけある文字列」を禁止語とし（最終データに出る語は禁止しない。F15@0#P2・P3 と F15@90#P3 の最終採用の「翼」は正当）、現方向の F15 の P3 に「翼」が出ないことも見る。
// 木: AUDIT_REPO_ROOT。B2 の rotation-memo.ts か C の guidance か旧テンプレートが無い木では skip（統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';

const root = auditRoot();
const files = ['dialogue-model/runtime/observation/rotation-memo.ts', 'workers/tangram-experiment/src/rotation-memory-source.ts', 'dialogue-model/runtime/decision/rotation-memory-guidance.ts',
  'dialogue-model/runtime/stimuli/primary-regions-data.ts', 'dialogue-model/runtime/stimuli/rotation-memory.ts'];
const missing = files.filter(file => !existsSync(root + file));
const skip = missing.length > 0 && process.env.AUDIT_REQUIRE_ROTATION_MEMORY !== '1' ? '次のファイルが無い木: ' + missing.join(', ') : false;
const load = (path: string): Promise<any> => import(pathToFileURL(root + path).href);

test('必須指定のとき、B2・C・B1 のファイルと旧テンプレートがそろっている', { skip: process.env.AUDIT_REQUIRE_ROTATION_MEMORY === '1' ? false : '統合ブランチだけ' }, () => assert.deepEqual(missing, []));

test('新 pin の初回メモと各層に、旧テンプレートにだけある見立てが無い（F6@0・F15@270#P3）', { skip }, async () => {
  const scatter = await load('dialogue-model/runtime/stimuli/scatter-v2.mjs'), source = await load('workers/tangram-experiment/src/rotation-memory-source.ts');
  const memoModule = await load('dialogue-model/runtime/observation/rotation-memo.ts'), guide = await load('dialogue-model/runtime/decision/rotation-memory-guidance.ts');
  const old = await load('dialogue-model/runtime/stimuli/primary-regions-data.ts'), memory = await load('dialogue-model/runtime/stimuli/rotation-memory.ts');
  const figureSelection = { mode: 'custom', figureIds: ['F6', 'F15', 'F1'] };
  // 自側に F6@0 と F15@270 が提示される試行を探す。
  let trial: any, model: any;
  search: for (const rotationMode of ['relative_90_180_270', 'relative_pm90', 'relative_0']) for (let seed = 0; seed < 4000; seed++) {
    const ai = scatter.createLayoutsV2({ seed, rotationMode, figureSelection }).ai as any[];
    if (ai.find(p => p.figureId === 'F6')?.rotation === 0 && ai.find(p => p.figureId === 'F15')?.rotation === 270) {
      trial = scatter.createTrialV2({ seed, rotationMode, figureSelection }); model = scatter.modelView(trial); break search;
    }
  }
  assert.ok(trial, '自側に F6@0 と F15@270 を持つ試行が見つからない');
  const projections: Map<string, any> = source.projectOwnFigures(trial, model.anchors, source.rotationMemorySource());
  assert.equal(projections.size, 3, '3図形すべてが投影される');
  const memo = memoModule.rotationInitialMemo(model.anchors, projections, '2026-01-01T00:00:00.000Z');
  for (const figure of memo.figures) { assert.deepEqual(figure.holistic, []); assert.deepEqual(figure.analytic.shapes, []); assert.ok(figure.rotation); }

  // 禁止語 = 旧テンプレート（その図形の4方向）の見立ての文字列のうち、最終データ（その図形の4方向の投影）に一度も出ないもの。
  const allowed = (figureKey: string) => JSON.stringify([0, 90, 180, 270].map(rotation => memory.projectOwnRotationMemory({ figureKey, rotation })));
  const oldConstruals = (figureKey: string, rotation: number): string[] => {
    const template = old.PRIMARY_REGION_TEMPLATES.find((t: any) => t.figureId === figureKey && t.rotation === rotation);
    return [...template.initial.holistic.map((h: any) => h.construal), ...template.regions.flatMap((r: any) => [...r.construal.candidates, ...(r.construal.canonicalCandidates ?? [])])];
  };
  const forbidden = [['F6', 0], ['F15', 270]].flatMap(([figureKey, rotation]) => oldConstruals(figureKey as string, rotation as number).filter(s => !allowed(figureKey as string).includes(s)));
  assert.ok(forbidden.length > 0, '旧テンプレートにだけある見立てがある（試験が空でない）');
  assert.ok(oldConstruals('F15', 270).some(s => s.includes('翼や尖った突起')), '旧テンプレートの F15@270 に「翼や尖った突起」がある');
  assert.ok(forbidden.some(s => s.includes('翼や尖った突起')), '「翼や尖った突起」は最終データに出ない（禁止語）');

  const surfaces: string[] = [JSON.stringify(memo)];
  for (const layer of ['nouns', 'roles', 'full']) surfaces.push(JSON.stringify({ ...guide.rotationLegendEntry(memo, layer), memo: guide.withRotationLayer(memo, layer) }));
  for (const surface of surfaces) for (const word of forbidden) assert.ok(!surface.includes(word), `旧テンプレートの見立て「${word.slice(0, 40)}」がモデル向けのメモに入っている`);

  // 現方向の F15@270 の P3 には候補が出ない（部分は未合意）。F6@0 の現方向は全体も部分も無い。
  const f15 = memo.figures.find((figure: any) => figure.id === model.anchors.find((a: any) => (trial.key.ai as Record<string, string>)[a.id] === 'F15').id);
  const f6 = memo.figures.find((figure: any) => figure.id === model.anchors.find((a: any) => (trial.key.ai as Record<string, string>)[a.id] === 'F6').id);
  assert.equal(f15.rotation.current.parts.P3, undefined);
  assert.deepEqual(f6.rotation.current, { whole: [], parts: {} });
});
