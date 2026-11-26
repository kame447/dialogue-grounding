import { verifiedParticipantUsage } from './participant-usage-fields.ts';
import { MODEL_CONTRACT_V2 } from '../../../dialogue-model/runtime/model-identity-contract.ts';
// Private Service-binding transport. Never exposed through the Worker's fetch handler.
import { DECISION_MODELS, OPENROUTER_DECISIONS_URL, decisionConfig } from './decisions.mjs';
import { resolvePurposeModel } from './modelPolicy.mjs';
import { requireExactParticipantModel, validateParticipantModelPin } from '../../../dialogue-model/runtime/v2/participant-model-pin.ts';

type ParticipantEnvironment = {
  PARTICIPANT_MODEL_PIN_JSON?: string;
  RESEARCH_PROXY_TOKEN?: string;
  UPSTREAM_PROVIDER?: string;
  UPSTREAM_API_KEY?: string;
  DIALOGUE_MODEL?: string;
  VISION_MODEL?: string;
  RESEARCH_DECISIONS_ENABLED?: string;
  OPENROUTER_DECISIONS_API_KEY?: string;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null;
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const failure = (status: number, error: string) => ({ status, data: { error } });

export function configuredParticipantPin(env: ParticipantEnvironment) {
  try {
    const pin = validateParticipantModelPin(JSON.parse(env.PARTICIPANT_MODEL_PIN_JSON ?? 'null'));
    const luna = resolvePurposeModel({ purpose: 'dialogue_turn' }, env).model;
    const terra = resolvePurposeModel({ purpose: 'visual_observation' }, env).model;
    const jev = decisionConfig(env);
    if ((env.UPSTREAM_PROVIDER ?? 'openai') !== 'openai' || !env.UPSTREAM_API_KEY?.trim() ||
        (env.RESEARCH_PROXY_TOKEN?.length ?? 0) < 32 || !jev.enabled || !jev.keyReady ||
        !MODEL_CONTRACT_V2.acceptedReturned.includes(pin.jevModelId) ||
        typeof luna !== 'string' || !['gpt-6-luna', pin.lunaModelId].includes(luna) ||
        typeof terra !== 'string' || !['gpt-6.1-terra', pin.terraModelId].includes(terra)) return null;
    return pin;
  } catch { return null; }
}

const MAX_BODY = 1024 * 1024;
const label = /^[A-Za-z0-9_-]{1,128}$/u;
const imageField = /data\s*:\s*image\/|"image_url"\s*:/iu;
function choicePayload(input: unknown) {
  const body = record(input);
  if (!body || !exact(body, ['model', 'state', 'questions']) || body.model !== DECISION_MODELS.decision_jev ||
      typeof body.state !== 'string' || body.state.length > 40_000 || imageField.test(body.state)) return null;
  try { if (!record(JSON.parse(body.state))) return null; } catch { return null; }
  const questions = record(body.questions);
  if (!questions || !Object.keys(questions).length || Object.keys(questions).length > 128) return null;
  for (const [name, value] of Object.entries(questions)) {
    const question = record(value);
    const criteria = record(question?.criteria);
    if (!label.test(name) || !question || !exact(question, ['type', 'instructions', 'criteria']) || question.type !== 'choice' ||
        typeof question.instructions !== 'string' || !question.instructions.length || question.instructions.length > 40_000 ||
        !criteria || !Object.keys(criteria).length || Object.keys(criteria).length > 256 ||
        Object.entries(criteria).some(([key, criterion]) => !label.test(key) || typeof criterion !== 'string' || imageField.test(criterion))) return null;
  }
  const payload = { model: DECISION_MODELS.decision_jev, state: body.state, questions };
  const wire = JSON.stringify(payload);
  return new TextEncoder().encode(wire).byteLength <= MAX_BODY && !imageField.test(wire) ? { payload, wire } : null;
}

function choiceReply(input: unknown, questions: Record<string, unknown>, usageOnly: boolean) {
  const response = record(input);
  const raw = record(response?.answers);
  if (!raw || !exact(raw, Object.keys(questions))) return null;
  const answers: Record<string, unknown> = {};
  const probability = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  for (const [key, value] of Object.entries(questions)) {
    const criteria = Object.keys(record(record(value)?.criteria)!);
    const answer = record(raw[key]), probabilities = record(answer?.probabilities);
    if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string' || !criteria.includes(answer.choice) ||
        !probabilities || !exact(probabilities, criteria) || !Object.values(probabilities).every(probability) ||
        answer.confidence !== undefined && answer.confidence !== null && !probability(answer.confidence)) return null;
    Object.defineProperty(answers, key, { enumerable: true, value: {
      type: 'choice', choice: answer.choice, probabilities,
      ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
    } });
  }
  const usage = record(response?.usage);
  const cost = usage?.cost ?? null;
  if (!(usageOnly && cost === null) && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) return null;
  const tokens = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  const id = typeof response?.id === 'string' && /^gen-[A-Za-z0-9_-]{1,124}$/u.test(response.id) ? response.id : null;
  return { model: response?.model, id, usage: { cost, ...(usageOnly ? {
    prompt_tokens: tokens(usage?.prompt_tokens ?? usage?.input_tokens),
    completion_tokens: tokens(usage?.completion_tokens ?? usage?.output_tokens),
  } : {}) }, answers };
}

export function participantChoices(env: ParticipantEnvironment, input: unknown, expectedId: string, fetchImpl = globalThis.fetch) {
  return choices(env, input, expectedId, fetchImpl, false);
}

export function participantUsageChoices(env: ParticipantEnvironment, input: unknown, expectedId: string, fetchImpl = globalThis.fetch) {
  return choices(env, input, expectedId, fetchImpl, true);
}

async function choices(env: ParticipantEnvironment, input: unknown, expectedId: string, fetchImpl: typeof fetch, usageOnly: boolean) {
  const pin = configuredParticipantPin(env);
  if (!pin) return failure(503, 'service_unconfigured');
  if (expectedId !== pin.jevModelId) return failure(409, 'model_mismatch');
  const request = choicePayload(input);
  if (!request) return failure(400, 'invalid_request');
  const signal = AbortSignal.timeout(85_000);
  try {
    const response = await fetchImpl(OPENROUTER_DECISIONS_URL, {
      // Workers' fetch accepts only 'follow' and 'manual': redirect 'error' throws a TypeError before any request is made, so every Jev call failed at once in production.
      // 'manual' hands a redirect back unfollowed; it is not ok, so it is refused below with the credential never forwarded.
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OPENROUTER_DECISIONS_API_KEY },
      body: request.wire,
    });
    if (!response.ok) return failure(response.status === 402 || response.status === 429 ? response.status : 502, 'upstream_error');
    const raw = await response.json();
    try { requireExactParticipantModel(expectedId, record(raw)?.model); }
    catch { return failure(502, 'model_mismatch'); }
    const data = choiceReply(raw, request.payload.questions, usageOnly);
    if (!data || JSON.stringify(data).includes(env.OPENROUTER_DECISIONS_API_KEY!)) {
      const rejected = failure(502, 'invalid_upstream_response');
      return usageOnly ? { ...rejected, verifiedUsage: verifiedParticipantUsage(expectedId, record(raw)?.usage) } : rejected;
    }
    return { status: 200, data };
  } catch { return failure(signal.aborted ? 504 : 502, 'upstream_unavailable'); }
}
