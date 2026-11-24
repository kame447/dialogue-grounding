// A lexical publication guard, not evidence of shared identification. Only the
// validated judgment determines state; detected wording never changes its act.
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

// A clause that says whose screen/viewpoint it describes (こちらの画面では…／私から見ると…) is not a flat claim.
// A bare mention of rotation or a different orientation does not say whose view the direction word belongs to.
const viewpointStated = /(?:こちら|私|わたし|自分|相手|そちら)(?:の(?:画面|側|向き|見方|図形|方)|側)?(?:では|で見ると|から見ると|から見れば|から見たら|から見て)/u;
// Sentence ends and adversative conjunctions start a new clause, so a viewpoint cannot cover a later unqualified claim.
const clauseBreak = /(?<=[。!?]|(?:ですが|ますが|ませんが|ましたが|でしたが|けど|けれど|けれども|のに)、)/u;

/** Orientation-dependent wording in public text; codes only, independent of the act. Clause-local: quoted spans
 * and clauses that state their viewpoint are exempt. */
export function findOrientationLeaks(text: string): string[] {
  const unquoted = normalize(text).replace(/「[^」]*」|『[^』]*』/gu, "「」");
  return unquoted.split(clauseBreak).some((clause) => orientationWords.test(clause) && !viewpointStated.test(clause))
    ? ["orientation_leak"] : [];
}

/** All publication rules for the committed primary act; codes only. */
export function findGuardViolations(text: string, action: Action): string[] {
  return [...(action === "agree" ? [] : findAgreementClaims(text)), ...(action === "repair" ? [] : findRepairClaims(text)),
    ...(action === "defer" || action === "move_on" ? [] : findDeferralClaims(text)), ...findInternalLeaks(text)];
}

const AGREEMENT_CODES = new Set(patterns.map(([code]) => code));
/** Retry instruction for the violated rule families; never echoes the draft. */
export function rewriteReasons(codes: readonly string[]): string {
  return [
    codes.some((code) => AGREEMENT_CODES.has(code)) ? "前の下書きは名称の決定・合意を表していました。決定・合意を表明せず、このactionの範囲で書き直してください。" : "",
    codes.includes("self_repair") ? "前の下書きは自分の取り違え・訂正・取り消しを表していました。このactionでは訂正を表明せず、このactionの範囲で書き直してください。" : "",
    codes.includes("name_mismatch") ? "前の下書きは、このactionで扱う名前とは別の名前を決定・合意として述べていました。このactionで扱う名前だけを「」で示して書き直してください。" : "",
    codes.includes("unsolicited_deferral") ? "前の下書きは未解決の図形について保留や先送りを提案していました。保留・先送りを提案せず、このactionの範囲で書き直してください。" : "",
    codes.includes("orientation_leak") ? "前の下書きに画面の向きに依存する語（上下左右・側・端・向き・斜め上/下/左/右・縦長・横長等）が含まれていました。非公開メモや判断の方位語をそのまま写さず、尖りの数・大小・くぼみ・四角い部分とのつながりなど回転しても変わらない特徴へ言い換えるか、同じ節で「こちらの画面では〜」と視点を明示して書き直してください。" : "",
    codes.some((code) => code.startsWith("internal_")) ? "前の下書きには内部の参照IDや作業メモの項目が含まれていました。それらを出さずに書き直してください。" : "",
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
    if (!safeSpan(judgment.candidateName) || findOrientationLeaks(judgment.candidateName).length) return null;
    const text = `「${judgment.candidateName.trim()}」にしましょう。`;
    return !findGuardViolations(text, "agree").length && !findAgreeNameMismatch(text, judgment.candidateName).length && !findOrientationLeaks(text).length ? text : null;
  }
  if (judgment.action === "propose_name") {
    if (!safeSpan(judgment.candidateName) || findOrientationLeaks(judgment.candidateName).length) return null;
    const text = `「${judgment.candidateName.trim()}」と呼ぶのはどうでしょう？`;
    return !findGuardViolations(text, "propose_name").length && !findOrientationLeaks(text).length ? text : null;
  }
  const text = orientationNeutral[judgment.action];
  return text && !findGuardViolations(text, judgment.action).length && !findOrientationLeaks(text).length ? text : null;
}
