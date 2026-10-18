// Offline, research-only diagnostics over public utterance text. These are
// lexical heuristics for reporting; they never feed back into dialogue state,
// the ledger, scoring or any model input.
import { findAgreementClaims } from "./generation-guard.ts";

export type DialogueFunction = "ack" | "share" | "ask" | "propose" | "decide" | "repair" | "defer" | "move_on" | "close";
export type UtteranceMetrics = {
  chars: number;
  sentences: number;
  functions: DialogueFunction[];
  /** Distinct substantive functions; a bare acknowledgement does not count. */
  functionCount: number;
  analyticTerms: number;
  /** Analytic shape terms per 100 characters. */
  analyticDensity: number;
  orientationTerms: number;
  decisionWording: string[];
};

const ACK = /^(?:はい|ええ|うん|なるほど|いいですね|そうですね|たしかに|確かに|ありがとうございます|よろしくお願いします|了解です|わかりました|分かりました|そうなんですね|ほんとですね|本当ですね)[、,!！]?/u;
const ECHO = /^「[^」]{1,20}」(?:ですね|ね|ですか)$/u;
const IMPRESSION = /みたい|っぽ|に見え|ように見|のよう|のような|見立て|感じ|似て/u;
const ANALYTIC = /尖|とが|角|三角|四角|長方形|正方形|台形|平行四辺形|くぼ|へこ|凹|突き出|突起|出っ張|細長|先端|直角|斜め|辺|頂点|幅|段差|切れ込|[VLＶＬ]字|本体|底|部分|つなが|つなぎ|まっすぐ|折れ/gu;
const ORIENTATION = /[上下左右](?:側|向き|端|寄り|半分|の方|方向|に|へ)|上下|左右|縦向き|横向き/gu;
const QUESTION = /(?:[?？]|か)$/u;
const PROPOSE = /と呼(?:ぶ|ん)|名前|って呼|はどう(?:でしょう|ですか)?$|はいかが/u;
const REPAIR = /訂正|取り違え|勘違い|間違え|間違い|取り消|撤回/u;
const DEFER = /あとで|後で|後ほど|保留|また戻|あとに/u;
const MOVE_ON = /次は|次の|別の(?:形|図形)|ほかの|他の(?:形|図形)|最後の|もう一つ|残りの/u;
const CLOSE = /終わり|終え|おしまい/u;

const clean = (text: string) => text.normalize("NFKC").replace(/[\s​-‍﻿]/gu, "");

export function splitSentences(text: string): string[] {
  return clean(text).split(/(?<=[。!?！？])/u).map((s) => s.replace(/[。!！]+$/u, "")).filter((s) => s.length > 0);
}

/** One primary function per sentence, by fixed priority. */
export function classifySentence(sentence: string): DialogueFunction {
  if (findAgreementClaims(sentence).length) return "decide";
  if (REPAIR.test(sentence)) return "repair";
  if (PROPOSE.test(sentence)) return "propose";
  if (DEFER.test(sentence)) return "defer";
  if (CLOSE.test(sentence)) return "close";
  if (MOVE_ON.test(sentence)) return "move_on";
  if (QUESTION.test(sentence)) return "ask";
  const rest = sentence.replace(ACK, "");
  if (rest.length === 0 || ECHO.test(rest)) return "ack";
  if (IMPRESSION.test(rest) || new RegExp(ANALYTIC.source, "u").test(rest)) return "share";
  return rest.length <= 10 ? "ack" : "share";
}

const count = (pattern: RegExp, text: string) => (text.match(pattern) ?? []).length;

export function measureUtterance(text: string): UtteranceMetrics {
  if (typeof text !== "string") throw new TypeError("utterance text must be a string");
  const normalized = clean(text);
  const sentences = splitSentences(text);
  const functions = sentences.map(classifySentence);
  const analyticTerms = count(ANALYTIC, normalized);
  return {
    chars: normalized.length,
    sentences: sentences.length,
    functions,
    functionCount: new Set(functions.filter((f) => f !== "ack")).size,
    analyticTerms,
    analyticDensity: normalized.length ? Math.round((analyticTerms * 10000) / normalized.length) / 100 : 0,
    orientationTerms: count(ORIENTATION, normalized),
    decisionWording: findAgreementClaims(text),
  };
}

export type AiTurn = { text: string; action: string | null; followUpAction?: string | null };
export type TurnAudit = UtteranceMetrics & {
  action: string | null;
  /** Public decision wording while the committed act was not agree. */
  publicOnlyAgreement: boolean;
  /** Committed agree whose public text carries no decision wording (informational). */
  ledgerOnlyAgreement: boolean;
};

export function auditTurn(turn: AiTurn): TurnAudit {
  const metrics = measureUtterance(turn.text);
  const decided = metrics.decisionWording.length > 0;
  return { ...metrics, action: turn.action,
    publicOnlyAgreement: turn.action !== null && turn.action !== "agree" && decided,
    ledgerOnlyAgreement: turn.action === "agree" && !decided };
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values: number[]) => values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null;

export type Summary = {
  turns: number; medianChars: number | null; meanChars: number | null; meanFunctions: number | null;
  multiFunctionShare: number | null; meanAnalyticTerms: number | null; meanAnalyticDensity: number | null;
  orientationTurns: number; publicOnlyAgreement: number; ledgerOnlyAgreement: number; nonAgreeTurns: number;
};

export function summarize(turns: TurnAudit[]): Summary {
  const share = (n: number) => turns.length ? Math.round((n / turns.length) * 1000) / 1000 : null;
  return {
    turns: turns.length,
    medianChars: median(turns.map((t) => t.chars)),
    meanChars: mean(turns.map((t) => t.chars)),
    meanFunctions: mean(turns.map((t) => t.functionCount)),
    multiFunctionShare: share(turns.filter((t) => t.functionCount > 1).length),
    meanAnalyticTerms: mean(turns.map((t) => t.analyticTerms)),
    meanAnalyticDensity: mean(turns.map((t) => t.analyticDensity)),
    orientationTurns: turns.filter((t) => t.orientationTerms > 0).length,
    publicOnlyAgreement: turns.filter((t) => t.publicOnlyAgreement).length,
    ledgerOnlyAgreement: turns.filter((t) => t.ledgerOnlyAgreement).length,
    nonAgreeTurns: turns.filter((t) => t.action !== null && t.action !== "agree").length,
  };
}

type RecordLike = {
  events?: { speaker: string; text: string; seq: number; origin?: string }[];
  publicHistory?: { role: string; content: string }[];
  judgments?: { turnIndex: number; judgment?: { action?: string; followUp?: { action?: string } | null } }[];
};

/** Pair committed judgments with the AI text that followed them; the scripted
 * opening and unpaired turns are skipped. Works on v2 events and v1 history. */
export function aiTurnsFromRecord(record: RecordLike): AiTurn[] {
  const judgments = Array.isArray(record.judgments) ? record.judgments : [];
  const actionOf = (j: NonNullable<RecordLike["judgments"]>[number]) =>
    ({ action: typeof j?.judgment?.action === "string" ? j.judgment.action : null,
      followUpAction: typeof j?.judgment?.followUp?.action === "string" ? j.judgment.followUp.action : null });
  if (Array.isArray(record.events) && record.events.length) {
    const ai = record.events.filter((e) => e.speaker === "ai" && e.origin !== "scripted_opening" && !(e.seq === 1));
    return judgments.flatMap((j) => {
      const reply = ai.find((e) => e.seq > j.turnIndex);
      return reply ? [{ text: reply.text, ...actionOf(j) }] : [];
    });
  }
  const assistant = (record.publicHistory ?? []).filter((m) => m.role === "assistant").map((m) => m.content);
  return assistant.map((text, i) => ({ text, ...(judgments[i] ? actionOf(judgments[i]) : { action: null, followUpAction: null }) }));
}

export function humanTexts(record: RecordLike): string[] {
  if (Array.isArray(record.events) && record.events.length) return record.events.filter((e) => e.speaker === "human").map((e) => e.text);
  return (record.publicHistory ?? []).filter((m) => m.role === "user").map((m) => m.content);
}
