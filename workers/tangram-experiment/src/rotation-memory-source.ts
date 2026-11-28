// The rotation-memory bundle as the participant Worker reads it. The bundle is compiled into the deploy: nothing here is
// configuration, and no setting turns it off. A new reception pins this bundle at approval; a trial reads it once at its start.
import { trialStimulusV2 } from '../../../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { projectOwnRotationMemory, rotationMemoryPin } from '../../../dialogue-model/runtime/stimuli/rotation-memory.ts';
import type { OwnRotationMemory } from '../../../dialogue-model/runtime/stimuli/rotation-memory-shape.ts';
import type { ParticipantPlanSettings } from '../../../dialogue-model/runtime/v2/reception.ts';
import type { RotationMemoryPin } from '../../../dialogue-model/runtime/v2/rotation-memory-pin.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../../../dialogue-model/runtime/web/participant-usage-policy.ts';

export type RotationMemorySource = {
  /** The bundle compiled into this deploy. */
  pin(): RotationMemoryPin;
  /** The projection of one own-side figure from its bank key and the rotation it is shown at; undefined when the bundle lacks it. */
  project(input: { figureKey: string; rotation: number }): OwnRotationMemory | undefined;
};

let current: RotationMemorySource | undefined = { pin: rotationMemoryPin, project: projectOwnRotationMemory };
export const rotationMemorySource = (): RotationMemorySource | undefined => current;
/** Test seam only. Production code never calls it. Returns the previous source so a test can restore it. */
export function overrideRotationMemorySource(next: RotationMemorySource | undefined): RotationMemorySource | undefined {
  const previous = current;
  current = next;
  return previous;
}

/**
 * The pin a new reception freezes: production participant runtime with reference memory, and a bundle in this deploy.
 * Approval and the observation-stock coordinator read this one rule from the same settings snapshot.
 */
export function rotationMemoryFor(participant: Pick<ParticipantPlanSettings, 'participantRuntimeProfile' | 'participantModelPin'>,
  referenceMemory: boolean): RotationMemoryPin | undefined {
  const source = current;
  return source && referenceMemory && participant.participantRuntimeProfile === PARTICIPANT_PRODUCTION_PROFILE && participant.participantModelPin !== undefined
    ? source.pin() : undefined;
}

/**
 * Own-side figure ID -> projection for this exact trial. The bank figure key and the absolute rotation exist only inside
 * this call; what comes out is relative. A figure the bundle lacks, or cannot project, is left out and the trial goes on.
 */
export function projectOwnFigures(trial: { key: { [side: string]: { [id: string]: string } } }, anchors: readonly { id: string }[],
  source: RotationMemorySource): Map<string, OwnRotationMemory> {
  const angles = trialStimulusV2(trial)?.angles.ai as Record<string, number> | undefined;
  const projections = new Map<string, OwnRotationMemory>();
  for (const { id } of anchors) {
    const figureKey = trial.key['ai']?.[id], rotation = angles?.[id];
    if (typeof figureKey !== 'string' || typeof rotation !== 'number') continue;
    try {
      const projection = source.project({ figureKey, rotation });
      if (projection) projections.set(id, projection);
    } catch { /* No new stop: this figure simply has no rotation memory. */ }
  }
  return projections;
}
