import { MODEL_CONTRACT_V2 } from '../../../dialogue-model/runtime/model-identity-contract.ts';
import { createChatClient } from '../../../dialogue-model/runtime/client.mjs';
import { NamingTaskError } from '../../../dialogue-model/runtime/naming-error.mjs';
import { createJevDecisionClient } from '../../../dialogue-model/runtime/decision/jev-decision.ts';
import { createJevLocalTestClassifier } from '../../../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createWorkerTerraObserver, type WorkerTerraCache } from '../../../dialogue-model/runtime/observation/worker-terra-observer.ts';
import type { ObservationInput } from '../../../dialogue-model/runtime/observation/contract.ts';
import { ENGINEERING_LIMITS, RunBudget, type BudgetLimits } from '../../../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { participantLedgerFetch, type JevResearchOptions } from '../../../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { requireExactParticipantModel, validateParticipantModelPin, type ParticipantModelPin } from '../../../dialogue-model/runtime/v2/participant-model-pin.ts';
import { researchTrialProfileV3, RESEARCH_TRIAL_PROFILE_V1 } from '../../../dialogue-model/runtime/v2/research-profile.ts';
import { RESEARCH_MAX_DEADLINE_MS, RESEARCH_MAX_LUNA_ATTEMPT_MS } from '../../../dialogue-model/runtime/v2/research-timeouts.ts';

type Result = { status: number; data: unknown };
type Dispatch = (payload: unknown, expectedModelId: string) => Promise<Result>;
export interface ParticipantService {
  participantPolicy(): Promise<unknown>;
  participantChat: Dispatch;
  participantChoices: Dispatch;
}

const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...RESEARCH_TRIAL_PROFILE_V1.timeouts,
  lunaAttemptMs: RESEARCH_MAX_LUNA_ATTEMPT_MS,
  trialMs: ENGINEERING_LIMITS.trialMs,
});
const researchLimits = { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS };

export async function workerParticipantPolicy(proxy: ParticipantService | undefined) {
  try {
    if (typeof proxy?.participantPolicy !== 'function' || typeof proxy.participantChat !== 'function' ||
        typeof proxy.participantChoices !== 'function') throw new Error();
    const pin = validateParticipantModelPin(structuredClone(await proxy.participantPolicy()));
    if (!MODEL_CONTRACT_V2.acceptedReturned.includes(pin.jevModelId)) throw new Error();
    return { pin, proxy };
  } catch {
    throw new NamingTaskError('ai_unavailable');
  }
}

function boundFetch(dispatch: Dispatch, modelId: string, ledger: RunBudget): typeof fetch {
  return async (_url, init) => {
    const { status, data } = await dispatch(JSON.parse(String(init?.body)), modelId);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new NamingTaskError('ai_unavailable');
    if (status >= 300) {
      if ((data as { error?: unknown } | null)?.error === 'model_mismatch') {
        ledger.stop('model_mismatch');
        throw new NamingTaskError('ai_unavailable');
      }
      return Response.json({ error: 'upstream_error' }, { status: status >= 400 ? status : 502 });
    }
    try {
      requireExactParticipantModel(modelId, (data as { model?: unknown } | null)?.model);
    } catch {
      ledger.stop('model_mismatch');
      throw new NamingTaskError('ai_unavailable');
    }
    return Response.json(data);
  };
}

export function createWorkerParticipantRuntime({ pin, own, proxy, cache, limits }: {
  pin: ParticipantModelPin;
  own: ObservationInput;
  proxy: ParticipantService;
  cache: WorkerTerraCache;
  limits: Readonly<BudgetLimits>;
}) {
  const ledger = new RunBudget(limits);
  const chat: Dispatch = (payload, expected) => proxy.participantChat(payload, expected);
  const choices: Dispatch = (payload, expected) => proxy.participantChoices(payload, expected);
  const client = createChatClient({
    provider: 'cloudflare', baseUrl: 'https://internal.proxy/v1', purpose: 'dialogue_turn',
    apiKey: 'service-binding-only', timeoutMs: profile.timeouts.lunaAttemptMs,
  }, participantLedgerFetch(ledger, 'luna', pin.lunaModelId, boundFetch(chat, pin.lunaModelId, ledger)));
  const transport = {
    // The native choice parser requires this format. boundFetch sends only the JSON body over the private RPC.
    readKey: async () => 'sk-or-service-binding-only-0000',
    fetchImpl: participantLedgerFetch(ledger, 'jev', pin.lunaModelId, boundFetch(choices, pin.jevModelId, ledger)),
    timeoutMs: profile.timeouts.decisionMs,
    researchLimits,
    costCapUsd: limits.jevUsd,
  };
  const observer = createWorkerTerraObserver({
    modelPin: pin, own, cache, timeoutMs: profile.timeouts.observationMs, researchLimits,
    visual: payload => chat(payload, pin.terraModelId),
  });
  const jevResearch: JevResearchOptions = {
    profile, observer, ledger,
    jevDecision: createJevDecisionClient({ ...transport, enabled: true, questionLayout: profile.questionLayout })!,
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...transport, enabled: true, timeoutMs: profile.timeouts.localMs })!,
      aiPublicTransport: transport, timeoutMs: profile.timeouts.localMs,
      researchLimits, aiPublicClaims: profile.localGrounding.aiPublicClaims,
    },
  };
  return { client, jevResearch };
}
