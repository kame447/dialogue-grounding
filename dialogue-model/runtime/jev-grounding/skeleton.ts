// Label-skeleton rendering: turns a labelled historical row into a short
// synthetic utterance built only from its labels (a-functions and the
// Holistic/Analytic tag) and a fixed invented lexicon. No characters of the
// original utterance are used, so the result carries the label sequence and the
// speaker alternation but none of the participants' wording or figure content.
//
// Limits: the rendered text encodes the labels it came from (for example a12
// becomes an explicit denial), so skeleton cases test plumbing and label-cue
// reading, not grounding judgement on real descriptions. Because they are
// derived from historical label sequences they are local-only (not sendable);
// real calls use from-scratch synthetic cases authored separately.
import type { LabeledRow } from "./labels.ts";

export const SKELETON_VERSION = "jev-grounding-skeleton/v1";

const IMPRESSIONS = Object.freeze(["鳥", "船", "家", "うさぎ", "帽子", "矢印", "人", "魚", "山", "椅子"]);
const FEATURES = Object.freeze(["三角の部分", "四角い出っ張り", "細長い部分", "くぼみ", "尖った先", "平らな底"]);

const PHRASES: Readonly<Record<string, (ctx: { impression: string; feature: string; analytic: boolean }) => string>> = Object.freeze({
  a1: () => "うん。",
  a2: () => "あー。",
  a3: () => "なるほど、わかりました。",
  a4: () => "はい。",
  a5: () => "あ、なるほど。",
  a6: () => "いいですね。",
  a7: () => "じゃあ次の図形にいきましょう。",
  a8: (c) => (c.analytic ? `${c.feature}があるやつですか？` : "どれのことですか？"),
  a9: (c) => `${c.analytic ? c.feature : c.impression}。`,
  a10: (c) => `${c.feature}のところとか。`,
  a11: (c) => (c.analytic ? "そうですね、それです。" : `${c.impression}でいいと思います。`),
  a12: () => "いや、それは違うと思います。",
  a13: () => "楽しいですね。",
  a14: () => "うーん、いやだな。",
  a15: () => "えーと、どれだろう。",
  a16: () => "たぶん、かな。",
  a17: () => "本当にそうですか？",
  a18: () => "え、どういうことですか？",
  a20: () => "（笑）",
  a25: () => "お願いします。",
  a26: () => "あの、",
  a28: () => "うーん。",
  a30: () => "えー、",
});

/** Deterministic synthetic text for one row. The episode index picks the invented impression. */
export function renderSkeleton(row: LabeledRow): string {
  const analytic = row.ah.some((t) => t === "Analytic" || t === "Ack analytic" || t === "Deny analytic");
  const holistic = row.ah.some((t) => t === "Holistic");
  const ctx = {
    impression: IMPRESSIONS[(row.episode ?? 0) % IMPRESSIONS.length],
    feature: FEATURES[row.position % FEATURES.length],
    analytic,
  };
  const parts: string[] = [];
  for (const label of row.aLabels) {
    const phrase = PHRASES[label]?.(ctx);
    if (phrase && !parts.includes(phrase)) parts.push(phrase);
  }
  if (holistic) parts.push(`${ctx.impression}みたいに見えます。`);
  else if (row.ah.includes("Analytic")) parts.push(`${ctx.feature}がある形です。`);
  return parts.length > 0 ? parts.join("") : "……";
}
