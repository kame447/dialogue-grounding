// RESEARCHER ONLY, no network. Builds the exact Decisions evidence states for
// stored replay judgments (synthetic stimuli), so the active-judge comparison
// can run later with the same inputs once /v1/decisions is available.
// node planned-decisions.ts --record S1=<run.json> --rows <replay.jsonl> --out <dir outside repo>
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDecisionEvidence } from "../../v2/decision-evidence.mjs";
import { CASES } from "../../decisions-eval/cases.mjs";
import { parseArgs, outputDirectory, labelled, readJson, readJsonl, publicPrefix } from "./common.ts";

export function plannedInputs(rows: any[], records: Map<string, any>, purpose = "decision_jev") {
  return rows.flatMap((row) => {
    const [label, turn, strategy] = row.id.split(":");
    const record = records.get(label);
    if (record) {
      const j = record.judgments.find((entry: any) => entry.turnIndex === Number(turn));
      const events = publicPrefix(record, Number(turn)).map(({ speaker, text }) => ({ speaker, text }));
      return [{ id: row.id, purpose, state: buildDecisionEvidence({ events, ownLedger: j.ownLedgerBefore, judgment: row.judgment, strategy }) }];
    }
    const c = CASES.find((entry: any) => entry.id === `${label}:${turn}`);
    return c ? [{ id: row.id, purpose, state: buildDecisionEvidence({ events: c.events, ownLedger: c.ownLedger, judgment: row.judgment, strategy: c.strategy }) }] : [];
  });
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv, ["record", "rows"]);
  const out = await outputDirectory(args);
  const records = new Map([...labelled(args, "record")].map(([label, path]) => [label, readJson(path)]));
  const planned = plannedInputs((args.values.get("rows") ?? []).flatMap((path) => readJsonl(path)), records);
  log(JSON.stringify({ plannedDecisionInputs: planned.length, written: Boolean(out) }));
  if (out) writeFileSync(join(out, "planned-decisions-inputs.jsonl"), planned.map((p) => JSON.stringify(p)).join("\n") + "\n");
  return planned;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; });
