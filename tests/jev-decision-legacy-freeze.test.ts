// Literal public synthetic catalog captured from git show 21e9fde64fbb1958ac6dd51edd2730cf2720137a.
// Never regenerate this fixture from the current catalog during a test.
import test from "node:test";
import assert from "node:assert/strict";
import { SYNTHETIC_CASES } from "../dialogue-model/runtime/diagnostics/jev-decision-eval/cases.ts";

const CATALOG_21E9FDE = [
  {
    "id": "continuing-referent",
    "referentScenario": "continuity",
    "steps": [
      {
        "text": "四角と細い棒がつながった形のことなんだけど。"
      },
      {
        "text": "それは棒の先が少し斜めになっている。"
      },
      {
        "text": "うん、その形。もう一方の端は広いよ。"
      }
    ]
  },
  {
    "id": "animal-construal",
    "referentScenario": "construal",
    "steps": [
      {
        "text": "馬にも牛にも見える形がある。細い出っ張りが二つあるやつ。",
        "check": "construal_without_conflict"
      },
      {
        "text": "私には牛っぽい。呼び名はまだ決めなくていいかな。"
      },
      {
        "text": "四角い部分はあるけど、二つの出っ張りは同じ長さじゃない。",
        "check": "partial_agreement",
        "expect": [
          {
            "act": "agree",
            "aspect": "part"
          },
          {
            "act": "deny",
            "aspect": "part"
          }
        ]
      },
      {
        "text": "その形はいったん置いて、細長い方の話をしよう。",
        "expect": [
          {
            "act": "defer"
          }
        ]
      },
      {
        "text": "さっきの牛っぽい形に戻るね。短い出っ張りの方には四角が付いてる。",
        "expect": [
          {
            "act": "revisit"
          }
        ]
      }
    ]
  },
  {
    "id": "two-candidates",
    "referentScenario": "split",
    "steps": [
      {
        "text": "鳥に見えるのが二つあって、まだどっちか分からない。",
        "check": "multiple_candidates"
      },
      {
        "text": "羽みたいな部分が細い方のこと。"
      },
      {
        "text": "『鳥』って呼ぶのはやめたい。もう一つと区別しづらいから。",
        "expect": [
          {
            "act": "name_reject",
            "aspect": "name"
          }
        ]
      },
      {
        "text": "細い方を『つばめ』って呼ぼうか。",
        "expect": [
          {
            "act": "name_propose",
            "aspect": "name"
          }
        ]
      },
      {
        "text": "うん、その名前でいいよ。",
        "expect": [
          {
            "act": "name_accept",
            "aspect": "name"
          }
        ]
      }
    ]
  },
  {
    "id": "repair-information",
    "referentScenario": "repair",
    "steps": [
      {
        "text": "鍵みたいな形の話なんだけど、細い棒の先に広い部分がある。"
      },
      {
        "text": "そこはまだよく分からない。"
      },
      {
        "text": "うーん、さっきと同じところで迷ってる。"
      },
      {
        "text": "広い部分には四角が一つあって、棒とは角でつながってる。",
        "expect": [
          {
            "act": "assert",
            "aspect": "part"
          }
        ]
      },
      {
        "text": "棒の方には四角がない。",
        "expect": [
          {
            "act": "assert",
            "aspect": "part"
          }
        ]
      },
      {
        "text": "『鍵』という名前でよさそう。"
      }
    ]
  },
  {
    "id": "compound-and-shift",
    "referentScenario": "shift",
    "steps": [
      {
        "text": "四角い部分は合ってるけど、三角が上にある形じゃない。"
      },
      {
        "text": "同じ形の下の方に、小さい出っ張りがある。"
      },
      {
        "text": "それはいったん置いて、今度は二つの細い部分が開いた形のこと。"
      },
      {
        "text": "鳥みたいにも見えるけど、名前はまだ決めなくていい。"
      }
    ]
  }
];

test("legacy 21e9fde catalog preserves IDs, order, all public text, expect/check and metadata", () => {
  assert.deepEqual(SYNTHETIC_CASES, CATALOG_21E9FDE);
});
