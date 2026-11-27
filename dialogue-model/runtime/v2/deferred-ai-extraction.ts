import { createHash } from "node:crypto";

export const DEFERRED_AI_EXTRACTION_GENERATION = "jev_generation_retry_v20";
export const isDeferredAiExtractionGeneration = (value: unknown): value is typeof DEFERRED_AI_EXTRACTION_GENERATION =>
  value === DEFERRED_AI_EXTRACTION_GENERATION;

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

export const extractionDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const digest = /^[a-f0-9]{64}$/u;
const keys = ["schemaVersion", "eventId", "aiSeq", "humanEventId", "requestSeq", "textSha256", "memoSha256",
  "publicTurnsSha256", "profileSha256", "graphRevision", "state", "error"] as const;

export function validDeferredExtractionJob(value: unknown): value is DeferredAiExtractionJob {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  const job = value as DeferredAiExtractionJob;
  return job.schemaVersion === "deferred_ai_extraction_v1" &&
    Number.isSafeInteger(job.aiSeq) && job.aiSeq > 1 && job.eventId === `event-${job.aiSeq}` &&
    job.humanEventId === `event-${job.aiSeq - 1}` &&
    Number.isSafeInteger(job.requestSeq) && job.requestSeq > 0 &&
    Number.isSafeInteger(job.graphRevision) && job.graphRevision >= 0 &&
    [job.textSha256, job.memoSha256, job.publicTurnsSha256, job.profileSha256].every(s => typeof s === "string" && digest.test(s)) &&
    (job.state === "queued" || job.state === "running" ? job.error === null : job.state === "failed" &&
      (job.error === "extraction_failed" || job.error === "model_mismatch" || job.error === "delivery_unknown"));
}
