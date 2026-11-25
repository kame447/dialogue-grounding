// One opt-in local interpretation transaction. Model work can only propose
// operations; the dialogue queue still owns publication and state installation.
import { LOCAL_ACTS, LOCAL_ASPECTS } from "../local-grounding/contract.ts";
import type { LocalAct, LocalOwnImage, LocalOwnAnchor, LocalFunctionVerdict, LocalSegmentProposal, LocalGroundingOptions, PublicTurn, LocalRejection, LocalVerificationResult } from "../local-grounding/contract.ts";
import { verifyLocalUpdate, recordAiClaims, type LocalVerificationDiagnostic } from "../local-grounding/verify.ts";
import { summarizeLocalIssues, priorClaimViews } from "../local-grounding/derive.ts";
import { validateReferenceUpdate, previewReferenceUpdate, ReferenceGraphError } from "../memory/reference-graph.mjs";
import { findInternalLeaks } from "./generation-guard.ts";
import { literalSpan } from "../judgment/public-evidence.mjs";
import { LOCAL_EXTRACTION_INSTRUCTIONS, LocalExtractionError, type LocalExtractionErrorCode } from "../local-grounding/extract.ts";
import { LOCAL_CLASSIFICATION_INSTRUCTIONS, LocalClassificationError, type LocalClassificationErrorCode } from "../local-grounding/classify.ts";

export const LOCAL_GROUNDING_TIMEOUT_MS = 20_000;
type Message = { role: string; content: unknown };

/** Opt-in publication checks. Only fixed codes leave this function; private
 * instructions and the matched draft text never enter research records. */
export function findLocalPublicationViolations(text: string, messages: readonly Message[]): string[] {
  const normalized = text.normalize("NFKC");
  // Preserve token boundaries: the legacy guard removes whitespace, which can
  // join a field and an opaque id into a single unmatched token.
  const separated = normalized.replace(/[\s\u200b-\u200d\ufeff]+/gu, "、");
  const codes = findInternalLeaks(separated);
  if (/(?<![A-Za-z])(?:issueId|nameState|claimIds|sourceTurn|respondsTo|localGrounding|classifierKind)(?![A-Za-z])/u.test(separated)) codes.push("internal_field");
  if (/(?<![A-Za-z0-9])[1-9]\d*:(?:local|ai)[1-9]\d*(?![A-Za-z0-9])/u.test(separated)) codes.push("internal_id");
  const compact = (value: string) => value.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");
  const reply = compact(normalized);
  if (messages.some(message => message.role === "system" && typeof message.content === "string" &&
      message.content.split(/\r?\n/u).some(line => line.trim().length >= 24 && reply.includes(compact(line.trim().slice(0, 80)))))) {
    codes.push("internal_prompt_echo");
  }
  if (/data\s*:\s*image\s*\//iu.test(normalized)) codes.push("internal_image");
  if (/\bBearer[ \t]+[A-Za-z0-9._~+/-]+={0,2}|\bsk-[A-Za-z0-9_-]{8,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\b(?:api[_-]?key|x-api-key)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/iu.test(normalized)) {
    codes.push("internal_credential");
  }
  return [...new Set(codes)];
}

type Graph = { revision: number; lastTurn: number; slots: string[]; records: Array<{ kind: string; id: string }> };
type Update = { expectedRevision: number; turn: number; operations: Array<{ kind: string; id: string }> };
export type LocalGroundingTrace = {
  status: "ok" | "error" | "timeout" | "aborted";
  segments: number;
  accepted: number;
  rejected: LocalRejection[];
  classifierKind: "luna_standin" | "unverified_injected" | "jev_local_test";
  latencyMs: number;
  extraction?: { rejectedSegments: number; reasons: Array<"quote_not_found" | "quote_span_too_long"> };
  attemptNumber?: number;
};
type ResearchClaim = LocalVerificationResult["operations"][number] & { redacted?: true };
export type LocalGroundingResearchData = {
  extractor: { segments: Array<LocalSegmentProposal & { act?: LocalAct; redacted?: true }>; errorCode?: LocalExtractionErrorCode };
  classifier: { kind: LocalGroundingTrace["classifierKind"]; model: string | null; status: "not_called" | "ok" | "error" | "skipped";
    callIndex: number | null; verdicts: Array<Pick<LocalFunctionVerdict, "segmentId" | "act" | "respondsToClaimId">>; errorCode?: LocalClassificationErrorCode };
  verification: { accepted: string[]; rejected: LocalRejection[]; diagnostics?: LocalVerificationDiagnostic[] };
  aiClaims: ResearchClaim[];
  claims: ResearchClaim[];
};
export type LocalGroundingResearchRecord = LocalGroundingResearchData & {
  turnIndex: number; lastEventId: string | null; attemptNumber: number;
  status: "staged" | "error" | "aborted" | "committed" | "superseded";
  localStatus: LocalGroundingTrace["status"];
};

/** Call after the queue settles. A generated candidate is not a commit receipt.
 * Matching all three identifiers avoids promoting a failed retry of the same turn. */
export function settleLocalTraces(records: readonly LocalGroundingResearchRecord[], privateState: unknown): LocalGroundingResearchRecord[] {
  const judgments = (privateState as { judgments?: unknown })?.judgments;
  return records.map(record => {
    const installed = Array.isArray(judgments) && judgments.some(judgment => judgment?.status === "committed" &&
      judgment.turnIndex === record.turnIndex && (judgment.lastEventId ?? null) === record.lastEventId &&
      judgment.localGrounding?.attemptNumber === record.attemptNumber);
    return { ...structuredClone(record), status: record.status === "staged" || record.status === "committed" || record.status === "superseded"
      ? installed ? "committed" : "superseded" : record.status };
  });
}

function classifierEvidence(classifier: LocalGroundingOptions["classifier"]): { callIndex: number | null; model: string | null; status: "ok" | "error" | "skipped" } {
  try {
    const evidence = (classifier as { lastEvidence?: { callIndex?: unknown; model?: unknown; status?: unknown } }).lastEvidence;
    return { callIndex: Number.isSafeInteger(evidence?.callIndex) && (evidence!.callIndex as number) > 0 ? evidence!.callIndex as number : null,
      model: typeof evidence?.model === "string" && /^typesafe\/jev-1\.14(?:-[0-9]{8})?$/u.test(evidence.model) ? evidence.model : null,
      status: evidence?.status === "ok" ? "ok" : evidence?.status === "skipped" ? "skipped" : "error" };
  } catch { return { callIndex: null, model: null, status: "error" }; }
}

// Constructors own the closed code sets. Re-normalize even typed instances:
// public code properties can be modified by an injected implementation.
function extractionErrorCode(error: unknown): LocalExtractionErrorCode {
  try { return error instanceof LocalExtractionError ? new LocalExtractionError(error.code).code : "unavailable"; }
  catch { return "unavailable"; }
}
function classificationErrorCode(error: unknown): LocalClassificationErrorCode {
  try { return error instanceof LocalClassificationError ? new LocalClassificationError(error.code).code : "unavailable"; }
  catch { return "unavailable"; }
}

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
const segmentCode = (value: unknown, index: number) => typeof value === "string" && /^s[0-9]{1,4}$/.test(value) ? value : `segment_${index + 1}`;
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
  ownImage: LocalOwnImage; ownAnchors: readonly LocalOwnAnchor[];
  captureResearch?: boolean;
  priorAct?: Parameters<typeof recordAiClaims>[0]["priorAct"];
}): Promise<{ update: Update; trace: LocalGroundingTrace; research?: LocalGroundingResearchData }> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let segmentsCount = 0;
  let extraction: LocalGroundingTrace["extraction"];
  let phase = "extractor_failed";
  const kind = (options.classifier as { metadata?: { classifierKind?: unknown } }).metadata?.classifierKind;
  const classifierKind = kind === "luna_standin" || kind === "jev_local_test" ? kind : "unverified_injected";
  const research: LocalGroundingResearchData | null = input.captureResearch ? {
    extractor: { segments: [] }, classifier: { kind: classifierKind, model: null, status: "not_called", callIndex: null, verdicts: [] },
    verification: { accepted: [], rejected: [] }, aiClaims: [], claims: [],
  } : null;
  const privateInstructions = [LOCAL_EXTRACTION_INSTRUCTIONS, LOCAL_CLASSIFICATION_INSTRUCTIONS].map(content => ({ role: "system", content }));
  const safeText = (value: string) => {
    const codes = findLocalPublicationViolations(value, privateInstructions);
    return (input.ownImage.base64 && value.includes(input.ownImage.base64)) || codes.some(code => ["internal_prompt_echo", "internal_credential", "internal_image"].includes(code))
      ? "[redacted]" : value;
  };
  const researchClaim = (operation: LocalVerificationResult["operations"][number]): ResearchClaim => {
    const quote = safeText(operation.quote), proposition = safeText(operation.proposition);
    const name = operation.name === null ? null : safeText(operation.name);
    return { kind: "claim", id: operation.id, issueId: operation.issueId, targets: [...operation.targets], aspect: operation.aspect,
      act: operation.act, proposition, name, speaker: operation.speaker, sourceTurn: operation.sourceTurn, quote,
      respondsTo: operation.respondsTo, source: operation.source,
      ...(quote !== operation.quote || proposition !== operation.proposition || name !== operation.name ? { redacted: true as const } : {}) };
  };
  const trace = (status: LocalGroundingTrace["status"], accepted = 0, rejected: LocalRejection[] = []): LocalGroundingTrace => ({
    status, segments: segmentsCount, accepted, rejected, classifierKind, latencyMs: Math.round(performance.now() - started),
    ...(extraction ? { extraction } : {}),
  });
  const finish = (update: Update, record: LocalGroundingTrace) => {
    if (!research) return { update, trace: record };
    const snapshot = structuredClone(research);
    const retained = new Set(update.operations.filter(operation => operation.kind === "claim").map(operation => operation.id));
    snapshot.claims = snapshot.claims.filter(claim => retained.has(claim.id));
    snapshot.aiClaims = snapshot.aiClaims.filter(claim => retained.has(claim.id));
    snapshot.verification = { ...snapshot.verification,
      accepted: [...snapshot.aiClaims, ...snapshot.claims].map(claim => claim.id), rejected: structuredClone(record.rejected) };
    return { update, trace: record, research: snapshot };
  };
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
        try {
          update = validateReferenceUpdate(input.graph, candidate, { publicTurns }); accepted++;
          if (research) {
            const claim = researchClaim(operation);
            (claim.speaker === "ai" ? research.aiClaims : research.claims).push(claim);
          }
        }
        catch (error) {
          if (!(error instanceof ReferenceGraphError)) throw error;
          rejected.push({ segmentId: `operation_${accepted + rejected.length + 1}`, reason: "memory_" + reasonCode(error.code) });
        }
      }
    };
    // Both current opt-in callers use this boundary. Never select legacy mode
    // from options, stored priorAct fields, or other external input.
    if (input.priorAct) merge(recordAiClaims({ graph: input.graph, turn: input.update.turn, publicTurns, priorAct: input.priorAct, featureSource: "none" }));
    const graph = previewReferenceUpdate(input.graph, update, { publicTurns });
    const issueSummary = summarizeLocalIssues(graph);
    check();
    let segments;
    try {
      segments = await options.extractor.extract({ turn: input.update.turn, publicTurns: structuredClone(publicTurns),
        ownSlots: [...input.graph.slots], issueSummary,
        ownImage: { ...input.ownImage }, ownAnchors: structuredClone(input.ownAnchors) },
      { signal: controller.signal, timeoutMs: Math.ceil(timeoutMs) });
    } catch (error) {
      if (research) research.extractor.errorCode = extractionErrorCode(error);
      throw error;
    } finally { extraction = extractionDiagnostics(options.extractor); }
    check();
    if (!Array.isArray(segments)) throw new Error("Invalid local extraction");
    segments = structuredClone(segments);
    check();
    segmentsCount = segments.length;
    if (research) research.extractor.segments = segments.flatMap((segment, index) => {
      if (!segment || !LOCAL_ASPECTS.includes(segment.aspect)) return [];
      const human = publicTurns.find(turn => turn.turn === input.update.turn && turn.speaker === "human");
      const quote = typeof segment.quote === "string" && human ? literalSpan(human.text, segment.quote)?.text : null;
      const proposition = typeof segment.proposition === "string" && segment.proposition.length <= 160 ? safeText(segment.proposition) : "";
      const name = typeof segment.name === "string" && segment.name.length <= 160 ? safeText(segment.name) : null;
      const sourceQuote = quote && quote.length <= 160 ? safeText(quote) : "";
      return [{ segmentId: segmentCode(segment.segmentId, index), quote: sourceQuote,
        targets: Array.isArray(segment.targets) ? segment.targets.filter(slot => input.graph.slots.includes(slot)).slice(0, 6) : [], aspect: segment.aspect,
        proposition, name, linkedIssueId: graph.records.some((record: { issueId?: string }) => record.issueId === segment.linkedIssueId) ? segment.linkedIssueId : null,
        respondsToTurn: Number.isSafeInteger(segment.respondsToTurn) && publicTurns.some(turn => turn.turn === segment.respondsToTurn && turn.turn < input.update.turn) ? segment.respondsToTurn : null,
        ...(sourceQuote === "[redacted]" || proposition === "[redacted]" || name === "[redacted]" ? { redacted: true as const } : {}) }];
    });
    phase = "classifier_failed";
    const priorClaims = priorClaimViews(graph);
    check();
    const beforeEvidence = research ? classifierEvidence(options.classifier) : null;
    let verdicts;
    if (research) research.classifier.status = "error";
    try {
      verdicts = await options.classifier.classify({ turn: input.update.turn, publicTurns: structuredClone(publicTurns),
        segments: structuredClone(segments), priorClaims }, { signal: controller.signal, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) });
      if (research) research.classifier.status = classifierKind === "jev_local_test" ? "error" : "ok";
    } catch (error) {
      if (research) research.classifier.errorCode = classificationErrorCode(error);
      throw error;
    } finally {
      if (research && classifierKind === "jev_local_test") {
        const evidence = classifierEvidence(options.classifier);
        if (evidence.callIndex === (beforeEvidence?.callIndex ?? 0) + 1) Object.assign(research.classifier, evidence);
      }
    }
    check();
    if (research && Array.isArray(verdicts)) {
      research.classifier.verdicts = verdicts.flatMap(verdict => {
        const index = segments.findIndex(segment => segment?.segmentId === verdict?.segmentId);
        if (index < 0 || !LOCAL_ACTS.includes(verdict?.act)) return [];
        const segmentId = segmentCode(verdict.segmentId, index);
        const recorded = research.extractor.segments.find(segment => segment.segmentId === segmentId);
        if (recorded) recorded.act = verdict.act;
        return [{ segmentId, act: verdict.act,
          respondsToClaimId: priorClaims.some(claim => claim.id === verdict.respondsToClaimId) ? verdict.respondsToClaimId : null }];
      });
    }
    phase = "verification_failed";
    const verified = verifyLocalUpdate({ graph, turn: input.update.turn, publicTurns, segments, verdicts });
    if (research && verified.diagnostics?.length) research.verification.diagnostics = verified.diagnostics
      .flatMap((diagnostic, index): LocalVerificationDiagnostic[] => {
        const segmentId = segmentCode(diagnostic.segmentId, index);
        if (diagnostic.reason === "issue_link_overridden") return [{ segmentId, reason: "issue_link_overridden",
          linkedIssueId: diagnostic.linkedIssueId, resolvedIssueId: diagnostic.resolvedIssueId }];
        if (diagnostic.reason === "antecedent_dropped") return [{ segmentId, reason: "antecedent_dropped",
          respondsToClaimId: diagnostic.respondsToClaimId, resolvedIssueId: diagnostic.resolvedIssueId }];
        if (diagnostic.reason === "antecedent_missing") return [{ segmentId, reason: "antecedent_missing",
          respondsToClaimId: diagnostic.respondsToClaimId, resolvedIssueId: diagnostic.resolvedIssueId }];
        return [];
      });
    merge(verified);
    check();
    return finish(update, trace("ok", accepted, rejected));
  };
  try { return await Promise.race([limit, work()]); }
  catch (error) {
    const name = (error as Error)?.name;
    const status = name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : "error";
    if (research && phase === "extractor_failed") research.extractor.errorCode ??= status === "error" ? extractionErrorCode(error) : status;
    if (research && phase === "classifier_failed") research.classifier.errorCode ??= status === "error" ? classificationErrorCode(error) : status;
    return finish(input.update, trace(status, 0, [{ segmentId: "turn", reason: status === "error" ? phase : status }]));
  } finally {
    clearTimeout(timer);
    if (abortListener) input.signal?.removeEventListener("abort", abortListener);
    controller.abort();
  }
}
