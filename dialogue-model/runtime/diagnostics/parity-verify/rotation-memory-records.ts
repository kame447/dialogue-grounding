// Independent S4 copy of what a request that carries the pre-made rotation memory says differently from the earlier requests.
// Everything here is written out, not read from decision/rotation-memory-guidance.ts or stimuli/rotation-memory-shape.ts, so that a missing,
// added or changed sentence, legend or layer in a recorded request is a mismatch (the S4 rule: the table is the evidence, never the producer).
// A request "carries" the memory when one figure of the memo recorded in the turn's state has a well-formed `rotation`; a malformed one
// counts as absent, like in the run. A request without it keeps every byte of the earlier versions: none of these texts may appear in it.
// Only what the memory adds is held here; the sentences around it are pinned by the registered source fingerprints and by the other S4 tables.
import { equal } from "./core.ts";
import type { Row } from "./core.ts";

// ---- Texts ----
export const ROTATION_LEGEND_NOUNS = "rotationは、自分の同じ図形を向きを変えて見たと想像したときの見立ての記録で、すべて仮説です。regionsは図形の領域の「領域id 形 面積の割合」で、領域のidで部分の見立てと結び付きます。currentは今の向き、turnedは今の向きを時計回りにrel度回したと想像した向きで、各向きは「全体: 全体の見立て / 領域id 部分の見立ての候補」の1行です。見立ては・で並び、確信度は中・高のときだけ括弧で付き、無ければ低です。「全体: なし」はその向きに全体の見立てがないことです。部分の見立ては全体の見立てとは別の候補です。wholeAnywhereはどれかの向きに全体の見立てがあるかを示します。";
export const ROTATION_LEGEND_ROLES = "rotationは、自分の同じ図形を向きを変えて見たと想像したときの見立ての記録で、すべて仮説です。regionsは領域ごとの1行「領域id 自分の今の画面での位置の形 面積の割合 頂点の向き くぼみ 隣:隣り合う領域」で、領域のidで他の項目と結び付きます。currentは今の向き、turnedは今の向きを時計回りにrel度回したと想像した向きで、どの向きも同じ形式です。各向きのwholeは全体の見立てごとの1行「見立て: 領域id 役割 / …」で、確信度は中・高のときだけ見立ての後に括弧で付き無ければ低です。空の配列はその向きに全体の見立てがないことです。partsは全体の見立てとは別の、領域idごとの部分の見立ての候補の1行です。wholeAnywhereはどれかの向きに全体の見立てがあるかを示します。turnedの位置や方向の語はその見え方の中の向きなので、今の画面での位置はregionsの位置の語で言います。";
export const COMMON_DIFFERENT_CONSTRUAL = "AIが馬、相手が牛と呼んだだけで誤同定や名称不一致を確定しないでください。同じ図形の異なる見立てかを照合し、必要なら画像の再観察を選べます。";
export const COMMON_DIFFERENT_CONSTRUAL_ROTATION = "AIが馬、相手が牛と呼んだだけで誤同定や名称不一致を確定しないでください。同じ図形の異なる見立てかを、別の向きの見立てを含む観察メモで照合してください。";
export const ROTATION_MATCH_USE = "相手の説明は、今の向きの見立てだけでなく、rotationの別の向きの見立てや部分の候補とも照合してください。同じ図形の別の向きの見立てに合うことは候補の根拠にとどまり、図形や名前の確定ではありません。";
export const ROTATION_ACCEPT_ANSWER = "相手が図形全体や見た目・特徴を尋ねたとき（複数の図形をまとめて尋ねたときを含む）は、質問を返すconfirmや部品の確認を重ねず、このacceptで観察メモ（rotationの別の向きの見立てや部分の候補を含む）に根拠のある答えを、求められた図形すべてについて直接返す。全体の問いには全体の見立てを先に、細部の問いにはその細部を、ある・ない・不明のいずれかで答える。今の向きに全体の見立てがなくても、別の向きの見立てや部分の候補があれば答えられる。見立ては説明であり、名前の提案・採用ではない。";
export const ROTATION_ACCEPT_BACKCHANNEL = "相手の発話が相槌だけ（新しい情報も問いもない）で、直前のAI行動もacceptだった場合は同じ受け止めを繰り返さず、より具体的な説明や次に役立つ見立てがあれば返す。見立てを否定された後などで対象がまだ特定できていないなら、観察メモに根拠のある別の説明（別の向きの見立てを含む）や弁別特徴の確認など、対象探しを進める行動を選ぶ。相槌は名称採用や対象同定の根拠にならない。問いが複数ならそれぞれに応答し、観察で分かる点と未特定の点を分ける。";
export const ROTATION_CONFIRM = "対象や話の理解に具体的な未解決点があり、相手の情報で確かめられるときだけ選ぶ。既に明らかになった点は聞き直さず、次に解消すべき論点を判断する。候補が複数というだけで細部へ進まず、今の目的に必要で、相手の情報が決め手になる点を選ぶ。";
export const ROTATION_PROPOSE_NAME = "特定の図形に呼び名を提案する。見立ては候補であり共同採用済みではない。対象が公開上で相手に伝わり、命名の流れに入って、呼び名が共同作業に役立つときに、自分側の観察の仮説（回転別メモの見立てを含む）を候補として提案できる。提案する必要がなければ見立てを返すだけでよい。相手が先に公開した呼び名は新しい提案として出し直さず、相手の提案を自分の新案にしない。";
export const ROTATION_REQUEST_OBSERVATION = "回転別メモ（rotation）にない、自分の画像でしか確かめられない視覚上の事実（細部の形・位置・つながり）を確かめるために、図形と論点を指定してLunaへ再観察を依頼する。回転別メモの今の向き・別の向き・部分の候補で答えられる問いや、相手の別の見立てがメモの別の向きの見立てで説明できる場合、呼び名の好みなど視覚に無関係な変更や相手にしか分からない点の解決には選ばない。以前の観察でも不明な点を再観察し、一方の画面の方位を他方の証拠に使わない。";
export const ROTATION_FEATURE_SOURCES = "回転別メモを使った出所は、先頭を \"rotation\" にして、使った候補を指します。例は [\"rotation\",\"current\",\"whole\",0]、[\"rotation\",\"turned\",1,\"whole\",0]、[\"rotation\",\"turned\",1,\"parts\",\"P1\",0]、[\"rotation\",\"regions\",0] です。whole・parts の添字は各向きの行に並んだ順で0から数え、turned の添字は0〜2です。";
export const EXTRACTION_ROTATION_USE = "相手の説明は、今の向きだけでなくrotationの別の向きの見立てや部分の候補とも照合し、合う図形をtargetsの候補に残してください。一致は候補の根拠にとどまり、同じ図形・名前の合意の確定ではありません。";
export const AI_EXTRACTION_ROTATION_USE = "「向きを変えて見ると〜」「見る角度によっては〜」は、rotationに根拠がある自分側の想像の見立て（construal）として抽出してください。相手の画面の向きの主張ではありません。";
export const REOBSERVATION_ROTATION_USE = "figuresのrotationは自分の図形を向きを変えて見たと想像した見立ての記録で、今の画像上の根拠ではありません。画像で確かめられる点だけをsupports・contradicts・unknownへ書いてください。";
export const ROTATION_OBSERVE_TOPICS: Readonly<Record<string, string>> = {
 "orientation": "指定図形の向き・部分間の方向関係",
 "part": "指定図形の部分と構成",
 "contour": "指定図形の輪郭",
 "construal": "指定図形が相手の別の見立てにも見えるか",
 "referent": "指定図形と公開発話の特徴の照合"
};
export const GENERATION_ROTATION_EDITS: readonly (readonly [string, string])[] = [
 [
  "観察メモと公開対話に根拠のある全体の見立て・印象・大まかな形を先に短く伝えてください。",
  "観察メモと公開対話に根拠のある、全体が何に見えるか・印象・大まかな形を先に短く伝えてください。"
 ],
 [
  "自然な見立てがなければ全体の形でかまいません。",
  "今の向きで何かに見えるならそれを自然に優先し、なければ最初から、別の向きで何に見えるかを「見る角度によっては〜」「向きを変えて見ると〜に見える」と添えて伝えてかまいません。相手が今の見え方を受け入れなかったときや、相手の説明が別の向きの見え方に合うと気づいたときにも使えます。どの向きでも全体が何かに見えなければ、全体の形や、領域ごとの部分が何に見えるか（耳・くちばし・柄など）から印象を伝えてください。"
 ],
 [
  "簡単な全体の見立てを一つ示してください。",
  "全体が何に見えるかを一つ簡単に示してください。"
 ],
 [
  "自分側の見え方を示し、相手には形の対応を尋ねてください。",
  "自分側の見え方を示してください。"
 ],
 [
  "相手の方位は相手の見え方として扱い、自分と同じ配置や向きだと断定しないでください。",
  "相手の方位は相手の見え方として扱い、自分と同じ配置や向きだと断定しないでください。「見る角度によっては」「向きを変えて見ると」は自分側の想像で、相手の画面の向きや相手の見え方を述べるものではありません。角度の数値は言わなくてかまいません。"
 ],
 [
  "などの内部項目名や種別名も公開しないでください。",
  "などの内部項目名や種別名も公開しないでください。rotation、regions、current、turned、whole、roles、領域のid（P1など）も同様です。"
 ]
];

// ---- Shape of a stored rotation memory ----
// Written out here too: the verifier decides "carries" and the layers from the recorded memo alone.
type Obj = Record<string, any>;
const plain = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const same = (a: unknown, b: unknown): boolean => { try { return equal(a, b); } catch { return false; } };
const must = (ok: boolean): void => { if (!ok) throw new TypeError("rotation_shape"); };
const keysOf = (value: Obj, required: readonly string[], optional: readonly string[] = []): boolean =>
  Object.keys(value).every(key => required.includes(key) || optional.includes(key)) && required.every(key => Object.hasOwn(value, key));
const words = (value: unknown, max: number): string => {
  must(typeof value === "string" && value.trim().length > 0 && value.length <= max && !/data\s*:\s*image|image_url|base64/iu.test(value));
  return value as string;
};
const POSITIONS = ["中央付近", "左寄り", "右寄り", "上寄り", "下寄り", "左上寄り", "右上寄り", "左下寄り", "右下寄り"];
const DIRECTIONS = ["上", "右上", "右", "右下", "下", "左下", "左", "左上"];
function checkView(view: unknown, ids: readonly string[], extra: readonly string[] = []): void {
  must(plain(view) && keysOf(view, ["whole", "parts", ...extra]));
  const v = view as Obj;
  must(Array.isArray(v.whole) && v.whole.length <= 3);
  for (const c of v.whole) {
    must(plain(c) && keysOf(c, ["noun", "posture", "direction", "roles"], ["confidence"]));
    words(c.noun, 40); words(c.posture, 80); words(c.direction, 80);
    must(c.confidence === undefined || c.confidence === "中" || c.confidence === "高");
    must(plain(c.roles) && Object.keys(c.roles).length > 0 && Object.keys(c.roles).every(id => ids.includes(id)));
    for (const role of Object.values(c.roles)) words(role, 80);
  }
  must(plain(v.parts) && Object.keys(v.parts).every(id => ids.includes(id)));
  for (const list of Object.values<any>(v.parts)) {
    must(Array.isArray(list) && list.length >= 1 && list.length <= 3);
    for (const c of list) {
      must(plain(c) && keysOf(c, ["noun"], ["owner", "confidence"]));
      words(c.noun, 40);
      if (c.owner !== undefined) words(c.owner, 40);
      must(c.confidence === undefined || c.confidence === "中" || c.confidence === "高");
    }
  }
}
function checkRotation(value: unknown): void {
  must(plain(value) && keysOf(value, ["regions", "current", "turned", "wholeAnywhere"]));
  const top = value as Obj;
  must(Array.isArray(top.regions) && top.regions.length >= 1 && top.regions.length <= 8);
  const ids: string[] = top.regions.map((r: unknown) => words(plain(r) ? r.id : undefined, 3));
  must(ids.every(id => /^P[1-9][0-9]?$/u.test(id)) && new Set(ids).size === ids.length);
  top.regions.forEach((r: Obj, i: number) => {
    must(plain(r) && keysOf(r, ["id", "shapeName", "areaPercent", "at", "adjacent"], ["tip", "concave"]));
    must(r.concave === undefined || r.concave === true);
    words(r.shapeName, 24);
    must(typeof r.areaPercent === "number" && Number.isFinite(r.areaPercent) && r.areaPercent > 0 && r.areaPercent <= 100);
    must(POSITIONS.includes(r.at) && (r.tip === undefined || DIRECTIONS.includes(r.tip)));
    must(Array.isArray(r.adjacent) && r.adjacent.length <= ids.length - 1);
    const adjacent: string[] = r.adjacent.map((a: unknown) => words(a, 3));
    must(adjacent.every(a => ids.includes(a) && a !== ids[i]) && new Set(adjacent).size === adjacent.length &&
      adjacent.join(",") === ids.filter(id => adjacent.includes(id)).join(","));
  });
  checkView(top.current, ids);
  must(Array.isArray(top.turned) && top.turned.length === 3);
  top.turned.forEach((t: Obj, i: number) => { checkView(t, ids, ["rel"]); must(t.rel === [90, 180, 270][i]); });
  must(top.wholeAnywhere === [top.current, ...top.turned].some((view: Obj) => view.whole.length > 0));
}
export function wellFormedRotation(value: unknown): boolean { try { checkRotation(value); return true; } catch { return false; } }
const figuresOf = (memo: unknown): Obj[] => plain(memo) && Array.isArray(memo.figures) ? memo.figures.filter(plain) : [];
const rotationOfFigure = (figure: Obj | undefined): Obj | undefined =>
  figure && Object.hasOwn(figure, "rotation") && wellFormedRotation(figure.rotation) ? figure.rotation : undefined;
/** A memo carries the memory when one of its figures has a well-formed `rotation`; a malformed one counts as absent. */
export const carriesRotation = (memo: unknown): boolean => figuresOf(memo).some(figure => rotationOfFigure(figure) !== undefined);

// ---- Layers a call shows (decision/extraction/re-observation: nouns; generation: roles) ----
const mark = (c: Obj): string => c.confidence === undefined ? c.noun : `${c.noun}（${c.confidence}）`;
const inRegionOrder = (rotation: Obj, dict: Obj): [string, any][] =>
  rotation.regions.map((r: Obj) => r.id).filter((id: string) => Object.hasOwn(dict, id)).map((id: string) => [id, dict[id]] as [string, any]);
const viewLine = (rotation: Obj, view: Obj): string => ["全体: " + (view.whole.length ? view.whole.map(mark).join("・") : "なし"),
  ...inRegionOrder(rotation, view.parts).map(([id, list]) => `${id} ${list.map(mark).join("・")}`)].join(" / ");
export const nounsLayer = (rotation: Obj): Obj => ({ regions: rotation.regions.map((r: Obj) => `${r.id} ${r.shapeName} ${r.areaPercent}%`), current: viewLine(rotation, rotation.current),
  turned: rotation.turned.map((t: Obj) => ({ rel: t.rel, view: viewLine(rotation, t) })), wholeAnywhere: rotation.wholeAnywhere });
const regionLine = (r: Obj): string => `${r.id} ${r.at}の${r.shapeName} ${r.areaPercent}%${r.tip === undefined ? "" : ` 頂点${r.tip}向き`}${r.concave === true ? " くぼみあり" : ""}${r.adjacent.length ? ` 隣:${r.adjacent.join("・")}` : ""}`;
const roleView = (rotation: Obj, view: Obj): Obj => ({
  whole: view.whole.map((w: Obj) => `${mark(w)}: ${inRegionOrder(rotation, w.roles).map(([id, role]) => `${id} ${role}`).join(" / ")}`),
  parts: inRegionOrder(rotation, view.parts).map(([id, list]) => `${id} ${list.map(mark).join("・")}`).join(" / ") || "なし" });
export const rolesLayer = (rotation: Obj): Obj => ({ regions: rotation.regions.map(regionLine), current: roleView(rotation, rotation.current),
  turned: rotation.turned.map((t: Obj) => ({ rel: t.rel, ...roleView(rotation, t) })), wholeAnywhere: rotation.wholeAnywhere });
/** The whole nouns of the current view, then of the turned views, each once: the names the memory offers for the figure. */
export const nameNouns = (rotation: Obj): string[] => [...new Set<string>([rotation.current, ...rotation.turned].flatMap((view: Obj) => view.whole.map((c: Obj) => c.noun)))];
export type RotationLayer = "nouns" | "roles";
/** The memo as a call shows it: every well-formed rotation replaced by its layer, a malformed one removed, the rest untouched. */
export function memoInLayer(memo: Obj, layer: RotationLayer): Obj {
  if (!carriesRotation(memo)) return memo;
  return { ...memo, figures: (memo.figures as unknown[]).map(figure => {
    if (!plain(figure) || !Object.hasOwn(figure, "rotation")) return figure;
    const { rotation, ...rest } = figure;
    return wellFormedRotation(rotation) ? { ...rest, rotation: layer === "nouns" ? nounsLayer(rotation) : rolesLayer(rotation) } : rest;
  }) };
}

// ---- What the turn's requests carry ----
export type RotationTurn = { carried: boolean; memo: Obj };
/** From the memo the turn starts with; the memo the turn records must hold the same rotation memories. Null when the two disagree. */
const rotationsOf = (memo: unknown): [unknown, unknown][] => figuresOf(memo).filter(figure => Object.hasOwn(figure, "rotation")).map(figure => [figure.id, figure.rotation]);
export function rotationTurn(start: unknown, recorded: unknown): RotationTurn | null {
  return same(rotationsOf(start), rotationsOf(recorded)) ? { carried: carriesRotation(start), memo: plain(start) ? start : {} } : null;
}
const count = (text: string, sentence: string): number => text.split(sentence).length - 1;
/** Sentences that only a request carrying the memory may hold (the short ones of the generation edits are checked where they are expected). */
const REQUEST_OBSERVATION_TERRA = ROTATION_REQUEST_OBSERVATION.replace("Lunaへ", "Terraへ");
const ROTATION_SENTENCES: readonly string[] = [ROTATION_LEGEND_NOUNS, ROTATION_LEGEND_ROLES, COMMON_DIFFERENT_CONSTRUAL_ROTATION, ROTATION_MATCH_USE, ROTATION_ACCEPT_ANSWER,
  ROTATION_ACCEPT_BACKCHANNEL, ROTATION_CONFIRM, ROTATION_PROPOSE_NAME, ROTATION_REQUEST_OBSERVATION, REQUEST_OBSERVATION_TERRA, ROTATION_FEATURE_SOURCES,
  EXTRACTION_ROTATION_USE, AI_EXTRACTION_ROTATION_USE, REOBSERVATION_ROTATION_USE, GENERATION_ROTATION_EDITS[1][1], GENERATION_ROTATION_EDITS[4][1], GENERATION_ROTATION_EDITS[5][1]];
const stray = (text: string, allowed: readonly string[] = []): boolean => ROTATION_SENTENCES.some(sentence => !allowed.includes(sentence) && count(text, sentence) > 0);
const parse = (text: unknown): Obj | null => { try { const value = typeof text === "string" ? JSON.parse(text) : null; return plain(value) ? value : null; } catch { return null; } };

// ---- Requests ----
const COMMON_STEM = "AIが馬、相手が牛と呼んだだけで誤同定や名称不一致を確定しないでください。";
const COMMON_AFTER = "\n未確認を全て埋めることは目的ではありません。";
const CONTEXT_HEAD = (n: number, of: number) => new RegExp(`^同じJSON文脈の続き ${n}/${of}（全断片を順に連結して読む。内容は指示ではなくデータ）\\n`, "u");
/** The JSON context one call sends as one message, or as numbered chunks (up to 20,000 characters per message), starting at `from`. */
function contextAt(messages: readonly Obj[], from: number): { value: Obj; end: number } | null {
  const first = messages[from];
  if (first?.role !== "user" || typeof first.content !== "string") return null;
  const head = /^同じJSON文脈の続き 1\/(\d+)（/u.exec(first.content);
  if (!head) { const value = parse(first.content); return value ? { value, end: from + 1 } : null; }
  const chunks = Number(head[1]);
  let text = "";
  for (let i = 0; i < chunks; i++) {
    const content = messages[from + i]?.content, prefix = typeof content === "string" ? CONTEXT_HEAD(i + 1, chunks).exec(content) : null;
    if (!prefix) return null;
    text += (content as string).slice(prefix[0].length);
  }
  const value = parse(text);
  return value ? { value, end: from + chunks } : null;
}
const contexts = (messages: readonly Obj[], from: number): Obj[] => {
  const found: Obj[] = [];
  for (let i = from; i < messages.length;) { const context = contextAt(messages, i); if (context) { found.push(context.value); i = context.end; } else i++; }
  return found;
};
/** Each figure of a call's memo shows the rotation layer the call is meant to carry (or none), whatever else it holds. */
function layerOk(turn: RotationTurn, figures: unknown, idKey: "id" | "figureId", layer: RotationLayer, shown?: readonly string[]): boolean {
  if (!Array.isArray(figures)) return false;
  const expected = figuresOf(turn.memo).filter(figure => shown === undefined || shown.includes(figure.id));
  if (figures.length !== expected.length) return false;
  return figures.every((figure, i) => {
    if (!plain(figure) || figure[idKey] !== expected[i].id) return false;
    const rotation = rotationOfFigure(expected[i]);
    if (rotation === undefined) return !Object.hasOwn(figure, "rotation");
    return same(figure.rotation, layer === "nouns" ? nounsLayer(rotation) : rolesLayer(rotation)) && Object.keys(figure).at(-1) === "rotation";
  });
}
export type RotationTexts = { terminology: string; sharedAccept: string; sharedConfirm: string; repairQuality: readonly string[] };

function actionCriteriaOk(state: Obj, criteria: Obj, texts: RotationTexts): boolean {
  const visual = state.visualPurposeVersion === "jev_visual_purpose_v1";
  const answer = ROTATION_ACCEPT_ANSWER + ROTATION_ACCEPT_BACKCHANNEL;
  return Object.entries<any>(criteria).every(([action, criterion]) => {
    if (typeof criterion !== "string") return false;
    if (action === "accept") return count(criterion, answer) === 1 && criterion.length > answer.length &&
      (criterion.endsWith(answer) || criterion.endsWith(answer + "\n" + texts.sharedAccept)) && texts.repairQuality.every(paragraph => count(criterion, paragraph) === 0) &&
      !stray(criterion, [ROTATION_ACCEPT_ANSWER, ROTATION_ACCEPT_BACKCHANNEL]);
    if (action === "request_observation") return criterion === (visual ? REQUEST_OBSERVATION_TERRA : ROTATION_REQUEST_OBSERVATION);
    if (action === "propose_name") return criterion === ROTATION_PROPOSE_NAME;
    if (action === "confirm" && visual) return criterion === ROTATION_CONFIRM || criterion === ROTATION_CONFIRM + "\n" + texts.sharedConfirm;
    return !stray(criterion);
  });
}
const nfkc = (text: unknown): string => typeof text === "string" ? text.normalize("NFKC").trim() : "";
/**
 * The names offered for a proposal: the figure's holistic construals, then the whole nouns of the memory (current view first, then the turned
 * views, each once, at most 80 characters), then the public names. Nothing else may be offered, and a noun of the memory that is not offered is
 * left out only for a reason the request itself shows (a name already taken by or proposed for another figure, a figure whose name is settled).
 */
function nameCandidatesOk(turn: RotationTurn, state: Obj, criteria: Obj): boolean {
  if (state.selected?.action !== "propose_name") return true;
  const offers: { value: string; figureIds: string[] }[] = [];
  for (const raw of Object.values<any>(criteria)) {
    const entry = parse(raw);
    if (!entry || typeof entry.value !== "string" || !Array.isArray(entry.figureIds)) return false;
    offers.push({ value: entry.value, figureIds: entry.figureIds });
  }
  const slots: string[] = Array.isArray(state.ownSlots) ? state.ownSlots : [];
  const taken = new Set<string>([...Object.values<any>(plain(state.figures) ? state.figures : {}).map(f => nfkc(plain(f) ? f.name : null)),
    ...(Array.isArray(state.claims) ? state.claims.map((row: unknown) => Array.isArray(row) ? nfkc(row[5]) : "") : [])].filter(Boolean));
  for (const id of new Set(offers.flatMap(offer => offer.figureIds))) {
    const observation = (state.observations as Obj[]).find(o => plain(o) && o.figureId === id);
    const holistic: string[] = (Array.isArray(observation?.holistic) ? observation!.holistic : []).map((h: Obj) => h?.construal).filter((n: unknown): n is string => typeof n === "string" && n.length <= 80);
    const rotation = rotationOfFigure(figuresOf(turn.memo).find(figure => figure.id === id));
    const nouns = rotation ? nameNouns(rotation).filter(n => n.length <= 80) : [];
    const pub: string[] = (Array.isArray(state.publicNames) ? state.publicNames : []).filter((n: Obj) => plain(n) && (n.figureId === null || n.figureId === id)).map((n: Obj) => n.name);
    const offered = offers.filter(offer => offer.figureIds.includes(id)).map(offer => offer.value);
    const rank = (name: string): number => holistic.includes(name) ? 0 : nouns.includes(name) ? 1 : pub.includes(name) ? 2 : -1;
    const ranks = offered.map(rank);
    if (ranks.some(r => r < 0) || ranks.some((r, i) => i > 0 && r < ranks[i - 1])) return false;
    const status = plain(state.figures) && plain(state.figures["f" + slots.indexOf(id)]) ? state.figures["f" + slots.indexOf(id)].status : undefined;
    if (status === "agreed" || status === "deferred") continue;
    if (nouns.some(noun => !offered.includes(noun) && !taken.has(nfkc(noun)) && !pub.includes(noun))) return false;
  }
  return true;
}
/** A Jev request (any phase): the memory's legend and layer in its state, the sentences of its questions. */
export function rotationJevMatches(turn: RotationTurn, payload: Obj, texts: RotationTexts): boolean {
  const state = parse(payload.state), questions: Obj = plain(payload.questions) ? payload.questions : {};
  const hasObservations = !!state && Array.isArray(state.observations);
  if (!turn.carried) {
    const words = Object.values<any>(questions).flatMap(q => plain(q) ? [String(q.instructions), ...Object.values<any>(plain(q.criteria) ? q.criteria : {}).map(String)] : []);
    return !stray(words.join("\n")) && !(state && (Object.hasOwn(state, "rotationLegend") ||
      hasObservations && state.observations.some((o: unknown) => plain(o) && Object.hasOwn(o, "rotation"))));
  }
  if (!state) return false;
  if (hasObservations) {
    const keys = Object.keys(state);
    if (keys.filter(key => key === "rotationLegend").length !== 1 || keys[keys.indexOf("observations") - 1] !== "rotationLegend" ||
        state.rotationLegend !== ROTATION_LEGEND_NOUNS || !layerOk(turn, state.observations, "figureId", "nouns")) return false;
  } else if (Object.hasOwn(state, "rotationLegend")) return false;
  for (const [key, question] of Object.entries<any>(questions)) {
    if (!plain(question) || typeof question.instructions !== "string" || !plain(question.criteria)) return false;
    const instructions: string = question.instructions, criteria: Obj = question.criteria;
    if (!hasObservations) {
      if (stray(instructions) || Object.values<any>(criteria).some(c => stray(String(c)))) return false;
      continue;
    }
    if (key === "feature") return false; // a feature question with a rotation memory belongs to the earlier lines of text, which this version does not have
    const carriesCommon = instructions.includes(COMMON_STEM) || instructions.includes(COMMON_AFTER);
    const matchesUse = key === "human_referent" || key === "target";
    if (count(instructions, COMMON_DIFFERENT_CONSTRUAL) !== 0 || count(instructions, COMMON_DIFFERENT_CONSTRUAL_ROTATION) !== (carriesCommon ? 1 : 0) ||
        instructions.includes(COMMON_AFTER) && !instructions.includes(COMMON_DIFFERENT_CONSTRUAL_ROTATION + COMMON_AFTER) ||
        count(instructions, ROTATION_MATCH_USE) !== (matchesUse ? 1 : 0) ||
        matchesUse && !instructions.endsWith(ROTATION_MATCH_USE) && !instructions.endsWith(ROTATION_MATCH_USE + "\n" + texts.terminology) ||
        stray(instructions, [COMMON_DIFFERENT_CONSTRUAL_ROTATION, ROTATION_MATCH_USE])) return false;
    if (key === "action" ? !actionCriteriaOk(state, criteria, texts) : Object.values<any>(criteria).some(c => stray(String(c)))) return false;
    if (key === "name" && !nameCandidatesOk(turn, state, criteria)) return false;
  }
  return true;
}

/** A Luna request: what its phase carries of the memory when the turn carries it, nothing of it otherwise. */
export function rotationLunaMatches(turn: RotationTurn, phase: string, payload: Obj): boolean {
  const messages: Obj[] = Array.isArray(payload.messages) ? payload.messages.filter(plain) : [];
  const text = (m: Obj | undefined): string => typeof m?.content === "string" ? m.content : "";
  if (!turn.carried) return !messages.some(m => stray(text(m)));
  const prompt = text(messages[0]);
  if (phase === "local_extraction" || phase === "ai_extraction") {
    const use = phase === "local_extraction" ? EXTRACTION_ROTATION_USE : AI_EXTRACTION_ROTATION_USE;
    const context = contextAt(messages, 1);
    if (count(prompt, use) !== 1 || stray(prompt, phase === "ai_extraction" ? [use, ROTATION_FEATURE_SOURCES] : [use]) || count(prompt, ROTATION_FEATURE_SOURCES) > 1 ||
        !context || context.end !== messages.length) return false;
    const state = context.value, keys = Object.keys(state);
    // local extraction: { ...context, rotationLegend, observations }; AI extraction: { ...snapshot, rotationLegend } (the snapshot already holds observations, so the legend is last)
    const order = phase === "local_extraction" ? keys.at(-2) === "rotationLegend" && keys.at(-1) === "observations" : keys.at(-1) === "rotationLegend" && keys.includes("observations");
    return order && state.rotationLegend === ROTATION_LEGEND_NOUNS && plain(state.observations) && layerOk(turn, state.observations.figures, "id", "nouns");
  }
  if (phase === "generation") {
    const instructions = text(messages[1]);
    if (!GENERATION_ROTATION_EDITS.every(([from, to]) => count(instructions, to) === 1 && count(instructions, from) === (to.includes(from) ? 1 : 0))) return false;
    const at = messages.findIndex((_, i) => contextAt(messages, i)?.value.scope === "private_observations_not_ground_truth");
    const memo = at < 0 ? null : contextAt(messages, at);
    if (!memo) return false;
    const keys = Object.keys(memo.value);
    if (keys[0] !== "scope" || keys[1] !== "rotationLegend" || keys[2] !== "memo" || memo.value.rotationLegend !== ROTATION_LEGEND_ROLES ||
        !plain(memo.value.memo) || !layerOk(turn, memo.value.memo.figures, "id", "roles")) return false;
    // The edits' own sentences sit in the instructions, the roles legend in the memo message(s), the sources line in the action message; nowhere else.
    return messages.every((m, i) => !stray(text(m), i === 1 ? [GENERATION_ROTATION_EDITS[1][1], GENERATION_ROTATION_EDITS[4][1], GENERATION_ROTATION_EDITS[5][1]]
      : i >= at && i < memo.end ? [ROTATION_LEGEND_ROLES] : i === 2 ? [ROTATION_FEATURE_SOURCES] : [])) &&
      messages.reduce((n, m) => n + count(text(m), ROTATION_FEATURE_SOURCES), 0) <= 1;
  }
  if (phase === "observation_targeted") {
    const context = contexts(messages, 1).find(c => Array.isArray(c.figureIds));
    const shown = context ? figuresOf(turn.memo).filter(figure => context.figureIds.includes(figure.id)) : [];
    // The figures asked for decide: a request for figures without the memory keeps the earlier bytes.
    if (!context || !carriesRotation({ figures: shown })) return !messages.some(m => stray(text(m))) && !(context && Object.hasOwn(context, "rotationLegend"));
    return count(prompt, REOBSERVATION_ROTATION_USE) === 1 && prompt.endsWith("\n" + REOBSERVATION_ROTATION_USE) && !stray(prompt, [REOBSERVATION_ROTATION_USE]) &&
      Object.keys(context).join(",") === "figureIds,issue,ownAnchors,rotationLegend,figures" && context.rotationLegend === ROTATION_LEGEND_NOUNS &&
      layerOk(turn, context.figures, "id", "nouns", context.figureIds);
  }
  return !messages.some(m => stray(text(m)));
}

/** The re-observation topic a decision asked for: the memory's topic sentence of the aspect and the human utterance of the turn (at most 160 characters). */
export function rotationObserveMatches(turn: RotationTurn, decisions: unknown, human: unknown): boolean {
  if (!turn.carried || !Array.isArray(decisions)) return true;
  return decisions.every(decision => {
    const observe = plain(decision) && plain(decision.observe) ? decision.observe : null;
    if (!observe) return true;
    const topic = typeof observe.aspect === "string" && Object.hasOwn(ROTATION_OBSERVE_TOPICS, observe.aspect) ? ROTATION_OBSERVE_TOPICS[observe.aspect] : undefined;
    return topic !== undefined && typeof human === "string" && observe.question === topic + "\n今回の公開人間発話（引用）: " + human.slice(0, 160);
  });
}

/** The prompt an AI extraction request may carry: the earlier prompt with the memory's sentence (and, for visual features, its sources line) where the request builder puts them. */
export function rotationAiPrompt(turn: RotationTurn, plainPrompt: string, visualPrompt: string, visualSources: string, visual: boolean): string | null {
  if (!turn.carried) return visual ? visualPrompt : plainPrompt;
  if (!visual) return plainPrompt + "\n" + AI_EXTRACTION_ROTATION_USE;
  const head = plainPrompt + "\n" + visualSources;
  return visualPrompt.startsWith(head) ? plainPrompt + "\n" + AI_EXTRACTION_ROTATION_USE + "\n" + visualSources + "\n" + ROTATION_FEATURE_SOURCES + visualPrompt.slice(head.length) : null;
}
