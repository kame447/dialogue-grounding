// RESEARCHER ONLY. Shared CLI plumbing for the candidate-conflict diagnostics.
// No data lives in this directory: every record, annotation and output path is
// an argument, live calls are opt-in (--live), and outputs must be outside Git.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";

export type Args = { live: boolean; out: string | null; cap: number; values: Map<string, string[]> };
export type PublicEvent = { seq: number; speaker: "human" | "ai"; text: string };

/** --live, --out <dir>, --cap <n>, and repeatable --<name> <value> pairs from `allowed`. */
export function parseArgs(argv: string[], allowed: readonly string[]): Args {
  const args: Args = { live: false, out: null, cap: 0, values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--live") { args.live = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("invalid_arguments");
    i++;
    if (flag === "--out") args.out = value;
    else if (flag === "--cap") {
      if (!/^[0-9]{1,3}$/.test(value)) throw new Error("invalid_cap");
      args.cap = Number(value);
    } else if (flag.startsWith("--") && allowed.includes(flag.slice(2))) {
      args.values.set(flag.slice(2), [...(args.values.get(flag.slice(2)) ?? []), value]);
    } else throw new Error("invalid_arguments");
  }
  return args;
}

/** Live mode needs --out outside the repository and a positive call cap. */
export async function outputDirectory(args: Args): Promise<string | null> {
  if (args.out !== null) return outsideRepositoryDirectory(args.out);
  if (args.live) throw new Error("output_required");
  return null;
}

/** `label=path` pairs, e.g. --record S1=/private/run.json. */
export function labelled(args: Args, name: string): Map<string, string> {
  return new Map((args.values.get(name) ?? []).map((entry) => {
    const at = entry.indexOf("=");
    if (at < 1) throw new Error("invalid_" + name);
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
}

export const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
export function readJsonl(path: string): any[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
export const appendJsonl = (dir: string, file: string, row: unknown) => appendFileSync(join(dir, file), JSON.stringify(row) + "\n");

/** Counts every attempted model call against a hard cap; never logs content. */
export function cappedClient(base: { complete(messages: unknown[], options?: unknown): Promise<any> }, cap: number) {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  return { usage, client: { async complete(messages: unknown[], options?: unknown) {
    if (usage.calls >= cap) throw new Error("call_cap_reached");
    usage.calls++;
    const response = await base.complete(messages, options);
    usage.inputTokens += response?.usage?.inputTokens ?? 0;
    usage.outputTokens += response?.usage?.outputTokens ?? 0;
    return response;
  } } };
}

/** Public prefix of a recorded v2 run up to (and including) a human turn. */
export function publicPrefix(record: any, turn: number): PublicEvent[] {
  return record.events.filter((e: any) => e.seq <= turn).map(({ seq, speaker, text }: PublicEvent) => ({ seq, speaker, text }));
}

/** Committed own acts before judgment index k, in primary-then-followUp order. */
export function ownHistoryBefore(record: any, k: number) {
  return record.judgments.slice(0, k).flatMap(({ judgment }: any) => [judgment, ...(judgment.followUp ? [judgment.followUp] : [])])
    .map(({ action, targetSlot, candidateName }: any) => ({ action, targetSlot, candidateName }));
}
