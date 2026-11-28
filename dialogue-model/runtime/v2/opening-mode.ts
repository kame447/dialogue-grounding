export const SCRIPTED_OPENING_MODE = 'scripted_v1';
export type OpeningMode = typeof SCRIPTED_OPENING_MODE;
export const SCRIPTED_OPENING_TEXT = 'どれから話しましょうか？';
export const isOpeningMode = (value: unknown): value is OpeningMode => value === SCRIPTED_OPENING_MODE;
