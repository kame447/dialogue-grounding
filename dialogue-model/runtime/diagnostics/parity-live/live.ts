// Import-safe Node harness. Only the parent supplies/executes real clients.
import { createHash, randomUUID } from "node:crypto";
import { readFile, appendFile, writeFile, rename, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { researchTrialProfile, researchHash } from "../../v2/research-profile.ts";
import type { LunaRequestSettings } from "../../v2/research-profile.ts";
import { createTrialV2, modelView } from "../../stimuli/scatter-v2.mjs";
import { createObservationCache, createObservationCacheKey, observationCacheFileName } from "../../observation/cache.ts";
import { createLunaObserver } from "../../observation/observe.ts";
import { createJevDecisionClient, buildJevDecisionPayload, buildHumanReferentPayload, JevDecisionError } from "../../decision/jev-decision.ts";
import { createJevLocalTestClassifier } from "../../local-grounding/jev-local-test.ts";
import { settleJevTurnTraces, settleAiPublicClaims } from "../../v2/jev-turn.ts";
import type { JevPrivateState, JevTurnTrace } from "../../v2/jev-turn.ts";
import type { JevDecisionClient } from "../../decision/contract.ts";
import type { ObservationCacheAudit } from "../../observation/cache.ts";
import { isGroundingModel } from "../../../../workers/research-ai-proxy/src/grounding.ts";
import { RunBudget, ENGINEERING_LIMITS, CALL_CAPS, compareParity, privateDirectory, privateWrite, publicText, promptSourceManifest } from "./audit.ts";
import type { Label, Phase, CallReceipt, ComparableTrial, IdentityTurn } from "./audit.ts";
import { validateRunManifest, loadRunManifest } from "./manifest.ts";
import type { RunManifest } from "./manifest.ts";
import { canonicalLunaPayload, LunaWireError, lunaWire } from "./luna-wire.ts";
import type { HttpReceipt } from "./luna-wire.ts";
import { createProfileDialogue, pairedReplay } from "./replay.ts";
import type { ReplayTape } from "./replay.ts";
import { wiringCoverage, stageGates } from "./coverage.ts";
import { DEFAULT_COST_CAP_USD } from "../jev-shadow-eval/local-openrouter.ts";
import { SYNTHETIC_PROBES } from "./cases.ts";
import { VerifierEvidence } from "./evidence.ts";
import type { Identity as EvidenceIdentity } from "./evidence.ts";

export type Script = { id: string; humanTurns: readonly string[] };
type Message = { role: string; content: unknown };
export type LunaClient = {
  getModelPolicy(): Promise<{ purpose: string; model: string; ready: boolean; provider: string }>;
  complete(messages: Message[], options?: { phase?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{
    text: string; model?: string; usage?: { inputTokens?: number | null; outputTokens?: number | null };
  }>;
};
export type Dependencies = { execution: "mock" | "live";
  createLunaClient(label: Label | "warmup", options: { request: LunaRequestSettings; instrumentFetch: (fetchImpl: typeof fetch) => typeof fetch }): LunaClient | Promise<LunaClient>;
  createJevTransport(label: Label): { readKey(): Promise<string>; fetchImpl(url: string, options: RequestInit): Promise<Response> };
  secrets?: readonly string[];
};
export type Options = { outputDir: string; cacheDir: string; manifest: RunManifest; scripts: readonly Script[] };
type Event = { id: string; seq: number; speaker: "human" | "ai"; text: string };
export type Trial = Omit<ComparableTrial, "turns"> & { order: number; stage: string; profile: ReturnType<typeof researchTrialProfile>; profileSha256: string;
  failure: string | null; cache: ObservationCacheAudit | null; calls: CallReceipt[];
  turns: Array<IdentityTurn & { trace: JevTurnTrace[]; state: JevPrivateState; wiring: unknown }>;
  notReached: number[]; aiPublicSettlement: unknown; durationMs: number; budget: unknown; http: HttpReceipt[]; attempts: JevTurnTrace[];
  replay: Array<{ tape: ReplayTape; result: Omit<Awaited<ReturnType<typeof pairedReplay>>, "sides"> }>; gates?: ReturnType<typeof stageGates>;
  lastCommittedState: JevPrivateState | null; failureAtTurn: number | null };
class HarnessError extends Error { constructor(readonlyCode: string) { super(readonlyCode); this.code = readonlyCode; } code: string; }
const fail = (code: string): never => { throw new HarnessError(code); };
const digestBytes = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const modelName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(v);
const tokens = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
type SavedField = "profile" | "manifest" | "cost" | "usage" | "model_ids";
type RecordReceipt = { file: string; status: "pending" | "saved" | "failed"; fields: SavedField[] };
export type SaveAudit = { status: "auditable" | "save_failed"; firstSaveFailure: string | null; requiredWritesComplete: boolean;
  fields: Record<SavedField, boolean>; recordReceipts: RecordReceipt[];
  evidencePresent: boolean; billingPresent: boolean; evidenceWriteFailed: boolean; billingWriteFailed: boolean;
  evidenceRevision: number; savedEvidenceRevision: number; billingRevision: number; savedBillingRevision: number };

/** Labels are metadata only. No semantic oracle or approved script catalog here. */
export async function runParityLive(options: Options, deps: Dependencies) {
  const manifest = validateRunManifest(options.manifest), PROFILE = researchTrialProfile(manifest.lunaRequest), RESEARCH_TRIAL_PROFILE_SHA256 = researchHash(PROFILE);
  const labels = [...new Set(manifest.trials.map(t => t.label))];
  const secrets = [...(deps.secrets ?? [])];
  if (!["mock", "live"].includes(deps.execution) || deps.execution === "live" && manifest.approval !== "approved" ||
      !Array.isArray(labels) || !labels.length || labels.length > 2 || new Set(labels).size !== labels.length ||
      labels.some(l => !["repair-first", "bypass-enabled"].includes(l)) || !Array.isArray(options.scripts) || !options.scripts.length ||
      new Set(options.scripts.map(s => s.id)).size !== options.scripts.length) fail("invalid_options");
  for (const script of options.scripts) {
    if (Object.keys(script).sort().join(",") !== "humanTurns,id" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(script.id) ||
        !Array.isArray(script.humanTurns) || !script.humanTurns.length || script.humanTurns.length > 32) fail("invalid_script");
    script.humanTurns.forEach(text => publicText(text, secrets));
  }
  const scripts = structuredClone(options.scripts), budget = new RunBudget(manifest.caps);
  if (manifest.trials.some(t => !scripts.some(s => s.id === t.scriptId))) fail("unknown_script");
  const output = await privateDirectory(options.outputDir), cacheDir = await privateDirectory(options.cacheDir);
  if (output === cacheDir) fail("cache_output_overlap");
  const runId = "parity-" + randomUUID(), directory = await privateDirectory(join(output, runId));
  const evidence = new VerifierEvidence(runId);
  const board = modelView(createTrialV2({ seed: manifest.seed })); // Own projection only.
  const image = { mimeType: board.mimeType, base64: board.png.toString("base64") }, anchors = board.anchors;
  const own = { ownImage: image, ownAnchors: anchors };
  const promptSources = await promptSourceManifest(), trials: Trial[] = [], skipped: unknown[] = [];
  const clients = new Set<LunaClient>(), connections = new Map<LunaClient, ReturnType<typeof lunaWire>>(), promptSpans = new Set<string>();
  let privacyRejected = false, fatal: string | null = null, logicalCallSequence = 0;
  let activeRunStop: ((reason: string) => void) | null = null;
  let instanceSequence = 0;
  const lunaIdentities = new Map<LunaClient, Omit<EvidenceIdentity, "callId" | "phase">>();
  const unsafe = (value: string) => {
    const s = value.normalize("NFKC"), compact = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
    return /data\s*:\s*image\s*\/|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9+/]{200,}={0,2}/iu.test(s) ||
      s.includes(image.base64) || secrets.some(key => key.length >= 8 && s.includes(key.normalize("NFKC"))) ||
      [...promptSpans].some(span => compact(s).includes(compact(span)));
  };
  let firstSaveFailure: string | null = null;
  const requiredRecords: RecordReceipt[] = [];
  const recordWrites = new Set<Promise<{ saved: boolean; redacted: boolean }>>();
  const saveFailed = (file: string) => { firstSaveFailure ??= file; };
  const persist = (file: string, value: unknown, fields: SavedField[] = [], trackRequired = true) => {
    const receipt: RecordReceipt = { file, status: "pending", fields: [...fields] };
    if (trackRequired) requiredRecords.push(receipt);
    const pending = `.record-${randomUUID()}.pending.json`;
    const work = (async () => {
      let redacted = false;
      try {
        redacted = await privateWrite(directory, pending, value, unsafe);
        await rename(join(directory, pending), join(directory, file));
        receipt.status = "saved";
        if (redacted) privacyRejected = true;
      } catch { receipt.status = "failed"; saveFailed(file); }
      finally { await unlink(join(directory, pending)).catch(() => {}); }
      return { saved: receipt.status === "saved", redacted };
    })();
    recordWrites.add(work); void work.finally(() => recordWrites.delete(work)); return work;
  };
  let billingWrites = Promise.resolve(), billingWriteFailed = false;
  let billingRevision = 0, savedBillingRevision = 0;
  let evidenceWrites = Promise.resolve(), evidenceWriteFailed = false, evidencePublished = false;
  let evidenceRevision = 0, savedEvidenceRevision = 0;
  const writeEvidence = () => {
    const snapshot = structuredClone(evidence.value);
    const revision = ++evidenceRevision;
    evidenceWrites = evidenceWrites.then(async () => {
      // Only the exact own-image projection is permitted; payload subtrees are
      // never normalized/redacted into apparent parity. Fail closed on leaks.
      const strings = (v: unknown): boolean => typeof v === "string" ?
        /data\s*:\s*image\s*\/|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9+/]{200,}={0,2}/iu.test(v) ||
          v.includes(image.base64) || secrets.some(key => key.length >= 8 && v.includes(key)) :
        Array.isArray(v) ? v.some(strings) : !!v && typeof v === "object" ? Object.values(v).some(strings) : false;
      if (strings(snapshot)) throw new Error("evidence_privacy_rejected");
      const pending = join(directory, "verifier-evidence.private.pending.json");
      await writeFile(pending, JSON.stringify(snapshot) + "\n", { mode: 0o600 });
      await rename(pending, join(directory, "verifier-evidence.private.json"));
      savedEvidenceRevision = revision;
    }).catch(() => { evidenceWriteFailed = true; saveFailed("verifier-evidence.private.json"); });
  };
  evidence.onChange = () => { if (evidencePublished) writeEvidence(); };
  const auditability = async (): Promise<SaveAudit> => {
    for (;;) {
      await Promise.all([...recordWrites]);
      const bills = billingWrites, records = evidenceWrites;
      await bills; await records;
      if (recordWrites.size || bills !== billingWrites || records !== evidenceWrites) continue;
      const revision = evidenceRevision;
      let evidencePresent = false;
      try { const info = await lstat(join(directory, "verifier-evidence.private.json"));
        evidencePresent = info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 &&
          !evidenceWriteFailed && savedEvidenceRevision === evidenceRevision;
      } catch { /* Missing mandatory evidence is a save failure. */ }
      let billingPresent = billingRevision === 0;
      if (billingRevision > 0) try { const info = await lstat(join(directory, "billing.private.jsonl"));
        billingPresent = info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600;
      } catch { /* A required billing journal is absent. */ }
      if (!billingPresent) { billingWriteFailed = true; saveFailed("billing.private.jsonl"); }
      await Promise.all(requiredRecords.filter(r => r.status === "saved").map(async receipt => {
        try { const info = await lstat(join(directory, receipt.file));
          if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error("invalid_record");
        } catch { receipt.status = "failed"; saveFailed(receipt.file); }
      }));
      if (revision !== evidenceRevision) continue;
      if (!evidencePresent) saveFailed("verifier-evidence.private.json");
      const recordReceipts = structuredClone(requiredRecords);
      const fields = { profile: false, manifest: false, cost: evidencePresent, usage: evidencePresent, model_ids: evidencePresent };
      for (const r of recordReceipts) if (r.status === "saved") for (const field of r.fields) fields[field] = true;
      const requiredWritesComplete = recordReceipts.every(r => r.status === "saved") && Object.values(fields).every(Boolean) &&
        evidencePresent && !billingWriteFailed && savedBillingRevision === billingRevision && !firstSaveFailure;
      return { status: requiredWritesComplete && !firstSaveFailure ? "auditable" : "save_failed", firstSaveFailure,
        requiredWritesComplete, fields, recordReceipts,
        evidencePresent, billingPresent, evidenceWriteFailed, billingWriteFailed, evidenceRevision, savedEvidenceRevision, billingRevision, savedBillingRevision };
    }
  };
  budget.onLedgerEvent = event => {
    if (event.type === "stop") {
      evidence.event({ type: "stop", reason: event.reason, inFlight: event.inFlight, scope: "run" });
      const reason = budget.haltReason ?? event.reason ?? "budget_stop";
      fatal ??= reason; activeRunStop?.(reason);
    }
    else if (event.entry) {
      const entry = event.entry, identity = entry.logicalCallId === null ? undefined : evidence.calls.get(entry.logicalCallId);
      if (event.type === "response") evidence.response(entry);
      else {
        const prior = budget.sends.filter(s => s.id !== entry.id && s.provider === "jev" && s.logicalCallId !== null &&
          evidence.calls.get(s.logicalCallId)?.instanceId === identity?.instanceId && s.costUsd !== null);
        evidence.event({ ...identity, type: event.type, sendId: entry.id,
          ...(entry.provider === "jev" ? { priorObservedSpentUsd: prior.reduce((n, s) => n + s.costUsd!, 0),
            priorObservedMaximumUsd: Math.max(0, ...prior.map(s => s.costUsd!)) } : {}) });
      }
    }
  };
  budget.onChange = entry => {
    const revision = ++billingRevision;
    const safe = { entry: { ...entry, model: entry.model && unsafe(entry.model) ? null : entry.model },
      stops: structuredClone(budget.stops) };
    billingWrites = billingWrites.then(async () => {
      await privateDirectory(directory);
      await appendFile(join(directory, "billing.private.jsonl"), JSON.stringify(safe) + "\n", { mode: 0o600 });
      savedBillingRevision = revision;
    }).catch(() => { billingWriteFailed = true; saveFailed("billing.private.jsonl"); });
  };
  budget.onRefusal = refusal => {
    const revision = ++billingRevision;
    const identity = refusal.logicalCallId == null ? undefined : evidence.calls.get(refusal.logicalCallId);
    evidence.event({ ...identity, type: "refused", status: "refused", reason: refusal.reason });
    billingWrites = billingWrites.then(async () => {
      await privateDirectory(directory);
      await appendFile(join(directory, "billing.private.jsonl"), JSON.stringify({ refused: refusal, stops: budget.stops }) + "\n", { mode: 0o600 });
      savedBillingRevision = revision;
    }).catch(() => { billingWriteFailed = true; saveFailed("billing.private.jsonl"); });
  };
  const freshClient = async (label: Label | "warmup", signal?: AbortSignal, trialOrder: number | null = null) => {
    const identity = { provider: "luna" as const, instanceId: `luna-${++instanceSequence}`, trialOrder, label, requestedModel: expectedModel };
    const connection = lunaWire(manifest.lunaRequest, budget, key => secrets.push(key), () => evidence.event({ ...identity,
      type: "policy_get", callId: 0, phase: "model_policy" }));
    if (signal) connection.bind(signal);
    const client = await deps.createLunaClient(label, { request: manifest.lunaRequest, instrumentFetch: connection.instrumentFetch });
    if (!client || typeof client.complete !== "function" || typeof client.getModelPolicy !== "function") fail("missing_luna_dependency");
    if (clients.has(client)) fail("shared_luna_client"); clients.add(client);
    connections.set(client, connection);
    lunaIdentities.set(client, identity);
    if (deps.execution === "live" && !connection.measured) fail("luna_http_uninstrumented");
    const policy = await client.getModelPolicy();
    if (policy.purpose !== PROFILE.modelPolicy.purpose || !policy.ready || !modelName(policy.model) || !["openai", "gemini"].includes(policy.provider)) fail("invalid_model_policy");
    identity.requestedModel = policy.model;
    return { client, policy: { purpose: policy.purpose, ready: policy.ready, model: policy.model, provider: policy.provider } };
  };
  let expectedModel = "", warmAudit: ObservationCacheAudit | null = null, cacheHash: string | null = null;
  let warmHttpRecords: HttpReceipt[] = [], warmMeasured = false, cacheStable = true;
  const warmCalls: CallReceipt[] = [];
  // Closed per-trial lifetime also covers signal-ignoring injected transports.
  function wireScope(raw: LunaClient, jev: ReturnType<Dependencies["createJevTransport"]> | null, calls: CallReceipt[],
    signal: AbortSignal, getTurn: () => number | null, isClosed: () => boolean, stop: (code: string) => void, getTape: () => ReplayTape | null = () => null) {
    const counts = new Map<string, number>();
    const lunaIdentity = lunaIdentities.get(raw)!;
    const jevInstances = { decision: `jev-decision-${++instanceSequence}`, local_function: `jev-local-${++instanceSequence}`,
      ai_function: `jev-ai-function-${++instanceSequence}`, ai_support: `jev-ai-support-${++instanceSequence}` };
    const start = (phase: Phase, provider: "luna" | "jev", request: unknown, instructions: unknown, imageCount = 0) => {
      if (signal.aborted || isClosed()) fail("aborted");
      try { budget.beforeSend(); } catch { stop("budget_stop"); fail("budget_stop"); }
      const turn = getTurn(), key = String(turn) + ":" + phase, count = (counts.get(key) ?? 0) + 1;
      if (count > CALL_CAPS[phase]) { stop("call_cap"); fail("call_cap"); } counts.set(key, count);
      if (provider === "luna") budget.lunaCalls++;
      const record: CallReceipt = { id: ++logicalCallSequence, sendIds: [], phase, turn, provider, requestSha256: researchHash(request), instructionSha256: researchHash(instructions),
        requestedModel: provider === "luna" ? expectedModel : PROFILE.modelPolicy.jevModel, model: null, status: "started", error: null,
        costUsd: null, inputTokens: null, outputTokens: null, imageCount, latencyMs: null };
      calls.push(record);
      const identity: EvidenceIdentity = { ...lunaIdentity, provider, requestedModel: record.requestedModel,
        instanceId: provider === "luna" ? lunaIdentity.instanceId : phase === "human_referent" || phase === "decision" ? jevInstances.decision
          : jevInstances[phase as "local_function" | "ai_function" | "ai_support"], callId: record.id, phase };
      evidence.calls.set(record.id, identity);
      if (provider === "luna") evidence.event({ ...identity, type: "complete" });
      return { record, started: performance.now() };
    };
    const rememberPrompt = (text: string) => { for (const line of text.split("\n")) if (line.trim().length >= 24) promptSpans.add(line.trim().slice(0, 80)); };
    const client = { async complete(messages: Message[], callOptions: { phase?: string; timeoutMs?: number; signal?: AbortSignal } = {}) {
      const phase = callOptions.phase as Phase;
      if (!["observation_initial", "observation_targeted", "local_extraction", "generation", "ai_extraction"].includes(phase)) fail("invalid_phase");
      let imageCount = 0;
      for (const m of messages) {
        if (m.role === "system" && typeof m.content === "string") rememberPrompt(m.content);
        if (typeof m.content === "string" && (m.content.includes(image.base64) || /data\s*:\s*image\s*\//iu.test(m.content))) { stop("embedded_image"); fail("embedded_image"); }
        if (Array.isArray(m.content)) for (const part of m.content) {
          if (part.type === "image_url") { imageCount++; if (part.image_url?.url !== `data:${image.mimeType};base64,${image.base64}`) { stop("wrong_image"); fail("wrong_image"); } }
          else if (typeof part.text === "string" && /data\s*:\s*image\s*\//iu.test(part.text)) { stop("embedded_image"); fail("embedded_image"); }
        }
      }
      if (imageCount && !["observation_initial", "observation_targeted"].includes(phase)) { stop("non_observation_image"); fail("non_observation_image"); }
      const { record, started } = start(phase, "luna", messages, messages.filter(m => m.role === "system"), imageCount);
      record.expectedHttpRequestSha256 = researchHash(canonicalLunaPayload(messages, manifest.lunaRequest));
      const callSignal = callOptions.signal ? AbortSignal.any([signal, callOptions.signal]) : signal;
      const recordAbort = () => evidence.event({ ...evidence.calls.get(record.id), type: "stop", reason: "phase_aborted",
        scope: "instance", scopeDetail: "logical_call", inFlight: budget.sends.filter(s => s.logicalCallId === record.id && s.status !== "observed_response").map(s => s.id) });
      callSignal.addEventListener("abort", recordAbort, { once: true });
      try {
        const reply = await connections.get(raw)!.withCall(record, () => raw.complete(messages, { ...callOptions, signal: callSignal }), callSignal);
        if (isClosed() || callSignal.aborted) fail("aborted");
        if (reply.model !== expectedModel) { stop("model_changed"); fail("model_changed"); }
        record.model = reply.model ?? null; record.inputTokens = tokens(reply.usage?.inputTokens); record.outputTokens = tokens(reply.usage?.outputTokens);
        if (!connections.get(raw)!.measured) {
          if (record.inputTokens === null) budget.syntheticInputUnknown++; else budget.syntheticInputTokens += record.inputTokens;
          if (record.outputTokens === null) budget.syntheticOutputUnknown++; else budget.syntheticOutputTokens += record.outputTokens;
          budget.checkObservedLimits();
        }
        record.status = "ok";
        getTape()?.luna.push({ phase, response: { text: reply.text, model: reply.model, usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens } } });
        return reply;
      } catch (error) {
        if (error instanceof LunaWireError) stop(error.code);
        for (const id of record.sendIds) { const send = budget.sends.find(s => s.id === id); if (send?.status === "observed_response") evidence.response(send, "error"); }
        if (!isClosed()) { record.status = "error"; record.error = error instanceof HarnessError ? error.code : "luna_error"; } throw new HarnessError(record.error ?? "aborted"); }
      finally { callSignal.removeEventListener("abort", recordAbort); if (!isClosed()) record.latencyMs = Math.max(0, performance.now() - started); }
    } };
    const fetchImpl = async (url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)), questions = Object.keys(payload.questions ?? {});
      const state = JSON.parse(payload.state);
      const phase: Phase = questions.includes("human_referent") ? "human_referent" : questions.some(k => k.endsWith("_support")) ? "ai_support"
        : questions.some(k => k.endsWith("_act")) ? (Object.hasOwn(state, "aiSeq") ? "ai_function" : "local_function") : "decision";
      const body = String(init.body);
      if (body.includes(image.base64) || /image_url|data\s*:\s*image\s*\//iu.test(body)) { stop("non_observation_image"); fail("non_observation_image"); }
      for (const q of Object.values(payload.questions) as Array<{ instructions: string }>) rememberPrompt(q.instructions);
      const { record, started } = start(phase, "jev", payload, payload.questions);
      const callSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      if (callSignal.aborted) { budget.refuse("jev_http", "phase_aborted", record.id); fail("aborted"); }
      const send = budget.reserve("jev", phase, getTurn(), record.id); record.sendIds.push(send.id);
      let sent = false;
      const recordAbort = () => {
        evidence.event({ ...evidence.calls.get(record.id), type: "stop", reason: "phase_aborted", scope: "instance",
          scopeDetail: "logical_call", inFlight: send.status === "observed_response" ? [] : [send.id] });
        if (sent && send.status === "in_flight") budget.unknown(send);
      };
      callSignal.addEventListener("abort", recordAbort, { once: true });
      try {
        sent = true; budget.sent(send);
        const response = await jev!.fetchImpl(url, { ...init, signal: callSignal });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); budget.jevUnknown = true; stop("jev_http_error"); fail("jev_http_error"); }
        const data = await response.clone().json() as { model?: unknown; id?: unknown; answers?: unknown; usage?: { cost?: unknown } };
        const cost = data.usage?.cost;
        const costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
        const modelMatches = isGroundingModel(data.model, PROFILE.modelPolicy.jevModel);
        budget.observe(send, { costUsd, model: modelMatches ? data.model as string : null, modelMatches });
        if (isClosed() || signal.aborted) fail("aborted");
        if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) { budget.jevUnknown = true; stop("jev_cost_unknown"); fail("jev_cost_unknown"); }
        record.costUsd = cost as number;
        if (!isGroundingModel(data.model, PROFILE.modelPolicy.jevModel)) { stop("model_changed"); fail("model_changed"); }
        record.model = data.model as string; record.status = "ok";
        getTape()?.jev.push({ model: data.model, id: typeof data.id === "string" ? data.id : null, answers: data.answers, usage: { cost } });
        return response;
      } catch (error) { if (sent) budget.unknown(send); if (!isClosed()) { record.status = "error"; record.error = error instanceof HarnessError ? error.code : "jev_error";
        stop(record.error); } throw new HarnessError(record.error ?? "aborted"); }
      finally { callSignal.removeEventListener("abort", recordAbort); if (!isClosed()) record.latencyMs = Math.max(0, performance.now() - started); }
    };
    const adapterResult = (phase: "decision" | "human_referent" | "local_function" | "ai_function" | "ai_support", reason: string) => {
      const instanceId = phase === "decision" || phase === "human_referent" ? jevInstances.decision : jevInstances[phase];
      const identity = [...evidence.calls.values()].reverse().find(c => c.instanceId === instanceId);
      if (!identity) return;
      const known = budget.sends.filter(s => s.logicalCallId !== null && evidence.calls.get(s.logicalCallId)?.instanceId === instanceId && s.costUsd !== null);
      if (reason === "referent_validation_failed" && known.reduce((n, s) => n + s.costUsd!, 0) + Math.max(0, ...known.map(s => s.costUsd!)) > DEFAULT_COST_CAP_USD) reason = "cost_cap";
      if (reason === "cost_cap") evidence.event({ ...identity, phase, type: "stop", scope: "instance", reason,
        inFlight: budget.sends.filter(s => s.logicalCallId !== null && evidence.calls.get(s.logicalCallId)?.instanceId === instanceId && s.status !== "observed_response").map(s => s.id) });
      else {
        const send = [...budget.sends].reverse().find(s => s.logicalCallId === identity.callId);
        if (send?.status === "observed_response") evidence.response(send, "error");
      }
    };
    return { client, fetchImpl, adapterResult, readKey: async () => { const key = await jev!.readKey(); if (typeof key === "string") secrets.push(key); return key; } };
  }
  await persist("run.private.json", { runId, manifest, manifestSha256: researchHash(manifest), execution: deps.execution, profile: PROFILE, profileSha256: RESEARCH_TRIAL_PROFILE_SHA256,
    promptSources, scripts: scripts.map(s => ({ id: s.id, sha256: researchHash(s), turns: s.humanTurns.length })),
    engineeringLimits: { ...ENGINEERING_LIMITS, ...budget.limits }, comparison: "not_implemented_pending_researcher_decision",
    semantic: "not_installed_pending_auditor_approval", coverage: "not_measured_by_wiring_harness" }, ["profile", "manifest"]);
  evidencePublished = true; writeEvidence(); await evidenceWrites;
  let warmupSaving: Awaited<ReturnType<typeof auditability>> | null = null, plannedIndex = 0;
  try {
    if (firstSaveFailure) fail("save_failed");
    const warm = await freshClient("warmup"); expectedModel = warm.policy.model;
    const controller = new AbortController();
    activeRunStop = reason => { fatal ??= reason; controller.abort(); };
    const wire = wireScope(warm.client, null, warmCalls, controller.signal, () => null, () => false, code => { fatal = code; controller.abort(); });
    const cache = await createObservationCache({ directory: cacheDir, modelId: expectedModel, client: wire.client, onMiss: "observe", timeoutMs: PROFILE.timeouts.observationMs });
    const cacheFile = join(cacheDir, observationCacheFileName(createObservationCacheKey(own, { modelId: expectedModel })));
    let warmBefore: string | null = null;
    try { warmBefore = digestBytes(await readFile(cacheFile)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const initial = await cache.get(own, { signal: controller.signal }); warmAudit = initial.audit;
    if (warmCalls.length !== (warmAudit.status === "MISS" ? 1 : 0)) fail("cache_warmup_wiring");
    const warmHttp = connections.get(warm.client)!;
    warmHttpRecords = warmHttp.records; warmMeasured = warmHttp.measured;
    const posts = warmHttp.records.filter(r => r.kind === "completion_post").length;
    if (warmHttp.measured && (warmAudit.status === "MISS" ? posts < 1 || posts > 3 : posts !== 0)) fail("cache_warmup_http_wiring");
    warmHttp.close();
    activeRunStop = null;
    cacheHash = digestBytes(await readFile(cacheFile));
    evidence.cache({ trialOrder: null, status: warmAudit.status, beforeSha256: warmBefore, afterSha256: cacheHash,
      memo: initial.memo, memoSha256: researchHash(initial.memo), validated: true, requestedModel: expectedModel, returnedModel: warm.policy.model });
    await persist("warmup.private.json", { audit: warmAudit, memoSha256: researchHash(initial.memo), fileSha256: cacheHash, calls: warmCalls, http: warmHttp.records, policy: warm.policy }, ["usage", "model_ids"]);
    warmupSaving = await auditability();
    for (const planned of manifest.trials) {
        plannedIndex++;
        const script = scripts.find(s => s.id === planned.scriptId)!, label = planned.label;
        const beforeTrial = await auditability();
        if (beforeTrial.status === "save_failed") {
          skipped.push({ scriptId: script.id, label, reason: `save_failed:${beforeTrial.firstSaveFailure ?? "required_records"}`, status: "not_reached" }); continue;
        }
        if (planned.stage === "main" && manifest.trials.some(t => t.stage === "smoke") &&
            !trials.filter(t => t.stage === "smoke").some(t => t.gates?.passed)) {
          skipped.push({ scriptId: script.id, label, reason: "smoke_stage_not_ready", status: "not_reached" }); continue;
        }
        const stopReason = fatal ?? budget.stopReason();
        if (stopReason) { budget.stop(stopReason);
          skipped.push({ scriptId: script.id, label, reason: stopReason, status: "not_reached" }); continue; }
        const controller = new AbortController(), started = performance.now(); let closed = false, turn: number | null = null;
        let state: JevPrivateState | null = null;
        const events: Event[] = [], traces: JevTurnTrace[] = [];
        const trial: Trial = { scriptId: script.id, label, stage: planned.stage, completed: false, order: trials.length, profile: PROFILE, profileSha256: RESEARCH_TRIAL_PROFILE_SHA256,
          failure: null, cache: null, calls: [], turns: [], notReached: [], aiPublicSettlement: [], durationMs: 0, budget: null, http: [], attempts: [], replay: [], lastCommittedState: null, failureAtTurn: null,
          identity: { image: researchHash(image), anchors: researchHash(anchors), memo: "", prompts: researchHash(promptSources), profile: RESEARCH_TRIAL_PROFILE_SHA256,
            timeouts: researchHash(PROFILE.timeouts), requestedModels: researchHash({ luna: expectedModel, jev: PROFILE.modelPolicy.jevModel }), returnedModels: [] } };
        trials.push(trial);
        const trialBefore = digestBytes(await readFile(cacheFile));
        let initialTrialMemo: typeof initial.memo | null = null;
        let cacheReadAttempted = false;
        let setupStage: "luna_client" | "jev_transport" | "native_runtime" | "native_initialization" = "luna_client";
        const stop = (code: string) => { if (closed) return; if (!trial.failure) trial.failure = code;
          evidence.event({ type: "stop", trialOrder: trial.order, label, reason: code, scope: "trial",
            inFlight: budget.sends.filter(s => s.status !== "observed_response").map(s => s.id) });
          if (code === "trial_timeout") budget.stop("trial_timeout"); controller.abort(); };
        activeRunStop = stop;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const canceled = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new HarnessError(trial.failure ?? "aborted")), { once: true });
          timer = setTimeout(() => stop("trial_timeout"), ENGINEERING_LIMITS.trialMs);
        });
        const work = async () => {
          const fresh = await freshClient(label, controller.signal, trial.order); if (fresh.policy.model !== expectedModel) fail("model_changed");
          const connection = connections.get(fresh.client)!; trial.http = connection.records;
          setupStage = "jev_transport";
          const rawJev = deps.createJevTransport(label);
          if (!rawJev || typeof rawJev.readKey !== "function" || typeof rawJev.fetchImpl !== "function") fail("missing_jev_dependency");
          let tape: ReplayTape | null = null;
          setupStage = "native_runtime";
          const wire = wireScope(fresh.client, rawJev, trial.calls, controller.signal, () => turn, () => closed, stop, () => tape);
          const cached = await createObservationCache({ directory: cacheDir, modelId: expectedModel, onMiss: "error" });
          const observer = createLunaObserver(wire.client, { timeoutMs: PROFILE.timeouts.observationMs });
          const core = createJevDecisionClient({ enabled: true, readKey: wire.readKey, fetchImpl: wire.fetchImpl,
            timeoutMs: PROFILE.timeouts.decisionMs, questionLayout: PROFILE.questionLayout })!;
          let inputs = { humanReferent: [] as string[], actionInputs: [] as string[], humanMaterial: [] as string[], actionMaterial: [] as string[] };
          const jevDecision: JevDecisionClient = {
            async estimateReferent(input, opts) {
              inputs.humanMaterial.push(researchHash(input)); inputs.humanReferent.push(researchHash(buildHumanReferentPayload(input)));
              const result = await core.estimateReferent(input, opts);
              if (result.status !== "ok") { const reason = core.spentUsd > DEFAULT_COST_CAP_USD ? "cost_cap" : "referent_validation_failed";
                wire.adapterResult("human_referent", reason); stop(reason); } return result;
            },
            async decide(input, opts) {
              inputs.actionMaterial.push(researchHash(input)); inputs.actionInputs.push(researchHash(buildJevDecisionPayload(input)));
              try { return await core.decide(input, opts); }
              catch (error) { wire.adapterResult("decision", error instanceof JevDecisionError ? error.code : "decision_error");
                if (error instanceof JevDecisionError && error.code === "cost_cap") stop("cost_cap"); throw error; }
            },
          };
          const classifier = createJevLocalTestClassifier({ enabled: true, readKey: wire.readKey, fetchImpl: wire.fetchImpl, timeoutMs: PROFILE.timeouts.decisionMs })!;
          const runtime = createProfileDialogue(PROFILE, { client: wire.client, strategy: label, image, anchors, referenceMemory: PROFILE.referenceMemory,
            decisionMode: PROFILE.decisionMode, utteranceStyle: PROFILE.utteranceStyle, maxReobservations: PROFILE.maxReobservations,
            observer: { async reobserve(input, opts) { const result = await observer.reobserve(input, opts); tape?.reobservations.push(structuredClone(result)); return result; }, async observeAll(input, opts) {
              if (researchHash(input) !== researchHash(own)) fail("wrong_own_material");
              cacheReadAttempted = true;
              const hit = await cached.get(input, opts); trial.cache = hit.audit;
              initialTrialMemo = structuredClone(hit.memo);
              if (hit.audit.status !== "HIT" || researchHash(hit.memo) !== researchHash(initial.memo)) fail("cache_mismatch");
              trial.identity.memo = researchHash(hit.memo); return hit.memo;
            } }, jevDecision,
            localGrounding: { classifier, timeoutMs: PROFILE.timeouts.localMs, aiPublicClaims: PROFILE.localGrounding.aiPublicClaims,
              aiPublicTransport: { readKey: wire.readKey, fetchImpl: wire.fetchImpl, timeoutMs: PROFILE.timeouts.decisionMs } },
            onJevTurnTrace: trace => { if (!closed) {
              const localError = trace.local?.classifier.errorCode;
              if (localError) wire.adapterResult("local_function", localError);
              for (const phase of ["ai_function", "ai_support"] as const) {
                const error = trace.aiPublic?.stages[phase].error; if (error) wire.adapterResult(phase, error);
              }
              traces.push(structuredClone(trace));
            } } });
          setupStage = "native_initialization";
          state = await runtime.initializePrivateState!({ signal: controller.signal });
          if (closed || controller.signal.aborted) fail(trial.failure ?? "aborted");
          for (const text of script.humanTurns) {
            turn = events.length + 1; inputs = { humanReferent: [], actionInputs: [], humanMaterial: [], actionMaterial: [] };
            events.push({ id: `human-${turn}`, seq: turn, speaker: "human", text });
            const publicPrefix = events.map(e => ({ turn: e.seq, speaker: e.speaker, text: e.text }));
            await persist(`public-${trial.order}-${turn}.packet.json`, { prefix: publicPrefix, sha256: researchHash(publicPrefix) });
            const prefixSha256 = researchHash(events), callStart = trial.calls.length, traceStart = traces.length;
            tape = { state: structuredClone(state!), events: structuredClone(events), luna: [], jev: [], reobservations: [], expectedRequests: [] };
            const result = await runtime.runAiTurn({ events: structuredClone(events), privateState: state, lastEventId: events.at(-1)!.id,
              requestSeq: turn, signal: controller.signal });
            if (closed || controller.signal.aborted || budget.halted || fatal) fail(trial.failure ?? budget.haltReason ?? fatal ?? "aborted");
            publicText(result.text, secrets); if (unsafe(result.text)) fail("privacy_rejected");
            const settled = settleJevTurnTraces(traces.slice(traceStart), result.privateState);
            const trace = settled.find(t => t.status === "committed");
            if (!trace || trace.redacted || trace.publicSpeech !== result.text || trace.intervention !== "none_pending_researcher_decision") fail("trace_mismatch");
            const calls = trial.calls.slice(callStart), counts = Object.fromEntries(Object.keys(CALL_CAPS).map(phase => [phase, calls.filter(c => c.phase === phase).length]));
            if (trace!.aiPublic?.pending?.reasons.some(r => r.endsWith("_cost_cap"))) fail("cost_cap");
            if (calls.some(c => c.status !== "ok") || trace!.local?.localStatus !== "ok" || trace!.humanReferent?.status !== "ok" ||
                trace!.aiPublic?.pending?.status === "failed") fail("stage_wiring_failed");
            tape.expectedRequests = calls.map(c => ({ provider: c.provider, phase: c.phase,
              requestSha256: c.provider === "luna" ? c.httpRequestSha256 ?? c.expectedHttpRequestSha256! : c.requestSha256,
              ...(c.provider === "luna" ? { actualSendMeasured: !!c.httpRequestSha256, messagesSha256: c.requestSha256,
                sendIds: [...c.sendIds] } : {}) }));
            const { sides, ...replayResult } = await pairedReplay(tape, own, expectedModel, PROFILE);
            if (closed || controller.signal.aborted || budget.halted || fatal) fail(trial.failure ?? budget.haltReason ?? fatal ?? "aborted");
            trial.replay.push({ tape: structuredClone(tape), result: replayResult });
            if (sides.length === 2) evidence.pair(trial.order, turn, sides[0], sides[1]);
            if (trial.replay.at(-1)!.result.status !== "same_material_same_payload") fail("replay_not_verified");
            if (closed || controller.signal.aborted || budget.halted || fatal) fail(trial.failure ?? budget.haltReason ?? fatal ?? "aborted");
            state = result.privateState;
            evidence.event({ type: "commit", trialOrder: trial.order, label, turn });
            trial.turns.push({ turn, prefixSha256, ...structuredClone(inputs), internalSha256: researchHash({ graph: state!.graph, memo: state!.observationMemo,
              aiPublic: state!.aiPublic, ledger: state!.ledger, repairHistory: state!.repairHistory, humanReferent: trace!.humanReferent?.scores ?? null }),
              publicText: result.text, trace: settled, state: structuredClone(state!), wiring: {
              counts, stages: Object.fromEntries(Object.keys(CALL_CAPS).map(phase => [phase, counts[phase] ? calls.filter(c => c.phase === phase) : "not_called"])),
              aiPublic: trace!.aiPublic, humanLocal: trace!.local?.localStatus ?? "not_reached", humanReferent: trace!.humanReferent?.status ?? "not_reached",
              imageBoundary: calls.every(c => c.imageCount === 0 || c.phase === "observation_targeted"), publicationLeak: false } });
            events.push({ id: `ai-${turn + 1}`, seq: turn + 1, speaker: "ai", text: result.text });
            const publishedPrefix = events.map(e => ({ turn: e.seq, speaker: e.speaker, text: e.text }));
            await persist(`public-${trial.order}-${turn + 1}.packet.json`, { prefix: publishedPrefix, sha256: researchHash(publishedPrefix) });
          }
          if (trial.calls.some(c => c.phase === "observation_initial")) fail("cache_trial_wiring");
          trial.aiPublicSettlement = await settleAiPublicClaims(traces, state!); trial.completed = true;
        };
        try { await Promise.race([work(), canceled]); }
        catch (error) { trial.failure ??= budget.haltReason ?? fatal ?? (error instanceof HarnessError ? error.code : "trial_failed"); }
        finally { closed = true; activeRunStop = null; clearTimeout(timer); controller.abort(); }
        connections.forEach(c => { if (c.records === trial.http) c.close(); });
        trial.calls.filter(c => c.status === "started").forEach(c => {
          const last = budget.sends.find(s => s.id === c.sendIds.at(-1));
          c.status = "error"; c.error = last?.status === "observed_response" ? "aborted_after_response" : "in_flight_outcome_unknown";
          if (c.provider === "jev" && last?.costUsd !== undefined && last.costUsd !== null) c.costUsd = last.costUsd;
        });
        budget.sends.filter(s => s.status === "in_flight").forEach(s => budget.unknown(s));
        trial.attempts = state ? settleJevTurnTraces(traces, state) : structuredClone(traces);
        trial.lastCommittedState = structuredClone(state);
        trial.durationMs = Math.max(0, performance.now() - started);
        trial.identity.returnedModels = [...new Set(trial.calls.flatMap(c => c.model ? [c.model] : []))].sort();
        trial.failureAtTurn = trial.failure ? turn : null;
        trial.notReached = script.humanTurns.map((_s, i) => i * 2 + 1).filter(t => !trial.turns.some(r => r.turn === t) && t !== trial.failureAtTurn);
        trial.budget = budget.snapshot();
        const trialAfter = digestBytes(await readFile(cacheFile));
        if (trial.cache && initialTrialMemo) evidence.cache({ trialOrder: trial.order, status: trial.cache.status, beforeSha256: trialBefore,
          afterSha256: trialAfter, memo: initialTrialMemo, memoSha256: researchHash(initialTrialMemo), validated: true,
          requestedModel: expectedModel, returnedModel: expectedModel });
        else if (!cacheReadAttempted) evidence.cache({ trialOrder: trial.order, status: "not_attempted", reason: `setup_failed:${setupStage}` });
        if (trialAfter !== cacheHash) { cacheStable = false; trial.failure = "cache_changed"; trial.completed = false; fatal = "cache_changed"; }
        const saved = await auditability();
        trial.gates = stageGates(trial, { warmAudit, warmCalls, warmHttp: warmHttpRecords, measuredHttp: warmMeasured,
          saving: saved,
          cacheStable, privacyRejected, jevUnknown: budget.jevUnknown, execution: deps.execution });
        const coverage = wiringCoverage(trial, deps.execution, own);
        const failureCategory = !trial.failure ? null : budget.jevUnknown ? "sent_result_unknown_run_halted" :
          /budget|cost_cap|trial_timeout/u.test(trial.failure) ? "budget_or_time_stop" : "validation_or_pipeline_failure_known_billing";
        const trialSave = await persist(`trial-${trial.order}.private.json`, { ...trial, failureCategory, coverage, publicTurns: events }, ["profile", "cost", "usage", "model_ids"]);
        if (!trialSave.saved) {
          // No published gate file exists: the atomic trial-record save failed.
          // Other completed trials' historical gates are never revised.
          trial.gates.G3.passed = false; trial.gates.G3.saving = await auditability(); trial.gates.passed = false;
        }
        if (trialSave.redacted) { trial.completed = false; trial.failure = "privacy_rejected"; privacyRejected = true; }
        // A primary wiring failure is retained; do not repeat the same script/input.
        if (trial.failure) { fatal ??= trial.failure; budget.stop(trial.failure); }
    }
  } catch (error) {
    if (!(error instanceof HarnessError && error.code === "save_failed" && firstSaveFailure)) {
      fatal ??= budget.haltReason ?? (error instanceof HarnessError ? error.code : "warmup_failed"); budget.stop(fatal);
    }
    await persist("failure.private.json", { code: fatal ?? "save_failed", calls: warmCalls, cache: warmAudit }); }
  warmupSaving ??= await auditability();
  if (firstSaveFailure) for (const planned of manifest.trials.slice(plannedIndex)) skipped.push({ scriptId: planned.scriptId, label: planned.label,
    reason: `save_failed:${firstSaveFailure}`, status: "not_reached" });
  const pairs = scripts.map(s => {
    const pair = trials.filter(t => t.scriptId === s.id && t.stage === "main");
    return { scriptId: s.id, result: pair.length === 2 ? compareParity(pair[0], pair[1]) : { status: "not_reached" } };
  });
  await billingWrites;
  writeEvidence(); await evidenceWrites;
  let savedAtSummary = await auditability();
  const budgetAtSummary = budget.snapshot();
  const saveFailure = savedAtSummary.status === "save_failed" ? firstSaveFailure === "verifier-evidence.private.json" ? "evidence_record_failed"
    : firstSaveFailure === "billing.private.jsonl" ? "billing_record_failed" : "required_record_failed" : null;
  const summary = { runId, manifestSha256: researchHash(manifest), execution: deps.execution, profile: PROFILE, profileSha256: RESEARCH_TRIAL_PROFILE_SHA256,
    status: saveFailure ? "save_failed" : !fatal && !privacyRejected && trials.length === manifest.trials.length && trials.every(t => t.completed) ? "wiring_passed" : "wiring_failed",
    failure: saveFailure ?? fatal, executionFailure: fatal, auditability: savedAtSummary, warmupSaving, privacyRejected, runOrder: trials.map(t => ({ scriptId: t.scriptId, label: t.label })), pairs, skipped,
    budget: budgetAtSummary, cacheAudit: warmAudit, cacheFileSha256: cacheHash, comparison: "not_implemented_pending_researcher_decision",
    semantic: "independent_blind_packets_no_automated_scoring", gates: trials.map(t => t.gates), coverage: trials.map(t => wiringCoverage(t, deps.execution, own)),
    billingJournal: "billing.private.jsonl; late_consumption_revisions_do_not_commit_dialogue", billingWriteFailed,
    verifierEvidence: "verifier-evidence.private.json", evidenceWriteFailed };
  // The summary cannot include a receipt for its own not-yet-completed write.
  // Its transport result is returned directly; it never rewrites historical G3.
  const summarySave = await persist("summary.private.json", summary, [], false);
  if (!summarySave.saved) {
    summary.status = "save_failed"; summary.failure = "required_record_failed";
    savedAtSummary = await auditability(); summary.auditability = savedAtSummary;
  }
  await billingWrites;
  return { directory, summary, trials: structuredClone(trials), async flushBilling() {
    const current = await auditability(), latest = budget.snapshot();
    const diff = Object.fromEntries(Object.keys(current).filter(k => researchHash(current[k as keyof typeof current]) !== researchHash(savedAtSummary[k as keyof typeof current]))
      .map(k => [k, { snapshot: savedAtSummary[k as keyof typeof current], current: current[k as keyof typeof current] }]));
    return { ...latest, billingWriteFailed, evidenceWriteFailed,
      auditability: { ...current, snapshotStatus: savedAtSummary.status, changedSinceSnapshot: Object.keys(diff).length > 0,
        diff, consumptionDiff: { observedJevUsd: latest.observedJevUsd - budgetAtSummary.observedJevUsd,
          observedLunaTokens: latest.observedLunaTokens - budgetAtSummary.observedLunaTokens } } }; } };
}
export async function runParityLiveFromManifest(options: { outputDir: string; cacheDir: string; manifestFile: string; scripts?: readonly Script[] }, deps: Dependencies) {
  return runParityLive({ outputDir: options.outputDir, cacheDir: options.cacheDir, manifest: await loadRunManifest(options.manifestFile),
    scripts: options.scripts ?? SYNTHETIC_PROBES }, deps);
}
