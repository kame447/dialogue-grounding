// One opt-in local interpretation transaction. Model work can only propose
// operations; the dialogue queue still owns publication and state installation.
import type { LocalGroundingOptions, PublicTurn, LocalRejection, LocalVerificationResult } from "../local-grounding/contract.ts";
import { verifyLocalUpdate, recordAiClaims } from "../local-grounding/verify.ts";
import { summarizeLocalIssues, priorClaimViews } from "../local-grounding/derive.ts";
import { validateReferenceUpdate, previewReferenceUpdate, ReferenceGraphError } from "../memory/reference-graph.mjs";

export const LOCAL_GROUNDING_TIMEOUT_MS = 20_000;
type Graph = { revision: number; lastTurn: number; slots: string[]; records: Array<{ kind: string; id: string }> };
type Update = { expectedRevision: number; turn: number; operations: Array<{ kind: string; id: string }> };
export type LocalGroundingTrace = {
  status: "ok" | "error" | "timeout" | "aborted";
  segments: number;
  accepted: number;
  rejected: LocalRejection[];
  classifierKind: "luna_standin" | "unverified_injected";
  latencyMs: number;
  extraction?: { rejectedSegments: number; reasons: Array<"quote_not_found" | "quote_span_too_long"> };
};

export function validateLocalGroundingOptions(value: unknown): LocalGroundingOptions | null {
  if (value === null || value === undefined) return null;
  const options = value as LocalGroundingOptions;
  if (typeof options?.extractor?.extract !== "function" || typeof options?.classifier?.classify !== "function" ||
      (options.timeoutMs !== undefined && (typeof options.timeoutMs !== "number" || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))) {
    throw new Error("Invalid local grounding options");
  }
  return { extractor: options.extractor, classifier: options.classifier, timeoutMs: options.timeoutMs ?? LOCAL_GROUNDING_TIMEOUT_MS };
}

// Never copy untrusted segment IDs or exception/provider messages into traces.
const segmentCode = (value: string, index: number) => /^s[0-9]{1,4}$/.test(value) ? value : `segment_${index + 1}`;
const reasonCode = (value: string) => /^[a-z][a-z0-9_]{0,59}$/.test(value) ? value : "invalid_update";
const canceled = () => Object.assign(new Error("Local grounding canceled"), { name: "AbortError" });
function extractionDiagnostics(extractor: LocalGroundingOptions["extractor"]): LocalGroundingTrace["extraction"] {
  const value = (extractor as { lastDiagnostics?: LocalGroundingTrace["extraction"] }).lastDiagnostics;
  if (!value || !Number.isSafeInteger(value.rejectedSegments) || value.rejectedSegments < 0 ||
      !Array.isArray(value.reasons) || !value.reasons.every(reason => reason === "quote_not_found" || reason === "quote_span_too_long")) return undefined;
  return { rejectedSegments: value.rejectedSegments, reasons: [...value.reasons] };
}

export function localGroundingMemo(graph: Graph, update: Update, publicTurns: readonly PublicTurn[]): string {
  let summary;
  try { summary = summarizeLocalIssues(previewReferenceUpdate(graph, update, { publicTurns })); }
  catch { summary = summarizeLocalIssues(graph); }
  return "局所問題の作業メモ（非公開・自分側の解釈であり正解ではない）:\n" + summary +
    "\n支持・否定・保留はその論点だけの情報です。局所的な支持から図形全体を理解済みとしたり、名称を決定済みとしたりしないでください。名称の決定は既存のactionの表現範囲に従ってください。";
}

export async function prepareLocalGroundingTurn(options: LocalGroundingOptions, input: {
  graph: Graph; update: Update; publicTurns: readonly PublicTurn[]; signal?: AbortSignal;
  priorAct?: Parameters<typeof recordAiClaims>[0]["priorAct"];
}): Promise<{ update: Update; trace: LocalGroundingTrace }> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let segmentsCount = 0;
  let extraction: LocalGroundingTrace["extraction"];
  let phase = "extractor_failed";
  const kind = (options.classifier as { metadata?: { classifierKind?: unknown } }).metadata?.classifierKind;
  const classifierKind = kind === "luna_standin" ? kind : "unverified_injected";
  const trace = (status: LocalGroundingTrace["status"], accepted = 0, rejected: LocalRejection[] = []): LocalGroundingTrace => ({
    status, segments: segmentsCount, accepted, rejected, classifierKind, latencyMs: Math.round(performance.now() - started),
    ...(extraction ? { extraction } : {}),
  });
  let abortListener: (() => void) | undefined;
  const timeoutMs = options.timeoutMs ?? LOCAL_GROUNDING_TIMEOUT_MS;
  const deadline = started + timeoutMs;
  const check = () => {
    if (controller.signal.aborted) throw canceled();
    if (performance.now() >= deadline) throw Object.assign(new Error("Local grounding timeout"), { name: "TimeoutError" });
  };
  const limit = new Promise<never>((_resolve, reject) => {
    abortListener = () => { reject(canceled()); controller.abort(); };
    input.signal?.addEventListener("abort", abortListener, { once: true });
    if (input.signal?.aborted) { abortListener(); return; }
    // Large finite timeouts are valid; avoid the platform's 32-bit timer wrap.
    const schedule = () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        reject(Object.assign(new Error("Local grounding timeout"), { name: "TimeoutError" }));
        controller.abort();
      } else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
  });
  const work = async () => {
    check();
    // Detached inputs keep an injected extractor/classifier from changing the
    // graph, public sources, or each other's evidence through object mutation.
    const publicTurns = input.publicTurns.filter(t => t.turn <= input.update.turn);
    let update = input.update;
    const rejected: LocalRejection[] = [];
    let accepted = 0;
    const merge = (verified: LocalVerificationResult) => {
      rejected.push(...verified.rejected.map((r, i) => ({ segmentId: segmentCode(r.segmentId, i), reason: reasonCode(r.reason) })));
      for (const operation of verified.operations) {
        const candidate = { ...update, operations: [...update.operations, operation] };
        try { update = validateReferenceUpdate(input.graph, candidate, { publicTurns }); accepted++; }
        catch (error) {
          if (!(error instanceof ReferenceGraphError)) throw error;
          rejected.push({ segmentId: `operation_${accepted + rejected.length + 1}`, reason: "memory_" + reasonCode(error.code) });
        }
      }
    };
    if (input.priorAct) merge(recordAiClaims({ graph: input.graph, turn: input.update.turn, publicTurns, priorAct: input.priorAct }));
    const graph = previewReferenceUpdate(input.graph, update, { publicTurns });
    const issueSummary = summarizeLocalIssues(graph);
    check();
    let segments;
    try {
      segments = await options.extractor.extract({ turn: input.update.turn, publicTurns: structuredClone(publicTurns),
        ownSlots: [...input.graph.slots], issueSummary }, { signal: controller.signal, timeoutMs: Math.ceil(timeoutMs) });
    } finally { extraction = extractionDiagnostics(options.extractor); }
    check();
    if (!Array.isArray(segments)) throw new Error("Invalid local extraction");
    segments = structuredClone(segments);
    check();
    segmentsCount = segments.length;
    phase = "classifier_failed";
    const priorClaims = priorClaimViews(graph);
    check();
    const verdicts = await options.classifier.classify({ turn: input.update.turn, publicTurns: structuredClone(publicTurns),
      segments: structuredClone(segments), priorClaims }, { signal: controller.signal, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) });
    check();
    phase = "verification_failed";
    merge(verifyLocalUpdate({ graph, turn: input.update.turn, publicTurns, segments, verdicts }));
    check();
    return { update, trace: trace("ok", accepted, rejected) };
  };
  try { return await Promise.race([limit, work()]); }
  catch (error) {
    const name = (error as Error)?.name;
    const status = name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : "error";
    return { update: input.update, trace: trace(status, 0, [{ segmentId: "turn", reason: status === "error" ? phase : status }]) };
  } finally {
    clearTimeout(timer);
    if (abortListener) input.signal?.removeEventListener("abort", abortListener);
    controller.abort();
  }
}
