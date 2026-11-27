import { researchHash } from '../../../../dialogue-model/runtime/v2/research-profile.ts';
import { isIncompleteTrialStatus } from '../../../../dialogue-model/runtime/v2/admin-termination.ts';
import type { IncompleteTrialStatus } from '../../../../dialogue-model/runtime/v2/admin-termination.ts';

export type TrialTerminationExpectation = { revision: string; status: IncompleteTrialStatus };
export type TrialTerminationResult = { ok: true } | { ok: false; error: 'not_found' | 'conflict' };

export function trialTerminationExpectation(record: unknown): TrialTerminationExpectation | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  // These two overlays are read independently of the trial archive in the admin view.
  const { questionnaire: _questionnaire, jevLedger: _usage, ...snapshot } = record as Record<string, unknown>;
  return isIncompleteTrialStatus(snapshot.status) ? { revision: researchHash(snapshot), status: snapshot.status } : null;
}
