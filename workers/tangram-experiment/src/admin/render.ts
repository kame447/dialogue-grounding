// Researcher-only admin pages, rendered on the server. Live views load only their own authenticated, self-hosted script.
// Every value from a record is escaped; unknown nested values are shown as
// escaped JSON, so new record fields cannot break the page or inject markup.
import type { AdminSummary } from "./summary.ts";
import type { LatencySummary } from "./latency";
import type { AuditEntry } from "./index-store";
import type { ReceptionAdminRow, ReceptionProtocolStatus, SettingsView } from './reception-port.ts';
import type { PreparedObservationPoolStatus } from './prepared-observation-port.ts';
import { isParticipantRole } from './participant-role.ts';
import type { AdminRecordSummary, ParticipantRole } from './participant-role.ts';
import { RECORD_ID } from './summary.ts';
import { renderTurnSheet } from "./turn-sheet.ts";
import type { TrialTerminationExpectation } from './trial-termination.ts';
import { isAdminTermination, isIncompleteTrialStatus } from '../../../../dialogue-model/runtime/v2/admin-termination.ts';
import { renderQrSvg } from './qr.ts';
import { createTrialV2, participantView, ROTATION_MODES } from '../../../../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { FIGURE_BANK, FIGURE_BANK_VERSION, FIGURE_SETS, FIGURE_SET_SIZE, validateResolvedFigureSelection } from '../../../../dialogue-model/runtime/stimuli/figure-bank.ts';
import type { FigurePreset } from './figure-presets.ts';
import { DEFAULT_ROTATION_MODE, ROTATION_CHOICES } from './rotation-choices.ts';
import { usesThreeFigures } from './reception-settings.ts';
import type { BankFigure } from '../../../../dialogue-model/runtime/stimuli/figure-bank.ts';

export const ADMIN_CSS = `:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;font-size:14px;line-height:1.5;color:#222;background:#f7f7f4;--line:#d8d8d2;--accent:#2a5d8f;--tint:#eaf1f8}
*,*::before,*::after{box-sizing:border-box}
body{margin:0 auto;max-width:1120px;padding:12px 16px 48px}h1{font-size:1.25rem;margin:16px 0 12px}
h2{font-size:1.05rem;margin:32px 0 10px;padding-bottom:4px;border-bottom:1px solid var(--line)}h3{font-size:.95rem;margin:20px 0 6px}
table{border-collapse:collapse;width:100%;background:#fff;font-size:.82rem}th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top}
th{background:#eee}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:.78rem}.bad{color:#9b2c1f;font-weight:600}.muted{color:#666}
form{margin:12px 0}label{margin-right:12px}a{color:var(--accent)}.wrap{overflow-x:auto}
nav{display:flex;flex-wrap:wrap;gap:0 20px;border-bottom:1px solid var(--line)}nav a{display:inline-block;padding:10px 0}
nav a[aria-current="page"]{color:#222;font-weight:600;text-decoration:none;box-shadow:inset 0 -2px 0 var(--accent)}
button,input,select{font:inherit}input:not([type="radio"]):not([type="checkbox"]),select{min-height:40px;padding:6px 8px;border:1px solid #8c8c86;border-radius:6px;background:#fff;color:#222;max-width:100%}
button{min-height:40px;padding:6px 16px;border:1px solid #8c8c86;border-radius:6px;background:#fff;color:#222;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.filters{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}.filters label{display:inline-flex;gap:6px;align-items:center;margin:0;white-space:nowrap}
.state{font-weight:600}.actions{display:flex;flex-wrap:wrap;gap:8px}
fieldset{margin:0;padding:6px 12px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;min-width:0}legend{font-weight:600;padding:0 4px}
fieldset label{display:flex;gap:8px;align-items:flex-start;margin:0;padding:6px 0}
input[type="radio"],input[type="checkbox"]{width:18px;height:18px;margin:2px 0 0;flex:none;accent-color:var(--accent)}
.fields{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));margin-bottom:12px}
.ops form{display:grid;gap:6px;margin:0 0 10px;max-width:300px}.ops form:last-child{margin-bottom:0}.ops label{display:grid;gap:2px;margin:0}
.ops form+form{padding-top:10px;border-top:1px solid #eee}
.row-action{margin-top:6px}.row-action>summary{cursor:pointer}.row-action p{margin:6px 0}.row-action code{overflow-wrap:anywhere}
.row-action form{display:flex;flex-wrap:wrap;gap:6px;align-items:end;margin:6px 0}.row-action label{display:grid;gap:2px;margin:0;min-width:0}
.reception-trials a{overflow-wrap:anywhere}.reception-trials>div+div{margin-top:4px}
#reception-new{margin:12px 0;padding:8px 12px;border-left:3px solid var(--accent);background:var(--tint);font-weight:600}
#reception-new:empty,#reception-sync:empty{display:none}tr.new>td{background:var(--tint)}
.experiment-preview{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}.experiment-preview section{min-width:0;background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px}.experiment-preview h2{margin:0 0 12px}.experiment-preview svg{display:block;width:100%;height:auto;background:#fafafa}.experiment-preview svg path{fill:#333}.experiment-preview .chat{max-height:70vh;overflow:auto}@media(max-width:699px){.experiment-preview{grid-template-columns:1fr}}
.history table{min-width:720px}.history td{overflow-wrap:anywhere}.entry-url{overflow-wrap:anywhere}.qr svg{display:block;width:100%;max-width:264px;height:auto}
@media (max-width:699px){input:not([type="radio"]):not([type="checkbox"]),select{font-size:16px;min-height:44px}button{min-height:44px}
.cards table,.cards tbody,.cards tr,.cards td{display:block;width:100%}.cards table{background:none}.cards thead{display:none}
.cards tr{margin:0 0 12px;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff}.cards tr.new{border-color:var(--accent)}
.cards td{display:grid;grid-template-columns:6.5em minmax(0,1fr);gap:8px;padding:4px 0;border:0;font-size:.9rem;background:none!important;overflow-wrap:anywhere}
.cards td::before{content:attr(data-label);color:#666}.cards td:empty{display:none}.cards td.ops{display:block;padding:8px 0 4px}.cards td.ops::before{content:none}
.ops form{max-width:none}}
.badge{display:inline-block;padding:1px 8px;border:1px solid var(--line);border-radius:999px;background:#fff;font-size:.78rem;white-space:nowrap}
.badges{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.badge.live{background:var(--tint);border-color:var(--accent);color:var(--accent)}.badge.done{background:#eef6ee;border-color:#9bbf9b;color:#2d5a2d}
.badge.warn{background:#fdf3dc;border-color:#d4a64a;color:#6f4b00}.badge.bad{background:#fbe9e6;border-color:#d99a91;color:#9b2c1f}
.log td.id a{font-weight:600}.log .cell>div+div{margin-top:2px}.log time{white-space:nowrap}
dl.summary{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px 16px;margin:12px 0;padding:12px;background:#fff;border:1px solid var(--line);border-radius:6px}
dl.summary div{min-width:0}dl.summary dt{color:#666;font-size:.78rem}dl.summary dd{margin:0;overflow-wrap:anywhere}
ol.chat{list-style:none;margin:0;padding:0;display:grid;gap:8px}ol.chat li{padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;max-width:760px}
ol.chat li.ai{background:#f1f3f0}ol.chat li.human{margin-left:auto;background:var(--tint)}
ol.chat .meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;color:#666;font-size:.78rem}ol.chat p{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
details.diag{margin:12px 0;background:#fff;border:1px solid var(--line);border-radius:6px}details.diag>summary{cursor:pointer;padding:10px 12px;font-weight:600;min-height:40px}
details.diag[open]>summary{border-bottom:1px solid var(--line)}details.diag>.body{padding:4px 12px 12px;overflow-x:auto}details.diag h3:first-child{margin-top:10px}
details.danger>summary{color:#9b2c1f}
.turn-sheet{max-height:72vh;overflow:auto;border:1px solid var(--line);background:#fff}.turn-sheet table{border-collapse:separate;border-spacing:0;min-width:1300px;table-layout:fixed;font-size:.85rem}.turn-sheet th,.turn-sheet td{border:0;border-right:1px solid #ddd;border-bottom:1px solid #ddd;padding:8px;overflow-wrap:anywhere;white-space:pre-wrap}.turn-sheet th{position:sticky;top:0;z-index:2;white-space:normal;background:#eee}.turn-sheet tr:nth-child(even) td{background:#fafafa}.turn-sheet th:nth-child(1){width:44px}.turn-sheet th:nth-child(2){width:54px}.turn-sheet th:nth-child(3){width:105px}.turn-sheet th:nth-child(4){width:300px}.turn-sheet th:nth-child(5){width:170px}.turn-sheet th:nth-child(6){width:195px}.turn-sheet th:nth-child(7){width:180px}.turn-sheet th:nth-child(8){width:195px}.turn-sheet th:nth-child(9){width:100px}.turn-sheet .seq,.turn-sheet .speaker{font-weight:600}.turn-sheet .utterance{font-size:.95rem}.turn-sheet td:first-child,.turn-sheet th:first-child{position:sticky;left:0;background:#eee;z-index:1}.turn-sheet th:first-child{z-index:3}.turn-sheet time{font-variant-numeric:tabular-nums}.turn-sheet .turn-open{min-height:30px;padding:3px 7px;font-size:.8rem;white-space:nowrap}.turn-popover{width:min(840px,92vw);max-height:85vh;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:16px 20px;color:#222;background:#fff;box-shadow:0 8px 32px #0002;white-space:normal}.turn-popover::backdrop{background:#0003}.turn-popover-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.turn-popover-head h3{margin:0}.turn-popover .utterance{white-space:pre-wrap;overflow-wrap:anywhere}.turn-popover .turn-entry pre{font-size:.85rem;max-height:48vh}.turn-sheet .turn-block+.turn-block{border-top:1px solid #ddd;margin-top:5px;padding-top:5px}.turn-sheet tr:target td{background:var(--tint)}.turn-detail summary,.turn-entry summary{cursor:pointer;overflow-wrap:anywhere;color:var(--accent)}.turn-entry{padding:5px 0;border-top:1px solid var(--line)}.turn-entry pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32vh;overflow:auto;background:#f5f5f5;padding:6px}.unlinked{margin:10px 0}.record-detail{max-width:none}
.figure-grid{display:flex;flex-wrap:wrap;gap:12px}.figure-grid figure{margin:0;text-align:center}.figure-art{display:flex;align-items:center;justify-content:center;min-width:112px;min-height:112px;padding:4px;background:#fff;border:1px solid var(--line);border-radius:4px}
.figure-art svg{max-width:96px;height:auto;fill:#24476b;stroke:#24476b;stroke-width:1;stroke-linejoin:round}.figure-grid figcaption{font-weight:600}
.preset-editor .figure-grid label{display:grid;justify-items:center;gap:4px;cursor:pointer}
.preset-editor .figure-grid label:has(input:checked) .figure-art{border-color:var(--accent);background:var(--tint)}
fieldset.figure-source{display:grid;gap:8px}.figure-source>div>label{display:block}.figure-source .sub{margin:4px 0 0 20px;display:flex;flex-wrap:wrap;gap:4px 12px}.figure-source input[type=text]{width:12em}
@media (max-width:699px){ol.chat li,ol.chat li.human{max-width:none;margin-left:0}dl.summary{grid-template-columns:1fr 1fr}}`;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char]);
}
const json = (value: unknown) => `<pre>${escapeHtml(value === undefined ? "" : JSON.stringify(value, null, 1))}</pre>`;
const cell = (value: unknown) => `<td>${typeof value === "object" && value !== null ? json(value) : escapeHtml(value)}</td>`;
const row = (values: unknown[]) => `<tr>${values.map(cell).join("")}</tr>`;
const head = (names: string[]) => `<tr>${names.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr>`;
const table = (names: string[], rows: unknown[][]) => rows.length
  ? `<div class="wrap"><table>${head(names)}${rows.map(row).join("")}</table></div>` : `<p class="muted">なし</p>`;
const isPlain = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];

function page(title: string, body: string, wide = false, live: 'list' | 'detail' | null = null): string {
  if (live) body = `<p id="admin-log-sync" class="muted" role="status"></p><main id="admin-log-live" data-view="${live}">${body}</main><script src="/admin/log-live.js" defer></script>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/admin/style.css"></head>
<body${wide ? ' class="record-detail"' : ""}>${body}</body></html>`;
}

const PARTICIPANT_ROLE_LABELS: Record<ParticipantRole, string> = { human: "人間", ai: "AI", unclassified: "未分類" };
const participantRole = (item: Pick<AdminRecordSummary, "participantRole">): ParticipantRole =>
  isParticipantRole(item.participantRole?.role) ? item.participantRole.role : "unclassified";

export type ListFilter = { status: string; error: "any" | "with" | "without"; memory: "any" | "on" | "off"; role?: ParticipantRole };
export const STATUS_FILTERS = ["any", "active", "dialogue", "submitting", "completed", "interrupted"] as const;
// The log and the reception list share one vocabulary: 実施中 / 提出中 / 終了.
const STATUS_LABELS: Record<string, string> = { dialogue: "実施中", submitting: "提出中", completed: "終了", interrupted: "強制終了" };
const STATUS_FILTER_LABELS: Record<string, string> = { any: "すべて", active: "進行中（実施中・提出中）", ...STATUS_LABELS };
const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

/** Unknown filter values fall back to "any"; the filter never reaches storage queries. */
export function parseFilter(params: URLSearchParams): ListFilter {
  const status = params.get("status") ?? "any";
  const error = params.get("error");
  const memory = params.get("memory");
  const role = params.get("role");
  return { status: (STATUS_FILTERS as readonly string[]).includes(status) ? status : "any",
    error: error === "with" || error === "without" ? error : "any", memory: memory === "on" || memory === "off" ? memory : "any",
    ...(isParticipantRole(role) ? { role } : {}) };
}

export function applyFilter(summaries: AdminRecordSummary[], filter: ListFilter): AdminRecordSummary[] {
  return summaries.filter((s) => (filter.status === "any" || (filter.status === "active" ? s.status === "dialogue" || s.status === "submitting" : s.status === filter.status)) &&
    (filter.error === "any" || (filter.error === "with") === s.errorCodes.length > 0) &&
    (filter.memory === "any" || (filter.memory === "on") === s.referenceMemory) &&
    (filter.role === undefined || participantRole(s) === filter.role));
}

const option = (value: string, current: string, label = value) =>
  `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
const roleOptions = (current: string) => Object.entries(PARTICIPANT_ROLE_LABELS).map(([value, label]) => option(value, current, label)).join("");

function participantRoleForm(action: string, recordIds: readonly string[] = []): string {
  return `<form method="post" action="${escapeHtml(action)}">
${recordIds.map(id => `<input type="hidden" name="recordId" value="${escapeHtml(id)}">`).join("")}
<label>変更後 <select name="role" required>${option("", "", "選択")}${roleOptions("")}</select></label>
<button>${recordIds.length ? "一括変更" : "変更"}</button></form>`;
}

function deleteRecordForm(recordId: string): string {
  const id = escapeHtml(recordId);
  return `<p>記録ID <code>${id}</code></p>
<form method="post" action="/admin/record/${id}/delete"><label>確認（記録ID） <input name="confirm" autocomplete="off" required></label>
<button>この記録を削除</button></form>`;
}

const ms = (value: number | null | undefined) => typeof value === "number" ? `${Math.round(value)}` : "—";

/** JST "YYYY-MM-DD HH:mm:ss"; the stored ISO value stays in datetime/title. Unparseable values are shown as they are. */
function timeTag(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return escapeHtml(value);
  const label = new Date(at + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
  return `<time datetime="${escapeHtml(value)}" title="${escapeHtml(value)}">${label}</time>`;
}
const badge = (text: string, tone = "") => `<span class="badge${tone ? " " + tone : ""}">${escapeHtml(text)}</span>`;
const statusBadge = (status: string) => badge(statusLabel(status), status === "completed" ? "done" : status === "dialogue" || status === "submitting" ? "live" : "");
const aiBadge = (aiStatus: string) => badge("AI " + aiStatus, aiStatus === "error" ? "bad" : "");
const surveyBadge = (value: string) => badge("仮アンケート" + (QUESTIONNAIRE_LABELS[value] ?? QUESTIONNAIRE_LABELS.none), value === "submitted" ? "done" : value === "draft" ? "warn" : "");

export function renderList(summaries: AdminRecordSummary[], filter: ListFilter, next: string | null, audit: AuditEntry[],
  _retentionDays?: number, deleted = false, receptions = false, forceEnd = false, live = false): string {
  const query = (extra: Record<string, string>) => "?" + new URLSearchParams({ status: filter.status, error: filter.error, memory: filter.memory,
    ...(filter.role ? { role: filter.role } : {}), ...extra });
  const td = (label: string, content: string, cls = "") => `<td data-label="${escapeHtml(label)}"${cls ? ` class="${cls}"` : ""}><div class="cell">${content}</div></td>`;
  const rows = summaries.map((s) => {
    const id = escapeHtml(s.recordId);
    const actions = RECORD_ID.test(s.recordId) ? `${forceEnd && isIncompleteTrialStatus(s.status) ? `<div><a href="/admin/record/${id}#force-end">試行を強制終了</a></div>` : ""}
<details class="row-action"><summary>担当者種別を変更</summary>
${participantRoleForm(`/admin/record/${s.recordId}/participant-role?from=log`)}</details>
<details class="row-action danger"><summary>記録を削除</summary>
<p>仮アンケートも削除されます。削除は取り消せません。</p>${deleteRecordForm(s.recordId)}</details>` : "";
    return `<tr>${td("記録", `<div><a href="/admin/record/${id}">${escapeHtml(s.recordId.slice(0, 8))}</a></div><div class="muted">${timeTag(s.updatedAt)}</div>
<div>担当者種別 ${PARTICIPANT_ROLE_LABELS[participantRole(s)]}</div>${actions}`, "id")}
${td("状態", `<div class="badges">${statusBadge(s.status)}${aiBadge(s.aiStatus)}${surveyBadge(s.questionnaire)}</div>`)}
${td("条件", `<div>${escapeHtml(s.strategy)}</div><div class="muted">メモリ ${s.referenceMemory ? "ON" : "OFF"} · ${escapeHtml(s.utteranceStyle)}</div>`)}
${td("発話・確定", `<div>人/AI ${s.counts.humanMessages}/${s.counts.aiMessages}</div><div class="muted">確定/試行 ${s.counts.committedTurns}/${s.counts.attempts}</div>`)}
${td("応答・エラー", `<div>p50/p95 ${ms(s.latency.turn.p50Ms)} / ${ms(s.latency.turn.p95Ms)} ms${s.latency.slowestPhase ? ` · 最遅 ${escapeHtml(s.latency.slowestPhase.phase)}` : ""}</div>
<div class="muted">要求エラー ${s.counts.requestErrors}</div>${s.errorCodes.length ? `<div class="bad">${escapeHtml(s.errorCodes.join(", "))}</div>` : ""}`)}</tr>`;
  }).join("");
  return page("実験ログ（研究者用）", `${receptions ? adminNav('/admin') : ''}<h1>実験ログ（研究者用）</h1>
<form method="get" action="/admin" class="filters"><label>状態 <select name="status">${STATUS_FILTERS.map((v) => option(v, filter.status, STATUS_FILTER_LABELS[v])).join("")}</select></label>
<label>エラー <select name="error">${option("any", filter.error, "すべて")}${option("with", filter.error, "あり")}${option("without", filter.error, "なし")}</select></label>
<label>参照メモリ <select name="memory">${option("any", filter.memory, "すべて")}${option("on", filter.memory, "ON")}${option("off", filter.memory, "OFF")}</select></label>
<label>担当者種別 <select name="role">${option("", filter.role ?? "", "すべて")}${roleOptions(filter.role ?? "")}</select></label>
<button>絞り込み</button></form>
${deleted ? `<p class="bad">記録を削除しました。</p>` : ""}
<p class="muted">更新が新しい順に ${PAGE_LIMIT_NOTE}（同じブラウザの過去の試行を含む）。絞り込みはこのページ内に適用します。記録は自動では削除されません（手動での削除のみ）。</p>
${summaries.length ? `<div class="wrap cards log"><table><thead>${head(["記録", "状態", "条件", "発話・確定", "応答・エラー"])}</thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">該当なし</p>`}
${next ? `<p><a href="/admin${escapeHtml(query({ after: next }))}">次のページ →</a></p>` : ""}
<h2>削除の記録（内容なし）</h2>${table(["削除日時", "理由", "記録IDのハッシュ"], audit.map((a) => [a.deletedAt, a.reason, a.recordHash]))}`, false, live ? "list" : null);
}
const PAGE_LIMIT_NOTE = "1ページ100件";
// Index entries written before the questionnaire existed have no state: shown as "none".
const QUESTIONNAIRE_LABELS: Record<string, string> = { none: "なし", draft: "下書き", submitted: "提出済み" };

/** The participant's provisional questionnaire (研究者未承認の仮項目), item by item; no total score. */
function questionnaireSection(value: unknown): string {
  const title = `<h2>仮アンケート（研究者未承認の試行項目）</h2>`;
  if (!isPlain(value)) return `${title}<p class="muted">回答なし</p>`;
  const answers = isPlain(value.answers) ? value.answers : {};
  return `${title}${table(["項目", "値"], [["版", value.version], ["状態", QUESTIONNAIRE_LABELS[value.status] ?? value.status],
    ["作成", value.createdAt], ["更新", value.updatedAt], ["提出", value.submittedAt ?? null]])}
${table(["項目ID", "回答（1-7）"], Object.entries(answers).map(([id, answer]) => [id, answer ?? "未回答"]))}
<h3>自由記述</h3>${value.comment ? `<pre>${escapeHtml(value.comment)}</pre>` : `<p class="muted">なし</p>`}`;
}

function latencySection(latency: LatencySummary): string {
  const phases = Object.entries(latency.byPhase).map(([phase, p]) => [phase, p.count, p.errors, ms(p.p50Ms), ms(p.p90Ms), ms(p.p95Ms), ms(p.maxMs), ms(p.totalMs)]);
  const turns = latency.turns.map((t) => [t.aiSeq, t.requestSeq, ms(t.fromTriggerMs), ms(t.fromFirstPendingMs), ms(t.runMs),
    t.calls.map((c) => `${c.phase} ${Math.round(c.latencyMs)}ms ${c.status}${c.errorCode ? " " + c.errorCode : ""}`).join("\n"),
    t.judgeRetries, t.validationFailures.join(", "), [t.judgeFallback && "judge_fallback", t.guardRegenerated && "guard_regenerated",
      t.guardFallback && "guard_fallback"].filter(Boolean).join(", "), t.supersededBefore]);
  return `<p>要求 ${latency.requests}・エラー ${latency.errors}・タイムアウト ${latency.timeouts}・応答 p50 ${ms(latency.turn.p50Ms)} ms / p95 ${ms(latency.turn.p95Ms)} ms（${latency.turn.count} 回）・最初の未応答から p50 ${ms(latency.firstPending.p50Ms)} ms</p>
${table(["段階", "回数", "エラー", "p50", "p90", "p95", "max", "合計 ms"], phases)}
${latency.turns.length ? `<h3>ターン別の遅延</h3>${table(["AI seq", "要求 seq", "最新の発話から ms", "最初の未応答から ms", "実行 ms", "呼び出し", "判断再試行", "検証失敗", "代替・書き直し", "直前の中断"], turns)}` : ""}`;
}

/** A section that opens on demand: plain HTML, no script. */
const fold = (title: string, body: string, extra = "", open = false) =>
  `<details class="diag${extra ? " " + extra : ""}"${open ? " open" : ""}><summary>${escapeHtml(title)}</summary><div class="body">${body}</div></details>`;
const chatSpeaker = (value: unknown) => value === "ai" ? "AI" : value === "human" ? "人間" : String(value ?? "");

/** Human/AI names and the match per figure; the raw submission, diagnostics and scoring stay in the fold below. */
function outcomeSection(r: Record<string, any>): string {
  const scoring = isPlain(r.scoring) ? r.scoring : {};
  const figures = [scoring.figures, isPlain(scoring.result) ? scoring.result.figures : undefined].find(Array.isArray) as any[] | undefined;
  const result = isPlain(scoring.result) ? scoring.result : scoring;
  const rows = figures ? figures.filter(isPlain).map((f) => [isPlain(f.human) ? f.human.slot : "", isPlain(f.human) ? f.human.rawName ?? "未合意" : "",
    isPlain(f.ai) ? f.ai.rawName ?? "未合意" : "", f.matched === true ? "一致" : f.matched === false ? "不一致" : ""])
    : isPlain(r.humanSubmission) ? Object.entries(r.humanSubmission).map(([slot, name]) => [slot, name ?? "未合意", isPlain(r.aiSubmission) ? (r.aiSubmission as any)[slot] ?? "" : "", ""]) : [];
  const counts = typeof result.matchedCount === "number" && typeof result.total === "number" ? `<p>一致 ${result.matchedCount} / ${result.total}（暫定）</p>` : "";
  return `<h2>提出と結果</h2>${counts}${table(["図形", "人間の名前", "AIの名前", "照合"], rows)}`;
}

/** Full researcher view of one stored record: identity and outcome first, every diagnostic one click away. */
/** Researcher metadata of the recorded figure set; a record without one shows the legacy six figures. */
function recordedFigures(r: Record<string, any>): unknown {
  const stimulus = isPlain(r.stimulus) ? r.stimulus : {};
  if (Object.hasOwn(stimulus, 'figureIds')) {
    return { figureSetId: stimulus.figureSetId ?? null, figureIds: stimulus.figureIds ?? null, bankVersion: stimulus.bankVersion ?? null,
      selectionSeed: stimulus.selectionSeed ?? null, selectionMode: stimulus.selectionMode ?? null };
  }
  const opt = isPlain(r.options) && isPlain(r.options.figureSelection) ? r.options.figureSelection : null;
  if (opt && Object.hasOwn(opt, 'figureIds')) {
    return { figureSetId: opt.setId ?? null, figureIds: opt.figureIds ?? null, bankVersion: opt.bankVersion ?? null,
      selectionSeed: opt.selectionSeed ?? null, selectionMode: opt.mode ?? null };
  }
  return '未記録（従来の6図形 F1–F6）';
}

export function renderDetail(record: unknown, summary: AdminRecordSummary, latency: LatencySummary, _retentionDays?: number,
  forceEnd: TrialTerminationExpectation | null = null, live = false): string {
  const r = isPlain(record) ? record : {};
  const judgments = list(r.judgments).filter(isPlain).map((j) => [j.turnIndex, j.judgment?.action, j.judgment?.targetSlot,
    j.judgment?.candidateName, j.judgment?.discriminatingFeature, j.judgment?.followUp ?? null, j.activeJudge ?? null]);
  // errorCode/errorPhase/errorStatus/errorElapsedMs and generationRetried are written by the v2 turn on failure.
  const attemptList = list(r.attempts).filter(isPlain);
  const attempts = attemptList.map((a) => [a.turnIndex, a.status,
    a.errorCode ? [a.errorCode, a.errorPhase, a.errorStatus === null || a.errorStatus === undefined ? "" : "HTTP " + a.errorStatus,
      a.errorElapsedMs === undefined ? "" : ms(a.errorElapsedMs) + " ms"].filter((part) => part !== "" && part !== undefined).join(" / ") : "",
    a.generationRetried === true ? "あり" : "", a.validation ?? null, a.memory ?? null,
    a.generationGuard ?? null, a.activeJudge ?? null, a.decisionShadow ?? null, a.utteranceStyle ?? null]);
  // Shadow-only, uncalibrated relative scores: never shown as a probability of being correct.
  const grounding = list(r.groundingShadow).filter(isPlain).map((g) => [g.turnIndex, g.targetSlot ?? "", g.status,
    isPlain(g.identification) ? g.identification.level : "", isPlain(g.nameAgreement) ? g.nameAgreement.level : "",
    g.error ?? "", g.latencyMs === null || g.latencyMs === undefined ? "" : ms(g.latencyMs),
    isPlain(g.usage) && typeof g.usage.costUsd === "number" ? g.usage.costUsd : "", list(g.inputGaps).join(", "),
    // Records made before the 5-level name axis carry no version (v1: "no name yet" was not_agreed).
    typeof g.criteriaVersion === "string" ? g.criteriaVersion : "v1（版記録なし）"]);
  const requestList = list(r.requests).filter(isPlain);
  const requests = requestList.map((q, i) => [i + 1, q.kind, q.status, q.httpStatus ?? "", q.errorCode ?? "",
    ms(q.latencyMs), q.retryCount ?? "", q.model ?? ""]);
  const attemptErrors = attemptList.filter((a) => a.errorCode).length;
  const requestErrors = requestList.filter((q) => q.errorCode || (typeof q.httpStatus === "number" && q.httpStatus >= 400)).length;
  const conversation = renderTurnSheet(r, latency, { escape: escapeHtml, time: timeTag });
  const dl = (items: [string, string][]) => `<dl class="summary">${items.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const id = escapeHtml(summary.recordId);
  const interrupted = r.status === 'interrupted' && isAdminTermination(r.termination);
  const forceEndForm = forceEnd ? `<details id="force-end" class="row-action danger"><summary>試行を強制終了</summary>
<p>保存された記録は残ります。受付に属する試行は、残りの条件も開始できなくなります。</p>
<form method="post" action="/admin/record/${id}/force-end">
<input type="hidden" name="revision" value="${escapeHtml(forceEnd.revision)}"><input type="hidden" name="status" value="${escapeHtml(forceEnd.status)}">
<label>確認（記録ID） <input name="confirm" autocomplete="off" required></label><button>試行を強制終了</button></form></details>` : "";
  const surveyState = isPlain(r.questionnaire) && typeof r.questionnaire.status === "string" ? r.questionnaire.status : summary.questionnaire;
  return page(`記録 ${summary.recordId.slice(0, 8)}`, `<p><a href="/admin">← 実験ログへ</a></p>
<h1>記録 ${id}</h1>
<p><a href="/admin/record/${id}.json">JSONで保存（この記録の全項目）</a></p>
${forceEndForm}
${dl([["状態", `<div class="badges">${statusBadge(interrupted ? "interrupted" : summary.status)}${aiBadge(interrupted ? "closed" : summary.aiStatus)}${surveyBadge(surveyState)}</div>`], ["開始", timeTag(summary.startedAt)], ["更新", timeTag(summary.updatedAt)],
  ...(interrupted ? [["強制終了", timeTag(r.termination.at)] as [string, string]] : []),
  ["担当者種別", PARTICIPANT_ROLE_LABELS[participantRole(summary)] + (RECORD_ID.test(summary.recordId) ?
    `<details class="row-action"><summary>変更</summary>${participantRoleForm(`/admin/record/${summary.recordId}/participant-role`)}</details>` : "")],
  ["方略", escapeHtml(summary.strategy)], ["参照メモリ", summary.referenceMemory ? "ON" : "OFF"], ["発話様式", escapeHtml(summary.utteranceStyle)],
  ["発話 人/AI", `${summary.counts.humanMessages}/${summary.counts.aiMessages}`], ["確定/試行", `${summary.counts.committedTurns}/${summary.counts.attempts}`],
  ["応答 p50/p95", `${ms(latency.turn.p50Ms)} / ${ms(latency.turn.p95Ms)} ms`],
  ["エラーコード", summary.errorCodes.length ? `<span class="bad">${escapeHtml(summary.errorCodes.join(", "))}</span>` : "なし"]])}
<h2>会話（公開発話）</h2>${conversation}
${outcomeSection(r)}
${questionnaireSection(r.questionnaire)}
<h2>診断</h2>
${fold(`確定した判断（ターンごと）（${judgments.length}件）`, table(["ターン", "行為", "対象", "名前", "弁別特徴", "followUp", "active 判断"], judgments))}
${fold(`実行の記録（中断・失敗を含む）（${attempts.length}件・エラー ${attemptErrors}件）`, table(["ターン", "状態", "エラー（コード / 段階 / HTTP / 経過）", "生成の再試行", "検証", "参照メモリ", "生成ガード", "active 判断", "影の判断", "発話様式"], attempts))}
${fold(`遅延・ターン別の遅延（p50 ${ms(latency.turn.p50Ms)} / p95 ${ms(latency.turn.p95Ms)} ms）`, latencySection(latency))}
${grounding.length ? fold(`根拠の影判定（Jev 2軸・研究用・未校正）（${grounding.length}件）`, table(["ターン", "対象", "結果", "対象同定の根拠", "名称合意の根拠", "エラー", "ms", "費用 USD", "入力の不足", "判定基準の版"], grounding)) : ""}
${fold(`外部要求（${requests.length}回・エラー ${requestErrors}件）`, table(["#", "段階", "結果", "HTTP", "コード", "ms", "再送", "モデル"], requests))}
${fold("詳細メタデータ・キュー・提出と採点の生データ", table(["項目", "値"], [["Durable Object", summary.objectId], ["開始", summary.startedAt], ["更新", summary.updatedAt],
  ["キュー", r.queueState ? { errorCode: r.queueState.errorCode ?? null, pending: list(r.queueState.pendingHumanEventIds).length, closed: r.queueState.closed ?? false } : null],
  ["最終エラー", r.finalError ?? null], ["件数", summary.counts], ["人間の提出", r.humanSubmission ?? null], ["AIの提出", r.aiSubmission ?? null],
  ["診断", r.diagnostics ?? null], ["採点", r.scoring ?? null], ["初回観察", r.initialObservation ?? null], ["最終参照グラフ", r.referenceGraph ?? null], ["最終参照台帳", r.ownLedger ?? null], ["図形セット", recordedFigures(r)]]))}
${fold("削除", `<p class="muted">この記録は自動では削除されません。削除する場合は、記録IDを確認欄に入力してください（仮アンケートの回答も削除されます）。削除は取り消せません。</p>
${deleteRecordForm(summary.recordId)}`, "danger")}`, true, live ? "detail" : null);
}

export function renderMessage(title: string, message: string, back: { href: string; label: string } = { href: '/admin', label: '一覧へ' }): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a></p>`);
}

const RECEPTION_LABELS = { pending: '許可待ち', approved: '許可済み', in_progress: '実施中', finished: '終了', cancelled: '取消済み', interrupted: '強制終了' };
const receptionBadge = (status: string) => badge(RECEPTION_LABELS[status as keyof typeof RECEPTION_LABELS] ?? status,
  status === 'finished' ? 'done' : status === 'in_progress' || status === 'approved' ? 'live' : status === 'pending' ? 'warn' : '');
const NAV: [string, string][] = [['/admin/receptions', '受付一覧'], ['/admin/entry', '参加用URL・QRコード'], ['/admin/reception-settings', '受付の設定'], ['/admin/figures', '図形一覧'], ['/admin', '実験ログ']];
function adminNav(current: string): string {
  return `<nav>${NAV.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`).join('')}</nav>`;
}
/** One frozen set id, or `A → B` when the trials use different sets. */
const figureSetSummary = (ids: readonly string[]) => ids.length && ids.every(id => id === ids[0]) ? ids[0] : ids.join(' → ');
const ROTATION_LABELS: Record<string, string> = Object.fromEntries(ROTATION_CHOICES.map(choice => [choice.value, choice.list]));
const BETWEEN_LABELS: Record<string, string> = { none: '指定なし', questionnaire_required: 'アンケート必須' };

/** Present only when the reception list updates itself: the version it was rendered from and the render time. */
export type ReceptionLive = { version: string; since: string };

export function renderReceptions(items: ReceptionAdminRow[], next: string | null, protocol: ReceptionProtocolStatus, live: ReceptionLive | null = null,
  forceEnd = false): string {
  const form = (entry: ReceptionAdminRow, action: 'approve' | 'cancel' | 'force-end') => {
    // No preselected order: the researcher chooses one, and the form carries the protocol version it was shown with.
    const choices = action === 'approve' && protocol.configured
      ? `<input type="hidden" name="protocolId" value="${escapeHtml(protocol.protocolId)}"><input type="hidden" name="protocolRevision" value="${escapeHtml(protocol.revision)}"><input type="hidden" name="protocolSha256" value="${escapeHtml(protocol.sha256)}">
<label>条件順序 <select name="order" required><option value="">選んでください</option>${protocol.allowedOrders.map((order, index) =>
        `<option value="${index}">${escapeHtml(order.join(' → '))}</option>`).join('')}</select></label>` : '';
    return `<form method="post" action="/admin/reception/${escapeHtml(entry.receptionId)}/${action}">
<input type="hidden" name="expectedRevision" value="${escapeHtml(entry.revision)}">${choices}
<label>確認（${escapeHtml(entry.number ?? entry.receptionId.slice(0, 8))} を入力） <input name="confirm" autocomplete="off" required></label>
<button${action === 'approve' ? ' class="primary"' : ''}>${action === 'approve' ? '許可' : action === 'cancel' ? '受付を取消' : '受付を強制終了'}</button></form>`;
  };
  // A row is redrawn by the live update only when this key changes, so it covers everything its forms carry.
  const protocolKey = protocol.configured ? `${protocol.mode}:${protocol.protocolId}:${protocol.revision}:${protocol.sha256}` : `${protocol.mode}:none`;
  // A setting that is not three figures cannot make new receptions (#268); approved receptions are unaffected.
  const approvable = protocol.configured && protocol.mode !== 'off' && !protocol.legacyFigures;
  const td = (label: string, content: string, extra = '') => `<td data-label="${escapeHtml(label)}"${extra}>${content}</td>`;
  const rows = [...items].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')).map(entry => {
    const unstarted = !entry.trials.some(trial => trial.recordId !== null || trial.recordDeleted);
    const cancel = unstarted && (entry.status === 'pending' || entry.status === 'approved');
    const end = forceEnd && entry.status === 'in_progress'
      ? `<details class="row-action danger"><summary>受付を強制終了</summary><p>進行中の試行を終了し、残りの開始を止めます。</p>${form(entry, 'force-end')}</details>` : '';
    const trials = entry.trials.map(trial => ({
      recordId: !trial.recordDeleted && trial.recordId && RECORD_ID.test(trial.recordId) ? trial.recordId : null,
      deleted: trial.recordDeleted === true,
      role: participantRole(trial),
    }));
    const lastRecord = trials.at(-1)?.recordId;
    const open = entry.status === 'in_progress' && lastRecord
      ? `<a href="/admin/record/${escapeHtml(lastRecord)}/experiment" target="_blank" rel="noopener noreferrer">実験画面を開く</a>` : '';
    const usage = entry.hasUnrecordedProductionAdmission && RECORD_ID.test(entry.receptionId)
      ? `<a href="/admin/reception/${escapeHtml(entry.receptionId)}/usage.json">開始失敗の使用量 JSON</a>` : '';
    const trialLinks = trials.map(({ recordId, role }) =>
      recordId ? `<div><a href="/admin/record/${escapeHtml(recordId)}">${escapeHtml(recordId)}</a> <span>${PARTICIPANT_ROLE_LABELS[role]}</span></div>` : '').join('');
    const recordIds = trials.flatMap(trial => trial.recordId === null ? [] : [trial.recordId]);
    const bulk = recordIds.length && RECORD_ID.test(entry.receptionId) ? `<details class="row-action"><summary>担当者種別を一括変更（${recordIds.length}件）</summary>
${participantRoleForm(`/admin/reception/${entry.receptionId}/participant-role`, recordIds)}</details>` : '';
    const rowKey = JSON.stringify([entry.revision, protocolKey, trials]);
    return `<tr data-id="${escapeHtml(entry.receptionId)}" data-status="${escapeHtml(entry.status)}" data-created="${escapeHtml(entry.createdAt)}" data-key="${escapeHtml(rowKey)}">${td('受付番号', escapeHtml(entry.number ?? '未割当'))}${td('受付時刻', timeTag(entry.createdAt))}
${td('状態', receptionBadge(entry.status) + (entry.termination ? ' ' + timeTag(entry.termination.at) : ''))}${td('条件順序', escapeHtml(entry.plan?.order.join(' → ') ?? ''))}
${td('図形セット', escapeHtml(figureSetSummary(entry.plan?.figureSets ?? [])))}${td('回転', escapeHtml(entry.plan ? ROTATION_LABELS[entry.plan.rotationMode] ?? '' : ''))}${td('試行の間', escapeHtml(entry.plan ? BETWEEN_LABELS[entry.plan.betweenTrials] ?? '' : ''))}
${td('試行記録', trialLinks ? `<div class="reception-trials">${trialLinks}</div>${bulk}` : '')}
${td('操作', `${entry.status === 'pending' && unstarted && approvable ? form(entry, 'approve') : ''}${cancel ? form(entry, 'cancel') : ''}${end}${open}${usage}`, ' class="ops"')}</tr>`;
  }).join('');
  const names = ['受付番号', '受付時刻', '状態', '条件順序', '図形セット', '回転', '試行の間', '試行記録', '操作'];
  const list = `<div id="reception-list"${live ? ` data-version="${escapeHtml(live.version)}" data-since="${escapeHtml(live.since)}"` : ''}>
<div data-part="status">${protocol.configured ? `<p>プロトコル設定済み: ${escapeHtml(protocol.protocolId)} / revision ${escapeHtml(protocol.revision)}</p>`
    : '<p class="bad">プロトコルが未設定のため、許可できません（<a href="/admin/reception-settings">受付の設定</a>）</p>'}
${protocol.configured && protocol.legacyFigures ? '<p class="bad">現在の設定は3図形ではないため、許可できません（<a href="/admin/reception-settings">受付の設定</a>）</p>' : ''}
${protocol.mode === 'off' ? '<p>受付を使わない設定です。許可済みの受付は、計画どおり続けられます。</p>' : ''}</div>
${items.length ? `<div class="wrap cards" data-part="table"><table><thead>${head(names)}</thead><tbody>${rows}</tbody></table></div>` : '<p data-part="empty">受付はありません</p>'}
${next ? `<p data-part="more"><a href="/admin/receptions?${escapeHtml(new URLSearchParams({ after: next }).toString())}">次のページ →</a></p>` : ''}</div>`;
  return page('受付一覧', `${adminNav('/admin/receptions')}<h1>受付一覧</h1>
${live ? '<p id="reception-new" role="status" aria-live="polite"></p><p id="reception-sync" class="muted" role="status"></p>' : ''}
${list}${live ? '<script src="/admin/receptions.js" defer></script>' : ''}`);
}

/** Researcher-only snapshot of the participant's own scene and public conversation. */
export function renderExperimentPreview(record: unknown, summary: AdminSummary): string {
  const r = isPlain(record) ? record : {};
  let board = '<p class="muted">図形を表示できません。</p>';
  const options = isPlain(r.options) ? r.options : {};
  const rotationMode = options.rotationMode ?? 'relative_pm90';
  if (Number.isSafeInteger(r.seed) && ROTATION_MODES.includes(rotationMode)) {
    try {
      const figureSelection = Object.hasOwn(options, 'figureSelection') ? validateResolvedFigureSelection(options.figureSelection) : undefined;
      const scene = participantView(createTrialV2({ seed: r.seed, rotationMode, ...(figureSelection ? { figureSelection } : {}) }));
      board = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" aria-label="参加者の図形">${scene.shapes.map((shape: { path: string }) => `<path d="${escapeHtml(shape.path)}"/>`).join('')}</svg>`;
    } catch { /* An older or unreadable stimulus must not prevent reading the conversation. */ }
  }
  const conversation = list(r.events).filter(e => isPlain(e) && ['ai', 'human'].includes(e.speaker)).map(e =>
    `<li class="${e.speaker}"><div class="meta">${badge(chatSpeaker(e.speaker))}${timeTag(e.at)}</div><p>${escapeHtml(e.text)}</p></li>`).join('');
  const id = escapeHtml(summary.recordId);
  return page('実験画面（閲覧専用）', `<p><a href="/admin/receptions">受付一覧</a> · <a href="/admin/record/${id}">試行記録</a> · <a href="/admin/record/${id}/experiment">更新</a></p>
<h1>実験画面（閲覧専用）</h1><p>${statusBadge(summary.status)} 保存時刻 ${timeTag(r.updatedAt ?? summary.updatedAt)}</p>
<div class="experiment-preview"><section><h2>参加者の図形</h2>${board}</section><section><h2>会話</h2><ol class="chat">${conversation}</ol></section></div>`);
}

export function renderEntry(entryUrl: string): string {
  return page('参加用URL・QRコード', `${adminNav('/admin/entry')}<h1>参加用URL・QRコード</h1>
<p class="entry-url"><a href="${escapeHtml(entryUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entryUrl)}</a></p><div class="qr">${renderQrSvg(entryUrl)}</div>`);
}

const ORDER_CHOICES: [string, string, string][] = [['rf-be', 'repair-first,bypass-enabled', 'repair-first → bypass-enabled'],
  ['be-rf', 'bypass-enabled,repair-first', 'bypass-enabled → repair-first'], ['rf', 'repair-first', 'repair-first のみ'], ['be', 'bypass-enabled', 'bypass-enabled のみ']];
const SETTING_CHOICES: [string, string, [string, string][]][] = [
  ['seedPolicy', 'seed', [['shared', '全試行で同じ'], ['per_trial', '試行ごとに別']]],
  ['referenceMemory', '参照メモリ', [['on', 'ON'], ['off', 'OFF']]],
  ['betweenTrials', '試行の間', [['none', '指定なし'], ['questionnaire_required', 'アンケートの提出後に次へ（対象：provisional-v0、研究者未承認の仮項目）']]],
  ['rotationMode', '回転', ROTATION_CHOICES.map(choice => [choice.value, choice.form])],
  ['receptionNumberFormat', '受付番号', [['daily_seq3', '日ごとの3桁の連番']]],
];
const MODE_LABELS: Record<string, string> = { on: '現在：使う', off: '現在：使わない', unset: '既定（使う）' };

function renderPreparedObservations(view: SettingsView, status: PreparedObservationPoolStatus | null | undefined): string {
  if (status === undefined) return '';
  const heading = '<h2>初回観察メモ</h2>';
  if (status === null || status.errorCode === 'unavailable' || status.errorCode === 'configuration_unavailable') {
    return heading + '<p class="bad">準備状況を確認できませんでした。設定画面を開き直してください。</p>';
  }
  if (status.errorCode === 'configuration_changed' || status.protocolRevision !== (view.protocol?.revision ?? null)) {
    return heading + '<p class="bad">設定が変わりました。設定画面を開き直してください。</p>';
  }
  if (!status.supported) return heading + '<p>現在の設定は事前準備の対象外です。</p>';
  if (status.protocolRevision === null) return heading + '<p>先にプロトコルを保存してください。</p>';
  const missing = !status.orders.length || status.orders.some(row => row.ready === 0);
  const pending = status.orders.some(row => row.queued + row.preparing > 0);
  const notice = status.errorCode === 'preparation_failed' ? '<p class="bad">一部の観察メモを準備できませんでした。もう一度準備してください。</p>'
    : status.errorCode === 'preparation_interrupted' ? '<p class="bad">準備が中断されました。もう一度準備してください。</p>' : '';
  return heading + table(['条件順序', '準備済み', '待機中', '準備中', '失敗'],
    status.orders.map(row => [row.order.join(' → '), row.ready, row.queued, row.preparing, row.failed])) + notice +
    (missing ? `<p>受付を許可する前に、${pending ? '観察メモの準備完了を待ってください。' : '観察メモを準備してください。'}</p>` : '') +
    `<form method="post" action="/admin/reception-settings/observations"><input type="hidden" name="expectedProtocolRevision" value="${escapeHtml(status.protocolRevision)}"><button>観察メモを準備</button></form>`;
}

/** Researcher settings form. Unsaved settings preselect only the default rotation; saved settings preselect the current values. */
export function renderSettings(view: SettingsView, observations?: PreparedObservationPoolStatus | null, presets?: readonly FigurePreset[]): string {
  const p = view.protocol?.protocol;
  const current: Record<string, string> = p ? { figureSetPolicy: p.figureSetPolicy ?? '', seedPolicy: p.seedPolicy, referenceMemory: p.referenceMemory ? 'on' : 'off', betweenTrials: p.betweenTrials,
    rotationMode: p.rotationMode, receptionNumberFormat: p.receptionNumberFormat } : { rotationMode: DEFAULT_ROTATION_MODE };
  const orders = new Set(p ? p.allowedOrders.map(o => o.join(',')) : []);
  // New settings are three figures only (#268). A saved four- or six-figure setting (or a v2 one) is shown as a notice
  // and never preselected: the researcher chooses the three figures to keep, and nothing is chosen on their behalf.
  const selection = p && usesThreeFigures(p) ? p.figureSelection : undefined;
  const customIds = new Set(selection?.mode === 'custom' ? selection.figureIds : []);
  const presetChoices = (presets ?? []).map(preset =>
    `<label><input type="radio" name="figureSetId" value="${escapeHtml(`${preset.id}:${preset.revision}`)}"> ${escapeHtml(preset.name)} ・ ${escapeHtml(preset.figureIds.join('、'))}</label>`).join('');
  const presetSource = presetChoices ? `<div><label><input type="radio" name="figureMode" value="preset" required> プリセット</label>
<div class="sub">${presetChoices}</div></div>` : '';
  const saved = p?.figureSelection;
  const savedCount = !saved ? FIGURE_SET_SIZE : saved.mode === 'custom' ? saved.figureIds.length
    : saved.mode === 'seeded_random' ? saved.figureCount ?? FIGURE_SET_SIZE : FIGURE_SETS[saved.setId]?.length;
  const legacyNotice = p && !usesThreeFigures(p)
    ? `<p class="bad">現在の設定は${savedCount ? savedCount + '図形' : '3図形以外'}のため、新しい受付を許可できません。図形セットで3図形を選んで保存してください。</p>` : '';
  const figureSource = `<fieldset class="figure-source"><legend>図形セット</legend>
${presets === undefined ? '' : '<p><a href="/admin/figure-presets">図形プリセットを管理</a></p>'}${presetSource}
<div><label><input type="radio" name="figureMode" value="seeded_random" required${selection?.mode === 'seeded_random' ? ' checked' : ''}> シード乱数</label>
<div class="sub"><label>図形数 <select name="figureCount"><option value="3">3</option></select></label><label>シード <input type="text" name="selectionSeed" inputmode="numeric" autocomplete="off" placeholder="空欄で自動"${selection?.mode === 'seeded_random' && selection.selectionSeed !== null ? ` value="${escapeHtml(selection.selectionSeed)}"` : ''}></label></div></div>
<div><label><input type="radio" name="figureMode" value="custom" required${selection?.mode === 'custom' ? ' checked' : ''}> 図形を選ぶ（3個）</label>
<div class="sub">${FIGURE_BANK.map(f => `<label><input type="checkbox" name="figureIds" value="${escapeHtml(f.id)}"${customIds.has(f.id) ? ' checked' : ''}> ${escapeHtml(f.id)}</label>`).join('')}</div></div></fieldset>`;
  const mark = (on: boolean) => on ? ' checked' : '';
  const fieldset = (name: string, legend: string, choices: [string, string][]) => `<fieldset><legend>${escapeHtml(legend)}</legend>${choices.map(([value, label]) =>
    `<label><input type="radio" name="${name}" value="${escapeHtml(value)}" required${mark(current[name] === value)}> ${escapeHtml(label)}</label>`).join('')}</fieldset>`;
  const status = view.protocol ? `<p class="state">revision ${escapeHtml(view.protocol.revision)}（${escapeHtml(view.protocol.savedAt)} に保存）</p>` : '<p class="bad">未設定のため、受付を許可できません</p>';
  return page('受付の設定', `${adminNav('/admin/reception-settings')}<h1>受付の設定</h1>
<h2>受付モード</h2><p class="state">${escapeHtml(MODE_LABELS[view.mode.value])}</p>
<p>受付は既定で使います。試行の開始には、プロトコルの保存と研究者の許可が必要です。</p>
<form method="post" action="/admin/reception-settings/mode" class="actions"><input type="hidden" name="expectedRevision" value="${escapeHtml(view.mode.revision)}">
<button name="value" value="on">受付を使う</button> <button name="value" value="off">受付を使わない</button></form>
<h2>生成後チェック</h2><p class="state">現在：${view.postGenerationCheck?.value === 'on' ? 'ON' : view.postGenerationCheck ? 'OFF' : 'OFF（既定）'}</p>
<p>v24 以降の受付をこれから許可するときに使う設定です。許可済みの受付の設定は変わりません。</p>
<form method="post" action="/admin/reception-settings/post-generation-check" class="actions"><input type="hidden" name="expectedRevision" value="${escapeHtml(view.postGenerationCheck?.revision ?? 0)}">
<button name="value" value="on">ON にする</button> <button name="value" value="off">OFF にする</button></form>
<h2>プロトコル</h2>${status}${legacyNotice}
<form method="post" action="/admin/reception-settings/protocol"><input type="hidden" name="expectedRevision" value="${escapeHtml(view.protocol?.revision ?? 0)}">
<div class="fields"><fieldset><legend>条件順序</legend>${ORDER_CHOICES.map(([token, key, label]) =>
    `<label><input type="checkbox" name="orders" value="${token}"${mark(orders.has(key))}> ${escapeHtml(label)}</label>`).join('')}</fieldset>
${SETTING_CHOICES.map(([name, legend, choices]) => fieldset(name, legend, choices)).join('\n')}
${figureSource}
${fieldset('figureSetPolicy', '図形セットの割付', [['shared', '全試行で同じ'], ['per_trial', '試行ごとに別（シード乱数のみ）']])}</div>
<p>保存しても、許可済みの受付の計画は変わりません。</p><button class="primary">保存</button></form>
${renderPreparedObservations(view, observations)}
<h2>履歴</h2><div class="history"><h3>プロトコル</h3>${table(['revision', '保存日時', '内容', 'SHA-256'], view.protocolHistory.map(h => [h.revision, h.savedAt, h.protocol, h.sha256]))}
<h3>受付モード</h3>${table(['revision', '保存日時', '受付モード', 'プロトコル revision'], view.modeHistory.map(h => [h.revision, h.savedAt, h.value, h.protocolRevision]))}</div>`);
}

/** Researcher-only catalogue of the candidate figure bank and sets. Never offered to a participant or model. */
function figureSvg(figure: BankFigure): string {
  const SCALE = 24, PAD = 12, points = figure.pieces.flatMap(piece => piece.points);
  const minX = Math.min(...points.map(q => q[0])), minY = Math.min(...points.map(q => q[1]));
  const w = Math.max(...points.map(q => q[0])) - minX, h = Math.max(...points.map(q => q[1])) - minY;
  const polygons = figure.pieces.map(piece => `<polygon points="${piece.points.map(([x, y]) => `${(x - minX) * SCALE + PAD},${(y - minY) * SCALE + PAD}`).join(' ')}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * SCALE + 2 * PAD}" height="${h * SCALE + 2 * PAD}" viewBox="0 0 ${w * SCALE + 2 * PAD} ${h * SCALE + 2 * PAD}" role="img" aria-label="${escapeHtml(figure.id)}">${polygons}</svg>`;
}
export function renderFigurePresets(presets: readonly FigurePreset[]): string {
  return page('図形プリセット', `<p><a href="/admin/reception-settings">受付の設定へ</a></p><h1>図形プリセット</h1>
<p><a href="/admin/figure-presets/new">プリセットを作成</a></p>
${presets.length ? `<ul>${presets.map(preset =>
    `<li><a href="/admin/figure-presets/${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</a> ${escapeHtml(preset.figureIds.join('、'))}</li>`).join('')}</ul>`
    : '<p>表示中のプリセットはありません。</p>'}`);
}
export function renderFigurePresetEditor(preset: FigurePreset | null): string {
  const heading = preset ? '図形プリセットを編集' : '図形プリセットを作成';
  const action = '/admin/figure-presets/' + (preset?.id ?? 'new');
  const revision = `<input type="hidden" name="expectedRevision" value="${preset?.revision ?? 0}">`;
  const selected = new Set(preset?.figureIds);
  return page(heading, `<p><a href="/admin/figure-presets">プリセット一覧へ</a></p><h1>${heading}</h1>
<form method="post" action="${escapeHtml(action)}" class="preset-editor">${revision}
<p><label>名前 <input type="text" name="name" value="${escapeHtml(preset?.name)}" required></label></p>
<fieldset><legend>図形を3個選ぶ</legend><div class="figure-grid">${FIGURE_BANK.map(figure =>
    `<label><span class="figure-art" aria-hidden="true">${figureSvg(figure)}</span><span><input type="checkbox" name="figureIds" value="${escapeHtml(figure.id)}"${selected.has(figure.id) ? ' checked' : ''}> ${escapeHtml(figure.id)}</span></label>`).join('')}</div></fieldset>
<p><button class="primary">保存</button></p></form>
${preset ? `<form method="post" action="${escapeHtml(action)}/hide">${revision}<button>プリセットを非表示</button></form>` : ''}`);
}
export function renderFigures(): string {
  const cell = (figure: BankFigure) => `<figure><div class="figure-art">${figureSvg(figure)}</div><figcaption>${escapeHtml(figure.id)}</figcaption></figure>`;
  const byId = new Map(FIGURE_BANK.map(f => [f.id, f]));
  const sets = Object.entries(FIGURE_SETS).map(([id, ids]) => `<h3>${escapeHtml(id)}</h3><div class="figure-grid">${ids.map(fid => byId.get(fid)).filter((f): f is BankFigure => Boolean(f)).map(cell).join('')}</div>`).join('');
  return page('図形一覧', `${adminNav('/admin/figures')}<h1>図形一覧</h1>
<p class="muted">候補バンク（${escapeHtml(FIGURE_BANK_VERSION)}）と候補セットは予備検討用です。実験条件への採用は研究者が判断します。</p>
<h2>全${FIGURE_BANK.length}図形</h2><div class="figure-grid">${FIGURE_BANK.map(cell).join('')}</div>
<h2>候補セット</h2>${sets}`);
}
