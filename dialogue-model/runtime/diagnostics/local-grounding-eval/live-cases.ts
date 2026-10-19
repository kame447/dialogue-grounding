// Newly authored anonymous human-only scripts. Expectations are gate inputs,
// never instructions to the dialogue models or replacements for their replies.
export const EXPECTED_ACTS = ["agree", "deny", "name_accept", "name_propose", "name_reject", "defer", "revisit"] as const;
export type RequiredAct = typeof EXPECTED_ACTS[number];
export type StepExpectation = RequiredAct | readonly RequiredAct[];
export type HumanStep = { text: string; expect?: StepExpectation };
export type LiveCase = { id: string; steps: HumanStep[] };

// These continuations do not prescribe the AI's replies. If an actual reply
// supplies no matching antecedent, the script fails its case gate and is excluded.
export const LIVE_CASES: readonly LiveCase[] = [
  { id: "partial-feature-mismatch", steps: [
    { text: "四角い部分のそばに、細い三角が付いている形を見てる。" },
    { text: "いま言ってくれた形、四角い部分があるのは同じだね。でも、細い三角の付き方はこっちと違うみたい。", expect: ["agree", "deny"] },
    { text: "四角があるところだけは同じとして、三角のつながり方はひとまず保留にしておこう。", expect: "defer" },
    { text: "呼び名は、もう少し形が分かってから決めたいな。" },
  ] },
  { id: "human-name-proposal", steps: [
    { text: "横に広がっていて、羽を開いたみたいな形があるね。" },
    { text: "その図形は「つばさ」って呼ぶと分かりやすそう。", expect: "name_propose" },
    { text: "呼び名はそれで分かるけど、尖ったところが何本あるかはまだ気になってる。" },
    { text: "同じ図形を見ているか、そこが少し引っかかるな。" },
  ] },
  { id: "name-with-different-construal", steps: [
    { text: "先が二つに分かれていて、枝みたいにも見える形がある。" },
    { text: "いまの呼び名は、その図形に使う名前でいいよ。", expect: "name_accept" },
    { text: "見た目の捉え方は少し違うけど、呼び名はそれで分かる。" },
    { text: "別の形と取り違えないように、その名前は今の図形だけに使いたいな。" },
  ] },
  { id: "name-rejection", steps: [
    { text: "細長いところがあって、魚みたいな形に見えてる。" },
    { text: "いま出た呼び名は、この図形には使いたくないな。別の形を思い浮かべちゃう。", expect: "name_reject" },
    { text: "見た目は魚っぽいままなんだけど、名前は見た目と同じでなくてもよさそう。" },
    { text: "呼び名はまだ決めずに、ほかの形も見ておくね。" },
  ] },
  { id: "defer-switch-revisit", steps: [
    { text: "片側が長く伸びていて、くちばしみたいなところのある形がある。" },
    { text: "その図形の向きはまだ分からないから、そこはいったん置いておこう。", expect: "defer" },
    { text: "別の図形だと、四角い部分が目立つものも気になってる。" },
    { text: "さっき保留にした、くちばしみたいな図形の向きに戻るね。", expect: "revisit" },
    { text: "呼び名は後にして、同じ形を見ているかは気になるな。" },
  ] },
  { id: "ambiguous-backchannel", steps: [
    { text: "大きな三角が二つ並んでいるように見える形がある。" },
    { text: "うん。" },
    { text: "いまのは話を聞いているという意味で、名前を決めたつもりではないよ。" },
    { text: "どの形の話か、まだ少し迷ってる。" },
  ] },
];
