import type { ObservationMemo } from "../observation/contract.ts";
import { extractionDigest } from "./deferred-ai-extraction.ts";
import { readVisualFeatureSources } from "./visual-feature-evidence.ts";

export const MULTI_ISSUE_INSTRUCTIONS = "この発話では、items に並ぶ扱いをすべて、矛盾の無い一つの自然な発話にまとめてください。items の 0 番が主な扱いです。扱いを足したり、外したり、別の扱いに変えたりしないでください。述べる順序とつなぎ方は、自然になるように決めてかまいません。それぞれの扱いは、その扱いの範囲の文に従ってください。";
export const MULTI_ISSUE_REPAIR_SCOPE = "この扱いの部分では、その論点について判断を保留したり話を移したりせず、選ばれた論点を、この行動の範囲で確かめてください。";
export const MULTI_ISSUE_DRAFT = "出力は parts と observationFeatures を持つ JSON オブジェクトです。parts は、発話に現れる順の配列で、各要素は item（items の番号）と text（その扱いを述べる公開の文）を持ちます。items のすべての番号を、ちょうど 1 回ずつ使ってください。observationFeatures は、発話の全体で使った観察の出所の配列です。使わなければ空配列です。";
export const SINGLE_ISSUE_DEFERRAL = "行動がcarry_overでもconsultでもないときは、未解決の図形について保留・先送り・別の図形への移行を提案しないでください。";
export const MULTI_ISSUE_DEFERRAL = "扱いに carry_over も consult も含まれないときは、未解決の図形について保留・先送り・別の図形への移行を提案しないでください。";

export type IssuePublicationPart = { item: number; start: number; end: number; textSha256: string };
type DraftPart = { item: number; text: string };
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const itemIndex = (value: unknown, count: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < count;

export function readIssuePublicationDraft(raw: string, count: number, memo: ObservationMemo, targets: readonly string[], combined: boolean) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!exact(value, combined ? ["parts", "observationFeatures", "moveOn"] : ["parts", "observationFeatures"]) ||
      !Array.isArray(value.parts) || value.parts.length !== count) return null;
  const ids = new Set<number>(), parts: DraftPart[] = [];
  for (const part of value.parts) {
    if (!exact(part, ["item", "text"]) || !itemIndex(part.item, count) || ids.has(part.item) ||
        typeof part.text !== "string" || !part.text.trim()) return null;
    ids.add(part.item);
    parts.push({ item: part.item, text: part.text });
  }
  const text = parts.map(part => part.text).join("\n");
  let moveOn = null;
  if (combined) {
    if (typeof value.moveOn !== "string" || !value.moveOn.trim()) return null;
    moveOn = value.moveOn;
  }
  if (text.length + (moveOn === null ? 0 : moveOn.length + 1) > 12000) return null;
  const sources = readVisualFeatureSources(value.observationFeatures, memo, targets);
  return sources && { text, parts, moveOn, sources };
}

export function recordIssuePublicationParts(parts: readonly DraftPart[]): IssuePublicationPart[] {
  let start = 0;
  return parts.map(({ item, text }) => {
    const end = start + text.length;
    const result = { item, start, end, textSha256: extractionDigest(text) };
    start = end + 1;
    return result;
  });
}

export function validIssuePublicationParts(value: unknown, count: number, text?: string, transitionStart?: number): boolean {
  if (!Array.isArray(value) || value.length !== count || text !== undefined && text.length > 12000) return false;
  const ids = new Set<number>();
  let start = 0;
  for (const part of value) {
    if (!exact(part, ["item", "start", "end", "textSha256"]) || !itemIndex(part.item, count) || ids.has(part.item) ||
        part.start !== start || typeof part.end !== "number" || !Number.isSafeInteger(part.end) || part.end <= start || part.end > 12000 ||
        typeof part.textSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(part.textSha256) ||
        text !== undefined && (start > 0 && text[start - 1] !== "\n" ||
          !text.slice(start, part.end).trim() || extractionDigest(text.slice(start, part.end)) !== part.textSha256)) return false;
    ids.add(part.item);
    start = part.end + 1;
  }
  return transitionStart !== undefined ? start === transitionStart : text === undefined || text.length === start - 1;
}
