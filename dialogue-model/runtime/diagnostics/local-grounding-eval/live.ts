// Manual-only live synthetic evaluation. Importing never reads credentials or calls a model.
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes, randomInt, createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createDialogueV2 } from "../../v2/dialogue-v2.mjs";
import { settleLocalTraces } from "../../v2/local-grounding-turn.ts";
import type { LocalGroundingResearchRecord } from "../../v2/local-grounding-turn.ts";
import { createTrialV2, modelView } from "../../stimuli/scatter-v2.mjs";
import { validateReferenceInterpretation } from "../../judgment/memory.mjs";
import { isGroundingModel } from "../../../../workers/research-ai-proxy/src/grounding.ts";
import { validateOwnLedger } from "../../judgment/schema.mjs";
import { snapshotReferenceGraph } from "../../memory/reference-graph.mjs";
import { assertPublicText, validateOutputDirectory, evaluationErrorCode } from "./run.ts";
import { LIVE_CASES } from "./live-cases.ts";
import type { LiveCase, HumanStep } from "./live-cases.ts";
import { auditLocalTurn, evaluateValidityGate } from "./gate.ts";
import type { AuditReceipt, GateResult } from "./gate.ts";
import type { LocalGroundingOptions, LocalSegmentProposal, LocalFunctionVerdict, LocalExtractionInput, LocalClassificationInput, PublicTurn } from "../../local-grounding/contract.ts";

type Event = { seq: number; id: string; speaker: "human" | "ai"; text: string };
type Client = { complete(messages: any[], options?: any): Promise<{ text: string; model?: string }> };
export type LiveOptions = { outputDir: string; seed: number; strategy: "repair-first" | "bypass-enabled";
  mode: "branch" | "multiturn" | "both"; caseId?: string };
export type LiveDependencies = { client: Client; expectedModel: string;
  createLocalGrounding: (client: Client) => LocalGroundingOptions; secrets?: readonly string[];
  cases?: readonly LiveCase[]; randomOrder?: () => boolean; judge?: any;
  onStarted?: (directory: string) => void; onProgress?: (value: { caseId: string; stage: string; turn?: number }) => void };
type ClassifierEvidence = { turn: number; callIndex: number | null; status: "ok" | "error" | "skipped";
  model: string | null; responseId: string | null; costUsd: number | null; reason: "cost_cap" | "classifier_failed" | null };
type Session = { classifierEvidence: ClassifierEvidence[]; events: Event[]; state: any; records: LocalGroundingResearchRecord[]; receipts: AuditReceipt[];
  provenance: Array<{ humanTurn: number; aiTurn: number; judgment: any; text: string }> };
const fail = (code: string): never => { throw new Error(code); };
const turns = (events: Event[]): PublicTurn[] => events.map(e => ({ turn: e.seq, speaker: e.speaker, text: e.text }));
const safeAct = (act: any, slots: string[]): any => ({ action: act.action, targetSlot: act.targetSlot, candidateName: act.candidateName,
  discriminatingFeature: act.discriminatingFeature, ...(Object.hasOwn(act, "note") ? { note: null } : {}),
  ...(Object.hasOwn(act, "reference") ? { reference: validateReferenceInterpretation(act.reference, slots) } : {}),
  ...(Object.hasOwn(act, "followUp") ? { followUp: act.followUp ? safeAct(act.followUp, slots) : null } : {}) });

/** Persist only runtime state needed for provenance/reproduction, with free-form
 * judgment notes, prompt strings, provider responses and image data excluded. */
export function privateSnapshot(state: any): any {
  snapshotReferenceGraph(state.graph);
  return { ledger: validateOwnLedger(state.ledger), graph: structuredClone(state.graph),
    judgments: state.judgments.map((j: any) => ({ turnIndex: j.turnIndex, lastEventId: j.lastEventId ?? null,
      status: j.status, judgment: safeAct(j.judgment, Object.keys(state.ledger)),
      ...(j.localGrounding ? { localGrounding: { attemptNumber: j.localGrounding.attemptNumber } } : {}) })) };
}

export function parseLiveArguments(args: readonly string[]): LiveOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!["--out", "--seed", "--strategy", "--mode", "--case"].includes(flag) || Object.hasOwn(values, flag) || !value || value.startsWith("--")) fail("invalid_arguments");
    values[flag] = value;
  }
  const seed = Number(values["--seed"] ?? 1701), strategy = values["--strategy"] ?? "bypass-enabled", mode = values["--mode"] ?? "both";
  if (!values["--out"]) fail("output_directory_required");
  if (!Number.isSafeInteger(seed) || !["repair-first", "bypass-enabled"].includes(strategy) || !["branch", "multiturn", "both"].includes(mode) ||
      (values["--case"] && !/^[A-Za-z0-9_-]{1,80}$/.test(values["--case"]))) fail("invalid_arguments");
  return { outputDir: values["--out"], seed, strategy: strategy as LiveOptions["strategy"], mode: mode as LiveOptions["mode"],
    ...(values["--case"] ? { caseId: values["--case"] } : {}) };
}

function validateCatalog(catalog: readonly LiveCase[], secrets: readonly string[]): void {
  if (!Array.isArray(catalog) || !catalog.length || catalog.length > 100 || new Set(catalog.map(c => c.id)).size !== catalog.length) fail("invalid_cases");
  for (const c of catalog) {
    if (Object.keys(c).sort().join(",") !== "id,steps" || !/^[A-Za-z0-9_-]{1,80}$/.test(c.id) ||
        !Array.isArray(c.steps) || c.steps.length < 2 || c.steps.length > 32) fail("invalid_cases");
    assertPublicText(c.id, secrets);
    for (const s of c.steps) {
      if (Object.keys(s).some(k => !["text", "expect"].includes(k)) ||
          (s.expect !== undefined && !["agree", "deny", "name_accept", "defer", "revisit"].includes(s.expect))) fail("invalid_cases");
      assertPublicText(s.text, secrets);
    }
  }
}

export async function runLiveEvaluation(options: LiveOptions, deps: LiveDependencies): Promise<{
  directory: string; status: "completed" | "gate_failed" | "failed"; unmet?: string[]; code?: string;
}> {
  const destination = await validateOutputDirectory(options.outputDir);
  if (!Number.isSafeInteger(options.seed) || !["repair-first", "bypass-enabled"].includes(options.strategy) || !["branch", "multiturn", "both"].includes(options.mode)) fail("invalid_arguments");
  const secrets = deps.secrets ?? [], catalog = deps.cases ?? LIVE_CASES;
  validateCatalog(catalog, secrets); assertPublicText(deps.expectedModel, secrets);
  const selected = catalog.filter(c => !options.caseId || c.id === options.caseId);
  if (!selected.length) fail("case_not_found");
  await mkdir(destination, { mode: 0o700, recursive: true });
  if (await validateOutputDirectory(destination) !== destination) fail("repository_output_forbidden");
  const directory = join(destination, "local-live-" + randomBytes(12).toString("hex"));
  await mkdir(directory, { mode: 0o700 });
  deps.onStarted?.(directory);
  const promptSpans = new Set<string>();
  const instructionSpans = new Set<string>();
  let drift = false;
  const checked: Client = { async complete(messages, callOptions) {
    for (const message of messages) if (message.role === "system" && typeof message.content === "string") {
      for (const line of message.content.split(/\r?\n/u)) if (line.trim().length >= 24) {
        promptSpans.add(line.trim().slice(0, 80));
        // Structured state is intentionally persisted privately. Instructions are not.
        if (!/^[{[]/u.test(line.trim())) instructionSpans.add(line.trim().slice(0, 80));
      }
    }
    const reply = await deps.client.complete(messages, callOptions);
    if (reply.model !== deps.expectedModel) { drift = true; fail("model_changed"); }
    return reply;
  } };
  const publicText = (text: unknown) => {
    assertPublicText(text, secrets);
    const compact = (s: string) => s.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");
    if ([...promptSpans].some(s => compact(text).includes(compact(s)))) fail("privacy_rejected");
  };
  const write = async (file: string, value: unknown) => {
    const serialized = JSON.stringify(value);
    // Internal fields/IDs are intentional in PRIVATE files. Credentials, images,
    // and known prompt spans are forbidden in both private and blind artifacts.
    const check = (item: unknown): void => {
      if (typeof item === "string") {
        const normalized = item.normalize("NFKC");
        const compact = (s: string) => s.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");
        if (/data\s*:\s*image\s*\/|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9+/]{200,}={0,2}/iu.test(normalized) ||
            secrets.some(s => s.length >= 8 && normalized.includes(s.normalize("NFKC"))) ||
            [...instructionSpans].some(s => compact(normalized).includes(compact(s)))) fail("privacy_rejected");
      } else if (item && typeof item === "object") for (const child of Object.values(item)) check(child);
    };
    check(value);
    const path = join(directory, file);
    if (await validateOutputDirectory(directory) !== directory) fail("repository_output_forbidden");
    await writeFile(path, serialized + "\n", { mode: 0o600, flag: "wx" });
  };
  await write("run.private.json", { schemaVersion: 1, protocol: "generated-prefix-verified-jev", ...options, outputDir: undefined,
    model: deps.expectedModel, catalogHash: createHash("sha256").update(JSON.stringify(selected)).digest("hex") });
  const board = modelView(createTrialV2({ seed: options.seed }));
  const stimulus = { image: { mimeType: board.mimeType, base64: board.png.toString("base64") }, anchors: board.anchors };
  const localByCase = new Map<string, LocalGroundingOptions>();
  const fresh = (): Session => ({ classifierEvidence: [], events: [], state: null, records: [], receipts: [], provenance: [] });
  const advance = async (session: Session, steps: HumanStep[], localOn: boolean, caseId: string, stage: string) => {
    const captured = { segments: [] as LocalSegmentProposal[], verdicts: [] as LocalFunctionVerdict[] };
    if (localOn && !localByCase.has(caseId)) localByCase.set(caseId, deps.createLocalGrounding(checked));
    const local = localOn ? localByCase.get(caseId)! : null;
    const observed: LocalGroundingOptions | null = local && { timeoutMs: local.timeoutMs,
      extractor: { get lastDiagnostics() { return (local.extractor as any).lastDiagnostics; },
        async extract(input: LocalExtractionInput, opts?: { signal?: AbortSignal; timeoutMs?: number }) { const result = await local.extractor.extract(input, opts); captured.segments = structuredClone(result); return result; } } as any,
      classifier: { get metadata() { return (local.classifier as any).metadata; }, get lastEvidence() { return (local.classifier as any).lastEvidence; },
        async classify(input: LocalClassificationInput, opts?: { signal?: AbortSignal; timeoutMs?: number }) {
          try { const result = await local.classifier.classify(input, opts); captured.verdicts = structuredClone(result); return result; }
          finally {
            const e = (local.classifier as any).lastEvidence;
            session.classifierEvidence.push({ turn: input.turn, callIndex: Number.isSafeInteger(e?.callIndex) && e.callIndex > 0 ? e.callIndex : null,
              status: e?.status === "ok" || e?.status === "skipped" ? e.status : "error",
              model: isGroundingModel(e?.model, "typesafe/jev-1.14") ? e.model : null,
              responseId: typeof e?.responseId === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(e.responseId) ? e.responseId : null,
              costUsd: typeof e?.costUsd === "number" && Number.isFinite(e.costUsd) && e.costUsd >= 0 ? e.costUsd : null,
              reason: e?.error === "cost_cap" ? "cost_cap" : e?.status === "ok" || e?.status === "skipped" ? null : "classifier_failed" });
          }
        } } as any };
    const pending: LocalGroundingResearchRecord[] = [];
    const dialogue = createDialogueV2({ client: checked, ...stimulus, strategy: options.strategy, referenceMemory: true,
      ...(deps.judge ? { judge: deps.judge } : {}), ...(observed ? { localGrounding: observed } : {}),
      onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => pending.push(structuredClone(record)) } as any);
    session.state ??= dialogue.initialPrivateState();
    for (const step of steps) {
      const seq = session.events.length + 1;
      deps.onProgress?.({ caseId, stage, turn: seq });
      session.events.push({ seq, id: "synthetic-live-" + seq, speaker: "human", text: step.text });
      captured.segments = []; captured.verdicts = []; pending.length = 0;
      const before = structuredClone(session.state);
      let result;
      try {
        result = await dialogue.runAiTurn({ events: structuredClone(session.events), privateState: structuredClone(before),
          lastEventId: session.events.at(-1)!.id, requestSeq: seq });
        if (drift) fail("model_changed");
        publicText(result.text);
      } catch (error) {
        session.records.push(...settleLocalTraces(pending, session.state));
        throw error;
      }
      // Install together with publication, then settle the callback against that receipt.
      session.state = result.privateState;
      const settled = settleLocalTraces(pending, session.state);
      if (localOn) session.receipts.push(auditLocalTurn({ before, after: session.state, publicTurns: turns(session.events),
        record: settled.find(r => r.status === "committed"), segments: captured.segments, verdicts: captured.verdicts, expected: step.expect }));
      session.records.push(...settled);
      session.provenance.push({ humanTurn: seq, aiTurn: seq + 1, judgment: safeAct(session.state.judgments.at(-1).judgment, Object.keys(session.state.ledger)), text: result.text });
      session.events.push({ seq: seq + 1, id: "synthetic-live-" + (seq + 1), speaker: "ai", text: result.text });
    }
    return session;
  };
  const diagnostics = async (c: LiveCase, stage: string, session: Session, gate?: GateResult) => {
    await write(c.id + "." + stage + ".private.json", { caseId: c.id, stage, publicTurns: turns(session.events),
      provenance: session.provenance, classifierEvidence: session.classifierEvidence, records: session.records, receipts: session.receipts, snapshot: privateSnapshot(session.state), ...(gate ? { gate } : {}) });
  };
  const prefixes = new Map<string, Session>(), preflight: AuditReceipt[] = [];
  const failures: Array<{ caseId: string; stage: string; code: string }> = [];
  for (const c of selected) {
    const session = fresh();
    try {
      await advance(session, c.steps.slice(0, -1), true, c.id, "prefix");
      await diagnostics(c, "prefix", session, evaluateValidityGate(session.receipts));
      prefixes.set(c.id, session); preflight.push(...session.receipts);
    } catch (error) {
      failures.push({ caseId: c.id, stage: "prefix", code: evaluationErrorCode(error) });
      if (session.state) await diagnostics(c, "prefix-failed", session);
    }
  }
  await write("failures.private.json", failures);
  const gate = evaluateValidityGate(preflight);
  if (failures.length) gate.unmet.push("local_pipeline_incomplete");
  gate.unmet = [...new Set(gate.unmet)]; gate.passed = gate.unmet.length === 0;
  await write("gate.private.json", gate);
  if (!gate.passed) return { directory, status: "gate_failed", unmet: gate.unmet };
  const rows: any[] = [], mapping: any[] = [];
  for (const c of selected) {
    const modes = options.mode === "both" ? ["branch", "multiturn"] : [options.mode];
    for (const mode of modes) {
      const reverse = deps.randomOrder?.() ?? randomInt(2) === 1;
      const order = reverse ? ["new", "old"] : ["old", "new"];
      const outputs: Record<string, Session> = {};
      for (const condition of order) {
        const session = mode === "branch" ? structuredClone(prefixes.get(c.id)!) : fresh();
        // Prefix receipts remain private provenance; gate the new suffix on its own
        // only when combined with its shared, already verified prefix.
        try {
          await advance(session, mode === "branch" ? c.steps.slice(-1) : c.steps, condition === "new", c.id, mode + "-" + condition);
          const armGate = condition === "new" ? evaluateValidityGate(session.receipts) : undefined;
          await diagnostics(c, mode + "-" + condition, session, armGate);
          if (armGate && !armGate.passed) {
            await write("result.private.json", { status: "gate_failed", caseId: c.id, stage: mode, unmet: armGate.unmet });
            return { directory, status: "gate_failed", unmet: armGate.unmet };
          }
          outputs[condition] = session;
        } catch (error) {
          if (session.state) await diagnostics(c, mode + "-" + condition + "-failed", session);
          const code = evaluationErrorCode(error);
          await write(c.id + "." + mode + ".failure.private.json", { caseId: c.id, stage: mode, code });
          await write("result.private.json", { status: "failed", caseId: c.id, stage: mode, code });
          return { directory, status: "failed", code };
        }
      }
      const a = order[0], b = order[1];
      const row = mode === "branch" ? { caseId: c.id, mode, publicTurns: turns(outputs[a].events).slice(0, -1),
        responses: { A: outputs[a].events.at(-1)!.text, B: outputs[b].events.at(-1)!.text } } :
        { caseId: c.id, mode, dialogues: { A: turns(outputs[a].events), B: turns(outputs[b].events) } };
      rows.push(row); mapping.push({ caseId: c.id, mode, A: a, B: b });
      // Private per-pair checkpoint survives a later failure. Never share it with raters.
      await write(c.id + "." + mode + ".completed.private.json", { row, mapping: mapping.at(-1) });
    }
  }
  // No blind projection exists until EVERY required gate has passed.
  await write("mapping.private.json", { conditions: { old: "referenceMemory ON / localGrounding OFF", new: "referenceMemory ON / localGrounding ON / Jev local test" }, mapping });
  for (const row of rows) {
    const publicTurns = row.mode === "branch" ? [...row.publicTurns, ...Object.values(row.responses).map(text => ({ text }))] : [...row.dialogues.A, ...row.dialogues.B];
    for (const t of publicTurns) publicText(t.text);
  }
  if (await validateOutputDirectory(directory) !== directory) fail("repository_output_forbidden");
  await writeFile(join(directory, "blinded.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return { directory, status: "completed" };
}

async function main(): Promise<void> {
  const options = parseLiveArguments(process.argv.slice(2));
  await validateOutputDirectory(options.outputDir);
  validateCatalog(LIVE_CASES, []);
  if (options.caseId && !LIVE_CASES.some(c => c.id === options.caseId)) fail("case_not_found");
  const { loadConfig } = await import("../../config.mjs"), { createChatClient } = await import("../../client.mjs");
  const config = loadConfig();
  if (config.provider !== "cloudflare" || config.purpose !== "dialogue_turn" || config.model !== undefined) fail("worker_client_required");
  const client = createChatClient(config), policy = await client.getModelPolicy();
  if (!policy.ready) fail("model_unavailable");
  const { createLunaLocalExtractor } = await import("../../local-grounding/extract.ts");
  const { createJevLocalTestClassifier } = await import("../../local-grounding/jev-local-test.ts");
  const result = await runLiveEvaluation(options, { client, expectedModel: policy.model, secrets: [config.apiKey],
    onStarted: directory => process.stdout.write("live_evaluation_started " + basename(directory) + "\n"),
    onProgress: progress => process.stdout.write(JSON.stringify(progress) + "\n"),
    createLocalGrounding: shared => ({ extractor: createLunaLocalExtractor(shared), classifier: createJevLocalTestClassifier({ enabled: true })! }) });
  process.stdout.write(JSON.stringify({ status: result.status, ...(result.unmet ? { unmet: result.unmet } : {}), ...(result.code ? { code: result.code } : {}) }) + "\n");
  if (result.status !== "completed") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write("live_evaluation_failed " + evaluationErrorCode(error) + "\n"); process.exitCode = 1; });
}
