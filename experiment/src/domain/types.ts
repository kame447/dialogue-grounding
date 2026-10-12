/**
 * Core domain contracts for the DEMO experiment prototype.
 *
 * Nothing here talks to a server or an AI. Condition labels, partner-side
 * layouts and scoring IDs are researcher-only data: participant-facing
 * components must never render them (see e2e/participant-leak.spec.ts).
 */

/** A = confirmation relatively easy to start; B = uncertainty relatively tolerated. Never shown to participants. */
export type ConditionId = 'A' | 'B';
export type StimulusSetId = 'alpha' | 'beta';
export type SequenceId = 'S1' | 'S2' | 'S3' | 'S4';
export type BlockIndex = 0 | 1;

export interface BlockPlan {
  round: 1 | 2;
  condition: ConditionId;
  stimulusSet: StimulusSetId;
}

export interface Assignment {
  sequenceId: SequenceId;
  blocks: [BlockPlan, BlockPlan];
}

/** One silhouette. `id` is the scoring ID and is researcher-only. */
export interface Stimulus {
  id: string;
  setId: StimulusSetId;
  /** Polygons in a 0..100 x 0..100 viewBox; each polygon is a list of [x, y]. */
  polygons: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** Researcher-only short description, e.g. "DEMO alpha-1: 座る人のような形". */
  researcherNote: string;
}

export interface StimulusSet {
  id: StimulusSetId;
  label: string;
  stimuli: Stimulus[]; // exactly 6
}

/**
 * Per-block layouts. Positions are 0..5 (grid slots). `human[i]` is the stimulus id
 * displayed at slot i for the participant; `partner` is a different permutation
 * shown only to the (mock) partner.
 */
export interface BlockLayout {
  human: string[];
  partner: string[];
}

export type Speaker = 'human' | 'partner';

export interface ChatMessage {
  id: string;
  speaker: Speaker;
  text: string;
  at: string; // ISO timestamp
}

/** Final per-block answer: slot-independent mapping stimulusId -> name. */
export type NameSubmission = Record<string, string>;

export interface BlockSurvey {
  /** Subjective mental effort invested during the conversation, 1..9 (primary). */
  effort: number | null;
  /** Ease of moving the dialogue forward, 1..7 (secondary). */
  fluency: number | null;
  /** Annoyance / bother, 1..7 (separate). */
  annoyance: number | null;
  naturalness: number | null; // optional 1..7
  satisfaction: number | null; // optional 1..7
  comment: string;
}

export interface ComparisonSurvey {
  /** Which round required less effort: 'round1' | 'round2' | 'same' | null (not answered). */
  lessEffort: 'round1' | 'round2' | 'same' | null;
  easier: 'round1' | 'round2' | 'same' | null;
  lessAnnoying: 'round1' | 'round2' | 'same' | null;
  comment: string;
}

export type Phase =
  | 'welcome'
  | 'consent'
  | 'instructions'
  | 'chat'
  | 'naming'
  | 'survey'
  | 'interblock'
  | 'comparison'
  | 'results'
  | 'done';

export interface BlockState {
  plan: BlockPlan;
  layout: BlockLayout;
  messages: ChatMessage[];
  humanNames: NameSubmission | null; // null until locked
  partnerNames: NameSubmission | null; // mock partner's independent submission (DEMO)
  survey: BlockSurvey | null;
  /** Participant's private per-slot notes. Never sent to the partner; pre-fill the naming form. */
  memos: string[];
}

export interface SessionState {
  version: 1;
  sessionId: string; // anonymous random id, DEMO
  createdAt: string;
  phase: Phase;
  blockIndex: BlockIndex;
  assignment: Assignment;
  blocks: [BlockState, BlockState];
  comparison: ComparisonSurvey | null;
  events: ExperimentEvent[];
  /** True while waiting for the partner adapter; blocks duplicate sends. */
  awaitingPartner: boolean;
}

export type EventType =
  | 'session_started'
  | 'consent_acknowledged'
  | 'phase_entered'
  | 'block_started'
  | 'composing_started'
  | 'composing_stopped'
  | 'message_sent'
  | 'partner_request_started'
  | 'partner_request_finished'
  | 'partner_request_failed'
  | 'message_received'
  | 'naming_end_requested'
  | 'names_locked'
  | 'partner_names_submitted'
  | 'survey_submitted'
  | 'comparison_submitted'
  | 'results_viewed'
  | 'mock_diagnostic'
  | 'transition_rejected';

/**
 * Append-only event. `at` is wall clock (ISO), `mono` is performance.now() ms.
 * Observed typing time (composing_*) is NOT cognitive time; API wait
 * (partner_request_*) is a separate measure.
 */
export interface ExperimentEvent {
  seq: number;
  type: EventType;
  at: string;
  mono: number;
  blockIndex: BlockIndex | null;
  /** Researcher-only. Present on every event; never rendered in participant UI. */
  condition: ConditionId | null;
  payload: Record<string, unknown>;
}
