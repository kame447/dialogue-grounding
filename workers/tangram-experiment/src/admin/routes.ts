// Researcher-only admin routes under /admin. Storage access is injected, so
// authentication, CSRF checks, headers and routing are testable without
// Cloudflare. Fails closed: no token (or no rate limiter) means 404.
// The only state-changing route is POST /admin/record/<recordId>/delete.
// GET /admin/record/<recordId>.json downloads that one full record as JSON.
import { checkAdmin, presentedToken } from "./auth.ts";
import { ADMIN_CSS, applyFilter, parseFilter, renderDetail, renderList, renderMessage } from "./render.ts";
import { OBJECT_ID, RECORD_ID } from "./summary.ts";
import type { AdminSummary } from "./summary.ts";
import type { LatencySummary } from "./latency.ts";
import type { AuditEntry } from "./index-store.ts";

export type AdminLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type AdminDeps = {
  token: string | undefined;
  limiter: AdminLimiter | undefined;
  // Legacy injected callers may still pass this; it no longer controls record retention.
  retentionDays?: number;
  listPage(after: string | null): Promise<{ items: AdminSummary[]; next: string | null }>;
  getSummary(recordId: string): Promise<AdminSummary | null>;
  /** Reads record:<recordId> from the owning session object over internal RPC, never the participant API. */
  getRecord(summary: AdminSummary): Promise<unknown | null>;
  /** Deletes the record in its session object, then its index entry (with a content-free audit entry). */
  deleteRecord(summary: AdminSummary): Promise<void>;
  audit(): Promise<AuditEntry[]>;
  summarizeLatency(record: unknown): LatencySummary;
};

export const ADMIN_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  // same-origin (not no-referrer): under no-referrer, browsers send `Origin: null` on the
  // delete form's POST, which the CSRF check would then always reject.
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
});
const REALM = 'Basic realm="tangram-admin", charset="UTF-8"';
const MAX_FORM_BYTES = 1024;

export const isAdminPath = (pathname: string) => pathname === "/admin" || pathname.startsWith("/admin/");

function respond(status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...ADMIN_HEADERS, "Content-Type": type, ...extra } });
}
const plain = (status: number, text: string, extra: Record<string, string> = {}) => respond(status, text, "text/plain; charset=utf-8", extra);
const notFound = () => plain(404, "Not found");

/** Visitor key from Cloudflare's own header only; never a client-supplied forwarding header. */
const visitorKey = (request: Request) => "admin:" + (request.headers.get("CF-Connecting-IP") ?? "ip-unavailable");

/**
 * CSRF guard. Origin is required: either this site's origin, or the opaque "null"
 * only when the browser-set Sec-Fetch-Site says same-origin. Any other origin, a
 * missing Origin, or a cross-site Sec-Fetch-Site is rejected.
 */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin === url.origin) return site === null || site === "same-origin";
  return origin === "null" && site === "same-origin";
}

async function confirmation(request: Request): Promise<string | null> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_FORM_BYTES) return null;
  return new URLSearchParams(text).get("confirm");
}

export async function handleAdmin(request: Request, deps: AdminDeps): Promise<Response> {
  if (!deps.limiter || typeof deps.token !== "string") return notFound();
  const url = new URL(request.url);
  // Deletion is POST-only; a GET to the same path is an unknown page with no side effect.
  const deletePath = request.method === "POST" ? url.pathname.match(/^\/admin\/record\/([^/]+)\/delete$/) : null;
  if (request.method === "POST" ? !deletePath : request.method !== "GET" && request.method !== "HEAD") return notFound();
  const header = request.headers.get("Authorization");
  // Every credentialed attempt (right or wrong) counts, so guessing is capped per visitor.
  if (presentedToken(header) !== null && !(await deps.limiter.limit({ key: visitorKey(request) })).success) {
    return plain(429, "Too many requests", { "Retry-After": "60" });
  }
  const auth = await checkAdmin(header, deps.token);
  if (auth === "unconfigured") return notFound();
  if (auth !== "ok") return plain(401, "Authentication required", { "WWW-Authenticate": REALM });

  if (deletePath) {
    if (!sameOrigin(request, url)) return plain(403, "Forbidden");
    const recordId = deletePath[1];
    if (!RECORD_ID.test(recordId)) return notFound();
    if (await confirmation(request) !== recordId) return respond(400, renderMessage("削除していません", "確認欄に記録IDを正確に入力してください。"));
    const summary = await deps.getSummary(recordId);
    if (!summary || summary.recordId !== recordId || !OBJECT_ID.test(summary.objectId)) return notFound();
    await deps.deleteRecord(summary);
    return respond(303, "", "text/plain; charset=utf-8", { Location: "/admin?deleted=1" });
  }
  if (url.pathname === "/admin/style.css") return respond(200, ADMIN_CSS, "text/css; charset=utf-8");
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const filter = parseFilter(url.searchParams);
    const page = await deps.listPage(url.searchParams.get("after"));
    return respond(200, renderList(applyFilter(page.items, filter), filter, page.next, await deps.audit(), deps.retentionDays,
      url.searchParams.get("deleted") === "1"));
  }
  const match = url.pathname.match(/^\/admin\/record\/([^/.]+)(\.json)?$/);
  if (!match || !RECORD_ID.test(match[1])) return notFound();
  // Only indexed trials are viewable; the owning object comes from the index, not the URL.
  const summary = await deps.getSummary(match[1]);
  if (!summary || summary.recordId !== match[1] || !OBJECT_ID.test(summary.objectId)) return notFound();
  const record = await deps.getRecord(summary);
  if (!record) return respond(404, renderMessage("記録がありません", "このセッションには保存済みの記録がありません。"));
  // Researcher export of the full stored record (including the provisional questionnaire), as a download.
  if (match[2]) return respond(200, JSON.stringify(record, null, 2), "application/json; charset=utf-8",
    { "Content-Disposition": `attachment; filename="tangram-record-${summary.recordId}.json"` });
  return respond(200, renderDetail(record, summary, deps.summarizeLatency(record), deps.retentionDays));
}
