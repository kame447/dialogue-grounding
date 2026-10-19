// Opt-in research shadow (default off), identical for both strategies: after Luna's
// interpretation is final for a turn, the two-axis grounding-evidence judge runs
// detached from the turn. It never changes the act, the utterance, the ledger,
// the queue or anything a participant sees; its only output is a private record.
import { buildGroundingEvidence, type GroundingAiHypothesis, type GroundingInputGap, type GroundingMemoryEvidence,
  type GroundingNote, type GroundingPriorAct } from "../grounding/evidence.ts";
import { buildMemoryEvidence } from "../grounding/memory-evidence.ts";
import { GROUNDING_CRITERIA_VERSION, parseGroundingVerdict, type GroundingJudge, type GroundingVerdict } from "../grounding/client.ts";

export const GROUNDING_SHADOW_TIMEOUT_MS = 20_000;

export type GroundingShadowOptions = { judge: GroundingJudge; timeoutMs?: number };
export type GroundingShadowInput = {
  events: readonly { seq: number; speaker: string; text: string }[];
  judgment: GroundingAiHypothesis;
  ownLedger: Record<string, GroundingNote>;
  priorAiActs: GroundingPriorAct[];
  turnIndex: number;
  lastEventId: string | null;
  /** Only when reference memory is on; see GroundingEvidenceInput.memoryEvidence. */
  memoryEvidence?: GroundingMemoryEvidence | null;
  /** The committed reference graph before this AI utterance; null/absent when memory is off. Read only. */
  graph?: unknown;
};
export type GroundingShadowRecord = {
  turnIndex: number;
  lastEventId: string | null;
  targetSlot: string | null;
  status: "ok" | "error" | "skipped";
  inputGaps: GroundingInputGap[];
  publicTurns: number | null;
  error: string | null;
  latencyMs: number | null;
  model: string | null;
  // Relative, uncalibrated scores; not the probability of a correct target.
  identification: GroundingVerdict["identification"] | null;
  nameAgreement: GroundingVerdict["nameAgreement"] | null;
  usage: GroundingVerdict["usage"];
  id: string | null;
  /** Criteria the record was judged (or attempted) under; absent on records made before v2. */
  criteriaVersion: typeof GROUNDING_CRITERIA_VERSION;
};

const code = (error: unknown) => {
  const value = (error as { code?: unknown })?.code;
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : "grounding_unavailable";
};

export function validateGroundingShadowOptions(value: unknown): GroundingShadowOptions | null {
  if (value === null || value === undefined) return null;
  const options = value as GroundingShadowOptions;
  const timeoutMs = options?.timeoutMs ?? GROUNDING_SHADOW_TIMEOUT_MS;
  if (typeof options?.judge?.judge !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Invalid grounding shadow options");
  }
  return { judge: options.judge, timeoutMs };
}

/**
 * Starts the shadow judgment without awaiting it. All work, including building
 * the state, happens after the current task; every failure settles as a record.
 */
export function startGroundingShadow(options: GroundingShadowOptions, input: GroundingShadowInput,
  onSettled: (record: GroundingShadowRecord) => void): void {
  const base = { turnIndex: input.turnIndex, lastEventId: input.lastEventId, targetSlot: input.judgment.targetSlot ?? null , criteriaVersion: GROUNDING_CRITERIA_VERSION as typeof GROUNDING_CRITERIA_VERSION };
  const empty = { publicTurns: null, error: null, latencyMs: null, model: null, identification: null, nameAgreement: null, usage: null, id: null };
  const started = performance.now();
  Promise.resolve().then(async (): Promise<GroundingShadowRecord> => {
    let evidence;
    const build = (memoryEvidence: GroundingMemoryEvidence | null | undefined) => buildGroundingEvidence({ events: input.events,
      asOfSeq: input.turnIndex, aiHypothesis: input.judgment, ownNamingNotes: input.ownLedger, priorAiActs: input.priorAiActs, memoryEvidence });
    try {
      // Built here, after the current task, from the pre-turn graph; nothing is written back to memory.
      let memory = input.memoryEvidence;
      let memoryGap = false;
      if (input.graph !== null && input.graph !== undefined) {
        try { memory = buildMemoryEvidence(input.graph, { asOfSeq: input.turnIndex, events: input.events }); }
        catch { memory = null; memoryGap = true; }
      }
      try {
        evidence = build(memory);
        if (memoryGap) evidence.gaps.push("memory_unavailable");
      }
      catch (error) {
        // Unusable memory evidence must not stop the axes: judge without it and record the gap.
        if (code(error) !== "invalid_memory_evidence") throw error;
        evidence = build(null);
        evidence.gaps.push("memory_unavailable");
      }
    } catch (error) {
      return { ...base, ...empty, status: "skipped", inputGaps: [], error: code(error) };
    }
    try {
      // The shadow enforces its own bound too, so a judge that ignores timeoutMs still settles.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raw = await Promise.race([
        options.judge.judge({ purpose: "grounding_jev", state: evidence.state }, { timeoutMs: options.timeoutMs, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("timeout"), { code: "timeout" })); }, options.timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      // Any judge (including injected ones) must return the closed sets; everything else is an error record.
      const verdict = parseGroundingVerdict(raw, "grounding_jev",
        Number.isFinite(raw?.latencyMs) && raw.latencyMs >= 0 ? raw.latencyMs : Math.round(performance.now() - started));
      return { ...base, status: "ok", inputGaps: evidence.gaps, publicTurns: evidence.turns, error: null,
        latencyMs: verdict.latencyMs, model: verdict.model, identification: verdict.identification,
        nameAgreement: verdict.nameAgreement, usage: verdict.usage, id: verdict.id };
    } catch (error) {
      return { ...base, ...empty, status: "error", inputGaps: evidence.gaps, publicTurns: evidence.turns, error: code(error),
        latencyMs: Math.round(performance.now() - started) };
    }
  }).then((record) => onSettled(structuredClone(record))).catch(() => {});
}
