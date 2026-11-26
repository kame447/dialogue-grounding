import { writeFileSync } from 'node:fs';
import { FIGURE_BANK, FIGURE_BANK_VERSION, FIGURE_SETS } from './figure-bank.ts';
import type { BankFigure } from './figure-bank.ts';

// Researcher-only visual catalogue (self-contained HTML, no external resources).
// Never serve this to a participant or model: it names figure IDs and candidate sets.
const SCALE = 24;
const PAD = 12;

function svgOf(figure: BankFigure): string {
  const points = figure.pieces.flatMap(p => p.points);
  const minX = Math.min(...points.map(p => p[0])), minY = Math.min(...points.map(p => p[1]));
  const w = Math.max(...points.map(p => p[0])) - minX, h = Math.max(...points.map(p => p[1])) - minY;
  const polygons = figure.pieces.map(p => '<polygon points="' + p.points
    .map(([x, y]) => `${(x - minX) * SCALE + PAD},${(y - minY) * SCALE + PAD}`).join(' ') + '"/>').join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * SCALE + 2 * PAD}" height="${h * SCALE + 2 * PAD}" `
    + `viewBox="0 0 ${w * SCALE + 2 * PAD} ${h * SCALE + 2 * PAD}" role="img" aria-label="${figure.id}" `
    + `fill="#24476b" stroke="#24476b" stroke-width="1" stroke-linejoin="round">${polygons}</svg>`;
}

export function renderBankCatalogHtml(): string {
  const cells = FIGURE_BANK.map(f => `<figure><div class="art">${svgOf(f)}</div><figcaption>${f.id}</figcaption></figure>`).join('');
  const sets = Object.entries(FIGURE_SETS).map(([id, ids]) => `<section><h3>${id}</h3><div class="row">${
    ids.map(fid => `<figure><div class="art">${svgOf(FIGURE_BANK.find(f => f.id === fid)!)}</div><figcaption>${fid}</figcaption></figure>`).join('')
  }</div></section>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>図形バンク ${FIGURE_BANK_VERSION}</title>`
    + '<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}h1{font-size:20px}h2{font-size:16px;margin-top:28px}h3{font-size:14px;margin:12px 0 4px}'
    + '.grid,.row{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;text-align:center}.art{border:1px solid #ccc;display:flex;align-items:center;justify-content:center;min-width:120px;min-height:120px;padding:4px;background:#fff}'
    + `figcaption{font-weight:600}</style></head><body><h1>図形バンク ${FIGURE_BANK_VERSION}（${FIGURE_BANK.length}図形・研究者用）</h1>`
    + `<h2>全図形</h2><div class="grid">${cells}</div><h2>候補セット（予備実験用候補）</h2>${sets}</body></html>`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const out = process.argv[2] ?? '/tmp/i180-bank-catalog.html';
  writeFileSync(out, renderBankCatalogHtml());
  console.log(out);
}
