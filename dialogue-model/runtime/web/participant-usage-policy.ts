/** Persisted identifier. Only the participant Worker may activate it from an approved plan. */
export const PARTICIPANT_PRODUCTION_PROFILE = 'participant_production_usage_v1';
export type ParticipantProductionProfile = typeof PARTICIPANT_PRODUCTION_PROFILE;

/** Process-local capability. A JSON field can never select usage-only transport. */
export const PARTICIPANT_USAGE_ONLY = Symbol('participant usage accounting');
export type ParticipantUsageOnly = typeof PARTICIPANT_USAGE_ONLY;
