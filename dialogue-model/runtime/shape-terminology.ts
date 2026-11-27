import type { JevDecisionPayload } from "./decision/jev-decision.ts";

export const SHAPE_TERMINOLOGY_GENERATION = "jev_generation_retry_v18";
export type ShapeTerminologyVersion = typeof SHAPE_TERMINOLOGY_GENERATION;
export const SHAPE_TERMINOLOGY = "この課題で「図形」は、画面に提示された一つの対象全体を指します。「この形」など、対話で対象全体を指す「形」も同じ意味で使われます。輪郭や構成、部分の性質を述べる「形」は、対象全体への参照と区別してください。どの対象かは公開対話と自分側の観察から判断し、呼び方の違いだけで別の対象とみなさないでください。";

export function isGenerationV18(version: unknown): version is ShapeTerminologyVersion {
  return version === SHAPE_TERMINOLOGY_GENERATION;
}

export function withShapeTerminology(prompt: string, version: unknown): string {
  return isGenerationV18(version) ? prompt + "\n" + SHAPE_TERMINOLOGY : prompt;
}

export function withShapeTerminologyQuestions(payload: JevDecisionPayload, version: unknown): JevDecisionPayload {
  if (!isGenerationV18(version)) return payload;
  return { ...payload, questions: Object.fromEntries(Object.entries(payload.questions).map(([key, question]) =>
    [key, { ...question, instructions: withShapeTerminology(question.instructions, version) }])) };
}
