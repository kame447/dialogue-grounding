// Reception-side view of the rotation-memory pin: which generated memory bundle a reception froze when it was approved.
// The pin's shape and its check live in the data-free stimuli/rotation-memory-shape.ts, so reception, record and admin
// code never import the bundle's data.
import { validateRotationMemoryPin } from '../stimuli/rotation-memory-shape.ts';
import type { RotationMemoryPin } from '../stimuli/rotation-memory-shape.ts';

export { validateRotationMemoryPin };
export type { RotationMemoryPin };
/** What a trial record keeps: the pin its plan froze, and the bundle its projection actually came from (they differ only if a deploy intervened). */
export type RotationMemoryRecord = { pin: RotationMemoryPin; used: RotationMemoryPin };

export const sameRotationMemoryPin = (a: RotationMemoryPin, b: RotationMemoryPin): boolean =>
  a.version === b.version && a.dataSha256 === b.dataSha256 && a.catalogRevision === b.catalogRevision;

export function validateRotationMemoryRecord(value: unknown): RotationMemoryRecord {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2) throw new TypeError('invalid_rotation_memory');
  const read = (key: string) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) throw new TypeError('invalid_rotation_memory');
    return validateRotationMemoryPin(field.value);
  };
  return { pin: read('pin'), used: read('used') };
}
