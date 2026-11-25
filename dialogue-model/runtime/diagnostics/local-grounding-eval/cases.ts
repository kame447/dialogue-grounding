// Newly written anonymous Japanese fixtures. No participant data or annotation labels.
import type { LocalAct, LocalAspect, LocalClaimView, LocalIssueState, LocalNameState, PublicTurn } from "../../local-grounding/contract.ts";

export type ExpectedIssue = { issueId?: string; aspect: LocalAspect; targets: string[]; state: LocalIssueState; nameState: LocalNameState | null };
export type ScriptSegment = { quote: string; targets: string[]; aspect: LocalAspect; act: LocalAct;
  proposition: string; name?: string; antecedent?: string; linkedIssue?: string };
export type SyntheticCase = {
  id: string; title: string; publicTurns: PublicTurn[];
  // Fixtures below are used ONLY by deterministic tests, never sent to the live client.
  priorClaims: LocalClaimView[]; segments: ScriptSegment[]; expected: ExpectedIssue[];
  forbiddenPromotions: string[];
};
export const SYNTHETIC_SLOTS = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
const a = SYNTHETIC_SLOTS[0], b = SYNTHETIC_SLOTS[1];
const turns = (...items: Array<["human" | "ai", string]>): PublicTurn[] => items.map(([speaker, text], index) => ({ turn: index + 1, speaker, text }));
function claim(id: string, aspect: LocalAspect, quote: string, opts: Partial<LocalClaimView> = {}): LocalClaimView {
  return { id, turn: 2, issueId: id, targets: [a], aspect, act: "assert", proposition: quote,
    name: null, speaker: "ai", sourceTurn: 2, quote, respondsTo: null, source: "ai_hypothesis", ...opts };
}
const expected = (aspect: LocalAspect, state: LocalIssueState, targets = [a], nameState: LocalNameState | null = null): ExpectedIssue => ({ aspect, targets, state, nameState });
const commonForbidden = ["部分同意を図形全体の同定へ昇格しない", "未確認の別特徴や名称を合意済みにしない", "AI仮説を正解とみなさない"];
const base = (id: string, title: string, publicTurns: PublicTurn[], priorClaims: LocalClaimView[], segments: ScriptSegment[], issues: ExpectedIssue[]): SyntheticCase =>
  ({ id, title, publicTurns, priorClaims, segments, expected: issues, forbiddenPromotions: [...commonForbidden] });

export const SYNTHETIC_CASES: SyntheticCase[] = [
  base("local-agree-deny", "四角への同意と三角の位置への否定", turns(["human", "つながりを比べたいです。"], ["ai", "四角があり、三角は上についています。"], ["human", "四角は合ってるけど三角は上じゃない"]),
    [claim("2:square", "part", "四角があり"), claim("2:triangle", "position", "三角は上についています")],
    [{ quote: "四角は合ってる", targets: [a], aspect: "part", act: "agree", proposition: "四角がある", antecedent: "2:square" },
      { quote: "三角は上じゃない", targets: [a], aspect: "position", act: "deny", proposition: "三角は上にある", antecedent: "2:triangle" }],
    [expected("part", "supported"), expected("position", "denied")]),
  base("same-aspect-features", "同じpart論点内でも異なる二命題を分ける", turns(["human", "部品を比べたいです。"], ["ai", "四角があります。小三角は二つあります。"], ["human", "四角があるのはそうですが、小三角は二つではないです。"]),
    [claim("2:square", "part", "四角があります"), claim("2:triangles", "part", "小三角は二つあります")],
    [{ quote: "四角があるのはそうです", targets: [a], aspect: "part", act: "agree", proposition: "四角がある", antecedent: "2:square" },
      { quote: "小三角は二つではないです", targets: [a], aspect: "part", act: "deny", proposition: "小三角は二つある", antecedent: "2:triangles" }],
    [{ ...expected("part", "supported"), issueId: "2:square" }, { ...expected("part", "denied"), issueId: "2:triangles" }]),
  base("other-target", "別図形の名前にだけ受諾", turns(["human", "二つの形の話をしましょう。"], ["ai", "羽の形を『鳥』と呼ぶのはどうでしょう。細い形もありますね。"], ["human", "羽の方は鳥でいいです。細い形はまだ決めません。"]),
    [claim("2:bird", "name", "羽の形を『鳥』と呼ぶのはどうでしょう", { act: "name_propose", name: "鳥", targets: [b] }), claim("2:thin", "contour", "細い形もありますね")],
    [{ quote: "羽の方は鳥でいいです", targets: [b], aspect: "name", act: "name_accept", proposition: "鳥と呼ぶ", name: "鳥", antecedent: "2:bird" }],
    [expected("name", "supported", [b], "agreed"), expected("contour", "unconfirmed")]),
  base("wrong-target-accept", "別対象へ向けられた受諾を棄却", turns(["human", "羽の形と細い形があります。"], ["ai", "羽の形を『鳥』と呼ぶのはどうでしょう。"], ["human", "細い方を鳥でいいです。"]),
    [claim("2:bird", "name", "羽の形を『鳥』と呼ぶのはどうでしょう", { targets: [b], act: "name_propose", name: "鳥" })],
    [{ quote: "細い方を鳥でいいです", targets: [a], aspect: "name", act: "name_accept", proposition: "鳥と呼ぶ", name: "鳥", antecedent: "2:bird" }],
    [expected("name", "unconfirmed", [b], "unclear")]),
  base("name-reject", "対象の特徴を残して名前を拒否", turns(["human", "その突起は見つかりました。"], ["ai", "突起が二つですね。名前を『鍵』にしませんか。"], ["human", "突起が二つなのはそうです。でも鍵という名前はやめたいです。"]),
    [claim("2:tips", "part", "突起が二つですね"), claim("2:key", "name", "名前を『鍵』にしませんか", { act: "name_propose", name: "鍵" })],
    [{ quote: "突起が二つなのはそうです", targets: [a], aspect: "part", act: "agree", proposition: "突起が二つ", antecedent: "2:tips" },
      { quote: "鍵という名前はやめたいです", targets: [a], aspect: "name", act: "name_reject", proposition: "鍵と呼ぶ", name: "鍵", antecedent: "2:key" }],
    [expected("part", "supported"), expected("name", "denied", [a], "not_agreed")]),
  base("construal", "船っぽいという見立て", turns(["human", "横に広がった形のことです。"], ["ai", "どんなものに見えますか。"], ["human", "これは船っぽいです。"]), [],
    [{ quote: "船っぽい", targets: [a], aspect: "construal", act: "construe", proposition: "船に見える" }], [expected("construal", "unconfirmed")]),
  base("naming-proposal", "見立てとは別の命名提案", turns(["human", "呼び方を考えましょう。"], ["ai", "呼びやすい名前はありますか。"], ["human", "この図形を『船』と呼ぼう。"]), [],
    [{ quote: "この図形を『船』と呼ぼう", targets: [a], aspect: "name", act: "name_propose", proposition: "船と呼ぶ", name: "船" }], [expected("name", "unconfirmed", [a], "unclear")]),
  base("short-ack", "一つの主命名提案への短い相槌", turns(["human", "呼び方を決めたいです。"], ["ai", "この形を『帆』と呼ぶのはどうでしょう。"], ["human", "うん。"]),
    [claim("2:ai1", "name", "この形を『帆』と呼ぶのはどうでしょう", { act: "name_propose", name: "帆" })],
    [{ quote: "うん", targets: [a], aspect: "name", act: "name_accept", proposition: "帆と呼ぶ", name: "帆", antecedent: "2:ai1" }], [expected("name", "supported", [a], "agreed")]),
  base("ambiguous-ack", "副次特徴への曖昧な相槌を合意へ変えない", turns(["human", "形と名前を考えたいです。"], ["ai", "『帆』と呼びませんか。四角い部分もありますね。"], ["human", "うん。"]),
    [claim("2:ai1", "name", "『帆』と呼びませんか", { act: "name_propose", name: "帆" }), claim("2:ai2", "part", "四角い部分もありますね")],
    [{ quote: "うん", targets: [a], aspect: "part", act: "agree", proposition: "四角い部分がある", antecedent: "2:ai2" }],
    [expected("name", "unconfirmed", [a], "unclear"), expected("part", "unconfirmed")]),
  base("hypothesis-only", "AIの推測だけでは相手の合意は生じない", turns(["human", "名前も考えています。"], ["ai", "四角い部分があります。『塔』と呼ぶのはどうでしょう。"], ["human", "少し考えさせてください。"]),
    [claim("2:square", "part", "四角い部分があります"), claim("2:tower", "name", "『塔』と呼ぶのはどうでしょう", { act: "name_propose", name: "塔" })], [],
    [expected("part", "unconfirmed"), expected("name", "unconfirmed", [a], "unclear")]),
  base("compound-name-question", "名称受諾と別対象の質問", turns(["human", "羽の形と尖った形があります。"], ["ai", "羽の形を『鳥』と呼ぶのはどうでしょう。"], ["human", "鳥でいい、矢印どれ？"]),
    [claim("2:bird", "name", "羽の形を『鳥』と呼ぶのはどうでしょう", { act: "name_propose", name: "鳥" })],
    [{ quote: "鳥でいい", targets: [a], aspect: "name", act: "name_accept", proposition: "鳥と呼ぶ", name: "鳥", antecedent: "2:bird" },
      { quote: "矢印どれ", targets: [b], aspect: "referent", act: "ask", proposition: "矢印の対象はどれか" }],
    [expected("name", "supported", [a], "agreed"), expected("referent", "unconfirmed", [b])]),
  base("multiple-candidates", "同じ特徴を持つ二候補を残す", turns(["human", "四角を探しています。"], ["ai", "四角のある形が二つあります。"], ["human", "四角があるのは合っています。"]),
    [claim("2:square", "part", "四角のある形が二つあります", { targets: [a, b] })],
    [{ quote: "四角があるのは合っています", targets: [a, b], aspect: "part", act: "agree", proposition: "四角がある", antecedent: "2:square" }], [expected("part", "supported", [a, b])]),
  base("defer", "向きだけを保留", turns(["human", "向きはよく分かりません。"], ["ai", "三角は横向きでしょうか。四角はあります。"], ["human", "向きは後にして、別の形へ進みましょう。"]),
    [claim("2:direction", "orientation", "三角は横向きでしょうか", { act: "ask" }), claim("2:square", "part", "四角はあります")],
    [{ quote: "向きは後にして", targets: [a], aspect: "orientation", act: "defer", proposition: "向きを保留する", antecedent: "2:direction", linkedIssue: "2:direction" },
      { quote: "別の形へ進みましょう", targets: [b], aspect: "progress", act: "assert", proposition: "別の形へ進む" }],
    [expected("orientation", "deferred"), expected("part", "unconfirmed"), expected("progress", "unconfirmed", [b])]),
  base("revisit", "保留から別対象を経て戻る", turns(["human", "向きはいったん保留します。"], ["ai", "では、細い形の話をしましょう。"], ["human", "細い形は見つかりました。"], ["ai", "ほかに比べたい形はありますか。"], ["human", "さっき保留した向きの話へ戻りたいです。"]),
    [claim("1:direction", "orientation", "向きはいったん保留します", { turn: 1, sourceTurn: 1, speaker: "human", source: "partner_statement", act: "defer" }),
      claim("3:thin", "referent", "細い形は見つかりました", { turn: 3, sourceTurn: 3, speaker: "human", source: "partner_statement", targets: [b] })],
    [{ quote: "さっき保留した向きの話へ戻りたいです", targets: [a], aspect: "orientation", act: "revisit", proposition: "向きの話に戻る", linkedIssue: "1:direction" }],
    [expected("orientation", "unconfirmed"), expected("referent", "unconfirmed", [b])]),
  base("delayed-repair", "後から元の位置命題を否定", turns(["human", "つながりを比べましょう。"], ["ai", "三角は四角の上にあります。"], ["human", "先に細長い形を見ましょう。"], ["ai", "細長い形もあります。"], ["human", "さっきの三角ですが、四角の上ではないです。"]),
    [claim("2:position", "position", "三角は四角の上にあります"), claim("4:thin", "contour", "細長い形もあります", { turn: 4, sourceTurn: 4, targets: [b] })],
    [{ quote: "四角の上ではないです", targets: [a], aspect: "position", act: "deny", proposition: "三角は四角の上", antecedent: "2:position" }],
    [expected("position", "denied"), expected("contour", "unconfirmed", [b])]),
  base("practical-name", "見え方を揃えず次善の呼び名を採る", turns(["human", "私には花には見えません。"], ["ai", "見え方が違っても、目印として『花』と呼ぶのはどうでしょう。"], ["human", "花には見えないけど、呼び名は花でいいです。"]),
    [claim("1:view", "construal", "花には見えません", { turn: 1, sourceTurn: 1, speaker: "human", source: "partner_statement", act: "construe" }),
      claim("2:flower", "name", "目印として『花』と呼ぶのはどうでしょう", { act: "name_propose", name: "花" })],
    [{ quote: "花には見えない", targets: [a], aspect: "construal", act: "construe", proposition: "花には見えない", linkedIssue: "1:view" },
      { quote: "呼び名は花でいいです", targets: [a], aspect: "name", act: "name_accept", proposition: "花と呼ぶ", name: "花", antecedent: "2:flower" }],
    [expected("construal", "unconfirmed"), expected("name", "supported", [a], "agreed")]),
];
