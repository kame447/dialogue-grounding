// holistic_v5 judgment material: the same validated material the older versions send, written compactly.
// Public history is one numbered speaker line per event; a claim is a row that points at its source line by number instead of quoting it;
// figures are f0..f5 in ownSlots order; the ledger lists each figure's agreed name and every action that was executed on it.
// encode and decode are exact inverses except for the claims' quotes, which a reference replaces (a decoded claim has quote "" and a nominal source).
import type { JevAction, JevTarget } from "./contract.ts";

export const JUDGMENT_VIEW_V5 = "judgment_v5";
/** An action executed on figures in an earlier turn (the ledger's typed history). */
export type LedgerAction = { turn: number; action: JevAction; target: JevTarget; name: string | null; feature: string | null };
export type MaterialV5Context = { actions: readonly LedgerAction[]; nameLedger?: Record<string, { status: string; name: string | null }>;
  /** Partner claims that answered each repair turn, taken before any repair history was trimmed for the budget. */
  answers?: ReadonlyMap<number, readonly string[]> };
/** Appended to every question's instructions of a holistic_v5 judgment request, and nowhere else. */
export const JUDGMENT_V5_LEGEND = "stateの記法: publicTurnsは全公開発話を番号順に一度ずつ並べた行（U番号 h=人間 / ai: 発話）です。claimsの各行は" +
  " [claim id, 出典の発話番号, act, aspect, 対象, 名前, 返答先のclaim id, 命題, issueId] で、発言そのものは出典の発話番号の行を参照してください。" +
  "f0〜f5はownSlotsの順の自分の図形です。issuesは局所の論点で、各行は [issue id, aspect, 対象, state, nameState, 名前, 最後の発話番号, claim id] です。figuresは図形ごとに、名称の状態（statusとname）と、これまでに実行した行動 [行動, 発話番号, 名前または特徴, 返答のclaim id] を並べた履歴です。";

const alias = (slots: readonly string[], id: string) => "f" + slots.indexOf(id);
const unalias = (slots: readonly string[], f: string) => slots[Number(String(f).slice(1))];
const line = (t: { turn: number; speaker: string; text: string }) => `U${t.turn} ${t.speaker === "human" ? "h" : "ai"}: ${t.text}`;
const LINE = /^U(\d+) (h|ai): ([\s\S]*)$/u;

export function encodeMaterialV5(material: any, { actions, nameLedger, answers: allAnswers }: MaterialV5Context): Record<string, unknown> {
  const slots: string[] = material.ownSlots;
  const al = (ids: readonly string[]) => ids.map(id => alias(slots, id));
  const answers = allAnswers ?? new Map<number, string[]>(material.repairHistory.map((r: any) => [r.turn, r.partnerClaims.map((c: any) => c.id)]));
  const figures: Record<string, { status?: string; name?: string | null; actions: unknown[][] }> = {};
  for (const id of slots) figures[alias(slots, id)] = { ...(nameLedger?.[id] ? { status: nameLedger[id].status, name: nameLedger[id].name } : {}), actions: [] };
  for (const a of [...actions].sort((x, y) => x.turn - y.turn)) {
    const ids = a.target.kind === "single" ? [a.target.figureId] : a.target.kind === "multiple" ? a.target.figureIds : [];
    const detail = a.name ?? a.feature, replies = answers.get(a.turn) ?? [];
    const entry: unknown[] = [a.action, a.turn];
    if (detail !== null || replies.length) entry.push(detail);
    if (replies.length) entry.push(replies);
    for (const id of ids) if (figures[alias(slots, id)]) figures[alias(slots, id)].actions.push(entry);
  }
  return {
    view: JUDGMENT_VIEW_V5, turn: material.turn, ownSlots: slots,
    publicTurns: material.publicTurns.map(line),
    observations: material.observations, ...compactIssues(material.issueSummary, slots, new Set(material.priorClaims.map((c: any) => c.id))),
    claims: material.priorClaims.map((c: any) => [c.id, c.sourceTurn, c.act, c.aspect, al(c.targets), c.name, c.respondsTo, c.proposition, c.issueId]),
    repairHistory: material.repairHistory.map((r: any) => [r.turn, r.issueId, r.action, r.question,
      r.partnerClaims.map((c: any) => [c.id, c.act, al(c.targets), c.proposition]), al(r.candidatesBefore), al(r.candidatesAfter),
      r.addedClaimIds, r.removedClaimIds, r.progress, ...(r.facts ? [r.facts] : [])]),
    previousAction: material.previousAction, publicNames: material.publicNames, figures,
    reobservationAllowed: material.reobservationAllowed,
    ...(material.selected ? { selected: material.selected } : {}),
    ...(material.humanReferent ? { humanReferent: material.humanReferent } : {}),
    ...(material.repairProspect ? { repairProspect: material.repairProspect } : {}),
    inputBudget: material.inputBudget,
  };
}

// The local issue summary repeats its claims' propositions; the written form keeps each issue's identity and state and points at the claims by id (only ones that are in `claims`).
function compactIssues(summary: string, slots: readonly string[], kept: ReadonlySet<string>): Record<string, unknown> {
  let parsed: any;
  try { parsed = JSON.parse(summary); } catch { return { issueSummary: summary }; }
  if (!parsed || !Array.isArray(parsed.issues)) return { issueSummary: summary };
  return { issues: [...(parsed.omitted ? [{ omitted: parsed.omitted }] : []), ...parsed.issues.map((i: any) => [i.issueId, i.aspect, (i.targets ?? []).map((id: string) => alias(slots, id)),
    i.state, i.nameState, i.name, i.lastTurn, (i.claimIds ?? []).filter((id: string) => kept.has(id))])] };
}
/** The older material shape of an encoded state (the S4 verifier's input); `view` and `figures` stay as they are. */
export function decodeMaterialV5(state: any): any {
  const slots: string[] = state.ownSlots;
  const un = (ids: readonly string[]) => ids.map(f => unalias(slots, f));
  const publicTurns = state.publicTurns.map((s: string) => {
    const m = LINE.exec(s);
    if (!m) throw new Error("invalid_v5_line");
    return { turn: Number(m[1]), speaker: m[2] === "h" ? "human" : "ai", text: m[3] };
  });
  const speakerAt = new Map<number, string>(publicTurns.map((t: any) => [t.turn, t.speaker]));
  const priorClaims = state.claims.map(([id, sourceTurn, act, aspect, targets, name, respondsTo, proposition, issueId]: any[]) => {
    const speaker = speakerAt.get(sourceTurn) ?? "human";
    return { id, turn: sourceTurn, issueId, targets: un(targets), aspect, act, proposition, name, speaker, sourceTurn, quote: "", respondsTo,
      source: speaker === "human" ? "partner_statement" : "ai_hypothesis" };
  });
  const repairHistory = state.repairHistory.map(([turn, issueId, action, question, partnerClaims, before, after, added, removed, progress, facts]: any[]) => ({
    turn, issueId, action, question, partnerClaims: partnerClaims.map(([id, act, targets, proposition]: any[]) => ({ id, act, proposition, targets: un(targets) })),
    candidatesBefore: un(before), candidatesAfter: un(after), addedClaimIds: added, removedClaimIds: removed, progress, ...(facts ? { facts } : {}) }));
  const { claims: _claims, issues, ...rest } = state;
  const issueSummary = Array.isArray(issues) ? JSON.stringify({ scope: "private_local_issues_not_ground_truth", omitted: issues.find((i: any) => !Array.isArray(i))?.omitted ?? 0,
    issues: issues.filter((i: unknown) => Array.isArray(i)).map(([issueId, aspect, targets, st, nameState, name, lastTurn, claimIds]: any[]) =>
      ({ issueId, aspect, targets: un(targets), state: st, nameState, name, claimIds, lastTurn, claims: [] })) }) : rest.issueSummary;
  return { ...rest, issueSummary, publicTurns, priorClaims, repairHistory };
}

/** Claims that must outlive the others when the request is over its budget: names, replies to confirmations, and what those answer. Lower is dropped first. */
export function claimKeepOrder(claims: readonly { id: string; act: string; name: string | null; sourceTurn: number; respondsTo: string | null }[],
  repairHistory: readonly { partnerClaims: readonly { id: string }[] }[]): string[] {
  const replies = new Set(repairHistory.flatMap(r => r.partnerClaims.map(c => c.id)));
  const named = new Set(claims.filter(c => c.name !== null || c.act.startsWith("name_")).map(c => c.id));
  const answered = new Set(claims.filter(c => named.has(c.id) || replies.has(c.id)).map(c => c.respondsTo).filter((id): id is string => id !== null));
  const rank = (c: { id: string; sourceTurn: number }) => (named.has(c.id) ? 2e6 : 0) + (replies.has(c.id) ? 1e6 : 0) + (answered.has(c.id) ? 5e5 : 0) + c.sourceTurn;
  return [...claims].sort((a, b) => rank(a) - rank(b)).map(c => c.id);
}
