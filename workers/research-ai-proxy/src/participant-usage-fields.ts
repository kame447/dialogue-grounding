/** Numeric metadata for an identity-verified upstream response on the private binding. */
export type VerifiedParticipantUsage = {
  model: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export function verifiedParticipantUsage(model: string, value: unknown): VerifiedParticipantUsage {
  const usage = value && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : {};
  const tokens = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  return {
    model,
    costUsd: typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null,
    inputTokens: tokens(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: tokens(usage.completion_tokens ?? usage.output_tokens),
  };
}
