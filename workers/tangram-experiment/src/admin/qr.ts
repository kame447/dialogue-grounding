import { qrcodegen } from './vendor/qrcodegen.mjs';

/** Byte mode, medium error correction (M), automatic version/mask, no ECC boosting. */
export function encodeQr(text: string): { errorCorrection: 'M'; modules: boolean[][] } {
  const segment = qrcodegen.QrSegment.makeBytes([...new TextEncoder().encode(text)]);
  const qr = qrcodegen.QrCode.encodeSegments([segment], qrcodegen.QrCode.Ecc.MEDIUM, 1, 40, -1, false);
  return { errorCorrection: 'M', modules: Array.from({ length: qr.size }, (_, y) =>
    Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y))) };
}

/** All markup is constant or integer coordinates. Input text is never inserted into SVG. */
export function renderQrSvg(text: string): string {
  const { modules } = encodeQr(text);
  const size = modules.length + 8; // Four light modules on every side (quiet zone).
  const cells = modules.flatMap((row, y) => row.flatMap((dark, x) => dark
    ? [`<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>`] : [])).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="264" height="264" role="img" aria-label="参加用URLのQRコード" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><g fill="black">${cells}</g></svg>`;
}
