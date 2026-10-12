import type { ChatMessage, ConditionId, NameSubmission, Stimulus } from '../domain/types';

/**
 * Replaceable boundary to the conversational partner (future: one multimodal
 * model that both perceives the images and decides whether to check now).
 *
 * Only MockPartner exists in this prototype. A production adapter must run
 * server-side; the browser must never hold partner layouts or scoring IDs.
 */
export interface VisibleStimulus {
  /** Opaque per-block token for the partner's own slot; NOT the scoring id in production. */
  slotToken: string;
  slot: number;
  stimulus: Stimulus;
}

export interface PolicyContext {
  /** Block condition. Influences only the partner's policy, never shown to the participant. */
  condition: ConditionId;
  round: 1 | 2;
  turnIndex: number;
}

export interface PartnerReply {
  text: string;
  /** Researcher-only diagnostics, explicitly labelled as mock. */
  diagnostics: { mock: true; [key: string]: unknown };
}

export interface RespondInput {
  history: ChatMessage[];
  visibleStimuli: VisibleStimulus[];
  policyContext: PolicyContext;
}

export interface SubmitNamesInput {
  history: ChatMessage[];
  visibleStimuli: VisibleStimulus[];
  policyContext: PolicyContext;
}

export interface PartnerPort {
  readonly kind: 'mock' | string;
  respond(input: RespondInput, signal?: AbortSignal): Promise<PartnerReply>;
  /** Independent final submission: slotToken -> name (scored later, never shown before the survey). */
  submitNames(input: SubmitNamesInput, signal?: AbortSignal): Promise<{ names: Record<string, string>; diagnostics: { mock: true; [key: string]: unknown } }>;
}

export type { NameSubmission };
