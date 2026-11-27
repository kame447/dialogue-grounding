// holistic_v5 judgment material: the same validated material the older versions send, written compactly.
// Public history is one numbered speaker line per event; a claim is a row that points at its source line by number instead of quoting it;
// figures are f0..f3 or f0..f5 in ownSlots order; the ledger lists each figure's agreed name and every action that was executed on it.
// encode and decode are exact inverses except for the claims' quotes, which a reference replaces (a decoded claim has quote "" and a nominal source).
import type { JevDecisionAction, JevTarget } from "./contract.ts";
import { issueTargetIds, ISSUE_HANDLING_VERSION } from "./issue-handling.ts";
import type { CarryDestination, ExecutedExtra, JevIssueRef } from "./issue-handling.ts";
import { isSupportedFigureCount } from "../stimuli/figure-bank.ts";
import { repairQualityEvidence } from "./repair-quality.ts";

export const JUDGMENT_VIEW_V5 = "judgment_v5";
/** An action executed on figures in an earlier turn (the ledger's typed history). */
export type LedgerAction = { turn: number; action: JevDecisionAction; target: JevTarget; name: string | null; feature: string | null;
  issue?: JevIssueRef; destination?: CarryDestination; extras?: readonly ExecutedExtra[];
  /** The partner claims that answered this action's check, read from the whole (ungated) repair history: they stay defined even after the issue closed. */
  answers?: readonly { id: string; act: string; proposition: string; targets: readonly string[] }[] };
export type MaterialV5Context = { actions: readonly LedgerAction[]; nameLedger?: Record<string, { status: string; name: string | null }>;
  /** Partner claims that answered each repair turn, taken before any repair history was trimmed for the budget. */
  answers?: ReadonlyMap<number, readonly string[]>;
  /** The stimulus rotation, written into the state so a verifier reads the same condition the instructions used. */
  rotationMode?: string;
  /** jev_generation_retry_v6: written into the state so a verifier knows every question carried the legend. */
  notationV6?: boolean;
  notationV11?: boolean;
  /** The answering claims the ledger points at, by id: one that is not a row of `claims` is written as an `answerClaims` row, so every id is defined in the same request. */
  answerRows?: ReadonlyMap<string, { sourceTurn: number | null; act: string; proposition: string; targets: readonly string[] }> };
/** Appended to every question's instructions of a holistic_v5 judgment request, and nowhere else. */
export const JUDGMENT_V5_LEGEND = "stateの記法: publicTurnsは全公開発話を番号順に一度ずつ並べた行（U番号 h=人間 / ai: 発話）です。claimsの各行は" +
  " [claim id, 出典の発話番号, act, aspect, 対象, 名前, 返答先のclaim id, 命題, issueId] で、発言そのものは出典の発話番号の行を参照してください。" +
  "f0〜f5はownSlotsの順の自分の図形です。issuesは局所の論点で、各行は [issue id, aspect, 対象, state, nameState, 名前, 最後の発話番号, claim id] です。figuresは図形ごとに、名称の状態（statusとname）と、これまでに実行した行動 [行動, 発話番号, 名前または特徴, 返答のclaim id] を並べた履歴です。";

export function judgmentV5Legend(figureCount: number = 6): string {
  if (!isSupportedFigureCount(figureCount)) throw new TypeError("Unsupported figure count");
  return figureCount === 4 ? JUDGMENT_V5_LEGEND.replace("f0〜f5", "f0〜f3") : JUDGMENT_V5_LEGEND;
}

/** jev_generation_retry_v11: appended after the legend when a figure's history points at an answer the request's claims do not carry. */
export const JUDGMENT_V11_ANSWER_LEGEND = "answerClaimsは、figuresの返答のclaim idがclaimsにない行動のためだけに添える行で、各行は [claim id, 出典の発話番号, act, 対象, 命題] です。グラフから外れた回答の出典の発話番号はnullになります。";
export const ISSUE_HANDLING_LEGEND = "handlingsの各行は [手番, 実際に公開した行動, 対象の図形, 論点のIDまたは種類, 移る先] です。移る先の図形はf番号、旧い論点は[old_issue, 論点のIDまたは種類, 図形の配列]で表します。";
export const PREVIOUS_EXTRAS_LEGEND = "previousExtrasの各行は、直前に公開した追加の扱いの [行動, 対象の図形, 論点のID] です。";

const alias = (slots: readonly string[], id: string) => "f" + slots.indexOf(id);
const unalias = (slots: readonly string[], f: string) => slots[Number(String(f).slice(1))];
const line = (t: { turn: number; speaker: string; text: string }) => `U${t.turn} ${t.speaker === "human" ? "h" : "ai"}: ${t.text}`;
const LINE = /^U(\d+) (h|ai): ([\s\S]*)$/u;

type HandledLedgerAction = Pick<LedgerAction, "turn" | "action" | "target" | "destination"> & { issue: JevIssueRef };

export function recentHandlings(actions: readonly LedgerAction[]): HandledLedgerAction[] {
  const rows: HandledLedgerAction[] = [];
  for (const action of [...actions].sort((a, b) => a.turn - b.turn)) {
    if (action.issue && ["hold_open", "carry_over", "consult", "revisit"].includes(action.action)) rows.push({ ...action, issue: action.issue });
    for (const extra of action.extras ?? []) {
      if ("issue" in extra) rows.push({ turn: action.turn, action: extra.action, target: extra.target, issue: extra.issue });
    }
  }
  return rows.slice(-16);
}

const issueLabel = (issue: JevIssueRef) => issue.kind === "resolve_issue" ? issue.issueId : issue.kind;

function handlingRows(actions: readonly LedgerAction[], slots: readonly string[]) {
  return recentHandlings(actions).map(({ turn, action, target, issue, destination }) => {
    const next = destination?.kind === "other_figure" ? [destination.kind, alias(slots, destination.figureId)]
      : destination?.kind === "old_issue" ? [destination.kind, issueLabel(destination.issue), destination.targets.map(id => alias(slots, id))]
        : destination?.kind ?? null;
    return [turn, action, issueTargetIds(target).map(id => alias(slots, id)), issueLabel(issue), next];
  });
}

export function encodeMaterialV5(material: any, { actions, nameLedger, answers: allAnswers, rotationMode, answerRows, notationV6, notationV11 }: MaterialV5Context): Record<string, unknown> {
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
    view: JUDGMENT_VIEW_V5, ...(rotationMode ? { rotationMode } : {}), ...(notationV6 ? { notationV6: true } : {}), ...(notationV11 ? { notationV11: true } : {}), turn: material.turn, ownSlots: slots,
    publicTurns: material.publicTurns.map(line),
    observations: material.observations, ...compactIssues(material.issueSummary, slots, new Set(material.priorClaims.map((c: any) => c.id))),
    claims: material.priorClaims.map((c: any) => [c.id, c.sourceTurn, c.act, c.aspect, al(c.targets), c.name, c.respondsTo, c.proposition, c.issueId]),
    repairHistory: material.repairHistory.map((r: any) => [r.turn, r.issueId, r.action, r.question,
      r.partnerClaims.map((c: any) => [c.id, c.act, al(c.targets), c.proposition]), al(r.candidatesBefore), al(r.candidatesAfter),
      r.addedClaimIds, r.removedClaimIds, r.progress, ...(r.facts ? [r.facts] : [])]),
    ...answerClaimRows(figures, material, slots, answerRows),
    previousAction: material.previousAction, publicNames: material.publicNames, figures,
    reobservationAllowed: material.reobservationAllowed,
    ...(material.selected ? { selected: material.selected } : {}),
    ...(material.humanReferent ? { humanReferent: material.humanReferent } : {}),
    ...(material.repairProspect ? { repairProspect: material.repairProspect } : {}),
    ...(material.sharedConstruals?.length ? { sharedConstruals: material.sharedConstruals } : {}),
    ...(material.namingEvidence ? { namingEvidence: material.namingEvidence } : {}),
    ...(material.referenceEvidence ? { referenceEvidence: material.referenceEvidence } : {}),
    ...(material.visualPurposeVersion ? { visualPurposeVersion: material.visualPurposeVersion } : {}),
    ...(material.issueHandlingVersion === ISSUE_HANDLING_VERSION ? {
      issueHandlingVersion: ISSUE_HANDLING_VERSION, handlings: handlingRows(actions, slots),
      ...(material.previousExtras?.length ? {
        previousExtras: (material.previousExtras as readonly ExecutedExtra[]).map(extra =>
          [extra.action, al(issueTargetIds(extra.target)), issueLabel("issue" in extra ? extra.issue : extra.visualPurpose)]),
      } : {}),
    } : {}),
    ...(material.judgmentMaterialVersion ? {
      judgmentMaterialVersion: material.judgmentMaterialVersion,
      repairQuality: repairQualityEvidence(material.turn, material.publicTurns, material.priorClaims, material.repairHistory),
      ...(material.publicationRecoveryContext ? { publicationRecoveryContext: material.publicationRecoveryContext } : {}),
    } : {}),
    inputBudget: material.inputBudget,
  };
}

// An answer id the ledger points at but the request's claims do not carry gets its own row [id, source turn, act, targets, proposition]; nothing is written when every id is a claim row.
function answerClaimRows(figures: Record<string, { actions: unknown[][] }>, material: any, slots: readonly string[],
  rows: MaterialV5Context["answerRows"]): Record<string, unknown> {
  if (!rows) return {};
  const carried = new Set<string>(material.priorClaims.map((c: any) => c.id));
  const ids = [...new Set(Object.values(figures).flatMap(f => f.actions.flatMap(a => Array.isArray(a[3]) ? (a[3] as string[]) : [])))].filter(id => !carried.has(id) && rows.has(id));
  return ids.length ? { answerClaims: ids.map(id => { const r = rows.get(id)!; return [id, r.sourceTurn, r.act, r.targets.map(t => alias(slots, t)), r.proposition]; }) } : {};
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

/** Drop order for unprotected claims. Keep names, replies to confirmations, and what those answer longer. */
export function claimKeepOrder(claims: readonly { id: string; act: string; name: string | null; sourceTurn: number; respondsTo: string | null }[],
  repairHistory: readonly { partnerClaims: readonly { id: string }[] }[], protectedClaims?: ReadonlySet<string>): string[] {
  const replies = new Set(repairHistory.flatMap(r => r.partnerClaims.map(c => c.id)));
  const named = new Set(claims.filter(c => c.name !== null || c.act.startsWith("name_")).map(c => c.id));
  const answered = new Set(claims.filter(c => named.has(c.id) || replies.has(c.id)).map(c => c.respondsTo).filter((id): id is string => id !== null));
  const rank = (c: { id: string; sourceTurn: number }) => (named.has(c.id) ? 2e6 : 0) + (replies.has(c.id) ? 1e6 : 0) + (answered.has(c.id) ? 5e5 : 0) + c.sourceTurn;
  return [...claims].sort((a, b) => rank(a) - rank(b)).map(c => c.id).filter(id => !protectedClaims?.has(id));
}
