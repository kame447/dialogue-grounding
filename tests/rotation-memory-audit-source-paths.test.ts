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

/** 向きの中の候補（全体の候補 whole[k]、領域ごとの部分の候補 parts[Pn][j]）。 */
type Candidate = { kind: 'whole' | 'parts'; noun: string; stored: Path; region?: string; index: number };
function candidatesOf(view: any, head: Path): Candidate[] {
  return [...view.whole.map((w: any, k: number): Candidate => ({ kind: 'whole', noun: w.noun, stored: [...head, 'whole', k], index: k })),
    ...Object.entries<any[]>(view.parts).flatMap(([region, list]) => list.map((c, j): Candidate => ({ kind: 'parts', noun: c.noun, stored: [...head, 'parts', region, j], region, index: j })))];
}
/** 向きの行（抽出が引用できる最も粗い単位）。current は文字列の葉 ['current']、回した向きは ['turned', i, 'view']。 */
const viewLine = (head: Path): Path => head[1] === 'current' ? ['rotation', 'current'] : ['rotation', 'turned', head[2] as number, 'view'];

test('同じ向きの別の候補は一致せず、同じ候補は一致する（宣言＝readVisualFeatureSources、抽出＝readVisualFeatureEvidence。120の現在方向 × 全ての候補の組）', { skip }, async () => {
  const memory = await load(files[0]), evidence = await load(files[2]);
  let sameChecked = 0, differentChecked = 0, otherViewChecked = 0, unnamedChecked = 0;
  for (const figureKey of FIGURES) for (const rotation of [0, 90, 180, 270]) {
    const projection = memory.projectOwnRotationMemory({ figureKey, rotation }), figureId = 's-0000';
    const memo = { observedAt: '2026-01-01T00:00:00.000Z', figures: [{ id: figureId, region: { x: 0, y: 0, w: 1, h: 1 }, holistic: [],
      analytic: { shapes: [], composition: 'x', relations: [] }, unknowns: [], reobservations: [], rotation: projection }] };
    const views: { view: any; head: Path }[] = [{ view: projection.current, head: ['rotation', 'current'] }, ...projection.turned.map((v: any, i: number) => ({ view: v, head: ['rotation', 'turned', i] }))];
    const declare = (path: Path) => evidence.readVisualFeatureSources([{ figureId, path }], memo, [figureId]);
    const extract = (path: Path, text: string, quote: string) => evidence.readVisualFeatureEvidence({ sources: [{ source: { figureId, path }, quote }] }, memo, [figureId], text);
    for (const { view, head } of views) {
      const all = candidatesOf(view, head);
      // 名詞で候補を特定できるのは、同じ種類の中で名詞が一意で、他の候補の名詞に含まれない（部分文字列でない）ものだけ。
      const identifiable = all.filter(c => all.filter(o => o.kind === c.kind && o.noun === c.noun).length === 1 && !all.some(o => o !== c && (o.noun.includes(c.noun) || c.noun.includes(o.noun))));
      for (const declared of identifiable) {
        const label = `${figureKey}@${rotation} ${head.slice(1).join('/')} 宣言 ${declared.kind}[${declared.region ?? ''}${declared.index}]「${declared.noun}」`;
        // 宣言は、保存形の名詞の path でも、生成の層（roles）が見せる全体の行の path でも、同じ候補として読まれる。
        const forms: Path[] = [[...declared.stored, 'noun']];
        if (declared.kind === 'whole') forms.push(declared.stored);
        for (const form of forms) {
          const sources = declare(form);
          assert.ok(sources, `${label}: 宣言の path ${JSON.stringify(form)} が読めない`);
          // 抽出が向きの行までしか指せず、引用した名詞で候補を特定する（nouns の層）。
          const sameText = `${declared.noun}に見えます`;
          const same = extract(viewLine(head), sameText, declared.noun);
          assert.ok(same, `${label}: 抽出の読み取りが失敗`);
          assert.equal(evidence.sameVisualFeatureSources(sources, same), true, `${label}: 同じ候補（向きの行＋名詞の引用）が一致しない`);
          sameChecked++;
          // 抽出が保存形の path で同じ候補を明示しても一致する。
          const explicit = extract([...declared.stored, 'noun'], sameText, declared.noun);
          assert.ok(explicit && evidence.sameVisualFeatureSources(sources, explicit), `${label}: 同じ候補（保存形）が一致しない`);
          // 同じ向きの別の候補（名詞の引用 or 保存形の path）は一致しない。
          for (const other of identifiable.filter(o => o !== declared)) {
            const text = `${other.noun}に見えます`;
            const viaLine = extract(viewLine(head), text, other.noun), viaStored = extract([...other.stored, 'noun'], text, other.noun);
            assert.ok(!viaLine || !evidence.sameVisualFeatureSources(sources, viaLine), `${label}: 別の候補「${other.noun}」（向きの行＋引用）が一致扱い`);
            assert.ok(!viaStored || !evidence.sameVisualFeatureSources(sources, viaStored), `${label}: 別の候補「${other.noun}」（保存形）が一致扱い`);
            differentChecked++;
          }
          // 引用に候補の名詞が無い（向きの行のまま）なら、候補を特定できず一致しない（既存の ON の規則: 出所が確かめられない）。
          const unnamed = extract(viewLine(head), 'ぼんやり見えます', 'ぼんやり');
          assert.ok(!unnamed || !evidence.sameVisualFeatureSources(sources, unnamed), `${label}: 候補を名指さない引用が一致扱い`);
          unnamedChecked++;
          // 別の向きの候補は一致しない。
          for (const { view: otherView, head: otherHead } of views.filter(v => v.head.join('/') !== head.join('/'))) {
            for (const other of candidatesOf(otherView, otherHead)) {
              const viaStored = extract([...other.stored, 'noun'], `${other.noun}に見えます`, other.noun);
              assert.ok(!viaStored || !evidence.sameVisualFeatureSources(sources, viaStored), `${label}: 別の向きの候補「${other.noun}」が一致扱い`);
              otherViewChecked++;
            }
          }
        }
      }
    }
  }
  assert.ok(sameChecked > 500 && differentChecked > 500 && otherViewChecked > 5000 && unnamedChecked > 500, JSON.stringify({ sameChecked, differentChecked, otherViewChecked, unnamedChecked }));
});
