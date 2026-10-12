/** Normalisation used both for duplicate checks before locking and for later scoring. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface NameValidation {
  ok: boolean;
  /** Per-slot error messages (participant-facing Japanese), keyed by slot index. */
  errors: Record<number, string>;
}

export const MAX_NAME_LENGTH = 40;

/** names are in participant slot order (0..5). */
export function validateNames(names: string[]): NameValidation {
  const errors: Record<number, string> = {};
  const seen = new Map<string, number>();
  names.forEach((raw, slot) => {
    const n = normalizeName(raw);
    if (!n) {
      errors[slot] = '名前を入力してください。';
      return;
    }
    if (raw.trim().length > MAX_NAME_LENGTH) {
      errors[slot] = `${MAX_NAME_LENGTH}文字以内で入力してください。`;
      return;
    }
    const prev = seen.get(n);
    if (prev !== undefined) {
      errors[slot] = `図形${prev + 1}と同じ名前です。すべて異なる名前にしてください。`;
      if (!errors[prev]) errors[prev] = `図形${slot + 1}と同じ名前です。すべて異なる名前にしてください。`;
      return;
    }
    seen.set(n, slot);
  });
  return { ok: Object.keys(errors).length === 0, errors };
}
