import type { LocalOwnAnchor } from '../local-grounding/contract.ts';
import { validatePartGeometry } from '../stimuli/part-geometry.ts';
import type { PartGeometry } from '../stimuli/part-geometry.ts';

export type OwnPartObservation = { id: string; parts: PartGeometry };

export const PART_OBSERVATION_INSTRUCTIONS = [
  'ownPartsと各図形のpartsは、自分側の図形を生成した元ピースと、辺でつながる全組合せを記録した部分候補です。見えている境界や相手との合意を保証する情報ではありません。',
  'membersは同じ図形内の元ピース番号です。1枚の部分、複数枚をまとめた部分、全体を区別して参照してください。人間が部分の形を述べる場合は、全体の外形だけでなく複数ピースからなる部分候補も照合してください。',
  'originは自分側画像上の左上座標、sizeは図形の幅と高さです。各部分のbboxとoutlinesはoriginからの相対座標です。adjacencyは元ピースどうしが辺でつながる関係です。',
  'shapeとsidesは候補の幾何的な形と辺数です。triangleは三角形、squareは正方形、rectangleは長方形、parallelogramは平行四辺形、rhombusはひし形、trapezoidは台形、quadrilateralは四角形、pentagonは五角形、hexagonは六角形、polygonは多角形です。compoundは穴や複数輪郭などを含み、単純な多角形の辺数として扱いません。',
  'edgeVisibilityは輪郭の各辺が図形全体の可視輪郭と重なる割合です。1未満の辺は画面にない切り分けを含みます。内部の切り分けは仮説として扱い、人間が同じように分けていると決めつけず、画像と位置・つながりを照合してください。',
  '候補があるだけで対象同定や合意を確定しません。候補にない形も直ちに存在しないと断定せず、画像の別の切り分けとして必要に応じて確かめてください。観察JSONへpartsを出力し直す必要はありません。',
].join('\n');

const invalid = (): never => { throw new TypeError('invalid_part_observation'); };
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validatePartsForRegion(value: unknown, region: LocalOwnAnchor['bbox']): PartGeometry {
  const parts = validatePartGeometry(value);
  if (parts.origin[0] !== region.x || parts.origin[1] !== region.y || parts.size[0] !== region.w || parts.size[1] !== region.h) invalid();
  return parts;
}

export function validateOwnParts(value: unknown, anchors: readonly LocalOwnAnchor[]): OwnPartObservation[] {
  if (!Array.isArray(value) || value.length !== anchors.length) return invalid();
  const found = new Map<string, PartGeometry>();
  for (const row of value) {
    if (!exact(row, ['id', 'parts']) || typeof row.id !== 'string' || found.has(row.id)) invalid();
    const anchor = anchors.find(anchor => anchor.id === row.id);
    if (!anchor) invalid();
    found.set(row.id, validatePartsForRegion(row.parts, anchor!.bbox));
  }
  return anchors.map(anchor => ({ id: anchor.id, parts: found.get(anchor.id) ?? invalid() }));
}
