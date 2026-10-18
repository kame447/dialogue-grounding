// RESEARCHER ONLY. Scripted live comparison: the first N human lines of a
// recorded run are replayed verbatim (public text only) against a live v2 AI,
// default judge vs candidateConflict opt-in, same strategy, no decision model.
// The scripted lines do not react to the AI's replies.
// Dry run: node live-compare.ts --record <run.json> [--turns 7] [--strategy repair-first]
// Live: add --live --cap <maxCalls> --out <dir outside repo> (writes live-compare.json).
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLunaJudge } from "../../judgment/luna.mjs";
import { createTrialV2, modelView } from "../../stimuli/scatter-v2.mjs";
import { createDialogueV2 } from "../../v2/dialogue-v2.mjs";
import { loadConfig } from "../../config.mjs";
import { createChatClient } from "../../client.mjs";
import { parseArgs, outputDirectory, readJson, cappedClient } from "./common.ts";

export const SCRIPTED_OPENING = "まず、どの図形から話しましょうか？";

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv, ["record", "turns", "strategy"]);
  const out = await outputDirectory(args);
  const record = readJson(args.values.get("record")?.[0] ?? "");
  const lines: string[] = record.events.filter((e: any) => e.speaker === "human").slice(0, Number(args.values.get("turns")?.[0] ?? 7)).map((e: any) => e.text);
  const strategy = args.values.get("strategy")?.[0] ?? "repair-first";
  log(JSON.stringify({ mode: args.live ? "live" : "dry-run", conditions: 2, turns: lines.length, maxCalls: lines.length * 2 * 4, cap: args.cap }));
  if (!args.live || !out) return { lines };
  if (args.cap < 1) throw new Error("cap_required");
  const view = modelView(createTrialV2({ seed: record.seed }));
  const image = { mimeType: view.mimeType, base64: view.png.toString("base64") };
  const { client, usage } = cappedClient(createChatClient(loadConfig(process.env)), args.cap);
  const result: Record<string, unknown> = {};
  for (const candidateConflict of [false, true]) {
    const judge = createLunaJudge(client, candidateConflict ? { candidateConflict: true } : undefined);
    const dialogue = createDialogueV2({ client, strategy, image, anchors: view.anchors, judge });
    let state: any = dialogue.initialPrivateState();
    const events: any[] = [{ id: "e-1", seq: 1, speaker: "ai", text: SCRIPTED_OPENING, nonReferential: true }];
    const turns: unknown[] = [];
    for (const text of lines) {
      events.push({ id: `e-${events.length + 1}`, seq: events.length + 1, speaker: "human", text });
      try {
        const turn = await dialogue.runAiTurn({ events: structuredClone(events), signal: null, privateState: state, lastEventId: events.at(-1).id });
        state = turn.privateState;
        events.push({ id: `e-${events.length + 1}`, seq: events.length + 1, speaker: "ai", text: turn.text });
        const t: any = state.judgments.at(-1);
        turns.push({ human: text, ai: turn.text, action: t.judgment.action, target: t.judgment.targetSlot, feature: t.judgment.discriminatingFeature,
          conflict: t.validation?.conflict ?? null, conflictError: t.validation?.conflictError ?? null, failures: t.validation?.failures ?? [], guard: t.generationGuard });
      } catch (error: any) { turns.push({ human: text, error: error?.code ?? error?.message ?? "error" }); break; }
    }
    result[candidateConflict ? "opt" : "def"] = { turns, ledger: state.ledger };
  }
  writeFileSync(join(out, "live-compare.json"), JSON.stringify(result, null, 1));
  log(JSON.stringify(usage));
  return { lines, usage };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; });
