import { LIMITS } from "../src/ai/protocol";

const isLocalHost = (url: URL) => url.hostname === "127.0.0.1" || url.hostname === "localhost";

/**
 * Per-IP room creations per minute. `DEV_CREATE_PER_MINUTE` (set only by the local E2E run via
 * `wrangler dev --var`) is honoured on localhost only, so the public Worker always keeps the default.
 */
export function createLimit(env: { DEV_CREATE_PER_MINUTE?: string }, url: URL): number {
  const override = Number(env.DEV_CREATE_PER_MINUTE);
  return isLocalHost(url) && Number.isInteger(override) && override > 0 ? override : LIMITS.createPerMinute;
}
