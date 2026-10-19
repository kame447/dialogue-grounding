// Deterministic callbacks: no lexical classifier, network, credentials or graph writes.
import type { LocalClassificationInput, LocalExtractionInput, LocalFunctionClassifier, LocalFunctionVerdict,
  LocalSegmentExtractor, LocalSegmentProposal } from "./contract.ts";

type Options = { signal?: AbortSignal; timeoutMs?: number };
type MockOptions = { delayMs?: number; timeoutMs?: number };
type Callback<I, O> = (input: I, options: { signal: AbortSignal; timeoutMs: number; callIndex: number }) => O | Promise<O>;
export class LocalMockError extends Error {
  code: "timeout" | "aborted" | "mock_failure" | "invalid_options";
  constructor(code: LocalMockError["code"]) {
    const safe = (["timeout", "aborted", "mock_failure", "invalid_options"] as const).includes(code) ? code : "mock_failure";
    super(safe);
    this.name = code === "aborted" ? "AbortError" : "LocalMockError";
    this.code = safe;
  }
}

function mock<I, O>(fn: Callback<I, O>, { delayMs = 0, timeoutMs = 20000 }: MockOptions) {
  if (typeof fn !== "function" || !Number.isSafeInteger(delayMs) || delayMs < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new LocalMockError("invalid_options");
  let callIndex = 0;
  return async (input: I, options: Options = {}): Promise<O> => {
    if (options.signal?.aborted) throw new LocalMockError("aborted");
    const deadline = options.timeoutMs ?? timeoutMs;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60000) throw new LocalMockError("invalid_options");
    const controller = new AbortController();
    const index = callIndex++;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let delay: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      const snapshot = structuredClone(input);
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => { reject(new LocalMockError("aborted")); controller.abort(); };
        options.signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => { reject(new LocalMockError("timeout")); controller.abort(); }, deadline);
      });
      const result = await Promise.race([Promise.resolve().then(async () => {
        if (delayMs) await new Promise<void>((resolve) => { delay = setTimeout(resolve, delayMs); });
        if (controller.signal.aborted) throw new LocalMockError(options.signal?.aborted ? "aborted" : "timeout");
        return fn(snapshot, { signal: controller.signal, timeoutMs: deadline, callIndex: index });
      }), cancelled]);
      return structuredClone(result);
    } catch (error) {
      if (error instanceof LocalMockError) throw new LocalMockError(error.code);
      throw new LocalMockError("mock_failure");
    } finally {
      clearTimeout(timeout);
      clearTimeout(delay);
      options.signal?.removeEventListener("abort", abort);
    }
  };
}

export function createMockLocalExtractor(fn: Callback<LocalExtractionInput, LocalSegmentProposal[]>, options: MockOptions = {}): LocalSegmentExtractor {
  return { extract: mock(fn, options) };
}
export function createMockLocalClassifier(fn: Callback<LocalClassificationInput, LocalFunctionVerdict[]>, options: MockOptions = {}): LocalFunctionClassifier {
  return { classify: mock(fn, options) };
}
