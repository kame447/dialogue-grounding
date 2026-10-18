// Researcher-only admin authentication. Pure: no Cloudflare types, so it is
// testable with node --test. The token never travels in a URL: only an
// Authorization header (Bearer, or Basic with ADMIN_USER and the token as the
// password, which lets a browser prompt for it).

export const ADMIN_USER = "researcher";
/** Shorter secrets are treated as unconfigured: fail closed rather than accept a weak token. */
export const MIN_TOKEN_LENGTH = 32;

export type AdminAuth = "ok" | "unconfigured" | "missing" | "invalid";

/** The presented token, or null when the header is absent or malformed. */
export function presentedToken(header: string | null): string | null {
  if (!header) return null;
  const bearer = header.match(/^Bearer ([\x21-\x7e]{1,512})$/);
  if (bearer) return bearer[1];
  const basic = header.match(/^Basic ([A-Za-z0-9+/]{1,1024}={0,2})$/);
  if (!basic) return null;
  let decoded: string;
  try { decoded = atob(basic[1]); } catch { return null; }
  const colon = decoded.indexOf(":");
  if (colon < 0 || decoded.slice(0, colon) !== ADMIN_USER) return null;
  const password = decoded.slice(colon + 1);
  return password ? password : null;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time over fixed-length digests, so neither content nor length leaks through timing. */
export async function tokensMatch(presented: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(secret)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function checkAdmin(header: string | null, secret: string | undefined): Promise<AdminAuth> {
  if (typeof secret !== "string" || secret.length < MIN_TOKEN_LENGTH) return "unconfigured";
  const token = presentedToken(header);
  if (token === null) return "missing";
  return await tokensMatch(token, secret) ? "ok" : "invalid";
}
