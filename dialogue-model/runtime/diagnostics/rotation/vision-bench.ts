// RESEARCHER ONLY, not an experiment trial. Vision-only probes of whether the
// model can match a rotated synthetic silhouette at all, with no dialogue,
// names or descriptions. Item metadata (figure ids, rotations, expected slot)
// is used only for scoring after the response and never enters a request.
import { SLOTS, imagePart, parseSame, parseSlot, randomSource, renderBoard, renderSingle, shuffle } from "./bench-common.ts";
import type { BoardEntry, ChatClient, ChatMessage, Slot } from "./bench-common.ts";

export const DELTAS = Object.freeze([0, 45, 90, 180]);
// Fixed from the offline rank (shape-similarity.ts rankPairs, 2026-10-19):
// the three most and three least similar pairs on mean rank of IoU/Hu/turning.
export const CONFUSABLE_PAIRS = Object.freeze([["F3", "F4"], ["F1", "F6"], ["F3", "F6"]] as const);
export const DISTINCT_PAIRS = Object.freeze([["F5", "F6"], ["F2", "F6"], ["F4", "F5"]] as const);
const IDS = ["F1", "F2", "F3", "F4", "F5", "F6"];
const QUARTERS = [0, 90, 180, 270];

export type SameItem = { kind: "same_different"; itemId: string; pairType: "same" | "confusable" | "distinct";
  first: { figureId: string; rotation: number }; second: { figureId: string; rotation: number }; delta: number; expected: boolean };
export type IdentifyItem = { kind: "identify"; itemId: string; board: BoardEntry[]; target: string; delta: number;
  cropRotation: number; expected: Slot; boardVariant: number; targetPair: "confusable" | "other" };
export type VisionItem = SameItem | IdentifyItem;

const confusableIds = new Set(CONFUSABLE_PAIRS.flat());

export function planVision(): VisionItem[] {
  const items: VisionItem[] = [];
  const pairs: Array<[SameItem["pairType"], string, string]> = [
    ...IDS.map((id) => ["same", id, id] as [SameItem["pairType"], string, string]),
    ...CONFUSABLE_PAIRS.map(([a, b]) => ["confusable", a, b] as [SameItem["pairType"], string, string]),
    ...DISTINCT_PAIRS.map(([a, b]) => ["distinct", a, b] as [SameItem["pairType"], string, string]),
  ];
  for (const [pairType, a, b] of pairs) for (const delta of DELTAS) {
    const itemId = `sd:${pairType}:${a}${b}:${delta}`;
    const random = randomSource(itemId);
    const base = QUARTERS[Math.floor(random() * 4)];
    const [x, y] = random() < 0.5 ? [a, b] : [b, a];
    items.push({ kind: "same_different", itemId, pairType, first: { figureId: x, rotation: base },
      second: { figureId: y, rotation: (base + delta) % 360 }, delta, expected: a === b });
  }
  for (const boardVariant of [1, 2]) {
    const random = randomSource(`board:${boardVariant}`);
    const board = shuffle(IDS, random).map((figureId) => ({ figureId, rotation: QUARTERS[Math.floor(random() * 4)] }));
    for (const entry of board) for (const delta of DELTAS) {
      items.push({ kind: "identify", itemId: `id:${boardVariant}:${entry.figureId}:${delta}`, board, target: entry.figureId, delta,
        cropRotation: (entry.rotation + delta) % 360, expected: SLOTS[board.indexOf(entry)], boardVariant,
        targetPair: confusableIds.has(entry.figureId as never) ? "confusable" : "other" });
    }
  }
  return items;
}

export const SAME_QUESTION = [
  "研究用の画像認識の確認です（対話課題ではありません）。",
  "2枚の画像には、黒いシルエットが1つずつ描かれています。大きさは同じです。",
  "2枚目は、1枚目と同じ形を回転させたもの（回転0度の場合を含む）か、異なる形のどちらかです。鏡映（裏返し）はありません。",
  "JSONのみで答えてください。形式: {\"same\": true} または {\"same\": false}",
].join("\n");

export const IDENTIFY_QUESTION = [
  "研究用の画像認識の確認です（対話課題ではありません）。",
  "最初の画像には6つの図形があります。位置名は 上段左・上段中・上段右・下段左・下段中・下段右 です。",
  "最後の画像の図形1つは、6図形のどれか1つと同じ形で、向きだけが任意の角度で回転している可能性があります（鏡映はありません）。",
  "どの位置の図形と同じ形かを、JSONのみで答えてください。形式: {\"slot\":\"<位置名>\"}",
].join("\n");

export function buildVisionMessages(item: VisionItem): ChatMessage[] {
  if (item.kind === "same_different") {
    return [{ role: "user", content: [{ type: "text", text: SAME_QUESTION },
      imagePart(renderSingle(item.first.figureId, item.first.rotation)),
      imagePart(renderSingle(item.second.figureId, item.second.rotation))] }];
  }
  return [
    { role: "user", content: [{ type: "text", text: IDENTIFY_QUESTION }, imagePart(renderBoard(item.board))] },
    { role: "user", content: [{ type: "text", text: "照合する図形:" }, imagePart(renderSingle(item.target, item.cropRotation))] },
  ];
}

export type VisionResult = { itemId: string; kind: VisionItem["kind"]; answer: string | boolean | null; correct: boolean;
  error: string | null; usage: unknown; item: VisionItem };

export async function runVisionItem(client: ChatClient, item: VisionItem): Promise<VisionResult> {
  let answer: string | boolean | null = null, error: string | null = null, usage: unknown = null;
  try {
    const response = await client.complete(buildVisionMessages(item));
    answer = item.kind === "same_different" ? parseSame(response.text) : parseSlot(response.text);
    usage = response.usage ?? null;
    if (answer === null) error = "unparsed";
  } catch (failure) {
    error = (failure as { code?: string })?.code || "request_failed";
  }
  // Scored only after the response; expected values never enter the request.
  return { itemId: item.itemId, kind: item.kind, answer, correct: answer === item.expected, error, usage, item };
}
