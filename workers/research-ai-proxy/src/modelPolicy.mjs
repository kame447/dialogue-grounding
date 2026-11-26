const MODEL_KEYS = Object.freeze({
  dialogue_turn: "DIALOGUE_MODEL",
  visual_observation: "VISION_MODEL",
  // Comparison only: a candidate model for the dialogue utterance. Never used by a participant path or by the production dialogue_turn purpose.
  dialogue_turn_candidate: "DIALOGUE_CANDIDATE_MODEL",
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
