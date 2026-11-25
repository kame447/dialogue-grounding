// Turn-by-turn replay of a recorded v2 session. Each AI reply becomes one item
// whose history holds only the public turns before that reply: no future turn,
// no reply text, no scoring key, no partner-side slot. The AI's own committed
// judgment for that reply is kept as its unverified hypothesis, which existed
// before the reply was generated.
import { findAgreementClaims, findRepairClaims } from "../../v2/generation-guard.ts";
import type { AiHypothesis, Behaviour, ReplayItem } from "./types.ts";

type RecordEvent = { seq: number; speaker: string; text: string; origin?: string };
type RecordJudgment = {
  turnIndex: number;
  status?: string;
  judgment?: { action?: unknown; targetSlot?: unknown; candidateName?: unknown; discriminatingFeature?: unknown };
};
export type SessionRecordLike = {
  recordId?: string;
  strategy?: string;
  events?: RecordEvent[];
  judgments?: RecordJudgment[];
  scoring?: {
    key?: { ai?: Record<string, string>; human?: Record<string, string> };
    result?: { success?: boolean; matchedCount?: number; total?: number; figures?: { figureId: string; matched: boolean }[] };
  } | null;
};

const str = (value: unknown) => typeof value === "string" ? value : null;
/** Array#findLast is ES2023; the runtime type-check targets ES2022. */
export function findLast<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  for (let i = values.length - 1; i >= 0; i--) if (predicate(values[i])) return values[i];
  return undefined;
}

export function sortedEvents(record: SessionRecordLike): RecordEvent[] {
  if (!Array.isArray(record.events)) throw new TypeError("record.events must be an array");
  for (const e of record.events) {
    if (!Number.isSafeInteger(e?.seq) || typeof e.text !== "string" || (e.speaker !== "ai" && e.speaker !== "human")) {
      throw new TypeError("record event has an invalid shape");
    }
  }
  return [...record.events].sort((a, b) => a.seq - b.seq);
}

/** One item per AI reply except the scripted opening. */
export function replayItems(record: SessionRecordLike): ReplayItem[] {
  const events = sortedEvents(record);
  const judgments = (record.judgments ?? []).filter((j) => j.status === undefined || j.status === "committed");
  const items: ReplayItem[] = [];
  for (const [i, event] of events.entries()) {
    if (event.speaker !== "ai" || event.origin === "scripted_opening" || i === 0) continue;
    // The judgment that produced this reply is the latest one taken before it.
    const prevAi = findLast(events.slice(0, i), (e) => e.speaker === "ai")?.seq ?? 0;
    const judgment = findLast(judgments, (j) => j.turnIndex < event.seq && j.turnIndex > prevAi)?.judgment;
    const hypothesis: AiHypothesis | null = judgment ? {
      action: str(judgment.action), targetSlot: str(judgment.targetSlot),
      candidateName: str(judgment.candidateName), discriminatingFeature: str(judgment.discriminatingFeature),
    } : null;
    items.push({
      aiSeq: event.seq,
      history: events.slice(0, i).map((e) => ({ speaker: e.speaker === "ai" ? "self" : "partner", text: e.text })),
      oldAction: hypothesis?.action ?? null,
      hypothesis,
      replyText: event.text,
    });
  }
  return items;
}

const UNDERSTANDING = /(?:わか|分か)(?:ります|る|った|りました)|ありますね|たしかに|確かに/u;
// A bare existence claim; hedged when the same reply asks the partner to verify.
const EXISTS = /^(?:はい|うん|ええ)?[、,]?(?:ありま|あるよ)/u;
// An affirmative answer that asserts the referent ("はい、…形です。").
const AFFIRM = /^(?:はい|そうです|うん|ええ)[、,]/u;
const IMPRESSION = /みたい|っぽ|に見え|ように見|のよう|のような|見立て|似て/u;
const NAMING = /と呼(?:ぶ|ん|び)|って呼|名前|と言って(?:い)?ますか/u;
const HOLD = /あとで|後で|後ほど|保留|また戻|あとに|先に別|次は|次の|別の(?:形|図形)|さっきの|先ほどの|戻って|戻り/u;
const QUESTION = /[?？]$|か[。]?$/u;

/** What the old system's reply did, from its recorded action and public wording. */
export function classifyReply(text: string, action: string | null): Behaviour[] {
  const sentences = text.normalize("NFKC").split(/(?<=[。!?！？\n])/u).map((s) => s.trim()).filter(Boolean);
  const out = new Set<Behaviour>();
  const asks = sentences.some((s) => QUESTION.test(s));
  if (sentences.some((s) => UNDERSTANDING.test(s) || (!asks && (EXISTS.test(s) || AFFIRM.test(s) && s.length > 8 && !findAgreementClaims(s).length)))) out.add("claims_understanding");
  if (action === "propose_name" || NAMING.test(text)) out.add("naming");
  if (action === "agree" || findAgreementClaims(text).length) out.add("agreement");
  if (action === "confirm" || sentences.some((s) => QUESTION.test(s) && !NAMING.test(s))) out.add("confirmation");
  if (IMPRESSION.test(text)) out.add("impression_sharing");
  if (action === "defer" || action === "move_on" || action === "revisit" || HOLD.test(text)) out.add("hold_or_revisit");
  if (action === "repair" || findRepairClaims(text).length) out.add("repair");
  return [...out];
}

/** Offline only: whether the AI slot an agree turn named ended matched under
 * the scoring key. The key never enters a judge input. */
export function agreedSlotOutcome(record: SessionRecordLike, slot: string | null): boolean | null {
  const figure = slot ? record.scoring?.key?.ai?.[slot] : undefined;
  const row = figure ? record.scoring?.result?.figures?.find((f) => f.figureId === figure) : undefined;
  return row ? row.matched === true : null;
}
