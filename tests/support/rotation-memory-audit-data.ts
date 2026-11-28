// D 監査（AquaGauss）: 回転別メモの元データ（全体の合議案・独立部分の見立て・確定分割）の読み込みと、実装に依存しない期待値・幾何の計算。
// B1 の束や投影のコードは使わない（期待値はここで元データから独立に作る）。
// データの場所: AUDIT_DATA_DIR（consensus-120.json・part-construal-468.json・review-results-final.json を置いた場所）か、無ければ検査する木の docs/review/ 配下。
import { existsSync, readFileSync } from 'node:fs';
import { auditRoot } from './rotation-memory-audit-keys.ts';

export type Confidence = '高' | '中' | '低';
export type SourceWhole = { rank: number; noun: string; posture: string; direction: string; confidence: Confidence; parts: { id: string; role: string }[] };
export type SourcePartCandidate = { noun: string; owner?: string; confidence: Confidence };
export type SourceView = { whole: SourceWhole[]; parts: Record<string, SourcePartCandidate[]> };
export type Atom = { id: string; polygon: [number, number][] };
export type SourceFigure = { size: [number, number]; atoms: Atom[]; regions: { id: string; members: string[] }[] };

export const ROTATIONS = [0, 90, 180, 270] as const;
const FILES = {
  consensus: ['consensus-120.json', 'docs/review/construal-consensus-20261128/consensus-120.json'],
  parts: ['part-construal-468.json', 'docs/review/part-construal-20261128/part-construal-468.json'],
  catalog: ['review-results-final.json', 'docs/review/review-results-final.json'],
} as const;

export const dataPath = (kind: keyof typeof FILES): string => {
  const [name, repoRelative] = FILES[kind];
  const dir = process.env.AUDIT_DATA_DIR;
  return dir && dir.length > 0 ? dir.replace(/\/?$/, '/') + name : auditRoot() + repoRelative;
};
export const sourcesAvailable = (): boolean => (Object.keys(FILES) as (keyof typeof FILES)[]).every(kind => existsSync(dataPath(kind)));
const readJson = (kind: keyof typeof FILES): any => JSON.parse(readFileSync(dataPath(kind), 'utf8'));

export type Sources = {
  views: Map<string, SourceView>;                   // `${figureId}@${rotation}` -> 採用された全体・部分の候補
  noCandidateParts: Set<string>;                    // `${figureId}@${rotation}#${regionId}`（候補なし。未合意を含む）
  agreement: Map<string, string>;                   // `${figureId}@${rotation}#${regionId}` -> 部分の合意状態
  figures: Map<string, SourceFigure>;               // 確定分割（0度の原子の多角形と領域の members）
  figureIds: string[];
};

let cached: Sources | undefined;
export function loadSources(): Sources {
  if (cached) return cached;
  const consensus = readJson('consensus').orientations as any[];
  const partEntries = readJson('parts').entries as any[];
  const catalog = readJson('catalog').results as any[];
  const views = new Map<string, SourceView>();
  for (const o of consensus) {
    views.set(`${o.figureId}@${o.rotation}`, { whole: (o.candidates ?? []).map((c: any) => ({ rank: c.rank, noun: c.noun, posture: c.posture, direction: c.direction,
      confidence: c.confidence, parts: c.parts.map((p: any) => ({ id: p.id, role: p.role })) })), parts: {} });
  }
  const noCandidateParts = new Set<string>(), agreement = new Map<string, string>();
  for (const e of partEntries) {
    const key = `${e.figureId}@${e.rotation}`, region = `${key}#${e.regionId}`;
    agreement.set(region, e.agreementStatus);
    if (e.noCandidate === true || !e.candidates?.length) { noCandidateParts.add(region); continue; }
    views.get(key)!.parts[e.regionId] = e.candidates.map((c: any) => ({ noun: c.noun, ...(c.owner ? { owner: c.owner } : {}), confidence: c.confidence }));
  }
  const figures = new Map<string, SourceFigure>();
  for (const result of catalog) {
    const regions = partEntries.filter(e => e.figureId === result.figureId && e.rotation === 0).map(e => ({ id: e.regionId as string, members: e.members as string[] }));
    figures.set(result.figureId, { size: result.size, atoms: result.atoms.map((a: any) => ({ id: a.id, polygon: a.polygon })), regions });
  }
  cached = { views, noCandidateParts, agreement, figures, figureIds: [...figures.keys()] };
  return cached;
}

// ---- 独立の幾何: 確定分割の 0 度の原子を、画面で時計回りに r 度回す（y 下向き）。r 度の見えの図形の外接範囲の幅・高さに対する重心の相対位置を返す ----
export const rotatePoint = ([x, y]: [number, number], degrees: number, [w, h]: [number, number]): [number, number] =>
  degrees === 0 ? [x, y] : degrees === 90 ? [h - y, x] : degrees === 180 ? [w - x, h - y] : [y, w - x];
export const rotatedSize = ([w, h]: [number, number], degrees: number): [number, number] => degrees % 180 === 0 ? [w, h] : [h, w];

function polygonArea(points: [number, number][]): { area: number; cx: number; cy: number } {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % points.length], cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  return { area: Math.abs(a / 2), cx: cx / (3 * a), cy: cy / (3 * a) };
}
/** 原子の集合の面積重みつき重心（回した後の外接範囲に対する 0〜1 の相対位置）と面積。 */
export function relativeCentroid(figure: SourceFigure, atomIds: readonly string[], degrees: number): { x: number; y: number; area: number } {
  const size = figure.size, [w, h] = rotatedSize(size, degrees);
  let total = 0, sx = 0, sy = 0;
  for (const id of atomIds) {
    const atom = figure.atoms.find(a => a.id === id)!;
    const { area, cx, cy } = polygonArea(atom.polygon.map(p => rotatePoint(p, degrees, size)));
    total += area; sx += area * cx; sy += area * cy;
  }
  return { x: sx / total / w, y: sy / total / h, area: total };
}

const THIRD = 1 / 3;
/** 位置の語。境界（1/3・2/3）から ±tolerance 以内は、隣り合う2つの語の両方を許す。 */
export function positionWords(x: number, y: number, tolerance = 0.02): string[] {
  const axis = (v: number): ('low' | 'mid' | 'high')[] => {
    const set = new Set<'low' | 'mid' | 'high'>([v < THIRD ? 'low' : v > 2 * THIRD ? 'high' : 'mid']);
    if (Math.abs(v - THIRD) <= tolerance) { set.add('low'); set.add('mid'); }
    if (Math.abs(v - 2 * THIRD) <= tolerance) { set.add('mid'); set.add('high'); }
    return [...set];
  };
  const columns = axis(x), rows = axis(y);
  const word = (c: string, r: string) => c === 'mid' && r === 'mid' ? '中央付近'
    : (c === 'low' ? '左' : c === 'high' ? '右' : '') + (r === 'low' ? '上' : r === 'high' ? '下' : '') + '寄り';
  return columns.flatMap(c => rows.map(r => word(c, r)));
}
