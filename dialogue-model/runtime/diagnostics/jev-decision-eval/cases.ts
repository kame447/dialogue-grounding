// Newly written anonymous human speech. Expectations stay outside model inputs.
import type { LocalAct, LocalAspect } from "../../local-grounding/contract.ts";

export type LocalExpectation = { act: LocalAct; aspect?: LocalAspect };
export type HumanStep = { text: string; expect?: readonly LocalExpectation[];
  check?: "construal_without_conflict" | "partial_agreement" | "multiple_candidates" };
export type SyntheticCase = { id: string; steps: readonly HumanStep[] };

export const SYNTHETIC_CASES: readonly SyntheticCase[] = [
  { id: "animal-construal", steps: [
    { text: "馬にも牛にも見える形がある。細い出っ張りが二つあるやつ。", check: "construal_without_conflict" },
    { text: "私には牛っぽい。呼び名はまだ決めなくていいかな。" },
    { text: "四角い部分はあるけど、二つの出っ張りは同じ長さじゃない。", check: "partial_agreement",
      expect: [{ act: "agree", aspect: "part" }, { act: "deny", aspect: "part" }] },
    { text: "その形はいったん置いて、細長い方の話をしよう。", expect: [{ act: "defer" }] },
    { text: "さっきの牛っぽい形に戻るね。短い出っ張りの方には四角が付いてる。", expect: [{ act: "revisit" }] },
  ] },
  { id: "two-candidates", steps: [
    { text: "鳥に見えるのが二つあって、まだどっちか分からない。", check: "multiple_candidates" },
    { text: "羽みたいな部分が細い方のこと。" },
    { text: "『鳥』って呼ぶのはやめたい。もう一つと区別しづらいから。", expect: [{ act: "name_reject", aspect: "name" }] },
    { text: "細い方を『つばめ』って呼ぼうか。", expect: [{ act: "name_propose", aspect: "name" }] },
    { text: "うん、その名前でいいよ。", expect: [{ act: "name_accept", aspect: "name" }] },
  ] },
  { id: "repair-information", steps: [
    { text: "鍵みたいな形の話なんだけど、細い棒の先に広い部分がある。" },
    { text: "そこはまだよく分からない。" },
    { text: "うーん、さっきと同じところで迷ってる。" },
    { text: "広い部分には四角が一つあって、棒とは角でつながってる。", expect: [{ act: "assert", aspect: "part" }] },
    { text: "棒の方には四角がない。", expect: [{ act: "assert", aspect: "part" }] },
    { text: "『鍵』という名前でよさそう。" },
  ] },
];
