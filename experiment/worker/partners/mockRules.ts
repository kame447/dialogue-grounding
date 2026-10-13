/**
 * Scripted text of the mock AI. This is a simulation for demo flow only: it never looks at figure
 * geometry, never parses which figure the human means, and does not model perception, grounding or
 * a decision to check. It must not ask for or mention figure numbers (figures are unnumbered).
 */
/** Short and natural; the "does not see the figures" disclosure is a static note in the UI instead. */
export const MOCK_OPENING = "こんにちは。図形の名前を考えましょう。";

const PROMPTS = [
  "受け取りました。ほかの図形についてもどうぞ。",
  "その図形は、画面のどのあたりにありますか？",
  "呼び方の案があれば教えてください。",
  "受け取りました。6つとも話せたら「会話を終えて名前を決める」へ進んでください。",
];

/** Neutral reply for the n-th human message (0-based), independent of its content. */
export const mockReplyText = (n: number) => PROMPTS[n % PROMPTS.length];

/**
 * Six distinct placeholder answers for the AI slots. They are not derived from the conversation or
 * the human's figures, and the server neither scores nor shows them.
 */
export function mockPlaceholderNames(slots: string[]): Record<string, string> {
  return Object.fromEntries(slots.map((slot) => [slot, `模擬AI未判定-${slot}`]));
}
