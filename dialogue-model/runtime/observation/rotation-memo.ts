// The initial memo of a rotation-memory trial. It is built from static, pre-made data: no provider request, no cache read, no wait.
// The memo carries no construal of its own (holistic is empty, analytic is geometry-free filler); every figure's
// views live in `rotation`. A figure the bundle lacks keeps a plain entry without it, and the trial goes on.
import type { LocalOwnAnchor } from '../local-grounding/contract.ts';
import type { OwnRotationMemory } from '../stimuli/rotation-memory-shape.ts';
import type { ObservationInput, ObservationMemo, ObservationObserver } from './contract.ts';
import { ObservationError, snapshotObservationInput, validateObservationMemo } from './observe.ts';

/** analytic.composition must be a non-empty text; these fixed lines name no figure, shape or construal. */
export const ROTATION_MEMO_COMPOSITION = '形・位置・接続は rotation を参照。';
export const ROTATION_MEMO_ABSENT = 'この図形の事前メモはない。';

/** One entry per own anchor, in anchor order. `projections` is keyed by the own-side figure ID. */
export function rotationInitialMemo(anchors: readonly LocalOwnAnchor[], projections: ReadonlyMap<string, OwnRotationMemory>, observedAt: string): ObservationMemo {
  return { observedAt, figures: anchors.map(anchor => {
    const rotation = projections.get(anchor.id);
    return { id: anchor.id, region: { ...anchor.bbox }, holistic: [],
      analytic: { shapes: [], composition: rotation ? ROTATION_MEMO_COMPOSITION : ROTATION_MEMO_ABSENT, relations: [] },
      unknowns: [], reobservations: [], ...(rotation ? { rotation: structuredClone(rotation) } : {}) };
  }) };
}

/**
 * The first read is the static memo; a targeted re-observation still goes to `base` (its own request, only when a decision asks for one).
 * `project` runs at the first read only, so a restored trial never touches the bundle: it uses the memo it saved.
 */
export function createRotationMemoryObserver({ base, own, project, now = () => new Date() }: {
  base: ObservationObserver;
  own: ObservationInput;
  project: () => ReadonlyMap<string, OwnRotationMemory>;
  now?: () => Date;
}): ObservationObserver {
  const bound = snapshotObservationInput(own);
  const boundJson = JSON.stringify(bound);
  return {
    async observeAll(input, options) {
      if (options?.signal?.aborted) throw new ObservationError('aborted');
      if (JSON.stringify(snapshotObservationInput(input)) !== boundJson) throw new ObservationError('invalid_input');
      return validateObservationMemo(rotationInitialMemo(bound.ownAnchors, project(), now().toISOString()), { ownAnchors: bound.ownAnchors });
    },
    reobserve: (input, options) => base.reobserve(input, options),
  };
}
