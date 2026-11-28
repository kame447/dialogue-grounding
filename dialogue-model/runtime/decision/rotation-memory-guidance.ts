// Prompt text for the rotation memory: an optional `rotation` on an observation figure (the same figure imagined turned, with whole and part construals).
// The legend (what the data is) is defined once here and every model call carries it once, next to the data. It describes the AI's own imagination only:
// it never mentions the partner's board, the rotation mode or which view is close to the partner, so it is byte-identical for every rotation mode.
// The partner-side task condition stays in the existing mode sentences (ROTATION_V5 ...). Each call adds only a short usage text of its own.
// A request without `rotation` on any figure never reaches this module's texts, so every earlier version keeps its bytes.

const object = (v: unknown): v is Record<string, unknown> => !!v && Object.getPrototypeOf(v) === Object.prototype;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const ID = /^[A-Za-z0-9_-]{1,16}$/u;

/** One view (the current one or a turned one): whole construals, and part candidates per region id. A confidence is written only when it is 中 or 高 (absent = 低). */
export type RotationCandidate = { noun: string; owner?: string; confidence?: "中" | "高" };
export type RotationWhole = { noun: string; posture: string; direction: string; confidence?: "中" | "高"; roles: Record<string, string> };
export type RotationView = { whole: RotationWhole[]; parts: Record<string, RotationCandidate[]> };
export type RotationRegion = { id: string; shapeName: string; areaPercent: number; at: string; tip?: string; concave?: true; adjacent: string[] };
export type ModelRotation = { regions: RotationRegion[]; current: RotationView; turned: (RotationView & { rel: 90 | 180 | 270 })[]; wholeAnywhere: boolean };

/** True when at least one figure of a memo (or of a decision input's observations) carries a rotation memory. */
export function hasRotationMemory(memo: { figures: readonly unknown[] } | undefined): boolean {
  return !!memo && Array.isArray(memo.figures) && memo.figures.some(figure => object(figure) && Object.hasOwn(figure, "rotation"));
}

export const ROTATION_MEMORY_LEGEND = "rotationは、自分の同じ図形を向きを変えて見たと想像したときの見立ての記録で、すべて仮説です。" +
  "regionsは図形の領域（id、形、面積の割合、自分の今の画面での位置at、隣り合う領域）で、領域のidで他の項目と結び付きます。" +
  "currentは今の向き、turnedは今の向きを時計回りにrel度回したと想像した向きで、どの向きも同じ形式です。" +
  "各向きのwholeは全体の見立ての配列で、noun=見立てた物、posture=その姿勢、direction=その見え方の中での向き、roles=領域idごとの役割、confidenceは中・高のときだけ付き、無ければ低です。空の配列はその向きに全体の見立てがないことです。" +
  "partsは全体の見立てとは別の、領域idごとの部分の見立ての候補です（noun、持ち主のowner）。wholeAnywhereはどれかの向きにwholeがあるかを示します。" +
  "turnedの方向や位置の語はその見え方の中の向きなので、今の画面での位置はregionsのatで言います。";

/** The key that carries the legend next to the data in a JSON state or context (once per call). */
export const ROTATION_LEGEND_KEY = "rotationLegend";

// ---- decision (Jev) ----
/** Replaces the one common-instruction sentence that sends a different construal to re-observation first. */
export const COMMON_DIFFERENT_CONSTRUAL = "AIが馬、相手が牛と呼んだだけで誤同定や名称不一致を確定しないでください。同じ図形の異なる見立てかを照合し、必要なら画像の再観察を選べます。";
export const COMMON_DIFFERENT_CONSTRUAL_ROTATION = "AIが馬、相手が牛と呼んだだけで誤同定や名称不一致を確定しないでください。同じ図形の異なる見立てかを、別の向きの見立てを含む観察メモで照合してください。";
/** Added to the action question only. */
export const ROTATION_ACTION_USE = "回転別メモ（rotation）で答えられる問いには再観察を求めず、acceptで直接答えます。今の向きに全体の見立てがなくても、別の向きの見立てや部分の候補があれば、答えの材料にできます。" +
  "相手の説明がrotationの別の向きの見立てや部分に合うと分かるときも、再観察ではなくメモとの照合で扱います。見立ての一致は候補の根拠にとどまり、対象・合意・命名の確定ではありません。" +
  "メモにない、自分の画像でしか確かめられない視覚上の事実が必要なときだけ、再観察を選びます。";
/** Added to the target question and to the partner-referent estimate. */
export const ROTATION_MATCH_USE = "相手の説明は、今の向きの見立てだけでなく、rotationの別の向きの見立てや部分の候補とも照合してください。同じ図形の別の向きの見立てに合うことは候補の根拠にとどまり、図形や名前の確定ではありません。";

/** Replaces the whole accept / request_observation criterion (including the repair-quality paragraph) of a request that carries a rotation memory: each point is stated once. */
export const ROTATION_ACCEPT_ANSWER = "相手が図形全体や見た目・特徴を尋ねたとき（複数の図形をまとめて尋ねたときを含む）は、質問を返すconfirmや部品の確認を重ねず、このacceptで観察メモ（rotationの別の向きの見立てや部分の候補を含む）に根拠のある答えを、求められた図形すべてについて直接返す。" +
  "全体の問いには全体の見立てを先に、細部の問いにはその細部を、ある・ない・不明のいずれかで答える。今の向きに全体の見立てがなくても、別の向きの見立てや部分の候補があれば答えられる。見立ては説明であり、名前の提案・採用ではない。";
export const ROTATION_ACCEPT_BACKCHANNEL = "相手の発話が相槌だけ（新しい情報も問いもない）で、直前のAI行動もacceptだった場合は同じ受け止めを繰り返さず、より具体的な説明や次に役立つ見立てがあれば返す。" +
  "見立てを否定された後などで対象がまだ特定できていないなら、観察メモに根拠のある別の説明（別の向きの見立てを含む）や弁別特徴の確認など、対象探しを進める行動を選ぶ。相槌は名称採用や対象同定の根拠にならない。問いが複数ならそれぞれに応答し、観察で分かる点と未特定の点を分ける。";
/** The observer name is written as Luna (the older request) and replaced by Terra where the request already does so. */
export const ROTATION_REQUEST_OBSERVATION = "回転別メモ（rotation）にない、自分の画像でしか確かめられない視覚上の事実（細部の形・位置・つながり）を確かめるために、図形と論点を指定してLunaへ再観察を依頼する。" +
  "回転別メモの今の向き・別の向き・部分の候補で答えられる問いや、相手の別の見立てがメモの別の向きの見立てで説明できる場合、呼び名の好みなど視覚に無関係な変更や相手にしか分からない点の解決には選ばない。" +
  "以前の観察でも不明な点を再観察し、一方の画面の方位を他方の証拠に使わない。";

// ---- generation ----
/** Applied to the finished generation instructions of a turn whose memo carries a rotation memory; every `from` must be found (checked when used). */
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

/** Candidate names a figure's rotation memory offers: the current view first, then the turned views, without repeats. */
export function rotationNameCandidates(rotation: { current: RotationView; turned: readonly RotationView[] }): string[] {
  const names: string[] = [];
  for (const view of [rotation.current, ...rotation.turned]) for (const whole of view.whole) if (!names.includes(whole.noun)) names.push(whole.noun);
  return names;
}

// ---- model-facing copy ----
function candidate(value: unknown): RotationCandidate {
  if (!object(value) || !text(value.noun, 40) || value.owner !== undefined && !text(value.owner, 40) ||
      value.confidence !== undefined && value.confidence !== "中" && value.confidence !== "高") throw new TypeError("invalid_rotation_memory");
  return { noun: value.noun, ...(value.owner !== undefined ? { owner: value.owner as string } : {}), ...(value.confidence !== undefined ? { confidence: value.confidence } : {}) };
}
function view(value: unknown): RotationView {
  if (!object(value) || !Array.isArray(value.whole) || value.whole.length > 8 || !object(value.parts)) throw new TypeError("invalid_rotation_memory");
  const whole = value.whole.map((w: unknown): RotationWhole => {
    if (!object(w) || !text(w.noun, 40) || !text(w.posture, 80) || !text(w.direction, 80) || !object(w.roles) ||
        w.confidence !== undefined && w.confidence !== "中" && w.confidence !== "高") throw new TypeError("invalid_rotation_memory");
    const roles = Object.fromEntries(Object.entries(w.roles).map(([id, role]) => {
      if (!ID.test(id) || !text(role, 80)) throw new TypeError("invalid_rotation_memory");
      return [id, role];
    }));
    return { noun: w.noun, posture: w.posture, direction: w.direction, ...(w.confidence !== undefined ? { confidence: w.confidence } : {}), roles };
  });
  const parts = Object.fromEntries(Object.entries(value.parts).map(([id, list]) => {
    if (!ID.test(id) || !Array.isArray(list) || list.length < 1 || list.length > 6) throw new TypeError("invalid_rotation_memory");
    return [id, list.map(candidate)];
  }));
  return { whole, parts };
}
/** Rebuilds a rotation memory from known keys only (nothing else can reach a prompt); throws a TypeError on a malformed value. The caller decides what a failure means. */
export function modelRotation(value: unknown): ModelRotation {
  if (!object(value) || !Array.isArray(value.regions) || !value.regions.length || value.regions.length > 12 || !Array.isArray(value.turned) || value.turned.length !== 3 ||
      typeof value.wholeAnywhere !== "boolean") throw new TypeError("invalid_rotation_memory");
  const regions = value.regions.map((r: unknown): RotationRegion => {
    if (!object(r) || !ID.test(String(r.id)) || !text(r.shapeName, 40) || typeof r.areaPercent !== "number" || !Number.isFinite(r.areaPercent) || !text(r.at, 40) ||
        r.tip !== undefined && !text(r.tip, 16) || r.concave !== undefined && r.concave !== true ||
        !Array.isArray(r.adjacent) || !r.adjacent.every((id: unknown) => typeof id === "string" && ID.test(id))) throw new TypeError("invalid_rotation_memory");
    return { id: r.id as string, shapeName: r.shapeName, areaPercent: r.areaPercent, at: r.at, ...(r.tip !== undefined ? { tip: r.tip as string } : {}),
      ...(r.concave === true ? { concave: true as const } : {}), adjacent: [...r.adjacent as string[]] };
  });
  const turned = value.turned.map((t: unknown) => {
    if (!object(t) || t.rel !== 90 && t.rel !== 180 && t.rel !== 270) throw new TypeError("invalid_rotation_memory");
    return { rel: t.rel as 90 | 180 | 270, ...view(t) };
  });
  if (new Set(turned.map(t => t.rel)).size !== 3) throw new TypeError("invalid_rotation_memory");
  return { regions, current: view(value.current), turned, wholeAnywhere: value.wholeAnywhere };
}
