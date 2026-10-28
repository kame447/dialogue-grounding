// Researcher-only admin routes under /admin. Storage access is injected, so
// authentication, CSRF checks, headers and routing are testable without
// Cloudflare. Fails closed: no token (or no rate limiter) means 404.
// GET /admin/record/<recordId>.json downloads that one full record as JSON.
import { checkAdmin, presentedToken } from "./auth.ts";
import { RECEPTIONS_LIVE_JS } from './receptions-live.ts';
import { ADMIN_CSS, applyFilter, parseFilter, renderDetail, renderList, renderMessage, renderReceptions, renderEntry, renderSettings } from "./render.ts";
import { OBJECT_ID, RECORD_ID } from "./summary.ts";
import type { AdminSummary } from "./summary.ts";
import type { LatencySummary } from "./latency.ts";
import type { AuditEntry } from "./index-store.ts";
import type { ProtocolFields, ReceptionAdminPort, ReceptionSettingsPort } from './reception-port.ts';

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
  /** Researcher reception settings (protocol and reception mode). */
  receptionSettings?: ReceptionSettingsPort;
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
/** Only the self-updating reception list may run its own same-origin script and fetch from this origin. */
export const LIVE_CSP = ADMIN_HEADERS["Content-Security-Policy"] + "; script-src 'self'; connect-src 'self'";
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
/** Browser pages (Accept: text/html without application/json) get a short page; other clients keep the JSON contract. */
function wantsHtml(request: Request): boolean {
  const types = (request.headers.get('Accept') ?? '').split(',').map(value => value.split(';')[0].trim().toLowerCase());
  return types.includes('text/html') && !types.includes('application/json');
}
const RECEPTION_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  not_found: '受付が見つかりません。',
  invalid_request: 'フォームの内容を確認できませんでした。開き直してから操作してください。',
  invalid_confirmation: '確認欄に、表示された番号を正確に入力してください。',
  conflict: '受付の状態が変わりました。開き直してから操作してください。',
  invalid_order: '条件順序を選んでください。',
  protocol_unconfigured: 'プロトコルが未設定のため、許可できません。',
  protocol_changed: '設定が変わりました。開き直してから許可してください。',
  reception_closed: '受付を使わない設定のため、許可できません。',
  reception_unavailable: '受付を確認できませんでした。開き直してから操作してください。',
});
/** The same status either way; the page names only the closed code's message, never the submitted or backend values. */
function receptionFailure(request: Request, title: string, status: number, error: string, message = RECEPTION_MESSAGES[error]): Response {
  if (!wantsHtml(request)) return receptionError(status, error);
  return respond(status, renderMessage(title, message ?? RECEPTION_MESSAGES.reception_unavailable, { href: '/admin/receptions', label: '受付一覧へ' }));
}
const unsigned = (text: string | null): number | null => {
  if (text === null || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const n = Number(text); return Number.isSafeInteger(n) ? n : null;
};

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
async function receptionMutation(request: Request, port: ReceptionAdminPort, id: string, action: string): Promise<Response> {
  // A 503 may follow a write whose reply was lost, so it says the outcome is unknown rather than "not done".
  const fail = (status: number, error: string) => status === 503
    ? receptionFailure(request, action === 'approve' ? '許可の結果を確認できません' : '取消の結果を確認できません', status, error,
      '受付を確認できませんでした。受付一覧を開き直して、状態を確認してください。')
    : receptionFailure(request, action === 'approve' ? '許可していません' : '取り消していません', status, error);
  if (!RECORD_ID.test(id)) return fail(404, 'not_found');
  const form = await receptionForm(request);
  const allowed = action === 'approve' ? ['order', 'expectedRevision', 'confirm', 'protocolId', 'protocolRevision', 'protocolSha256'] : ['expectedRevision', 'confirm'];
  if (!form || [...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)) return fail(400, 'invalid_request');
  const expectedRevision = unsigned(form.get('expectedRevision'));
  if (expectedRevision === null) return fail(400, 'invalid_request');
  // The protocol version shown with the order choices; it is compared before the order is interpreted.
  const shown = { protocolId: form.get('protocolId') ?? '', revision: unsigned(form.get('protocolRevision')), sha256: form.get('protocolSha256') ?? '' };
  if (action === 'approve' && (!UUID_V4.test(shown.protocolId) || shown.revision === null || shown.revision < 1 || !/^[a-f0-9]{64}$/u.test(shown.sha256))) return fail(400, 'invalid_request');
  try {
    const entry = await port.get(id);
    if (!entry || entry.receptionId !== id) return fail(404, 'not_found');
    if (form.get('confirm') !== entry.receptionId.slice(0, 8) && (entry.number === null || form.get('confirm') !== entry.number)) return fail(400, 'invalid_confirmation');
    if (entry.revision !== expectedRevision) return fail(409, 'conflict');
    let result;
    if (action === 'approve') {
      const protocol = await port.protocol();
      if (!protocol.configured) return fail(409, 'protocol_unconfigured');
      if (protocol.mode === 'off') return fail(409, 'reception_closed');
      if (protocol.protocolId !== shown.protocolId || protocol.revision !== shown.revision || protocol.sha256 !== shown.sha256) return fail(409, 'protocol_changed');
      const order = unsigned(form.get('order'));
      if (order === null || order >= protocol.allowedOrders.length) return fail(400, 'invalid_order');
      if (entry.status !== 'pending' || entry.trials.some(trial => trial.recordId !== null)) return fail(409, 'conflict');
      result = await port.approve(id, { order, expectedRevision, protocol: { protocolId: shown.protocolId, revision: shown.revision!, sha256: shown.sha256 } });
    } else {
      if ((entry.status !== 'pending' && entry.status !== 'approved') || entry.trials.some(trial => trial.recordId !== null)) return fail(409, 'conflict');
      result = await port.cancel(id, { expectedRevision });
    }
    if (!result.ok) {
      // The result remains allowlisted at runtime: never reflect an arbitrary backend error.
      switch (result.error) {
        case 'not_found': return fail(404, 'not_found');
        case 'invalid_order': return fail(400, 'invalid_order');
        case 'conflict': return fail(409, 'conflict');
        case 'protocol_unconfigured': return fail(409, 'protocol_unconfigured');
        case 'protocol_changed': return fail(409, 'protocol_changed');
        case 'reception_closed': return fail(409, 'reception_closed');
        default: return fail(503, 'reception_unavailable');
      }
    }
    if (request.headers.get('Accept')?.split(',').some(value => value.split(';')[0].trim() === 'application/json')) {
      return respond(200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    }
    return plain(303, '', { Location: '/admin/receptions' });
  } catch { return fail(503, 'reception_unavailable'); }
}

const ORDER_TOKENS: Readonly<Record<string, ProtocolFields['allowedOrders'][number]>> = Object.freeze({
  'rf-be': ['repair-first', 'bypass-enabled'], 'be-rf': ['bypass-enabled', 'repair-first'], rf: ['repair-first'], be: ['bypass-enabled'] });
const SINGLE: Readonly<Record<string, readonly string[]>> = Object.freeze({ seedPolicy: ['shared', 'per_trial'], referenceMemory: ['on', 'off'],
  betweenTrials: ['none', 'questionnaire_required'], rotationMode: ['relative_pm90', 'relative_0'], receptionNumberFormat: ['daily_seq3'] });
/** Every field must be selected explicitly; nothing missing is filled with a default. */
function protocolForm(form: URLSearchParams): { expectedRevision: number; fields: ProtocolFields } | null {
  const keys = [...new Set(form.keys())];
  if (keys.some(k => k !== 'orders' && k !== 'expectedRevision' && !Object.hasOwn(SINGLE, k))) return null;
  if (['expectedRevision', ...Object.keys(SINGLE)].some(k => form.getAll(k).length !== 1)) return null;
  const expectedRevision = unsigned(form.get('expectedRevision')), orders = form.getAll('orders');
  if (expectedRevision === null || !orders.length || new Set(orders).size !== orders.length || orders.some(o => !Object.hasOwn(ORDER_TOKENS, o))) return null;
  for (const [k, values] of Object.entries(SINGLE)) if (!values.includes(form.get(k)!)) return null;
  return { expectedRevision, fields: { allowedOrders: Object.keys(ORDER_TOKENS).filter(t => orders.includes(t)).map(t => [...ORDER_TOKENS[t]]),
    seedPolicy: form.get('seedPolicy') as ProtocolFields['seedPolicy'], referenceMemory: form.get('referenceMemory') === 'on',
    betweenTrials: form.get('betweenTrials') as ProtocolFields['betweenTrials'], receptionNumberFormat: 'daily_seq3',
    rotationMode: form.get('rotationMode') as ProtocolFields['rotationMode'] } };
}
function modeForm(form: URLSearchParams): { expectedRevision: number; value: 'on' | 'off' } | null {
  const keys = [...form.keys()];
  if (keys.length !== 2 || ['expectedRevision', 'value'].some(k => form.getAll(k).length !== 1)) return null;
  const expectedRevision = unsigned(form.get('expectedRevision')), value = form.get('value');
  return expectedRevision !== null && (value === 'on' || value === 'off') ? { expectedRevision, value } : null;
}
const NOT_SAVED = '保存していません';
async function settingsMutation(request: Request, port: ReceptionSettingsPort, kind: string): Promise<Response> {
  const form = await receptionForm(request);
  const input = form && (kind === 'protocol' ? protocolForm(form) : modeForm(form));
  if (!input) return respond(400, renderMessage(NOT_SAVED, 'すべての項目を選んでください。'));
  let result;
  try { result = 'fields' in input ? await port.saveProtocol(input) : await port.saveMode(input); }
  catch { return respond(503, renderMessage(NOT_SAVED, '設定を保存できませんでした。')); }
  if (result.ok) return plain(303, '', { Location: '/admin/reception-settings' });
  switch (result.error) {
    case 'conflict': return respond(409, renderMessage(NOT_SAVED, '他の画面で設定が変わりました。開き直してから保存してください。'));
    case 'invalid': return respond(400, renderMessage(NOT_SAVED, 'すべての項目を選んでください。'));
    case 'protocol_unconfigured': return respond(409, renderMessage(NOT_SAVED, 'プロトコルを保存してから、受付を使ってください。'));
    default: return respond(503, renderMessage(NOT_SAVED, '設定を保存できませんでした。'));
  }
}

export async function handleAdmin(request: Request, deps: AdminDeps): Promise<Response> {
  if (!deps.limiter || typeof deps.token !== "string") return notFound();
  const url = new URL(request.url);
  // Deletion is POST-only; a GET to the same path is an unknown page with no side effect.
  const deletePath = request.method === "POST" ? url.pathname.match(/^\/admin\/record\/([^/]+)\/delete$/) : null;
  const nextPath = request.method === 'POST' && deps.prepareNext ? url.pathname.match(/^\/admin\/record\/([^/]+)\/prepare-next$/) : null;
  const receptionPath = request.method === 'POST' && deps.receptions ? url.pathname.match(/^\/admin\/reception\/([^/]+)\/(approve|cancel)$/) : null;
  const settingsPath = request.method === 'POST' && deps.receptionSettings ? url.pathname.match(/^\/admin\/reception-settings\/(protocol|mode)$/) : null;
  if (!deps.receptions && (url.pathname === '/admin/receptions' || url.pathname === '/admin/entry' || url.pathname === '/admin/receptions.js')) return notFound();
  if (!deps.receptions?.version && url.pathname === '/admin/receptions/version') return notFound();
  if (!deps.receptionSettings && url.pathname === '/admin/reception-settings') return notFound();
  if (request.method === "POST" ? !deletePath && !nextPath && !receptionPath && !settingsPath : request.method !== "GET" && request.method !== "HEAD") return notFound();
  const header = request.headers.get("Authorization");
  // Every credentialed attempt (right or wrong) counts, so guessing is capped per visitor.
  if (presentedToken(header) !== null && !(await deps.limiter.limit({ key: visitorKey(request) })).success) {
    return plain(429, "Too many requests", { "Retry-After": "60" });
  }
  const auth = await checkAdmin(header, deps.token);
  if (auth === "unconfigured") return notFound();
  if (auth !== "ok") return plain(401, "Authentication required", { "WWW-Authenticate": REALM });

  if (settingsPath) {
    if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
    return settingsMutation(request, deps.receptionSettings!, settingsPath[1]);
  }
  if (deps.receptionSettings && url.pathname === '/admin/reception-settings') {
    try { return respond(200, renderSettings(await deps.receptionSettings.read())); }
    catch { return respond(503, renderMessage('受付の設定', '設定を読み込めませんでした。')); }
  }
  if (receptionPath) {
    if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
    return receptionMutation(request, deps.receptions!, receptionPath[1], receptionPath[2]);
  }
  if (deps.receptions && url.pathname === '/admin/receptions') {
    try {
      // Version first, then content: a change in between makes the next version check differ, so none is missed.
      const since = new Date().toISOString();
      let version: string | null = null;
      if (deps.receptions.version) { try { version = (await deps.receptions.version(null)).version; } catch { version = null; } }
      const protocol = await deps.receptions.protocol();
      const page = await deps.receptions.listPage(url.searchParams.get('after'));
      const live = version !== null && /^[a-f0-9]{64}$/u.test(version) ? { version, since } : null;
      return respond(200, renderReceptions(page.items, page.next, protocol, live), undefined, live ? { 'Content-Security-Policy': LIVE_CSP } : {});
    } catch { return receptionFailure(request, '受付一覧', 503, 'reception_unavailable'); }
  }
  if (deps.receptions?.version && url.pathname === '/admin/receptions/version') {
    // `since` is the render time the page carries; anything else is ignored rather than reflected.
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam !== null && ISO_MS.test(sinceParam) && new Date(sinceParam).toISOString() === sinceParam ? sinceParam : null;
    try {
      const { version, newPending } = await deps.receptions.version(since);
      if (!/^[a-f0-9]{64}$/u.test(version) || newPending !== null && !Number.isSafeInteger(newPending)) throw new Error();
      return respond(200, JSON.stringify(since === null ? { version } : { version, newPending }), 'application/json; charset=utf-8');
    } catch { return receptionError(503, 'reception_unavailable'); }
  }
  if (deps.receptions && url.pathname === '/admin/receptions.js') return respond(200, RECEPTIONS_LIVE_JS, 'text/javascript; charset=utf-8');
  if (deps.receptions && url.pathname === '/admin/entry') {
    try { return respond(200, renderEntry(new URL('/', url).href)); }
    catch { return receptionFailure(request, '参加用URL・QRコード', 503, 'reception_unavailable'); }
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
