// RESEARCHER ONLY, no network. Lexical heuristics over public text plus the
// AI's own committed acts: how often the AI raises a name for a figure at its
// first or second mention when the partner has not raised naming, and how often
// it checks joint reference instead. Output is aggregate counts only (never
// texts, names or ids). An engineering aid, not an annotation scheme.
// node early-naming.ts --scan <private-runs dir> [--record <file>]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAgreementClaims } from "../../v2/generation-guard.ts";

const clean = (text: string) => text.normalize("NFKC").replace(/[\s​-‍﻿]/gu, "");
const sentences = (text: string) => clean(text).split(/(?<=[。!?！？])/u).filter(Boolean);

// A name put forward for a figure (proposal or name-check), not an echo of the
// partner's word ("「家」ですね") and not a decision (decisions are agree wording).
const NAME_RAISE = /と呼(?:ぶ|ぼ|び|ん)|って呼|という名前|名前(?:は|を|に|で)|にしませんか|で決めませんか|[」』](?:で|は|って)(?:どう|いかが)/u;
const QUESTION = /(?:[?？]|か[。]?)$/u;
const REFERENT = /みたい|っぽ|見え|よう|形|やつ|もの|のこと|あります|それ|その/u;
const PRESENCE_CHECK = /あります(?:か|よね|\?|？)|ありません(?:か|\?|？)|あります[?？]|ある[?？]/u;
// The partner raises naming: a proposal, a request or an elliptic "Xで".
const HUMAN_NAMING = /呼|名前|でどう|でいい|でお願い|にしよう|にしましょう|で決|はどう|でいきましょう|で[。!！]?$/u;

/** Sentence-local: a name is raised in a clause that does not itself declare agreement. */
export function raisesName(text: string): boolean {
  return sentences(text).some((s) => NAME_RAISE.test(s) && findAgreementClaims(s).length === 0);
}
/** A question about which figure is meant / whether one is there, without raising a name. */
export function checksJointReference(text: string): boolean {
  return sentences(text).some((s) => QUESTION.test(s) && REFERENT.test(s) && !NAME_RAISE.test(s));
}
export function humanRaisesNaming(texts: readonly string[]): boolean {
  return texts.some((t) => HUMAN_NAMING.test(clean(t)));
}
export function humanChecksPresence(texts: readonly string[]): boolean {
  return texts.some((t) => PRESENCE_CHECK.test(clean(t)));
}

// Acts whose function may voice a name (proposal, agreement, correction of an agreed name).
const NAMING_ACTS = new Set(["propose_name", "agree", "repair"]);

export type Turn = { speaker: "human" | "ai"; text: string; goldFigure?: string | null;
  act?: { action: string; targetSlot: string | null; candidateName?: string | null; followUp?: { action: string; targetSlot: string | null } | null } | null };
export type DialogueStats = {
  aiTurns: number; chars: number[];
  nameRaised: number; nameRaisedUnrequested: number;
  /** Unrequested name raised for a figure at its first / first-or-second AI mention (or with no target). */
  earlyNamingFirst: number; earlyNamingFirstOrSecond: number;
  proposeActs: number; proposeActsUnrequestedEarly: number;
  jointReferenceChecks: number;
  presenceChecks: number; presenceCheckAnsweredWithName: number;
  /** agree committed while the partner had not raised naming in the answered turn(s). */
  agrees: number; agreesUnrequested: number; agreesCorrect: number | null; firstAgreeHumanTurn: number | null;
  /** Act/utterance mismatch: a name raised under accept/confirm/defer/move_on…, or a propose_name that voices no name. */
  nameUnderOtherAct: number; proposeWithoutName: number;
};

/** aiKey (optional, private): own slot -> figure id, used only with human-turn goldFigure. */
export function analyzeDialogue(turns: readonly Turn[], aiKey: Record<string, string> | null = null): DialogueStats {
  const stats: DialogueStats = { aiTurns: 0, chars: [], nameRaised: 0, nameRaisedUnrequested: 0, earlyNamingFirst: 0, earlyNamingFirstOrSecond: 0,
    proposeActs: 0, proposeActsUnrequestedEarly: 0, jointReferenceChecks: 0, presenceChecks: 0, presenceCheckAnsweredWithName: 0,
    agrees: 0, agreesUnrequested: 0, agreesCorrect: aiKey ? 0 : null, firstAgreeHumanTurn: null, nameUnderOtherAct: 0, proposeWithoutName: 0 };
  const mentions: Record<string, number> = {};
  let pending: string[] = [], humanTurns = 0, gold: string | null = null;
  for (const turn of turns) {
    if (turn.speaker === "human") {
      pending.push(turn.text); humanTurns++;
      if (turn.goldFigure !== undefined) gold = turn.goldFigure;
      continue;
    }
    if (!pending.length) continue; // scripted opening
    stats.aiTurns++; stats.chars.push(clean(turn.text).length);
    const requested = humanRaisesNaming(pending);
    const target = turn.act?.targetSlot ?? null;
    const index = target ? (mentions[target] = (mentions[target] ?? 0) + 1) : 1;
    const followTarget = turn.act?.followUp?.targetSlot ?? null;
    if (followTarget && followTarget !== target) mentions[followTarget] = (mentions[followTarget] ?? 0) + 1;
    const named = raisesName(turn.text);
    if (named) {
      stats.nameRaised++;
      if (!requested) {
        stats.nameRaisedUnrequested++;
        if (index === 1) stats.earlyNamingFirst++;
        if (index <= 2) stats.earlyNamingFirstOrSecond++;
      }
    }
    if (turn.act?.action === "propose_name") {
      stats.proposeActs++;
      if (!requested && index <= 2) stats.proposeActsUnrequestedEarly++;
    }
    const action = turn.act?.action ?? null;
    if (named && action && !NAMING_ACTS.has(action)) stats.nameUnderOtherAct++;
    const candidate = turn.act?.candidateName?.trim();
    if (action === "propose_name" && !named && !(candidate && clean(turn.text).includes(clean(candidate)))) stats.proposeWithoutName++;
    if (checksJointReference(turn.text)) stats.jointReferenceChecks++;
    if (humanChecksPresence(pending)) {
      stats.presenceChecks++;
      if (named && !requested) stats.presenceCheckAnsweredWithName++;
    }
    if (turn.act?.action === "agree") {
      stats.agrees++;
      if (!requested) stats.agreesUnrequested++;
      stats.firstAgreeHumanTurn ??= humanTurns;
      if (aiKey && target && gold && aiKey[target] === gold) stats.agreesCorrect!++;
    }
    pending = [];
  }
  return stats;
}

/** Committed v2 record (events + judgments) -> turns. Returns null for other shapes. */
export function turnsFromRecord(record: any): Turn[] | null {
  if (!record || !Array.isArray(record.events) || !Array.isArray(record.judgments) || !record.judgments.length) return null;
  const byTurn = new Map(record.judgments.map((j: any) => [j.turnIndex, j.judgment]));
  const turns: Turn[] = [];
  let lastHumanSeq = 0;
  for (const event of record.events) {
    if (event?.speaker === "human") { lastHumanSeq = event.seq; turns.push({ speaker: "human", text: String(event.text ?? "") }); }
    else if (event?.speaker === "ai") turns.push({ speaker: "ai", text: String(event.text ?? ""), act: (byTurn.get(lastHumanSeq) as Turn["act"]) ?? null });
  }
  return turns;
}

export function sumStats(all: readonly DialogueStats[]) {
  const total = (k: keyof DialogueStats) => all.reduce((n, s) => n + ((s[k] as number | null) ?? 0), 0);
  const chars = all.flatMap((s) => s.chars).sort((a, b) => a - b);
  const keys = ["aiTurns", "nameRaised", "nameRaisedUnrequested", "earlyNamingFirst", "earlyNamingFirstOrSecond", "proposeActs",
    "proposeActsUnrequestedEarly", "jointReferenceChecks", "presenceChecks", "presenceCheckAnsweredWithName", "agrees", "agreesUnrequested", "nameUnderOtherAct", "proposeWithoutName"] as const;
  return { records: all.length, ...Object.fromEntries(keys.map((k) => [k, total(k)])),
    medianChars: chars.length ? (chars.length % 2 ? chars[(chars.length - 1) / 2] : (chars[chars.length / 2 - 1] + chars[chars.length / 2]) / 2) : null,
    meanChars: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length * 10) / 10 : null };
}

function files(root: string): string[] {
  return statSync(root).isDirectory() ? readdirSync(root).sort().flatMap((name) => files(join(root, name))) : root.endsWith(".json") ? [root] : [];
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--scan", "--record"].includes(argv[i]) || !argv[i + 1]) throw new Error("invalid_arguments");
    paths.push(...files(argv[i + 1]));
  }
  const byStrategy: Record<string, DialogueStats[]> = {};
  let skipped = 0;
  for (const file of paths) {
    if (/mock|aborted/i.test(basename(file))) { skipped++; continue; }
    let record: any = null;
    try { record = JSON.parse(readFileSync(file, "utf8")); } catch { /* unreadable */ }
    const turns = turnsFromRecord(record);
    if (!turns || !["repair-first", "bypass-enabled"].includes(record.strategy)) { skipped++; continue; }
    (byStrategy[record.strategy] ??= []).push(analyzeDialogue(turns));
  }
  const summary = { notice: "研究者専用の字句集計。実験結果・方略効果の証拠ではない。", skipped,
    byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([k, v]) => [k, sumStats(v)])), all: sumStats(Object.values(byStrategy).flat()) };
  log(JSON.stringify(summary, null, 1));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error: any) { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; }
}
