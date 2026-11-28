import { createHash } from "node:crypto";
import { LOCAL_ASPECTS } from "../local-grounding/contract.ts";
import type { LocalSegmentProposal, PublicTurn } from "../local-grounding/contract.ts";
import { aiExact, aiIndex, aiText, type AiExtractionDiagnostics } from "../local-grounding/extract-ai.ts";
import { literalSpan } from "../judgment/public-evidence.mjs";

export const DEFERRED_AI_EXTRACTION_GENERATION = "jev_generation_retry_v20";
export const ISSUE_HANDLING_GENERATION = "jev_generation_retry_v21";
export const GENERATION_RETRY_V22 = "jev_generation_retry_v22";
export const GENERATION_RETRY_V23 = "jev_generation_retry_v23";
export const GENERATION_RETRY_V24 = "jev_generation_retry_v24";
/** v24's procedure with the generation instructions tidied (#273) and the independent source extraction of ON told what a source is (#275). */
export const GENERATION_RETRY_V25 = "jev_generation_retry_v25";
export type PostGenerationCheck = "off" | "on";
export const isPostGenerationCheck = (value: unknown): value is PostGenerationCheck => value === "off" || value === "on";
export const isGenerationV22 = (value: unknown): value is typeof GENERATION_RETRY_V22 => value === GENERATION_RETRY_V22;
export const isGenerationV23 = (value: unknown): value is typeof GENERATION_RETRY_V23 => value === GENERATION_RETRY_V23;
export const isGenerationV24 = (value: unknown): value is typeof GENERATION_RETRY_V24 => value === GENERATION_RETRY_V24;
export const isGenerationV25 = (value: unknown): value is typeof GENERATION_RETRY_V25 => value === GENERATION_RETRY_V25;
type GenerationV24Plus = typeof GENERATION_RETRY_V24 | typeof GENERATION_RETRY_V25;
type GenerationV22Plus = typeof GENERATION_RETRY_V22 | typeof GENERATION_RETRY_V23 | GenerationV24Plus;
type IssueHandlingGeneration = typeof ISSUE_HANDLING_GENERATION | GenerationV22Plus;
export type DeferredAiExtractionGeneration = typeof DEFERRED_AI_EXTRACTION_GENERATION | IssueHandlingGeneration;
/** v24 or later: the post-generation check setting, the direct-answer recovery and every procedure v24 introduced. v25 keeps all of them. */
export const usesV24GenerationRules = (value: unknown): value is GenerationV24Plus => isGenerationV24(value) || isGenerationV25(value);
export const usesV22GenerationRules = (value: unknown): value is GenerationV22Plus =>
  isGenerationV22(value) || isGenerationV23(value) || usesV24GenerationRules(value);
export const isIssueHandlingGeneration = (value: unknown): value is IssueHandlingGeneration =>
  value === ISSUE_HANDLING_GENERATION || usesV22GenerationRules(value);
export const isDeferredAiExtractionGeneration = (value: unknown): value is DeferredAiExtractionGeneration =>
  value === DEFERRED_AI_EXTRACTION_GENERATION || isIssueHandlingGeneration(value);

export type DeferredAiExtractionJob = {
  schemaVersion: "deferred_ai_extraction_v1";
  eventId: string;
  aiSeq: number;
  humanEventId: string;
  requestSeq: number;
  textSha256: string;
  memoSha256: string;
  publicTurnsSha256: string;
  profileSha256: string;
  graphRevision: number;
  state: "queued" | "running" | "failed";
  error: "extraction_failed" | "model_mismatch" | "delivery_unknown" | null;
};

export type DeferredClassificationExtraction = {
  segments: LocalSegmentProposal[];
  rejected: AiExtractionDiagnostics["rejected"];
  sha256: string;
};
export type DeferredAiClassificationJob = Omit<DeferredAiExtractionJob, "schemaVersion" | "error"> & {
  schemaVersion: "deferred_ai_classification_v1";
  extraction: DeferredClassificationExtraction;
  error: "classification_failed" | "model_mismatch" | "delivery_unknown" | null;
};
export type DeferredAiPublicJob = DeferredAiExtractionJob | DeferredAiClassificationJob;

export const extractionDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const digest = /^[a-f0-9]{64}$/u;
const keys = ["schemaVersion", "eventId", "aiSeq", "humanEventId", "requestSeq", "textSha256", "memoSha256",
  "publicTurnsSha256", "profileSha256", "graphRevision", "state", "error"] as const;

function classificationDigest({ segments, rejected }: Omit<DeferredClassificationExtraction, "sha256">): string {
  return extractionDigest(JSON.stringify({
    rejected: rejected.map(({ reason, segmentId }) => ({ reason, segmentId })),
    segments: segments.map(({ aspect, linkedIssueId, name, proposition, quote, respondsToTurn, segmentId, targets }) =>
      ({ aspect, linkedIssueId, name, proposition, quote, respondsToTurn, segmentId, targets })),
  }));
}

export function classificationExtraction(segments: LocalSegmentProposal[], rejected: AiExtractionDiagnostics["rejected"]): DeferredClassificationExtraction {
  return { segments, rejected, sha256: classificationDigest({ segments, rejected }) };
}

export function validDeferredAiPublicJob(value: unknown, slots: readonly string[], allowClassification: boolean): value is DeferredAiPublicJob {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const job = value as DeferredAiPublicJob;
  const classification = job.schemaVersion === "deferred_ai_classification_v1";
  const expected = classification ? [...keys, "extraction"] : keys;
  if (Reflect.ownKeys(value).length !== expected.length || !expected.every(key => Object.hasOwn(value, key)) ||
      (classification ? !allowClassification : job.schemaVersion !== "deferred_ai_extraction_v1")) return false;
  return (
    Number.isSafeInteger(job.aiSeq) && job.aiSeq > 1 && job.eventId === `event-${job.aiSeq}` &&
    job.humanEventId === `event-${job.aiSeq - 1}` &&
    Number.isSafeInteger(job.requestSeq) && job.requestSeq > 0 &&
    Number.isSafeInteger(job.graphRevision) && job.graphRevision >= 0 &&
    [job.textSha256, job.memoSha256, job.publicTurnsSha256, job.profileSha256].every(s => typeof s === "string" && digest.test(s)) &&
    (job.state === "queued" || job.state === "running" ? job.error === null : job.state === "failed" &&
      (job.error === (classification ? "classification_failed" : "extraction_failed") || job.error === "model_mismatch" || job.error === "delivery_unknown")) &&
    (!classification || validClassificationExtraction(job.extraction, job.aiSeq, slots)));
}

function validClassificationExtraction(value: unknown, aiSeq: number, slots: readonly string[]): boolean {
  if (!aiExact(value, ["segments", "rejected", "sha256"]) || !Array.isArray(value.segments) || !Array.isArray(value.rejected) ||
      value.segments.length + value.rejected.length > 32 || typeof value.sha256 !== "string" || !digest.test(value.sha256)) return false;
  const keys = ["segmentId", "quote", "targets", "aspect", "proposition", "name", "linkedIssueId", "respondsToTurn"];
  if (!value.segments.every(segment => aiExact(segment, keys) && aiText(segment.segmentId, 64) && aiText(segment.quote) &&
      aiText(segment.proposition) && (LOCAL_ASPECTS as readonly unknown[]).includes(segment.aspect) && segment.aspect !== "name" &&
      Array.isArray(segment.targets) && new Set(segment.targets).size === segment.targets.length && segment.targets.every(slot => slots.includes(slot)) &&
      segment.name === null && (segment.linkedIssueId === null || aiText(segment.linkedIssueId, 128)) &&
      (segment.respondsToTurn === null || aiIndex(segment.respondsToTurn) && segment.respondsToTurn < aiSeq)) ||
      !value.rejected.every(segment => aiExact(segment, ["segmentId", "reason"]) && aiText(segment.segmentId, 64) &&
        (segment.reason === "name_by_literal_path" || segment.reason === "nonpublic_quote"))) return false;
  const ids = [...value.segments, ...value.rejected].map(segment => segment.segmentId);
  return new Set(ids).size === ids.length && classificationDigest({ segments: value.segments, rejected: value.rejected }) === value.sha256;
}

export function classificationMatchesPublication(job: DeferredAiClassificationJob, text: string, publicTurns: readonly PublicTurn[]): boolean {
  return job.extraction.segments.every(segment => literalSpan(text, segment.quote)?.text === segment.quote &&
    (segment.respondsToTurn === null || publicTurns.some(turn => turn.turn === segment.respondsToTurn)));
}
