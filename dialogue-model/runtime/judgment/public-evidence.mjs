// Deterministic grounding of a judge's small interpretation in already-public text.
// The program owns turn numbers, speakers and quotes; the model only chooses
// slots, uncertainty and intent. Names and features are kept only when they
// appear literally in a public utterance, and the stored string is that literal
// span, never the model's paraphrase. Nothing here reads generated, unpublished
// text, the answer key or the other participant's image.

export const QUOTE_LIMIT = 160;

const ACK_TOKENS = ["それ", "これ", "あれ", "はい", "うん", "ええ", "そう", "そうです", "そうですね", "それで", "それです",
  "じゃあそれ", "じゃあそれで", "了解", "了解です", "ok", "yes"];
const PUNCT = /[\s、。，．,.!！?？…〜ー]+/gu;

/** Public history -> [{ turn, speaker, text }] with exchange numbering (1-based). */
export function publicTurnsFromHistory(history) {
  if (!Array.isArray(history)) throw new TypeError("history must be an array");
  return history.map((message, index) => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new TypeError("invalid public message");
    }
    return { turn: Math.floor(index / 2) + 1, speaker: message.role === "user" ? "human" : "ai", text: message.content };
  });
}

/** True when the utterance is only acknowledgments/deictics (and punctuation). */
export function isBareDeictic(text) {
  const parts = String(text).normalize("NFKC").toLowerCase().split(PUNCT).filter(Boolean);
  return parts.length > 0 && parts.every((part) => ACK_TOKENS.includes(part));
}

// Per-character folding that keeps a map back to the original indices.
function fold(text) {
  const chars = [], origin = [];
  for (let i = 0; i < text.length; i++) {
    let folded = text[i].normalize("NFKC").toLowerCase();
    if (/^\s+$/u.test(folded)) continue;
    folded = folded.replace(/[ァ-ヶ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    for (const c of folded) { chars.push(c); origin.push(i); }
  }
  return { text: chars.join(""), origin };
}

/** Literal occurrence of candidate in text, returned as a span of the original text. */
export function literalSpan(text, candidate) {
  if (typeof text !== "string" || typeof candidate !== "string" || !candidate.trim()) return null;
  const exact = text.indexOf(candidate);
  if (exact >= 0) return { start: exact, end: exact + candidate.length, text: candidate };
  const haystack = fold(text), needle = fold(candidate).text;
  if (!needle) return null;
  const at = haystack.text.indexOf(needle);
  if (at < 0) return null;
  const start = haystack.origin[at], end = haystack.origin[at + needle.length - 1] + 1;
  return { start, end, text: text.slice(start, end) };
}

/** Substring of text (<= maxChars) containing the focus span when given. */
export function quoteAround(text, { focus = null, maxChars = QUOTE_LIMIT } = {}) {
  if (typeof text !== "string" || !text.trim()) return null;
  if (text.length <= maxChars) return text;
  if (!focus || focus.end - focus.start > maxChars) return text.slice(0, maxChars);
  const room = maxChars - (focus.end - focus.start);
  const start = Math.max(0, Math.min(focus.start - Math.floor(room / 2), text.length - maxChars));
  return text.slice(start, start + maxChars);
}

const CONFIDENCE = { unresolved: 0, hypothesis: 0.5, grounded: 0.9 };

/**
 * interpretation: { slots, epistemic, intent, feature: {slot, feature, polarity}|null,
 *   nameAcceptance: {slot, name}|null, deferSlot, revisitSlot } (already schema-validated).
 * Returns materials for typed graph operations plus what was dropped and why.
 */
export function groundReference({ publicTurns, turn, interpretation }) {
  const human = publicTurns.find((t) => t.turn === turn && t.speaker === "human");
  if (!human) return { human: null, antecedent: null, feature: null, name: null, focus: [], dropped: [{ kind: "mention", reason: "no_public_human_turn" }] };
  const previousAi = publicTurns.find((t) => t.turn === turn - 1 && t.speaker === "ai") ?? null;
  const dropped = [];
  let slots = [...interpretation.slots];
  let epistemic = interpretation.epistemic;
  const bare = isBareDeictic(human.text);

  // Literal support for a name or feature: the human turn first, then the previous public AI turn.
  const locate = (value) => {
    const inHuman = literalSpan(human.text, value);
    if (inHuman) return { where: "human", span: inHuman };
    const inAi = previousAi && literalSpan(previousAi.text, value);
    return inAi ? { where: "ai", span: inAi } : null;
  };
  const featureSupport = interpretation.feature && locate(interpretation.feature.feature);
  const nameSupport = interpretation.nameAcceptance && locate(interpretation.nameAcceptance.name);

  const antecedentSpan = [nameSupport, featureSupport].find((s) => s?.where === "ai")?.span ?? null;
  const antecedentSlot = (nameSupport?.where === "ai" && interpretation.nameAcceptance.slot) ||
    (featureSupport?.where === "ai" && interpretation.feature.slot) || null;
  const antecedent = antecedentSpan && antecedentSlot && slots.length === 1 && slots[0] === antecedentSlot ? {
    sourceTurn: previousAi.turn, speaker: "ai", quote: quoteAround(previousAi.text, { focus: antecedentSpan }),
    slots: [antecedentSlot], confidence: CONFIDENCE.grounded, epistemic: "grounded",
    intent: nameSupport?.where === "ai" ? "name_proposal" : "feature_assertion",
  } : null;

  // A bare acknowledgment never grounds a referent by itself.
  if (bare && epistemic === "grounded" && !antecedent) {
    epistemic = slots.length ? "hypothesis" : "unresolved";
    dropped.push({ kind: "mention", reason: "bare_deictic_downgraded" });
  }
  if (epistemic === "unresolved") slots = [];
  if (epistemic === "grounded" && slots.length !== 1) { epistemic = slots.length ? "hypothesis" : "unresolved"; }
  if (epistemic === "hypothesis" && !slots.length) epistemic = "unresolved";

  const humanFocus = (nameSupport?.where === "human" && nameSupport.span) || (featureSupport?.where === "human" && featureSupport.span) || null;
  const mention = {
    sourceTurn: turn, speaker: "human", quote: quoteAround(human.text, { focus: humanFocus }),
    slots, confidence: CONFIDENCE[epistemic], epistemic, intent: interpretation.intent, usesAntecedent: Boolean(antecedent),
  };
  const singleOn = (slot) => epistemic === "grounded" && slots.length === 1 && slots[0] === slot;

  let feature = null;
  if (interpretation.feature) {
    const { slot, polarity } = interpretation.feature;
    const intentOk = ["feature_assertion", "feature_acceptance", "denial", "correction"].includes(interpretation.intent);
    if (!featureSupport) dropped.push({ kind: "feature", reason: "not_literal_in_public_text" });
    else if (!intentOk || !slots.includes(slot)) dropped.push({ kind: "feature", reason: "intent_or_slot_mismatch" });
    else if (featureSupport.where === "ai" && !(antecedent && singleOn(slot))) dropped.push({ kind: "feature", reason: "antecedent_not_single" });
    else feature = { slot, feature: featureSupport.span.text, polarity };
  }

  let name = null;
  if (interpretation.nameAcceptance) {
    const { slot } = interpretation.nameAcceptance;
    if (!nameSupport) dropped.push({ kind: "name", reason: "not_literal_in_public_text" });
    else if (!slots.includes(slot)) dropped.push({ kind: "name", reason: "slot_mismatch" });
    else if (nameSupport.where === "ai" && !(antecedent && singleOn(slot))) dropped.push({ kind: "name", reason: "antecedent_not_single" });
    else {
      // Explicit only when the human literally says the name while accepting it.
      const explicit = interpretation.intent === "name_acceptance" && nameSupport.where === "human" && singleOn(slot);
      const implicit = interpretation.intent === "name_acceptance" && singleOn(slot);
      name = { slot, name: nameSupport.span.text, agreement: explicit ? "explicit" : implicit ? "implicit" : "none" };
    }
  }

  const focus = [];
  for (const [mode, slot] of [["defer", interpretation.deferSlot], ["revisit", interpretation.revisitSlot]]) {
    if (!slot) continue;
    if (slots.includes(slot) || epistemic === "unresolved") focus.push({ slot, mode });
    else dropped.push({ kind: "focus", reason: "slot_not_referenced" });
  }
  return { human: mention, antecedent, feature, name, focus, dropped };
}
