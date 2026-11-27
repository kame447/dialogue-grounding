import type { JevNamingGrounding, PublicNameCandidate } from "../../decision/contract.ts";
import { literalSpan } from "../../judgment/public-evidence.mjs";
import { normalizeName } from "../../judgment/name-evidence.mjs";
import { equal } from "./core.ts";

export const NAMING_GUIDANCE = "namingEvidence.namesは人が公開発話で述べた実在の名前です。名前の候補があることは、どの図形かが確定したことも、現在の合意も意味しません。公開発話を読み、局所の棄却、否定の論点、古い記述、対象推定は誤り得る材料として扱ってください。受け止めるだけならaccept、同定の確認が要るならconfirmなどを自分で選んでください。agreeを選んでも、後の判定で根拠が足りなければ名前は確定しません。";
const HOLD_TEXT = "今お話ししている形は、どの特徴を目印にすると見分けられそうですか？";
const namingActs = new Set(["name_propose", "name_accept"]);

export function namingMaterial(claims: any[], turns: any[], trace: any) {
  const names: PublicNameCandidate[] = [];
  const localRejections: { quote: string; reason: string }[] = [];
  const humanTurns = new Map(turns.filter(t => t.speaker === "human").map(t => [t.turn, t.text]));
  const add = (turn: number, quote: string, candidate: string) => {
    const span = literalSpan(quote, candidate);
    if (span && span.text.length <= 80 && !names.some(n => n.name === span.text && n.sourceTurn === turn)) {
      names.push({ name: span.text, figureId: null, sourceTurn: turn });
    }
  };
  for (const c of claims) {
    const speech = humanTurns.get(c.sourceTurn);
    if (c.speaker === "human" && c.aspect === "name" && namingActs.has(c.act) && c.name && literalSpan(speech, c.quote)) {
      add(c.sourceTurn, c.quote, c.name);
    }
  }
  const local = trace.local;
  if (local?.classifier?.status === "ok") {
    for (const rejection of local.verification.rejected) {
      const segment = local.extractor.segments.find((s: any) => s.segmentId === rejection.segmentId);
      const quote = segment && literalSpan(humanTurns.get(trace.turnIndex), segment.quote);
      if (!quote) continue;
      localRejections.push({ quote: quote.text, reason: rejection.reason });
      const verdicts = local.classifier.verdicts.filter((v: any) => v.segmentId === segment.segmentId);
      if (verdicts.length === 1 && namingActs.has(verdicts[0].act) && segment.aspect === "name" && segment.name) {
        add(trace.turnIndex, quote.text, segment.name);
      }
    }
  }
  return { names, localRejections };
}

export function namingInputMatches(input: any, material: ReturnType<typeof namingMaterial>, turns: any[], claims: any[]) {
  if (!Array.isArray(input.publicTurns) || !Array.isArray(input.priorClaims)) return false;
  const publicTurns = turns.map(({ turn, speaker, text }) => ({ turn, speaker, text }));
  const retained = new Map(input.publicTurns.map((t: any) => [t.turn, t]));
  if (retained.size !== input.publicTurns.length ||
      !equal(input.publicTurns, publicTurns.filter(t => retained.has(t.turn))) ||
      input.inputBudget?.omitted?.publicTurns !== turns.length - retained.size) return false;
  const expected = material.names.flatMap(n => {
    const speech = publicTurns.find(t => t.turn === n.sourceTurn);
    const span = retained.has(n.sourceTurn) && literalSpan(speech?.text, n.name);
    return span ? [{ ...n, name: span.text }] : [];
  });
  if (!equal(input.namingEvidence, { names: expected, localRejections: material.localRejections })) return false;
  // The compact format omits claim quotes and derives speakers from retained public turns.
  const claimRow = (c: any) => [c.id, c.sourceTurn, c.act, c.aspect, c.targets, c.name, c.respondsTo, c.proposition, c.issueId];
  const saved = new Set(input.priorClaims.map((c: any) => c.id));
  return saved.size === input.priorClaims.length &&
    input.inputBudget?.omitted?.claims === claims.length - saved.size &&
    equal(input.priorClaims.map(claimRow), claims.filter(c => saved.has(c.id) && retained.has(c.sourceTurn)).map(claimRow));
}

export function namingQuestions(instructions: string, target: unknown, candidates: { value: string }[], publicNames: PublicNameCandidate[]) {
  const proposalsByTurn = new Map<number, string[]>();
  for (const { value } of candidates) {
    const latest = Math.max(0, ...publicNames.filter(n => n.name === value).map(n => n.sourceTurn));
    if (latest) proposalsByTurn.set(latest, [...(proposalsByTurn.get(latest) ?? []), value]);
  }
  return {
    naming_grounding: { type: "choice",
      instructions: instructions + "\n選択済みの図形に関し、公開された人の提案と対象の同定に根拠がある組を選んでください。名前の提案だけや特徴一つへの肯定で同定したことにはなりません。未確定や矛盾をそのまま選べます。",
      criteria: {
        unresolved: "同じ対象への命名だと公開のやり取りから確かめられない。",
        contradicted: "対象または提案の意味に解消していない矛盾がある。",
        ...Object.fromEntries(candidates.map(({ value }, i) => [`grounded_name_${i}`,
          JSON.stringify({ name: value, target, grounding: "公開のやり取りから、この図形に対するこの名前の提案と同定を確認できる。" })])),
      },
    },
    naming_evidence: { type: "choice",
      instructions: instructions + "\n同定に根拠があると判断した名前について、その名称を提示した相手の公開手番を選んでください。提案の存在だけで同定や同意を示すわけではありません。不足や矛盾が解けなければnoneを選んでください。",
      criteria: { none: "根拠を示せない。",
        ...Object.fromEntries([...proposalsByTurn].map(([sourceTurn, names]) => [`turn_${sourceTurn}`,
          JSON.stringify({ sourceTurn, names, target })])) },
    },
  };
}

export function namingVerdict(execution: any, intervention: any, decision: any, names: PublicNameCandidate[]): JevNamingGrounding | undefined {
  if (execution?.action !== "agree") return undefined;
  const stage = intervention?.disposition === "rejected" ? intervention.detailEvidence : decision?.evidence?.stages?.at(-1);
  const choices = stage?.stage === "detail" ? stage.choices : undefined;
  const source = names.find(n => n.name === execution.name && choices?.naming_evidence === `turn_${n.sourceTurn}`);
  const verdict = choices?.naming_grounding;
  return {
    verdict: verdict === "unresolved" || verdict === "contradicted" ? verdict
      : source && typeof choices?.name === "string" && verdict === `grounded_${choices.name}` ? "grounded" : "unconfirmed",
    evidenceTurn: source?.sourceTurn ?? null,
  };
}

export function namingHold(grounding: JevNamingGrounding | undefined, execution: any, ledger: any) {
  if (!grounding || execution.target.kind !== "single") return null;
  const figureId = execution.target.figureId;
  const entry = ledger[figureId];
  const name = normalizeName(execution.name);
  const conflict = entry.name !== null && entry.status !== "tentative" && normalizeName(entry.name) !== name ||
    Object.entries(ledger).some(([id, other]: [string, any]) => id !== figureId && other.name !== null && normalizeName(other.name) === name);
  const reason = grounding.verdict !== "grounded" ? "naming_grounding_unresolved" : conflict ? "naming_ledger_conflict" : null;
  return reason && holdPublication(reason, figureId);
}

export function holdPublication(reason: unknown, figureId: string) {
  if (reason !== "naming_grounding_unresolved" && reason !== "naming_ledger_conflict") return null;
  return { recovery: { reason, act: "confirm_current_topic" }, judgment: {
    action: "confirm", targetSlot: figureId, candidateName: null, discriminatingFeature: null, note: null,
  }, text: HOLD_TEXT };
}
