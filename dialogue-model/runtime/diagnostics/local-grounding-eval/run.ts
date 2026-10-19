// Manual-only synthetic evaluation. Importing this module never calls an API.
import { mkdir, readFile, stat, writeFile, rm, appendFile, rename, truncate } from "node:fs/promises";
import { randomBytes, randomInt, createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";
import { createTrialV2, modelView } from "../../stimuli/scatter-v2.mjs";
import { createDialogueV2 } from "../../v2/dialogue-v2.mjs";
import { createChatClient } from "../../client.mjs";
import { loadConfig } from "../../config.mjs";
import { SYNTHETIC_CASES } from "./cases.ts";
import type { PublicTurn, LocalGroundingOptions } from "../../local-grounding/contract.ts";

export type EvaluationCase = { id: string; publicTurns: PublicTurn[] };
type Client = { complete(messages: any[], options?: any): Promise<{ text: string; model?: string }> };
export type EvaluationOptions = { outputDir: string; casesFile?: string; caseId?: string; resume?: boolean; seed: number;
  strategy: "repair-first" | "bypass-enabled" };
const fail = (code: string): never => { throw new Error(code); };
const sensitive = /(?:data:image\/|Bearer\s+\S+|sk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}|(?:api[_-]?key|RESEARCH_PROXY_TOKEN|UPSTREAM_API_KEY)\s*[:=]|[A-Za-z0-9+/]{200,}={0,2}|(?:^|\W)s-[0-9a-f]{4}(?:\W|$)|\d+:(?:local|ai)\d+|ownLedger|targetSlot|candidateName|discriminatingFeature|issueSummary|issueId|nameState|claimIds|sourceTurn|respondsTo|localGrounding|classifierKind|AI自身の作業メモ|公開発話の生成|この発話の判断|局所問題.*非公開)/iu;

/** Public allowlist plus fail-closed checks for credentials, image bodies and private prompts. */
export function assertPublicText(value: unknown, secrets: readonly string[] = []): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 8000) return fail("privacy_rejected");
  const normalized = value.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/gu, "");
  if (sensitive.test(normalized) || secrets.some((secret) => secret.length >= 8 && normalized.includes(secret.normalize("NFKC")))) fail("privacy_rejected");
}

export function parseArguments(args: readonly string[]): EvaluationOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!["--out", "--seed", "--strategy", "--cases", "--case", "--resume"].includes(name) || Object.hasOwn(values, name)) fail("invalid_arguments");
    if (name === "--resume") { values[name] = "true"; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) fail("invalid_arguments");
    values[name] = value;
  }
  if (!values["--out"]?.trim()) fail("output_directory_required");
  const seed = values["--seed"] === undefined ? 1701 : Number(values["--seed"]);
  const strategy = values["--strategy"] ?? "bypass-enabled";
  if (!Number.isSafeInteger(seed) || !["repair-first", "bypass-enabled"].includes(strategy) ||
      (values["--case"] && !/^[A-Za-z0-9_-]{1,80}$/.test(values["--case"]))) fail("invalid_arguments");
  return { outputDir: values["--out"], seed, strategy: strategy as EvaluationOptions["strategy"],
    ...(values["--cases"] ? { casesFile: values["--cases"] } : {}),
    ...(values["--case"] ? { caseId: values["--case"] } : {}), ...(values["--resume"] ? { resume: true } : {}) };
}

export async function validateOutputDirectory(path: string): Promise<string> {
  const destination = await outsideRepositoryDirectory(path);
  try { if (!(await stat(destination)).isDirectory()) fail("invalid_output_directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return destination;
}

function validateCases(value: unknown): EvaluationCase[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail("invalid_cases");
  const ids = new Set<string>();
  return (value as any[]).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_cases");
    const id = item.sequenceId ?? item.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || ids.has(id)) fail("invalid_cases");
    ids.add(id);
    if (!Array.isArray(item.publicTurns) || !item.publicTurns.length || item.publicTurns.length > 32) fail("invalid_cases");
    const publicTurns: PublicTurn[] = item.publicTurns.map((turn: any, index: number) => {
      if (!turn || Object.keys(turn).sort().join(",") !== "speaker,text,turn" || turn.turn !== index + 1 ||
          !["human", "ai"].includes(turn.speaker)) fail("invalid_cases");
      assertPublicText(turn.text);
      return { turn: turn.turn, speaker: turn.speaker, text: turn.text };
    });
    if (publicTurns.at(-1)?.speaker !== "human") fail("invalid_cases");
    return { id, publicTurns };
  });
}

/** Only publicTurns are retained. Expected annotations and candidate descriptions never enter prompts. */
export async function loadEvaluationCases(path?: string): Promise<EvaluationCase[]> {
  if (!path) return validateCases(SYNTHETIC_CASES);
  const canonical = await outsideRepositoryDirectory(path);
  const info = await stat(canonical);
  if (!info.isFile() || !canonical.endsWith(".json") || info.size > 2_000_000) fail("invalid_cases_file");
  let document: any;
  try { document = JSON.parse(await readFile(canonical, "utf8")); } catch { return fail("invalid_cases_file"); }
  if (document?.dataPolicy?.syntheticOnly !== true || document.dataPolicy.containsRealParticipantData !== false ||
      document.dataPolicy.containsExcelOrPast5Dialogues !== false) fail("synthetic_attestation_required");
  return validateCases(document.sequences);
}

/** Replays the same public prefix; earlier AI replies are fixed fixture speech, final reply is generated. */
export async function generateNextReply(example: EvaluationCase, options: EvaluationOptions, client: Client,
  localGrounding: LocalGroundingOptions | null): Promise<{ text: string; models: string[] }> {
  const models: string[] = [];
  const model = modelView(createTrialV2({ seed: options.seed }));
  let fixedReply: string | null = null;
  const replayClient = { async complete(messages: any[], callOptions: any = {}) {
    if (["generation", "regeneration"].includes(callOptions.phase) && fixedReply !== null) return { text: fixedReply };
    const reply = await client.complete(messages, callOptions);
    if (reply.model) models.push(reply.model);
    return reply;
  } };
  const dialogue = createDialogueV2({ client: replayClient, strategy: options.strategy, referenceMemory: true,
    image: { mimeType: model.mimeType, base64: model.png.toString("base64") }, anchors: model.anchors,
    ...(localGrounding ? { localGrounding } : {}) } as any);
  let privateState: any = dialogue.initialPrivateState();
  let text = "";
  for (const turn of example.publicTurns.filter((turn) => turn.speaker === "human" &&
      example.publicTurns.find((next) => next.turn === turn.turn + 1)?.speaker !== "human")) {
    fixedReply = example.publicTurns.find((next) => next.turn === turn.turn + 1 && next.speaker === "ai")?.text ?? null;
    const events = example.publicTurns.filter((prior) => prior.turn <= turn.turn)
      .map((prior) => ({ seq: prior.turn, id: `synthetic-${prior.turn}`, speaker: prior.speaker, text: prior.text }));
    const result = await dialogue.runAiTurn({ events, privateState, lastEventId: events.at(-1)!.id });
    privateState = result.privateState;
    text = result.text;
  }
  return { text, models };
}

export type CaseResult = { caseId: string; status: "completed" | "failed" | "skipped"; code?: EvaluationErrorCode };
export type EvaluationDependencies = { client: Client; createLocalGrounding: (client: Client) => LocalGroundingOptions;
  expectedModel?: string; secrets?: readonly string[]; randomOrder?: () => boolean;
  onCaseResult?: (result: CaseResult) => void; onRunStarted?: (directory: string) => void };
const ERROR_CODES = ["invalid_arguments", "output_directory_required", "invalid_output_directory", "repository_output_forbidden",
  "invalid_cases", "invalid_cases_file", "synthetic_attestation_required", "privacy_rejected", "model_changed", "case_not_found",
  "invalid_resume", "resume_mismatch", "evaluation_busy", "record_write_failed", "worker_client_required", "model_unavailable",
  "provider_http_error", "network_error", "timeout", "empty_response", "invalid_json", "invalid_policy_response", "evaluation_unavailable"] as const;
type EvaluationErrorCode = typeof ERROR_CODES[number];

/** Fixed codes only, including at the CLI boundary; never echo upstream messages. */
export function evaluationErrorCode(error: unknown): EvaluationErrorCode {
  const candidate = (error as { code?: unknown })?.code ?? (error as Error)?.message;
  return ERROR_CODES.some((code) => code === candidate) ? candidate as EvaluationErrorCode : "evaluation_unavailable";
}
export function evaluationErrorLine(error: unknown): string {
  return "synthetic_evaluation_failed " + evaluationErrorCode(error) + "\n";
}
const CONDITIONS = { old: "referenceMemory ON, localGrounding OFF", new: "referenceMemory ON, localGrounding ON (Luna extraction + provisional classifier)" };
type Mapping = { caseId: string; A: string; B: string };
type CompletedCase = { row: { caseId: string; publicTurns: PublicTurn[]; responses: { A: string; B: string } }; mapping: Mapping };
const exact = (value: any, keys: string[]) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

async function safeArtifact(path: string): Promise<void> {
  // Reject artifact symlinks as well as paths that now point into a repository.
  if (await outsideRepositoryDirectory(path) !== path) fail("repository_output_forbidden");
}
async function atomicWrite(path: string, body: string): Promise<void> {
  await safeArtifact(path);
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await safeArtifact(path);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
async function readRunFile(path: string, limit: number): Promise<string> {
  await safeArtifact(path);
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) return fail("invalid_resume");
  return readFile(path, "utf8");
}
function validateCompleted(raw: any, catalog: EvaluationCase[], secrets: readonly string[]): CompletedCase {
  if (!exact(raw, ["row", "mapping"]) || !exact(raw.row, ["caseId", "publicTurns", "responses"]) ||
      !exact(raw.row.responses, ["A", "B"]) || !exact(raw.mapping, ["caseId", "A", "B"])) return fail("invalid_resume");
  const example = catalog.find((example) => example.id === raw.row.caseId);
  if (!example || JSON.stringify(raw.row.publicTurns) !== JSON.stringify(example.publicTurns) || raw.mapping.caseId !== example.id ||
      !["old", "new"].includes(raw.mapping.A) || !["old", "new"].includes(raw.mapping.B) || raw.mapping.A === raw.mapping.B) return fail("invalid_resume");
  assertPublicText(raw.row.responses.A, secrets);
  assertPublicText(raw.row.responses.B, secrets);
  return raw as CompletedCase;
}
async function projectCompleted(directory: string, completed: CompletedCase[], metadata: object): Promise<void> {
  // Rebuild from the private journal on resume, repairing interrupted projection writes.
  await atomicWrite(join(directory, "blinded.jsonl"), completed.map((entry) => JSON.stringify(entry.row)).join("\n") + (completed.length ? "\n" : ""));
  await atomicWrite(join(directory, "mapping.private.json"), JSON.stringify({ ...metadata, conditions: CONDITIONS, mapping: completed.map((entry) => entry.mapping) }, null, 2) + "\n");
}
async function appendCompleted(directory: string, result: CompletedCase, completed: CompletedCase[], metadata: object): Promise<void> {
  const blinded = join(directory, "blinded.jsonl");
  await safeArtifact(blinded);
  await appendFile(blinded, JSON.stringify(result.row) + "\n", { mode: 0o600 });
  await atomicWrite(join(directory, "mapping.private.json"), JSON.stringify({ ...metadata, conditions: CONDITIONS,
    mapping: completed.map((entry) => entry.mapping) }, null, 2) + "\n");
}
async function evaluateCase(example: EvaluationCase, options: EvaluationOptions, dependencies: EvaluationDependencies): Promise<CompletedCase> {
  let modelChanged = false;
  const privateSpans = new Set<string>();
  const checkedClient: Client = { async complete(messages, callOptions) {
    for (const message of messages) if (message.role === "system" && typeof message.content === "string") {
      for (const line of message.content.split(/\r?\n/u)) if (line.trim().length >= 24) privateSpans.add(line.trim().slice(0, 80));
    }
    const response = await dependencies.client.complete(messages, callOptions);
    if (dependencies.expectedModel && response.model !== dependencies.expectedModel) { modelChanged = true; fail("model_changed"); }
    return response;
  } };
  const reverse = dependencies.randomOrder?.() ?? randomInt(2) === 1;
  const conditions = reverse ? ["new", "old"] : ["old", "new"];
  const outputs: Record<string, string> = {};
  for (const condition of conditions) {
    const local = condition === "new" ? dependencies.createLocalGrounding(checkedClient) : null;
    const reply = await generateNextReply(example, options, checkedClient, local);
    // The local pipeline may fall back; model drift still invalidates this pair.
    if (modelChanged) fail("model_changed");
    assertPublicText(reply.text, dependencies.secrets);
    if ([...privateSpans].some((span) => reply.text.includes(span))) fail("privacy_rejected");
    outputs[condition] = reply.text;
  }
  return { row: { caseId: example.id, publicTurns: example.publicTurns, responses: { A: outputs[conditions[0]], B: outputs[conditions[1]] } },
    mapping: { caseId: example.id, A: conditions[0], B: conditions[1] } };
}

export async function runEvaluation(options: EvaluationOptions, dependencies: EvaluationDependencies): Promise<string> {
  try { return await runEvaluationChecked(options, dependencies); }
  catch (error) { return fail(evaluationErrorCode(error)); }
}
async function runEvaluationChecked(options: EvaluationOptions, dependencies: EvaluationDependencies): Promise<string> {
  if (!Number.isSafeInteger(options.seed) || !["repair-first", "bypass-enabled"].includes(options.strategy) ||
      (options.resume !== undefined && typeof options.resume !== "boolean")) fail("invalid_arguments");
  const destination = await validateOutputDirectory(options.outputDir);
  const catalog = await loadEvaluationCases(options.casesFile);
  const examples = options.caseId ? catalog.filter((example) => example.id === options.caseId) : catalog;
  if (!examples.length) fail("case_not_found");
  for (const example of catalog) {
    assertPublicText(example.id, dependencies.secrets);
    for (const turn of example.publicTurns) assertPublicText(turn.text, dependencies.secrets);
  }
  if (dependencies.expectedModel) assertPublicText(dependencies.expectedModel, dependencies.secrets);
  const metadata = { schemaVersion: 2, seed: options.seed, strategy: options.strategy, model: dependencies.expectedModel ?? null,
    catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex") };
  const directory = options.resume ? destination : join(destination, `local-grounding-${randomBytes(12).toString("hex")}`);
  if (!options.resume) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    if (await validateOutputDirectory(destination) !== destination) fail("repository_output_forbidden");
    await mkdir(directory, { mode: 0o700 });
  }
  await safeArtifact(directory);
  const lock = join(directory, ".evaluation.lock");
  await safeArtifact(lock);
  try { await writeFile(lock, "evaluation_in_progress\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { return fail((error as NodeJS.ErrnoException).code === "EEXIST" ? "evaluation_busy" : "invalid_resume"); }
  try {
    const manifest = join(directory, "run.private.json"), journal = join(directory, "completed.private.jsonl");
    const failures = join(directory, "failures.jsonl");
    let completed: CompletedCase[] = [];
    if (options.resume) {
      let saved: unknown;
      let text: string;
      try { saved = JSON.parse(await readRunFile(manifest, 4096)); text = await readRunFile(journal, 16_000_000); }
      catch (error) { if (evaluationErrorCode(error) === "repository_output_forbidden") throw error; return fail("invalid_resume"); }
      if (JSON.stringify(saved) !== JSON.stringify(metadata)) fail("resume_mismatch");
      // Only newline-terminated journal entries are committed. Discard an interrupted tail.
      const end = text.lastIndexOf("\n") + 1;
      const committedText = text.slice(0, end);
      try { completed = committedText.split("\n").filter(Boolean).map((line) => validateCompleted(JSON.parse(line), catalog, dependencies.secrets ?? [])); }
      catch (error) { if (evaluationErrorCode(error) === "privacy_rejected") throw error; return fail("invalid_resume"); }
      if (new Set(completed.map((entry) => entry.row.caseId)).size !== completed.length) fail("invalid_resume");
      if (text.length !== committedText.length) { await safeArtifact(journal); await truncate(journal, Buffer.byteLength(committedText)); }
      await safeArtifact(failures);
      let failureText: string;
      try { failureText = await readRunFile(failures, 16_000_000); }
      catch (error) { if (evaluationErrorCode(error) === "repository_output_forbidden") throw error; return fail("invalid_resume"); }
      const failurePrefix = failureText.slice(0, failureText.lastIndexOf("\n") + 1);
      try {
        for (const line of failurePrefix.split("\n").filter(Boolean)) {
          const entry = JSON.parse(line);
          if (!exact(entry, ["caseId", "code"]) || !catalog.some((example) => example.id === entry.caseId) ||
              !ERROR_CODES.some((code) => code === entry.code)) fail("invalid_resume");
        }
      } catch { return fail("invalid_resume"); }
      if (failurePrefix.length !== failureText.length) await truncate(failures, Buffer.byteLength(failurePrefix));
    } else {
      await writeFile(manifest, JSON.stringify(metadata) + "\n", { flag: "wx", mode: 0o600 });
      await writeFile(journal, "", { flag: "wx", mode: 0o600 });
      await writeFile(failures, "", { flag: "wx", mode: 0o600 });
    }
    await projectCompleted(directory, completed, metadata);
    dependencies.onRunStarted?.(directory);
    const done = new Set(completed.map((entry) => entry.row.caseId));
    for (const example of examples) {
      if (done.has(example.id)) { dependencies.onCaseResult?.({ caseId: example.id, status: "skipped" }); continue; }
      let result: CompletedCase;
      try { result = await evaluateCase(example, options, dependencies); }
      catch (error) {
        const code = evaluationErrorCode(error);
        await safeArtifact(failures);
        try { await appendFile(failures, JSON.stringify({ caseId: example.id, code }) + "\n", { mode: 0o600 }); }
        catch { return fail("record_write_failed"); }
        dependencies.onCaseResult?.({ caseId: example.id, status: "failed", code });
        continue;
      }
      // One private journal entry binds the blind row and mapping before either projection changes.
      try {
        await safeArtifact(journal);
        await appendFile(journal, JSON.stringify(result) + "\n", { mode: 0o600 });
        completed.push(result);
        await appendCompleted(directory, result, completed, metadata);
      } catch { return fail("record_write_failed"); }
      done.add(example.id);
      dependencies.onCaseResult?.({ caseId: example.id, status: "completed" });
    }
    return directory;
  } finally { await rm(lock, { force: true }); }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await validateOutputDirectory(options.outputDir);
  const examples = await loadEvaluationCases(options.casesFile);
  if (options.caseId && !examples.some((example) => example.id === options.caseId)) fail("case_not_found");
  const config = loadConfig();
  if (config.provider !== "cloudflare" || config.purpose !== "dialogue_turn" || config.model !== undefined) fail("worker_client_required");
  const client = createChatClient(config);
  const policy = await client.getModelPolicy();
  if (!policy.ready) fail("model_unavailable");
  const { createLunaLocalExtractor } = await import("../../local-grounding/extract.ts");
  const { createLunaLocalClassifier } = await import("../../local-grounding/classify.ts");
  let failures = 0;
  const directory = await runEvaluation(options, { client, expectedModel: policy.model, secrets: [config.apiKey],
    onRunStarted: (directory) => { process.stdout.write("synthetic_evaluation_started " + basename(directory) + "\n"); },
    onCaseResult: (result) => {
      if (result.status === "failed") { failures++; process.stderr.write(JSON.stringify({ caseId: result.caseId, code: result.code }) + "\n"); }
      else process.stdout.write(JSON.stringify(result) + "\n");
    }, createLocalGrounding: (sharedClient) => ({
    extractor: createLunaLocalExtractor(sharedClient), classifier: createLunaLocalClassifier(sharedClient),
  }) });
  process.stdout.write("synthetic_evaluation_written " + basename(directory) + "\n");
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(evaluationErrorLine(error)); process.exitCode = 1; });
}
