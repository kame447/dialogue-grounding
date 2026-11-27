// The admin page uses the shared, text-free latency summary from the v2 runtime.
export * from "../../../../dialogue-model/runtime/v2/latency.ts";

import type { BaseRecord } from "../../../../dialogue-model/runtime/v2/base-assignment.ts";

const timestamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;

export function participantStartTiming(record: BaseRecord | null, trialIndex: number, cacheHits: number | null) {
  let firstHumanReceivedAt: string | null = null;
  let firstAiReplyAt: string | null = null;
  for (const event of Array.isArray(record?.events) ? record.events : []) {
    if (event?.speaker === "human") firstHumanReceivedAt ??= timestamp(event.at);
    if (firstHumanReceivedAt && event?.speaker === "ai") {
      firstAiReplyAt = timestamp(event.at);
      break;
    }
  }
  return {
    trialIndex,
    startRequestReceivedAt: timestamp(record?.startRequestReceivedAt),
    initialMemoReadStartedAt: timestamp(record?.initialMemoReadStartedAt),
    initialMemoReadyAt: timestamp(record?.initialMemoReadyAt),
    trialStartedAt: timestamp(record?.startedAt),
    firstHumanReceivedAt,
    firstAiReplyAt,
    initialObservationCacheHit: cacheHits === null ? null : cacheHits > 0,
  };
}
