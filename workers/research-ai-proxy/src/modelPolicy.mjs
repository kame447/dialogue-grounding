const MODEL_KEYS = Object.freeze({
  dialogue_turn: "DIALOGUE_MODEL",
});

export const RESEARCH_AI_PURPOSES = Object.freeze(Object.keys(MODEL_KEYS));

export function resolvePurposeModel(body, env) {
  const purpose = typeof body?.purpose === "string" ? body.purpose.trim() : "";
  if (!Object.hasOwn(MODEL_KEYS, purpose)) {
    return { error: "unsupported_purpose" };
  }

  const rawModel = env[MODEL_KEYS[purpose]];
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!model || model.length > 128 || !/^[a-zA-Z0-9._:/-]+$/.test(model)) {
    return { error: "model_unconfigured" };
  }
  return { purpose, model };
}
