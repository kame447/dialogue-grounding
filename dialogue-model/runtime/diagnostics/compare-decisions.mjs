// Opt-in fixture smoke through the research Worker. No study data or keys in output.
import { loadConfig } from "../config.mjs";
import { createDecisionComparisonClient } from "../decisions-client.mjs";

const scenarios = Object.freeze([
  {
    id: "ambiguous",
    state: JSON.stringify({
      strategy: "bypass-enabled",
      lastPublicUtterance: "鳥みたいに見えませんか。",
      ownVisualEvidence: "自分の盤面には鳥に見立てられる図形が2種類あり、どちらを指すか未確定。",
      nameAdoptionEvidence: "なし",
      currentLedger: "未合意",
    }),
  },
  {
    id: "identified",
    state: JSON.stringify({
      strategy: "repair-first",
      lastPublicUtterance: "あの四角い部分のついた船ですね。じゃあ『船』にしましょう。",
      ownVisualEvidence: "相手の特徴に一致する図形が自分の盤面で1個に限定される。",
      nameAdoptionEvidence: "相手が明示的に船という名称の共同採用を提案",
      currentLedger: "対象を照合済み、名称は暫定",
    }),
  },
]);

async function main() {
  if (!process.argv.includes("--fixture")) {
    console.error("Usage: node --env-file=.env dialogue-model/runtime/diagnostics/compare-decisions.mjs --fixture");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const client = createDecisionComparisonClient(config);
  for (const scenario of scenarios) {
    for (const purpose of ["decision_jev", "decision_luna"]) {
      const started = performance.now();
      try {
        const result = await client.chooseAction({ purpose, state: scenario.state });
        console.log(JSON.stringify({
          scenario: scenario.id,
          model: result.model,
          action: result.action,
          agreeProbability: result.probabilities.agree,
          elapsedMs: Math.round(performance.now() - started),
          costUsd: result.usage?.costUsd ?? null,
        }));
      } catch (error) {
        console.log(JSON.stringify({ scenario: scenario.id, purpose, error: error.code ?? "unknown" }));
        process.exitCode = 1;
      }
    }
  }
}

await main();
