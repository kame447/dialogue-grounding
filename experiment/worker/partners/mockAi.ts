import type {
  PartnerAdapter,
  PartnerTurnInput,
  PartnerTurnOutput,
} from "./types";
import type { RoomState } from "../roomCore";
import { mockNames } from "../roomCore";
import { extractNamePairs } from "./mockRules";

const PROMPTS = [
  "図形1は…の形ですか？",
  "図形2は…と呼べそうですか？",
  "図形3はどんな名前がよいでしょう？",
];

function recordedFrom(
  history: PartnerTurnInput["history"],
): Map<number, string> {
  const recorded = new Map<number, string>();
  for (const message of history) {
    if (message.from !== "human") continue;
    for (const [number, name] of extractNamePairs(message.text)) recorded.set(number, name);
  }
  return recorded;
}

/** Explicitly a scripted simulation. It has no perception and does not inspect figure geometry. */
export class MockAi implements PartnerAdapter {
  readonly kind = "mock" as const;

  async respond(input: PartnerTurnInput): Promise<PartnerTurnOutput> {
    const latest = [...input.history]
      .reverse()
      .find((message) => message.from === "human");
    if (!latest) {
      return {
        utterance: [
          "（模擬AI）こんにちは。私は動作確認用の模擬AIで、図形は見ていません。",
          "「図形2は鳥」のように番号と名前を書いてもらえれば、",
          "その名前を記録して最後に提出します。",
        ].join(""),
      };
    }

    const recorded = recordedFrom(input.history);
    const missing = [1, 2, 3, 4, 5, 6].filter(
      (number) => !recorded.has(number),
    );
    if (missing.length === 0) {
      return {
        utterance: [
          "（模擬AI）6つの名前を記録しました。",
          "「会話を終えて名前を決める」から提出に進めます。",
        ].join(""),
      };
    }

    const captured = [...extractNamePairs(latest.text)];
    if (captured.length > 0) {
      return {
        utterance: `（模擬AI）${captured
          .map(
            ([number, label]) =>
              `図形${number}を「${label}」として記録しました。`,
          )
          .join(
            "",
          )}未記録: ${missing.map((number) => `図形${number}`).join("・")}`,
      };
    }

    const promptCount = input.history.filter(
      (message) => message.from === "human" && extractNamePairs(message.text).size === 0,
    ).length;
    return {
      utterance: `（模擬AI）${PROMPTS[(promptCount - 1) % PROMPTS.length]}`,
    };
  }

  async proposeNames(
    input: PartnerTurnInput,
    state?: RoomState,
  ): Promise<Record<string, string>> {
    if (state) return mockNames(state);
    return Object.fromEntries(
      input.figures.map((figure, index) => [figure.slot, `未記録${index + 1}`]),
    );
  }
}
