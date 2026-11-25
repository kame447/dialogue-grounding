// Public-source check for a v2 Luna agree (shared by both strategies).
// It answers only "is there an unrevoked public source for this slot/name?".
// Whether the partner meant to adopt the name is the judge's semantic call
// (its action and reference interpretation); this module never picks a dialogue act.
// Sources and revocations come only from interpretations saved on committed traces
// (humanNaming) and from applied AI acts, so pruning the reference graph never revives one.

export const NAME_ACTS = Object.freeze(["propose_name", "agree"]);
const SOURCE_INTENTS = new Set(["name_proposal", "name_acceptance"]);
const NAMING_INTENTS = new Set(["name_proposal", "name_acceptance", "correction"]);
const RETRACTING_INTENTS = new Set(["denial", "correction"]);

export const normalizeName = (value) => typeof value === "string" ? value.normalize("NFKC").trim() : "";

/** True only when the text shows the exact name in Japanese name brackets: a format fact, not a speech act. */
export function nameShown(text, name) {
  const n = normalizeName(name);
  if (!n || typeof text !== "string") return false;
  const t = text.normalize("NFKC");
  return t.includes("「" + n + "」") || t.includes("『" + n + "』");
}

/** The name an act refers to: its candidateName, or for agree the slot's current ledger name. */
export function effectiveName(act, ledger) {
  if (!act) return "";
  return normalizeName(act.candidateName ?? (act.action === "agree" ? ledger?.[act.targetSlot]?.name : null) ?? "");
}

/**
 * The minimal naming record of one human turn, copied from the judge's validated reference.
 * No reference (the judge chose none, or a judge/memory fallback) is an unknown reading: intent=null.
 */
export function humanNamingRecord(reference, turn, publicTurns) {
  if (!reference) return { turn, intent: null, slots: [], nameSlot: null, name: null, nameInHuman: false };
  const name = normalizeName(reference.nameAcceptance?.name) || null;
  // A named slot outside the interpreted slots is a contradictory reading: unknown, never a source.
  if (name && !reference.slots.includes(reference.nameAcceptance.slot)) return humanNamingRecord(null, turn, publicTurns);
  // The literal check uses this turn's own human text only (never an earlier coalesced message).
  const humanText = publicTurns.find((t) => t.speaker === "human" && t.turn === turn)?.text.normalize("NFKC") ?? "";
  return { turn, intent: reference.intent, slots: [...reference.slots], nameSlot: reference.nameAcceptance?.slot ?? null,
    name, nameInHuman: Boolean(name) && humanText.includes(name) };
}

/**
 * @param {{ judgment: {action: string, targetSlot: string|null, candidateName: string|null},
 *   ledger: Record<string, {status: string, name: string|null}>,
 *   history: ({kind: "human", turn: number, intent: string|null, slots: string[], nameSlot: string|null, name: string|null, nameInHuman: boolean}
 *     | {kind: "ai", aiSeq: number, aiText?: string|null, evidence: boolean, acts: {action: string, targetSlot: string|null, candidateName: string|null, nameShown: boolean}[]})[],
 *   publicTurns: {turn: number, speaker: string, text: string}[] }} input
 *   history: oldest first, ending with this turn's provisional human record. A human
 *   record with intent=null is unknown: nothing before it can be verified as unrevoked.
 *   aiText: the AI event published at aiSeq, from all public events (null: none there). When the
 *   field is absent, the bounded publicTurns are searched instead.
 * @returns {{ok: boolean, source: "human"|"ai"|null, reason: string|null}}
 */
export function agreeNameEvidence({ judgment, ledger, history = [], publicTurns = [] }) {
  if (judgment?.action !== "agree") return { ok: true, source: null, reason: null };
  const slot = judgment.targetSlot, name = effectiveName(judgment, ledger);
  if (!slot || !name) return { ok: false, source: null, reason: "no_public_name_source" };
  const at = (entry) => entry.kind === "human" ? entry.turn : entry.aiSeq;
  // Stored readings are re-checked: a half-specified or contradictory name is treated as unknown.
  const consistent = (h) => h.intent === null || ((h.nameSlot === null) === (h.name === null) && Array.isArray(h.slots) &&
    (h.nameSlot === null || h.slots.includes(h.nameSlot)));
  const humans = history.filter((e) => e.kind === "human").map((h) => consistent(h) ? h : { ...h, intent: null }),
    ais = history.filter((e) => e.kind === "ai");

  const revokedAfter = (t) =>
    humans.some((h) => h.turn > t && (h.intent === null ||
      // E1: the partner retracts or denies this name for this slot.
      (RETRACTING_INTENTS.has(h.intent) && h.nameSlot === slot && h.name === name) ||
      // E2/E3: the partner gives this slot another name, or this name to another slot.
      (NAMING_INTENTS.has(h.intent) && h.name && ((h.nameSlot === slot && h.name !== name) || (h.nameSlot !== slot && h.name === name))))) ||
    // E4/E5: an AI repair of this slot, another name for it, or this name moved to another slot.
    ais.some((a) => a.aiSeq > t && a.acts.some((act) => (act.targetSlot === slot && act.action === "repair") ||
      (NAME_ACTS.includes(act.action) && act.candidateName !== null &&
        ((act.targetSlot === slot && normalizeName(act.candidateName) !== name) || (act.targetSlot !== slot && normalizeName(act.candidateName) === name)))));

  // (H) The partner said this name while proposing or accepting it for this slot.
  for (const h of humans) {
    if (SOURCE_INTENTS.has(h.intent) && h.nameSlot === slot && h.name === name && h.nameInHuman && !revokedAfter(h.turn)) {
      return { ok: true, source: "human", reason: null };
    }
  }
  // (A) An AI name act shown publicly, then accepted by the partner, with no revocation since.
  for (const entry of [...ais].reverse()) {
    const act = entry.acts.find((a) => a.targetSlot === slot && NAME_ACTS.includes(a.action) && normalizeName(a.candidateName) === name);
    if (!act || !entry.evidence || !act.nameShown) continue;
    const published = Object.hasOwn(entry, "aiText") ? entry.aiText : publicTurns.find((t) => t.turn === entry.aiSeq && t.speaker === "ai")?.text;
    if (typeof published !== "string" || !nameShown(published, name) || revokedAfter(entry.aiSeq)) continue;
    // An acceptance naming a slot/name must match the offer exactly; an unnamed one relies on its slots.
    if (humans.some((h) => h.turn > at(entry) && h.intent === "name_acceptance" &&
        (h.nameSlot !== null ? h.nameSlot === slot && h.name === name : h.slots.includes(slot)))) {
      return { ok: true, source: "ai", reason: null };
    }
  }
  return { ok: false, source: null, reason: "no_public_name_source" };
}
