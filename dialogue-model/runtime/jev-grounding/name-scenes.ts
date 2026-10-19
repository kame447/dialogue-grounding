// Historical name-state scenes (task D). A scene is one row of a historical
// dialogue at which a reviewer judged the name state for the episode's main
// referent, under grounding-criteria/v2 (an impression alone is no_name; unclear
// needs an explicit proposal or a 仮称 offered as the name by context).
// Scenes hold row references only (dialogue key, Excel row, utterance number);
// the text stays in the private source file.
//
// The annotation scheme has no "naming proposal" label, so the proxies below
// test how far the existing labels can stand in for a reader:
// - erOnly: ER1 at the row → agreed; nothing else (ER0 is ambiguous).
// - impressionAsProposal: the superseded reading in which a Holistic
//   (見立て) description counts as a candidate → unclear, a later denial →
//   not_agreed, none → no_name; ER1 → agreed.
// - agreementTag: a11 together with an acknowledged impression → agreed, a
//   check of "a11 ≠ name agreed".
// None of them is gold; they exist to measure disagreement with a reader.
import type { NameEvidence, Split } from "./evalcase.ts";
import { NAME_LEVELS } from "./evalcase.ts";
import type { LabeledRow } from "./labels.ts";
import type { AxisReport } from "./metrics.ts";
import { axisReport } from "./metrics.ts";

export const NAME_SCENE_SCHEMA = "jev-grounding-name-scene/v1";

export type Confidence = "high" | "medium" | "low";
export type SceneState = Exclude<NameEvidence, "unknown">;

export interface NameScene {
  dialogueKey: string;
  xlsxRow: number;
  utteranceNo: string;
  state: SceneState;
  confidence: Confidence;
  /** Speaker who first proposed the name for this referent, "-" if none. */
  proposer: string;
  borderline: boolean;
  reviewer: string;
  reviewVersion: string;
}

const STATES: readonly SceneState[] = ["agreed", "unclear", "not_agreed", "no_name"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

export function validateScene(value: unknown): string[] {
  const v = value as Partial<NameScene> | null;
  if (!v || typeof v !== "object") return ["scene is not an object"];
  const errors: string[] = [];
  if (typeof v.dialogueKey !== "string" || !/^H\d+$/.test(v.dialogueKey)) errors.push("dialogueKey");
  if (!Number.isInteger(v.xlsxRow)) errors.push("xlsxRow");
  if (typeof v.utteranceNo !== "string" || !v.utteranceNo) errors.push("utteranceNo");
  if (!STATES.includes(v.state as SceneState)) errors.push("state");
  if (!CONFIDENCES.includes(v.confidence as Confidence)) errors.push("confidence");
  if (typeof v.proposer !== "string") errors.push("proposer");
  if (typeof v.borderline !== "boolean") errors.push("borderline");
  if (typeof v.reviewer !== "string" || !v.reviewer) errors.push("reviewer");
  if (typeof v.reviewVersion !== "string" || !v.reviewVersion) errors.push("reviewVersion");
  return errors;
}

export interface Proxies {
  erOnly: NameEvidence | null;
  impressionAsProposal: NameEvidence;
  agreementTag: NameEvidence | null;
}

const isImpression = (row: LabeledRow) => row.ah.includes("Holistic");
const isDenial = (row: LabeledRow) => row.aLabels.includes("a12") || row.ah.some((t) => t.startsWith("Deny"));

/** Label-only proxies at `index` within one episode's rows (start row first). Uses no later row. */
export function proxies(episodeRows: readonly LabeledRow[], index: number): Proxies {
  const upTo = episodeRows.slice(0, index + 1);
  const row = episodeRows[index];
  const erOnly: NameEvidence | null = row.er === "ER1" ? "agreed" : null;
  let impressionAsProposal: NameEvidence = "no_name";
  const first = upTo.findIndex(isImpression);
  if (row.er === "ER1") impressionAsProposal = "agreed";
  else if (first >= 0) impressionAsProposal = upTo.slice(first + 1).some(isDenial) ? "not_agreed" : "unclear";
  const agreementTag: NameEvidence | null = row.aLabels.includes("a11") && row.ah.includes("Ack holistic") ? "agreed" : null;
  return { erOnly, impressionAsProposal, agreementTag };
}

export interface SceneComparison {
  scenes: number;
  byState: Record<string, number>;
  byConfidence: Record<string, number>;
  borderline: number;
  bySplit: Record<string, Record<string, number>>;
  /** Each proxy scored against the reader's state (null proxy values count as missing). */
  proxies: Record<keyof Proxies, AxisReport>;
  /** Rows with a11 among scenes, by reader state: how often agreement ≠ a name agreed. */
  a11ByState: Record<string, number>;
  /** Scene states on episode-end rows, by ER. */
  episodeEndByER: Record<string, Record<string, number>>;
  /** Rows whose reader state disagrees with ER on the same row (ER1 but not agreed). */
  er1NotAgreed: number;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Compares reader scenes with label proxies. `rowsByDialogue` comes from
 * labelRows(); scenes whose row is not found are reported as an error.
 */
export function compareScenes(scenes: readonly NameScene[], rowsByDialogue: ReadonlyMap<string, readonly LabeledRow[]>,
  split: (dialogueKey: string) => Split, options: { minConfidence?: Confidence; excludeBorderline?: boolean } = {}): SceneComparison {
  const rank = { high: 2, medium: 1, low: 0 } as const;
  const keep = scenes.filter((s) => (!options.excludeBorderline || !s.borderline) &&
    rank[s.confidence] >= rank[options.minConfidence ?? "low"]);
  const out: SceneComparison = {
    scenes: keep.length, byState: {}, byConfidence: {}, borderline: 0, bySplit: {},
    proxies: {} as SceneComparison["proxies"], a11ByState: {}, episodeEndByER: {}, er1NotAgreed: 0,
  };
  const pairs: Record<keyof Proxies, { gold: NameEvidence; predicted: NameEvidence | null }[]> = { erOnly: [], impressionAsProposal: [], agreementTag: [] };
  for (const scene of keep) {
    const rows = rowsByDialogue.get(scene.dialogueKey);
    const index = rows?.findIndex((r) => r.utteranceNo === scene.utteranceNo) ?? -1;
    if (!rows || index < 0) throw new Error(`scene row not found: ${scene.dialogueKey}#${scene.utteranceNo}`);
    const row = rows[index];
    if (row.episode === null) throw new Error(`scene outside an episode: ${scene.dialogueKey}#${scene.utteranceNo}`);
    const episodeRows = rows.filter((r) => r.episode === row.episode);
    const p = proxies(episodeRows, episodeRows.indexOf(row));
    for (const key of Object.keys(pairs) as (keyof Proxies)[]) pairs[key].push({ gold: scene.state, predicted: p[key] });
    bump(out.byState, scene.state);
    bump(out.byConfidence, scene.confidence);
    if (scene.borderline) out.borderline++;
    out.bySplit[split(scene.dialogueKey)] ??= {};
    bump(out.bySplit[split(scene.dialogueKey)], scene.state);
    if (row.aLabels.includes("a11")) bump(out.a11ByState, scene.state);
    if (row.episodeMarks.some((m) => m.edge === "end")) {
      const er = row.er ?? "missing";
      out.episodeEndByER[er] ??= {};
      bump(out.episodeEndByER[er], scene.state);
    }
    if (row.er === "ER1" && scene.state !== "agreed") out.er1NotAgreed++;
  }
  for (const key of Object.keys(pairs) as (keyof Proxies)[]) out.proxies[key] = axisReport(NAME_LEVELS, pairs[key]);
  return out;
}
