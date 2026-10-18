// Participant-facing views of the participant's own stored v2 records: the record
// list, a read-only review of a completed trial, and a PROVISIONAL questionnaire.
// Shared by the experiment Worker and the local research server, so both answer
// with identical shapes. Callers decide ownership (only records stored for the
// participant's own session reach these functions).
//
// The questionnaire items are trial items written for operation checks only
// (研究者未承認の仮項目). They are not NASA-TLX, Paas or any validated scale, and
// no total score is computed. See dialogue-model/README.md: the scales are undecided.
import { createTrialV2, participantView } from "../stimuli/scatter-v2.mjs";
import { NamingTaskError } from "../naming-error.mjs";

export const QUESTIONNAIRE_VERSION = "provisional-v0";
const SCALE = { min: 1, max: 7 } as const;
export const COMMENT_MAX_LENGTH = 2000;

export type QuestionnaireItem = {
  id: string; text: string; type: "likert"; min: number; max: number; minLabel: string; maxLabel: string; required: true;
};
export type QuestionnaireForm = {
  version: string; provisional: true; notice: string; items: QuestionnaireItem[]; comment: { maxLength: number };
};
export type QuestionnaireStatus = "draft" | "submitted";
export type Questionnaire = {
  version: string; status: QuestionnaireStatus; answers: Record<string, number | null>; comment: string;
  createdAt: string; updatedAt: string; submittedAt: string | null;
};

const item = (id: string, text: string, minLabel: string, maxLabel: string): QuestionnaireItem =>
  ({ id, text, type: "likert", ...SCALE, minLabel, maxLabel, required: true });

// Independent items; neither wording names a cause (e.g. the partner's confirmations).
export const QUESTIONNAIRE_FORM: QuestionnaireForm = Object.freeze({
  version: QUESTIONNAIRE_VERSION,
  provisional: true,
  notice: "試行用の仮の質問です（研究者未承認）。正式な尺度ではありません。回答は実験記録と同じ期間保存され、その後自動的に削除されます。",
  items: [
    item("mental_effort", "この課題に取り組むあいだ、どの程度頭を使いましたか。", "ほとんど使わなかった", "非常に多く使った"),
    item("task_difficulty", "この課題はどの程度難しかったですか。", "とても易しかった", "とても難しかった"),
    item("smoothness", "相手とのやり取りは、どの程度滞りなく進みましたか。", "とても滞った", "とても滞りなく進んだ"),
    item("bothersome", "相手とのやり取りを、どの程度煩わしく感じましたか。", "まったく感じなかった", "非常に強く感じた"),
  ],
  comment: { maxLength: COMMENT_MAX_LENGTH },
}) as QuestionnaireForm;

const ITEM_IDS = QUESTIONNAIRE_FORM.items.map((entry) => entry.id);
const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const invalid = () => new NamingTaskError("invalid_questionnaire");

export function questionnaireStatus(value: unknown): "none" | QuestionnaireStatus {
  return isPlain(value) && (value.status === "draft" || value.status === "submitted") ? value.status : "none";
}

/**
 * Validates a draft save or a submission against the stored questionnaire.
 * Drafts may leave items null and may be overwritten. A submission needs every
 * item; once submitted, only an identical re-submission is accepted (idempotent).
 * Returns the questionnaire to store and whether it changed.
 */
export function applyQuestionnaire(previous: Questionnaire | null, body: unknown, now: string):
  { questionnaire: Questionnaire; changed: boolean } {
  if (!isPlain(body) || typeof body.submit !== "boolean" || !isPlain(body.answers)) throw invalid();
  if (Object.keys(body).some((key) => !["answers", "comment", "submit"].includes(key))) throw invalid();
  const given = body.answers;
  if (Object.keys(given).some((key) => !ITEM_IDS.includes(key))) throw invalid();
  const answers: Record<string, number | null> = {};
  for (const id of ITEM_IDS) {
    const value = Object.hasOwn(given, id) ? given[id] : null;
    if (value !== null && !(Number.isInteger(value) && (value as number) >= SCALE.min && (value as number) <= SCALE.max)) throw invalid();
    answers[id] = value as number | null;
  }
  if (body.comment !== undefined && typeof body.comment !== "string") throw invalid();
  const comment = typeof body.comment === "string" ? body.comment : "";
  if (comment.length > COMMENT_MAX_LENGTH) throw invalid();
  const submit = body.submit;
  if (submit && ITEM_IDS.some((id) => answers[id] === null)) throw invalid();
  if (previous?.status === "submitted") {
    const same = submit && previous.comment === comment && ITEM_IDS.every((id) => previous.answers[id] === answers[id]);
    if (same) return { questionnaire: previous, changed: false };
    throw new NamingTaskError("questionnaire_submitted");
  }
  return {
    questionnaire: { version: QUESTIONNAIRE_VERSION, status: submit ? "submitted" : "draft", answers, comment,
      createdAt: previous?.createdAt ?? now, updatedAt: now, submittedAt: submit ? now : null },
    changed: true,
  };
}

export type RecordListEntry = {
  recordId: string; status: string; startedAt: string | null; updatedAt: string | null; active: boolean;
  questionnaire: "none" | QuestionnaireStatus;
};

const STATUSES = ["dialogue", "submitting", "completed"];
const iso = (value: unknown) => typeof value === "string" ? value : null;

export function recordListEntry(record: Record<string, unknown>, active: boolean, questionnaire: unknown): RecordListEntry {
  return { recordId: String(record.recordId), status: STATUSES.includes(record.status as string) ? record.status as string : "unknown",
    startedAt: iso(record.startedAt), updatedAt: iso(record.updatedAt), active, questionnaire: questionnaireStatus(questionnaire) };
}

/** Newest first by last update, then by id for a stable order. */
export function sortRecordList(entries: RecordListEntry[]): RecordListEntry[] {
  return entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.recordId.localeCompare(b.recordId));
}

/**
 * Researcher decision (2026-10-19): the match result, the AI's names and the score
 * stay hidden from the participant until that trial's questionnaire is submitted,
 * so they cannot bias the answers. Applies to the live state and to the review,
 * for earlier records too. Only the participant view changes; the stored record,
 * its scoring and the admin pages are untouched.
 * `resultLocked` is true exactly when a result exists and is being withheld.
 */
export function lockResult<T extends Record<string, unknown>>(view: T, questionnaire: unknown): Omit<T, "result"> & { resultLocked: boolean } {
  const { result, ...rest } = view;
  if (result === undefined) return { ...rest, resultLocked: false };
  if (questionnaireStatus(questionnaire) === "submitted") return { ...rest, result, resultLocked: false } as Omit<T, "result"> & { resultLocked: boolean };
  return { ...rest, resultLocked: true };
}

/** Same participant-facing result as the live state's `result`: own slots and names only, never figure ids. */
export function participantResult(result: any) {
  return { provisional: result.provisional, success: result.success, matchedCount: result.matchedCount, total: result.total,
    figures: (result.figures as any[]).map(({ human, ai, matched }) => ({ human: { slot: human.slot, rawName: human.rawName }, ai: { rawName: ai.rawName }, matched })) };
}

/**
 * Read-only review of a completed trial from its stored record. Holds only what
 * the participant already saw: their own scene, public events, their own
 * submitted names and the results screen. Never the AI's board, the answer key,
 * judgments, attempts, the ledger or the AI's raw submission.
 */
export function participantReview(record: Record<string, any>) {
  if (record.status !== "completed" || !isPlain(record.scoring) || !isPlain(record.scoring.result)) throw new NamingTaskError("trial_not_completed");
  if (!Number.isSafeInteger(record.seed)) throw new NamingTaskError("operation_failed");
  const events = (Array.isArray(record.events) ? record.events : []).filter(isPlain)
    .map(({ id, speaker, text, at }) => ({ id, speaker, text, at }));
  const human = isPlain(record.humanSubmission) ? record.humanSubmission : {};
  return {
    recordId: String(record.recordId), status: "completed" as const, startedAt: iso(record.startedAt), updatedAt: iso(record.updatedAt),
    scene: participantView(createTrialV2({ seed: record.seed })), events,
    humanSubmission: Object.fromEntries(Object.entries(human).map(([slot, name]) => [slot, typeof name === "string" ? name : null])),
    result: participantResult(record.scoring.result),
  };
}
