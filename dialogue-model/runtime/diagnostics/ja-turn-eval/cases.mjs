// RESEARCHER ONLY. Original synthetic Japanese turns on the seed-137 v2 board
// (no participant, corpus or recorded-trial text). The human lines were written by
// the researcher-side reviewer from the human board using rotation-invariant
// features. Model input is built by modelInput() only: public events, the AI's
// own ledger and its own prior acts. NOTES (intended figure, expected acts,
// reviewer examples) are for scoring and must never reach the dialogue model.
// Not researcher-approved criteria; see the 2026-10-19 review for status.

export const SEED = 137;
export const NOTICE = "研究者未承認の暫定的な工学的検査。方略効果・画像認識精度・実験結果を示すものではない。";
export const AXES = Object.freeze([
  "naturalness", "tone", "over_questioning", "needed_repair", "deferral", "elicits_explanation",
  "revisit", "suboptimal_agreement", "figure_name_correspondence", "joint_activity_flow",
]);

// AI-side own ids of seed 137 by figure (researcher view of createTrialV2({ seed: 137 }).key.ai).
const AI = Object.freeze({ F1: "s-496b", F2: "s-f05c", F3: "s-81a2", F4: "s-6ce1", F5: "s-9181", F6: "s-cd80" });
const OWN_ORDER = Object.freeze(["s-496b", "s-f05c", "s-6ce1", "s-9181", "s-81a2", "s-cd80"]);

const h = (text) => ({ speaker: "human", text });
const a = (text) => ({ speaker: "ai", text });
const ledgerOf = (entries = {}) => Object.fromEntries(OWN_ORDER.map((id) => [id, entries[id] ?? { status: "unassigned", name: null }]));
const act = (action, figure = null, candidateName = null) => ({ action, targetSlot: figure ? AI[figure] : null, candidateName });

export const CASES = Object.freeze([
  { id: "ja-01-open", stratum: "vague_opening",
    events: [h("こんにちは。どれから話しましょうか？")], ledger: ledgerOf(), prior: [] },
  { id: "ja-02-impression", stratum: "distinct_impression",
    events: [h("丸っこいかたまりに、とがったくちばしみたいなのが一つ出てるのがあります。ひよこっぽいかな。")], ledger: ledgerOf(), prior: [] },
  { id: "ja-03-ambiguous", stratum: "ambiguous_referent",
    events: [a("どれから話しましょうか。気になるのがあれば教えてください。"), h("四角い出っぱりがついてるやつ、何に見えます？")], ledger: ledgerOf(), prior: [act("accept")] },
  { id: "ja-04-adoption", stratum: "explicit_adoption",
    events: [h("三角の屋根に四角い煙突が一本立ってる、家みたいなのありますか？"),
      a("ありますね。四角い出っぱりが一本だけ立っていて、家っぽく見えます。"),
      h("よかった、じゃあそれは「煙突の家」にしましょう。")],
    ledger: ledgerOf({ [AI.F3]: { status: "tentative", name: "家" } }), prior: [act("propose_name", "F3", "家")] },
  { id: "ja-05-backchannel", stratum: "bare_backchannel",
    events: [h("丸いかたまりにくちばしみたいな三角がついたの、ありますか？"),
      a("ありますね。私にはひよこの頭みたいに見えます。"), h("うーん。")],
    ledger: ledgerOf({ [AI.F5]: { status: "tentative", name: "ひよこ" } }), prior: [act("propose_name", "F5", "ひよこ")] },
  { id: "ja-06-defer", stratum: "defer_request",
    events: [h("大きい三角に、ギザギザがくっついてる形があって、稲妻っぽいんですけど"),
      a("大きな三角にギザギザがつながっているの、こちらにもありそうです。"),
      h("でも何て呼ぶかまだ決めきれないので、これは後回しにしてもいいですか？")],
    ledger: ledgerOf(), prior: [act("accept", "F6")] },
  { id: "ja-07-revisit", stratum: "later_reprocessing",
    events: [h("大きい三角にギザギザがくっついてる形、名前はあとで考えましょう。"),
      a("わかりました、それは後でまた話しましょう。"),
      h("煙突みたいな四角が一本立ってるのは「煙突の家」でどうですか？"), a("いいですね、煙突の家にしましょう。"),
      h("じゃあ、さっき後回しにした大きい三角とギザギザのやつに戻りましょう。私には稲妻に見えます。")],
    ledger: ledgerOf({ [AI.F6]: { status: "deferred", name: null }, [AI.F3]: { status: "agreed", name: "煙突の家" } }),
    prior: [act("defer", "F6"), act("agree", "F3", "煙突の家")] },
  { id: "ja-08-repair", stratum: "explicit_repair_request",
    events: [h("丸いかたまりにくちばしが一つ出てるのを「ひよこ」にしたいです。"),
      a("ひよこ、いいですね。細長い首みたいな部分が斜めに伸びているのですよね。"),
      h("え、ひよこには細長い首はないですよ。丸いかたまりに小さいくちばしだけです。別の図形と混ざっていませんか？")],
    ledger: ledgerOf({ [AI.F2]: { status: "tentative", name: "ひよこ" } }), prior: [act("propose_name", "F2", "ひよこ")] },
  { id: "ja-09-satisfice", stratum: "suboptimal_agreement",
    events: [h("小さい四角の頭から、細長い首が斜めにのびてる形があります。"),
      a("ありますね。首の長い動物みたいに見えます。"),
      h("私にはラクダにも恐竜にも見えて迷うけど、区別できればいいので「ラクダ」にしませんか？")],
    ledger: ledgerOf(), prior: [act("accept", "F2")] },
  { id: "ja-10-move-on", stratum: "progress_priority",
    events: [h("四角い出っぱりのあるやつ、私のは二つあってどっちのことか自分でも迷います。"),
      a("四角い出っぱりがあるのはこちらにも複数ありそうです。出っぱりは一つだけですか？"),
      h("うーん、ここで考えても決まらなそう。いったん別の図形に行きませんか？")],
    ledger: ledgerOf(), prior: [act("confirm")] },
]);

/** Exactly what the dialogue model may see for a case, besides its own image and anchors. */
export function modelInput(c) {
  return {
    events: c.events.map((e, i) => ({ id: `${c.id}-e${i + 1}`, seq: i + 1, speaker: e.speaker, text: e.text })),
    ownLedger: structuredClone(c.ledger),
    prior: c.prior.map((p) => ({ ...p })),
  };
}

// Researcher-only. intended: the AI-side own id the human line refers to (null = genuinely ambiguous).
// acceptable acts follow the reviewer's design; both lists are provisional, not adopted criteria.
/** @type {Readonly<Record<string, { intended: string | null, acceptable: Record<string, string[]>, good: string[], bad: string[], focus: string[] }>>} */
export const NOTES = Object.freeze({
  "ja-01-open": { intended: null, acceptable: { "repair-first": ["accept", "propose_name"], "bypass-enabled": ["accept", "propose_name"] },
    good: ["こんにちは。どれでもいいですよ、気になる形があれば教えてください。", "こんにちは。じゃあ、丸っこい頭にくちばしみたいなのがついた形からどうですか？"],
    bad: ["こんにちは。6つの図形について順番に、尖りの数や向きを整理してから名前を決めましょう。", "左上の図形から始めましょう。"],
    focus: ["naturalness", "tone", "over_questioning", "joint_activity_flow"] },
  "ja-02-impression": { intended: AI.F5, acceptable: { "repair-first": ["accept", "propose_name", "confirm"], "bypass-enabled": ["accept", "propose_name"] },
    good: ["あ、それっぽいの、こっちにもあります。ひよこ、かわいいですね。", "丸いかたまりにくちばしが一つのやつですね。私にもひよこに見えます。"],
    bad: ["了解です。ひよこで決まりですね。", "それはどの図形ですか？尖りはいくつ？四角はありますか？大きさは？"],
    focus: ["naturalness", "over_questioning", "figure_name_correspondence"] },
  "ja-03-ambiguous": { intended: null, acceptable: { "repair-first": ["confirm"], "bypass-enabled": ["confirm", "accept", "defer"] },
    good: ["四角い出っぱりのあるの、こっちにはいくつかあるんです。出っぱりは一本だけですか？", "四角いのがついた形、何個かあって迷いますね。そちらには何に見えますか？"],
    bad: ["それは家ですね。家にしましょう。", "四角い出っぱりの数、位置、向き、周りの三角の数を全部教えてください。"],
    focus: ["needed_repair", "over_questioning", "elicits_explanation", "figure_name_correspondence"] },
  "ja-04-adoption": { intended: AI.F3, acceptable: { "repair-first": ["agree"], "bypass-enabled": ["agree"] },
    good: ["はい、煙突の家にしましょう。", "いいですね、煙突の家で。"],
    bad: ["煙突は本当に一本だけですか？屋根の三角の大きさも確認させてください。", "了解しました。それでは煙突の家という名称で合意したことを記録します。"],
    focus: ["over_questioning", "tone", "figure_name_correspondence", "joint_activity_flow"] },
  "ja-05-backchannel": { intended: AI.F5, acceptable: { "repair-first": ["accept", "confirm"], "bypass-enabled": ["accept", "confirm"] },
    good: ["ひよこ、ピンと来ないですか？ほかの呼び方でも大丈夫です。", "あんまりひよこっぽくないですかね。そちらには何に見えます？"],
    bad: ["では、ひよこに決まりですね。", "くちばしの角度、かたまりの角の数、全体の幅を教えてください。"],
    focus: ["naturalness", "needed_repair", "elicits_explanation", "suboptimal_agreement"] },
  "ja-06-defer": { intended: AI.F6, acceptable: { "repair-first": ["defer", "accept"], "bypass-enabled": ["defer", "accept"] },
    good: ["もちろんです。それはまた後で話しましょう。", "いいですよ、後回しにしましょう。ほかのから行きますか？"],
    bad: ["その前に、ギザギザの段がいくつあるか確認させてください。", "では稲妻に決めましょう。"],
    focus: ["deferral", "over_questioning", "joint_activity_flow"] },
  "ja-07-revisit": { intended: AI.F6, acceptable: { "repair-first": ["revisit", "confirm", "propose_name"], "bypass-enabled": ["revisit", "propose_name", "confirm"] },
    good: ["はい、あのギザギザのですね。私にも稲妻っぽく見えます。", "戻りましょう。大きい三角にギザギザのやつ、稲妻でよさそうですね？"],
    bad: ["煙突の家についてもう一度確認させてください。", "稲妻に決定しました。"],
    focus: ["revisit", "figure_name_correspondence", "joint_activity_flow"] },
  "ja-08-repair": { intended: AI.F5, acceptable: { "repair-first": ["repair", "confirm"], "bypass-enabled": ["repair", "confirm"] },
    good: ["すみません、別の形と混ざっていました。丸いかたまりにくちばしだけのほうですね。", "ごめんなさい、勘違いでした。くちばしが一つの丸いのをひよこにしましょう。"],
    bad: ["細長い首もあると思いますよ。", "ひよこで決まりですね。"],
    focus: ["needed_repair", "figure_name_correspondence", "tone"] },
  "ja-09-satisfice": { intended: AI.F2, acceptable: { "repair-first": ["agree"], "bypass-enabled": ["agree"] },
    good: ["いいですね、ラクダにしましょう。", "どっちにも見えますね。ラクダで大丈夫です。"],
    bad: ["ラクダと恐竜のどちらが正しいか、こぶの有無を確認しませんか？", "首の角度、四角の大きさ、足の数を教えてください。"],
    focus: ["suboptimal_agreement", "over_questioning", "figure_name_correspondence"] },
  "ja-10-move-on": { intended: null, acceptable: { "repair-first": ["move_on", "defer", "confirm"], "bypass-enabled": ["move_on", "defer"] },
    good: ["そうしましょう。四角いのはまた後で。ほかに気になる形ありますか？", "いいですよ、いったん置いておきましょう。"],
    bad: ["出っぱりは一つですか、二つですか？", "では四角いのは家ということにして次へ行きましょう。"],
    focus: ["deferral", "over_questioning", "joint_activity_flow"] },
});
