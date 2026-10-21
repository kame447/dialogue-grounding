// Detached, record-only inputs for an independent verifier. Never normalizes a
// payload/material subtree or imports research scoring rules.
import { createHash } from "node:crypto";
import type { Label, SendReceipt } from "./audit.ts";
export type Identity = { provider: "luna" | "jev"; instanceId: string; trialOrder: number | null;
  label: Label | "warmup"; callId: number; phase: string; requestedModel: string };
export type LedgerEvent = Partial<Identity> & { seq: number; at: string;
  type: "complete" | "reserve" | "send" | "response" | "stop" | "commit" | "policy_get" | "refused";
  sendId?: number; status?: "ok" | "error" | "unknown" | "refused"; costUsd?: number | null;
  inputTokens?: number | null; outputTokens?: number | null; model?: string | null;
  reason?: string; inFlight?: number[]; scope?: "run" | "trial" | "instance"; scopeDetail?: "logical_call";
  turn?: number | null; priorObservedMaximumUsd?: number; priorObservedSpentUsd?: number };
export type ReplaySide = { label: Label; material: unknown; materialSha256: string;
  requests: Array<{ provider: "luna" | "jev"; phase: string; payload: unknown; payloadDomain: "canonical_http_json";
    payloadSha256: string; preProjectionPayloadSha256: string; completeMessagesSha256?: string }> };
export type CacheReceipt = { trialOrder: number | null; status: "not_attempted";
  reason: `setup_failed:${"luna_client" | "jev_transport" | "native_runtime" | "native_initialization"}` } | { trialOrder: number | null; status: "MISS" | "HIT";
  beforeSha256: string | null; afterSha256: string; memo: unknown; memoSha256: string;
  validated: boolean; requestedModel: string; returnedModel: string };
export const EVIDENCE_NORMALIZED_ENVELOPE_FIELDS = Object.freeze(["label", "runId", "timestamp", "timestamps", "startedAt", "finishedAt", "createdAt"]);
export function imageProjection(image: { mimeType: string; base64: string }) {
  return { projection: "own_image_bytes_sha256", mimeType: image.mimeType,
    byteSha256: createHash("sha256").update(Buffer.from(image.base64, "base64")).digest("hex") };
}
export function projectReplayValue(value: unknown, image: { mimeType: string; base64: string }): unknown {
  // The sole projection is the exact synthetic own-image data URL. All other
  // keys and values (including nested label/timestamp) remain significant.
  if (value === `data:${image.mimeType};base64,${image.base64}`) return imageProjection(image);
  if (Array.isArray(value)) return value.map(v => projectReplayValue(v, image));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, projectReplayValue(v, image)]));
  return value;
}
export class VerifierEvidence {
  readonly value: { version: 1; runId: string; normalizedEnvelopeFields: readonly string[]; imageProjection: string;
    pairedReplay: Array<{ trialOrder: number; turn: number; left: ReplaySide; right: ReplaySide }>;
    events: LedgerEvent[]; cache: CacheReceipt[] };
  readonly calls = new Map<number, Identity>();
  onChange: (() => void) | null = null;
  private lastAt = "";
  constructor(runId: string) { this.value = { version: 1, runId, normalizedEnvelopeFields: EVIDENCE_NORMALIZED_ENVELOPE_FIELDS,
    imageProjection: "exact_synthetic_own_image_data_url_to_mime_and_byte_sha256; canonical_http_json_not_raw_body_byte_parity",
    pairedReplay: [], events: [], cache: [] }; }
  event(event: Omit<LedgerEvent, "seq" | "at">) {
    const now = new Date().toISOString(); this.lastAt = now > this.lastAt ? now : this.lastAt;
    this.value.events.push(structuredClone({ ...event, seq: this.value.events.length + 1, at: this.lastAt })); this.onChange?.();
  }
  response(entry: SendReceipt, status?: "ok" | "error" | "unknown") {
    const identity = entry.logicalCallId === null ? undefined : this.calls.get(entry.logicalCallId);
    this.event({ ...identity, provider: entry.provider, phase: entry.phase ?? undefined, sendId: entry.id,
      type: "response", status: status ?? (entry.status === "observed_response" ? "ok" : "unknown"), model: entry.model,
      ...(entry.provider === "jev" ? { costUsd: entry.costUsd } : { inputTokens: entry.inputTokens, outputTokens: entry.outputTokens }) });
  }
  cache(receipt: CacheReceipt) { this.value.cache.push(structuredClone(receipt)); this.onChange?.(); }
  pair(trialOrder: number, turn: number, left: ReplaySide, right: ReplaySide) {
    this.value.pairedReplay.push(structuredClone({ trialOrder, turn, left, right })); this.onChange?.();
  }
}
