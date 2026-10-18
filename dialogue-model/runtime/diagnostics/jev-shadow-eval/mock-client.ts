// Deterministic in-process stand-in for the Jev 2-axis judge, used to dry-run
// the comparison plumbing. It reads only the recent public partner turns with
// fixed lexical cues; it is not a model and its verdicts carry no evidential
// weight. Real verdicts come from the grounding judge client (live, opt-in).
import { findLast } from "./replay.ts";
import type { JevAxesClient, JevAxesInput, JevAxesVerdict, NameLevel, TargetLevel } from "./types.ts";

const DENIAL = /違う|ちが[うい]|じゃない|ではない|ない気|ないよ|ないけど|見えない|わからん|わからない|分からない|どれのこと|どれ[?？]|ん[?？]|いや[、 ]/u;
const CONFIRMED = /^(?:そう|それ|うん|はい|合って|同じ|あっ?てる|オッケー|OK|ok|おけ)|そうそう|それそれ|同じ|合ってる|それです|それだ/u;
const NAME_OK = /それでいい|でいい|いいよ|いいね|いいです|オッケー|OK|賛成|決まり|それにしよ|それで/u;
const NAMING = /と呼|って呼|名前|「[^」]{1,20}」/u;

export function mockVerdict(input: JevAxesInput): { target: TargetLevel; name: NameLevel } {
  const turns = input.history;
  if (!turns.length) return { target: "unknown", name: "unknown" };
  const lastPartner = findLast(turns, (t) => t.speaker === "partner")?.text.normalize("NFKC") ?? "";
  const lastSelf = findLast(turns, (t) => t.speaker === "self")?.text.normalize("NFKC") ?? "";
  if (!lastPartner) return { target: "unknown", name: "unknown" };
  const denied = DENIAL.test(lastPartner);
  const target: TargetLevel = denied ? "contradicted" : CONFIRMED.test(lastPartner) && lastSelf ? "supported" : "insufficient";
  const selfNamed = NAMING.test(lastSelf);
  const name: NameLevel = selfNamed && denied ? "not_agreed" : selfNamed && NAME_OK.test(lastPartner) ? "agreed" : "unclear";
  return { target, name };
}

export function createMockJevAxesClient(): JevAxesClient {
  let calls = 0;
  return Object.freeze({
    kind: "mock" as const,
    get calls() { return calls; },
    async judgeAxes(input: JevAxesInput): Promise<JevAxesVerdict> {
      calls += 1;
      return { ...mockVerdict(input), scores: null, model: "mock-lexical", latencyMs: 0, usage: null };
    },
  });
}
