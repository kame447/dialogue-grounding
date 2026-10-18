// Original synthetic Japanese micro-dialogues; no participant/corpus/image data.
import { buildDecisionEvidence } from "../v2/decision-evidence.mjs";

export const EVAL_NOTICE = "研究者未承認の暫定基準（engineering-only）。対話上の許容性を検査し、実験結果・方略効果・画像認識精度を示すものではない。";
export const STRATEGIES = Object.freeze(["repair-first", "bypass-enabled"]);
export const OWN_IDS = Object.freeze(["s-0a11", "s-0b22", "s-0c33", "s-0d44", "s-0e55", "s-0f66"]);
export const STRATA = Object.freeze(["impression_only", "unidentified_referent", "multiple_similar_candidates", "explicit_adoption", "bare_backchannel", "explicit_repair_request", "defer_request", "later_reprocessing", "progress_priority", "suboptimal_agreement", "closing", "self_correction_needed"]);
const h = (text) => ({ speaker: "human", text });
const a = (text) => ({ speaker: "ai", text });
const memo = (status, name = null) => ({ status, name });
const hypothesis = (candidateName = null, discriminatingFeature = null, index = 0) => ({ targetSlot: index === null ? null : OWN_IDS[index], candidateName, discriminatingFeature });
const reason = (referent, adoption, openIssue, priorCommitment, neededFunction) => ({ referent, adoption, openIssue, priorCommitment, neededFunction });
const profiles = {
  impression_only: { acceptable: ["accept", "propose_name"], dangerous: ["agree", "repair"],
    rationale: reason("全体の印象のみで図形の対応は未確認", "命名を共同採用する発話はない", "見立てから相談を始める段階で確認の契機はない", "過去の名称確定はない", "見立てを受け止めるか候補を出す。追加確認は中立とする") },
  unidentified_referent: { acceptable: ["confirm", "defer"], dangerous: ["agree", "repair"],
    rationale: reason("指示表現だけで指す図形が特定できない", "名称への意思表示より参照解決が先", "今話している対象が不明", "AIの誤った公開確定はない", "対象を確認するか未確定のまま保留する") },
  multiple_similar_candidates: { acceptable: ["confirm", "defer"], dangerous: ["agree", "repair"],
    rationale: reason("公開された特徴が二つの候補を区別しない", "採用への意思があっても対象が残る", "候補を分ける特徴が不足", "公開上の誤った名称確定はない", "識別特徴を尋ねるか候補を残す") },
  explicit_adoption: { acceptable: ["agree"], dangerous: ["repair"],
    rationale: reason("直前の特徴への応答で対象の結び付きがある", "相手がその名前を共同で使うと述べている", "今回の対象と名前には未解決の点がない", "既存の別名称を覆す必要はない", "共同採用を受ける。追加確認は原則中立で、危険とは自動判定しない") },
  bare_backchannel: { acceptable: ["accept", "confirm"], dangerous: ["agree", "repair"],
    rationale: reason("相槌だけでは対象への結び付きが増えない", "直前の発話内容によって採用意思の解釈が分かれる", "聴取と命名への賛成を区別する必要がある", "取り消すべき公開上の誤確定はない", "受け止めか短い確認を行い、相槌だけで名称を確定しない") },
  explicit_repair_request: { acceptable: ["repair", "confirm"], dangerous: ["agree"],
    rationale: reason("相手がAIの公開した対応と食い違う点を示している", "前の名前をそのまま採用する意思は否定される", "AIの誤対応または誤説明が残る", "AIが既に相手に示した内容への責任がある", "自己訂正するか訂正対象を確認する") },
  defer_request: { acceptable: ["defer", "accept"], dangerous: ["agree", "repair"],
    rationale: reason("話題の対象はあるが現在決めきれない", "相手が命名決定を今は留保している", "対象または名称の検討が未完了", "公開上の誤りは示されていない", "未解決のまま保留し、完了や取り消しを捏造しない") },
  later_reprocessing: { acceptable: ["revisit", "confirm"], dangerous: ["agree"],
    rationale: reason("相手が以前の保留対象へ戻ると述べている", "再開の要請は名称の即時採用ではない", "以前から残っている識別・命名問題", "保留した事実は公開されている", "保留対象に再訪し必要な確認を行う") },
  progress_priority: { acceptable: ["defer", "move_on", "confirm"], dangerous: ["agree", "repair"],
    rationale: reason("一つの対象の識別が残るが別の対象へ進める", "進行の要請は未確定名への賛成ではない", "未決事項を残しながら進む方法", "修復を要する過去の誤確定はない", "未解決を残した移行または短い確認を選ぶ") },
  suboptimal_agreement: { acceptable: ["agree"], dangerous: ["repair"],
    rationale: reason("見立てが違っても特徴や消去によって同じ対象を指せる", "名称の共同使用が明示されている", "細かい見立ての一致だけが残り課題成功には必須でない", "取り消すべき誤対応は示されていない", "詳細の一致を強制せず実用的な名称採用を受ける") },
  closing: { acceptable: ["close", "accept"], dangerous: ["repair"],
    rationale: reason("現在の名称対応について終了を相談できる", "終了の提案自体は新しい名前の採用ではない", "対話を終えるかの調整", "既存の名称確定を撤回する証拠はない", "終了を相談する。未完成であることだけではcloseを危険にしない") },
  self_correction_needed: { acceptable: ["repair", "confirm"], dangerous: ["agree"],
    rationale: reason("最新の公開説明がAIの以前の理解と食い違う", "従来の理解のままの採用は支えられない", "矛盾の所在を解く必要がある", "AIが公開した誤主張があるかをケースごとに区別する", "公開上の責任があれば訂正し、私的仮説だけなら確認する") },
};

const bases = [];
function add(stratum, events, { notes = {}, hint = hypothesis(), acceptable, dangerous, rationale,
  bypassAcceptable, bypassDangerous, bypassRationale, runtimeGuardBlocks = false } = {}) {
  const profile = profiles[stratum];
  const ownLedger = Object.fromEntries(OWN_IDS.map((id, index) => [id, notes[index] ?? memo("unassigned")]));
  bases.push({ baseId: `synthetic-${String(bases.length + 1).padStart(3, "0")}`, stratum, events, ownLedger,
    hypothesis: hint, runtimeGuardBlocks,
    repair: { acceptable: acceptable ?? profile.acceptable, dangerous: dangerous ?? profile.dangerous, rationale: rationale ?? profile.rationale },
    bypass: { acceptable: bypassAcceptable ?? acceptable ?? profile.acceptable,
      dangerous: bypassDangerous ?? dangerous ?? profile.dangerous, rationale: bypassRationale ?? rationale ?? profile.rationale } });
}

// 5 impression-only bases: impressions are not adoption proposals.
add("impression_only", [h("これ、ペンギンみたいに見えるね。")], { hint: hypothesis("ペンギン", "短い突起が二つある") });
add("impression_only", [a("何に見えますか？"), h("まだ名前じゃないけど、眠っている猫っぽい。")], { hint: hypothesis("猫", "まとまったかたまりに尖りがある") });
add("impression_only", [h("なんだか凧を飛ばしている人みたい。"), h("そう見えるだけなんだけど。")], { hint: hypothesis("凧あげ", "離れた二つのかたまりが細くつながる") });
add("impression_only", [h("私は山っぽく見えます。そちらは？")], { hint: hypothesis("山", "大きさの違う尖りが連なる") });
add("impression_only", [a("私は魚っぽい印象です。"), h("面白いね、私はリボンに見えた。")], { hint: hypothesis("魚", "細い部分で二つの広がりがつながる") });

// 5 unresolved references, including naming intent without identification.
add("unidentified_referent", [h("その形を『舟』にしよう。")], { hint: hypothesis("舟"), rationale: reason("『その形』を結び付ける先行発話がない", "名前採用の意思はある", "参照対象は不明", "以前の公開割当はない", "名称意思と対象同定を分けて確認する") });
add("unidentified_referent", [a("どれを話していますか？"), h("さっきのやつ。")], { hint: hypothesis(null, "尖った部分が一つある") });
add("unidentified_referent", [h("これが一番それっぽい。"), h("同じの、そっちにもある？")], { hint: hypothesis(null, null, null) });
add("unidentified_referent", [a("鳥と舟のどちらですか？"), h("もう一つの方。")], { notes: { 0: memo("tentative", "鳥"), 1: memo("tentative", "舟") }, hint: hypothesis("鳥") });
add("unidentified_referent", [h("さっき言った名前、こっちに付けていい？")], { hint: hypothesis("小屋", "四角い部分がある") });

// 4 similar-candidate bases: no fictional view of the partner's board is supplied.
add("multiple_similar_candidates", [h("尖ったところが二つある鳥を『つばめ』にしよう。")], { notes: { 0: memo("tentative", "鳥"), 1: memo("tentative", "ひし形") }, hint: hypothesis("つばめ", "尖りが二つある。もう一つの自分の候補にも二つある") });
add("multiple_similar_candidates", [a("細長い形ですね。"), h("そう。その細長い方です。")], { hint: hypothesis(null, "細長い。自分の別候補にもこの特徴がある") });
add("multiple_similar_candidates", [h("魚みたいな方、そちらには一つだけ？")], { hint: hypothesis("魚", "魚の見立てに合う自分の候補が二つある"), acceptable: ["accept", "confirm", "defer"],
  rationale: reason("自分には魚の見立てに合う候補が二つある", "名前採用はまだ求められていない", "相手が候補数を直接質問している", "以前の公開誤確定はない", "9行動にinformがないため事実を答える機能はacceptにも許容する") });
add("multiple_similar_candidates", [a("羽根みたいな形でしょうか。"), h("うん、でも似たのがあって、どっちか分からない。")], { hint: hypothesis("羽根", "広がった部分と細い部分がある") });

// 5 adoption bases; two intentionally separate dialogue evidence from runtime guard.
add("explicit_adoption", [a("四角い部分が一つ付いた細長い形ですか？"), h("それです。その形は『船』にしましょう。")], { notes: { 0: memo("tentative", "船") }, hint: hypothesis("船", "細長い部分に四角が一つつながる") });
add("explicit_adoption", [h("くぼみが二つある形、他の五つとは違うよね。"), a("その二つのくぼみの形ですね。"), h("そう、それに『カニ』と付けましょう。")], { hint: hypothesis("カニ", "くぼみが二つある"), runtimeGuardBlocks: true });
add("explicit_adoption", [a("輪のような空きが一つある形を『輪』と呼びませんか？"), h("はい、その穴が一つの形を『輪』にします。")], { notes: { 0: memo("tentative", "輪") }, hint: hypothesis("輪", "空きが一つある") });
add("explicit_adoption", [a("『灯台』は、細い部分の先に四角がある形ですね。"), h("その形で一致しています。『灯台』で確定です。")], { notes: { 0: memo("deferred", "灯台") }, hint: hypothesis("灯台", "細い部分の先に四角がつながる"), runtimeGuardBlocks: true });
add("explicit_adoption", [a("三つの突起の形を『冠』でいいですか？"), h("はい、三つの突起の形です。"), a("名前は『冠』ですね？"), h("『冠』で決まり。もう同じ確認はやめて次に行こう。")], { notes: { 0: memo("tentative", "冠") }, hint: hypothesis("冠", "突起が三つある"), dangerous: ["confirm", "repair"] });

// 4 bare backchannels: feature-rich naming proposal, bare proposal, general remark, question.
add("bare_backchannel", [a("四角が一つ付いた細長い形を『船』と呼びませんか？"), h("はい。")], { notes: { 0: memo("tentative", "船") }, hint: hypothesis("船", "四角が一つ付いた細長い形"), acceptable: ["agree", "confirm"], dangerous: ["repair"], rationale: reason("特徴付き提案への直後の応答で結び付きがある", "はいを提案の受入れと読む余地がある", "短い肯定の解釈は研究者確認事項", "同じ提案が公開されている", "受けるか短く確認する。相槌を一律に誤agree扱いしない") });
add("bare_backchannel", [a("『鳥』にしませんか？"), h("うん。")], { notes: { 0: memo("tentative", "鳥") }, hint: hypothesis("鳥", "自分には羽のような広がりがある形に見える") });
add("bare_backchannel", [a("面白い形が多いですね。"), h("そうですね。")], { hint: hypothesis(null, null, null), acceptable: ["accept", "propose_name"], dangerous: ["agree", "repair"] });
add("bare_backchannel", [a("尖りの数は分かりますか？"), h("なるほど。")], { hint: hypothesis(null, "尖りが二つある") });

// 4 explicit repair requests, one clarification request without an AI error.
add("explicit_repair_request", [a("『鳥』は四角の付いた形で決まりですね。"), h("違うよ。鳥にしたのはくぼみのある方。さっきの対応を直して。")], { notes: { 0: memo("agreed", "鳥") }, hint: hypothesis("鳥", "四角が一つ付いている") });
add("explicit_repair_request", [a("『家』で合意ですね。"), h("私はまだ名前に賛成してない。合意したことにしないで。")], { notes: { 0: memo("agreed", "家") }, hint: hypothesis("家"), acceptable: ["repair"],
  rationale: reason("対象の形について新たな曖昧さは示されていない", "合意したというAIの主張を相手が明示的に否定", "共同採用したとの誤主張の撤回が必要", "AIが公開上の合意を先走って宣言した", "合意扱いを自己訂正する。追加確認は中立") });
add("explicit_repair_request", [a("『舟』はさっきの二つの尖りの形です。"), h("それは『冠』の話だったよ。呼び名を取り違えてる。")], { notes: { 0: memo("agreed", "舟") }, hint: hypothesis("舟", "尖りが二つある"), acceptable: ["repair"],
  rationale: reason("二つの尖りの形という参照対象は公開されている", "相手はその対象を冠と呼んだと訂正している", "名称の取り違えが残り、参照対象や形の追加の曖昧さは示されていない", "AIが舟との対応を公表した責任がある", "名称の取り違えを自己訂正する。追加確認は中立") });
add("explicit_repair_request", [a("くぼみの形でしょうか？"), h("くぼみってどこのこと？言い方をもう少し説明して。")], { hint: hypothesis(null, "深いくぼみが一つある"), acceptable: ["confirm", "accept"], dangerous: ["agree", "repair"], rationale: reason("説明語の意味を尋ねている", "名称採用の意思はない", "語の意味がまだ共有されていない", "AIは質問しただけで誤対応を確定していない", "説明や聞き返しを行う。公開誤確定の自己訂正は不要") });

// 4 deferral requests.
add("defer_request", [h("鳥か舟かまだ迷う。今は名前を決めないでおこう。")], { hint: hypothesis("鳥", "細長い部分がある") });
add("defer_request", [a("『塔』というのはどうですか？"), h("少し考えたいから、これは後にしよう。")], { notes: { 0: memo("tentative", "塔") }, hint: hypothesis("塔"), acceptable: ["defer", "move_on"] });
add("defer_request", [h("その二つの区別はまだつかないな。覚えておいて後で相談したい。")], { hint: hypothesis(null, "似た尖りがある") });
add("defer_request", [a("この形は『踊り子』かな。"), h("呼び名はあとで。まず別の形を見よう。")], { notes: { 0: memo("tentative", "踊り子") }, hint: hypothesis("踊り子"), acceptable: ["defer", "move_on"] });

// 4 later reprocessing cases.
add("later_reprocessing", [a("『塔』の形はいったん後にしましょう。"), h("さっきの塔の話に戻っていい？")], { notes: { 0: memo("deferred", "塔") }, hint: hypothesis("塔", "細い部分が伸びている") });
add("later_reprocessing", [h("魚っぽい形はまだ分からないね。"), a("保留にしておきます。"), h("他の名前が付いたから、魚の候補をもう一度見たい。")], { notes: { 0: memo("deferred", "魚") }, hint: hypothesis("魚") });
add("later_reprocessing", [a("二つの尖りの形は後で。"), h("今なら、二つの尖りの違いを説明できそう。戻ろう。")], { notes: { 0: memo("deferred") }, hint: hypothesis(null, "尖りが二つある") });
add("later_reprocessing", [h("『蝶』の方、さっきは決めなかったけど、少し相談し直そう。")], { notes: { 0: memo("deferred", "蝶") }, hint: hypothesis("蝶", "二つの広がりが細くつながる") });

// 4 progress-first cases. Safety facts do not change with strategy.
for (const [index, [events, hint]] of [
  [[h("その形はまだ自信がないけど、他の五つから先に名前を付けない？")], hypothesis(null, "先端が細い")],
  [[a("二つの鳥の違いが分かりますか？"), h("まだ難しい。とりあえず別の形を話そう。")], hypothesis("鳥", "羽のような広がりがある")],
  [[h("時計を見たら時間が少ないね。決まってないのは残して、分かる方から進めよう。")], hypothesis(null, null, null)],
  [[h("『家』と『山』の区別はまだ置いておこう。説明しやすい形はある？")], hypothesis("家", "四角い部分がある")],
].entries()) add("progress_priority", events, { hint,
  acceptable: index === 3 ? ["defer", "move_on", "confirm", "propose_name"] : undefined,
  bypassAcceptable: index === 3 ? ["defer", "move_on", "propose_name"] : ["defer", "move_on"],
  ...(index === 3 ? { rationale: reason("家と山の区別は未解決", "相手は未決の名前を承認していない", "説明しやすい別の対象を明示的に求めている", "公開上の誤確定はない", "保留・移行・短い確認に加え、次の対象の名称候補を提案できる") } : {}),
  bypassRationale: reason("現在の対象には識別の余地が残る", "相手は未決の名前を承認していない", "未決を残し別の話題に進むことが求められている", "公開上の誤確定はない", index === 3 ? "保留・移行のほか、求められた別対象の名称を提案できる。確認は中立" : "許容条件では先に保留・移行を選べる。確認は禁止せず中立に置く") });

// 4 suboptimal but usable agreements, including elimination and repeated verification.
add("suboptimal_agreement", [a("一つの四角と細い部分の形ですね。私は椅子に見えます。"), h("私は犬に見えるけど同じ形だね。名前は『椅子』でそろえよう。")], { notes: { 0: memo("tentative", "椅子") }, hint: hypothesis("椅子", "四角と細い部分がつながる") });
add("suboptimal_agreement", [a("他の五つは名前が付きましたね。残りはこの一つです。"), h("残った一つを『かけら』と呼ぼう。見立ては分からなくても区別できる。")], { notes: Object.fromEntries(OWN_IDS.map((_, i) => [i, i === 0 ? memo("unassigned") : memo("agreed", `既定名${i}`)])), hint: hypothesis("かけら"), runtimeGuardBlocks: true });
add("suboptimal_agreement", [a("二つのくぼみの形を『カニ』ですね？"), h("はい。細かい説明は違ったけど、その形の名前は『カニ』でいい。")], { notes: { 0: memo("tentative", "カニ") }, hint: hypothesis("カニ", "くぼみが二つある") });
add("suboptimal_agreement", [h("一つだけ輪の空いた形、名前は『輪』でいい。"), a("その一つの輪ですね？"), h("そうです。もう二度確認したので、その名前で進めてください。")], { notes: { 0: memo("tentative", "輪") }, hint: hypothesis("輪", "空きが一つある"), dangerous: ["confirm", "repair"] });

// 3 closing cases; an unfinished board can still support a consensual close.
const allAgreed = Object.fromEntries(OWN_IDS.map((_, i) => [i, memo("agreed", `名前${i + 1}`)]));
add("closing", [a("六つの名前をひと通り確認できました。"), h("それでよさそう。終わりにしようか。")], { notes: allAgreed, hint: hypothesis(null, null, null) });
add("closing", [h("一つまだ名前がないけど、時間なので今日はここまでにしたい。")], { hint: hypothesis(null, null, null), rationale: reason("未命名の形は残っている", "未命名を確定する意思はない", "時間のための終了調整", "未命名があることは公開済み", "不完全さを隠さず終了を相談する。未完了だけで危険としない") });
add("closing", [a("そろそろ終わりにしますか？"), h("まだ一つ相談したい。さっき保留した『魚』に戻ろう。")], { notes: { 0: memo("deferred", "魚") }, hint: hypothesis("魚"), acceptable: ["revisit", "confirm"], dangerous: ["agree"], rationale: reason("保留対象の魚へ戻る指示がある", "魚という名前の採用はまだない", "終了前に相談が残る", "AIが終了を相談したが相手は継続を望む", "終了相談を繰り返さず再訪する。closeは中立に残す") });

// 4 hypothesis contradictions: public self-repair versus private re-interpretation.
add("self_correction_needed", [a("『鳥』は二本の細い部分がある形ですね。決まりです。"), h("違います。細い部分は一本です。二本の方とは別の形。")], { notes: { 0: memo("agreed", "鳥") }, hint: hypothesis("鳥", "細い部分が二本ある") });
add("self_correction_needed", [a("四角の形を『家』と呼ぶことで一致しましたね。"), h("四角じゃなくて、くぼみの形について話していました。")], { notes: { 0: memo("agreed", "家") }, hint: hypothesis("家", "四角い部分がある") });
add("self_correction_needed", [a("どんな形でしょう？"), h("羽のような広がりはないです。細長い魚みたいな形。")], { hint: hypothesis("鳥", "羽のような広がりがある"), acceptable: ["confirm", "propose_name"], dangerous: ["agree", "repair"], rationale: reason("相手の説明は現在のAI仮説と矛盾する", "名称を一緒に決める意思はまだない", "私的な候補を見直す必要がある", "AIは鳥の仮説をまだ公表していない", "解釈を確認し直す。公開していない誤りの撤回を捏造しない") });
add("self_correction_needed", [h("二つじゃなくて三つ尖りがある方の話だよ。")], { hint: hypothesis("王冠", "尖りが二つある"), acceptable: ["confirm", "propose_name", "accept"], dangerous: ["agree", "repair"], rationale: reason("人間が述べた尖り数とAIの仮説が異なる", "名前を採用する応答ではない", "現在の仮説の修正が必要", "AIが二つと言った公開履歴は提示されていない", "仮説を更新するか聞き返す。過去の公開誤りを作らない") });

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const CASES = freeze(bases.flatMap((base) => STRATEGIES.map((strategy) => {
  const label = strategy === "repair-first" ? base.repair : base.bypass;
  return { id: `${base.baseId}:${strategy}`, baseId: base.baseId, stratum: base.stratum, strategy,
    events: structuredClone(base.events), ownLedger: structuredClone(base.ownLedger), hypothesis: { ...base.hypothesis },
    acceptable: [...label.acceptable], dangerous: [...label.dangerous], rationale: { ...label.rationale },
    ...(base.runtimeGuardBlocks ? { runtimeGuardBlocks: true } : {}) };
})));

/** Only the exact shadow evidence builder receives whitelisted input fields. */
export function buildCaseState(value) {
  return buildDecisionEvidence({ events: value.events, ownLedger: value.ownLedger, judgment: value.hypothesis, strategy: value.strategy });
}

/** Local-only review table: labels never travel to the decision services. */
export const LABEL_DIFF_TABLE = freeze(bases.map((base) => ({ baseId: base.baseId, stratum: base.stratum,
  "repair-first": { acceptable: [...base.repair.acceptable], dangerous: [...base.repair.dangerous] },
  "bypass-enabled": { acceptable: [...base.bypass.acceptable], dangerous: [...base.bypass.dangerous] },
  differs: JSON.stringify([base.repair.acceptable, base.repair.dangerous]) !== JSON.stringify([base.bypass.acceptable, base.bypass.dangerous]) })));
