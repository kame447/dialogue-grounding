// Client-level complete calls and actual HTTP attempts are different counters.
import { researchHash } from "../../v2/research-profile.ts";
import type { LunaRequestSettings } from "../../v2/research-profile.ts";
import type { CallReceipt } from "./audit.ts";
import type { RunBudget } from "./audit.ts";
import { AsyncLocalStorage } from "node:async_hooks";
export type HttpReceipt = { method: string; kind: "policy_get" | "completion_post"; phase: string | null;
  callId: number | null; sendId: number | null; hashScheme: "canonical_json_sha256";
  requestSha256: string | null; status: number | null; outcome: "started" | "returned" | "unknown" };
export const LUNA_HTTP_BODY_KEYS = Object.freeze(["purpose", "messages", "max_completion_tokens"]);
export function canonicalLunaPayload(messages: unknown[], settings: LunaRequestSettings) {
  return { purpose: "dialogue_turn", messages, ...(settings.maxCompletionTokens === null ? {} : { max_completion_tokens: settings.maxCompletionTokens }) };
}
export class LunaWireError extends Error { readonly code = "invalid_luna_wire"; constructor() { super("invalid_luna_wire"); } }
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
        const method = init?.method ?? "GET";
        let body: ReturnType<typeof canonicalLunaPayload> | null = null;
        if (method === "POST") try { body = JSON.parse(String(init?.body)); }
        catch { budget.refuse("luna_http", "invalid_luna_wire", current?.id ?? null); budget.stop("invalid_luna_wire"); throw new LunaWireError(); }
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization?.startsWith("Bearer ")) onSecret(authorization.slice(7));
        if (method === "POST") {
          if (!current || !body || !Array.isArray(body.messages) || Object.keys(body).some(k => !LUNA_HTTP_BODY_KEYS.includes(k)) ||
              researchHash(body.messages) !== current.requestSha256 ||
              researchHash(body) !== researchHash(canonicalLunaPayload(body.messages, settings))) {
            budget.refuse("luna_http", "invalid_luna_wire", current?.id ?? null); budget.stop("invalid_luna_wire"); throw new LunaWireError();
          }
          const count = (attempts.get(current) ?? 0) + 1;
          if (count > 3) throw new Error("luna_http_cap"); attempts.set(current, count);
        } else if (method !== "GET") throw new Error("invalid_luna_wire");
        const record: HttpReceipt = { method, kind: method === "POST" ? "completion_post" : "policy_get", phase: current?.phase ?? null,
          callId: current?.id ?? null, sendId: null, hashScheme: "canonical_json_sha256",
          requestSha256: body ? researchHash(body) : null, status: null, outcome: "started" };
        const send = method === "POST" ? budget.reserve("luna", current?.phase ?? null, current?.turn ?? null, current?.id ?? null) : null;
        if (send && current?.sendIds) current.sendIds.push(send.id);
        record.sendId = send?.id ?? null;
        if (send) owned.push(send);
        records.push(record);
        try {
          if (send) { budget.sent(send); current!.httpRequestSha256 = record.requestSha256!; } else onPolicyGet();
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
