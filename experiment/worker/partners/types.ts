import type { Figure } from "../../src/ai/protocol";

/** Future multimodal partner seam. Figures are already in AI order and use opaque slots. */
export interface PartnerTurnInput {
  figures: Figure[];
  history: Array<{ from: "ai" | "human"; text: string; at: number }>;
  publicCues: { humanStage: "chat" | "after_chat"; chatClosed: boolean };
}
export interface PartnerJudgement {
  /** Future VLM: whether to check now. */ checkNow: boolean;
  rationale?: string;
}
export interface PartnerTurnOutput {
  utterance?: string;
  judgement?: PartnerJudgement;
  endChat?: boolean;
}
export interface PartnerAdapter {
  readonly kind: "mock" | "external";
  respond(input: PartnerTurnInput): Promise<PartnerTurnOutput>;
  proposeNames(input: PartnerTurnInput): Promise<Record<string, string>>;
}
