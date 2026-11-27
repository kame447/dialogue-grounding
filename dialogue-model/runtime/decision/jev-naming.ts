import { literalSpan } from "../judgment/public-evidence.mjs";
import type { LocalClaimView, LocalFunctionVerdict, LocalSegmentProposal, PublicTurn } from "../local-grounding/contract.ts";
import type { JevDecisionStageEvidence, JevNamingGrounding, PublicNameCandidate } from "./contract.ts";

type LocalEvidence = {
  extractor: { segments: readonly LocalSegmentProposal[] };
  classifier: { status: string; verdicts: readonly Pick<LocalFunctionVerdict, "segmentId" | "act">[] };
  verification: { rejected: readonly { segmentId: string; reason: string }[] };
};

/** Extract literal, public names without treating a proposed target as decided. */
export function buildJevNamingMaterial(claims: readonly LocalClaimView[], turns: readonly PublicTurn[], turn: number,
  local: LocalEvidence | null | undefined) {
  const names = new Map<string, PublicNameCandidate>();
  const add = (name: string, sourceTurn: number, utterance: string) => {
    const span = literalSpan(utterance, name);
    if (span && span.text.length <= 80) {
      names.set(JSON.stringify([span.text, sourceTurn]), { name: span.text, figureId: null, sourceTurn });
    }
  };
  for (const claim of claims) {
    if (claim.speaker !== "human" || claim.aspect !== "name" ||
        (claim.act !== "name_propose" && claim.act !== "name_accept") || !claim.name) continue;
    const source = turns.find(t => t.turn === claim.sourceTurn && t.speaker === "human");
    const span = literalSpan(claim.quote, claim.name);
    if (source && span && literalSpan(source.text, claim.quote)) add(span.text, source.turn, claim.quote);
  }

  const human = turns.find(t => t.turn === turn && t.speaker === "human");
  const localRejections = [];
  if (human && local?.classifier.status === "ok") {
    for (const rejection of local.verification.rejected) {
      const segment = local.extractor.segments.find(s => s.segmentId === rejection.segmentId);
      const quote = segment && literalSpan(human.text, segment.quote);
      if (!segment || !quote) continue;
      localRejections.push({ quote: quote.text, reason: rejection.reason });
      const matches = local.classifier.verdicts.filter(v => v.segmentId === rejection.segmentId);
      if (matches.length === 1 && segment.aspect === "name" && segment.name &&
          (matches[0].act === "name_propose" || matches[0].act === "name_accept")) add(segment.name, turn, quote.text);
    }
  }
  return { names: [...names.values()], localRejections };
}

/** Projection of the existing detail result, never a program judgment of meaning. */
export function readJevNamingGrounding(detail: Pick<JevDecisionStageEvidence, "stage" | "choices"> | null | undefined,
  turns: readonly PublicTurn[], name: string | null, names: readonly PublicNameCandidate[]): JevNamingGrounding {
  const choices = detail?.stage === "detail" ? detail.choices : undefined;
  const verdict = choices?.naming_grounding;
  const namedGrounding = typeof choices?.name === "string" && verdict === "grounded_" + choices.name;
  const source = /^turn_([1-9][0-9]*)$/u.exec(choices?.naming_evidence ?? "");
  const evidenceTurn = source ? Number(source[1]) : null;
  const current = name !== null && evidenceTurn !== null && names.some(n => n.name === name && n.sourceTurn === evidenceTurn) &&
    turns.some(t => t.turn === evidenceTurn && t.speaker === "human" && literalSpan(t.text, name));
  return {
    verdict: verdict === "unresolved" || verdict === "contradicted" ? verdict
      : namedGrounding && current ? "grounded" : "unconfirmed",
    evidenceTurn: current ? evidenceTurn : null,
  };
}
