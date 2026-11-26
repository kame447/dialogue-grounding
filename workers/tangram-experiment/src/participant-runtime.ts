import { ParticipantUsageLedger, type ParticipantDispatchResult } from '../../../dialogue-model/runtime/web/participant-usage.ts';
import { PARTICIPANT_USAGE_ONLY } from '../../../dialogue-model/runtime/web/participant-usage-policy.ts';
import { MODEL_CONTRACT_V2 } from '../../../dialogue-model/runtime/model-identity-contract.ts';
import { createChatClient } from '../../../dialogue-model/runtime/client.mjs';
import { NamingTaskError } from '../../../dialogue-model/runtime/naming-error.mjs';
import { createJevDecisionClient, type JevDecisionClientOptions } from '../../../dialogue-model/runtime/decision/jev-decision.ts';
import { createJevLocalTestClassifier } from '../../../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createWorkerTerraObserver, type WorkerTerraCache } from '../../../dialogue-model/runtime/observation/worker-terra-observer.ts';
import type { InitialObservationGeneration } from '../../../dialogue-model/runtime/observation/initial-observation-generation.ts';
import type { ObservationInput } from '../../../dialogue-model/runtime/observation/contract.ts';
import { ENGINEERING_LIMITS, RunBudget, type BudgetLimits } from '../../../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { participantLedgerFetch, type JevResearchOptions, type JevResearchLedger } from '../../../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { participantGenerationPhase, requireExactParticipantModel, validateParticipantModelPin, type ParticipantModelPin } from '../../../dialogue-model/runtime/v2/participant-model-pin.ts';
import { researchTrialProfileV3, RESEARCH_TRIAL_PROFILE_V1 } from '../../../dialogue-model/runtime/v2/research-profile.ts';
import { RESEARCH_MAX_DEADLINE_MS, RESEARCH_MAX_LUNA_ATTEMPT_MS } from '../../../dialogue-model/runtime/v2/research-timeouts.ts';

type Dispatch = (payload: unknown, expectedModelId: string) => Promise<ParticipantDispatchResult>;
export interface ParticipantService {
  participantPolicy(): Promise<unknown>;
  participantChat: Dispatch;
  participantChoices: Dispatch;
  participantUsagePolicy?(): Promise<unknown>;
  participantUsageChat?: Dispatch;
  participantUsagePolicyV2?(): Promise<unknown>;
  participantUsageGeneration?: Dispatch;
  participantUsageChoices?: Dispatch;
  participantInitialObservationPolicy?(): Promise<unknown>;
}

const profile = researchTrialProfileV3({ timeoutMs: null, maxCompletionTokens: null }, {
  ...RESEARCH_TRIAL_PROFILE_V1.timeouts,
  // The first 6-figure observation by the vision model takes longer than the research harness default of 20 s. The deadline must
  // not undercut the proxy's own 85 s upstream deadline: a shorter one fails the start while the Terra call is still running and later settles.
  observationMs: RESEARCH_MAX_LUNA_ATTEMPT_MS,
  // Local grounding and the AI-public extraction share one deadline per turn (extraction + function + support). The E2E-validated value is 45 s;
  // measured worst cases were 16.6 s and 17.0 s of Luna extraction alone, too close to the 20 s default for long dialogues.
  localMs: 45000,
  lunaAttemptMs: RESEARCH_MAX_LUNA_ATTEMPT_MS,
  trialMs: ENGINEERING_LIMITS.trialMs,
});
const researchLimits = { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS };

async function requireWorkerInitialObservationGeneration(proxy: ParticipantService | undefined,
  generation: InitialObservationGeneration): Promise<void> {
  if (await proxy?.participantInitialObservationPolicy?.() !== generation) throw new NamingTaskError('ai_unavailable');
}

export async function workerParticipantPolicy(proxy: ParticipantService | undefined, usageOnly = false,
  initialObservationGeneration?: InitialObservationGeneration,
  schemaVersion: ParticipantModelPin['schemaVersion'] = 'participant_model_pin_v1') {
  try {
    if (typeof proxy?.participantPolicy !== 'function' || typeof proxy.participantChat !== 'function' ||
        typeof proxy.participantChoices !== 'function') throw new Error();
    if (usageOnly && (typeof proxy.participantUsagePolicy !== 'function' ||
        typeof proxy.participantUsageChat !== 'function' || typeof proxy.participantUsageChoices !== 'function')) throw new Error();
    const terraGeneration = schemaVersion === 'participant_model_pin_v2';
    if (terraGeneration && (!usageOnly || typeof proxy.participantUsagePolicyV2 !== 'function' ||
        typeof proxy.participantUsageGeneration !== 'function')) throw new Error();
    const raw = await (terraGeneration ? proxy.participantUsagePolicyV2!()
      : usageOnly ? proxy.participantUsagePolicy!() : proxy.participantPolicy());
    const pin = validateParticipantModelPin(structuredClone(raw));
    if (pin.schemaVersion !== schemaVersion || !MODEL_CONTRACT_V2.acceptedReturned.includes(pin.jevModelId)) throw new Error();
    if (initialObservationGeneration) await requireWorkerInitialObservationGeneration(proxy, initialObservationGeneration);
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

export function createWorkerParticipantRuntime({ pin, own, proxy, cache, limits, usage, initialObservationGeneration }: {
  pin: ParticipantModelPin;
  own: ObservationInput;
  proxy: ParticipantService;
  cache: WorkerTerraCache;
  initialObservationGeneration?: InitialObservationGeneration;
} & ({ limits: Readonly<BudgetLimits>; usage?: never } | { limits?: never; usage: ParticipantUsageLedger })) {
  if (pin.schemaVersion === 'participant_model_pin_v2' && !usage) throw new NamingTaskError('invalid_options');
  const ledger = usage ?? new RunBudget(limits!);
  const chat: Dispatch = (payload, expected) => usage ? proxy.participantUsageChat!(payload, expected) : proxy.participantChat(payload, expected);
  const choices: Dispatch = (payload, expected) => usage ? proxy.participantUsageChoices!(payload, expected) : proxy.participantChoices(payload, expected);
  function meteredFetch(dispatch: Dispatch, provider: 'jev' | 'luna' | 'terra', expected: string): typeof fetch {
    if (ledger instanceof RunBudget) {
      if (provider === 'terra') throw new NamingTaskError('invalid_options');
      return participantLedgerFetch(ledger, provider, pin.lunaModelId, boundFetch(dispatch, expected, ledger));
    }
    return async (_url, init) => {
      if (init?.method?.toUpperCase() !== 'POST') throw new NamingTaskError('ai_unavailable');
      const { status, data } = await ledger.dispatch(provider, dispatch, JSON.parse(String(init.body)), init.signal);
      if (!Number.isInteger(status) || status < 200 || status > 599) throw new NamingTaskError('ai_unavailable');
      return status === 200 ? Response.json(data) :
        Response.json({ error: 'upstream_error' }, { status: status >= 400 ? status : 502 });
    };
  }
  const chatConfig = { provider: 'cloudflare', baseUrl: 'https://internal.proxy/v1', purpose: 'dialogue_turn',
    apiKey: 'service-binding-only', timeoutMs: profile.timeouts.lunaAttemptMs };
  const lunaClient = createChatClient(chatConfig, meteredFetch(chat, 'luna', pin.lunaModelId));
  const terraClient = pin.schemaVersion === 'participant_model_pin_v2' ? createChatClient(chatConfig,
    meteredFetch((payload, expected) => proxy.participantUsageGeneration!(payload, expected), 'terra', pin.generationModelId)) : null;
  const client = terraClient ? {
    complete(messages: Parameters<typeof lunaClient.complete>[0],
      options?: Parameters<typeof lunaClient.complete>[1] & { phase?: string }) {
      return (participantGenerationPhase(options?.phase) ? terraClient : lunaClient).complete(messages, options);
    },
  } : lunaClient;
  const jevFetch = meteredFetch(choices, 'jev', pin.jevModelId);
  const transport: JevDecisionClientOptions = {
    // The native choice parser requires this format. boundFetch sends only the JSON body over the private RPC.
    readKey: async () => 'sk-or-service-binding-only-0000',
    fetchImpl: jevFetch,
    timeoutMs: profile.timeouts.decisionMs,
    researchLimits,
    ...(usage ? { usagePolicy: PARTICIPANT_USAGE_ONLY } : { costCapUsd: limits!.jevUsd }),
  };
  const localTransport = usage ? {
    ...transport,
    fetchImpl: ((url, init) => usage.runPhase('local', () => jevFetch(url, init))) as typeof fetch,
  } : transport;
  const aiPublicTransport = usage ? {
    ...transport,
    fetchImpl: ((url, init) => {
      const questions = JSON.parse(String(init?.body)).questions;
      const phase = Object.keys(questions).some(key => key.endsWith('_support')) ? 'ai_support' : 'ai_function';
      return usage.runPhase(phase, () => jevFetch(url, init));
    }) as typeof fetch,
  } : transport;
  const terra = createWorkerTerraObserver({
    modelPin: pin, own, cache, timeoutMs: profile.timeouts.observationMs, researchLimits, initialObservationGeneration,
    visual: (payload, signal) => usage ? usage.dispatch('terra', chat, payload, signal) : chat(payload, pin.terraModelId),
    ...(usage ? { onCacheHit: () => usage.cacheHit() } : {}),
  });
  const jevResearch: JevResearchOptions<JevResearchLedger> = {
    profile, ledger,
    observer: usage ? {
      observeAll: (input, options) => usage.logical('terra', 'initial_observation', () => terra.observeAll(input, options)),
      reobserve: (input, options) => usage.logical('terra', 'reobservation', () => terra.reobserve(input, options)),
    } : terra,
    jevDecision: createJevDecisionClient({ ...transport, enabled: true, questionLayout: profile.questionLayout, participantTargetMenu: true })!,
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...localTransport, enabled: true, timeoutMs: profile.timeouts.localMs })!,
      aiPublicTransport, timeoutMs: profile.timeouts.localMs,
      researchLimits, aiPublicClaims: profile.localGrounding.aiPublicClaims,
    },
  };
  return { client, jevResearch };
}
