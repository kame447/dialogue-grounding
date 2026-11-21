// RESEARCHER ONLY. Japanese-dialogue judge over recorded synthetic turns (run.ts
// output) via the agy CLI. The model is pinned per call with --model; nothing
// changes agy or ORRERY defaults. The judge sees only the public synthetic
// history, a neutral researcher description of the situation, and the two
// strategies' utterances under shuffled labels. It never sees strategy names,
// internal judgments, ids, the trial key or images. The effective model is
// accepted only when the agy log names it; otherwise the row is "unverified".
// Dry run: node argon.ts --in <dir>       Live: add --live --cap <n> [--model gemini-4-argon-high --cases ja-03,ja-05]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { CASES, AXES, NOTICE } from "./cases.mjs";
import { parseArgs, readJsonl, appendJsonl } from "../candidate-conflict/common.ts";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";

export const MODELS = Object.freeze({ "gemini-4-argon-medium": "Gemini 4 Argon (Medium)", "gemini-4-argon-high": "Gemini 4 Argon (High)" });
export const OUTPUT_FILE = "argon.jsonl";

// Neutral, researcher-written facts the judge needs; no expected answer or strategy.
export const SITUATIONS: Record<string, string> = {
  "ja-01-open": "対話の冒頭。まだどの図形も話題になっていない。",
  "ja-02-impression": "人間はAI側にも同じ図形がある形を、見立てとして初めて紹介した。名前の採用はまだ求めていない。",
  "ja-03-ambiguous": "AI側の画像には『四角い出っぱり』をもつ図形が複数あり、人間の指示だけではどれか一つに絞れない。人間はAIに何に見えるかを質問している。",
  "ja-04-adoption": "直前にAIが該当図形を受け止めており、人間がその図形の名前を明示的に提案した。対象の取り違えはない。",
  "ja-05-backchannel": "AIが名前を出した直後、人間は『うーん』とだけ返した。",
  "ja-06-defer": "人間が名前を決めきれず、その図形を後回しにしたいと求めた。",
  "ja-07-revisit": "以前に後回しにした図形に、人間が戻ろうとし、自分の見立てを述べた。",
  "ja-08-repair": "AIは直前に、人間が言う図形とは別の図形の特徴（細長い首）を述べてしまっていた。人間がそれを指摘した。",
  "ja-09-satisfice": "人間は見立てが割れていることを認めたうえで、区別できればよいとして名前を提案した。対象の取り違えはない。",
  "ja-10-move-on": "ある図形の特定が決まらず、人間が別の図形へ移ることを提案した。",
};

const AXIS_TEXT = [
  "naturalness: 日本語チャットとしての自然さ（硬さ・翻訳調・実験用語の混入がないか）",
  "tone: 語調・丁寧さが相手と場面に合っているか",
  "over_questioning: 質問のし過ぎがないか（5=過剰な質問なし）",
  "needed_repair: 必要な確認・修復ができているか（不要な場面ならn/a）",
  "deferral: 判断保留や移行が場面に合っているか（該当しなければn/a）",
  "elicits_explanation: 相手に負担の少ない形で後続の説明を引き出せているか（該当しなければn/a）",
  "revisit: 保留した問題への再訪が適切か（該当しなければn/a）",
  "suboptimal_agreement: 細部の不一致を許した実用的な合意を受け入れられているか（該当しなければn/a）",
  "figure_name_correspondence: 発話が図形と名前の対応を誤らせる危険がないか（5=危険なし）",
  "joint_activity_flow: 共同作業が停滞せず進むか",
];

export const RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["X", "Y"],
  properties: Object.fromEntries(["X", "Y"].map((label) => [label, {
    type: "object", additionalProperties: false, required: ["scores", "overall", "verdict", "confidence", "reason"],
    properties: {
      scores: { type: "object", additionalProperties: false, required: [...AXES],
        properties: Object.fromEntries(AXES.map((axis: string) => [axis, { type: ["integer", "null"], minimum: 1, maximum: 5 }])) },
      overall: { type: "integer", minimum: 1, maximum: 5 },
      verdict: { type: "string", enum: ["good", "acceptable", "bad"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      reason: { type: "string", maxLength: 300 },
    },
  }])),
};

/** Deterministic label order per case so reruns are comparable; strategy names never appear. */
export function labelOrder(caseId: string): ["repair-first" | "bypass-enabled", "repair-first" | "bypass-enabled"] {
  return createHash("sha256").update("ja-turn-eval:" + caseId).digest()[0] % 2 === 0
    ? ["repair-first", "bypass-enabled"] : ["bypass-enabled", "repair-first"];
}

export function buildPrompt(caseId: string, utterances: Record<string, string>): string {
  const c: any = CASES.find((x: any) => x.id === caseId);
  if (!c || !SITUATIONS[caseId]) throw new Error("unknown_case");
  const [x, y] = labelOrder(caseId);
  const history = c.events.map((e: any) => (e.speaker === "human" ? "人間: " : "AI: ") + e.text).join("\n");
  return [
    "あなたは日本語対話の評価者です。ツールやファイルは使わず、この文面だけで判断してください。",
    "課題: 人間とAIが、それぞれ自分の画面に見える6つのタングラム図形（配置と向きは互いに異なる）について、チャットで相談して同じ図形に同じ名前を付ける共同命名課題。AIは相手の画面を見られない。",
    "以下はすべて研究者が作った合成対話で、実在の参加者の発話ではない。",
    "", "【これまでの公開対話】", history,
    "", "【場面の説明（研究者による）】", SITUATIONS[caseId],
    "", "【次のAI発話の候補】", "X: " + utterances[x], "Y: " + utterances[y],
    "", "X と Y をそれぞれ独立に、各観点を1〜5（5が最良）で採点してください。その場面で該当しない観点は null にしてください。",
    ...AXIS_TEXT,
    "overall は総合1〜5、verdict は good / acceptable / bad、confidence は判定の確信度、reason は日本語150字以内の根拠です。",
    "指定のJSONオブジェクトだけを返してください。",
  ].join("\n");
}

/** The effective model, only if the agy log shows that exact model propagated to the backend. */
export function verifiedModel(log: string, requested: string): string | null {
  const label = MODELS[requested as keyof typeof MODELS];
  if (!label) return null;
  const propagated = [...log.matchAll(/Propagating selected model override to backend: label="([^"]+)"/g)].map((m) => m[1]);
  return propagated.length > 0 && propagated.every((l) => l === label) ? requested : null;
}

export function parseReply(stdout: string) {
  const outer = JSON.parse(stdout);
  if (outer?.status !== "SUCCESS" || typeof outer.response !== "string") throw new Error("judge_failed");
  const text = outer.response.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const reply = JSON.parse(text);
  for (const label of ["X", "Y"]) {
    const r = reply?.[label];
    if (!r || !["good", "acceptable", "bad"].includes(r.verdict) || !Number.isInteger(r.overall)) throw new Error("invalid_judge_reply");
    for (const axis of AXES) if (!(r.scores?.[axis] === null || (Number.isInteger(r.scores?.[axis]) && r.scores[axis] >= 1 && r.scores[axis] <= 5))) throw new Error("invalid_judge_reply");
  }
  return { reply, usage: outer.usage ?? null, durationSeconds: outer.duration_seconds ?? null };
}

function callAgy(prompt: string, model: string) {
  // Empty scratch workspace: the judge gets no repository or tool context.
  const dir = mkdtempSync(join(tmpdir(), "ja-judge-"));
  try {
    const result = spawnSync("agy", ["-p", prompt, "--model", model, "--output-format", "json", "--sandbox", "--disable-slash-commands",
      "--json-schema", JSON.stringify(RESPONSE_SCHEMA), "--print-timeout", "300s", "--log-file", join(dir, "agy.log")],
      { cwd: dir, encoding: "utf8", timeout: 330000, maxBuffer: 4 * 1024 * 1024 });
    let log = "";
    try { log = readFileSync(join(dir, "agy.log"), "utf8"); } catch { /* missing log = unverified */ }
    return { status: result.status, stdout: result.stdout ?? "", verified: verifiedModel(log, model) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv, ["in", "model", "cases"]);
  const inDir = args.values.get("in")?.[0];
  if (!inDir) throw new Error("input_required");
  const dir = await outsideRepositoryDirectory(inDir);
  const model = args.values.get("model")?.[0] ?? "gemini-4-argon-medium";
  if (!MODELS[model as keyof typeof MODELS]) throw new Error("unsupported_model");
  const only = args.values.get("cases")?.join(",").split(",").filter(Boolean) ?? null;
  const turns = readJsonl(join(dir, "turns.jsonl"));
  const done = new Set(readJsonl(join(dir, OUTPUT_FILE)).filter((r) => r.verifiedModel === model).map((r) => r.caseId));
  const todo = CASES.map((c: any) => c.id).filter((id: string) => (!only || only.some((p) => id.startsWith(p))) && !done.has(id));
  log(JSON.stringify({ mode: args.live ? "live" : "dry-run", model, todo, cap: args.cap }));
  if (!args.live) return { todo };
  if (args.cap < 1) throw new Error("cap_required");
  let calls = 0;
  for (const caseId of todo) {
    if (calls >= args.cap) { log(JSON.stringify({ stop: "call_cap_reached" })); break; }
    const utterances = Object.fromEntries(turns.filter((t) => t.caseId === caseId).map((t) => [t.strategy, t.utterance]));
    if (!utterances["repair-first"] || !utterances["bypass-enabled"]) { log(JSON.stringify({ caseId, skip: "missing_turns" })); continue; }
    calls++;
    const call = callAgy(buildPrompt(caseId, utterances), model);
    const [x, y] = labelOrder(caseId);
    try {
      const parsed = parseReply(call.stdout);
      appendJsonl(dir, OUTPUT_FILE, { caseId, requestedModel: model, verifiedModel: call.verified, labels: { X: x, Y: y },
        byStrategy: { [x]: parsed.reply.X, [y]: parsed.reply.Y }, usage: parsed.usage, durationSeconds: parsed.durationSeconds });
      log(JSON.stringify({ caseId, verifiedModel: call.verified }));
    } catch (error: any) {
      appendJsonl(dir, OUTPUT_FILE, { caseId, requestedModel: model, verifiedModel: call.verified, error: error?.message ?? "error", exit: call.status });
      log(JSON.stringify({ caseId, error: error?.message ?? "error", verifiedModel: call.verified }));
    }
  }
  return { todo, calls };
}

export { NOTICE };
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; });
