import type { PreparedTrialObservationReference } from '../../../dialogue-model/runtime/v2/prepared-observations.ts';
import { ParticipantUsageLedger, type ParticipantDispatchResult } from '../../../dialogue-model/runtime/web/participant-usage.ts';
import { PARTICIPANT_USAGE_ONLY } from '../../../dialogue-model/runtime/web/participant-usage-policy.ts';
import { MODEL_CONTRACT_V2 } from '../../../dialogue-model/runtime/model-identity-contract.ts';
import { createChatClient } from '../../../dialogue-model/runtime/client.mjs';
import { NamingTaskError } from '../../../dialogue-model/runtime/naming-error.mjs';
import { createJevDecisionClient, type JevDecisionClientOptions } from '../../../dialogue-model/runtime/decision/jev-decision.ts';
import { JEV_REPAIR_QUALITY_VERSION } from '../../../dialogue-model/runtime/decision/repair-quality.ts';
import { createJevLocalTestClassifier } from '../../../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createWorkerTerraObserver, type WorkerTerraCache } from '../../../dialogue-model/runtime/observation/worker-terra-observer.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V1, INITIAL_OBSERVATION_STRUCTURED_V2,
  type InitialObservationGeneration } from '../../../dialogue-model/runtime/observation/initial-observation-generation.ts';
import type { ObservationInput } from '../../../dialogue-model/runtime/observation/contract.ts';
import { ENGINEERING_LIMITS, RunBudget, type BudgetLimits } from '../../../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { LegacyParticipantUsageLedger, participantLedgerFetch, type JevResearchOptions, type JevResearchLedger } from '../../../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { participantChatProvider, requireExactParticipantModel, validateParticipantModelPin, type ParticipantModelPin } from '../../../dialogue-model/runtime/v2/participant-model-pin.ts';
import { researchHash, researchTrialProfileV3, RESEARCH_TRIAL_PROFILE_V1 } from '../../../dialogue-model/runtime/v2/research-profile.ts';
import { RESEARCH_MAX_DEADLINE_MS, RESEARCH_MAX_LUNA_ATTEMPT_MS } from '../../../dialogue-model/runtime/v2/research-timeouts.ts';
import { SHAPE_TERMINOLOGY_GENERATION } from '../../../dialogue-model/runtime/shape-terminology.ts';
import { DEFERRED_AI_EXTRACTION_GENERATION, GENERATION_RETRY_V22, GENERATION_RETRY_V23,
  ISSUE_HANDLING_GENERATION } from '../../../dialogue-model/runtime/v2/deferred-ai-extraction.ts';

import type { BaseRecord } from '../../../dialogue-model/runtime/v2/base-assignment.ts';
import { isPilot012ParticipantDialogueProfile, participantMemoryPruneVersion, PILOT012_PARTICIPANT_PROFILE, PILOT012_V18_PARTICIPANT_PROFILE,
  PILOT012_V19_PARTICIPANT_PROFILE, PILOT012_V20_PARTICIPANT_PROFILE, PILOT012_V21_PARTICIPANT_PROFILE,
  PILOT012_V22_PARTICIPANT_PROFILE, PILOT012_V23_PARTICIPANT_PROFILE,
  type ParticipantDialogueProfile } from '../../../dialogue-model/runtime/v2/reception.ts';

type Dispatch = (payload: unknown, expectedModelId: string) => Promise<ParticipantDispatchResult>;
export interface ParticipantService {
  participantPolicy(): Promise<unknown>;
  participantChat: Dispatch;
  participantChoices: Dispatch;
  participantUsagePolicy?(): Promise<unknown>;
  participantUsageChat?: Dispatch;
  participantUsagePolicyV2?(): Promise<unknown>;
  participantUsagePolicyV3?(): Promise<unknown>;
  participantUsageGeneration?: Dispatch;
  participantUsageChoices?: Dispatch;
  participantInitialObservationPolicy?(generation?: InitialObservationGeneration): Promise<unknown>;
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
const dialogueV12 = {
  profile: researchTrialProfileV3(profile.lunaRequest, profile.timeouts, 'two_stage_v3', 'holistic_v5'),
  technicalTrial: { version: 'adaptive_repair_v3' },
  pinnedVersions: { generationRetryVersion: 'jev_generation_retry_v12', namingRestoreVersion: 'ai_name_acceptances_v1' },
  newTrialAgreeNameScopeVersion: 'scoped_v7',
} as const;

const dialogueV13P5 = {
  ...dialogueV12,
  pinnedVersions: { ...dialogueV12.pinnedVersions, generationRetryVersion: 'jev_generation_retry_v13' },
} as const;

const dialogueV13P5HumanLedMoveOn = {
  ...dialogueV13P5,
  newTrialAgreeNameScopeVersion: 'scoped_v11',
  profile: researchTrialProfileV3(profile.lunaRequest, profile.timeouts, 'two_stage_v3', 'holistic_v5', 'bypass_acceptance_v2'),
  pinnedVersions: { ...dialogueV13P5.pinnedVersions, generationRetryVersion: 'jev_generation_retry_v15' },
} as const;

const dialogueV13P5DiscriminatingConfirmation = {
  ...dialogueV13P5HumanLedMoveOn,
  pinnedVersions: { ...dialogueV13P5HumanLedMoveOn.pinnedVersions, generationRetryVersion: 'jev_generation_retry_v16' },
} as const;

const dialogueV17Pilot012 = {
  ...dialogueV13P5HumanLedMoveOn,
  newTrialAgreeNameScopeVersion: 'jev_naming_v1',
  profile: researchTrialProfileV3(profile.lunaRequest, profile.timeouts, 'two_stage_v3', 'holistic_v5',
    'bypass_acceptance_v2', JEV_REPAIR_QUALITY_VERSION),
  pinnedVersions: { ...dialogueV13P5HumanLedMoveOn.pinnedVersions, generationRetryVersion: 'jev_generation_retry_v17' },
} as const;

const dialogueV21IssueHandling = {
  ...dialogueV17Pilot012,
  newTrialAgreeNameScopeVersion: 'jev_naming_v2',
  profile: researchTrialProfileV3(profile.lunaRequest, profile.timeouts, 'two_stage_v3', 'holistic_v5',
    'bypass_acceptance_v3', JEV_REPAIR_QUALITY_VERSION),
  pinnedVersions: { ...dialogueV17Pilot012.pinnedVersions, generationRetryVersion: ISSUE_HANDLING_GENERATION },
} as const;

const dialogueV22IssueFixes = {
  ...dialogueV21IssueHandling,
  newTrialAgreeNameScopeVersion: 'jev_naming_v3',
  pinnedVersions: { ...dialogueV21IssueHandling.pinnedVersions, generationRetryVersion: GENERATION_RETRY_V22 },
} as const;

const workerDialogue = {
  participant_dialogue_v12: dialogueV12,
  participant_dialogue_v12_naming_v2: { ...dialogueV12, newTrialAgreeNameScopeVersion: 'scoped_v9' },
  participant_dialogue_v12_naming_v3: { ...dialogueV12, newTrialAgreeNameScopeVersion: 'scoped_v10' },
  participant_dialogue_v12_naming_v4: { ...dialogueV12, newTrialAgreeNameScopeVersion: 'scoped_v11' },
  participant_dialogue_v13_p5: dialogueV13P5,
  participant_dialogue_v13_p5_naming_v4: { ...dialogueV13P5, newTrialAgreeNameScopeVersion: 'scoped_v11' },
  participant_dialogue_v13_p5_semantic_guard: { ...dialogueV13P5, newTrialAgreeNameScopeVersion: 'scoped_v11',
    pinnedVersions: { ...dialogueV13P5.pinnedVersions, generationRetryVersion: 'jev_generation_retry_v15' } },
  participant_dialogue_v13_p5_semantic_guard_jev_naming: { ...dialogueV13P5, newTrialAgreeNameScopeVersion: 'jev_naming_v1',
    pinnedVersions: { ...dialogueV13P5.pinnedVersions, generationRetryVersion: 'jev_generation_retry_v15' } },
  participant_dialogue_v13_p5_human_led_move_on: dialogueV13P5HumanLedMoveOn,
  participant_dialogue_v13_p5_discriminating_confirmation: dialogueV13P5DiscriminatingConfirmation,
  participant_dialogue_v13_p5_jev_naming_v16_human_led_move_on: { ...dialogueV13P5DiscriminatingConfirmation,
    newTrialAgreeNameScopeVersion: 'jev_naming_v1' },
  [PILOT012_PARTICIPANT_PROFILE]: dialogueV17Pilot012,
  [PILOT012_V18_PARTICIPANT_PROFILE]: { ...dialogueV17Pilot012,
    pinnedVersions: { ...dialogueV17Pilot012.pinnedVersions, generationRetryVersion: SHAPE_TERMINOLOGY_GENERATION },
  },
  [PILOT012_V19_PARTICIPANT_PROFILE]: { ...dialogueV17Pilot012,
    pinnedVersions: { ...dialogueV17Pilot012.pinnedVersions, generationRetryVersion: 'jev_generation_retry_v19' },
  },
  [PILOT012_V20_PARTICIPANT_PROFILE]: { ...dialogueV17Pilot012,
    pinnedVersions: { ...dialogueV17Pilot012.pinnedVersions, generationRetryVersion: DEFERRED_AI_EXTRACTION_GENERATION },
  },
  [PILOT012_V21_PARTICIPANT_PROFILE]: dialogueV21IssueHandling,
  [PILOT012_V22_PARTICIPANT_PROFILE]: dialogueV22IssueFixes,
  [PILOT012_V23_PARTICIPANT_PROFILE]: { ...dialogueV22IssueFixes,
    pinnedVersions: { ...dialogueV22IssueFixes.pinnedVersions, generationRetryVersion: GENERATION_RETRY_V23 },
  },
} as const;

export function matchesWorkerDialogueProfile(key: ParticipantDialogueProfile | undefined, record: BaseRecord) {
  const { options, queueState } = record;
  if (key === undefined) return !Object.hasOwn(options, 'participantDialogueProfile');
  const state = queueState.privateState as { agreeNameScopeVersion?: unknown; graph?: { memoryPruneVersion?: unknown } } | undefined;
  const technicalTrial = options.technicalTrial as { version?: unknown } | undefined;
  const dialogue = workerDialogue[key];
  const memoryPruneVersion = participantMemoryPruneVersion(key);
  return !!dialogue && options.participantDialogueProfile === key &&
    options.memoryPruneVersion === memoryPruneVersion && state?.graph?.memoryPruneVersion === memoryPruneVersion &&
    (!isPilot012ParticipantDialogueProfile(key) || options.initialObservationGeneration === INITIAL_OBSERVATION_STRUCTURED_V2) &&
    options.profileSha256 === researchHash(dialogue.profile) && options.questionLayout === dialogue.profile.questionLayout &&
    options.dialoguePolicy === dialogue.profile.dialoguePolicy &&
    technicalTrial?.version === dialogue.technicalTrial.version && Object.keys(technicalTrial).length === 1 &&
    options.generationRetryVersion === dialogue.pinnedVersions.generationRetryVersion &&
    options.jevNamingRestoreVersion === dialogue.pinnedVersions.namingRestoreVersion &&
    state?.agreeNameScopeVersion === dialogue.newTrialAgreeNameScopeVersion;
}

const researchLimits = { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS };

async function requireWorkerInitialObservationGeneration(proxy: ParticipantService | undefined,
  generation: InitialObservationGeneration): Promise<void> {
  const supported = generation === INITIAL_OBSERVATION_STRUCTURED_V1
    ? await proxy?.participantInitialObservationPolicy?.() : await proxy?.participantInitialObservationPolicy?.(generation);
  if (supported !== generation) throw new NamingTaskError('ai_unavailable');
}

export async function workerParticipantPolicy(proxy: ParticipantService | undefined, usageOnly = false,
  initialObservationGeneration?: InitialObservationGeneration,
  schemaVersion: ParticipantModelPin['schemaVersion'] = 'participant_model_pin_v1') {
  try {
    if (typeof proxy?.participantPolicy !== 'function' || typeof proxy.participantChat !== 'function' ||
        typeof proxy.participantChoices !== 'function') throw new Error();
    if (usageOnly && (typeof proxy.participantUsagePolicy !== 'function' ||
        typeof proxy.participantUsageChat !== 'function' || typeof proxy.participantUsageChoices !== 'function')) throw new Error();
    if (schemaVersion !== 'participant_model_pin_v1' && (!usageOnly || typeof proxy.participantUsageGeneration !== 'function')) throw new Error();
    const policy = schemaVersion === 'participant_model_pin_v3' ? proxy.participantUsagePolicyV3?.()
      : schemaVersion === 'participant_model_pin_v2' ? proxy.participantUsagePolicyV2?.()
      : usageOnly ? proxy.participantUsagePolicy!() : proxy.participantPolicy();
    const raw = initialObservationGeneration === INITIAL_OBSERVATION_STRUCTURED_V2
      ? (await Promise.all([policy, requireWorkerInitialObservationGeneration(proxy, initialObservationGeneration)]))[0]
      : await policy;
    const pin = validateParticipantModelPin(structuredClone(raw));
    if (pin.schemaVersion !== schemaVersion || !MODEL_CONTRACT_V2.acceptedReturned.includes(pin.jevModelId)) throw new Error();
    if (initialObservationGeneration === INITIAL_OBSERVATION_STRUCTURED_V1) {
      await requireWorkerInitialObservationGeneration(proxy, initialObservationGeneration);
    }
    return { pin, proxy };
  } catch {
    throw new NamingTaskError('ai_unavailable');
  }
}

function boundFetch(dispatch: Dispatch, modelId: string, ledger: RunBudget<BudgetLimits | null>): typeof fetch {
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

type ParticipantObservationOptions = {
  pin: ParticipantModelPin;
  own: ObservationInput;
  proxy: ParticipantService;
  cache: WorkerTerraCache;
  initialObservationGeneration?: InitialObservationGeneration;
  preparedObservation?: PreparedTrialObservationReference;
};

function participantChat(proxy: ParticipantService, usageOnly: boolean): Dispatch {
  return (payload, expected) => usageOnly ? proxy.participantUsageChat!(payload, expected) : proxy.participantChat(payload, expected);
}

export function createParticipantTerraObserver({ pin, own, proxy, cache, usage, initialObservationGeneration, preparedObservation }:
  ParticipantObservationOptions & { usage?: ParticipantUsageLedger }) {
  const chat = participantChat(proxy, Boolean(usage));
  const terra = createWorkerTerraObserver({
    modelPin: pin, own, cache, ...(preparedObservation ? { requiredInitialMemo: { key: preparedObservation.cacheKey, memoSha256: preparedObservation.memoSha256 } } : {}), timeoutMs: profile.timeouts.observationMs, researchLimits, initialObservationGeneration,
    visual: (payload, signal) => usage ? usage.dispatch('terra', chat, payload, signal) : chat(payload, pin.terraModelId),
    ...(usage ? { onCacheHit: () => usage.cacheHit() } : {}),
  });
  if (!usage) return terra;
  return {
    observeAll: (...args: Parameters<typeof terra.observeAll>) =>
      usage.logical('terra', 'initial_observation', () => terra.observeAll(...args)),
    reobserve: (...args: Parameters<typeof terra.reobserve>) =>
      usage.logical('terra', 'reobservation', () => terra.reobserve(...args)),
  };
}

export function createWorkerParticipantRuntime({ pin, own, proxy, cache, limits, usage, historicalLimits, initialObservationGeneration, participantDialogueProfile, preparedObservation }:
  ParticipantObservationOptions & { participantDialogueProfile?: ParticipantDialogueProfile } &
  ({ limits: Readonly<BudgetLimits>; usage?: never; historicalLimits?: never } |
   { limits?: never; usage?: never; historicalLimits: Readonly<BudgetLimits> | null } |
   { limits?: never; usage: ParticipantUsageLedger; historicalLimits?: never })) {
  if (pin.schemaVersion !== 'participant_model_pin_v1' && !usage) throw new NamingTaskError('invalid_options');
  const dialogue = participantDialogueProfile === undefined ? null : workerDialogue[participantDialogueProfile];
  if (participantDialogueProfile !== undefined && (!dialogue || pin.schemaVersion !== 'participant_model_pin_v3' || !usage ||
      isPilot012ParticipantDialogueProfile(participantDialogueProfile) && initialObservationGeneration !== INITIAL_OBSERVATION_STRUCTURED_V2)) {
    throw new NamingTaskError('invalid_options');
  }
  const runtimeProfile = dialogue?.profile ?? profile;
  const usageOnly = Boolean(usage) || historicalLimits !== undefined;
  const ledger = usage ?? (historicalLimits === undefined ? new RunBudget(limits!) : new LegacyParticipantUsageLedger(historicalLimits));
  const chat = participantChat(proxy, usageOnly);
  const choices: Dispatch = (payload, expected) => usageOnly ? proxy.participantUsageChoices!(payload, expected) : proxy.participantChoices(payload, expected);
  function meteredFetch(dispatch: Dispatch, provider: 'jev' | 'luna' | 'terra', expected: string): typeof fetch {
    if (ledger instanceof RunBudget) {
      if (provider === 'terra' || pin.schemaVersion === 'participant_model_pin_v3') throw new NamingTaskError('invalid_options');
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
  const lunaClient = pin.schemaVersion === 'participant_model_pin_v3' ? null
    : createChatClient(chatConfig, meteredFetch(chat, 'luna', pin.lunaModelId));
  const terraClient = pin.schemaVersion === 'participant_model_pin_v1' ? null : createChatClient(chatConfig,
    meteredFetch((payload, expected) => proxy.participantUsageGeneration!(payload, expected), 'terra', pin.terraModelId));
  const client = terraClient ? {
    complete(messages: Parameters<NonNullable<typeof lunaClient>['complete']>[0],
      options?: Parameters<NonNullable<typeof lunaClient>['complete']>[1] & { phase?: string }) {
      const selected = participantChatProvider(pin, options?.phase) === 'terra' ? terraClient : lunaClient;
      if (!selected) throw new NamingTaskError('invalid_options');
      return selected.complete(messages, options);
    },
  } : lunaClient!;
  const jevFetch = meteredFetch(choices, 'jev', pin.jevModelId);
  const transport: JevDecisionClientOptions = {
    // The native choice parser requires this format. boundFetch sends only the JSON body over the private RPC.
    readKey: async () => 'sk-or-service-binding-only-0000',
    fetchImpl: jevFetch,
    timeoutMs: profile.timeouts.decisionMs,
    researchLimits,
    ...(usageOnly ? { usagePolicy: PARTICIPANT_USAGE_ONLY } : { costCapUsd: limits!.jevUsd }),
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
  const jevResearch: JevResearchOptions<JevResearchLedger> = {
    ...(dialogue ?? {}), profile: runtimeProfile, ledger,
    observer: createParticipantTerraObserver({ pin, own, proxy, cache, usage, initialObservationGeneration, preparedObservation }),
    jevDecision: createJevDecisionClient({ ...transport, enabled: true, questionLayout: runtimeProfile.questionLayout,
      participantTargetMenu: !dialogue, participantPrompts: dialogue !== null })!,
    localGrounding: {
      classifier: createJevLocalTestClassifier({ ...localTransport, enabled: true, timeoutMs: profile.timeouts.localMs,
        ...(dialogue ? { questionLayout: dialogue.profile.questionLayout, dialoguePolicy: dialogue.profile.dialoguePolicy } : {}) })!,
      aiPublicTransport, timeoutMs: profile.timeouts.localMs,
      researchLimits, aiPublicClaims: profile.localGrounding.aiPublicClaims,
    },
  };
  return { client, jevResearch };
}
