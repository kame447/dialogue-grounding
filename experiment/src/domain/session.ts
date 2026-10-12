import { SEQUENCES } from './assignment';
import { validateNames } from './names';
import type {
  BlockIndex,
  BlockState,
  BlockSurvey,
  ComparisonSurvey,
  EventType,
  ExperimentEvent,
  NameSubmission,
  Phase,
  SequenceId,
  SessionState,
} from './types';
import { STIMULUS_SETS } from '../stimuli/sets';
import { createLayout, createRng } from '../stimuli/layout';

/**
 * Explicit experiment state machine. Every participant-visible step is a
 * transition here; the UI only dispatches actions. Invalid transitions are
 * rejected (state unchanged apart from a `transition_rejected` event), which
 * is what makes double clicks, stale buttons and back navigation harmless.
 */

export interface Clock {
  now(): { at: string; mono: number };
}

export const systemClock: Clock = {
  now: () => ({ at: new Date().toISOString(), mono: typeof performance !== 'undefined' ? performance.now() : Date.now() }),
};

export type Action =
  | { type: 'ADVANCE_FROM_WELCOME' }
  | { type: 'ACK_CONSENT' }
  | { type: 'BEGIN_BLOCK' }
  | { type: 'COMPOSING'; active: boolean }
  | { type: 'SEND_MESSAGE'; id: string; text: string }
  | { type: 'PARTNER_REPLY'; id: string; text: string; diagnostics: Record<string, unknown>; waitMs: number }
  | { type: 'PARTNER_FAILED'; error: string; waitMs: number }
  | { type: 'RETRY_PARTNER' }
  | { type: 'SET_MEMO'; slot: number; text: string }
  | { type: 'END_NAMING' }
  | { type: 'LOCK_NAMES'; namesBySlot: string[] }
  | { type: 'PARTNER_NAMES'; blockIndex: BlockIndex; names: NameSubmission; diagnostics: Record<string, unknown> }
  | { type: 'SUBMIT_SURVEY'; survey: BlockSurvey }
  | { type: 'SUBMIT_COMPARISON'; comparison: ComparisonSurvey }
  | { type: 'FINISH' }
  | { type: 'RESTORED' };

export interface CreateSessionOptions {
  sessionId: string;
  sequenceId: SequenceId;
  seed: number;
  clock?: Clock;
}

export function createSession({ sessionId, sequenceId, seed, clock = systemClock }: CreateSessionOptions): SessionState {
  const assignment = SEQUENCES[sequenceId];
  const rng = createRng(seed);
  const blocks = assignment.blocks.map(
    (plan): BlockState => ({
      plan,
      layout: createLayout(STIMULUS_SETS[plan.stimulusSet], rng),
      messages: [],
      humanNames: null,
      partnerNames: null,
      survey: null,
      memos: ['', '', '', '', '', ''],
    }),
  ) as [BlockState, BlockState];
  const { at } = clock.now();
  const state: SessionState = {
    version: 1,
    sessionId,
    createdAt: at,
    phase: 'welcome',
    blockIndex: 0,
    assignment,
    blocks,
    comparison: null,
    events: [],
    awaitingPartner: false,
  };
  return emit(state, clock, 'session_started', { sequenceId, seed, demo: true }, null);
}

function emit(state: SessionState, clock: Clock, type: EventType, payload: Record<string, unknown>, blockIndex: BlockIndex | null = inBlock(state.phase) ? state.blockIndex : null): SessionState {
  const { at, mono } = clock.now();
  const event: ExperimentEvent = {
    seq: state.events.length + 1,
    type,
    at,
    mono,
    blockIndex,
    condition: blockIndex === null ? null : state.blocks[blockIndex].plan.condition,
    payload,
  };
  return { ...state, events: [...state.events, event] };
}

function inBlock(phase: Phase): boolean {
  return phase === 'chat' || phase === 'naming' || phase === 'survey';
}

function enter(state: SessionState, clock: Clock, phase: Phase, blockIndex: BlockIndex = state.blockIndex): SessionState {
  const next = { ...state, phase, blockIndex };
  return emit(next, clock, 'phase_entered', { phase, from: state.phase }, inBlock(phase) ? blockIndex : null);
}

function reject(state: SessionState, clock: Clock, action: Action, reason: string): SessionState {
  return emit(state, clock, 'transition_rejected', { action: action.type, phase: state.phase, reason });
}

function updateBlock(state: SessionState, index: BlockIndex, patch: Partial<BlockState>): SessionState {
  const blocks = [...state.blocks] as [BlockState, BlockState];
  blocks[index] = { ...blocks[index], ...patch };
  return { ...state, blocks };
}

const inRange = (v: number | null, max: number) => v === null || (Number.isInteger(v) && v >= 1 && v <= max);

export function surveyProblems(s: BlockSurvey): string[] {
  const problems: string[] = [];
  if (!inRange(s.effort, 9)) problems.push('effort out of range 1..9');
  for (const k of ['fluency', 'annoyance', 'naturalness', 'satisfaction'] as const) if (!inRange(s[k], 7)) problems.push(`${k} out of range 1..7`);
  return problems;
}

export function reduce(state: SessionState, action: Action, clock: Clock = systemClock): SessionState {
  const block = state.blocks[state.blockIndex];
  switch (action.type) {
    case 'ADVANCE_FROM_WELCOME':
      if (state.phase !== 'welcome') return reject(state, clock, action, 'not on welcome');
      return enter(state, clock, 'consent');

    case 'ACK_CONSENT':
      if (state.phase !== 'consent') return reject(state, clock, action, 'not on consent');
      return enter(emit(state, clock, 'consent_acknowledged', { provisional: true }), clock, 'instructions');

    case 'BEGIN_BLOCK': {
      if (state.phase === 'instructions' && state.blockIndex === 0) {
        return emit(enter(state, clock, 'chat', 0), clock, 'block_started', { round: 1, stimulusSet: state.blocks[0].plan.stimulusSet });
      }
      if (state.phase === 'interblock' && state.blockIndex === 0) {
        return emit(enter(state, clock, 'chat', 1), clock, 'block_started', { round: 2, stimulusSet: state.blocks[1].plan.stimulusSet });
      }
      return reject(state, clock, action, 'cannot begin block here');
    }

    case 'COMPOSING':
      if (state.phase !== 'chat') return state; // silently ignore stray input events
      return emit(state, clock, action.active ? 'composing_started' : 'composing_stopped', {});

    case 'SEND_MESSAGE': {
      const text = action.text.trim();
      if (state.phase !== 'chat') return reject(state, clock, action, 'not in chat');
      if (state.awaitingPartner) return reject(state, clock, action, 'awaiting partner');
      if (!text) return reject(state, clock, action, 'empty message');
      if (block.messages.some((m) => m.id === action.id)) return reject(state, clock, action, 'duplicate message id');
      const { at } = clock.now();
      let next = updateBlock(state, state.blockIndex, { messages: [...block.messages, { id: action.id, speaker: 'human', text, at }] });
      next = emit(next, clock, 'message_sent', { messageId: action.id, text, chars: [...text].length });
      next = { ...next, awaitingPartner: true };
      return emit(next, clock, 'partner_request_started', { retry: false });
    }

    case 'RETRY_PARTNER':
      if (state.phase !== 'chat' || state.awaitingPartner) return reject(state, clock, action, 'nothing to retry');
      return emit({ ...state, awaitingPartner: true }, clock, 'partner_request_started', { retry: true });

    case 'PARTNER_REPLY': {
      if (state.phase !== 'chat' || !state.awaitingPartner) return reject(state, clock, action, 'unexpected partner reply');
      const { at } = clock.now();
      let next = updateBlock(state, state.blockIndex, { messages: [...block.messages, { id: action.id, speaker: 'partner', text: action.text, at }] });
      next = emit({ ...next, awaitingPartner: false }, clock, 'partner_request_finished', { waitMs: action.waitMs });
      next = emit(next, clock, 'message_received', { messageId: action.id, text: action.text, chars: [...action.text].length });
      return emit(next, clock, 'mock_diagnostic', { stage: 'respond', ...action.diagnostics });
    }

    case 'PARTNER_FAILED':
      if (!state.awaitingPartner) return reject(state, clock, action, 'no pending request');
      return emit({ ...state, awaitingPartner: false }, clock, 'partner_request_failed', { error: action.error, waitMs: action.waitMs });

    case 'SET_MEMO': {
      if (state.phase !== 'chat' && state.phase !== 'naming') return state;
      if (!Number.isInteger(action.slot) || action.slot < 0 || action.slot >= block.memos.length) return state;
      const memos = [...block.memos];
      memos[action.slot] = action.text.slice(0, 200);
      return updateBlock(state, state.blockIndex, { memos });
    }

    case 'END_NAMING':
      if (state.phase !== 'chat') return reject(state, clock, action, 'not in chat');
      if (state.awaitingPartner) return reject(state, clock, action, 'awaiting partner');
      return enter(emit(state, clock, 'naming_end_requested', { messages: block.messages.length }), clock, 'naming');

    case 'LOCK_NAMES': {
      if (state.phase !== 'naming') return reject(state, clock, action, 'not in naming');
      if (block.humanNames) return reject(state, clock, action, 'already locked');
      if (action.namesBySlot.length !== block.layout.human.length) return reject(state, clock, action, 'wrong number of names');
      const v = validateNames(action.namesBySlot);
      if (!v.ok) return reject(state, clock, action, 'invalid names');
      const humanNames: NameSubmission = {};
      block.layout.human.forEach((id, slot) => (humanNames[id] = action.namesBySlot[slot].trim()));
      let next = updateBlock(state, state.blockIndex, { humanNames });
      next = emit(next, clock, 'names_locked', { namesBySlot: action.namesBySlot.map((n) => n.trim()) });
      return enter(next, clock, 'survey');
    }

    case 'PARTNER_NAMES': {
      const target = state.blocks[action.blockIndex];
      if (target.partnerNames) return reject(state, clock, action, 'partner names already submitted');
      let next = updateBlock(state, action.blockIndex, { partnerNames: action.names });
      next = emit(next, clock, 'partner_names_submitted', { names: action.names }, action.blockIndex);
      return emit(next, clock, 'mock_diagnostic', { stage: 'submitNames', ...action.diagnostics }, action.blockIndex);
    }

    case 'SUBMIT_SURVEY': {
      if (state.phase !== 'survey') return reject(state, clock, action, 'not in survey');
      const problems = surveyProblems(action.survey);
      if (problems.length) return reject(state, clock, action, problems.join('; '));
      const missing = (['effort', 'fluency', 'annoyance', 'naturalness', 'satisfaction'] as const).filter((k) => action.survey[k] === null);
      let next = updateBlock(state, state.blockIndex, { survey: action.survey });
      next = emit(next, clock, 'survey_submitted', { ...action.survey, missing });
      return state.blockIndex === 0 ? enter(next, clock, 'interblock', 0) : enter(next, clock, 'comparison', 1);
    }

    case 'SUBMIT_COMPARISON': {
      if (state.phase !== 'comparison') return reject(state, clock, action, 'not in comparison');
      const missing = (['lessEffort', 'easier', 'lessAnnoying'] as const).filter((k) => action.comparison[k] === null);
      const next = emit({ ...state, comparison: action.comparison }, clock, 'comparison_submitted', { ...action.comparison, missing });
      return enter(next, clock, 'results');
    }

    case 'FINISH':
      if (state.phase !== 'results') return reject(state, clock, action, 'not on results');
      return enter(emit(state, clock, 'results_viewed', {}), clock, 'done');

    case 'RESTORED':
      // A reload while waiting for the partner loses the in-flight request; surface it as a failure so the UI offers retry.
      if (state.awaitingPartner) return emit({ ...state, awaitingPartner: false }, clock, 'partner_request_failed', { error: 'page reloaded during request', waitMs: null });
      return state;
  }
}
