import { LOCAL_ACTS, LOCAL_ASPECTS, LOCAL_SOURCES } from "./contract.ts";
import type { LocalAct, LocalAspect, LocalClaimFields, LocalClaimView, LocalFunctionVerdict, LocalSegmentProposal, PublicTurn } from "./contract.ts";
import { priorClaimViews } from "./derive.ts";
import type { LocalGraph } from "./verify.ts";
import { REFERENCE_LIMITS } from "../memory/reference-graph.mjs";
import { SLOTS } from "../stimuli/board.mjs";
import { findLocalPublicationViolations } from "../v2/generation-guard.ts";

export const REFERENCE_EVIDENCE_MAX_CHARS = 3600;
const MAX_ALTERNATIVES = 8;
const MAX_HISTORY = 16;
const maxAlternativesChars = 1700;
const correctionActs = new Set<LocalAct>(["deny", "withdraw", "name_reject"]);
const rejectedReasons = [
  "inconsistent_claim_response", "missing_claim_response", "inconsistent_claim_speaker",
  "unsupported_name_response", "not_deferred", "act_aspect_mismatch", "unknown_act",
] as const;

type EvidenceSpan = { sourceTurn: number; quote: string; targets: string[]; act: LocalAct; aspect: LocalAspect };
type PublicSource = PublicTurn & { nonReferential?: boolean };
export type LocalReferenceAlternative = EvidenceSpan & { reason: typeof rejectedReasons[number] };
export type ReferenceClaimExcerpt = EvidenceSpan & Pick<LocalClaimFields, "speaker" | "source" | "respondsTo"> & { claimId: string };
export type ReferenceEvidence = { history: ReferenceClaimExcerpt[]; localAlternatives: LocalReferenceAlternative[] };
export function hasRetainedNameSource(evidence: ReferenceEvidence | undefined, sourceTurn: number, name: string) {
  return evidence?.history.some(row => row.sourceTurn === sourceTurn && row.speaker === "human" &&
    row.aspect === "name" && row.quote.includes(name)) ?? false;
}
type LocalResearch = {
  extractor: { segments: readonly (LocalSegmentProposal & { redacted?: boolean })[] };
  classifier: { status: string; verdicts: readonly Pick<LocalFunctionVerdict, "segmentId" | "act">[] };
  verification: { rejected: readonly { segmentId: string; reason: string }[] };
};

const ref = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*:[A-Za-z0-9_-]{1,32}$/u.test(value);
const exact = (value: unknown, keys: readonly string[]) => value !== null && typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const spanKeys = ["sourceTurn", "quote", "targets", "act", "aspect"];
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 160 &&
  value !== "[redacted]" && !findLocalPublicationViolations(value, []).some(code => code === "internal_credential" || code === "internal_image");
const targets = (value: unknown, slots: readonly string[]): value is string[] =>
  Array.isArray(value) && value.length <= slots.length && new Set(value).size === value.length && [...value].every(id => slots.includes(id));

function publicSources(turns: readonly PublicSource[]) {
  const sources = new Map<number, PublicSource>();
  const duplicates = new Set<number>();
  for (const turn of turns) {
    if (sources.has(turn.turn)) duplicates.add(turn.turn);
    sources.set(turn.turn, turn);
  }
  for (const turn of duplicates) sources.delete(turn);
  return sources;
}

function span(value: any, slots: readonly string[], turn: number): value is EvidenceSpan {
  return Number.isSafeInteger(value.sourceTurn) && value.sourceTurn > 0 && value.sourceTurn <= turn &&
    text(value.quote) && targets(value.targets, slots) && LOCAL_ACTS.includes(value.act) && LOCAL_ASPECTS.includes(value.aspect);
}

function hasSource(row: EvidenceSpan, speaker: PublicTurn["speaker"], sources: ReadonlyMap<number, PublicSource>) {
  const source = sources.get(row.sourceTurn);
  return source?.speaker === speaker && !source.nonReferential && source.text.includes(row.quote);
}

export function validReferenceAlternatives(value: unknown, slots: readonly string[], turn: number, turns?: readonly PublicTurn[]): value is LocalReferenceAlternative[] {
  if (!Array.isArray(value) || value.length > MAX_ALTERNATIVES) return false;
  const sources = turns && publicSources(turns);
  return [...value].every(row => exact(row, [...spanKeys, "reason"]) && rejectedReasons.includes(row.reason) &&
    span(row, slots, turn) && (!sources || hasSource(row, "human", sources))) && JSON.stringify(value).length <= maxAlternativesChars;
}

/** Validate against the complete public input, before request compaction. */
export function validReferenceEvidence(value: unknown, slots: readonly string[], turn: number, turns: readonly PublicTurn[]): value is ReferenceEvidence {
  const evidence = value as ReferenceEvidence;
  if (!exact(value, ["history", "localAlternatives"]) || !validReferenceAlternatives(evidence.localAlternatives, slots, turn, turns) ||
      !Array.isArray(evidence.history) || evidence.history.length > MAX_HISTORY) return false;
  const sources = publicSources(turns);
  return [...evidence.history].every(row => exact(row, [...spanKeys, "speaker", "source", "respondsTo", "claimId"]) &&
    span(row, slots, turn) && (row.speaker === "human" || row.speaker === "ai") && LOCAL_SOURCES.includes(row.source) &&
    ref(row.claimId) && (row.respondsTo === null || ref(row.respondsTo)) && hasSource(row, row.speaker, sources)) &&
    JSON.stringify(value).length <= REFERENCE_EVIDENCE_MAX_CHARS;
}

function currentAlternatives(local: LocalResearch | null | undefined, slots: readonly string[], turn: number, sources: ReadonlyMap<number, PublicTurn>) {
  if (local?.classifier.status !== "ok") return [];
  const result: LocalReferenceAlternative[] = [];
  for (const entry of local.verification.rejected) {
    const reason = rejectedReasons.find(reason => reason === entry.reason);
    const segments = local.extractor.segments.filter(segment => segment.segmentId === entry.segmentId);
    const verdicts = local.classifier.verdicts.filter(verdict => verdict.segmentId === entry.segmentId);
    if (!reason || segments.length !== 1 || verdicts.length !== 1 || segments[0].redacted) continue;
    const { quote, targets, aspect } = segments[0];
    const row = { sourceTurn: turn, quote, targets, aspect, act: verdicts[0].act, reason };
    if (span(row, slots, turn) && hasSource(row, "human", sources)) result.push(row);
  }
  return result;
}

function claimPriority(claims: LocalClaimView[]) {
  const retained = new Set<string>();
  const groups = new Set<string>();
  const supported = new Set(claims.filter(c => ["agree", "name_accept"].includes(c.act)).map(c => c.respondsTo));
  for (const c of [...claims].reverse()) {
    const kinds = [];
    if (correctionActs.has(c.act)) kinds.push("correction");
    if (c.aspect === "name" && c.name !== null) kinds.push("name");
    if (c.speaker === "human" && c.act === "ask") kinds.push(supported.has(c.id) ? "question" : "open_question");
    if (c.act === "defer") kinds.push("deferred");
    for (const kind of kinds) {
      for (const target of c.targets.length ? c.targets : [null]) {
        const key = JSON.stringify([target, kind]);
        if (!groups.has(key)) retained.add(c.id);
        groups.add(key);
      }
    }
  }
  return [...claims].reverse().sort((a, b) => Number(retained.has(b.id)) - Number(retained.has(a.id)));
}

/** The public transcript supplies the literal source. The graph supplies the
 * local interpretation; neither confirms an identity on the partner's board. */
export function buildReferenceEvidence(graph: LocalGraph, turns: readonly PublicTurn[], turn: number, local: LocalResearch | null | undefined,
  previousAlternatives: readonly LocalReferenceAlternative[] = []): ReferenceEvidence {
  const slots = graph.slots ?? SLOTS;
  const sources = publicSources(turns);
  const localAlternatives: LocalReferenceAlternative[] = [];
  for (const row of [...currentAlternatives(local, slots, turn, sources), ...previousAlternatives]
    .filter(r => r.sourceTurn <= turn && hasSource(r, "human", sources))) {
    const candidate = [...localAlternatives, row];
    if (candidate.length > MAX_ALTERNATIVES) break;
    if (!localAlternatives.some(r => JSON.stringify(r) === JSON.stringify(row)) &&
        JSON.stringify(candidate).length <= maxAlternativesChars) localAlternatives.push(row);
  }
  const evidence: ReferenceEvidence = { history: [], localAlternatives };
  const claims = priorClaimViews(graph, { limit: REFERENCE_LIMITS.records });
  for (const { id: claimId, sourceTurn, speaker, quote, targets, act, aspect, source, respondsTo } of claimPriority(claims)) {
    const excerpt = { claimId, sourceTurn, speaker, quote, targets, act, aspect, source, respondsTo };
    if (!text(quote) || !hasSource(excerpt, speaker, sources) || sourceTurn > turn) continue;
    evidence.history.push(excerpt);
    if (JSON.stringify(evidence).length > REFERENCE_EVIDENCE_MAX_CHARS) evidence.history.pop();
    if (evidence.history.length === MAX_HISTORY) break;
  }
  return evidence;
}
