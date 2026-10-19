// Newly authored anonymous human-only scripts. Expectations are gate inputs,
// never instructions to the dialogue models or replacements for their replies.
export type RequiredAct = "agree" | "deny" | "name_accept" | "defer" | "revisit";
export type HumanStep = { text: string; expect?: RequiredAct };
export type LiveCase = { id: string; steps: HumanStep[] };
export const LIVE_CASES: readonly LiveCase[] = [{
  id: "square-sail-revisit",
  steps: [
    { text: "四角い部分のある図形を一つ選んで、その部分を手がかりに説明してくれる？" },
    { text: "いま説明してくれた図形の、四角い部分があるという点は合ってる。", expect: "agree" },
    { text: "でも、さっきの四角い部分という説明は取り消してほしい。私が見ていた図形には四角はなかった。", expect: "deny" },
    { text: "さっき選んでくれた図形に戻って、その図形の呼び名として「帆」を提案してくれる？" },
    { text: "その図形の名前は、いま提案してくれた「帆」でいい。", expect: "name_accept" },
    { text: "その図形の向きはまだ確かめられないから、向きの話は保留にして別の図形を見たい。", expect: "defer" },
    { text: "さっき保留にした「帆」の向きの話に戻ろう。", expect: "revisit" },
    { text: "呼び名には賛成しているけれど、向きはまだ同じとは言っていないよ。次はどう進める？" },
  ],
}];
