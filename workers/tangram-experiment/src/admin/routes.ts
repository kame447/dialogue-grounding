// Researcher-only admin routes under /admin. Storage access is injected, so
// authentication, CSRF checks, headers and routing are testable without
// Cloudflare. Fails closed: no token (or no rate limiter) means 404.
// GET /admin/record/<recordId>.json downloads that one full record as JSON.
import { checkAdmin, presentedToken } from "./auth.ts";
import { ADMIN_CSS, applyFilter, parseFilter, renderDetail, renderList, renderMessage, renderReceptions, renderEntry } from "./render.ts";
import { OBJECT_ID, RECORD_ID } from "./summary.ts";
import type { AdminSummary } from "./summary.ts";
import type { LatencySummary } from "./latency.ts";
import type { AuditEntry } from "./index-store.ts";
import type { ReceptionAdminPort } from './reception-port.ts';

export type AdminLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type AdminDeps = {
  token: string | undefined;
  limiter: AdminLimiter | undefined;
  // Accepted for older callers only; record retention is no longer time-limited.
  retentionDays?: number;
  listPage(after: string | null): Promise<{ items: AdminSummary[]; next: string | null }>;
  getSummary(recordId: string): Promise<AdminSummary | null>;
  /** Reads record:<recordId> from the owning session object over internal RPC, never the participant API. */
  getRecord(summary: AdminSummary): Promise<unknown | null>;
  /** Deletes the record in its session object, then its index entry (with a content-free audit entry). */
  deleteRecord(summary: AdminSummary): Promise<void>;
  audit(): Promise<AuditEntry[]>;
  summarizeLatency(record: unknown): LatencySummary;
  /** Optional S5 operator action; participant cookies do not authorize it. */
  prepareNext?(summary: AdminSummary): Promise<{ kind: 'created' | 'existing'; recordId: string; participantPath: '/' }>;
  receptions?: ReceptionAdminPort;
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

/** Stop reading before decoding/parsing an over-limit streamed form. */
async function receptionForm(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_FORM_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } catch { return null; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
}
const receptionError = (status: number, error: string) => respond(status, JSON.stringify({ error }), 'application/json; charset=utf-8');
const unsigned = (text: string | null): number | null => {
  if (text === null || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const n = Number(text); return Number.isSafeInteger(n) ? n : null;
};

async function receptionMutation(request: Request, port: ReceptionAdminPort, id: string, action: string): Promise<Response> {
  if (!RECORD_ID.test(id)) return receptionError(404, 'not_found');
  const form = await receptionForm(request);
  const allowed = action === 'approve' ? ['order', 'expectedRevision', 'confirm'] : ['expectedRevision', 'confirm'];
  if (!form || [...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)) return receptionError(400, 'invalid_request');
  const expectedRevision = unsigned(form.get('expectedRevision'));
  if (expectedRevision === null || expectedRevision < 1) return receptionError(400, 'invalid_request');
  try {
    const entry = await port.get(id);
    if (!entry || entry.receptionId !== id) return receptionError(404, 'not_found');
    if (form.get('confirm') !== entry.receptionId.slice(0, 8) && (entry.number === null || form.get('confirm') !== entry.number)) return receptionError(400, 'invalid_confirmation');
    if (entry.revision !== expectedRevision) return receptionError(409, 'conflict');
    let result;
    if (action === 'approve') {
      const protocol = await port.protocol();
      if (!protocol.configured) return receptionError(409, 'protocol_unconfigured');
      const order = unsigned(form.get('order'));
      if (order === null || order >= protocol.allowedOrders.length) return receptionError(400, 'invalid_order');
      if (entry.status !== 'pending' || entry.trials.some(trial => trial.recordId !== null)) return receptionError(409, 'conflict');
      result = await port.approve(id, { order, expectedRevision });
    } else {
      if ((entry.status !== 'pending' && entry.status !== 'approved') || entry.trials.some(trial => trial.recordId !== null)) return receptionError(409, 'conflict');
      result = await port.cancel(id, { expectedRevision });
    }
    if (!result.ok) {
      // The result remains allowlisted at runtime: never reflect an arbitrary backend error.
      switch (result.error) {
        case 'not_found': return receptionError(404, 'not_found');
        case 'invalid_order': return receptionError(400, 'invalid_order');
        case 'conflict': return receptionError(409, 'conflict');
        case 'protocol_unconfigured': return receptionError(409, 'protocol_unconfigured');
        default: return receptionError(503, 'reception_unavailable');
      }
    }
    if (request.headers.get('Accept')?.split(',').some(value => value.split(';')[0].trim() === 'application/json')) {
      return respond(200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    }
    return plain(303, '', { Location: '/admin/receptions' });
  } catch { return receptionError(503, 'reception_unavailable'); }
}

export async function handleAdmin(request: Request, deps: AdminDeps): Promise<Response> {
  if (!deps.limiter || typeof deps.token !== "string") return notFound();
  const url = new URL(request.url);
  // Deletion is POST-only; a GET to the same path is an unknown page with no side effect.
  const deletePath = request.method === "POST" ? url.pathname.match(/^\/admin\/record\/([^/]+)\/delete$/) : null;
  const nextPath = request.method === 'POST' && deps.prepareNext ? url.pathname.match(/^\/admin\/record\/([^/]+)\/prepare-next$/) : null;
  const receptionPath = request.method === 'POST' && deps.receptions ? url.pathname.match(/^\/admin\/reception\/([^/]+)\/(approve|cancel)$/) : null;
  if (!deps.receptions && (url.pathname === '/admin/receptions' || url.pathname === '/admin/entry')) return notFound();
  if (request.method === "POST" ? !deletePath && !nextPath && !receptionPath : request.method !== "GET" && request.method !== "HEAD") return notFound();
  const header = request.headers.get("Authorization");
  // Every credentialed attempt (right or wrong) counts, so guessing is capped per visitor.
  if (presentedToken(header) !== null && !(await deps.limiter.limit({ key: visitorKey(request) })).success) {
    return plain(429, "Too many requests", { "Retry-After": "60" });
  }
  const auth = await checkAdmin(header, deps.token);
  if (auth === "unconfigured") return notFound();
  if (auth !== "ok") return plain(401, "Authentication required", { "WWW-Authenticate": REALM });

  if (receptionPath) {
    if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
    return receptionMutation(request, deps.receptions!, receptionPath[1], receptionPath[2]);
  }
  if (deps.receptions && url.pathname === '/admin/receptions') {
    try {
      const protocol = await deps.receptions.protocol();
      const page = await deps.receptions.listPage(url.searchParams.get('after'));
      return respond(200, renderReceptions(page.items, page.next, protocol));
    } catch { return receptionError(503, 'reception_unavailable'); }
  }
  if (deps.receptions && url.pathname === '/admin/entry') {
    try { return respond(200, renderEntry(new URL('/', url).href)); }
    catch { return receptionError(503, 'reception_unavailable'); }
  }

  if (nextPath) {
    if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
    const id = nextPath[1]; if (!RECORD_ID.test(id)) return notFound();
    try {
      if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new Error();
      // Bound before JSON parsing, including streaming/chunked requests.
      const reader = request.body?.getReader(); let length = 0; const chunks: Uint8Array[] = [];
      if (reader) { for (;;) { const {done,value} = await reader.read(); if (done) break; length += value.byteLength;
        if (length > MAX_FORM_BYTES) { await reader.cancel(); throw new Error(); } chunks.push(value); } }
      const bytes = new Uint8Array(length); let offset = 0; for (const c of chunks) { bytes.set(c,offset); offset += c.length; }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) throw new Error();
    } catch { return respond(400, JSON.stringify({error:'invalid_request'}), 'application/json; charset=utf-8'); }
    const summary = await deps.getSummary(id);
    if (!summary || summary.recordId !== id || !OBJECT_ID.test(summary.objectId)) return notFound();
    try {
      const next = await deps.prepareNext!(summary);
      return respond(next.kind === 'created' ? 201 : 200, JSON.stringify({recordId:next.recordId,participantPath:next.participantPath}), 'application/json; charset=utf-8');
    } catch (error) {
      // Only the typed coordinator boundary may choose these machine codes.
      const { BaseSessionError } = await import('../../../../dialogue-model/runtime/v2/base-assignment-session.ts');
      const code = error instanceof BaseSessionError ? error.code : 'trial_unavailable';
      const mapped = code === 'owner_expired' ? 'not_found' : code;
      return respond(mapped === 'not_found' ? 404 : 409, JSON.stringify({error:mapped}), 'application/json; charset=utf-8');
    }
  }

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
      url.searchParams.get("deleted") === "1", Boolean(deps.receptions)));
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
