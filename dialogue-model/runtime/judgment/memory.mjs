import { validateReferenceUpdate, REFERENCE_LIMITS } from "../memory/reference-graph.mjs";

// Shared across strategies; present only when a private graph is supplied.
export const MEMORY_INSTRUCTIONS = [
  "AI自身の参照メモは正解表ではなく、自分の画像と公開発話に基づく作業メモです。ledgerとの矛盾は自分で吟味し、自動的に正しいと扱わないでください。",
  "任意キーmemoryOpsにnullまたは最大16件の操作配列を指定できます。必要な記録だけを判断し、不要なら空配列にしてください。公開発話を生成してから解析するのではなく、この非公開判断で操作を選びます。",
  "全操作はkindとidを持ちます。idは現在のturn番号:英数字のローカルID（1〜32文字）。同じ配列の前方の操作か保持済み記録だけを参照します。turnやexpectedRevisionは操作に追加せず、環境が付けます。以下の各kindの全フィールドを指定し、追加キーは付けないでください。",
  "mention: sourceTurn, speaker(human|ai), quote(公開発話の部分文字列・160字以内), slots(自分の候補位置の配列), confidence(0〜1), epistemic(unresolved|hypothesis|grounded), intent(refer|name_proposal|name_acceptance|feature_assertion|feature_acceptance|denial|correction|acknowledgment), antecedent(先行mentionのidまたはnull)。unresolvedはslots=[]かつconfidence=0、hypothesisは1つ以上の候補、groundedは1候補です。相手の位置ではありません。",
  "feature: slot, feature(160字以内), polarity(confirmed|denied), mentionId。name: slot, name(80字以内), agreement(none|implicit|explicit), mentionIds(1〜8個), replaces(同じ枠の直前nameのidまたはnull)。明示的合意には相手の命名受入れを裏付ける公開mentionが必要で、特徴の受入れを命名の受入れにしないでください。",
  "question: slots, text(200字以内), status(open|deferred|resolved), mentionIds, replaces(更新元questionのidまたはnull)。focus: slot, mode(defer|revisit), mentionId。retract: targetId, mentionId, reason(160字以内)。訂正・否定の公開mentionなしに撤回しないでください。",
  "publicTurnsは公開発話の出典番号一覧です。本文は後続の公開履歴にあり、turnは人間とAIの1往復ごとの番号です。出典のpublicTurnsだけを引用し、今回の未生成のAI応答・未来の発話を出典にしないでください。記憶にある名前や特徴も出典のmentionに結び付け、曖昧な指示語だけで対象や合意を確定しないでください。",
].join("\n");

export function referenceUpdate(graph, turn, operations = []) {
  return { expectedRevision: graph.revision, turn, operations: operations ?? [] };
}
export function stageMemory(graph, turn, operations, publicTurns) {
  return validateReferenceUpdate(graph, referenceUpdate(graph, turn, operations), { publicTurns });
}
export function visibleTurns(history) {
  return history.map(({ role, content }, i) => ({ turn: Math.floor(i / 2) + 1, speaker: role === "user" ? "human" : "ai", text: content }))
    .slice(-REFERENCE_LIMITS.publicTurns);
}
