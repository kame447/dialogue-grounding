import type { AdminSummary } from './summary.ts';

export const PARTICIPANT_ROLES = ['unclassified', 'human', 'ai'] as const;
export const PARTICIPANT_ROLE_VERSION = 'participant_role_v1';
export type ParticipantRole = typeof PARTICIPANT_ROLES[number];
export type ParticipantRoleView = { schemaVersion: typeof PARTICIPANT_ROLE_VERSION; role: ParticipantRole };
export type ParticipantRoleEntry = ParticipantRoleView & { recordId: string; updatedAt: string };
export type ParticipantRoleAudit = {
  kind: 'participant_role_set'; recordId: string; from: ParticipantRole; to: ParticipantRole; at: string;
};
export type ParticipantRoleResult = { ok: true } | { ok: false; error: 'not_found' | 'conflict' };
export type AdminRecordSummary = AdminSummary & { participantRole?: ParticipantRoleView };

export function isParticipantRole(value: unknown): value is ParticipantRole {
  return value === 'unclassified' || value === 'human' || value === 'ai';
}

export function participantRoleView(role: ParticipantRole = 'unclassified'): ParticipantRoleView {
  return { schemaVersion: PARTICIPANT_ROLE_VERSION, role };
}

export function readParticipantRoleEntry(value: unknown, recordId: string): ParticipantRoleEntry {
  const entry = value as Partial<ParticipantRoleEntry> | null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 4 ||
      entry.schemaVersion !== PARTICIPANT_ROLE_VERSION || entry.recordId !== recordId || !isParticipantRole(entry.role) ||
      typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt)) ||
      new Date(entry.updatedAt).toISOString() !== entry.updatedAt) throw new Error('invalid_participant_role');
  return { ...participantRoleView(entry.role), recordId, updatedAt: entry.updatedAt };
}

/** A historical export may predate classification. Present but invalid metadata is a data error. */
export function participantRoleFromExport(value: unknown): ParticipantRoleView {
  if (value === undefined) return participantRoleView();
  const view = value as Partial<ParticipantRoleView> | null;
  if (!view || typeof view !== 'object' || view.schemaVersion !== PARTICIPANT_ROLE_VERSION || !isParticipantRole(view.role)) {
    throw new Error('invalid_participant_role');
  }
  return participantRoleView(view.role);
}
