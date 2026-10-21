// Client-level complete calls and actual HTTP attempts are different counters.
import { researchHash } from "../../v2/research-profile.ts";
import type { LunaRequestSettings } from "../../v2/research-profile.ts";
import type { CallReceipt } from "./audit.ts";
import type { RunBudget } from "./audit.ts";
import { AsyncLocalStorage } from "node:async_hooks";
export type HttpReceipt = { method: string; kind: "policy_get" | "completion_post"; phase: string | null;
  requestSha256: string | null; status: number | null; outcome: "started" | "returned" | "unknown" };
export function lunaWire(settings: LunaRequestSettings, budget: RunBudget, onSecret: (key: string) => void = () => {},
  onPolicyGet: () => void = () => {}) {
  const records: HttpReceipt[] = [];
  const owned: ReturnType<RunBudget["reserve"]>[] = [];
  const context = new AsyncLocalStorage<{ record: CallReceipt; signal?: AbortSignal }>();
  let active: CallReceipt | null = null, closed = false, measured = false, signal: AbortSignal | undefined;
  const attempts = new WeakMap<CallReceipt, number>();
  return {
    records, get measured() { return measured; },
    withCall<T>(record: CallReceipt, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> { return context.run({ record, signal }, operation); },
    setActive(record: CallReceipt | null) { active = record; },
    bind(abort: AbortSignal) { signal = abort; },
    close() { closed = true; records.filter(r => r.outcome === "started").forEach(r => { r.outcome = "unknown"; }); owned.forEach(s => budget.unknown(s)); },
    instrumentFetch(fetchImpl: typeof fetch): typeof fetch {
      measured = true;
      return async (url, init) => {
        const call = context.getStore(), current = call?.record ?? active;
        if (closed || signal?.aborted || call?.signal?.aborted) { budget.refuse("luna_http", call?.signal?.aborted ? "phase_aborted" : "scope_closed", current?.id ?? null); throw new Error("closed_luna_wire"); }
        const method = init?.method ?? "GET", body = method === "POST" ? JSON.parse(String(init?.body)) : null;
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization?.startsWith("Bearer ")) onSecret(authorization.slice(7));
        if (method === "POST") {
          if (!current || body.purpose !== "dialogue_turn" || Object.hasOwn(body, "model") ||
              researchHash(body.messages) !== current.requestSha256 ||
              (settings.maxCompletionTokens === null ? Object.hasOwn(body, "max_completion_tokens") : body.max_completion_tokens !== settings.maxCompletionTokens)) throw new Error("invalid_luna_wire");
          const count = (attempts.get(current) ?? 0) + 1;
          if (count > 3) throw new Error("luna_http_cap"); attempts.set(current, count);
        } else if (method !== "GET") throw new Error("invalid_luna_wire");
        const record: HttpReceipt = { method, kind: method === "POST" ? "completion_post" : "policy_get", phase: current?.phase ?? null,
          requestSha256: body ? researchHash(body) : null, status: null, outcome: "started" };
        const send = method === "POST" ? budget.reserve("luna", current?.phase ?? null, current?.turn ?? null, current?.id ?? null) : null;
        if (send && current?.sendIds) current.sendIds.push(send.id);
        if (send) owned.push(send);
        records.push(record);
        try {
          if (send) budget.sent(send); else onPolicyGet();
          const response = await fetchImpl(url, { ...init, ...(signal ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}) });
          // Account each send once, even when complete() later rejects an empty
          // body, or the trial has already ended. Failed HTTP bodies stay unread.
          if (send) {
            let inputTokens: number | null = null, outputTokens: number | null = null, model: string | null = null;
            if (response.ok) try {
              const data = await response.clone().json();
              inputTokens = Number.isSafeInteger(data?.usage?.prompt_tokens) && data.usage.prompt_tokens >= 0 ? data.usage.prompt_tokens : null;
              outputTokens = Number.isSafeInteger(data?.usage?.completion_tokens) && data.usage.completion_tokens >= 0 ? data.usage.completion_tokens : null;
              model = typeof data?.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(data.model) ? data.model : null;
            } catch { /* Usage remains unknown, never zero-filled. */ }
            budget.observe(send, { inputTokens, outputTokens, model });
          }
          if (!closed) { record.status = response.status; record.outcome = "returned"; }
          return response;
        } catch (error) { if (send) budget.unknown(send); if (!closed) record.outcome = "unknown"; throw error; }
      };
    },
  };
}
