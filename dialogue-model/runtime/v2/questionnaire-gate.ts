// Gate for a plan whose betweenTrials is questionnaire_required: the stored
// questionnaire of the predecessor must itself be a complete submission. The
// stored value is checked as stored; it is never normalized into a pass.
import { applyQuestionnaire, COMMENT_MAX_LENGTH, QUESTIONNAIRE_FORM, QUESTIONNAIRE_VERSION } from './participant-records.ts';

const KEYS = ['version', 'status', 'answers', 'comment', 'createdAt', 'updatedAt', 'submittedAt'];
const ITEMS = QUESTIONNAIRE_FORM.items;
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

export function isSubmittedQuestionnaire(value: unknown): boolean {
  try {
    if (!plain(value) || Object.keys(value).length !== KEYS.length || KEYS.some(k => !Object.hasOwn(value, k))) return false;
    const { version, status, answers, comment, createdAt, updatedAt, submittedAt } = value;
    if (version !== QUESTIONNAIRE_VERSION || status !== 'submitted' || typeof comment !== 'string' || comment.length > COMMENT_MAX_LENGTH ||
      !iso(createdAt) || !iso(updatedAt) || !iso(submittedAt) || !plain(answers)) return false;
    if (Object.keys(answers).length !== ITEMS.length || ITEMS.some(({ id, min, max }) => !Number.isInteger(answers[id]) || (answers[id] as number) < min || (answers[id] as number) > max)) return false;
    // The same validation as a participant submission, applied to the stored values.
    applyQuestionnaire(null, { answers, comment, submit: true }, submittedAt as string);
    return true;
  } catch { return false; }
}
