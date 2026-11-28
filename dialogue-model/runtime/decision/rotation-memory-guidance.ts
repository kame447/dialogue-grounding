// Prompt text and per-call layers of the rotation memory: an optional `rotation` on an observation figure (the same figure imagined turned, with whole and part construals).
// Shapes, validation and name/feature candidates come from stimuli/rotation-memory-shape.ts (B1); this file only decides what each model call sees and how it is explained.
// The legend (what the data is) is defined once here and every call carries it once, next to the data. It describes the AI's own imagination only:
// it never mentions the partner's board, the rotation mode or which view is close to the partner, so it is byte-identical for every rotation mode.
// The partner-side task condition stays in the existing mode sentences (ROTATION_V5 ...). Each call adds only a short usage text of its own.
// A request without a valid `rotation` on any figure never reaches this module's texts, so every earlier version keeps its bytes.
import { rotationNameCandidates, rotationFeatureCandidates, validateOwnRotationMemory } from "../stimuli/rotation-memory-shape.ts";
import type { OwnRotationMemory, OwnRotationView } from "../stimuli/rotation-memory-shape.ts";

export { rotationNameCandidates, rotationFeatureCandidates };
export type { OwnRotationMemory };

const object = (v: unknown): v is Record<string, unknown> => !!v && Object.getPrototypeOf(v) === Object.prototype;

/** What a call is shown: nouns = whole/part nouns with minimal geometry; roles = nouns + the roles of regions in each whole + full geometry; full = everything. */
export type RotationLayer = "nouns" | "roles" | "full";
/** One place that says which layer each kind of call carries (decision: the fixed small block counted in the state budget). */
export const ROTATION_LAYER_OF_CALL = Object.freeze({ decision: "nouns", generation: "roles", extraction: "roles", reobservation: "nouns" } as const);

/** The figure's rotation memory when it is present and well formed, else null. A malformed value is treated as absent: it never stops a request. */
export function figureRotation(figure: unknown): OwnRotationMemory | null {
  if (!object(figure) || !Object.hasOwn(figure, "rotation")) return null;
  try { return validateOwnRotationMemory(figure.rotation); } catch { return null; }
}
/** True when at least one figure carries a well-formed rotation memory. Every call decides "new text or old bytes" with this one test. */
export function hasRotationMemory(memo: { figures: readonly unknown[] } | undefined): boolean {
  return !!memo && Array.isArray(memo.figures) && memo.figures.some(figure => figureRotation(figure) !== null);
}

type Layered = Record<string, unknown>;
const mark = (c: { confidence?: "中" | "高" }) => c.confidence === undefined ? {} : { confidence: c.confidence };
const nounMark = (c: { noun: string; confidence?: "中" | "高" }) => c.confidence === undefined ? c.noun : `${c.noun}（${c.confidence}）`;
/** The roles and full layers: whole candidates as objects (noun, confidence mark, roles per region; full adds posture and direction), part candidates as plain nouns. The owner of a part is not carried. */
function layerView(view: OwnRotationView, layer: RotationLayer): Layered {
  const whole = view.whole.map(w => ({ noun: w.noun, ...mark(w), roles: w.roles, ...(layer === "full" ? { posture: w.posture, direction: w.direction } : {}) }));
  const parts = Object.fromEntries(Object.entries(view.parts).map(([id, list]) => [id, list.map(nounMark)]));
  return { whole, parts };
}
/** The nouns layer writes a view as one line: "全体: 見立て・見立て / P1 部分の見立て・… / P2 …"; "全体: なし" when the view has no whole construal. */
const viewLine = (view: OwnRotationView): string => ["全体: " + (view.whole.length ? view.whole.map(nounMark).join("・") : "なし"),
  ...Object.entries(view.parts).map(([id, list]) => `${id} ${list.map(nounMark).join("・")}`)].join(" / ");
/** A pure projection of a validated rotation memory onto a layer. Nouns, confidence marks, region ids and wholeAnywhere survive in every layer. */
export function rotationMemoryLayer(rotation: OwnRotationMemory, layer: RotationLayer): Layered {
  if (layer === "nouns") return { regions: rotation.regions.map(r => `${r.id} ${r.shapeName} ${r.areaPercent}%`), current: viewLine(rotation.current),
    turned: rotation.turned.map(t => ({ rel: t.rel, view: viewLine(t) })), wholeAnywhere: rotation.wholeAnywhere };
  return { regions: rotation.regions, current: layerView(rotation.current, layer), turned: rotation.turned.map(t => ({ rel: t.rel, ...layerView(t, layer) })), wholeAnywhere: rotation.wholeAnywhere };
}
/** The memo as a call shows it: every well-formed rotation replaced by its layer, a malformed one removed. Other fields are untouched. */
export function withRotationLayer<T extends { figures: readonly unknown[] }>(memo: T, layer: RotationLayer): T {
  if (!hasRotationMemory(memo)) return memo;
  return { ...memo, figures: memo.figures.map(figure => {
    if (!object(figure) || !Object.hasOwn(figure, "rotation")) return figure;
    const { rotation: _own, ...rest } = figure;
    const rotation = figureRotation(figure);
    return rotation ? { ...rest, rotation: rotationMemoryLayer(rotation, layer) } : rest;
  }) };
}

/** The legend of a layer: the base says what the data is; the clauses are present only for the keys the layer carries. */
export function rotationLegend(layer: RotationLayer): string {
  const detail = layer !== "nouns", full = layer === "full";
  const head = "rotationは、自分の同じ図形を向きを変えて見たと想像したときの見立ての記録で、すべて仮説です。";
  if (!detail) return head + "regionsは図形の領域の「領域id 形 面積の割合」で、領域のidで部分の見立てと結び付きます。" +
    "currentは今の向き、turnedは今の向きを時計回りにrel度回したと想像した向きで、各向きは「全体: 全体の見立て / 領域id 部分の見立ての候補」の1行です。" +
    "見立ては・で並び、確信度は中・高のときだけ括弧で付き、無ければ低です。「全体: なし」はその向きに全体の見立てがないことです。" +
    "部分の見立ては全体の見立てとは別の候補です。wholeAnywhereはどれかの向きに全体の見立てがあるかを示します。";
  return head +
    "regionsは図形の領域のid・形・面積の割合で、領域のidで他の項目と結び付きます。" + "atは自分の今の画面での位置、tipは尖った頂点の向き、adjacentは隣り合う領域です。" +
    "currentは今の向き、turnedは今の向きを時計回りにrel度回したと想像した向きで、どの向きも同じ形式です。" +
    "各向きのwholeは全体の見立ての配列で、nounは見立てた物、confidenceは中・高のときだけ付き無ければ低です" +
    (detail ? "、rolesは領域idごとの役割" : "") + (full ? "、postureはその姿勢、directionはその見え方の中での向き" : "") + "。空の配列はその向きに全体の見立てがないことです。" +
    "partsは全体の見立てとは別の、領域idごとの部分の見立ての候補で、確信度は括弧で付きます。wholeAnywhereはどれかの向きにwholeがあるかを示します。" +
    (detail ? "turnedの位置や方向の語はその見え方の中の向きなので、今の画面での位置はregionsのatで言います。" : "");
}
export const ROTATION_LEGENDS: Readonly<Record<RotationLayer, string>> = Object.freeze({ nouns: rotationLegend("nouns"), roles: rotationLegend("roles"), full: rotationLegend("full") });
/** The key that carries the legend next to the data in a JSON state or context (once per call). */
export const ROTATION_LEGEND_KEY = "rotationLegend";
/** `{ rotationLegend }` for a memo that carries a rotation memory, else nothing (the old bytes). */
export function rotationLegendEntry(memo: { figures: readonly unknown[] } | undefined, layer: RotationLayer): Record<string, string> {
  return hasRotationMemory(memo) ? { [ROTATION_LEGEND_KEY]: ROTATION_LEGENDS[layer] } : {};
}

// ---- decision (Jev) ----
/** Replaces the one common-instruction sentence that sends a different construal to re-observation first. */
export const COMMON_DIFFERENT_CONSTRUAL = "AIが馬、相手が牛と呼んだだけで誤同定や名称不一致を確定しないでください。同じ図形の異なる見立てかを照合し、必要なら画像の再観察を選べます。";
export const COMMON_DIFFERENT_CONSTRUAL_ROTATION = "AIが馬、相手が牛と呼んだだけで誤同定や名称不一致を確定しないでください。同じ図形の異なる見立てかを、別の向きの見立てを含む観察メモで照合してください。";
/** Added to the target question and to the partner-referent estimate. */
export const ROTATION_MATCH_USE = "相手の説明は、今の向きの見立てだけでなく、rotationの別の向きの見立てや部分の候補とも照合してください。同じ図形の別の向きの見立てに合うことは候補の根拠にとどまり、図形や名前の確定ではありません。";

/** Replace the whole accept / request_observation criterion (including the repair-quality paragraph) of a request that carries a rotation memory: each point is stated once. */
export const ROTATION_ACCEPT_ANSWER = "相手が図形全体や見た目・特徴を尋ねたとき（複数の図形をまとめて尋ねたときを含む）は、質問を返すconfirmや部品の確認を重ねず、このacceptで観察メモ（rotationの別の向きの見立てや部分の候補を含む）に根拠のある答えを、求められた図形すべてについて直接返す。" +
  "全体の問いには全体の見立てを先に、細部の問いにはその細部を、ある・ない・不明のいずれかで答える。今の向きに全体の見立てがなくても、別の向きの見立てや部分の候補があれば答えられる。見立ては説明であり、名前の提案・採用ではない。";
export const ROTATION_ACCEPT_BACKCHANNEL = "相手の発話が相槌だけ（新しい情報も問いもない）で、直前のAI行動もacceptだった場合は同じ受け止めを繰り返さず、より具体的な説明や次に役立つ見立てがあれば返す。" +
  "見立てを否定された後などで対象がまだ特定できていないなら、観察メモに根拠のある別の説明（別の向きの見立てを含む）や弁別特徴の確認など、対象探しを進める行動を選ぶ。相槌は名称採用や対象同定の根拠にならない。問いが複数ならそれぞれに応答し、観察で分かる点と未特定の点を分ける。";
/** Narrowed so that answering what the memo can answer stays with accept alone; the older confirm text repeated it. */
export const ROTATION_CONFIRM = "対象や話の理解に具体的な未解決点があり、相手の情報で確かめられるときだけ選ぶ。既に明らかになった点は聞き直さず、次に解消すべき論点を判断する。候補が複数というだけで細部へ進まず、今の目的に必要で、相手の情報が決め手になる点を選ぶ。";
export const ROTATION_PROPOSE_NAME = "特定の図形に呼び名を提案する。見立ては候補であり共同採用済みではない。対象が公開上で相手に伝わり、命名の流れに入って、呼び名が共同作業に役立つときに、自分側の観察の仮説（回転別メモの見立てを含む）を候補として提案できる。提案する必要がなければ見立てを返すだけでよい。相手が先に公開した呼び名は新しい提案として出し直さず、相手の提案を自分の新案にしない。";
/** The observer name is written as Luna (the older request) and replaced by Terra where the request already does so. */
export const ROTATION_REQUEST_OBSERVATION = "回転別メモ（rotation）にない、自分の画像でしか確かめられない視覚上の事実（細部の形・位置・つながり）を確かめるために、図形と論点を指定してLunaへ再観察を依頼する。" +
  "回転別メモの今の向き・別の向き・部分の候補で答えられる問いや、相手の別の見立てがメモの別の向きの見立てで説明できる場合、呼び名の好みなど視覚に無関係な変更や相手にしか分からない点の解決には選ばない。" +
  "以前の観察でも不明な点を再観察し、一方の画面の方位を他方の証拠に使わない。";

// ---- generation ----
/** Applied to the finished generation instructions of a turn whose memo carries a rotation memory; every `from` must be found exactly once. */
export const GENERATION_ROTATION_EDITS: readonly (readonly [from: string, to: string])[] = Object.freeze([
  ["自然な見立てがなければ全体の形でかまいません。",
    "今の向きに見立てがあればそれを自然に優先し、なければ最初から、別の向きの見立てを「見る角度によっては〜」「向きを変えて見ると〜」と添えて伝えてかまいません。" +
    "相手が今の見立てを受け入れなかったときや、相手の説明が別の向きの見立てに合うと気づいたときにも使えます。一度に伝えるのは一、二個にとどめます。" +
    "どの向きにも全体の見立てがなければ、全体の形や、領域ごとの部分の見立て（耳・くちばし・柄など）から印象を伝えてください。"],
  ["相手の方位は相手の見え方として扱い、自分と同じ配置や向きだと断定しないでください。",
    "相手の方位は相手の見え方として扱い、自分と同じ配置や向きだと断定しないでください。" +
    "「見る角度によっては」「向きを変えて見ると」は自分側の想像の見立てで、相手の画面の向きや相手の見え方を述べるものではありません。" +
    "回した見え方の上下左右などはその見え方の中の向きなので、今の画面の位置を言うときは領域のatの語を使い、角度の数値は言わなくてかまいません。"],
  ["などの内部項目名や種別名も公開しないでください。",
    "などの内部項目名や種別名も公開しないでください。rotation、regions、current、turned、whole、roles、領域のid（P1など）も同様です。"],
]);
export function applyGenerationRotationEdits(instructions: string): string {
  let result = instructions;
  for (const [from, to] of GENERATION_ROTATION_EDITS) {
    if (result.split(from).length !== 2) throw new Error("rotation_generation_instructions_out_of_sync");
    result = result.replace(from, () => to);
  }
  return result;
}

// ---- extraction and re-observation ----
export const EXTRACTION_ROTATION_USE = "相手の説明は、今の向きだけでなくrotationの別の向きの見立てや部分の候補とも照合し、合う図形をtargetsの候補に残してください。一致は候補の根拠にとどまり、同じ図形・名前の合意の確定ではありません。";
export const AI_EXTRACTION_ROTATION_USE = "「向きを変えて見ると〜」「見る角度によっては〜」は、rotationに根拠がある自分側の想像の見立て（construal）として抽出してください。相手の画面の向きの主張ではありません。";
export const REOBSERVATION_ROTATION_USE = "figuresのrotationは自分の図形を向きを変えて見たと想像した見立ての記録で、今の画像上の根拠ではありません。画像で確かめられる点だけをsupports・contradicts・unknownへ書いてください。";

/** Every rotation text a call can carry, for the guard that keeps instruction text out of public utterances. */
export const ROTATION_PRIVATE_TEXTS: readonly string[] = Object.freeze([...Object.values(ROTATION_LEGENDS), ROTATION_MATCH_USE,
  EXTRACTION_ROTATION_USE, AI_EXTRACTION_ROTATION_USE, REOBSERVATION_ROTATION_USE, ...GENERATION_ROTATION_EDITS.map(([, to]) => to)]);
