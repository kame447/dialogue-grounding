// D 監査（AquaGauss）D-C4: 回転別メモの描画サイズの見積もり（全4方向、候補の名詞は全て残す）。形式は B1 のものではなく、サイズ感を見る。
// 使い方: node tests/support/rotation-memory-audit-measure-render.mjs <consensus-120.json> <part-construal-468.json>
//   consensus-120.json: 4e09b62 の docs/review/construal-consensus-20261128/、part-construal-468.json: 1c5fd3e の docs/review/part-construal-20261128/
import { readFileSync } from 'node:fs';

const [consensusPath, partPath] = process.argv.slice(2);
if (!consensusPath || !partPath) { console.error('usage: <consensus-120.json> <part-construal-468.json>'); process.exit(2); }
const cons = JSON.parse(readFileSync(consensusPath, 'utf8')).orientations;
const parts = JSON.parse(readFileSync(partPath, 'utf8')).entries;
const figures = [...new Set(cons.map(o => o.figureId))];

const render = (figure, level) => JSON.stringify([0, 90, 180, 270].map(rotation => {
  const view = cons.find(o => o.figureId === figure && o.rotation === rotation);
  const withParts = parts.filter(p => p.figureId === figure && p.rotation === rotation && !p.noCandidate && p.candidates.length);
  const whole = (view.candidates ?? []).map(c => level === 'nouns' ? c.noun
    : level === 'roles' ? { n: c.noun, r: Object.fromEntries(c.parts.map(p => [p.id, p.role])) }
      : { n: c.noun, p: c.posture, d: c.direction, c: c.confidence, r: Object.fromEntries(c.parts.map(p => [p.id, p.role])) });
  const partNouns = Object.fromEntries(withParts.map(p => [p.regionId, p.candidates.map(c => level === 'full' ? { n: c.noun, o: c.owner, c: c.confidence } : c.noun)]));
  return { w: whole, p: partNouns };
}));

for (const level of ['nouns', 'roles', 'full']) {
  const sizes = figures.map(figure => ({ figure, chars: render(figure, level).length })).sort((a, b) => b.chars - a.chars);
  const sum = k => sizes.slice(0, k).reduce((total, x) => total + x.chars, 0);
  console.log(level.padEnd(6), 'per-figure min/med/max =', sizes.at(-1).chars, sizes[Math.floor(sizes.length / 2)].chars, sizes[0].chars,
    '| worst 3/4/6 figures sum =', sum(3), sum(4), sum(6), '| worst6 =', sizes.slice(0, 6).map(x => x.figure).join(','));
}
