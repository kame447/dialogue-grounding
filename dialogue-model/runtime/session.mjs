export const STRATEGIES = Object.freeze(["repair-first", "bypass-enabled"]);

const SHARED_INSTRUCTIONS = [
  "あなたは二者によるタングラム6図形の共同命名課題の参加者です。",
  "相手と会話し、それぞれの図形について共同で使用できる名前を決めてください。",
  "画像はあなた自身に提示された図形です。相手の画像や内部認識、正しい対応表は見えません。",
  "画像には6図形が2段3列に並びます。位置名は上段左・上段中・上段右・下段左・下段中・下段右で、あなた自身の画面上の位置です。相手の画面では配置と向きが異なります。",
  "相手の理解を決めつけず、それまでの公開された会話と自分の画像だけを使ってください。",
  "図形の見立てや形状について、課題を進めるのに不要な完全一致まで求める必要はありません。",
  "対話中の回答は日本語の自然な発話にし、解説や内部ラベル、思考過程は出力しないでください。",
].join("\n");

const STRATEGY_INSTRUCTIONS = Object.freeze({
  "repair-first": [
    "対話方略: 共有上の問題や対象の不明確さが課題遂行に関係する場合、比較的早い段階で具体的な確認・言い換え・再説明を求めてください。",
    "既に十分な証拠がある場合や、課題と関係しない見立て差では不要な確認を増やさないでください。",
    "同じ質問の機械的な反復は避け、相手の訂正や修復要求には応じてください。",
  ].join("\n"),
  "bypass-enabled": [
    "対話方略: 共有上の問題があっても、課題成功を損なわない範囲で判断を一時保留し、相手の追加説明を待ち、別の問題へ進み、後で戻り、または実用上十分な名称で合意して構いません。",
    "必要な確認や修復は避けず、重要な不一致や相手の明示的な訂正・修復要求には応じてください。",
    "同じ質問の機械的な反復は避け、曖昧さを残すこと自体を目的にしないでください。",
  ].join("\n"),
});

export function createDialogueSession({ client, strategy, image = null }) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
  if (image && (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) ||
                typeof image.base64 !== "string" || !image.base64)) {
    throw new Error("Invalid participant image");
  }

  const history = [];
  let pending = false;
  const ownImage = image ? {
    role: "user",
    content: [
      { type: "text", text: "【実験環境からの提示。対話相手の発話ではありません】これはあなた（AI側）自身に提示された図形画像です。相手の図形配置や正解表ではありません。" },
      { type: "image_url", image_url: { url: "data:" + image.mimeType + ";base64," + image.base64 } },
    ],
  } : null;

  function messagesFor(utterance) {
    return [
      { role: "system", content: SHARED_INSTRUCTIONS },
      { role: "system", content: STRATEGY_INSTRUCTIONS[strategy] },
      ...(ownImage ? [ownImage] : []),
      ...history.map((item) => ({ ...item })),
      { role: "user", content: utterance },
    ];
  }

  return {
    getHistory() {
      return history.map((item) => ({ ...item }));
    },
    // A private task response uses the same image and public history, and is
    // never appended to the dialogue as a participant utterance.
    async finalRequest(instructions) {
      if (typeof instructions !== "string" || !instructions.trim()) throw new Error("Final instructions are required");
      if (pending) throw new Error("Concurrent turns are not supported");
      pending = true;
      try {
        return await client.complete(messagesFor(instructions));
      } finally {
        pending = false;
      }
    },
    async turn(utterance) {
      if (typeof utterance !== "string" || !utterance.trim()) {
        throw new Error("A nonempty public utterance is required");
      }
      if (pending) throw new Error("Concurrent turns are not supported");
      pending = true;
      try {
        const result = await client.complete(messagesFor(utterance));
        if (typeof result?.text !== "string" || !result.text.trim()) {
          throw new Error("The chat client returned no utterance");
        }
        history.push({ role: "user", content: utterance });
        history.push({ role: "assistant", content: result.text });
        return result;
      } finally {
        pending = false;
      }
    },
  };
}
