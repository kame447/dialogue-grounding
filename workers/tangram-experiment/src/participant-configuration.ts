import { INITIAL_OBSERVATION_STRUCTURED_V2, isInitialObservationGeneration } from '../../../dialogue-model/runtime/observation/initial-observation-generation.ts';
import { SCRIPTED_OPENING_MODE } from '../../../dialogue-model/runtime/v2/opening-mode.ts';
import { ReceptionError, isParticipantDialogueProfile, isPilot012ParticipantDialogueProfile, participantMemoryPruneVersion,
  validateParticipantLimits } from '../../../dialogue-model/runtime/v2/reception.ts';
import type { ParticipantPlanSettings, ReceptionProtocol, ReceptionProtocolV2, ReceptionProtocolV3 } from '../../../dialogue-model/runtime/v2/reception.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../../../dialogue-model/runtime/web/participant-usage-policy.ts';
import { workerParticipantPolicy } from './participant-runtime.ts';
import type { ParticipantService } from './participant-runtime.ts';

export type ParticipantConfigurationEnv = {
  PARTICIPANT_TERRA_ENABLED?: string;
  PARTICIPANT_TERRA_GENERATION_ENABLED?: string;
  PARTICIPANT_TERRA_ALL_ROLES_ENABLED?: string;
  PARTICIPANT_TERRA_PROFILE?: string;
  PARTICIPANT_DIALOGUE_PROFILE?: string;
  PARTICIPANT_TERRA_LIMITS_JSON?: string;
  PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION?: string;
  PARTICIPANT_AI_PROXY?: ParticipantService;
};
export type ParticipantConfiguration = {
  participant: Omit<ParticipantPlanSettings, 'preparedObservations'>;
  proxy?: ParticipantService;
};

/** Resolve one deployment snapshot for preparation and approval. This reads policy only; it never infers. */
export async function resolveParticipantConfiguration(env: ParticipantConfigurationEnv,
  protocol: ReceptionProtocol | ReceptionProtocolV2 | ReceptionProtocolV3): Promise<ParticipantConfiguration> {
  try {
    let participant: ParticipantConfiguration['participant'] = {};
    let proxy: ParticipantService | undefined;
    const generationPin = env.PARTICIPANT_TERRA_GENERATION_ENABLED === 'on';
    const allTerraPin = env.PARTICIPANT_TERRA_ALL_ROLES_ENABLED === 'on';
    const dialogueProfile = env.PARTICIPANT_DIALOGUE_PROFILE;
    if (dialogueProfile !== undefined && (!isParticipantDialogueProfile(dialogueProfile) || !protocol.referenceMemory || !allTerraPin ||
        env.PARTICIPANT_TERRA_ENABLED !== 'on' || env.PARTICIPANT_TERRA_PROFILE !== PARTICIPANT_PRODUCTION_PROFILE)) throw new Error();
    if ((generationPin || allTerraPin) && env.PARTICIPANT_TERRA_ENABLED !== 'on') throw new Error();
    if (env.PARTICIPANT_TERRA_ENABLED === 'on') {
      const configuredProfile = env.PARTICIPANT_TERRA_PROFILE;
      const configuredObservation = env.PARTICIPANT_TERRA_INITIAL_OBSERVATION_GENERATION;
      const pilot012 = isPilot012ParticipantDialogueProfile(dialogueProfile);
      const initialObservationGeneration = pilot012 ? configuredObservation ?? INITIAL_OBSERVATION_STRUCTURED_V2 : configuredObservation;
      if (initialObservationGeneration !== undefined && !isInitialObservationGeneration(initialObservationGeneration) ||
          pilot012 && initialObservationGeneration !== INITIAL_OBSERVATION_STRUCTURED_V2) throw new Error();
      const usageOnly = configuredProfile === PARTICIPANT_PRODUCTION_PROFILE;
      if (configuredProfile !== undefined && !usageOnly) throw new Error();
      const participantLimits = usageOnly ? undefined : validateParticipantLimits(JSON.parse(env.PARTICIPANT_TERRA_LIMITS_JSON ?? 'null'));
      const policy = await workerParticipantPolicy(env.PARTICIPANT_AI_PROXY, usageOnly, initialObservationGeneration,
        allTerraPin ? 'participant_model_pin_v3' : generationPin ? 'participant_model_pin_v2' : 'participant_model_pin_v1');
      proxy = policy.proxy;
      participant = { participantModelPin: policy.pin, ...(initialObservationGeneration ? { initialObservationGeneration } : {}),
        ...(participantLimits ? { participantLimits } : { participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE }),
        ...(dialogueProfile ? { participantDialogueProfile: dialogueProfile } : {}) };
    }
    return { participant: { ...participant,
      ...(protocol.schemaVersion !== 'reception_protocol_v1' ? { openingMode: SCRIPTED_OPENING_MODE } : {}),
      ...(protocol.referenceMemory ? { memoryPruneVersion: participantMemoryPruneVersion(participant.participantDialogueProfile) } : {}) },
      ...(proxy ? { proxy } : {}) };
  } catch { throw new ReceptionError('reception_unavailable'); }
}
