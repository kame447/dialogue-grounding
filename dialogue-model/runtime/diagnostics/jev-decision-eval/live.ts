// Parent-run manual wiring check. Imports never read keys or contact a provider.
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AIConnectionError } from "../../client.mjs";
import { NamingTaskError } from "../../naming-error.mjs";
import { createDialogueV2 } from "../../v2/dialogue-v2.mjs";
import { settleLocalTraces } from "../../v2/local-grounding-turn.ts";
import type { LocalGroundingResearchRecord } from "../../v2/local-grounding-turn.ts";
import type { JevTurnTrace, JevPrivateState, JevGenerationErrorCode } from "../../v2/jev-turn.ts";
import { createTrialV2, modelView } from "../../stimuli/scatter-v2.mjs";
import { deriveLocalIssues } from "../../local-grounding/derive.ts";
import { assertPublicText, validateOutputDirectory } from "../local-grounding-eval/run.ts";
import type { LocalFunctionClassifier, LocalOwnAnchor, LocalSegmentProposal, PublicTurn } from "../../local-grounding/contract.ts";
import { LOCAL_ACTS, LOCAL_ASPECTS } from "../../local-grounding/contract.ts";
import type { ObservationObserver } from "../../observation/contract.ts";
import { ObservationError } from "../../observation/observe.ts";
import type { ObservationErrorCode } from "../../observation/observe.ts";
import type { JevDecisionClient, JevDecision, DecisionInputBudget, HumanReferentEstimate, HumanReferentMaterial } from "../../decision/contract.ts";
import type { JevDecisionCallEvidence, JevDecisionStageCallEvidence, JevDecisionRejectionCode } from "../../decision/jev-decision.ts";
import { isGroundingModel } from "../../../../workers/research-ai-proxy/src/grounding.ts";
import { SYNTHETIC_CASES } from "./cases.ts";
import type { SyntheticCase } from "./cases.ts";
import { evaluateRunGate, auditJevLocalTurn, memoIdentity, requestIdentity } from "./gate.ts";
import type { ObservationReceipt, WireReceipt, TrialReceipt, TurnReceipt, DecisionInputHashes } from "./gate.ts";

type Client = { complete(messages: any[], options?: any): Promise<{ text: string; model?: string }> };
type Event = { seq: number; id: string; speaker: "human" | "ai"; text: string };
export type EvaluationOptions = { outputDir: string; seed: number; caseId?: string; localTimeoutMs?: number; observationTimeoutMs?: number; decisionTimeoutMs?: number };
type ObservationFailure = { observationErrorCode?: ObservationErrorCode; observationPhase?: "initial" | "targeted" };
const CONNECTION_ERROR_CODES = ["timeout", "network_error", "invalid_json", "empty_response", "provider_http_error",
  "policy_http_error", "invalid_policy_response"] as const;
type ConnectionErrorCode = typeof CONNECTION_ERROR_CODES[number];
type ClientWireReceipt = WireReceipt & { errorCode?: ConnectionErrorCode };
type FailureRecord = { caseId: string; turn: number | null; code: EvaluationErrorCode;
  errorCode?: ConnectionErrorCode; generationErrorCode?: JevGenerationErrorCode } & ObservationFailure;
export type EvaluationDependencies = { client: Client; expectedModel: string; execution: "mock" | "live";
  createComponents(client: Client, options?: Pick<EvaluationOptions, "observationTimeoutMs" | "decisionTimeoutMs">): { observer: ObservationObserver; jevDecision: JevDecisionClient; classifier: LocalFunctionClassifier };
  strategy?: "repair-first" | "bypass-enabled"; cases?: readonly SyntheticCase[]; secrets?: readonly string[]; onStarted?: (directory: string) => void;
  onProgress?: (progress: { caseId: string; turn: number | null; stage: "initial" | "turn" | "finished" }) => void };

const CODES = ["invalid_arguments", "output_directory_required", "invalid_cases", "case_not_found", "privacy_rejected", "model_changed",
  "repository_output_forbidden", "invalid_output_directory", "worker_client_required", "model_unavailable", "evaluation_unavailable",
  "non_observation_image", "wrong_own_material", "observation_failed", "decision_failed", "local_grounding_failed", "unsafe_generation",
  "timeout", "aborted", "cost_cap", "model_mismatch", "invalid_state", "invalid_decision", "reobservation_limit", "generation_failed"] as const;
export type EvaluationErrorCode = typeof CODES[number];
const fail = (code: EvaluationErrorCode): never => { throw new HarnessError(code); };
const validTimeout = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 60000;

/** Only harness-owned messages or typed dependency errors are normalized here.
 * Arbitrary provider error.code/message/response is never persisted. */
export function evaluationErrorCode(error: unknown): EvaluationErrorCode {
  if (error instanceof HarnessError) return CODES.includes(error.code) ? error.code : "evaluation_unavailable";
  if (error instanceof NamingTaskError && ["repository_output_forbidden", "invalid_output_directory"].includes(error.code)) return error.code as EvaluationErrorCode;
  return "evaluation_unavailable";
}
class HarnessError extends Error {
  readonly code: EvaluationErrorCode;
  constructor(code: EvaluationErrorCode) {
    const safe = CODES.includes(code) ? code : "evaluation_unavailable";
    super(safe); this.name = "JevEvaluationError"; this.code = safe;
  }
}
function projectBudget(value: DecisionInputBudget | undefined): DecisionInputBudget | null {
  const keys: Array<keyof DecisionInputBudget["omitted"]> = ["publicTurns", "claims", "publicNames", "repairHistory",
    "reobservations", "observationDetails", "observationChars", "issueSummaryChars"];
  if (!value || value.maxChars !== 20000 || !Number.isSafeInteger(value.stateChars) || value.stateChars < 1 || value.stateChars > 20000 ||
      !value.omitted || keys.some(key => !Number.isSafeInteger(value.omitted[key]) || value.omitted[key] < 0)) return null;
  return { maxChars: 20000, stateChars: value.stateChars,
    omitted: Object.fromEntries(keys.map(key => [key, value.omitted[key]])) as DecisionInputBudget["omitted"] };
}
function connectionErrorCode(error: unknown): ConnectionErrorCode | undefined {
  try {
    if (error instanceof AIConnectionError) {
      const code = error.code;
      if (CONNECTION_ERROR_CODES.includes(code)) return code;
    }
  } catch { /* Do not read modified exception getters twice or preserve their text. */ }
  return undefined;
}
function publicText(value: unknown, secrets: readonly string[]): asserts value is string {
  try { assertPublicText(value, secrets); } catch { fail("privacy_rejected"); }
}

export function parseEvaluationArguments(args: readonly string[]): EvaluationOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!["--out", "--seed", "--case", "--local-timeout-ms", "--observation-timeout-ms", "--decision-timeout-ms"].includes(key) || Object.hasOwn(values, key) || !value?.trim() || value.startsWith("--")) fail("invalid_arguments");
    values[key] = value;
  }
  if (!values["--out"]) fail("output_directory_required");
  const seed = Number(values["--seed"] ?? 1701), localTimeoutMs = values["--local-timeout-ms"] === undefined ? undefined : Number(values["--local-timeout-ms"]);
  const observationTimeoutMs = values["--observation-timeout-ms"] === undefined ? undefined : Number(values["--observation-timeout-ms"]);
  const decisionTimeoutMs = values["--decision-timeout-ms"] === undefined ? undefined : Number(values["--decision-timeout-ms"]);
  if (!Number.isSafeInteger(seed) || (localTimeoutMs !== undefined && !validTimeout(localTimeoutMs)) || (observationTimeoutMs !== undefined && !validTimeout(observationTimeoutMs)) || (decisionTimeoutMs !== undefined && !validTimeout(decisionTimeoutMs)) ||
      (values["--case"] && !/^[A-Za-z0-9_-]{1,80}$/u.test(values["--case"]))) fail("invalid_arguments");
  return { outputDir: values["--out"], seed, ...(values["--case"] ? { caseId: values["--case"] } : {}),
    ...(localTimeoutMs === undefined ? {} : { localTimeoutMs }), ...(observationTimeoutMs === undefined ? {} : { observationTimeoutMs }), ...(decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs }) };
}

function validateCases(cases: readonly SyntheticCase[], secrets: readonly string[]): void {
  if (!Array.isArray(cases) || !cases.length || cases.length > 20 || new Set(cases.map(c => c.id)).size !== cases.length) fail("invalid_cases");
  for (const c of cases) {
    if (Object.keys(c).sort().join(",") !== (c.referentScenario === undefined ? "id,steps" : "id,referentScenario,steps") ||
        (c.referentScenario !== undefined && !["continuity", "construal", "split", "repair", "shift"].includes(c.referentScenario)) || !/^[A-Za-z0-9_-]{1,80}$/u.test(c.id) || !Array.isArray(c.steps) || !c.steps.length || c.steps.length > 32) fail("invalid_cases");
    for (const step of c.steps) {
      if (Object.keys(step).some(k => !["text", "expect", "check"].includes(k))) fail("invalid_cases");
      publicText(step.text, secrets);
      if (step.expect !== undefined && (!Array.isArray(step.expect) || !step.expect.length || step.expect.some(e =>
        !e || Object.keys(e).some(k => !["act", "aspect"].includes(k)) || !LOCAL_ACTS.includes(e.act) ||
        (e.aspect !== undefined && !LOCAL_ASPECTS.includes(e.aspect))))) fail("invalid_cases");
      if (step.check !== undefined && !["construal_without_conflict", "partial_agreement", "multiple_candidates"].includes(step.check)) fail("invalid_cases");
    }
  }
}

const turns = (events: Event[]): PublicTurn[] => events.map(e => ({ turn: e.seq, speaker: e.speaker, text: e.text }));
const compact = (text: string) => text.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");

export async function runJevEvaluation(options: EvaluationOptions, deps: EvaluationDependencies) {
  const destination = await validateOutputDirectory(options.outputDir);
  const catalog = deps.cases ?? SYNTHETIC_CASES, secrets = deps.secrets ?? [];
  if (!Number.isSafeInteger(options.seed) || (options.localTimeoutMs !== undefined && !validTimeout(options.localTimeoutMs)) ||
      (options.observationTimeoutMs !== undefined && !validTimeout(options.observationTimeoutMs)) ||
      (options.decisionTimeoutMs !== undefined && !validTimeout(options.decisionTimeoutMs)) ||
      (deps.strategy !== undefined && !["repair-first", "bypass-enabled"].includes(deps.strategy)) || !["mock", "live"].includes(deps.execution)) fail("invalid_arguments");
  validateCases(catalog, secrets); publicText(deps.expectedModel, secrets);
  const selected = catalog.filter(c => !options.caseId || c.id === options.caseId);
  if (!selected.length) fail("case_not_found");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (await validateOutputDirectory(destination) !== destination) fail("repository_output_forbidden");
  const directory = join(destination, "jev-e2e-" + randomBytes(12).toString("hex"));
  await mkdir(directory, { mode: 0o700 }); deps.onStarted?.(directory);
  const board = modelView(createTrialV2({ seed: options.seed }));
  const image = { mimeType: board.mimeType, base64: board.png.toString("base64") };
  const anchors: LocalOwnAnchor[] = board.anchors;
  const promptSpans = new Set<string>();
  let redacted = false, caseRedacted = false;
  const unsafeString = (s: string) => {
    const normalized = s.normalize("NFKC");
    return /data\s*:\s*image\s*\/|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9+/]{200,}={0,2}/iu.test(normalized) ||
      normalized.includes(image.base64) || secrets.some(secret => secret.length >= 8 && normalized.includes(secret.normalize("NFKC"))) ||
      [...promptSpans].some(span => compact(normalized).includes(compact(span)));
  };
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string" && unsafeString(value)) { redacted = true; caseRedacted = true; return { redacted: true }; }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
    return value;
  };
  const persist = async (file: string, value: unknown, append = false) => {
    if (await validateOutputDirectory(directory) !== directory) throw new HarnessError("repository_output_forbidden");
    const text = JSON.stringify(sanitize(value)) + "\n";
    if (append) await appendFile(join(directory, file), text, { mode: 0o600 });
    else await writeFile(join(directory, file), text, { mode: 0o600, flag: "wx" });
  };
  await persist("run.private.json", { schemaVersion: 1, architecture: "jev-decision-observation", seed: options.seed,
    execution: deps.execution, expectedModel: deps.expectedModel, expectedCaseIds: catalog.map(c => c.id), selectedCaseIds: selected.map(c => c.id),
    catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"), localTimeoutMs: options.localTimeoutMs,
    observationTimeoutMs: options.observationTimeoutMs, decisionTimeoutMs: options.decisionTimeoutMs,
    conditionNeutrality: "not_measured; verified_by_regression", referentScoring: "unscored; independent_posthoc_required",
    intervention: "none_pending_researcher_decision", comparison: "not_implemented_pending_researcher_decision" });
  const { settleJevTurnTraces, JevTurnError, normalizeGenerationErrorCode } = await import("../../v2/jev-turn.ts");
  const { validateJevDecision, validateHumanReferentEstimate, buildHumanReferentPayload, buildJevDecisionPayload, buildJevDecisionDetailPayload, parseJevActionTargetChoices, JevDecisionError, JEV_DECISION_REJECTION_CODES } = await import("../../decision/jev-decision.ts");
  const receipts: TrialReceipt[] = [];
  const failures: FailureRecord[] = [];
  for (const c of selected) {
    caseRedacted = false;
    const trial: TrialReceipt = { caseId: c.id, completed: false, expectedTurns: c.steps.length, referents: [], anchors: structuredClone(anchors), observations: [], wire: [], turns: [] };
    receipts.push(trial);
    let currentTurn: number | null = null, state: JevPrivateState | null = null;
    let callOrder = 0;
    let pendingLocal: LocalGroundingResearchRecord[] = [], pendingJev: JevTurnTrace[] = [];
    let decisionCalls: JevDecision[] = [];
    let decisionOrder: number[] = [];
    let decisionReferents: HumanReferentMaterial[] = [];
    let decisionInputHashes: DecisionInputHashes[] = [];
    let decisionAttempts: unknown[] = [];
    let clientFailure: EvaluationErrorCode | null = null;
    let failure: FailureRecord | undefined;
    const events: Event[] = [];
    const client: Client = { async complete(messages, callOptions) {
      const phase = String(callOptions?.phase ?? "unknown");
      const urls: string[] = [];
      let embeddedImages = 0;
      const inspectText = (value: unknown) => {
        if (typeof value === "string" && (value.includes(image.base64) || /data\s*:\s*image\s*\//iu.test(value.normalize("NFKC")))) embeddedImages++;
      };
      for (const message of messages) {
        if (message.role === "system" && typeof message.content === "string") for (const line of message.content.split(/\r?\n/u)) {
          const text = line.trim(); if (text.length >= 24 && !/^[{[]/u.test(text)) promptSpans.add(text.slice(0, 80));
        }
        if (typeof message.content === "string") inspectText(message.content);
        if (Array.isArray(message.content)) for (const part of message.content) {
          if (part.type === "image_url") urls.push(part.image_url?.url ?? "");
          else inspectText(part.text);
        }
      }
      const wire: ClientWireReceipt = { turn: currentTurn, phase, imageCount: urls.length + embeddedImages, succeeded: false }; trial.wire.push(wire);
      try {
        if (wire.imageCount && !["observation_initial", "observation_targeted"].includes(phase)) { clientFailure = "non_observation_image"; throw new HarnessError(clientFailure); }
        if (embeddedImages || urls.some(url => url !== `data:${image.mimeType};base64,${image.base64}`)) { clientFailure = "wrong_own_material"; throw new HarnessError(clientFailure); }
        const reply = await deps.client.complete(messages, callOptions);
        if (reply.model !== deps.expectedModel) { clientFailure = "model_changed"; throw new HarnessError(clientFailure); }
        wire.succeeded = true; return reply;
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        const code = connectionErrorCode(error);
        if (code) { wire.errorCode = code; throw new AIConnectionError(code); }
        throw new HarnessError("evaluation_unavailable");
      }
    } };
    try {
      const componentOptions = { ...(options.observationTimeoutMs === undefined ? {} : { observationTimeoutMs: options.observationTimeoutMs }),
        ...(options.decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs: options.decisionTimeoutMs }) };
      const components = Object.keys(componentOptions).length ? deps.createComponents(client, componentOptions) : deps.createComponents(client);
      const observer: ObservationObserver = {
        async observeAll(input, callOptions) {
          const record: ObservationReceipt = { turn: currentTurn, kind: "initial", order: ++callOrder, figureIds: input.ownAnchors.map(a => a.id), succeeded: false };
          trial.observations.push(record);
          if (!isDeepStrictEqual(input.ownImage, image) || !isDeepStrictEqual(input.ownAnchors, anchors)) throw new HarnessError("wrong_own_material");
          const memo = await components.observer.observeAll(input, callOptions); record.memo = structuredClone(memo); record.succeeded = true; return memo;
        },
        async reobserve(input, callOptions) {
          const record: ObservationReceipt = { turn: currentTurn, kind: "targeted", order: ++callOrder, figureIds: [...input.figureIds], issue: structuredClone(input.issue), succeeded: false };
          trial.observations.push(record);
          if (!isDeepStrictEqual(input.ownImage, image) || !isDeepStrictEqual(input.ownAnchors, anchors)) throw new HarnessError("wrong_own_material");
          const result = await components.observer.reobserve(input, callOptions); record.result = structuredClone(result); record.succeeded = true; return result;
        },
      };
      const jevDecision: JevDecisionClient = {
        async estimateReferent(input, callOptions) {
          const order = ++callOrder, started = performance.now();
          let estimate: HumanReferentEstimate = { status: "unknown", scores: null, model: null, responseId: null,
            costUsd: null, latencyMs: 0, inputBudget: null, calibrated: false };
          const attempt = { turn: input.turn, order, inputSha256: requestIdentity(buildHumanReferentPayload(input)),
            observationMemo: memoIdentity(input.observations), estimate };
          trial.referents.push(attempt);
          try {
            const raw = await components.jevDecision.estimateReferent?.(structuredClone(input), callOptions);
            if (raw !== undefined) estimate = validateHumanReferentEstimate(raw, input);
          } catch (error) {
            estimate.latencyMs = Math.max(0, Math.round(performance.now() - started));
            let aborted = callOptions?.signal?.aborted === true;
            try { aborted ||= error instanceof JevDecisionError && error.code === "aborted"; }
            catch { /* Injected exception fields cannot become evidence or control flow. */ }
            if (aborted) throw new JevDecisionError("aborted");
          } finally { attempt.estimate = structuredClone(estimate); }
          return structuredClone(estimate);
        },
        async decide(input, callOptions) {
          const order = ++callOrder;
          const adapter = components.jevDecision as JevDecisionClient & { readonly lastEvidence?: JevDecisionCallEvidence | null };
          const previousIndex = adapter.lastEvidence?.callIndex ?? 0;
          let succeeded = false;
          try {
            const result = validateJevDecision(await adapter.decide(structuredClone(input), callOptions), input);
            decisionOrder.push(order); decisionCalls.push(structuredClone(result));
            decisionReferents.push(structuredClone(input.humanReferent ?? { status: "unknown", scores: null }));
            const detail = buildJevDecisionDetailPayload(input, { action: result.action, target: result.target });
            decisionInputHashes.push({ actionTarget: requestIdentity(buildJevDecisionPayload(input)), detail: detail ? requestIdentity(detail) : null });
            succeeded = true; return result;
          } finally {
            const evidence = adapter.lastEvidence;
            const fresh = evidence && Number.isSafeInteger(evidence.callIndex) && evidence.callIndex > previousIndex;
            const budget = fresh ? projectBudget(evidence.inputBudget) : null;
            // Rebuild each request from the same input and closed first-stage labels.
            // A failed detail call must not erase the successful action/target evidence.
            const closedChoices = (raw: Record<string, string>, questions: ReturnType<typeof buildJevDecisionPayload>["questions"]) => {
              const keys = Object.keys(questions);
              return raw && Object.keys(raw).length === keys.length && keys.every(key => typeof raw[key] === "string" &&
                Object.hasOwn(questions[key].criteria, raw[key])) ? Object.fromEntries(keys.map(key => [key, raw[key]])) : {};
            };
            const rejection = (error: unknown, code: unknown): JevDecisionRejectionCode | null => ["inconsistent_decision", "invalid_decision"].includes(String(error)) &&
              JEV_DECISION_REJECTION_CODES.includes(code as typeof JEV_DECISION_REJECTION_CODES[number]) ? code as JevDecisionRejectionCode : null;
            let choices: Record<string, string> = {};
            const stages: Array<Omit<JevDecisionStageCallEvidence, "scores" | "inputBudget" | "latencyMs"> &
              { inputBudget: DecisionInputBudget | null; latencyMs: number | null }> = [];
            if (fresh) try {
              const first = buildJevDecisionPayload(input);
              choices = closedChoices(evidence.choices, first.questions);
              let detail: ReturnType<typeof buildJevDecisionDetailPayload> = null;
              try { detail = buildJevDecisionDetailPayload(input, parseJevActionTargetChoices(input, choices)); }
              catch { /* Closed but inconsistent stage-one choices have no detail request. */ }
              if (Array.isArray(evidence.stages) && evidence.stages.length <= 2) for (const [i, stage] of evidence.stages.entries()) {
                const expected = i === 0 ? first : detail;
                if (!expected || stage.stage !== (i === 0 ? "action_target" : "detail")) continue;
                stages.push({ stage: stage.stage, status: stage.status === "ok" ? "ok" : "error",
                  model: isGroundingModel(stage.model, "typesafe/jev-1.14") ? stage.model : null,
                  responseId: typeof stage.responseId === "string" && /^gen-[A-Za-z0-9_-]{1,124}$/u.test(stage.responseId) ? stage.responseId : null,
                  latencyMs: Number.isFinite(stage.latencyMs) && stage.latencyMs >= 0 ? stage.latencyMs : null,
                  costUsd: typeof stage.costUsd === "number" && Number.isFinite(stage.costUsd) && stage.costUsd >= 0 ? stage.costUsd : null,
                  inputBudget: projectBudget(stage.inputBudget),
                  choices: closedChoices(stage.choices, expected.questions),
                  error: stage.error ? new JevDecisionError(stage.error).code : null,
                  rejectionCode: rejection(stage.error, stage.rejectionCode) });
              }
            } catch { /* Invalid or partial answers cannot provide closed choice evidence. */ }
            const rejectionCode = fresh ? rejection(evidence.error, evidence.rejectionCode) : null;
            decisionAttempts.push({ turn: input.turn, order, succeeded, callIndex: fresh ? evidence.callIndex : null,
              model: fresh && isGroundingModel(evidence.model, "typesafe/jev-1.14") ? evidence.model : null,
              responseId: fresh && typeof evidence.responseId === "string" && /^gen-[A-Za-z0-9_-]{1,124}$/u.test(evidence.responseId) ? evidence.responseId : null,
              latencyMs: fresh && Number.isFinite(evidence.latencyMs) && evidence.latencyMs >= 0 ? evidence.latencyMs : null,
              costUsd: fresh && typeof evidence.costUsd === "number" && Number.isFinite(evidence.costUsd) && evidence.costUsd >= 0 ? evidence.costUsd : null,
              error: fresh && evidence.error ? new JevDecisionError(evidence.error).code : succeeded ? null : "evaluation_unavailable", inputBudget: budget,
              choices, rejectionCode, stages });
            if (!succeeded) for (const stage of stages.length ? stages : [{ inputBudget: budget }]) {
              (trial.failedDecisionInputs ??= []).push({ turn: input.turn, inputBudget: stage.inputBudget });
            }
          }
        } };
      const dialogue = (createDialogueV2 as any)({ client, image, anchors, strategy: deps.strategy ?? "bypass-enabled", referenceMemory: true, decisionMode: "jev",
        observer, jevDecision, localGrounding: { classifier: components.classifier, ...(options.localTimeoutMs === undefined ? {} : { timeoutMs: options.localTimeoutMs }) },
        onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => pendingLocal.push(structuredClone(record)),
        onJevTurnTrace: (record: JevTurnTrace) => pendingJev.push(structuredClone(record)) });
      deps.onProgress?.({ caseId: c.id, turn: null, stage: "initial" });
      state = await dialogue.initializePrivateState();
      await persist("attempts.private.jsonl", { caseId: c.id, stage: "initial", observations: trial.observations }, true);
      if (caseRedacted) throw new HarnessError("privacy_rejected");
      for (const step of c.steps) {
        currentTurn = events.length + 1; decisionCalls = []; decisionOrder = []; decisionReferents = []; decisionInputHashes = []; decisionAttempts = []; pendingLocal = []; pendingJev = [];
        deps.onProgress?.({ caseId: c.id, turn: currentTurn, stage: "turn" });
        events.push({ seq: currentTurn, id: "synthetic-" + currentTurn, speaker: "human", text: step.text });
        const before = structuredClone(state!);
        let record: TurnReceipt | undefined;
        try {
          const result = await dialogue.runAiTurn({ events: structuredClone(events), privateState: structuredClone(before),
            lastEventId: events.at(-1)!.id, requestSeq: currentTurn });
          if (clientFailure) throw new HarnessError(clientFailure);
          publicText(result.text, secrets);
          if (unsafeString(result.text)) throw new HarnessError("privacy_rejected");
          state = result.privateState;
          const settledLocal = settleLocalTraces(pendingLocal, state), local = settledLocal.find(r => r.status === "committed");
          const segments: LocalSegmentProposal[] = (local?.extractor.segments ?? []).map(s => ({ segmentId: s.segmentId, quote: s.quote,
            targets: s.targets, aspect: s.aspect, proposition: s.proposition, name: s.name, linkedIssueId: s.linkedIssueId, respondsToTurn: s.respondsToTurn }));
          const localAudit = auditJevLocalTurn({ before, after: state, publicTurns: turns(events), record: local,
            segments, verdicts: (local?.classifier.verdicts ?? []).map(v => ({ ...v, rawScore: null })) });
          // No semantic segments requires no classifier call; a skipped call is
          // valid only alongside a successful, independently reproduced update.
          if (localAudit.pipelineOk && local?.classifier.status === "skipped" && !segments.length && !local.classifier.verdicts.length) localAudit.classifierOk = true;
          const settledJev = settleJevTurnTraces(pendingJev, state);
          const committed = settledJev.find(r => r.status === "committed");
          if (settledJev.some(r => r.redacted)) { redacted = true; caseRedacted = true; }
          const judgment = state!.judgments.at(-1)?.judgment;
          const traceMatches = !!committed && settledJev.filter(r => r.status === "committed").length === 1 &&
            committed.turnIndex === currentTurn && committed.lastEventId === events.at(-1)!.id &&
            isDeepStrictEqual(committed.decisions, decisionCalls) && isDeepStrictEqual(committed.finalAction, judgment) &&
            isDeepStrictEqual(state!.judgments.at(-1)?.jevTurn.decision, decisionCalls.at(-1)) &&
            isDeepStrictEqual(committed.humanReferent, state!.judgments.at(-1)?.jevTurn.humanReferent) &&
            committed.publicSpeech === result.text && isDeepStrictEqual(committed.observationMemo, state!.observationMemo) &&
            isDeepStrictEqual(committed.repairHistory, state!.repairHistory) && !committed.redacted;
          record = { turn: currentTurn, committed: !!committed, traceMatches, decisions: structuredClone(decisionCalls), decisionOrder: [...decisionOrder],
            humanReferent: structuredClone(committed?.humanReferent ?? null), decisionReferents: structuredClone(decisionReferents), decisionInputHashes: structuredClone(decisionInputHashes),
            finalAct: judgment ? { action: judgment.action, targetSlot: judgment.targetSlot, candidateName: judgment.candidateName, discriminatingFeature: judgment.discriminatingFeature } : null,
            intervention: (committed?.intervention ?? null) as TurnReceipt["intervention"], publicText: result.text, local: localAudit, issues: deriveLocalIssues(state!.graph),
            ledger: structuredClone(state!.ledger), repairHistory: structuredClone(state!.repairHistory), step: structuredClone(step) };
          trial.turns.push(record);
          events.push({ seq: currentTurn + 1, id: "synthetic-" + (currentTurn + 1), speaker: "ai", text: result.text });
          await persist("attempts.private.jsonl", { caseId: c.id, stage: "turn", turn: currentTurn, publicTurns: turns(events),
            referents: trial.referents.filter(r => r.turn === currentTurn), localRecords: settledLocal, jevRecords: settledJev, decisionAttempts, receipt: record }, true);
          await persist("referent-trajectories.private.jsonl", { caseId: c.id, turn: currentTurn, humanText: step.text,
            humanReferent: record.humanReferent, actionTarget: decisionCalls.at(-1)?.target ?? null,
            scoring: "unscored; independent_posthoc_required" }, true);
          if (caseRedacted) throw new HarnessError("privacy_rejected");
        } catch (error) {
          if (!record) trial.turns.push({ turn: currentTurn, committed: false, traceMatches: false, decisions: structuredClone(decisionCalls), decisionOrder: [...decisionOrder], humanReferent: null,
            decisionReferents: structuredClone(decisionReferents), decisionInputHashes: structuredClone(decisionInputHashes), finalAct: null,
            intervention: null, publicText: null, local: { turn: currentTurn, verified: [], unverified: 0, classifierOk: false, pipelineOk: false, model: null },
            issues: deriveLocalIssues(before.graph), ledger: before.ledger, repairHistory: before.repairHistory ?? [], step: structuredClone(step) });
          await persist("attempts.private.jsonl", { caseId: c.id, stage: "failed", turn: currentTurn, publicTurns: turns(events),
            referents: trial.referents.filter(r => r.turn === currentTurn), localRecords: settleLocalTraces(pendingLocal, before), jevRecords: settleJevTurnTraces(pendingJev, before), decisionAttempts }, true);
          throw error;
        }
      }
      trial.completed = true;
    } catch (error) {
      const turnCode = error instanceof JevTurnError ? new JevTurnError(error.code).code : null;
      const code = clientFailure ?? (turnCode !== null && CODES.some(c => c === turnCode) ? turnCode as EvaluationErrorCode : evaluationErrorCode(error));
      trial.failureCode = code;
      const observation: ObservationFailure = {};
      if (error instanceof JevTurnError) {
        if (error.observationErrorCode !== undefined) observation.observationErrorCode = new ObservationError(error.observationErrorCode).code;
        if (error.observationPhase === "initial" || error.observationPhase === "targeted") observation.observationPhase = error.observationPhase;
      }
      failure = { caseId: c.id, turn: currentTurn, code, ...observation };
      const wire = trial.wire.at(-1) as ClientWireReceipt | undefined;
      if (wire?.turn === currentTurn && !wire.succeeded && wire.errorCode && CONNECTION_ERROR_CODES.includes(wire.errorCode) &&
          (code === "generation_failed" && wire.phase === "generation" || code === "observation_failed" &&
            ["observation_initial", "observation_targeted"].includes(wire.phase))) failure.errorCode = wire.errorCode;
      if (error instanceof JevTurnError && code === "generation_failed") failure.generationErrorCode = normalizeGenerationErrorCode(error);
      failures.push(failure); await persist("failures.private.jsonl", failure, true);
    }
    await persist(c.id + ".private.json", { receipt: trial, publicTurns: turns(events), ...(failure ? { failure } : {}) });
    await persist("completed.private.jsonl", { caseId: c.id, completed: trial.completed }, true);
    deps.onProgress?.({ caseId: c.id, turn: currentTurn, stage: "finished" });
  }
  const gate = evaluateRunGate(receipts, catalog.map(c => c.id));
  if (redacted && !gate.unmet.includes("trial_incomplete")) { gate.unmet.push("trial_incomplete"); gate.passed = false; }
  await persist("gate.private.json", { ...gate, execution: deps.execution, failures, privacyRedacted: redacted,
    comparison: "not_implemented_pending_researcher_decision" });
  return { directory, status: gate.passed ? "passed" as const : "gate_failed" as const, gate };
}

async function main(): Promise<void> {
  const options = parseEvaluationArguments(process.argv.slice(2));
  await validateOutputDirectory(options.outputDir);
  validateCases(SYNTHETIC_CASES, []);
  if (options.caseId && !SYNTHETIC_CASES.some(c => c.id === options.caseId)) fail("case_not_found");
  const { loadConfig } = await import("../../config.mjs"), { createChatClient } = await import("../../client.mjs");
  const config = loadConfig();
  if (config.provider !== "cloudflare" || config.purpose !== "dialogue_turn" || config.model !== undefined) fail("worker_client_required");
  const client = createChatClient(config), policy = await client.getModelPolicy();
  if (!policy.ready) fail("model_unavailable");
  const { createLunaObserver } = await import("../../observation/observe.ts");
  const { createJevDecisionClient } = await import("../../decision/jev-decision.ts");
  const { createJevLocalTestClassifier } = await import("../../local-grounding/jev-local-test.ts");
  const result = await runJevEvaluation(options, { client, expectedModel: policy.model, execution: "live", secrets: [config.apiKey],
    createComponents: (shared, componentOptions = {}) => ({ observer: createLunaObserver(shared,
      componentOptions.observationTimeoutMs === undefined ? {} : { timeoutMs: componentOptions.observationTimeoutMs }), jevDecision: createJevDecisionClient({ enabled: true, ...(componentOptions.decisionTimeoutMs === undefined ? {} : { timeoutMs: componentOptions.decisionTimeoutMs }) })!,
      classifier: createJevLocalTestClassifier({ enabled: true })! }),
    onStarted: directory => process.stdout.write("jev_evaluation_started " + basename(directory) + "\n"),
    onProgress: progress => process.stdout.write(JSON.stringify(progress) + "\n") });
  process.stdout.write(JSON.stringify({ status: result.status, unmet: result.gate.unmet }) + "\n");
  if (result.status !== "passed") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write("jev_evaluation_failed " + evaluationErrorCode(error) + "\n"); process.exitCode = 1; });
}
