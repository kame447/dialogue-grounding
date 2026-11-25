// Parsing and bookkeeping for the historical annotation labels (a1–a30, M0–M4,
// P1–P6, ER0/ER1, episode markers). Data-free; rows are supplied by the caller.
//
// Blank-handling contract (annotation/annotation-contract.md):
// - M is written only at state-change points. A blank M continues the last
//   explicit M of the same episode; before the first M of an episode the state
//   is unknown (null), never "M0 / no misalignment".
// - A blank P means no process started or changed at that row.
// - ER is expected on episode-end rows only; a blank ER there is "missing".
// - A blank speech-function cell is "unannotated", not "no function".

export type MState = "M0" | "M1" | "M2" | "M3" | "M4";
export type PProcess = "P1" | "P2" | "P3" | "P4" | "P5" | "P6";
export type EpisodeResult = "ER0" | "ER1";

/** Preprocessed historical row (one utterance or overlap part). Extra fields are ignored. */
export interface HistoricalRow {
  dialogue: number | string;
  utteranceNo: string;
  speaker: string;
  text: string;
  AHLabel?: string;
  episode?: string;
  speechFunctions?: string;
  misalignmentState?: string;
  adjustmentProcess?: string;
  episodeResult?: string;
}

export interface LabeledRow {
  dialogueKey: string;
  position: number; // order within the dialogue
  utteranceNo: string;
  speaker: string;
  text: string;
  aLabels: string[];
  aBlank: boolean;
  ah: string[];
  m: MState | null;
  p: PProcess | null;
  er: EpisodeResult | null;
  episodeMarks: { episode: number; edge: "start" | "end" }[];
  /** Episode index the row belongs to, or null between episodes. */
  episode: number | null;
  /** Last explicit M in this episode up to and including this row; null if none yet. */
  activeM: MState | null;
}

const M_RE = /^\s*(M[0-4])(?![0-9])/;
const P_RE = /^\s*(P[1-6])(?![0-9])/;
const ER_RE = /^\s*(ER[01])(?![0-9])/;
const A_RE = /^\s*(a(?:[1-9]|[12][0-9]|30))(?![0-9])/;
const EPISODE_RE = /E(\d+)\s*(start|end)/g;

export function parseM(cell: string | undefined): MState | null {
  const match = M_RE.exec(cell ?? "");
  return match ? (match[1] as MState) : null;
}

export function parseP(cell: string | undefined): PProcess | null {
  const match = P_RE.exec(cell ?? "");
  return match ? (match[1] as PProcess) : null;
}

export function parseER(cell: string | undefined): EpisodeResult | null {
  const match = ER_RE.exec(cell ?? "");
  return match ? (match[1] as EpisodeResult) : null;
}

/** "a5（驚き）; a11（同意）" → ["a5", "a11"]. Unknown fragments are reported, not guessed. */
export function parseALabels(cell: string | undefined): { labels: string[]; unparsed: string[] } {
  const labels: string[] = [];
  const unparsed: string[] = [];
  for (const part of (cell ?? "").split(/[;；]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = A_RE.exec(trimmed);
    if (match) {
      if (!labels.includes(match[1])) labels.push(match[1]);
    } else unparsed.push(trimmed);
  }
  return { labels, unparsed };
}

/** "Holistic,Ack holistic; Grounded" → ["Holistic", "Ack holistic", "Grounded"]. */
export function parseAH(cell: string | undefined): string[] {
  return (cell ?? "").split(/[,;；、]/).map((s) => s.trim()).filter(Boolean);
}

export function parseEpisodeMarks(cell: string | undefined): { episode: number; edge: "start" | "end" }[] {
  return [...(cell ?? "").matchAll(EPISODE_RE)].map((m) => ({ episode: Number(m[1]), edge: m[2] as "start" | "end" }));
}

export function dialogueKeyOf(dialogue: number | string): string {
  return `H${String(dialogue)}`;
}

/** Groups rows by dialogue (input order kept) and restores episode membership and the active M state. */
export function labelRows(rows: readonly HistoricalRow[]): Map<string, LabeledRow[]> {
  const byDialogue = new Map<string, LabeledRow[]>();
  const open = new Map<string, { episode: number | null; activeM: MState | null }>();
  for (const row of rows) {
    const key = dialogueKeyOf(row.dialogue);
    const list = byDialogue.get(key) ?? [];
    byDialogue.set(key, list);
    const state = open.get(key) ?? { episode: null, activeM: null };
    const marks = parseEpisodeMarks(row.episode);
    for (const mark of marks) {
      if (mark.edge === "start") {
        state.episode = mark.episode;
        state.activeM = null;
      }
    }
    const m = parseM(row.misalignmentState);
    if (m) state.activeM = m;
    const { labels } = parseALabels(row.speechFunctions);
    list.push({
      dialogueKey: key,
      position: list.length,
      utteranceNo: String(row.utteranceNo),
      speaker: row.speaker,
      text: row.text,
      aLabels: labels,
      aBlank: !(row.speechFunctions ?? "").trim(),
      ah: parseAH(row.AHLabel),
      m,
      p: parseP(row.adjustmentProcess),
      er: parseER(row.episodeResult),
      episodeMarks: marks,
      episode: state.episode,
      activeM: state.episode === null ? null : state.activeM,
    });
    if (marks.some((mark) => mark.edge === "end" && mark.episode === state.episode)) {
      state.episode = null;
      state.activeM = null;
    }
    open.set(key, state);
  }
  return byDialogue;
}

export interface LabelDistribution {
  rows: number;
  rowsOutsideEpisodes: number;
  episodes: number;
  episodeEndsWithoutER: number;
  erOutsideEpisodeEnd: number;
  m: Record<string, number>;
  p: Record<string, number>;
  er: Record<string, number>;
  a: Record<string, number>;
  ah: Record<string, number>;
  blank: { m: number; p: number; er: number; a: number; ah: number };
  /** Episodes whose first M event is not on the start row (state unknown until then). */
  episodesWithoutStartM: number;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function distribution(rows: readonly LabeledRow[]): LabelDistribution {
  const d: LabelDistribution = {
    rows: rows.length, rowsOutsideEpisodes: 0, episodes: 0, episodeEndsWithoutER: 0, erOutsideEpisodeEnd: 0,
    m: {}, p: {}, er: {}, a: {}, ah: {}, blank: { m: 0, p: 0, er: 0, a: 0, ah: 0 }, episodesWithoutStartM: 0,
  };
  for (const row of rows) {
    if (row.episode === null && row.episodeMarks.length === 0) d.rowsOutsideEpisodes++;
    if (row.m) bump(d.m, row.m); else d.blank.m++;
    if (row.p) bump(d.p, row.p); else d.blank.p++;
    if (row.er) bump(d.er, row.er); else d.blank.er++;
    if (row.aBlank) d.blank.a++;
    for (const a of row.aLabels) bump(d.a, a);
    if (row.ah.length === 0) d.blank.ah++;
    for (const tag of row.ah) bump(d.ah, tag);
    const isEnd = row.episodeMarks.some((mark) => mark.edge === "end");
    if (row.episodeMarks.some((mark) => mark.edge === "start")) {
      d.episodes++;
      if (!row.m) d.episodesWithoutStartM++;
    }
    if (isEnd && !row.er) d.episodeEndsWithoutER++;
    if (!isEnd && row.er) d.erOutsideEpisodeEnd++;
  }
  return d;
}

/** Rows of one episode in order, start to end inclusive. */
export function episodes(rows: readonly LabeledRow[]): Map<number, LabeledRow[]> {
  const out = new Map<number, LabeledRow[]>();
  for (const row of rows) {
    if (row.episode === null) continue;
    const list = out.get(row.episode) ?? [];
    list.push(row);
    out.set(row.episode, list);
  }
  return out;
}
