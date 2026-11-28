import { reviewedPartProjection, type ReviewedPartProjection } from '../stimuli/primary-regions.ts';
import { createPartGeometry, validatePartGeometry } from '../stimuli/part-geometry.ts';
import type { PartGeometry, PartShape, PartPoint } from '../stimuli/part-geometry.ts';
import type { ObservationMemo } from './contract.ts';

type PartFigure = ObservationMemo['figures'][number] & { parts?: PartGeometry };
const SHAPE_LABELS: Record<PartShape, string> = {
  triangle: '三角形', square: '正方形', rectangle: '長方形', rhombus: 'ひし形',
  parallelogram: '平行四辺形', trapezoid: '台形', quadrilateral: '四角形',
  pentagon: '五角形', hexagon: '六角形', polygon: '多角形', compound: '複数の輪郭または接点を含む形',
};
const SHAPE_CODES: readonly PartShape[] = Object.freeze(Object.keys(SHAPE_LABELS) as PartShape[]);
export const PART_FEATURE_SOURCES = '部分候補の出所には ["parts","descriptions",候補の位置] を使えます。位置は0から数え、同じ図形の parts.descriptions に対応します。これは保存された構造から再計算される候補の記述で、観察済みの境界や合意済みの事実へ読み替えないでください。';
export const PART_INDEX_INSTRUCTIONS = 'メモのpartsがtangram_primary_regions_v1の場合、regionsは人が確認した少数の主要なまとまりであり、元ピース途中で区切る場合もあります。membersは部分を区別する記号、shape/sides/convexは形・辺数・凸性、areaPercentは全体面積に対する割合、outlinesとbboxは自分側の向きでの図形内座標です。construal.candidatesは見立ての仮説であり、確定的な形や名称ではありません。contactsは辺を共有する部分と重心から見た方向を表します。内部境界は見える線ではなく切り分けの仮説です。tangram_part_index_v1の場合は主要なまとまりが未確定のため、元7ピースと全連結候補のrowsを示します。rowsは[部品番号連結,形コード,符号付き辺数,左,上,幅,高さ,内部境界を含む辺数]、形コードは0=三角形、1=正方形、2=長方形、3=ひし形、4=平行四辺形、5=台形、6=四角形、7=五角形、8=六角形、9=その他多角形、10=複数輪郭または接点。いずれも唯一の正解や共有済みの認識とはみなさず、対話と自分の画像で照合してください。';
export const PART_REFERENCE_INSTRUCTIONS = 'parts は自分側の生成構造から列挙した部分の候補です。全体だけでなく元の部品や複数部品をまとめた部分とも相手の説明を照合してください。descriptions は各候補の形・自分の表示向きでの位置・内部を仮に区切る辺を記した補助メモです。人間にも同じ分け方や境界が見えているとは限らず、部分候補の存在だけで対象の一致や合意を確定しないでください。上下左右は自分側の向きなので、相手の向きと同一視せず、形やつながりも使って照合してください。' + '\n' + PART_INDEX_INSTRUCTIONS;

export const PART_OBSERVATION_SOURCES_INSTRUCTIONS = PART_REFERENCE_INSTRUCTIONS + '\n' + PART_FEATURE_SOURCES;

type MemoFigures = { figures: readonly PartFigure[] };
export const hasPartGeometry = (memo: MemoFigures): boolean => memo.figures.some(figure => Object.hasOwn(figure, 'parts'));
export const partObservationSourcesInstructions = (memo: MemoFigures): string =>
  hasPartGeometry(memo) ? '\n' + PART_OBSERVATION_SOURCES_INSTRUCTIONS : '';

function position(value: number, extent: number, lower: string, middle: string, upper: string): string {
  return value < extent / 3 ? lower : value > extent * 2 / 3 ? upper : middle;
}
function describeValidated(geometry: PartGeometry, index: number): string | undefined {
  const part = geometry.parts[index];
  if (!part) return;
  const [x, y, w, h] = part.bbox;
  const location = position(x + w / 2, geometry.size[0], '左寄り', '中央寄り', '右寄り') + '・' +
    position(y + h / 2, geometry.size[1], '上寄り', '中ほど', '下寄り');
  const edgeCount = part.edgeVisibility.reduce((sum, values) => sum + values.length, 0);
  const hidden = part.edgeVisibility.flat().filter(value => value < 1).length;
  const kind = part.members.length === 7 ? '図形全体' : part.members.length === 1 ? '元のピース' : '複数ピースをまとめた部分';
  const sides = part.shape === 'polygon' && part.sides !== null ? String(part.sides) + '辺の' : '';
  const concavity = part.convex === false ? '、くぼみあり' : '';
  const boundary = hidden ? '、輪郭' + edgeCount + '辺のうち' + hidden + '辺は内部を仮に区切る箇所を含む' : '、輪郭は全体の外周上';
  return kind + '（部品' + part.members.join('+') + '）は' + sides + SHAPE_LABELS[part.shape] + 'の候補。' +
    '自分側の' + location + '、範囲[' + part.bbox.join(',') + ']' + concavity + boundary + '。';
}

/** Virtual source value: always derived from validated saved geometry, never supplied by model prose. */
export function describePart(value: unknown, index: number): string | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return;
  const geometry = validatePartGeometry(value);
  const primary = reviewedPartProjection(geometry);
  return primary ? describeReviewed(primary, index) : describeValidated(geometry, index);
}

function describeReviewed(geometry: ReviewedPartProjection, index: number): string | undefined {
  const region = geometry.regions[index];
  if (!region) return;
  return region.id + '（部品' + region.members.join('+') + '）：' + region.description +
    '見立て候補：' + region.construal.candidates.join('・') + '。内部の切り分けと見立ては仮説。';
}

/** Model-facing projection; the stored full catalogue is unchanged. */
export function modelPartGeometry(value: unknown): ReviewedPartProjection | CompactPartGeometry {
  const geometry = validatePartGeometry(value);
  return reviewedPartProjection(geometry) ?? compactValidated(geometry);
}

/** Extra descriptions exist only in model-facing material; the stored memo remains unchanged. */
export function withPartDescriptions<T extends MemoFigures>(memo: T) {
  if (!hasPartGeometry(memo)) return memo;
  return { ...memo, figures: memo.figures.map(figure => {
    if (!Object.hasOwn(figure, 'parts')) return figure;
    const geometry = validatePartGeometry(figure.parts);
    const primary = reviewedPartProjection(geometry);
    return { ...figure, parts: primary ? { ...primary, descriptions: primary.regions.map((_region, index) => describeReviewed(primary, index)!) }
      : { ...compactValidated(geometry), descriptions: geometry.parts.map((_part, index) => describeValidated(geometry, index)!) } };
  }) };
}

export type CompactPartGeometry = {
  version: 'tangram_part_index_v1'; origin: PartPoint; size: PartPoint; pieces: PartPoint[][];
  rows: [string, number, number, number, number, number, number, number][];
};

/** Full geometry is losslessly recoverable from the seven pieces; every candidate also has an explicit index row. */
export function compactPartGeometry(value: unknown): CompactPartGeometry {
  return compactValidated(validatePartGeometry(value));
}
function compactValidated(geometry: PartGeometry): CompactPartGeometry {
  return { version: 'tangram_part_index_v1', origin: [...geometry.origin], size: [...geometry.size],
    pieces: Array.from({ length: 7 }, (_, i) => structuredClone(geometry.parts.find(part =>
      part.members.length === 1 && part.members[0] === i + 1)!.outlines[0])),
    rows: geometry.parts.map(part => [part.members.join(''), SHAPE_CODES.indexOf(part.shape),
      part.sides === null ? 0 : part.sides * (part.convex ? 1 : -1), ...part.bbox,
      part.edgeVisibility.flat().filter(value => value < 1).length]),
  };
}

export function expandCompactPartGeometry(value: CompactPartGeometry): PartGeometry {
  const geometry = createPartGeometry(value.pieces.map(polygon => polygon.map(([x, y]) =>
    [x + value.origin[0], y + value.origin[1]] as PartPoint)));
  if (JSON.stringify(compactPartGeometry(geometry)) !== JSON.stringify(value)) throw new TypeError('invalid_part_index');
  return geometry;
}
