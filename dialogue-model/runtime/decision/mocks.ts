import { deadlineLimit, deadlineValue } from '../v2/research-deadline-options.ts';
import type { ResearchLimits } from '../v2/research-timeouts.ts';
// Synthetic-only action injection; its provenance never claims a real Jev call.
import { buildJevDecisionPayload, JevDecisionError, validateJevDecision } from "./jev-decision.ts";
import type { JevDecision, JevDecisionClient, JevDecisionInput } from "./contract.ts";

type Core = Pick<JevDecision, "action" | "target" | "name" | "feature" | "observe" | "detailFigureIds">;
type Callback = (input: JevDecisionInput, options: { signal: AbortSignal; timeoutMs: number; callIndex: number }) => Core | Promise<Core>;
export function createMockJevDecisionClient(fn: Callback, { delayMs = 0, timeoutMs = 15000, researchLimits }: { delayMs?: number; timeoutMs?: number; researchLimits?: ResearchLimits } = {}): JevDecisionClient & {
  readonly metadata: Readonly<{ decisionKind: "mock"; calibrated: false }>; readonly callCount: number;
} {
  const limit = deadlineLimit(researchLimits);
  if (typeof fn !== "function" || !Number.isSafeInteger(delayMs) || delayMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limit) {
    throw new JevDecisionError("invalid_options");
  }
  let count = 0;
  return Object.freeze({
    metadata: Object.freeze({ decisionKind: "mock" as const, calibrated: false as const }),
    get callCount() { return count; },
    async decide(input, options = {}) {
      const started = performance.now(), callIndex = ++count;
      if (options.signal?.aborted) throw new JevDecisionError("aborted");
      const raw = researchLimits === undefined ? options.timeoutMs ?? timeoutMs : options.timeoutMs === undefined ? timeoutMs : options.timeoutMs;
      if (!deadlineValue(raw, limit)) throw new JevDecisionError("invalid_options");
      const deadline = researchLimits === undefined ? raw : Math.min(timeoutMs, raw);
      if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > limit) throw new JevDecisionError("invalid_options");
      buildJevDecisionPayload(input);
      const snapshot = structuredClone(input);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined, delay: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => { reject(new JevDecisionError("aborted")); controller.abort(); };
          options.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => { reject(new JevDecisionError("timeout")); controller.abort(); }, deadline);
        });
        const run = async () => {
          if (delayMs) await new Promise<void>(resolve => { delay = setTimeout(resolve, delayMs); });
          if (controller.signal.aborted) throw new JevDecisionError(options.signal?.aborted ? "aborted" : "timeout");
          const result = await fn(structuredClone(snapshot), { signal: controller.signal, timeoutMs: deadline, callIndex });
          if (controller.signal.aborted) throw new JevDecisionError(options.signal?.aborted ? "aborted" : "timeout");
          return validateJevDecision({ action: result.action, target: result.target, name: result.name, feature: result.feature, observe: result.observe,
            ...(result.detailFigureIds === undefined ? {} : { detailFigureIds: result.detailFigureIds }),
            decisionKind: "mock", calibrated: false, evidence: { model: null, responseId: null, choices: {}, scores: {},
              latencyMs: Math.max(0, Math.round(performance.now() - started)), costUsd: 0 } }, snapshot);
        };
        return await Promise.race([run(), cancelled]);
      } catch (error) {
        throw new JevDecisionError(error instanceof JevDecisionError ? error.code : "invalid_response");
      } finally {
        clearTimeout(timer); clearTimeout(delay); options.signal?.removeEventListener("abort", abort);
      }
    },
  });
}
