/**
 * Crude string rules shared by the mock AI. This is a simulation for demo flow only: it never looks
 * at figure geometry and does not model perception, grounding or a decision to check.
 */
const PAIR_RE = /図形\s*([1-6１-６])\s*(?:は|を|が|→|:|：|=)\s*「?([^、。,.!?！？\s「」]{1,20})」?/g;
const FULL_WIDTH = "１２３４５６";

/**
 * 「図形N は X」 pairs in one message, keyed by the human's figure number (1..6). When the same
 * figure is mentioned more than once, the last mention wins (e.g. a description, then a name).
 */
export function extractNamePairs(text: string): Map<number, string> {
  const pairs = new Map<number, string>();
  for (const match of text.matchAll(PAIR_RE)) {
    const number = FULL_WIDTH.indexOf(match[1]) + 1 || Number(match[1]);
    pairs.delete(number);
    pairs.set(number, match[2]);
  }
  return pairs;
}
