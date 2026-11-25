import test from 'node:test';
import assert from 'node:assert/strict';

import { ROOT_MATRIX as MATRIX } from './support/i139-qr-oracle.ts';

// Dynamic import keeps a missing implementation an individual RED assertion.
const load = () => import('../workers/tangram-experiment/src/admin/qr.ts');
test('QR byte encoding matches a pinned independent known matrix with explicit medium error correction', async () => {
  const { encodeQr } = await load(); const qr = encodeQr('https://example.test/');
  assert.equal(qr.errorCorrection, 'M'); assert.equal(qr.modules.length, 25);
  assert.deepEqual(qr.modules.map((row: boolean[]) => row.map((v: boolean) => v ? '1' : '0').join('')), MATRIX.split('\n'));
});
test('QR SVG draws the encoded matrix with a four-module quiet zone and no executable/external markup', async () => {
  const { renderQrSvg } = await load(); const svg = renderQrSvg('https://example.test/');
  assert.match(svg, /^<svg\b/); assert.match(svg, /viewBox="0 0 33 33"/);
  assert.doesNotMatch(svg, /<script|<style|<foreignObject|<image|<use|\sstyle\s*=|\son[a-z]+\s*=|href\s*=|url\(|<!|<\?/i);
  assert.match(svg, /fill="white"/); assert.match(svg, /fill="black"/);
  // Every black cell is an integer rectangle at its exact matrix coordinate.
  const cells = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"\s*\/?\s*>/g)].map(m => `${Number(m[1]) - 4},${Number(m[2]) - 4}`);
  const expected = MATRIX.split('\n').flatMap((row, y) => [...row].flatMap((v, x) => v === '1' ? [`${x},${y}`] : []));
  assert.deepEqual(cells.sort(), expected.sort());
});
