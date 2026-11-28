import type { RotationMode } from '../../../../dialogue-model/runtime/v2/reception.ts';

/**
 * Rotation modes a researcher can choose, keyed by value. A mode the generator gains without a label here fails the type check.
 * `form` is the label in the settings form, `list` the short one in the reception list.
 */
const LABELS = {
  relative_90_180_270: { form: '相対 90°・180°・270°', list: '90°・180°・270°' },
  relative_pm90: { form: '相対 ±90°（従来）', list: '±90°' },
  relative_0: { form: '相対 0°（向きを一致）', list: '0°' },
} satisfies Record<RotationMode, { form: string; list: string }>;

/** In the order the form offers them; the first is the default for new settings (researcher-approved 2026-11-28, #269). */
export const ROTATION_CHOICES: readonly { value: RotationMode; form: string; list: string }[] =
  (Object.keys(LABELS) as RotationMode[]).map(value => ({ value, ...LABELS[value] }));
export const DEFAULT_ROTATION_MODE: RotationMode = ROTATION_CHOICES[0].value;
