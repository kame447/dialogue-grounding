// Manual-only synthetic evaluation. Importing this module never calls an API.
import { mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { randomBytes, randomInt } from "node:crypto";
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
export type EvaluationOptions = { outputDir: string; casesFile?: string; seed: number;
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
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!["--out", "--seed", "--strategy", "--cases"].includes(name) || !value || value.startsWith("--") || Object.hasOwn(values, name)) fail("invalid_arguments");
    values[name] = value;
  }
  if (!values["--out"]?.trim()) fail("output_directory_required");
  const seed = values["--seed"] === undefined ? 1701 : Number(values["--seed"]);
  const strategy = values["--strategy"] ?? "bypass-enabled";
  if (!Number.isSafeInteger(seed) || !["repair-first", "bypass-enabled"].includes(strategy)) fail("invalid_arguments");
  return { outputDir: values["--out"], seed, strategy: strategy as EvaluationOptions["strategy"],
    ...(values["--cases"] ? { casesFile: values["--cases"] } : {}) };
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

export type EvaluationDependencies = { client: Client; createLocalGrounding: (client: Client) => LocalGroundingOptions;
  expectedModel?: string; secrets?: readonly string[]; randomOrder?: () => boolean };

export async function runEvaluation(options: EvaluationOptions, dependencies: EvaluationDependencies): Promise<string> {
  try { return await runEvaluationChecked(options, dependencies); }
  catch (error) {
    const allowed = ["invalid_arguments", "output_directory_required", "invalid_output_directory", "repository_output_forbidden",
      "invalid_cases", "invalid_cases_file", "synthetic_attestation_required", "privacy_rejected", "model_changed"];
    // Never expose a raw provider exception, path, prompt or authentication response.
    const candidate = (error as { code?: string })?.code ?? (error as Error)?.message;
    return fail(allowed.includes(candidate) ? candidate : "evaluation_unavailable");
  }
}

async function runEvaluationChecked(options: EvaluationOptions, dependencies: EvaluationDependencies): Promise<string> {
  if (!Number.isSafeInteger(options.seed) || !["repair-first", "bypass-enabled"].includes(options.strategy)) fail("invalid_arguments");
  // All input/output refusal happens before the first client call or directory write.
  const destination = await validateOutputDirectory(options.outputDir);
  const examples = await loadEvaluationCases(options.casesFile);
  for (const example of examples) {
    assertPublicText(example.id, dependencies.secrets);
    for (const turn of example.publicTurns) assertPublicText(turn.text, dependencies.secrets);
  }
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
  const rows: unknown[] = [], key: unknown[] = [];
  for (const example of examples) {
    const reverse = dependencies.randomOrder?.() ?? randomInt(2) === 1;
    const outputs: Record<string, string> = {};
    // Randomize execution order too, while retaining a single client and identical options.
    const conditions = reverse ? ["new", "old"] : ["old", "new"];
    for (const condition of conditions) {
      const local = condition === "new" ? dependencies.createLocalGrounding(checkedClient) : null;
      const reply = await generateNextReply(example, options, checkedClient, local);
      // Extraction/classification deliberately fall back on errors; model drift must still abort the pair.
      if (modelChanged) fail("model_changed");
      assertPublicText(reply.text, dependencies.secrets);
      if ([...privateSpans].some((span) => reply.text.includes(span))) fail("privacy_rejected");
      if (dependencies.expectedModel && reply.models.some((model) => model !== dependencies.expectedModel)) fail("model_changed");
      outputs[condition] = reply.text;
    }
    rows.push({ caseId: example.id, publicTurns: example.publicTurns, responses: { A: outputs[conditions[0]], B: outputs[conditions[1]] } });
    key.push({ caseId: example.id, A: conditions[0], B: conditions[1] });
  }
  // Write no prompts, images, token counts, private graph, expected labels or credentials.
  const blinded = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const mapping = JSON.stringify({ schemaVersion: 1, seed: options.seed, strategy: options.strategy,
    conditions: { old: "referenceMemory ON, localGrounding OFF", new: "referenceMemory ON, localGrounding ON (Luna extraction + provisional classifier)" }, mapping: key }, null, 2) + "\n";
  for (const secret of dependencies.secrets ?? []) if (secret.length >= 8 && (blinded.includes(secret) || mapping.includes(secret))) fail("privacy_rejected");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (await validateOutputDirectory(destination) !== destination) fail("repository_output_forbidden");
  const directory = join(destination, `local-grounding-${randomBytes(12).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    if (await validateOutputDirectory(directory) !== directory) fail("repository_output_forbidden");
    await writeFile(join(directory, "blinded.jsonl"), blinded, { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "mapping.private.json"), mapping, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return directory;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await validateOutputDirectory(options.outputDir);
  await loadEvaluationCases(options.casesFile);
  const config = loadConfig();
  if (config.provider !== "cloudflare" || config.purpose !== "dialogue_turn" || config.model !== undefined) fail("worker_client_required");
  const client = createChatClient(config);
  const policy = await client.getModelPolicy();
  if (!policy.ready) fail("model_unavailable");
  const { createLunaLocalExtractor } = await import("../../local-grounding/extract.ts");
  const { createLunaLocalClassifier } = await import("../../local-grounding/classify.ts");
  const directory = await runEvaluation(options, { client, expectedModel: policy.model, secrets: [config.apiKey], createLocalGrounding: (sharedClient) => ({
    extractor: createLunaLocalExtractor(sharedClient), classifier: createLunaLocalClassifier(sharedClient),
  }) });
  process.stdout.write("synthetic_evaluation_written " + basename(directory) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("synthetic_evaluation_failed\n"); process.exitCode = 1; });
}
