// Research-only, text-first comparison. Model IDs and choice vocabulary are server-owned.
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DECISION_MODELS = Object.freeze({
  decision_jev: "typesafe/jev-1.14",
  decision_luna: "openai/gpt-6-luna-decisions",
});

export const ACTION_CRITERIA = Object.freeze({
  accept: "相手の発話を受け止める。ただし対象の同定・名称の合意はまだ確定しない。",
  propose_name: "自分が見ている図形について呼び名を候補として提案する。合意ではない。",
  confirm: "対象の取り違えを防ぐため、識別できる形の特徴を1つ確かめる。",
  repair: "以前の対象対応または合意済み名称について、明示的に訂正する。",
  defer: "同じ未解決問題を扱いながら、採否や理解の判断を保留する。",
  revisit: "前に保留した問題を、解決のため再び取り上げる。",
  agree: "同じ対象を識別でき、相手にも名称の共同採用意思があるときに合意する。",
  move_on: "未解決問題を一旦保留したまま、別の対象や論点へ移る。",
  close: "課題終了を相手に相談する。",
});

export const DECISION_ACTIONS = Object.freeze(Object.keys(ACTION_CRITERIA));
const MAX_STATE_CHARS = 20_000;

export function decisionConfig(env) {
  return {
    enabled: env.RESEARCH_DECISIONS_ENABLED === "true",
    keyReady: typeof env.OPENROUTER_DECISIONS_API_KEY === "string" &&
      env.OPENROUTER_DECISIONS_API_KEY.startsWith("sk-or-"),
  };
}

export function buildDecisionPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["purpose", "state"].includes(key)) ||
      typeof body.purpose !== "string" || !Object.hasOwn(DECISION_MODELS, body.purpose) ||
      typeof body.state !== "string" || !body.state.trim() ||
      body.state.length > MAX_STATE_CHARS) return null;

  return {
    model: DECISION_MODELS[body.purpose],
    state: body.state.trim(),
    questions: {
      action: {
        type: "choice",
        instructions: [
          "二者のタングラム図形共同命名における次の発話の行動を選んでください。",
          "相手の見立て、対象の同定、名称の合意を区別してください。",
          "相槌や印象の類似だけで合意せず、同定と共同採用の根拠が不足する場合は保留・確認・受け止め等を選べます。",
          "ただし、根拠が十分なら必要以上の質問をしないでください。",
          "課題条件として与えられた確認優先／曖昧さ許容の方略を尊重してください。",
        ].join("\n"),
        criteria: ACTION_CRITERIA,
      },
    },
  };
}

export function sanitizeDecision(data, requestedModel, purpose) {
  if (!data || typeof data !== "object" || typeof data.model !== "string" ||
      !(data.model === requestedModel || data.model.startsWith(requestedModel + "-") &&
        /^[0-9]{8}$/.test(data.model.slice(requestedModel.length + 1))) ||
      data.answers?.action?.type !== "choice") return null;

  const { choice, probabilities, confidence } = data.answers.action;
  if (!DECISION_ACTIONS.includes(choice) ||
      !probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) ||
      Object.keys(probabilities).length !== DECISION_ACTIONS.length ||
      !DECISION_ACTIONS.every((key) => Number.isFinite(probabilities[key]) &&
        probabilities[key] >= 0 && probabilities[key] <= 1) ||
      (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
    return null;
  }
  const usage = data.usage;
  const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null;
  return {
    purpose,
    model: data.model,
    action: choice,
    probabilities: Object.fromEntries(DECISION_ACTIONS.map((key) => [key, probabilities[key]])),
    confidence: confidence ?? null,
    usage: {
      inputTokens: nonnegative(usage?.input_tokens),
      costUsd: nonnegative(usage?.cost),
    },
  };
}
