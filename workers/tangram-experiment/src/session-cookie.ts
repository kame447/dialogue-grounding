// The participant session cookie. Persistent for the record retention period, so
// closing the browser does not cut the participant off from their own completed
// trial (later review and a questionnaire answered afterwards). Each page load
// re-sends the same id with a fresh Max-Age, which also upgrades cookies issued
// before this change as browser-session cookies. The id is never changed here.
// SameSite=Lax, not Strict (Issue #136): with Strict, opening the site from a link
// on another site sends no cookie, the page load issues a new id, and that id
// replaces the shared cookie of every open tab, which then loses its trial.
// Lax still withholds the cookie from cross-site POSTs and subresource requests.
export const SESSION_COOKIE = "tangram_session";
const DAY_SECONDS = 24 * 60 * 60;

export function sessionId(cookie: string | null): string | null {
  return cookie?.match(/(?:^|;\s*)tangram_session=([a-f0-9]{64})(?:;|$)/)?.[1] ?? null;
}

export function sessionCookie(id: string, retentionDays: number): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError("invalid_session_id");
  return `${SESSION_COOKIE}=${id}; Max-Age=${retentionDays * DAY_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
