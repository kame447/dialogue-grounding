// RESEARCHER ONLY, not an experiment trial. The model sees its own unlabeled
// board and one short partner-style description written for the partner's
// view of a figure. Aligned and rotated items differ only in the target's own
// orientation, which isolates verbal correspondence across rotation from
// whole-board vision. Descriptions are a fixed template table WRITTEN BY A
// MODEL (Claude Opus, acting as a proxy partner) and not approved by the
// researcher. They are not human or participant language; never report
// results from them as evidence about how humans describe these figures.
import { SLOTS, imagePart, parseSlot, randomSource, renderBoard, shuffle } from "./bench-common.ts";
import type { BoardEntry, ChatClient, ChatMessage, Slot } from "./bench-common.ts";

export const STYLES = Object.freeze(["impression", "impression+oriented", "impression+invariant"] as const);
export type Style = (typeof STYLES)[number];
export const VIEWS = Object.freeze(["aligned", "rotated"] as const);
export type View = (typeof VIEWS)[number];
export const PARTNER_ROTATIONS = Object.freeze([0, 180]);

type Phrase = { impression: string; oriented: string };
/** Partner-view phrases keyed by figure and the partner's rotation (clockwise).
 * `oriented` uses the partner's screen directions; `invariant` does not. */
export const PHRASES: Readonly<Record<string, { invariant: string; views: Readonly<Record<number, Phrase>> }>> = Object.freeze({
  F1: { invariant: "細い縦長の胴の両端から、三角が反対向きに出ています",
    views: { 0: { impression: "タツノオトシゴ", oriented: "上の頭みたいな三角が左を向いています" },
      180: { impression: "座ったウサギ", oriented: "左上に長い耳みたいな突起があります" } } },
  F2: { invariant: "細長い斜めの帯の端に、小さな四角がはみ出しています",
    views: { 0: { impression: "階段", oriented: "左下に小さな四角がはみ出しています" },
      180: { impression: "走る犬", oriented: "右上に平らな四角い頭があります" } } },
  F3: { invariant: "四角い出っ張りが二つあって、間に深いV字の切れ込みがあります",
    views: { 0: { impression: "ピストル", oriented: "左上に四角い腕が横に突き出ています" },
      180: { impression: "走る人", oriented: "右下に四角い足が横に突き出ています" } } },
  F4: { invariant: "大きな三角の胴に、二つの尖りが並んでV字のすき間を作っています",
    views: { 0: { impression: "羽ばたく鳥", oriented: "右上に下向きの三角がぶら下がっています" },
      180: { impression: "座った猫", oriented: "左下にV字に開いた三角があります" } } },
  F5: { invariant: "ずんぐりした丸っこい塊に、小さな三角の突起が一つ付いています",
    views: { 0: { impression: "鳥の頭", oriented: "右下にくちばしみたいな三角が出ています" },
      180: { impression: "ひよこ", oriented: "左上に尖った三角が突き出ています" } } },
  F6: { invariant: "ジグザグに折れた形で、一辺だけ長くまっすぐです",
    views: { 0: { impression: "稲妻", oriented: "上が広くて平らな辺になっています" },
      180: { impression: "帆船", oriented: "下が広くて平らな辺になっています" } } },
});

export function describe(figureId: string, partnerRotation: number, style: Style): string {
  const entry = PHRASES[figureId], phrase = entry?.views[partnerRotation];
  if (!phrase) throw new TypeError("No phrase for this figure and rotation");
  const head = `${phrase.impression}みたいな形です。`;
  if (style === "impression") return head;
  return head + (style === "impression+oriented" ? phrase.oriented : entry.invariant) + "。";
}

export type VerbalItem = { kind: "verbal"; itemId: string; target: string; partnerRotation: number; style: Style; view: View;
  board: BoardEntry[]; ownTargetRotation: number; expected: Slot; description: string };

const IDS = ["F1", "F2", "F3", "F4", "F5", "F6"];
const QUARTERS = [0, 90, 180, 270];

/** Aligned and rotated twins share board slots and distractor orientations. */
export function planVerbal(): VerbalItem[] {
  const items: VerbalItem[] = [];
  for (const target of IDS) for (const partnerRotation of PARTNER_ROTATIONS) {
    const scope = `verbal:${target}:${partnerRotation}`;
    const random = randomSource(scope);
    const order = shuffle(IDS, random);
    const distractors = new Map(order.map((id) => [id, QUARTERS[Math.floor(random() * 4)]]));
    // As in v2, the two screens differ by a quarter turn either way.
    const rotatedOwn = (partnerRotation + (random() < 0.5 ? 90 : 270)) % 360;
    for (const view of VIEWS) {
      const ownTargetRotation = view === "aligned" ? partnerRotation : rotatedOwn;
      const board = order.map((figureId) => ({ figureId, rotation: figureId === target ? ownTargetRotation : distractors.get(figureId)! }));
      for (const style of STYLES) {
        items.push({ kind: "verbal", itemId: `vb:${target}:${partnerRotation}:${view}:${style}`, target, partnerRotation, style, view,
          board, ownTargetRotation, expected: SLOTS[order.indexOf(target)], description: describe(target, partnerRotation, style) });
      }
    }
  }
  return items;
}

export function verbalQuestion(description: string): string {
  return [
    "研究用の確認です（対話課題ではありません）。",
    "画像はあなたの画面で、6つの図形があります。位置名は 上段左・上段中・上段右・下段左・下段中・下段右 です。",
    "相手は同じ6図形を別の画面で見ています。相手の画面では、配置や向きがあなたの画面と異なることがあります。",
    `相手が1つの図形について、次のように言いました。「${description}」`,
    "相手が指しているのは、あなたの画面のどの位置の図形だと思いますか。JSONのみで答えてください。形式: {\"slot\":\"<位置名>\"}",
  ].join("\n");
}

export function buildVerbalMessages(item: VerbalItem): ChatMessage[] {
  return [{ role: "user", content: [{ type: "text", text: verbalQuestion(item.description) }, imagePart(renderBoard(item.board))] }];
}

export type VerbalResult = { itemId: string; kind: "verbal"; answer: Slot | null; correct: boolean; error: string | null; usage: unknown; item: VerbalItem };

export async function runVerbalItem(client: ChatClient, item: VerbalItem): Promise<VerbalResult> {
  let answer: Slot | null = null, error: string | null = null, usage: unknown = null;
  try {
    const response = await client.complete(buildVerbalMessages(item));
    answer = parseSlot(response.text);
    usage = response.usage ?? null;
    if (answer === null) error = "unparsed";
  } catch (failure) {
    error = (failure as { code?: string })?.code || "request_failed";
  }
  return { itemId: item.itemId, kind: "verbal", answer, correct: answer === item.expected, error, usage, item };
}
