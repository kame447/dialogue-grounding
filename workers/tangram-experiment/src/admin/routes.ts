// Researcher-only admin routes under /admin. Storage access is injected, so
// authentication, CSRF checks, headers and routing are testable without
// Cloudflare. Fails closed: no token (or no rate limiter) means 404.
// GET /admin/record/<recordId>.json downloads that one full record as JSON.
import { checkAdmin, presentedToken } from "./auth.ts";
import { RECEPTIONS_LIVE_JS } from './receptions-live.ts';
import { LOG_LIVE_JS } from './log-live.ts';
import { ADMIN_CSS, applyFilter, parseFilter, renderDetail, renderList, renderMessage, renderReceptions, renderEntry, renderSettings, renderExperimentPreview, renderFigures } from "./render.ts";
import { FIGURE_SETS, FIGURE_BANK, isSupportedFigureCount } from '../../../../dialogue-model/runtime/stimuli/figure-bank.ts';
import { OBJECT_ID, RECORD_ID } from "./summary.ts";
import type { AdminSummary } from "./summary.ts";
import { isParticipantRole, participantRoleView } from "./participant-role.ts";
import type { AdminRecordSummary, ParticipantRole, ParticipantRoleResult } from "./participant-role.ts";
import type { LatencySummary } from "./latency.ts";
import type { AuditEntry } from "./index-store.ts";
import type { ProtocolFields, ReceptionAdminPort, ReceptionSettingsPort } from './reception-port.ts';
import type { PreparedObservationPoolStatus } from './prepared-observation-port.ts';
import { trialTerminationExpectation } from './trial-termination.ts';
import type { TrialTerminationExpectation, TrialTerminationResult } from './trial-termination.ts';
import { isIncompleteTrialStatus } from '../../../../dialogue-model/runtime/v2/admin-termination.ts';

export type AdminLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type AdminDeps = {
  token: string | undefined;
  limiter: AdminLimiter | undefined;
  // Accepted for older callers only; record retention is no longer time-limited.
  retentionDays?: number;
  listPage(after: string | null): Promise<{ items: AdminRecordSummary[]; next: string | null }>;
  getSummary(recordId: string, includeParticipantRole?: boolean): Promise<AdminRecordSummary | null>;
  setParticipantRole?(summary: AdminSummary, role: ParticipantRole): Promise<ParticipantRoleResult>;
  /** Reads record:<recordId> from the owning session object over internal RPC, never the participant API. */
  getRecord(summary: AdminSummary): Promise<unknown | null>;
  /** Deletes the record in its session object, then its index entry (with a content-free audit entry). */
  deleteRecord(summary: AdminSummary): Promise<void>;
  forceEndRecord?(summary: AdminSummary, expected: TrialTerminationExpectation): Promise<TrialTerminationResult>;
  audit(): Promise<AuditEntry[]>;
  summarizeLatency(record: unknown): LatencySummary;
  /** Optional S5 operator action; participant cookies do not authorize it. */
  prepareNext?(summary: AdminSummary): Promise<{ kind: 'created' | 'existing'; recordId: string; participantPath: '/' }>;
  /** True only when the request's participant browser already owns this exact active trial. */
  canResumeParticipant?(request: Request, recordId: string): Promise<boolean>;
  receptions?: ReceptionAdminPort;
  /** Researcher reception settings (protocol and reception mode). */
  receptionSettings?: ReceptionSettingsPort;
  preparedObservations?: {
    status(): Promise<PreparedObservationPoolStatus>;
    prepare(input: { expectedProtocolRevision: number }): Promise<{ ok: true } | { ok: false; error: 'conflict' | 'unconfigured' | 'unavailable' }>;
  };
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
/** Only explicitly live admin views may run their own same-origin script and fetch from this origin. */
export const LIVE_CSP = ADMIN_HEADERS["Content-Security-Policy"] + "; script-src 'self'; connect-src 'self'";
const REALM = 'Basic realm="tangram-admin", charset="UTF-8"';
// Large enough for the settings form with six custom figure ids; still a hard stop for anything bigger.
const MAX_FORM_BYTES = 4096;

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

async function participantRoleMutation(request: Request, deps: AdminDeps, id: string, reception: boolean, fromLog: boolean): Promise<Response> {
  const back = reception ? { href: '/admin/receptions', label: '受付一覧へ' }
    : fromLog ? { href: '/admin', label: '実験ログへ' } : { href: '/admin/record/' + id, label: '記録詳細へ' };
  const fail = (status: number, code: string, message: string, title = '担当者種別を変更していません') => wantsHtml(request)
    ? respond(status, renderMessage(title, message, back))
    : receptionError(status, code);
  if (!RECORD_ID.test(id)) return receptionError(404, 'not_found');
  const form = await receptionForm(request);
  const role = form?.get('role'), recordIds = form?.getAll('recordId') ?? [];
  if (!form || !isParticipantRole(role) || form.getAll('role').length !== 1 ||
      [...form.keys()].some(key => key !== 'role' && !(reception && key === 'recordId')) ||
      new Set(recordIds).size !== recordIds.length || recordIds.some(recordId => !RECORD_ID.test(recordId))) {
    return fail(400, 'invalid_request', '担当者種別と対象の記録を確認してください。');
  }
  try {
    let result: ParticipantRoleResult;
    if (reception) {
      result = await deps.receptions!.setParticipantRole!(id, role, recordIds.length ? recordIds : null);
    } else {
      const summary = await deps.getSummary(id, true);
      result = summary?.recordId === id && OBJECT_ID.test(summary.objectId)
        ? await deps.setParticipantRole!(summary, role)
        : { ok: false, error: 'not_found' };
    }
    if (!result.ok) {
      if (result.error === 'not_found') return fail(404, 'not_found', '対象の記録が見つかりません。');
      return fail(409, 'conflict', reception
        ? '対象の試行記録が変わりました。受付一覧を開き直してください。'
        : '対象の記録が変わりました。画面を開き直してください。');
    }
    if (request.headers.get('Accept')?.split(',').some(value => value.split(';')[0].trim().toLowerCase() === 'application/json')) {
      return respond(200, JSON.stringify({ [reception ? 'receptionId' : 'recordId']: id, role }), 'application/json; charset=utf-8');
    }
    return plain(303, '', { Location: back.href });
  } catch {
    return fail(503, 'unavailable', '画面を開き直して担当者種別を確認してください。', '担当者種別の保存結果を確認できません');
  }
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
  prepared_observations_unavailable: '初回観察メモの準備が完了していません。設定画面で観察メモを準備してください。',
});
/** The same status either way; the page names only the closed code's message, never the submitted or backend values. */
function receptionFailure(request: Request, title: string, status: number, error: string, message = RECEPTION_MESSAGES[error]): Response {
  if (!wantsHtml(request)) return receptionError(status, error);
  const back = error === 'prepared_observations_unavailable'
    ? { href: '/admin/reception-settings', label: '受付の設定へ' } : { href: '/admin/receptions', label: '受付一覧へ' };
  return respond(status, renderMessage(title, message ?? RECEPTION_MESSAGES.reception_unavailable, back));
}
const unsigned = (text: string | null): number | null => {
  if (text === null || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const n = Number(text); return Number.isSafeInteger(n) ? n : null;
};

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
async function receptionMutation(request: Request, port: ReceptionAdminPort, id: string, action: string): Promise<Response> {
  // A 503 may follow a write whose reply was lost, so it says the outcome is unknown rather than "not done".
  const operation = action === 'approve' ? '許可' : action === 'force-end' ? '強制終了' : '取消';
  const fail = (status: number, error: string) => status === 503
    ? receptionFailure(request, operation + 'の結果を確認できません', status, error,
      '受付を確認できませんでした。受付一覧を開き直して、状態を確認してください。')
    : receptionFailure(request, action === 'cancel' ? '取り消していません' : operation + 'していません', status, error);
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
    if (entry.revision !== expectedRevision && !(action === 'force-end' && entry.status === 'interrupted' &&
      entry.revision === expectedRevision + 1)) return fail(409, 'conflict');
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
    } else if (action === 'force-end') {
      if (!port.forceEnd || !['in_progress', 'interrupted'].includes(entry.status)) return fail(409, 'conflict');
      result = await port.forceEnd(id, { expectedRevision });
    } else {
      if ((entry.status !== 'pending' && entry.status !== 'approved') || entry.trials.some(trial => trial.recordId !== null)) return fail(409, 'conflict');
      result = await port.cancel(id, { expectedRevision });
    }
    if (!result.ok) {
      // The result remains allowlisted at runtime: never reflect an arbitrary backend error.
      const error: string = result.error;
      switch (error) {
        case 'not_found': return fail(404, 'not_found');
        case 'invalid_order': return fail(400, 'invalid_order');
        case 'conflict': return fail(409, 'conflict');
        case 'protocol_unconfigured': return fail(409, 'protocol_unconfigured');
        case 'protocol_changed': return fail(409, 'protocol_changed');
        case 'reception_closed': return fail(409, 'reception_closed');
        case 'prepared_observations_unavailable': return fail(409, 'prepared_observations_unavailable');
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
const FIGURE_KEYS = ['figureMode', 'figureSetPolicy', 'figureSetId', 'selectionSeed', 'figureIds', 'figureCount'];
const BANK_IDS = new Set(FIGURE_BANK.map(f => f.id));
/** The figure source and its allocation, both explicit. Inputs that belong to another mode are ignored; per_trial needs the seeded mode. */
function figureFields(form: URLSearchParams): Pick<ProtocolFields, 'figureSelection' | 'figureSetPolicy'> | null {
  const mode = form.getAll('figureMode'), policy = form.getAll('figureSetPolicy');
  if (mode.length !== 1 || policy.length !== 1 || (policy[0] !== 'shared' && policy[0] !== 'per_trial')) return null;
  let figureSelection: ProtocolFields['figureSelection'];
  if (mode[0] === 'preset') {
    const set = form.getAll('figureSetId');
    if (set.length !== 1 || !Object.hasOwn(FIGURE_SETS, set[0])) return null;
    figureSelection = { mode: 'preset', setId: set[0] };
  } else if (mode[0] === 'seeded_random') {
    const seeds = form.getAll('selectionSeed'), counts = form.getAll('figureCount');
    const rawCount = counts[0] ?? '3';
    const figureCount = Number(rawCount);
    if (seeds.length > 1 || counts.length > 1 || !isSupportedFigureCount(figureCount) || String(figureCount) !== rawCount) return null;
    const raw = (seeds[0] ?? '').trim();
    if (raw === '') figureSelection = { mode: 'seeded_random', selectionSeed: null, figureCount };
    else {
      const seed = /^-?\d{1,16}$/u.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(seed)) return null;
      figureSelection = { mode: 'seeded_random', selectionSeed: seed, figureCount };
    }
  } else if (mode[0] === 'custom') {
    const ids = form.getAll('figureIds');
    if (!isSupportedFigureCount(ids.length) || new Set(ids).size !== ids.length || ids.some(id => !BANK_IDS.has(id))) return null;
    figureSelection = { mode: 'custom', figureIds: FIGURE_BANK.map(f => f.id).filter(id => ids.includes(id)) };
  } else return null;
  if (policy[0] === 'per_trial' && figureSelection.mode !== 'seeded_random') return null;
  return { figureSelection, figureSetPolicy: policy[0] };
}
/** Require the protocol choices. The random figure count defaults to three within its source. */
function protocolForm(form: URLSearchParams): { expectedRevision: number; fields: ProtocolFields } | null {
  const keys = [...new Set(form.keys())];
  if (keys.some(k => k !== 'orders' && k !== 'expectedRevision' && !Object.hasOwn(SINGLE, k) && !FIGURE_KEYS.includes(k))) return null;
  if (['expectedRevision', ...Object.keys(SINGLE)].some(k => form.getAll(k).length !== 1)) return null;
  const figures = figureFields(form);
  if (!figures) return null;
  const expectedRevision = unsigned(form.get('expectedRevision')), orders = form.getAll('orders');
  if (expectedRevision === null || !orders.length || new Set(orders).size !== orders.length || orders.some(o => !Object.hasOwn(ORDER_TOKENS, o))) return null;
  for (const [k, values] of Object.entries(SINGLE)) if (!values.includes(form.get(k)!)) return null;
  return { expectedRevision, fields: { allowedOrders: Object.keys(ORDER_TOKENS).filter(t => orders.includes(t)).map(t => [...ORDER_TOKENS[t]]),
    seedPolicy: form.get('seedPolicy') as ProtocolFields['seedPolicy'], referenceMemory: form.get('referenceMemory') === 'on',
    betweenTrials: form.get('betweenTrials') as ProtocolFields['betweenTrials'], receptionNumberFormat: 'daily_seq3',
    rotationMode: form.get('rotationMode') as ProtocolFields['rotationMode'], ...figures } };
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

const PREPARATION_ERRORS = new Set(['configuration_unavailable', 'configuration_changed', 'preparation_failed', 'preparation_interrupted', 'unavailable']);
function preparedObservationStatus(value: PreparedObservationPoolStatus): PreparedObservationPoolStatus {
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!value || typeof value.supported !== 'boolean' || !count(value.targetPerOrder) ||
      value.protocolRevision !== null && (!count(value.protocolRevision) || value.protocolRevision < 1) || !Array.isArray(value.orders)) throw new Error('invalid_status');
  const orders = value.orders.map(row => {
    if (!row || !count(row.orderIndex) || !Array.isArray(row.order) || row.order.length < 1 || row.order.length > 2 ||
        row.order.some(strategy => strategy !== 'repair-first' && strategy !== 'bypass-enabled') || new Set(row.order).size !== row.order.length ||
        ![row.ready, row.queued, row.preparing, row.failed].every(count)) throw new Error('invalid_status');
    return { orderIndex: row.orderIndex, order: [...row.order], ready: row.ready, queued: row.queued, preparing: row.preparing, failed: row.failed };
  });
  if (new Set(orders.map(row => row.orderIndex)).size !== orders.length) throw new Error('invalid_status');
  return { supported: value.supported, protocolRevision: value.protocolRevision, targetPerOrder: value.targetPerOrder, orders,
    errorCode: value.errorCode === null ? null : PREPARATION_ERRORS.has(value.errorCode) ? value.errorCode : 'unavailable' };
}

async function preparedObservationMutation(request: Request, port: NonNullable<AdminDeps['preparedObservations']>): Promise<Response> {
  const back = { href: '/admin/reception-settings', label: '受付の設定へ' };
  const fail = (status: number, message: string) => respond(status, renderMessage('初回観察メモの準備', message, back));
  const form = await receptionForm(request), revision = form && unsigned(form.get('expectedProtocolRevision'));
  if (!form || revision === null || revision < 1 || form.getAll('expectedProtocolRevision').length !== 1 ||
      [...form.keys()].some(key => key !== 'expectedProtocolRevision')) return fail(400, '設定画面を開き直してから準備してください。');
  try {
    const result = await port.prepare({ expectedProtocolRevision: revision });
    if (result.ok) return plain(303, '', { Location: '/admin/reception-settings' });
    if (result.error === 'conflict') return fail(409, '設定が変わりました。設定画面を開き直してから準備してください。');
    if (result.error === 'unconfigured') return fail(409, '準備に必要な設定がありません。プロトコルを確認して保存してください。');
  } catch { /* A lost reply can follow a queued preparation; report an unknown outcome. */ }
  return fail(503, '準備の状況を確認できませんでした。設定画面を開き直して確認してください。');
}

export async function handleAdmin(request: Request, deps: AdminDeps): Promise<Response> {
  if (!deps.limiter || typeof deps.token !== "string") return notFound();
  const url = new URL(request.url);
  // Deletion is POST-only; a GET to the same path is an unknown page with no side effect.
  const deletePath = request.method === "POST" ? url.pathname.match(/^\/admin\/record\/([^/]+)\/delete$/) : null;
  const forceEndPath = request.method === "POST" && deps.forceEndRecord ? url.pathname.match(/^\/admin\/record\/([^/]+)\/force-end$/u) : null;
  const nextPath = request.method === 'POST' && deps.prepareNext ? url.pathname.match(/^\/admin\/record\/([^/]+)\/prepare-next$/) : null;
  const receptionPath = request.method === 'POST' && deps.receptions ? url.pathname.match(/^\/admin\/reception\/([^/]+)\/(approve|cancel|force-end)$/) : null;
  const rolePath = url.pathname.match(/^\/admin\/(record|reception)\/([^/]+)\/participant-role$/u);
  const settingsPath = request.method === 'POST' && deps.receptionSettings ? url.pathname.match(/^\/admin\/reception-settings\/(protocol|mode)$/) : null;
  const observationsPath = url.pathname === '/admin/reception-settings/observations';
  if (observationsPath && !deps.preparedObservations) return notFound();
  if (!deps.receptions && (url.pathname === '/admin/receptions' || url.pathname === '/admin/entry' || url.pathname === '/admin/receptions.js')) return notFound();
  if (!deps.receptions?.version && url.pathname === '/admin/receptions/version') return notFound();
  if (!deps.receptionSettings && url.pathname === '/admin/reception-settings') return notFound();
  if (request.method === "POST" ? !deletePath && !forceEndPath && !nextPath && !receptionPath && !settingsPath && !observationsPath && !rolePath : request.method !== "GET" && request.method !== "HEAD") return notFound();
  const header = request.headers.get("Authorization");
  // Every credentialed attempt (right or wrong) counts, so guessing is capped per visitor.
  if (presentedToken(header) !== null && !(await deps.limiter.limit({ key: visitorKey(request) })).success) {
    return plain(429, "Too many requests", { "Retry-After": "60" });
  }
  const auth = await checkAdmin(header, deps.token);
  if (auth === "unconfigured") return notFound();
  if (auth !== "ok") return plain(401, "Authentication required", { "WWW-Authenticate": REALM });

  if (rolePath) {
    const id = rolePath[2];
    const reception = rolePath[1] === 'reception';
    if (request.method === 'POST') {
      if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
      if (reception ? !deps.receptions?.setParticipantRole : !deps.setParticipantRole) return notFound();
      return participantRoleMutation(request, deps, id, reception, url.searchParams.get('from') === 'log');
    }
    if (reception || !RECORD_ID.test(id)) return receptionError(404, 'not_found');
    try {
      const summary = await deps.getSummary(id, true);
      if (summary?.recordId !== id || !OBJECT_ID.test(summary.objectId) || !await deps.getRecord(summary)) return receptionError(404, 'not_found');
      return respond(200, JSON.stringify({ recordId: id, role: summary.participantRole?.role ?? 'unclassified' }), 'application/json; charset=utf-8');
    } catch { return receptionError(503, 'unavailable'); }
  }
  if (observationsPath) {
    if (request.method === 'POST') {
      if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
      return preparedObservationMutation(request, deps.preparedObservations!);
    }
    try { return respond(200, JSON.stringify(preparedObservationStatus(await deps.preparedObservations!.status())), 'application/json; charset=utf-8'); }
    catch { return receptionError(503, 'unavailable'); }
  }
  if (settingsPath) {
    if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
    return settingsMutation(request, deps.receptionSettings!, settingsPath[1]);
  }
  if (deps.receptionSettings && url.pathname === '/admin/reception-settings') {
    try {
      const [view, observations] = await Promise.all([deps.receptionSettings.read(),
        deps.preparedObservations ? deps.preparedObservations.status().then(preparedObservationStatus).catch(() => null) : undefined]);
      return respond(200, renderSettings(view, observations));
    }
    catch { return respond(503, renderMessage('受付の設定', '設定を読み込めませんでした。')); }
  }
  if (receptionPath) {
    if (!sameOrigin(request, url)) return plain(403, 'Forbidden');
    return receptionMutation(request, deps.receptions!, receptionPath[1], receptionPath[2]);
  }
  const failedUsagePath = url.pathname.match(/^\/admin\/reception\/([^/]+)\/usage\.json$/u);
  if (failedUsagePath) {
    const id = failedUsagePath[1];
    if (!deps.receptions?.failedStartUsage || !RECORD_ID.test(id)) return notFound();
    try {
      const usage = await deps.receptions.failedStartUsage(id);
      return usage === null ? notFound() : respond(200, JSON.stringify(usage, null, 2), 'application/json; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="tangram-reception-usage-${id}.json"` });
    } catch { return receptionError(503, 'reception_unavailable'); }
  }
  if (deps.receptions && url.pathname === '/admin/receptions') {
    try {
      // Version first, then content: a change in between makes the next version check differ, so none is missed.
      const since = new Date().toISOString();
      let version: string | null = null;
      if (deps.receptions.version) { try { version = (await deps.receptions.version(null)).version; } catch { version = null; } }
      const protocol = await deps.receptions.protocol();
      const page = await deps.receptions.listPage(url.searchParams.get('after'));
      // An unreadable version still starts the live list: an empty version differs from the first good one,
      // so the page is fetched again as soon as the version can be read.
      const live = deps.receptions.version ? { version: version !== null && /^[a-f0-9]{64}$/u.test(version) ? version : '', since } : null;
      return respond(200, renderReceptions(page.items, page.next, protocol, live, Boolean(deps.receptions.forceEnd)), undefined, live ? { 'Content-Security-Policy': LIVE_CSP } : {});
    } catch { return receptionFailure(request, '受付一覧', 503, 'reception_unavailable'); }
  }
  if (deps.receptions?.version && url.pathname === '/admin/receptions/version') {
    // `since` is the render time the page carries; anything else is ignored rather than reflected.
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam !== null && ISO_MS.test(sinceParam) && Number.isFinite(Date.parse(sinceParam)) &&
      new Date(sinceParam).toISOString() === sinceParam ? sinceParam : null;
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

  if (forceEndPath) {
    if (!sameOrigin(request, url)) return plain(403, "Forbidden");
    const id = forceEndPath[1];
    if (!RECORD_ID.test(id)) return notFound();
    const form = await receptionForm(request);
    const revision = form?.get('revision'), status = form?.get('status');
    const back = { href: '/admin/record/' + id, label: '記録へ' };
    if (!form || [...form.keys()].length !== 3 || form.get('confirm') !== id ||
        typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision) || !isIncompleteTrialStatus(status)) {
      return respond(400, renderMessage('強制終了していません', '確認欄に記録IDを正確に入力してください。', back));
    }
    try {
      const summary = await deps.getSummary(id);
      if (!summary || summary.recordId !== id || !OBJECT_ID.test(summary.objectId)) return notFound();
      const result = await deps.forceEndRecord!(summary, { revision, status });
      if (!result.ok) return result.error === 'not_found' ? notFound() :
        respond(409, renderMessage('強制終了していません', '記録の状態が変わりました。開き直して確認してください。', back));
      return plain(303, '', { Location: back.href });
    } catch {
      return respond(503, renderMessage('強制終了の結果を確認できません', '記録を開き直して状態を確認してください。', back));
    }
  }
  if (deletePath) {
    if (!sameOrigin(request, url)) return plain(403, "Forbidden");
    const recordId = deletePath[1];
    if (!RECORD_ID.test(recordId)) return notFound();
    if (await confirmation(request) !== recordId) return respond(400, renderMessage("削除していません",
      "確認欄に36文字の記録IDを正確に入力してください。", { href: "/admin", label: "実験ログへ" }));
    const summary = await deps.getSummary(recordId);
    if (!summary || summary.recordId !== recordId || !OBJECT_ID.test(summary.objectId)) return notFound();
    await deps.deleteRecord(summary);
    return respond(303, "", "text/plain; charset=utf-8", { Location: "/admin?deleted=1" });
  }
  if (url.pathname === "/admin/log-live.js") return respond(200, LOG_LIVE_JS, "text/javascript; charset=utf-8");
  if (url.pathname === "/admin/style.css") return respond(200, ADMIN_CSS, "text/css; charset=utf-8");
  if (url.pathname === "/admin/figures") return respond(200, renderFigures());
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const filter = parseFilter(url.searchParams);
    const page = await deps.listPage(url.searchParams.get("after"));
    return respond(200, renderList(applyFilter(page.items, filter), filter, page.next, await deps.audit(), deps.retentionDays,
      url.searchParams.get("deleted") === "1", Boolean(deps.receptions), Boolean(deps.forceEndRecord), true), undefined, { "Content-Security-Policy": LIVE_CSP });
  }
  const experiment = url.pathname.match(/^\/admin\/record\/([^/]+)\/experiment$/u);
  if (experiment) {
    const id = experiment[1];
    if (!RECORD_ID.test(id)) return notFound();
    const summary = await deps.getSummary(id);
    if (!summary || summary.recordId !== id || !OBJECT_ID.test(summary.objectId)) return notFound();
    const record = await deps.getRecord(summary);
    if (!record || typeof record !== 'object' || (record as {recordId?: unknown}).recordId !== id) return notFound();
    if (request.method === 'GET' && (record as { status?: unknown }).status !== 'interrupted' && await deps.canResumeParticipant?.(request, id)) {
      return plain(303, '', { Location: '/#resume=' + id });
    }
    return respond(200, renderExperimentPreview(record, summary));
  }
  const match = url.pathname.match(/^\/admin\/record\/([^/.]+)(\.json)?$/);
  if (!match || !RECORD_ID.test(match[1])) return notFound();
  // Only indexed trials are viewable; the owning object comes from the index, not the URL.
  const summary = await deps.getSummary(match[1], true);
  if (!summary || summary.recordId !== match[1] || !OBJECT_ID.test(summary.objectId)) return notFound();
  const record = await deps.getRecord(summary);
  if (!record) return respond(404, renderMessage("記録がありません", "このセッションには保存済みの記録がありません。"));
  // Researcher export of the full stored record (including the provisional questionnaire), as a download.
  if (match[2]) return respond(200, JSON.stringify({ ...record, participantRole: summary.participantRole ?? participantRoleView() }, null, 2), "application/json; charset=utf-8",
    { "Content-Disposition": `attachment; filename="tangram-record-${summary.recordId}.json"` });
  return respond(200, renderDetail(record, summary, deps.summarizeLatency(record), deps.retentionDays,
    deps.forceEndRecord ? trialTerminationExpectation(record) : null, true), undefined, { "Content-Security-Policy": LIVE_CSP });
}
