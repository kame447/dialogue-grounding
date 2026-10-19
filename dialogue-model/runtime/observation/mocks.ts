// Deterministic observer callbacks only: no lexical heuristics or network client.
import type { ObservationInput, ObservationMemo, ObservationObserver, ObservationOptions,
  ReobservationInput, ReobservationResult } from "./contract.ts";
import { ObservationError, validateObservationMemo, mergeReobservation } from "./observe.ts";

type Callback<I, O> = (input: I, options: { signal: AbortSignal; timeoutMs: number; callIndex: number }) => O | Promise<O>;
export function createMockObserver(callbacks: {
  observeAll: Callback<ObservationInput, ObservationMemo>;
  reobserve: Callback<ReobservationInput, ReobservationResult>;
}, { delayMs = 0, timeoutMs = 20000 }: { delayMs?: number; timeoutMs?: number } = {}): ObservationObserver {
  if (!callbacks || typeof callbacks.observeAll !== "function" || typeof callbacks.reobserve !== "function" ||
      !Number.isSafeInteger(delayMs) || delayMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new ObservationError("invalid_input");
  }
  let callIndex = 0;
  async function run<I, O>(fn: Callback<I, O>, input: I, validate: (result: O, snapshot: I) => O, options: ObservationOptions): Promise<O> {
    if (options.signal?.aborted) throw new ObservationError("aborted");
    const deadline = options.timeoutMs ?? timeoutMs;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60000) throw new ObservationError("invalid_input");
    const controller = new AbortController();
    const index = callIndex++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      const snapshot = structuredClone(input);
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => { reject(new ObservationError("aborted")); controller.abort(); };
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => { reject(new ObservationError("timeout")); controller.abort(); }, deadline);
      });
      const result = await Promise.race([Promise.resolve().then(async () => {
        if (delayMs) await new Promise<void>(resolve => { delay = setTimeout(resolve, delayMs); });
        if (controller.signal.aborted) throw new ObservationError(options.signal?.aborted ? "aborted" : "timeout");
        return fn(structuredClone(snapshot), { signal: controller.signal, timeoutMs: deadline, callIndex: index });
      }), cancelled]);
      return validate(structuredClone(result), snapshot);
    } catch (error) {
      if (error instanceof ObservationError) throw new ObservationError(error.code);
      throw new ObservationError("unavailable");
    } finally {
      clearTimeout(timer); clearTimeout(delay); options.signal?.removeEventListener("abort", abort);
    }
  }
  return {
    observeAll(input, options = {}) {
      return run(callbacks.observeAll, input, (value, own) => validateObservationMemo(value, { ownAnchors: own.ownAnchors }), options);
    },
    reobserve(input, options = {}) {
      return run(callbacks.reobserve, input, (value, own) => {
        if (!value || !value.issue || !Array.isArray(value.figures) || value.issue.aspect !== own.issue.aspect ||
            value.issue.question !== own.issue.question || value.issue.partnerConstrual !== own.issue.partnerConstrual ||
            value.figures.length !== own.figureIds.length || value.figures.some(f => !own.figureIds.includes(f.figureId))) throw new ObservationError("invalid_response");
        mergeReobservation(validateObservationMemo(own.memo, { ownAnchors: own.ownAnchors }), value);
        return value;
      }, options);
    },
  };
}
