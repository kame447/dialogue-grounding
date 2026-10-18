/**
 * Gentle, per-minute traffic limits intended to catch automated floods rather
 * than put a quota on legitimate conversations or experiment duration.
 * Cloudflare counters are approximate and local to a data center; these are
 * abuse controls, not billing caps.
 */
export interface LimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface SoftLimitBindings {
  START_RATE_LIMIT: LimitBinding;
  IP_ACTION_RATE_LIMIT: LimitBinding;
  SESSION_ACTION_RATE_LIMIT: LimitBinding;
  GLOBAL_ACTION_RATE_LIMIT: LimitBinding;
}

const AI_ACTIONS = new Set(["/api/message", "/api/retry", "/api/names", "/api/ai-submit"]);

/** Only genuine request metadata from Cloudflare, never user-supplied X-Forwarded-For. */
function visitorKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "ip-unavailable";
}

/** Does not consume rate-limit counters for page loads, polling or static assets. */
export async function isExcessiveTraffic(
  request: Request,
  bindings: SoftLimitBindings,
  cookie: string | null,
): Promise<boolean> {
  if (request.method !== "POST" || !cookie) return false;
  const path = new URL(request.url).pathname;
  const ip = visitorKey(request);
  if (path === "/api/start") {
    return !(await bindings.START_RATE_LIMIT.limit({ key: ip })).success;
  }
  if (!AI_ACTIONS.has(path)) return false;
  if (!(await bindings.SESSION_ACTION_RATE_LIMIT.limit({ key: cookie })).success) return true;
  if (!(await bindings.IP_ACTION_RATE_LIMIT.limit({ key: ip })).success) return true;
  return !(await bindings.GLOBAL_ACTION_RATE_LIMIT.limit({ key: "tangram-ai-actions" })).success;
}
