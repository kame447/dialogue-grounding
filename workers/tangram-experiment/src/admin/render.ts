// Researcher-only admin pages, rendered on the server. Only the reception list loads a script, the
// self-hosted /admin/receptions.js (receptions-live.ts); every other page has none.
// Every value from a record is escaped; unknown nested values are shown as
// escaped JSON, so new record fields cannot break the page or inject markup.
import type { AdminSummary } from "./summary";
import type { LatencySummary } from "./latency";
import type { AuditEntry } from "./index-store";
import type { ReceptionAdminRow, ReceptionProtocolStatus, SettingsView } from './reception-port.ts';
import { RECORD_ID } from './summary.ts';
import { renderQrSvg } from './qr.ts';
import { createTrialV2, participantView, ROTATION_MODES } from '../../../../dialogue-model/runtime/stimuli/scatter-v2.mjs';

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

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/admin/style.css"></head>
<body>${body}</body></html>`;
}

export type ListFilter = { status: string; error: "any" | "with" | "without"; memory: "any" | "on" | "off" };
export const STATUS_FILTERS = ["any", "active", "dialogue", "submitting", "completed"] as const;
// The log and the reception list share one vocabulary: 実施中 / 提出中 / 終了.
const STATUS_LABELS: Record<string, string> = { dialogue: "実施中", submitting: "提出中", completed: "終了" };
const STATUS_FILTER_LABELS: Record<string, string> = { any: "すべて", active: "進行中（実施中・提出中）", dialogue: "実施中", submitting: "提出中", completed: "終了" };
const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

/** Unknown filter values fall back to "any"; the filter never reaches storage queries. */
export function parseFilter(params: URLSearchParams): ListFilter {
  const status = params.get("status") ?? "any";
  const error = params.get("error");
  const memory = params.get("memory");
  return { status: (STATUS_FILTERS as readonly string[]).includes(status) ? status : "any",
    error: error === "with" || error === "without" ? error : "any", memory: memory === "on" || memory === "off" ? memory : "any" };
}

export function applyFilter(summaries: AdminSummary[], filter: ListFilter): AdminSummary[] {
  return summaries.filter((s) => (filter.status === "any" || (filter.status === "active" ? s.status === "dialogue" || s.status === "submitting" : s.status === filter.status)) &&
    (filter.error === "any" || (filter.error === "with") === s.errorCodes.length > 0) &&
    (filter.memory === "any" || (filter.memory === "on") === s.referenceMemory));
}

const option = (value: string, current: string, label = value) =>
  `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
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

export function renderList(summaries: AdminSummary[], filter: ListFilter, next: string | null, audit: AuditEntry[],
  _retentionDays?: number, deleted = false, receptions = false): string {
  const query = (extra: Record<string, string>) => "?" + new URLSearchParams({ status: filter.status, error: filter.error, memory: filter.memory, ...extra });
  const td = (label: string, content: string, cls = "") => `<td data-label="${escapeHtml(label)}"${cls ? ` class="${cls}"` : ""}><div class="cell">${content}</div></td>`;
  const rows = summaries.map((s) => `<tr>${td("記録", `<div><a href="/admin/record/${escapeHtml(s.recordId)}">${escapeHtml(s.recordId.slice(0, 8))}</a></div><div class="muted">${timeTag(s.updatedAt)}</div>`, "id")}
${td("状態", `<div class="badges">${statusBadge(s.status)}${aiBadge(s.aiStatus)}${surveyBadge(s.questionnaire)}</div>`)}
${td("条件", `<div>${escapeHtml(s.strategy)}</div><div class="muted">メモリ ${s.referenceMemory ? "ON" : "OFF"} · ${escapeHtml(s.utteranceStyle)}</div>`)}
${td("発話・確定", `<div>人/AI ${s.counts.humanMessages}/${s.counts.aiMessages}</div><div class="muted">確定/試行 ${s.counts.committedTurns}/${s.counts.attempts}</div>`)}
${td("応答・エラー", `<div>p50/p95 ${ms(s.latency.turn.p50Ms)} / ${ms(s.latency.turn.p95Ms)} ms${s.latency.slowestPhase ? ` · 最遅 ${escapeHtml(s.latency.slowestPhase.phase)}` : ""}</div>
<div class="muted">要求エラー ${s.counts.requestErrors}</div>${s.errorCodes.length ? `<div class="bad">${escapeHtml(s.errorCodes.join(", "))}</div>` : ""}`)}</tr>`).join("");
  return page("実験ログ（研究者用）", `${receptions ? adminNav('/admin') : ''}<h1>実験ログ（研究者用・読み取り専用）</h1>
<form method="get" action="/admin" class="filters"><label>状態 <select name="status">${STATUS_FILTERS.map((v) => option(v, filter.status, STATUS_FILTER_LABELS[v])).join("")}</select></label>
<label>エラー <select name="error">${option("any", filter.error, "すべて")}${option("with", filter.error, "あり")}${option("without", filter.error, "なし")}</select></label>
<label>参照メモリ <select name="memory">${option("any", filter.memory, "すべて")}${option("on", filter.memory, "ON")}${option("off", filter.memory, "OFF")}</select></label>
<button>絞り込み</button></form>
${deleted ? `<p class="bad">記録を削除しました。</p>` : ""}
<p class="muted">更新が新しい順に ${PAGE_LIMIT_NOTE}（同じブラウザの過去の試行を含む）。絞り込みはこのページ内に適用します。記録は自動では削除されません（手動での削除のみ）。</p>
${summaries.length ? `<div class="wrap cards log"><table><thead>${head(["記録", "状態", "条件", "発話・確定", "応答・エラー"])}</thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">該当なし</p>`}
${next ? `<p><a href="/admin${escapeHtml(query({ after: next }))}">次のページ →</a></p>` : ""}
<h2>削除の記録（内容なし）</h2>${table(["削除日時", "理由", "記録IDのハッシュ"], audit.map((a) => [a.deletedAt, a.reason, a.recordHash]))}`);
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
export function renderDetail(record: unknown, summary: AdminSummary, latency: LatencySummary, _retentionDays?: number): string {
  const r = isPlain(record) ? record : {};
  const rawEvents = list(r.events).filter(isPlain);
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
  const conversation = rawEvents.length ? `<ol class="chat">${rawEvents.map((e) => `<li class="${e.speaker === "ai" ? "ai" : "human"}"><div class="meta">${badge(chatSpeaker(e.speaker))}<span>seq ${escapeHtml(e.seq)}</span>${timeTag(e.at)}${e.origin ? `<span>${escapeHtml(e.origin)}</span>` : ""}</div><p>${escapeHtml(e.text)}</p></li>`).join("")}</ol>` : `<p class="muted">なし</p>`;
  const dl = (items: [string, string][]) => `<dl class="summary">${items.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const id = escapeHtml(summary.recordId);
  const surveyState = isPlain(r.questionnaire) && typeof r.questionnaire.status === "string" ? r.questionnaire.status : summary.questionnaire;
  return page(`記録 ${summary.recordId.slice(0, 8)}`, `<p><a href="/admin">← 一覧</a></p>
<h1>記録 ${id}</h1>
<p><a href="/admin/record/${id}.json">JSONで保存（この記録の全項目）</a></p>
${dl([["状態", `<div class="badges">${statusBadge(summary.status)}${aiBadge(summary.aiStatus)}${surveyBadge(surveyState)}</div>`], ["開始", timeTag(summary.startedAt)], ["更新", timeTag(summary.updatedAt)],
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
  ["診断", r.diagnostics ?? null], ["採点", r.scoring ?? null]]))}
${fold("削除", `<p class="muted">この記録は自動では削除されません。削除する場合は、記録IDを確認欄に入力してください（仮アンケートの回答も削除されます）。削除は取り消せません。</p>
<form method="post" action="/admin/record/${id}/delete"><label>確認（記録ID） <input name="confirm" autocomplete="off" required></label>
<button>この記録を削除</button></form>`, "danger")}`);
}

export function renderMessage(title: string, message: string, back: { href: string; label: string } = { href: '/admin', label: '一覧へ' }): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a></p>`);
}

const RECEPTION_LABELS = { pending: '許可待ち', approved: '許可済み', in_progress: '実施中', finished: '終了', cancelled: '取消済み' };
const receptionBadge = (status: string) => badge(RECEPTION_LABELS[status as keyof typeof RECEPTION_LABELS] ?? status,
  status === 'finished' ? 'done' : status === 'in_progress' || status === 'approved' ? 'live' : status === 'pending' ? 'warn' : '');
const NAV: [string, string][] = [['/admin/receptions', '受付一覧'], ['/admin/entry', '参加用URL・QRコード'], ['/admin/reception-settings', '受付の設定'], ['/admin', '実験ログ']];
function adminNav(current: string): string {
  return `<nav>${NAV.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`).join('')}</nav>`;
}
const ROTATION_LABELS: Record<string, string> = { relative_pm90: '±90°', relative_0: '0°' };
const BETWEEN_LABELS: Record<string, string> = { none: '指定なし', questionnaire_required: 'アンケート必須' };

/** Present only when the reception list updates itself: the version it was rendered from and the render time. */
export type ReceptionLive = { version: string; since: string };

export function renderReceptions(items: ReceptionAdminRow[], next: string | null, protocol: ReceptionProtocolStatus, live: ReceptionLive | null = null): string {
  const form = (entry: ReceptionAdminRow, action: 'approve' | 'cancel') => {
    // No preselected order: the researcher chooses one, and the form carries the protocol version it was shown with.
    const choices = action === 'approve' && protocol.configured
      ? `<input type="hidden" name="protocolId" value="${escapeHtml(protocol.protocolId)}"><input type="hidden" name="protocolRevision" value="${escapeHtml(protocol.revision)}"><input type="hidden" name="protocolSha256" value="${escapeHtml(protocol.sha256)}">
<label>条件順序 <select name="order" required><option value="">選んでください</option>${protocol.allowedOrders.map((order, index) =>
        `<option value="${index}">${escapeHtml(order.join(' → '))}</option>`).join('')}</select></label>` : '';
    return `<form method="post" action="/admin/reception/${escapeHtml(entry.receptionId)}/${action}">
<input type="hidden" name="expectedRevision" value="${escapeHtml(entry.revision)}">${choices}
<label>確認（${escapeHtml(entry.number ?? entry.receptionId.slice(0, 8))} を入力） <input name="confirm" autocomplete="off" required></label>
<button${action === 'approve' ? ' class="primary"' : ''}>${action === 'approve' ? '許可' : '受付を取消'}</button></form>`;
  };
  // A row is redrawn by the live update only when this key changes, so it covers everything its forms carry.
  const protocolKey = protocol.configured ? `${protocol.mode}:${protocol.protocolId}:${protocol.revision}:${protocol.sha256}` : `${protocol.mode}:none`;
  const td = (label: string, content: string, extra = '') => `<td data-label="${escapeHtml(label)}"${extra}>${content}</td>`;
  const rows = [...items].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')).map(entry => {
    const unstarted = !entry.trials.some(trial => trial.recordId !== null);
    const cancel = unstarted && (entry.status === 'pending' || entry.status === 'approved');
    const lastRecord = entry.trials.at(-1)?.recordId;
    const open = entry.status === 'in_progress' && lastRecord && RECORD_ID.test(lastRecord)
      ? `<a href="/admin/record/${escapeHtml(lastRecord)}/experiment" target="_blank" rel="noopener noreferrer">実験画面を開く</a>` : '';
    return `<tr data-id="${escapeHtml(entry.receptionId)}" data-status="${escapeHtml(entry.status)}" data-created="${escapeHtml(entry.createdAt)}" data-key="${escapeHtml(entry.revision + ':' + protocolKey)}">${td('受付番号', escapeHtml(entry.number ?? '未割当'))}${td('受付時刻', timeTag(entry.createdAt))}
${td('状態', receptionBadge(entry.status))}${td('条件順序', escapeHtml(entry.plan?.order.join(' → ') ?? ''))}
${td('回転', escapeHtml(entry.plan ? ROTATION_LABELS[entry.plan.rotationMode] ?? '' : ''))}${td('試行の間', escapeHtml(entry.plan ? BETWEEN_LABELS[entry.plan.betweenTrials] ?? '' : ''))}
${td('試行記録', entry.trials.filter(trial => trial.recordId && RECORD_ID.test(trial.recordId)).map(trial =>
      `<a href="/admin/record/${escapeHtml(trial.recordId)}">${escapeHtml(trial.recordId)}</a>`).join('<br>'))}
${td('操作', `${entry.status === 'pending' && unstarted && protocol.configured && protocol.mode !== 'off' ? form(entry, 'approve') : ''}${cancel ? form(entry, 'cancel') : ''}${open}`, ' class="ops"')}</tr>`;
  }).join('');
  const names = ['受付番号', '受付時刻', '状態', '条件順序', '回転', '試行の間', '試行記録', '操作'];
  const list = `<div id="reception-list"${live ? ` data-version="${escapeHtml(live.version)}" data-since="${escapeHtml(live.since)}"` : ''}>
<div data-part="status">${protocol.configured ? `<p>プロトコル設定済み: ${escapeHtml(protocol.protocolId)} / revision ${escapeHtml(protocol.revision)}</p>`
    : '<p class="bad">プロトコルが未設定のため、許可できません（<a href="/admin/reception-settings">受付の設定</a>）</p>'}
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
      const scene = participantView(createTrialV2({ seed: r.seed, rotationMode }));
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
  ['rotationMode', '回転', [['relative_pm90', '相対 ±90°（従来）'], ['relative_0', '相対 0°（向きを一致）']]],
  ['receptionNumberFormat', '受付番号', [['daily_seq3', '日ごとの3桁の連番']]],
];
const MODE_LABELS: Record<string, string> = { on: '現在：使う', off: '現在：使わない', unset: '既定（使う）' };

/** Researcher settings form. Unsaved settings preselect nothing; saved settings preselect the current values. */
export function renderSettings(view: SettingsView): string {
  const p = view.protocol?.protocol;
  const current: Record<string, string> = p ? { seedPolicy: p.seedPolicy, referenceMemory: p.referenceMemory ? 'on' : 'off', betweenTrials: p.betweenTrials,
    rotationMode: p.rotationMode, receptionNumberFormat: p.receptionNumberFormat } : {};
  const orders = new Set(p ? p.allowedOrders.map(o => o.join(',')) : []);
  const mark = (on: boolean) => on ? ' checked' : '';
  const fieldset = (name: string, legend: string, choices: [string, string][]) => `<fieldset><legend>${escapeHtml(legend)}</legend>${choices.map(([value, label]) =>
    `<label><input type="radio" name="${name}" value="${escapeHtml(value)}" required${mark(current[name] === value)}> ${escapeHtml(label)}</label>`).join('')}</fieldset>`;
  const status = view.protocol ? `<p class="state">revision ${escapeHtml(view.protocol.revision)}（${escapeHtml(view.protocol.savedAt)} に保存）</p>` : '<p class="bad">未設定のため、受付を許可できません</p>';
  return page('受付の設定', `${adminNav('/admin/reception-settings')}<h1>受付の設定</h1>
<h2>受付モード</h2><p class="state">${escapeHtml(MODE_LABELS[view.mode.value])}</p>
<p>受付は既定で使います。試行の開始には、プロトコルの保存と研究者の許可が必要です。</p>
<form method="post" action="/admin/reception-settings/mode" class="actions"><input type="hidden" name="expectedRevision" value="${escapeHtml(view.mode.revision)}">
<button name="value" value="on">受付を使う</button> <button name="value" value="off">受付を使わない</button></form>
<h2>プロトコル</h2>${status}
<form method="post" action="/admin/reception-settings/protocol"><input type="hidden" name="expectedRevision" value="${escapeHtml(view.protocol?.revision ?? 0)}">
<div class="fields"><fieldset><legend>条件順序</legend>${ORDER_CHOICES.map(([token, key, label]) =>
    `<label><input type="checkbox" name="orders" value="${token}"${mark(orders.has(key))}> ${escapeHtml(label)}</label>`).join('')}</fieldset>
${SETTING_CHOICES.map(([name, legend, choices]) => fieldset(name, legend, choices)).join('\n')}</div>
<p>保存しても、許可済みの受付の計画は変わりません。</p><button class="primary">保存</button></form>
<h2>履歴</h2><div class="history"><h3>プロトコル</h3>${table(['revision', '保存日時', '内容', 'SHA-256'], view.protocolHistory.map(h => [h.revision, h.savedAt, h.protocol, h.sha256]))}
<h3>受付モード</h3>${table(['revision', '保存日時', '受付モード', 'プロトコル revision'], view.modeHistory.map(h => [h.revision, h.savedAt, h.value, h.protocolRevision]))}</div>`);
}
