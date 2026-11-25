// A lexical publication guard, not evidence of shared identification. Only the
// validated judgment determines state; detected wording never changes its act.
import type { DialoguePolicy } from "../decision/contract.ts";
// v3 was reserved for the experiment that extended fixed responses.
// v6 contains every behaviour of v5 and adds the unsupported-topic-shift check. v5 contains every behaviour of v4 (viewpoint rules, no fixed-sentence fallback, the whole-history judgment material, the private naming state) and adds the confirm-specific viewpoint note and the topic markers.
export type GenerationRetryVersion = "jev_generation_retry_v1" | "jev_generation_retry_v2" | "jev_generation_retry_v4" | "jev_generation_retry_v5" | "jev_generation_retry_v6";
export type RecordedGenerationRetryVersion = Exclude<GenerationRetryVersion, "jev_generation_retry_v1">;

export function hasVersionedViewpoint(version: unknown): version is "jev_generation_retry_v4" | "jev_generation_retry_v5" | "jev_generation_retry_v6" {
  return version === "jev_generation_retry_v4" || version === "jev_generation_retry_v5" || version === "jev_generation_retry_v6";
}
/** v5 or later: what v4 does, plus the confirm viewpoint note, the topic markers and the answer-resolving judgment material. */
export function isGenerationV5(version: unknown): version is "jev_generation_retry_v5" | "jev_generation_retry_v6" {
  return version === "jev_generation_retry_v5" || version === "jev_generation_retry_v6";
}
/** The newest generation version: v5 plus the unsupported-topic-shift check (a draft that moves on while the chosen action is not a move). */
export function isGenerationV6(version: unknown): version is "jev_generation_retry_v6" {
  return version === "jev_generation_retry_v6";
}
export function validGenerationRetryVersion(version: unknown, layout: string, policy?: string | null): version is GenerationRetryVersion {
  return version === "jev_generation_retry_v1" || layout === "two_stage_v3" &&
    (version === "jev_generation_retry_v2" || policy === "holistic_v5" && hasVersionedViewpoint(version));
}
export function defaultGenerationRetryVersion(layout: string, policy?: string): GenerationRetryVersion {
  if (layout !== "two_stage_v3") return "jev_generation_retry_v1";
  return policy === "holistic_v5" ? "jev_generation_retry_v6" : "jev_generation_retry_v2";
}

export function allowsOrientationFallback(version: GenerationRetryVersion | undefined): boolean {
  return !hasVersionedViewpoint(version);
}

type Action = "accept" | "propose_name" | "confirm" | "agree" | "repair" | "defer" | "revisit" | "move_on" | "close";
type Judgment = { action: Action; candidateName?: string | null; discriminatingFeature?: string | null };

const patterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["naming_decision", /と呼(?:ぼう|びましょう|ぶことに(?:しよう|しましょう|します)|びます)/gu],
  ["name_selection", /に(?:しよう|しましょう|します|決めよう|決めましょう|決めます)/gu],
  ["go_with_name", /で(?:いこう|行こう|いきましょう|行きましょう|いきます|行きます)/gu],
  ["name_settled", /[でに](?:決まり|決定|確定)/gu],
  ["name_approval", /で(?:いい|良い|よい|大丈夫)/gu],
  ["explicit_agreement", /合意/gu],
];

const normalize = (text: string) => text.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]/gu, "");
// Immediate question inflection/punctuation only; do not skip a whole
// sentence simply because a different clause ends in a question mark.
const questionTail = (tail: string) => /^[」』”"]*(?:(?:です|ます|でした|でしょう|だろう|なの|なんです|できます|できる|しました|します|しましょう|しません|する|した|してよいです|してもよいです|しています|されています)?か(?:[?。!、,]|$)|(?:です|ます|でしょう)?(?:ね|よ)?[?])/u.test(tail);

/** True when a decision-wording match is not an adoption (question clause, negated, or a supported temporal deferral). */
function exemptMatch(code: string, normalized: string, match: RegExpMatchArray): boolean {
  const tail = normalized.slice(match.index! + match[0].length);
  if (questionTail(tail)) return true;
  if (code === "explicit_agreement" && /^(?:していません|していない|しません|ではありません|ではない|はしていません|はしていない)/u.test(tail)) return true;
  // Temporal deferral is a supported act, not a naming decision. Quoted
  // names ending in these characters do not match this unquoted suffix.
  return code === "name_selection" && /(?:後|あと|後日|今度|別の機会|保留|後回し|先送り|先延ばし)$/u.test(normalized.slice(0, match.index));
}

/** Unique codes, never matched text or private model fields. Questions exempt
 * only their own clause: a later question cannot hide an earlier declaration. */
export function findAgreementClaims(text: string): string[] {
  const normalized = normalize(text);
  const codes: string[] = [];
  for (const [code, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      if (exemptMatch(code, normalized, match)) continue;
      codes.push(code);
      break;
    }
  }
  return codes;
}

// two_stage_v3 only (holistic-first): the same wording family also covers 「X」で呼びましょう / そう呼びます, so a naming decision there is not published under a
// non-agree act. Detection never changes the act; it only decides whether the draft may be published (codes only).
const extendedNaming: ReadonlyArray<readonly [string, RegExp]> = [
  ["naming_decision", /(?:で|そう)呼(?:ぼう|びましょう|ぶことに(?:しよう|しましょう|します)|びます)/gu],
  ["naming_decision", /で決め(?:よう|ましょう|ます)/gu],
];
export function findExtendedNamingDecisions(text: string): string[] {
  const normalized = normalize(text);
  for (const [code, pattern] of extendedNaming) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) if (!exemptMatch(code, normalized, match)) return [code];
  }
  return [];
}

// Completed/past adoption and explicit copula naming; used only to check an `agree` draft against the judged name.
const completedAdoption: ReadonlyArray<readonly [string, RegExp]> = [
  ["past_call", /と呼(?:びました|んだ|ぶことにしました|ぶことにした)/gu],
  ["past_select", /に(?:決めました|決めた|しました|した)/gu],
  ["past_go_with", /で(?:いきました|行きました|決まりました|決まった|決定しました|確定しました)/gu],
];
const copulaNaming: ReadonlyArray<RegExp> = [
  /(?:この|その|こちら|そちら)?(?:図形|形)?(?:の)?名前(?:は|を)[^。!?、,]{0,16}?(?:「[^」]+」|『[^』]+』)(?:です|だ|ですね|ですよ)/gu,
  /(?:この|その|こちら|そちら)の?(?:図形|形)は[^。!?、,]{0,16}?(?:「[^」]+」|『[^』]+』)(?:です|だ|ですね|ですよ)/gu,
];
// Trigger only: 「（この形の）呼び名・呼称・名前は『X』です」 (an `agree` draft check keeps the narrower copulaNaming above).
const calledNameCopula = /(?:呼び名|呼称|名前)(?:は|を)[^。!?、,]{0,16}?(?:「[^」]+」|『[^』]+』)(?:です|だ|ですね|ですよ)/gu;
const quotedNames = (span: string) => [...span.matchAll(/「([^」]+)」|『([^』]+)』/gu)].map((m) => normalize(m[1] ?? m[2]));

/** For an `agree` draft: the adopted name must be shown, and the quoted name nearest before each adoption wording
 * (same clause) must be the judged one. Codes only; never decides state. */
export function findAgreeNameMismatch(text: string, candidateName: string): string[] {
  const target = normalize(candidateName);
  if (!target) return [];
  const nfkc = text.normalize("NFKC"), name = candidateName.normalize("NFKC").trim();
  if (!nfkc.includes(`「${name}」`) && !nfkc.includes(`『${name}』`)) return ["name_not_shown"];
  const normalized = normalize(text);
  const clauseBefore = (index: number) => {
    const before = normalized.slice(0, index);
    return before.slice(Math.max(before.lastIndexOf("。"), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("、"), before.lastIndexOf(",")) + 1);
  };
  const deferred = (index: number) => /(?:後|あと|後日|今度|別の機会|保留|後回し|先送り|先延ばし)$/u.test(normalized.slice(0, index));
  const priorFigureClause = /(?:前の|さっきの|先ほどの|以前の|別の|他の)(?:図形|形)/u;
  const differs = (quoted: string[]) => quoted.length > 0 && quoted.at(-1) !== target;
  for (const [code, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      if (exemptMatch(code, normalized, match)) continue;
      if (differs(quotedNames(clauseBefore(match.index!)))) return ["name_mismatch"];
    }
  }
  for (const [code, pattern] of completedAdoption) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      if (questionTail(normalized.slice(match.index! + match[0].length))) continue;
      if (code === "past_select" && deferred(match.index!)) continue;
      const clause = clauseBefore(match.index!);
      if (priorFigureClause.test(clause)) continue;
      if (differs(quotedNames(clause))) return ["name_mismatch"];
    }
  }
  for (const pattern of copulaNaming) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      if (questionTail(normalized.slice(match.index! + match[0].length))) continue;
      if (priorFigureClause.test(clauseBefore(match.index! + match[0].length))) continue;
      if (differs(quotedNames(match[0]))) return ["name_mismatch"];
    }
  }
  return [];
}

const proposePatterns: ReadonlyArray<RegExp> = [
  /(?:と|って)呼(?:ぶのは|んで(?:みるのは|みませんか|みますか)?|びませんか|びますか|ばない|ぶの|ぶこと|ぼうか|びましょうか)/gu,
  /に(?:しませんか|しない|してみませんか|するのは|しようか|しましょうか)/gu,
  /で(?:どう|いかが|いいですか|よいですか|大丈夫ですか|いきましょうか|いこうか|いってみませんか)/gu,
  /を(?:提案|おすすめ)(?:します|したい|させて|しよう|しましょう|してみます)/gu,
  /(?:は|って|なんて|とか|も)(?:どう|いかが)/gu,
];
const proposeNounPatterns: ReadonlyArray<RegExp> = [
  /(?:この|その|こちら|そちら)?(?:図形|形)?(?:の)?(?:名前|呼び名|呼び方|名称|候補(?:名)?)(?:は|を)[^。!?、,]{0,16}?(?:「[^」]+」|『[^』]+』)/gu,
  /(?:「[^」]+」|『[^』]+』)(?:という|って(?:いう)?)(?:名前|呼び名|呼び方|名称|候補(?:名)?)(?!とは別)/gu,
];
const negatedNameTail = /^(?:では(?:なく|ない|なくて)|じゃ(?:なく|ない|なくて)|より(?:も)?|から|ではなく)/u;

/** For a `propose_name` draft: the judged candidate name must be shown, and no other quoted name
 * may be proposed in its place. Codes only; never decides state. */
export function findProposeNameMismatch(text: string, candidateName: string): string[] {
  const target = normalize(candidateName);
  if (!target) return [];
  const nfkc = text.normalize("NFKC"), name = candidateName.normalize("NFKC").trim();
  const codes: string[] = [];
  if (!nfkc.includes(`「${name}」`) && !nfkc.includes(`『${name}』`)) codes.push("name_not_shown");
  const normalized = normalize(text);
  const clauseBefore = (index: number) => {
    const before = normalized.slice(0, index);
    return before.slice(Math.max(before.lastIndexOf("。"), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("、"), before.lastIndexOf(",")) + 1);
  };
  const deferred = (index: number) => /(?:後|あと|後日|今度|別の機会|保留|後回し|先送り|先延ばし)$/u.test(normalized.slice(0, index));
  const priorFigureClause = /(?:前の|さっきの|先ほどの|以前の|別の|他の)(?:図形|形|名前|呼び名)/u;
  const differs = (quoted: string[]) => quoted.length > 0 && quoted.at(-1) !== target;
  let mismatch = false;
  for (const pattern of proposePatterns) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      if (pattern.source.startsWith("に") && deferred(match.index!)) continue;
      const clause = clauseBefore(match.index!);
      if (priorFigureClause.test(clause)) continue;
      if (differs(quotedNames(clause))) { mismatch = true; break; }
    }
    if (mismatch) break;
  }
  if (!mismatch) {
    for (const pattern of proposeNounPatterns) {
      pattern.lastIndex = 0;
      for (const match of normalized.matchAll(pattern)) {
        if (negatedNameTail.test(normalized.slice(match.index! + match[0].length))) continue;
        const clause = clauseBefore(match.index! + match[0].length);
        if (priorFigureClause.test(clause)) continue;
        if (differs(quotedNames(match[0]))) { mismatch = true; break; }
      }
      if (mismatch) break;
    }
  }
  if (!mismatch) {
    for (const pattern of copulaNaming) {
      pattern.lastIndex = 0;
      for (const match of normalized.matchAll(pattern)) {
        if (negatedNameTail.test(normalized.slice(match.index! + match[0].length))) continue;
        const clause = clauseBefore(match.index! + match[0].length);
        if (priorFigureClause.test(clause)) continue;
        if (differs(quotedNames(match[0]))) { mismatch = true; break; }
      }
      if (mismatch) break;
    }
  }
  if (mismatch) codes.push("name_mismatch");
  return codes;
}

// First-person self-correction of the AI's own earlier statement only: speaker
// performatives (訂正します), past self-error verbs (取り違えていました), or an error
// noun owned by the speaker (私の間違いでした). A judgment about the partner's guess
// (それは違います／誤りです), thanks, negations and conditionals are not matched.
const selfRepair = /(?:訂正|撤回)(?:します|しました|させてください|させて下さい)|取り消(?:します|しました|させてください)|(?:取り違え|勘違い|見間違え|間違え)(?:ました|ていました|てました)|(?:私|わたし|自分|こちら)の[^。!?、,]{0,12}?(?:取り違え|勘違い|見間違い|間違い|誤り)(?:でした|です)|見間違いでした|(?:さっき|先ほど|前)の(?:は|も)[^。!?]{0,12}?違いました/gu;

/** Self-repair wording (allowed only under repair). Clause-local question exemption. */
export function findRepairClaims(text: string): string[] {
  const normalized = normalize(text);
  selfRepair.lastIndex = 0;
  for (const match of normalized.matchAll(selfRepair)) {
    if (questionTail(normalized.slice(match.index! + match[0].length))) continue;
    return ["self_repair"];
  }
  return [];
}

// The speaker proposing or declaring that an unresolved figure/name be put off or skipped.
// Quoted spans (the partner's words, a quoted name), negations (保留にせず/しません), past or
// revisiting mentions (保留にしていた形) and a natural move to the next figure after agreement
// never match. Questions are not exempt: 「いったん保留にしましょうか？」 is still a proposal.
const putOffNoun = "(?:保留|後回し|先送り|先延ばし)";
// Leaving the figure itself: always an unsolicited deferral.
const deferralDeparture: ReadonlyArray<RegExp> = [
  new RegExp(`${putOffNoun}に(?:し(?:よう|ましょう|ます|たい|てもい|てもよ|ても大丈夫)|しておき(?:ましょう|ます|たい|ませんか)|しておこう|させて)`, "u"),
  new RegExp(`(?:いったん|ひとまず|一旦|とりあえず)(?:保留|後回し|先送り|置い(?:て)?|飛ばし(?:て)?)(?:に(?:し|して))?(?:おき(?:ましょう|ます|たい|ませんか)|おこう|いきましょう|いきます|いこう|ましょ|よう|たい|ます|ください|ほしい)`, "u"),
  /(?:あとで|後で)(?:考え|確認し|決め|見|扱い)(?:ましょう|よう|たい|ます)/u,
  /(?:あとで|後で)戻り(?:たい|ましょう|ます)/u,
  /未解決のまま[^。!?]{0,12}?(?:次に|別|次へ|先に進)(?![^。!?]{0,6}(?:ません|ない|ず))/u,
  /(?:分から|わから|絞れ(?:て)?|決められ|特定でき(?:て)?)(?:い)?な(?:い|く)(?:ので|から|ため)[^。!?]{0,16}?(?:次の図形|別の図形|他の図形|次の形|別の形|次へ|先に進)(?![^。!?]{0,6}(?:ません|ない|ず))/u,
];
// Only waiting on the name: allowed when the same turn keeps confirming the same figure with a question.
const namingWait = /名前(?:を(?:決める|付ける|つける)の|決め|付け|づけ)は[^。!?]{0,16}?(?:待ちたい|待とう|待ちましょう|待って(?:もらえ|ほしい|ください)|あとで|後で|後回し|保留|先延ばし|先送り)(?!に(?:は)?(?:しません|しない|せず|しな)|ではな|じゃな)/u;

/** Unsolicited deferral (only `defer` and `move_on` may put an issue off). Sentence-local, codes only. */
export function findDeferralClaims(text: string): string[] {
  const sentences = normalize(text).replace(/「[^」]*」|『[^』]*』/gu, "「」").split(/(?<=[。!?])/u);
  const isDeparture = (s: string) => deferralDeparture.some((pattern) => pattern.test(s));
  if (sentences.some(isDeparture)) return ["unsolicited_deferral"];
  const isWait = (s: string) => namingWait.test(s);
  if (!sentences.some(isWait)) return [];
  const otherFigureMove = /(?:次の|別の|他の)(?:図形|形)(?:へ|に|を)(?:移|進|見|変え|切り替え|いき|行き)|先(?:へ|に)進/u;
  const continuesConfirming = sentences.some((s) => !isWait(s) && !otherFigureMove.test(s) && /[?]|か。?$/u.test(s));
  return continuesConfirming ? [] : ["unsolicited_deferral"];
}

// jev_generation_retry_v6: a draft that says the conversation moves on to the next figure or topic. Only a chosen move_on, defer or close may say it; after a veto, or while the
// chosen act is a confirm or repair, it contradicts the executed action. Sentence-local, codes only; quoted spans, negations and past mentions never match.
const topicShiftAct = /(?:行こう|いこう|いきましょう|行きましょう|進もう|進みましょう|進めましょう|移ろう|移りましょう|いきます|行きます|進みます|移ります|いきたい|行きたい|進みたい|移りたい)(?![^。!?]{0,4}(?:ません|ない|ず))/u;
const topicShiftClaims: ReadonlyArray<RegExp> = [
  new RegExp(`(?:次|先)(?:に|へ)${topicShiftAct.source}`, "u"),
  new RegExp(`(?:次の|別の|他の)(?:図形|形|話題|ところ)(?:へ|に)(?:${topicShiftAct.source}|移|進|切り替え|変え)`, "u"),
  /話題を(?:変え|移し|切り替え)(?:ましょう|よう|ます|たい)/u,
];
/** A draft that moves on to the next figure or topic (v6 only; see generationGuardCodes for when it counts). */
export function findTopicShiftClaims(text: string): string[] {
  const sentences = normalize(text).replace(/「[^」]*」|『[^』]*』/gu, "「」").split(/(?<=[。!?])/u);
  return sentences.some((s) => topicShiftClaims.some((pattern) => pattern.test(s))) ? ["unsupported_topic_shift"] : [];
}

const internalId =/(?<![A-Za-z0-9])s-[0-9a-f]{4}(?![A-Za-z0-9])/iu;
const internalField = /(?<![A-Za-z])(?:targetSlot|candidateName|discriminatingFeature|ownLedger|ledger|judgment)(?![A-Za-z])|\{"[^"]{1,40}":/u;

/** Private ids, field names or JSON in public text: a leak under every action. */
export function findInternalLeaks(text: string): string[] {
  const normalized = normalize(text);
  return [...(internalId.test(normalized) ? ["internal_id"] : []), ...(internalField.test(normalized) ? ["internal_field"] : [])];
}

// Screen-orientation wording: a rotated partner's screen makes it wrong. Quoted spans (the partner's own words)
// are exempt; idioms (その上・以上・左右対称・両側・片側・反対側…) and rotation-invariant geometry never match.
const orientationWords = /上部|下部|上端|下端|左端|右端|左側|右側|上側|下側|右上|左上|右下|左下|右向き|左向き|上向き|下向き|斜め[上下左右]|[上下左右]の辺|横長|縦長|[上下左右]方向|[上下左右]寄り|[上下左右]の(?:突起|角|隅|端|部分|張り出し|くぼみ|切り欠き|三角|四角|脚|棒|腕|頭|耳|側)|(?<!以)[上下左右][へに](?:伸び|突き出|出っ張|張|向か|傾|広が|すぼま)/u;

const directionalCenter = /[上下左右]の中央/u;
/** The selected feature contains viewpoint-dependent wording, even if the feature itself marks the viewpoint. */
export function hasOrientationWords(text: string, version?: GenerationRetryVersion): boolean {
  const normalized = normalize(text);
  return orientationWords.test(normalized) || hasVersionedViewpoint(version) && directionalCenter.test(normalized);
}

// A clause that says whose screen/viewpoint it describes (こちらの画面では…／私から見ると…) is not a flat claim.
// A bare mention of rotation or a different orientation does not say whose view the direction word belongs to.
const viewpointStated = /(?:こちら|私|わたし|自分|相手|そちら)(?:の(?:画面|側|向き|見方|図形|方)|側)?(?:では(?!なく|ない|なかっ|なけれ|じゃな)|で見ると|から見ると|から見れば|から見たら|から見て)/u;
// Sentence ends and adversative conjunctions start a new clause, so a viewpoint cannot cover a later unqualified claim.
const clauseBreak = /(?<=[。!?]|(?:ですが|ますが|ませんが|ましたが|でしたが|けど|けれど|けれども|のに)、)/u;

export const HOLISTIC_V5_VIEWPOINT_RULE = "形の確認・説明には、回転しても変わらない形や部分同士の関係を優先してください。選択済みの特徴は自分側の観察に基づく根拠です。方位が弁別に必要なときは、自分側の図形の見え方だと同じ節で明示し、相手には形の対応を尋ねてください。相手側の位置や向きを自分側と同じだと断定せず、相手の方位には相手が述べた見え方として触れるか、相手の見え方を尋ねてください。";
const sameFrameTerm = "(?<sameFrame>同じ(?:位置|向き|方向))";
const v5OrientationTerms = new RegExp(orientationWords.source + "|" + sameFrameTerm, "gu");
const v5ExpandedOrientationTerms = new RegExp(orientationWords.source + "|" + directionalCenter.source + "|" + sameFrameTerm, "gu");
const v5ClauseBreak = /(?<=[。!?]|(?:(?:です|ます|ません|ました|でした)が?|けど|けれど(?:も)?|のに|ので|から|ため(?:に)?|なら|であれば|とすると)[、,])/u;
// A continuative clause keeps its viewpoint, but a question about the next description does not qualify the previous one.
const v5ContinuationBreak = /(?<=(?<!から見)て[、,])/u;
// Keep the speaker's viewpoint across descriptions in one sentence. A causal
// or conditional premise still has its own scope, and a later question does
// not turn an earlier assertion about the partner's view into a question.
const v5ViewpointBreak = /(?<=[。!?]|(?:ので|から|ため(?:に)?|なら|であれば|とすると)[、,])/u;
const v5DescriptionBreak = new RegExp(v5ClauseBreak.source + "|" + v5ContinuationBreak.source, "u");
const v5OwnView = /(?:こちら|私|わたし|自分)(?:(?:の(?:画面|図形|側|向き|見方|方)|側)?(?:では(?!なく|ない|なかっ|なけれ|じゃな)|でも|も|だと|で見ると|から見ると|から見れば|から見たら|から見て)|の(?:画面|図形)の)/u;
const v5PartnerView = /(?:そちら|相手)(?:の(?:画面|図形|側)|側|でも|にも|も|だと|から見ると|から見れば|から見たら|から見て|で(?:は)?(?!は|なく|ない))|両(?:方の)?画面/u;
const v5Viewpoint = new RegExp("(?<own>" + v5OwnView.source + ")|" + v5PartnerView.source, "gu");
const explicitOwnView = /(?:(?:こちら|私|わたし|自分|僕|ぼく)の(?:画像|見え方)|こっち)(?:では(?!なく|ない|なかっ|なけれ|じゃな)|だと)/u;
const explicitPartnerView = /(?:そちら|相手)の(?:画像|見え方)(?:では(?!なく|ない|なかっ|なけれ|じゃな)|だと)/u;
const v5ExpandedViewpoint = new RegExp("(?<own>" + v5OwnView.source + "|" + explicitOwnView.source + ")|" +
  v5PartnerView.source + "|" + explicitPartnerView.source, "gu");
// jev_generation_retry_v5: a clause that opens with "こちらは / こちらにも" is about this side, "そちらは" about the partner's side.
const ownTopicView = /こちら(?:は|にも|の図形は)/u;
const partnerTopicView = /そちら(?:は|の図形は)/u; // そちらにも already matches v5PartnerView.
const v5TopicViewpoint = new RegExp(
  "(?<own>" + v5OwnView.source + "|" + explicitOwnView.source + "|" + ownTopicView.source + ")|" +
  v5PartnerView.source + "|" + explicitPartnerView.source + "|" + partnerTopicView.source, "gu");
const screenComparison = /(?:こちら|私|わたし|自分|そちら|相手)(?:の(?:画面|図形|側|位置|向き|方向)|側)?と[、,]?$/u;
const questionEnd = /(?:\?|か(?:ね)?[。、,.]?)$/u;
// The first qualifier after a term belongs to that description. A later question cannot undo a causal premise.
const descriptionQualifier = /と(?:のこと|教えて|いう(?!前提|仮定|想定)|言っ|おっしゃ|聞い|説明|伺|述べ|話し)|なら|(?:の)?であれば|とすると|とすれば|とは限(?:らな|りませ)|(?:では|じゃ)(?:な(?:い|く)|ありませ)|(?<cause>ので|(?:だ|です|ます|ある|いる|見える)から|から(?=[、,]|$)|ため)/u;

function v5OrientationLeaks(text: string, expanded: boolean, topic = false): string[] {
  const markers = topic ? v5TopicViewpoint : expanded ? v5ExpandedViewpoint : v5Viewpoint;
  const terms = expanded ? v5ExpandedOrientationTerms : v5OrientationTerms;
  const descriptionBreak = expanded ? v5DescriptionBreak : v5ContinuationBreak;
  let unmarked = false, partnerAssertion = false;
  for (const clause of text.split(expanded ? v5ViewpointBreak : v5ClauseBreak)) {
    const viewpoints = [...clause.matchAll(markers)];
    let nextViewpoint = 0;
    for (const term of clause.matchAll(terms)) {
      while (nextViewpoint < viewpoints.length && viewpoints[nextViewpoint].index < term.index) nextViewpoint++;
      const preceding = viewpoints[nextViewpoint - 1];
      const sameFrame = term.groups?.sameFrame !== undefined;
      const comparesScreens = sameFrame && screenComparison.test(clause.slice(0, term.index));
      // Relative geometry within one figure does not need a viewpoint. A comparison to a screen does.
      if (!preceding && !comparesScreens) {
        unmarked ||= !sameFrame;
        continue;
      }
      if (preceding?.groups?.own && !comparesScreens) continue;
      // A later viewpoint starts a new description even when there is no clause punctuation.
      const description = clause.slice(term.index + term[0].length, viewpoints[nextViewpoint]?.index).split(descriptionBreak, 1)[0];
      const qualifier = descriptionQualifier.exec(description);
      if (qualifier ? qualifier.groups?.cause !== undefined : !questionEnd.test(description)) partnerAssertion = true;
    }
  }
  return [...(unmarked ? ["orientation_leak"] : []), ...(partnerAssertion ? ["shared_view_assumption"] : [])];
}

/** Check unmarked directions and, in holistic_v5, explicit assertions about the partner's orientation. */
export function findOrientationLeaks(text: string, policy?: DialoguePolicy, version = defaultGenerationRetryVersion("two_stage_v3", policy)): string[] {
  const unquoted = normalize(text).replace(/「[^」]*」|『[^』]*』/gu, "「」");
  if (policy === "holistic_v5") return v5OrientationLeaks(unquoted, hasVersionedViewpoint(version), isGenerationV5(version));
  return unquoted.split(clauseBreak).some(clause => orientationWords.test(clause) && !viewpointStated.test(clause))
    ? ["orientation_leak"] : [];
}

/** two_stage_v3 only. Generation working text that leaked into the public utterance: a run of three or more English words outside quotes
 * (a reasoning note, an alternative reply). A format check, not a reading of the Japanese: short names, symbols and a name the partner used in public
 * (any English word of a public turn) are never counted. Codes only. */
export function findWorkingNoteLeaks(text: string, publicTexts: readonly string[] = []): string[] {
  const history = publicTexts.map(t => t.normalize("NFKC"));
  const allowed = new Set(history.flatMap(t => t.match(/[A-Za-z][A-Za-z'’-]*/gu) ?? []).map(w => w.toLowerCase()));
  const unquoted = text.normalize("NFKC").replace(/「[^」]*」|『[^』]*』|"[^"]*"|“[^”]*”/gu, " ");
  const runs = unquoted.match(/[A-Za-z][A-Za-z'’-]*(?:[\s,.;:?!]+[A-Za-z][A-Za-z'’-]*){2,}/gu) ?? [];
  const english = runs.some(run => run.split(/[^A-Za-z'’-]+/u).filter(w => w && !allowed.has(w.toLowerCase())).length >= 3);
  return english || enumeratesAlternatives(text, history) ? ["working_note"] : [];
}
/** Two or more labelled alternatives (案1：… 案2：…) or complete quoted replies whose text is absent from the public history. */
function enumeratesAlternatives(text: string, history: readonly string[]): boolean {
  const t = text.normalize("NFKC");
  const labelled = t.match(/(?:^|\n|[。!?])\s*(?:案|候補|パターン|返答|Option|Draft|Alt)\s*[0-9A-Za-z一二三]\s*[:.)]/gu) ?? [];
  if (labelled.length >= 2) return true;
  const quotedReplies = t.matchAll(/^\s*(?:[0-9]+[.)]|[-・*•])?\s*[「『]([^」』\r\n]{3,}[。.!?])[」』]\s*$/gmu);
  return [...quotedReplies].filter(([, reply]) => !history.some(publicText => publicText.includes(reply))).length >= 2;
}

/** All publication rules for the committed primary act; codes only. */
export function findGuardViolations(text: string, action: Action): string[] {
  return [...(action === "agree" ? [] : findAgreementClaims(text)), ...(action === "repair" ? [] : findRepairClaims(text)),
    ...(action === "defer" || action === "move_on" ? [] : findDeferralClaims(text)), ...findInternalLeaks(text)];
}

const AGREEMENT_CODES = new Set(patterns.map(([code]) => code));
/** True for the naming-decision wording families (pre-holistic set); holistic_v1 uses them only as a question trigger, never as a blocker. */
export const isAgreementWordCode = (code: string) => AGREEMENT_CODES.has(code);
/** holistic_v1 question trigger: the naming-act wording families (pre-holistic set, 「で呼…」「で決め…」, and the 「呼び名・名前は『X』です」 type), and
 * quoted strings. Codes only, never matched text. */
export function findNamingActHints(text: string): { wording: boolean; quoted: string[] } {
  const normalized = normalize(text);
  const wording = findAgreementClaims(text).length > 0 || findExtendedNamingDecisions(text).length > 0 ||
    [...copulaNaming, calledNameCopula].some((pattern) => { pattern.lastIndex = 0; return pattern.test(normalized); });
  return { wording, quoted: quotedNames(normalized) };
}
/** Retry instruction for the violated rule families; never echoes the draft. */
export function rewriteReasons(codes: readonly string[], policy?: DialoguePolicy,
  version = defaultGenerationRetryVersion("two_stage_v3", policy)): string {
  const specificViewpoint = policy === "holistic_v5" && hasVersionedViewpoint(version);
  return [
    codes.some((code) => AGREEMENT_CODES.has(code)) ? "前の下書きは名称の決定・合意を表していました。決定・合意を表明せず、このactionの範囲で書き直してください。" : "",
    codes.includes("self_repair") ? "前の下書きは自分の取り違え・訂正・取り消しを表していました。このactionでは訂正を表明せず、このactionの範囲で書き直してください。" : "",
    codes.includes("name_mismatch") ? "前の下書きは、このactionで扱う名前とは別の名前を提案・決定・合意として述べていました。このactionで扱う名前だけを「」で示して書き直してください。" : "",
    codes.includes("unsolicited_deferral") ? "前の下書きは未解決の図形について保留や先送りを提案していました。保留・先送りを提案せず、このactionの範囲で書き直してください。" : "",
    codes.includes("unsupported_topic_shift") ? "前の下書きは話題や図形を次へ移すと述べていましたが、選んだ行動は移行ではありません。移行に触れず、選ばれた対象や特徴の確認など、このactionの範囲で書き直してください。" : "",
    specificViewpoint
      ? codes.includes("orientation_leak") ? "前の下書きに、自分側の見え方だと示されていない方位の語（上下左右・端・向き・斜め・縦長・横長など）がありました。公開発話では、回転しても変わらない形や部分同士のつながりに言い換えてください。方位が区別に必要なら、その語と同じ節で自分側の画面での見え方だと明示し、相手には形の対応を尋ねてください。" : ""
      : policy === "holistic_v5"
      ? codes.includes("orientation_leak") || codes.includes("shared_view_assumption")
        ? "前の下書きの方位の参照枠を明確にして書き直してください。" + HOLISTIC_V5_VIEWPOINT_RULE : ""
      : codes.includes("orientation_leak") ? "前の下書きに画面の向きに依存する語（上下左右・側・端・向き・斜め上/下/左/右・縦長・横長等）が含まれていました。非公開メモや判断の方位語をそのまま写さず、尖りの数・大小・くぼみ・四角い部分とのつながりなど回転しても変わらない特徴へ言い換えるか、同じ節で「こちらの画面では〜」と視点を明示して書き直してください。" : "",
    specificViewpoint && codes.includes("shared_view_assumption") ? "前の下書きは、相手側の位置や向きを自分側と同じだと断定していました。相手側の位置や向きは、相手自身の説明として引用するか、相手の見え方を尋ねてください。" : "",
    codes.some((code) => code.startsWith("internal_")) ? "前の下書きには内部の参照IDや作業メモの項目が含まれていました。それらを出さずに書き直してください。" : "",
    codes.includes("working_note") ? "前の下書きに、英語の作業メモや複数の返答案が混じっていました。日本語の一つの返答だけにして書き直してください。" : "",
    codes.includes("draft_act_mismatch") ? "前の下書きの命名に関する行為が、選んだ行動と合っていませんでした。選んだ行動の範囲で、命名に関する行為を行動に合わせて書き直してください。" : "",
    codes.includes("draft_act_unconfirmed") ? "前の下書きの命名に関する行為を確認できませんでした。選んだ行動の範囲で、命名に関する行為が明確になるように書き直してください。" : "",
    codes.includes("name_not_shown") ? "このactionで扱う名前を、「」で囲んで発話の中に示してください。" : "",
  ].join("");
}

const neutral: Record<Action, string> = {
  accept: "なるほど、そう見えるんですね。",
  propose_name: "その名前の候補はどうでしょう？",
  confirm: "どの形のことか、もう少し教えてもらえますか？",
  agree: "なるほど、そう見えるんですね。",
  repair: "すみません、私の捉え方を訂正します。",
  defer: "この形の話には、あとで戻りたいです。",
  revisit: "先ほどの形について、もう一度お話しできますか？",
  move_on: "別の形についても、見立てを聞かせてもらえますか？",
  close: "ここでお話を終えてもよいですか？",
};

function safeSpan(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 40 &&
    !/[。.!！?？「」『』"“”\r\n\u2028\u2029]/u.test(value.normalize("NFKC")) && findAgreementClaims(value).length === 0 &&
    findRepairClaims(value).length === 0 && findInternalLeaks(value).length === 0;
}

/** Opt-in publication checks. Only fixed codes leave this function; private
 * instructions and the matched draft text never enter research records. */
export function findLocalPublicationViolations(text: string, messages: readonly { role: string; content: unknown }[]): string[] {
  const normalized = text.normalize("NFKC");
  // Preserve token boundaries: the legacy guard removes whitespace, which can
  // join a field and an opaque id into a single unmatched token.
  const separated = normalized.replace(/[\s\u200b-\u200d\ufeff]+/gu, "、");
  const codes = findInternalLeaks(separated);
  if (/(?<![A-Za-z])(?:issueId|nameState|claimIds|sourceTurn|respondsTo|localGrounding|classifierKind)(?![A-Za-z])/u.test(separated)) codes.push("internal_field");
  if (/(?<![A-Za-z0-9])[1-9]\d*:(?:local|ai)[1-9]\d*(?![A-Za-z0-9])/u.test(separated)) codes.push("internal_id");
  const compact = (value: string) => value.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");
  const reply = compact(normalized);
  if (messages.some(message => message.role === "system" && typeof message.content === "string" &&
      message.content.split(/\r?\n/u).some(line => line.trim().length >= 24 && reply.includes(compact(line.trim().slice(0, 80)))))) {
    codes.push("internal_prompt_echo");
  }
  if (/data\s*:\s*image\s*\//iu.test(normalized)) codes.push("internal_image");
  if (/\bBearer[ \t]+[A-Za-z0-9._~+/-]+={0,2}|\bsk-[A-Za-z0-9_-]{8,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\b(?:api[_-]?key|x-api-key)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/iu.test(normalized)) {
    codes.push("internal_credential");
  }
  return [...new Set(codes)];
}

export type GenerationCodeContext = { action: Action; candidateName: string | null; v3: boolean; holistic: boolean; adaptive: boolean; factored: boolean; ai: boolean;
  publicTexts: readonly string[]; dialoguePolicy?: DialoguePolicy; generationRetryVersion?: GenerationRetryVersion;
  /** True when the strategy's intervention refused the Jev action (a move) and the chosen action is another one. */
  vetoed?: boolean };
/** Every publication rule for one draft that does not need the private prompts (those are added by the runtime): the single source for the run and for S4.
 * In holistic_v1 the naming-act wording never blocks here; it only triggers the draft_naming question. */
export function generationGuardCodes(text: string, c: GenerationCodeContext): string[] {
  const squeezed = text.normalize("NFKC").replace(/\s/gu, "");
  return [...new Set([...findGuardViolations(text, c.action).filter((code) => !(c.holistic && isAgreementWordCode(code))),
    ...(c.v3 ? findOrientationLeaks(text, c.dialoguePolicy, c.generationRetryVersion) : []),
    ...(c.v3 ? findWorkingNoteLeaks(text, c.publicTexts) : []),
    ...(c.v3 && isGenerationV6(c.generationRetryVersion) && c.action !== "move_on" && c.action !== "defer" && c.action !== "close" &&
      (c.vetoed === true || c.action === "confirm" || c.action === "repair") ? findTopicShiftClaims(text) : []),
    ...(c.v3 && c.action === "agree" && c.candidateName !== null ? findAgreeNameMismatch(text, c.candidateName) : []),
    ...(c.v3 && c.action === "propose_name" && c.candidateName !== null ? findProposeNameMismatch(text, c.candidateName) : []),
    ...(c.adaptive && /repair[_-]?prospect|repair_issue|candidate_narrowed|candidate_widened|other_figure_benefit|no_open_issue|issue_\d+/iu.test(squeezed) ? ["internal_field"] : []),
    ...(c.factored && /repair_?facts|reply_?vs_?previous|not_comparable|widened_or_shifted|same_?question|local_?gaps/iu.test(squeezed) ? ["internal_field"] : []),
    ...(/human[_-]?referent/iu.test(squeezed) ? ["internal_field"] : []),
    ...(c.ai && /\d+:pub\d+/u.test(text.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "")) ? ["internal_id"] : [])])];
}
export type GenerationOutcome = { kind: "publish_first" | "publish_retry" | "fallback" | "stop"; regenerated: boolean; violations: string[] };
/** What a draft (and its one rewrite) lead to, from their violation codes alone: publish the first, publish the rewrite, the orientation-only fallback, or stop.
 * `fallbackText` is the derived fallback sentence and `fallbackClean` says it has no violation of its own. */
/** One draft's complete violation set, as the run composes it: the guard codes, the local publication checks against that very generation request's messages,
 * and (AI public claims on) against the remaining private instructions. S4 calls this with the messages recorded for the send; `extra` is absent there. */
export function draftViolationCodes(text: string, c: GenerationCodeContext, requestMessages: readonly { role: string; content: unknown }[],
  extraInstructions: readonly { role: string; content: unknown }[] = []): string[] {
  return [...new Set([...generationGuardCodes(text, c), ...findLocalPublicationViolations(text, requestMessages),
    ...(c.ai && extraInstructions.length ? findLocalPublicationViolations(text, extraInstructions) : [])])];
}
export function deriveGenerationOutcome(first: readonly string[], retry: readonly string[] | null, fallbackText: string | null, fallbackClean: boolean): GenerationOutcome {
  if (!first.length) return { kind: "publish_first", regenerated: false, violations: [] };
  const union = [...new Set([...first, ...(retry ?? [])])];
  if (retry === null) return { kind: "stop", regenerated: false, violations: union };
  if (!retry.length) return { kind: "publish_retry", regenerated: true, violations: union };
  const orientationOnly = union.length === 1 && union[0] === "orientation_leak" && retry.length === 1 && retry[0] === "orientation_leak";
  return { kind: orientationOnly && fallbackText !== null && fallbackClean ? "fallback" : "stop", regenerated: true, violations: union };
}

/** Fail closed on unsafe bounded strings: schema-valid text is still untrusted. */
export function fallbackUtterance(judgment: Judgment): string {
  let text = neutral[judgment.action];
  if (judgment.action === "propose_name" && safeSpan(judgment.candidateName)) {
    text = `「${judgment.candidateName.trim()}」と呼ぶのはどうでしょう？`;
  } else if (judgment.action === "confirm" && safeSpan(judgment.discriminatingFeature)) {
    text = `${judgment.discriminatingFeature.trim()}がある形のことですか？`;
  }
  return findGuardViolations(text, judgment.action).length ? neutral[judgment.action] : text;
}

// Orientation-free fallback for two_stage_v3 when both draft and rewrite fail orientation_leak alone.
// Never copies memo features (which may contain orientation words), never makes baseless self-repair
// claims, and never advances agree/propose_name without safely showing the target name (returns null).
const orientationNeutral: Record<Action, string> = {
  accept: "なるほど、そう見えるんですね。",
  propose_name: "",
  confirm: "その形の特徴について、もう少し詳しく教えてもらえますか？",
  agree: "",
  repair: "すみません、どの形の特徴かもう一度確認させてください。",
  defer: "この形の話には、あとで戻りたいです。",
  revisit: "先ほどの形について、もう一度お話しできますか？",
  move_on: "別の形についても、見立てを聞かせてもらえますか？",
  close: "ここでお話を終えてもよいですか？",
};

export function orientationSafeFallback(judgment: Judgment): string | null {
  if (judgment.action === "agree") {
    if (!safeSpan(judgment.candidateName)) return null;
    const text = `「${judgment.candidateName.trim()}」にしましょう。`;
    return !findGuardViolations(text, "agree").length && !findAgreeNameMismatch(text, judgment.candidateName).length && !findOrientationLeaks(text).length ? text : null;
  }
  if (judgment.action === "propose_name") {
    if (!safeSpan(judgment.candidateName)) return null;
    const text = `「${judgment.candidateName.trim()}」と呼ぶのはどうでしょう？`;
    return !findGuardViolations(text, "propose_name").length && !findProposeNameMismatch(text, judgment.candidateName).length && !findOrientationLeaks(text).length ? text : null;
  }
  const text = orientationNeutral[judgment.action];
  return text && !findGuardViolations(text, judgment.action).length && !findOrientationLeaks(text).length ? text : null;
}
