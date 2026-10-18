// Research-only decision evidence. Public turns and AI-side hypotheses only;
// never the other participant's board, answer key, future turns, or gold labels.
import { STRATEGIES } from "../judgment/instructions.mjs";
import { validateOwnLedger } from "../judgment/schema.mjs";

const MAX_STATE_LENGTH = 20_000;
const MAX_UTTERANCES = 12;
const MAX_UTTERANCE_LENGTH = 2_000;

export function buildDecisionEvidence({ events, ownLedger, judgment, strategy }) {
  if (!STRATEGIES.includes(strategy) || !Array.isArray(events) ||
      !events.every((e) => e && ["human", "ai"].includes(e.speaker) &&
        typeof e.text === "string" && e.text.length <= MAX_UTTERANCE_LENGTH)) {
    throw new TypeError("invalid_public_evidence");
  }
  if (!judgment || typeof judgment !== "object") {
    throw new TypeError("invalid_ai_hypothesis");
  }
  const ledger = validateOwnLedger(ownLedger);
  const currentSlot = judgment.targetSlot;
  if (currentSlot !== null && (typeof currentSlot !== "string" || !Object.hasOwn(ledger, currentSlot))) {
    throw new TypeError("invalid_ai_hypothesis");
  }
  const hintText = (value, max) => value === null || value === undefined ? null :
    typeof value === "string" && value.length <= max ? value : (() => { throw new TypeError("invalid_ai_hypothesis"); })();

  const payload = {
    task: "二者による6図形の共同命名。見立ての類似と図形の同定と名称への合意は異なる。",
    strategy: strategy === "repair-first" ? "確認・修復を早めに選ぶ" : "必要に応じて判断保留や後の再訪を許容する",
    publicUtterances: events.slice(-MAX_UTTERANCES).map(({ speaker, text }) => ({
      speaker: speaker === "human" ? "相手" : "AI", text,
    })),
    ownNamingNotes: Object.fromEntries(Object.entries(ledger).map(([id, entry]) => [id, entry])),
    aiUnverifiedHypothesis: {
      ownTargetId: currentSlot,
      possibleName: hintText(judgment.candidateName, 200),
      visuallyDistinguishingFeature: hintText(judgment.discriminatingFeature, 400),
      // These fields were inferred by Luna, not verified against the other's board.
      certainty: "候補の見立て・識別特徴はAIの仮説であり、正解ではない",
    },
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_STATE_LENGTH) throw new RangeError("decision_state_too_large");
  return serialized;
}
