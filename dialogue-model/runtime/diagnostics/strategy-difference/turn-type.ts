// RESEARCHER ONLY. Heuristic turn type of the human message(s) answered by one
// AI turn, from public text only. Fixed priority; the first matching type wins.
// An engineering aid for tabulation, not an annotation scheme or a gold label.
export const TURN_TYPES = Object.freeze(["revisit_request", "defer_request", "uncertainty", "topic_shift", "naming_proposal", "answer", "greeting", "description", "none"] as const);
export type TurnType = typeof TURN_TYPES[number];

const RULES: readonly [TurnType, RegExp][] = [
  ["revisit_request", /戻りましょう|戻ろう|戻って|戻りたい|もう一度相談|相談し直/],
  ["defer_request", /後で|あとで|後回し|保留|置いておこう|置いとこ|決めないでおこう|まだ決めない|後にしよう/],
  ["uncertainty", /迷う|迷って|分からない|わからない|どっち|自信がない|違う|ちがう|うーん|ではない|じゃなくて|区別がつかない/],
  ["topic_shift", /次は|次、|次の|別の|ほかの|他の|残り|最後の/],
  ["naming_proposal", /って呼|と呼|でどう|にしよう|にしましょう|でいい|で決ま|でいきましょう|はどう/],
  ["answer", /^(はい|うん|そう|それ|たぶん|ええ|いいえ)/],
];
const GREETING = /よろしく|こんにちは|はじめまして/;

export function classifyHumanTurn(texts: readonly string[]): TurnType {
  const joined = texts.map((t) => t.trim()).filter(Boolean).join("\n");
  if (!joined) return "none";
  for (const [type, pattern] of RULES) if (pattern.test(joined)) return type;
  if (GREETING.test(joined) && joined.replace(GREETING, "").replace(/[、。！!？?\s]|お願いします/g, "").length <= 4) return "greeting";
  return "description";
}
