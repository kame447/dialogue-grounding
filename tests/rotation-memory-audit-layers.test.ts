// D 監査（AquaGauss）: 呼び出しごとの層（nouns・roles・full）が、どの層でも全方向の候補（名詞）・確信度の印・領域IDを落とさず、層ごとに足す分（役割・姿勢・向き）だけが違うこと。
// 120の現在方向 × 3層 = 360 通りを、B1 の投影から独立に検査する（期待値は投影の値そのもの。層の変換は C の rotationMemoryLayer）。
// 層の字数の上限も固定する（2026-11-28 19:15 の 174be43 の実測に余白を足した値。上がるときは理由を添えて統括へ）。
// 木: AUDIT_REPO_ROOT。B1 の rotation-memory.ts か C の guidance が無い木では skip（統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';

const root = auditRoot();
const memoryFile = root + 'dialogue-model/runtime/stimuli/rotation-memory.ts', guidanceFile = root + 'dialogue-model/runtime/decision/rotation-memory-guidance.ts';
const skip = !(existsSync(memoryFile) && existsSync(guidanceFile)) && process.env.AUDIT_REQUIRE_ROTATION_MEMORY !== '1' ? 'B1 の rotation-memory.ts か C の rotation-memory-guidance.ts が無い木' : false;
const FIGURES = Array.from({ length: 30 }, (_, i) => 'F' + (i + 1));
const marked = (c: { noun: string; confidence?: string }) => c.confidence === undefined ? c.noun : `${c.noun}（${c.confidence}）`;

test('どの層も、全方向の全体の名詞・部分の名詞・確信度の印・領域ID・wholeAnywhere・回した向きの順を落とさない。役割・姿勢・向きは層が足す分だけ', { skip }, async () => {
  const memory: any = await import(pathToFileURL(memoryFile).href), guide: any = await import(pathToFileURL(guidanceFile).href);
  let combinations = 0;
  for (const figureKey of FIGURES) for (const rotation of [0, 90, 180, 270]) {
    const projection = memory.projectOwnRotationMemory({ figureKey, rotation });
    for (const layer of ['nouns', 'roles', 'full'] as const) {
      const label = `${figureKey}@${rotation} ${layer}`, layered = guide.rotationMemoryLayer(projection, layer);
      assert.equal(layered.wholeAnywhere, projection.wholeAnywhere, label);
      assert.deepEqual(layered.turned.map((t: any) => t.rel), [90, 180, 270], label);
      assert.equal(layered.regions.length, projection.regions.length, label + ' 領域の数');
      projection.regions.forEach((region: any, i: number) => assert.ok(layered.regions[i].startsWith(region.id + ' '), `${label}: 領域ID ${region.id}`));
      const views = [{ source: projection.current, layered: layered.current, name: '現在' },
        ...projection.turned.map((t: any, i: number) => ({ source: t, layered: layered.turned[i], name: '相対' + t.rel }))];
      for (const { source, layered: out, name } of views) {
        const text = layer === 'nouns' ? String(layer === 'nouns' && typeof out === 'string' ? out : out.view) : [...out.whole, out.parts].join(' | ');
        for (const candidate of source.whole) {
          assert.ok(text.includes(marked(candidate)), `${label} ${name}: 全体の名詞（印つき）「${marked(candidate)}」`);
          if (candidate.confidence === undefined) assert.ok(!text.includes(`${candidate.noun}（低）`), `${label} ${name}: 低は印を付けない`);
          if (layer !== 'nouns') for (const [id, role] of Object.entries(candidate.roles)) assert.ok(text.includes(`${id} ${role}`), `${label} ${name}: 役割 ${id} ${role}`);
          if (layer === 'full') assert.ok(text.includes(`（${candidate.posture}／${candidate.direction}）`), `${label} ${name}: 姿勢・向き`);
          if (layer !== 'full') assert.ok(!text.includes(candidate.posture) || candidate.posture.length < 3, `${label} ${name}: 姿勢は full だけ`);
        }
        for (const [id, list] of Object.entries<any[]>(source.parts)) assert.ok(text.includes(`${id} ${list.map(marked).join('・')}`), `${label} ${name}: 部分 ${id}`);
        if (source.whole.length === 0 && layer === 'nouns') assert.ok(text.startsWith('全体: なし'), `${label} ${name}: 全体の見立てなし`);
        if (source.whole.length === 0 && layer !== 'nouns') assert.deepEqual(out.whole, [], `${label} ${name}: 全体の見立てなし`);
      }
      combinations++;
    }
  }
  assert.equal(combinations, 360);
});

test('層の字数の上限（最悪の組の合計、3/4/6図形）。上がるときは理由を添えて統括へ', { skip }, async () => {
  const memory: any = await import(pathToFileURL(memoryFile).href), guide: any = await import(pathToFileURL(guidanceFile).href);
  // 174be43 の実測: nouns 1,112/1,464/2,157、roles 2,096/2,746/4,021、full 2,459/3,219/4,713（図形ごとに最も大きい向き）。上限は実測の約 +10%。
  const limits: Record<string, [number, number, number]> = { nouns: [1250, 1650, 2450], roles: [2350, 3050, 4450], full: [2750, 3600, 5200] };
  for (const [layer, [three, four, six]] of Object.entries(limits)) {
    const sizes = FIGURES.map(figureKey => Math.max(...[0, 90, 180, 270].map(rotation => JSON.stringify(guide.rotationMemoryLayer(memory.projectOwnRotationMemory({ figureKey, rotation }), layer)).length))).sort((a, b) => b - a);
    const sum = (n: number) => sizes.slice(0, n).reduce((total, size) => total + size, 0);
    assert.ok(sum(3) <= three, `${layer} 3図形の最悪 ${sum(3)} > ${three}`);
    assert.ok(sum(4) <= four, `${layer} 4図形の最悪 ${sum(4)} > ${four}`);
    assert.ok(sum(6) <= six, `${layer} 6図形の最悪 ${sum(6)} > ${six}`);
  }
});
