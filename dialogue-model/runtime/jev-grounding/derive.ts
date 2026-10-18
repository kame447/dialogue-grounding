// Conservative gold derivation for the two Jev evidence axes from historical
// labels. Data-free rules; the private build applies them to the preprocessed rows.
//
// What the labels can support (and what they cannot):
// - ER is the episode-level outcome: ER1 = a name or identifiable descriptor was
//   jointly adopted, ER0 = not. It supports the name axis at episode end only.
//   ER1 is not independent correctness: both people may have adopted one name for
//   different figures. correctnessKnown is therefore always false.
// - M records the local sharing state but not its dimension (target, position,
//   orientation, feature, name...). M4 is local sharing, not "same referent
//   confirmed"; M2 is a public problem of an unknown dimension. Every target-axis
//   value derived from M is therefore "weak", and M2 alone gives "insufficient";
//   "contradicted" needs an explicit denial (a12 / Deny) as well. Whether M4 at a
//   commitment point may count as target sharing is a researcher decision.
// - a11 (agreement) / a3 (acceptance) / a9 (repetition) / a4 (response) mark the
//   positions where a listener commits; they are where an unfounded 「わかります」
//   would sit. They are never evidence of a shared referent by themselves.
// - Blank labels are never mapped to a value (see labels.ts).
// - ER and later rows are not used to judge an earlier local position.
import type { GroundingEvalCase, HistoryTurn, LabelQuality, NameEvidence, Split, TargetEvidence } from "./evalcase.ts";
import { EVAL_CASE_SCHEMA } from "./evalcase.ts";
import type { LabeledRow, MState } from "./labels.ts";
import { episodes } from "./labels.ts";

export const DERIVE_RULESET = "jev-grounding-derive/v2";

/** Speech functions at which a speaker commits to the partner's content. */
export const COMMIT_FUNCTIONS: readonly string[] = Object.freeze(["a11", "a3", "a9", "a4"]);
/** Bound on how many earlier turns of the same episode go into history. */
export const DEFAULT_MAX_HISTORY = 20;

export interface Derived {
  target: TargetEvidence | null;
  name: NameEvidence | null;
  basis: string[];
  /** Weakest quality over the axes that carry a value. */
  quality: LabelQuality;
  axisQuality: { target: LabelQuality | null; name: LabelQuality | null };
}

const RANK: Record<LabelQuality, number> = { explicit: 2, derived: 1, weak: 0 };

function weakest(axis: Derived["axisQuality"]): LabelQuality {
  const present = [axis.target, axis.name].filter((q): q is LabelQuality => q !== null);
  return present.length === 0 ? "weak" : present.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

const OPEN: readonly MState[] = ["M1", "M2", "M3"];

/** Removes the other speaker's overlap parts and transcription markup. Laughter becomes （笑）. */
export function normalizeText(text: string): string {
  return text
    .replace(/<o>[\s\S]*?<\/o>/g, "")
    .replace(/<la>/g, "（笑）")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Episode-end gold. `episodeRows` runs from the start row to the end row inclusive. */
export function deriveEpisodeEnd(episodeRows: readonly LabeledRow[]): Derived {
  const end = episodeRows[episodeRows.length - 1];
  const basis: string[] = [];
  let name: NameEvidence | null = null;
  if (end.er === "ER1") { name = "agreed"; basis.push("rule:N-ER1-end"); }
  else if (end.er === "ER0") { name = "not_agreed"; basis.push("rule:N-ER0-end"); }
  else basis.push("rule:N-ER-missing");

  const processes = new Set(episodeRows.map((r) => r.p).filter(Boolean));
  const finalM = end.activeM;
  let target: TargetEvidence | null = null;
  if (end.er === "ER1") {
    if (processes.has("P5")) basis.push("rule:T-ER1-P5-null"); // approximate adoption: what stayed incomplete is not recorded
    else if (finalM === "M4") { target = "supported"; basis.push("rule:T-ER1-M4"); }
    else if (finalM && OPEN.includes(finalM)) basis.push("rule:T-ER1-open-null");
    else basis.push("rule:T-ER1-noM-null");
  } else if (end.er === "ER0") {
    if (finalM && OPEN.includes(finalM)) { target = "insufficient"; basis.push("rule:T-ER0-open"); }
    else if (processes.has("P4") || processes.has("P6")) { target = "insufficient"; basis.push("rule:T-ER0-P4P6"); }
    else basis.push("rule:T-ER0-M4-subissue-null"); // a sub-issue was shared, the dimension is not recorded
  }
  if (finalM) basis.push(`M:${finalM}`);
  for (const p of processes) basis.push(`P:${p}`);
  if (end.er) basis.push(`ER:${end.er}`);
  const axisQuality = { target: target ? "weak" as const : null, name: name ? "derived" as const : null };
  return { target, name, basis, quality: weakest(axisQuality), axisQuality };
}

/**
 * Local-window gold at a commitment row. Uses only labels on rows up to and
 * including the focal row (the focal M was annotated with 1–3 turns of local
 * post-context, which the annotation policy allows). Never uses ER or later rows.
 */
export function deriveLocal(focal: LabeledRow, previous: readonly LabeledRow[]): Derived {
  const basis: string[] = focal.aLabels.filter((a) => COMMIT_FUNCTIONS.includes(a)).map((a) => `a:${a}`);
  const prevM = [...previous].reverse().find((r) => r.m)?.m ?? null;
  const deny = focal.aLabels.includes("a12") || focal.ah.some((t) => t.startsWith("Deny"));
  if (prevM) basis.push(`prevM:${prevM}`);
  if (focal.m) basis.push(`M:${focal.m}`);
  if (focal.p) basis.push(`P:${focal.p}`);
  if (deny) basis.push("deny");

  let target: TargetEvidence | null = null;
  const openM2 = focal.m === "M2" || (!focal.m && prevM === "M2");
  if (focal.p === "P5") basis.push("rule:T-P5-null");
  else if (deny && (focal.m === "M2" || prevM === "M2")) { target = "contradicted"; basis.push("rule:T-deny-M2"); }
  else if (focal.m === "M4") { target = "supported"; basis.push("rule:T-focal-M4"); }
  else if (openM2) { target = "insufficient"; basis.push("rule:T-open-M2-nodeny"); } // a public problem, not proof of different referents
  else if ((focal.m === "M1" || focal.m === "M3") || (!focal.m && (prevM === "M1" || prevM === "M3"))) {
    target = "insufficient"; basis.push("rule:T-open-M1M3");
  } else basis.push("rule:T-no-open-state-null"); // blank after M0/M4 or before any M: not "no misalignment"
  const axisQuality = { target: target ? "weak" as const : null, name: null };
  return { target, name: null, basis, quality: weakest(axisQuality), axisQuality };
}

export interface BuildOptions {
  split: (dialogueKey: string) => Split;
  /** Episodes that are not about a figure (e.g. a connection check), as "H1:E0". */
  procedural?: readonly string[];
  maxHistory?: number;
  /** Text transform for history; the default keeps the normalized original (private only). */
  render?: (row: LabeledRow) => string;
  externalModelAllowed?: boolean;
  source?: "historical" | "synthetic";
}

function historyOf(rows: readonly LabeledRow[], self: string, render: (row: LabeledRow) => string): HistoryTurn[] {
  return rows.map((r) => ({ speaker: r.speaker === self ? "self" : "partner", text: render(r) }));
}

/** Builds episode_end and local_window cases for one dialogue. */
export function buildHistoricalCases(dialogueKey: string, rows: readonly LabeledRow[], options: BuildOptions): GroundingEvalCase[] {
  const render = options.render ?? ((row: LabeledRow) => normalizeText(row.text));
  const maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
  const procedural = new Set(options.procedural ?? []);
  const split = options.split(dialogueKey);
  const source = options.source ?? "historical";
  const allowed = source === "historical" ? false : options.externalModelAllowed ?? false;
  const cases: GroundingEvalCase[] = [];
  for (const [episode, episodeRows] of episodes(rows)) {
    if (procedural.has(`${dialogueKey}:E${episode}`)) continue;
    const groupId = `${dialogueKey}-E${episode}`;
    const make = (unit: "episode_end" | "local_window", index: number, derived: Derived): GroundingEvalCase => {
      const window = episodeRows.slice(Math.max(0, index + 1 - maxHistory), index + 1);
      const focal = episodeRows[index];
      return {
        schema: EVAL_CASE_SCHEMA,
        caseId: `${groupId}-${unit === "episode_end" ? "end" : "u"}${focal.utteranceNo}`,
        source, unit, groupId, dialogueKey, split,
        externalModelAllowed: allowed,
        history: historyOf(window, focal.speaker, render),
        judgedTurnIndex: window.length - 1,
        expected: { target: derived.target, name: derived.name },
        labelBasis: [`ruleset:${DERIVE_RULESET}`, ...derived.basis],
        labelQuality: derived.quality,
        axisQuality: derived.axisQuality,
        correctnessKnown: false,
      };
    };
    const last = episodeRows[episodeRows.length - 1];
    const closed = last.episodeMarks.some((m) => m.edge === "end" && m.episode === episode);
    episodeRows.forEach((row, index) => {
      if (!row.aLabels.some((a) => COMMIT_FUNCTIONS.includes(a))) return;
      if (closed && index === episodeRows.length - 1) return; // covered by the episode_end case
      cases.push(make("local_window", index, deriveLocal(row, episodeRows.slice(0, index))));
    });
    if (closed) cases.push(make("episode_end", episodeRows.length - 1, deriveEpisodeEnd(episodeRows)));
  }
  return cases;
}
