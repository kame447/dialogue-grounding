import { NamingTaskError } from '../../../dialogue-model/runtime/naming-error.mjs';
import { applyQuestionnaire, sortRecordList } from '../../../dialogue-model/runtime/v2/participant-records.ts';
import type { Questionnaire, RecordListEntry } from '../../../dialogue-model/runtime/v2/participant-records.ts';
import { effectiveBetweenTrials, participantReception } from '../../../dialogue-model/runtime/v2/reception.ts';
import type { Reception } from '../../../dialogue-model/runtime/v2/reception.ts';

export const BROWSER_SESSIONS_KEY = 'browser:sessions:v1';
export const TAB_SESSION_HEADER = 'X-Tab-Session';
export const TAB_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const MAX_EMPTY_TAB_SESSIONS = 16;
export const EMPTY_TAB_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type BrowserSession = { sessionId: string; doName: string; createdAt: string };
export type ReceptionMode = 'on' | 'off' | 'unavailable';
export type SessionPhase = 'waiting' | 'ready' | 'in_progress' | 'submitting' |
  'questionnaire_waiting' | 'ready_next' | 'finished' | 'cancelled' | 'interrupted' | 'unavailable';
type SummaryRecord = Omit<RecordListEntry, 'status'> & { status: 'dialogue' | 'submitting' | 'completed' | 'interrupted' | 'unknown' };

export type BrowserSessionSummary = {
  sessionId: string;
  createdAt: string | null;
  updatedAt: string | null;
  status: SessionPhase;
  resumable: boolean;
  hasUnansweredQuestionnaire: boolean;
  reception: ReturnType<typeof participantReception> | null;
  activeRecordId: string | null;
  records: SummaryRecord[];
};

export function tabSessionRoute(header: string | string[] | null | undefined): string | null {
  if (header == null || header === 'legacy') return 'legacy';
  return typeof header === 'string' && TAB_SESSION_ID.test(header) ? header : null;
}

/** Accept an empty body or an empty JSON object, irrespective of HTTP framing. */
export function validateCreateTabSession(text: string, contentType: string | undefined | null): void {
  if (text === '') return;
  if (contentType?.split(';')[0].trim() !== 'application/json' || !/^\s*\{\s*\}\s*$/u.test(text)) {
    throw new NamingTaskError('invalid_request');
  }
}

function latest(...dates: (string | null | undefined)[]): string | null {
  return dates.reduce<string | null>((max, date) => date && (!max || date > max) ? date : max, null);
}

export function summarizeBrowserSession(input: {
  sessionId: string;
  createdAt: string | null;
  reception: Reception | null;
  protocolAvailable?: boolean;
  receptionUnreadable?: boolean;
  activeRecordId: string | null;
  records: Array<{ entry: RecordListEntry; questionnaireUpdatedAt?: string }>;
}): BrowserSessionSummary | null {
  const { sessionId, reception, receptionUnreadable, activeRecordId } = input;
  if (!reception && !receptionUnreadable && !input.records.length) return null;

  let updatedAt = latest(reception?.createdAt, reception?.plan?.approvedAt);
  const records = sortRecordList(input.records.map(({ entry, questionnaireUpdatedAt }) => {
    const { recordId, startedAt, updatedAt: recordUpdatedAt, status, questionnaire } = entry;
    updatedAt = latest(updatedAt, recordUpdatedAt ?? startedAt, questionnaireUpdatedAt);
    return { recordId, startedAt, updatedAt: recordUpdatedAt, status, questionnaire, active: recordId === activeRecordId };
  })) as SummaryRecord[];
  const active = records.find(record => record.active);
  const createdAt = input.createdAt ?? reception?.createdAt ?? records.reduce<string | null>((first, record) =>
    record.startedAt && (!first || record.startedAt < first) ? record.startedAt : first, null);

  const predecessor = reception?.trials.at(-1);
  const next = reception?.status === 'in_progress' && Boolean(reception.plan &&
    reception.trials.length < reception.plan.trials.length &&
    records.some(record => record.recordId === predecessor?.recordId && record.status === 'completed'));
  const awaitingQuestionnaire = Boolean(next && reception?.plan &&
    effectiveBetweenTrials(reception.plan) === 'questionnaire_required' &&
    !records.some(record => record.recordId === predecessor?.recordId && record.questionnaire === 'submitted'));
  const publicReception = reception ? participantReception(reception, { awaitingQuestionnaire }) : null;
  const blocked = receptionUnreadable || (reception?.status === 'approved' || next) && input.protocolAvailable === false;
  if (blocked && publicReception) publicReception.status = 'unavailable';

  let status: SessionPhase;
  if (blocked) status = 'unavailable';
  else if (reception?.status === 'interrupted' || active?.status === 'interrupted') status = 'interrupted';
  else if (reception?.status === 'cancelled') status = 'cancelled';
  else if (reception?.status === 'finished') status = 'finished';
  else if (reception?.status === 'pending') status = 'waiting';
  else if (reception?.status === 'approved') status = 'ready';
  else if (next) status = awaitingQuestionnaire ? 'questionnaire_waiting' : 'ready_next';
  else if (active?.status === 'submitting') status = 'submitting';
  else if (active?.status === 'dialogue') status = 'in_progress';
  else if (active?.status === 'completed' || !reception && records.every(record => record.status === 'completed')) status = 'finished';
  else status = 'unavailable';

  return {
    sessionId, createdAt, updatedAt, status,
    resumable: status !== 'finished' && status !== 'cancelled' && status !== 'interrupted' && status !== 'unavailable',
    hasUnansweredQuestionnaire: records.some(record => record.status === 'completed' && record.questionnaire !== 'submitted'),
    reception: publicReception, activeRecordId: active?.recordId ?? null, records,
  };
}

export function sortBrowserSessions(sessions: BrowserSessionSummary[]): BrowserSessionSummary[] {
  return sessions.sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '')
    || a.sessionId.localeCompare(b.sessionId));
}

export function validateEventCount(body: Record<string, unknown>, events: unknown): void {
  if (!Object.hasOwn(body, 'expectedEventCount')) return;
  const expected = body.expectedEventCount;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) throw new NamingTaskError('invalid_request');
  if (!Array.isArray(events) || events.length !== expected) throw new NamingTaskError('trial_changed');
}

export function questionnaireUpdate(body: Record<string, unknown>) {
  const { expectedUpdatedAt, ...input } = body;
  if (Object.hasOwn(body, 'expectedUpdatedAt') && expectedUpdatedAt !== null && typeof expectedUpdatedAt !== 'string') {
    throw new NamingTaskError('invalid_questionnaire');
  }
  return (previous: Questionnaire | null, now: number) => {
    const stale = expectedUpdatedAt !== undefined && expectedUpdatedAt !== (previous?.updatedAt ?? null);
    if (stale && previous?.status !== 'submitted') throw new NamingTaskError('trial_changed');
    // Concurrent writes can arrive in one millisecond, including under a fixed test clock.
    const nextTime = Math.max(now, (previous ? Date.parse(previous.updatedAt) + 1 : now) || now);
    const next = applyQuestionnaire(previous, input, new Date(nextTime).toISOString());
    // Validation against an immutable submission takes precedence over the conflict check.
    if (stale) throw new NamingTaskError('trial_changed');
    return next;
  };
}
