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
  "受け取りました。話し合いが済んだら「会話を終了する」を押してください。",
];

/** Neutral reply for the n-th human message (0-based), independent of its content. */
export const mockReplyText = (n: number) => PROMPTS[n % PROMPTS.length];

/**
 * The mock AI's post-conversation answers. It cannot see the figures or resolve references, so it
 * honestly answers "not agreed / don't know" (null) for every figure. Mock rooms are never scored.
 */
export function mockAnswers(slots: string[]): Record<string, null> {
  return Object.fromEntries(slots.map((slot) => [slot, null]));
}
