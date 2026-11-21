// RESEARCHER ONLY. One full v2 AI turn (Luna judgment + public utterance) per
// synthetic case and strategy, through the normal createDialogueV2 path. Both
// strategies get the same seed board, events, ledger, prior acts and client;
// only `strategy` differs. Model input = own image + own anchors + public events
// + own ledger/acts (modelInput). NOTES and the trial key are used only after the
// call, to label the chosen target. Outputs must be outside Git.
// Dry run: node run.ts            Live: node --env-file=.env run.ts --live --cap 70 --out <dir>
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDialogueV2 } from "../../v2/dialogue-v2.mjs";
import { createTrialV2, modelView } from "../../stimuli/scatter-v2.mjs";
import { STRATEGIES } from "../../judgment/instructions.mjs";
import { loadConfig } from "../../config.mjs";
import { createChatClient } from "../../client.mjs";
import { parseArgs, outputDirectory, readJsonl, appendJsonl, cappedClient } from "../candidate-conflict/common.ts";
import { CASES, NOTES, SEED, modelInput } from "./cases.mjs";

export const OUTPUT_FILE = "turns.jsonl";
type Job = { id: string; caseId: string; strategy: string };

export function jobs(): Job[] {
  return CASES.flatMap((c: any) => STRATEGIES.map((strategy: string) => ({ id: `${c.id}:${strategy}`, caseId: c.id, strategy })));
}

/** Prior own acts as committed traces, so runAiTurn passes them as ownJudgmentHistory. */
export function privateStateFor(input: ReturnType<typeof modelInput>) {
  const aiSeqs = input.events.filter((e: any) => e.speaker === "ai").map((e: any) => e.seq);
  return { ledger: input.ownLedger, graph: null,
    judgments: input.prior.map((judgment: any, k: number) => ({ turnIndex: (aiSeqs[k] ?? 1) - 1, judgment, status: "committed" })) };
}

/** Records every model name the client reported, never message content. */
function modelRecorder(base: { complete(m: unknown[], o?: unknown): Promise<any> }) {
  const models: string[] = [];
  return { models, client: { async complete(messages: unknown[], options?: unknown) {
    const result = await base.complete(messages, options);
    models.push(typeof result?.model === "string" ? result.model : "unknown");
    return result;
  } } };
}

/** Post-hoc label: does the act (or its followUp, e.g. repair + re-proposal) reach the intended own id? */
export function labelTarget(judgment: any, intended: string | null) {
  const targets = [judgment.targetSlot, judgment.followUp?.targetSlot ?? null].filter((t) => t !== null);
  if (intended === null) return targets.length ? "bound_in_ambiguous_case" : "unbound";
  return targets.includes(intended) ? "intended" : targets.length ? "other_figure" : "unbound";
}

export async function runJob(job: Job, client: { complete(m: unknown[], o?: unknown): Promise<any> }, view = modelView(createTrialV2({ seed: SEED }))) {
  const c: any = CASES.find((x: any) => x.id === job.caseId);
  const input = modelInput(c);
  const recorder = modelRecorder(client);
  const dialogue = createDialogueV2({ client: recorder.client, strategy: job.strategy,
    image: { mimeType: view.mimeType, base64: view.png.toString("base64") }, anchors: view.anchors });
  const started = Date.now();
  const result = await dialogue.runAiTurn({ events: input.events, privateState: privateStateFor(input), lastEventId: input.events.at(-1)!.id });
  const trace = result.privateState.judgments.at(-1);
  const judgment = trace.judgment;
  const intended = NOTES[job.caseId].intended;
  return { id: job.id, caseId: job.caseId, strategy: job.strategy, utterance: result.text,
    judgment: { action: judgment.action, targetSlot: judgment.targetSlot, candidateName: judgment.candidateName ?? null,
      discriminatingFeature: judgment.discriminatingFeature ?? null, followUp: judgment.followUp ?? null },
    target: labelTarget(judgment, intended),
    actAcceptable: NOTES[job.caseId].acceptable[job.strategy].includes(judgment.action),
    validation: trace.validation ? { attempts: trace.validation.attempts ?? null, fallback: trace.validation.fallback ?? null, failures: trace.validation.failures ?? [] } : null,
    generationGuard: trace.generationGuard, models: recorder.models, elapsedMs: Date.now() - started };
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv, []);
  const out = await outputDirectory(args);
  const all = jobs();
  const done = new Set(out ? readJsonl(join(out, OUTPUT_FILE)).map((row) => row.id) : []);
  const todo = all.filter((job) => !done.has(job.id));
  log(JSON.stringify({ mode: args.live ? "live" : "dry-run", seed: SEED, jobs: all.length, todo: todo.length, cap: args.cap }));
  if (!args.live || !out) return { jobs: all, todo };
  if (args.cap < 1) throw new Error("cap_required");
  const { client, usage } = cappedClient(createChatClient(loadConfig(process.env)), args.cap);
  const view = modelView(createTrialV2({ seed: SEED }));
  for (const job of todo) {
    try { appendJsonl(out, OUTPUT_FILE, await runJob(job, client, view)); }
    catch (error: any) {
      log(JSON.stringify({ id: job.id, error: error?.code ?? (error?.message === "call_cap_reached" ? "call_cap_reached" : "error") }));
      if (error?.message === "call_cap_reached") break;
    }
  }
  log(JSON.stringify(usage));
  return { jobs: all, todo, usage };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; });
