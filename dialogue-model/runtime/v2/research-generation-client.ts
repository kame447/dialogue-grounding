// Harness-only logical generation deadline; native client attempt timers stay intact.
import { AIConnectionError } from '../client.mjs';
import { deadlineValue } from './research-deadline-options.ts';
import { RESEARCH_MAX_DEADLINE_MS } from './research-timeouts.ts';
type Options = { phase?: string; timeoutMs?: number; signal?: AbortSignal };
type Client = { complete(messages: any[], options?: Options): Promise<any> };
export function researchGenerationClient<T extends Client>(client: T, generationMs: number): T {
  if (!deadlineValue(generationMs, RESEARCH_MAX_DEADLINE_MS)) throw Error('invalid_timeouts');
  return { ...client, async complete(messages: any[], options: Options = {}) {
    if (!['generation', 'final_submission'].includes(options.phase ?? '')) return client.complete(messages, options);
    const controller = new AbortController(), deadline = performance.now() + generationMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOuter!: (error: Error) => void;
    const timeout = () => { rejectOuter(new AIConnectionError('timeout')); controller.abort(); };
    const caller = () => { rejectOuter(Object.assign(new Error('aborted'), { name: 'AbortError' })); controller.abort(); };
    const canceled = new Promise<never>((_resolve, reject) => { rejectOuter = reject; });
    options.signal?.addEventListener('abort', caller, { once: true });
    try {
      if (options.signal?.aborted) { caller(); return await canceled; }
      timer = setTimeout(timeout, generationMs);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const result = await Promise.race([client.complete(messages, { ...options, timeoutMs: generationMs, signal }), canceled]);
      if (performance.now() >= deadline) { timeout(); return await canceled; }
      if (signal.aborted) { caller(); return await canceled; }
      return result;
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', caller); }
  } } as T;
}
