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

/** Unique codes, never matched text or private model fields. Questions exempt
 * only their own clause: a later question cannot hide an earlier declaration. */
export function findAgreementClaims(text: string): string[] {
  const normalized = normalize(text);
  const codes: string[] = [];
  for (const [code, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const tail = normalized.slice(match.index! + match[0].length);
      if (questionTail(tail)) continue;
      if (code === "explicit_agreement" && /^(?:していません|していない|しません|ではありません|ではない|はしていません|はしていない)/u.test(tail)) continue;
      // Temporal deferral is a supported act, not a naming decision. Quoted
      // names ending in these characters do not match this unquoted suffix.
      if (code === "name_selection" && /(?:後|あと|後日|今度|別の機会|保留|後回し)$/u.test(normalized.slice(0, match.index))) continue;
      codes.push(code);
      break;
    }
  }
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

const internalId = /(?<![A-Za-z0-9])s-[0-9a-f]{4}(?![A-Za-z0-9])/iu;
const internalField = /(?<![A-Za-z])(?:targetSlot|candidateName|discriminatingFeature|ownLedger|ledger|judgment)(?![A-Za-z])|\{"[^"]{1,40}":/u;

/** Private ids, field names or JSON in public text: a leak under every action. */
export function findInternalLeaks(text: string): string[] {
  const normalized = normalize(text);
  return [...(internalId.test(normalized) ? ["internal_id"] : []), ...(internalField.test(normalized) ? ["internal_field"] : [])];
}

/** All publication rules for the committed primary act; codes only. */
export function findGuardViolations(text: string, action: Action): string[] {
  return [...(action === "agree" ? [] : findAgreementClaims(text)), ...(action === "repair" ? [] : findRepairClaims(text)),
    ...findInternalLeaks(text)];
}

const AGREEMENT_CODES = new Set(patterns.map(([code]) => code));
/** Retry instruction for the violated rule families; never echoes the draft. */
export function rewriteReasons(codes: readonly string[]): string {
  return [
    codes.some((code) => AGREEMENT_CODES.has(code)) ? "前の下書きは名称の決定・合意を表していました。決定・合意を表明せず、このactionの範囲で書き直してください。" : "",
    codes.includes("self_repair") ? "前の下書きは自分の取り違え・訂正・取り消しを表していました。このactionでは訂正を表明せず、このactionの範囲で書き直してください。" : "",
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
