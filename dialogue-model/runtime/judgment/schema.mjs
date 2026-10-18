import { SLOTS } from "../stimuli/board.mjs";
import { normalizeName, slotsOf } from "../scoring.mjs";
import { validateReferenceInterpretation } from "./memory.mjs";

/** @typedef {'上段左'|'上段中'|'上段右'|'下段左'|'下段中'|'下段右'} Slot */
/** @typedef {'accept'|'propose_name'|'confirm'|'repair'|'defer'|'revisit'|'agree'|'move_on'|'close'} JudgmentAction */
/** @typedef {'unassigned'|'tentative'|'agreed'|'deferred'} LedgerStatus */
/** @typedef {{status: LedgerStatus, name: string|null}} LedgerEntry */
/** @typedef {Record<Slot, LedgerEntry>} OwnLedger AI's own slot notes, never an answer key. */
/** @typedef {'propose_name'|'confirm'|'move_on'|'revisit'|'defer'} FollowUpAction */
/** @typedef {{action: FollowUpAction, targetSlot: Slot|null, candidateName: string|null, discriminatingFeature: string|null}} FollowUp */
/** @typedef {{action: JudgmentAction, targetSlot: Slot|null, candidateName: string|null, discriminatingFeature: string|null, note: string|null, followUp?: FollowUp|null, reference?: object|null}} Judgment Reference interpretations also require provenance validation against the session graph. */
/** @typedef {{mimeType: string, base64: string}} ParticipantImage */
/** @typedef {{role: 'user'|'assistant', content: string}} PublicUtterance */
/**
 * @typedef {object} JudgeInput
 * @property {ParticipantImage|null} image
 * @property {ParticipantImage|null} [rotationImage] Derived exclusively from the participant's own board.
 * @property {{graph: object, turn: number, publicTurns: {turn: number, speaker: 'human'|'ai', text: string}[]}|null} [referenceContext] Private provenance context, never generator input.
 * @property {PublicUtterance[]} publicHistory
 * @property {'repair-first'|'bypass-enabled'} strategy
 * @property {OwnLedger} ownLedger
 * @property {{action: JudgmentAction, targetSlot: Slot|null, candidateName: string|null}[]} [ownJudgmentHistory] Committed acts in primary-then-followUp order.
 */
/** @typedef {{judge(input: JudgeInput): Promise<Judgment>}} DialogueJudge */

export const ACTIONS = Object.freeze(["accept", "propose_name", "confirm", "repair", "defer", "revisit", "agree", "move_on", "close"]);
export const FOLLOW_UP_ACTIONS = Object.freeze(["propose_name", "confirm", "move_on", "revisit", "defer"]);
export const STATUSES = Object.freeze(["unassigned", "tentative", "agreed", "deferred"]);
export const SAFE_JUDGMENT = Object.freeze({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null });
const KEYS = Object.keys(SAFE_JUDGMENT);
const ACT_KEYS = KEYS.filter((key) => key !== "note");

export class JudgmentValidationError extends Error {
  constructor(code = "invalid_judgment") { super("Invalid dialogue judgment: " + code); this.name = "JudgmentValidationError"; this.code = code; }
}
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nullableText = (value, limit) => value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= limit);

/** v1 uses the fixed position names; v2 passes the AI's six opaque own ids. @returns {OwnLedger} */
export function createOwnLedger(slots = SLOTS) {
  const own = ledgerSlots(Object.fromEntries(slots.map((slot) => [slot, null])));
  return Object.fromEntries(own.map((slot) => [slot, { status: "unassigned", name: null }]));
}

function ledgerSlots(value) {
  try { return slotsOf(value); } catch { throw new JudgmentValidationError("invalid_ledger"); }
}

/** @returns {OwnLedger} A fresh, whitelisted copy suitable for an AI request. */
export function validateOwnLedger(value) {
  const slots = ledgerSlots(value);
  if (!exactKeys(value, slots)) throw new JudgmentValidationError("invalid_ledger");
  for (const slot of slots) {
    const entry = value[slot];
    if (!exactKeys(entry, ["status", "name"]) || !STATUSES.includes(entry.status) || !nullableText(entry.name, 200) ||
        (entry.status === "unassigned" && entry.name !== null) ||
        (["tentative", "agreed"].includes(entry.status) && entry.name === null)) throw new JudgmentValidationError("invalid_ledger");
  }
  return Object.fromEntries(slots.map((slot) => [slot, { status: value[slot].status, name: value[slot].name?.trim() ?? null }]));
}

function validateAct(value, ledger) {
  if (!exactKeys(value, KEYS) || !ACTIONS.includes(value.action) ||
      !(value.targetSlot === null || Object.hasOwn(ledger, value.targetSlot)) ||
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
  // A tentative name may adopt the other participant's wording on this slot.
  // Agreed/deferred names and other acts still require explicit self-repair.
  if (targetSlot && ledger[targetSlot].name !== null && candidateName !== null &&
      normalizeName(ledger[targetSlot].name) !== normalizeName(candidateName) && action !== "repair" &&
      !(ledger[targetSlot].status === "tentative" && ["agree", "confirm", "propose_name"].includes(action))) {
    throw new JudgmentValidationError("reassignment_requires_repair");
  }
  const assignedName = candidateName ?? (targetSlot && ["agree", "defer", "revisit"].includes(action) ? ledger[targetSlot].name : null);
  if (assignedName !== null && Object.keys(ledger).some((slot) => slot !== targetSlot && ledger[slot].name !== null &&
      normalizeName(ledger[slot].name) === normalizeName(assignedName))) {
    // Repair must explicitly release the old slot before reusing its name on
    // another. Never infer which correspondence is correct or silently move it.
    throw new JudgmentValidationError("duplicate_name_requires_repair");
  }
  return judgment;
}

/** @returns {Judgment} Validate followUp against the primary act's resulting notes; evidence checks are v2 opt-in. */
export function validateJudgment(value, { ownLedger = createOwnLedger(), agreeEvidence = false } = {}) {
  const ledger = validateOwnLedger(ownLedger);
  const optional = ["followUp", "reference"].filter((key) => value && Object.hasOwn(value, key));
  if (!exactKeys(value, [...KEYS, ...optional])) throw new JudgmentValidationError();
  const judgment = validateAct(Object.fromEntries(KEYS.map((key) => [key, value[key]])), ledger);
  if (agreeEvidence && judgment.action === "agree" &&
      ["unassigned", "deferred"].includes(ledger[judgment.targetSlot].status) && judgment.discriminatingFeature === null) {
    throw new JudgmentValidationError("agree_requires_identification");
  }
  if (Object.hasOwn(value, "followUp")) {
    if (value.followUp === null) judgment.followUp = null;
    else {
      if (!exactKeys(value.followUp, ACT_KEYS) || !FOLLOW_UP_ACTIONS.includes(value.followUp.action)) {
        throw new JudgmentValidationError("invalid_follow_up");
      }
      const followUp = validateAct({ ...value.followUp, note: null }, applyAct(ledger, judgment));
      judgment.followUp = Object.fromEntries(ACT_KEYS.map((key) => [key, followUp[key]]));
    }
  }
  if (Object.hasOwn(value, "reference")) {
    try { judgment.reference = validateReferenceInterpretation(value.reference, Object.keys(ledger)); }
    catch (error) { throw new JudgmentValidationError(error.code ?? "invalid_reference"); }
  }
  return judgment;
}

// Mutates only an already whitelisted local copy, never the caller's ledger.
function applyAct(ledger, judgment) {
  const { action, targetSlot, candidateName } = judgment;
  if (!targetSlot) return ledger;
  const current = ledger[targetSlot];
  if (action === "repair") ledger[targetSlot] = candidateName === null ? { status: "unassigned", name: null } : { status: "tentative", name: candidateName };
  else if (action === "agree") ledger[targetSlot] = { status: "agreed", name: candidateName ?? current.name };
  else if (action === "defer") ledger[targetSlot] = { status: "deferred", name: candidateName ?? current.name };
  else if (action === "revisit") ledger[targetSlot] = { status: current.status === "agreed" ? "agreed" :
    (candidateName ?? current.name) === null ? "unassigned" : "tentative", name: candidateName ?? current.name };
  else if (action === "confirm" && candidateName !== null) ledger[targetSlot] = { status: "tentative", name: candidateName };
  else if (candidateName !== null && ["accept", "propose_name"].includes(action)) {
    ledger[targetSlot] = { status: current.status === "agreed" ? "agreed" : "tentative", name: candidateName };
  }
  return ledger;
}

/** Apply both typed acts atomically; never infer state from generated speech. */
export function applyJudgment(ownLedger, value) {
  const ledger = validateOwnLedger(ownLedger);
  const judgment = validateJudgment(value, { ownLedger: ledger });
  applyAct(ledger, judgment);
  if (judgment.followUp) applyAct(ledger, judgment.followUp);
  return ledger;
}
