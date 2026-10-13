import type {
  PartnerAdapter,
  PartnerTurnInput,
  PartnerTurnOutput,
} from "./types";
import { MOCK_OPENING, mockAnswers, mockReplyText } from "./mockRules";

/**
 * Explicitly a scripted simulation. It has no perception, does not inspect figure geometry and does
 * not resolve references; replies only depend on how many human turns there were.
 */
export class MockAi implements PartnerAdapter {
  readonly kind = "mock" as const;

  async respond(input: PartnerTurnInput): Promise<PartnerTurnOutput> {
    const humanTurns = input.history.filter((m) => m.from === "human").length;
    return { utterance: humanTurns === 0 ? MOCK_OPENING : mockReplyText(humanTurns - 1) };
  }

  async proposeNames(input: PartnerTurnInput): Promise<Record<string, null>> {
    return mockAnswers(input.figures.map((figure) => figure.slot));
  }
}
