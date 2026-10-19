// Research-only grounding-evidence judge (Jev, two closed-set axes, shadow use).
// The vocabulary, criteria, instructions and model ID are server-owned; clients
// send only { purpose, state }. Choice scores are relative, uncalibrated model
// scores, never the probability that the AI identified the correct target.
import { OPENROUTER_DECISIONS_URL } from "./decisions.mjs";

export { OPENROUTER_DECISIONS_URL };

export const GROUNDING_MODELS = Object.freeze({
  grounding_jev: "typesafe/jev-1.14",
});
export type GroundingPurpose = keyof typeof GROUNDING_MODELS;

export type IdentificationEvidence = "supported" | "insufficient" | "contradicted" | "unknown";
export type NameAgreementEvidence = "agreed" | "unclear" | "not_agreed" | "no_name" | "unknown";

// Recorded with every verdict. v1 (2026-10-19): name axis agreed/unclear/not_agreed/unknown, where
// "no name yet" fell under not_agreed. v2: no_name is its own level (researcher-approved option 3).
export const GROUNDING_CRITERIA_VERSION = "grounding-criteria/v2";
export type GroundingAxis = "identification" | "name_agreement";

// Each criterion leads with short alternative phrasings of the level, then the
// evidence rule. Luna's hypothesis is never evidence on its own (see instructions).
export const IDENTIFICATION_CRITERIA: Readonly<Record<IdentificationEvidence, string>> = Object.freeze({
  supported: "裏付けあり（独立に一致／確認済み）。公開対話で、相手自身の発話が判定対象の図形を一つに絞れる識別的な特徴（尖りや部分の数・大小・くぼみ・細長さ等）を述べてAI側の特徴と一致する、またはAIが示した識別特徴を相手が明示的に肯定しており、どちらにも矛盾する記述がない。",
  insufficient: "根拠不足（未確認／見立てだけ）。対象を一つに絞る公開上の根拠がない。見立て（何に見えるか）の類似、相槌、「わかります」「はい」だけ、またはAI側の未検証の仮説だけが根拠である。",
  contradicted: "矛盾あり（食い違い／否定）。相手が述べた特徴・数・部分がAI側の判定対象の特徴と食い違う、相手が否定・訂正した、同じ説明が別の図形にも当てはまると公開上示された、または同じ呼び名が別の図形に使われている。",
  unknown: "判定不能（入力不足）。公開発話がない・判定対象がどの図形か読み取れない・画像を見なければ判断できず公開の記述もない等、与えられた情報からは判断できない。",
});

// Judged from public utterances only, per target figure, by either party. Researcher rule (2026-10-19,
// superseding an earlier reading): a 見立て or visual impression (「鳥みたい」) serves identification and is
// NOT a naming proposal; only an explicit proposal (「『鳥』と呼びませんか」) puts a name on the table. A
// tentative label (仮称) counts as a proposal only when the context shows it is offered as this figure's name.
export const NAME_AGREEMENT_CRITERIA: Readonly<Record<NameAgreementEvidence, string>> = Object.freeze({
  agreed: "合意済（共同採用／呼び名が決まった）。判定対象の図形について明示的に提案された名称を、他方が公開発話で採用すると明示した（「それにしましょう」「〇〇でいいですね」等）。返答がない・空欄・相槌だけは合意ではない。その後に別案・留保・撤回が残っていない。",
  unclear: "提案中・未確定（名前の提案はあるが共同採用は未確定）。判定対象の図形について、どちらかが名前として明示的に提案した（「〇〇と呼びませんか」「〇〇にしましょうか」「名前は〇〇で」、または文脈上この図形の名前として出された仮称）が、他方の採用がまだ明示されていない。提案に対して、返答がない、相槌や「わかります」だけ、見立てへの同意だけが返った、または「とりあえず」「仮に」等の留保付きで応じた場合を含む。提案がなく見立ての共有だけなら unclear ではなく no_name。",
  not_agreed: "不採用（拒否／競合／撤回）。判定対象の図形について名前が明示的に提案されたが、他方が明示的に拒否・否定した、別の名前を対案に出して競合が解消していない、提案者が撤回した、またはその名前が別の図形に割り当てられてこの図形には採用されていない。名前の提案が一度もない場合は選ばない。",
  no_name: "名前の提案なし（見立てだけ／形の説明だけ）。判定対象の図形について、名前としての明示的な提案が公開対話にまだ一度もない。「鳥みたい」「船っぽい形がある？」のような見立て・印象の共有は対象を特定するためのもので名前の提案ではないため、それだけならここに入る。形の幾何的な説明（「三角が二つある」「とがっている」）も同じ。別の図形について出た名前はこの判定を妨げない。AIの作業メモ・aiSideClaims・aiMemory にしかない候補名は数えない。",
  unknown: "判定不能（入力不足／対象を参照できない）。公開発話がない、または判定対象がどの図形か読み取れず、名前の提案の有無も判断できない。対象が読み取れて名前の提案がないなら unknown ではなく no_name。",
});

export const GROUNDING_LEVELS = Object.freeze({
  identification: Object.freeze(Object.keys(IDENTIFICATION_CRITERIA)) as readonly IdentificationEvidence[],
  name_agreement: Object.freeze(Object.keys(NAME_AGREEMENT_CRITERIA)) as readonly NameAgreementEvidence[],
});

export const GROUNDING_MAX_STATE_CHARS = 20_000;

/** Off unless RESEARCH_GROUNDING_ENABLED is exactly "true" and the OpenRouter secret is present. */
export function groundingConfig(env: { RESEARCH_GROUNDING_ENABLED?: unknown; OPENROUTER_DECISIONS_API_KEY?: unknown }) {
  return {
    enabled: env.RESEARCH_GROUNDING_ENABLED === "true",
    keyReady: typeof env.OPENROUTER_DECISIONS_API_KEY === "string" && env.OPENROUTER_DECISIONS_API_KEY.startsWith("sk-or-"),
  };
}

const COMMON_INSTRUCTIONS = [
  "二者がそれぞれ自分の画面で異なる配置・向きの同じ6図形を見ながら、同じ図形に同じ名前を付ける共同命名課題です。",
  "あなたは対話の参加者ではなく、公開対話の証拠を判定する独立の判定者です。判定は次のAI発話の直前の時点についてのものです。",
  "aiSideClaims はAI側のモデルが自分の画像から推定した未検証の仮説です。仮説そのものを証拠として数えず、公開対話（publicDialogue）の中に独立した裏付けがあるかだけを判定してください。",
  "aiOwnNotes・aiPriorActsOnTarget・aiMemory も、AI側の非公開の作業メモや解釈の記録であり、証拠ではありません。正解表でも、相手と照合済みの事実でもありません。",
  "AI自身の過去の公開発話は相手に伝わった内容ですが、相手の発話による裏付けとは区別してください。",
  "見立ての類似（同じものに見えると言い合うこと）は対象の同定でも名称の合意でもありません。相槌や「わかります」だけを裏付けや合意として扱わないでください。",
  "対象の同定と名称の合意は独立に判定してください。名称に合意していても対象の同定が矛盾している場合や、同定できていても名称が決まっていない場合があります。",
  "AI側の画像や相手の画像は渡されません。テキストから判断できない場合は unknown を選んでください。",
];

export type DecisionsChoiceQuestion = { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> };
export type GroundingPayload = {
  model: string;
  state: string;
  questions: { identification: DecisionsChoiceQuestion; name_agreement: DecisionsChoiceQuestion };
};

/** Validates the client body ({purpose, state} only) and builds the fixed upstream request. */
export function buildGroundingPayload(body: unknown): GroundingPayload | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["purpose", "state"].includes(key)) ||
      typeof record.purpose !== "string" || !Object.hasOwn(GROUNDING_MODELS, record.purpose) ||
      typeof record.state !== "string" || !record.state.trim() ||
      record.state.length > GROUNDING_MAX_STATE_CHARS) return null;
  return {
    model: GROUNDING_MODELS[record.purpose as GroundingPurpose],
    state: record.state.trim(),
    questions: {
      identification: {
        type: "choice",
        instructions: [...COMMON_INSTRUCTIONS,
          "問: 判定対象の図形（aiSideClaims の対象、なければ直近で話題の図形）について、相手とAIが同じ図形を指していることの公開対話上の証拠はどの段階ですか。"].join("\n"),
        criteria: IDENTIFICATION_CRITERIA,
      },
      name_agreement: {
        type: "choice",
        instructions: [...COMMON_INSTRUCTIONS,
          "問: 判定対象の図形について、名称（識別可能な呼び名）を両者が共同で採用したことの公開対話上の証拠はどの段階ですか。名称が正しい図形を指しているかはこの問では判定しません。",
          "公開対話の発話だけから判断してください。名称がこの図形について出たのか、別の図形について出たのかを区別してください。見立てや印象の共有（「〇〇みたい」）は対象の特定のためのもので、名前の提案ではありません。名前の明示的な提案がないこと（no_name）、提案はあるが共同採用が未確定であること（unclear）、提案が採用されなかったこと（not_agreed）を区別してください。"].join("\n"),
        criteria: NAME_AGREEMENT_CRITERIA,
      },
    },
  };
}

export type AxisVerdict<Level extends string> = { level: Level; scores: Record<Level, number>; confidence: number | null };
export type GroundingVerdictBody = {
  purpose: GroundingPurpose;
  model: string;
  provider: string | null;
  id: string | null;
  identification: AxisVerdict<IdentificationEvidence>;
  nameAgreement: AxisVerdict<NameAgreementEvidence>;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  criteriaVersion: typeof GROUNDING_CRITERIA_VERSION;
};

/** Exact model or a dated snapshot of it (model-YYYYMMDD). */
export function isGroundingModel(value: unknown, requested: string): value is string {
  return typeof value === "string" && (value === requested ||
    value.startsWith(requested + "-") && /^[0-9]{8}$/.test(value.slice(requested.length + 1)));
}

/** Closed-set axis answer: the choice and a score for every level, nothing else. */
export function validateAxis<Level extends string>(answer: unknown, levels: readonly Level[], expectType = true): AxisVerdict<Level> | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const value = answer as Record<string, unknown>;
  if (expectType && value.type !== "choice") return null;
  const choice = value.choice ?? value.level;
  const scores = value.probabilities ?? value.scores;
  const confidence = value.confidence ?? null;
  if (typeof choice !== "string" || !(levels as readonly string[]).includes(choice) ||
      !scores || typeof scores !== "object" || Array.isArray(scores) ||
      Object.keys(scores).length !== levels.length ||
      !levels.every((level) => {
        const score = (scores as Record<string, unknown>)[level];
        return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1;
      }) ||
      (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
    return null;
  }
  const typedScores = scores as Record<Level, number>;
  return {
    level: choice as Level,
    scores: Object.fromEntries(levels.map((level) => [level, typedScores[level]])) as Record<Level, number>,
    confidence: confidence as number | null,
  };
}

/** Upstream Decisions response -> the only fields the Worker returns. */
export function sanitizeGroundingVerdict(data: unknown, requestedModel: string, purpose: GroundingPurpose): GroundingVerdictBody | null {
  if (!data || typeof data !== "object") return null;
  const value = data as { model?: unknown; provider?: unknown; id?: unknown; answers?: Record<string, unknown>; usage?: Record<string, unknown> };
  if (!isGroundingModel(value.model, requestedModel) || !value.answers || typeof value.answers !== "object") return null;
  const identification = validateAxis(value.answers.identification, GROUNDING_LEVELS.identification);
  const nameAgreement = validateAxis(value.answers.name_agreement, GROUNDING_LEVELS.name_agreement);
  if (!identification || !nameAgreement) return null;
  const nonnegative = (raw: unknown) => typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
  const metadata = (raw: unknown, pattern: RegExp) => typeof raw === "string" && !/sk-/i.test(raw) && pattern.test(raw) ? raw : null;
  return {
    purpose,
    model: value.model,
    provider: metadata(value.provider, /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/),
    id: metadata(value.id, /^gen-[A-Za-z0-9_-]{1,124}$/),
    identification,
    nameAgreement,
    usage: {
      inputTokens: nonnegative(value.usage?.input_tokens),
      outputTokens: nonnegative(value.usage?.output_tokens),
      costUsd: nonnegative(value.usage?.cost),
    },
    // Server-owned; never taken from the upstream or the client.
    criteriaVersion: GROUNDING_CRITERIA_VERSION,
  };
}
