// Research-only, shadow-only summary of the AI's own reference memory for the
// two-axis grounding-evidence judge (Jev). Pure: it reads a reference graph and
// the public events, and returns a compact closed-vocabulary view of what the AI
// side has recorded, as of one judged public turn. Nothing here writes back to
// the graph, the ledger, the public history or any participant-facing state.
//
// What the summary is NOT: the graph's mention confidence and the AI's slot/name
// estimates are not the probability of a correct match, so no confidence value is
// forwarded. 'grounded' stays the graph's epistemic label for an AI interpretation
// of a public reference onto its OWN figure; it is never a verified correspondence.
// Retracted (and dependent) records are listed only as retracted, never as support.
// Free text is limited to candidate names that someone has already said in a
// public turn up to the judged point; question text, retraction reasons, feature
// wording, own-image observations and quotes are never copied.
// Memory OFF (graph null) yields null, so the shadow input can omit the field and
// stay byte-identical to the memory-less path.
import { SLOTS } from "../stimuli/board.mjs";
import { snapshotReferenceGraph } from "../memory/reference-graph.mjs";

export const MEMORY_EVIDENCE_SCHEMA = "memory_evidence_v1";
// Six current names at the graph's 80-char maximum still fit with every list emptied.
export const MEMORY_EVIDENCE_MAX_CHARS = 3_000;
/** Newest entries kept per list before the character budget applies. Engineering bounds, not research thresholds. */
const LIST_CAPS = [4, 2, 1, 0] as const;
const MAX_EVENT_TEXT = 12_000;

export type MemorySpeaker = "human" | "ai";
export type MemoryIntent = "refer" | "name_proposal" | "name_acceptance" | "feature_assertion" | "feature_acceptance" |
  "denial" | "correction" | "acknowledgment";
export type MemoryRecordKind = "mention" | "feature" | "name" | "question" | "focus";
export type MemoryTurnRef = { turn: number; speaker: MemorySpeaker; intent: MemoryIntent };
export type MemoryHypothesisRef = MemoryTurnRef & { alternatives: number };
export type MemoryName = {
  /** Null when the recorded name does not occur in any public turn up to the judged point. */
  text: string | null;
  agreement: "none" | "implicit" | "explicit";
  visibility: "public" | "ai_private";
  proposedBy: MemorySpeaker[];
  sourceTurns: number[];
};
export type MemoryRetraction = { kind: MemoryRecordKind; sourceTurn: number; cause: "retracted" | "dependent" };
export type MemoryFigure = {
  /** The AI's own opaque figure id (never the partner's). */
  ref: string;
  memoryStatus: "unassigned" | "tentative" | "agreed" | "deferred";
  grounded: MemoryTurnRef[];
  hypothesis: MemoryHypothesisRef[];
  name: MemoryName | null;
  /** Public feature reports about this figure: confirmations and negations (negations are not support). */
  featureReports: { confirmedTurns: number[]; deniedTurns: number[] };
  questions: { openTurns: number[]; deferredTurns: number[] };
  focus: { mode: "defer" | "revisit"; turn: number } | null;
  retracted: MemoryRetraction[];
};
export type MemoryEvidence = {
  schema: typeof MEMORY_EVIDENCE_SCHEMA;
  scope: "ai_private_interpretation_not_ground_truth";
  asOfTurn: number;
  /** Last turn at which the memory changed, at or before asOfTurn (0 = nothing recorded yet). */
  memoryTurn: number;
  figures: MemoryFigure[];
  unresolvedReferences: MemoryTurnRef[];
  omitted: { entries: number };
};

export class MemoryEvidenceError extends TypeError {
  code: string;
  constructor(code: string) {
    super("Invalid memory evidence input: " + code);
    this.name = "MemoryEvidenceError";
    this.code = code;
  }
}

type GraphRecord = {
  kind: "mention" | "feature" | "name" | "question" | "focus" | "retract";
  id: string;
  turn: number;
  sourceTurn?: number;
  speaker?: MemorySpeaker;
  slots?: string[];
  slot?: string;
  epistemic?: "unresolved" | "hypothesis" | "grounded";
  intent?: MemoryIntent;
  antecedent?: string | null;
  polarity?: "confirmed" | "denied";
  name?: string;
  agreement?: MemoryName["agreement"];
  status?: "open" | "deferred" | "resolved";
  mode?: "defer" | "revisit";
  mentionId?: string;
  mentionIds?: string[];
  targetId?: string;
  replaces?: string | null;
};
type Graph = { schemaVersion: 1; revision: number; lastTurn: number; ownObservations: unknown[]; records: GraphRecord[]; slots?: string[] };
type SlotView = { status: MemoryFigure["memoryStatus"]; candidate: { id: string; name: string; agreement: MemoryName["agreement"]; sourceTurns: number[] } | null };
type GraphView = { ownSlots: Record<string, SlotView>; questions: (GraphRecord & { sourceTurns: number[] })[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function publicTexts(events: readonly unknown[], asOfSeq: number): string[] {
  if (!Array.isArray(events)) throw new MemoryEvidenceError("invalid_public_events");
  const texts: string[] = [];
  let previous = 0;
  for (const event of events) {
    if (!isRecord(event) || !Number.isSafeInteger(event.seq) || (event.seq as number) <= previous ||
        !["human", "ai"].includes(event.speaker as string) || typeof event.text !== "string" || event.text.length > MAX_EVENT_TEXT) {
      throw new MemoryEvidenceError("invalid_public_events");
    }
    previous = event.seq as number;
    if (previous <= asOfSeq) texts.push(event.text);
  }
  return texts;
}

const dependencies = (record: GraphRecord): string[] => {
  if (record.kind === "mention") return record.antecedent ? [record.antecedent] : [];
  if (record.kind === "name" || record.kind === "question") return record.mentionIds ?? [];
  return record.mentionId ? [record.mentionId] : [];
};
const recordSlots = (record: GraphRecord): string[] => record.slots ?? (record.slot ? [record.slot] : []);
const newest = <T>(items: T[], cap: number): T[] => cap === 0 ? [] : items.slice(-cap);
const lastOf = (records: GraphRecord[], kind: GraphRecord["kind"], slot: string) => {
  for (let i = records.length - 1; i >= 0; i--) if (records[i].kind === kind && records[i].slot === slot) return records[i];
  return undefined;
};
const sortedUnique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/**
 * @param graph the AI's committed reference graph (as stored in private state or restored from JSON), or null when memory is OFF.
 * @param options.asOfSeq the judged public turn; records added after it are ignored. The view is exact when
 *   graph.lastTurn <= asOfSeq (the shadow passes the pre-turn committed graph). A later graph may already have
 *   pruned older history, so replaying an earlier turn from it is a lower bound, never an invented record.
 * @param options.events public events (seq/speaker/text); only texts up to asOfSeq are used, to check that names are public.
 */
export function buildMemoryEvidence(graph: unknown, options: { asOfSeq: number; events: readonly unknown[] }): MemoryEvidence | null {
  if (graph === null || graph === undefined) return null;
  if (!isRecord(options) || !Number.isSafeInteger(options.asOfSeq) || options.asOfSeq < 1) throw new MemoryEvidenceError("invalid_as_of");
  const asOf = options.asOfSeq;
  const texts = publicTexts(options.events, asOf);
  let prefix: Graph;
  let view: GraphView;
  try {
    snapshotReferenceGraph(graph); // Validates the whole graph, not only the prefix.
    const full = graph as Graph;
    // Records are ordered by turn and support only points backwards, so a turn prefix is a valid graph.
    const records = full.records.filter((record) => record.turn <= asOf);
    const lastTurn = Math.min(full.lastTurn, asOf);
    prefix = { ...full, records, lastTurn, revision: 0 };
    view = snapshotReferenceGraph(prefix) as unknown as GraphView;
  } catch {
    throw new MemoryEvidenceError("invalid_graph");
  }
  const records = prefix.records;
  const byId = new Map(records.map((record) => [record.id, record]));
  const retracted = new Set(records.filter((r) => r.kind === "retract").map((r) => r.targetId as string));
  const dead = new Set(retracted);
  for (const record of records) {
    if (record.kind !== "retract" && dependencies(record).some((id) => dead.has(id))) dead.add(record.id);
  }
  const live = records.filter((record) => record.kind !== "retract" && !dead.has(record.id));
  const mentions = live.filter((record) => record.kind === "mention");
  const turnRef = (m: GraphRecord): MemoryTurnRef => ({ turn: m.sourceTurn as number, speaker: m.speaker as MemorySpeaker, intent: m.intent as MemoryIntent });
  const byTurn = (a: { turn: number }, b: { turn: number }) => a.turn - b.turn;
  const slotIds: string[] = prefix.slots ?? [...SLOTS];
  const isPublic = (name: string) => texts.some((text) => text.includes(name));

  const full = slotIds.map((slot) => {
    const slotView = view.ownSlots[slot];
    const candidate = slotView.candidate;
    let name: MemoryName | null = null;
    let memoryStatus = slotView.status;
    if (candidate) {
      const record = byId.get(candidate.id) as GraphRecord;
      const visibility = isPublic(candidate.name) ? "public" : "ai_private";
      const speakers = new Set((record.mentionIds ?? []).map((id) => byId.get(id)?.speaker as MemorySpeaker));
      name = {
        text: visibility === "public" ? candidate.name : null,
        // A name nobody said publicly is never presented as agreed.
        agreement: visibility === "public" ? candidate.agreement : "none",
        visibility,
        proposedBy: (["human", "ai"] as const).filter((speaker) => speakers.has(speaker)),
        sourceTurns: sortedUnique(candidate.sourceTurns),
      };
      if (visibility === "ai_private" && memoryStatus === "agreed") memoryStatus = "tentative";
    }
    const targeting = mentions.filter((m) => (m.slots ?? []).includes(slot));
    const features = live.filter((r) => r.kind === "feature" && r.slot === slot);
    const featureTurns = (polarity: string) => sortedUnique(features.filter((r) => r.polarity === polarity)
      .map((r) => byId.get(r.mentionId as string)?.sourceTurn as number));
    const questions = view.questions.filter((q) => (q.slots ?? []).includes(slot));
    const questionTurns = (status: string) => sortedUnique(questions.filter((q) => q.status === status).flatMap((q) => q.sourceTurns));
    const focusRecord = lastOf(records, "focus", slot);
    const nameRecord = lastOf(records, "name", slot);
    // Same precedence as the graph's own view: a later name supersedes an earlier defer/revisit.
    const focus = focusRecord && !dead.has(focusRecord.id) && (!nameRecord || records.indexOf(focusRecord) > records.indexOf(nameRecord))
      ? { mode: focusRecord.mode as "defer" | "revisit", turn: byId.get(focusRecord.mentionId as string)?.sourceTurn as number } : null;
    const retractions = records.filter((r) => r.kind !== "retract" && dead.has(r.id) && recordSlots(r).includes(slot))
      .map((r): MemoryRetraction & { order: number } => ({
        kind: r.kind as MemoryRecordKind,
        sourceTurn: r.kind === "mention" ? r.sourceTurn as number : (byId.get(dependencies(r)[0])?.sourceTurn ?? r.turn),
        cause: retracted.has(r.id) ? "retracted" : "dependent",
        order: records.indexOf(r),
      }));
    return {
      ref: slot, memoryStatus, name,
      grounded: targeting.filter((m) => m.epistemic === "grounded").map(turnRef).sort(byTurn),
      hypothesis: targeting.filter((m) => m.epistemic === "hypothesis")
        .map((m) => ({ ...turnRef(m), alternatives: (m.slots as string[]).length })).sort(byTurn),
      featureReports: { confirmedTurns: featureTurns("confirmed"), deniedTurns: featureTurns("denied") },
      questions: { openTurns: questionTurns("open"), deferredTurns: questionTurns("deferred") },
      focus,
      retracted: retractions.sort((a, b) => a.sourceTurn - b.sourceTurn || a.order - b.order).map(({ order, ...rest }) => rest),
    };
  });
  const unresolved = mentions.filter((m) => m.epistemic === "unresolved").map(turnRef).sort(byTurn);

  for (const cap of LIST_CAPS) {
    let omitted = 0;
    const keep = <T>(items: T[]) => { const kept = newest(items, cap); omitted += items.length - kept.length; return kept; };
    const evidence: MemoryEvidence = {
      schema: MEMORY_EVIDENCE_SCHEMA,
      scope: "ai_private_interpretation_not_ground_truth",
      asOfTurn: asOf,
      memoryTurn: records.at(-1)?.turn ?? 0,
      figures: full.map((figure) => ({
        ...figure,
        grounded: keep(figure.grounded),
        hypothesis: keep(figure.hypothesis),
        name: figure.name && { ...figure.name, sourceTurns: keep(figure.name.sourceTurns) },
        featureReports: { confirmedTurns: keep(figure.featureReports.confirmedTurns), deniedTurns: keep(figure.featureReports.deniedTurns) },
        questions: { openTurns: keep(figure.questions.openTurns), deferredTurns: keep(figure.questions.deferredTurns) },
        retracted: keep(figure.retracted),
      })),
      unresolvedReferences: keep(unresolved),
      omitted: { entries: 0 },
    };
    evidence.omitted.entries = omitted;
    if (JSON.stringify(evidence).length <= MEMORY_EVIDENCE_MAX_CHARS) return evidence;
  }
  throw new MemoryEvidenceError("too_large");
}
