import { SLOTS } from "../stimuli/board.mjs";

/** @typedef {'上段左'|'上段中'|'上段右'|'下段左'|'下段中'|'下段右'} Slot */
/** @typedef {'accept'|'propose_name'|'confirm'|'repair'|'defer'|'revisit'|'agree'|'move_on'|'close'} JudgmentAction */
/** @typedef {'unassigned'|'tentative'|'agreed'|'deferred'} LedgerStatus */
/** @typedef {{status: LedgerStatus, name: string|null}} LedgerEntry */
/** @typedef {Record<Slot, LedgerEntry>} OwnLedger AI's own slot notes, never an answer key. */
/** @typedef {{action: JudgmentAction, targetSlot: Slot|null, candidateName: string|null, discriminatingFeature: string|null, note: string|null}} Judgment */
/** @typedef {{mimeType: string, base64: string}} ParticipantImage */
/** @typedef {{role: 'user'|'assistant', content: string}} PublicUtterance */
/**
 * @typedef {object} JudgeInput
 * @property {ParticipantImage|null} image
 * @property {PublicUtterance[]} publicHistory
 * @property {'repair-first'|'bypass-enabled'} strategy
 * @property {OwnLedger} ownLedger
 * @property {{action: JudgmentAction, targetSlot: Slot|null}[]} [ownJudgmentHistory]
 */
/** @typedef {{judge(input: JudgeInput): Promise<Judgment>}} DialogueJudge */

export const ACTIONS = Object.freeze(["accept", "propose_name", "confirm", "repair", "defer", "revisit", "agree", "move_on", "close"]);
export const STATUSES = Object.freeze(["unassigned", "tentative", "agreed", "deferred"]);
export const SAFE_JUDGMENT = Object.freeze({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null });
const KEYS = Object.keys(SAFE_JUDGMENT);

export class JudgmentValidationError extends Error {
  constructor(code = "invalid_judgment") { super("Invalid dialogue judgment: " + code); this.name = "JudgmentValidationError"; this.code = code; }
}
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nullableText = (value, limit) => value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= limit);

/** @returns {OwnLedger} */
export function createOwnLedger() {
  return Object.fromEntries(SLOTS.map((slot) => [slot, { status: "unassigned", name: null }]));
}

/** @returns {OwnLedger} A fresh, whitelisted copy suitable for an AI request. */
export function validateOwnLedger(value) {
  if (!exactKeys(value, SLOTS)) throw new JudgmentValidationError("invalid_ledger");
  for (const slot of SLOTS) {
    const entry = value[slot];
    if (!exactKeys(entry, ["status", "name"]) || !STATUSES.includes(entry.status) || !nullableText(entry.name, 200) ||
        (entry.status === "unassigned" && entry.name !== null) ||
        (["tentative", "agreed"].includes(entry.status) && entry.name === null)) throw new JudgmentValidationError("invalid_ledger");
  }
  return Object.fromEntries(SLOTS.map((slot) => [slot, { status: value[slot].status, name: value[slot].name?.trim() ?? null }]));
}

/** @returns {Judgment} */
export function validateJudgment(value, { ownLedger = createOwnLedger() } = {}) {
  const ledger = validateOwnLedger(ownLedger);
  if (!exactKeys(value, KEYS) || !ACTIONS.includes(value.action) ||
      !(value.targetSlot === null || SLOTS.includes(value.targetSlot)) ||
      !nullableText(value.candidateName, 200) || !nullableText(value.discriminatingFeature, 400) || !nullableText(value.note, 1000)) {
    throw new JudgmentValidationError();
  }
  const judgment = Object.fromEntries(KEYS.map((key) => [key, typeof value[key] === "string" ? value[key].trim() : value[key]]));
  const { action, targetSlot, candidateName, discriminatingFeature } = judgment;
  if ((candidateName !== null && targetSlot === null) ||
      (["propose_name", "repair", "defer", "revisit", "agree"].includes(action) && targetSlot === null) ||
      (action === "propose_name" && candidateName === null) ||
      (action === "agree" && candidateName === null && ledger[targetSlot].name === null) ||
      (action === "confirm" && discriminatingFeature === null) ||
      (["move_on", "close"].includes(action) && candidateName !== null)) throw new JudgmentValidationError("inconsistent_action");
  // A slot may hold one working name. Overwriting any remembered name requires
  // an explicit self-repair, including a named slot that was later deferred.
  if (targetSlot && ledger[targetSlot].name !== null && candidateName !== null &&
      ledger[targetSlot].name !== candidateName && action !== "repair") {
    throw new JudgmentValidationError("reassignment_requires_repair");
  }
  return judgment;
}

/** Apply typed decisions only; never inspect a generated utterance for state. */
export function applyJudgment(ownLedger, value) {
  const ledger = validateOwnLedger(ownLedger);
  const judgment = validateJudgment(value, { ownLedger: ledger });
  const { action, targetSlot, candidateName } = judgment;
  if (!targetSlot) return ledger;
  const current = ledger[targetSlot];
  if (action === "repair") ledger[targetSlot] = candidateName === null ? { status: "unassigned", name: null } : { status: "tentative", name: candidateName };
  else if (action === "agree") ledger[targetSlot] = { status: "agreed", name: candidateName ?? current.name };
  else if (action === "defer") ledger[targetSlot] = { status: "deferred", name: candidateName ?? current.name };
  else if (action === "revisit") ledger[targetSlot] = { status: current.status === "agreed" ? "agreed" :
    (candidateName ?? current.name) === null ? "unassigned" : "tentative", name: candidateName ?? current.name };
  else if (candidateName !== null && ["accept", "propose_name", "confirm"].includes(action)) {
    ledger[targetSlot] = { status: current.status === "agreed" ? "agreed" : "tentative", name: candidateName };
  }
  return ledger;
}
