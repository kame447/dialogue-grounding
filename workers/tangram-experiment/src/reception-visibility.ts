/** Absence alone is not evidence of deletion. Keep unstarted receptions and
 * unrecorded admissions that may still recover; never mutate the saved plan. */
export function allRecordedTrialsDeleted(
  trials: readonly { recordId: string | null }[],
  isDeleted: (recordId: string) => boolean,
): boolean {
  const ids = trials.flatMap(trial => trial.recordId === null ? [] : [trial.recordId]);
  return ids.length > 0 && ids.every(isDeleted);
}
