// Mock-only harness for memory-ON multi-turn regression tests. Every human line,
// judge reply and AI utterance below is invented synthetic text; nothing comes
// from real dialogues, annotation workbooks or a live model. No network access.
import { AIConnectionError } from "../../dialogue-model/runtime/client.mjs";
import { createNamingTaskV2 } from "../../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createTrialV2, modelView, participantView } from "../../dialogue-model/runtime/stimuli/scatter-v2.mjs";

export type Message = { role: string; content: unknown };
export type CallOptions = { phase?: string; timeoutMs?: number };
export type Request = { phase: string; messages: Message[]; options: CallOptions; stepIndex: number };
/** A scripted reply: text, or an error code thrown as AIConnectionError (never a real network failure). */
export type Reply = string | { error: string } | { hang: true };
export type Reference = {
  slots: string[]; epistemic: "unresolved" | "hypothesis" | "grounded"; intent: string;
  feature: { slot: string; feature: string; polarity: "confirmed" | "denied" } | null;
  nameAcceptance: { slot: string; name: string } | null; deferSlot: string | null; revisitSlot: string | null;
};
export type Act = { action: string; targetSlot: string | null; candidateName: string | null; discriminatingFeature: string | null;
  note: string | null; followUp?: unknown };
export type Step = {
  human: string;
  act: Act;
  /** Only sent when memory is ON (the memory-less judge prompt never asks for it). */
  reference?: Reference | null;
  reply: string;
  /** Overrides for the judge/generation replies, consumed in call order. */
  judgeReplies?: Reply[];
  generationReplies?: Reply[];
};

export const SEED = 4242;
export const trial = createTrialV2({ seed: SEED });
export const ids: string[] = modelView(trial).anchors.map((anchor: { id: string }) => anchor.id);
export const [A, B, C, D, E, F] = ids;
export const humanIds: string[] = participantView(trial).shapes.map((shape: { id: string }) => shape.id);
export const humanPngBase64: string = Buffer.from(trial.human.png).toString("base64");
export const aiPngBase64: string = Buffer.from(trial.ai.png).toString("base64");

export const act = (action: string, targetSlot: string | null = null, candidateName: string | null = null,
  discriminatingFeature: string | null = null): Act => ({ action, targetSlot, candidateName, discriminatingFeature, note: "synthetic note" });
export const ref = (slots: string[], epistemic: Reference["epistemic"], intent: string, extra: Partial<Reference> = {}): Reference =>
  ({ slots, epistemic, intent, feature: null, nameAcceptance: null, deferSlot: null, revisitSlot: null, ...extra });

/** Text parts only (image data excluded), so token scans never match inside base64. */
export function requestText(request: Request): string {
  return request.messages.map((message) => typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.map((part: { type?: string; text?: string }) => part?.type === "text" ? part.text ?? "" : "").join("\n")
    : "").join("\n");
}
export function requestImages(request: Request): string[] {
  return request.messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((part: { type?: string }) => part?.type === "image_url").map((part: { image_url: { url: string } }) => part.image_url.url) : []);
}

/**
 * Runs a scripted dialogue through the real Luna judge, dialogue-v2 and naming task.
 * Only the upstream chat client is mocked.
 */
export async function createScriptedTrial({ steps, referenceMemory, strategy = "repair-first", restore = null, stepOffset = 0,
  requests = [], records = [] }: { steps: Step[]; referenceMemory: boolean; strategy?: string; restore?: object | null; stepOffset?: number;
  requests?: Request[]; records?: Record<string, any>[] }) {
  let stepIndex = -1;
  const pending = { judge: [] as Reply[], generation: [] as Reply[] };
  let clock = Date.UTC(2026, 9, 19) + stepOffset * 1000;
  const reply = async (value: Reply, signalMs: number | undefined) => {
    if (typeof value === "string") return { text: value, model: "mock-model", usage: null };
    if ("hang" in value) {
      await new Promise((resolve) => setTimeout(resolve, signalMs ?? 10));
      throw new AIConnectionError("timeout");
    }
    // A raw provider message must never reach records or logs; only the code may.
    const error = new AIConnectionError(value.error, value.error === "upstream_error" ? 502 : undefined);
    error.message = "SYNTHETIC-RAW-PROVIDER-MESSAGE";
    throw error;
  };
  const client = {
    async complete(messages: Message[], options: CallOptions = {}) {
      const phase = options.phase ?? "dialogue";
      requests.push({ phase, messages: structuredClone(messages), options: { ...options }, stepIndex: stepOffset + stepIndex });
      const step = steps[stepIndex];
      if (phase === "judgment") {
        const next = pending.judge.shift();
        if (next !== undefined) return reply(next, options.timeoutMs);
        return { text: JSON.stringify({ ...step.act, ...(referenceMemory ? { reference: step.reference ?? null } : {}) }), model: "mock-model" };
      }
      if (phase === "generation") {
        const next = pending.generation.shift();
        if (next !== undefined) return reply(next, options.timeoutMs);
        return { text: step.reply, model: "mock-model" };
      }
      if (phase === "final_submission") return { text: JSON.stringify(Object.fromEntries(ids.map((id) => [id, ""]))), model: "mock-model" };
      throw new Error("unexpected phase " + phase);
    },
  };
  const task = await createNamingTaskV2({ client, strategy, seed: SEED, referenceMemory, runDir: null, restore,
    now: () => (clock += 1000), onPersist: async (record: Record<string, any>) => { records.push(structuredClone(record)); } });
  return {
    task, requests, records,
    /** Sends the next scripted human line and waits until the AI turn settles (or errors). */
    async say(index: number) {
      stepIndex = index;
      const step = steps[index];
      pending.judge = [...(step.judgeReplies ?? [])];
      pending.generation = [...(step.generationReplies ?? [])];
      task.message(step.human, "client-" + (stepOffset + index));
      await task.whenIdle();
      return records.at(-1)!;
    },
    /** Retry after an error, with the given replacement replies. */
    async retry(index: number, overrides: { judgeReplies?: Reply[]; generationReplies?: Reply[] } = {}) {
      stepIndex = index;
      pending.judge = [...(overrides.judgeReplies ?? [])];
      pending.generation = [...(overrides.generationReplies ?? [])];
      await task.retry();
      return records.at(-1)!;
    },
  };
}
