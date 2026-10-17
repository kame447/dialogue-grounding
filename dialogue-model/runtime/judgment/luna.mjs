import { ACTIONS, SAFE_JUDGMENT, validateJudgment, validateOwnLedger, JudgmentValidationError } from "./schema.mjs";
import { STRATEGIES, TASK_INSTRUCTIONS, JUDGE_POLICIES, ownImageMessage, publicMessages } from "./instructions.mjs";

const JUDGE_INSTRUCTIONS = [
  "【非公開の対話判断】次の公開発話を生成するために、対話上の判断をJSONだけで返してください。これは対話相手への発話ではありません。",
  "キーは action, targetSlot, candidateName, discriminatingFeature, note の5個だけです。action は " + ACTIONS.join(" | ") + " です。",
  "targetSlot は自分の6位置の1つ、またはnull。candidateName は名称文字列またはnull。discriminatingFeature は候補を区別する画像上の特徴1つ、またはnull。note は短い作業メモまたはnullで、相手には公開されません。",
  "propose_name は対象と名前候補を選ぶ、agree は対象の名前に合意する、confirm は対象を区別する特徴で確かめる、repair は自分の対応・名称を訂正する、defer は保留、revisit は保留対象へ戻る、move_on は別対象へ進む、accept は相手の発言を受け止める、close は対話終了を相談する判断です。",
  "ownLedger は自分の過去判断を記録した作業メモで、相手との正しい対応を保証しません。記憶した名前を別名へ変更する場合はrepairを選び、相手に自己訂正を伝えてください。誤対応を取り消すrepairではcandidateName=nullで自分の枠を空にできます。",
  "propose_nameとagreeには対象枠と名称が必要です（既存の名前にagreeする場合の名称はnullでも構いません）。confirmには弁別的特徴が必要です。単に同じ形かどうかを聞くのではなく、回転しても変わりにくい尖りの数・細長さ・くぼみなどを画像から1つ選んでください。",
  "相手から名称が出るのを待つだけにせず、画像から未命名の対象の名前を提案できます。画像にない特徴・図形を推測で作らないでください。",
  "同じ質問を繰り返さず、公開応答に合わせて判断を更新してください。どの方略でも、見立ての完全一致と対象の識別を区別してください。",
  "各名称は200文字以内、特徴は400文字以内、メモは1000文字以内。説明文・Markdown・追加キーは返さないでください。",
].join("\n");

/** @returns {import('./schema.mjs').DialogueJudge & {getDiagnostics(): object[]}} */
export function createLunaJudge(client) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  const diagnostics = [];
  return {
    getDiagnostics() { return structuredClone(diagnostics); },
    async judge({ image = null, publicHistory, strategy, ownLedger, ownJudgmentHistory = [] }) {
      if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
      const ledger = validateOwnLedger(ownLedger);
      const previous = ownJudgmentHistory.map(({ action, targetSlot }) => {
        if (!ACTIONS.includes(action) || !(targetSlot === null || Object.hasOwn(ledger, targetSlot))) throw new Error("Invalid own judgment history");
        return { action, targetSlot };
      });
      const messages = [
        { role: "system", content: TASK_INSTRUCTIONS },
        { role: "system", content: JUDGE_POLICIES[strategy] },
        { role: "system", content: JUDGE_INSTRUCTIONS },
        ...ownImageMessage(image),
        { role: "system", content: "AI自身の作業メモ（公開発話ではない）:\n" + JSON.stringify({ ownLedger: ledger, ownJudgmentHistory: previous }) },
        ...publicMessages(publicHistory),
      ];
      const failures = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await client.complete(attempt ? [...messages,
          { role: "system", content: "前回の判断は検証できませんでした。検証理由: " + failures.at(-1) + "。既存枠の改名はrepairを使い、上記JSON形式と制約を守って再提出してください。" }] : messages,
        { phase: "judgment" });
        try {
          const judgment = validateJudgment(JSON.parse(response.text), { ownLedger: ledger });
          diagnostics.push({ attempts: attempt + 1, fallback: false, failures });
          return judgment;
        } catch (error) {
          failures.push(error instanceof JudgmentValidationError ? error.code : "invalid_json");
        }
      }
      diagnostics.push({ attempts: 2, fallback: true, failures });
      return { ...SAFE_JUDGMENT };
    },
  };
}
